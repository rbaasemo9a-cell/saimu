'use strict';
/**
 * 返済ロードマップ — データ層
 * Node 22.5+ 組み込みの node:sqlite を使う（npm install 不要）。
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.SAIMU_DB || path.join(__dirname, 'saimu.db');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');   // 書き込み中の読み取りをブロックしない
db.exec('PRAGMA foreign_keys = ON');    // 借入を消したら返済記録も消える
db.exec('PRAGMA busy_timeout = 4000');

db.exec(`
CREATE TABLE IF NOT EXISTS debts (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  principal        REAL NOT NULL DEFAULT 0 CHECK(principal >= 0),
  interest_accrued REAL NOT NULL DEFAULT 0 CHECK(interest_accrued >= 0),
  accrued_at       TEXT NOT NULL DEFAULT '',
  initial          REAL NOT NULL DEFAULT 0 CHECK(initial >= 0),
  rate             REAL NOT NULL DEFAULT 0 CHECK(rate >= 0 AND rate <= 100),
  min_payment      REAL NOT NULL DEFAULT 0 CHECK(min_payment >= 0),
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS txns (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL CHECK(type IN ('income','expense')),
  date      TEXT NOT NULL,
  amount    REAL NOT NULL CHECK(amount > 0),
  category  TEXT NOT NULL DEFAULT 'その他',
  memo      TEXT NOT NULL DEFAULT '',
  -- 実際に口座から出ていく月。カード払いは利用した月の翌月になる。
  pay_month TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS repayments (
  id        TEXT PRIMARY KEY,
  debt_id   TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  amount    REAL NOT NULL CHECK(amount > 0),
  interest  REAL NOT NULL DEFAULT 0,
  principal REAL NOT NULL DEFAULT 0,
  memo      TEXT NOT NULL DEFAULT ''
);

-- 使っているクレジットカード
CREATE TABLE IF NOT EXISTS cards (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- カード会社からの請求額。「この月に口座からいくら引き落とされるか」の正解。
-- 明細を1件ずつ入れなくても、ここに実額を入れれば取り置きが正しくなる。
CREATE TABLE IF NOT EXISTS card_bills (
  id        TEXT PRIMARY KEY,
  card_id   TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  pay_month TEXT NOT NULL,
  amount    REAL NOT NULL CHECK(amount >= 0),
  memo      TEXT NOT NULL DEFAULT '',
  UNIQUE(card_id, pay_month)
);

CREATE TABLE IF NOT EXISTS goals (
  id                INTEGER PRIMARY KEY CHECK(id = 1),
  target_date       TEXT NOT NULL DEFAULT '',
  monthly_repay     REAL NOT NULL DEFAULT 0,
  emergency         REAL NOT NULL DEFAULT 0,
  emergency_current REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_txns_date       ON txns(date);
CREATE INDEX IF NOT EXISTS idx_txns_type_date  ON txns(type, date);
CREATE INDEX IF NOT EXISTS idx_rep_date        ON repayments(date);
CREATE INDEX IF NOT EXISTS idx_rep_debt        ON repayments(debt_id);

INSERT OR IGNORE INTO goals (id) VALUES (1);
`);

/* ---------- ヘルパ ---------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** 複数の書き込みをひとまとまりにする。途中で失敗したら何も残さない。 */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

const num = (v, def = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : def;
};
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function dateOr(v, fallback) {
  const s = str(v, 10);
  return ISO_DATE.test(s) ? s : fallback;
}
function localToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
}

const ISO_MONTH = /^\d{4}-\d{2}$/;
const monthOf = iso => String(iso || '').slice(0, 7);
/** YYYY-MM に n ヶ月足す。年またぎもここで面倒を見る。 */
function addMonthKey(key, n) {
  if (!ISO_MONTH.test(key)) return key;
  const [y, m] = key.split('-').map(Number);
  const t = (y * 12) + (m - 1) + n;
  return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
}
/** 引落月。指定が無ければ利用月そのまま（＝現金・口座払い）。 */
function payMonthOf(b, date) {
  const given = str(b.payMonth, 7);
  return ISO_MONTH.test(given) ? given : monthOf(date);
}

class BadRequest extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

/* ---------- 利息（日割り） ---------- */

/** 年利を日割りするときの分母。うるう年も 365 日として扱う。 */
const DAY_BASIS = 365;

/** ISO 日付間の日数。過去に戻る向きは 0 とし、利息を巻き戻さない。 */
function daysBetween(fromISO, toISO) {
  if (!ISO_DATE.test(fromISO || '') || !ISO_DATE.test(toISO || '')) return 0;
  const [y1, m1, d1] = fromISO.split('-').map(Number);
  const [y2, m2, d2] = toISO.split('-').map(Number);
  const diff = Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1);
  return Math.max(0, Math.round(diff / 86400000));
}

/**
 * 起算日 (accrued_at) から toISO までに発生した利息を求める。
 * 利息は**元金にのみ**付く。未払いのまま残った利息がさらに利息を生むことはない。
 */
function accrue(d, toISO) {
  const days = daysBetween(d.accrued_at, toISO);
  const add = d.principal * (d.rate / 100 / DAY_BASIS) * days;
  return { days, add, interest: d.interest_accrued + add };
}

/* ---------- 旧スキーマからの移行 ---------- */

/**
 * balance 一本だった頃の DB を、元金＋未払利息の形に移す。
 * 残高はすべて元金として引き継ぎ、未払利息は 0 から始める。
 * 起算日は移行した日。過去に遡って利息を作り出すことはしない。
 */
(function migrate() {
  const cols = new Set(db.prepare('PRAGMA table_info(debts)').all().map(c => c.name));
  if (!cols.has('balance')) return;
  tx(() => {
    if (!cols.has('principal')) {
      db.exec(`ALTER TABLE debts ADD COLUMN principal REAL NOT NULL DEFAULT 0`);
      db.exec(`ALTER TABLE debts ADD COLUMN interest_accrued REAL NOT NULL DEFAULT 0`);
      db.exec(`ALTER TABLE debts ADD COLUMN accrued_at TEXT NOT NULL DEFAULT ''`);
    }
    db.prepare('UPDATE debts SET principal = balance, interest_accrued = 0, accrued_at = ?')
      .run(localToday());
    db.exec('ALTER TABLE debts DROP COLUMN balance');
  });
  console.log('[db] 借入を「元金＋未払利息」の形に移行しました');
})();

/** 引落月を持たなかった頃の記録に、利用月をそのまま入れる（＝現金払い扱い）。 */
(function migrateTxns() {
  const cols = new Set(db.prepare('PRAGMA table_info(txns)').all().map(c => c.name));
  if (!cols.has('pay_month')) {
    db.exec(`ALTER TABLE txns ADD COLUMN pay_month TEXT NOT NULL DEFAULT ''`);
  }
  const n = db.prepare("SELECT COUNT(*) AS n FROM txns WHERE pay_month = ''").get().n;
  if (!n) return;
  db.exec("UPDATE txns SET pay_month = substr(date, 1, 7) WHERE pay_month = ''");
  console.log('[db] 収支 ' + n + ' 件に引落月を補いました');
})();

/** どのカードで払ったかを持てるようにする。空欄は現金・口座払い、または未指定のカード。 */
(function migrateTxnCard() {
  const cols = new Set(db.prepare('PRAGMA table_info(txns)').all().map(c => c.name));
  if (cols.has('card_id')) return;
  db.exec(`ALTER TABLE txns ADD COLUMN card_id TEXT NOT NULL DEFAULT ''`);
})();

/* ---------- 読み取り ---------- */

const Q = {
  debts: db.prepare(`SELECT id, name, principal, interest_accrued AS interestAccrued,
                            accrued_at AS accruedAt, initial, rate,
                            min_payment AS minPayment, created_at AS createdAt
                     FROM debts ORDER BY created_at, rowid`),
  txns: db.prepare(`SELECT id, type, date, amount, category, memo,
                           pay_month AS payMonth, card_id AS cardId
                    FROM txns ORDER BY date DESC, rowid DESC`),
  cards: db.prepare(`SELECT id, name, created_at AS createdAt
                     FROM cards ORDER BY created_at, rowid`),
  cardBills: db.prepare(`SELECT id, card_id AS cardId, pay_month AS payMonth, amount, memo
                         FROM card_bills ORDER BY pay_month DESC, rowid`),
  card: db.prepare('SELECT * FROM cards WHERE id = ?'),
  reps: db.prepare(`SELECT id, debt_id AS debtId, date, amount, interest, principal, memo
                    FROM repayments ORDER BY date DESC, rowid DESC`),
  goals: db.prepare(`SELECT target_date AS targetDate, monthly_repay AS monthlyRepay,
                            emergency, emergency_current AS emergencyCurrent
                     FROM goals WHERE id = 1`),
  debt: db.prepare('SELECT * FROM debts WHERE id = ?'),
  rep:  db.prepare('SELECT * FROM repayments WHERE id = ?')
};

/**
 * DB に入っているのは「起算日時点」の元金と未払利息。
 * 画面が欲しいのは「今日時点」なので、起算日から今日までの分をここで足して返す。
 * 足した結果は保存しない（保存するのは返済を記録したときだけ）。
 */
function asOfToday(d, today) {
  const days = daysBetween(d.accruedAt, today);
  const pending = d.principal * (d.rate / 100 / DAY_BASIS) * days;
  const interestToday = d.interestAccrued + pending;
  return Object.assign({}, d, {
    pendingDays: days,
    pendingInterest: pending,
    interestToday,
    balance: d.principal + interestToday
  });
}

function getState() {
  const today = localToday();
  return {
    debts: Q.debts.all().map(d => asOfToday(d, today)),
    cards: Q.cards.all(),
    cardBills: Q.cardBills.all(),
    txns: Q.txns.all(),
    repayments: Q.reps.all(),
    goals: Q.goals.get() || { targetDate: '', monthlyRepay: 0, emergency: 0, emergencyCurrent: 0 }
  };
}

/* ---------- 借入 ---------- */

/**
 * フォームや取り込み JSON の値をそろえる。
 * principal / interestAccrued が無い古い形（balance だけ）は、全額を元金として読む。
 */
function debtFields(b) {
  const split = b.principal != null || b.interestAccrued != null;
  const principal = Math.max(0, split ? num(b.principal) : num(b.balance));
  const interest = Math.max(0, num(b.interestAccrued));
  const balance = principal + interest;
  return {
    principal, interest,
    accruedAt: dateOr(b.accruedAt, localToday()),
    initial: Math.max(balance, num(b.initial) || balance),
    rate: Math.min(100, Math.max(0, num(b.rate))),
    minPayment: Math.max(0, num(b.minPayment))
  };
}

function addDebt(b) {
  const name = str(b.name, 60);
  if (!name) throw new BadRequest('借入先の名前を入力してください');
  const f = debtFields(b);
  const id = uid();
  db.prepare(`INSERT INTO debts (id, name, principal, interest_accrued, accrued_at,
                                 initial, rate, min_payment, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, name, f.principal, f.interest, f.accruedAt,
         f.initial, f.rate, f.minPayment, localToday());
  return id;
}

function updateDebt(id, b) {
  if (!Q.debt.get(id)) throw new BadRequest('その借入は見つかりません');
  const name = str(b.name, 60);
  if (!name) throw new BadRequest('借入先の名前を入力してください');
  const f = debtFields(b);
  db.prepare(`UPDATE debts SET name=?, principal=?, interest_accrued=?, accrued_at=?,
                               initial=?, rate=?, min_payment=? WHERE id=?`)
    .run(name, f.principal, f.interest, f.accruedAt, f.initial, f.rate, f.minPayment, id);
}

/** 借入の削除。ON DELETE CASCADE で返済記録も一緒に消える。 */
function deleteDebt(id) {
  db.prepare('DELETE FROM debts WHERE id = ?').run(id);
}

/* ---------- 返済 ---------- */

/**
 * 返済の記録と残高の更新は必ず一組で行う。
 * 途中で落ちて「記録はあるが残高が減っていない」状態にはならない。
 *
 * 手順は返済予定表と同じ順序:
 *   1. 起算日から返済日までの日割り利息を未払利息に積む
 *   2. 返済額をまず未払利息へ充当する
 *   3. 余った分だけを元金から引く
 */
function addRepayment(b) {
  const d = Q.debt.get(str(b.debtId, 40));
  if (!d) throw new BadRequest('その借入は見つかりません');
  const amount = num(b.amount);
  if (!(amount > 0)) throw new BadRequest('返済額は1円以上で入力してください');

  const date = dateOr(b.date, localToday());
  const acc = accrue(d, date);
  const paidInterest = Math.min(amount, acc.interest);
  const paidPrincipal = Math.min(amount - paidInterest, d.principal);
  // 過去の日付で記録しても起算日は戻さない。戻すと同じ期間の利息を二度積んでしまう。
  const accruedAt = date > d.accrued_at ? date : d.accrued_at;

  return tx(() => {
    const id = uid();
    db.prepare(`INSERT INTO repayments (id, debt_id, date, amount, interest, principal, memo)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, d.id, date, amount, paidInterest, paidPrincipal, str(b.memo, 60));
    db.prepare('UPDATE debts SET principal=?, interest_accrued=?, accrued_at=? WHERE id=?')
      .run(d.principal - paidPrincipal, acc.interest - paidInterest, accruedAt, d.id);
    return id;
  });
}

/** 返済の取り消し。利息充当分と元金充当分をそれぞれ戻すところまでを一組で行う。 */
function deleteRepayment(id) {
  const r = Q.rep.get(id);
  if (!r) return;
  tx(() => {
    db.prepare(`UPDATE debts SET principal = principal + ?, interest_accrued = interest_accrued + ?
                WHERE id = ?`)
      .run(Math.max(0, r.principal), Math.max(0, r.interest), r.debt_id);
    db.prepare('DELETE FROM repayments WHERE id = ?').run(id);
  });
}

/* ---------- 収入・支出 ---------- */

function addTxn(b) {
  const type = b.type === 'income' ? 'income' : 'expense';
  const amount = num(b.amount);
  if (!(amount > 0)) throw new BadRequest('金額は1円以上で入力してください');
  const date = dateOr(b.date, localToday());
  const id = uid();
  // 収入は受け取った月がそのまま現金の動き。引落月を選べるのは支出だけ。
  const payMonth = type === 'income' ? monthOf(date) : payMonthOf(b, date);
  // 実在しないカードを指していたら現金・口座払いに倒す
  const cardId = type === 'income' ? '' : str(b.cardId, 40);
  const card = cardId && Q.card.get(cardId) ? cardId : '';
  db.prepare(`INSERT INTO txns (id, type, date, amount, category, memo, pay_month, card_id)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, type, date, amount, str(b.category, 30) || 'その他', str(b.memo, 60), payMonth, card);
  return id;
}

function deleteTxn(id) {
  db.prepare('DELETE FROM txns WHERE id = ?').run(id);
}

/* ---------- クレジットカード ---------- */

function addCard(b) {
  const name = str(b.name, 40);
  if (!name) throw new BadRequest('カードの名前を入力してください');
  const id = uid();
  db.prepare('INSERT INTO cards (id, name, created_at) VALUES (?,?,?)')
    .run(id, name, localToday());
  return id;
}

function updateCard(id, b) {
  if (!Q.card.get(id)) throw new BadRequest('そのカードは見つかりません');
  const name = str(b.name, 40);
  if (!name) throw new BadRequest('カードの名前を入力してください');
  db.prepare('UPDATE cards SET name = ? WHERE id = ?').run(name, id);
}

/** カードを消すと請求額も消える。明細側は現金・口座払い扱いに戻す。 */
function deleteCard(id) {
  tx(() => {
    db.prepare("UPDATE txns SET card_id = '' WHERE card_id = ?").run(id);
    db.prepare('DELETE FROM cards WHERE id = ?').run(id);
  });
}

/**
 * 請求額の登録。1枚のカードにつき1ヶ月1件なので、同じ月なら上書きする。
 * 0円を入れると「その月は請求なし」として扱われ、明細からの推定も止まる。
 */
function setCardBill(b) {
  const cardId = str(b.cardId, 40);
  if (!Q.card.get(cardId)) throw new BadRequest('そのカードは見つかりません');
  const payMonth = str(b.payMonth, 7);
  if (!ISO_MONTH.test(payMonth)) throw new BadRequest('引落月は YYYY-MM の形で指定してください');
  const amount = Math.max(0, num(b.amount));
  db.prepare(`INSERT INTO card_bills (id, card_id, pay_month, amount, memo)
              VALUES (?,?,?,?,?)
              ON CONFLICT(card_id, pay_month)
              DO UPDATE SET amount = excluded.amount, memo = excluded.memo`)
    .run(uid(), cardId, payMonth, amount, str(b.memo, 60));
}

function deleteCardBill(id) {
  db.prepare('DELETE FROM card_bills WHERE id = ?').run(id);
}

/* ---------- 目標 ---------- */

function setGoals(b) {
  db.prepare(`UPDATE goals SET target_date=?, monthly_repay=?, emergency=?, emergency_current=?
              WHERE id = 1`)
    .run(dateOr(b.targetDate, ''), Math.max(0, num(b.monthlyRepay)),
         Math.max(0, num(b.emergency)), Math.max(0, num(b.emergencyCurrent)));
}

/* ---------- 一括操作 ---------- */

function wipe() {
  tx(() => {
    db.exec('DELETE FROM repayments; DELETE FROM txns; DELETE FROM debts; DELETE FROM cards;');
    db.prepare(`UPDATE goals SET target_date='', monthly_repay=0, emergency=0, emergency_current=0
                WHERE id=1`).run();
  });
}

/** JSON バックアップの取り込み。全置換を一括で行う。 */
function importState(p) {
  if (!p || !Array.isArray(p.debts)) throw new BadRequest('バックアップの形式が違います');
  tx(() => {
    db.exec('DELETE FROM repayments; DELETE FROM txns; DELETE FROM debts; DELETE FROM cards;');

    const insC = db.prepare('INSERT OR IGNORE INTO cards (id,name,created_at) VALUES (?,?,?)');
    const cardIds = new Set();
    for (const c of (p.cards || [])) {
      const id = str(c.id, 40) || uid();
      if (cardIds.has(id)) continue;
      cardIds.add(id);
      insC.run(id, str(c.name, 40) || '名称未設定', dateOr(c.createdAt, localToday()));
    }
    const insB = db.prepare(`INSERT OR IGNORE INTO card_bills (id,card_id,pay_month,amount,memo)
                             VALUES (?,?,?,?,?)`);
    for (const b of (p.cardBills || [])) {
      const cid = str(b.cardId, 40);
      const pm = str(b.payMonth, 7);
      if (!cardIds.has(cid) || !ISO_MONTH.test(pm)) continue;   // 宛先の無い請求は捨てる
      insB.run(str(b.id, 40) || uid(), cid, pm, Math.max(0, num(b.amount)), str(b.memo, 60));
    }

    const insD = db.prepare(`INSERT INTO debts (id,name,principal,interest_accrued,accrued_at,
                                                initial,rate,min_payment,created_at)
                             VALUES (?,?,?,?,?,?,?,?,?)`);
    const seen = new Set();
    for (const d of p.debts) {
      const id = str(d.id, 40) || uid();
      if (seen.has(id)) continue;
      seen.add(id);
      const f = debtFields(d);   // balance しか無い旧バックアップも読める
      insD.run(id, str(d.name, 60) || '名称未設定', f.principal, f.interest, f.accruedAt,
               f.initial, f.rate, f.minPayment, dateOr(d.createdAt, localToday()));
    }

    const insT = db.prepare(`INSERT OR IGNORE INTO txns (id,type,date,amount,category,memo,pay_month,card_id)
                             VALUES (?,?,?,?,?,?,?,?)`);
    for (const t of (p.txns || [])) {
      const amt = num(t.amount);
      if (!(amt > 0)) continue;
      const type = t.type === 'income' ? 'income' : 'expense';
      const date = dateOr(t.date, localToday());
      const cid = type === 'income' ? '' : str(t.cardId, 40);
      insT.run(str(t.id, 40) || uid(), type, date, amt,
               str(t.category, 30) || 'その他', str(t.memo, 60),
               type === 'income' ? monthOf(date) : payMonthOf(t, date),
               cardIds.has(cid) ? cid : '');
    }

    const insR = db.prepare(`INSERT OR IGNORE INTO repayments (id,debt_id,date,amount,interest,principal,memo)
                             VALUES (?,?,?,?,?,?,?)`);
    for (const r of (p.repayments || [])) {
      const amt = num(r.amount);
      if (!(amt > 0) || !seen.has(str(r.debtId, 40))) continue;   // 存在しない借入の記録は捨てる
      insR.run(str(r.id, 40) || uid(), str(r.debtId, 40), dateOr(r.date, localToday()),
               amt, Math.max(0, num(r.interest)), Math.max(0, num(r.principal)), str(r.memo, 60));
    }

    const g = p.goals || {};
    db.prepare(`UPDATE goals SET target_date=?, monthly_repay=?, emergency=?, emergency_current=? WHERE id=1`)
      .run(dateOr(g.targetDate, ''), Math.max(0, num(g.monthlyRepay)),
           Math.max(0, num(g.emergency)), Math.max(0, num(g.emergencyCurrent)));
  });
}

/* ---------- サンプルデータ ---------- */

function loadSample() {
  const now = new Date();
  const today = localToday();
  const mk = i => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  };

  tx(() => {
    db.exec('DELETE FROM repayments; DELETE FROM txns; DELETE FROM debts;');

    // 金額は「6ヶ月前の元金」。ここから毎月27日の返済を実際に積み上げて現在の残高を作るので、
    // 履歴の利息と元金の内訳も、表示される残高と辻褄が合う。
    const debts = [
      ['銀行カードローン', 1330000, 1500000, 14.5, 30000, 38000],
      ['自動車ローン',     1030000, 1800000, 3.9,  32000, 32000],
      ['クレジット分割',    320000,  400000, 15.0, 15000, 15000]
    ].map(([name, prin, init, rate, min, pay]) => {
      const id = uid();
      db.prepare(`INSERT INTO debts (id,name,principal,interest_accrued,accrued_at,
                                     initial,rate,min_payment,created_at)
                  VALUES (?,?,?,0,?,?,?,?,?)`)
        .run(id, name, prin, mk(6) + '-27', init, rate, min, mk(10) + '-01');
      return { id, prin, rate, pay, accruedAt: mk(6) + '-27' };
    });

    const insT = db.prepare(`INSERT INTO txns (id,type,date,amount,category,memo,pay_month)
                             VALUES (?,?,?,?,?,?,?)`);
    // カードで払いがちな費目。利用した月ではなく翌月に口座から出ていく。
    const CARD = new Set(['通信', '娯楽', '交際費', '被服']);
    const insR = db.prepare(`INSERT INTO repayments (id,debt_id,date,amount,interest,principal,memo)
                             VALUES (?,?,?,?,?,?,?)`);
    const EX = [['住居', 82000], ['食費', 54000], ['水道光熱', 16500], ['通信', 9800],
                ['交通', 12000], ['保険', 14000], ['日用品', 11500], ['交際費', 9000], ['娯楽', 7500]];

    for (let i = 5; i >= 0; i--) {
      const m = mk(i);
      insT.run(uid(), 'income', m + '-25', 328000 + (i % 2 ? 0 : 4000), '給与', '', m);
      if (i === 1) insT.run(uid(), 'income', m + '-10', 420000, '賞与', '夏季', m);
      EX.forEach(([c, v], k) =>
        insT.run(uid(), 'expense', m + '-' + String(3 + k * 2).padStart(2, '0'),
                 v + ((i * 7 + k * 3) % 5) * 400, c,
                 CARD.has(c) ? 'カード払い' : '',
                 CARD.has(c) ? addMonthKey(m, 1) : m));
      debts.forEach(d => {
        const date = m + '-27';
        if (date > today) return;          // まだ来ていない返済日は記録しない
        const interest = d.prin * (d.rate / 100 / DAY_BASIS) * daysBetween(d.accruedAt, date);
        const paidInterest = Math.min(d.pay, interest);
        const paidPrincipal = Math.min(d.pay - paidInterest, d.prin);
        insR.run(uid(), d.id, date, d.pay, paidInterest, paidPrincipal, '');
        d.prin -= paidPrincipal;
        d.accruedAt = date;
      });
    }

    const upd = db.prepare('UPDATE debts SET principal=?, accrued_at=? WHERE id=?');
    debts.forEach(d => upd.run(d.prin, d.accruedAt, d.id));

    db.prepare(`UPDATE goals SET target_date=?, monthly_repay=?, emergency=?, emergency_current=? WHERE id=1`)
      .run((now.getFullYear() + 3) + '-03-31', 95000, 600000, 180000);
  });
}

/* ---------- バックアップ ---------- */

/**
 * SQLite の VACUUM INTO で、実行中でも壊れないバックアップを作る。
 * 単なるファイルコピーと違い、書き込み途中の状態を掴むことがない。
 */
function backup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `saimu-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return { file, size: fs.statSync(file).size };
}

function stats() {
  const one = sql => db.prepare(sql).get().n;
  let size = 0;
  try { size = fs.statSync(DB_PATH).size; } catch (_) {}
  return {
    path: DB_PATH,
    size,
    debts: one('SELECT COUNT(*) AS n FROM debts'),
    txns: one('SELECT COUNT(*) AS n FROM txns'),
    repayments: one('SELECT COUNT(*) AS n FROM repayments'),
    backupDir: BACKUP_DIR
  };
}

module.exports = {
  DB_PATH, BadRequest, DAY_BASIS, daysBetween, addMonthKey,
  getState, stats,
  addCard, updateCard, deleteCard, setCardBill, deleteCardBill,
  addDebt, updateDebt, deleteDebt,
  addRepayment, deleteRepayment,
  addTxn, deleteTxn,
  setGoals,
  wipe, importState, loadSample, backup
};

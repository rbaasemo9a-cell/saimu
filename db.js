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
  -- 現在の状態。返済を記録するたびに、下の起点から再生して組み立て直す。
  principal        REAL NOT NULL DEFAULT 0 CHECK(principal >= 0),
  interest_accrued REAL NOT NULL DEFAULT 0 CHECK(interest_accrued >= 0),
  accrued_at       TEXT NOT NULL DEFAULT '',
  -- 起点。「この日時点でこの残高だった」という申告そのもの。
  -- 返済の入力順に影響されないよう、ここは返済では動かさない。
  origin_principal REAL NOT NULL DEFAULT 0,
  origin_interest  REAL NOT NULL DEFAULT 0,
  origin_date      TEXT NOT NULL DEFAULT '',
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

-- 追加で借りた記録。返済と同じ時間軸に並べ、日付順に再生して残高を組み立てる。
CREATE TABLE IF NOT EXISTS borrows (
  id      TEXT PRIMARY KEY,
  debt_id TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  date    TEXT NOT NULL,
  amount  REAL NOT NULL CHECK(amount > 0),
  memo    TEXT NOT NULL DEFAULT ''
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

-- 毎月決まって出入りするお金。目標から逆算して「あといくら必要か」を出すのに使う。
-- ここに入れても収支の記録にはならない。あくまで計画のための数字。
CREATE TABLE IF NOT EXISTS fixed_items (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK(type IN ('income','expense')),
  name       TEXT NOT NULL DEFAULT '',
  day        INTEGER NOT NULL DEFAULT 0 CHECK(day >= 0 AND day <= 31),
  category   TEXT NOT NULL DEFAULT 'その他',
  amount     REAL NOT NULL CHECK(amount >= 0),
  memo       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- ふるさと納税の上限を出すための、年ごとの申告内容。
-- 収入・経費・社会保険料は収支の記録から集計できるので、ここは 0 のまま置ける。
-- 0 以外を入れたときだけ、その数字が記録より優先される。
CREATE TABLE IF NOT EXISTS tax_years (
  year       INTEGER PRIMARY KEY CHECK(year >= 2000 AND year <= 2200),
  salary     REAL NOT NULL DEFAULT 0 CHECK(salary >= 0),      -- 給与の年収（額面）
  biz_income REAL NOT NULL DEFAULT 0 CHECK(biz_income >= 0),  -- 事業・副業の売上
  biz_cost   REAL NOT NULL DEFAULT 0 CHECK(biz_cost >= 0),    -- その経費
  social     REAL NOT NULL DEFAULT 0 CHECK(social >= 0),      -- 社会保険料控除
  blue       REAL NOT NULL DEFAULT 0 CHECK(blue >= 0),        -- 青色申告特別控除
  life_ins   REAL NOT NULL DEFAULT 0 CHECK(life_ins >= 0),    -- 生命保険料控除
  ideco      REAL NOT NULL DEFAULT 0 CHECK(ideco >= 0),       -- 小規模企業共済等掛金控除
  medical    REAL NOT NULL DEFAULT 0 CHECK(medical >= 0),     -- 医療費控除
  family     REAL NOT NULL DEFAULT 0 CHECK(family >= 0),      -- 配偶者・扶養の控除
  other_ded  REAL NOT NULL DEFAULT 0 CHECK(other_ded >= 0),   -- その他の所得控除
  -- 住民税決定通知書に載っている所得割額。入っていれば、これが一番正確なので優先する。
  levy       REAL NOT NULL DEFAULT 0 CHECK(levy >= 0),
  memo       TEXT NOT NULL DEFAULT ''
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

/**
 * 起点を持たなかった頃の借入に、今の状態をそのまま起点として入れる。
 * 既存の返済はすべて起点より前になるので再生の対象外になり、残高は変わらない。
 */
(function migrateDebtOrigin() {
  const cols = new Set(db.prepare('PRAGMA table_info(debts)').all().map(c => c.name));
  if (cols.has('origin_date')) return;
  db.exec(`ALTER TABLE debts ADD COLUMN origin_principal REAL NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE debts ADD COLUMN origin_interest  REAL NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE debts ADD COLUMN origin_date      TEXT NOT NULL DEFAULT ''`);
  const n = db.prepare('SELECT COUNT(*) AS n FROM debts').get().n;
  db.exec(`UPDATE debts SET origin_principal = principal,
                            origin_interest  = interest_accrued,
                            origin_date      = accrued_at`);
  if (n) console.log('[db] 借入 ' + n + ' 件に、いまの状態を起点として記録しました');
})();

/** 固定収支に項目名と日付を持たせる。名前が空なら、それまでのカテゴリ名を使う。 */
(function migrateFixed() {
  const cols = new Set(db.prepare('PRAGMA table_info(fixed_items)').all().map(c => c.name));
  if (!cols.has('name')) db.exec(`ALTER TABLE fixed_items ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
  if (!cols.has('day')) db.exec(`ALTER TABLE fixed_items ADD COLUMN day INTEGER NOT NULL DEFAULT 0`);
  db.exec("UPDATE fixed_items SET name = category WHERE name = ''");
})();

/** どのカードで払ったかを持てるようにする。空欄は現金・口座払い、または未指定のカード。 */
(function migrateTxnCard() {
  const cols = new Set(db.prepare('PRAGMA table_info(txns)').all().map(c => c.name));
  if (cols.has('card_id')) return;
  db.exec(`ALTER TABLE txns ADD COLUMN card_id TEXT NOT NULL DEFAULT ''`);
})();

/** 支出を経費として何割計上するかを持たせる。0 は経費にしない、100 は全額。 */
(function migrateTxnCost() {
  const cols = new Set(db.prepare('PRAGMA table_info(txns)').all().map(c => c.name));
  if (cols.has('cost_rate')) return;
  db.exec(`ALTER TABLE txns ADD COLUMN cost_rate INTEGER NOT NULL DEFAULT 0`);
})();

/* ---------- 読み取り ---------- */

const Q = {
  debts: db.prepare(`SELECT id, name, principal, interest_accrued AS interestAccrued,
                            accrued_at AS accruedAt, origin_date AS originDate,
                            initial, rate,
                            min_payment AS minPayment, created_at AS createdAt
                     FROM debts ORDER BY created_at, rowid`),
  txns: db.prepare(`SELECT id, type, date, amount, category, memo,
                           pay_month AS payMonth, card_id AS cardId,
                           cost_rate AS costRate
                    FROM txns ORDER BY date DESC, rowid DESC`),
  tax: db.prepare(`SELECT year, salary, biz_income AS bizIncome, biz_cost AS bizCost,
                          social, blue, life_ins AS lifeIns, ideco, medical, family,
                          other_ded AS otherDed, levy, memo
                   FROM tax_years ORDER BY year DESC`),
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
  borrows: db.prepare(`SELECT id, debt_id AS debtId, date, amount, memo
                       FROM borrows ORDER BY date DESC, rowid DESC`),
  fixed: db.prepare(`SELECT id, type, name, day, category, amount, memo,
                            created_at AS createdAt
                     FROM fixed_items
                     ORDER BY type DESC, CASE WHEN day = 0 THEN 99 ELSE day END, rowid`),
  debt: db.prepare('SELECT * FROM debts WHERE id = ?'),
  rep:  db.prepare('SELECT * FROM repayments WHERE id = ?'),
  borrow: db.prepare('SELECT * FROM borrows WHERE id = ?')
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
    borrows: Q.borrows.all(),
    fixed: Q.fixed.all(),
    txns: Q.txns.all(),
    tax: Q.tax.all(),
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
                                 origin_principal, origin_interest, origin_date,
                                 initial, rate, min_payment, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, f.principal, f.interest, f.accruedAt,
         f.principal, f.interest, f.accruedAt,
         f.initial, f.rate, f.minPayment, localToday());
  return id;
}

function updateDebt(id, b) {
  if (!Q.debt.get(id)) throw new BadRequest('その借入は見つかりません');
  const name = str(b.name, 60);
  if (!name) throw new BadRequest('借入先の名前を入力してください');
  const f = debtFields(b);
  // 編集は「この日時点でこの残高だった」という申告し直し。起点も一緒に更新し、
  // それ以降の返済を再生して現在の状態を組み直す。
  tx(() => {
    db.prepare(`UPDATE debts SET name=?, principal=?, interest_accrued=?, accrued_at=?,
                                 origin_principal=?, origin_interest=?, origin_date=?,
                                 initial=?, rate=?, min_payment=? WHERE id=?`)
      .run(name, f.principal, f.interest, f.accruedAt,
           f.principal, f.interest, f.accruedAt,
           f.initial, f.rate, f.minPayment, id);
    rebuild(id);
  });
}

/** 借入の削除。ON DELETE CASCADE で返済記録も一緒に消える。 */
function deleteDebt(id) {
  db.prepare('DELETE FROM debts WHERE id = ?').run(id);
}

/* ---------- 返済 ---------- */

/**
 * 借入の現在の状態を、起点から返済を**日付順に**再生して組み立て直す。
 *
 * 各回の手順は返済予定表と同じ:
 *   1. 前回からその返済日までの日割り利息を未払利息に積む
 *   2. 返済額をまず未払利息へ充当する
 *   3. 余った分だけを元金から引く
 *
 * 入力した順ではなく日付の順で計算するので、あとから過去の返済を足しても
 * 結果は変わらない。各返済の利息／元金の内訳もここで書き直す。
 */
function rebuild(debtId) {
  const d = Q.debt.get(debtId);
  if (!d) return;

  // 追加借入と返済を1本の時間軸に並べる。同じ日なら借りてから返した順に扱う。
  const events = [];
  db.prepare(`SELECT id, date, amount FROM borrows WHERE debt_id = ? AND date >= ?
              ORDER BY date, rowid`).all(debtId, d.origin_date)
    .forEach(b => events.push({ kind: 0, date: b.date, amount: b.amount, id: b.id }));
  db.prepare(`SELECT id, date, amount FROM repayments WHERE debt_id = ? AND date >= ?
              ORDER BY date, rowid`).all(debtId, d.origin_date)
    .forEach(r => events.push({ kind: 1, date: r.date, amount: r.amount, id: r.id }));
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.kind - b.kind));

  let principal = d.origin_principal;
  let interest = d.origin_interest;
  let cursor = d.origin_date;

  const upd = db.prepare('UPDATE repayments SET interest = ?, principal = ? WHERE id = ?');
  for (const e of events) {
    // どちらの出来事でも、まずそこまでの利息を積む
    interest += principal * (d.rate / 100 / DAY_BASIS) * daysBetween(cursor, e.date);
    if (e.kind === 0) {
      principal += e.amount;                       // 追加で借りた
    } else {
      const paidInterest = Math.min(e.amount, interest);
      const paidPrincipal = Math.min(e.amount - paidInterest, principal);
      upd.run(paidInterest, paidPrincipal, e.id);
      interest -= paidInterest;
      principal -= paidPrincipal;
    }
    if (e.date > cursor) cursor = e.date;
  }

  db.prepare('UPDATE debts SET principal=?, interest_accrued=?, accrued_at=? WHERE id=?')
    .run(principal, interest, cursor, debtId);
}

/**
 * 返済の記録。記録と残高の組み直しを必ず一組で行うので、
 * 途中で落ちて「記録はあるが残高が減っていない」状態にはならない。
 */
function addRepayment(b) {
  const d = Q.debt.get(str(b.debtId, 40));
  if (!d) throw new BadRequest('その借入は見つかりません');
  const amount = num(b.amount);
  if (!(amount > 0)) throw new BadRequest('返済額は1円以上で入力してください');

  const date = dateOr(b.date, localToday());
  // 起点より前の返済も記録はできる。ただし残高には反映しない。
  // 「この日にこの残高だった」という申告に既に含まれているので、
  // 差し引くと二重に減ってしまう。rebuild が起点以降だけを再生する。
  return tx(() => {
    const id = uid();
    db.prepare(`INSERT INTO repayments (id, debt_id, date, amount, interest, principal, memo)
                VALUES (?,?,?,?,0,0,?)`)
      .run(id, d.id, date, amount, str(b.memo, 60));
    rebuild(d.id);
    return id;
  });
}

/**
 * 追加で借りた記録。カードローンのように、返済しながらまた借りる形に対応する。
 * 当初借入額も増やす。進捗率が「借りた総額のうちいくら返したか」を表すようにするため。
 */
function addBorrow(b) {
  const d = Q.debt.get(str(b.debtId, 40));
  if (!d) throw new BadRequest('その借入は見つかりません');
  const amount = num(b.amount);
  if (!(amount > 0)) throw new BadRequest('借入額は1円以上で入力してください');

  const date = dateOr(b.date, localToday());
  // 返済と同じく、起点より前の借入も記録だけはできる（残高には反映しない）。
  return tx(() => {
    const id = uid();
    db.prepare('INSERT INTO borrows (id, debt_id, date, amount, memo) VALUES (?,?,?,?,?)')
      .run(id, d.id, date, amount, str(b.memo, 60));
    // 残高に反映しない（起点より前の）借入では、当初借入額も動かさない
    if (!d.origin_date || date >= d.origin_date) {
      db.prepare('UPDATE debts SET initial = initial + ? WHERE id = ?').run(amount, d.id);
    }
    rebuild(d.id);
    return id;
  });
}

function deleteBorrow(id) {
  const b = Q.borrow.get(id);
  if (!b) return;
  tx(() => {
    db.prepare('DELETE FROM borrows WHERE id = ?').run(id);
    const d0 = Q.debt.get(b.debt_id);
    if (d0 && (!d0.origin_date || b.date >= d0.origin_date)) {
      db.prepare('UPDATE debts SET initial = MAX(0, initial - ?) WHERE id = ?')
        .run(b.amount, b.debt_id);
    }
    rebuild(b.debt_id);
  });
}

/** 返済の取り消し。消してから残りを組み直すので、順番に関係なく元の状態に戻る。 */
function deleteRepayment(id) {
  const r = Q.rep.get(id);
  if (!r) return;
  tx(() => {
    db.prepare('DELETE FROM repayments WHERE id = ?').run(id);
    rebuild(r.debt_id);
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
  // 経費は支出だけの概念。収入に付いていても無視する。
  const costRate = type === 'income' ? 0 : clampInt(b.costRate, 0, 100);
  db.prepare(`INSERT INTO txns (id, type, date, amount, category, memo, pay_month, card_id, cost_rate)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, type, date, amount, str(b.category, 30) || 'その他', str(b.memo, 60),
         payMonth, card, costRate);
  return id;
}

/**
 * ある年のあるカテゴリの支出を、まとめて経費にする。
 * 12ヶ月ぶんの通信費を1件ずつ触るのはスマホでは現実的でない。
 */
function setTxnCostBulk(b) {
  const year = clampInt(b.year, 2000, 2200);
  if (!year) throw new BadRequest('年を指定してください');
  const category = str(b.category, 30);
  if (!category) throw new BadRequest('カテゴリを指定してください');
  const rate = clampInt(b.costRate, 0, 100);
  const r = db.prepare(`UPDATE txns SET cost_rate = ?
                        WHERE type = 'expense' AND category = ?
                          AND date >= ? AND date <= ?`)
    .run(rate, category, year + '-01-01', year + '-12-31');
  return r.changes;
}

/** 既にある支出を、あとから経費に切り替える。金額や日付はここでは触らない。 */
function setTxnCost(id, b) {
  const t = db.prepare('SELECT type FROM txns WHERE id = ?').get(id);
  if (!t) throw new BadRequest('その記録は見つかりません');
  if (t.type !== 'expense') throw new BadRequest('経費にできるのは支出だけです');
  db.prepare('UPDATE txns SET cost_rate = ? WHERE id = ?').run(clampInt(b.costRate, 0, 100), id);
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

/* ---------- 毎月の固定収支 ---------- */

/** 毎月何日か。0 は未設定。31 を超える指定は月末に丸める。 */
/** 整数に丸めて範囲に収める。範囲外や数字でないものは 0 にする。 */
function clampInt(v, lo, hi) {
  const n = Math.round(num(v));
  if (!Number.isFinite(n) || n < lo || n > hi) return 0;
  return n;
}

function dayOfMonth(v) {
  const d = Math.round(num(v));
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.min(31, d);
}

function fixedFields(b) {
  const name = str(b.name, 40);
  if (!name) throw new BadRequest('項目名を入力してください');
  const amount = Math.max(0, num(b.amount));
  if (!(amount > 0)) throw new BadRequest('金額は1円以上で入力してください');
  return { name, day: dayOfMonth(b.day), amount,
           category: str(b.category, 30) || name, memo: str(b.memo, 60) };
}

function addFixed(b) {
  const type = b.type === 'income' ? 'income' : 'expense';
  const f = fixedFields(b);
  const id = uid();
  db.prepare(`INSERT INTO fixed_items (id, type, name, day, category, amount, memo, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, type, f.name, f.day, f.category, f.amount, f.memo, localToday());
  return id;
}

function updateFixed(id, b) {
  if (!db.prepare('SELECT id FROM fixed_items WHERE id = ?').get(id)) {
    throw new BadRequest('その項目は見つかりません');
  }
  const f = fixedFields(b);
  db.prepare('UPDATE fixed_items SET name=?, day=?, category=?, amount=?, memo=? WHERE id=?')
    .run(f.name, f.day, f.category, f.amount, f.memo, id);
}

function deleteFixed(id) {
  db.prepare('DELETE FROM fixed_items WHERE id = ?').run(id);
}

/* ---------- ふるさと納税（年ごとの申告内容） ---------- */

/**
 * 年の内容を丸ごと差し替える。0 は「未入力」であって「ゼロと申告した」ではない。
 * 未入力のところは画面側が収支の記録から集計して埋める。
 */
function setTax(b) {
  const year = clampInt(b.year, 2000, 2200);
  if (!year) throw new BadRequest('年を指定してください');
  const n = k => Math.max(0, num(b[k]));
  db.prepare(`INSERT INTO tax_years
                (year, salary, biz_income, biz_cost, social, blue, life_ins, ideco,
                 medical, family, other_ded, levy, memo)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(year) DO UPDATE SET
                salary=excluded.salary, biz_income=excluded.biz_income,
                biz_cost=excluded.biz_cost, social=excluded.social, blue=excluded.blue,
                life_ins=excluded.life_ins, ideco=excluded.ideco, medical=excluded.medical,
                family=excluded.family, other_ded=excluded.other_ded, levy=excluded.levy,
                memo=excluded.memo`)
    .run(year, n('salary'), n('bizIncome'), n('bizCost'), n('social'), n('blue'),
         n('lifeIns'), n('ideco'), n('medical'), n('family'), n('otherDed'), n('levy'),
         str(b.memo, 60));
  return year;
}

function deleteTax(year) {
  db.prepare('DELETE FROM tax_years WHERE year = ?').run(clampInt(year, 2000, 2200));
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
    db.exec(`DELETE FROM repayments; DELETE FROM borrows; DELETE FROM txns;
             DELETE FROM debts; DELETE FROM cards; DELETE FROM fixed_items;
             DELETE FROM tax_years;`);
    db.prepare(`UPDATE goals SET target_date='', monthly_repay=0, emergency=0, emergency_current=0
                WHERE id=1`).run();
  });
}

/** JSON バックアップの取り込み。全置換を一括で行う。 */
function importState(p) {
  if (!p || !Array.isArray(p.debts)) throw new BadRequest('バックアップの形式が違います');
  tx(() => {
    db.exec(`DELETE FROM repayments; DELETE FROM borrows; DELETE FROM txns;
             DELETE FROM debts; DELETE FROM cards; DELETE FROM fixed_items;
             DELETE FROM tax_years;`);

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
                                                origin_principal,origin_interest,origin_date,
                                                initial,rate,min_payment,created_at)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const seen = new Set();
    for (const d of p.debts) {
      const id = str(d.id, 40) || uid();
      if (seen.has(id)) continue;
      seen.add(id);
      const f = debtFields(d);   // balance しか無い旧バックアップも読める
      // 書き出した時点の状態をそのまま起点にする。返済は履歴として残るが再生の対象外。
      insD.run(id, str(d.name, 60) || '名称未設定', f.principal, f.interest, f.accruedAt,
               f.principal, f.interest, f.accruedAt,
               f.initial, f.rate, f.minPayment, dateOr(d.createdAt, localToday()));
    }

    const insT = db.prepare(`INSERT OR IGNORE INTO txns
                             (id,type,date,amount,category,memo,pay_month,card_id,cost_rate)
                             VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const t of (p.txns || [])) {
      const amt = num(t.amount);
      if (!(amt > 0)) continue;
      const type = t.type === 'income' ? 'income' : 'expense';
      const date = dateOr(t.date, localToday());
      const cid = type === 'income' ? '' : str(t.cardId, 40);
      insT.run(str(t.id, 40) || uid(), type, date, amt,
               str(t.category, 30) || 'その他', str(t.memo, 60),
               type === 'income' ? monthOf(date) : payMonthOf(t, date),
               cardIds.has(cid) ? cid : '',
               type === 'income' ? 0 : clampInt(t.costRate, 0, 100));
    }

    const insR = db.prepare(`INSERT OR IGNORE INTO repayments (id,debt_id,date,amount,interest,principal,memo)
                             VALUES (?,?,?,?,?,?,?)`);
    for (const r of (p.repayments || [])) {
      const amt = num(r.amount);
      if (!(amt > 0) || !seen.has(str(r.debtId, 40))) continue;   // 存在しない借入の記録は捨てる
      insR.run(str(r.id, 40) || uid(), str(r.debtId, 40), dateOr(r.date, localToday()),
               amt, Math.max(0, num(r.interest)), Math.max(0, num(r.principal)), str(r.memo, 60));
    }

    const insBo = db.prepare(`INSERT OR IGNORE INTO borrows (id,debt_id,date,amount,memo)
                              VALUES (?,?,?,?,?)`);
    for (const b of (p.borrows || [])) {
      const amt = num(b.amount);
      if (!(amt > 0) || !seen.has(str(b.debtId, 40))) continue;   // 宛先の無い記録は捨てる
      insBo.run(str(b.id, 40) || uid(), str(b.debtId, 40), dateOr(b.date, localToday()),
                amt, str(b.memo, 60));
    }

    const insF = db.prepare(`INSERT OR IGNORE INTO fixed_items
                             (id,type,name,day,category,amount,memo,created_at)
                             VALUES (?,?,?,?,?,?,?,?)`);
    for (const f of (p.fixed || [])) {
      const amt = num(f.amount);
      if (!(amt > 0)) continue;
      const nm = str(f.name, 40) || str(f.category, 30) || 'その他';
      insF.run(str(f.id, 40) || uid(), f.type === 'income' ? 'income' : 'expense',
               nm, dayOfMonth(f.day), str(f.category, 30) || nm, amt, str(f.memo, 60),
               dateOr(f.createdAt, localToday()));
    }

    for (const t of (p.tax || [])) {
      // setTax は年が壊れていると投げる。取り込みでは1件捨てるだけにする。
      if (clampInt(t.year, 2000, 2200)) setTax(t);
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
                                     origin_principal,origin_interest,origin_date,
                                     initial,rate,min_payment,created_at)
                  VALUES (?,?,?,0,?,?,0,?,?,?,?,?)`)
        .run(id, name, prin, mk(6) + '-27', prin, mk(6) + '-27',
             init, rate, min, mk(10) + '-01');
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

    debts.forEach(d => rebuild(d.id));

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
  addBorrow, deleteBorrow,
  addFixed, updateFixed, deleteFixed,
  setTax, deleteTax, setTxnCost, setTxnCostBulk,
  addTxn, deleteTxn,
  setGoals,
  wipe, importState, loadSample, backup
};

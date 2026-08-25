/* ----------------------------------------------------------
   server.js の JSON API と同じ形をブラウザ側で再現する。
   呼び出し側（commit / 各画面）は元のままで動く。
   ---------------------------------------------------------- */

let mem = null;          // スプレッドシートに入っている生の状態

/**
 * 保存先から取り出した一覧。新しい種類のデータを足したとき、まだそれを持たない
 * 保存先や端末の控えを開いても落ちないようにする。
 * ここを直接 st.xxx.slice() と書いて、実際に3度画面を壊した。必ずこれを通す。
 */
const list = (st, name) => (Array.isArray(st && st[name]) ? st[name] : []);

/**
 * スプレッドシートから一度でも正しく読めたか。
 * 読めていない状態で書き込むと、全シートを空の内容で置き換えてしまう。
 * 起動時に落ちて mem が空のまま操作された場合に、それが起きる。
 */
let loadedFromSheet = false;
const markLoaded = () => { loadedFromSheet = true; };

/** 状態に足りない一覧を空で補う。読み込み・取り込み・控えの復元で使う。 */
function fillState(st) {
  const base = { debts: [], txns: [], repayments: [], borrows: [], cards: [], cardBills: [], fixed: [] };
  const out = Object.assign({}, base, st || {});
  Object.keys(base).forEach(k => { out[k] = list(out, k); });
  out.goals = Object.assign(
    { targetDate: '', monthlyRepay: 0, emergency: 0, emergencyCurrent: 0 },
    (st && st.goals) || {});
  return out;
}

/** 保存値は起算日時点。画面には今日時点の未払利息と残高を渡す。 */
function derive(raw) {
  const st = fillState(raw);
  const today = nowISO();
  return {
    debts: st.debts.map(d => {
      const days = daysBetweenISO(d.accruedAt, today);
      const pending = accrueOn(d.principal, d.rate, days);
      const interestToday = d.interestAccrued + pending;
      return Object.assign({}, d, {
        originDate: d.originDate,
        pendingDays: days,
        pendingInterest: pending,
        interestToday,
        balance: d.principal + interestToday
      });
    }),
    cards: st.cards.slice(),
    cardBills: st.cardBills.slice(),
    borrows: st.borrows.slice(),
    fixed: st.fixed.slice(),
    txns: st.txns.slice().sort((a, b) => b.date.localeCompare(a.date)),
    repayments: st.repayments.slice().sort((a, b) => b.date.localeCompare(a.date)),
    goals: st.goals
  };
}

/* ---------- 変更の中身（db.js と同じ規則） ---------- */

const findDebt = id => mem.debts.find(d => d.id === id);

/**
 * 借入の現在の状態を、起点から返済を**日付順に**再生して組み立て直す。
 * 入力した順ではなく日付の順で計算するので、あとから過去の返済を足しても結果は変わらない。
 */
/** 毎月何日か。0 は未設定。31 を超える指定は月末に丸める。 */
function dayOfMonth(v) {
  const d = Math.round(toNum(v));
  return (!Number.isFinite(d) || d <= 0) ? 0 : Math.min(31, d);
}

function fixedFields(b) {
  const name = strOf(b.name, 40);
  if (!name) throw new Refused('項目名を入力してください');
  const amount = Math.max(0, toNum(b.amount));
  if (!(amount > 0)) throw new Refused('金額は1円以上で入力してください');
  return { name, day: dayOfMonth(b.day), amount,
           category: strOf(b.category, 30) || name, memo: strOf(b.memo, 60) };
}

function rebuildDebt(d) {
  // 追加借入と返済を1本の時間軸に並べる。同じ日なら借りてから返した順に扱う。
  const events = [];
  list(mem, 'borrows').filter(b => b.debtId === d.id && b.date >= d.originDate)
    .forEach(b => events.push({ kind: 0, date: b.date, amount: b.amount, ref: b }));
  list(mem, 'repayments').filter(r => r.debtId === d.id && r.date >= d.originDate)
    .forEach(r => events.push({ kind: 1, date: r.date, amount: r.amount, ref: r }));
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.kind - b.kind) ||
                        String(a.ref.id).localeCompare(String(b.ref.id)));

  let principal = d.originPrincipal;
  let interest = d.originInterest;
  let cursor = d.originDate;

  for (const e of events) {
    interest += accrueOn(principal, d.rate, daysBetweenISO(cursor, e.date));
    if (e.kind === 0) {
      principal += e.amount;                       // 追加で借りた
    } else {
      const paidInterest = Math.min(e.amount, interest);
      const paidPrincipal = Math.min(e.amount - paidInterest, principal);
      e.ref.interest = paidInterest;
      e.ref.principal = paidPrincipal;
      interest -= paidInterest;
      principal -= paidPrincipal;
    }
    if (e.date > cursor) cursor = e.date;
  }
  d.principal = principal;
  d.interestAccrued = interest;
  d.accruedAt = cursor;
}

const MUT = {
  addDebt(b) {
    const name = strOf(b.name, 60);
    if (!name) throw new Refused('借入先の名前を入力してください');
    const f = debtFields(b);
    mem.debts.push(Object.assign({ id: newId(), name }, f, {
      originPrincipal: f.principal, originInterest: f.interestAccrued, originDate: f.accruedAt,
      createdAt: nowISO()
    }));
  },

  updateDebt(id, b) {
    const d = findDebt(id);
    if (!d) throw new Refused('その借入は見つかりません');
    const name = strOf(b.name, 60);
    if (!name) throw new Refused('借入先の名前を入力してください');
    const f = debtFields(b);
    // 編集は「この日時点でこの残高だった」という申告し直し。起点も更新して組み直す。
    Object.assign(d, { name }, f, {
      originPrincipal: f.principal, originInterest: f.interestAccrued, originDate: f.accruedAt
    });
    rebuildDebt(d);
  },

  deleteDebt(id) {
    mem.debts = mem.debts.filter(d => d.id !== id);
    mem.repayments = mem.repayments.filter(r => r.debtId !== id);   // ON DELETE CASCADE の代わり
    mem.borrows = mem.borrows.filter(b => b.debtId !== id);
  },

  addRepayment(b) {
    const d = findDebt(strOf(b.debtId, 40));
    if (!d) throw new Refused('その借入は見つかりません');
    const amount = toNum(b.amount);
    if (!(amount > 0)) throw new Refused('返済額は1円以上で入力してください');

    const date = dateOrDefault(b.date, nowISO());
    // 起点より前の返済も記録はできる。ただし残高には反映しない。
    // rebuildDebt が起点以降だけを再生するので、二重に減ることはない。
    mem.repayments.push({
      id: newId(), debtId: d.id, date, amount,
      interest: 0, principal: 0, memo: strOf(b.memo, 60)
    });
    rebuildDebt(d);
  },

  /** 追加で借りた記録。当初借入額も増やし、進捗率が借りた総額に対する割合になるようにする。 */
  addBorrow(b) {
    const d = findDebt(strOf(b.debtId, 40));
    if (!d) throw new Refused('その借入は見つかりません');
    const amount = toNum(b.amount);
    if (!(amount > 0)) throw new Refused('借入額は1円以上で入力してください');
    const date = dateOrDefault(b.date, nowISO());
    mem.borrows.push({ id: newId(), debtId: d.id, date, amount, memo: strOf(b.memo, 60) });
    // 残高に反映しない（起点より前の）借入では、当初借入額も動かさない
    if (!d.originDate || date >= d.originDate) d.initial += amount;
    rebuildDebt(d);
  },

  addFixed(b) {
    const type = b.type === 'income' ? 'income' : 'expense';
    const f = fixedFields(b);
    mem.fixed.push(Object.assign({ id: newId(), type }, f, { createdAt: nowISO() }));
  },

  updateFixed(id, b) {
    const cur = mem.fixed.find(x => x.id === id);
    if (!cur) throw new Refused('その項目は見つかりません');
    Object.assign(cur, fixedFields(b));
  },

  deleteFixed(id) { mem.fixed = mem.fixed.filter(f => f.id !== id); },

  deleteBorrow(id) {
    const b = mem.borrows.find(x => x.id === id);
    if (!b) return;
    mem.borrows = mem.borrows.filter(x => x.id !== id);
    const d = findDebt(b.debtId);
    if (!d) return;
    if (!d.originDate || b.date >= d.originDate) d.initial = Math.max(0, d.initial - b.amount);
    rebuildDebt(d);
  },

  deleteRepayment(id) {
    const r = mem.repayments.find(x => x.id === id);
    if (!r) return;
    mem.repayments = mem.repayments.filter(x => x.id !== id);
    const d = findDebt(r.debtId);
    if (d) rebuildDebt(d);
  },

  addTxn(b) {
    const amount = toNum(b.amount);
    if (!(amount > 0)) throw new Refused('金額は1円以上で入力してください');
    const type = b.type === 'income' ? 'income' : 'expense';
    const date = dateOrDefault(b.date, nowISO());
    const cid = type === 'income' ? '' : strOf(b.cardId, 40);
    mem.txns.push({
      id: newId(), type, date, amount,
      category: strOf(b.category, 30) || 'その他',
      memo: strOf(b.memo, 60),
      // 収入は受け取った月がそのまま現金の動き。引落月を選べるのは支出だけ。
      payMonth: type === 'income' ? monthOf(date) : payMonthFor(b, date),
      cardId: mem.cards.some(c => c.id === cid) ? cid : ''
    });
  },

  addCard(b) {
    const name = strOf(b.name, 40);
    if (!name) throw new Refused('カードの名前を入力してください');
    mem.cards.push({ id: newId(), name, createdAt: nowISO() });
  },

  updateCard(id, b) {
    const c = mem.cards.find(x => x.id === id);
    if (!c) throw new Refused('そのカードは見つかりません');
    const name = strOf(b.name, 40);
    if (!name) throw new Refused('カードの名前を入力してください');
    c.name = name;
  },

  /** カードを消すと請求額も消える。明細は現金・口座払い扱いに戻す。 */
  deleteCard(id) {
    mem.cards = mem.cards.filter(c => c.id !== id);
    mem.cardBills = mem.cardBills.filter(b => b.cardId !== id);
    mem.txns.forEach(t => { if (t.cardId === id) t.cardId = ''; });
  },

  /** 1枚のカードにつき1ヶ月1件。同じ月なら上書きする。 */
  setCardBill(b) {
    const cardId = strOf(b.cardId, 40);
    if (!mem.cards.some(c => c.id === cardId)) throw new Refused('そのカードは見つかりません');
    const payMonth = strOf(b.payMonth, 7);
    if (!ISO_MONTH.test(payMonth)) throw new Refused('引落月は YYYY-MM の形で指定してください');
    const amount = Math.max(0, toNum(b.amount));
    const memo = strOf(b.memo, 60);
    const cur = mem.cardBills.find(x => x.cardId === cardId && x.payMonth === payMonth);
    if (cur) { cur.amount = amount; cur.memo = memo; }
    else mem.cardBills.push({ id: newId(), cardId, payMonth, amount, memo });
  },

  deleteCardBill(id) {
    mem.cardBills = mem.cardBills.filter(b => b.id !== id);
  },

  deleteTxn(id) { mem.txns = mem.txns.filter(t => t.id !== id); },

  setGoals(b) {
    mem.goals = {
      targetDate: dateOrDefault(b.targetDate, ''),
      monthlyRepay: Math.max(0, toNum(b.monthlyRepay)),
      emergency: Math.max(0, toNum(b.emergency)),
      emergencyCurrent: Math.max(0, toNum(b.emergencyCurrent))
    };
  },

  wipe() {
    mem = { debts: [], txns: [], repayments: [], borrows: [], cards: [], cardBills: [], fixed: [],
            goals: { targetDate: '', monthlyRepay: 0, emergency: 0, emergencyCurrent: 0 } };
  },

  importState(p) {
    if (!p || !Array.isArray(p.debts)) throw new Refused('バックアップの形式が違います');
    const seen = new Set();
    const debts = [];
    for (const d of p.debts) {
      const id = strOf(d.id, 40) || newId();
      if (seen.has(id)) continue;
      seen.add(id);
      const f = debtFields(d);
      debts.push(Object.assign({ id, name: strOf(d.name, 60) || '名称未設定' }, f, {
        originPrincipal: f.principal, originInterest: f.interestAccrued, originDate: f.accruedAt,
        createdAt: dateOrDefault(d.createdAt, nowISO())
      }));
    }
    const cards = [];
    const cardIds = new Set();
    for (const c of (p.cards || [])) {
      const id = strOf(c.id, 40) || newId();
      if (cardIds.has(id)) continue;
      cardIds.add(id);
      cards.push({ id, name: strOf(c.name, 40) || '名称未設定',
                   createdAt: dateOrDefault(c.createdAt, nowISO()) });
    }
    const cardBills = [];
    for (const b of (p.cardBills || [])) {
      const cid = strOf(b.cardId, 40);
      const pm = strOf(b.payMonth, 7);
      if (!cardIds.has(cid) || !ISO_MONTH.test(pm)) continue;   // 宛先の無い請求は捨てる
      cardBills.push({ id: strOf(b.id, 40) || newId(), cardId: cid, payMonth: pm,
                       amount: Math.max(0, toNum(b.amount)), memo: strOf(b.memo, 60) });
    }
    const txns = [];
    for (const t of (p.txns || [])) {
      const amount = toNum(t.amount);
      if (!(amount > 0)) continue;
      const ttype = t.type === 'income' ? 'income' : 'expense';
      const tdate = dateOrDefault(t.date, nowISO());
      txns.push({
        id: strOf(t.id, 40) || newId(), type: ttype, date: tdate, amount,
        category: strOf(t.category, 30) || 'その他', memo: strOf(t.memo, 60),
        payMonth: ttype === 'income' ? monthOf(tdate) : payMonthFor(t, tdate),
        cardId: cardIds.has(strOf(t.cardId, 40)) ? strOf(t.cardId, 40) : ''
      });
    }
    const repayments = [];
    for (const r of (p.repayments || [])) {
      const amount = toNum(r.amount);
      if (!(amount > 0) || !seen.has(strOf(r.debtId, 40))) continue;   // 宛先の無い記録は捨てる
      repayments.push({
        id: strOf(r.id, 40) || newId(), debtId: strOf(r.debtId, 40),
        date: dateOrDefault(r.date, nowISO()), amount,
        interest: Math.max(0, toNum(r.interest)), principal: Math.max(0, toNum(r.principal)),
        memo: strOf(r.memo, 60)
      });
    }
    const borrows = [];
    for (const b of (p.borrows || [])) {
      const amount = toNum(b.amount);
      if (!(amount > 0) || !seen.has(strOf(b.debtId, 40))) continue;   // 宛先の無い記録は捨てる
      borrows.push({ id: strOf(b.id, 40) || newId(), debtId: strOf(b.debtId, 40),
                     date: dateOrDefault(b.date, nowISO()), amount, memo: strOf(b.memo, 60) });
    }
    const fixed = [];
    for (const f of (p.fixed || [])) {
      const amount = toNum(f.amount);
      if (!(amount > 0)) continue;
      const nm = strOf(f.name, 40) || strOf(f.category, 30) || 'その他';
      fixed.push({ id: strOf(f.id, 40) || newId(),
                   type: f.type === 'income' ? 'income' : 'expense',
                   name: nm, day: dayOfMonth(f.day),
                   category: strOf(f.category, 30) || nm, amount,
                   memo: strOf(f.memo, 60), createdAt: dateOrDefault(f.createdAt, nowISO()) });
    }
    const g = p.goals || {};
    mem = { debts, cards, cardBills, txns, repayments, borrows, fixed, goals: {
      targetDate: dateOrDefault(g.targetDate, ''),
      monthlyRepay: Math.max(0, toNum(g.monthlyRepay)),
      emergency: Math.max(0, toNum(g.emergency)),
      emergency_current: undefined,
      emergencyCurrent: Math.max(0, toNum(g.emergencyCurrent))
    } };
    delete mem.goals.emergency_current;
  },

  loadSample() {
    const now = new Date();
    const mk = i => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    };
    const today = nowISO();
    MUT.wipe();

    const seeds = [
      ['銀行カードローン', 1330000, 1500000, 14.5, 30000, 38000],
      ['自動車ローン',     1030000, 1800000, 3.9,  32000, 32000],
      ['クレジット分割',    320000,  400000, 15.0, 15000, 15000]
    ].map(([name, prin, initial, rate, minPayment, pay]) => {
      const d = { id: newId(), name, principal: prin, interestAccrued: 0,
                  accruedAt: mk(6) + '-27',
                  originPrincipal: prin, originInterest: 0, originDate: mk(6) + '-27',
                  initial, rate, minPayment, createdAt: mk(10) + '-01' };
      mem.debts.push(d);
      return { d, pay };
    });

    const EX = [['住居', 82000], ['食費', 54000], ['水道光熱', 16500], ['通信', 9800],
                ['交通', 12000], ['保険', 14000], ['日用品', 11500], ['交際費', 9000], ['娯楽', 7500]];

    for (let i = 5; i >= 0; i--) {
      const m = mk(i);
      mem.txns.push({ id: newId(), type: 'income', date: m + '-25',
                      amount: 328000 + (i % 2 ? 0 : 4000), category: '給与', memo: '', payMonth: m });
      if (i === 1) mem.txns.push({ id: newId(), type: 'income', date: m + '-10',
                                   amount: 420000, category: '賞与', memo: '夏季', payMonth: m });
      // カードで払いがちな費目は、利用した月ではなく翌月に口座から出ていく
      const CARD = new Set(['通信', '娯楽', '交際費', '被服']);
      EX.forEach(([c, v], k) => mem.txns.push({
        id: newId(), type: 'expense', date: m + '-' + String(3 + k * 2).padStart(2, '0'),
        amount: v + ((i * 7 + k * 3) % 5) * 400, category: c,
        memo: CARD.has(c) ? 'カード払い' : '',
        payMonth: CARD.has(c) ? addMonthKey(m, 1) : m
      }));
      seeds.forEach(({ d, pay }) => {
        const date = m + '-27';
        if (date > today) return;                       // まだ来ていない返済日は記録しない
        const interest = accrueOn(d.principal, d.rate, daysBetweenISO(d.accruedAt, date));
        const paidInterest = Math.min(pay, interest);
        const paidPrincipal = Math.min(pay - paidInterest, d.principal);
        mem.repayments.push({ id: newId(), debtId: d.id, date, amount: pay,
                              interest: paidInterest, principal: paidPrincipal, memo: '' });
        d.principal -= paidPrincipal;
        d.accruedAt = date;
      });
    }

    mem.goals = { targetDate: (now.getFullYear() + 3) + '-03-31', monthlyRepay: 95000,
                  emergency: 600000, emergencyCurrent: 180000 };
  }
};

/* ---------- 入口 ---------- */

async function api(path, method, body) {
  const [, resource, id] = path.split('/');
  const m = method || 'GET';

  if (resource === 'state' && m === 'GET') return derive(mem);

  if (resource === 'stats' && m === 'GET') {
    return {
      path: `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
      size: JSON.stringify(mem).length,
      debts: mem.debts.length,
      txns: mem.txns.length,
      repayments: mem.repayments.length,
      backupDir: 'Google ドライブ'
    };
  }

  // 書き込み。先に他端末の更新を確かめ、変更を適用してから全体を書き戻す。
  const save = async fn => {
    // 読み込みが済んでいないうちは絶対に書かない。空の内容で全部を上書きしてしまう。
    if (!loadedFromSheet) {
      throw new Error('データをまだ読み込めていません。画面を再読み込みしてから、もう一度お試しください。');
    }
    await assertFresh();
    const before = JSON.stringify(mem);
    try {
      fn();
      await writeAll(mem);
      saveCache(mem);                  // 手元の控えも最新にする
    } catch (e) {
      mem = JSON.parse(before);        // 書けなかったら手元も元に戻す
      throw e;
    }
    return derive(mem);
  };

  switch (resource) {
    case 'debts':
      if (m === 'POST')   return save(() => MUT.addDebt(body));
      if (m === 'PUT')    return save(() => MUT.updateDebt(id, body));
      if (m === 'DELETE') return save(() => MUT.deleteDebt(id));
      break;
    case 'repayments':
      if (m === 'POST')   return save(() => MUT.addRepayment(body));
      if (m === 'DELETE') return save(() => MUT.deleteRepayment(id));
      break;
    case 'borrows':
      if (m === 'POST')   return save(() => MUT.addBorrow(body));
      if (m === 'DELETE') return save(() => MUT.deleteBorrow(id));
      break;
    case 'txns':
      if (m === 'POST')   return save(() => MUT.addTxn(body));
      if (m === 'DELETE') return save(() => MUT.deleteTxn(id));
      break;
    case 'cards':
      if (m === 'POST')   return save(() => MUT.addCard(body));
      if (m === 'PUT')    return save(() => MUT.updateCard(id, body));
      if (m === 'DELETE') return save(() => MUT.deleteCard(id));
      break;
    case 'cardbills':
      if (m === 'POST')   return save(() => MUT.setCardBill(body));
      if (m === 'DELETE') return save(() => MUT.deleteCardBill(id));
      break;
    case 'fixed':
      if (m === 'POST')   return save(() => MUT.addFixed(body));
      if (m === 'PUT')    return save(() => MUT.updateFixed(id, body));
      if (m === 'DELETE') return save(() => MUT.deleteFixed(id));
      break;
    case 'goals':
      if (m === 'PUT')    return save(() => MUT.setGoals(body));
      break;
    case 'import':
      if (m === 'POST')   return save(() => MUT.importState(body));
      break;
    case 'sample':
      if (m === 'POST')   return save(() => MUT.loadSample());
      break;
    case 'wipe':
      if (m === 'POST')   return save(() => MUT.wipe());
      break;
    case 'backup': {
      if (m !== 'POST') break;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const copy = await gapi(`${DRIVE_API}/${fileId}/copy`, {
        method: 'POST', body: { name: `${FILE_NAME} ${stamp}` }
      });
      return { file: copy.name, size: JSON.stringify(mem).length };
    }
  }

  throw new Error('この操作には対応していません');
}

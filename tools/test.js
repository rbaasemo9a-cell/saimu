'use strict';
/**
 * npm test
 *  1. データ層（SQLite）— 整合性とトランザクション
 *  2. 返済シミュレーション — 元利均等返済の理論式との突き合わせ
 * 一時 DB を使うので、本番の saimu.db には触れない。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'saimu-test-' + Date.now() + '.db');
process.env.SAIMU_DB = TMP;

const db = require('../db');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

/* ==========================================================
   1. データ層
   ========================================================== */
console.log('\nデータ層 (SQLite)');

const findD = id => db.getState().debts.find(x => x.id === id);

const d1 = db.addDebt({ name: 'カードローン', principal: 1000000, interestAccrued: 0,
                        accruedAt: '2026-01-01', initial: 1500000, rate: 12, minPayment: 30000 });
const d2 = db.addDebt({ name: '自動車ローン', balance: 500000, rate: 3.6, minPayment: 20000 });
ok('借入を2件登録できる', db.getState().debts.length === 2);
ok('balance しか無い旧形式は全額を元金として読む',
  findD(d2).principal === 500000 && findD(d2).interestAccrued === 0);
ok('当初借入額が未指定なら残高で埋まる', findD(d2).initial === 500000);

// 未払利息を分けて登録できる
{
  const d3 = db.addDebt({ name: '内訳あり', principal: 300000, interestAccrued: 4500,
                          accruedAt: '2026-01-01', rate: 15, minPayment: 10000 });
  const d = findD(d3);
  ok('元金と未払利息を分けて登録できる',
    d.principal === 300000 && d.interestAccrued === 4500, `${d.principal}/${d.interestAccrued}`);
  db.deleteDebt(d3);
}

// 日割り利息: 元金 × 年利 ÷ 365 × 経過日数
const DAILY = (p, rate, days) => p * (rate / 100 / 365) * days;

db.addRepayment({ debtId: d1, amount: 30000, date: '2026-01-31', memo: 'テスト' });
{
  const s = db.getState();
  const r = s.repayments[0];
  const d = s.debts.find(x => x.id === d1);
  const wantInterest = DAILY(1000000, 12, 30);             // 30日分 = 9,863.01…
  ok('利息 = 元金 × 年利 ÷ 365 × 経過日数', near(r.interest, wantInterest), `interest=${r.interest}`);
  ok('返済はまず利息に充当される', near(r.principal, 30000 - wantInterest), `principal=${r.principal}`);
  ok('元金が元金充当分だけ減る', near(d.principal, 1000000 - (30000 - wantInterest)), `principal=${d.principal}`);
  ok('未払利息は使い切られて0になる', near(d.interestAccrued, 0), `interest_accrued=${d.interestAccrued}`);
  ok('起算日が返済日まで進む', d.accruedAt === '2026-01-31', d.accruedAt);
}

// 取り消し → 元金と未払利息の両方が戻る
{
  const rid = db.getState().repayments[0].id;
  db.deleteRepayment(rid);
  const d = findD(d1);
  ok('返済を取り消すと元金が元に戻る', near(d.principal, 1000000), `principal=${d.principal}`);
  ok('返済を取り消すと未払利息も戻る', near(d.interestAccrued, DAILY(1000000, 12, 30)),
    `interest_accrued=${d.interestAccrued}`);
  ok('返済記録が消えている', db.getState().repayments.length === 0);
}

// 返済額が利息に満たない場合 → 元金は1円も減らず、未払利息が残る
{
  const dx = db.addDebt({ name: '利息割れ', principal: 1000000, accruedAt: '2026-01-01',
                          rate: 18, minPayment: 3000 });
  db.addRepayment({ debtId: dx, amount: 3000, date: '2026-02-01' });   // 31日 = 15,287円
  const d = findD(dx);
  const r = db.getState().repayments.find(x => x.debtId === dx);
  ok('返済額 < 利息 なら元金は減らない', d.principal === 1000000 && r.principal === 0,
    `principal=${d.principal} rep.principal=${r.principal}`);
  ok('払いきれない利息は未払利息として残る',
    near(d.interestAccrued, DAILY(1000000, 18, 31) - 3000), `interest_accrued=${d.interestAccrued}`);

  // 未払利息そのものは利息を生まない（利息が付くのは元金だけ）
  const before = findD(dx).interestAccrued;
  db.addRepayment({ debtId: dx, amount: 1, date: '2026-03-01' });      // さらに28日
  const after = findD(dx).interestAccrued;
  ok('未払利息には利息が付かない（元金にのみ付く）',
    near(after, before + DAILY(1000000, 18, 28) - 1), `${before} → ${after}`);
  db.deleteDebt(dx);
}

// 過去の日付で記録しても起算日は巻き戻らない（同じ期間の利息を二度積まない）
{
  const dy = db.addDebt({ name: '順序ばらばら', principal: 500000, accruedAt: '2026-05-01',
                          rate: 12, minPayment: 10000 });
  db.addRepayment({ debtId: dy, amount: 10000, date: '2026-06-01' });
  db.addRepayment({ debtId: dy, amount: 10000, date: '2026-05-15' });  // 過去の日付
  const d = findD(dy);
  const back = db.getState().repayments.find(x => x.debtId === dy && x.date === '2026-05-15');
  ok('過去日付の返済では利息が発生しない', near(back.interest, 0), `interest=${back.interest}`);
  ok('起算日は巻き戻らない', d.accruedAt === '2026-06-01', d.accruedAt);
  db.deleteDebt(dy);
}

// 不正な入力は弾かれ、DB は変化しない
{
  const before = JSON.stringify(db.getState());
  let threw = 0;
  try { db.addRepayment({ debtId: d1, amount: 0 }); } catch (e) { threw++; }
  try { db.addRepayment({ debtId: 'nope', amount: 1000 }); } catch (e) { threw++; }
  try { db.addTxn({ type: 'expense', amount: -5 }); } catch (e) { threw++; }
  try { db.addDebt({ name: '   ', balance: 100 }); } catch (e) { threw++; }
  ok('不正な入力は4件とも拒否される', threw === 4, 'threw=' + threw);
  ok('拒否時に DB は変化しない', JSON.stringify(db.getState()) === before);
}

// 借入を消すと返済記録も消える (ON DELETE CASCADE)
db.addRepayment({ debtId: d2, amount: 20000 });
db.addRepayment({ debtId: d2, amount: 20000 });
ok('返済記録が2件ある', db.getState().repayments.length === 2);
db.deleteDebt(d2);
ok('借入を消すと紐づく返済記録も消える (CASCADE)',
  db.getState().repayments.length === 0 && db.getState().debts.length === 1);

// 収支
db.addTxn({ type: 'income', date: '2026-08-25', amount: 320000, category: '給与' });
db.addTxn({ type: 'expense', date: '2026-08-03', amount: 82000, category: '住居' });
ok('収支を登録できる', db.getState().txns.length === 2);

// 目標
db.setGoals({ targetDate: '2029-03-31', monthlyRepay: 95000, emergency: 600000, emergencyCurrent: 180000 });
ok('目標を保存できる', db.getState().goals.monthlyRepay === 95000);
db.setGoals({ targetDate: 'これは日付ではない', monthlyRepay: -100 });
ok('不正な日付は空に、負の金額は0に丸められる',
  db.getState().goals.targetDate === '' && db.getState().goals.monthlyRepay === 0);

// 書き出し → 全消し → 取り込みで元に戻る
{
  db.setGoals({ targetDate: '2029-03-31', monthlyRepay: 95000, emergency: 600000, emergencyCurrent: 180000 });
  db.addRepayment({ debtId: d1, amount: 30000 });
  const snapshot = JSON.parse(JSON.stringify(db.getState()));
  db.wipe();
  ok('全消しで空になる', db.getState().debts.length === 0 && db.getState().txns.length === 0);
  db.importState(snapshot);
  const back = db.getState();
  ok('取り込むと元の状態に戻る',
    back.debts.length === snapshot.debts.length &&
    back.txns.length === snapshot.txns.length &&
    back.repayments.length === snapshot.repayments.length &&
    back.goals.monthlyRepay === snapshot.goals.monthlyRepay,
    JSON.stringify({ d: back.debts.length, t: back.txns.length, r: back.repayments.length }));
}

// 存在しない借入に紐づく返済記録は取り込み時に捨てる
{
  db.importState({
    debts: [{ id: 'x1', name: 'A', balance: 1000, rate: 1, minPayment: 100 }],
    repayments: [
      { id: 'r1', debtId: 'x1', date: '2026-01-01', amount: 100 },
      { id: 'r2', debtId: 'ghost', date: '2026-01-01', amount: 100 }
    ],
    txns: [], goals: {}
  });
  ok('存在しない借入の返済記録は取り込まれない', db.getState().repayments.length === 1);
}

// サンプルデータ — 履歴の内訳と現在の残高が食い違わないこと
{
  db.loadSample();
  const s = db.getState();
  const now = new Date();
  const todayISO = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') +
                   '-' + String(now.getDate()).padStart(2, '0');
  // 返済日は毎月27日。今月の27日がまだ来ていなければ、その回は記録されない。
  const paidMonths = now.getDate() >= 27 ? 6 : 5;
  ok('サンプルを読み込める', s.debts.length === 3 && s.repayments.length === paidMonths * 3,
    `debts=${s.debts.length} reps=${s.repayments.length} (期待 ${paidMonths * 3})`);
  ok('サンプルに未来日付の返済が入らない', s.repayments.every(r => r.date <= todayISO),
    s.repayments.map(r => r.date).filter(d => d > todayISO).join(' '));
  ok('サンプルの返済はすべて 返済額 = 利息 + 元金 に分かれている',
    s.repayments.every(r => near(r.amount, r.interest + r.principal)));
  ok('サンプルの利息が0でない（日割りが効いている）',
    s.repayments.some(r => r.interest > 1));
  ok('サンプルの元金は当初借入額を超えない',
    s.debts.every(d => d.principal <= d.initial),
    s.debts.map(d => `${d.name}:${Math.round(d.principal)}/${d.initial}`).join(' '));
  // サンプルの元金は1万円単位の切りのいい額から始まる。
  // 「現在の元金 ＋ 元金充当の合計」がその額に戻れば、履歴と残高が食い違っていない。
  const dropped = id => s.repayments.filter(r => r.debtId === id)
    .reduce((a, r) => a + r.principal, 0);
  ok('現在の元金 ＋ 元金充当の合計 が開始時の元金に戻る',
    s.debts.every(d => {
      const seed = d.principal + dropped(d.id);
      return seed > d.principal && near(seed, Math.round(seed / 10000) * 10000);
    }),
    s.debts.map(d => Math.round(d.principal + dropped(d.id))).join(' / '));
  db.wipe();
}

// バックアップ
{
  const r = db.backup();
  ok('VACUUM INTO でバックアップファイルができる', fs.existsSync(r.file) && r.size > 0,
    r.file + ' ' + r.size + 'B');
  try { fs.rmSync(path.dirname(r.file), { recursive: true, force: true }); } catch (e) {}
}

/* ==========================================================
   2. シミュレーション（public/index.html の実コードを評価する）
   ========================================================== */
console.log('\n返済シミュレーション');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('見つかりません: ' + name);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('括弧が閉じていません: ' + name);
}

const MAXM = 600;
const DAY_BASIS = 365;
let state = { debts: [] };
const totalBalance = () => state.debts.reduce((s, d) => s + Math.max(0, d.balance), 0);
const addMonthsExact = eval('(' + grab('addMonthsExact') + ')');
const daysApart      = eval('(' + grab('daysApart') + ')');
const interestFor    = eval('(' + grab('interestFor') + ')');
const simulate       = eval('(' + grab('simulate') + ')');
const requiredBudget = eval('(' + grab('requiredBudget') + ')');

/** シミュレーション用の借入。残高は元金＋未払利息。 */
const fx = (id, name, principal, rate, minPayment, interestToday = 0) =>
  ({ id, name, principal, interestToday, balance: principal + interestToday, rate, minPayment });

// 日割り計算そのものの確認
{
  ok('日割り利息 = 元金 × 年利 ÷ 365 × 日数',
    near(interestFor(1000000, 14.6, 30), 1000000 * 0.146 / 365 * 30),
    String(interestFor(1000000, 14.6, 30)));
  ok('1年分を積むと年利1回分になる', near(interestFor(1000000, 12, 365), 120000));
  ok('うるう年も365日で割る（366日なら1日分多く付く）',
    near(interestFor(1000000, 12, 366), 120000 + 120000 / 365));
  const t = new Date(2026, 0, 31);
  ok('翌月に同じ日が無ければ月末に丸める',
    addMonthsExact(t, 1).getMonth() === 1 && addMonthsExact(t, 1).getDate() === 28,
    addMonthsExact(t, 1).toDateString());
  ok('過去に戻る向きの日数は0', daysApart(new Date(2026, 5, 1), new Date(2026, 4, 1)) === 0);
}

/**
 * 日割り（年利 ÷ 365 × 実日数）でも、1年を通せば月複利の理論式と一致するはず。
 * n = -ln(1 - rP/A) / ln(1+r)
 */
function closedForm(P, annual, A) {
  const r = annual / 100 / 12;
  if (r === 0) return Math.ceil(P / A);
  if (A <= P * r) return null;
  return Math.ceil(-Math.log(1 - (r * P) / A) / Math.log(1 + r));
}
[[1000000, 14.5, 30000], [500000, 3.9, 20000], [2400000, 8.0, 45000], [300000, 0, 25000]]
  .forEach(([P, rate, pay]) => {
    state.debts = [fx('a', 'A', P, rate, pay)];
    const got = simulate(0, 'minimum').payoffMonths;
    const want = closedForm(P, rate, pay);
    ok(`${P.toLocaleString()}円 @${rate}% ${pay.toLocaleString()}円/月 → ${got}ヶ月 (理論値 ${want})`,
      got != null && want != null && Math.abs(got - want) <= 1);
  });

// 未払利息を抱えていれば、その分だけ完済が遠のく
{
  state.debts = [fx('a', 'A', 1000000, 14.5, 30000)];
  const clean = simulate(0, 'minimum').payoffMonths;
  state.debts = [fx('a', 'A', 1000000, 14.5, 30000, 50000)];
  const dirty = simulate(0, 'minimum').payoffMonths;
  ok('未払利息があると完済が遅くなる', dirty > clean, `${clean}ヶ月 → ${dirty}ヶ月`);
}

state.debts = [fx('a', 'A', 1000000, 15, 10000)];
{
  const r = simulate(0, 'minimum');
  ok('最低返済 < 利息 → 完済しないと判定', r.payoffMonths === null && r.stalled === true);
  ok('元金は増えない（増えるのは未払利息だけ）',
    r.months.every(m => m.balance >= 1000000), String(r.months[0].balance));
}

state.debts = [
  fx('a', '高金利・少額', 200000, 18.0, 10000),
  fx('b', '低金利・高額', 1500000, 3.5, 30000)
];
{
  const av = simulate(70000, 'avalanche');
  const sn = simulate(70000, 'snowball');
  ok('雪崩式の利息 ≦ 雪だるま式の利息',
    av.totalInterest <= sn.totalInterest + 1,
    `雪崩=${Math.round(av.totalInterest)} 雪だるま=${Math.round(sn.totalInterest)}`);
  ok('雪だるま式は残高の小さい方を先に完済', sn.perDebt.a.paidOff < sn.perDebt.b.paidOff);

  let pm = Infinity, pi = Infinity, mono = true;
  for (const b of [60000, 80000, 120000, 200000, 400000]) {
    const r = simulate(b, 'avalanche');
    if (!(r.payoffMonths <= pm && r.totalInterest <= pi + 1)) mono = false;
    pm = r.payoffMonths; pi = r.totalInterest;
  }
  ok('返済額を増やすほど期間も利息も単調に減る', mono);
}

[12, 24, 36, 60].forEach(tm => {
  const need = requiredBudget(tm);
  const got = need == null ? null : simulate(need, 'avalanche').payoffMonths;
  const less = need == null ? null : simulate(need - 2000, 'avalanche').payoffMonths;
  ok(`${tm}ヶ月で完済するには ${need == null ? '—' : need.toLocaleString()}円/月 → 実測 ${got}ヶ月`,
    got != null && got <= tm && (less == null || less > tm - 1));
});

state.debts = [];
ok('借入なし → 0ヶ月', simulate(50000, 'avalanche').payoffMonths === 0);

state.debts = [
  fx('a', 'A', 500000, 12, 20000),
  fx('b', 'B', 500000, 12, 20000)
];
{
  const r = simulate(25000, 'avalanche');
  ok('予算 < 最低返済額合計 でも無限ループしない', r.months.length > 0 && r.months.length <= MAXM);
}

/* ---------- 後片付け ---------- */
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch (e) {}
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

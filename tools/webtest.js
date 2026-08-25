'use strict';
/**
 * docs/index.html（GitHub Pages 版）の検査。
 *   node tools/webtest.js
 *
 * Google に繋がずに確かめられるところまでを見る:
 *   1. 組み立て結果が壊れていないか（構文・骨格・差し替え漏れ）
 *   2. データ層のロジックが SQLite 版と同じ答えを出すか
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'index.html');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

if (!fs.existsSync(OUT)) {
  console.log('\ndocs/index.html がありません。先に npm run build:web を実行してください。\n');
  process.exit(1);
}
const html = fs.readFileSync(OUT, 'utf8');

/* ==========================================================
   1. 組み立て結果
   ========================================================== */
console.log('\nGitHub Pages 版の組み立て');

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).filter(s => s.trim());
const app = scripts.sort((a, b) => b.length - a.length)[0];

try {
  new Function(app);
  ok(`JS 構文 (${app.split('\n').length} 行)`, true);
} catch (e) {
  ok('JS 構文', false, e.message);
}

['<!doctype html>', '<meta charset="utf-8">', '<meta name="viewport"', '</head>', '<body>', '</html>']
  .forEach(s => ok('骨格: ' + s, html.includes(s)));

ok('Google のログイン部品を読み込んでいる',
  html.includes('https://accounts.google.com/gsi/client'));
ok('ログイン画面の下敷きが入っている', html.includes('id="gate"') && html.includes('.gate-card'));
ok('スコープは drive.file だけ',
  html.includes("'https://www.googleapis.com/auth/drive.file'") &&
  !html.includes('auth/drive.readonly') &&
  !html.includes("auth/spreadsheets'"));
// 入力欄の placeholder は例示なので除いてから探す
ok('クライアントIDが埋め込まれていない',
  !/\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com/.test(html.replace(/placeholder="[^"]*"/g, '')));
ok('サーバーへの fetch が残っていない', !html.includes("fetch('/api"));
ok('差し替えの目印が残っていない', !html.includes('@swap:'));
ok('Jekyll 抑止ファイルがある', fs.existsSync(path.join(ROOT, 'docs', '.nojekyll')));

// 再読み込みのたびにログインが出ないこと（鍵を端末に覚えておく作り）
ok('アクセストークンを端末に覚える', app.includes("token:    'saimu.token'") &&
  /function rememberToken/.test(app) && /function recallToken/.test(app));
ok('期限内の鍵があれば Google に問い合わせない', /if \(hasLiveToken\(\)\)/.test(app));
ok('期限ぎりぎりの鍵は使わない', /Date\.now\(\) \+ 120000/.test(app));
ok('同意画面を毎回は強制しない', !app.includes("prompt: 'consent'"));
ok('ログアウトで覚えた鍵を消す', /function signOut[\s\S]{0,200}forgetToken\(\)/.test(app));
ok('401 のときは覚えた鍵を捨てる', /res\.status === 401[\s\S]{0,160}forgetToken\(\)/.test(app));

/*
 * ログインの回数を減らす作り。トークンは1時間で切れ、ブラウザだけでは
 * 長期の更新鍵をもらえない。だから「見るだけ」は控えで済ませる。
 */
{
  ok('読み込んだ内容を端末に控える', /function saveCache/.test(app) && /function loadCache/.test(app));
  ok('開いたらまず控えを出す', /function showCached/.test(app) && /const cached = showCached\(\)/.test(app));
  ok('控えがあればログイン画面で止めない',
    app.includes('showStaleBanner(cached.at)') && !app.includes('if (cached) showGate'));
  ok('いつ時点かを帯で知らせる', /function showStaleBanner/.test(app));
  ok('書き込んだら控えも更新する', /await writeAll\(mem\);[\s\S]{0,40}saveCache\(mem\);/.test(app));
  ok('ログアウトで控えも消す', /function signOut[\s\S]{0,220}clearCache\(\)/.test(app));
  // 通信の失敗で有効な鍵を捨てない（捨てると次回また必ずログインになる）
  ok('拒否されたときだけ鍵を捨てる',
    /authReason !== 'rejected'[\s\S]{0,220}forgetToken\(\)/.test(app));
  ok('ログインが要る理由を画面に出す',
    app.includes('gate-why') && /expired:/.test(app) && /rejected:/.test(app));
  // 控えがあるのに勝手に認証しにいくと、アカウント選択が出てしまう
  // 控えがあるのに勝手に認証しにいくと、アカウント選択が出てしまう
  ok('控えがあるなら自動で認証しにいかない',
    app.includes('if (cached) {') && app.includes('showStaleBanner(cached.at);'));
  ok('使用中は期限切れ前に先回りして取り直す',
    app.includes('function keepTokenFresh') && app.includes('tokenExpires - 10 * 60 * 1000'));
  ok('期限は Google が返す値をそのまま使う',
    app.includes('Number(r.expires_in || 3600)'));
}

/*
 * 権限外のエンドポイントを叩かないこと。
 * drive.file しか要求していないのに userinfo を叩くと 401 が返り、
 * それを「鍵が切れた」と誤解して鍵を捨て、毎回ログインのポップアップが出る。
 * 一度やらかしたので、行き先を許可リストで縛る。
 */
{
  const ALLOWED = [
    'https://sheets.googleapis.com/v4/spreadsheets',      // drive.file で作った表の読み書き
    'https://www.googleapis.com/drive/v3/files',           // 自分が作ったファイルの検索・複製
    'https://www.googleapis.com/auth/drive.file',          // スコープの宣言そのもの
    'https://accounts.google.com/gsi/client',              // ログイン部品
    'https://docs.google.com/spreadsheets/d/'              // 保存先を人に見せるための URL
  ];
  const found = [...new Set((app.match(/https:\/\/[a-z0-9.\-]*google[a-z.]*\/[^'"`\s)]*/gi) || [])
    .map(u => u.replace(/\$\{[^}]*\}.*$/, '')))];
  const stray = found.filter(u => !ALLOWED.some(a => u.startsWith(a)));
  ok('Google への行き先が許可リストの中だけ', stray.length === 0, stray.join(' '));
  ok('権限外の userinfo を叩いていない', !app.includes('oauth2/v3/userinfo'));
}

/*
 * 列を足しても既存のシートが壊れないこと。
 * debts の途中に起点の3列を入れたとき、位置決め打ちで読んでいたせいで
 * 年利と最低返済額が 0 になった。見出しで対応づけるようにして直した。
 */
console.log('\n古いシートとの互換');
{
  const L2 = new Function([
    "const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/;",
    grab('toNum', 'const'),
    grab('TABLES', 'const'),
    grab('NUMERIC', 'const'),
    grab('rowsToObjects'),
    'return { rowsToObjects, TABLES };'
  ].join(String.fromCharCode(10)))();

  ok('見出しで対応づけている（位置決め打ちでない）',
    /header\.findIndex/.test(app) && !/cols\.forEach\(\(c, i\) => \{\s*const raw = row\[i\]/.test(app));

  // 起点の3列が無い、古い debts シート
  const oldRows = [
    ['id', 'name', 'principal', 'interestAccrued', 'accruedAt', 'initial', 'rate', 'minPayment', 'createdAt'],
    ['d1', '銀行カードローン', '1216519', '12565', '2026-07-27', '1500000', '14.5', '30000', '2026-01-01']
  ];
  const r = L2.rowsToObjects('debts', oldRows)[0];
  ok('古いシートでも年利が読める', r.rate === 14.5, String(r.rate));
  ok('古いシートでも最低返済額が読める', r.minPayment === 30000, String(r.minPayment));
  ok('古いシートでも当初借入額が読める', r.initial === 1500000, String(r.initial));
  ok('古いシートでも元金が読める', r.principal === 1216519, String(r.principal));
  ok('無い列は空になるだけ', r.originDate === '' && r.originPrincipal === 0);

  // 列の順番を入れ替えたシートでも読める
  const shuffled = [
    ['name', 'id', 'rate', 'principal', 'minPayment'],
    ['カードローン', 'd9', '15', '500000', '20000']
  ];
  const s2 = L2.rowsToObjects('debts', shuffled)[0];
  ok('列の順番が違っても見出しで引ける',
    s2.name === 'カードローン' && s2.rate === 15 && s2.principal === 500000,
    JSON.stringify(s2));

  ok('読み込み時に起点を補完する',
    /originDate = ISO_DATE\.test\(d\.accruedAt/.test(app));
}

/*
 * 新しい種類のデータを足したとき、それを持たない保存先や端末の控えを開いても
 * 落ちないこと。borrows / fixed を足したときに、これで実際に2度画面を壊した。
 */
console.log('\n古い保存先・古い控えとの互換');
{
  const L3 = new Function([
    "const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/;",
    grab('daysBetweenISO'),
    'const accrueOn = (p, r, d) => p * (r / 100 / 365) * d;',
    grab('nowISO', 'const'),
    grab('list', 'const'),
    grab('fillState'),
    grab('derive'),
    'return { derive, fillState };'
  ].join(String.fromCharCode(10)))();

  const cases = [
    ['fixed が無い', { debts: [], txns: [], repayments: [], borrows: [], cards: [], cardBills: [] }],
    ['borrows も無い', { debts: [], txns: [], repayments: [], cards: [], cardBills: [] }],
    ['debts だけ', { debts: [] }],
    ['空', {}],
    ['null', null]
  ];
  const broke = cases.filter(([, st]) => {
    try { L3.derive(st); return false; } catch (e) { return true; }
  }).map(([n]) => n);
  ok('種類が欠けた保存先を開いても落ちない', broke.length === 0, broke.join(' | '));

  const filled = L3.fillState({ debts: [] });
  ok('足りない一覧は空で補われる',
    ['txns', 'repayments', 'borrows', 'cards', 'cardBills', 'fixed']
      .every(k => Array.isArray(filled[k])));
  ok('目標も既定値で補われる', filled.goals && filled.goals.monthlyRepay === 0);

  // 直接 st.xxx.slice() に戻っていないこと（それで3度壊した）
  ok('一覧の取り出しは list() を通している',
    !/st\.(txns|repayments|borrows|cards|cardBills|fixed)\.slice\(\)/.test(
      app.slice(app.indexOf('function derive('), app.indexOf('function derive(') + 900)
        .replace(/const st = fillState\(raw\);/, '')) ||
    app.includes('const st = fillState(raw);'));
  ok('控えの復元でも補っている', app.includes('mem = fillState(c.state);'));
  ok('読み込みでも補っている', app.includes('return fillState({'));
}

/* ==========================================================
   2. データ層のロジック
   ========================================================== */
console.log('\nデータ層（スプレッドシート版）');

// ブラウザ用のコードから、Google に触らない純粋な部分だけを取り出して動かす。
function grab(name, kind) {
  const head = kind === 'const' ? 'const ' + name + ' = ' : 'function ' + name + '(';
  const i = app.indexOf(head);
  if (i < 0) throw new Error('見つかりません: ' + name);
  let depth = 0, started = false;
  for (let j = i; j < app.length; j++) {
    if (app[j] === '{') { depth++; started = true; }
    else if (app[j] === '}') { depth--; if (started && depth === 0) return app.slice(i, j + 1); }
    else if (app[j] === ';' && !started && kind === 'const') return app.slice(i, j + 1);
  }
  throw new Error('括弧が閉じていません: ' + name);
}

const sandbox = {};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const src = [
  'const ISO_DATE = /^\\d{4}-\\d{2}-\\d{2}$/;',
  grab('daysBetweenISO'),
  'const accrueOn = (principal, rate, days) => principal * (rate / 100 / 365) * days;',
  grab('toNum', 'const'),
  grab('strOf', 'const'),
  grab('dateOrDefault', 'const'),
  grab('nowISO', 'const'),
  grab('debtFields'),
  'return { daysBetweenISO, accrueOn, toNum, strOf, dateOrDefault, nowISO, debtFields };'
].join('\n');
const L = new Function(src)();

ok('日数の計算 — 1月1日から1月31日は30日', L.daysBetweenISO('2026-01-01', '2026-01-31') === 30);
ok('日数の計算 — 過去向きは0', L.daysBetweenISO('2026-06-01', '2026-05-01') === 0);
ok('日数の計算 — 日付でなければ0', L.daysBetweenISO('', '2026-05-01') === 0);
ok('うるう年をまたいでも実日数で数える',
  L.daysBetweenISO('2028-02-28', '2028-03-01') === 2, String(L.daysBetweenISO('2028-02-28', '2028-03-01')));

ok('日割り利息 = 元金 × 年利 ÷ 365 × 日数',
  near(L.accrueOn(1000000, 12, 30), 1000000 * 0.12 / 365 * 30, 0.001));
ok('1年分で年利1回分', near(L.accrueOn(1000000, 12, 365), 120000, 0.001));

// SQLite 版（db.js）と同じ答えになること
const dbFields = require('../db');
{
  const a = L.debtFields({ principal: 300000, interestAccrued: 4500, rate: 15, minPayment: 10000 });
  ok('元金と未払利息を分けて受け取る',
    a.principal === 300000 && a.interestAccrued === 4500, JSON.stringify(a));

  const b = L.debtFields({ balance: 500000, rate: 3.6 });
  ok('balance だけの旧形式は全額を元金として読む',
    b.principal === 500000 && b.interestAccrued === 0, JSON.stringify(b));

  const c = L.debtFields({ principal: 100, interestAccrued: 50, initial: 0 });
  ok('当初借入額は残高を下回らない', c.initial === 150, String(c.initial));

  const d = L.debtFields({ principal: -5, rate: 999, minPayment: -1 });
  ok('負の元金は0、年利は100が上限',
    d.principal === 0 && d.rate === 100 && d.minPayment === 0, JSON.stringify(d));
}

// 返済の充当順序を、SQLite 版の実装と突き合わせる
{
  const os = require('os');
  const TMP = path.join(os.tmpdir(), 'saimu-webtest-' + Date.now() + '.db');
  process.env.SAIMU_DB = TMP;
  delete require.cache[require.resolve('../db')];
  const db = require('../db');

  const id = db.addDebt({ name: 'A', principal: 1000000, interestAccrued: 0,
                          accruedAt: '2026-01-01', rate: 12, minPayment: 30000 });
  db.addRepayment({ debtId: id, amount: 30000, date: '2026-01-31' });
  const r = db.getState().repayments[0];
  const d = db.getState().debts[0];

  // ブラウザ側と同じ手順を手で辿る
  const accrued = 0 + L.accrueOn(1000000, 12, L.daysBetweenISO('2026-01-01', '2026-01-31'));
  const paidInterest = Math.min(30000, accrued);
  const paidPrincipal = Math.min(30000 - paidInterest, 1000000);

  ok('利息への充当が SQLite 版と一致', near(r.interest, paidInterest, 0.001),
    `${r.interest} vs ${paidInterest}`);
  ok('元金への充当が SQLite 版と一致', near(r.principal, paidPrincipal, 0.001),
    `${r.principal} vs ${paidPrincipal}`);
  ok('残った元金が SQLite 版と一致', near(d.principal, 1000000 - paidPrincipal, 0.001),
    `${d.principal}`);

  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch (e) {}
  }
}

/* ==========================================================
   3. 実際にブラウザで開く
   ========================================================== */
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

if (!EDGE) {
  console.log('\nブラウザでの描画確認');
  console.log('  SKIP  Edge が見つかりません');
  done();
}

console.log('\nブラウザでの描画確認');

const http = require('http');
const PORT = 5191;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

const srv = http.createServer((req, res) => {
  const rel = req.url === '/' ? 'index.html' : req.url.replace(/^\/+/, '').split('?')[0];
  const file = path.join(ROOT, 'docs', rel);
  if (!file.startsWith(path.join(ROOT, 'docs'))) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// spawnSync だとイベントループが止まって、この静的サーバーが応答できなくなる。
// ブラウザは非同期で起こして、待っている間もリクエストを捌けるようにする。
function renderWithEdge() {
  const { spawn } = require('child_process');
  return new Promise(resolve => {
    // Google へは行かせない。繋がらない状況でもログイン画面が出ることを確かめたい。
    // 使い捨てのプロファイル。他のテストが起こした Edge と食い合わせない。
    const profile = path.join(require('os').tmpdir(), 'saimu-webtest-profile-' + Date.now());
    const p = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--user-data-dir=' + profile,
      '--host-resolver-rules=MAP accounts.google.com 127.0.0.1:1',
      '--virtual-time-budget=8000', '--dump-dom',
      `http://127.0.0.1:${PORT}/`
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    p.stdout.setEncoding('utf8'); p.stdout.on('data', c => { out += c; });
    p.stderr.setEncoding('utf8'); p.stderr.on('data', c => { err += c; });
    const kill = setTimeout(() => { try { p.kill(); } catch (e) {} }, 60000);
    p.on('close', () => {
      clearTimeout(kill);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
      resolve({ out, err });
    });
  });
}

srv.listen(PORT, '127.0.0.1', async () => {
  const r = await renderWithEdge();
  const dom = r.out || '';
  srv.close();

  ok('ページが描画される', dom.length > 1000, 'DOM ' + dom.length + ' 文字');
  ok('ログイン画面が出る', dom.includes('gate-card'));
  ok('クライアントID未設定なら設定画面になる',
    dom.includes('最初の設定') && dom.includes('apps.googleusercontent.com'));
  ok('本体の画面は隠れている（未ログインでデータが覗けない）',
    /<div id="gate"(?![^>]*hidden)/.test(dom), 'gate が hidden のままになっている');
  ok('JS の実行時エラーが出ていない',
    !/Uncaught|is not defined|is not a function/.test(dom + (r.stderr || '')),
    ((r.stderr || '').split('\n').find(l => /Uncaught|not defined/.test(l)) || '').slice(0, 120));

  done();
});

function done() {
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

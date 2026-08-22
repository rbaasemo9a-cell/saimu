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

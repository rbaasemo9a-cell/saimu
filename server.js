'use strict';
/**
 * 返済ロードマップ — ローカルサーバー
 * 依存パッケージなし。既定では 127.0.0.1 のみで待ち受ける（外部からは接続できない）。
 * --host を付けたときだけ外に出る。そのときはアクセスキーを必須にする。
 *   --host tailscale  Tailscale のアドレスだけで待つ（LAN には出ない）
 *   --host 0.0.0.0    LAN にも Tailscale にも出る
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const db = require('./db');
const net = require('./netinfo');

const argv = process.argv.slice(2);
const argOf = name => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : null;
};
const PORT = Number(argOf('port') || process.env.PORT || 5173);
const OPEN = !argv.includes('--no-open');
const PUBLIC = path.join(__dirname, 'public');

/** --host tailscale は起動時に実アドレスへ解決する。見つからなければ理由を出して止まる。 */
function resolveHost(raw) {
  if (raw !== 'tailscale' && raw !== 'ts') return raw;
  const ts = net.tailscaleAddress();
  if (ts) return ts.address;
  console.error('\n  Tailscale のアドレス（100.64.0.0/10）が見つかりません。');
  console.error('  Tailscale を起動してログインしてから、もう一度試してください。');
  console.error('  確認:  tailscale status\n');
  process.exit(1);
}
const HOST = resolveHost(argOf('host') || process.env.SAIMU_HOST || '127.0.0.1');

/** ループバックだけで待っているなら、そもそも他の端末から届かないので鍵は要らない。 */
const LOCAL_ONLY = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

const MAX_BODY = 8 * 1024 * 1024;   // 8MB（バックアップ取り込み用に大きめ）

/* ---------- アクセスキー ---------- */

const KEY_FILE = path.join(__dirname, 'saimu.key');
// スマホで打ちやすいよう、紛らわしい 0/1/i/l/o を除いた31文字。10桁で約50ビット。
const KEY_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';
const COOKIE = 'saimu_key';

/** 鍵は saimu.key に保存して使い回す。無ければ作る。SAIMU_KEY があればそちらが優先。 */
function loadKey() {
  const fromEnv = (process.env.SAIMU_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch (_) { /* 初回は無くて当たり前 */ }
  let k = '';
  for (let i = 0; i < 10; i++) k += KEY_CHARS[crypto.randomInt(KEY_CHARS.length)];
  fs.writeFileSync(KEY_FILE, k + '\n', { mode: 0o600 });
  return k;
}
const KEY = LOCAL_ONLY ? null : loadKey();

/** 長さの違いも含めて、比較時間から中身が漏れないようにする。 */
function keyEq(given) {
  if (typeof given !== 'string' || !KEY) return false;
  const a = Buffer.from(given), b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieOf(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return null; }
    }
  }
  return null;
}

const isLoopback = ra =>
  ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';

// 総当たりを潰す。IP ごとに失敗を数え、続くようなら一定時間締め出す。
const FAILS = new Map();
const FAIL_MAX = 10;
const FAIL_WINDOW = 10 * 60 * 1000;

function lockedOut(ip) {
  const f = FAILS.get(ip);
  if (!f) return false;
  if (Date.now() - f.at > FAIL_WINDOW) { FAILS.delete(ip); return false; }
  return f.n >= FAIL_MAX;
}
function noteFail(ip) {
  const f = FAILS.get(ip);
  if (f && Date.now() - f.at <= FAIL_WINDOW) { f.n++; f.at = Date.now(); }
  else FAILS.set(ip, { n: 1, at: Date.now() });
}

/**
 * 'ok'      … 通してよい
 * 'grant'   … ?k= が正しい。Cookie を配って鍵なしの URL へ送り直す
 * 'deny'    … 鍵が無い/違う
 * 'locked'  … 失敗が続いたので一時的に締め出し中
 */
function checkAuth(req, url) {
  if (LOCAL_ONLY) return 'ok';
  const ip = req.socket.remoteAddress || '';
  if (isLoopback(ip)) return 'ok';              // 同じ PC からは素通し
  if (lockedOut(ip)) return 'locked';

  if (keyEq(url.searchParams.get('k'))) return 'grant';
  if (keyEq(cookieOf(req.headers.cookie, COOKIE))) return 'ok';
  if (keyEq(req.headers['x-saimu-key'])) return 'ok';

  noteFail(ip);
  return 'deny';
}

const DENY_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>返済ロードマップ</title>
<body style="font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#12151a;color:#e6e9ef">
<div style="max-width:30ch;padding:24px;text-align:center;line-height:1.8">
<h1 style="font-size:17px;margin:0 0 10px">この端末からは開けません</h1>
<p style="font-size:13.5px;color:#9aa3b2;margin:0">
PC の画面に表示されているアクセスキー付きの URL を開いてください。</p>
</div>`;

function sendJSON(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('データが大きすぎます'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(Object.assign(new Error('JSON を解釈できませんでした'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  // public/ の外へ出る経路を塞ぐ
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('見つかりません'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ---------- API ---------- */

async function api(req, res, pathname) {
  const m = req.method;
  const seg = pathname.split('/').filter(Boolean);   // ['api', ...]
  const [, resource, id] = seg;
  const body = (m === 'POST' || m === 'PUT') ? await readBody(req) : {};

  // 書き込み系はすべて、更新後の全状態を返す。画面と DB がずれない。
  const ok = () => sendJSON(res, 200, db.getState());

  switch (resource) {
    case 'state':
      if (m !== 'GET') break;
      return sendJSON(res, 200, db.getState());

    case 'stats':
      if (m !== 'GET') break;
      return sendJSON(res, 200, db.stats());

    case 'debts':
      if (m === 'POST')   { db.addDebt(body); return ok(); }
      if (m === 'PUT')    { db.updateDebt(id, body); return ok(); }
      if (m === 'DELETE') { db.deleteDebt(id); return ok(); }
      break;

    case 'repayments':
      if (m === 'POST')   { db.addRepayment(body); return ok(); }
      if (m === 'DELETE') { db.deleteRepayment(id); return ok(); }
      break;

    case 'borrows':
      if (m === 'POST')   { db.addBorrow(body); return ok(); }
      if (m === 'DELETE') { db.deleteBorrow(id); return ok(); }
      break;

    case 'txns':
      if (m === 'POST')   { db.addTxn(body); return ok(); }
      if (m === 'DELETE') { db.deleteTxn(id); return ok(); }
      break;

    case 'cards':
      if (m === 'POST')   { db.addCard(body); return ok(); }
      if (m === 'PUT')    { db.updateCard(id, body); return ok(); }
      if (m === 'DELETE') { db.deleteCard(id); return ok(); }
      break;

    case 'cardbills':
      if (m === 'POST')   { db.setCardBill(body); return ok(); }
      if (m === 'DELETE') { db.deleteCardBill(id); return ok(); }
      break;

    case 'fixed':
      if (m === 'POST')   { db.addFixed(body); return ok(); }
      if (m === 'PUT')    { db.updateFixed(id, body); return ok(); }
      if (m === 'DELETE') { db.deleteFixed(id); return ok(); }
      break;

    case 'tax':
      if (m === 'POST')   { db.setTax(body); return ok(); }
      if (m === 'DELETE') { db.deleteTax(id); return ok(); }
      break;

    // 既にある支出を、あとから経費に切り替える
    case 'txncost':
      if (m === 'PUT')    { db.setTxnCost(id, body); return ok(); }
      if (m === 'POST')   { db.setTxnCostBulk(body); return ok(); }
      break;

    case 'goals':
      if (m === 'PUT')    { db.setGoals(body); return ok(); }
      break;

    case 'import':
      if (m === 'POST')   { db.importState(body); return ok(); }
      break;

    case 'sample':
      if (m === 'POST')   { db.loadSample(); return ok(); }
      break;

    case 'wipe':
      if (m === 'POST')   { db.wipe(); return ok(); }
      break;

    case 'backup':
      if (m === 'POST')   { return sendJSON(res, 200, db.backup()); }
      break;

    case 'export': {
      if (m !== 'GET') break;
      const stamp = new Date().toISOString().slice(0, 10);
      return sendJSON(res, 200, db.getState(), {
        'Content-Disposition': `attachment; filename="saimu-backup-${stamp}.json"`
      });
    }
  }

  sendJSON(res, 405, { error: 'この操作には対応していません' });
}

/* ---------- サーバー ---------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  switch (checkAuth(req, url)) {
    case 'grant': {
      // 鍵は Cookie に移し、URL からは落として履歴に残さない
      url.searchParams.delete('k');
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE}=${KEY}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
        'Location': url.pathname + (url.search || ''),
        'Cache-Control': 'no-store'
      });
      return res.end();
    }
    case 'locked':
      if (pathname.startsWith('/api/')) return sendJSON(res, 429, { error: '試行が多すぎます。しばらく待ってください' });
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('試行が多すぎます。しばらく待ってください。');
    case 'deny':
      if (pathname.startsWith('/api/')) return sendJSON(res, 401, { error: 'アクセスキーが必要です' });
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(DENY_PAGE);
  }

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  api(req, res, pathname).catch(err => {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err);
    sendJSON(res, status, { error: err.message || 'サーバー側で問題が起きました' });
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nポート ${PORT} は既に使われています。別のポートで起動してください:\n  npm start -- --port 5174\n`);
    process.exit(1);
  }
  throw err;
});

/** 今の待ち受け方で、実際に他の端末から届くアドレス。 */
function reachable() {
  const all = net.interfaces();
  if (HOST === '0.0.0.0' || HOST === '::') return all;
  return all.filter(a => a.address === HOST);
}

server.listen(PORT, HOST, () => {
  const url = `http://127.0.0.1:${PORT}/`;
  const s = db.stats();
  console.log('\n  返済ロードマップ');
  console.log('  ' + url);
  console.log('  DB: ' + s.path + `  (借入 ${s.debts} / 収支 ${s.txns} / 返済 ${s.repayments})`);

  if (!LOCAL_ONLY) {
    const addrs = reachable();
    const ts = addrs.filter(a => a.tailscale);
    const lan = addrs.filter(a => !a.tailscale);

    console.log('\n  ── スマホなど他の端末から ──');
    if (!addrs.length) {
      console.log('  届くアドレスが見つかりませんでした。');
    } else {
      console.log('  下の URL を一度だけ開いてください（以後は鍵なしで開けます）:');
    }

    if (ts.length) {
      console.log('\n  [Tailscale] 外出先からも開けます。通信は暗号化されています。');
      ts.forEach(a => console.log(`    http://${a.address}:${PORT}/?k=${KEY}`));
      console.log(`    MagicDNS を使っているなら  http://${net.magicDnsName()}:${PORT}/?k=${KEY}`);
    }
    if (lan.length) {
      console.log('\n  [LAN] 同じ Wi-Fi の端末から。通信は暗号化されません。');
      lan.forEach(a => console.log(`    http://${a.address}:${PORT}/?k=${KEY}    [${a.name}]`));
    }

    console.log(`\n  アクセスキー: ${KEY}`);
    console.log(`  保存先: ${KEY_FILE}（消すと次回に作り直します）`);
    if (lan.length) {
      console.log('  LAN 側は平文で流れます。信頼できる Wi-Fi でだけ使ってください。');
    }
  }

  console.log('\n  停止するには Ctrl+C\n');
  if (OPEN && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
  }
});

// Ctrl+C で WAL を畳んでから終了する
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

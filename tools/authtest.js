'use strict';
/**
 * LAN 公開（--host 0.0.0.0）のアクセスキーを検証する。
 *   node tools/authtest.js
 *
 * ループバック経由だと素通しになるので、この PC の LAN アドレス宛に投げて
 * 「他の端末から来た接続」と同じ扱いにさせる。LAN アドレスが無い環境では省略する。
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const net = require('../netinfo');

const ROOT = path.join(__dirname, '..');
const PORT = 5189;
const KEY = 'testkey1234';
const DB = path.join(os.tmpdir(), 'saimu-authtest-' + Date.now() + '.db');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

/* ==========================================================
   1. アドレスの判定（実際のネットワークに依らない）
   ========================================================== */
console.log('\nアドレスの判定');

// Tailscale は CGNAT 用の 100.64.0.0/10 を使う。その外側の 100.x は普通のグローバルIP。
[['100.64.0.1', true], ['100.101.102.103', true], ['100.127.255.255', true],
 ['100.63.255.255', false], ['100.128.0.1', false], ['100.0.0.1', false],
 ['192.168.2.101', false], ['10.0.0.5', false], ['', false], ['100.64.0.999', false]]
  .forEach(([ip, want]) =>
    ok(`${ip || '(空)'} は Tailscale ${want ? 'である' : 'でない'}`,
      net.isTailscaleIPv4(ip) === want));

// 合成したインターフェース一覧で、Tailscale と LAN を振り分けられること
{
  const fake = {
    'Wi-Fi':     [{ family: 'IPv4', internal: false, address: '192.168.2.103' }],
    'Tailscale': [{ family: 'IPv4', internal: false, address: '100.101.102.103' }],
    'Loopback':  [{ family: 'IPv4', internal: true,  address: '127.0.0.1' }],
    'IPv6のみ':   [{ family: 'IPv6', internal: false, address: 'fe80::1' }]
  };
  ok('Tailscale のアドレスを選び出せる',
    net.tailscaleAddress(fake).address === '100.101.102.103');
  ok('LAN 側は Tailscale を除いた分だけ',
    net.lanAddresses(fake).length === 1 && net.lanAddresses(fake)[0].address === '192.168.2.103');
  ok('ループバックと IPv6 は候補に入らない', net.interfaces(fake).length === 2);
  ok('Tailscale が無ければ null', net.tailscaleAddress({ 'Wi-Fi': fake['Wi-Fi'] }) === null);
}

/* ==========================================================
   2. アクセスキー（実際に待ち受けて確かめる）
   ========================================================== */
const LAN = (net.lanAddresses()[0] || {}).address || null;

console.log('\nLAN 公開時のアクセスキー');
if (!LAN) {
  console.log('  SKIP  LAN アドレスが無いので省略します');
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

function req(host, pathname, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host, port: PORT, path: pathname, method: opts.method || 'GET', headers: opts.headers || {} },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const server = spawn(process.execPath,
  [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '0.0.0.0', '--no-open'],
  { env: Object.assign({}, process.env, { SAIMU_DB: DB, SAIMU_KEY: KEY }), stdio: 'ignore' });

const cleanup = () => {
  try { server.kill(); } catch (_) {}
  for (const f of [DB, DB + '-wal', DB + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch (_) {}
  }
};
process.on('exit', cleanup);

/** 起動を待つ。127.0.0.1 は素通しなので、応答が返れば準備完了。 */
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await req('127.0.0.1', '/api/state');
      if (r.status === 200) return true;
    } catch (_) { /* まだ立ち上がっていない */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  if (!await waitReady()) {
    console.log('  FAIL  サーバーが起動しませんでした\n');
    process.exit(1);
  }

  // 同じ PC（ループバック）からは鍵なしで通る
  {
    const r = await req('127.0.0.1', '/api/state');
    ok('127.0.0.1 からは鍵なしで開ける', r.status === 200, 'status=' + r.status);
  }

  // LAN 経由・鍵なし → 拒否
  {
    const a = await req(LAN, '/api/state');
    ok('LAN から鍵なしの API は 401', a.status === 401, 'status=' + a.status);
    ok('401 の本文にデータが含まれない', !a.body.includes('debts'), a.body.slice(0, 80));

    const b = await req(LAN, '/');
    ok('LAN から鍵なしの画面は 401', b.status === 401, 'status=' + b.status);
    ok('401 の画面は案内文を返す', b.body.includes('この端末からは開けません'));
  }

  // 間違った鍵 → 拒否
  {
    const r = await req(LAN, '/api/state?k=wrongkey999');
    ok('間違った鍵は 401', r.status === 401, 'status=' + r.status);
  }

  // 正しい鍵 → Cookie を配って鍵なしの URL へ送り直す
  let cookie = null;
  {
    const r = await req(LAN, '/?k=' + KEY);
    ok('正しい鍵は 302 で返す', r.status === 302, 'status=' + r.status);
    const sc = String(r.headers['set-cookie'] || '');
    ok('Cookie に鍵が入る', sc.includes('saimu_key=' + KEY), sc);
    ok('Cookie は HttpOnly / SameSite=Lax', sc.includes('HttpOnly') && sc.includes('SameSite=Lax'), sc);
    ok('転送先の URL から鍵が消えている',
      !String(r.headers.location || '').includes(KEY), String(r.headers.location));
    cookie = 'saimu_key=' + KEY;
  }

  // Cookie / ヘッダで通る
  {
    const a = await req(LAN, '/api/state', { headers: { Cookie: cookie } });
    ok('Cookie があれば API が通る', a.status === 200, 'status=' + a.status);

    const b = await req(LAN, '/', { headers: { Cookie: cookie } });
    ok('Cookie があれば画面が開ける', b.status === 200 && b.body.includes('<!doctype html>'),
      'status=' + b.status);

    const c = await req(LAN, '/api/state', { headers: { 'X-Saimu-Key': KEY } });
    ok('X-Saimu-Key ヘッダでも通る', c.status === 200, 'status=' + c.status);
  }

  // 書き込みもできる（スマホから返済を記録する用）
  {
    const body = JSON.stringify({ name: 'スマホから', principal: 100000, rate: 10, minPayment: 5000 });
    const r = await req(LAN, '/api/debts', {
      method: 'POST', body,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    });
    ok('鍵があれば書き込みもできる', r.status === 200 && JSON.parse(r.body).debts.length === 1,
      'status=' + r.status);
  }

  // 総当たりの締め出し（失敗が重なると 429）。他を巻き込むので最後に回す。
  {
    let locked = false;
    for (let i = 0; i < 15 && !locked; i++) {
      const r = await req(LAN, '/api/state?k=bad' + i);
      if (r.status === 429) locked = true;
    }
    ok('鍵の総当たりは 429 で締め出す', locked);

    const still = await req('127.0.0.1', '/api/state');
    ok('締め出し中でも 127.0.0.1 からは使える', still.status === 200, 'status=' + still.status);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('  FAIL  ' + e.message + '\n');
  cleanup();
  process.exit(1);
});

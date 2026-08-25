'use strict';
/**
 * スマホ幅でレイアウトが崩れていないかを見る。
 *   node tools/mobiletest.js
 *
 * 普段使いはスマホなので、横スクロールが出る＝不具合として扱う。
 * ヘッドレスの --window-size は OS の最小ウィンドウ幅で頭打ちになるため、
 * 目的の幅の iframe にアプリを入れて、その中から実測する。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 5195;
const WIDTHS = [390, 360];                 // iPhone 12〜15 / 小さめの Android
const VIEWS = ['dash', 'debts', 'cash', 'goals', 'tax', 'sim', 'data'];
const DB = path.join(os.tmpdir(), 'saimu-mobile-' + Date.now() + '.db');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('\nスマホ表示');
if (!EDGE) { console.log('  SKIP  Edge が見つかりません\n'); process.exit(0); }

const src = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const tmp = [];
const put = (name, html) => {
  const f = path.join(ROOT, 'public', name);
  fs.writeFileSync(f, html, 'utf8');
  tmp.push(f);
};

const probe = v => `<script>
 (async () => {
   const wait = ms => new Promise(r => setTimeout(r, ms));
   for (let i = 0; i < 240; i++) {
     if (document.querySelectorAll('.nav-item').length && document.getElementById('view-dash').innerHTML) break;
     await wait(50);
   }
   const b = [...document.querySelectorAll('.nav-item')].find(x => x.dataset.view === '${v}');
   if (b) b.click();
   await wait(500);
   const out = {};
   try {
     const de = document.documentElement;
     out.vw = de.clientWidth;
     out.overflow = de.scrollWidth - de.clientWidth;
     out.wide = [];
     document.querySelectorAll('*').forEach(el => {
       const r = el.getBoundingClientRect();
       if (!r.width || el.closest('.table-wrap')) return;
       if (r.right - de.clientWidth > 1) {
         const cls = (typeof el.className === 'string' ? el.className : '').split(' ').filter(Boolean)[0] || '';
         out.wide.push(el.tagName.toLowerCase() + (cls ? '.' + cls : ''));
       }
     });
     out.wide = [...new Set(out.wide)].slice(0, 4);
     out.tiny = 0;
     document.querySelectorAll('button, a, input, select').forEach(el => {
       const r = el.getBoundingClientRect();
       if (r.height > 0 && r.height < 36) out.tiny++;
     });
     const navItems = [...document.querySelectorAll('.nav-item')];
     out.tabs = navItems.length;
     // タブが増えると1つあたりの幅が痩せる。名前が読めなくなる前に気づきたい。
     const nav = document.querySelector('.rail-nav');
     out.navOverflow = nav ? Math.max(0, nav.scrollWidth - nav.clientWidth) : 0;
     out.navMinW = navItems.length
       ? Math.round(Math.min(...navItems.map(el => el.getBoundingClientRect().width))) : 0;
   } catch (e) { out.err = e.message; }
   const pre = document.createElement('pre');
   pre.id = 'probe'; pre.textContent = JSON.stringify(out);
   document.body.appendChild(pre);
 })();
</script></body>`;

const frame = (v, w) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{width:${w}px;height:1500px;border:0;display:block}</style>
<iframe id="fr" src="/__mt_${v}.html"></iframe>
<script>
 (async () => {
   const wait = ms => new Promise(r => setTimeout(r, ms));
   const fr = document.getElementById('fr');
   for (let i = 0; i < 320; i++) {
     try {
       const d = fr.contentDocument;
       if (d && d.getElementById('probe')) {
         const pre = document.createElement('pre');
         pre.id = 'probe'; pre.textContent = d.getElementById('probe').textContent;
         document.body.appendChild(pre); break;
       }
     } catch (e) {}
     await wait(60);
   }
 })();
</script>`;

VIEWS.forEach(v => put('__mt_' + v + '.html', src.replace('</body>', probe(v))));
WIDTHS.forEach(w => VIEWS.forEach(v => put(`__mf_${v}_${w}.html`, frame(v, w))));

const server = spawn(process.execPath,
  [path.join(ROOT, 'server.js'), '--port', String(PORT), '--no-open'],
  { env: Object.assign({}, process.env, { SAIMU_DB: DB }), stdio: 'ignore' });

const cleanup = () => {
  try { server.kill(); } catch (e) {}
  tmp.forEach(f => { try { fs.rmSync(f, { force: true }); } catch (e) {} });
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
};
process.on('exit', cleanup);

const render = url => {
  const prof = path.join(os.tmpdir(), 'mt-' + Math.random().toString(36).slice(2));
  const r = spawnSync(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + prof, '--window-size=900,1500', '--virtual-time-budget=20000',
    '--dump-dom', url], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, timeout: 120000 });
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  const m = (r.stdout || '').match(/<pre id="probe">([\s\S]*?)<\/pre>/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); }
  catch (e) { return null; }
};

(async () => {
  for (let i = 0; i < 80; i++) {
    try { await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/api/state`, x => { x.resume(); res(); }).on('error', rej)); break; }
    catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  await new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/sample', method: 'POST' },
      x => { x.resume(); x.on('end', res); });
    r.on('error', rej); r.end();
  });

  for (const w of WIDTHS) {
    for (const v of VIEWS) {
      const p = render(`http://127.0.0.1:${PORT}/__mf_${v}_${w}.html`);
      if (!p) { ok(`${w}px ${v}`, false, '計測できませんでした'); continue; }
      ok(`${w}px ${v} — 横スクロールが出ない`, p.overflow <= 1,
        `はみ出し ${p.overflow}px / ${p.wide.join(', ')}`);
      // 閉じたダイアログが画面に出ていないこと。display を #dlg に直接書くと
      // ブラウザ標準の dialog:not([open]) を打ち消し、各画面の下に
      // 「保存・キャンセル」が出たままになる。
      ok(`${w}px ${v} — 閉じたダイアログが画面に出ていない`,
        !p.dlgOpen && !p.dlgShown, `open=${p.dlgOpen} 表示=${p.dlgShown}`);
      if (w === WIDTHS[0]) {
        ok(`${w}px ${v} — 指で押せない部品が無い`, p.tiny === 0, `${p.tiny} 個が36px未満`);
      }
    }
  }
  // 下部タブは全画面ぶん出ていること
  for (const w of WIDTHS) {
    const p = render(`http://127.0.0.1:${PORT}/__mf_dash_${w}.html`);
    ok(`${w}px — 下部タブに${VIEWS.length}画面ぶん並ぶ`, p && p.tabs === VIEWS.length,
      p ? String(p.tabs) : '—');
    ok(`${w}px — 下部タブが横に溢れない`, p && p.navOverflow <= 1,
      p ? `${p.navOverflow}px はみ出し` : '—');
    // 40px を切ると3〜4文字の名前が入らなくなる
    ok(`${w}px — 各タブに名前が入る幅がある`, p && p.navMinW >= 40,
      p ? `一番狭いタブが ${p.navMinW}px` : '—');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  cleanup();
  process.exit(fail ? 1 : 0);
})();

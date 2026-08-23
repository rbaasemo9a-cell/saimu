'use strict';
/**
 * ダイアログの実挙動をヘッドレス Edge で確認する。
 * public/index.html をそのまま読み込み、末尾にテスト用スクリプトだけを足した
 * 一時ファイルを作って開く。終わったら消す。
 *   node tools/uitest.js
 *
 * 以前まれに落ちていたのは、テストではなくアプリの不具合だった。
 * <dialog> の close は非同期に発火するため、閉じた直後に別の画面を開くと、
 * 遅れて届いた close が次の画面の保存処理（onSubmit）を消していた。
 * 押しても黙って何も起きない、という形で表に出る。手順8がその再現。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'index.html');
const TEST_PAGE = path.join(ROOT, 'public', '__uitest.html');
const PORT = 5188;
const DB = path.join(os.tmpdir(), 'saimu-uitest-' + Date.now() + '.db');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));
if (!EDGE) { console.error('Edge が見つかりません'); process.exit(1); }

/* テスト本体。アプリの読み込みが終わってから DOM を操作する。 */
const HARNESS = `
<script>
(async () => {
  const out = [];
  const ok = (name, cond, extra) => out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !extra ? '' : '  -> ' + extra));
  const $ = s => document.querySelector(s);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // 仮想時間では setTimeout が一気に進むので、非同期の完了は条件で待つ
  const waitFor = async (fn, tries = 200) => {
    for (let i = 0; i < tries; i++) {
      try { if (await fn()) return true; } catch (e) {}
      await wait(50);
    }
    return false;
  };
  const txnCount = async () => (await (await fetch('/api/state')).json()).txns.length;

  // 失敗したときに何が起きたかを残す。待ちを足さず、記録するだけにする。
  const diag = { submit: 0, posts: 0, postErr: '', dlgOpen: [] };
  const _fetch = window.fetch;
  window.fetch = function (u, o) {
    if (o && o.method === 'POST') {
      diag.posts++;
      return _fetch.apply(this, arguments)
        .then(r => { if (!r.ok) diag.postErr = 'status ' + r.status; return r; })
        .catch(e => { diag.postErr = String(e && e.message || e); throw e; });
    }
    return _fetch.apply(this, arguments);
  };
  document.getElementById('dlgForm').addEventListener('submit', () => { diag.submit++; }, true);
  const nav = v => { [...document.querySelectorAll('.nav-item')].find(b => b.dataset.view === v).click(); };
  const dlg = $('#dlg');

  try {
    // boot() の fetch が終わって画面が描かれるまで待つ
    await waitFor(async () => document.querySelectorAll('.nav-item').length > 0 &&
                              $('#view-dash').innerHTML.length > 0);

    // --- 1. 収入の追加ダイアログ: 金額が空のままキャンセル ---
    nav('cash'); await wait(120);
    [...document.querySelectorAll('[data-act="add-income"]')][0].click();
    await wait(80);
    ok('収入ダイアログが開く', dlg.open);
    ok('金額欄が空で必須', $('#t-amt').value === '' && $('#t-amt').required);
    $('#dlgCancel').click(); await wait(80);
    ok('金額が空でもキャンセルで閉じる', !dlg.open);

    // --- 2. 支出も同じ ---
    [...document.querySelectorAll('[data-act="add-expense"]')][0].click();
    await wait(80);
    $('#dlgCancel').click(); await wait(80);
    ok('支出ダイアログもキャンセルで閉じる', !dlg.open);

    // --- 3. 借入の追加（全項目が空）でもキャンセルできる ---
    nav('debts'); await wait(120);
    [...document.querySelectorAll('[data-act="add-debt"]')][0].click();
    await wait(80);
    ok('借入ダイアログが開く', dlg.open);
    $('#dlgCancel').click(); await wait(80);
    ok('借入ダイアログもキャンセルで閉じる', !dlg.open);

    // --- 4. 入力途中でキャンセルしても保存されない ---
    nav('cash'); await wait(120);
    const nBefore = await txnCount();
    [...document.querySelectorAll('[data-act="add-expense"]')][0].click();
    await wait(80);
    $('#t-amt').value = '9999';
    $('#dlgCancel').click();
    await wait(400);
    const nAfter = await txnCount();
    ok('キャンセルした内容は DB に入らない', nBefore === nAfter, nBefore + ' → ' + nAfter);

    // --- 5. 送信ボタンは1つ = Enter は「保存」になる ---
    [...document.querySelectorAll('[data-act="add-expense"]')][0].click();
    await wait(80);
    const submits = [...dlg.querySelectorAll('button[type=submit]')];
    ok('送信ボタンは「保存」1つだけ', submits.length === 1 && submits[0].id === 'dlgOk',
      submits.map(b => b.id || b.textContent).join(','));
    ok('キャンセルは送信ボタンではない', $('#dlgCancel').type === 'button');

    // --- 6. 必須が空のまま保存 → 閉じずに検証が働く ---
    $('#dlgOk').click(); await wait(120);
    ok('金額が空なら保存では閉じない（検証が働く）', dlg.open);
    ok('検証エラーが金額欄に付く', !$('#t-amt').checkValidity());
    // --- 7. 正しく入れれば保存できる（SQLite に届いたかを API で確かめる） ---
    const n0 = await txnCount();
    $('#t-amt').value = '1234';
    $('#t-amt').dispatchEvent(new Event('input', { bubbles: true }));
    await wait(60);
    $('#dlgOk').click();
    const closed = await waitFor(async () => !dlg.open);
    const saved = await waitFor(async () => (await txnCount()) === n0 + 1);
    ok('保存でダイアログが閉じる', closed);
    ok('保存した金額が DB に入る', saved,
      '件数 ' + n0 + ' → ' + (await txnCount()) +
      '  submit=' + diag.submit + ' post=' + diag.posts +
      (diag.postErr ? ' postErr=' + diag.postErr : '') +
      ' toast=' + (($('#toast') || {}).textContent || '(なし)'));
    ok('保存後の画面に金額が出る',
      await waitFor(async () => document.body.innerText.includes('1,234')));

    // --- 8. 閉じた直後に別の画面を開いても保存できる ---
    // close は非同期に発火する。遅れて届いた close が次の画面の保存処理を
    // 消してしまい、押しても黙って何も起きない不具合があった。
    const n1 = await txnCount();
    [...document.querySelectorAll('[data-act="add-expense"]')][0].click();
    await wait(60);
    $('#dlgCancel').click();                       // 待たずに次を開く
    [...document.querySelectorAll('[data-act="add-income"]')][0].click();
    await wait(60);
    $('#t-amt').value = '777';
    $('#t-amt').dispatchEvent(new Event('input', { bubbles: true }));
    $('#dlgOk').click();
    const savedAfterCancel = await waitFor(async () => (await txnCount()) === n1 + 1);
    ok('キャンセル直後に開いた画面でも保存できる', savedAfterCancel,
      '件数 ' + n1 + ' → ' + (await txnCount()) + ' submit=' + diag.submit + ' post=' + diag.posts);

    // --- 9. Esc でも閉じる ---
    [...document.querySelectorAll('[data-act="add-income"]')][0].click();
    await wait(80);
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    dlg.close('cancel');                          // headless では Esc が届かないことがある
    await wait(80);
    ok('Esc / close() で閉じる', !dlg.open);
  } catch (e) {
    out.push('FAIL  例外: ' + e.message);
  }

  const pre = document.createElement('pre');
  pre.id = 'uitest-result';
  pre.textContent = out.join('\\n');
  document.body.innerHTML = '';
  document.body.appendChild(pre);
})();
</script>`;

fs.writeFileSync(TEST_PAGE, fs.readFileSync(SRC, 'utf8').replace('</body>', HARNESS + '\n</body>'), 'utf8');

const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--no-open'],
  { env: Object.assign({}, process.env, { SAIMU_DB: DB }), stdio: 'ignore' });

// 既定のプロファイルを使うと、他のテストが起こした Edge と食い合って
// 結果が安定しない。実行ごとに使い捨てのプロファイルを与えて切り離す。
const PROFILE = path.join(os.tmpdir(), 'saimu-uitest-profile-' + Date.now());

const cleanup = () => {
  try { server.kill(); } catch (e) {}
  try { fs.rmSync(TEST_PAGE, { force: true }); } catch (e) {}
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  try { fs.rmSync(path.join(os.tmpdir(), 'backups'), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
};
process.on('exit', cleanup);

setTimeout(() => {
  const r = spawnSync(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + PROFILE,
    '--virtual-time-budget=90000', '--dump-dom',   // 仮想時間は一気に進むので、通信の完了を待てるだけの余裕を取る
    `http://127.0.0.1:${PORT}/__uitest.html`
  ], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });

  const m = (r.stdout || '').match(/<pre id="uitest-result">([\s\S]*?)<\/pre>/);
  if (!m) {
    console.error('テスト結果を取得できませんでした。');
    console.error((r.stderr || '').slice(0, 800));
    cleanup(); process.exit(1);
  }
  const lines = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').split('\n');
  console.log('\nダイアログ挙動 (ヘッドレス Edge)\n');
  lines.forEach(l => console.log('  ' + l));
  const failed = lines.filter(l => l.startsWith('FAIL')).length;
  console.log('\n' + (lines.length - failed) + ' passed, ' + failed + ' failed\n');
  cleanup();
  process.exit(failed ? 1 : 0);
}, 1600);

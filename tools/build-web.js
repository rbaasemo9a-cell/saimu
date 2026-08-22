'use strict';
/**
 * GitHub Pages 版を組み立てる。
 *   node tools/build-web.js   →   docs/index.html
 *
 * 画面のコードは public/index.html ただ1つ。ここではデータ層だけを
 * Google スプレッドシート版に差し替える。UI を二重管理しないための作り。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'index.html');
const OUT_DIR = path.join(ROOT, 'docs');
const OUT = path.join(OUT_DIR, 'index.html');
const WEB = path.join(ROOT, 'web');

const read = p => fs.readFileSync(p, 'utf8');

/** /* @swap:名前 *​/ … /* @swap:名前:end *​/ を丸ごと置き換える。 */
function swap(html, name, replacement) {
  const start = `/* @swap:${name} */`;
  const end = `/* @swap:${name}:end */`;
  const i = html.indexOf(start);
  const j = html.indexOf(end);
  if (i < 0 || j < 0) throw new Error(`差し替え位置が見つかりません: @swap:${name}`);
  return html.slice(0, i) + replacement.trimEnd() + '\n  ' + html.slice(j + end.length);
}

let html = read(SRC);

// 1. サーバー用のデータ層 → スプレッドシート用に差し替え
html = swap(html, 'api', [read(path.join(WEB, 'store.js')), read(path.join(WEB, 'api.js'))].join('\n'));
html = swap(html, 'boot', read(path.join(WEB, 'boot.js')));

// 2. ログイン画面の下敷きと、Google の部品を読み込む一行
const gateCSS = read(path.join(WEB, 'gate.css'));
html = html.replace('</style>', gateCSS.trimEnd() + '\n</style>');
html = html.replace('</head>',
  '<script src="https://accounts.google.com/gsi/client" async defer></script>\n</head>');
html = html.replace('<body>', '<body>\n<div id="gate" hidden></div>');

// 3. サーバー前提の文言を、置かれている場所に合わせて直す
const RETEXT = [
  ['サーバーに接続できません。npm start が動いているか確認してください。',
   'Google に接続できません。通信状況を確かめてから、もう一度お試しください。'],
  ['<h2>データベース</h2>', '<h2>保存先</h2>'],
  ['<td>ファイルの大きさ</td>', '<td>データの大きさ</td>'],
  ['<b>データベースの複製</b>は <code style="font-family:var(--mono);font-size:12px">VACUUM INTO</code> で作ります。単なるファイルのコピーと違い、書き込み途中の中途半端な状態を掴むことがありません。',
   '<b>スプレッドシートの複製</b>を、あなたのドライブに日付つきで作ります。元のシートはそのまま残ります。'],
  ['<button class="btn primary" data-act="backup">データベースを複製する</button>',
   '<button class="btn primary" data-act="backup">スプレッドシートを複製する</button>'],
  ['/** SQLite の VACUUM INTO で DB ファイルそのものの複製を backups/ に作る */',
   '/** Drive の files.copy でスプレッドシートごと複製する */'],
  ['ローカルの SQLite ファイルに保存しています',
   'あなたの Google ドライブのスプレッドシートに保存しています'],
  ['データはこの PC の中だけにあります',
   'データはあなたの Google アカウントの中だけにあります']
];
for (const [from, to] of RETEXT) html = html.split(from).join(to);

// 4. 目印そのものは残しておく必要がないので消す
html = html.replace(/\s*\/\* @swap:[a-z]+(?::end)? \*\/\n?/g, '\n');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
// GitHub Pages の Jekyll 処理を止める（_ で始まる名前などをそのまま配るため）
fs.writeFileSync(path.join(OUT_DIR, '.nojekyll'), '');

// 差し替え漏れの検査。サーバー前提のコードが残っていたら気づけるようにする。
const leftovers = ["fetch('/api", 'npm start', 'VACUUM'].filter(s => html.includes(s));
console.log(`\n  docs/index.html を書き出しました  (${(html.length / 1024).toFixed(0)} KB)`);
if (leftovers.length) {
  console.log('  ⚠ サーバー前提の記述が残っています: ' + leftovers.join(', '));
  process.exit(1);
}
console.log('  サーバー前提の記述は残っていません\n');

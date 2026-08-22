'use strict';
/** 公開前の静的チェック: JS 構文 / HTML 構造 / テーマトークンの漏れ */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(file, 'utf8');
let bad = 0;
const say = (okFlag, msg) => { if (!okFlag) bad++; console.log((okFlag ? '  OK    ' : '  FAIL  ') + msg); };

// 1. JS 構文
const m = html.match(/<script>([\s\S]*?)<\/script>/);
try {
  new Function(m[1]);
  say(true, 'JS 構文 (' + m[1].split('\n').length + ' 行)');
} catch (e) {
  say(false, 'JS 構文: ' + e.message);
}

// 2. HTML の骨格
const need = ['<!doctype html>', '<meta charset="utf-8">', '<meta name="viewport"', '</head>', '<body>', '</body>', '</html>'];
const miss = need.filter(s => !html.includes(s));
say(miss.length === 0, 'HTML の骨格' + (miss.length ? ' — 不足: ' + miss.join(', ') : ''));

// 3. タグの閉じ忘れ
const voids = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr','!doctype']);
const body = html
  .replace(/<!--[\s\S]*?-->/g, '')          // コメントはタグとして数えない
  .replace(/<script>[\s\S]*?<\/script>/g, '')
  .replace(/<style>[\s\S]*?<\/style>/g, '');
const stack = []; const errs = [];
for (const t of body.matchAll(/<(\/?)([a-zA-Z!][a-zA-Z0-9-]*)([^>]*)>/g)) {
  const [, close, tag, attrs] = t;
  if (voids.has(tag.toLowerCase()) || attrs.trim().endsWith('/')) continue;
  if (close) {
    if (stack[stack.length - 1] !== tag) errs.push('</' + tag + '> が対応しない');
    else stack.pop();
  } else stack.push(tag);
}
if (stack.length) errs.push('閉じていない: ' + stack.join(', '));
say(errs.length === 0, 'タグの入れ子' + (errs.length ? ' — ' + errs.join(' | ') : ''));

// 4. ダークテーマだけで定義された色がないか（明るいテーマで色が消えるバグ）
const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const rootVars = new Set();
const rootBlock = style.match(/:root\s*\{([\s\S]*?)\}/);
if (rootBlock) for (const v of rootBlock[1].matchAll(/(--[a-z0-9-]+)\s*:/g)) rootVars.add(v[1]);
const scoped = new Set();
for (const b of style.matchAll(/(?:@media[^{]*\{\s*)?:root(?:\[data-theme[^\]]*\]|:not\([^)]*\))[^{]*\{([\s\S]*?)\}/g))
  for (const v of b[1].matchAll(/(--[a-z0-9-]+)\s*:/g)) scoped.add(v[1]);
const orphan = [...scoped].filter(v => !rootVars.has(v));
say(orphan.length === 0, 'テーマトークン ' + rootVars.size + ' 件' + (orphan.length ? ' — 明色の既定なし: ' + orphan.join(', ') : ''));

// 5. 旧 localStorage 版の残骸
const stale = ['localStorage', 'storageOK', 'window.claude', 'loadSample('].filter(s => m[1].includes(s));
say(stale.length === 0, '旧保存層の残骸' + (stale.length ? ' — ' + stale.join(', ') : 'なし'));

console.log(bad ? '\n' + bad + ' 件の問題\n' : '\nすべて通過\n');
process.exit(bad ? 1 : 0);

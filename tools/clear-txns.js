'use strict';
/**
 * 収入・支出（txns）だけを空にする。借入・返済・目標には触れない。
 * 実行前に VACUUM INTO でバックアップを取る。
 *   node tools/clear-txns.js          消す前の内訳を表示するだけ
 *   node tools/clear-txns.js --yes    実際に消す
 */
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH, backup, getState } = require('../db');

const doIt = process.argv.includes('--yes');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 4000');

const yen = n => '¥' + Math.round(n).toLocaleString('ja-JP');

const total = db.prepare(`
  SELECT COUNT(*) AS n,
         SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income,
         SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
         MIN(date) AS since, MAX(date) AS until
  FROM txns`).get();

if (!total.n) {
  console.log('収入・支出の記録は既に0件です。何もしません。');
  process.exit(0);
}

console.log('現在の収入・支出');
console.log('  ' + total.n + ' 件  (' + total.since + ' 〜 ' + total.until + ')');
console.log('  収入 ' + yen(total.income || 0) + ' / 支出 ' + yen(total.expense || 0) + '\n');

const byMonth = db.prepare(`
  SELECT substr(date,1,7) AS m, COUNT(*) AS n,
         SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income,
         SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense
  FROM txns GROUP BY 1 ORDER BY 1`).all();
byMonth.forEach(r =>
  console.log('  ' + r.m + '  ' + String(r.n).padStart(3) + '件   収入 ' +
    yen(r.income).padStart(11) + '   支出 ' + yen(r.expense).padStart(11)));

const keep = getState();
console.log('\n残すもの: 借入 ' + keep.debts.length + ' 件 / 返済 ' + keep.repayments.length +
            ' 件 / 目標' + (keep.goals.targetDate ? ' (' + keep.goals.targetDate + ')' : ''));

if (!doIt) {
  console.log('\n消す場合は --yes を付けて実行してください。');
  process.exit(0);
}

const b = backup();
console.log('\nバックアップ: ' + b.file + '  (' + Math.round(b.size / 1024) + ' KB)');

db.exec('BEGIN IMMEDIATE');
try {
  const r = db.prepare('DELETE FROM txns').run();
  db.exec('COMMIT');
  console.log('収入・支出を ' + r.changes + ' 件削除しました。');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const after = getState();
console.log('残り: 収支 ' + after.txns.length + ' 件 / 借入 ' + after.debts.length +
            ' 件 / 返済 ' + after.repayments.length + ' 件');

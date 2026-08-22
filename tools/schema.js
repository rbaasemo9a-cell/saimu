'use strict';
/** npm run schema — 現在の DB のスキーマと件数を表示する */
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH, stats } = require('../db');

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db.prepare(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type DESC, name"
).all();

console.log('DB: ' + DB_PATH + '\n');
for (const r of rows) console.log(r.sql.trim() + ';\n');

const s = stats();
console.log('件数:  借入 ' + s.debts + ' / 収支 ' + s.txns + ' / 返済 ' + s.repayments);
console.log('容量:  ' + Math.round(s.size / 1024) + ' KB');

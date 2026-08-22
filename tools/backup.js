'use strict';
/** npm run backup — DB ファイルの複製を backups/ に作る */
const db = require('../db');
const r = db.backup();
console.log('バックアップを作成しました');
console.log('  ' + r.file + '  (' + Math.round(r.size / 1024) + ' KB)');

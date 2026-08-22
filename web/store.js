/* ==========================================================
   データ層 — Google スプレッドシート
   tools/build-web.js が public/index.html のデータ層と差し替える。

   ・ログインは Google。drive.file スコープなので、このアプリが作った
     ファイルにしか触れない。他人の Drive は見えないし、こちらも見せない。
   ・保存先は利用者自身の Drive に作る1枚のスプレッドシート。
     つまり「誰がログインしたか」がそのまま「どのデータを見るか」になる。
   ・書き込みは毎回、全シートを1回の batchUpdate で置き換える。
     部分更新をしないので「返済は記録されたが残高が古いまま」が起きない。
   ========================================================== */

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = '返済ロードマップ';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

const LS = {
  clientId: 'saimu.clientId',
  fileId:   'saimu.fileId'
};

/* ---------- 表の形 ---------- */

const TABLES = {
  debts: ['id', 'name', 'principal', 'interestAccrued', 'accruedAt',
          'initial', 'rate', 'minPayment', 'createdAt'],
  txns: ['id', 'type', 'date', 'amount', 'category', 'memo'],
  repayments: ['id', 'debtId', 'date', 'amount', 'interest', 'principal', 'memo'],
  goals: ['targetDate', 'monthlyRepay', 'emergency', 'emergencyCurrent'],
  meta: ['revision', 'updatedAt', 'app']
};
const NUMERIC = new Set(['principal', 'interestAccrued', 'initial', 'rate', 'minPayment',
                         'amount', 'interest', 'monthlyRepay', 'emergency', 'emergencyCurrent',
                         'revision']);

/* ---------- 利息（db.js と同じ規則） ---------- */

const DAY_BASIS_DB = 365;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function daysBetweenISO(fromISO, toISO) {
  if (!ISO_DATE.test(fromISO || '') || !ISO_DATE.test(toISO || '')) return 0;
  const [y1, m1, d1] = fromISO.split('-').map(Number);
  const [y2, m2, d2] = toISO.split('-').map(Number);
  return Math.max(0, Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000));
}
/** 利息は元金にのみ付く。未払いのまま残った利息はそれ自身では増えない。 */
const accrueOn = (principal, rate, days) => principal * (rate / 100 / DAY_BASIS_DB) * days;

/* ---------- 値の正規化（db.js と同じ扱い） ---------- */

const toNum = (v, def = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : def;
};
const strOf = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const dateOrDefault = (v, fallback) => (ISO_DATE.test(strOf(v, 10)) ? strOf(v, 10) : fallback);
const nowISO = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

class Refused extends Error {}

function debtFields(b) {
  const split = b.principal != null || b.interestAccrued != null;
  const principal = Math.max(0, split ? toNum(b.principal) : toNum(b.balance));
  const interest = Math.max(0, toNum(b.interestAccrued));
  const balance = principal + interest;
  return {
    principal, interestAccrued: interest,
    accruedAt: dateOrDefault(b.accruedAt, nowISO()),
    initial: Math.max(balance, toNum(b.initial) || balance),
    rate: Math.min(100, Math.max(0, toNum(b.rate))),
    minPayment: Math.max(0, toNum(b.minPayment))
  };
}

/* ---------- ログイン ---------- */

let clientId = localStorage.getItem(LS.clientId) || '';
let tokenClient = null;
let accessToken = null;
let tokenExpires = 0;
let profile = null;

const setClientId = id => {
  clientId = String(id || '').trim();
  localStorage.setItem(LS.clientId, clientId);
  tokenClient = null;
};

function gisReady() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      if (Date.now() - t0 > 12000) return reject(new Error('Google のログイン部品を読み込めませんでした'));
      setTimeout(poll, 60);
    })();
  });
}

/** アクセストークンを取る。1時間で切れるので、切れていれば取り直す。 */
async function getToken(interactive) {
  if (accessToken && Date.now() < tokenExpires - 60000) return accessToken;
  if (!clientId) throw new Refused('クライアントIDが未設定です');
  await gisReady();

  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: r => {
        if (r.error) return reject(new Refused(r.error_description || r.error));
        accessToken = r.access_token;
        tokenExpires = Date.now() + (Number(r.expires_in || 3600) * 1000);
        resolve(accessToken);
      },
      error_callback: e => reject(new Refused((e && e.message) || 'ログインを中断しました'))
    });
    // 初回は同意画面を出す。2回目以降は黙って取り直す。
    tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

function signOut() {
  if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
    try { google.accounts.oauth2.revoke(accessToken); } catch (e) { /* 失効済みなら何もしない */ }
  }
  accessToken = null; tokenExpires = 0; profile = null;
  localStorage.removeItem(LS.fileId);
}

/* ---------- Google API 呼び出し ---------- */

async function gapi(url, opts) {
  opts = opts || {};
  const token = await getToken(false);
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: Object.assign(
      { Authorization: 'Bearer ' + token },
      opts.body ? { 'Content-Type': 'application/json' } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) {          // トークンが切れていた。取り直して1度だけやり直す。
    accessToken = null;
    const fresh = await getToken(false);
    const retry = await fetch(url, {
      method: opts.method || 'GET',
      headers: Object.assign(
        { Authorization: 'Bearer ' + fresh },
        opts.body ? { 'Content-Type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!retry.ok) throw new Error(await describe(retry));
    return retry.json();
  }
  if (!res.ok) throw new Error(await describe(res));
  return res.json();
}

async function describe(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = (j.error && (j.error.message || j.error.status)) || '';
  } catch (e) { /* 本文が JSON でないこともある */ }
  if (res.status === 403) return 'Google に拒否されました。' + (detail || 'スコープや権限を確認してください');
  if (res.status === 429) return 'Google の利用上限に達しました。少し待ってからもう一度試してください';
  return 'Google との通信に失敗しました（' + res.status + '）' + (detail ? ' ' + detail : '');
}

/* ---------- スプレッドシートの用意 ---------- */

let fileId = localStorage.getItem(LS.fileId) || '';
let sheetIds = {};       // 表の名前 → sheetId
let rowCounts = {};      // 前回書いた行数。余りを空行で消すのに使う。
let revision = 0;

async function ensureFile() {
  if (fileId) {
    try {
      await loadSheetIds();
      return fileId;
    } catch (e) {
      fileId = '';                                   // 消された・共有が外れた等
      localStorage.removeItem(LS.fileId);
    }
  }
  // drive.file なので、ここで見えるのはこのアプリが作ったファイルだけ
  const q = encodeURIComponent(
    `name='${FILE_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
  const found = await gapi(`${DRIVE_API}?q=${q}&fields=files(id,name)&pageSize=10`);
  if (found.files && found.files.length) {
    fileId = found.files[0].id;
  } else {
    const made = await gapi(SHEETS_API, {
      method: 'POST',
      body: {
        properties: { title: FILE_NAME },
        sheets: Object.keys(TABLES).map(name => ({ properties: { title: name } }))
      }
    });
    fileId = made.spreadsheetId;
  }
  localStorage.setItem(LS.fileId, fileId);
  await loadSheetIds();
  return fileId;
}

async function loadSheetIds() {
  const meta = await gapi(`${SHEETS_API}/${fileId}?fields=sheets(properties(sheetId,title))`);
  sheetIds = {};
  (meta.sheets || []).forEach(s => { sheetIds[s.properties.title] = s.properties.sheetId; });

  // 足りない表があれば足す（古いファイルを開いたとき用）
  const missing = Object.keys(TABLES).filter(t => sheetIds[t] === undefined);
  if (missing.length) {
    await gapi(`${SHEETS_API}/${fileId}:batchUpdate`, {
      method: 'POST',
      body: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) }
    });
    const again = await gapi(`${SHEETS_API}/${fileId}?fields=sheets(properties(sheetId,title))`);
    sheetIds = {};
    (again.sheets || []).forEach(s => { sheetIds[s.properties.title] = s.properties.sheetId; });
  }
}

/* ---------- 読み書き ---------- */

const colLetter = n => String.fromCharCode(64 + n);
const rangeOf = t => `${t}!A1:${colLetter(TABLES[t].length)}`;

function rowsToObjects(table, rows) {
  const cols = TABLES[table];
  const out = [];
  for (const row of (rows || []).slice(1)) {                 // 1行目は見出し
    if (!row || row.every(c => String(c ?? '') === '')) continue;
    const o = {};
    cols.forEach((c, i) => {
      const raw = row[i];
      o[c] = NUMERIC.has(c) ? toNum(raw) : String(raw ?? '');
    });
    out.push(o);
  }
  return out;
}

async function readAll() {
  const ranges = Object.keys(TABLES).map(t => `ranges=${encodeURIComponent(rangeOf(t))}`).join('&');
  const got = await gapi(`${SHEETS_API}/${fileId}/values:batchGet?${ranges}&majorDimension=ROWS`);
  const byTable = {};
  Object.keys(TABLES).forEach((t, i) => {
    const values = (got.valueRanges && got.valueRanges[i] && got.valueRanges[i].values) || [];
    rowCounts[t] = Math.max(0, values.length - 1);
    byTable[t] = rowsToObjects(t, values);
  });

  const g = byTable.goals[0] || {};
  const m = byTable.meta[0] || {};
  revision = toNum(m.revision);

  return {
    debts: byTable.debts,
    txns: byTable.txns,
    repayments: byTable.repayments,
    goals: {
      targetDate: g.targetDate || '',
      monthlyRepay: toNum(g.monthlyRepay),
      emergency: toNum(g.emergency),
      emergencyCurrent: toNum(g.emergencyCurrent)
    }
  };
}

/** 全シートを1回の batchUpdate で置き換える。前回より短くなった分は空行で消す。 */
async function writeAll(st) {
  const payload = {
    debts: st.debts, txns: st.txns, repayments: st.repayments,
    goals: [st.goals],
    meta: [{ revision: revision + 1, updatedAt: new Date().toISOString(), app: 'saimu-roadmap' }]
  };

  const requests = [];
  for (const table of Object.keys(TABLES)) {
    const cols = TABLES[table];
    const data = payload[table] || [];
    const body = data.map(o => cols.map(c => o[c]));
    const blanks = Math.max(0, (rowCounts[table] || 0) - data.length);
    const rows = [cols].concat(body).concat(
      Array.from({ length: blanks }, () => cols.map(() => '')));

    requests.push({
      updateCells: {
        range: { sheetId: sheetIds[table], startRowIndex: 0, startColumnIndex: 0 },
        fields: 'userEnteredValue',
        rows: rows.map(r => ({
          values: r.map(v => ({
            userEnteredValue: v === '' || v == null ? {}
              : (typeof v === 'number' ? { numberValue: v } : { stringValue: String(v) })
          }))
        }))
      }
    });
    rowCounts[table] = data.length;
  }

  await gapi(`${SHEETS_API}/${fileId}:batchUpdate`, { method: 'POST', body: { requests } });
  revision += 1;
}

/** 他の端末が先に書いていないか確かめる。書き負けを黙って起こさないため。 */
async function assertFresh() {
  const got = await gapi(
    `${SHEETS_API}/${fileId}/values:batchGet?ranges=${encodeURIComponent('meta!A1:C2')}`);
  const rows = (got.valueRanges && got.valueRanges[0] && got.valueRanges[0].values) || [];
  const theirs = toNum((rows[1] || [])[0]);
  if (theirs > revision) {
    throw new Error('別の端末で更新されています。画面を再読み込みしてから、もう一度お試しください');
  }
}

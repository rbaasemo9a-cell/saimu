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
  fileId:   'saimu.fileId',
  token:    'saimu.token',
  cache:    'saimu.cache'
};

/** なぜログインが要るのかを画面で説明するために覚えておく。 */
let authReason = 'none';

/* ---------- 表の形 ---------- */

const TABLES = {
  debts: ['id', 'name', 'principal', 'interestAccrued', 'accruedAt',
          'originPrincipal', 'originInterest', 'originDate',
          'initial', 'rate', 'minPayment', 'createdAt'],
  txns: ['id', 'type', 'date', 'amount', 'category', 'memo', 'payMonth', 'cardId'],
  cards: ['id', 'name', 'createdAt'],
  cardBills: ['id', 'cardId', 'payMonth', 'amount', 'memo'],
  repayments: ['id', 'debtId', 'date', 'amount', 'interest', 'principal', 'memo'],
  borrows: ['id', 'debtId', 'date', 'amount', 'memo'],
  fixed: ['id', 'type', 'name', 'day', 'category', 'amount', 'memo', 'createdAt'],
  goals: ['targetDate', 'monthlyRepay', 'emergency', 'emergencyCurrent'],
  meta: ['revision', 'updatedAt', 'app']
};
const NUMERIC = new Set(['principal', 'interestAccrued', 'originPrincipal', 'originInterest',
                         'initial', 'rate', 'minPayment',
                         'amount', 'interest', 'monthlyRepay', 'emergency', 'emergencyCurrent', 'day',
                         'revision']);

/* ---------- 利息（db.js と同じ規則） ---------- */

const DAY_BASIS_DB = 365;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

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

/** YYYY-MM に n ヶ月足す。年またぎもここで面倒を見る。 */
function addMonthKey(key, n) {
  if (!ISO_MONTH.test(key || '')) return key;
  const [y, m] = key.split('-').map(Number);
  const t = (y * 12) + (m - 1) + n;
  return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
}
const monthOf = iso => String(iso || '').slice(0, 7);
/** 引落月。指定が無ければ利用月そのまま（＝現金・口座払い）。 */
function payMonthFor(b, date) {
  const given = strOf(b.payMonth, 7);
  return ISO_MONTH.test(given) ? given : monthOf(date);
}

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

/**
 * アクセストークンは1時間で切れる短命な鍵。これを端末に覚えておかないと、
 * 画面を再読み込みするたびに Google のログインをやり直す羽目になる。
 * 保存先はこの端末のこのサイト専用の領域で、他のサイトからは読めない。
 */
function rememberToken() {
  try {
    localStorage.setItem(LS.token, JSON.stringify({ t: accessToken, e: tokenExpires }));
  } catch (e) { /* 保存できなくても動作は続けられる */ }
}
function forgetToken() {
  accessToken = null; tokenExpires = 0;
  try { localStorage.removeItem(LS.token); } catch (e) {}
}
function recallToken() {
  try {
    const raw = localStorage.getItem(LS.token);
    if (!raw) { authReason = 'none'; return false; }
    const v = JSON.parse(raw);
    // 期限ぎりぎりのものは使わない。操作の途中で切れる方が困る。
    if (v && v.t && v.e > Date.now() + 120000) {
      accessToken = v.t; tokenExpires = v.e;
      authReason = 'ok';
      return true;
    }
    authReason = 'expired';
  } catch (e) { authReason = 'broken'; }
  forgetToken();
  return false;
}

/* ---------- 手元の控え ---------- */

/**
 * 最後に読んだ内容をこの端末に控えておく。
 * 開いた瞬間に前回の数字を出せるので、「見るだけ」ならログインが要らない。
 * アクセストークンは1時間で切れる短命な鍵で、ブラウザだけで動く作りでは
 * 長期の更新鍵をもらえない。だから残高を見るたびにログイン、を避けるには
 * 手元に控えておくしかない。
 */
function saveCache(state) {
  try {
    localStorage.setItem(LS.cache, JSON.stringify({ fileId, at: Date.now(), state }));
  } catch (e) { /* 容量超過などは無視。次の同期でまた試す */ }
}
function loadCache() {
  try {
    const raw = localStorage.getItem(LS.cache);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !v.state) return null;
    // 別のファイルを開いている控えは使わない
    if (v.fileId && fileId && v.fileId !== fileId) return null;
    return v;
  } catch (e) { return null; }
}
function clearCache() {
  try { localStorage.removeItem(LS.cache); } catch (e) {}
}
recallToken();

/** 覚えている鍵だけで進めるか。true ならログイン画面を出さずに済む。 */
const hasLiveToken = () => !!accessToken && Date.now() < tokenExpires - 120000;

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
        rememberToken();
        resolve(accessToken);
      },
      error_callback: e => reject(new Refused((e && e.message) || 'ログインを中断しました'))
    });
    // prompt を空にすると、同意済みなら黙って発行され、必要なときだけ画面が出る。
    // 'consent' を指定すると毎回同意画面が出てしまうので使わない。
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

function signOut() {
  if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
    try { google.accounts.oauth2.revoke(accessToken); } catch (e) { /* 失効済みなら何もしない */ }
  }
  forgetToken();
  clearCache();
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
    authReason = 'rejected';
    forgetToken();
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

/**
 * 行を項目に組み直す。**1行目の見出しを見て対応づける。**
 *
 * 位置で決め打つと、列を1つ足しただけで既存のシートが全部ずれる。
 * 実際、debts の途中に起点の3列を入れたときに年利と最低返済額が消えた。
 * 見出しで引けば、古いシートを開いても無い列が空になるだけで済む。
 */
function rowsToObjects(table, rows) {
  const cols = TABLES[table];
  const header = (rows && rows[0]) || [];
  const at = {};
  cols.forEach(c => {
    const i = header.findIndex(h => String(h ?? '').trim() === c);
    // 見出しが無いシート（自分で作る前の手書きなど）だけ、並び順を頼りにする
    at[c] = i >= 0 ? i : (header.length ? -1 : cols.indexOf(c));
  });

  const out = [];
  for (const row of (rows || []).slice(1)) {
    if (!row || row.every(c => String(c ?? '') === '')) continue;
    const o = {};
    cols.forEach(c => {
      const raw = at[c] >= 0 ? row[at[c]] : undefined;
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

  // 起点の列が無かった頃のシートを開いたとき。いまの状態をそのまま起点として補う。
  // ここを空のままにすると、次の書き込みで元金0として保存され残高が消える。
  byTable.debts.forEach(d => {
    if (!ISO_DATE.test(d.originDate || '')) {
      d.originDate = ISO_DATE.test(d.accruedAt || '') ? d.accruedAt : nowISO();
      d.originPrincipal = d.principal;
      d.originInterest = d.interestAccrued;
    }
    if (!(d.initial > 0)) d.initial = d.principal + d.interestAccrued;
  });

  const g = byTable.goals[0] || {};
  const m = byTable.meta[0] || {};
  revision = toNum(m.revision);

  return {
    debts: byTable.debts,
    cards: byTable.cards,
    cardBills: byTable.cardBills,
    borrows: byTable.borrows,
    fixed: byTable.fixed,
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
    cards: st.cards, cardBills: st.cardBills, borrows: st.borrows, fixed: st.fixed,
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

/* ----------------------------------------------------------
   起動 — ログインしてから、自分のスプレッドシートを開く。
   ---------------------------------------------------------- */

function gateEl() { return document.getElementById('gate'); }

function showGate(mode, detail) {
  const g = gateEl();
  const needsId = !clientId;
  g.hidden = false;
  g.innerHTML = `
    <div class="gate-card">
      <div class="gate-mark">返済ロードマップ</div>
      ${needsId ? `
        <h1>最初の設定</h1>
        <p>Google Cloud で作った<b>クライアントID</b>を貼り付けてください。
           この端末にだけ保存され、どこにも送信されません。</p>
        <input type="text" id="gate-id" placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"
               autocomplete="off" spellcheck="false">
        <button class="btn primary" id="gate-save">保存して次へ</button>
        <p class="gate-note">手順は README の「Google Cloud の設定」を見てください。</p>
      ` : `
        <h1>ログイン</h1>
        <p>あなたの Google ドライブにある<b>あなた自身のデータ</b>だけを開きます。
           他の人のデータは見えませんし、あなたのデータも他の人には見えません。</p>
        <p class="gate-why">${{
          none:     'この端末にログインの記録がありません。初回か、ブラウザの保存領域が消えた場合です。',
          expired:  '前回の許可が期限切れです（1時間で切れます）。ブラウザだけで動く作りのため、長期の更新鍵は受け取れません。',
          broken:   'この端末に保存された情報が読めませんでした。入り直してください。',
          rejected: 'Google に許可を取り消されました。もう一度ログインしてください。',
          ok:       ''
        }[authReason] || ''}</p>
        <button class="btn primary" id="gate-in">Google でログイン</button>
        ${detail ? `<p class="gate-err">${esc(detail)}</p>` : ''}
        <p class="gate-note">
          このアプリが触れるのは、このアプリが作ったファイルだけです（<code>drive.file</code>）。
          ドライブの他のファイルには一切アクセスしません。
          <button class="linklike" id="gate-reset">クライアントIDを設定し直す</button>
        </p>
      `}
    </div>`;

  if (needsId) {
    const input = document.getElementById('gate-id');
    const go = () => {
      const v = input.value.trim();
      if (!v.includes('.apps.googleusercontent.com')) {
        input.setCustomValidity('クライアントIDの形式ではありません');
        input.reportValidity();
        return;
      }
      setClientId(v);
      showGate();
    };
    document.getElementById('gate-save').addEventListener('click', go);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.focus();
  } else {
    document.getElementById('gate-in').addEventListener('click', signIn);
    document.getElementById('gate-reset').addEventListener('click', () => {
      setClientId('');
      showGate();
    });
  }
}

function hideGate() { gateEl().hidden = true; }

async function signIn() {
  const btn = document.getElementById('gate-in');
  if (btn) { btn.disabled = true; btn.textContent = 'ログイン中…'; }
  try {
    await getToken(true);
    await afterSignIn();
  } catch (e) {
    showGate('in', e.message || 'ログインできませんでした');
  }
}

/** ログイン後：本人確認 → 自分のファイルを用意 → 読み込み → 描画 */
async function afterSignIn() {
  // ここで userinfo を叩いてはいけない。要求しているのは drive.file だけなので
  // 権限外として 401 が返り、gapi がそれを「鍵が切れた」と誤解して鍵を捨て、
  // 取り直しのポップアップを毎回出してしまう。メール表示のために払う代償ではない。
  await ensureFile();
  mem = await readAll();
  saveCache(mem);                     // 次に開いたときログイン無しで見られるように
  dbStats = await api('/stats');
  adopt(await api('/state'));
  online = true;
  hideGate();
  hideStaleBanner();
  render();
}

/** 手元の控えを画面に出す。ログインしていなくても前回の数字が見られる。 */
function showCached() {
  const c = loadCache();
  if (!c) return null;
  mem = c.state;
  adopt(derive(mem));
  online = false;
  hideGate();
  render();
  showStaleBanner(c.at);
  return c;
}

async function boot() {
  online = false;
  mem = { debts: [], txns: [], repayments: [], borrows: [], cards: [], cardBills: [], fixed: [],
          goals: { targetDate: '', monthlyRepay: 0, emergency: 0, emergencyCurrent: 0 } };
  adopt(mem);

  if (!clientId) { render(); showGate(); return; }

  // まず手元の控えを出す。残高を見るだけならこれで足りるので、
  // アクセストークンが切れていてもログイン画面で止めない。
  const cached = showCached();
  if (!cached) render();

  // 期限内の鍵があれば、Google に問い合わせずそのまま最新に合わせる。
  if (hasLiveToken()) {
    try {
      await afterSignIn();
      return;
    } catch (e) {
      // 通信の失敗と、鍵が拒否されたのは別物。拒否でなければ鍵は捨てない。
      if (authReason !== 'rejected') {
        if (cached) { showStaleBanner(cached.at, e.message); return; }
      } else {
        forgetToken();
      }
    }
  }

  // 鍵が無い・切れている。
  // ここで自動的に取り直そうとすると、Google のアカウント選択が勝手に出る。
  // 静かに終わる保証が無い（特にスマホのブラウザ）ので、控えがあるなら出さない。
  // 更新は「最新にする」を押したときと、記録を変えるときだけにする。
  if (cached) {
    showStaleBanner(cached.at);
    return;
  }
  try {
    await getToken(false);
    await afterSignIn();
  } catch (e) {
    showGate('in');
  }
}

/**
 * 使っている最中に期限が切れないよう、先回りして取り直す。
 * すでに許可済みで Google の画面も開いたばかりなので、たいていは何も出ずに通る。
 * 失敗しても何もしない（控えを見せたまま、必要なときに押してもらう）。
 */
function keepTokenFresh() {
  setInterval(async () => {
    if (document.hidden || !online) return;
    if (!accessToken) return;
    if (Date.now() < tokenExpires - 10 * 60 * 1000) return;   // 残り10分を切ってから
    try {
      await getToken(false);
    } catch (e) { /* 取り直せなければ、次の操作のときに改めて出す */ }
  }, 5 * 60 * 1000);
}
keepTokenFresh();

/** 控えを見せているときの帯。いつ時点の数字かと、更新の手立てを出す。 */
function showStaleBanner(at, note) {
  const d = new Date(at);
  const stamp = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
                String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  let bar = document.getElementById('stale');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'stale';
    document.body.appendChild(bar);
  }
  bar.innerHTML =
    `<span>この端末に保存された <b>${stamp}</b> 時点の内容です${note ? '（' + esc(note) + '）' : ''}</span>
     <button class="btn sm primary" id="stale-sync">最新にする</button>`;
  bar.hidden = false;
  document.getElementById('stale-sync').addEventListener('click', async () => {
    const b = document.getElementById('stale-sync');
    b.disabled = true; b.textContent = '更新中…';
    try {
      await getToken(true);
      await afterSignIn();
      hideStaleBanner();
    } catch (e) {
      b.disabled = false; b.textContent = '最新にする';
      toast(e.message || '更新できませんでした');
    }
  });
}
function hideStaleBanner() {
  const bar = document.getElementById('stale');
  if (bar) bar.hidden = true;
}

/** ヘッダのアカウント表示から呼ぶ。 */
function signOutAndReset() {
  signOut();
  location.reload();
}
window.saimuSignOut = signOutAndReset;

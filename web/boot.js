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
  try {
    profile = await gapi('https://www.googleapis.com/oauth2/v3/userinfo');
  } catch (e) {
    profile = null;                                  // 表示用なので取れなくても続ける
  }
  await ensureFile();
  mem = await readAll();
  dbStats = await api('/stats');
  adopt(await api('/state'));
  online = true;
  hideGate();
  render();
  if (profile && profile.email) toast(profile.email + ' として開きました');
}

async function boot() {
  online = false;
  mem = { debts: [], txns: [], repayments: [],
          goals: { targetDate: '', monthlyRepay: 0, emergency: 0, emergencyCurrent: 0 } };
  adopt(mem);
  render();

  if (!clientId) { showGate(); return; }

  // 前回ログイン済みなら、同意画面を出さずに黙って入り直す
  try {
    await getToken(false);
    await afterSignIn();
  } catch (e) {
    showGate('in');
  }
}

/** ヘッダのアカウント表示から呼ぶ。 */
function signOutAndReset() {
  signOut();
  location.reload();
}
window.saimuSignOut = signOutAndReset;

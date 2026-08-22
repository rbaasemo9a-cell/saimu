'use strict';
/**
 * 返済ロードマップ — このPCがどのアドレスで見えるかを調べる。
 * 副作用なし。os.networkInterfaces() の結果を引数で差し替えられるので単体で試せる。
 */
const os = require('os');

/**
 * Tailscale が配るアドレスかどうか。
 * Tailscale は CGNAT 用に予約された 100.64.0.0/10（100.64.x.x〜100.127.x.x）を使う。
 * 同じ 100 始まりでも 100.0.x.x や 100.128.x.x は普通のグローバルIPなので含めない。
 */
function isTailscaleIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return false;
  const part = m.slice(1).map(Number);
  if (part.some(n => n > 255)) return false;
  return part[0] === 100 && part[1] >= 64 && part[1] <= 127;
}

/** 外向きの IPv4 を全部集める。 */
function interfaces(nets) {
  const ifs = nets || os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifs)) {
    for (const a of (ifs[name] || [])) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address, tailscale: isTailscaleIPv4(a.address) });
    }
  }
  return out;
}

/** Tailscale のアドレス。見つからなければ null。 */
function tailscaleAddress(nets) {
  return interfaces(nets).find(i => i.tailscale) || null;
}

/** Tailscale 以外（＝同じLANの他の端末から見えるアドレス）。 */
function lanAddresses(nets) {
  return interfaces(nets).filter(i => !i.tailscale);
}

/** MagicDNS を有効にしていれば、この名前でも開ける。 */
function magicDnsName() {
  return String(os.hostname() || '').toLowerCase().split('.')[0];
}

module.exports = { isTailscaleIPv4, interfaces, tailscaleAddress, lanAddresses, magicDnsName };

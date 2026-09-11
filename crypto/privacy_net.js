/**
 * Operator/network anonymity. Logs use a rotating connection id.
 * Never join IP + dest / she1 / login in one line or JSON object.
 */
let seq = 0;

export function newConnId() {
  seq = (seq + 1) % 1e9;
  return `c${seq.toString(36)}`;
}

export function walletSubmitLog({ connId, ok } = {}) {
  return JSON.stringify({
    event: 'wallet_submit',
    conn: String(connId || newConnId()),
    ok: !!ok,
  });
}

export function lineJoinsIpToIdentity(line) {
  const s = String(line || '');
  const ip = /remoteAddress|peerIp|"ip"\s*:|\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(s);
  const id = /she1|shear1|ssa1|login|dest|txid/i.test(s);
  return ip && id;
}

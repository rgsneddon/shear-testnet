/**
 * Operator posture that is not book law: fee identity, stratum listen,
 * interval certify wording, and the bound stratum auth pub.
 * Russell pinned this fee ssa1 for the shear-testnet-v10 reset. One percent.
 */

export const THIS_POOL_DIRECT_FEE_DEST = 'ssa1qzcru37269cx30t7pdsmujwrxhc76km6ctzhwggxnyr9f0ld85wc4zvluktldtcnke7mr524ngqqvfr3sd5qsh6kkuk';

export const CERTIFY_WINDOW = 288;

export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '' || h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/**
 * Fee publish dest and admin spend dest are one pin.
 * Unset env keeps both on THIS_POOL_DIRECT_FEE_DEST (no silent swap).
 * A mismatch fails closed. SHEAR_FEE_IDENTITY_LAB=1 is the only bypass.
 */
export function feeIdentityCheck({
  feeDest = '',
  adminSpendDest = '',
  labOverride = false,
} = {}) {
  const fee = String(feeDest || '').trim();
  const admin = String(adminSpendDest || '').trim();
  if (labOverride) {
    return { ok: true, lab: true, reason: '', feeDest: fee, adminSpendDest: admin };
  }
  if (!fee || !admin || fee !== admin) {
    return { ok: false, lab: false, reason: 'fee_dest_mismatch', feeDest: fee, adminSpendDest: admin };
  }
  return { ok: true, lab: false, reason: '', feeDest: fee, adminSpendDest: admin };
}

export function configuredFeeIdentity({
  env = process.env,
  feeDest,
  adminSpendDest,
  labOverride,
} = {}) {
  const e = env || {};
  // The live unit still names the pin SHEAR_POOL_FEE_PAYOUT_DEST. Read that
  // so a deploy does not swap it for the shipped constant under a new key.
  const legacy = String(e.SHEAR_POOL_FEE_PAYOUT_DEST || '').trim();
  const fee = String(feeDest || e.SHEAR_FEE_DEST || legacy || THIS_POOL_DIRECT_FEE_DEST).trim();
  const admin = String(
    adminSpendDest || e.SHEAR_ADMIN_SPEND_DEST || e.SHEAR_FEE_DEST || legacy || THIS_POOL_DIRECT_FEE_DEST,
  ).trim();
  return feeIdentityCheck({
    feeDest: fee,
    adminSpendDest: admin,
    labOverride: labOverride === true || String(e.SHEAR_FEE_IDENTITY_LAB || '') === '1',
  });
}

/**
 * Public bind (not loopback) needs a TLS listener or an explicit lab flag.
 * Loopback may stay cleartext. requireTls without a cert fails closed.
 * Dual-listen is the migrate default when a cert is present and requireTls is off.
 */
export function stratumListenPlan({
  bind = '127.0.0.1',
  hasTls = false,
  requireTls = false,
  labCleartext = false,
} = {}) {
  const loop = isLoopbackHost(bind);
  if (requireTls && !hasTls) {
    return { ok: false, reason: 'require_tls_without_cert', cleartext: false, tls: false, loopback: loop };
  }
  if (!loop && !hasTls && !labCleartext) {
    return { ok: false, reason: 'public_bind_needs_tls_or_lab', cleartext: true, tls: false, loopback: false };
  }
  const cleartext = !(requireTls && !loop && !labCleartext);
  return { ok: true, reason: '', cleartext, tls: !!hasTls, loopback: loop };
}

/** AUTH=1 cannot pass unless the presented pub is the bound operator pub. */
export function authPubGate({ requireAuth = false, boundPub = '', presentedPub = '' } = {}) {
  if (!requireAuth) return { ok: true, reason: '' };
  const bound = String(boundPub || '').trim().toLowerCase();
  const presented = String(presentedPub || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bound)) return { ok: false, reason: 'auth_pub_unbound' };
  if (presented !== bound) return { ok: false, reason: 'auth_pub_mismatch' };
  return { ok: true, reason: '' };
}

/**
 * n < 288 never certifies ~90s and never says ready-on-interval.
 * EWMA stays observational.
 */
export function intervalCertify({
  sealedSamples = 0,
  ewmaMs = null,
  sealedMeanMs = null,
  targetMs = 90000,
  window = CERTIFY_WINDOW,
} = {}) {
  const n = Math.max(0, Math.floor(Number(sealedSamples) || 0));
  const soaking = n < Number(window);
  const ewma = Number(ewmaMs);
  const mean = Number(sealedMeanMs);
  const observationalMs = Number.isFinite(ewma) && ewma > 0 ? ewma : null;
  const meanMs = Number.isFinite(mean) && mean > 0 ? mean : null;
  const near = meanMs != null && Math.abs(meanMs - Number(targetMs)) <= 15000;
  const certified90s = !soaking && near;
  return {
    sealedSamples: n,
    certifyWindow: Number(window),
    soaking,
    certified90s,
    readyOnInterval: certified90s,
    observationalMs,
    sealedMeanMs: meanMs,
    text: soaking
      ? `soaking n=${n}/${window} — ~90s not certified`
      : (certified90s ? `n=${n} ~90s certified` : `n=${n} window full — not on interval`),
  };
}

/** Public stats shape: counts and a tail, never the full fee dest or a fluxset. */
export function narrowPublicStats(stats) {
  const src = stats && typeof stats === 'object' ? { ...stats } : {};
  const full = String(src.feeDest || '');
  if (full) src.feeDestTail = full.slice(-4);
  delete src.feeDest;
  delete src.fluxset;
  delete src.pubs;
  delete src.workerPubs;
  if (Array.isArray(src.workers)) {
    src.workers = src.workers.map((w) => {
      const row = { ...w };
      delete row.pub;
      delete row.spendPub;
      delete row.authPub;
      delete row.payoutDest;
      delete row.dest;
      return row;
    });
  }
  return src;
}

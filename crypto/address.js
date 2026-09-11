import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
} from 'node:crypto';
import {
  destCommitFromSpendPub,
  stealthSpendPubFrom,
  stealthKey,
  isStealthKey,
  stealthSign,
} from './stealth_ed25519.js';

export { destCommitFromSpendPub, stealthSpendPubFrom, isStealthKey, stealthSign };

export const HRP = 'shear';
export const HRP_DEST = 'ssa';
export const HRP_PAY = 'she';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values) {
  const gens = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) {
      if ((b >> i) & 1) chk ^= gens[i];
    }
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << to) - 1;
  const out = [];
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits) out.push((acc << (to - bits)) & maxv);
  if (!pad && (bits >= from || ((acc << (to - bits)) & maxv))) return null;
  return out;
}

export function encodeHrp(hrp, bytes) {
  const data = Buffer.from(bytes);
  if (!data.length) throw new Error('empty payload');
  const values = [0, ...convertBits([...data], 8, 5, true)];
  const checksum = polymod([...hrpExpand(hrp), ...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const ret = [...values];
  for (let i = 0; i < 6; i += 1) ret.push((checksum >> (5 * (5 - i))) & 31);
  return `${hrp}1${ret.map((v) => CHARSET[v]).join('')}`;
}

export function bech32Hrp(s) {
  const t = String(s || '').trim().toLowerCase();
  const one = t.indexOf('1');
  if (one < 1) return '';
  return t.slice(0, one);
}

function bech32BodyOk(s) {
  const t = String(s || '').trim();
  const one = t.indexOf('1');
  if (one < 1) return false;
  const body = t.slice(one + 1).toLowerCase();
  if (body.length < 6) return false;
  return /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(body);
}

export function encodeAddress(pubkeyHash20) {
  return encodeHrp(HRP, pubkeyHash20);
}

export function encodeDest(pubkeyHash20) {
  const data = Buffer.from(pubkeyHash20);
  if (data.length !== 20) throw new Error('spend hash must be 20 bytes');
  return encodeHrp(HRP_DEST, data);
}

/** 20-byte she1 payload: SHA256(shear-she1-v2 || scanPub || spendPub)[0:20]. Not rest-frame S. */
export function paymentIdHash(scanPub, spendPub) {
  const scan = Buffer.from(scanPub);
  const spend = Buffer.from(spendPub);
  if (scan.length !== 32 || spend.length !== 32) throw new Error('silent code keys must be 32 bytes');
  return createHash('sha256')
    .update(Buffer.from('shear-she1-v2'))
    .update(scan)
    .update(spend)
    .digest()
    .subarray(0, 20);
}

/** Product payment code: version || X25519 scanPub || Ed25519 spendPub. Not a 20-byte hash. */
export const PAYMENT_CODE_VERSION = 1;

export function encodePaymentCode({ scanPub, spendPub }) {
  const scan = Buffer.from(scanPub);
  const spend = Buffer.from(spendPub);
  if (scan.length !== 32 || spend.length !== 32) throw new Error('silent code keys must be 32 bytes');
  return encodeHrp(HRP_PAY, Buffer.concat([Buffer.from([PAYMENT_CODE_VERSION]), scan, spend]));
}

export function encodePaymentFingerprint(scanPub, spendPub) {
  return encodeHrp(HRP_PAY, paymentIdHash(scanPub, spendPub));
}

export function isShearAddress(s) {
  const t = String(s || '').trim();
  return bech32Hrp(t) === 'shear' && bech32BodyOk(t);
}

export function isPaymentCode(s) {
  return decodePaymentCode(s) != null;
}

export function isDestAddress(s) {
  const t = String(s || '').trim();
  if (isShearAddress(t)) return false;
  if (bech32Hrp(t) === 'she') return false;
  return bech32Hrp(t) === 'ssa' && bech32BodyOk(t);
}

/** Login identity: dest or silent ID, worker suffix stripped. */
export function identityOfLogin(login) {
  return String(login || '').trim().split('.')[0];
}

export function isMineLogin(s) {
  const id = identityOfLogin(s);
  return isDestAddress(id) || isPaymentCode(id);
}

/**
 * Payable dest of a login. ssa1 pays as-is. Payment codes are not payable —
 * construct a stealth dest with silentDestFromCode. Never encodeDest(she1.hash20).
 */
export function payoutDest(login) {
  const id = identityOfLogin(login);
  if (isDestAddress(id)) return id;
  return null;
}

/** The dead alias dest20 = she1.hash20. Hasher/send/coinbase must refuse this. */
export function aliasDestOfSilentId(login) {
  const d = decodePaymentCode(identityOfLogin(login));
  if (!d?.hash20) return null;
  return encodeDest(d.hash20);
}

export function decodeBech32Payload(address) {
  const raw = String(address || '').trim();
  const one = raw.indexOf('1');
  if (one < 1) return null;
  const body = raw.slice(one + 1).toLowerCase();
  const vals = [];
  for (const ch of body) {
    const i = CHARSET.indexOf(ch);
    if (i < 0) return null;
    vals.push(i);
  }
  if (vals.length < 7) return null;
  const bytes = convertBits(vals.slice(0, -6).slice(1), 5, 8, false);
  if (!bytes || !bytes.length) return null;
  return Buffer.from(bytes);
}

export function hash20FromAddress(address) {
  const bytes = decodeBech32Payload(address);
  if (!bytes || bytes.length < 20) return null;
  return bytes.subarray(0, 20);
}

export function decodePaymentCode(s) {
  const t = String(s || '').trim();
  if (isShearAddress(t) || bech32Hrp(t) !== 'she' || !bech32BodyOk(t)) return null;
  const p = decodeBech32Payload(t);
  if (!p) return null;
  if (p.length === 65 && p[0] === PAYMENT_CODE_VERSION) {
    const scanPub = Buffer.from(p.subarray(1, 33));
    const spendPub = Buffer.from(p.subarray(33, 65));
    return {
      version: PAYMENT_CODE_VERSION,
      scanPub,
      spendPub,
      hash20: paymentIdHash(scanPub, spendPub),
    };
  }
  if (p.length === 20) return { hash20: Buffer.from(p) };
  return null;
}

export function isFullPaymentCode(s) {
  const d = decodePaymentCode(s);
  return !!(d && d.scanPub && d.spendPub);
}

export function isPaymentFingerprint(s) {
  const d = decodePaymentCode(s);
  return !!(d && d.hash20 && !d.scanPub);
}

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function x25519PrivateFromSeed(seed32) {
  const seed = Buffer.from(seed32);
  if (seed.length !== 32) throw new Error('x25519 seed must be 32 bytes');
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function x25519PublicFromRaw(raw32) {
  const raw = Buffer.from(raw32);
  if (raw.length !== 32) throw new Error('x25519 pub must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function x25519PublicRaw(key) {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  return pub.export({ type: 'spki', format: 'der' }).subarray(-32);
}

export function scanSeedFromView(viewKey, index = 0) {
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(BigInt(index));
  return createHash('sha256')
    .update(Buffer.from('shear-scan-v1'))
    .update(Buffer.from(String(viewKey || ''), 'utf8'))
    .update(n)
    .digest();
}

export const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Raw 32-byte Ed25519 public key. This is the spend pub in dest openings. */
export function ed25519RawPub(key) {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  return pub.export({ type: 'spki', format: 'der' }).subarray(-32);
}

function needSpendPub32(spendPub32) {
  const b = Buffer.from(spendPub32 || []);
  if (b.length !== 32) throw new Error('spend pub must be 32 bytes');
  return b;
}

export function paymentCodeAtIndex(viewKey, spendPub32, index = 0) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return null;
  const scanPriv = x25519PrivateFromSeed(scanSeedFromView(viewKey, n));
  const scanPub = x25519PublicRaw(scanPriv);
  return encodePaymentCode({ scanPub, spendPub: needSpendPub32(spendPub32) });
}

export function paymentCodeFromViewKey(viewKey, spendPub32) {
  return paymentCodeAtIndex(viewKey, spendPub32, 0);
}

/** 64-byte scan||spend opening. spendPub32 is the Ed25519 spend public key. */
export function destOpeningFromView(viewKey, spendPub32, index = 0) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return '';
  const spend = Buffer.from(spendPub32 || []);
  if (spend.length !== 32) return '';
  const scanPriv = x25519PrivateFromSeed(scanSeedFromView(viewKey, n));
  const scanPub = x25519PublicRaw(scanPriv);
  return Buffer.concat([Buffer.from(scanPub), spend]).toString('hex');
}

function asSpend(h) {
  const b = Buffer.from(h);
  if (b.length === 32) return b;
  return createHash('sha256').update(b).digest();
}

/** Hash mix for silent dest ECDH. Not a signing key. */
function spendMixAtIndex(spendHash20, index) {
  const idx = Buffer.alloc(8);
  idx.writeBigUInt64LE(BigInt(index));
  return createHash('sha256')
    .update(Buffer.from('shear-spend-v1'))
    .update(asSpend(spendHash20))
    .update(idx)
    .digest();
}

export function spendDestOf(spendPub) {
  const c = destCommitFromSpendPub(spendPub);
  return c ? encodeDest(c) : null;
}

/** dest20 = SHA256(shear-silent-v1 || oneTimeSpendPub)[0:20]. */
export function destMatchesSpendPub(dest, spendPub) {
  const want = hash20FromAddress(dest);
  const got = destCommitFromSpendPub(spendPub);
  if (!want || !got) return false;
  return Buffer.from(want).equals(got);
}

/** One-time dest from view-key scan/spend (she1 string no longer carries the 64-byte keys). */
export function silentDestFromView(viewKey, spendPub32, ephPrivate, index = 0) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return null;
  const scanPriv = x25519PrivateFromSeed(scanSeedFromView(viewKey, n));
  const shared = diffieHellman({ privateKey: ephPrivate, publicKey: createPublicKey(scanPriv) });
  const oneTime = stealthSpendPubFrom(needSpendPub32(spendPub32), shared);
  const commit = destCommitFromSpendPub(oneTime);
  return commit ? encodeDest(commit) : null;
}

export function silentSharedFromCode(fullCode, ephPrivate) {
  const parsed = decodePaymentCode(fullCode);
  if (!parsed?.scanPub || !parsed?.spendPub) return null;
  try {
    return diffieHellman({
      privateKey: ephPrivate,
      publicKey: x25519PublicFromRaw(parsed.scanPub),
    });
  } catch {
    return null;
  }
}

/** One-time dest from a published full payment code + sender ephemeral. Fingerprint-only fails closed. */
export function silentDestFromCode(fullCode, ephPrivate) {
  const parsed = decodePaymentCode(fullCode);
  if (!parsed?.scanPub || !parsed?.spendPub) return null;
  const shared = silentSharedFromCode(fullCode, ephPrivate);
  if (!shared) return null;
  const oneTime = stealthSpendPubFrom(parsed.spendPub, shared);
  const commit = destCommitFromSpendPub(oneTime);
  return commit ? encodeDest(commit) : null;
}

export function silentPay(fullCode, ephPrivate) {
  const dest = silentDestFromCode(fullCode, ephPrivate);
  if (!dest) return null;
  const shared = silentSharedFromCode(fullCode, ephPrivate);
  return {
    dest,
    shared,
    ephPub: x25519PublicRaw(ephPrivate),
  };
}

export function silentDestFromEphPub(fullCode, ephPubRaw, scanPriv) {
  const parsed = decodePaymentCode(fullCode);
  if (!parsed?.scanPub || !parsed?.spendPub) return null;
  try {
    const shared = diffieHellman({
      privateKey: scanPriv,
      publicKey: x25519PublicFromRaw(ephPubRaw),
    });
    const oneTime = stealthSpendPubFrom(parsed.spendPub, shared);
    const commit = destCommitFromSpendPub(oneTime);
    if (!commit) return null;
    return { dest: encodeDest(commit), shared };
  } catch {
    return null;
  }
}

/** Recipient: view key + incoming dest + eph pub. Never POST V/C/shear1. */
export function recognizeSilentDest({ viewKey, spendPub, dest, ephPub, maxIndex = 16 } = {}) {
  const want = String(dest || '');
  if (!want || !viewKey || !spendPub || !ephPub) return null;
  let ephKey;
  try {
    ephKey = x25519PublicFromRaw(ephPub);
  } catch {
    return null;
  }
  const spend = Buffer.from(spendPub);
  const max = Math.max(0, Math.floor(Number(maxIndex) || 0));
  for (let i = 0; i <= max; i += 1) {
    try {
      const scanPriv = x25519PrivateFromSeed(scanSeedFromView(viewKey, i));
      const shared = diffieHellman({ privateKey: scanPriv, publicKey: ephKey });
      const oneTime = stealthSpendPubFrom(spend, shared);
      const commit = destCommitFromSpendPub(oneTime);
      if (!commit) continue;
      const got = encodeDest(commit);
      if (got === want) return { dest: got, shared, index: i, spendPub: oneTime };
    } catch {
      continue;
    }
  }
  return null;
}

export function freshStealthDest(paymentCode) {
  const { privateKey } = generateKeyPairSync('x25519');
  return silentPay(paymentCode, privateKey);
}

export function ed25519PrivateFromSeed(seed32) {
  const seed = Buffer.from(seed32);
  if (seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function ed25519SeedOf(privateKey) {
  return privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
}

export function stealthSpendPrivate(shared, spendSeed32) {
  return stealthKey(shared, spendSeed32);
}

/**
 * Typed HRP on one address field. Empty allowed for burn/coinbase marker only.
 * HRP she → silent_id_on_chain. HRP shear → rest_frame_on_chain. On-chain dest is ssa.
 */
export function checkAddressField(addr, { allowEmpty = false } = {}) {
  const s = String(addr || '').trim();
  if (!s) return allowEmpty ? { ok: true } : { ok: false, reason: 'dest' };
  const hrp = bech32Hrp(s);
  if (hrp === 'she') return { ok: false, reason: 'silent_id_on_chain' };
  if (hrp === 'shear') return { ok: false, reason: 'rest_frame_on_chain' };
  if (hrp !== 'ssa' || !isDestAddress(s)) return { ok: false, reason: 'dest' };
  return { ok: true };
}

export function checkTxAddressFields(tx, { coinbase = false } = {}) {
  const kind = String(tx?.kind || '');
  const emptyOk = coinbase || kind === 'burn' || kind === 'levy' || kind === 'coinbase';
  const fields = [];
  const push = (a) => { if (a != null && a !== '') fields.push(a); };
  push(tx?.from);
  push(tx?.to);
  push(tx?.miner);
  push(tx?.payer);
  for (const v of tx?.vin || []) {
    push(v?.address);
    push(v?.miner);
  }
  for (const o of tx?.vout || []) {
    push(o?.address);
    push(o?.miner);
  }
  for (const s of tx?.samples || []) {
    push(s?.address);
    push(s?.miner);
    push(s?.dest);
  }
  for (const a of fields) {
    const r = checkAddressField(a, { allowEmpty: emptyOk && !String(a || '').trim() });
    if (!r.ok) return r;
  }
  return { ok: true };
}

export function resolvePayTo(paste, ephPrivate) {
  const s = String(paste || '').trim();
  if (isDestAddress(s)) return { dest: s, ephPub: null, shared: null };
  if (!ephPrivate) return null;
  return silentPay(s, ephPrivate);
}

export function newIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' });
  const hash = createHash('sha256').update(raw).digest().subarray(0, 20);
  const address = encodeAddress(hash);
  const spendPub = Buffer.from(raw.subarray(-32));
  const viewKey = createHash('sha256').update(Buffer.concat([
    Buffer.from('shear-view-v1'),
    privateKey.export({ type: 'pkcs8', format: 'der' }),
  ])).digest().toString('hex');
  const scanPriv = x25519PrivateFromSeed(scanSeedFromView(viewKey, 0));
  const scanPub = x25519PublicRaw(scanPriv);
  const paymentCode = encodePaymentCode({ scanPub, spendPub });
  const paymentFingerprint = encodePaymentFingerprint(scanPub, spendPub);
  return {
    address,
    viewKey,
    publicKey,
    privateKey,
    paymentCode,
    paymentFingerprint,
    spendPub,
    scanPub,
  };
}

export function signSpend(privateKey, msg) {
  return sign(null, Buffer.from(msg), privateKey);
}

export function verifySpend(publicKey, msg, sig) {
  return verify(null, Buffer.from(msg), publicKey, sig);
}

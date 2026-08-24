import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
} from 'node:crypto';

export const HRP = 'shear';
export const HRP_DEST = 'shp';
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

export function encodePaymentCode({ scanPub, spendPub }) {
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
  return bech32Hrp(t) === 'shp' && bech32BodyOk(t);
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
 * On-chain payout dest. shp1 pays as-is. she1 pays shp1 of the same
 * 20-byte payload so the silent ID never appears on chain. shear1 is not a dest.
 */
export function payoutDest(login) {
  const id = identityOfLogin(login);
  if (isDestAddress(id)) return id;
  const pay = decodePaymentCode(id);
  if (!pay) return null;
  return encodeDest(pay.hash20);
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
  if (!p || p.length !== 20) return null;
  return { hash20: Buffer.from(p) };
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

export function paymentCodeAtIndex(viewKey, spendHash20, index = 0) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return null;
  const scanPriv = x25519PrivateFromSeed(scanSeedFromView(viewKey, n));
  const scanPub = x25519PublicRaw(scanPriv);
  const spend = spendPubAtIndex(spendHash20, n);
  return encodePaymentCode({ scanPub, spendPub: spend });
}

export function paymentCodeFromViewKey(viewKey, spendHash20) {
  return paymentCodeAtIndex(viewKey, spendHash20, 0);
}

function asSpend(h) {
  const b = Buffer.from(h);
  if (b.length === 32) return b;
  if (b.length === 20) return createHash('sha256').update(b).digest();
  return createHash('sha256').update(b).digest();
}

function spendPubAtIndex(spendHash20, index) {
  const idx = Buffer.alloc(8);
  idx.writeBigUInt64LE(BigInt(index));
  return createHash('sha256')
    .update(Buffer.from('shear-spend-v1'))
    .update(asSpend(spendHash20))
    .update(idx)
    .digest();
}

/** One-time dest from view-key scan/spend (she1 string no longer carries the 64-byte keys). */
export function silentDestFromView(viewKey, spendHash20, ephPrivate, index = 0) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return null;
  const scanPriv = x25519PrivateFromSeed(scanSeedFromView(viewKey, n));
  const spend = spendPubAtIndex(spendHash20, n);
  const shared = diffieHellman({ privateKey: ephPrivate, publicKey: createPublicKey(scanPriv) });
  const tweak = createHash('sha256')
    .update(Buffer.from('shear-silent-v1'))
    .update(shared)
    .update(spend)
    .digest()
    .subarray(0, 20);
  return encodeDest(tweak);
}

/** @deprecated she1 is a 20-byte id; ECDH needs the view key. */
export function silentDestFromCode() {
  return null;
}

export function silentDestFromEphPub() {
  return null;
}

export function newIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' });
  const hash = createHash('sha256').update(raw).digest().subarray(0, 20);
  const address = encodeAddress(hash);
  const viewKey = createHash('sha256').update(Buffer.concat([
    Buffer.from('shear-view-v1'),
    privateKey.export({ type: 'pkcs8', format: 'der' }),
  ])).digest().toString('hex');
  const paymentCode = paymentCodeFromViewKey(viewKey, hash);
  return { address, viewKey, publicKey, privateKey, paymentCode };
}

export function signSpend(privateKey, msg) {
  return sign(null, Buffer.from(msg), privateKey);
}

export function verifySpend(publicKey, msg, sig) {
  return verify(null, Buffer.from(msg), publicKey, sig);
}

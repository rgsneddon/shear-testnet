import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';

export const HRP = 'shear';
export const HRP_DEST = 'she';

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

export function encodeHrp(hrp, pubkeyHash20) {
  const data = Buffer.from(pubkeyHash20);
  if (data.length !== 20) throw new Error('spend hash must be 20 bytes');
  const values = [0, ...convertBits([...data], 8, 5, true)];
  const checksum = polymod([...hrpExpand(hrp), ...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const ret = [...values];
  for (let i = 0; i < 6; i += 1) ret.push((checksum >> (5 * (5 - i))) & 31);
  return `${hrp}1${ret.map((v) => CHARSET[v]).join('')}`;
}

export function encodeAddress(pubkeyHash20) {
  return encodeHrp(HRP, pubkeyHash20);
}

export function encodeDest(pubkeyHash20) {
  return encodeHrp(HRP_DEST, pubkeyHash20);
}

export function isShearAddress(s) {
  return /^shear1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,80}$/i.test(String(s || '').trim());
}

export function isDestAddress(s) {
  return /^she1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,80}$/i.test(String(s || '').trim());
}

export function hash20FromAddress(address) {
  const raw = String(address || '').trim();
  const one = raw.lastIndexOf('1');
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
  if (!bytes || bytes.length < 20) return null;
  return Buffer.from(bytes).subarray(0, 20);
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
  return { address, viewKey, publicKey, privateKey };
}

export function signSpend(privateKey, msg) {
  return sign(null, Buffer.from(msg), privateKey);
}

export function verifySpend(publicKey, msg, sig) {
  return verify(null, Buffer.from(msg), publicKey, sig);
}

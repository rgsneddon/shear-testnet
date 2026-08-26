import { createHash } from 'node:crypto';

export const PERSONAL = 'ShearHash-v1';
export const ALGO = 'ShearHash';
export const HEADER_LEN = 120;
export const HASH_ROUNDS = 8;
export const CLIENT = 'ShearHash';

export function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

/** 8-round ShearHash over the 120-byte header. */
export function shearHash(header) {
  const h = Buffer.isBuffer(header) ? header : Buffer.from(header);
  if (h.length !== HEADER_LEN) {
    throw new Error(`header must be ${HEADER_LEN} bytes`);
  }
  const personal = Buffer.from(PERSONAL);
  const algo = Buffer.from(ALGO);
  let out = sha256(Buffer.concat([personal, algo, h]));
  for (let r = 0; r < HASH_ROUNDS; r += 1) {
    out = sha256(Buffer.concat([out, personal, Buffer.from([0x30 + r]), h]));
  }
  return out;
}

export function hashHex(buf) {
  return Buffer.from(buf).toString('hex');
}

export function leadingZeroBits(hash) {
  const h = Buffer.isBuffer(hash) ? hash : Buffer.from(hash);
  let n = 0;
  for (let i = 0; i < h.length; i += 1) {
    const v = h[i];
    if (v === 0) {
      n += 8;
      continue;
    }
    let b = v;
    let k = 0;
    while ((b & 0x80) === 0 && k < 8) {
      b <<= 1;
      k += 1;
    }
    return n + k;
  }
  return n;
}

export function meetsTarget(hash, bits) {
  const n = Math.max(0, Math.min(256, Number(bits) || 0));
  if (n <= 0) return true;
  const full = Math.floor(n / 8);
  const rem = n % 8;
  for (let i = 0; i < full; i += 1) {
    if (hash[i] !== 0) return false;
  }
  if (!rem) return true;
  return hash[full] < (1 << (8 - rem));
}

export function targetFromBits(bits) {
  const n = Math.max(0, Math.min(256, Number(bits) || 0));
  const t = Buffer.alloc(32);
  const full = Math.floor(n / 8);
  const rem = n % 8;
  for (let i = 0; i < full; i += 1) t[i] = 0;
  if (full < 32) {
    t[full] = rem ? (1 << (8 - rem)) - 1 : 0xff;
    for (let i = full + 1; i < 32; i += 1) t[i] = 0xff;
  }
  return t;
}

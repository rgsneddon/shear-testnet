import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERSONAL = 'ShearHash-v2';
export const ALGO = 'ShearHash';
export const HEADER_LEN = 128;
export const CLIENT = 'ShearHash';
export const RX_MODE = 'light';
export const V1_SELFTEST =
  '5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066';
export const V2_SELFTEST =
  '64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895';
export const V2_SELFTEST_K =
  'e46e00191cde74015961b7a68274933c680b69f05bdbbad1ef51e75fbc19f389';

const here = path.dirname(fileURLToPath(import.meta.url));
let native = null;
try {
  native = createRequire(import.meta.url)('./native/shearhash.node');
  if (native?.backend) native.backend('interpreter');
} catch {
  native = null;
}

function minerBin() {
  const p = path.join(here, '..', 'sheark-miner', process.platform === 'win32' ? 'ShearK-Miner.exe' : 'ShearK-Miner');
  return fs.existsSync(p) ? p : '';
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

/** v1 8-round SHA-256. Invalid under v2; used only to prove old shares miss. */
export function shearHashV1(header) {
  const h = Buffer.isBuffer(header) ? header : Buffer.from(header);
  if (h.length !== HEADER_LEN) throw new Error(`header must be ${HEADER_LEN} bytes`);
  const personal = Buffer.from('ShearHash-v1');
  const algo = Buffer.from(ALGO);
  let out = sha256(Buffer.concat([personal, algo, h]));
  for (let r = 0; r < 8; r += 1) {
    out = sha256(Buffer.concat([out, personal, Buffer.from([0x30 + r]), h]));
  }
  return out;
}

function hashViaMiner(header) {
  const bin = minerBin();
  if (!bin) throw new Error('ShearHash-v2 native addon missing and ShearK-Miner not built');
  const hex = Buffer.from(header).toString('hex');
  const got = spawnSync(bin, ['--backend', 'interpreter', '--verify', hex], { encoding: 'utf8' });
  if (got.status !== 0) throw new Error(got.stderr || got.stdout || 'verify failed');
  const m = /digest ([0-9a-f]{64})/.exec(got.stdout);
  if (!m) throw new Error('verify parse');
  return Buffer.from(m[1], 'hex');
}

/** ShearHash-v2: RandomX light interpreter. Not a JS VM. */
export function shearHash(header) {
  const h = Buffer.isBuffer(header) ? header : Buffer.from(header);
  if (h.length !== HEADER_LEN) {
    throw new Error(`header must be ${HEADER_LEN} bytes`);
  }
  if (native?.hash) return Buffer.from(native.hash(h));
  return hashViaMiner(h);
}

export function shearKey(header) {
  const h = Buffer.isBuffer(header) ? header : Buffer.from(header);
  if (h.length !== HEADER_LEN) throw new Error(`header must be ${HEADER_LEN} bytes`);
  if (native?.key) return Buffer.from(native.key(h));
  const bin = minerBin();
  if (!bin) throw new Error('shearKey: native missing');
  const hex = h.toString('hex');
  const got = spawnSync(bin, ['--backend', 'interpreter', '--verify', hex], { encoding: 'utf8' });
  const m = /k ([0-9a-f]{64})/.exec(got.stdout || '');
  if (!m) throw new Error('k parse');
  return Buffer.from(m[1], 'hex');
}

export function setHashBackend(name) {
  if (native?.backend) return native.backend(String(name || 'interpreter'));
  return 'interpreter';
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

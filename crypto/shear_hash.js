import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERSONAL = 'ShearHash-v3';
export const ALGO = 'ShearHash';
export const HEADER_LEN = 128;
export const CLIENT = 'ShearHash';
export const RX_MODE = 'light';
export const V1_SELFTEST =
  '5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066';
/** v2 light vector. Must miss under v3. */
export const V2_SELFTEST =
  '64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895';
export const V2_SELFTEST_K =
  'e46e00191cde74015961b7a68274933c680b69f05bdbbad1ef51e75fbc19f389';
export const V3_SELFTEST =
  '98818c31d739ef821db0242f76bd244b96f1fb5049d27ea9a192e95c67b39a8b';
export const V3_SELFTEST_K =
  '55111f0216ab10a6ba15fc0146990b10d26edcf58c86fa1418c41d96fa40b8e4';

const here = path.dirname(fileURLToPath(import.meta.url));
let native = null;
try {
  native = createRequire(import.meta.url)('./native/shearhash.node');
  if (native?.backend) native.backend('interpreter');
} catch (err) {
  native = null;
  try {
    console.error(JSON.stringify({
      event: 'shearhash_native',
      ok: false,
      reason: String(err?.message || err).slice(0, 160),
    }));
  } catch { /* ignore */ }
}

export function minerBin() {
  const names = process.platform === 'win32' ? 'ShearK-Miner.exe' : 'ShearK-Miner';
  const cands = [
    process.env.SHEARK_MINER,
    process.env.SHEAR_MINER,
    path.join(here, '..', 'sheark-miner', names),
  ];
  for (const p of cands) {
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, names);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch { /* skip */ }
  }
  return '';
}

export function hashBackendKind() {
  if (native?.hash) return 'native';
  if (minerBin()) return 'miner';
  return '';
}

/** Solo/pool must verify ShearHash-v3 before taking shares. */
export function assertHashBackend() {
  const kind = hashBackendKind();
  if (kind) return kind;
  throw new Error(
    'ShearHash-v3 native addon missing and ShearK-Miner not built. '
    + 'On Linux: cmake -S crypto/randomx -B crypto/randomx/build -DARCH=native '
    + '&& cmake --build crypto/randomx/build -j$(nproc) '
    + '&& make -C crypto/native shearhash.node. '
    + 'Or set SHEARK_MINER to a 2.5 ShearK-Miner binary.',
  );
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
  if (!bin) throw new Error('ShearHash-v3 native addon missing and ShearK-Miner not built');
  const hex = Buffer.from(header).toString('hex');
  const got = spawnSync(bin, ['--backend', 'interpreter', '--verify', hex], { encoding: 'utf8' });
  if (got.status !== 0) throw new Error(got.stderr || got.stdout || 'verify failed');
  const m = /digest ([0-9a-f]{64})/.exec(got.stdout);
  if (!m) throw new Error('verify parse');
  return Buffer.from(m[1], 'hex');
}

/** ShearHash-v3: RandomX light interpreter. Not a JS VM. */
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

function hashToBig(hash) {
  const h = Buffer.isBuffer(hash) ? hash : Buffer.from(hash);
  let n = 0n;
  for (const b of h) n = (n << 8n) | BigInt(b);
  return n;
}

function targetFromBitsFp(bitsFp) {
  const exp = 256 - Number(bitsFp);
  if (!Number.isFinite(exp) || exp >= 256) return (1n << 256n) - 1n;
  if (exp <= 0) return 1n;
  const i = Math.floor(exp);
  const f = exp - i;
  const num = BigInt(Math.round((2 ** f) * (2 ** 48)));
  return ((1n << BigInt(i)) * num) / (1n << 48n);
}

export function meetsTarget(hash, bits) {
  const n = Number(bits) || 0;
  if (n >= 65536) {
    return hashToBig(hash) < targetFromBitsFp(n / 65536);
  }
  const k = Math.max(0, Math.min(256, n));
  if (k <= 0) return true;
  const full = Math.floor(k / 8);
  const rem = k % 8;
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

/**
 * BluNotes (R28): private share payees and payouts.
 * Design: Desktop PR130-review/R28-private-share-payees-design.md (27 Oct),
 * Russell's rulings D1-D6.
 *
 * - A share names a one-time key (R, P), never an address. P = B + delta·G
 *   with delta = H(r·Y) = H(y·R), so only the scan key y finds it and only
 *   x_base + delta spends it. The rig holds (B, Y) and no secret.
 * - Nonce bits 8..55 must equal the first 48 bits of
 *   sha256(BIND_DST || job || R || P), job = the header with its nonce
 *   zeroed. A RandomX hash is over one nonce, so it pays one payee (H1).
 * - Work id = sha256(WORK_DST || the exact 128-byte header that was hashed).
 * - Each block draws `BLUNOTE_WINNERS` shares by weight from its own PoW
 *   hash. Every node pays them as implicit notes; no payee rows.
 */
import { createHash } from 'node:crypto';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { G, hashToScalar, randomScalar, scalarBytes, pointBytes, pointFrom, commit } from './note.js';
import { fs1Leaf } from './fs1_leaf.js';

const Fn = RistrettoPoint.Fn;

/** Winners per block (D3, provisional). */
export const BLUNOTE_WINNERS = 16;
/** Share frame bytes a block may carry (D6). Hex on the wire is twice this. */
export const SHARE_BYTES_MAX = 2 * 1024 * 1024;
/** Nonce bytes 113..118 (bits 8..55) carry the binding. Byte 112 is the rig counter, 119 the width. */
export const BIND_BITS = 48;
const BIND_MASK = (1n << BigInt(BIND_BITS)) - 1n;
const NONCE_OFFSET = 112;

const BIND_DST = Buffer.from('shear-blunote-bind-v1');
const WORK_DST = Buffer.from('shear-blunote-work-v1');
const DRAW_DST = Buffer.from('shear-blunote-draw-v1');
const SCAN_DST = Buffer.from('shear-blunote-scan-v1');
const DELTA_DST = Buffer.from('shear-blunote-delta-v1');
const TAG_DST = Buffer.from('shear-blunote-tag-v1');
const RHO_DST = Buffer.from('shear-blunote-rho-v1');
const REC_DST = Buffer.from('shear-blunote-record-v1');
const LEAF_DST = Buffer.from([0x00]);
const NODE_DST = Buffer.from([0x01]);

function sha256(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function buf32(v, what) {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v || []);
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
}

function header128(h) {
  const b = Buffer.isBuffer(h) ? h : Buffer.from(h || []);
  if (b.length !== 128) throw new Error('header must be 128 bytes');
  return b;
}

/** The header with its nonce zeroed: what a share's binding commits to. */
export function jobBytes(header) {
  const out = Buffer.from(header128(header));
  out.fill(0, NONCE_OFFSET, NONCE_OFFSET + 8);
  return out;
}

// ---- keys ----------------------------------------------------------------

/** Scan scalar y from the wallet's spend seed. Restore = shewall.bin + password rebuilds it. */
export function scanScalar(spendSeed) {
  return hashToScalar(SCAN_DST, Buffer.from(spendSeed));
}

export function scanPub(spendSeed) {
  return pointBytes(G.multiply(scanScalar(spendSeed)));
}

function deltaOf(shared) {
  return hashToScalar(DELTA_DST, pointBytes(shared));
}

function tagOf(shared) {
  return sha256(TAG_DST, pointBytes(shared))[0];
}

/**
 * A fresh one-time key for the mining address (B, Y). The rig needs only the
 * public keys. `r` is for tests; production draws it at random.
 */
export function oneTimeKey({ B, Y }, r = null) {
  const base = pointFrom(buf32(B, 'B'));
  const scan = pointFrom(buf32(Y, 'Y'));
  const er = r == null ? randomScalar() : r;
  const R = G.multiply(er);
  const shared = scan.multiply(er);
  const P = base.add(G.multiply(deltaOf(shared)));
  return { R: pointBytes(R), P: pointBytes(P), tag: tagOf(shared) };
}

/**
 * Owner side. delta when (R, P, tag) is this wallet's, else null.
 * The tag is checked first, so 255 of 256 strangers cost one ECDH.
 */
export function recogniseOneTime({ y, B }, R, P, tag = null) {
  let shared;
  try {
    shared = pointFrom(buf32(R, 'R')).multiply(y);
  } catch {
    return null;
  }
  if (tag != null && tagOf(shared) !== (Number(tag) & 0xff)) return null;
  const delta = deltaOf(shared);
  const want = pointFrom(buf32(B, 'B')).add(G.multiply(delta));
  if (!Buffer.from(pointBytes(want)).equals(buf32(P, 'P'))) return null;
  return delta;
}

/** Spend scalar of a recognised note: x_base + delta. */
export function oneTimeSpendScalar(xBase, delta) {
  return Fn.add(xBase, delta);
}

// ---- the binding (H1) ----------------------------------------------------

export function bindValue(header, R, P) {
  const d = sha256(BIND_DST, jobBytes(header), buf32(R, 'R'), buf32(P, 'P'));
  return d.readUIntLE(0, 6);
}

/** Nonce for (R, P) on this job: counter in bits 0..7, binding 8..55, width in 56..63. */
export function bindNonce(header, R, P, counter, bits) {
  const c = BigInt(Math.floor(Number(counter)) & 0xff);
  const b = BigInt(Math.floor(Number(bits)) & 0xff);
  return c | (BigInt(bindValue(header, R, P)) << 8n) | (b << 56n);
}

export function bindingOk(header, nonce, R, P) {
  let n;
  try { n = BigInt(nonce); } catch { return false; }
  if (n < 0n || n >= 1n << 64n) return false;
  try {
    return ((n >> 8n) & BIND_MASK) === BigInt(bindValue(header, R, P));
  } catch {
    return false;
  }
}

// ---- work id (H2-H4) -----------------------------------------------------

/** One RandomX evaluation: the exact proven header, nonce included. */
export function workId(provenHeader) {
  return sha256(WORK_DST, header128(provenHeader)).toString('hex');
}

// ---- the draw ------------------------------------------------------------

/**
 * Winners of one block. `weights` are BigInt share weights (2^b) in the
 * batch's canonical order. Returns [{ index, m }] sorted by index, where m
 * is how many of the k draws hit that share. Empty when the batch is empty.
 */
export function drawWinners(seed, weights, k = BLUNOTE_WINNERS) {
  const s = buf32(seed, 'seed');
  const n = weights.length;
  if (!n) return [];
  const prefix = new Array(n);
  let total = 0n;
  for (let i = 0; i < n; i += 1) {
    const w = BigInt(weights[i]);
    if (w <= 0n) throw new Error('weight must be positive');
    total += w;
    prefix[i] = total;
  }
  const hits = new Map();
  const t32 = Buffer.alloc(4);
  for (let t = 0; t < k; t += 1) {
    t32.writeUInt32LE(t, 0);
    const u = BigInt(`0x${sha256(DRAW_DST, s, t32).toString('hex')}`) % total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prefix[mid] > u) hi = mid;
      else lo = mid + 1;
    }
    hits.set(lo, (hits.get(lo) || 0) + 1);
  }
  return [...hits.entries()].sort((a, b) => a[0] - b[0]).map(([index, m]) => ({ index, m }));
}

/** Equal pieces of T: each winner gets m pieces, the remainder carries. */
export function drawPieces(total, k = BLUNOTE_WINNERS) {
  const T = BigInt(total);
  if (T < 0n) throw new Error('total must be >= 0');
  const piece = T / BigInt(k);
  return { piece, carry: T - piece * BigInt(k) };
}

// ---- implicit notes ------------------------------------------------------

/** Public blinding of a winner note. It opens a value that is already public. */
export function blunoteRho(P) {
  return hashToScalar(RHO_DST, buf32(P, 'P'));
}

/**
 * The note every node derives for a winner: admitPub P, value v, commitment
 * C = v·G + rho·H, and its FS-1 leaf. leaf is null when P is not a valid
 * point (the piece is then forfeit to carry; the caller decides).
 */
export function blunoteNote(P, v) {
  const Pb = buf32(P, 'P');
  let C;
  try {
    pointFrom(Pb);
    C = pointBytes(commit(BigInt(v), blunoteRho(Pb)));
  } catch {
    return null;
  }
  const leaf = fs1Leaf({ admitPub: Pb, commit: C });
  if (!leaf) return null;
  return { admitPub: Pb, commit: C, v: BigInt(v), leaf };
}

// ---- compact record ------------------------------------------------------

/** Merkle-sum root over (frame bytes, weight). Odd nodes carry up. Empty is 32 zero bytes. */
export function batchSumRoot(frames, weights) {
  if (frames.length !== weights.length) throw new Error('frames and weights differ');
  if (!frames.length) return { root: Buffer.alloc(32), total: 0n };
  const w8 = (w) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(w), 0);
    return b;
  };
  let level = frames.map((f, i) => ({ h: sha256(LEAF_DST, Buffer.from(f), w8(weights[i])), w: BigInt(weights[i]) }));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1];
      if (!b) { next.push(a); continue; }
      next.push({ h: sha256(NODE_DST, a.h, w8(a.w), b.h, w8(b.w)), w: a.w + b.w });
    }
    level = next;
  }
  return { root: level[0].h, total: level[0].w };
}

/**
 * The per-block record kept after the frames are pruned:
 * batchRoot 32 | n u32 | W u64 | T u64 | fee R 32 | fee P 32 | count u8 | count x (R 32 | P 32 | m u8).
 */
export function encodeRecord({ batchRoot, n, W, T, feeR, feeP, winners }) {
  const list = Array.isArray(winners) ? winners : [];
  if (list.length > 255) throw new Error('too many winners');
  const head = Buffer.alloc(32 + 4 + 8 + 8 + 64 + 1);
  buf32(batchRoot, 'batchRoot').copy(head, 0);
  head.writeUInt32LE(Number(n), 32);
  head.writeBigUInt64LE(BigInt(W), 36);
  head.writeBigUInt64LE(BigInt(T), 44);
  buf32(feeR, 'feeR').copy(head, 52);
  buf32(feeP, 'feeP').copy(head, 84);
  head.writeUInt8(list.length, 116);
  const rows = list.map((w) => {
    const r = Buffer.alloc(65);
    buf32(w.R, 'R').copy(r, 0);
    buf32(w.P, 'P').copy(r, 32);
    r.writeUInt8(Number(w.m), 64);
    return r;
  });
  return Buffer.concat([head, ...rows]);
}

export function decodeRecord(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 117) return null;
  const count = b.readUInt8(116);
  if (b.length !== 117 + count * 65) return null;
  const winners = [];
  for (let i = 0; i < count; i += 1) {
    const at = 117 + i * 65;
    winners.push({ R: b.subarray(at, at + 32), P: b.subarray(at + 32, at + 64), m: b.readUInt8(at + 64) });
  }
  return {
    batchRoot: b.subarray(0, 32),
    n: b.readUInt32LE(32),
    W: b.readBigUInt64LE(36),
    T: b.readBigUInt64LE(44),
    feeR: b.subarray(52, 84),
    feeP: b.subarray(84, 116),
    winners,
  };
}

export function recordRoot(bytes) {
  return sha256(REC_DST, Buffer.from(bytes));
}

export { scalarBytes };

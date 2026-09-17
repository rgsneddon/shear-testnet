/**
 * Lag-1 proven shareBatch. A hash is one ShearHash-v3 digest of the frozen
 * parent header (nonce replaced). Units are 2^SHARE_FLOOR_BITS, never a
 * client counter.
 *
 * Share difficulty binds hasher identity: the floor target is on
 * sha256("shear-share-dest-v1" || rx || noteCommit), not on rx alone.
 * A third-party pool cannot restamp dest/noteCommit on a stolen nonce.
 * Block POW stays ShearHash-v3 of the 128-byte header.
 */
import { createHash } from 'node:crypto';
import {
  SHARE_FLOOR_BITS,
  MAX_SHARES_PER_BLOCK,
  MAX_HASH_UNITS_PER_BLOCK,
  DEST_HRP,
  HASH_BONUS_NANOS,
} from './asert.js';
import { shearHash, meetsTarget, leadingZeroBits } from './shear_hash.js';
import { setNonce } from './header.js';
import { packShareV5, unpackShareBatch } from './pack.js';
import { isDestAddress, bech32Hrp, encodeDest, hash20FromAddress } from './address.js';
import { noteCommitOfDest20 } from './note.js';

export const SHARE_DEST_DST = Buffer.from('shear-share-dest-v1');

/** Dest-bound share digest. rx is ShearHash-v3(header with nonce). */
export function destBoundShareHash(rxHash, noteCommit) {
  const rx = Buffer.from(rxHash || []);
  const nc = Buffer.from(noteCommit || []);
  if (rx.length !== 32 || nc.length !== 32) return Buffer.alloc(32);
  return createHash('sha256').update(SHARE_DEST_DST).update(rx).update(nc).digest();
}

export function shareMeetsFloor(rxHash, share, floorBits = SHARE_FLOOR_BITS) {
  const nc = noteCommitOfShare(share);
  if (!nc || nc.length !== 32) return false;
  return meetsTarget(destBoundShareHash(rxHash, nc), floorBits);
}

export function unitsForShare(shareBits = SHARE_FLOOR_BITS) {
  const b = Math.max(SHARE_FLOOR_BITS, Math.floor(Number(shareBits) || 0));
  void b;
  return 2 ** SHARE_FLOOR_BITS;
}

function asBuf(v, n) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^[0-9a-fA-F]+$/.test(v) && v.length === n * 2) {
    return Buffer.from(v, 'hex');
  }
  try {
    const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
    if (b.length === n) return b;
  } catch { /* fall through */ }
  return null;
}

export function dest20OfShare(share) {
  const fromField = asBuf(share?.dest20, 20);
  if (fromField) return fromField;
  const addr = String(share?.dest || share?.address || share?.miner || '');
  const h = hash20FromAddress(addr);
  return h ? Buffer.from(h) : Buffer.alloc(20);
}

export function noteCommitOfShare(share) {
  const fromField = asBuf(share?.noteCommit, 32);
  if (fromField) return fromField;
  const d20 = dest20OfShare(share);
  if (!d20 || d20.equals(Buffer.alloc(20))) return Buffer.alloc(0);
  return noteCommitOfDest20(d20);
}

export function destOfShare(share) {
  const addr = String(share?.dest || share?.address || share?.miner || '');
  if (isDestAddress(addr) && bech32Hrp(addr) === DEST_HRP) return addr;
  const d20 = dest20OfShare(share);
  if (d20.equals(Buffer.alloc(20))) return '';
  return encodeDest(d20);
}

export function sortShares(shares = []) {
  return [...shares].sort((a, b) => {
    const da = noteCommitOfShare(a);
    const db = noteCommitOfShare(b);
    const c = da.compare(db);
    if (c !== 0) return c;
    const na = BigInt(a.nonce || 0);
    const nb = BigInt(b.nonce || 0);
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  });
}

export function collateShareUnits(shares = []) {
  const by = new Map();
  for (const s of unpackShareBatch(shares)) {
    const dest = destOfShare(s);
    if (!dest) continue;
    by.set(dest, (by.get(dest) || 0) + unitsForShare());
  }
  return by;
}

export function aLeavesFromShares(shares = []) {
  const by = new Map();
  for (const s of unpackShareBatch(shares)) {
    const nc = noteCommitOfShare(s);
    const key = nc.toString('hex');
    by.set(key, (by.get(key) || 0) + unitsForShare());
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([hex, count]) => ({ noteCommit: Buffer.from(hex, 'hex'), count }));
}

function asHeaderBuf(header) {
  if (Buffer.isBuffer(header)) return Buffer.from(header);
  if (header instanceof Uint8Array) return Buffer.from(header);
  const s = String(header || '');
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return Buffer.from(s, 'hex');
  return null;
}

function shareJobKey(header) {
  try {
    const buf = asHeaderBuf(header);
    if (!buf || buf.length !== 128) return '';
    return setNonce(buf, 0n).toString('hex').toLowerCase();
  } catch {
    return '';
  }
}

/** Process-local: floor shares the pool already hashed live. Not on the wire. */
const liveSharePow = new Set();

export function rememberLiveSharePow(parentHeader, nonce) {
  const job = shareJobKey(parentHeader);
  if (!job) return;
  liveSharePow.add(`${job}:${String(nonce)}`);
  if (liveSharePow.size > MAX_SHARES_PER_BLOCK * 8) liveSharePow.clear();
}

/**
 * Recompute ShearHash-v3 on the frozen parent job header.
 * Duplicate nonce = dup_share. Miss floor = share_pow. Dest must be ssa1.
 * Live pool shares already hashed off-thread skip a second RandomX on the
 * event loop (p2p / tests still hash).
 */
export function verifyShareBatch({
  parentHeader,
  shares = [],
  floorBits = SHARE_FLOOR_BITS,
  skipPow = false,
} = {}) {
  const list = sortShares(unpackShareBatch(shares));
  if (list.length > MAX_SHARES_PER_BLOCK) {
    return { ok: false, reason: 'share_cap' };
  }
  if (!list.length) {
    return { ok: true, shares: [], units: 0, byDest: new Map(), aLeaves: [] };
  }
  if (!parentHeader) return { ok: false, reason: 'parent_header' };
  const job = Buffer.from(parentHeader);
  const jobKey = shareJobKey(job);
  const seenNonce = new Set();
  const proven = [];
  for (const s of list) {
    const nonce = BigInt(s.nonce || 0);
    const nk = nonce.toString();
    if (seenNonce.has(nk)) return { ok: false, reason: 'dup_share' };
    seenNonce.add(nk);
    const dest = destOfShare(s);
    if (dest) {
      if (!isDestAddress(dest) || bech32Hrp(dest) !== DEST_HRP) {
        return { ok: false, reason: 'miner_addr' };
      }
    }
    let nc = noteCommitOfShare(s);
    if (nc && (Buffer.from(nc).length !== 32 || Buffer.from(nc).equals(Buffer.alloc(32)))) {
      nc = Buffer.alloc(0);
    }
    if (dest && nc && nc.length === 32) {
      const expect = noteCommitOfDest20(dest20OfShare({ ...s, dest }));
      if (!Buffer.from(nc).equals(expect)) return { ok: false, reason: 'hash_bonus' };
    }
    if (dest && (!nc || nc.length !== 32)) {
      nc = noteCommitOfDest20(dest20OfShare({ ...s, dest }));
    }
    const header = setNonce(job, nonce);
    const cached = skipPow || (jobKey && liveSharePow.has(`${jobKey}:${nk}`));
    let lz = Number(s.lz) & 0xff;
    if (!cached) {
      if (!nc || Buffer.from(nc).length !== 32) {
        return { ok: false, reason: 'miner_addr' };
      }
      const hash = shearHash(header);
      const bound = destBoundShareHash(hash, nc);
      if (!meetsTarget(bound, floorBits)) {
        return { ok: false, reason: 'share_pow' };
      }
      lz = leadingZeroBits(bound) & 0xff;
    }
    // Historical persist dropped dest/noteCommit and kept nonce+lz. POW still binds
    // the share; hasher identity is the sealed aLeaf. New rows keep noteCommit.
    proven.push({
      dest20: dest ? dest20OfShare({ ...s, dest }) : Buffer.alloc(20),
      dest: dest || '',
      noteCommit: nc && nc.length === 32 ? Buffer.from(nc) : Buffer.alloc(32),
      nonce,
      lz,
      units: unitsForShare(),
      bound: !!(nc && nc.length === 32),
    });
  }
  const units = proven.reduce((n, s) => n + s.units, 0);
  if (units > MAX_HASH_UNITS_PER_BLOCK) {
    return { ok: false, reason: 'hash_units' };
  }
  const bound = proven.filter((s) => s.bound);
  return {
    ok: true,
    shares: proven,
    units,
    byDest: collateShareUnits(bound),
    aLeaves: aLeavesFromShares(bound),
  };
}

export function findShare(header, {
  dest,
  dest20,
  floorBits = SHARE_FLOOR_BITS,
  maxTries = 1_000_000,
  startNonce = 0n,
} = {}) {
  const job = Buffer.from(header);
  const d20 = dest20 ? Buffer.from(dest20) : dest20OfShare({ dest });
  const addr = dest || encodeDest(d20);
  for (let n = BigInt(startNonce); n < BigInt(startNonce) + BigInt(maxTries); n += 1n) {
    const h = setNonce(job, n);
    const hash = shearHash(h);
    const share = {
      dest20: d20,
      dest: addr,
      nonce: n,
      lz: 0,
    };
    const nc = noteCommitOfShare(share);
    const bound = destBoundShareHash(hash, nc);
    if (meetsTarget(bound, floorBits)) {
      share.lz = leadingZeroBits(bound) & 0xff;
      return {
        ...share,
        noteCommit: nc,
        packed: packShareV5({
          noteCommit: nc,
          nonce: n,
          lz: share.lz,
        }),
        header: h,
        hash,
        bound,
      };
    }
  }
  return null;
}

export { HASH_BONUS_NANOS };

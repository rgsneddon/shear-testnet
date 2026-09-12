/**
 * Lag-1 proven shareBatch. A hash is one ShearHash-v3 digest of the frozen
 * parent header (nonce replaced). Units are 2^SHARE_FLOOR_BITS, never a
 * client counter.
 */
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

export function unitsForShare(shareBits = SHARE_FLOOR_BITS) {
  const b = Math.max(SHARE_FLOOR_BITS, Math.floor(Number(shareBits) || 0));
  void b;
  return 2 ** SHARE_FLOOR_BITS;
}

export function dest20OfShare(share) {
  if (share?.dest20 && Buffer.from(share.dest20).length === 20) {
    return Buffer.from(share.dest20);
  }
  const addr = String(share?.dest || share?.address || share?.miner || '');
  const h = hash20FromAddress(addr);
  return h ? Buffer.from(h) : Buffer.alloc(20);
}

export function noteCommitOfShare(share) {
  if (share?.noteCommit && Buffer.from(share.noteCommit).length === 32) {
    return Buffer.from(share.noteCommit);
  }
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

function shareJobKey(header) {
  try {
    const buf = Buffer.isBuffer(header) ? Buffer.from(header) : Buffer.from(String(header), 'hex');
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
    const nc = noteCommitOfShare(s);
    if (!nc || Buffer.from(nc).length !== 32 || Buffer.from(nc).equals(Buffer.alloc(32))) {
      return { ok: false, reason: 'miner_addr' };
    }
    if (dest) {
      const expect = noteCommitOfDest20(dest20OfShare({ ...s, dest }));
      if (!Buffer.from(nc).equals(expect)) return { ok: false, reason: 'hash_bonus' };
    }
    const header = setNonce(job, nonce);
    const cached = jobKey && liveSharePow.has(`${jobKey}:${nk}`);
    let lz = Number(s.lz) & 0xff;
    if (!cached) {
      const hash = shearHash(header);
      if (!meetsTarget(hash, floorBits)) {
        return { ok: false, reason: 'share_pow' };
      }
      lz = leadingZeroBits(hash) & 0xff;
    }
    proven.push({
      dest20: dest ? dest20OfShare({ ...s, dest }) : Buffer.alloc(20),
      dest: dest || '',
      noteCommit: Buffer.from(nc),
      nonce,
      lz,
      units: unitsForShare(),
    });
  }
  const units = proven.reduce((n, s) => n + s.units, 0);
  if (units > MAX_HASH_UNITS_PER_BLOCK) {
    return { ok: false, reason: 'hash_units' };
  }
  return {
    ok: true,
    shares: proven,
    units,
    byDest: collateShareUnits(proven),
    aLeaves: aLeavesFromShares(proven),
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
    if (meetsTarget(hash, floorBits)) {
      const share = {
        dest20: d20,
        dest: addr,
        nonce: n,
        lz: leadingZeroBits(hash) & 0xff,
      };
      return {
        ...share,
        noteCommit: noteCommitOfShare(share),
        packed: packShareV5({
          noteCommit: noteCommitOfShare(share),
          nonce: n,
          lz: leadingZeroBits(hash) & 0xff,
        }),
        header: h,
        hash,
      };
    }
  }
  return null;
}

export { HASH_BONUS_NANOS };

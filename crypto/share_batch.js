/**
 * Lag-1 proven shareBatch. A hash is one ShearHash-v3 digest of the frozen
 * parent header (nonce replaced). The credited width is the little-endian
 * high byte of that nonce (header offset 119). Units are 2^b when that byte
 * is b, the packed claim is b, and the dest-bound digest meets b.
 *
 * Share difficulty binds hasher identity: the target is on
 * sha256("shear-share-dest-v1" || rx || noteCommit), not on rx alone.
 * A third-party pool cannot restamp dest/noteCommit on a stolen nonce.
 * Block POW stays ShearHash-v3 of the child header. The share byte does not
 * constrain that header's nonce.
 */
import { createHash } from 'node:crypto';
import {
  SHARE_FLOOR_BITS,
  MAX_SHARES_PER_BLOCK,
  MAX_HASH_UNITS_PER_BLOCK,
  DEST_HRP,
  HASH_BONUS_NANOS,
  shareCreditMaxBits,
} from './asert.js';
import { shearHash, meetsTarget, leadingZeroBits } from './shear_hash.js';
import { hashHeaderOffLoop } from './hash_offloop.js';
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

/** Work units of one share. Floor when bits are omitted, below the floor, or not a number. */
export function unitsForShare(shareBits = SHARE_FLOOR_BITS) {
  const raw = Math.floor(Number(shareBits));
  const b = Math.max(SHARE_FLOOR_BITS, Number.isFinite(raw) ? raw : SHARE_FLOOR_BITS);
  // 2^53 is not an exact JS integer. Cap the unit; the block unit cap rejects it.
  if (b >= 53) return 2 ** 52;
  return 2 ** b;
}

/** Packed difficulty field. Absent or below the floor stays the floor. Not the credit law. */
export function shareWorkBits(share) {
  const raw = share?.creditedShareBits != null && share.creditedShareBits !== ''
    ? share.creditedShareBits
    : share?.shareBits;
  if (raw == null || raw === '') return SHARE_FLOOR_BITS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return SHARE_FLOOR_BITS;
  if (n > 52) return 52;
  return Math.max(SHARE_FLOOR_BITS, n);
}

/** LE high byte of the share nonce. Header byte 119. Low 56 bits are the search. */
export const SHARE_NONCE_TARGET_SHIFT = 56n;
const SHARE_NONCE_LOW_MASK = (1n << SHARE_NONCE_TARGET_SHIFT) - 1n;

export function shareTargetByte(nonce) {
  try {
    const n = BigInt(nonce);
    if (n < 0n) return -1;
    return Number((n >> SHARE_NONCE_TARGET_SHIFT) & 0xffn);
  } catch {
    return -1;
  }
}

/** Low 56 bits of `nonce`, with credited width `bits` in the high byte. */
export function nonceWithShareTarget(nonce, bits) {
  const low = BigInt(nonce ?? 0) & SHARE_NONCE_LOW_MASK;
  const b = BigInt(Math.floor(Number(bits)) & 0xff);
  return low | (b << SHARE_NONCE_TARGET_SHIFT);
}

function declaredShareBits(share) {
  const raw = share?.creditedShareBits != null && share.creditedShareBits !== ''
    ? share.creditedShareBits
    : share?.shareBits;
  if (raw == null || raw === '') return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Credit width from the nonce high byte.
 * strict: the packed claim must equal that byte (verify, supply).
 * A legal byte outside the packed field is still that byte when strict is false (select).
 * An illegal byte is never clamped up to the floor.
 */
export function creditBitsForShare(share, floor = SHARE_FLOOR_BITS, { strict = true } = {}) {
  const hi = shareTargetByte(share?.nonce);
  const maxB = shareCreditMaxBits();
  const floorN = Math.floor(Number(floor));
  const lo = Number.isFinite(floorN) ? Math.max(SHARE_FLOOR_BITS, floorN) : SHARE_FLOOR_BITS;
  if (!Number.isInteger(hi) || hi < lo || hi > maxB) {
    return { ok: false, reason: 'share_target', bits: hi };
  }
  const declared = declaredShareBits(share);
  const claim = declared == null ? lo : declared;
  if (strict && claim !== hi) return { ok: false, reason: 'share_target', bits: hi };
  return { ok: true, bits: hi, reason: '' };
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

function headerTie(share) {
  const slot = share?.proofSlot === 0 || share?.proofSlot === 1
    || share?.proofSlot === '0' || share?.proofSlot === '1'
    ? String(Number(share.proofSlot))
    : '';
  const raw = share?.verifiedHeader;
  let hex = '';
  if (Buffer.isBuffer(raw)) hex = raw.toString('hex');
  else if (typeof raw === 'string') hex = raw.toLowerCase();
  return `${slot}:${hex}`;
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
    const ha = headerTie(a);
    const hb = headerTie(b);
    if (ha < hb) return -1;
    if (ha > hb) return 1;
    return 0;
  });
}

/** Extra leading zeros above the floor. Equal floor shares tie; dest order does not decide. */
export function shareInclusionWeight(share) {
  const lz = Number(share?.lz) & 0xff;
  const extra = Math.max(0, lz - SHARE_FLOOR_BITS);
  return 2 ** Math.min(extra, 20);
}

/** Tie break for equal weight. Hash of the commit and nonce, not the address. */
export function shareInclusionTie(share) {
  const nc = noteCommitOfShare(share);
  const nonce = Buffer.alloc(8);
  try { nonce.writeBigUInt64LE(BigInt(share?.nonce || 0)); } catch { /* zero */ }
  return createHash('sha256').update(nc).update(nonce).digest();
}

/**
 * Keep at most `cap` shares. Under that count, every share stays. The unit
 * cap scales credit later; it does not drop a share. Over the count, each
 * noteCommit takes a turn in sorted order so one dest is not cleared to
 * make room for another. A block over the count still fails verify with
 * share_cap when the caller does not select first.
 */
export function selectBlockShares(shares = [], cap = MAX_SHARES_PER_BLOCK) {
  const list = sharesAtProvenBits(unpackShareBatch(shares));
  const limit = Math.max(0, Math.floor(Number(cap) || 0));
  if (list.length <= limit) return sortShares(list);
  const groups = new Map();
  for (const s of sortShares(list)) {
    const nc = noteCommitOfShare(s);
    const hex = nc && nc.length === 32 ? Buffer.from(nc).toString('hex') : '';
    const key = hex || `:${String(s.nonce)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const keys = [...groups.keys()].sort();
  const kept = [];
  let progressed = true;
  while (kept.length < limit && progressed) {
    progressed = false;
    for (const key of keys) {
      const bucket = groups.get(key);
      if (!bucket.length) continue;
      kept.push(bucket.shift());
      progressed = true;
      if (kept.length >= limit) break;
    }
  }
  return sortShares(kept);
}

/**
 * Credited units per noteCommit. Under the cap, every proven unit is kept.
 * Over the cap, each noteCommit keeps floor(submitted * cap / total).
 * Leftover units fill a zero credit first, then walk sorted noteCommit.
 * A dest that still has zero takes one unit from a dest that has more than
 * one, so accepted work is not dropped while another dest is paid.
 */
export function retainedUnitsByCommit(shares = [], cap = MAX_HASH_UNITS_PER_BLOCK) {
  const by = new Map();
  for (const s of unpackShareBatch(shares)) {
    const nc = noteCommitOfShare(s);
    if (!nc || nc.length !== 32 || nc.equals(Buffer.alloc(32))) continue;
    const hex = Buffer.from(nc).toString('hex');
    const credit = creditBitsForShare(s, SHARE_FLOOR_BITS, { strict: false });
    if (!credit.ok) continue;
    const units = BigInt(unitsForShare(credit.bits));
    by.set(hex, (by.get(hex) || 0n) + units);
  }
  const entries = [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const total = entries.reduce((n, [, u]) => n + u, 0n);
  const limit = BigInt(Math.max(0, Math.floor(Number(cap) || 0)));
  const out = new Map();
  if (total === 0n || limit <= 0n) return out;
  if (total <= limit) {
    for (const [hex, u] of entries) out.set(hex, Number(u));
    return out;
  }
  const floors = entries.map(([hex, u]) => ({ hex, base: (u * limit) / total }));
  let leftover = limit - floors.reduce((n, row) => n + row.base, 0n);
  for (const row of floors) {
    if (leftover <= 0n) break;
    if (row.base === 0n) {
      row.base += 1n;
      leftover -= 1n;
    }
  }
  let i = 0;
  while (leftover > 0n && floors.length) {
    floors[i % floors.length].base += 1n;
    leftover -= 1n;
    i += 1;
  }
  for (const row of floors) {
    if (row.base > 0n) continue;
    const donor = floors.find((other) => other.base > 1n);
    if (!donor) break;
    donor.base -= 1n;
    row.base += 1n;
  }
  for (const row of floors) if (row.base > 0n) out.set(row.hex, Number(row.base));
  return out;
}

export function collateShareUnits(shares = [], cap = MAX_HASH_UNITS_PER_BLOCK) {
  const retained = retainedUnitsByCommit(shares, cap);
  const by = new Map();
  const seen = new Set();
  for (const s of unpackShareBatch(shares)) {
    const dest = destOfShare(s);
    const nc = noteCommitOfShare(s);
    if (!dest || !nc || nc.length !== 32) continue;
    const hex = Buffer.from(nc).toString('hex');
    if (seen.has(hex)) continue;
    seen.add(hex);
    const units = retained.get(hex) || 0;
    if (units > 0) by.set(dest, (by.get(dest) || 0) + units);
  }
  return by;
}

export function aLeavesFromShares(shares = [], cap = MAX_HASH_UNITS_PER_BLOCK) {
  const retained = retainedUnitsByCommit(shares, cap);
  return [...retained.entries()]
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

/** One proven unit. The same nonce on two headers is two units. */
export function shareWorkKey(header, nonce) {
  const job = shareJobKey(header);
  if (!job) return '';
  try {
    return `${job}:${BigInt(nonce ?? 0).toString()}`;
  } catch {
    return '';
  }
}

/**
 * Work already sealed in the parent block, keyed by the header it proved on.
 * `provedOnHeader` is that block's parent, which is this block's grandparent
 * candidate. A row marked proofSlot 1 proved on the older header and does
 * not exclude a new unit on `provedOnHeader`. A missing slot excludes the
 * nonce on `provedOnHeader` so an unmarked parent share cannot be paid twice.
 */
export function paidWorkKeys(shares, provedOnHeader) {
  const out = new Set();
  const want = shareJobKey(provedOnHeader);
  if (!want) return out;
  let rows = [];
  try { rows = unpackShareBatch(shares || []); } catch {
    rows = Array.isArray(shares) ? shares : [];
  }
  for (const s of rows) {
    const slot = s?.proofSlot;
    const vh = shareJobKey(s?.verifiedHeader);
    if (vh && vh !== want) continue;
    if (slot === 1 || slot === '1') continue;
    if (vh === want || slot === 0 || slot === '0' || slot == null || slot === '') {
      const key = shareWorkKey(provedOnHeader, s?.nonce);
      if (key) out.add(key);
    }
  }
  return out;
}

/**
 * One sealing window. Expiring rows (prior header) fill the count cap first.
 * Fresh rows fill what remains. Fresh overflow is still eligible on the next
 * block. Expiring overflow is not. Rows on neither header are stale.
 */
export function splitDeferWindow(shares, parentHeader, priorHeader, cap = MAX_SHARES_PER_BLOCK) {
  const parentId = shareJobKey(parentHeader);
  const priorId = shareJobKey(priorHeader);
  const expiring = [];
  const fresh = [];
  const stale = [];
  const list = Array.isArray(shares) ? shares : [];
  for (const s of list) {
    const id = shareJobKey(s?.verifiedHeader);
    if (parentId && id === parentId) fresh.push(s);
    else if (priorId && id === priorId && id !== parentId) expiring.push(s);
    else stale.push(s);
  }
  const limit = Math.max(0, Math.floor(Number(cap) || 0));
  const keptExp = selectBlockShares(expiring, limit);
  const room = limit - keptExp.length;
  const keptFresh = room > 0 ? selectBlockShares(fresh, room) : [];
  const seal = sortShares(keptExp.concat(keptFresh));
  // selectBlockShares returns copies. Match the unit, not the object.
  const sealIds = new Set(seal.map((s) => shareWorkKey(s?.verifiedHeader, s?.nonce)).filter(Boolean));
  const spill = (rows) => sortShares(rows.filter((s) => {
    const key = shareWorkKey(s?.verifiedHeader, s?.nonce);
    return !key || !sealIds.has(key);
  }));
  return {
    seal,
    carry: spill(fresh),
    owe: spill(expiring),
    stale: sortShares(stale),
  };
}

/**
 * Process-local proofs for shares this process already hashed.
 * Keyed by job and nonce. The value binds noteCommit and the proven bit
 * width. A hit cannot be restamped onto another dest or a higher width.
 * Not on the wire. Peers do not see it.
 */
const liveSharePow = new Map();
/** Keys the pool still needs: open round and the template's lag-1 batch. */
const liveSharePins = new Set();
/** One entry per accepted share, eight blocks of the count cap. Not a wipe line. */
export const LIVE_SHARE_POW_BOUND = MAX_SHARES_PER_BLOCK * 8;
let liveShareEvictions = 0;
let liveShareWipes = 0;
let syncSharePowHashes = 0;
let preparedSharePowUses = 0;

export function sharePowCounters() {
  return { sync: syncSharePowHashes, prepared: preparedSharePowUses };
}

export function resetSharePowCounters() {
  syncSharePowHashes = 0;
  preparedSharePowUses = 0;
}

export function liveSharePowMetrics() {
  return {
    size: liveSharePow.size,
    bound: LIVE_SHARE_POW_BOUND,
    evictions: liveShareEvictions,
    wipes: liveShareWipes,
    pins: liveSharePins.size,
    overBound: Math.max(0, liveSharePow.size - LIVE_SHARE_POW_BOUND),
  };
}

/** Replace the pin set. An empty list pins nothing. Eviction will not drop these keys. */
export function pinLiveSharePow(keys) {
  liveSharePins.clear();
  for (const key of keys || []) {
    if (key) liveSharePins.add(String(key));
  }
  return liveSharePins.size;
}

/** Keep one more key pinned. Does not drop keys already pinned. */
export function pinOneLiveSharePow(key) {
  if (key) liveSharePins.add(String(key));
  return liveSharePins.size;
}

export function liveSharePowKey(parentHeader, nonce) {
  const job = shareJobKey(parentHeader);
  if (!job || nonce == null || nonce === '') return '';
  return `${job}:${String(nonce)}`;
}

export function hasLiveSharePow(parentHeader, nonce) {
  const key = liveSharePowKey(parentHeader, nonce);
  return !!key && liveSharePow.has(key);
}

function evictUnpinned(keepKey) {
  if (liveSharePow.size <= LIVE_SHARE_POW_BOUND) return 0;
  let n = 0;
  for (const key of liveSharePow.keys()) {
    if (liveSharePow.size <= LIVE_SHARE_POW_BOUND) break;
    if (key === keepKey || liveSharePins.has(key)) continue;
    liveSharePow.delete(key);
    liveShareEvictions += 1;
    n += 1;
  }
  return n;
}

/**
 * Digests ShearHash already computed off the accept thread for this process.
 * P2P stashes them, then the verifier still checks the floor. Not a skip,
 * and not a wire field.
 */
const preparedSharePow = new Map();

export function stashSharePow(header, hash) {
  const key = Buffer.from(header).toString('hex');
  preparedSharePow.set(key, Buffer.from(hash));
  return key;
}

export function takeSharePow(header) {
  const key = Buffer.from(header).toString('hex');
  const found = preparedSharePow.get(key);
  if (!found) return null;
  preparedSharePow.delete(key);
  return found;
}

export function dropSharePowKeys(keys) {
  for (const key of keys || []) preparedSharePow.delete(key);
}

export function clearLiveSharePow() {
  if (liveSharePow.size) liveShareWipes += 1;
  liveSharePow.clear();
}

/**
 * Record a share this process already proved. Incomplete proof records nothing.
 * A second proof cannot move the nonce to another noteCommit or a higher width.
 */
export function rememberLiveSharePow(parentHeader, nonce, proof) {
  const job = shareJobKey(parentHeader);
  if (!job || !proof) return false;
  const nc = asBuf(proof.noteCommit, 32);
  if (!nc || proof.shareBits == null || proof.shareBits === '') return false;
  const lz = Number(proof.lz);
  if (!Number.isFinite(lz)) return false;
  const hi = shareTargetByte(nonce);
  const raw = Math.floor(Number(proof.shareBits));
  const maxB = shareCreditMaxBits();
  if (!Number.isFinite(raw) || raw !== hi || hi < SHARE_FLOOR_BITS || hi > maxB) return false;
  const bits = hi;
  const key = `${job}:${String(nonce)}`;
  const hex = Buffer.from(nc).toString('hex');
  const prev = liveSharePow.get(key);
  if (prev) {
    if (prev.noteCommit !== hex || bits !== prev.bits) return false;
    return true;
  }
  liveSharePow.set(key, { noteCommit: hex, bits, lz: lz & 0xff });
  // Drop the oldest unpinned jobs. Never the key just stored, and never a pin.
  evictUnpinned(key);
  return liveSharePow.has(key);
}

/**
 * Re-hash lag-1 rows that lost their process-local proof.
 * RandomX runs off the accept thread. A miss is not a skipPow pass.
 * Rows that meet the nonce-byte target are cached again. The rest are failed.
 */
export async function reproveSharesOffLoop(parentHeader, shares = []) {
  const list = Array.isArray(shares) ? shares : [];
  const job = asHeaderBuf(parentHeader);
  // A missing parent is not a per-share failure. Callers must keep the batch.
  if (!job || job.length !== 128) {
    return { ok: false, reason: 'parent_header', failed: [], proved: 0 };
  }
  const cold = [];
  for (const s of list) {
    const own = asHeaderBuf(s?.verifiedHeader);
    const onPrior = (s?.proofSlot === 1 || s?.proofSlot === '1') && own && own.length === 128;
    if (onPrior) {
      if (hasLiveSharePow(own, s?.nonce)) continue;
    } else if (hasLiveSharePow(job, s?.nonce) || hasLiveSharePow(s?.verifiedHeader, s?.nonce)) {
      continue;
    }
    cold.push(s);
  }
  if (!cold.length) return { ok: true, reason: '', failed: [], proved: list.length };
  // Illegal rows fail closed before RandomX. A worker miss is not those rows.
  const failed = [];
  const hashable = [];
  for (const s of cold) {
    let header;
    try {
      const own = asHeaderBuf(s?.verifiedHeader);
      const base = (s?.proofSlot === 1 || s?.proofSlot === '1') && own && own.length === 128
        ? own
        : job;
      header = setNonce(base, BigInt(s?.nonce || 0));
    } catch {
      failed.push(s);
      continue;
    }
    const credit = creditBitsForShare(s, SHARE_FLOOR_BITS, { strict: true });
    const nc = noteCommitOfShare(s);
    if (!credit.ok || !nc || nc.length !== 32) {
      failed.push(s);
      continue;
    }
    hashable.push({ share: s, header, credit, nc });
  }
  let hashes = [];
  if (hashable.length) {
    try {
      hashes = await Promise.all(hashable.map((row) => hashHeaderOffLoop(row.header)));
    } catch (err) {
      return {
        ok: false,
        reason: 'worker',
        failed: [],
        proved: 0,
        error: String(err?.message || err),
      };
    }
  }
  let proved = list.length - cold.length;
  for (let i = 0; i < hashable.length; i += 1) {
    const { share: s, credit, nc } = hashable[i];
    const bound = destBoundShareHash(hashes[i], nc);
    if (!meetsTarget(bound, credit.bits)) {
      failed.push(s);
      continue;
    }
    const lz = leadingZeroBits(bound) & 0xff;
    const own = asHeaderBuf(s?.verifiedHeader);
    const base = (s?.proofSlot === 1 || s?.proofSlot === '1') && own && own.length === 128
      ? own
      : job;
    const remembered = rememberLiveSharePow(base, s.nonce, {
      noteCommit: nc,
      shareBits: credit.bits,
      lz,
    });
    if (!remembered) failed.push(s);
    else proved += 1;
  }
  return {
    ok: failed.length === 0,
    reason: failed.length ? 'share_pow' : '',
    failed,
    proved,
  };
}

function liveProofForShare(share) {
  if (!share?.verifiedHeader) return null;
  const buf = asHeaderBuf(share.verifiedHeader);
  if (!buf || buf.length !== 128) return null;
  const job = shareJobKey(buf);
  if (!job || share.nonce == null || share.nonce === '') return null;
  return liveSharePow.get(`${job}:${String(share.nonce)}`) || null;
}

/** Keep a share only at the nonce-byte width. A moved dest or a different cached width is dropped. */
function sharesAtProvenBits(list) {
  const out = [];
  for (const s of list) {
    const credit = creditBitsForShare(s, SHARE_FLOOR_BITS, { strict: false });
    if (!credit.ok) continue;
    const proof = liveProofForShare(s);
    if (proof) {
      const nc = noteCommitOfShare(s);
      const hex = nc && nc.length === 32 ? Buffer.from(nc).toString('hex') : '';
      if (!hex || hex !== proof.noteCommit || proof.bits !== credit.bits) continue;
    }
    out.push({ ...s, shareBits: credit.bits, creditedShareBits: credit.bits });
  }
  return out;
}

function headerWorkBuf(header) {
  const raw = asHeaderBuf(header);
  if (!raw || raw.length !== 128) return null;
  return raw;
}

function nonceKeySet(excludeNonces) {
  if (excludeNonces instanceof Set) return excludeNonces;
  const out = new Set();
  if (!excludeNonces) return out;
  for (const n of excludeNonces) {
    const raw = String(n ?? '');
    if (raw.includes(':')) {
      out.add(raw);
      continue;
    }
    try { out.add(BigInt(n).toString()); } catch { /* skip */ }
  }
  return out;
}

/** A bare nonce still blocks every header. A work key blocks that header only. */
function paidBlocks(paid, headerBuf, nk) {
  if (!paid || paid.size === 0) return false;
  if (paid.has(nk)) return true;
  const key = shareWorkKey(headerBuf, nk);
  return !!(key && paid.has(key));
}

/**
 * Proof of one share against one header. A cache hit that names another dest
 * or width is a contradiction and is not re-hashed. skipPow with no cache
 * entry and no prepared digest does not hash.
 */
function proveShareOn(headerBuf, { nonce, nk, nc, ncHex, claimedBits, skipPow, trustWork }) {
  const jobKey = shareJobKey(headerBuf);
  const cached = jobKey ? liveSharePow.get(`${jobKey}:${nk}`) : null;
  if (cached) {
    if (!ncHex || ncHex !== cached.noteCommit || claimedBits !== cached.bits) {
      return { ok: false, reason: 'share_pow', contradict: true };
    }
    return { ok: true, lz: Number(cached.lz) & 0xff };
  }
  let stamped;
  try { stamped = setNonce(Buffer.from(headerBuf), nonce); } catch {
    return { ok: false, reason: 'share_pow' };
  }
  const prepared = takeSharePow(stamped);
  if (prepared) preparedSharePowUses += 1;
  // Own-install keyed load only. The slot, width, dest, and work key
  // were already checked. A foreign load must not set this.
  if (!prepared && trustWork) return { ok: true, lz: 0, trusted: true };
  if (!prepared && skipPow) return { ok: false, reason: 'share_pow', cold: true };
  if (!nc || Buffer.from(nc).length !== 32) return { ok: false, reason: 'miner_addr' };
  if (!prepared) syncSharePowHashes += 1;
  const hash = prepared || shearHash(stamped);
  const bound = destBoundShareHash(hash, nc);
  if (!meetsTarget(bound, claimedBits)) return { ok: false, reason: 'share_pow' };
  return { ok: true, lz: leadingZeroBits(bound) & 0xff };
}

/**
 * Recompute ShearHash-v3 on the frozen parent job header.
 * A work row names its header with proofSlot. 0 is parentHeader. 1 is
 * priorHeader, the parent of that parent, for one step. A work row with no
 * slot is share_slot and is not tried on both headers. Identity is that
 * header plus the nonce. The same nonce on both headers is two units. The
 * same header and nonce twice is dup_share. excludeNonces may be bare
 * nonces or work keys. Verification does not write the slot back.
 * Credit is the nonce high byte. A packed claim that disagrees, or a byte
 * outside [floor, B_MAX], is share_target and is not hashed. A dest-bound
 * digest that misses that byte is share_pow. A cache hit at that exact dest
 * and width skips a second RandomX. skipPow does not credit a row that has
 * no such proof and no prepared digest. trustWork credits a row that already
 * passed the slot, width, dest, duplicate, and paid-work checks. It is the
 * own-install load shortcut. A foreign load leaves it false and hashes.
 */
export function verifyShareBatch({
  parentHeader,
  priorHeader = null,
  excludeNonces = null,
  shares = [],
  floorBits = SHARE_FLOOR_BITS,
  skipPow = false,
  trustWork = false,
} = {}) {
  const raw = Array.isArray(shares) ? shares : [];
  const linked = [];
  for (const src of raw) {
    const row = unpackShareBatch([src])[0];
    if (!row) continue;
    if (src && typeof src === 'object' && !Buffer.isBuffer(src)) row._src = src;
    linked.push(row);
  }
  const list = sortShares(linked);
  if (list.length > MAX_SHARES_PER_BLOCK) {
    return { ok: false, reason: 'share_cap' };
  }
  if (!list.length) {
    return { ok: true, shares: [], units: 0, byDest: new Map(), aLeaves: [] };
  }
  if (!parentHeader) return { ok: false, reason: 'parent_header' };
  const job = Buffer.from(parentHeader);
  const priorBuf = headerWorkBuf(priorHeader);
  const paid = nonceKeySet(excludeNonces);
  const seenWork = new Set();
  const proven = [];
  for (const s of list) {
    const nonce = BigInt(s.nonce || 0);
    const nk = nonce.toString();
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
    const credit = creditBitsForShare(s, floorBits, { strict: true });
    if (!credit.ok) return { ok: false, reason: credit.reason };
    const claimedBits = credit.bits;
    const ncHex = nc && nc.length === 32 ? Buffer.from(nc).toString('hex') : '';
    const ctx = { nonce, nk, nc, ncHex, claimedBits, skipPow, trustWork: !!trustWork };
    const wantSlot = s.proofSlot === 1 || s.proofSlot === '1'
      ? 1
      : (s.proofSlot === 0 || s.proofSlot === '0' ? 0 : null);
    const workRow = (s.shareBits != null && s.shareBits !== '')
      || (s.creditedShareBits != null && s.creditedShareBits !== '');
    if (workRow && wantSlot == null) return { ok: false, reason: 'share_slot' };
    const tries = [];
    if (wantSlot === 1) {
      if (priorBuf) tries.push([priorBuf, 1]);
    } else if (wantSlot === 0) {
      tries.push([job, 0]);
    } else if (!workRow) {
      tries.push([job, 0]);
      if (priorBuf) tries.push([priorBuf, 1]);
    }
    let chosen = null;
    let sawDup = false;
    let lastFail = { ok: false, reason: 'share_pow' };
    for (const [hdr, slot] of tries) {
      const key = shareWorkKey(hdr, nonce);
      if (!key) {
        lastFail = { ok: false, reason: 'share_pow' };
        continue;
      }
      if (seenWork.has(key)) {
        sawDup = true;
        continue;
      }
      if (paidBlocks(paid, hdr, nk)) {
        lastFail = { ok: false, reason: 'share_pow' };
        continue;
      }
      const attempt = proveShareOn(hdr, ctx);
      if (attempt.contradict) return { ok: false, reason: 'share_pow' };
      if (attempt.ok) {
        chosen = { attempt, key, slot };
        break;
      }
      lastFail = attempt;
    }
    if (!chosen) {
      if (sawDup) return { ok: false, reason: 'dup_share' };
      return { ok: false, reason: lastFail.reason || 'share_pow' };
    }
    seenWork.add(chosen.key);
    const lz = chosen.attempt.lz;
    // Historical persist dropped dest/noteCommit and kept nonce+lz. POW still binds
    // the share; hasher identity is the sealed aLeaf. New rows keep noteCommit.
    proven.push({
      dest20: dest ? dest20OfShare({ ...s, dest }) : Buffer.alloc(20),
      dest: dest || '',
      noteCommit: nc && nc.length === 32 ? Buffer.from(nc) : Buffer.alloc(32),
      nonce,
      lz,
      proofSlot: chosen.slot,
      shareBits: claimedBits,
      units: unitsForShare(claimedBits),
      bound: !!(nc && nc.length === 32),
    });
  }
  const bound = proven.filter((s) => s.bound);
  const unbound = proven.filter((s) => !s.bound).reduce((n, s) => n + s.units, 0);
  const room = Math.max(0, MAX_HASH_UNITS_PER_BLOCK - unbound);
  const retained = retainedUnitsByCommit(bound, room);
  let boundUnits = 0;
  for (const u of retained.values()) boundUnits += u;
  const units = boundUnits + unbound;
  if (units > MAX_HASH_UNITS_PER_BLOCK) {
    return { ok: false, reason: 'hash_units' };
  }
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
  const width = Math.floor(Number(floorBits));
  const bits = Number.isFinite(width) ? width : SHARE_FLOOR_BITS;
  let n = BigInt(startNonce) & SHARE_NONCE_LOW_MASK;
  const limit = n + BigInt(maxTries);
  for (; n < limit; n += 1n) {
    const stamped = nonceWithShareTarget(n, bits);
    const h = setNonce(job, stamped);
    const hash = shearHash(h);
    const share = {
      dest20: d20,
      dest: addr,
      nonce: stamped,
      lz: 0,
      shareBits: bits,
      creditedShareBits: bits,
    };
    const nc = noteCommitOfShare(share);
    const bound = destBoundShareHash(hash, nc);
    if (meetsTarget(bound, bits)) {
      share.lz = leadingZeroBits(bound) & 0xff;
      return {
        ...share,
        noteCommit: nc,
        packed: packShareV5({
          noteCommit: nc,
          nonce: stamped,
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

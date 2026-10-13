/**
 * Hash-bonus owed ledger. One rule for every producer.
 *
 * A block may mint at most MAX_HASH_UNITS_PER_BLOCK times the live unit.
 * HASH_OWED_DRAIN splits that budget. Parent rows at or above the dust
 * floor take HASH_OWED_DRAIN_NUM/HASH_OWED_DRAIN_DEN, oldest height then
 * noteCommit. Fresh credits take the rest, pro-rata, the same walk as
 * retainedUnitsByCommit. An unused parent slice spills to fresh, and an
 * unused fresh slice spills back to unpaid parent rows. Anything still
 * unpaid stays on that noteCommit. After every row at or above the dust
 * floor is handled,
 * spare budget pays parent rows still below the floor, oldest first, even
 * for one nano (HASH_OWED_SUBDUST_V1). A fresh credit below the floor is
 * not spent from that spare in the same settle.
 * HASH_OWED_CARRY_V1 has no public dust pot and no unattributed overflow.
 * The inline pack takes payable rows first, then sub-dust rows. That pack
 * is node state. The coinbase wire carries hashOwedRoot only
 * (HASH_OWED_WIRE=root-v1). Each block also seals this block's fresh
 * per-noteCommit credits (HASH_OWED_RECOVER=sealed-credits-v1). Replay
 * reads that record, not the prunable share batch, and only after this
 * chain's own tip buries the block by SAMPLE_PRUNE_CONFIRMATIONS. A
 * samplesPruned flag alone is not burial. The hash-bonus unit
 * is the one live at that height (HASH_OWED_UNIT_HISTORY=per-height).
 * hashAcceptedUnits is required and must match settlement
 * (HASH_ACCEPTED_UNITS=validated). Slot-1 expiring shares that missed a seat,
 * up to one batch of MAX_SHARES_PER_BLOCK, are hashSpill
 * (HASH_OWED_SPILL=witness-v1). Their full credit is owed at this height and
 * is not spent from this block's budget, so seated pay does not change. Owe
 * past that batch is lostWork. A row that is not slot 1 stays off the
 * template. A pool file is not an input. HASH_OWED_BUDGET_SCALE_V1 sets this block's
 * mint capacity to max(MAX_HASH_UNITS, k * lowerMedian) over the
 * fingerprinted window of sealed accepted units, and never below the floor.
 * Pot splits and the pool fee do not read this ledger. Amounts stay BigInt
 * so a value above 2^53 is not rounded.
 *
 * Share Commitment (018e, SHARE_COMMIT=timely-omit-v1) is not this ledger.
 * Timely is the open interval after the parent header time through this
 * block's header time. Prod is the sum of 2^b units on the due set.
 * CapUnits_prod is that sum capped at MAX_HASH_UNITS_PER_BLOCK. A timely
 * commit that fits the cap must be in shareBatch; omitting it is
 * share_commit. A parent carry that fits is fresh hash-bonus credit on
 * this block, paid beside shareBatch, not instead of it.
 */
import { createHash } from 'node:crypto';
import {
  HASH_BONUS_NANOS,
  HASH_OWED_MAX_ENTRIES,
  HASH_OWED_DRAIN_DEN,
  HASH_OWED_DRAIN_NUM,
  HASH_OWED_SCALE_K,
  HASH_OWED_SCALE_WINDOW,
  MAX_HASH_UNITS_PER_BLOCK,
  MAX_SHARES_PER_BLOCK,
  SAMPLE_PRUNE_CONFIRMATIONS,
  SHARE_FLOOR_BITS,
  hashBonusUnitNanos,
  hashOwedDustNanos,
} from './asert.js';
import { noteCommitOfDest20 } from './note.js';
import {
  creditBitsForShare,
  dest20OfShare,
  destOfShare,
  noteCommitOfShare,
  unitsForShare,
} from './share_batch.js';
import { packShareBatchBytes, unpackShareBatch, unpackShareBatchBytes } from './pack.js';
import { admitBaseFromAddress } from './address.js';

const MAX_U64 = (1n << 64n) - 1n;
const MAX_U32 = 0xffffffff;

function asBi(v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    return BigInt(v);
  }
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) {
    try {
      const n = BigInt(v);
      return n >= 0n ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

function buf32(v) {
  if (v == null || v === '') return null;
  let b;
  try {
    if (Buffer.isBuffer(v)) b = Buffer.from(v);
    else if (v instanceof Uint8Array) b = Buffer.from(v);
    else if (typeof v === 'string' && /^[0-9a-fA-F]+$/.test(v) && v.length === 64) b = Buffer.from(v, 'hex');
    else b = Buffer.from(v);
  } catch {
    return null;
  }
  return b.length === 32 ? b : null;
}

function buf20(v) {
  if (v == null || v === '') return null;
  let b;
  try {
    if (Buffer.isBuffer(v)) b = Buffer.from(v);
    else if (v instanceof Uint8Array) b = Buffer.from(v);
    else if (typeof v === 'string' && /^[0-9a-fA-F]+$/.test(v) && v.length === 40) b = Buffer.from(v, 'hex');
    else b = Buffer.from(v);
  } catch {
    return null;
  }
  return b.length === 20 ? b : null;
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n) >>> 0, 0);
  return b;
}

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

export function cmpNoteCommit(a, b) {
  return Buffer.compare(a, b);
}

function cmpOwed(a, b) {
  if (a.sinceHeight !== b.sinceHeight) return a.sinceHeight < b.sinceHeight ? -1 : 1;
  return cmpNoteCommit(a.noteCommit, b.noteCommit);
}

const ROOT_PREFIX = Buffer.from('hashowed-root-v1');
const CREDIT_PREFIX = Buffer.from('hashowed-credits-v1');
const CREDIT_MAGIC = Buffer.from('hcrd1');
const SPILL_MAGIC = Buffer.from('hspw1');
const SPILL_CREDIT_MAGIC = Buffer.from('hspc1');
const CREDIT_ROW = 32 + 20 + 32 + 8;

function rootBytes(v) {
  if (v == null || v === '') return null;
  if (Buffer.isBuffer(v) && v.length === 32) return Buffer.from(v);
  if (v instanceof Uint8Array && v.length === 32) return Buffer.from(v);
  if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  if (v && typeof v === 'object' && typeof v.$hex === 'string') return rootBytes(v.$hex);
  return null;
}

function hasOwedArrays(tx) {
  if (!tx || typeof tx !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(tx, 'hashOwed')
    || Object.prototype.hasOwnProperty.call(tx, 'hashOwedRest');
}

/**
 * Mint capacity in work units. Empty history and every median at or below
 * the floor stay at MAX_HASH_UNITS_PER_BLOCK. A bad sample fails closed.
 */
export function hashBudgetUnits(samples) {
  const src = Array.isArray(samples) ? samples : [];
  const start = Math.max(0, src.length - HASH_OWED_SCALE_WINDOW);
  const list = [];
  for (let i = start; i < src.length; i += 1) {
    const n = asBi(src[i]);
    if (n == null) return null;
    list.push(n);
  }
  const floor = BigInt(MAX_HASH_UNITS_PER_BLOCK);
  if (!list.length) return floor;
  const sorted = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted[Math.floor((sorted.length - 1) / 2)];
  const scaled = BigInt(HASH_OWED_SCALE_K) * mid;
  return scaled > floor ? scaled : floor;
}

export function hashBudgetNanos(samples, unit = HASH_BONUS_NANOS) {
  const units = hashBudgetUnits(samples);
  if (units == null) return null;
  return units * BigInt(hashBonusUnitNanos(unit));
}

/** Canonical root over cmpOwed order. The empty map has a root. */
export function hashOwedRoot(rows) {
  const ordered = [...(rows || [])].sort(cmpOwed);
  const parts = [ROOT_PREFIX];
  for (const row of ordered) {
    parts.push(Buffer.from(row.noteCommit));
    parts.push(Buffer.from(row.dest20));
    const base = row.admitBase && !emptyBase(row.admitBase) ? Buffer.from(row.admitBase) : Buffer.alloc(32);
    parts.push(base);
    parts.push(u64le(row.nanos));
    parts.push(u32le(row.sinceHeight));
  }
  return createHash('sha256').update(Buffer.concat(parts)).digest();
}

export function hashOwedRootAgrees(tx, rows) {
  if (hasOwedArrays(tx)) return false;
  if (tx == null) return !rows || rows.length === 0;
  const root = rootBytes(tx.hashOwedRoot);
  const expect = hashOwedRoot(rows || []);
  if (!root) return (rows || []).length === 0;
  return root.equals(expect);
}

function creditBase(row) {
  return row?.admitBase && !emptyBase(row.admitBase) ? Buffer.from(row.admitBase) : Buffer.alloc(32);
}

/** Canonical credit root. sinceHeight is not part of a fresh credit. */
export function hashCreditRoot(rows) {
  const ordered = [...(rows || [])].sort((a, b) => cmpNoteCommit(a.noteCommit, b.noteCommit));
  const parts = [CREDIT_PREFIX];
  for (const row of ordered) {
    parts.push(Buffer.from(row.noteCommit));
    parts.push(Buffer.from(row.dest20));
    parts.push(creditBase(row));
    parts.push(u64le(row.nanos));
  }
  return createHash('sha256').update(Buffer.concat(parts)).digest();
}

function creditRowBytes(row) {
  const out = Buffer.alloc(CREDIT_ROW);
  Buffer.from(row.noteCommit).copy(out, 0);
  Buffer.from(row.dest20).copy(out, 32);
  creditBase(row).copy(out, 52);
  u64le(row.nanos).copy(out, 84);
  return out;
}

/** Non-prunable body of this block's fresh credits. The empty record is real. */
export function packHashCreditBytes(rows) {
  const ordered = [...(rows || [])].sort((a, b) => cmpNoteCommit(a.noteCommit, b.noteCommit));
  const body = Buffer.alloc(CREDIT_MAGIC.length + 4 + ordered.length * CREDIT_ROW);
  CREDIT_MAGIC.copy(body, 0);
  body.writeUInt32LE(ordered.length, CREDIT_MAGIC.length);
  let o = CREDIT_MAGIC.length + 4;
  for (const row of ordered) {
    creditRowBytes(row).copy(body, o);
    o += CREDIT_ROW;
  }
  return body;
}

export function unpackHashCreditBytes(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < CREDIT_MAGIC.length + 4) return null;
  if (!b.subarray(0, CREDIT_MAGIC.length).equals(CREDIT_MAGIC)) return null;
  const n = b.readUInt32LE(CREDIT_MAGIC.length);
  if (b.length !== CREDIT_MAGIC.length + 4 + n * CREDIT_ROW) return null;
  const rows = [];
  let o = CREDIT_MAGIC.length + 4;
  let prev = null;
  for (let i = 0; i < n; i += 1) {
    const noteCommit = Buffer.from(b.subarray(o, o + 32));
    const dest20 = Buffer.from(b.subarray(o + 32, o + 52));
    const admit = Buffer.from(b.subarray(o + 52, o + 84));
    const nanos = b.readBigUInt64LE(o + 84);
    o += CREDIT_ROW;
    if (prev && cmpNoteCommit(prev, noteCommit) >= 0) return null;
    prev = noteCommit;
    let expect;
    try { expect = noteCommitOfDest20(dest20); } catch { return null; }
    if (!expect.equals(noteCommit) || nanos <= 0n) return null;
    rows.push({
      noteCommit,
      dest20,
      nanos,
      sinceHeight: 0,
      admitBase: emptyBase(admit) ? null : admit,
      address: '',
    });
  }
  return rows;
}

/** Share bodies of a window-spill witness. Empty input is an empty pack. */
export function packSpillBytes(shares) {
  return Buffer.concat([SPILL_MAGIC, packShareBatchBytes(shares || [])]);
}

export function unpackSpillBytes(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < SPILL_MAGIC.length) return null;
  if (!b.subarray(0, SPILL_MAGIC.length).equals(SPILL_MAGIC)) return null;
  try {
    const rows = unpackShareBatchBytes(b.subarray(SPILL_MAGIC.length));
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/** Credit rows for a spill witness after the share bodies are pruned. */
export function packSpillCreditBytes(rows) {
  return Buffer.concat([SPILL_CREDIT_MAGIC, packHashCreditBytes(rows || [])]);
}

export function unpackSpillCreditBytes(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < SPILL_CREDIT_MAGIC.length) return null;
  if (!b.subarray(0, SPILL_CREDIT_MAGIC.length).equals(SPILL_CREDIT_MAGIC)) return null;
  return unpackHashCreditBytes(b.subarray(SPILL_CREDIT_MAGIC.length));
}

function parseCreditList(raw) {
  if (raw == null) return null;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return unpackHashCreditBytes(raw);
  if (typeof raw === 'string' && /^[0-9a-fA-F]+$/.test(raw)) {
    try { return unpackHashCreditBytes(Buffer.from(raw, 'hex')); } catch { return null; }
  }
  if (!Array.isArray(raw)) return null;
  const rows = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const noteCommit = buf32(item.noteCommit);
    const dest20 = buf20(item.dest20);
    const nanos = asBi(item.nanos);
    if (!noteCommit || !dest20 || nanos == null || nanos <= 0n || nanos > MAX_U64) return null;
    let expect;
    try { expect = noteCommitOfDest20(dest20); } catch { return null; }
    if (!expect.equals(noteCommit)) return null;
    const hex = noteCommit.toString('hex');
    if (seen.has(hex)) return null;
    seen.add(hex);
    let admitBase = null;
    if (item.admitBase != null && item.admitBase !== '') {
      const base = buf32(item.admitBase);
      if (!base || emptyBase(base)) return null;
      admitBase = base;
    }
    rows.push({
      noteCommit,
      dest20,
      nanos,
      sinceHeight: 0,
      admitBase,
      address: typeof item.address === 'string' ? item.address : '',
    });
  }
  return rows;
}

export function creditsEqual(a, b) {
  const left = parseCreditList(a);
  const right = parseCreditList(b);
  if (left == null || right == null || left.length !== right.length) return false;
  const as = [...left].sort((x, y) => cmpNoteCommit(x.noteCommit, y.noteCommit));
  const bs = [...right].sort((x, y) => cmpNoteCommit(x.noteCommit, y.noteCommit));
  for (let i = 0; i < as.length; i += 1) {
    if (as[i].nanos !== bs[i].nanos) return false;
    if (!as[i].noteCommit.equals(bs[i].noteCommit) || !as[i].dest20.equals(bs[i].dest20)) return false;
    if (!creditBase(as[i]).equals(creditBase(bs[i]))) return false;
  }
  return true;
}

/**
 * Dest the share itself still carries. The packed share frame keeps
 * noteCommit and bits, not the address, so a missing dest is not a zero dest.
 */
function explicitDest20(share) {
  const field = buf20(share?.dest20);
  const addr = String(share?.dest || share?.address || share?.miner || '');
  let fromAddr = null;
  if (addr) {
    const derived = dest20OfShare({ dest: addr });
    if (derived && !derived.equals(Buffer.alloc(20))) fromAddr = Buffer.from(derived);
  }
  const fieldReal = field && !field.equals(Buffer.alloc(20)) ? field : null;
  if (fieldReal && fromAddr && !fieldReal.equals(fromAddr)) return { ok: false, dest20: null };
  return { ok: true, dest20: fieldReal || fromAddr };
}

/**
 * Share batches witness noteCommit and nanos. Dest and admit base live in
 * the sealed credit record, which the coinbase credit root binds.
 */
function shareWitnessAgrees(shares, recorded, unit) {
  const u = BigInt(hashBonusUnitNanos(unit));
  if (u <= 0n) return false;
  let list = [];
  try {
    list = unpackShareBatch(shares || []);
  } catch {
    return false;
  }
  const by = new Map();
  for (const share of list) {
    const credit = creditBitsForShare(share, SHARE_FLOOR_BITS, { strict: true });
    if (!credit.ok) continue;
    const nc = noteCommitOfShare(share);
    if (!nc || nc.length !== 32 || nc.equals(Buffer.alloc(32))) return false;
    const carried = explicitDest20(share);
    if (!carried.ok) return false;
    if (carried.dest20) {
      let expect;
      try { expect = noteCommitOfDest20(carried.dest20); } catch { return false; }
      if (!expect.equals(Buffer.from(nc))) return false;
    }
    const hex = Buffer.from(nc).toString('hex');
    const nanos = BigInt(unitsForShare(credit.bits)) * u;
    const prev = by.get(hex);
    if (!prev) {
      by.set(hex, { nanos, dest20: carried.dest20 });
    } else {
      prev.nanos += nanos;
      if (carried.dest20) {
        if (prev.dest20 && !prev.dest20.equals(carried.dest20)) return false;
        prev.dest20 = carried.dest20;
      }
    }
  }
  if (by.size !== recorded.length) return false;
  for (const row of recorded) {
    const got = by.get(row.noteCommit.toString('hex'));
    if (!got || got.nanos !== row.nanos) return false;
    if (got.dest20 && !got.dest20.equals(row.dest20)) return false;
    by.delete(row.noteCommit.toString('hex'));
  }
  return by.size === 0;
}

function coinbaseTx(block) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  return txs.find((tx) => tx && tx.coinbase) || txs[0] || null;
}

/**
 * Same burial as flowSkipAllowed: SAMPLE_PRUNE_CONFIRMATIONS under the
 * caller's own tip, and the block is marked pruned. A peer flag is not enough.
 */
export function sealedCreditsBuried(block, tipHeight) {
  const tip = Number(tipHeight);
  const h = Number(block?.height);
  if (!Number.isFinite(tip) || !Number.isFinite(h)) return false;
  if (block?.samplesPruned !== true) return false;
  return Math.max(0, tip - h) >= SAMPLE_PRUNE_CONFIRMATIONS;
}

/**
 * Fresh credits for one block. A share batch that is still present must
 * match the sealed record on noteCommit and nanos. The packed frame does
 * not carry dest, so dest is the sealed row, bound by the coinbase credit
 * root. An empty batch is not a source unless this tip buries the block.
 * A missing record on an unpruned block is the share batch itself.
 * `tipHeight` is the caller's accepted tip, never a peer advertisement.
 */
export function freshForBlock(block, unit = HASH_BONUS_NANOS, tipHeight = null) {
  let shares = [];
  try {
    shares = unpackShareBatch(block?.shareBatch || []);
  } catch {
    return { ok: false, fresh: [] };
  }
  const fromShares = freshCreditsFromShares(shares, unit);
  const payRows = commitPayOfBlock(block);
  if (payRows == null) return { ok: false, fresh: [] };
  const expect = mergeCreditRows(fromShares, payRows);
  if (expect == null) return { ok: false, fresh: [] };
  const hasField = block != null && Object.prototype.hasOwnProperty.call(block, 'hashCredits');
  if (!hasField) {
    if (payRows.length === 0) {
      if (block?.samplesPruned === true && shares.length === 0) return { ok: false, fresh: [] };
      return { ok: true, fresh: fromShares };
    }
    if (block?.samplesPruned === true && shares.length === 0 && !sealedCreditsBuried(block, tipHeight)) {
      return { ok: false, fresh: [] };
    }
    return { ok: true, fresh: expect };
  }
  const recorded = parseCreditList(block.hashCredits);
  if (recorded == null) return { ok: false, fresh: [] };
  const root = rootBytes(coinbaseTx(block)?.hashCreditRoot);
  if (recorded.length && !root) return { ok: false, fresh: [] };
  if (root && !root.equals(hashCreditRoot(recorded))) return { ok: false, fresh: [] };
  if (payRows.length === 0) {
    if (shares.length) {
      if (!shareWitnessAgrees(shares, recorded, unit)) return { ok: false, fresh: [] };
      if (fromShares.length && !creditsEqual(recorded, fromShares)) return { ok: false, fresh: [] };
    } else if (recorded.length && !sealedCreditsBuried(block, tipHeight)) {
      return { ok: false, fresh: [] };
    }
    return { ok: true, fresh: recorded };
  }
  if (!creditsEqual(recorded, expect)) return { ok: false, fresh: [] };
  if (shares.length) {
    if (!shareWitnessAgrees(shares, fromShares, unit)) return { ok: false, fresh: [] };
  } else if (expect.length && !sealedCreditsBuried(block, tipHeight)) {
    return { ok: false, fresh: [] };
  }
  return { ok: true, fresh: recorded };
}

/**
 * Window-spill credits. Share bodies witness noteCommit and nanos. The packed
 * frame does not carry dest, so dest is the sealed credit record. An empty
 * body is not a source unless this tip has buried the block. A pool file is
 * not read here.
 */
export function spillForBlock(block, unit = HASH_BONUS_NANOS, tipHeight = null) {
  let shares = [];
  try {
    shares = unpackShareBatch(block?.hashSpill || []);
  } catch {
    return { ok: false, fresh: [] };
  }
  const fromShares = freshCreditsFromShares(shares, unit);
  const hasField = block != null && Object.prototype.hasOwnProperty.call(block, 'hashSpillCredits');
  if (!hasField) return { ok: true, fresh: fromShares };
  const recorded = parseCreditList(block.hashSpillCredits);
  if (recorded == null) return { ok: false, fresh: [] };
  if (shares.length) {
    if (!shareWitnessAgrees(shares, recorded, unit)) return { ok: false, fresh: [] };
    if (fromShares.length && !creditsEqual(recorded, fromShares)) return { ok: false, fresh: [] };
  } else if (recorded.length && !sealedCreditsBuried(block, tipHeight)) {
    return { ok: false, fresh: [] };
  }
  return { ok: true, fresh: recorded };
}

function emptyBase(buf) {
  return !buf || buf.length !== 32 || buf.equals(Buffer.alloc(32));
}

/**
 * Full credited nanos per noteCommit. Illegal bytes add nothing.
 * This is 2^b, not the retained pro-rata share of the cap.
 */
export function freshCreditsFromShares(shares, unit = HASH_BONUS_NANOS) {
  const u = BigInt(hashBonusUnitNanos(unit));
  const by = new Map();
  let list = [];
  try {
    list = unpackShareBatch(shares || []);
  } catch {
    list = [];
  }
  for (const s of list) {
    const credit = creditBitsForShare(s, SHARE_FLOOR_BITS, { strict: true });
    if (!credit.ok) continue;
    let nc;
    let dest20;
    try {
      nc = noteCommitOfShare(s);
      dest20 = dest20OfShare(s);
    } catch {
      continue;
    }
    if (!nc || !dest20 || nc.length !== 32 || dest20.length !== 20) continue;
    if (nc.equals(Buffer.alloc(32))) continue;
    let expect;
    try {
      expect = noteCommitOfDest20(dest20);
    } catch {
      continue;
    }
    if (!Buffer.from(nc).equals(expect)) continue;
    const hex = Buffer.from(nc).toString('hex');
    const nanos = BigInt(unitsForShare(credit.bits)) * u;
    const addr = destOfShare(s) || '';
    let base = null;
    try {
      const raw = addr ? admitBaseFromAddress(addr) : null;
      if (raw && Buffer.from(raw).length === 32) base = Buffer.from(raw);
    } catch {
      base = null;
    }
    const prev = by.get(hex);
    if (!prev) {
      by.set(hex, {
        noteCommit: Buffer.from(nc),
        dest20: Buffer.from(dest20),
        nanos,
        admitBase: base,
        address: addr,
        sinceHeight: 0,
      });
    } else {
      prev.nanos += nanos;
      if (!prev.admitBase && base) prev.admitBase = base;
      if (!prev.address && addr) prev.address = addr;
    }
  }
  return [...by.values()];
}

function parseRow(row) {
  if (!row || typeof row !== 'object') return null;
  const noteCommit = buf32(row.noteCommit);
  const dest20 = buf20(row.dest20);
  const nanos = asBi(row.nanos);
  const since = asBi(row.sinceHeight);
  if (!noteCommit || !dest20 || nanos == null || since == null) return null;
  if (nanos <= 0n || nanos > MAX_U64 || since > BigInt(MAX_U32)) return null;
  let expect;
  try {
    expect = noteCommitOfDest20(dest20);
  } catch {
    return null;
  }
  if (!expect.equals(noteCommit)) return null;
  let admitBase = null;
  if (row.admitBase != null && row.admitBase !== '') {
    const base = buf32(row.admitBase);
    if (!base || emptyBase(base)) return null;
    admitBase = base;
  }
  return {
    noteCommit,
    dest20,
    nanos,
    sinceHeight: Number(since),
    admitBase,
    address: typeof row.address === 'string' ? row.address : '',
  };
}

function parseLedgerRows(raw) {
  if (raw == null || raw === '') return [];
  if (!Array.isArray(raw)) return null;
  const rows = [];
  for (const item of raw) {
    const row = parseRow(item);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

/**
 * Rows for a coinbase this process still holds, or [] when the root is the
 * empty map. A non-empty root without rows is node state, not this tx.
 * Wire arrays are rejected. Payable-first local rows do not have to be in
 * cmpOwed order; the root is. The dust argument is the payable floor for
 * callers. It does not drop a row.
 */
export function hashOwedFromTx(tx, dust = hashOwedDustNanos()) {
  if (tx == null) return [];
  const floor = typeof dust === 'bigint' ? dust : asBi(dust);
  if (floor == null || floor <= 0n) return null;
  const dustPot = hashDustFromTx(tx);
  const overPot = hashOverflowFromTx(tx);
  if (dustPot == null || overPot == null || dustPot !== 0n || overPot !== 0n) return null;
  if (hasOwedArrays(tx)) return null;
  if (tx.hashOwedLocal != null) {
    const rows = parseLedgerRows(tx.hashOwedLocal);
    if (rows == null) return null;
    const root = rootBytes(tx.hashOwedRoot);
    if (root && !root.equals(hashOwedRoot(rows))) return null;
    return rows;
  }
  const root = rootBytes(tx.hashOwedRoot);
  if (!root || root.equals(hashOwedRoot([]))) return [];
  return null;
}

export function settledOwedRows(settled) {
  return [...(settled?.owed || []), ...(settled?.owedRest || [])];
}

function parsePot(v) {
  if (v == null || v === '') return 0n;
  const n = asBi(v);
  if (n == null || n > MAX_U64) return null;
  return n;
}

export function hashDustFromTx(tx) {
  if (tx == null) return 0n;
  return parsePot(tx.hashDustNanos);
}

export function hashOverflowFromTx(tx) {
  if (tx == null) return 0n;
  return parsePot(tx.hashOwedOverflowNanos);
}

export function writeHashLedger(tx, settled) {
  if (!tx || !settled) return tx;
  const rows = settledOwedRows(settled).map((row) => copyRow(row, row.nanos, row.sinceHeight));
  tx.hashOwedLocal = rows;
  tx.hashOwedRoot = hashOwedRoot(rows);
  tx.hashCreditRoot = hashCreditRoot(settled.fresh || []);
  tx.hashBonusUnit = hashBonusUnitNanos(settled.unit == null ? HASH_BONUS_NANOS : settled.unit);
  if (settled.acceptedUnits == null) delete tx.hashAcceptedUnits;
  else tx.hashAcceptedUnits = settled.acceptedUnits.toString();
  delete tx.hashOwed;
  delete tx.hashOwedRest;
  delete tx.hashDustNanos;
  delete tx.hashOwedOverflowNanos;
  return tx;
}

export function hashOwedDigestSuffix(tx) {
  if (hasOwedArrays(tx)) return null;
  let root = rootBytes(tx?.hashOwedRoot);
  if (tx?.hashOwedLocal != null) {
    const rows = parseLedgerRows(tx.hashOwedLocal);
    if (rows == null) return null;
    const expect = hashOwedRoot(rows);
    if (root && !root.equals(expect)) return null;
    root = expect;
  }
  if (!root) return Buffer.alloc(0);
  const credit = rootBytes(tx?.hashCreditRoot);
  const unitN = asBi(tx?.hashBonusUnit);
  const accepted = asBi(tx?.hashAcceptedUnits);
  if (!credit || unitN == null || unitN < 1n || unitN > BigInt(MAX_U32) || accepted == null || accepted > MAX_U64) {
    return null;
  }
  const parts = [
    Buffer.from('hashowed2'), root,
    Buffer.from('hashcred1'), credit,
    Buffer.from('hashunit1'), u32le(unitN),
    Buffer.from('hashacc1'), u64le(accepted),
  ];
  return Buffer.concat(parts);
}

function copyRow(row, nanos, sinceHeight) {
  return {
    noteCommit: Buffer.from(row.noteCommit),
    dest20: Buffer.from(row.dest20),
    nanos,
    sinceHeight,
    admitBase: row.admitBase && !emptyBase(row.admitBase) ? Buffer.from(row.admitBase) : null,
    address: row.address || '',
  };
}

/**
 * Pro-rata of `budget` across rows, the retainedUnitsByCommit walk in nanos.
 * Rows are sorted by noteCommit. A zero share of a positive row is filled
 * before the remainder walks the same order.
 */
export function proRataNanos(rows, budget) {
  const list = [...rows].sort((a, b) => cmpNoteCommit(a.noteCommit, b.noteCommit));
  const total = list.reduce((n, row) => n + row.nanos, 0n);
  const limit = budget > 0n ? budget : 0n;
  const out = new Map();
  if (total === 0n || limit === 0n) return out;
  if (total <= limit) {
    for (const row of list) out.set(row.noteCommit.toString('hex'), row.nanos);
    return out;
  }
  const floors = list.map((row) => ({
    row,
    base: (row.nanos * limit) / total,
  }));
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
  for (const row of floors) {
    if (row.base > 0n) out.set(row.row.noteCommit.toString('hex'), row.base);
  }
  return out;
}

function addPay(paid, row, nanos) {
  if (nanos <= 0n) return;
  const hex = row.noteCommit.toString('hex');
  const prev = paid.get(hex);
  if (!prev) {
    paid.set(hex, copyRow(row, nanos, row.sinceHeight || 0));
    return;
  }
  prev.nanos += nanos;
  if (!prev.admitBase && row.admitBase) prev.admitBase = row.admitBase;
  if (!prev.address && row.address) prev.address = row.address;
}

/**
 * Pay `rows` oldest-first up to `budget`. A peel that would leave either
 * side below `floor` stays on the row. `left` is the unspent budget.
 */
function takeFifo(rows, budget, floor) {
  let left = budget > 0n ? budget : 0n;
  const paid = [];
  const unpaid = [];
  for (const row of rows) {
    if (left >= row.nanos) {
      paid.push({ row, nanos: row.nanos });
      left -= row.nanos;
      continue;
    }
    if (left >= floor && row.nanos - left >= floor) {
      paid.push({ row, nanos: left });
      unpaid.push(copyRow(row, row.nanos - left, row.sinceHeight));
      left = 0n;
      continue;
    }
    unpaid.push(copyRow(row, row.nanos, row.sinceHeight));
  }
  return { paid, unpaid, left };
}

/**
 * Settle one block. `fresh` is full credit, not the retained share.
 * Optional dust, budget, and maxEntries let tests sweep any size.
 * Consensus verify calls this with the fingerprinted defaults.
 */
export function settleHashOwed({
  owedIn = [],
  dustIn = 0n,
  overflowIn = 0n,
  fresh = [],
  spill = [],
  budget = null,
  dust = null,
  maxEntries = HASH_OWED_MAX_ENTRIES,
  height = 0,
  unit = HASH_BONUS_NANOS,
} = {}) {
  const fail = (reason = 'hash_owed') => ({
    ok: false, reason, pay: [], owed: [], owedRest: [], dust: 0n, overflow: 0n, minted: 0n,
    acceptedUnits: 0n,
  });
  const floor = dust == null ? hashOwedDustNanos(unit) : asBi(dust);
  const cap = maxEntries == null ? HASH_OWED_MAX_ENTRIES : Math.floor(Number(maxEntries));
  const unitBi = BigInt(hashBonusUnitNanos(unit));
  const limit = budget == null ? BigInt(MAX_HASH_UNITS_PER_BLOCK) * unitBi : asBi(budget);
  const h = asBi(height);
  if (floor == null || floor <= 0n || limit == null || limit < 0n || h == null || h > BigInt(MAX_U32)) return fail();
  if (!Number.isInteger(cap) || cap < 0) return fail();
  const blockHeight = Number(h);
  const dustAcc = asBi(dustIn);
  const overAcc = asBi(overflowIn);
  // A public scalar has no noteCommit. It cannot enter the carry map.
  if (dustAcc == null || overAcc == null || dustAcc !== 0n || overAcc !== 0n) return fail();

  const parent = [];
  const carriedLow = [];
  for (const row of owedIn || []) {
    const nanos = asBi(row?.nanos);
    const since = asBi(row?.sinceHeight);
    const noteCommit = buf32(row?.noteCommit);
    const dest20 = buf20(row?.dest20);
    if (nanos == null || since == null || !noteCommit || !dest20) return fail();
    if (since > BigInt(MAX_U32) || nanos > MAX_U64) return fail();
    if (nanos === 0n) continue;
    let expect;
    try {
      expect = noteCommitOfDest20(dest20);
    } catch {
      return fail();
    }
    if (!expect.equals(noteCommit)) return fail();
    const parsed = {
      noteCommit,
      dest20,
      nanos,
      sinceHeight: Number(since),
      admitBase: buf32(row.admitBase),
      address: typeof row.address === 'string' ? row.address : '',
    };
    if (parsed.nanos < floor) carriedLow.push(parsed);
    else parent.push(parsed);
  }
  parent.sort(cmpOwed);

  const freshRows = [];
  for (const row of fresh || []) {
    const nanos = asBi(row?.nanos);
    const noteCommit = buf32(row?.noteCommit);
    const dest20 = buf20(row?.dest20);
    if (nanos == null || !noteCommit || !dest20) return fail();
    if (nanos === 0n) continue;
    if (nanos > MAX_U64) return fail();
    let expect;
    try {
      expect = noteCommitOfDest20(dest20);
    } catch {
      return fail();
    }
    if (!expect.equals(noteCommit)) return fail();
    freshRows.push({
      noteCommit,
      dest20,
      nanos,
      sinceHeight: blockHeight,
      admitBase: buf32(row.admitBase),
      address: typeof row.address === 'string' ? row.address : '',
    });
  }

  // Spill is owed at this height. It does not enter the fresh pay walk.
  const spillRows = [];
  for (const row of spill || []) {
    const nanos = asBi(row?.nanos);
    const noteCommit = buf32(row?.noteCommit);
    const dest20 = buf20(row?.dest20);
    if (nanos == null || !noteCommit || !dest20) return fail();
    if (nanos === 0n) continue;
    if (nanos > MAX_U64) return fail();
    let expect;
    try {
      expect = noteCommitOfDest20(dest20);
    } catch {
      return fail();
    }
    if (!expect.equals(noteCommit)) return fail();
    spillRows.push({
      noteCommit,
      dest20,
      nanos,
      sinceHeight: blockHeight,
      admitBase: buf32(row.admitBase),
      address: typeof row.address === 'string' ? row.address : '',
    });
  }

  const inSum = parent.reduce((n, row) => n + row.nanos, 0n)
    + carriedLow.reduce((n, row) => n + row.nanos, 0n)
    + freshRows.reduce((n, row) => n + row.nanos, 0n)
    + spillRows.reduce((n, row) => n + row.nanos, 0n);

  const paid = new Map();
  const still = [];
  // Parent slice is the floor fraction. The odd nano stays on the fresh side.
  const parentSlice = (limit * BigInt(HASH_OWED_DRAIN_NUM)) / BigInt(HASH_OWED_DRAIN_DEN);
  const freshSlice = limit - parentSlice;
  const first = takeFifo(parent, parentSlice, floor);
  for (const part of first.paid) addPay(paid, part.row, part.nanos);
  const freshBudget = freshSlice + first.left;

  const freshBy = new Map();
  for (const row of freshRows) {
    const hex = row.noteCommit.toString('hex');
    const prev = freshBy.get(hex);
    if (!prev) freshBy.set(hex, copyRow(row, row.nanos, blockHeight));
    else {
      prev.nanos += row.nanos;
      if (!prev.admitBase && row.admitBase) prev.admitBase = row.admitBase;
    }
  }
  const freshList = [...freshBy.values()];
  const share = proRataNanos(freshList, freshBudget);
  let spentFresh = 0n;
  for (const row of freshList) {
    const hex = row.noteCommit.toString('hex');
    const got = share.get(hex) || 0n;
    const unpaid = row.nanos - got;
    if (got >= floor) {
      addPay(paid, row, got);
      spentFresh += got;
      if (unpaid > 0n) still.push(copyRow(row, unpaid, blockHeight));
    } else if (row.nanos > 0n) {
      // A sub-dust slice stays on the owed row. Peeling it off would drop an above-dust credit.
      still.push(copyRow(row, row.nanos, blockHeight));
    }
  }
  // Unused fresh budget spills back onto parent rows the first slice did not finish.
  const spilled = takeFifo(first.unpaid, freshBudget - spentFresh, floor);
  for (const part of spilled.paid) addPay(paid, part.row, part.nanos);
  for (const row of spilled.unpaid) still.push(row);
  let left = spilled.left;

  // HASH_OWED_SUBDUST_V1. Spare after the floor walk pays parent rows that
  // are still below the floor. A partial below the floor is a real pay.
  // Fresh credits below the floor stay in `still` and are not in this walk.
  carriedLow.sort(cmpOwed);
  const unpaidLow = [];
  for (const row of carriedLow) {
    if (left <= 0n) {
      unpaidLow.push(row);
      continue;
    }
    if (left >= row.nanos) {
      addPay(paid, row, row.nanos);
      left -= row.nanos;
      continue;
    }
    addPay(paid, row, left);
    unpaidLow.push(copyRow(row, row.nanos - left, row.sinceHeight));
    left = 0n;
  }
  void left;

  const merged = new Map();
  for (const row of unpaidLow) still.push(row);
  for (const row of spillRows) {
    if (row.nanos > 0n) still.push(copyRow(row, row.nanos, blockHeight));
  }
  for (const row of still) {
    const hex = row.noteCommit.toString('hex');
    const prev = merged.get(hex);
    if (!prev) {
      merged.set(hex, copyRow(row, row.nanos, row.sinceHeight));
      continue;
    }
    prev.nanos += row.nanos;
    if (row.sinceHeight < prev.sinceHeight) prev.sinceHeight = row.sinceHeight;
    if (!prev.admitBase && row.admitBase) prev.admitBase = row.admitBase;
    if (!prev.address && row.address) prev.address = row.address;
  }
  const owedAll = [];
  for (const row of merged.values()) {
    if (row.nanos > 0n) owedAll.push(row);
  }
  // Payable rows take the inline window. Sub-dust does not sit ahead of them.
  const payable = [];
  const low = [];
  for (const row of owedAll) {
    if (row.nanos >= floor) payable.push(row);
    else low.push(row);
  }
  payable.sort(cmpOwed);
  low.sort(cmpOwed);
  const packed = payable.concat(low);
  const owed = packed.slice(0, cap);
  const owedRest = packed.slice(cap);

  const pay = [...paid.values()].sort((a, b) => cmpNoteCommit(a.noteCommit, b.noteCommit));
  const minted = pay.reduce((n, row) => n + row.nanos, 0n);
  const carried = owed.reduce((n, row) => n + row.nanos, 0n)
    + owedRest.reduce((n, row) => n + row.nanos, 0n);
  if (minted + carried !== inSum) return fail();
  if (owed.length > cap) return fail();
  const freshNanos = freshRows.reduce((n, row) => n + row.nanos, 0n);
  const spillNanos = spillRows.reduce((n, row) => n + row.nanos, 0n);
  if (unitBi <= 0n || freshNanos % unitBi !== 0n || spillNanos % unitBi !== 0n) return fail();
  const acceptedUnits = freshNanos / unitBi;
  return {
    ok: true,
    reason: '',
    pay,
    owed,
    owedRest,
    dust: 0n,
    overflow: 0n,
    minted,
    acceptedUnits,
    fresh: freshRows,
    unit: hashBonusUnitNanos(unit),
  };
}

export function acceptedUnitsOfBlock(block, unit = HASH_BONUS_NANOS, tipHeight = null) {
  const got = freshForBlock(block, unit, tipHeight);
  if (!got.ok) return null;
  const u = BigInt(hashBonusUnitNanos(unit));
  if (u <= 0n) return null;
  let n = 0n;
  for (const row of got.fresh) {
    if (row.nanos % u !== 0n) return null;
    n += row.nanos / u;
  }
  const cb = Array.isArray(block?.txs) ? block.txs[0] : null;
  const stamped = cb ? asBi(cb.hashAcceptedUnits) : null;
  if (stamped == null || stamped !== n) return null;
  return n;
}

/**
 * Replay the owed map from sealed per-block credits. Share batches are not
 * the source. `units[i]` is the hash-bonus unit live at that block.
 */
export function replayHashOwed(blocks, { unit = null, units = null } = {}) {
  let rows = [];
  const accepted = [];
  const snaps = [];
  const list = Array.isArray(blocks) ? blocks : [];
  let tipH = 0;
  for (let i = 0; i < list.length; i += 1) {
    const h = Number(list[i]?.height);
    const n = Number.isInteger(h) ? h : i + 1;
    if (n > tipH) tipH = n;
  }
  for (let i = 0; i < list.length; i += 1) {
    const block = list[i];
    const u = Array.isArray(units) ? units[i] : (unit == null ? HASH_BONUS_NANOS : unit);
    const next = advanceHashOwed({
      owedIn: rows,
      acceptedSeries: accepted,
      block,
      unit: u,
      height: Number.isInteger(Number(block?.height)) ? Number(block.height) : i + 1,
      tipHeight: tipH,
    });
    if (!next.ok) return { ok: false, reason: next.reason || 'hash_owed', rows: [], accepted: [], snaps: [] };
    rows = next.rows;
    snaps.push({ rows, seriesEnd: accepted.length });
  }
  return { ok: true, reason: '', rows, accepted, snaps };
}

/** One block of the replay. `acceptedSeries` is the history before this block. */
export function advanceHashOwed({
  owedIn = [],
  acceptedSeries = [],
  block,
  unit = HASH_BONUS_NANOS,
  height = null,
  tipHeight = null,
} = {}) {
  const h = height == null ? Number(block?.height || 0) : Number(height);
  const gotFresh = freshForBlock(block, unit, tipHeight);
  if (!gotFresh.ok) return { ok: false, reason: 'hash_owed' };
  const gotSpill = spillForBlock(block, unit, tipHeight);
  if (!gotSpill.ok) return { ok: false, reason: 'hash_owed' };
  const fresh = gotFresh.fresh;
  const budget = hashBudgetNanos(acceptedSeries, unit);
  if (budget == null) return { ok: false, reason: 'hash_owed' };
  const settled = settleHashOwed({
    owedIn,
    fresh,
    spill: gotSpill.fresh,
    height: Number.isInteger(h) && h >= 0 ? h : 0,
    unit,
    budget,
  });
  if (!settled.ok) return { ok: false, reason: settled.reason || 'hash_owed' };
  const cb = Array.isArray(block?.txs) ? block.txs[0] : null;
  if (!cb || !sameHashLedger(cb, settled)) return { ok: false, reason: 'hash_owed' };
  const acceptedUnits = settled.acceptedUnits == null ? 0n : settled.acceptedUnits;
  const series = Array.isArray(acceptedSeries) ? acceptedSeries : [];
  series.push(acceptedUnits);
  return {
    ok: true,
    reason: '',
    rows: settledOwedRows(settled),
    acceptedUnits,
    acceptedSeries: series,
    settled,
  };
}

function rowsEqual(a, b) {
  if (a.length !== b.length) return false;
  const as = [...a].sort(cmpOwed);
  const bs = [...b].sort(cmpOwed);
  for (let i = 0; i < as.length; i += 1) {
    const left = as[i];
    const right = bs[i];
    if (left.nanos !== right.nanos || left.sinceHeight !== right.sinceHeight) return false;
    if (!left.noteCommit.equals(right.noteCommit) || !left.dest20.equals(right.dest20)) return false;
    const aa = left.admitBase && !emptyBase(left.admitBase) ? left.admitBase : Buffer.alloc(0);
    const bb = right.admitBase && !emptyBase(right.admitBase) ? right.admitBase : Buffer.alloc(0);
    if (!aa.equals(bb)) return false;
  }
  return true;
}

export function sameHashLedger(tx, settled, dust = hashOwedDustNanos()) {
  void dust;
  if (!settled?.ok || hasOwedArrays(tx)) return false;
  const dustGot = hashDustFromTx(tx);
  const overGot = hashOverflowFromTx(tx);
  if (dustGot == null || overGot == null) return false;
  if (dustGot !== 0n || overGot !== 0n || settled.dust !== 0n || settled.overflow !== 0n) return false;
  const expect = settledOwedRows(settled);
  const root = rootBytes(tx?.hashOwedRoot);
  if (!root || !root.equals(hashOwedRoot(expect))) return false;
  if (tx?.hashOwedLocal != null) {
    const local = parseLedgerRows(tx.hashOwedLocal);
    if (local == null || !rowsEqual(local, expect)) return false;
  }
  if (settled.acceptedUnits == null) return false;
  const got = asBi(tx?.hashAcceptedUnits);
  if (got == null || got !== settled.acceptedUnits) return false;
  const credit = rootBytes(tx?.hashCreditRoot);
  if (!credit || !credit.equals(hashCreditRoot(settled.fresh || []))) return false;
  const unitStamp = asBi(tx?.hashBonusUnit);
  const unitWant = hashBonusUnitNanos(settled.unit == null ? HASH_BONUS_NANOS : settled.unit);
  if (unitStamp == null || Number(unitStamp) !== unitWant) return false;
  return true;
}

export function hashLedgerIdle(settled, freshCount = 0) {
  if (!settled?.ok) return false;
  return freshCount === 0
    && settled.pay.length === 0
    && settled.owed.length === 0
    && (settled.owedRest || []).length === 0
    && settled.dust === 0n
    && settled.overflow === 0n
    && settled.minted === 0n;
}

const COMMIT_SHARE_MAGIC = Buffer.from('hscm1');
const COMMIT_LIST_MAGIC = Buffer.from('hscn1');
const COMMIT_PAY_MAGIC = Buffer.from('hscp1');
const COMMIT_SHARE_ROW = 32 + 8 + 4 + 8 + 20;
const COMMIT_ROOT_PREFIX = Buffer.from('sharecommit1');

function asTime(v) {
  if (typeof v === 'bigint') return v >= 0n && v <= MAX_U64 ? v : null;
  const n = asBi(v);
  if (n == null || n > MAX_U64) return null;
  return n;
}

/**
 * True when commitMs is after the parent header time and at or before
 * this block's header time. A missing or non-integer time is not timely.
 */
export function Timely(commitMs, parentMs, blockMs) {
  const t = asTime(commitMs);
  const p = asTime(parentMs);
  const b = asTime(blockMs);
  if (t == null || p == null || b == null) return false;
  return t > p && t <= b;
}

function shareKeyOf(share) {
  let nc;
  try { nc = noteCommitOfShare(share); } catch { return null; }
  if (!nc || nc.length !== 32 || nc.equals(Buffer.alloc(32))) return null;
  let nonce;
  try { nonce = BigInt(share?.nonce); } catch { return null; }
  if (nonce < 0n || nonce > MAX_U64) return null;
  return { key: `${Buffer.from(nc).toString('hex')}:${nonce.toString()}`, nc: Buffer.from(nc), nonce };
}

function shareUnitsOf(share) {
  const credit = creditBitsForShare(share, SHARE_FLOOR_BITS, { strict: true });
  if (!credit.ok) return null;
  return { units: BigInt(unitsForShare(credit.bits)), bits: credit.bits };
}

function normalizeCommitShare(share, { timeDefault = null } = {}) {
  const id = shareKeyOf(share);
  const sized = shareUnitsOf(share);
  if (!id || !sized) return null;
  let dest20;
  try { dest20 = dest20OfShare(share); } catch { return null; }
  if (!dest20 || dest20.length !== 20 || dest20.equals(Buffer.alloc(20))) return null;
  let expect;
  try { expect = noteCommitOfDest20(dest20); } catch { return null; }
  if (!expect.equals(id.nc)) return null;
  let time = asTime(share?.commitMs);
  if (time == null) time = timeDefault;
  if (time == null) return null;
  return {
    key: id.key,
    nc: id.nc,
    nonce: id.nonce,
    units: sized.units,
    bits: sized.bits,
    time,
    dest20: Buffer.from(dest20),
    share,
  };
}

/**
 * Sum of credited units. An illegal width fails closed (null).
 * An empty list is zero production.
 */
export function Prod(shares) {
  const list = Array.isArray(shares) ? shares : [];
  let n = 0n;
  for (const share of list) {
    const sized = shareUnitsOf(share);
    if (!sized) return null;
    n += sized.units;
  }
  return n;
}

/**
 * Inclusion cap for one producer. Prod below the block unit cap is the
 * cap. Prod above it stops at MAX_HASH_UNITS_PER_BLOCK. Zero production
 * caps at zero.
 */
export function CapUnits_prod(prod, maxUnits = MAX_HASH_UNITS_PER_BLOCK) {
  const p = typeof prod === 'bigint' ? prod : asBi(prod);
  const m = typeof maxUnits === 'bigint' ? maxUnits : asBi(maxUnits);
  if (p == null || m == null || p < 0n || m < 0n) return null;
  if (p === 0n || m === 0n) return 0n;
  return p < m ? p : m;
}

function cmpCommitRow(a, b) {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  const c = cmpNoteCommit(a.nc, b.nc);
  if (c) return c;
  if (a.nonce !== b.nonce) return a.nonce < b.nonce ? -1 : 1;
  return 0;
}

/**
 * Invalidate-omit. Parent carry is due ahead of new timely commits.
 * A row that fits under CapUnits_prod is mandatory: a new commit must be
 * in `included`, and a parent carry is fresh credit. A row that does not
 * fit is the next carry. shareBatch pay is not cleared.
 * `maxUnits` is the block cap. Callers on the consensus path leave it at
 * MAX_HASH_UNITS_PER_BLOCK.
 */
export function shareCommitAccount({
  carryIn = [],
  commits = [],
  included = [],
  parentMs = null,
  blockMs = null,
  maxUnits = MAX_HASH_UNITS_PER_BLOCK,
  maxShares = MAX_SHARES_PER_BLOCK,
} = {}) {
  const fail = (bad = true) => ({
    ok: false,
    bad,
    reason: 'share_commit',
    prod: 0n,
    cap: 0n,
    mandatory: [],
    carry: [],
    fresh: [],
  });
  const seats = Math.floor(Number(maxShares));
  if (!Number.isInteger(seats) || seats < 0) return fail(true);
  const carryRows = [];
  for (const share of Array.isArray(carryIn) ? carryIn : []) {
    const row = normalizeCommitShare(share, { timeDefault: 0n });
    if (!row) return fail(true);
    row.due = true;
    carryRows.push(row);
  }
  const commitRows = [];
  for (const share of Array.isArray(commits) ? commits : []) {
    const time = asTime(share?.commitMs);
    if (!Timely(time, parentMs, blockMs)) continue;
    const row = normalizeCommitShare(share, { timeDefault: null });
    if (!row) return fail(true);
    row.due = false;
    commitRows.push(row);
  }
  const seen = new Set();
  const ordered = [];
  for (const row of carryRows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    ordered.push(row);
  }
  for (const row of commitRows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    ordered.push(row);
  }
  ordered.sort(cmpCommitRow);
  let prod = 0n;
  for (const row of ordered) prod += row.units;
  const cap = CapUnits_prod(prod, maxUnits);
  if (cap == null) return fail(true);
  let remaining = cap;
  let usedSeats = 0;
  const mandatory = [];
  const carry = [];
  const payShares = [];
  for (const row of ordered) {
    const fits = row.units <= remaining;
    if (row.due) {
      if (fits) {
        payShares.push(row.share);
        remaining -= row.units;
      } else {
        carry.push(row.share);
      }
    } else if (fits && usedSeats < seats) {
      mandatory.push(row.share);
      remaining -= row.units;
      usedSeats += 1;
    } else {
      carry.push(row.share);
    }
  }
  const have = new Set();
  for (const share of Array.isArray(included) ? included : []) {
    const id = shareKeyOf(share);
    if (id) have.add(id.key);
  }
  let omitted = false;
  for (const share of mandatory) {
    const id = shareKeyOf(share);
    if (!id || !have.has(id.key)) omitted = true;
  }
  const fresh = freshCreditsFromShares(payShares);
  return {
    ok: !omitted,
    bad: false,
    reason: omitted ? 'share_commit' : '',
    prod,
    cap,
    mandatory,
    carry,
    fresh,
  };
}

export function shareCommitMissing(included, mandatory) {
  const have = new Set();
  for (const share of Array.isArray(included) ? included : []) {
    const id = shareKeyOf(share);
    if (id) have.add(id.key);
  }
  const out = [];
  for (const share of Array.isArray(mandatory) ? mandatory : []) {
    const id = shareKeyOf(share);
    if (id && !have.has(id.key)) out.push(share);
  }
  return out;
}

function commitShareBytes(share) {
  const row = normalizeCommitShare(share, { timeDefault: 0n });
  if (!row) return null;
  const out = Buffer.alloc(COMMIT_SHARE_ROW);
  row.nc.copy(out, 0);
  out.writeBigUInt64LE(row.nonce, 32);
  out.writeUInt32LE(row.bits >>> 0, 40);
  out.writeBigUInt64LE(row.time, 44);
  row.dest20.copy(out, 52);
  return out;
}

function packCommitShares(magic, shares) {
  const list = Array.isArray(shares) ? shares : [];
  const body = Buffer.alloc(magic.length + 4 + list.length * COMMIT_SHARE_ROW);
  magic.copy(body, 0);
  body.writeUInt32LE(list.length, magic.length);
  let o = magic.length + 4;
  for (const share of list) {
    const row = commitShareBytes(share);
    if (!row) return null;
    row.copy(body, o);
    o += COMMIT_SHARE_ROW;
  }
  return body;
}

function unpackCommitShares(magic, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < magic.length + 4) return null;
  if (!b.subarray(0, magic.length).equals(magic)) return null;
  const n = b.readUInt32LE(magic.length);
  if (b.length !== magic.length + 4 + n * COMMIT_SHARE_ROW) return null;
  const shares = [];
  let o = magic.length + 4;
  for (let i = 0; i < n; i += 1) {
    const noteCommit = Buffer.from(b.subarray(o, o + 32));
    const nonce = b.readBigUInt64LE(o + 32);
    const bits = b.readUInt32LE(o + 40);
    const commitMs = b.readBigUInt64LE(o + 44);
    const dest20 = Buffer.from(b.subarray(o + 52, o + 72));
    o += COMMIT_SHARE_ROW;
    const share = {
      noteCommit,
      dest20,
      nonce,
      creditedShareBits: bits,
      shareBits: bits,
      commitMs,
    };
    const row = normalizeCommitShare(share, { timeDefault: 0n });
    if (!row || row.bits !== bits || row.time !== commitMs) return null;
    shares.push(share);
  }
  return shares;
}

export function packShareCommitCarryBytes(shares) {
  return packCommitShares(COMMIT_SHARE_MAGIC, shares);
}

export function unpackShareCommitCarryBytes(buf) {
  return unpackCommitShares(COMMIT_SHARE_MAGIC, buf);
}

export function packShareCommitListBytes(shares) {
  return packCommitShares(COMMIT_LIST_MAGIC, shares);
}

export function unpackShareCommitListBytes(buf) {
  return unpackCommitShares(COMMIT_LIST_MAGIC, buf);
}

export function packShareCommitPayBytes(rows) {
  const packed = packHashCreditBytes(rows || []);
  return Buffer.concat([COMMIT_PAY_MAGIC, packed]);
}

export function unpackShareCommitPayBytes(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < COMMIT_PAY_MAGIC.length) return null;
  if (!b.subarray(0, COMMIT_PAY_MAGIC.length).equals(COMMIT_PAY_MAGIC)) return null;
  return unpackHashCreditBytes(b.subarray(COMMIT_PAY_MAGIC.length));
}

/** True when the coinbase root matches the carry. Both absent agrees. */
export function shareCommitRootAgrees(root, shares) {
  const list = Array.isArray(shares) ? shares : [];
  const expect = shareCommitRoot(list);
  const got = rootBytes(root);
  if (!expect) return false;
  if (!got) return list.length === 0 && (root == null || root === '');
  return got.equals(expect);
}

/** Canonical root over the carry, in the account's order. Empty has a root. */
export function shareCommitRoot(shares) {
  const list = Array.isArray(shares) ? shares : [];
  const parts = [COMMIT_ROOT_PREFIX];
  for (const share of list) {
    const row = commitShareBytes(share);
    if (!row) return null;
    parts.push(row);
  }
  return createHash('sha256').update(Buffer.concat(parts)).digest();
}

export function shareCommitDigestSuffix(tx) {
  if (!tx || tx.shareCommitRoot == null || tx.shareCommitRoot === '') return Buffer.alloc(0);
  const root = rootBytes(tx.shareCommitRoot);
  if (!root) return null;
  return Buffer.concat([Buffer.from('sharecommit1'), root]);
}

function commitPayOfBlock(block) {
  if (!block || !Object.prototype.hasOwnProperty.call(block, 'shareCommitPay')) return [];
  return parseCreditList(block.shareCommitPay);
}

/** Share-batch credits, then parent-carry credits. An empty extra list is the original rows. */
export function mergeCreditRows(left, right) {
  const extra = Array.isArray(right) ? right : [];
  if (!extra.length) return Array.isArray(left) ? left : [];
  const base = Array.isArray(left) ? left : [];
  if (!base.length) return extra.slice();
  const by = new Map();
  const order = [];
  const take = (row) => {
    const noteCommit = buf32(row?.noteCommit);
    const dest20 = buf20(row?.dest20);
    const nanos = asBi(row?.nanos);
    if (!noteCommit || !dest20 || nanos == null) return false;
    const hex = noteCommit.toString('hex');
    const prev = by.get(hex);
    if (!prev) {
      by.set(hex, {
        noteCommit,
        dest20,
        nanos,
        sinceHeight: 0,
        admitBase: buf32(row.admitBase),
        address: typeof row.address === 'string' ? row.address : '',
      });
      order.push(hex);
      return true;
    }
    if (!prev.dest20.equals(dest20)) return false;
    prev.nanos += nanos;
    if (!prev.admitBase && row.admitBase) prev.admitBase = buf32(row.admitBase);
    if (!prev.address && row.address) prev.address = row.address;
    return true;
  };
  for (const row of base) {
    if (!take(row)) return null;
  }
  for (const row of extra) {
    if (!take(row)) return null;
  }
  return order.map((hex) => by.get(hex));
}

function carriesMatch(stored, want) {
  const left = Array.isArray(stored) ? stored : [];
  const right = Array.isArray(want) ? want : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = normalizeCommitShare(left[i], { timeDefault: 0n });
    const b = normalizeCommitShare(right[i], { timeDefault: 0n });
    if (!a || !b || a.key !== b.key || a.units !== b.units || a.time !== b.time) return false;
  }
  return true;
}

/**
 * Block rule. A parent carry must match its coinbase root. This block's
 * carry and shareCommitPay must match the account. Omitting a timely
 * commit that fits the cap is share_commit.
 */
export function shareCommitOfBlock(block, prev, { parentMs = null, blockMs = null } = {}) {
  const fail = () => ({ ok: false, reason: 'share_commit', fresh: [], carry: [], mandatory: [] });
  const parentCarry = Array.isArray(prev?.shareCommitCarry) ? prev.shareCommitCarry : [];
  const parentCb = Array.isArray(prev?.txs) ? prev.txs.find((tx) => tx && tx.coinbase) || prev.txs[0] : null;
  const parentRoot = rootBytes(parentCb?.shareCommitRoot);
  if (parentCarry.length || parentRoot) {
    const expect = shareCommitRoot(parentCarry);
    if (!expect || !parentRoot || !parentRoot.equals(expect)) return fail();
  }
  const account = shareCommitAccount({
    carryIn: parentCarry,
    commits: Array.isArray(block?.shareCommits) ? block.shareCommits : [],
    included: Array.isArray(block?.shareBatch) ? block.shareBatch : [],
    parentMs,
    blockMs,
  });
  if (!account.ok) return fail();
  const storedCarry = Array.isArray(block?.shareCommitCarry) ? block.shareCommitCarry : [];
  if (!carriesMatch(storedCarry, account.carry)) return fail();
  const cb = Array.isArray(block?.txs) ? block.txs.find((tx) => tx && tx.coinbase) || block.txs[0] : null;
  const root = rootBytes(cb?.shareCommitRoot);
  if (account.carry.length || root) {
    const expect = shareCommitRoot(account.carry);
    if (!expect || !root || !root.equals(expect)) return fail();
  }
  const pay = commitPayOfBlock(block || {});
  if (pay == null || !creditsEqual(pay, account.fresh)) return fail();
  return account;
}

/** Copy the root onto a compacted coinbase. Rows stay off the wire. */
export function compactHashLedger(tx, row) {
  if (!tx || !row) return row;
  const slotRoot = rootBytes(tx.shareSlotRoot);
  if (slotRoot) row.shareSlotRoot = slotRoot;
  else delete row.shareSlotRoot;
  const commitRoot = rootBytes(tx.shareCommitRoot);
  if (commitRoot) row.shareCommitRoot = commitRoot;
  else delete row.shareCommitRoot;
  delete row.hashOwed;
  delete row.hashOwedRest;
  delete row.hashOwedLocal;
  delete row.hashDustNanos;
  delete row.hashOwedOverflowNanos;
  if (hasOwedArrays(tx)) return row;
  let root = rootBytes(tx.hashOwedRoot);
  if (tx.hashOwedLocal != null) {
    const owed = parseLedgerRows(tx.hashOwedLocal);
    if (owed == null) return row;
    const expect = hashOwedRoot(owed);
    if (root && !root.equals(expect)) return row;
    root = expect;
  }
  if (root) row.hashOwedRoot = root;
  else delete row.hashOwedRoot;
  delete row.hashCredits;
  const credit = rootBytes(tx.hashCreditRoot);
  if (credit) row.hashCreditRoot = credit;
  else delete row.hashCreditRoot;
  const unitN = asBi(tx.hashBonusUnit);
  if (unitN != null && unitN >= 1n && unitN <= BigInt(MAX_U32)) row.hashBonusUnit = Number(unitN);
  else delete row.hashBonusUnit;
  if (tx.hashAcceptedUnits != null && tx.hashAcceptedUnits !== '') {
    const n = asBi(tx.hashAcceptedUnits);
    if (n == null) return row;
    row.hashAcceptedUnits = n.toString();
  } else {
    delete row.hashAcceptedUnits;
  }
  return row;
}

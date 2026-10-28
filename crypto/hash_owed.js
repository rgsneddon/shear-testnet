/**
 * R28 hash budget and the retired owed ledger (D2, Russell 28 Oct).
 *
 * A BluNotes block pays its shares by the draw. There is no owed ledger, no
 * spill and no per-block hash-credit record. The hash budget of a block is
 * max(MAX_HASH_UNITS_PER_BLOCK, HASH_OWED_SCALE_K * lower median) over the
 * last HASH_OWED_SCALE_WINDOW accepted W, each read from that block's own
 * record (advanceHashOwed). A block with no record is refused, never stepped
 * by the old ledger. A block or coinbase that still carries an owed or
 * hash-credit field is refused as blunote_owed (retiredOwedField), on the
 * rows as they arrived, before any compaction could strip the field.
 * Amounts stay BigInt so a value above 2^53 is not rounded.
 */
import { decodeRecord } from './blunote.js';
import {
  HASH_BONUS_NANOS,
  HASH_OWED_SCALE_K,
  HASH_OWED_SCALE_WINDOW,
  MAX_HASH_UNITS_PER_BLOCK,
  SAMPLE_PRUNE_CONFIRMATIONS,
  SHARE_FLOOR_BITS,
  hashBonusUnitNanos,
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

/**
 * Tx fields of the retired owed ledger and hash-credit record (R28 D2,
 * Russell 28 Oct). A coinbase, or any tx, carrying one is refused as
 * blunote_owed. Compaction no longer keeps any of them, so the refusal is
 * read on the rows as they arrived (chain.js earlyRowsRejected).
 */
export const RETIRED_OWED_TX_FIELDS = Object.freeze([
  'hashOwed', 'hashOwedRest', 'hashOwedLocal', 'hashOwedRoot', 'hashCreditRoot', 'hashCredits',
  'hashDustNanos', 'hashOwedOverflowNanos', 'hashAcceptedUnits', 'hashBonusUnit',
]);

/** Block fields of the retired hash-credit record: refused as blunote_owed. */
export const RETIRED_OWED_BLOCK_FIELDS = Object.freeze(['hashCredits', 'hashCreditPacked']);

function carries(obj, key) {
  if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, key)) return false;
  return obj[key] !== undefined && obj[key] !== null;
}

/**
 * The first retired owed or hash-credit field `block` carries, as a
 * blunote_owed refusal, or null. Any value counts, an empty one too: no
 * honest R28 producer writes these fields, so their presence is the fault.
 */
export function retiredOwedField(block) {
  if (!block || typeof block !== 'object') return null;
  for (const key of RETIRED_OWED_BLOCK_FIELDS) {
    if (carries(block, key)) return { ok: false, reason: 'blunote_owed', field: key };
  }
  const txs = Array.isArray(block.txs) ? block.txs : [];
  for (let i = 0; i < txs.length; i += 1) {
    for (const key of RETIRED_OWED_TX_FIELDS) {
      if (carries(txs[i], key)) return { ok: false, reason: 'blunote_owed', field: `txs[${i}].${key}` };
    }
  }
  return null;
}

function hasRecord(block) {
  return block?.blunoteRecord != null && block.blunoteRecord !== '';
}

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

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

export function cmpNoteCommit(a, b) {
  return Buffer.compare(a, b);
}

const CREDIT_MAGIC = Buffer.from('hcrd1');
const SPILL_MAGIC = Buffer.from('hspw1');
const SPILL_CREDIT_MAGIC = Buffer.from('hspc1');
const CREDIT_ROW = 32 + 20 + 32 + 8;

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

function creditBase(row) {
  return row?.admitBase && !emptyBase(row.admitBase) ? Buffer.from(row.admitBase) : Buffer.alloc(32);
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

function emptyBase(buf) {
  return !buf || buf.length !== 32 || buf.equals(Buffer.alloc(32));
}

/**
 * Full credited nanos per noteCommit. Illegal bytes add nothing.
 * This is 2^b, not the retained pro-rata share of the cap.
 */
export function freshCreditsFromShares(shares, unit = HASH_BONUS_NANOS) {
  const u = BigInt(hashBonusUnitNanos(unit));
  // A zero unit is not a zero-nanos row. Those rows fail the credit parser.
  if (u === 0n) return [];
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

/**
 * Replay the owed map from sealed per-block credits. Share batches are not
 * the source. `units[i]` is the hash-bonus unit live at that block.
 */
export function replayHashOwed(blocks, { unit = null, units = null, burialOf = null } = {}) {
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
    // A pruned block proven buried by a chain this tip replaced keeps that burial.
    const own = typeof burialOf === 'function' ? burialOf(block) : null;
    const next = advanceHashOwed({
      owedIn: rows,
      acceptedSeries: accepted,
      block,
      unit: u,
      height: Number.isInteger(Number(block?.height)) ? Number(block.height) : i + 1,
      tipHeight: Number.isInteger(own) && own > tipH ? own : tipH,
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
  // R28: a BluNotes block has no owed ledger (D2). Its record's W is the
  // accepted units the next budget's median reads.
  if (hasRecord(block)) {
    const raw = block.blunoteRecord;
    const rec = decodeRecord(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'hex'));
    if (!rec) return { ok: false, reason: 'blunote_record' };
    const acceptedUnits = rec.n > 0 ? rec.W : 0n;
    const series = Array.isArray(acceptedSeries) ? acceptedSeries : [];
    series.push(acceptedUnits);
    return {
      ok: true,
      reason: '',
      rows: [],
      acceptedUnits,
      acceptedSeries: series,
      settled: { ok: true, pay: [], owed: [], owedRest: [], dust: 0n, overflow: 0n, minted: 0n, acceptedUnits },
    };
  }
  // R28 (D2, Russell 28 Oct): a block with no record has no accepted units.
  // The retired owed ledger is not a fallback, so it is refused outright.
  void owedIn;
  void unit;
  void height;
  void tipHeight;
  return { ok: false, reason: 'blunote_record' };
}

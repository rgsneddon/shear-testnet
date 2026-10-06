/**
 * Hash-bonus owed ledger. One rule for every producer.
 *
 * A block may mint at most MAX_HASH_UNITS_PER_BLOCK times the live unit.
 * Parent owed rows are paid first (oldest height, then noteCommit bytes).
 * This block's new credits then share whatever budget remains, pro-rata,
 * the same walk as retainedUnitsByCommit. Anything still unpaid stays on
 * that noteCommit. After every row at or above the dust floor is handled,
 * spare budget pays parent rows still below the floor, oldest first, even
 * for one nano (HASH_OWED_SUBDUST_V1). A fresh credit below the floor is
 * not spent from that spare in the same settle.
 * HASH_OWED_CARRY_V1 has no public dust pot and no unattributed overflow.
 * The inline pack takes payable rows first, then sub-dust rows. That pack
 * is node state. The coinbase wire carries hashOwedRoot only
 * (HASH_OWED_WIRE=root-v1). HASH_OWED_BUDGET_SCALE_V1 sets this block's
 * mint capacity to max(MAX_HASH_UNITS, k * lowerMedian) over the
 * fingerprinted window of sealed accepted units, and never below the floor.
 * Pot splits and the pool fee do not read this ledger. Amounts stay BigInt
 * so a value above 2^53 is not rounded.
 */
import { createHash } from 'node:crypto';
import {
  HASH_BONUS_NANOS,
  HASH_OWED_MAX_ENTRIES,
  HASH_OWED_SCALE_K,
  HASH_OWED_SCALE_WINDOW,
  MAX_HASH_UNITS_PER_BLOCK,
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
import { unpackShareBatch } from './pack.js';
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
  if (settled.acceptedUnits != null) tx.hashAcceptedUnits = settled.acceptedUnits.toString();
  else delete tx.hashAcceptedUnits;
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
  const parts = [Buffer.from('hashowed2'), root];
  if (tx?.hashAcceptedUnits != null && tx.hashAcceptedUnits !== '') {
    const n = asBi(tx.hashAcceptedUnits);
    if (n == null || n > MAX_U64) return null;
    parts.push(Buffer.from('hashacc1'), u64le(n));
  }
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
 * Settle one block. `fresh` is full credit, not the retained share.
 * Optional dust, budget, and maxEntries let tests sweep any size.
 * Consensus verify calls this with the fingerprinted defaults.
 */
export function settleHashOwed({
  owedIn = [],
  dustIn = 0n,
  overflowIn = 0n,
  fresh = [],
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

  const inSum = parent.reduce((n, row) => n + row.nanos, 0n)
    + carriedLow.reduce((n, row) => n + row.nanos, 0n)
    + freshRows.reduce((n, row) => n + row.nanos, 0n);

  const paid = new Map();
  let left = limit;
  const still = [];
  for (const row of parent) {
    if (left >= row.nanos) {
      addPay(paid, row, row.nanos);
      left -= row.nanos;
      continue;
    }
    if (left >= floor && row.nanos - left >= floor) {
      addPay(paid, row, left);
      still.push(copyRow(row, row.nanos - left, row.sinceHeight));
      left = 0n;
      continue;
    }
    // A remainder below the floor stays on this note. Do not peel it into a pot.
    still.push(copyRow(row, row.nanos, row.sinceHeight));
  }

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
  const share = proRataNanos(freshList, left);
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
  left -= spentFresh;

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
  const acceptedUnits = freshNanos % unitBi === 0n ? freshNanos / unitBi : null;
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
  };
}

export function acceptedUnitsOfBlock(block, unit = HASH_BONUS_NANOS) {
  const cb = Array.isArray(block?.txs) ? block.txs[0] : null;
  const stamped = cb ? asBi(cb.hashAcceptedUnits) : null;
  if (stamped != null) return stamped;
  const fresh = freshCreditsFromShares(block?.shareBatch || [], unit);
  const u = BigInt(hashBonusUnitNanos(unit));
  let n = 0n;
  for (const row of fresh) {
    if (u <= 0n || row.nanos % u !== 0n) return null;
    n += row.nanos / u;
  }
  return n;
}

/**
 * Replay the owed map from sealed share batches and check each coinbase root.
 * A pruned share batch cannot rebuild fresh credits. That hole is 035.
 */
export function replayHashOwed(blocks, { unit = HASH_BONUS_NANOS } = {}) {
  let rows = [];
  const accepted = [];
  const list = Array.isArray(blocks) ? blocks : [];
  for (let i = 0; i < list.length; i += 1) {
    const block = list[i];
    const next = advanceHashOwed({
      owedIn: rows,
      acceptedSeries: accepted,
      block,
      unit,
      height: Number.isInteger(Number(block?.height)) ? Number(block.height) : i + 1,
    });
    if (!next.ok) return { ok: false, reason: next.reason || 'hash_owed', rows: [], accepted: [] };
    rows = next.rows;
    accepted.push(next.acceptedUnits);
  }
  return { ok: true, reason: '', rows, accepted };
}

/** One block of the replay. `acceptedSeries` is the history before this block. */
export function advanceHashOwed({
  owedIn = [],
  acceptedSeries = [],
  block,
  unit = HASH_BONUS_NANOS,
  height = null,
} = {}) {
  const h = height == null ? Number(block?.height || 0) : Number(height);
  const fresh = freshCreditsFromShares(block?.shareBatch || [], unit);
  const budget = hashBudgetNanos(acceptedSeries, unit);
  if (budget == null) return { ok: false, reason: 'hash_owed' };
  const settled = settleHashOwed({
    owedIn,
    fresh,
    height: Number.isInteger(h) && h >= 0 ? h : 0,
    unit,
    budget,
  });
  if (!settled.ok) return { ok: false, reason: settled.reason || 'hash_owed' };
  const cb = Array.isArray(block?.txs) ? block.txs[0] : null;
  if (!cb || !sameHashLedger(cb, settled)) return { ok: false, reason: 'hash_owed' };
  const acceptedUnits = settled.acceptedUnits == null ? 0n : settled.acceptedUnits;
  return {
    ok: true,
    reason: '',
    rows: settledOwedRows(settled),
    acceptedUnits,
    acceptedSeries: [...acceptedSeries, acceptedUnits],
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
  if (settled.acceptedUnits != null) {
    const got = asBi(tx?.hashAcceptedUnits);
    if (got == null || got !== settled.acceptedUnits) return false;
  }
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

/** Copy the root onto a compacted coinbase. Rows stay off the wire. */
export function compactHashLedger(tx, row) {
  if (!tx || !row) return row;
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
  if (tx.hashAcceptedUnits != null && tx.hashAcceptedUnits !== '') {
    const n = asBi(tx.hashAcceptedUnits);
    if (n == null) return row;
    row.hashAcceptedUnits = n.toString();
  } else {
    delete row.hashAcceptedUnits;
  }
  return row;
}

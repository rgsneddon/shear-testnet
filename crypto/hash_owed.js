/**
 * Hash-bonus owed ledger. One rule for every producer.
 *
 * A block may mint at most MAX_HASH_UNITS_PER_BLOCK times the live unit.
 * Parent owed rows are paid first (oldest height, then noteCommit bytes).
 * This block's new credits then share whatever budget remains, pro-rata,
 * the same walk as retainedUnitsByCommit. Anything still unpaid and at
 * least the dust floor stays owed on this coinbase. Sub-dust nanos fold
 * into the public dust pot. Rows that do not fit in HASH_OWED_MAX_ENTRIES
 * sum into the public overflow total. Overflow is not burned and is not
 * paid to a different dest. Pot splits and the pool fee do not read this
 * ledger. Amounts stay BigInt so a value above 2^53 is not rounded.
 */
import {
  HASH_BONUS_NANOS,
  HASH_OWED_MAX_ENTRIES,
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

function parseRow(row, dust) {
  if (!row || typeof row !== 'object') return null;
  const noteCommit = buf32(row.noteCommit);
  const dest20 = buf20(row.dest20);
  const nanos = asBi(row.nanos);
  const since = asBi(row.sinceHeight);
  if (!noteCommit || !dest20 || nanos == null || since == null) return null;
  if (nanos <= 0n || nanos > MAX_U64 || since > BigInt(MAX_U32)) return null;
  if (nanos < dust) return null;
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

/** Absent is an empty ledger. A present list must already be canonical. */
export function hashOwedFromTx(tx, dust = hashOwedDustNanos()) {
  if (tx == null) return [];
  const raw = tx.hashOwed;
  if (raw == null || raw === '') return [];
  if (!Array.isArray(raw)) return null;
  const floor = typeof dust === 'bigint' ? dust : asBi(dust);
  if (floor == null || floor <= 0n) return null;
  if (raw.length > HASH_OWED_MAX_ENTRIES) return null;
  const rows = [];
  for (const item of raw) {
    const row = parseRow(item, floor);
    if (!row) return null;
    rows.push(row);
  }
  for (let i = 1; i < rows.length; i += 1) {
    if (cmpOwed(rows[i - 1], rows[i]) >= 0) return null;
  }
  return rows;
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

function jsonInt(n) {
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n);
  return n.toString();
}

export function writeHashLedger(tx, settled) {
  if (!tx || !settled) return tx;
  if (settled.owed && settled.owed.length) {
    tx.hashOwed = settled.owed.map((row) => {
      const out = {
        noteCommit: Buffer.from(row.noteCommit),
        dest20: Buffer.from(row.dest20),
        nanos: jsonInt(row.nanos),
        sinceHeight: row.sinceHeight,
      };
      if (row.admitBase && !emptyBase(row.admitBase)) out.admitBase = Buffer.from(row.admitBase);
      if (row.address) out.address = row.address;
      return out;
    });
  } else {
    delete tx.hashOwed;
  }
  if (settled.dust > 0n) tx.hashDustNanos = jsonInt(settled.dust);
  else delete tx.hashDustNanos;
  if (settled.overflow > 0n) tx.hashOwedOverflowNanos = jsonInt(settled.overflow);
  else delete tx.hashOwedOverflowNanos;
  return tx;
}

export function hashOwedDigestSuffix(tx) {
  const owed = hashOwedFromTx(tx);
  const dust = hashDustFromTx(tx);
  const overflow = hashOverflowFromTx(tx);
  if (owed == null || dust == null || overflow == null) return null;
  if (!owed.length && dust === 0n && overflow === 0n) return Buffer.alloc(0);
  const parts = [Buffer.from('hashowed1')];
  for (const row of owed) {
    parts.push(row.noteCommit);
    parts.push(row.dest20);
    parts.push(row.admitBase && !emptyBase(row.admitBase) ? row.admitBase : Buffer.alloc(32));
    parts.push(u64le(row.nanos));
    parts.push(u32le(row.sinceHeight));
  }
  parts.push(Buffer.from('hashdust1'), u64le(dust));
  parts.push(Buffer.from('hashover1'), u64le(overflow));
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
  const fail = (reason = 'hash_owed') => ({ ok: false, reason, pay: [], owed: [], dust: 0n, overflow: 0n, minted: 0n });
  const floor = dust == null ? hashOwedDustNanos(unit) : asBi(dust);
  const cap = maxEntries == null ? HASH_OWED_MAX_ENTRIES : Math.floor(Number(maxEntries));
  const unitBi = BigInt(hashBonusUnitNanos(unit));
  const limit = budget == null ? BigInt(MAX_HASH_UNITS_PER_BLOCK) * unitBi : asBi(budget);
  const h = asBi(height);
  if (floor == null || floor <= 0n || limit == null || limit < 0n || h == null || h > BigInt(MAX_U32)) return fail();
  if (!Number.isInteger(cap) || cap < 0) return fail();
  const blockHeight = Number(h);
  let dustAcc = asBi(dustIn);
  let overAcc = asBi(overflowIn);
  if (dustAcc == null || overAcc == null) return fail();
  if (overAcc > 0n && overAcc < floor) {
    dustAcc += overAcc;
    overAcc = 0n;
  }

  const parent = [];
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
    if (parsed.nanos < floor) dustAcc += parsed.nanos;
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
    + freshRows.reduce((n, row) => n + row.nanos, 0n)
    + dustAcc
    + overAcc;

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
    if (left >= floor && row.nanos > left && row.nanos - left < floor) {
      addPay(paid, row, left);
      dustAcc += row.nanos - left;
      left = 0n;
      continue;
    }
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
      if (unpaid >= floor) still.push(copyRow(row, unpaid, blockHeight));
      else if (unpaid > 0n) dustAcc += unpaid;
    } else if (row.nanos >= floor) {
      // A sub-dust slice stays on the owed row. Peeling it off would drop an above-dust credit.
      still.push(copyRow(row, row.nanos, blockHeight));
    } else if (row.nanos > 0n) {
      dustAcc += row.nanos;
    }
  }
  left -= spentFresh;
  void left;

  const merged = new Map();
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
    if (row.nanos >= floor) owedAll.push(row);
    else if (row.nanos > 0n) dustAcc += row.nanos;
  }
  owedAll.sort(cmpOwed);
  const owed = owedAll.slice(0, cap);
  for (const row of owedAll.slice(cap)) overAcc += row.nanos;

  const pay = [...paid.values()].sort((a, b) => cmpNoteCommit(a.noteCommit, b.noteCommit));
  const minted = pay.reduce((n, row) => n + row.nanos, 0n);
  const outSum = minted + owed.reduce((n, row) => n + row.nanos, 0n) + dustAcc + overAcc;
  if (outSum !== inSum) return fail();
  if (owed.length > cap) return fail();
  for (const row of owed) {
    if (row.nanos < floor) return fail();
  }
  return {
    ok: true,
    reason: '',
    pay,
    owed,
    dust: dustAcc,
    overflow: overAcc,
    minted,
  };
}

export function sameHashLedger(tx, settled, dust = hashOwedDustNanos()) {
  const owed = hashOwedFromTx(tx, dust);
  const dustGot = hashDustFromTx(tx);
  const overGot = hashOverflowFromTx(tx);
  if (owed == null || dustGot == null || overGot == null || !settled?.ok) return false;
  if (dustGot !== settled.dust || overGot !== settled.overflow) return false;
  if (owed.length !== settled.owed.length) return false;
  for (let i = 0; i < owed.length; i += 1) {
    const a = owed[i];
    const b = settled.owed[i];
    if (a.nanos !== b.nanos || a.sinceHeight !== b.sinceHeight) return false;
    if (!a.noteCommit.equals(b.noteCommit) || !a.dest20.equals(b.dest20)) return false;
    const aa = a.admitBase && !emptyBase(a.admitBase) ? a.admitBase : Buffer.alloc(0);
    const bb = b.admitBase && !emptyBase(b.admitBase) ? b.admitBase : Buffer.alloc(0);
    if (!aa.equals(bb)) return false;
  }
  return true;
}

export function hashLedgerIdle(settled, freshCount = 0) {
  if (!settled?.ok) return false;
  return freshCount === 0
    && settled.pay.length === 0
    && settled.owed.length === 0
    && settled.dust === 0n
    && settled.overflow === 0n
    && settled.minted === 0n;
}

/** Copy the ledger onto a compacted coinbase. Absent stays absent. */
export function compactHashLedger(tx, row) {
  if (!tx || !row) return row;
  const owed = hashOwedFromTx(tx);
  const dust = hashDustFromTx(tx);
  const overflow = hashOverflowFromTx(tx);
  if (owed == null || dust == null || overflow == null) return row;
  if (owed.length) {
    row.hashOwed = owed.map((item) => {
      const out = {
        noteCommit: Buffer.from(item.noteCommit),
        dest20: Buffer.from(item.dest20),
        nanos: jsonInt(item.nanos),
        sinceHeight: item.sinceHeight,
      };
      if (item.admitBase && !emptyBase(item.admitBase)) out.admitBase = Buffer.from(item.admitBase);
      return out;
    });
  }
  if (dust > 0n) row.hashDustNanos = jsonInt(dust);
  if (overflow > 0n) row.hashOwedOverflowNanos = jsonInt(overflow);
  return row;
}

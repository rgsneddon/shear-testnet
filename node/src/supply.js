/**
 * Circulating supply from public block totals, not from opened notes.
 * Permitted pot is the schedule. Permitted hash is the share-batch rule.
 * The commitment sum must match pot minted + that hash + the public fee.
 * An oversized hash changes the sum, so it cannot cancel out of the reconcile.
 */
import { decodeHeader } from '../../crypto/header.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import {
  MAGIC_TESTNET,
  HASH_BONUS_NANOS,
  hashBonusUnitNanos,
  MAX_SHARES_PER_BLOCK,
  MAX_HASH_UNITS_PER_BLOCK,
  SHARE_FLOOR_BITS,
} from '../../crypto/asert.js';
import { verifyMintSum, verifyRange, excessOf } from '../../crypto/note.js';
import { isDestAddress } from '../../crypto/address.js';
import { unpackShareBatch } from '../../crypto/pack.js';
import {
  unitsForShare,
  destOfShare,
  noteCommitOfShare,
  retainedUnitsByCommit,
  creditBitsForShare,
} from '../../crypto/share_batch.js';
import { canonicalCarry } from './chain.js';
import {
  freshForBlock,
  hashBudgetNanos,
  hashLedgerIdle,
  sameHashLedger,
  settleHashOwed,
} from '../../crypto/hash_owed.js';
import { bonusUnitsBefore } from '../../crypto/reserve_vault.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ZERO_32 = Buffer.alloc(32);

function safeNum(n) {
  if (typeof n !== 'bigint' || n < 0n || n > MAX_SAFE) return null;
  return Number(n);
}

function safeSigned(n) {
  if (typeof n !== 'bigint' || n > MAX_SAFE || n < -MAX_SAFE) return null;
  return Number(n);
}

function headerMs(block) {
  try {
    if (!block?.header) return null;
    const ts = Number(decodeHeader(Buffer.from(block.header)).timestamp);
    return Number.isSafeInteger(ts) && ts > 0 ? ts : null;
  } catch {
    return null;
  }
}

function asNonNeg(v) {
  if (typeof v === 'bigint') return v >= 0n && v <= MAX_SAFE ? v : null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = BigInt(v);
    return n <= MAX_SAFE ? n : null;
  }
  return null;
}

/** Fees on non-coinbase txs. That sum is the public levy, not an opened note. */
function publicLevy(block) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  let n = 0n;
  for (let i = 1; i < txs.length; i += 1) {
    const fee = txs[i]?.fee;
    if (fee == null || fee === '') continue;
    const v = asNonNeg(fee);
    if (v == null) return null;
    n += v;
    if (n > MAX_SAFE) return null;
  }
  return n;
}

function shareCounts(share) {
  try {
    const dest = destOfShare(share);
    if (dest && isDestAddress(dest)) return true;
  } catch { /* not a dest */ }
  try {
    const nc = noteCommitOfShare(share);
    return !!(nc && nc.length === 32 && !Buffer.from(nc).equals(ZERO_32));
  } catch {
    return false;
  }
}

/**
 * Consensus hash bonus for one block, without opening a note.
 * A non-empty batch credits retainedUnitsByCommit. Under the unit cap that
 * is 2^bits per share. Over the cap it is the pro-rata share of the cap.
 * An empty batch is not a finder-floor shortcut: a later block pays every
 * parent row the settlement names, and a pruned batch has no shares to sum.
 * The idle one-output finder floor is applied by the audit, which can see
 * the owed ledger. Missing bits on a present share are rejected.
 */
function permittedHash(block) {
  const unit = BigInt(hashBonusUnitNanos(HASH_BONUS_NANOS));
  let shares = [];
  try {
    shares = unpackShareBatch(Array.isArray(block?.shareBatch) ? block.shareBatch : []);
  } catch {
    return { ok: false, reason: 'hash_bonus', nanos: 0n };
  }
  if (!shares.length) return { ok: true, nanos: 0n, pruned: block?.samplesPruned === true };
  if (shares.length > MAX_SHARES_PER_BLOCK) {
    return { ok: false, reason: 'hash_bonus', nanos: 0n };
  }
  const seen = new Set();
  for (const share of shares) {
    if (!shareCounts(share)) return { ok: false, reason: 'hash_bonus', nanos: 0n };
    let nonce;
    try { nonce = BigInt(share?.nonce || 0).toString(); } catch {
      return { ok: false, reason: 'hash_bonus', nanos: 0n };
    }
    if (seen.has(nonce)) return { ok: false, reason: 'hash_bonus', nanos: 0n };
    seen.add(nonce);
    const credit = creditBitsForShare(share, SHARE_FLOOR_BITS, { strict: true });
    if (!credit.ok) return { ok: false, reason: 'hash_bonus', nanos: 0n };
  }
  let units = 0n;
  for (const u of retainedUnitsByCommit(shares).values()) units += BigInt(u);
  if (units > BigInt(MAX_HASH_UNITS_PER_BLOCK)) {
    return { ok: false, reason: 'hash_bonus', nanos: 0n };
  }
  return { ok: true, nanos: units * unit };
}

function rangeBound(vouts) {
  const rows = Array.isArray(vouts) ? vouts : [];
  for (const o of rows) {
    if (!o?.commit) return false;
    let pr;
    try {
      pr = o.rangeProof
        ? (Buffer.isBuffer(o.rangeProof) ? o.rangeProof : Buffer.from(o.rangeProof))
        : Buffer.alloc(0);
    } catch {
      return false;
    }
    if (!pr.length || !verifyRange(o.commit, pr)) return false;
  }
  return true;
}

function commitmentsMatch(vouts, total, excess) {
  const rows = Array.isArray(vouts) ? vouts : [];
  if (total < 0n || total > MAX_SAFE) return false;
  if (!rows.length) {
    if (total !== 0n) return false;
    if (excess == null || excess === '') return true;
    try {
      return Buffer.from(excess).equals(Buffer.from(excessOf([])));
    } catch {
      return false;
    }
  }
  if (!rangeBound(rows)) return false;
  return verifyMintSum(rows, Number(total), excess);
}

const U64 = 0xffffffffffffffffn;

function fitsU64(n) {
  return typeof n === 'bigint' && n >= 0n && n <= U64;
}

function copySupply(state) {
  return {
    height: Number(state.height) || 0,
    blockHash: state.blockHash ? Buffer.from(state.blockHash) : null,
    schedulePot: state.schedulePot,
    carry: state.carry,
    mintedPot: state.mintedPot,
    mintedHash: state.mintedHash,
    mintedLevy: state.mintedLevy,
    permittedHashAll: state.permittedHashAll,
    acceptedHash: state.acceptedHash,
    owedRows: state.owedRows.slice(),
    dust: state.dust,
    overflow: state.overflow,
    acceptedSeries: state.acceptedSeries.slice(),
    liveUnit: state.liveUnit,
    genesisMs: state.genesisMs,
    owedKnown: state.owedKnown !== false,
  };
}

/** Supply before genesis. Owed rows are known because there are none. */
export function emptySupplyState(genesisMs = 0) {
  const g = Number(genesisMs) || 0;
  return {
    height: 0,
    blockHash: null,
    schedulePot: 0n,
    carry: 0n,
    mintedPot: 0n,
    mintedHash: 0n,
    mintedLevy: 0n,
    permittedHashAll: 0n,
    acceptedHash: 0n,
    owedRows: [],
    dust: 0n,
    overflow: 0n,
    acceptedSeries: [],
    liveUnit: HASH_BONUS_NANOS,
    genesisMs: Number.isFinite(g) && g > 0 ? g : 0,
    owedKnown: true,
  };
}

/** Scalar snap plus the owed rows the caller still has. */
export function supplyFromScalar(scalar, {
  owedRows = [],
  acceptedSeries = [],
  owedKnown = false,
} = {}) {
  if (!scalar) return null;
  return {
    height: Number(scalar.height) || 0,
    blockHash: scalar.blockHash ? Buffer.from(scalar.blockHash) : null,
    schedulePot: BigInt(scalar.schedulePot || 0),
    carry: BigInt(scalar.carry || 0),
    mintedPot: BigInt(scalar.mintedPot || 0),
    mintedHash: BigInt(scalar.mintedHash || 0),
    mintedLevy: BigInt(scalar.mintedLevy || 0),
    permittedHashAll: BigInt(scalar.permittedHashAll || 0),
    acceptedHash: BigInt(scalar.acceptedHash || 0),
    owedRows: Array.isArray(owedRows) ? owedRows.slice() : [],
    dust: BigInt(scalar.dust || 0),
    overflow: BigInt(scalar.overflow || 0),
    acceptedSeries: Array.isArray(acceptedSeries) ? acceptedSeries.slice() : [],
    liveUnit: Number(scalar.liveUnit) || HASH_BONUS_NANOS,
    genesisMs: Number(scalar.genesisMs) || 0,
    owedKnown: owedKnown === true,
  };
}

/** `state` is the supply after `block`, not after its child. */
export function supplyLinks(state, block) {
  if (!state || !block) return false;
  const h = Number(block.height);
  if (!Number.isInteger(h) || h < 1 || Number(state.height) !== h) return false;
  if (!state.blockHash || !block.hash) return false;
  try {
    const a = Buffer.from(state.blockHash);
    const b = Buffer.from(block.hash);
    return a.length === 32 && b.length === 32 && a.equals(b);
  } catch {
    return false;
  }
}

/**
 * One block on top of a copied parent state.
 * A failure still applies the same accumulator updates as the public audit,
 * so a later reconcile sees the same first reason and the same difference.
 * The caller decides whether to stop.
 */
function accountBlock(prev, block, opts = {}) {
  const state = copySupply(prev);
  const ts = headerMs(block);
  if (!(ts > 0)) return { reason: 'header', state };
  const blockHeight = Number(opts.height) || Number(block?.height) || 0;
  // Height 1 is the genesis header. Its own timestamp is epoch 0, even when
  // a caller passes an earlier wall-clock genesisMs.
  const genesisMs = blockHeight === 1
    ? ts
    : (Number(state.genesisMs) > 0 ? Number(state.genesisMs) : (Number(opts.genesisMs) || ts));
  state.genesisMs = genesisMs;
  const permitted = potSubsidyAt({ nowMs: ts, genesisMs, magic: opts.magic || MAGIC_TESTNET });
  if (!Number.isSafeInteger(permitted) || permitted < 0) return { reason: 'pot_sched', state };
  const permittedBi = BigInt(permitted);
  state.schedulePot += permittedBi;
  const cb = Array.isArray(block?.txs) ? block.txs[0] : null;
  const carryOutN = canonicalCarry(cb);
  if (carryOutN == null) return { reason: 'pot_sched', state };
  const carryOut = BigInt(carryOutN);
  const potMinted = permittedBi + state.carry - carryOut;
  if (potMinted < 0n) return { reason: 'pot_sched', state };
  const hash = permittedHash(block);
  const levy = publicLevy(block);
  if (!hash.ok || levy == null) {
    state.carry = carryOut;
    return { reason: hash.reason || 'supply', state };
  }
  let shares = null;
  try {
    shares = unpackShareBatch(Array.isArray(block?.shareBatch) ? block.shareBatch : []);
  } catch {
    shares = null;
  }
  if (shares == null) {
    state.carry = carryOut;
    return { reason: 'hash_bonus', state };
  }
  const unit = hashBonusUnitNanos(opts.unit == null ? state.liveUnit : opts.unit);
  const tipHeight = Number(opts.tipHeight) > 0 ? Number(opts.tipHeight) : blockHeight;
  const gotFresh = freshForBlock(block, unit, tipHeight);
  if (!gotFresh.ok) {
    state.carry = carryOut;
    return { reason: 'hash_owed', state };
  }
  const fresh = gotFresh.fresh;
  const budget = hashBudgetNanos(state.acceptedSeries, unit);
  if (budget == null) {
    state.carry = carryOut;
    return { reason: 'hash_owed', state };
  }
  const settled = settleHashOwed({
    owedIn: state.owedRows,
    dustIn: state.dust,
    overflowIn: state.overflow,
    fresh,
    height: Number.isInteger(blockHeight) && blockHeight >= 0 ? blockHeight : 0,
    unit,
    budget,
  });
  if (!settled.ok || !sameHashLedger(cb, settled)) {
    state.carry = carryOut;
    return { reason: 'hash_owed', state };
  }
  const rowsOut = (settled.owed || []).concat(settled.owedRest || []);
  const parentIdle = state.owedRows.length === 0 && state.dust === 0n && state.overflow === 0n;
  const idle = parentIdle && hashLedgerIdle(settled, fresh.length);
  let mintedHashHere = settled.minted;
  const hashVouts = (cb?.vout || []).filter((o) => String(o?.kind || '') === 'hash');
  if (!shares.length && idle) {
    if (hashVouts.length === 0) mintedHashHere = 0n;
    else if (hashVouts.length === 1) mintedHashHere = BigInt(unitsForShare()) * BigInt(hashBonusUnitNanos(unit));
    else {
      state.carry = carryOut;
      return { reason: 'hash_bonus', state };
    }
  }
  const freshNanos = fresh.reduce((n, row) => n + row.nanos, 0n);
  state.acceptedHash += freshNanos + (mintedHashHere - settled.minted);
  state.permittedHashAll += mintedHashHere;
  state.owedRows = rowsOut.slice();
  state.acceptedSeries.push(settled.acceptedUnits == null ? 0n : settled.acceptedUnits);
  state.dust = settled.dust;
  state.overflow = settled.overflow;
  state.carry = carryOut;
  const publicTotal = potMinted + mintedHashHere + levy;
  if (!commitmentsMatch(cb?.vout || [], publicTotal, cb?.excess)) {
    return { reason: 'supply', state };
  }
  state.mintedPot += potMinted;
  state.mintedHash += mintedHashHere;
  state.mintedLevy += levy;
  state.liveUnit = unit;
  state.height = blockHeight;
  state.owedKnown = true;
  const hashBytes = opts.blockHash || block?.hash;
  state.blockHash = hashBytes ? Buffer.from(hashBytes) : state.blockHash;
  if (!fitsU64(state.schedulePot) || !fitsU64(state.carry) || !fitsU64(state.mintedPot)
    || !fitsU64(state.mintedHash) || !fitsU64(state.mintedLevy) || !fitsU64(state.permittedHashAll)
    || !fitsU64(state.acceptedHash) || !fitsU64(state.dust) || !fitsU64(state.overflow)) {
    return { reason: 'supply', state };
  }
  return { reason: '', state };
}

/**
 * O(block). `prev` is the parent supply. A missing parent is the caller's
 * `supply_state`. This step only accepts a block whose own accounts balance.
 */
export function supplyStep(prev, block, opts = {}) {
  if (!prev || prev.owedKnown === false) return { ok: false, reason: 'supply_state', state: null };
  const next = accountBlock(prev, block, opts);
  if (next.reason) return { ok: false, reason: next.reason, state: null };
  let outstanding = next.state.dust + next.state.overflow;
  for (const row of next.state.owedRows) outstanding += row.nanos;
  if (next.state.mintedHash + outstanding !== next.state.acceptedHash) {
    return { ok: false, reason: 'hash_owed', state: null };
  }
  const difference = next.state.mintedPot + next.state.mintedHash
    - next.state.schedulePot + next.state.carry - next.state.permittedHashAll;
  if (difference !== 0n) return { ok: false, reason: 'supply', state: null };
  return { ok: true, reason: '', state: next.state };
}

/** Fold a genesis-rooted list. One unit walk, then one step per block. */
export function foldSupply(blocks, opts = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const genesisMs = Number(opts.genesisMs) > 0 ? Number(opts.genesisMs) : (headerMs(list[0]) || 0);
  if (!list.length) return { ok: true, reason: '', state: emptySupplyState(genesisMs) };
  const units = opts.units || bonusUnitsBefore(list);
  if (!units) return { ok: false, reason: 'epoch_open', state: null };
  let tip = 0;
  for (let i = 0; i < list.length; i += 1) {
    const h = Number(list[i]?.height);
    if (Number.isInteger(h) && h > tip) tip = h;
  }
  if (!tip) tip = list.length;
  const tipHeight = Number(opts.tipHeight) > 0 ? Number(opts.tipHeight) : tip;
  let state = emptySupplyState(genesisMs);
  for (let i = 0; i < list.length; i += 1) {
    const h = Number(list[i]?.height) || (i + 1);
    const stepped = supplyStep(state, list[i], {
      magic: opts.magic,
      unit: units[i] == null ? HASH_BONUS_NANOS : units[i],
      tipHeight,
      height: h,
      genesisMs,
      blockHash: list[i]?.hash || null,
    });
    if (!stepped.ok) return stepped;
    state = stepped.state;
  }
  return { ok: true, reason: '', state };
}

/**
 * @returns {{
 *   status: 'verified' | 'mismatch',
 *   reason: string,
 *   circulatingNanos: number,
 *   measuredPotNanos: number,
 *   measuredHashNanos: number,
 *   measuredLevyNanos: number,
 *   schedulePotNanos: number,
 *   carryNanos: number,
 *   extraMintNanos: number,
 *   burnedNanos: number,
 *   differenceNanos: number,
 * }}
 */
export function auditCirculatingSupply(blocks, {
  magic = MAGIC_TESTNET,
  extraMintNanos = 0,
  burnedNanos = 0,
} = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const extra = asNonNeg(extraMintNanos) ?? 0n;
  const burned = asNonNeg(burnedNanos) ?? 0n;
  const blank = {
    status: 'mismatch',
    reason: 'supply',
    circulatingNanos: 0,
    measuredPotNanos: 0,
    measuredHashNanos: 0,
    measuredLevyNanos: 0,
    schedulePotNanos: 0,
    carryNanos: 0,
    hashOwedNanos: 0,
    hashDustNanos: 0,
    hashOwedOverflowNanos: 0,
    extraMintNanos: safeNum(extra) || 0,
    burnedNanos: safeNum(burned) || 0,
    differenceNanos: 0,
  };
  if (asNonNeg(extraMintNanos) == null || asNonNeg(burnedNanos) == null) return blank;
  if (!list.length) {
    const net = extra - burned;
    const shown = safeNum(net);
    if (shown == null) return blank;
    return {
      ...blank,
      status: 'verified',
      reason: '',
      circulatingNanos: shown,
      differenceNanos: 0,
    };
  }
  const genesisMs = headerMs(list[0]);
  if (!(genesisMs > 0)) return { ...blank, reason: 'genesis_ms' };

  let ok = true;
  let reason = '';
  const units = bonusUnitsBefore(list);
  if (!units) return { ...blank, reason: 'epoch_open' };
  let auditTip = 0;
  for (let i = 0; i < list.length; i += 1) {
    const h = Number(list[i]?.height);
    const n = Number.isInteger(h) ? h : i + 1;
    if (n > auditTip) auditTip = n;
  }
  let state = emptySupplyState(genesisMs);
  for (let bi = 0; bi < list.length; bi += 1) {
    const h = Number(list[bi]?.height);
    const next = accountBlock(state, list[bi], {
      magic,
      unit: units[bi] == null ? HASH_BONUS_NANOS : units[bi],
      tipHeight: auditTip,
      height: Number.isInteger(h) && h > 0 ? h : bi + 1,
      genesisMs,
      blockHash: list[bi]?.hash || null,
    });
    state = next.state;
    if (next.reason) {
      ok = false;
      reason = reason || next.reason;
    }
  }
  const mintedPot = state.mintedPot;
  const mintedHash = state.mintedHash;
  const mintedLevy = state.mintedLevy;
  const schedulePot = state.schedulePot;
  const permittedHashAll = state.permittedHashAll;
  const acceptedHash = state.acceptedHash;
  const carry = state.carry;
  const owedState = state.owedRows;
  const dustState = state.dust;
  const overflowState = state.overflow;
  let outstanding = dustState + overflowState;
  for (const row of owedState) outstanding += row.nanos;
  if (mintedHash + outstanding !== acceptedHash) {
    ok = false;
    reason = reason || 'hash_owed';
  }

  const circulating = mintedPot + mintedHash + extra - burned;
  const expected = schedulePot - carry + permittedHashAll + extra - burned;
  const difference = circulating - expected;
  if (difference !== 0n) {
    ok = false;
    reason = reason || 'supply';
  }
  const nums = {
    circulatingNanos: safeNum(circulating),
    measuredPotNanos: safeNum(mintedPot),
    measuredHashNanos: safeNum(mintedHash),
    measuredLevyNanos: safeNum(mintedLevy),
    schedulePotNanos: safeNum(schedulePot),
    carryNanos: safeNum(carry),
    hashOwedNanos: safeNum(owedState.reduce((n, row) => n + row.nanos, 0n)),
    hashDustNanos: safeNum(dustState),
    hashOwedOverflowNanos: safeNum(overflowState),
    extraMintNanos: safeNum(extra),
    burnedNanos: safeNum(burned),
    differenceNanos: safeSigned(difference),
  };
  if (Object.values(nums).some((n) => n == null || !Number.isSafeInteger(n))) {
    return { ...blank, reason: reason || 'supply' };
  }
  return {
    status: ok ? 'verified' : 'mismatch',
    reason: ok ? '' : (reason || 'supply'),
    ...nums,
  };
}

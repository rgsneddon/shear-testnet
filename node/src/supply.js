/**
 * Circulating supply from public block totals, not from opened notes.
 * Permitted pot is the schedule. Permitted hash is the share-batch rule.
 * The commitment sum must match pot minted + that hash + the public fee.
 * An oversized hash changes the sum, so it cannot cancel out of the reconcile.
 */
import { createHash } from 'node:crypto';
import { decodeHeader } from '../../crypto/header.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import {
  MAGIC_TESTNET,
  HASH_BONUS_NANOS,
  hashBonusUnitNanos,
  MAX_SHARES_PER_BLOCK,
  MAX_HASH_UNITS_PER_BLOCK,
  SHARE_FLOOR_BITS,
  RESERVE_PROGRAM,
} from '../../crypto/asert.js';
import { verifyMintSum, verifyRange, excessOf, noteCommitOfDest20 } from '../../crypto/note.js';
import { nativeLoaded } from '../../crypto/native_admit.js';
import { canonicalBLeaf, derivedBLeaves, sameBLeaves } from '../../crypto/clearing.js';
import { unpackShareBatch } from '../../crypto/pack.js';
import {
  unitsForShare,
  accountShareUnits,
  creditBitsForShare,
} from '../../crypto/share_batch.js';
import { canonicalCarry } from './chain.js';
import {
  freshForBlock,
  spillForBlock,
  hashBudgetNanos,
  hashLedgerIdle,
  sameHashLedger,
  settleHashOwed,
} from '../../crypto/hash_owed.js';
import {
  bonusUnitsBefore,
  blockWithdrawInterest,
  emptyVault,
  cloneVault,
  applyReserveBlock,
  txIsReserveAction,
} from '../../crypto/reserve_vault.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

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

export function blockNeedsReserve(block) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  for (const tx of txs) {
    if (!tx || tx.coinbase) continue;
    if (String(tx.programId || '') !== RESERVE_PROGRAM) continue;
    if (txIsReserveAction(tx)) return true;
  }
  return false;
}

/** Vault after `block`, or null when this block does not touch a vault. */
export function vaultAfterBlock(vault, block) {
  if (!vault && !blockNeedsReserve(block)) return { ok: true, vault: null };
  if (vault && vault.blankFork) return { ok: false, vault: null };
  const next = vault ? cloneVault(vault) : emptyVault();
  const applied = applyReserveBlock({
    state: next,
    block,
    nowMs: headerMs(block) || 0,
  });
  if (!applied || applied.ok !== true) return { ok: false, vault: null };
  return { ok: true, vault: next };
}

/**
 * Parent vault for `blocks[index]`. Null when the list has no reserve tx.
 * Null when a prefix apply fails. An empty vault is the parent of the first
 * reserve block, and is not null.
 */
export function vaultBefore(blocks, index) {
  const list = Array.isArray(blocks) ? blocks : [];
  let needs = false;
  for (let i = 0; i < list.length; i += 1) {
    if (blockNeedsReserve(list[i])) { needs = true; break; }
  }
  if (!needs) return null;
  const end = Math.max(0, Math.min(Number(index) || 0, list.length));
  let vault = emptyVault();
  for (let i = 0; i < end; i += 1) {
    const applied = applyReserveBlock({
      state: vault,
      block: list[i],
      nowMs: headerMs(list[i]) || 0,
    });
    if (!applied || applied.ok !== true) return null;
  }
  return vault;
}

/** `{ ok, vault }` so a failed prefix is not the same as a coinbase-only list. */
export function vaultParent(blocks, index) {
  const list = Array.isArray(blocks) ? blocks : [];
  const vault = vaultBefore(list, index);
  if (vault) return { ok: true, vault };
  for (let i = 0; i < list.length; i += 1) {
    if (blockNeedsReserve(list[i])) return { ok: false, vault: null };
  }
  return { ok: true, vault: null };
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

function leafHex(leaf) {
  try {
    if (leaf?.noteCommit) {
      const b = Buffer.from(leaf.noteCommit);
      if (b.length === 32 && !b.equals(Buffer.alloc(32))) return b.toString('hex');
    }
  } catch { /* dest20 below */ }
  try {
    if (leaf?.dest20) {
      const d = Buffer.from(leaf.dest20);
      if (d.length === 20) return noteCommitOfDest20(d).toString('hex');
    }
  } catch { /* no commit */ }
  return '';
}

/**
 * Consensus hash bonus for one block, without opening a note.
 * A non-empty batch uses accountShareUnits. Rows with no noteCommit occupy
 * the cap and are not leaves. Bound rows keep the room that occupancy leaves.
 * Under that room the credit is 2^bits per share. Over it, the credit is the
 * pro-rata share of the room. An empty batch is not a finder-floor shortcut.
 * The idle one-output finder floor is applied by the audit, which can see
 * the owed ledger. Missing bits on a present share are rejected.
 * Occupancy above the cap is hash_bonus.
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
    let nonce;
    try { nonce = BigInt(share?.nonce || 0).toString(); } catch {
      return { ok: false, reason: 'hash_bonus', nanos: 0n };
    }
    if (seen.has(nonce)) return { ok: false, reason: 'hash_bonus', nanos: 0n };
    seen.add(nonce);
    const credit = creditBitsForShare(share, SHARE_FLOOR_BITS, { strict: true });
    if (!credit.ok) return { ok: false, reason: 'hash_bonus', nanos: 0n };
  }
  const account = accountShareUnits(shares);
  if (!account.ok) return { ok: false, reason: 'hash_bonus', nanos: 0n };
  return { ok: true, nanos: BigInt(account.units) * unit, account };
}

/**
 * V8 Set and Map throw RangeError at 2^24 entries. This cache only skips a
 * repeat of a proof this process already accepted. It is not the history.
 * 2^20 is sixteen times under that limit, for any chain length and any
 * output count. Oldest keys leave first.
 */
export const RANGE_VERIFIED_CAP = 2 ** 20;
const RANGE_VERIFIED_HARD_MAX = 2 ** 24 - 1;

const rangeVerified = new Set();
const rangeOrder = [];
let rangeCursor = 0;
let rangeVerifyCalls = 0;
let rangeInserts = 0;

/** How many coinbase range proofs this process actually verified. A repeat of the same bytes does not add. */
export function coinbaseRangeVerifies() {
  return rangeVerifyCalls;
}

/** Keys retained. Never above RANGE_VERIFIED_CAP. */
export function rangeVerifiedSize() {
  return rangeVerified.size;
}

/** New keys recorded. A hit does not add. */
export function rangeVerifiedInserts() {
  return rangeInserts;
}

/**
 * Record a proof the caller already verified. A full cache drops the oldest
 * key. An engine RangeError stays inside this function: the verdict already
 * stands, and a cache miss on the next call re-verifies.
 */
export function rememberVerifiedRange(key) {
  if (typeof key !== 'string' || key.length === 0) return;
  if (rangeVerified.has(key)) return;
  if (rangeVerified.size >= RANGE_VERIFIED_HARD_MAX) return;
  let replaced = null;
  if (rangeVerified.size >= RANGE_VERIFIED_CAP) {
    replaced = rangeOrder[rangeCursor];
    rangeVerified.delete(replaced);
  }
  try {
    rangeVerified.add(key);
  } catch (err) {
    if (replaced != null && !rangeVerified.has(replaced)) rangeVerified.add(replaced);
    if (err instanceof RangeError) return;
    throw err;
  }
  if (replaced != null) {
    rangeOrder[rangeCursor] = key;
    rangeCursor += 1;
    if (rangeCursor === RANGE_VERIFIED_CAP) rangeCursor = 0;
  } else {
    rangeOrder.push(key);
  }
  rangeInserts += 1;
}

function rangeKey(commit, proof) {
  return createHash('sha256').update(Buffer.from(commit)).update(proof).digest('hex');
}

function rangeBound(vouts, remember) {
  const rows = Array.isArray(vouts) ? vouts : [];
  for (const o of rows) {
    if (!o?.commit) return false;
    let pr;
    let commit;
    try {
      commit = Buffer.from(o.commit);
      pr = o.rangeProof
        ? (Buffer.isBuffer(o.rangeProof) ? o.rangeProof : Buffer.from(o.rangeProof))
        : Buffer.alloc(0);
    } catch {
      return false;
    }
    if (!pr.length || commit.length !== 32) return false;
    const key = rangeKey(commit, pr);
    if (rangeVerified.has(key)) continue;
    rangeVerifyCalls += 1;
    if (!verifyRange(commit, pr)) return false;
    if (remember) rememberVerifiedRange(key);
  }
  return true;
}

function commitmentsMatch(vouts, total, excess, remember) {
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
  if (!rangeBound(rows, remember)) return false;
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
    mintedInterest: typeof state.mintedInterest === 'bigint' ? state.mintedInterest : 0n,
    permittedInterest: typeof state.permittedInterest === 'bigint' ? state.permittedInterest : 0n,
    bLocked: typeof state.bLocked === 'bigint' ? state.bLocked : 0n,
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
    mintedInterest: 0n,
    permittedInterest: 0n,
    bLocked: 0n,
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

/** Interest already on a live state. A 12-u64 snap omits both fields. */
function carriedInterest(scalar, key) {
  if (!scalar || !Object.prototype.hasOwnProperty.call(scalar, key)) return 0n;
  const raw = scalar[key];
  if (raw == null || raw === '') return 0n;
  try {
    const n = typeof raw === 'bigint' ? raw : BigInt(raw);
    return n >= 0n && n <= U64 ? n : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Replay withdraw interest onto snap rows. The 12-u64 snap does not store it.
 * `rows[i]` is the supply after `blocks[i]`. A miss is not published.
 */
export function fillSnapInterest(rows, blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const snaps = Array.isArray(rows) ? rows : [];
  if (!snaps.length || snaps.length !== list.length) return { ok: false, reason: 'supply_state' };
  let vault = null;
  let interest = 0n;
  for (let i = 0; i < list.length; i += 1) {
    const row = snaps[i];
    if (!row) return { ok: false, reason: 'supply_state' };
    const ts = headerMs(list[i]);
    if (!(ts > 0)) return { ok: false, reason: 'header' };
    const got = blockWithdrawInterest(vault, list[i], ts);
    if (!got.ok) return { ok: false, reason: got.reason || 'supply' };
    interest += got.nanos;
    if (interest > U64) return { ok: false, reason: 'supply' };
    row.mintedInterest = interest;
    row.permittedInterest = interest;
    const advanced = vaultAfterBlock(vault, list[i]);
    if (!advanced.ok) return { ok: false, reason: 'supply' };
    vault = advanced.vault;
  }
  return { ok: true, reason: '' };
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
    mintedInterest: carriedInterest(scalar, 'mintedInterest'),
    permittedInterest: carriedInterest(scalar, 'permittedInterest'),
    bLocked: BigInt(scalar.bLocked || 0),
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

/** Consensus supply for `block` when this state is that block's own account. */
export function publishedSupply(state, block) {
  if (!block || !state || state.owedKnown === false || !supplyLinks(state, block)) return null;
  return copySupply(state);
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
 * B value locked by a debit and not yet drawn by a b-spend.
 * A published leaf list that is not that debit is b_leaves.
 * A draw that the commitments do not bind, or that exceeds the lock, is supply.
 * Returns '' when the term updated.
 */
function accountBLocked(state, block) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const got = derivedBLeaves(txs);
  if (!got.ok) return got.reason || 'b_debit';
  if (Array.isArray(block?.bLeaves) && !sameBLeaves(block.bLeaves, got.leaves)) return 'b_leaves';
  let created = 0n;
  for (const leaf of got.leaves) {
    created += BigInt(leaf.unit);
    if (created > MAX_SAFE) return 'supply';
  }
  let spent = 0n;
  for (let i = 1; i < txs.length; i += 1) {
    const tx = txs[i];
    if (String(tx?.kind || '') !== 'b-spend') continue;
    const leaf = canonicalBLeaf(tx);
    if (!leaf) return 'supply';
    if (!tx.excess || !verifyMintSum(tx.vout || [], leaf.unit, tx.excess)) return 'supply';
    spent += BigInt(leaf.unit);
    if (spent > MAX_SAFE) return 'supply';
  }
  const prior = typeof state.bLocked === 'bigint' ? state.bLocked : 0n;
  if (prior + created < spent) return 'supply';
  state.bLocked = prior + created - spent;
  return '';
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
  // Height 1 is the genesis header. assessHeader anchors the pot on that
  // timestamp, so supply must too. A caller genesisMs must not move it.
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
  if (shares.length && hash.account && Array.isArray(block?.aLeaves) && block.aLeaves.length) {
    const seen = new Set();
    for (const leaf of block.aLeaves) {
      const count = Math.floor(Number(leaf?.count) || 0);
      if (count <= 0) continue;
      const hex = leafHex(leaf);
      if (!hex || (hash.account.retained.get(hex) || 0) !== count) {
        state.carry = carryOut;
        return { reason: 'hash_bonus', state };
      }
      seen.add(hex);
    }
    for (const [hex, kept] of hash.account.retained) {
      if (kept > 0 && !seen.has(hex)) {
        state.carry = carryOut;
        return { reason: 'hash_bonus', state };
      }
    }
  }
  const tipHeight = Number(opts.tipHeight) > 0 ? Number(opts.tipHeight) : blockHeight;
  const gotFresh = freshForBlock(block, unit, tipHeight);
  if (!gotFresh.ok) {
    state.carry = carryOut;
    return { reason: 'hash_owed', state };
  }
  const gotSpill = spillForBlock(block, unit, tipHeight);
  if (!gotSpill.ok) {
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
    spill: gotSpill.fresh,
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
  const spillNanos = (gotSpill.fresh || []).reduce((n, row) => n + row.nanos, 0n);
  // Spill is proven work entering the owed map on this block. It stays out of
  // acceptedUnits, so the hash budget does not move. Minted plus still-owed
  // has to equal accepted hash, so the witness is ingress.
  state.acceptedHash += freshNanos + spillNanos + (mintedHashHere - settled.minted);
  state.permittedHashAll += mintedHashHere;
  state.owedRows = rowsOut.slice();
  state.acceptedSeries.push(settled.acceptedUnits == null ? 0n : settled.acceptedUnits);
  state.dust = settled.dust;
  state.overflow = settled.overflow;
  state.carry = carryOut;
  const publicTotal = potMinted + mintedHashHere + levy;
  const rememberRange = opts.rememberRange !== false;
  if (!commitmentsMatch(cb?.vout || [], publicTotal, cb?.excess, rememberRange)) {
    return { reason: 'supply', state };
  }
  const interest = blockWithdrawInterest(opts.vault, block, ts);
  if (!interest.ok) return { reason: interest.reason || 'supply', state };
  if (state.mintedInterest + interest.nanos > U64) return { reason: 'supply', state };
  if (state.permittedInterest + interest.nanos > U64) return { reason: 'supply', state };
  state.mintedPot += potMinted;
  state.mintedHash += mintedHashHere;
  state.mintedLevy += levy;
  state.mintedInterest += interest.nanos;
  state.permittedInterest += interest.nanos;
  const bReason = accountBLocked(state, block);
  if (bReason) return { reason: bReason, state };
  state.liveUnit = unit;
  state.height = blockHeight;
  state.owedKnown = true;
  const hashBytes = opts.blockHash || block?.hash;
  state.blockHash = hashBytes ? Buffer.from(hashBytes) : state.blockHash;
  if (!fitsU64(state.schedulePot) || !fitsU64(state.carry) || !fitsU64(state.mintedPot)
    || !fitsU64(state.mintedHash) || !fitsU64(state.mintedLevy) || !fitsU64(state.bLocked)
    || !fitsU64(state.mintedInterest) || !fitsU64(state.permittedInterest)
    || !fitsU64(state.permittedHashAll)
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
  if (next.state.mintedInterest !== next.state.permittedInterest) {
    return { ok: false, reason: 'supply', state: null };
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
  let vault = null;
  for (let i = 0; i < list.length; i += 1) {
    const h = Number(list[i]?.height) || (i + 1);
    const stepped = supplyStep(state, list[i], {
      magic: opts.magic,
      unit: units[i] == null ? HASH_BONUS_NANOS : units[i],
      tipHeight,
      height: h,
      genesisMs,
      blockHash: list[i]?.hash || null,
      vault,
    });
    if (!stepped.ok) return stepped;
    state = stepped.state;
    const advanced = vaultAfterBlock(vault, list[i]);
    if (!advanced.ok) return { ok: false, reason: 'supply', state: null };
    vault = advanced.vault;
  }
  return { ok: true, reason: '', state };
}

/** Public numbers for one supply state. No range proof is opened. */
export function supplyReport(state, opts = {}) {
  const burnedIn = Object.prototype.hasOwnProperty.call(opts, 'burnedNanos') ? opts.burnedNanos : 0;
  const claimPresent = Object.prototype.hasOwnProperty.call(opts, 'extraMintNanos');
  const ok = opts.ok !== false;
  const reason = opts.reason || '';
  const burned = asNonNeg(burnedIn);
  const claim = claimPresent ? asNonNeg(opts.extraMintNanos) : null;
  const chainExtra = state && typeof state.mintedInterest === 'bigint' ? state.mintedInterest : 0n;
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
    extraMintNanos: 0,
    burnedNanos: 0,
    bLockedNanos: 0,
    differenceNanos: 0,
  };
  if (burned == null || !state) return { ...blank, reason: reason || 'supply' };
  if (claimPresent && claim == null) return { ...blank, reason: 'supply' };
  let reportOk = ok;
  let reportReason = reason;
  if (claimPresent && claim !== chainExtra) {
    reportOk = false;
    reportReason = reportReason || 'supply';
  }
  const mintedPot = state.mintedPot;
  const mintedHash = state.mintedHash;
  const mintedLevy = state.mintedLevy;
  const schedulePot = state.schedulePot;
  const permittedHashAll = state.permittedHashAll;
  const acceptedHash = state.acceptedHash;
  const carry = state.carry;
  const owedState = state.owedRows || [];
  const dustState = state.dust;
  const overflowState = state.overflow;
  let outstanding = dustState + overflowState;
  for (const row of owedState) outstanding += row.nanos;
  if (mintedHash + outstanding !== acceptedHash) {
    reportOk = false;
    reportReason = reportReason || 'hash_owed';
  }
  const circulating = mintedPot + mintedHash + chainExtra - burned;
  const expected = schedulePot - carry + permittedHashAll + chainExtra - burned;
  const difference = circulating - expected;
  if (difference !== 0n) {
    reportOk = false;
    reportReason = reportReason || 'supply';
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
    extraMintNanos: safeNum(chainExtra),
    burnedNanos: safeNum(burned),
    bLockedNanos: safeNum(state.bLocked),
    differenceNanos: safeSigned(difference),
  };
  if (Object.values(nums).some((n) => n == null || !Number.isSafeInteger(n))) {
    return { ...blank, reason: reportReason || 'supply' };
  }
  return {
    status: reportOk ? 'verified' : 'mismatch',
    reason: reportOk ? '' : (reportReason || 'supply'),
    ...nums,
  };
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
export function auditCirculatingSupply(blocks, opts = {}) {
  const magic = opts.magic == null ? MAGIC_TESTNET : opts.magic;
  const burnedIn = Object.prototype.hasOwnProperty.call(opts, 'burnedNanos') ? opts.burnedNanos : 0;
  const claimPresent = Object.prototype.hasOwnProperty.call(opts, 'extraMintNanos');
  const burned = asNonNeg(burnedIn);
  const claim = claimPresent ? asNonNeg(opts.extraMintNanos) : 0n;
  const list = Array.isArray(blocks) ? blocks : [];
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
    extraMintNanos: 0,
    burnedNanos: safeNum(burned) || 0,
    bLockedNanos: 0,
    differenceNanos: 0,
  };
  if (burned == null || (claimPresent && claim == null)) return blank;
  if (!list.length) {
    if (claimPresent && claim !== 0n) return blank;
    const net = 0n - burned;
    const shown = safeNum(net);
    if (shown == null) return blank;
    return {
      ...blank,
      status: 'verified',
      reason: '',
      circulatingNanos: shown,
      burnedNanos: safeNum(burned) || 0,
      differenceNanos: 0,
    };
  }
  const genesisMs = headerMs(list[0]);
  if (!(genesisMs > 0)) return { ...blank, reason: 'genesis_ms' };
  if (!nativeLoaded()) {
    return {
      ...blank,
      status: 'unverifiable',
      reason: 'unverifiable',
      circulatingNanos: null,
      measuredPotNanos: null,
      measuredHashNanos: null,
      measuredLevyNanos: null,
      schedulePotNanos: null,
      carryNanos: null,
      hashOwedNanos: null,
      hashDustNanos: null,
      hashOwedOverflowNanos: null,
      extraMintNanos: null,
      burnedNanos: null,
      bLockedNanos: null,
      differenceNanos: null,
    };
  }

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
  let vault = null;
  for (let bi = 0; bi < list.length; bi += 1) {
    const h = Number(list[bi]?.height);
    const next = accountBlock(state, list[bi], {
      magic,
      unit: units[bi] == null ? HASH_BONUS_NANOS : units[bi],
      tipHeight: auditTip,
      height: Number.isInteger(h) && h > 0 ? h : bi + 1,
      genesisMs,
      blockHash: list[bi]?.hash || null,
      rememberRange: false,
      vault,
    });
    state = next.state;
    if (next.reason) {
      ok = false;
      reason = reason || next.reason;
      const broken = emptyVault();
      broken.blankFork = true;
      vault = broken;
    } else {
      const advanced = vaultAfterBlock(vault, list[bi]);
      if (!advanced.ok) {
        ok = false;
        reason = reason || 'supply';
        const broken = emptyVault();
        broken.blankFork = true;
        vault = broken;
      } else {
        vault = advanced.vault;
      }
    }
  }
  const reportOpts = { burnedNanos: burnedIn, ok, reason };
  if (claimPresent) reportOpts.extraMintNanos = opts.extraMintNanos;
  return supplyReport(state, reportOpts);
}

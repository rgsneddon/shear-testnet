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
import { verifyMintSum, verifyRange, excessOf, noteCommitOfDest20, asU8, verifiedInputNanos, verifyFlowConservation } from '../../crypto/note.js';
import { publicReserveReceipt, publicReceiptNanos } from '../../crypto/dummy.js';
import { nativeLoaded } from '../../crypto/native_admit.js';
import { canonicalBLeaf, derivedBLeaves, sameBLeaves } from '../../crypto/clearing.js';
import { unpackShareBatch } from '../../crypto/pack.js';
import {
  unitsForShare,
  accountShareUnits,
  creditBitsForShare,
  shareWorkKey,
} from '../../crypto/share_batch.js';
import { canonicalCarry } from './chain.js';
import { BLUNOTE_WINNERS, decodeRecord, drawPieces } from '../../crypto/blunote.js';
import { splitLevy } from '../../crypto/levy.js';
import {
  freshForBlock,
  spillForBlock,
  hashBudgetNanos,
  hashLedgerIdle,
  sameHashLedger,
  settleHashOwed,
} from '../../crypto/hash_owed.js';
import {
  supplyUnits,
  unitsAlongChain,
  blockWithdrawInterest,
  blockPermittedInterest,
  stakeRewardSupply,
  supplyIdentity,
  emptyVault,
  cloneVault,
  applyReserveBlock,
  txIsReserveAction,
  reserveAction,
  lockNotePrincipal,
  releasedWithdrawPrincipal,
} from '../../crypto/reserve_vault.js';
import { reserveApplyFields, windowBlocksFor } from '../../crypto/reserve_oracle.js';
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
    if (String(tx?.kind || tx?.vout?.[0]?.kind || '') === 'reward-claim') return true;
  }
  const cb = txs.find((tx) => tx?.coinbase);
  if (cb?.rewardRoot) return true;
  return false;
}

/** Vault after `block`, or null when this block does not touch a vault. */
function vaultApply(state, block, prior, applyOpts = {}) {
  const parent = prior?.length ? prior[prior.length - 1] : null;
  return applyReserveBlock({
    state,
    ...reserveApplyFields({
      prior,
      block,
      magic: applyOpts.magic || MAGIC_TESTNET,
      parentMs: parent ? headerMs(parent) || 0 : 0,
      genesisMs: headerMs(prior?.[0] || block) || 0,
      nowMs: headerMs(block) || 0,
    }),
    requireStakeReward: applyOpts.requireStakeReward === true,
  });
}

/**
 * Prior the oracle and the genesis clock need.
 * A report outside the last `windowBlocksFor(magic)` blocks does not count.
 * The genesis header stays at index 0 so the clock does not move.
 */
function priorForOracle(list, index, magic) {
  const i = Math.max(0, Math.floor(Number(index) || 0));
  if (i <= 0 || !Array.isArray(list) || !list.length) return [];
  const cap = windowBlocksFor(magic);
  const width = Number.isInteger(cap) && cap > 0 ? cap : list.length;
  const start = Math.max(0, i - width);
  const window = list.slice(start, i);
  if (start === 0) return window;
  return [list[0], ...window];
}

function asLocked(value) {
  if (typeof value === 'bigint') return value > 0n ? value : 0n;
  const n = Math.floor(Number(value) || 0);
  if (!Number.isSafeInteger(n) || n <= 0) return 0n;
  return BigInt(n);
}

function vaultLockedNanos(vault) {
  if (!vault || vault.blankFork) return 0n;
  return asLocked(vault.totalLockedNanos);
}

/** Interest minted into the mint bank or a claimable leaf and not yet withdrawn. */
function vaultAccruedNanos(vault) {
  if (!vault || vault.blankFork) return 0n;
  let n = asLocked(vault.mintBankNanos);
  for (const portal of Object.values(vault.portals || {})) {
    n += asLocked(portal?.claimableRewards);
  }
  return n;
}

function openedLockNanos(tx) {
  if (!tx || tx.coinbase || String(tx.kind || '') !== 'lock') return 0n;
  if (publicReserveReceipt(tx)) return publicReceiptNanos(tx);
  const noted = lockNotePrincipal(tx);
  if (noted > 0n) return noted;
  const act = reserveAction(tx);
  if (!act || act.opened === false) return 0n;
  return asLocked(act.nanos);
}

/**
 * A lock input pays a note when 113's predicate says it is not a public
 * receipt, and the verified openings on its inputs cover the lock.
 * The openings are read in note.js. This file does not touch them.
 */
/**
 * A hidden π leaf does not open each input. The fund proof says the lock
 * commitment is π, and the FS-1 excess says the spent notes cover that
 * commitment plus the fee. That is a note payment, not a bare credit.
 */
function fs1NotePaysLock(tx, need) {
  if (need <= 0n) return false;
  if (tx?.fs1 == null || tx.fs1 === '' || !tx?.excess) return false;
  if (lockNotePrincipal(tx) !== need) return false;
  return verifyFlowConservation(tx);
}

function vinPaysNote(tx) {
  if (publicReserveReceipt(tx)) return false;
  const need = openedLockNanos(tx);
  if (need <= 0n) return false;
  let opened = 0n;
  for (const v of Array.isArray(tx?.vin) ? tx.vin : []) {
    const n = verifiedInputNanos(v);
    if (n == null) continue;
    opened += n;
  }
  if (opened >= need) return true;
  return fs1NotePaysLock(tx, need);
}

/**
 * Lock principal this block opens. Note-paid means the input spends a note.
 * A dest20 receipt, including a public reserve receipt, is bare.
 */
function lockPrincipalSplit(block) {
  let note = 0n;
  let bare = 0n;
  for (const tx of block?.txs || []) {
    const n = openedLockNanos(tx);
    if (n <= 0n) continue;
    if (vinPaysNote(tx)) note += n;
    else bare += n;
  }
  return { note, bare };
}

/**
 * Principal an opened withdraw releases. An indexed receipt is principal
 * plus the arrival stub; the stub is minted interest, not principal.
 * Without a parent vault the receipt total is used, and the cross-check fails closed.
 */
function openedWithdrawPrincipal(block, vault = null, nowMs = null) {
  let n = 0n;
  for (const tx of block?.txs || []) {
    if (!tx || tx.coinbase) continue;
    const act = reserveAction(tx);
    if (!act || act.kind !== 'withdraw' || act.opened === false) continue;
    const released = vault ? releasedWithdrawPrincipal(vault, tx, nowMs) : null;
    n += released == null ? asLocked(act.nanos) : released;
  }
  return n;
}

/**
 * Note-backed principal is note-paid lock inputs, not the vault delta.
 * A withdraw spends note-backed principal first. A vault credit above
 * those inputs is unfunded and is not moved into the note term.
 */
export function rollVaultSupply(track, beforeLocked, afterLocked, block) {
  let note = asLocked(track?.noteBacked);
  let bare = asLocked(track?.unfunded);
  const before = asLocked(beforeLocked);
  const after = asLocked(afterLocked);
  const delta = after - before;
  const split = lockPrincipalSplit(block);
  if (delta > 0n) {
    note += split.note;
    bare += split.bare;
  } else if (delta < 0n) {
    const withdrawn = openedWithdrawPrincipal(block);
    let drop = withdrawn > 0n ? withdrawn : -delta;
    const fromNotes = note < drop ? note : drop;
    note -= fromNotes;
    drop -= fromNotes;
    const fromBare = bare < drop ? bare : drop;
    bare -= fromBare;
  }
  return { noteBacked: note, unfunded: bare };
}

export function vaultAfterBlock(vault, block, prior = [], applyOpts = {}) {
  if (!vault && !blockNeedsReserve(block)) return { ok: true, vault: null };
  if (vault && vault.blankFork) return { ok: false, vault: null };
  const next = vault ? cloneVault(vault) : emptyVault();
  if (applyOpts.magic) next.magic = applyOpts.magic;
  const applied = vaultApply(next, block, prior, applyOpts);
  if (!applied || applied.ok !== true) return { ok: false, vault: null };
  return { ok: true, vault: next };
}

/**
 * Parent vault for `blocks[index]`. Null when the list has no reserve tx.
 * Null when a prefix apply fails. An empty vault is the parent of the first
 * reserve block, and is not null. `magic` is the book's: a note lock's π
 * proof binds txDigestV3 at that magic, so a vault rebuilt at another magic
 * refuses an honest lock (reorg and supply carry run through here).
 */
export function vaultBefore(blocks, index, magic = MAGIC_TESTNET) {
  const list = Array.isArray(blocks) ? blocks : [];
  let needs = false;
  for (let i = 0; i < list.length; i += 1) {
    if (blockNeedsReserve(list[i])) { needs = true; break; }
  }
  if (!needs) return null;
  const end = Math.max(0, Math.min(Number(index) || 0, list.length));
  let vault = emptyVault();
  vault.magic = magic;
  for (let i = 0; i < end; i += 1) {
    const applied = vaultApply(vault, list[i], priorForOracle(list, i, magic), { magic });
    if (!applied || applied.ok !== true) return null;
  }
  return vault;
}

/** `{ ok, vault }` so a failed prefix is not the same as a coinbase-only list. */
export function vaultParent(blocks, index, magic = MAGIC_TESTNET) {
  const list = Array.isArray(blocks) ? blocks : [];
  const vault = vaultBefore(list, index, magic);
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
    // The same nonce on two headers is two units. A repeat of one header is not.
    let id = '';
    if (share?.verifiedHeader) id = shareWorkKey(share.verifiedHeader, share.nonce);
    if (!id) {
      const slot = share?.proofSlot === 0 || share?.proofSlot === 1
        || share?.proofSlot === '0' || share?.proofSlot === '1'
        ? String(Number(share.proofSlot))
        : '';
      id = `${slot}:${nonce}`;
    }
    if (seen.has(id)) return { ok: false, reason: 'hash_bonus', nanos: 0n };
    seen.add(id);
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
      commit = Buffer.from(asU8(o.commit));
      pr = o.rangeProof
        ? Buffer.from(asU8(o.rangeProof))
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
    vaultPrincipal: typeof state.vaultPrincipal === 'bigint' ? state.vaultPrincipal : 0n,
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
    vaultPrincipal: 0n,
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
 * Principal the replayed vault publishes. The 12-u64 snap has no field for
 * it. A suffix load starts from this row, so a missing principal is supply.
 * Returns null when the vault's own identity does not close.
 */
function replayedPrincipal(vault) {
  if (!vault) return 0n;
  const identity = supplyIdentity(vault);
  if (!identity.ok) return null;
  const raw = identity.principalNanos;
  if (typeof raw === 'bigint') return raw >= 0n && raw <= U64 ? raw : null;
  if (!Number.isSafeInteger(raw) || raw < 0) return null;
  const n = BigInt(raw);
  return n <= U64 ? n : null;
}

/**
 * Replay withdraw interest onto snap rows. The 12-u64 snap does not store it,
 * and it does not store vault principal either. `rows[i]` is the supply after
 * `blocks[i]`. The walk is the load replay: stake rewards required, prior
 * blocks in view. A miss is not published.
 */
export function fillSnapInterest(rows, blocks, opts = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const snaps = Array.isArray(rows) ? rows : [];
  if (!snaps.length || snaps.length !== list.length) return { ok: false, reason: 'supply_state' };
  let vault = null;
  let interest = 0n;
  let permitted = 0n;
  const magic = opts && opts.magic ? String(opts.magic) : MAGIC_TESTNET;
  const replay = { requireStakeReward: true, magic };
  for (let i = 0; i < list.length; i += 1) {
    const row = snaps[i];
    if (!row) return { ok: false, reason: 'supply_state' };
    const ts = headerMs(list[i]);
    if (!(ts > 0)) return { ok: false, reason: 'header' };
    // Same height foldSupply replays at. A block that omits height is i+1;
    // the withdraw walk and the vault replay both see that height, so an
    // epoch or ballot boundary is decided the same way in each.
    const vaultBlock = Number(list[i]?.height) > 0 ? list[i] : { ...list[i], height: i + 1 };
    const got = blockWithdrawInterest(vault, vaultBlock, ts);
    if (!got.ok) return { ok: false, reason: got.reason || 'supply' };
    const allowed = blockPermittedInterest(vault, vaultBlock, ts);
    if (!allowed.ok) return { ok: false, reason: allowed.reason || 'supply' };
    interest += got.nanos;
    permitted += allowed.nanos;
    if (interest > U64 || permitted > U64) return { ok: false, reason: 'supply' };
    if (interest !== permitted) return { ok: false, reason: 'supply' };
    row.mintedInterest = interest;
    row.permittedInterest = permitted;
    const advanced = vaultAfterBlock(vault, vaultBlock, priorForOracle(list, i, magic), replay);
    if (!advanced.ok) return { ok: false, reason: 'supply' };
    vault = advanced.vault;
    const principal = replayedPrincipal(vault);
    if (principal == null) return { ok: false, reason: 'supply' };
    row.vaultPrincipal = principal;
  }
  return { ok: true, reason: '', magic: vault && vault.magic ? vault.magic : magic };
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
    vaultPrincipal: carriedInterest(scalar, 'vaultPrincipal'),
    permittedHashAll: BigInt(scalar.permittedHashAll || 0),
    acceptedHash: BigInt(scalar.acceptedHash || 0),
    owedRows: Array.isArray(owedRows) ? owedRows.slice() : [],
    dust: BigInt(scalar.dust || 0),
    overflow: BigInt(scalar.overflow || 0),
    acceptedSeries: Array.isArray(acceptedSeries) ? acceptedSeries.slice() : [],
    liveUnit: hashBonusUnitNanos(scalar.liveUnit),
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
/**
 * The part of a block's account both share paths share: the vault reward,
 * the coinbase commitment sum, interest, levy and the u64 bounds.
 * `publicTotal` is what the coinbase's explicit outputs must sum to.
 */
function accountTail(state, block, cb, { ts, blockHeight, opts, potMinted, mintedHashHere, levy, publicTotal, unit }) {
  const reward = stakeRewardSupply(
    opts.vault,
    block,
    ts,
    Number.isInteger(blockHeight) && blockHeight >= 0 ? blockHeight : block?.height,
  );
  if (!reward.ok) return { reason: reward.reason || 'supply', state };
  // stakeRewardSupply returns claimed 0. Claim nanos live in reward.minted,
  // and applyRewardClaim accepts them only when they equal the proof reward.
  const claimedReward = reward.claimed || 0n;
  // A claim mint is the claim output, not a coinbase output. Counting it
  // here made the first honest claim block fail the coinbase sum.
  const rememberRange = opts.rememberRange !== false;
  if (!commitmentsMatch(cb?.vout || [], publicTotal, cb?.excess, rememberRange)) {
    return { reason: 'supply', state };
  }
  const interest = blockWithdrawInterest(opts.vault, block, ts, opts.oracle);
  if (!interest.ok) return { reason: interest.reason || 'supply', state };
  // Schedule allowance is staked × epochBps per epoch, not a copy of the receipt.
  const allowed = blockPermittedInterest(opts.vault, block, ts, opts.oracle);
  if (!allowed.ok) return { reason: allowed.reason || 'supply', state };
  state.mintedPot += potMinted;
  state.mintedHash += mintedHashHere;
  state.mintedLevy += levy;
  if (state.mintedInterest + interest.nanos + reward.minted + claimedReward > U64) return { reason: 'supply', state };
  if (state.permittedInterest + allowed.nanos + reward.permitted + claimedReward > U64) return { reason: 'supply', state };
  state.mintedInterest += interest.nanos + reward.minted + claimedReward;
  state.permittedInterest += allowed.nanos + reward.permitted + claimedReward;
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
    || !fitsU64(state.vaultPrincipal || 0n)
    || !fitsU64(state.permittedHashAll)
    || !fitsU64(state.acceptedHash) || !fitsU64(state.dust) || !fitsU64(state.overflow)) {
    return { reason: 'supply', state };
  }
  return { reason: '', state };
}

/**
 * R28 BluNotes. The record names what the block paid by draw. Every node
 * re-derives those notes, so the check here is the account: the notes plus
 * the carry are the subsidy, the parent carry, the finder levy and the
 * hash bonus (scaled in the block, D2; no owed ledger). The coinbase's
 * explicit outputs are the reserve levy only.
 */
function accountBluBlock(state, block, cb, { ts, blockHeight, opts, potMinted, carryOut, levy }) {
  const raw = block.blunoteRecord;
  const rec = decodeRecord(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'hex'));
  if (!rec) { state.carry = carryOut; return { reason: 'blunote_record', state }; }
  const unit = hashBonusUnitNanos(opts.unit == null ? state.liveUnit : opts.unit);
  let hashHere = 0n;
  if (rec.n > 0) {
    const budget = hashBudgetNanos(state.acceptedSeries, unit);
    if (budget == null) { state.carry = carryOut; return { reason: 'hash_owed', state }; }
    hashHere = rec.W * BigInt(unit);
    if (hashHere > BigInt(budget)) hashHere = BigInt(budget);
  }
  const split = splitLevy(Number(levy));
  const { piece } = drawPieces(rec.T, BLUNOTE_WINNERS);
  let paid = rec.feeV;
  for (const w of rec.winners) paid += piece * BigInt(w.m);
  if (paid !== potMinted + BigInt(split.finder) + hashHere) {
    state.carry = carryOut;
    return { reason: 'supply', state };
  }
  state.acceptedHash += hashHere;
  state.permittedHashAll += hashHere;
  state.acceptedSeries.push(rec.n > 0 ? rec.W : 0n);
  state.owedRows = [];
  state.dust = 0n;
  state.overflow = 0n;
  state.carry = carryOut;
  return accountTail(state, block, cb, {
    ts,
    blockHeight,
    opts,
    potMinted,
    mintedHashHere: hashHere,
    levy,
    publicTotal: BigInt(split.reserve),
    unit,
  });
}

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
  if (block?.blunoteRecord != null && block.blunoteRecord !== '') {
    return accountBluBlock(state, block, cb, { ts, blockHeight, opts, potMinted, carryOut, levy });
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
  return accountTail(state, block, cb, { ts, blockHeight, opts, potMinted, mintedHashHere, levy, publicTotal: potMinted + mintedHashHere + levy, unit });
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
  // Minted is the receipt. Permitted is the bps schedule. They are not the same sum.
  if (next.state.mintedInterest !== next.state.permittedInterest) {
    return { ok: false, reason: 'supply', state: null };
  }
  const difference = next.state.mintedPot + next.state.mintedHash
    - next.state.schedulePot + next.state.carry - next.state.permittedHashAll;
  if (difference !== 0n) return { ok: false, reason: 'supply', state: null };
  // Vault principal is note-paid lock inputs minus withdrawn principal.
  // The vault balance is a cross-check when this step has the parent vault.
  // A public lock credits vault principal with no note debit.
  const split = lockPrincipalSplit(block);
  const notePrincipal = (next.state.vaultPrincipal || 0n) + split.note - openedWithdrawPrincipal(block, opts.vault, headerMs(block));
  if (notePrincipal < 0n) return { ok: false, reason: 'supply', state: null };
  if (opts.vault) {
    // The reserve trial already used the structural height. A block on the
    // wire often omits height; replaying the vault at 0 closes the vote
    // window and this check then rejects a block the trial accepted.
    const structural = Number(opts.height);
    const stamped = Number(block?.height);
    const vaultBlock = Number.isInteger(structural) && structural > 0 && !(stamped > 0)
      ? { ...block, height: structural }
      : block;
    const advanced = vaultAfterBlock(opts.vault, vaultBlock, [], {
      magic: opts.magic || undefined,
    });
    if (!advanced.ok || !advanced.vault) return { ok: false, reason: 'supply', state: null };
    const identity = supplyIdentity(advanced.vault);
    if (!identity.ok) return { ok: false, reason: 'supply', state: null };
    if (BigInt(identity.principalNanos) !== notePrincipal) {
      return { ok: false, reason: 'supply', state: null };
    }
  }
  next.state.vaultPrincipal = notePrincipal;
  if (split.bare > 0n) return { ok: false, reason: 'supply', state: null };
  return { ok: true, reason: '', state: next.state };
}

/** Fold a genesis-rooted list. One unit walk, then one step per block. */
export function foldSupply(blocks, opts = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const genesisMs = Number(opts.genesisMs) > 0 ? Number(opts.genesisMs) : (headerMs(list[0]) || 0);
  if (!list.length) return { ok: true, reason: '', state: emptySupplyState(genesisMs) };
  const units = opts.units || supplyUnits(list);
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
    // A pruned block a proven-work header chain buried keeps that tip.
    const own = typeof opts.burialOf === 'function' ? opts.burialOf(list[i]) : null;
    // A wire block often omits height. The step (and its withdraw walk) and
    // the vault replay below all see the same stamped height.
    const vaultBlock = Number(list[i]?.height) > 0 ? list[i] : { ...list[i], height: h };
    const stepped = supplyStep(state, vaultBlock, {
      magic: opts.magic,
      unit: units[i] == null ? HASH_BONUS_NANOS : units[i],
      tipHeight: Number.isInteger(own) && own > tipHeight ? own : tipHeight,
      height: h,
      genesisMs,
      blockHash: list[i]?.hash || null,
      vault,
    });
    if (!stepped.ok) return stepped;
    state = stepped.state;
    // Same prior and stake-reward rule as the store's vault apply.
    const foldMagic = opts.magic || MAGIC_TESTNET;
    const advanced = vaultAfterBlock(vault, vaultBlock, priorForOracle(list, i, foldMagic), {
      requireStakeReward: true,
      magic: foldMagic,
    });
    if (!advanced.ok) return { ok: false, reason: 'supply', state: null };
    vault = advanced.vault;
    if (vault) {
      const identity = supplyIdentity(vault);
      if (!identity.ok) return { ok: false, reason: 'supply', state: null };
      if (BigInt(identity.principalNanos) !== (state.vaultPrincipal || 0n)) {
        return { ok: false, reason: 'supply', state: null };
      }
    }
  }
  // The audit publishes through supplyReport. A total that is not a safe
  // integer, including one portal locked at 2^53-1, is the same mismatch.
  const report = supplyReport(state);
  if (report.status !== 'verified') return { ok: false, reason: report.reason || 'supply', state: null };
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
    vaultPrincipalNanos: 0,
    totalNanos: 0,
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
  const storedPrincipal = state && typeof state.vaultPrincipal === 'bigint' ? state.vaultPrincipal : 0n;
  const hasVault = Object.prototype.hasOwnProperty.call(opts, 'vaultPrincipalNanos');
  const hasNote = Object.prototype.hasOwnProperty.call(opts, 'noteBackedPrincipalNanos');
  const vaultPrincipal = asNonNeg(hasVault ? opts.vaultPrincipalNanos : storedPrincipal);
  const vaultAccrued = asNonNeg(opts.vaultAccruedNanos ?? 0);
  const noteBacked = asNonNeg(hasNote ? opts.noteBackedPrincipalNanos : storedPrincipal);
  if (vaultPrincipal == null || vaultAccrued == null || noteBacked == null) {
    return { ...blank, reason: reportReason || 'supply' };
  }
  // circulating + vault principal + accrued interest
  //   == schedule emission + interest ever minted − burned + note-backed principal.
  // Interest still in the mint bank is on both sides. Note-backed principal is
  // the matching debit. A public lock has no debit, so differenceNanos moves.
  const circulating = mintedPot + mintedHash + chainExtra - burned;
  const scheduleEmission = schedulePot - carry + permittedHashAll;
  const mintedEver = chainExtra + vaultAccrued;
  const expected = scheduleEmission + mintedEver - burned + noteBacked;
  const lhs = circulating + vaultPrincipal + vaultAccrued;
  const difference = lhs - expected;
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
    vaultPrincipalNanos: safeNum(vaultPrincipal),
    totalNanos: safeNum(circulating + (state.vaultPrincipal || 0n) + (state.bLocked || 0n)),
    differenceNanos: safeSigned(difference),
    vaultAccruedNanos: safeNum(vaultAccrued),
    noteBackedPrincipalNanos: safeNum(noteBacked),
    mintedInterestNanos: safeNum(mintedEver),
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
 * Units for a supply audit. A refused reserve row still has a unit, so the
 * walk can report that row. A hole before the last block stays epoch_open.
 */
function auditUnits(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const walked = unitsAlongChain({
    history: [],
    fork: list,
    vault: emptyVault(),
    timeOf: (block) => {
      try {
        return Number(decodeHeader(Buffer.from(block.header)).timestamp);
      } catch {
        return 0;
      }
    },
  });
  if (!walked || !Array.isArray(walked.units)) return null;
  if (walked.ok) return walked.units;
  if (walked.units.length === list.length) return walked.units;
  return null;
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
  const units = auditUnits(list);
  if (!units) return { ...blank, reason: 'epoch_open' };
  let auditTip = 0;
  for (let i = 0; i < list.length; i += 1) {
    const h = Number(list[i]?.height);
    const n = Number.isInteger(h) ? h : i + 1;
    if (n > auditTip) auditTip = n;
  }
  let state = emptySupplyState(genesisMs);
  let vault = null;
  let notePrincipal = 0n;
  let claimedUnfunded = 0n;
  for (let bi = 0; bi < list.length; bi += 1) {
    const h = Number(list[bi]?.height);
    // Same stamped height for the step, the withdraw walk and the replay.
    const vaultBlock = Number.isInteger(h) && h > 0 ? list[bi] : { ...list[bi], height: bi + 1 };
    const next = accountBlock(state, vaultBlock, {
      magic,
      unit: units[bi] == null ? HASH_BONUS_NANOS : units[bi],
      tipHeight: auditTip,
      height: Number.isInteger(h) && h > 0 ? h : bi + 1,
      genesisMs,
      blockHash: list[bi]?.hash || null,
      rememberRange: false,
      vault,
    });
    if (next.reason) {
      state = next.state;
      ok = false;
      reason = reason || next.reason;
      const broken = emptyVault();
      broken.blankFork = true;
      vault = broken;
    } else if (next.state.mintedInterest !== next.state.permittedInterest) {
      // Same comparison as supplyStep. The inflated block is not the measured mint.
      ok = false;
      reason = reason || 'supply';
      const broken = emptyVault();
      broken.blankFork = true;
      vault = broken;
    } else {
      state = next.state;
      const split = lockPrincipalSplit(vaultBlock);
      const withdrawn = openedWithdrawPrincipal(vaultBlock, vault, headerMs(vaultBlock));
      // prior is the prefix this block was applied on. An empty prior
      // installs this header as genesis and skips the epoch boundary.
      const advanced = vaultAfterBlock(vault, vaultBlock, priorForOracle(list, bi, magic), {
        requireStakeReward: true,
        magic,
      });
      if (!advanced.ok) {
        // The vault refused the row. A bare receipt is still a claim with
        // no note debit, so the difference is that amount. Keep the prior vault.
        ok = false;
        reason = reason || 'supply';
        claimedUnfunded += split.bare;
        state.vaultPrincipal = notePrincipal;
      } else {
        vault = advanced.vault;
        const nextNote = notePrincipal + split.note - withdrawn;
        if (nextNote < 0n) {
          ok = false;
          reason = reason || 'supply';
        } else {
          notePrincipal = nextNote;
        }
        state.vaultPrincipal = notePrincipal;
        if (vault) {
          const identity = supplyIdentity(vault);
          const recorded = identity && identity.ok ? BigInt(identity.principalNanos) : null;
          if (recorded !== notePrincipal) {
            ok = false;
            reason = reason || 'supply';
          }
        }
      }
    }
  }
  const reportOpts = {
    burnedNanos: burnedIn,
    ok,
    reason,
    vaultPrincipalNanos: notePrincipal + claimedUnfunded,
    vaultAccruedNanos: vaultAccruedNanos(vault),
    noteBackedPrincipalNanos: notePrincipal,
  };
  if (claimPresent) reportOpts.extraMintNanos = opts.extraMintNanos;
  return supplyReport(state, reportOpts);
}

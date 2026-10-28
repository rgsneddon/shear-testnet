import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { potSubsidyAt, chainGenesisMs as genesisMsOf, epochDays, vortexEpochIndex } from '../../crypto/pot_sched.js';
import { shearHash, meetsTarget, hashHex } from '../../crypto/shear_hash.js';
import { hashHeaderOffLoop } from '../../crypto/hash_offloop.js';
import { encodeHeader, decodeHeader, setNonce, VERSION } from '../../crypto/header.js';
import { merkleRoot, EMPTY_ROOT } from '../../crypto/merkle.js';
import {
  GENESIS_BITS_PACKED,
  LIVE_MIN_BITS,
  MAX_BITS,
  asertNextBits,
  bitsAcceptAsert,
  TARGET_BLOCK_INTERVAL_MS,
  isPackedBits,
  unpackBits,
  blockWork,
  blockWorkBig,
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  HASH_BONUS_NANOS_FLOOR,
  hashBonusUnitNanos,
  MAGIC_TESTNET,
  MAGIC_TESTNET_V12,
  MAGIC_MAINNET,
  consensusFingerprint,
  extraMintAllowed,
  wrapMintForbidden,
  DEST_HRP,
  JOIN_PROGRAM,
  JOIN_KIND_GENESIS,
  SHARE_FLOOR_BITS,
  MAX_SHARES_PER_BLOCK,
  POOL_FEE_BPS,
  POOL_FEE_MAX_BPS,
  MTP_WINDOW,
  MTP_FUTURE_MS,
  HEADER_AHEAD_MS,
  medianTimePast,
} from '../../crypto/asert.js';
import { isHistoricalHeader } from '../../crypto/historical_prefix.js';
import { regtestBitsOverride } from '../../crypto/regtest_bits.js';
import {
  verifyShareBatch,
  paidWorkKeys,
  collateShareUnits,
  aLeavesFromShares,
  unitsForShare,
  destOfShare,
  dest20OfShare,
  noteCommitOfShare,
  accountShareUnits,
  selectBlockShares,
  bindShareProofSlots,
  shareWorkKey,
  stashSharePow,
  peekSharePow,
  dropSharePowKeys,
  issuedJobDigestSuffix,
  issuedKeysForParents,
} from '../../crypto/share_batch.js';
import {
  bootReserveEvm,
  blockNeedsEvm,
  executeBlockEvm,
} from '../../crypto/reserve_evm.js';
import { isDestAddress, isShearAddress, hash20FromAddress, bech32Hrp, checkAddressField, checkTxAddressFields, admitBaseFromAddress, encodeDest } from '../../crypto/address.js';
import {
  admitDelta,
  attachAdmitPub,
  fluxsetFromBlocks,
  appendFluxBlock,
  emptyFluxset,
  outputJoinsAdmitSet,
  receiptAdmitRejected,
  jroot as jrootOf,
  extendZeroRoot,
  admitPubIndex,
} from '../../crypto/admit.js';
import { ANCHOR_WINDOW, checkAdmitAnchor, flowPresentsProof, typedKindNeedsAdmitV3, verifyFlowAdmitV3, verifyTypedAdmitFunding, v12FlowVersionRejected } from '../../crypto/admit_v3.js';
import { chainStage0Rejected } from '../../crypto/fs1_send_gate.js';
import { chainNoteRuleRejected, txNoteRuleRejected } from '../../crypto/n1.js';
import { fs1LeafFor, fs1OutputNote } from '../../crypto/fs1_leaf.js';
import { collateSamples, shouldPruneSamples, flowSkipAllowed, sealedVinLinkField, valueOpenRejected, bSpendVinRejected } from '../../crypto/chronoflux.js';
import { verifyFundedBody, verifyPoolWithdrawBound, boundReserveWithdraw, typedCommitRejected, typedCommitSum, reserveAuth, v12KindRejected, userCoinbaseRejected, explicitTypedKindRejected, typedClockRejected, openingBeforeCarry, unsignedBodyField, feeFieldRejected, bSpendFeeRejected, postedFeeNanos } from '../../crypto/spend.js';
import { emptyVault, applyReserveBlock, trialReserveApply, reserveDigestSuffix, rewardClaimDigestSuffix, blockRewardRoot, stakeRewardRejected, lockNoteSpendRejected, coinbaseRewardRoot, rewardClaimRejected, withdrawRewardRejected, rollRewardRejected, leafVoteFundingRejected, leafVoteLeakRejected, compactLockLeakRejected, withdrawLeakRejected } from '../../crypto/reserve_vault.js';
import {
  GENESIS_BPS,
  ORACLE_ACTIVATION_HEIGHT,
  canonicalReports,
  coinbaseObserveRejected,
  epochBpsFromReports,
  isReportBoundary,
  observeDigestSuffix,
  oracleRuleAt,
  verifyMinerReport,
  reserveApplyFields,
  verifyRateCommit,
  windowBlocksFor,
} from '../../crypto/reserve_oracle.js';
import { emptySupplyState, foldSupply, supplyLinks, supplyStep } from './supply.js';
import { blunoteHashNanos, blunotePlan, blunoteSettle } from './blunote_payout.js';
import { BLUNOTE_WINNERS, SHARE_BYTES_MAX, batchSumRoot, decodeRecord, encodeRecord, recordRoot } from '../../crypto/blunote.js';
import { compareBluShares, bluFrameBytes } from '../../crypto/share_batch.js';
import { hasherPayoutDest } from '../../crypto/flow_sheet.js';
import {
  sealCoinbaseNote,
  verifySealedNote,
  verifyMintSum,
  openedCoinbaseNanos,
  coinbaseVoutsBound,
  verifyRange,
  excessOf,
  verifyFlowConservation,
  flowInputsBound,
  unboundMembershipCarry,
  noteCommitOfDest20,
  asU8,
  pointFrom,
  pointBytes,
  G,
  txIoCap,
} from '../../crypto/note.js';
import { t21CoinbaseGate } from '../../crypto/t21_split.js';
import { blockBudget } from '../../crypto/block_budget.js';
import {
  packTx,
  packDigest,
  unpackShareBatch,
  u64le,
  shareSlotRoot,
  bluSlotRoot,
  shareSlotDigestSuffix,
  shareSlotCommitment,
} from '../../crypto/pack.js';
import {
  freshCreditsFromShares,
  freshForBlock,
  spillForBlock,
  sealedCreditsBuried,
  hashBudgetNanos,
  hashDustFromTx,
  hashLedgerIdle,
  hashOwedDigestSuffix,
  hashOwedFromTx,
  hashOwedRootAgrees,
  hashOverflowFromTx,
  advanceHashOwed,
  sameHashLedger,
  settleHashOwed,
  writeHashLedger,
} from '../../crypto/hash_owed.js';
import { buildDualTree, bindBSpend, derivedBLeaves, sameBLeaves, bLeafAskRejected } from '../../crypto/clearing.js';
import {
  nextBaseFee,
  blockWeight,
  splitLevy,
  txWeight,
  reserveFeeDest,
  unclaimedFinderDest,
  levyTaxed,
  containsShe1,
  levyNeed,
  LEVY_CAP_NANOS,
  poolFeeDest,
  custodialPullRejected,
} from '../../crypto/levy.js';
import { gateVorticeRegister } from '../../crypto/vortex.js';
import { dummyCount, flowNeedsDummy, moneyNeedsRange, publicReserveReceiptRejected } from '../../crypto/dummy.js';

export { blockWeight, nextBaseFee } from '../../crypto/levy.js';

export {
  SAMPLE_PRUNE_CONFIRMATIONS,
  shouldPruneSamples,
  pruneSamples,
  collateSamples,
  leanBlock,
  sealedExplorerRows,
  explorerSpendable,
  compactTx,
  compactChainBlock,
} from '../../crypto/chronoflux.js';

import { canonicalHash } from '../../crypto/canonical_row.js';
import { compactTx } from '../../crypto/chronoflux.js';

export const GENESIS_PREV = Buffer.alloc(32);

/**
 * Height-1 block hash, lowercase hex. Empty until the v12 genesis cut fills it.
 * A non-empty pin rejects every other height-1 hash, including one with genesis bits.
 */
export const V12_GENESIS_BLOCK_HASH = '';

/**
 * Optional bootstrap checkpoint. height 0 means unset.
 * CoS fills the hash from the genesis script at the cut.
 * Install rule: a bootstrap may land only in an empty book, the remote chain
 * must have positive work, and these pins must match when they are set.
 * A backdated walk can still ease ASERT by about one bit per 2h MTP gap.
 * The pins are the anchor. The future bound does not replace them.
 */
export const V12_BOOTSTRAP_CHECKPOINT = Object.freeze({ height: 0, hash: '' });

function dest20Of(addr) {
  const h = hash20FromAddress(addr);
  return h ? Buffer.from(h) : Buffer.alloc(20);
}

function kindByte(kind) {
  const k = String(kind || '');
  if (k === 'hash') return 1;
  if (k === 'pot') return 2;
  if (k === 'finder-fee') return 3;
  if (k === 'reserve-fee') return 4;
  if (k === 'dummy') return 5;
  return 0;
}

function ref32(x) {
  if (x == null || x === '') return null;
  try {
    const b = Buffer.from(asU8(x));
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/** Non-negative safe-integer carry, 0 when absent. Null is not a carry. */
export function canonicalCarry(tx) {
  if (tx == null || tx.carryNanos == null || tx.carryNanos === '') return 0;
  const n = typeof tx.carryNanos === 'bigint' ? Number(tx.carryNanos) : Number(tx.carryNanos);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/**
 * A negative top-level amount. Only a kind whose compact body keeps nanos
 * (reward-claim, non-negative only: chronoflux compactTx) can name one, so
 * on an arrived block this stays a guard; the key is tested before it is
 * read, as an absent amount is not a negative one.
 */
function negativeTopNanos(tx) {
  if (!tx || typeof tx !== 'object' || !Object.prototype.hasOwnProperty.call(tx, 'nanos')) return false;
  const n = tx.nanos;
  return typeof n === 'bigint' ? n < 0n : typeof n === 'number' && n < 0;
}

/**
 * The merkle leaf of one tx (TX_DIGEST=body-v2). Computed on compactTx(tx),
 * the one form a block is validated in, stored in, served in and read back
 * from disk in, so a full row and its compact copy are one digest and a
 * field compaction drops reaches no digest. It binds the packed core and
 * sha256 of the canonical encoding of the whole compact row
 * (canonical_row.js), so every byte a validator reads is in the block hash,
 * for every kind including the coinbase. The id is a label its sender picks
 * and no signature covers, so it is not in the leaf: a relayed copy under a
 * new id is the same tx (Russell 26 Oct). A withdraw signs its id
 * (reserveDigestSuffix), so there it is body and stays in, as in the
 * mempool body key (mempool.js txBodyKey).
 */
export function digestTx(tx) {
  const body = { ...compactTx(tx) };
  if (String(body.kind || '') !== 'withdraw') delete body.id;
  return packDigest(Buffer.concat([
    Buffer.from(TX_DIGEST_DOMAIN),
    coreDigest(body),
    canonicalHash('shear-tx-body-v2', body),
  ]));
}

const TX_DIGEST_DOMAIN = 'shear-tx-digest-v2';

/**
 * A block's merkle leaves (digestTx), or null when two txs share a leaf.
 * merkleRoot pairs an odd last leaf with itself, so [A, B, C] and
 * [A, B, C, C] have one root and one block hash (the CVE-2012-2459 class):
 * a repeated leaf is refused before the root is compared (Russell 26 Oct).
 */
export function blockLeaves(txs) {
  const leaves = (Array.isArray(txs) ? txs : []).map(digestTx);
  const seen = new Set();
  for (const leaf of leaves) {
    const hex = Buffer.from(leaf).toString('hex');
    if (seen.has(hex)) return null;
    seen.add(hex);
  }
  return leaves;
}

/**
 * The packed core alone: the v1 merkle leaf. It binds no commitment, tag or
 * proof of an FS-1 body, which is why it is no longer the leaf by itself.
 */
export function txCoreDigest(tx) {
  return coreDigest(tx);
}

function coreDigest(tx) {
  const vins = (tx.vin || []).map((v, i) => {
    const prev = ref32(v.prev) || Buffer.alloc(32);
    const nc = ref32(v.noteCommit);
    return {
      prev,
      index: Number(v.index || i),
      dest20: nc ? nc.subarray(0, 20) : Buffer.alloc(20),
    };
  });
  const vouts = (tx.vout || []).map((o) => {
    const nc = ref32(o.noteCommit);
    let d20 = nc ? nc.subarray(0, 20) : null;
    if (!d20) {
      try {
        const owned = o.dest20 != null && o.dest20 !== '' ? Buffer.from(asU8(o.dest20)) : null;
        if (owned && owned.length >= 20) d20 = owned.subarray(0, 20);
      } catch { /* fall through to address */ }
    }
    const claimed = o.valueProof?.v != null ? Number(o.valueProof.v) : Number(o.nanos || 0);
    return {
      dest20: d20 || dest20Of(o.address || ''),
      nanos: o.commit ? 0 : claimed,
      kind: kindByte(o.kind),
    };
  });
  const packed = packTx({
    version: 1,
    vins: vins.length ? vins : [{ prev: Buffer.alloc(32), index: Number(tx.height || 0), dest20: Buffer.alloc(20) }],
    vouts,
    memoH: tx.memoH || null,
    bFlag: tx.bFlag || tx.kind === 'b-spend' ? 1 : 0,
  });
  // A positive carry is bound into the coinbase digest. Zero omits the suffix,
  // so a paid-out coinbase keeps the previous digest. A peer who changes the
  // carry changes the merkle root.
  const carry = tx?.coinbase ? canonicalCarry(tx) : 0;
  const owedSuffix = tx?.coinbase ? hashOwedDigestSuffix(tx) : Buffer.alloc(0);
  const slotSuffix = tx?.coinbase ? shareSlotDigestSuffix(tx) : Buffer.alloc(0);
  const issuedSuffix = tx?.coinbase ? issuedJobDigestSuffix(tx) : Buffer.alloc(0);
  const bluSuffix = tx?.coinbase ? blunoteDigestSuffix(tx) : Buffer.alloc(0);
  const observeSuffix = tx?.coinbase ? observeDigestSuffix(tx) : null;
  const reportSuffix = Array.isArray(tx?.reports) && tx.reports.length
    ? Buffer.from(`reports1${JSON.stringify(canonicalReports(tx.reports))}`)
    : null;
  const rateSuffix = tx?.coinbase && tx.rateCommit && typeof tx.rateCommit === 'object'
    ? Buffer.from(`ratecommit1${Math.floor(Number(tx.rateCommit.epochIndex) || 0)}:${Math.floor(Number(tx.rateCommit.epochBps) || 0)}:${String(tx.rateCommit.magic || '')}`)
    : null;
  const rootHex = tx?.coinbase ? blockRewardRoot({ txs: [tx] }) : '';
  const rewardSuffix = rootHex && rootHex !== 'bad'
    ? Buffer.from(`rewardroot1${rootHex}`)
    : (rootHex === 'bad' ? Buffer.from('rewardroot-bad') : null);
  if (tx?.coinbase && (owedSuffix == null || slotSuffix == null || issuedSuffix == null || bluSuffix == null)) {
    return packDigest(Buffer.concat([packed, Buffer.from('hashowed-bad')]));
  }
  if (tx?.coinbase && (carry || (owedSuffix && owedSuffix.length) || (slotSuffix && slotSuffix.length) || (issuedSuffix && issuedSuffix.length) || (bluSuffix && bluSuffix.length) || (observeSuffix && observeSuffix.length) || (reportSuffix && reportSuffix.length) || (rateSuffix && rateSuffix.length) || (rewardSuffix && rewardSuffix.length))) {
    const parts = [packed];
    if (carry) parts.push(Buffer.from('potcarry1'), u64le(carry));
    if (owedSuffix && owedSuffix.length) parts.push(owedSuffix);
    if (slotSuffix && slotSuffix.length) parts.push(slotSuffix);
    if (issuedSuffix && issuedSuffix.length) parts.push(issuedSuffix);
    if (bluSuffix && bluSuffix.length) parts.push(bluSuffix);
    if (observeSuffix && observeSuffix.length) parts.push(observeSuffix);
    if (reportSuffix && reportSuffix.length) parts.push(reportSuffix);
    if (rateSuffix && rateSuffix.length) parts.push(rateSuffix);
    if (rewardSuffix && rewardSuffix.length) parts.push(rewardSuffix);
    return packDigest(Buffer.concat(parts));
  }
  if (reportSuffix && reportSuffix.length) {
    return packDigest(Buffer.concat([packed, reportSuffix]));
  }
  const reserveSuffix = reserveDigestSuffix(tx);
  if (reserveSuffix && reserveSuffix.length) {
    return packDigest(Buffer.concat([packed, reserveSuffix]));
  }
  const claimSuffix = rewardClaimDigestSuffix(tx);
  if (claimSuffix && claimSuffix.length) {
    return packDigest(Buffer.concat([packed, claimSuffix]));
  }
  return packDigest(packed);
}

function noteCommitOfStoredLeaf(leaf) {
  const raw = leaf?.noteCommit;
  if (raw != null && raw !== '') {
    try {
      const nc = Buffer.from(raw);
      if (nc.length === 32 && !nc.equals(Buffer.alloc(32))) return nc;
    } catch { /* dest20 below */ }
  }
  let d20 = null;
  try { d20 = Buffer.from(leaf?.dest20 || Buffer.alloc(0)); } catch { d20 = null; }
  if (!d20 || d20.length !== 20 || d20.equals(Buffer.alloc(20))) return null;
  return noteCommitOfDest20(d20);
}

/** Proven share leaves and the stored Tree-A leaves name the same counts. */
function sameLeafCounts(proven, stored) {
  const want = new Map();
  for (const leaf of proven || []) {
    const nc = noteCommitOfStoredLeaf(leaf);
    if (!nc) return false;
    const key = nc.toString('hex');
    want.set(key, (want.get(key) || 0) + (Number(leaf.count) || 0));
  }
  const have = new Map();
  for (const leaf of stored || []) {
    const nc = noteCommitOfStoredLeaf(leaf);
    if (!nc) return false;
    const key = nc.toString('hex');
    have.set(key, (have.get(key) || 0) + (Number(leaf.count) || 0));
  }
  if (have.size !== want.size) return false;
  for (const [key, count] of want) {
    if (have.get(key) !== count) return false;
  }
  return true;
}

function aLeavesOf(collated, pay) {
  return collated.map((s) => {
    const d20 = dest20Of(pay(s.miner || s.address || s.dest || ''));
    return {
      dest20: d20,
      noteCommit: s.noteCommit && Buffer.from(s.noteCommit).length === 32
        ? Buffer.from(s.noteCommit)
        : noteCommitOfDest20(d20),
      count: Number(s.count) > 0 ? Number(s.count) : unitsForShare(),
    };
  });
}

function publishedALeaves(block) {
  if (!Array.isArray(block?.aLeaves)) return [];
  return block.aLeaves.map((l) => {
    const d20 = Buffer.from(l.dest20);
    const nc = l.noteCommit && Buffer.from(l.noteCommit).length === 32
      ? Buffer.from(l.noteCommit)
      : noteCommitOfDest20(d20);
    return { dest20: d20, count: Number(l.count) || 1, noteCommit: nc };
  });
}

function bLeavesOf(txs, _pay) {
  const got = derivedBLeaves(txs);
  return got.ok ? got.leaves : [];
}

/** Published leaves must be the debited list. A free list is b_leaves. */
function boundBLeaves(block, txs) {
  const got = derivedBLeaves(txs);
  if (!got.ok) return got;
  if (Array.isArray(block?.bLeaves) && !sameBLeaves(block.bLeaves, got.leaves)) {
    return { ok: false, reason: 'b_leaves' };
  }
  return { ok: true, leaves: got.leaves };
}

function ssaOk(addr) {
  return isDestAddress(addr) && bech32Hrp(addr) === DEST_HRP && !isShearAddress(addr);
}

/** Dest count above 2^headerBits * 16 is sample_cap. */
export function sampleCountCap(bits) {
  const b = BigInt(Math.max(0, Math.floor(Number(bits) || 0)));
  return (1n << b) * 16n;
}

export function sampleCapExceeded(samples = [], bits) {
  const cap = sampleCountCap(bits);
  for (const s of collateSamples(samples)) {
    const count = BigInt(Math.max(0, Math.floor(Number(s.count) || 0)));
    if (count > cap) return true;
  }
  return false;
}

export function hashBonusByMiner(samples = [], unit = HASH_BONUS_NANOS, shareBatch = null) {
  const bonus = hashBonusUnitNanos(unit);
  const by = new Map();
  void samples;
  if (shareBatch != null) {
    for (const [addr, units] of collateShareUnits(shareBatch)) {
      by.set(addr, units * bonus);
    }
  }
  return by;
}

function ncHex(buf) {
  try {
    return Buffer.from(buf || []).toString('hex');
  } catch {
    return '';
  }
}

function chainGenesisMsFrom(blocks, prevHeader) {
  return genesisMsOf(blocks, prevHeader, decodeHeader);
}

function blockTimeMs(block) {
  try {
    return Number(decodeHeader(Buffer.from(block.header)).timestamp) || 0;
  } catch {
    return 0;
  }
}

function mintWithLevy(vouts, scheduled, excess) {
  const rows = (vouts || []).filter((o) => o?.commit);
  // A carried pot mints no note. The empty commitment sum is a mint of zero.
  if (!rows.length) return Math.floor(Number(scheduled) || 0) === 0;
  let levy = 0;
  for (const o of rows) {
    if (o.kind !== 'finder-fee' && o.kind !== 'reserve-fee') continue;
    const v = openedCoinbaseNanos(o);
    if (v == null) return false;
    levy += v;
  }
  return verifyMintSum(rows, scheduled + levy, excess);
}

export function wantPotNanos(block, opts = {}) {
  const nowMs = blockTimeMs(block) || Number(opts.nowMs) || 0;
  const genesisMs = Number(opts.genesisMs);
  if (!Number.isFinite(genesisMs) || genesisMs <= 0) return null;
  return potSubsidyAt({ nowMs, genesisMs, magic: opts.magic || MAGIC_TESTNET });
}

/** PROP of (pot − pool fee + carry) across Tree-A note_commits. The fee is not taken from carry. */
export function potPaysFromLeaves(leaves = [], poolDest = null, feeNanos = null, potNanos = BLOCK_SUBSIDY_NANOS, carryNanos = 0) {
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const carry = Math.max(0, Math.floor(Number(carryNanos) || 0));
  const pool = poolDest && isDestAddress(poolDest) ? poolDest : '';
  const poolNc = pool ? noteCommitOfDest20(hash20FromAddress(pool)).toString('hex') : '';
  const fee = feeNanos != null
    ? Math.max(0, Math.floor(Number(feeNanos) || 0))
    : (poolNc ? Math.floor(pot * POOL_FEE_BPS / 10000) : 0);
  const rest = pot - fee + carry;
  const list = (leaves || []).map((l) => ({
    noteCommit: Buffer.from(l.noteCommit || []),
    count: Number(l.count) || 0,
  })).filter((l) => l.noteCommit.length === 32 && l.count > 0);
  const total = list.reduce((a, l) => a + l.count, 0);
  const out = [];
  if (!total) return out;
  let paid = 0;
  const sorted = [...list].sort((a, b) => ncHex(a.noteCommit).localeCompare(ncHex(b.noteCommit)));
  for (let i = 0; i < sorted.length; i += 1) {
    const nanos = i === sorted.length - 1 ? rest - paid : Math.floor(rest * sorted[i].count / total);
    paid += nanos;
    if (nanos > 0) out.push({ noteCommit: sorted[i].noteCommit, nanos, kind: 'pot' });
  }
  // The fee is its own note even when the fee dest also hashed. Adding it
  // into a hasher note is not a different block from a no-fee pot once the
  // dest is gone, and load has no dest. A folded coinbase is pot_prop
  // whenever the opened notes are not this split plus one fee note.
  if (poolNc && fee > 0) {
    out.push({ noteCommit: noteCommitOfDest20(hash20FromAddress(pool)), nanos: fee, kind: 'pool-fee' });
  }
  return out.filter((s) => s.nanos > 0);
}

/**
 * Finder-fee notes for one block. An empty round is one public note to the
 * block miner. A round with shares splits the finder half across that
 * round's payees by work. The last leaf takes the remainder so the notes
 * sum to the finder half. The pool is not a payee unless it holds shares.
 */
export function finderFeePays(shareBatch = [], feeNanos = 0, minerDest = '') {
  const fee = Math.max(0, Math.floor(Number(feeNanos) || 0));
  if (!fee) return [];
  const leaves = aLeavesFromShares(shareBatch);
  const total = leaves.reduce((a, l) => a + (Number(l.count) || 0), 0);
  if (!total) {
    const dest = minerDest && isDestAddress(minerDest) ? minerDest : String(minerDest || '');
    const d20 = dest && isDestAddress(dest) ? hash20FromAddress(dest) : null;
    return [{
      address: dest,
      nanos: fee,
      kind: 'finder-fee',
      noteCommit: d20 ? noteCommitOfDest20(d20) : null,
    }];
  }
  const destByNc = new Map();
  for (const s of shareBatch || []) {
    const dest = destOfShare(s);
    const nc = ncHex(noteCommitOfShare(s));
    if (dest && nc) destByNc.set(nc, dest);
  }
  let paid = 0;
  const out = [];
  for (let i = 0; i < leaves.length; i += 1) {
    const nanos = i === leaves.length - 1
      ? fee - paid
      : Math.floor(fee * leaves[i].count / total);
    paid += nanos;
    if (!(nanos > 0)) continue;
    const nc = leaves[i].noteCommit;
    out.push({
      noteCommit: nc,
      address: destByNc.get(ncHex(nc)) || '',
      nanos,
      kind: 'finder-fee',
    });
  }
  return out;
}

/** PROP of (pot - pool fee + carry) across dest20 in shareBatch. Pool dest gets only the fee. */
export function potSharesFromBatch(shareBatch = [], poolDest = null, potNanos = BLOCK_SUBSIDY_NANOS, carryNanos = 0) {
  const leaves = aLeavesFromShares(shareBatch);
  const pays = potPaysFromLeaves(leaves, poolDest, null, potNanos, carryNanos);
  const destByNc = new Map();
  for (const s of shareBatch || []) {
    const dest = destOfShare(s);
    const nc = ncHex(noteCommitOfShare(s));
    if (dest && nc) destByNc.set(nc, dest);
  }
  if (poolDest && isDestAddress(poolDest)) {
    destByNc.set(noteCommitOfDest20(hash20FromAddress(poolDest)).toString('hex'), poolDest);
  }
  return pays.map((p) => ({
    ...p,
    address: destByNc.get(ncHex(p.noteCommit)) || '',
  })).filter((s) => s.nanos > 0);
}

export function lag1Continuity(prevHeader) {
  if (!prevHeader) return EMPTY_ROOT;
  try {
    return decodeHeader(Buffer.from(prevHeader)).continuityRoot;
  } catch {
    return EMPTY_ROOT;
  }
}

export function custodyPotShares(poolDest, potNanos = BLOCK_SUBSIDY_NANOS) {
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const feeDest = poolFeeDest() || poolDest;
  const fee = Math.floor(pot * POOL_FEE_BPS / 10000);
  const rest = pot - fee;
  const out = [];
  if (rest > 0 && isDestAddress(poolDest)) out.push({ address: poolDest, nanos: rest, kind: 'pot' });
  if (fee > 0 && isDestAddress(feeDest)) {
    out.push({ address: feeDest, nanos: fee, kind: feeDest === poolDest ? 'pot' : 'pool-fee' });
  }
  return out;
}

function notePays(o, dest, nanos) {
  if (!o?.commit || !isDestAddress(dest) || !(nanos > 0)) return false;
  const nc = ncHex(noteCommitOfDest20(hash20FromAddress(dest)));
  return ncHex(o.noteCommit) === nc && verifySealedNote(o, nanos);
}

/**
 * Old custodial shape: one hash note for the whole bonus, paid to a dest
 * that is not a hasher leaf. v12 verifyBlockConsensus does not accept it.
 */
export function matchCustodyCoinbase({
  hashVouts = [],
  poolDest,
  wantBonus,
  hasherNcs,
} = {}) {
  const bonus = Math.max(0, Math.floor(Number(wantBonus) || 0));
  const dest = poolDest && isDestAddress(poolDest) ? poolDest : '';
  const hasher = hasherNcs instanceof Set ? hasherNcs : new Set();
  if (bonus > 0) {
    if (hashVouts.length !== 1) return false;
    if (dest) {
      if (!notePays(hashVouts[0], dest, bonus)) return false;
    } else if (!verifySealedNote(hashVouts[0], bonus)) {
      return false;
    }
    const hashNc = ncHex(hashVouts[0].noteCommit);
    if (hasher.has(hashNc)) return false;
    return true;
  }
  return hashVouts.length === 0;
}

/**
 * Old shape: hash notes on hasher leaves, pot still custodial. v12
 * verifyBlockConsensus does not accept it.
 */
export function matchDestBoundHashCustodyPot({
  hashVouts = [],
  potVouts = [],
  leaves = [],
  liveUnit,
  wantPot,
  hinted,
  hasherNcs,
} = {}) {
  const hasher = hasherNcs instanceof Set ? hasherNcs : new Set();
  if (!leaves.length) return false;
  const unit = hashBonusUnitNanos(liveUnit);
  for (const leaf of leaves) {
    const n = (Number(leaf.count) || 0) * unit;
    const hit = hashVouts.find((o) => ncHex(o.noteCommit) === ncHex(leaf.noteCommit));
    if (!(n > 0) || !hit || !verifySealedNote(hit, n)) return false;
  }
  for (const o of hashVouts) {
    if (!hasher.has(ncHex(o.noteCommit))) return false;
  }
  const extra = (potVouts || []).filter((o) => !hasher.has(ncHex(o.noteCommit)));
  if (extra.length !== potVouts.length || !extra.length) return false;
  const dest = hinted && isDestAddress(hinted) ? hinted : '';
  if (dest) {
    const shares = custodyPotShares(dest, wantPot);
    if (shares.length === extra.length) {
      const used = new Set();
      let ok = true;
      for (const s of shares) {
        const hit = extra.find((o) => !used.has(ncHex(o.noteCommit)) && notePays(o, s.address, s.nanos));
        if (!hit) {
          ok = false;
          break;
        }
        used.add(ncHex(hit.noteCommit));
      }
      if (ok && used.size === extra.length) return true;
    }
  }
  // P2P ingest has no out-of-band poolDest. Accept 1% through the subsidy cap, plus the rest, on non-hasher dests. Carry is not fee'd.
  const pot = Math.max(0, Math.floor(Number(wantPot) || 0));
  if (extra.length === 2 && pot > 0) {
    for (let bps = 1; bps <= POOL_FEE_MAX_BPS; bps += 1) {
      const fee = Math.floor(pot * bps / 10000);
      const rest = pot - fee;
      if (!(fee > 0) || rest <= 0) continue;
      const feeV = extra.find((o) => verifySealedNote(o, fee));
      const restV = extra.find((o) => o !== feeV && verifySealedNote(o, rest));
      if (feeV && restV) return true;
    }
  }
  return false;
}

/**
 * Subsidy fees a block may open. The amount is floor(subsidy * bps / 10000)
 * for a bps from 1 through POOL_FEE_MAX_BPS, or zero. Carry is not a fee base.
 */
function legalSubsidyFees(wantPot) {
  const pot = Math.max(0, Math.floor(Number(wantPot) || 0));
  const maxFee = Math.floor(pot * POOL_FEE_MAX_BPS / 10000);
  const out = [0];
  const seen = new Set([0]);
  for (let bps = 1; bps <= POOL_FEE_MAX_BPS; bps += 1) {
    const n = Math.floor(pot * bps / 10000);
    if (n > 0 && n <= maxFee && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** Each pay takes one unused opening of that noteCommit and nanos. */
function assignPotPays(rows, pays) {
  if (rows.length !== pays.length) return false;
  const used = new Set();
  for (const pay of pays) {
    const want = ncHex(pay.noteCommit);
    let hit = -1;
    for (let i = 0; i < rows.length; i += 1) {
      if (used.has(i)) continue;
      if (rows[i].nc !== want || rows[i].v !== pay.nanos) continue;
      hit = i;
      break;
    }
    if (hit < 0) return false;
    used.add(hit);
  }
  return used.size === rows.length;
}

/**
 * Pot openings are the work split of (minted pot − fee) plus one note that
 * opens to a legal subsidy fee. Fee identity is that note. No pool dest,
 * miner, or share address is required. A fee added into a hasher note does
 * not match. Two notes may share a noteCommit: the work slice and the fee.
 */
function hintOpen(o) {
  const claimed = Math.floor(Number(o?.valueProof?.v));
  if (!Number.isSafeInteger(claimed) || claimed <= 0) return null;
  return verifySealedNote(o, claimed) ? claimed : null;
}

function opensAt(o, nanos) {
  return Number.isSafeInteger(nanos) && nanos > 0 && verifySealedNote(o, nanos);
}

/** Match pays by the commitment. A published v is a hint. A missing or wrong v still opens. */
function assignOpened(rows, pays) {
  if (rows.length !== pays.length) return null;
  const used = new Set();
  const opened = [];
  for (const pay of pays) {
    const want = ncHex(pay.noteCommit);
    const nanos = pay.nanos;
    let hit = -1;
    for (let i = 0; i < rows.length; i += 1) {
      if (used.has(i)) continue;
      if (rows[i].nc !== want) continue;
      if (rows[i].v != null) {
        if (rows[i].v !== nanos) continue;
      } else if (!opensAt(rows[i].o, nanos)) continue;
      hit = i;
      break;
    }
    if (hit < 0) return null;
    used.add(hit);
    opened.push({ o: rows[hit].o, v: nanos, nc: rows[hit].nc });
  }
  return used.size === rows.length ? opened : null;
}

function matchUnfoldedPot(potVouts, leaves, wantPot, mintedPot) {
  const rows = [];
  for (const o of potVouts) {
    rows.push({ o, v: hintOpen(o), nc: ncHex(o.noteCommit) });
  }
  // Every output already opens at its published v. Do not search other amounts.
  if (rows.every((row) => row.v != null)) {
    for (const fee of legalSubsidyFees(wantPot)) {
      const pays = potPaysFromLeaves(leaves, null, fee, mintedPot, 0);
      if (fee === 0) {
        if (assignPotPays(rows, pays)) return rows;
        continue;
      }
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].v !== fee) continue;
        const rest = rows.filter((_, j) => j !== i);
        if (!assignPotPays(rest, pays)) continue;
        return rows;
      }
    }
    return null;
  }
  for (const fee of legalSubsidyFees(wantPot)) {
    const pays = potPaysFromLeaves(leaves, null, fee, mintedPot, 0);
    if (fee === 0) {
      const got = assignOpened(rows, pays);
      if (got) return got;
      continue;
    }
    if (rows.length !== pays.length + 1) continue;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row.v != null && row.v !== fee) continue;
      if (row.v == null && !opensAt(row.o, fee)) continue;
      const rest = rows.filter((_, j) => j !== i);
      const got = assignOpened(rest, pays);
      if (!got) continue;
      return got.concat([{ o: row.o, v: fee, nc: row.nc }]);
    }
  }
  return null;
}

/**
 * Older candidate list. Verify does not call this. A dest string is not
 * book law. matchUnfoldedPot reads the openings.
 */
function propPayCandidates(leaves, feeBase, hinted, extraAmt, shareBatch, splitPot = null) {
  const pot = splitPot == null ? feeBase : splitPot;
  const base = Math.max(0, Math.floor(Number(feeBase) || 0));
  const candidates = [];
  if (hinted) candidates.push(potPaysFromLeaves(leaves, hinted, extraAmt, pot));
  candidates.push(potPaysFromLeaves(leaves, null, extraAmt, pot));
  if (extraAmt > 0) candidates.push(potPaysFromLeaves(leaves, null, 0, pot));
  if (!(extraAmt > 0)) {
    const dests = new Set();
    if (hinted && isDestAddress(hinted)) dests.add(hinted);
    for (const s of shareBatch || []) {
      const d = destOfShare(s);
      if (d && isDestAddress(d)) dests.add(d);
    }
    for (const dest of dests) {
      for (let bps = 1; bps <= POOL_FEE_MAX_BPS; bps += 1) {
        const fee = Math.floor(base * bps / 10000);
        if (fee > 0) candidates.push(potPaysFromLeaves(leaves, dest, fee, pot));
      }
    }
  }
  return candidates;
}

/**
 * One non-hasher pot note: absent (0) or a bps of `wantPot` through
 * POOL_FEE_MAX_BPS. A published valueProof.v, when present, is the fee: it
 * must open the note and be a legal subsidy fee, or the note is refused
 * (COINBASE_V=opens). Only a note with no v is found by the bps search.
 */
export function extraPotFeeNanos(extraVouts = [], wantPot) {
  const pot = Math.max(0, Math.floor(Number(wantPot) || 0));
  const maxFee = Math.floor(pot * POOL_FEE_MAX_BPS / 10000);
  const extra = Array.isArray(extraVouts) ? extraVouts : [];
  if (!extra.length) return 0;
  if (extra.length !== 1 || !(pot > 0)) return null;
  const raw = extra[0]?.valueProof?.v;
  if (raw != null && raw !== '') {
    const claimed = Math.floor(Number(raw));
    if (!(claimed > 0 && claimed <= maxFee)) return null;
    for (let bps = 1; bps <= POOL_FEE_MAX_BPS; bps += 1) {
      if (Math.floor(pot * bps / 10000) === claimed && verifySealedNote(extra[0], claimed)) return claimed;
    }
    return null;
  }
  for (let bps = 1; bps <= POOL_FEE_MAX_BPS; bps += 1) {
    const n = Math.floor(pot * bps / 10000);
    if (n > 0 && n <= maxFee && verifySealedNote(extra[0], n)) return n;
  }
  return null;
}

/** Fail-closed: consensus ignores hashBonusCustodyDest unless SHEAR_ALLOW_HASHBONUS_CUSTODY=1. */
export const HASHBONUS_CUSTODY_ALLOW_ENV = 'SHEAR_ALLOW_HASHBONUS_CUSTODY';

export function allowedHashBonusCustodyDest(dest) {
  if (String(process.env.SHEAR_ALLOW_HASHBONUS_CUSTODY || '').trim() !== '1') return '';
  return dest && isDestAddress(dest) ? dest : '';
}

function sealHashPay(pay, address) {
  const nanos = Number(pay.nanos);
  const base = pay.admitBase && Buffer.from(pay.admitBase).length === 32
    ? pay.admitBase
    : (address ? admitBaseFromAddress(address) : null);
  return attachAdmitPub(sealCoinbaseNote(nanos, {
    dest20: pay.dest20,
    noteCommit: pay.noteCommit,
    kind: 'hash',
  }), { admitBase: base || null });
}


// ---- R28 BluNotes coinbase ---------------------------------------------------

function hex32(v) {
  if (v == null || v === '') return null;
  let b = null;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) b = Buffer.from(v);
  else if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)) b = Buffer.from(v, 'hex');
  return b && b.length === 32 ? b : null;
}

/**
 * The coinbase's BluNotes fields, or null when malformed. Absent is
 * { feeBps: 0 }. A fee key names the pool's own one-time key (R, P, tag);
 * prev is the parent block's record root.
 */
const BLUNOTE_FIELD_KEYS = new Set(['feeBps', 'feeR', 'feeP', 'feeTag', 'prev']);

export function blunoteFields(tx) {
  const b = tx?.blunote;
  if (b == null) return { feeBps: 0, feeKey: null, prev: null };
  if (typeof b !== 'object' || Buffer.isBuffer(b) || Array.isArray(b)) return null;
  // Only the fields the digest binds; anything else would be unbound bytes.
  for (const key of Object.keys(b)) {
    if (!BLUNOTE_FIELD_KEYS.has(key)) return null;
  }
  const feeBps = Number(b.feeBps ?? 0);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > POOL_FEE_MAX_BPS) return null;
  const R = hex32(b.feeR);
  const P = hex32(b.feeP);
  if ((b.feeR != null || b.feeP != null) && (!R || !P)) return null;
  const tag = Number(b.feeTag ?? 0);
  if (!Number.isInteger(tag) || tag < 0 || tag > 255) return null;
  if (feeBps > 0 && !P) return null;
  if (P) {
    try { pointFrom(P); } catch { return null; }
  }
  const prev = b.prev == null || b.prev === '' ? null : hex32(b.prev);
  if (b.prev != null && b.prev !== '' && !prev) return null;
  return { feeBps, feeKey: P ? { R, P, viewTag: tag } : null, prev };
}

function blunoteDigestSuffix(tx) {
  if (tx?.blunote == null) return Buffer.alloc(0);
  const f = blunoteFields(tx);
  if (!f) return null;
  const bps = Buffer.alloc(2);
  bps.writeUInt16LE(f.feeBps, 0);
  return Buffer.concat([
    Buffer.from('blunote1'),
    bps,
    f.feeKey ? f.feeKey.R : Buffer.alloc(32),
    f.feeKey ? f.feeKey.P : Buffer.alloc(32),
    Buffer.from([f.feeKey ? f.feeKey.viewTag : 0]),
    f.prev || Buffer.alloc(32),
  ]);
}

/** Pool fee nanos for this subsidy at feeBps, or 0 with no fee key. */
export function blunoteFeeNanos(subsidy, fields) {
  if (!fields?.feeKey || !(fields.feeBps > 0)) return 0n;
  return BigInt(Math.floor(Number(subsidy) * fields.feeBps / 10000));
}


/** The parent's record root, which this coinbase must name; null at height 1. */
export function parentRecordRoot(prevBlock) {
  const rec = prevBlock?.blunoteRecord;
  if (rec == null || rec === '') return null;
  return recordRoot(Buffer.isBuffer(rec) ? rec : Buffer.from(String(rec), 'hex'));
}

/**
 * Canonical template batch: BluNotes rows only, a decodable P, no repeated
 * work key or P, canonical order, and the share byte cap.
 */
export function bluTemplateBatch(rows, knownPubs = null) {
  const out = [];
  const seenWork = new Set();
  const seenP = new Set();
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.shareR != null && r.shareP != null && (r.proofSlot === 0 || r.proofSlot === 1))
    .slice()
    .sort(compareBluShares);
  let bytes = 0;
  for (const r of sorted) {
    const P = Buffer.from(r.shareP);
    try { pointFrom(P); } catch { continue; }
    const pk = P.toString('hex');
    if (knownPubs && knownPubs.has(pk)) continue;
    const wk = `${r.kinHeader && r.verifiedHeader ? Buffer.from(r.verifiedHeader).toString('hex') : r.proofSlot}:${BigInt(r.nonce || 0)}`;
    if (seenP.has(pk) || seenWork.has(wk)) continue;
    const size = bluFrameBytes(r);
    if (bytes + size > SHARE_BYTES_MAX) break;
    bytes += size;
    seenP.add(pk);
    seenWork.add(wk);
    out.push(r);
  }
  return out;
}

/**
 * The part of a BluNotes block's payout fixed before its PoW (carry, fee
 * note value, reserve extra), from the template's batch.
 */
export function bluPlanFor({ payable, finderLevy = 0, feeNanos = 0n, feeKey = null, shares = [], unitNanos, budgetNanos = null }) {
  const hash = shares.length ? blunoteHashNanos(shares, unitNanos, budgetNanos) : 0n;
  return blunotePlan({ shareCount: shares.length, potPayable: payable, feeNanos, feeKey, finderLevy, hashNanos: hash });
}

export function coinbaseTx({
  height, miner, samples = [], potShares = null, destOf = (a) => a, hashBonusNanos = HASH_BONUS_NANOS,
  shareBatch = null, poolDest = null, potNanos = BLOCK_SUBSIDY_NANOS,
  hashBonusCustodyDest = null,
  carryNanos = 0,
  hashOwedIn = null,
  hashDustIn = null,
  hashOverflowIn = null,
  hashAcceptedSeries = null,
  hashSpill = null,
}) {
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const carry = Math.max(0, Math.floor(Number(carryNanos) || 0));
  const bonuses = hashBonusByMiner(samples, hashBonusNanos, shareBatch);
  const vout = [];
  // v12 does not retarget the hash bonus or the pot onto a custody dest.
  // Explicit shares still name the pot. Callers that pass a custodial list
  // build a block verify rejects.
  void hashBonusCustodyDest;
  const explicit = Array.isArray(potShares);
  let shares = explicit ? potShares : null;
  if (!explicit) {
    if (Array.isArray(shareBatch) && shareBatch.length) {
      shares = potSharesFromBatch(shareBatch, poolDest, pot);
      if (!shares.length) shares = [{ address: miner, nanos: pot, kind: 'pot' }];
    } else if (carry > 0) {
      shares = [];
    } else {
      shares = [{ address: miner, nanos: pot, kind: 'pot' }];
    }
  }
  for (const s of shares) {
    const pay = destOf(s.address);
    if (!isDestAddress(pay) || !s.nanos) continue;
    const d20 = hash20FromAddress(pay);
    vout.push(attachAdmitPub(sealCoinbaseNote(s.nanos, { dest20: d20, kind: s.kind || 'pot' }), {
      admitBase: admitBaseFromAddress(pay),
    }));
  }
  // Hash notes follow the owed settlement. Under the cap with nothing
  // owed, that is the retained share and the vout order matches the
  // first-seen dest order. An empty batch with an empty ledger mints no
  // hash note here. A later producer pays parent rows the same way.
  const fresh = freshCreditsFromShares(shareBatch || [], hashBonusNanos);
  const spill = freshCreditsFromShares(hashSpill || [], hashBonusNanos);
  const budget = hashAcceptedSeries == null ? null : hashBudgetNanos(hashAcceptedSeries, hashBonusNanos);
  if (hashAcceptedSeries != null && budget == null) throw new Error('hash_owed');
  const settled = settleHashOwed({
    owedIn: hashOwedIn || [],
    dustIn: hashDustIn || 0n,
    overflowIn: hashOverflowIn || 0n,
    fresh,
    spill,
    height,
    unit: hashBonusNanos,
    budget,
  });
  if (!settled.ok) throw new Error(settled.reason || 'hash_owed');
  const payByHex = new Map(settled.pay.map((p) => [p.noteCommit.toString('hex'), p]));
  const emitted = new Set();
  for (const [address] of bonuses) {
    const payAddr = destOf(address);
    if (!isDestAddress(payAddr)) continue;
    const d20 = hash20FromAddress(payAddr);
    if (!d20) continue;
    let nc;
    try { nc = noteCommitOfDest20(d20); } catch { continue; }
    const hex = nc.toString('hex');
    const pay = payByHex.get(hex);
    if (!pay || emitted.has(hex)) continue;
    if (pay.nanos > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('hash_owed');
    emitted.add(hex);
    vout.push(sealHashPay(pay, payAddr));
  }
  for (const pay of settled.pay) {
    const hex = pay.noteCommit.toString('hex');
    if (emitted.has(hex)) continue;
    if (pay.nanos > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('hash_owed');
    emitted.add(hex);
    const addr = pay.address && isDestAddress(pay.address)
      ? pay.address
      : encodeDest(pay.dest20);
    vout.push(sealHashPay(pay, addr));
  }
  const carriedRows = (settled.owed?.length || 0) + (settled.owedRest?.length || 0);
  if (!vout.length && carry <= 0 && settled.minted === 0n && carriedRows === 0) {
    throw new Error('coinbase_needs_dest');
  }
  const tx = {
    coinbase: true,
    height,
    vin: [{ coinbase: true, height }],
    vout,
    excess: excessOf(vout),
    carryNanos: carry,
  };
  writeHashLedger(tx, settled);
  return tx;
}

function noteDest20(o) {
  if (o?.dest20 != null && o.dest20 !== '') {
    try {
      const b = Buffer.from(asU8(o.dest20));
      if (b.length >= 20) return b.subarray(0, 20);
    } catch { /* address fallback */ }
  }
  const addr = String(o?.address || '');
  if (isDestAddress(addr)) {
    const h = hash20FromAddress(addr);
    if (h) return Buffer.from(h);
  }
  return null;
}

/** A fee address is not a block finder. The reserve dest is the other half.
 * The unclaimed hold is not a miner either. */
function forbiddenFinderDest(dest, poolDest, feeDest) {
  if (!dest || !isDestAddress(dest)) return true;
  if (dest === reserveFeeDest() || dest === poolFeeDest()) return true;
  if (dest === unclaimedFinderDest()) return true;
  if (poolDest && isDestAddress(poolDest) && dest === poolDest) return true;
  if (feeDest && isDestAddress(feeDest) && dest === feeDest) return true;
  return false;
}

/**
 * Who the finder-fee note pays. An explicit dest is the miner who hashes
 * this header. Undefined is the solo miner. '' or null holds the finder
 * half at the unclaimed dest so a fee round still has both levy notes.
 * Aiming at that hold, the reserve, or a fee dest pays nobody.
 */
function resolveFinderPay(finderDest, miner, poolDest, feeDest, pay) {
  if (finderDest === '' || finderDest === null) return unclaimedFinderDest();
  const named = finderDest !== undefined ? String(finderDest) : String(pay(miner) || '');
  if (forbiddenFinderDest(named, poolDest, feeDest)) return '';
  return named;
}

function sealLevyNote(nanos, dest, kind) {
  const d20 = hash20FromAddress(dest);
  if (!d20) return { address: dest, nanos, kind };
  return attachAdmitPub(sealCoinbaseNote(nanos, { dest20: d20, kind }), {
    admitBase: admitBaseFromAddress(dest),
  });
}

function levyRootOf(bind, addedPubs) {
  if (bind?.zeroFrontier) {
    const root = extendZeroRoot({ zeroFrontier: bind.zeroFrontier }, addedPubs);
    if (root) return Buffer.from(root);
  }
  const pubs = [...(bind?.parentPubs || []), ...addedPubs];
  if (!pubs.length) return null;
  return Buffer.from(jrootOf(pubs.map((p) => (typeof p?.toBytes === 'function' ? p : p))));
}

function pubsJoining(txs) {
  const added = [];
  for (const tx of txs || []) {
    for (const o of tx?.vout || []) {
      if (outputJoinsAdmitSet(tx, o)) added.push(o.admitPub);
    }
  }
  return added;
}

/**
 * Amount and dest of the levy notes. Every finder-fee note pays one dest,
 * and that dest is not the reserve or the protocol pool fee. Every
 * reserve-fee note pays the reserve. Sums match splitLevy.
 */
export function coinbaseLevyPays(cb, fees, levyOpts = {}) {
  const split = splitLevy(fees);
  const rows = (kind) => (cb?.vout || []).filter((v) => v?.kind === kind);
  const openedSum = (list) => {
    let sum = 0;
    for (const o of list) {
      const v = openedCoinbaseNanos(o);
      if (v == null) return null;
      sum += v;
    }
    return sum;
  };
  const finderRows = rows('finder-fee');
  const reserveRows = rows('reserve-fee');
  if (split.finder === 0 ? finderRows.length !== 0 : openedSum(finderRows) !== split.finder) {
    return { ok: false, reason: 'levy_split' };
  }
  if (split.reserve === 0 ? reserveRows.length !== 0 : openedSum(reserveRows) !== split.reserve) {
    return { ok: false, reason: 'levy_split' };
  }
  const reserve20 = Buffer.from(hash20FromAddress(reserveFeeDest()));
  const pool20 = Buffer.from(hash20FromAddress(poolFeeDest()));
  const shareBatch = Array.isArray(levyOpts?.shareBatch) ? levyOpts.shareBatch : [];
  const finderWork = shareBatch.length
    ? aLeavesFromShares(shareBatch).reduce((a, l) => a + (Number(l.count) || 0), 0)
    : 0;
  if (finderWork > 0) {
    const want = finderFeePays(shareBatch, split.finder, levyOpts?.miner || '');
    if (want.length !== finderRows.length) return { ok: false, reason: 'levy_split' };
    const used = new Set();
    for (const row of want) {
      const hit = finderRows.findIndex((o, i) => {
        if (used.has(i)) return false;
        if (openedCoinbaseNanos(o) !== row.nanos) return false;
        if (row.noteCommit && o.noteCommit) return ncHex(o.noteCommit) === ncHex(row.noteCommit);
        return true;
      });
      if (hit < 0) return { ok: false, reason: 'levy_split' };
      const d20 = noteDest20(finderRows[hit]);
      if (!d20 || d20.equals(reserve20) || d20.equals(pool20)) return { ok: false, reason: 'levy_split' };
      used.add(hit);
    }
  } else {
  let finder20 = null;
  for (const o of finderRows) {
    const d20 = noteDest20(o);
    if (!d20 || d20.equals(reserve20) || d20.equals(pool20)) return { ok: false, reason: 'levy_split' };
    if (finder20 && !finder20.equals(d20)) return { ok: false, reason: 'levy_split' };
    finder20 = d20;
  }
  }
  for (const o of reserveRows) {
    const d20 = noteDest20(o);
    if (!d20 || !d20.equals(reserve20)) return { ok: false, reason: 'levy_split' };
  }
  return { ok: true, finder: split.finder, reserve: split.reserve };
}

/** Memory bound for aimed finder headers. Not a miner-count tuning. */
const FINDER_AIM_CACHE_BOUND = 4096;
const finderAimCache = new Map();
let finderAimSealCount = 0;

/** How many finder-fee notes templateForFinder has sealed. A cache hit does not count. */
export function finderAimSeals() {
  return finderAimSealCount;
}

export function resetFinderAimSeals() {
  finderAimSealCount = 0;
}

/** Timestamp, bits, and nonce are stamped later. The merkle stays in the key. */
function finderAimKey(header, dest, finderNanos) {
  try {
    const buf = Buffer.from(header);
    if (buf.length !== 128) return '';
    const stamp = Buffer.from(buf);
    stamp.fill(0, 100, 112);
    stamp.fill(0, 112, 120);
    return `${stamp.toString('hex')}:${dest}:${finderNanos}`;
  } catch {
    return '';
  }
}

function rememberFinderAim(key, built) {
  if (!key || !built) return;
  if (finderAimCache.has(key)) finderAimCache.delete(key);
  finderAimCache.set(key, built);
  while (finderAimCache.size > FINDER_AIM_CACHE_BOUND) {
    const oldest = finderAimCache.keys().next().value;
    finderAimCache.delete(oldest);
  }
}

/** A copy. A restamp keeps the cached merkle and takes the input stamp. */
function stampAimed(cached, tpl) {
  const decodedIn = decodeHeader(Buffer.from(tpl.header));
  const decodedCached = decodeHeader(Buffer.from(cached.header));
  let header = Buffer.from(cached.header);
  const merkle = Buffer.from(cached.merkleRoot);
  if (decodedIn.timestamp !== decodedCached.timestamp || Number(decodedIn.bits) !== Number(decodedCached.bits)) {
    header = encodeHeader({
      version: decodedCached.version,
      prevBlockHash: decodedCached.prevBlockHash,
      merkleRoot: decodedCached.merkleRoot,
      continuityRoot: decodedCached.continuityRoot,
      timestamp: decodedIn.timestamp,
      bits: decodedIn.bits,
      nonce: 0n,
      baseFee: decodedCached.baseFee,
    });
  }
  const cb = cached.txs[0];
  const vout = (cb.vout || []).map((o) => ({ ...o }));
  const nextCb = { ...cb, vout };
  const txs = [nextCb, ...(cached.txs || []).slice(1)];
  return {
    ...cached,
    header,
    merkleRoot: merkle,
    txs,
  };
}

/**
 * Look up an aimed header without sealing. `miss` means a later
 * templateForFinder call would seal a new finder-fee note.
 */
function finderAimPeek(tpl, finderDest) {
  const bind = tpl?.levyBind;
  if (!bind || !(bind.finderNanos > 0)) return { state: 'plain', tpl: tpl || null };
  const dest = String(finderDest || '');
  if (forbiddenFinderDest(dest, bind.poolDest, bind.feeDest)) return { state: 'refuse' };
  const cb = tpl.txs?.[0];
  if (!cb?.coinbase) return { state: 'refuse' };
  const finderNotes = (cb.vout || []).filter((o) => o.kind === 'finder-fee');
  if (finderNotes.length > 1) return { state: 'plain', tpl };
  const existing = finderNotes[0];
  const want = hash20FromAddress(dest);
  if (existing && want && noteDest20(existing)?.equals(Buffer.from(want))) return { state: 'plain', tpl };
  const key = finderAimKey(tpl.header, dest, bind.finderNanos);
  if (key && finderAimCache.has(key)) {
    const hit = finderAimCache.get(key);
    rememberFinderAim(key, hit);
    return { state: 'hit', tpl: stampAimed(hit, tpl) };
  }
  return { state: 'miss', bind, dest, cb, key };
}

/** Cache peek for the pool handler. A miss does not seal. */
export function cachedFinderTemplate(tpl, finderDest) {
  const peek = finderAimPeek(tpl, finderDest);
  if (peek.state === 'refuse') return { ok: false };
  if (peek.state === 'miss') return { ok: true, miss: true };
  return { ok: true, tpl: peek.tpl };
}

/**
 * One header whose finder-fee pays `finderDest`. The pot notes stay.
 * The shared template holds the finder half at the unclaimed dest until a
 * miner aims. A fee dest, the reserve, and that hold are refused.
 * A repeat for the same round and dest reuses the sealed note.
 */
export function templateForFinder(tpl, finderDest) {
  const peek = finderAimPeek(tpl, finderDest);
  if (peek.state === 'refuse') return null;
  if (peek.state === 'plain' || peek.state === 'hit') return peek.tpl;
  const { bind, dest, cb, key } = peek;
  finderAimSealCount += 1;
  const note = sealLevyNote(bind.finderNanos, dest, 'finder-fee');
  const vout = (cb.vout || []).filter((o) => o.kind !== 'finder-fee');
  const reserveAt = vout.findIndex((o) => o.kind === 'reserve-fee');
  if (reserveAt >= 0) vout.splice(reserveAt, 0, note);
  else vout.push(note);
  const nextCb = { ...cb, vout, excess: excessOf(vout) };
  const txs = [nextCb, ...(tpl.txs || []).slice(1)];
  const root = levyRootOf(bind, pubsJoining(txs));
  if (cb.jroot && !root) return null;
  if (root) nextCb.jroot = root;
  const merkle = merkleRoot(txs.map(digestTx));
  const decoded = decodeHeader(Buffer.from(tpl.header));
  const header = encodeHeader({
    version: decoded.version,
    prevBlockHash: decoded.prevBlockHash,
    merkleRoot: merkle,
    continuityRoot: decoded.continuityRoot,
    timestamp: decoded.timestamp,
    bits: decoded.bits,
    nonce: 0n,
    baseFee: decoded.baseFee,
  });
  const built = {
    ...tpl,
    header,
    merkleRoot: merkle,
    txs,
    miner: dest,
    weight: blockWeight(txs, tpl.bLeaves),
  };
  rememberFinderAim(key, built);
  return stampAimed(built, tpl);
}

function droppedPotNanos(o) {
  const kind = String(o?.kind || '');
  // Hash and levy notes are not pot. Folding them into the carry would mint
  // the wrong supply. Refuse the template instead of publishing that block.
  if (kind === 'hash' || kind === 'finder-fee' || kind === 'reserve-fee') {
    throw new Error('admit_note_point');
  }
  const opened = openedNoteNanos(o);
  if (opened == null) throw new Error('admit_note_point');
  return opened;
}

function openedNoteNanos(o) {
  const opened = o?.valueProof && o.valueProof.v != null && o.valueProof.v !== ''
    ? Number(o.valueProof.v)
    : Number(o?.nanos || 0);
  if (!Number.isSafeInteger(opened) || opened < 0) return null;
  return opened;
}

/** B from a kept pot note, so the reseal still pays that dest. */
function admitBaseOfKeptPot(o) {
  const named = o?.address ? admitBaseFromAddress(o.address) : null;
  if (named && named.length === 32) return named;
  const P = pointFrom(o.admitPub);
  return pointBytes(P.subtract(G.multiply(admitDelta(o))));
}

function resealPotPayee(o, nanos) {
  const dest20 = noteDest20(o);
  if (!dest20) throw new Error('admit_note_point');
  return attachAdmitPub(sealCoinbaseNote(nanos, { dest20, kind: 'pot' }), {
    admitBase: admitBaseOfKeptPot(o),
  });
}

/**
 * Drop a coinbase payee that is not an FS-1 leaf.
 * With no share batch, a dropped pot share is split again over the pot
 * payees that remain, by the same last-remainder rule as potPaysFromLeaves.
 * Their notes are resealed at the new amounts. If none remain, the whole
 * pot is carried and no pot note is left beside that carry.
 * A share batch already fixed those pays. Re-splitting them misses
 * pot_prop, and carrying them misses pot_carry, so this throws.
 * buildTemplate catches that, drops every share of the broken payee,
 * and builds again. A hash or levy note has no pot to rejoin, so that
 * drop throws either way.
 */
export function dropBrokenCoinbaseNotes(cb, { shares = false } = {}) {
  if (!(cb && typeof cb === 'object')) return cb;
  const kept = [];
  const dropped = [];
  for (const o of cb.vout || []) {
    if (outputJoinsAdmitSet(cb, o) && !fs1LeafFor(o)) {
      const n = droppedPotNanos(o);
      const kind = String(o?.kind || cb?.kind || '');
      dropped.push({ kind, nanos: n });
      console.error(JSON.stringify({
        event: 'coinbase_note_drop',
        reason: 'admit_note_point',
        kind,
        nanos: n,
      }));
      continue;
    }
    kept.push(o);
  }
  if (shares && dropped.length) throw new Error('admit_note_point');
  cb.vout = kept;
  if (!dropped.length) return cb;
  let droppedNanos = 0;
  for (const row of dropped) {
    if (!Number.isSafeInteger(droppedNanos + row.nanos)) throw new Error('admit_note_point');
    droppedNanos += row.nanos;
  }
  const pots = kept.filter((o) => String(o?.kind || '') === 'pot');
  if (!pots.length || droppedNanos === 0) {
    if (!pots.length && droppedNanos > 0) {
      const carry = canonicalCarry(cb);
      if (carry == null || !Number.isSafeInteger(carry + droppedNanos)) throw new Error('admit_note_point');
      cb.carryNanos = carry + droppedNanos;
    }
    const excess = excessOf(kept);
    if (!excess) throw new Error('admit_note_point');
    cb.excess = excess;
    return cb;
  }
  const carry = canonicalCarry(cb);
  if (carry == null) throw new Error('admit_note_point');
  // Consensus rejects a carry beside a pot note. The amount re-split is the
  // pot still opened, the dropped share, and any carry already on this tx.
  let potSum = droppedNanos + carry;
  const leaves = [];
  for (const o of pots) {
    const n = openedNoteNanos(o);
    if (n == null || !Number.isSafeInteger(potSum + n)) throw new Error('admit_note_point');
    potSum += n;
    const dest20 = noteDest20(o);
    if (!dest20) throw new Error('admit_note_point');
    leaves.push({
      output: o,
      noteCommit: noteCommitOfDest20(dest20),
      count: n > 0 ? n : 1,
    });
  }
  const pays = potPaysFromLeaves(
    leaves.map((leaf) => ({ noteCommit: leaf.noteCommit, count: leaf.count })),
    null,
    0,
    potSum,
    0,
  );
  const used = new Set();
  const resealed = [];
  for (const pay of pays) {
    const src = leaves.find((leaf) => !used.has(leaf) && ncHex(leaf.noteCommit) === ncHex(pay.noteCommit));
    if (!src) throw new Error('admit_note_point');
    used.add(src);
    resealed.push(resealPotPayee(src.output, pay.nanos));
  }
  if (!resealed.length) throw new Error('admit_note_point');
  const next = [];
  let placed = false;
  for (const o of kept) {
    if (String(o?.kind || '') === 'pot') {
      if (!placed) {
        next.push(...resealed);
        placed = true;
      }
      continue;
    }
    next.push(o);
  }
  const excess = excessOf(next);
  if (!excess) throw new Error('admit_note_point');
  cb.vout = next;
  cb.excess = excess;
  if (carry > 0) cb.carryNanos = 0;
  return cb;
}

function brokenPayeeHexes(cb) {
  const bad = new Set();
  for (const o of cb?.vout || []) {
    if (!outputJoinsAdmitSet(cb, o) || fs1LeafFor(o)) continue;
    const d20 = noteDest20(o);
    if (d20 && d20.length >= 20) bad.add(Buffer.from(d20.subarray(0, 20)).toString('hex'));
  }
  return bad;
}

function shareHitsBrokenPayee(share, bad) {
  if (!bad.size) return false;
  let d20 = null;
  try { d20 = dest20OfShare(share); } catch { d20 = null; }
  if (!d20 || d20.length < 20) return false;
  return bad.has(Buffer.from(d20.subarray(0, 20)).toString('hex'));
}

export function buildTemplate({
  prev,
  prevHeader,
  prevBlock = null,
  parentWeight: parentWeightIn,
  height,
  miner,
  samples = [],
  txs = [],
  bLeaves: bLeavesIn,
  now = Date.now(),
  bits,
  destOf,
  potShares = null,
  hashBonusNanos = HASH_BONUS_NANOS,
  shareBatch = null,
  poolDest = null,
  feeDest = null,
  finderDest,
  hashBonusCustodyDest = null,
  parentFluxset = null,
  parentBlocks = null,
  hashAcceptedSeries = null,
  hashOwedIn: hashOwedInOpt = null,
  issuedHeaders = null,
  hashSpill = null,
  prepareCoinbase = null,
  feeKey = null,
  feeBps = 0,
}) {
  txs = (Array.isArray(txs) ? txs : []).filter((tx) => !tx?.coinbase && !txNoteRuleRejected(tx, 1) && !feeFieldRejected(tx) && !bSpendFeeRejected(tx));
  // R28: spill is retired (D2); a slot-1 share is simply a share.
  void hashSpill;
  const selected = Array.isArray(shareBatch) ? shareBatch : [];
  const priorBlock = Array.isArray(parentBlocks) && parentBlocks.length >= 2
    ? parentBlocks[parentBlocks.length - 2]
    : null;
  const knownPubs = parentFluxset && !Array.isArray(parentFluxset) ? admitPubIndex(parentFluxset) : null;
  const batch = bluTemplateBatch(bindShareProofSlots(selected, prevHeader, priorBlock?.header || null, {
    keepClaim: true,
  }).slotted, knownPubs);
  const spillBatch = [];
  // R28: shares pay by draw, not per payee, so tree A has no payee leaves.
  const collated = [];
  const pay = destOf || ((login) => hasherPayoutDest(login) || '');
  let genesisMs = chainGenesisMsFrom(parentBlocks, null);
  if (!(genesisMs > 0) && prevHeader) {
    try {
      const parent = decodeHeader(Buffer.from(prevHeader));
      if (parent.prevBlockHash.equals(GENESIS_PREV)) genesisMs = Number(parent.timestamp) || 0;
    } catch { /* parent is not a readable header */ }
  }
  if (!(genesisMs > 0) && Number(height) === 1) genesisMs = Number(now) || 0;
  const subsidy = potSubsidyAt({
    nowMs: now,
    genesisMs: genesisMs > 0 ? genesisMs : Number(now) || 0,
    magic: MAGIC_TESTNET,
  });
  // Parent carry is unminted miner pot. Explicit shares mint what they name.
  // Anything still unpaid, including an empty list, stays carried. Solo
  // (null shares) pays the miner the subsidy plus that carry and carries nothing.
  const carryIn = canonicalCarry(prevBlock?.txs?.[0]) || 0;
  const parentCb = prevBlock?.txs?.[0] || null;
  let series = Array.isArray(hashAcceptedSeries) ? hashAcceptedSeries : null;
  // Maintained owed state. A lean parent root is not a reason to walk the chain.
  let hashOwedIn = Array.isArray(hashOwedInOpt) ? hashOwedInOpt : hashOwedFromTx(parentCb);
  if (Array.isArray(hashOwedInOpt) && parentCb && !hashOwedRootAgrees(parentCb, hashOwedInOpt)) {
    throw new Error('hash_owed');
  }
  const hashDustIn = hashDustFromTx(parentCb);
  const hashOverflowIn = hashOverflowFromTx(parentCb);
  if (hashOwedIn == null || hashDustIn == null || hashOverflowIn == null) {
    throw new Error('hash_owed');
  }
  const payable = subsidy + carryIn;
  void potShares;
  void hashOwedIn;
  void hashDustIn;
  void hashOverflowIn;
  // A leaf-vote fee is the note it spends. A declared number with no spend
  // is not minted into the reserve fee note.
  const fees = (txs || []).reduce((a, t) => {
    if (String(t?.kind || '') === 'leaf-vote' && leafVoteFundingRejected(t)) return a;
    const n = postedFeeNanos(t);
    return a + (n == null || n < 0 ? 0 : n);
  }, 0);
  const split = splitLevy(fees);
  // R28 BluNotes: no share payout notes. The finder levy joins the draw.
  const fields = blunoteFields({ blunote: feeKey ? {
    feeBps,
    feeR: Buffer.from(feeKey.R),
    feeP: Buffer.from(feeKey.P),
    feeTag: Number(feeKey.viewTag ?? feeKey.tag ?? 0) & 0xff,
  } : { feeBps: 0 } });
  if (!fields) throw new Error('blunote_fee');
  const feeNanos = blunoteFeeNanos(subsidy, fields);
  const budget = series == null ? null : hashBudgetNanos(series, hashBonusNanos);
  const plan = bluPlanFor({
    payable,
    finderLevy: split.finder,
    feeNanos,
    feeKey: fields.feeKey,
    shares: batch,
    unitNanos: hashBonusUnitNanos(hashBonusNanos),
    budgetNanos: budget,
  });
  const carryOut = plan.carryOut;
  const prevRoot = parentRecordRoot(prevBlock);
  const cb = {
    coinbase: true,
    height,
    vin: [{ coinbase: true, height }],
    vout: [],
    carryNanos: Number(carryOut),
    blunote: {
      feeBps: fields.feeBps,
      ...(fields.feeKey ? { feeR: fields.feeKey.R, feeP: fields.feeKey.P, feeTag: fields.feeKey.viewTag } : {}),
      ...(prevRoot ? { prev: prevRoot } : {}),
    },
  };
  if (!Number.isSafeInteger(cb.carryNanos)) throw new Error('pot_carry');
  // An empty batch with no fee key pays its finder levy with the reserve note.
  const reserveNanos = split.reserve + Number(plan.reserveExtra);
  if (reserveNanos) cb.vout.push(sealLevyNote(reserveNanos, reserveFeeDest(), 'reserve-fee'));
  if (typeof prepareCoinbase === 'function') prepareCoinbase(cb);
  dropBrokenCoinbaseNotes(cb, { shares: false });
  cb.excess = excessOf(cb.vout);
  cb.shareSlotRoot = shareSlotRoot(batch);
  const issuedJobKeys = issuedKeysForParents(issuedHeaders, prevHeader, priorBlock?.header || null);
  if (issuedJobKeys.length) cb.issuedJobKeys = issuedJobKeys;
  const addedPubs = [];
  for (const o of cb.vout || []) {
    if (outputJoinsAdmitSet(cb, o)) addedPubs.push(o.admitPub);
  }
  for (const tx of txs || []) {
    for (const o of tx.vout || []) {
      if (outputJoinsAdmitSet(tx, o)) addedPubs.push(o.admitPub);
    }
  }
  // The live flux already has a pubs-only frontier. Extend it by this block's
  // notes. Rebuilding J from every ancestor is what made connect and reorg
  // quadratic.
  let parentFlux = null;
  const hasParentBlock = !!prevBlock || (Array.isArray(parentBlocks) && parentBlocks.length > 0);
  if (parentFluxset && !Array.isArray(parentFluxset) && parentFluxset.zeroFrontier) {
    parentFlux = parentFluxset;
  } else if (!Array.isArray(parentFluxset) && (hasParentBlock || Number(height) === 1)) {
    // A missing parent at height > 1 is not an empty book. Stamping a jroot
    // from that empty frontier commits only this block's pubs and fails
    // admit_membership against the chain the block actually extends.
    parentFlux = fluxsetFromBlocks(parentBlocks || (prevBlock ? [prevBlock] : []));
  }
  const parentPubs = parentFlux?.pubs
    || (Array.isArray(parentFluxset) ? parentFluxset : []);
  let root = parentFlux ? extendZeroRoot(parentFlux, addedPubs) : null;
  if (!root && (Number(height) === 1 || parentPubs.length || prevBlock || parentBlocks)) {
    const newPubs = [...parentPubs, ...addedPubs];
    root = jrootOf(newPubs.map((p) => (typeof p?.toBytes === 'function' ? p : p)));
  }
  if (root && (Number(height) === 1 || parentPubs.length || prevBlock || parentBlocks || addedPubs.length)) {
    cb.jroot = root;
  }
  const bodyTxs = [cb, ...txs];
  const merkle = merkleRoot(bodyTxs.map(digestTx));
  const aLeaves = aLeavesOf(collated, pay);
  const bLeaves = Array.isArray(bLeavesIn) ? bLeavesIn : bLeavesOf(txs, pay);
  const dual = buildDualTree({ aLeaves, bLeaves });
  let parentBase = 1;
  if (prevHeader) {
    try {
      parentBase = Number(decodeHeader(Buffer.from(prevHeader)).baseFee || 1n);
    } catch { parentBase = 1; }
  }
  let parentWeight = parentWeightIn;
  if (parentWeight == null && prevBlock) {
    parentWeight = Number(prevBlock.weight != null
      ? prevBlock.weight
      : blockWeight(prevBlock.txs || [], prevBlock.bLeaves || []));
  }
  if (parentWeight == null) parentWeight = 1;
  const baseFee = nextBaseFee(parentBase, parentWeight);
  const header = encodeHeader({
    version: VERSION,
    prevBlockHash: prev || GENESIS_PREV,
    merkleRoot: merkle,
    continuityRoot: dual.continuityRoot,
    timestamp: BigInt(now),
    bits: bits ?? GENESIS_BITS_PACKED,
    nonce: 0n,
    baseFee: BigInt(baseFee),
  });
  return {
    height,
    bits: bits ?? GENESIS_BITS_PACKED,
    header,
    merkleRoot: merkle,
    continuityRoot: dual.continuityRoot,
    rootA: dual.rootA,
    rootB: dual.rootB,
    aLeaves,
    bLeaves,
    baseFee,
    weight: blockWeight(bodyTxs, bLeaves),
    txs: bodyTxs,
    samples: Array.isArray(samples) && samples.length ? collateSamples(samples) : collated,
    shareBatch: batch,
    hashSpill: spillBatch,
    miner,
    poolDest: poolDest || allowedHashBonusCustodyDest(hashBonusCustodyDest) || '',
    hashBonusCustodyDest: allowedHashBonusCustodyDest(hashBonusCustodyDest) || '',
    hashCredits: [],
    levyBind: {
      finderNanos: split.finder,
      reserveNanos: split.reserve,
      poolDest: poolDest && isDestAddress(poolDest) ? poolDest : '',
      feeDest: feeDest && isDestAddress(feeDest) ? feeDest : '',
      zeroFrontier: parentFlux?.zeroFrontier ? Buffer.from(parentFlux.zeroFrontier) : null,
      parentPubs: parentPubs.slice(),
    },
  };
}

export function mineTemplate(tpl, {
  maxTries = 1_000_000,
  shareBits = 8,
  nonceStart = 0n,
  blockOnly = false,
} = {}) {
  const start = BigInt(nonceStart);
  for (let i = 0n; i < BigInt(maxTries); i += 1n) {
    const n = start + i;
    const header = setNonce(tpl.header, n);
    const hash = shearHash(header);
    if (meetsTarget(hash, tpl.bits)) {
      return { header, hash, nonce: n, block: true };
    }
    if (!blockOnly && meetsTarget(hash, shareBits)) {
      return { header, hash, nonce: n, block: false };
    }
  }
  return null;
}

export function headerHash(header) {
  return shearHash(header);
}

export const PHASE_B_GATE = true;

export function phaseBGate() {
  return {
    verifyBlockExecutesEvm: true,
    nativeFlowSend: true,
    evmSheValueTransfer: true,
    ok: true,
  };
}

export { blockNeedsEvm };

const preparedHeaderPow = new Map();

function headerPowKey(header) {
  return Buffer.from(header).toString('hex');
}

function stashPreparedHeader(header, hash) {
  preparedHeaderPow.set(headerPowKey(header), Buffer.from(hash));
}

function takePreparedHeader(header) {
  const key = headerPowKey(header);
  const found = preparedHeaderPow.get(key);
  if (!found) return null;
  preparedHeaderPow.delete(key);
  return found;
}

function peekPreparedHeader(header) {
  const found = preparedHeaderPow.get(headerPowKey(header));
  return found ? Buffer.from(found) : null;
}

/** The hash assessHeader stashed for this header, or null. Read-only. */
export function preparedHeaderHash(header) {
  return header ? peekPreparedHeader(header) : null;
}

export function discardPreparedHeader(header) {
  if (header) dropPreparedHeader(header);
}

/**
 * A worker already hashed this header. The sync verifier still checks the
 * target. This does not invent trustedPowHash.
 */
export function holdPreparedHeader(header, hash) {
  const buf = Buffer.from(hash || []);
  if (!header || buf.length !== 32) return false;
  stashPreparedHeader(header, buf);
  return true;
}

function dropPreparedHeader(header) {
  preparedHeaderPow.delete(headerPowKey(header));
}

function shareNonceKeys(shares, provedOnHeader) {
  return paidWorkKeys(shares, provedOnHeader);
}

/**
 * Hash the header and each share header on the worker before the sync
 * verifier runs. The sync verifier still checks targets; this only moves
 * RandomX off the accept thread. trustedPowHash is never invented here.
 * When the store supplies the grandparent header, each share is also hashed
 * against that header so a one-step deferred proof is not a sync RandomX.
 */
async function prepareOffLoopPow(block, prev, { skipSharePow = false, priorHeader = null } = {}) {
  if (!block?.header) return { ok: false, reason: 'no_header' };
  const h = Buffer.from(block.header);
  let decoded;
  try {
    decoded = decodeHeader(h);
  } catch {
    return { ok: false, reason: 'bad_header' };
  }
  if (decoded.version !== VERSION) return { ok: false, reason: 'version' };
  const wantPrev = prev?.hash ? Buffer.from(prev.hash) : GENESIS_PREV;
  if (!decoded.prevBlockHash.equals(wantPrev)) return { ok: false, reason: 'prev' };
  const shareHeaders = [];
  const shareLists = [];
  if (Array.isArray(block.shareBatch) && block.shareBatch.length) shareLists.push(block.shareBatch);
  if (Array.isArray(block.hashSpill) && block.hashSpill.length) shareLists.push(block.hashSpill);
  if (!skipSharePow && prev?.header && shareLists.length) {
    let rows = [];
    for (const list of shareLists) {
      try {
        rows = rows.concat(unpackShareBatch(list));
      } catch { /* the sync verifier reports the bad row */ }
    }
    const parent = Buffer.from(prev.header);
    let prior = null;
    if (priorHeader) {
      try {
        const raw = Buffer.isBuffer(priorHeader) ? Buffer.from(priorHeader) : Buffer.from(priorHeader);
        if (raw.length === 128) prior = raw;
      } catch { prior = null; }
    }
    for (const s of rows) {
      try {
        const nonce = BigInt(s?.nonce || 0);
        const slot = s?.proofSlot;
        const workRow = (s?.shareBits != null && s.shareBits !== '')
          || (s?.creditedShareBits != null && s.creditedShareBits !== '');
        const ownRaw = s?.verifiedHeader ? Buffer.from(s.verifiedHeader) : null;
        const own = ownRaw && ownRaw.length === 128 ? ownRaw : null;
        if (slot === 1 || slot === '1') {
          const base = own || prior || parent;
          shareHeaders.push(setNonce(base, nonce));
        } else if (slot === 0 || slot === '0') {
          shareHeaders.push(setNonce(own || parent, nonce));
        } else if (!workRow) {
          shareHeaders.push(setNonce(parent, nonce));
          if (prior) shareHeaders.push(setNonce(prior, nonce));
        }
      } catch { /* sync verifier reports the bad row */ }
    }
  }
  // A burial append may already have hashed this header on the other
  // worker while the new header above it was proving. Reuse that ShearHash.
  // Share headers still hash here. The target check stays in the verifier.
  const pending = [];
  const headerReady = peekPreparedHeader(h);
  if (!headerReady) pending.push(h);
  const sharePending = [];
  for (const sh of shareHeaders) {
    if (peekSharePow(sh)) sharePending.push(null);
    else {
      sharePending.push(sh);
      pending.push(sh);
    }
  }
  let hashes = [];
  if (pending.length) {
    try {
      hashes = await Promise.all(pending.map((hdr) => hashHeaderOffLoop(hdr)));
    } catch {
      // The local hash worker failed. Nothing about the block is known yet.
      return { ok: false, reason: 'pow_worker' };
    }
    if (hashes.length !== pending.length) return { ok: false, reason: 'pow_worker' };
  }
  let cursor = 0;
  if (!headerReady) {
    stashPreparedHeader(h, hashes[cursor]);
    cursor += 1;
  }
  const shareKeys = [];
  for (let i = 0; i < shareHeaders.length; i += 1) {
    if (sharePending[i] == null) {
      shareKeys.push(Buffer.from(shareHeaders[i]).toString('hex'));
      continue;
    }
    shareKeys.push(stashSharePow(shareHeaders[i], hashes[cursor]));
    cursor += 1;
  }
  return {
    ok: true,
    cleanup() {
      dropPreparedHeader(h);
      dropSharePowKeys(shareKeys);
    },
  };
}

function hashPaysMatch(hashVouts, pay, provenOpen, confidential) {
  if (hashVouts.length !== pay.length) return false;
  const used = new Set();
  for (const p of pay) {
    const hex = p.noteCommit.toString('hex');
    let idx = -1;
    for (let i = 0; i < hashVouts.length; i += 1) {
      if (used.has(i)) continue;
      if (ncHex(hashVouts[i].noteCommit) === hex) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return false;
    const nanos = Number(p.nanos);
    if (!Number.isSafeInteger(nanos) || nanos < 0) return false;
    const hit = hashVouts[idx];
    if (confidential) {
      if (!verifySealedNote(hit, nanos)) return false;
      if (provenOpen) provenOpen.set(hit, nanos);
    } else if (Number(hit.nanos || 0) !== nanos) {
      return false;
    }
    used.add(idx);
  }
  return used.size === hashVouts.length;
}

function leafCommitHex(leaf) {
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
 * Cheap share-credit bind for a block this node already accepted.
 * No ShearHash. A pruned block keeps aLeaves and drops the batch: the
 * empty batch is not a fresh-credit lie. A live batch must reproduce
 * each positive aLeaf, and the header continuity root must still match
 * the stored leaves, so a rewritten nonce byte fails closed.
 */
export function shareCreditBound(block, tipHeight = null) {
  const shares = Array.isArray(block?.shareBatch) ? block.shareBatch : [];
  if (sealedCreditsBuried(block, tipHeight) && shares.length === 0) return { ok: true, reason: '' };
  const leaves = Array.isArray(block?.aLeaves) ? block.aLeaves : [];
  let positive = false;
  for (const leaf of leaves) {
    if (Number(leaf?.count) > 0) {
      positive = true;
      break;
    }
  }
  let id = null;
  if (Buffer.isBuffer(block?.hash) && block.hash.length === 32) id = block.hash;
  else if (block?.hash instanceof Uint8Array && block.hash.length === 32) id = block.hash;
  if (!id) return { ok: false, reason: 'share_credit_bind' };
  // R28: a BluNotes block binds its shares to its record's batch root (count
  // and total weight) and to the coinbase share root, not to payee leaves.
  if (block?.blunoteRecord != null && block.blunoteRecord !== '') {
    const raw = block.blunoteRecord;
    const rec = decodeRecord(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'hex'));
    if (!rec) return { ok: false, reason: 'share_credit_bind' };
    if (positive) return { ok: false, reason: 'share_credit_bind' };
    if (shares.length) {
      let root;
      try { root = bluSlotRoot(shares); } catch { return { ok: false, reason: 'share_credit_bind' }; }
      if (rec.n !== shares.length || rec.W !== root.total || !Buffer.from(rec.batchRoot).equals(Buffer.from(root.root))) {
        return { ok: false, reason: 'share_credit_bind' };
      }
      const slot = block?.txs?.[0]?.shareSlotRoot;
      if (slot == null || !Buffer.from(asU8(slot)).equals(Buffer.from(root.root))) return { ok: false, reason: 'share_credit_bind' };
    } else if (rec.n !== 0) {
      return { ok: false, reason: 'share_credit_bind' };
    }
    if (block?.samplesPruned !== true) {
      let decoded;
      try { decoded = decodeHeader(Buffer.from(block.header)); } catch {
        return { ok: false, reason: 'share_credit_bind' };
      }
      const dual = buildDualTree({ aLeaves: [], bLeaves: block.bLeaves || [] });
      if (!Buffer.from(dual.continuityRoot).equals(Buffer.from(decoded.continuityRoot))) {
        return { ok: false, reason: 'share_credit_bind' };
      }
    }
    return { ok: true, reason: '' };
  }
  if (shares.length === 0 && !positive) return { ok: true, reason: '' };
  const account = accountShareUnits(shares);
  if (!account.ok) return { ok: false, reason: 'share_credit_bind' };
  const retained = account.retained;
  const seen = new Set();
  for (const leaf of leaves) {
    const count = Math.floor(Number(leaf?.count) || 0);
    if (count <= 0) continue;
    const hex = leafCommitHex(leaf);
    if (!hex || (retained.get(hex) || 0) !== count) return { ok: false, reason: 'share_credit_bind' };
    seen.add(hex);
  }
  for (const [hex, units] of retained) {
    if (units > 0 && !seen.has(hex)) return { ok: false, reason: 'share_credit_bind' };
  }
  if (block?.samplesPruned !== true) {
    let decoded;
    try { decoded = decodeHeader(Buffer.from(block.header)); } catch {
      return { ok: false, reason: 'share_credit_bind' };
    }
    const dual = buildDualTree({ aLeaves: leaves, bLeaves: block.bLeaves || [] });
    if (!Buffer.from(dual.continuityRoot).equals(Buffer.from(decoded.continuityRoot))) {
      return { ok: false, reason: 'share_credit_bind' };
    }
  }
  return { ok: true, reason: '' };
}

function spillWorkKeys(shares, fallbackHeader) {
  const out = [];
  for (const s of shares || []) {
    const hdr = s?.verifiedHeader || fallbackHeader;
    const key = shareWorkKey(hdr, s?.nonce);
    if (key) out.push(key);
  }
  return out;
}

/**
 * Expiring overflow only. Slot 0 is still eligible and must stay in the
 * payable batch. A witness longer than the seat cap, or one that repeats
 * a seated work key, is not a credit. Buried blocks keep the credit record
 * and no longer carry the share bodies.
 */
function spillSharesRejected(block, prev, opts = {}) {
  const spill = Array.isArray(block?.hashSpill) ? block.hashSpill : [];
  if (!spill.length) {
    const recorded = block?.hashSpillCredits;
    if (Array.isArray(recorded) && recorded.length && !sealedCreditsBuried(block, opts.burialTip)) {
      return 'hash_spill';
    }
    return '';
  }
  if (spill.length > MAX_SHARES_PER_BLOCK) return 'hash_spill';
  if (!prev?.header) return 'hash_spill';
  const exclude = spillWorkKeys(block.shareBatch, prev.header);
  const proved = verifyShareBatch({
    parentHeader: prev.header,
    priorHeader: opts.grandparentHeader || null,
    excludeNonces: exclude,
    shares: spill,
    floorBits: SHARE_FLOOR_BITS,
    skipPow: !!opts.skipSharePow,
    trustWork: !!opts.trustWork,
    issuedJobKeys: block.txs?.[0]?.issuedJobKeys,
  });
  if (!proved.ok || proved.shares.length !== spill.length) return 'hash_spill';
  for (const row of proved.shares) {
    if (row.proofSlot !== 1) return 'hash_spill';
  }
  return '';
}

function settlementFor(prev, height, block, unit, extra = {}) {
  const shareBatch = Array.isArray(block?.shareBatch) ? block.shareBatch : (Array.isArray(block) ? block : []);
  const creditBlock = block && !Array.isArray(block) ? block : { shareBatch };
  const parent = prev?.txs?.[0] || null;
  let owedIn;
  if (extra.owedIn != null) {
    if (!hashOwedRootAgrees(parent, extra.owedIn)) return { ok: false, reason: 'hash_owed' };
    owedIn = extra.owedIn;
  } else {
    owedIn = hashOwedFromTx(parent);
  }
  const dustIn = hashDustFromTx(parent);
  const overflowIn = hashOverflowFromTx(parent);
  if (owedIn == null || dustIn == null || overflowIn == null) {
    return { ok: false, reason: 'hash_owed' };
  }
  const series = extra.hashAcceptedSeries;
  const budget = series == null ? null : hashBudgetNanos(series, unit);
  if (series != null && budget == null) return { ok: false, reason: 'hash_owed' };
  const gotFresh = freshForBlock(creditBlock, unit, extra.tipHeight);
  if (!gotFresh.ok) return { ok: false, reason: 'hash_owed' };
  const gotSpill = spillForBlock(creditBlock, unit, extra.tipHeight);
  if (!gotSpill.ok) return { ok: false, reason: 'hash_owed' };
  const fresh = gotFresh.fresh;
  const settled = settleHashOwed({
    owedIn,
    dustIn,
    overflowIn,
    fresh,
    spill: gotSpill.fresh,
    height,
    unit,
    budget,
  });
  if (!settled.ok) return { ok: false, reason: settled.reason || 'hash_owed' };
  // owedIn is the combined map, including rows that were packed in hashOwedRest.
  // A ledger that only looks empty inline is not idle and must not mint a finder floor.
  const parentIdle = owedIn.length === 0 && dustIn === 0n && overflowIn === 0n;
  const idle = parentIdle && hashLedgerIdle(settled, fresh.length);
  return { ...settled, idle };
}

/**
 * Header proof-of-work and the cheap header rules.
 * The store runs this before any owed replay. `consumePrepared` drops a
 * stashed header hash after this call. A gate that leaves the stash for
 * the body sets it false.
 */
export function assessHeader(block, prev, opts = {}) {
  const consume = opts.consumePrepared === true;
  const trustedPowHash = opts.trustedPowHash || null;
  const mtpTimestamps = opts.mtpTimestamps || null;
  const nowMs = opts.nowMs == null ? null : opts.nowMs;
  const genesisMs = Number(opts.genesisMs) || 0;
  const magic = opts.magic || MAGIC_TESTNET;
  let headerBuf = null;
  const finish = (result) => {
    if (consume && headerBuf) dropPreparedHeader(headerBuf);
    return result;
  };
  if (!block?.header) return finish({ ok: false, reason: 'no_header' });
  const h = Buffer.from(block.header);
  headerBuf = h;
  let decoded;
  try {
    decoded = decodeHeader(h);
  } catch (e) {
    return finish({ ok: false, reason: 'bad_header' });
  }
  if (decoded.version !== VERSION) return finish({ ok: false, reason: 'version' });
  const wantPrev = prev?.hash ? Buffer.from(prev.hash) : GENESIS_PREV;
  if (!decoded.prevBlockHash.equals(wantPrev)) return finish({ ok: false, reason: 'prev' });
  // P2P burial gate. Structural height is the parent already accepted, plus one.
  // A peer height field is not that number. Reject it before slot burial,
  // ASERT, or skipFlow can read it.
  const structuralH = (Number(prev?.height) || 0) + 1;
  if (block.height != null && block.height !== '' && Number(block.height) !== structuralH) {
    return finish({ ok: false, reason: 'height' });
  }
  // The slot byte is consensus. Check it before header work so a flipped
  // trailer is share_slot and does not depend on proof-of-work. An unburied
  // pruned block keeps the samples_pruned reason from the later check.
  const slotHeight = structuralH;
  const slotParent = Number(prev?.height || 0);
  // burialTip is the caller's own tip (load, fork, or suffix). A peer
  // tipHeight does not bury. Live append leaves burialTip unset.
  const slotBurial = Number.isInteger(opts.burialTip) && opts.burialTip >= 0
    ? Number(opts.burialTip)
    : (opts.loadReplay === true ? (Number(opts.tipHeight) || slotParent) : slotParent);
  const slotPrunedEarly = !!block.samplesPruned && !shouldPruneSamples(slotHeight, slotBurial);
  if (!slotPrunedEarly && Array.isArray(block.txs) && block.txs[0]?.coinbase) {
    const slotReason = shareSlotCommitment(block.txs[0], block.shareBatch || [], {
      samplesPruned: !!block.samplesPruned,
      buried: shouldPruneSamples(slotHeight, slotBurial),
    });
    if (slotReason) return finish({ ok: false, reason: slotReason });
  }
  // Local pool already hashed this header off-thread and passes trustedPowHash.
  // P2P omits that field. It stashes a worker ShearHash, then this branch
  // still checks the target. A missing stash hashes here (local mine / tests).
  let hash;
  if (opts.probeBody === true) {
    // In-process template probe. store.append never sets this, and the
    // stand-in is not block work. Every other check still runs.
    hash = Buffer.alloc(32);
  } else if (opts.preparedHash) {
    hash = Buffer.from(opts.preparedHash);
    if (hash.length !== 32 || !meetsTarget(hash, decoded.bits)) {
      return finish({ ok: false, reason: 'pow' });
    }
  } else if (trustedPowHash) {
    hash = Buffer.from(trustedPowHash);
    if (hash.length !== 32 || !meetsTarget(hash, decoded.bits)) {
      return finish({ ok: false, reason: 'pow' });
    }
  } else {
    const prepared = peekPreparedHeader(h);
    if (prepared) hash = prepared;
    else {
      hash = shearHash(h);
      stashPreparedHeader(h, hash);
    }
    if (!meetsTarget(hash, decoded.bits)) return finish({ ok: false, reason: 'pow' });
  }
  // P2P tip-extend stops here. Merkle, ASERT, and the book walk stay on the
  // full check. A claimed hash that merely matches a stored id is not proof.
  if (opts.stopAfterPow === true) return finish({ ok: true, hash, decoded });
  const txs = Array.isArray(block.txs) ? block.txs : [];
  if (!txs.length || !txs[0]?.coinbase) return finish({ ok: false, reason: 'coinbase' });
  for (const tx of txs) {
    for (const o of tx?.vout || []) {
      const raw = o?.valueProof?.v != null ? o.valueProof.v : o?.nanos;
      if (typeof raw === 'bigint' ? raw < 0n : typeof raw === 'number' && raw < 0) {
        return finish({ ok: false, reason: 'negative_mint' });
      }
    }
    if (negativeTopNanos(tx)) return finish({ ok: false, reason: 'negative_mint' });
  }
  const leaves = blockLeaves(txs);
  if (!leaves) return finish({ ok: false, reason: 'duplicate_tx' });
  const merkle = merkleRoot(leaves);
  if (!merkle.equals(decoded.merkleRoot)) return finish({ ok: false, reason: 'merkle' });
  let resolvedGenesisMs = 0;
  if (prev?.header) {
    let parent;
    try {
      parent = decodeHeader(Buffer.from(prev.header));
    } catch {
      return finish({ ok: false, reason: 'parent_header' });
    }
    // Genesis-anchored aserti3-2d. The child stamp is the block time.
    // Parent bits are not the anchor, so an emergency ease does not stick.
    // A closed-book historical header may skip this check. v12 does not.
    const ts = Number(decoded.timestamp);
    const parentTs = Number(parent.timestamp);
    const parentIsGenesis = parent.prevBlockHash.equals(GENESIS_PREV);
    resolvedGenesisMs = parentIsGenesis ? parentTs : Number(genesisMs);
    if (!Number.isFinite(resolvedGenesisMs) || resolvedGenesisMs <= 0) {
      return finish({ ok: false, reason: 'genesis_ms' });
    }
    const heightNow = structuralH;
    // After genesis, testnet and mainnet anchor on the genesis seed. Those
    // books seal that seed in the genesis header, so this is the same bits.
    // The regtest override is that seed only after the test factory seals it.
    const regtestBits = regtestBitsOverride(magic);
    const quote = asertNextBits({
      anchorBits: parentIsGenesis ? parent.bits : (regtestBits != null ? regtestBits : GENESIS_BITS_PACKED),
      anchorTimeMs: resolvedGenesisMs,
      anchorHeight: parentIsGenesis ? Number(prev.height || 1) : 1,
      blockTimeMs: ts,
      blockHeight: heightNow,
      parentTimeMs: parentTs,
    });
    const closedBook = String(magic) !== MAGIC_TESTNET_V12 && String(magic) !== MAGIC_MAINNET;
    if ((!quote.ok || !bitsAcceptAsert(decoded.bits, quote)) && !(closedBook && isHistoricalHeader(h))) {
      return finish({ ok: false, reason: 'bits' });
    }
    if (!isPackedBits(decoded.bits)) return finish({ ok: false, reason: 'bits' });
    const fp = unpackBits(decoded.bits);
    if (fp < LIVE_MIN_BITS || fp > MAX_BITS) return finish({ ok: false, reason: 'bits' });
    const pWeight = Number(prev.weight != null
      ? prev.weight
      : blockWeight(prev.txs || [], prev.bLeaves || []));
    const wantBase = nextBaseFee(Number(parent.baseFee || 1n), pWeight);
    if (Number(decoded.baseFee) !== wantBase) return finish({ ok: false, reason: 'base_fee' });
    if (!(ts > parentTs)) return finish({ ok: false, reason: 'timestamp' });
    const window = Array.isArray(mtpTimestamps) && mtpTimestamps.length
      ? mtpTimestamps.slice(-MTP_WINDOW)
      : [parentTs];
    const mtp = medianTimePast(window);
    if (ts > mtp + MTP_FUTURE_MS) return finish({ ok: false, reason: 'timestamp' });
    if (nowMs != null && Number.isFinite(Number(nowMs)) && ts > Number(nowMs) + HEADER_AHEAD_MS) {
      return finish({ ok: false, reason: 'timestamp' });
    }
    if (nowMs != null && Number.isFinite(Number(nowMs)) && ts > Number(nowMs) + MTP_FUTURE_MS) {
      return finish({ ok: false, reason: 'timestamp' });
    }
  } else {
    // Testnet and mainnet stay on the genesis seed. regtestBitsOverride is
    // null for those books, and null until the test-only store factory seals.
    const wantBits = regtestBitsOverride(magic) ?? GENESIS_BITS_PACKED;
    if (decoded.bits !== wantBits || !isPackedBits(decoded.bits)) {
      return finish({ ok: false, reason: 'bits' });
    }
    if (Number(decoded.baseFee) < 1) return finish({ ok: false, reason: 'base_fee' });
    resolvedGenesisMs = Number(decoded.timestamp);
  }
  if (!Number.isFinite(resolvedGenesisMs) || resolvedGenesisMs <= 0) {
    return finish({ ok: false, reason: 'genesis_ms' });
  }
  return finish({ ok: true, hash, decoded, genesisMs: resolvedGenesisMs });
}

/**
 * Header target for one block, before any comparison of its claimed hash
 * to the book. Share headers are hashed here too so a later full check can
 * reuse the stash. `release` drops that stash when the caller does not ingest.
 */
export async function headerPowReason(block, prev, opts = {}) {
  const ready = await prepareOffLoopPow(block, prev, {
    skipSharePow: !!opts.skipSharePow,
    priorHeader: opts.grandparentHeader || null,
  });
  if (!ready.ok) return { reason: ready.reason || 'pow', release: null };
  let assessed;
  try {
    assessed = assessHeader(block, prev, {
      ...opts,
      preparedHash: peekPreparedHeader(block.header),
      consumePrepared: false,
      stopAfterPow: true,
      trustedPowHash: null,
      offLoopPow: false,
      probeBody: false,
    });
  } catch (err) {
    ready.cleanup?.();
    throw err;
  }
  if (!assessed.ok) {
    ready.cleanup?.();
    return { reason: assessed.reason || 'pow', release: null };
  }
  return { reason: null, release: () => ready.cleanup?.() };
}

/**
 * A genesis header without its body, under a claimed hash.
 * `magic` selects the regtest seed after the test factory seals it.
 * Testnet and mainnet stay on GENESIS_BITS_PACKED: the override is null there.
 */
export function rootHeaderReason(header, hash, magic = '') {
  let decoded;
  try {
    decoded = decodeHeader(Buffer.from(header));
  } catch {
    return { ok: false, reason: 'bad_header' };
  }
  if (decoded.version !== VERSION) return { ok: false, reason: 'version' };
  if (!decoded.prevBlockHash.equals(GENESIS_PREV)) return { ok: false, reason: 'prev' };
  const wantBits = regtestBitsOverride(magic) ?? GENESIS_BITS_PACKED;
  if (decoded.bits !== wantBits || !isPackedBits(decoded.bits)) return { ok: false, reason: 'bits' };
  const pow = Buffer.from(hash || []);
  if (pow.length !== 32 || !meetsTarget(pow, decoded.bits)) return { ok: false, reason: 'pow' };
  return { ok: true, decoded };
}

/**
 * One header above a parent header, without its body: version, prev link,
 * proof-of-work under its own bits, genesis-anchored ASERT bits, the packed
 * range, and the timestamp rules. The base fee and the merkle root need the
 * body, so a header run does not prove them. `hash` is the header's proven
 * ShearHash. `parent` is { header, hash, height }.
 */
export function headerLinkReason(header, hash, parent, { genesisMs = 0, mtpTimestamps = null, nowMs = null, magic = '' } = {}) {
  let decoded;
  let up;
  try {
    decoded = decodeHeader(Buffer.from(header));
    up = decodeHeader(Buffer.from(parent.header));
  } catch {
    return { ok: false, reason: 'bad_header' };
  }
  if (decoded.version !== VERSION) return { ok: false, reason: 'version' };
  if (!decoded.prevBlockHash.equals(Buffer.from(parent.hash))) return { ok: false, reason: 'prev' };
  const pow = Buffer.from(hash || []);
  if (pow.length !== 32 || !meetsTarget(pow, decoded.bits)) return { ok: false, reason: 'pow' };
  const ts = Number(decoded.timestamp);
  const parentTs = Number(up.timestamp);
  if (!(ts > parentTs)) return { ok: false, reason: 'timestamp' };
  const parentIsGenesis = up.prevBlockHash.equals(GENESIS_PREV);
  const anchorMs = parentIsGenesis ? parentTs : Number(genesisMs);
  if (!Number.isFinite(anchorMs) || anchorMs <= 0) return { ok: false, reason: 'genesis_ms' };
  // Same regtest seed as block verify. A peer height is not an anchor.
  const regtestBits = regtestBitsOverride(magic);
  const quote = asertNextBits({
    anchorBits: parentIsGenesis ? up.bits : (regtestBits != null ? regtestBits : GENESIS_BITS_PACKED),
    anchorTimeMs: anchorMs,
    anchorHeight: parentIsGenesis ? Number(parent.height || 1) : 1,
    blockTimeMs: ts,
    blockHeight: Number(parent.height) + 1,
    parentTimeMs: parentTs,
  });
  if (!quote.ok || !bitsAcceptAsert(decoded.bits, quote) || !isPackedBits(decoded.bits)) {
    return { ok: false, reason: 'bits' };
  }
  const fp = unpackBits(decoded.bits);
  if (fp < LIVE_MIN_BITS || fp > MAX_BITS) return { ok: false, reason: 'bits' };
  const window = Array.isArray(mtpTimestamps) && mtpTimestamps.length
    ? mtpTimestamps.slice(-MTP_WINDOW)
    : [parentTs];
  if (ts > medianTimePast(window) + MTP_FUTURE_MS) return { ok: false, reason: 'timestamp' };
  if (nowMs != null && Number.isFinite(Number(nowMs))) {
    if (ts > Number(nowMs) + HEADER_AHEAD_MS || ts > Number(nowMs) + MTP_FUTURE_MS) {
      return { ok: false, reason: 'timestamp' };
    }
  }
  return { ok: true, decoded };
}

// Parent tags stay in the live set. Copying them once per block grows with
// chain history. The overlay is only the tags this block accepts.
function parentSpendView(chain) {
  const overlay = new Set();
  const source = chain && typeof chain.has === 'function' ? chain : null;
  return {
    has(tag) {
      const hex = String(tag);
      if (source && source.has(hex)) return true;
      return overlay.has(hex);
    },
    add(tag) {
      const hex = String(tag);
      if (hex) overlay.add(hex);
    },
  };
}

/**
 * A coinbase output's noteCommit names the dest a node credits it to
 * (note_ledger.js), so on every output, hasher payouts included, it must be
 * the one its own dest20 derives (noteCommitOfDest20), and a row with no
 * dest20 carries none. Nothing derives or fills one in, and the verdict
 * reads only the row: no share batch, so a pruned block is judged as it was
 * live. Russell 26 Oct: from height 0, COINBASE_NC=dest-bound, with no
 * hasher exemption (lane finding PS1, 83ea4352).
 */
export function coinbaseLabelRejected(vout) {
  for (const o of Array.isArray(vout) ? vout : []) {
    if (!o || typeof o !== 'object') continue;
    if (o.noteCommit == null || o.noteCommit === '') continue;
    let label;
    try { label = Buffer.from(asU8(o.noteCommit)); } catch { return { ok: false, reason: 'coinbase_output' }; }
    let d20 = null;
    try { d20 = o.dest20 == null || o.dest20 === '' ? null : Buffer.from(asU8(o.dest20)); } catch { d20 = null; }
    if (!d20 || d20.length !== 20) return { ok: false, reason: 'coinbase_output' };
    if (!noteCommitOfDest20(d20).equals(label)) return { ok: false, reason: 'coinbase_output' };
  }
  return null;
}

/** The key opts.arrivedRows is read by: the header bytes as hex, however the block holds them. */
export function arrivedRowsKey(block) {
  try {
    const h = Buffer.from(asU8(block?.header));
    return h.length ? h.toString('hex') : '';
  } catch {
    return '';
  }
}

/**
 * The row checks verifyBlock runs before proof of work: fee fields, a
 * coinbase observe, stage 0, leaked and unsigned fields. They read the rows
 * as given, so the store also runs them on the rows as they arrived
 * (store.js arrivedRows): compaction strips some of what they name.
 */
export function earlyRowsRejected(block) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  for (let i = 0; i < txs.length; i += 1) {
    const feeHit = feeFieldRejected(txs[i]);
    if (feeHit) return feeHit;
    const spendFee = bSpendFeeRejected(txs[i]);
    if (spendFee) return spendFee;
  }
  const earlyObserve = coinbaseObserveRejected(block?.txs);
  if (earlyObserve) return earlyObserve;
  const gated = chainStage0Rejected([block]);
  if (gated) return gated;
  for (let i = 0; i < txs.length; i += 1) {
    const leakedVote = leafVoteLeakRejected(txs[i]);
    if (leakedVote) return leakedVote;
    const leakedLock = compactLockLeakRejected(txs[i]);
    if (leakedLock) return leakedLock;
    const leakedWithdraw = withdrawLeakRejected(txs[i]);
    if (leakedWithdraw) return leakedWithdraw;
    const unsignedField = unsignedBodyField(txs[i]);
    if (unsignedField) return unsignedField;
  }
  return null;
}

/**
 * Refusals a later binary may lift (a pin bump or a native rebuild), which a
 * peer notes as soft (p2p.js). Every other refusal is final.
 */
export const UPGRADEABLE_REASONS = Object.freeze(new Set(['evm', 'unsigned', 'admit_membership']));

function upgradeable(r) {
  return !!r && r.ok === false && UPGRADEABLE_REASONS.has(String(r.reason || ''));
}

function verifyBlockConsensus(block, prev, opts = {}) {
  // The arrived rows' verdict first, at the place it held when verifyBlock
  // read full rows, so a block keeps the reason its full body had. A final
  // early verdict returns at once. An upgradeable one waits for the body:
  // a final fault behind it is the verdict, so a block that fails a final
  // check is never noted as soft (Russell 26 Oct).
  const arrived = opts.arrivedRows?.get(arrivedRowsKey(block));
  const own = earlyRowsRejected(block);
  // A verdict only the arrived rows give, where the compact body the header
  // commits passes the same checks, is the serving peer's fault: peerOnly
  // (Russell 26 Oct). p2p scores that peer and never soft-notes the hash.
  const peerEarly = arrived?.early && !own ? { ...arrived.early, peerOnly: true } : arrived?.early;
  const earlies = [peerEarly, own].filter(Boolean);
  const finalEarly = earlies.find((r) => !upgradeable(r));
  if (finalEarly) return finalEarly;
  if (!earlies.length) return verifyBlockBody(block, prev, opts);
  const soft = earlies[0];
  const settle = (body) => (body && body.ok === false && !upgradeable(body) ? body : soft);
  const body = verifyBlockBody(block, prev, opts);
  return body && typeof body.then === 'function' ? body.then(settle) : settle(body);
}

function verifyBlockBody(block, prev, opts = {}) {
  if (opts.offLoopPow && !opts.trustedPowHash) {
    return prepareOffLoopPow(block, prev, {
      skipSharePow: !!opts.skipSharePow,
      priorHeader: opts.grandparentHeader || null,
    }).then((ready) => {
      if (!ready.ok) return ready;
      let result;
      try {
        result = verifyBlockBody(block, prev, { ...opts, offLoopPow: false });
      } catch (err) {
        ready.cleanup?.();
        throw err;
      }
      if (result && typeof result.then === 'function') {
        return result.then((out) => {
          ready.cleanup?.();
          return out;
        }, (err) => {
          ready.cleanup?.();
          throw err;
        });
      }
      ready.cleanup?.();
      return result;
    });
  }
  const {
    buried = false,
    spentB = null,
    tipHeight = 0,
    hashBonusNanos = HASH_BONUS_NANOS,
    spendableOf = null,
    mtpTimestamps = null,
    nowMs = null,
    committedBps = null,
    reserveState = null,
    poolDest = null,
    seenDigests = null,
    evmSession = null,
    evmHistory = null,
    trustedPowHash = null,
    skipSharePow = false,
    parentFluxset = null,
    parentSpendTags = null,
    genesisMs = 0,
    magic = MAGIC_TESTNET,
  } = opts;
  // A pool dest passed by the store is not a pot witness. The openings are.
  void poolDest;
  void mtpTimestamps;
  void nowMs;
  void genesisMs;
  void trustedPowHash;
  const assessed = assessHeader(block, prev, { ...opts, consumePrepared: true });
  if (!assessed.ok) return assessed;
  const { hash, decoded } = assessed;
  const resolvedGenesisMs = assessed.genesisMs;
  const txs = Array.isArray(block.txs) ? block.txs : [];
  for (let i = 0; i < txs.length; i += 1) {
    const capped = txIoCap(txs[i]);
    if (!capped.ok) return capped;
  }
  const budget = blockBudget(txs);
  if (!budget.ok) return budget;
  const noteRule = chainNoteRuleRejected([block]);
  if (noteRule) return noteRule;
  const observeGate = coinbaseObserveRejected(txs);
  if (observeGate) return observeGate;
  for (const tx of txs) {
    const rows = tx?.vout || [];
    for (const o of rows) {
      const raw = o?.valueProof?.v != null ? o.valueProof.v : o?.nanos;
      if (typeof raw === 'bigint' ? raw < 0n : typeof raw === 'number' && raw < 0) {
        return { ok: false, reason: 'negative_mint' };
      }
    }
    if (negativeTopNanos(tx)) return { ok: false, reason: 'negative_mint' };
  }
  for (let i = 0; i < txs.length; i += 1) {
    if (txs[i]?.reports == null) continue;
    if (i !== 0) return { ok: false, reason: 'bad_rate' };
    const report = verifyMinerReport(txs[i].reports);
    if (!report.ok) return { ok: false, reason: report.reason || 'bad_rate' };
  }
  const wantPot = potSubsidyAt({
    nowMs: Number(decoded.timestamp) || Number(nowMs) || 0,
    genesisMs: resolvedGenesisMs,
    magic,
  });
  // Empty rounds carry the unminted pot. The next block's outputs plus its
  // own carry must equal this subsidy plus the parent carry. Paying the pot
  // and carrying it would mint twice. Dropping it mints nothing.
  const carryOut = canonicalCarry(txs[0]);
  const carryIn = prev?.txs?.[0] ? canonicalCarry(prev.txs[0]) : 0;
  if (carryOut == null || carryIn == null || !Number.isSafeInteger(wantPot) || wantPot < 0) {
    return { ok: false, reason: 'pot_sched' };
  }
  const payablePot = wantPot + carryIn;
  const mintedPot = payablePot - carryOut;
  if (!Number.isSafeInteger(payablePot) || !Number.isSafeInteger(mintedPot) || mintedPot < 0) {
    return { ok: false, reason: 'pot_sched' };
  }
  const samples = collateSamples(
    Array.isArray(block.samples) ? block.samples : (txs[0].samples || []),
  );
  const shareBatchEarly = Array.isArray(block.shareBatch) ? block.shareBatch : [];
  if (!block.samplesPruned && !shareBatchEarly.length && sampleCapExceeded(samples, decoded.bits)) {
    return { ok: false, reason: 'sample_cap' };
  }
  const cbVouts = txs[0].vout || [];
  const confidential = cbVouts.some((o) => o.commit);
  const potVouts = cbVouts.filter((o) => o.kind !== 'hash' && o.kind !== 'finder-fee' && o.kind !== 'reserve-fee');
  const hashVouts = cbVouts.filter((o) => o.kind === 'hash');
  let potNanos = 0;
  let bonusNanos = 0;
  // Structural height. assessHeader already rejected a peer height field.
  // opts.tipHeight is a peer advertisement and must not open skipFlow.
  // loadReplay is this book's own tip, used only while checking a loaded chain.
  const parentHeight = Number(prev?.height || 0);
  const height = parentHeight + 1;
  const activationHeight = opts.oracleActivationHeight === undefined
    ? ORACLE_ACTIVATION_HEIGHT
    : opts.oracleActivationHeight;
  const rule = oracleRuleAt(height, { activationHeight });
  let parentMs = 0;
  if (prev?.header) {
    try { parentMs = Number(decodeHeader(Buffer.from(prev.header)).timestamp) || 0; } catch { parentMs = 0; }
  }
  const headerMs = Number(decoded.timestamp) || 0;
  const boundary = isReportBoundary({
    headerMs,
    parentMs,
    genesisMs: resolvedGenesisMs,
    magic,
  });
  if (rule === 'median3b' && boundary && !txs[0]?.rateCommit) {
    return { ok: false, reason: 'rate_commit' };
  }
  if (txs[0]?.rateCommit) {
    if (rule === 'median3b' && !boundary) return { ok: false, reason: 'rate_commit' };
    const days = epochDays(magic);
    const epochIndex = resolvedGenesisMs > 0
      ? vortexEpochIndex({ nowMs: headerMs, genesisMs: resolvedGenesisMs, epochDays: days })
      : Math.floor(Number(txs[0].rateCommit.epochIndex) || 0);
    const prevEpochBps = Math.floor(Number(opts.committedBps ?? opts.reserveState?.epochBps ?? GENESIS_BPS));
    const windowSize = opts.oracleWindowSize == null ? windowBlocksFor(magic) : opts.oracleWindowSize;
    const expectedBps = rule === 'median3b'
      ? epochBpsFromReports(prevEpochBps, opts.oracleWindow || [], { windowSize })
      : null;
    const commit = verifyRateCommit(txs[0].rateCommit, {
      prevEpochBps,
      blockTimeMs: headerMs,
      epochIndex,
      magic,
      expectedBps,
    });
    if (!commit.ok) return commit;
  }
  // Live burial is the parent this caller already accepted. A peer tipHeight
  // does not open it. loadReplay is this book's own tip. Fork and suffix
  // pass burialTip, the tip of the chain they are validating, and that
  // overwrites a peer field. Spend maturity stays this block's height.
  const burialTip = Number.isInteger(opts.burialTip) && opts.burialTip >= 0
    ? Number(opts.burialTip)
    : (opts.loadReplay === true ? (Number(opts.tipHeight) || parentHeight) : parentHeight);
  void tipHeight;
  void buried;
  // Continuity before the unburied-prune reject. A lied root is continuity.
  // A matching root is still samples_pruned, and a later pot or hash check
  // must not replace that reason. Peer tipHeight does not bury this block.
  // A buried pruned block skips this and uses skipFlow below.
  if (block.samplesPruned && !shouldPruneSamples(height, burialTip)) {
    const earlyB = boundBLeaves(block, txs);
    if (!earlyB.ok) return earlyB;
    const dualEarly = buildDualTree({
      aLeaves: publishedALeaves(block),
      bLeaves: earlyB.leaves,
    });
    if (!Buffer.from(dualEarly.continuityRoot).equals(Buffer.from(decoded.continuityRoot))) {
      return { ok: false, reason: 'continuity' };
    }
    return { ok: false, reason: 'samples_pruned' };
  }
  const skipFlow = flowSkipAllowed({ height, samplesPruned: block.samplesPruned }, burialTip);
  const shareBatch = Array.isArray(block.shareBatch) ? block.shareBatch : [];
  const liveUnit = hashBonusUnitNanos(hashBonusNanos);
  // R28: the proven BluNotes rows the draw pays.
  let bluRows = [];
  // Amounts the coinbase rule already opened. A published valueProof.v
  // that is missing or wrong does not replace these.
  const provenOpen = new Map();
  // Frames still on the block take the live batch rules on every path,
  // including load. A foreign load hashes each share. An own-install keyed
  // load sets trustShareWork and skips only that hash. skipPow with an empty
  // cache stays share_pow and is not this shortcut. A buried pruned block
  // has an empty batch, so there is no share frame to hash. There is no
  // release assume-valid anchor: an empty genesis pin does not skip a share.
  const trustWork = opts.loadReplay === true && opts.trustShareWork === true;
  if (shareBatch.length) {
    if (shareBatch.length > MAX_SHARES_PER_BLOCK) return { ok: false, reason: 'share_cap' };
    if (!prev?.header) return { ok: false, reason: 'share_batch' };
    const proved = verifyShareBatch({
      parentHeader: prev.header,
      priorHeader: opts.grandparentHeader || null,
      excludeNonces: shareNonceKeys(prev?.shareBatch, opts.grandparentHeader || null),
      shares: shareBatch,
      floorBits: SHARE_FLOOR_BITS,
      skipPow: trustWork ? false : !!skipSharePow,
      trustWork,
      issuedJobKeys: txs[0]?.issuedJobKeys,
    });
    if (!proved.ok) return proved;
    bluRows = proved.shares;
  }
  // R28 (D2): spill is retired. Every share is paid by the draw of the block
  // that seats it, so there is no second place to credit work (H2, H3).
  if (Array.isArray(block.hashSpill) && block.hashSpill.length) return { ok: false, reason: 'hash_spill' };
  if (Array.isArray(block.hashSpillCredits) && block.hashSpillCredits.length) return { ok: false, reason: 'hash_spill' };
  // R28: share payouts are implicit (node/src/blunote_payout.js). A
  // coinbase carries no pot, hash, pool-fee or finder-fee note and no T21
  // split; only the reserve levy note stays explicit.
  const bluFields = blunoteFields(txs[0]);
  if (!bluFields) return { ok: false, reason: 'blunote_fields' };
  if (txs[0] && txs[0].t21Split != null) return { ok: false, reason: 'blunote_vout' };
  for (const o of cbVouts) {
    if (String(o?.kind || '') !== 'reserve-fee') return { ok: false, reason: 'blunote_vout' };
  }
  void potVouts;
  void hashVouts;
  void potNanos;
  void bonusNanos;
  void confidential;
  void provenOpen;
  void mintedPot;
  const boundCb = coinbaseVoutsBound(cbVouts, txs[0].excess, () => null, null);
  if (!boundCb.ok) return boundCb;
  const aLeaves = [];
  const boundLeaves = boundBLeaves(block, txs);
  if (!boundLeaves.ok) return boundLeaves;
  const bLeaves = boundLeaves.leaves;
  if (!skipFlow) {
    const dual = buildDualTree({ aLeaves, bLeaves });
    if (!dual.continuityRoot.equals(decoded.continuityRoot)) return { ok: false, reason: 'continuity' };
  }
  const feeBound = checkTxAddressFields({ vout: txs[0].vout || [] }, { coinbase: true });
  if (!feeBound.ok && feeBound.reason === 'pool_fee_dest') return feeBound;
  for (const o of txs[0].vout) {
    if (o.commit && o.noteCommit && !o.address) continue;
    const r = checkAddressField(o.address, { allowEmpty: false });
    if (!r.ok) {
      if (r.reason === 'silent_id_on_chain') return { ok: false, reason: 'silent_id_on_chain' };
      if (r.reason === 'rest_frame_on_chain') return { ok: false, reason: 'rest_frame_on_chain' };
      return { ok: false, reason: r.reason === 'dest' ? 'miner_addr' : r.reason };
    }
  }
  // COINBASE_NC=dest-bound: a label names its payee only as its own dest20
  // derives it, on every row, read from the row alone.
  const labelled = coinbaseLabelRejected(txs[0].vout);
  if (labelled) return labelled;
  if (block.miner) {
    const minerHrp = checkAddressField(block.miner, { allowEmpty: true });
    if (!minerHrp.ok) return { ok: false, reason: minerHrp.reason };
  }
  for (const s of samples) {
    for (const a of [s?.miner, s?.address, s?.dest]) {
      if (!a) continue;
      const sr = checkAddressField(a, { allowEmpty: true });
      if (!sr.ok) return { ok: false, reason: sr.reason };
    }
  }
  const base = Number(decoded.baseFee || 1n);
  let fees = 0;
  const spent = spentB instanceof Set ? spentB : new Set(spentB || []);
  // A live parent fluxset already has every earlier height. Do not walk the
  // chain again. Rebuild only when this block has no parent state.
  const haveLive = parentFluxset && !Array.isArray(parentFluxset) && Array.isArray(parentFluxset.pubs);
  let live;
  if (haveLive) {
    live = parentFluxset;
  } else {
    const history = Array.isArray(evmHistory) && evmHistory.length ? evmHistory : (prev ? [prev] : []);
    const rebuilt = fluxsetFromBlocks(history);
    live = Array.isArray(parentFluxset)
      ? {
          pubs: parentFluxset,
          commits: rebuilt.commits,
          spendTags: parentSpendTags instanceof Set ? parentSpendTags : new Set(parentSpendTags || rebuilt.spendTags || []),
          jroot: rebuilt.jroot,
        }
      : rebuilt;
  }
  // R28 (attack 8): a share whose one-time key is already a note would make
  // two notes share a key image, so it is refused; so is a fee key that is.
  {
    const known = admitPubIndex(live);
    for (const r of bluRows) {
      if (known.has(Buffer.from(r.shareP).toString('hex'))) return { ok: false, reason: 'share_key' };
    }
    const fk = blunoteFields(txs[0])?.feeKey;
    if (fk && known.has(Buffer.from(fk.P).toString('hex'))) return { ok: false, reason: 'share_key' };
  }
  const pubs = (live.pubs || []).slice();
  const commits = (live.commits || []).slice();
  const spentTags = parentSpendView(live.spendTags);
  // The body loop records this block's tags. Funded-body checks the same
  // rules against the parent set, then its own additions, so a tag this
  // tx just recorded is not a double spend of itself.
  const parentTags = parentSpendView(live.spendTags);
  const pushPub = (tx, o) => {
    if (!outputJoinsAdmitSet(tx, o)) return null;
    const note = fs1OutputNote(o);
    if (!fs1LeafFor(o)) return { ok: false, reason: 'admit_note_point' };
    try {
      pubs.push(pointFrom(note.admitPub));
      commits.push(Buffer.from(note.commit));
    } catch {
      return { ok: false, reason: 'admit_note_point' };
    }
    return null;
  };
  // Compaction strips a hidden output's opening, so the store reads it on
  // the rows as they arrived (store.js arrivedRows) and it keeps its place
  // as this first body check.
  const arrivedOpen = opts.arrivedRows?.get(arrivedRowsKey(block))?.opening;
  let ownOpen = null;
  for (const tx of txs) {
    ownOpen = openingBeforeCarry(tx);
    if (ownOpen) break;
  }
  // An opening only the arrived rows carry is the serving peer's fault.
  if (arrivedOpen) return ownOpen ? arrivedOpen : { ...arrivedOpen, peerOnly: true };
  if (ownOpen) return ownOpen;
  const coinbaseCarry = (txs[0]?.coinbase || String(txs[0]?.kind || '') === 'coinbase')
    ? unboundMembershipCarry(txs[0])
    : { ok: true };
  if (!coinbaseCarry.ok) return coinbaseCarry;
  const body = txs.slice(1);
  const seenOwners = new Map();
  const drawnWithdraws = new Set();
  for (let i = 0; i < body.length; i += 1) {
    const tx = body[i];
    // A disabled pool-withdraw is custodial_pull before range or kind.
    const pull = custodialPullRejected(tx);
    if (pull) return pull;
    // A refused kind returns kind before an unbound proof, tag, or commit vin
    // is membership. The range check still runs first. A verified proof then
    // returns kind. Lock, vote, and withdraw keep the commit-vin reject.
    const kindGate = v12KindRejected(tx);
    if (kindGate && moneyNeedsRange(tx)) {
      for (const o of (tx.vout || [])) {
        if (!o?.commit || !o.rangeProof || o.rangeProof === true) {
          return { ok: false, reason: 'range_proof' };
        }
        if (!verifyRange(o.commit, o.rangeProof)) return { ok: false, reason: 'range_proof' };
      }
    }
    if (kindGate) return kindGate;
    if (!flowNeedsDummy(tx) && !typedKindNeedsAdmitV3(tx)) {
      const carry = unboundMembershipCarry(tx);
      if (!carry.ok) return carry;
    }
    const userCb = userCoinbaseRejected(tx);
    if (userCb) return userCb;
    const explicitKind = explicitTypedKindRejected(tx);
    if (explicitKind) return explicitKind;
    const typedVin = typedCommitRejected(tx);
    if (typedVin) return typedVin;
    const open = valueOpenRejected(tx);
    if (open) return open;
    const leafAsk = bLeafAskRejected(tx);
    if (leafAsk) return leafAsk;
    // Flow byte 0 is classified before the anchor window, so a v2 blob is not
    // saved by an anchor and does not reach the v2 verifier.
    const flowVersion = v12FlowVersionRejected(tx);
    if (flowVersion) return flowVersion;
    const anchored = checkAdmitAnchor(tx, height);
    if (!anchored.ok) return anchored;
    // Byte 3 is verified here, before dummy and range, so a bad proof is not
    // reported as a missing range proof. The v2 verifier does not run.
    let flowV3Done = false;
    if (flowNeedsDummy(tx) && flowPresentsProof(tx)) {
      const flowProof = verifyFlowAdmitV3(tx, {
        height,
        blocks: Array.isArray(evmHistory) ? evmHistory : [],
        spentTags,
        magic,
        noteAtAnchor: typeof opts.noteAtAnchor === 'function' ? opts.noteAtAnchor : null,
      });
      if (!flowProof.ok) return flowProof;
      if (!flowProof.skip) {
        for (const th of flowProof.tags || []) spentTags.add(th);
        flowV3Done = true;
      }
    }
    const clockField = typedClockRejected(tx);
    if (clockField) return clockField;
    const receiptPub = receiptAdmitRejected(tx);
    if (receiptPub) return receiptPub;
    const publicReceipt = publicReserveReceiptRejected(tx);
    if (publicReceipt) return publicReceipt;
    const lockedNote = lockNoteSpendRejected(reserveState, tx, headerMs);
    if (lockedNote) return lockedNote;
    const outs = Array.isArray(tx.vout) ? tx.vout : [];
    const fields = checkTxAddressFields(tx, { coinbase: false });
    if (!fields.ok) {
      if (fields.reason === 'silent_id_on_chain') return { ok: false, reason: 'silent_id_on_chain' };
      if (fields.reason === 'rest_frame_on_chain') return { ok: false, reason: 'rest_frame_on_chain' };
      return { ok: false, reason: fields.reason };
    }
    for (const o of outs) {
      if (o?.address) {
        const r = checkAddressField(o.address, { allowEmpty: String(tx.kind || o.kind || '') === 'burn' });
        if (!r.ok) return { ok: false, reason: r.reason };
      }
    }
    const ins = Array.isArray(tx.vin) ? tx.vin : [];
    const vinAdmit = bSpendVinRejected(tx);
    if (vinAdmit) return vinAdmit;
    for (const i of ins) {
      const link = sealedVinLinkField(i);
      if (link) return { ok: false, reason: 'vin_link' };
      if (i?.address) {
        const r = checkAddressField(i.address, { allowEmpty: false });
        if (!r.ok) return { ok: false, reason: r.reason };
      }
    }
    // A vote with no input, no fee, and no opened value mints nothing.
    // The empty vin is the owner signature, not an unfunded mint.
    const voteKind = String(tx?.kind || '');
    let bareVote = voteKind === 'vote' && !tx?.mint && Math.floor(Number(tx?.fee || 0)) === 0;
    if (bareVote) {
      for (const o of (tx.vout || [])) {
        const raw = o?.valueProof?.v != null ? o.valueProof.v : o?.nanos;
        if (raw == null || raw === '') continue;
        const n = Math.floor(Number(raw));
        if (n > 0) bareVote = false;
      }
    }
    const unfunded = !bareVote && (!Array.isArray(tx.vin) || tx.vin.length === 0 || tx.mint);
    // A wrapped-SHE programme never mints. Its programId arm is live for any
    // v12 kind. Its kind arm (wrap, wshe, ...) and its ticker arm are refused
    // first today, as kind (v12KindRejected) and unsigned (unsignedBodyField);
    // they stay as a backstop if either gate moves.
    if (wrapMintForbidden(tx)) {
      return { ok: false, reason: 'mint_forbidden' };
    }
    // The join programme is gone. Its programId arm is live for any v12 kind.
    // The join-genesis kind is refused first as kind (v12KindRejected); that
    // arm stays as a backstop if the kind gate moves.
    if (String(tx.programId || '') === JOIN_PROGRAM || String(tx.kind || '') === JOIN_KIND_GENESIS) {
      return { ok: false, reason: 'join_removed' };
    }
    // Live: an unfunded body (no vin, or mint set) that is not the Reserve's
    // own extra-mint, such as a fee-paying vote with no input.
    if ((unfunded || tx.mint) && !extraMintAllowed(tx.programId, { kind: tx.kind })) {
      return { ok: false, reason: 'mint_forbidden' };
    }
    let boundIns = null;
    if (flowNeedsDummy(tx)) {
      boundIns = flowInputsBound(tx);
      if (!boundIns.ok) return boundIns;
    }
    if (flowNeedsDummy(tx) && dummyCount(tx) < 1) {
      return { ok: false, reason: 'dummy_outs' };
    }
    if (moneyNeedsRange(tx)) {
      for (const o of (tx.vout || [])) {
        if (!o?.commit || !o.rangeProof || o.rangeProof === true) {
          return { ok: false, reason: 'range_proof' };
        }
        if (!verifyRange(o.commit, o.rangeProof)) return { ok: false, reason: 'range_proof' };
      }
    }
    const typed = typedCommitRejected(tx);
    if (typed) return typed;
    if (flowNeedsDummy(tx)) {
      const dummies = (tx.vout || []).filter((o) => String(o.kind || '') === 'dummy');
      if (!dummies.every((o) => verifySealedNote(o, 0))) return { ok: false, reason: 'dummy_outs' };
      if (!verifyFlowConservation(tx)) return { ok: false, reason: 'commit_sum' };
      if (flowV3Done) {
        // Tags are already in spentTags. Do not send the blob to admit_verify.
      } else {
        // A flow that did not finish verifyFlowAdmitV3 is not a member.
        // The v2 verifier is not called.
        return { ok: false, reason: 'admit_membership' };
      }
    }
    for (const o of outs) {
      const pushed = pushPub(tx, o);
      if (pushed) return pushed;
    }
    const noteFund = verifyTypedAdmitFunding(tx, {
      height,
      blocks: Array.isArray(evmHistory) ? evmHistory : [],
      spentTags,
      magic,
      noteAtAnchor: typeof opts.noteAtAnchor === 'function' ? opts.noteAtAnchor : null,
    });
    if (!noteFund.ok) return noteFund;
    if (Array.isArray(noteFund.tags)) {
      for (const th of noteFund.tags) spentTags.add(th);
    }
    const summed = typedCommitSum(tx, {
      height,
      magic,
      state: reserveState,
      nowMs: Number(decoded.timestamp) || 0,
    });
    if (!summed.ok) return summed;
    const stake = boundReserveWithdraw(tx, reserveState, drawnWithdraws, Number(decoded.timestamp) || 0);
    if (!stake.ok) return stake;
    const auth = reserveAuth(tx, reserveState, seenOwners);
    if (!auth.ok) return auth;
    const claimAuth = rewardClaimRejected(tx, reserveState, height);
    if (claimAuth) return claimAuth;
    const withdrawAuth = withdrawRewardRejected(reserveState, tx, Number(decoded.timestamp) || 0);
    if (withdrawAuth) return withdrawAuth;
    const rollAuth = rollRewardRejected(reserveState, tx, Number(decoded.timestamp) || 0, height);
    if (rollAuth) return rollAuth;
    if (containsShe1(tx)) return { ok: false, reason: 'she1_on_chain' };
    const bound = verifyPoolWithdrawBound(tx);
    if (!bound.ok) return bound;
    const taxed = levyTaxed(tx);
    const need = levyNeed(tx, body.slice(0, i));
    const paid = postedFeeNanos(tx);
    if (paid == null) return { ok: false, reason: 'fee' };
    const spendFee = bSpendFeeRejected(tx);
    if (spendFee) return spendFee;
    if (paid < need) return { ok: false, reason: 'levy' };
    if (taxed && paid > LEVY_CAP_NANOS) return { ok: false, reason: 'levy' };
    if (taxed && tx.maxLevy != null && need > Number(tx.maxLevy)) {
      return { ok: false, reason: 'max_levy' };
    }
    fees += paid;
    if (String(tx.kind || '') === 'vortice-register') {
      const gate = gateVorticeRegister(tx);
      if (!gate.ok) return { ok: false, reason: gate.reason || 'vortice_register' };
    }
    if (tx.kind === 'b-spend') {
      let got;
      try {
        got = bindBSpend(tx, {
          history: evmHistory,
          prev,
          tipHeight: parentHeight + 1,
          spent,
        });
      } catch {
        return { ok: false, reason: 'leaf' };
      }
      if (!got || !got.ok) return got || { ok: false, reason: 'leaf' };
    }
    if (stake.mintId) drawnWithdraws.add(stake.mintId);
  }
  if (typeof spendableOf === 'function') {
    const funded = verifyFundedBody(body, spendableOf, {
      seenDigests,
      reserveState,
      nowMs: Number(decoded.timestamp) || 0,
      height,
      spentTags: parentTags,
      magic,
      noteAtAnchor: typeof opts.noteAtAnchor === 'function' ? opts.noteAtAnchor : null,
    });
    if (!funded.ok) return funded;
  }
  // R28: the draw. Its carry is fixed before the PoW; its winners come from
  // this block's PoW hash. The record is what a pruned node keeps. The
  // finder levy joins the draw (or, in an empty block, the fee or reserve
  // note); the reserve levy is its own explicit note.
  const levySplit = splitLevy(fees);
  let blunoteRecord = null;
  let reserveExtra = 0n;
  if (skipFlow && !shareBatch.length && block.blunoteRecord != null && block.blunoteRecord !== '') {
    // A buried pruned block: its record rests on burial (D5) and on the next
    // block's commitment to its root.
    blunoteRecord = Buffer.isBuffer(block.blunoteRecord) ? block.blunoteRecord : Buffer.from(String(block.blunoteRecord), 'hex');
    const rec = decodeRecord(blunoteRecord);
    if (!rec) return { ok: false, reason: 'blunote_record' };
    if (!bluFields.feeKey && rec.n === 0) reserveExtra = BigInt(levySplit.finder);
  } else {
    const budgetB = opts.hashAcceptedSeries == null ? null : hashBudgetNanos(opts.hashAcceptedSeries, hashBonusNanos);
    let settle;
    try {
      settle = blunoteSettle({
        shares: bluRows,
        powHash: hash,
        potPayable: BigInt(payablePot),
        feeNanos: blunoteFeeNanos(wantPot, bluFields),
        feeKey: bluFields.feeKey,
        finderLevy: BigInt(levySplit.finder),
        unitNanos: liveUnit,
        budgetNanos: budgetB,
      });
    } catch {
      return { ok: false, reason: 'blunote_payout' };
    }
    if (settle.carryOut !== BigInt(carryOut)) return { ok: false, reason: 'pot_carry' };
    reserveExtra = settle.reserveExtra;
    const root = bluRows.length ? bluSlotRoot(shareBatch) : { root: Buffer.alloc(32), total: 0n };
    blunoteRecord = encodeRecord({
      batchRoot: root.root,
      n: bluRows.length,
      W: root.total,
      T: settle.T,
      feeV: settle.feeV,
      feeR: bluFields.feeKey ? bluFields.feeKey.R : null,
      feeP: bluFields.feeKey ? bluFields.feeKey.P : null,
      winners: settle.winners.map((w) => ({ R: w.R, P: w.admitPub, m: w.m })),
    });
  }
  {
    const reserveRows = cbVouts.filter((o) => o?.kind === 'reserve-fee');
    const wantReserve = BigInt(levySplit.reserve) + reserveExtra;
    let reserveSum = 0n;
    for (const o of reserveRows) {
      const v = openedCoinbaseNanos(o);
      if (v == null) return { ok: false, reason: 'levy_split' };
      reserveSum += BigInt(v);
      const d20 = noteDest20(o);
      if (!d20 || !d20.equals(Buffer.from(hash20FromAddress(reserveFeeDest())))) return { ok: false, reason: 'levy_split' };
    }
    if (wantReserve === 0n ? reserveRows.length !== 0 : reserveSum !== wantReserve) {
      return { ok: false, reason: 'levy_split' };
    }
  }
  // The parent's record is bound under this block's PoW.
  {
    const wantPrev = parentRecordRoot(prev);
    if (prev && height > 1 && !wantPrev) return { ok: false, reason: 'blunote_prev' };
    if (wantPrev ? !(bluFields.prev && bluFields.prev.equals(wantPrev)) : bluFields.prev != null) {
      return { ok: false, reason: 'blunote_prev' };
    }
  }
  const addedPubs = [];
  for (const tx of txs) {
    for (const o of tx.vout || []) {
      if (!outputJoinsAdmitSet(tx, o)) continue;
      const note = fs1OutputNote(o);
      if (!fs1LeafFor(o)) return { ok: false, reason: 'admit_note_point' };
      try {
        addedPubs.push(pointFrom(note.admitPub));
      } catch {
        return { ok: false, reason: 'admit_note_point' };
      }
    }
  }
  const extended = live.zeroFrontier ? extendZeroRoot(live, addedPubs) : null;
  const wantRoot = extended
    ? Buffer.from(extended)
    : Buffer.from(jrootOf(live.pubs.concat(addedPubs)));
  const gotRoot = txs[0].jroot;
  if (gotRoot && !Buffer.from(asU8(gotRoot)).equals(wantRoot)) {
    return { ok: false, reason: 'admit_membership' };
  }
  // The store passes the live vault. A reserve row with no vault fails closed.
  if (reserveState) {
    const rewardGate = stakeRewardRejected(reserveState, block, headerMs, { require: true });
    if (rewardGate) return rewardGate;
  }
  const vaultForTrial = reserveState || null;
  const vaultTry = trialReserveApply({
    state: vaultForTrial,
    block,
    nowMs: Number(decoded.timestamp),
    oracleWindow: opts.oracleWindow || null,
    oracleWindowSize: opts.oracleWindowSize,
    activationHeight: opts.oracleActivationHeight,
    height,
    parentMs,
    genesisMs: resolvedGenesisMs || genesisMs || 0,
  });
  if (!vaultTry.ok) return { ok: false, reason: vaultTry.reason || 'epoch_open' };
  const parentSupply = parentSupplyState(prev, block, opts, height, burialTip);
  if (!parentSupply.ok) return parentSupply;
  const stepped = supplyStep(parentSupply.state, { ...block, blunoteRecord: blunoteRecord.toString('hex') }, {
    magic,
    unit: hashBonusNanos,
    tipHeight: burialTip,
    height,
    genesisMs: resolvedGenesisMs || genesisMs || 0,
    blockHash: hash,
    vault: reserveState || null,
    oracle: {
      oracleWindow: opts.oracleWindow || null,
      oracleWindowSize: opts.oracleWindowSize,
      activationHeight: opts.oracleActivationHeight,
      height,
      parentMs,
      genesisMs: resolvedGenesisMs || genesisMs || 0,
    },
  });
  if (!stepped.ok) return { ok: false, reason: stepped.reason || 'supply' };
  return {
    ok: true,
    hash,
    decoded,
    height,
    aLeaves,
    bLeaves,
    jroot: wantRoot,
    supplyState: stepped.state,
    blunoteRecord: blunoteRecord.toString('hex'),
  };
}

/**
 * Parent supply for this block. A carried state must link to `prev`.
 * A missing state is not invented from a window of history. A genesis
 * child may fold that one parent. Anything taller fails closed.
 */
function parentSupplyState(prev, block, opts, height, burialTip) {
  const magic = opts?.magic;
  const genesisMs = Number(opts?.genesisMs) || 0;
  const tipHeight = Number.isInteger(burialTip) && burialTip >= 0
    ? burialTip
    : (Number.isInteger(height) && height > 0 ? height : 1);
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'parentSupply') && opts.parentSupply) {
    if (!prev) {
      if (Number(opts.parentSupply.height) !== 0) return { ok: false, reason: 'supply_state' };
      return { ok: true, state: opts.parentSupply };
    }
    if (!supplyLinks(opts.parentSupply, prev)) return { ok: false, reason: 'supply_state' };
    return { ok: true, state: opts.parentSupply };
  }
  if (Array.isArray(opts?.supplyParents)) {
    const parents = opts.supplyParents;
    if (!parents.length) {
      if (!prev) return { ok: true, state: emptySupplyState(genesisMs) };
      return { ok: false, reason: 'supply_state' };
    }
    if (Number(parents[0]?.height || 0) !== 1) return { ok: false, reason: 'supply_state' };
    const folded = foldSupply(parents, { magic, genesisMs, tipHeight });
    if (!folded.ok) return { ok: false, reason: folded.reason || 'supply' };
    if (prev && !supplyLinks(folded.state, prev)) return { ok: false, reason: 'supply_state' };
    return { ok: true, state: folded.state };
  }
  if (!prev) return { ok: true, state: emptySupplyState(genesisMs) };
  if (Number(prev.height || 0) <= 1) {
    const folded = foldSupply([prev], { magic, genesisMs, tipHeight });
    if (!folded.ok) return { ok: false, reason: folded.reason || 'supply' };
    return { ok: true, state: folded.state };
  }
  return { ok: false, reason: 'supply_state' };
}

function headerTimeMs(block) {
  try {
    return Number(decodeHeader(Buffer.from(block.header)).timestamp);
  } catch {
    return 0;
  }
}

/** Chain genesis for the EVM clock. A genesis header in the replay wins.
 * Otherwise the header assessment. A caller-supplied option is not a clock. */
function evmClockGenesis(consensus, block, opts) {
  const rows = [];
  if (Array.isArray(opts?.evmHistory)) rows.push(...opts.evmHistory);
  if (block) rows.push(block);
  for (const row of rows) {
    if (!row?.header) continue;
    try {
      const decoded = decodeHeader(Buffer.from(row.header));
      if (!decoded.prevBlockHash.equals(GENESIS_PREV)) continue;
      const ts = Number(decoded.timestamp);
      if (Number.isFinite(ts) && ts > 0) return ts;
    } catch { /* skip an unreadable header */ }
  }
  const assessed = Number(consensus?.genesisMs);
  if (Number.isFinite(assessed) && assessed > 0) return assessed;
  return 0;
}

/** The frozen root and census a claim or leaf vote must carry on the coinbase. */
function vaultCoinbaseBind(state, txs) {
  if (!state) return undefined;
  const roots = Object.create(null);
  const census = Object.create(null);
  let need = false;
  for (const tx of Array.isArray(txs) ? txs : []) {
    if (!tx || tx.coinbase) continue;
    const kind = String(tx.kind || '');
    if (kind !== 'reward-claim' && kind !== 'leaf-vote') continue;
    if (kind === 'reward-claim' && !tx.vaultProof) continue;
    if (kind === 'leaf-vote' && !tx.voteProof) continue;
    need = true;
    const earn = String(Math.floor(Number(tx.earnEpoch ?? tx.rootEpoch) || 0));
    const start = String(state.epochStartRoots?.[earn] || '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(start)) roots[earn] = start;
    if (kind !== 'leaf-vote') continue;
    const row = state.epochCensus?.[earn];
    const leaves = Math.floor(Number(row?.leafCount) || 0);
    const openH = Math.floor(Number(row?.openHeight) || 0);
    if (row?.known && leaves >= 1 && openH >= 0) census[earn] = { leafCount: leaves, openHeight: openH };
  }
  return need ? { roots, census } : undefined;
}

async function verifyBlockEvm(consensus, block, opts = {}) {
  let session = opts.evmSession;
  let fresh = false;
  try {
    if (!session) {
      session = await bootReserveEvm();
      fresh = true;
    }
  } catch (e) {
    // The node could not start its own EVM: a local fault, not a verdict on
    // the block, so it is never noted against the block or its peer.
    return { ok: false, reason: 'evm_local', error: String(e?.message || e) };
  }
  const genesisMs = evmClockGenesis(consensus, block, opts);
  if (fresh && Array.isArray(opts.evmHistory)) {
    for (const b of opts.evmHistory) {
      if (!blockNeedsEvm(b?.txs || [])) continue;
      const replayed = await executeBlockEvm(session, b.txs, headerTimeMs(b), genesisMs, undefined, undefined, {
        height: Math.floor(Number(b?.height) || 0),
        magic: opts.magic || MAGIC_TESTNET,
      });
      if (!replayed.ok) {
        // Our own stored history did not replay: local, as above.
        return { ok: false, reason: 'evm_local', error: `replay:${replayed.reason}` };
      }
    }
  }
  const headerMs = consensus?.decoded?.timestamp != null
    ? Number(consensus.decoded.timestamp)
    : headerTimeMs(block);
  const owedRoot = opts.reserveState ? coinbaseRewardRoot(opts.reserveState, headerMs) : undefined;
  const vaultBind = vaultCoinbaseBind(opts.reserveState, block.txs || []);
  const structural = Math.floor(Number(consensus?.height) || 0);
  // The store's session is the node's EVM state. Its calls for this block run
  // inside a checkpoint: a failed block, or a probe, leaves no call applied,
  // and an append commits only once the block is stored (store.js).
  const probe = opts.probeBody === true;
  const sm = (opts.evmCheckpoint === true || probe) ? session?.evm?.stateManager : null;
  if (sm) await sm.checkpoint();
  let ran;
  try {
    ran = await executeBlockEvm(session, block.txs || [], headerMs, genesisMs, owedRoot, vaultBind, {
      height: structural > 0 ? structural : Math.floor(Number(block?.height) || 0),
      magic: opts.magic || MAGIC_TESTNET,
    });
  } catch (err) {
    // A throw is a refused block too: its partial calls never stay applied.
    if (sm) await sm.revert();
    throw err;
  }
  if (!ran.ok) {
    if (sm) await sm.revert();
    return { ok: false, reason: 'evm', error: ran.reason };
  }
  if (sm && probe) await sm.revert();
  return {
    ...consensus,
    evmRan: ran.calls > 0,
    evm: ran,
    evmSession: session,
    evmOpen: !!sm && !probe,
  };
}

function asBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v == null) return Buffer.alloc(0);
  try { return Buffer.from(v); } catch { return Buffer.alloc(0); }
}

/**
 * Domain for book.seal. bookseal1 predates N-1. A seal under that tag, or
 * under a fingerprint that does not name N-1, is not this book's seal.
 * The load discards it and checks the notes.
 */
export const BOOK_SEAL_DOMAIN = 'bookseal2';

/** Keyed sha256 over the rules id, the genesis pin, the checkpoint, and each header and stored hash.
 *  The key is the per-install secret kept outside the datadir.
 *  A copied chain.bin plus book.seal does not verify under another install.
 *  A seal from an older domain, or from another fingerprint, does not match.
 *  persist and a successful verify write it. writeChainBin does not.
 *  Header and hash only. The body shortcut is book.snap, not this seal.
 */
/** Running book.seal hasher. chainLoadSeal folds every block into this. */
export function chainLoadSealHash(key, magic = MAGIC_TESTNET) {
  const k = asBuf(key);
  if (k.length !== 32) throw new Error('seal_key');
  // RESERVE_NOTE lives in consensusFingerprint. A different principal rule
  // is a different seal, so old and new nodes do not share a chain.
  const rules = Buffer.from(String(consensusFingerprint(magic)), 'utf8');
  const pin = Buffer.from(String(V12_GENESIS_BLOCK_HASH || ''), 'utf8');
  const cpH = Math.floor(Number(V12_BOOTSTRAP_CHECKPOINT?.height) || 0);
  const cpHash = Buffer.from(cpH > 0 ? String(V12_BOOTSTRAP_CHECKPOINT?.hash || '') : '', 'utf8');
  const h = createHash('sha256');
  const domain = Buffer.from(BOOK_SEAL_DOMAIN, 'utf8');
  h.update(u32le(domain.length));
  h.update(domain);
  h.update(u32le(rules.length));
  h.update(rules);
  h.update(u32le(pin.length));
  h.update(pin);
  h.update(u32le(cpH));
  h.update(u32le(cpHash.length));
  h.update(cpHash);
  h.update(k);
  return h;
}

export function chainLoadSealUpdate(h, block) {
  const header = asBuf(block?.header);
  const hash = asBuf(block?.hash);
  const n = Buffer.alloc(8);
  n.writeUInt32LE(header.length >>> 0, 0);
  n.writeUInt32LE(hash.length >>> 0, 4);
  h.update(n);
  h.update(header);
  h.update(hash);
}

export function chainLoadSeal(blocks, key, magic = MAGIC_TESTNET) {
  const h = chainLoadSealHash(key, magic);
  for (const b of Array.isArray(blocks) ? blocks : []) chainLoadSealUpdate(h, b);
  return h.digest('hex');
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n) >>> 0, 0);
  return b;
}

/** Empty string means the pin is unset. A non-hex pin is refused. */
function normGenesisPin(hex) {
  const s = String(hex || '').trim().toLowerCase();
  if (!s) return '';
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  return s;
}

/**
 * Load check for a chain.bin or latest.bin before the vault boots.
 * Empty passes. Header linkage runs first. Body consensus then runs with
 * loadReplay so a pruned body can be buried under this book's own tip.
 * That replay does not call Date.now. The future ceiling is one clock,
 * nowMs or the load time, plus MTP_FUTURE_MS, applied to every stamp.
 * trustStoredHash skips the header ShearHash only when book.seal matches
 * this install's key. That same match sets trustShareWork, which skips the
 * share hash and still checks the slot, the width, the dest, duplicates,
 * and the paid work key. A foreign book hashes every share that is still
 * on the block. An empty genesis pin is not an assume-valid anchor.
 * A buried pruned batch is empty, so those frames are not re-hashed.
 * Mint, range, spend, the fee cap, and the hash ledger still run.
 * fromIndex replays only the suffix. The prefix state is the caller's,
 * already checked under this install's snapshot. It is not a weaker rule.
 */
function applyLoadedVault(vault, list, index, load) {
  const block = list[index];
  let nowMs = 0;
  let parentMs = 0;
  try { nowMs = Number(decodeHeader(asBuf(block.header)).timestamp) || 0; } catch { nowMs = 0; }
  if (index > 0) {
    try { parentMs = Number(decodeHeader(asBuf(list[index - 1].header)).timestamp) || 0; } catch { parentMs = 0; }
  }
  let genesisMs = Number(load?.genesisMs) || 0;
  if (!(genesisMs > 0) && list[0]?.header) {
    try { genesisMs = Number(decodeHeader(asBuf(list[0].header)).timestamp) || 0; } catch { genesisMs = 0; }
  }
  const fields = reserveApplyFields({
    prior: list.slice(0, index),
    block,
    magic: load?.magic || MAGIC_TESTNET,
    parentMs,
    genesisMs,
    nowMs,
  });
  if (load && load.oracleActivationHeight !== undefined) {
    fields.activationHeight = load.oracleActivationHeight;
  }
  return applyReserveBlock({ state: vault, ...fields, requireStakeReward: true });
}

function beginLoaded(blocks, {
  trustStoredHash = false,
  trustShareWork = null,
  nowMs = null,
  genesisHash = V12_GENESIS_BLOCK_HASH,
  checkpoint = V12_BOOTSTRAP_CHECKPOINT,
  fromIndex = 0,
  prior = null,
  reorgHaltDepth = 0,
  burialOf = null,
  magic = MAGIC_TESTNET,
  oracleActivationHeight = undefined,
} = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (!list.length) return { ok: true, empty: true };
  const gated = chainStage0Rejected(list);
  if (gated) return gated;
  // N-1 runs inside each block, after the header and the budget. A load
  // does not walk leaves before proof-of-work.
  const givenClock = Number(nowMs);
  const clock = Number.isFinite(givenClock) && givenClock > 0 ? givenClock : Date.now();
  const pinned = normGenesisPin(genesisHash);
  if (pinned == null) return { ok: false, reason: 'genesis' };
  const cpHeight = Math.floor(Number(checkpoint?.height) || 0);
  const cpHash = cpHeight > 0 ? normGenesisPin(checkpoint?.hash) : '';
  if (cpHeight > 0 && !cpHash) return { ok: false, reason: 'checkpoint' };
  const start = Math.floor(Number(fromIndex) || 0);
  if (start < 0 || start > list.length) return { ok: false, reason: 'height' };
  const loadTip = Number(list[list.length - 1]?.height) || list.length;
  let prevLink = GENESIS_PREV;
  let prevDecoded = null;
  let prevHeight = 0;
  let genesisMs = 0;
  let owedIn = [];
  let acceptedSeries = [];
  const spentB = new Set();
  const mtp = [];
  let flux = emptyFluxset();
  let supply = emptySupplyState();
  let supplyAt = [];
  let anchors = [];
  const vault = emptyVault();
  vault.magic = magic || MAGIC_TESTNET;
  if (start > 0) {
    for (let j = 0; j < start; j += 1) {
      let priorTs = 0;
      try { priorTs = Number(decodeHeader(asBuf(list[j].header)).timestamp); } catch { priorTs = 0; }
      const applied = applyLoadedVault(vault, list, j, { magic, oracleActivationHeight });
      if (applied && applied.ok === false) return { ok: false, reason: applied.reason || 'epoch_open' };
    }
  }
  if (start > 0) {
    if (!prior) return { ok: false, reason: 'height' };
    try {
      const genesisDecoded = decodeHeader(asBuf(list[0].header));
      genesisMs = Number(genesisDecoded.timestamp);
      prevDecoded = decodeHeader(asBuf(list[start - 1].header));
      prevLink = asBuf(list[start - 1].hash);
      prevHeight = Number(list[start - 1].height);
    } catch {
      return { ok: false, reason: 'bad_header' };
    }
    if (prevLink.length !== 32 || !Number.isFinite(genesisMs) || genesisMs <= 0) {
      return { ok: false, reason: 'prev' };
    }
    owedIn = Array.isArray(prior.owedRows) ? prior.owedRows : [];
    acceptedSeries = Array.isArray(prior.acceptedSeries) ? prior.acceptedSeries : [];
    for (const id of prior.spentIds || []) spentB.add(String(id));
    if (prior.flux && Array.isArray(prior.flux.pubs)) flux = prior.flux;
    if (!prior.supply || !supplyLinks(prior.supply, list[start - 1])) {
      return { ok: false, reason: 'supply_state' };
    }
    supply = prior.supply;
    if (Array.isArray(prior.supplyAt)) supplyAt = prior.supplyAt.slice();
    if (Array.isArray(prior.anchors)) anchors = prior.anchors.slice();
    const mtpFrom = Math.max(0, start - MTP_WINDOW);
    for (let j = mtpFrom; j < start; j += 1) {
      try {
        mtp.push(Number(decodeHeader(asBuf(list[j].header)).timestamp));
      } catch {
        return { ok: false, reason: 'bad_header' };
      }
    }
  }
  return {
    ok: true,
    list,
    state: {
      clock,
      pinned,
      cpHeight,
      cpHash,
      loadTip,
      start,
      prevLink,
      prevDecoded,
      prevHeight,
      genesisMs,
      owedIn,
      acceptedSeries,
      spentB,
      mtp,
      flux,
      vault,
      magic,
      oracleActivationHeight,
      supply,
      supplyAt,
      anchors,
      sawCheckpoint: cpHeight <= 0 || (start > 0 && cpHeight <= start),
      trustStoredHash: trustStoredHash === true,
      trustShareWork: trustStoredHash === true && trustShareWork !== false,
      reorgHaltDepth: Math.max(0, Math.floor(Number(reorgHaltDepth) || 0)),
      burialOf: typeof burialOf === 'function' ? burialOf : null,
    },
  };
}

/**
 * Owed rows and Admit frontiers share this spacing. A fork replays from the
 * checkpoint at or below its anchor, so the walk is this spacing plus the
 * fork, not the chain length.
 */
export const OWED_CHECKPOINT_SPACING = 32;

/**
 * Heights behind the tip that keep a frontier blob, plus one checkpoint
 * spacing. Halt depth 0 still covers the admit anchor window, so a spend
 * inside that window does not replay, and a deeper ancestor replays from
 * the previous checkpoint.
 */
export function frontierWindow(haltDepth) {
  const halt = Math.max(0, Math.floor(Number(haltDepth) || 0));
  return Math.max(ANCHOR_WINDOW, halt) + OWED_CHECKPOINT_SPACING;
}

/** True when this height keeps frontier blobs. Other heights keep n and jroot. */
export function keepsFrontier(height, tipHeight, haltDepth) {
  const h = Number(height);
  const tip = Number(tipHeight);
  if (!Number.isInteger(h) || h < 1) return false;
  if (!Number.isInteger(tip) || tip < 1 || h > tip) return false;
  if (h === 1 || h === tip) return true;
  if (tip - h < frontierWindow(haltDepth)) return true;
  return h % OWED_CHECKPOINT_SPACING === 0;
}

/** Drop frontier blobs that are outside the reorg window and are not checkpoints. */
export function retainFrontierBlobs(anchors, tipHeight, haltDepth) {
  if (!Array.isArray(anchors)) return;
  const tip = Number(tipHeight) || 0;
  for (let h = 1; h < anchors.length; h += 1) {
    const rec = anchors[h];
    if (!rec || (!rec.frontier && !rec.zeroFrontier)) continue;
    if (!keepsFrontier(h, tip, haltDepth)) {
      rec.frontier = null;
      rec.zeroFrontier = null;
    }
  }
}

function stepLoaded(state, list, i) {
  const block = list[i];
  const header = asBuf(block?.header);
  if (!block?.header || header.length === 0) return { ok: false, reason: 'no_header' };
  let decoded;
  try {
    decoded = decodeHeader(header);
  } catch {
    return { ok: false, reason: 'bad_header' };
  }
  if (!decoded.prevBlockHash.equals(state.prevLink)) return { ok: false, reason: 'prev' };
  const height = Number(block.height);
  if (height !== i + 1) return { ok: false, reason: 'height' };
  const ts = Number(decoded.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: 'timestamp' };
  if (state.prevDecoded && !(ts > Number(state.prevDecoded.timestamp))) return { ok: false, reason: 'timestamp' };
  if (ts > state.clock + MTP_FUTURE_MS) return { ok: false, reason: 'timestamp' };
  const stored = asBuf(block.hash);
  if (stored.length !== 32) return { ok: false, reason: 'pow' };
  let link = stored;
  if (!state.trustStoredHash) {
    const hash = shearHash(header);
    if (!meetsTarget(hash, decoded.bits) || !stored.equals(hash)) {
      return { ok: false, reason: 'pow' };
    }
    link = hash;
  }
  if (i === 0 && state.pinned && link.toString('hex') !== state.pinned) {
    return { ok: false, reason: 'genesis' };
  }
  if (state.cpHeight > 0 && height === state.cpHeight) {
    if (link.toString('hex') !== state.cpHash) return { ok: false, reason: 'checkpoint' };
    state.sawCheckpoint = true;
  }
  if (!state.prevDecoded) {
    // Same regtest seed as block verify. Public books keep GENESIS_BITS_PACKED.
    const wantBits = regtestBitsOverride(state.magic) ?? GENESIS_BITS_PACKED;
    if (decoded.bits !== wantBits || !isPackedBits(decoded.bits)) {
      return { ok: false, reason: 'bits' };
    }
    state.genesisMs = ts;
  } else {
    const parentIsGenesis = state.prevDecoded.prevBlockHash.equals(GENESIS_PREV);
    const regtestBits = regtestBitsOverride(state.magic);
    const quote = asertNextBits({
      anchorBits: parentIsGenesis ? state.prevDecoded.bits : (regtestBits != null ? regtestBits : GENESIS_BITS_PACKED),
      anchorTimeMs: parentIsGenesis ? Number(state.prevDecoded.timestamp) : state.genesisMs,
      anchorHeight: parentIsGenesis ? state.prevHeight : 1,
      blockTimeMs: ts,
      blockHeight: height,
      parentTimeMs: Number(state.prevDecoded.timestamp),
    });
    if (!quote.ok || !bitsAcceptAsert(decoded.bits, quote) || !isPackedBits(decoded.bits)) {
      return { ok: false, reason: 'bits' };
    }
  }
  const txs = Array.isArray(block.txs) ? block.txs : [];
  if (!txs.length || !txs[0]?.coinbase) return { ok: false, reason: 'coinbase' };
  const leaves = blockLeaves(txs);
  if (!leaves) return { ok: false, reason: 'duplicate_tx' };
  const merkle = merkleRoot(leaves);
  if (!merkle.equals(decoded.merkleRoot)) return { ok: false, reason: 'merkle' };
  const prevBlock = i === 0 ? null : list[i - 1];
  // A pruned block a proven-work header chain buried keeps that tip for
  // verify and for the owed step. Every other block is buried by this load.
  const own = state.burialOf ? state.burialOf(block) : null;
  const burial = Number.isInteger(own) && own > state.loadTip ? own : state.loadTip;
  const oracle = reserveApplyFields({
    prior: list.slice(0, i),
    block,
    magic: state.magic || MAGIC_TESTNET,
    parentMs: state.prevDecoded ? Number(state.prevDecoded.timestamp) || 0 : 0,
    genesisMs: state.genesisMs || 0,
    nowMs: ts,
  });
  if (state.oracleActivationHeight !== undefined) {
    oracle.activationHeight = state.oracleActivationHeight;
  }
  // The block paid the unit that was already live. Enact in this block
  // changes the next one. A voted 0 must not be rechecked as 1.
  const unitNow = hashBonusUnitNanos(state.vault?.liveHashBonusNanos);
  const body = verifyBlockConsensus(block, prevBlock, {
    trustedPowHash: link,
    loadReplay: true,
    oracleWindow: oracle.oracleWindow,
    oracleWindowSize: oracle.oracleWindowSize,
    oracleActivationHeight: oracle.activationHeight,
    // A foreign book cannot set this. An explicit false keeps the share
    // hash on an own-keyed load, which is how the load test reaches it
    // without a second header search. createStore does not pass it.
    trustShareWork: state.trustShareWork,
    tipHeight: burial,
    genesisMs: state.genesisMs,
    mtpTimestamps: state.mtp.slice(),
    owedIn: state.owedIn,
    hashAcceptedSeries: state.acceptedSeries,
    spentB: state.spentB,
    magic: state.magic || MAGIC_TESTNET,
    hashBonusNanos: unitNow,
    grandparentHeader: i >= 2 ? list[i - 2].header : null,
    parentFluxset: state.flux,
    parentSpendTags: state.flux.spendTags,
    parentSupply: state.supply,
    noteAtAnchor: (anchor) => noteFromAnchor(state.flux, state.anchors, anchor),
    evmHistory: historyPrefix(list, i),
    reserveState: state.vault,
  });
  if (!body || typeof body.then === 'function' || body.ok !== true) {
    return { ok: false, reason: body?.reason || 'pow' };
  }
  if (!body.supplyState || !supplyLinks(body.supplyState, { height, hash: link })) {
    return { ok: false, reason: 'supply_state' };
  }
  state.supply = body.supplyState;
  state.supplyAt.push(body.supplyState);
  const appliedVault = applyLoadedVault(state.vault, list, i, state);
  if (appliedVault && appliedVault.ok === false) {
    return { ok: false, reason: appliedVault.reason || 'epoch_open' };
  }
  const stepped = advanceHashOwed({
    owedIn: state.owedIn,
    acceptedSeries: state.acceptedSeries,
    block,
    unit: unitNow,
    tipHeight: burial,
  });
  if (!stepped.ok) return { ok: false, reason: stepped.reason || 'hash_owed' };
  state.owedIn = stepped.rows;
  state.acceptedSeries = stepped.acceptedSeries;
  state.flux = appendFluxBlock(state.flux, block);
  const root = state.flux.jroot;
  const row = {
    n: state.flux.pubs.length,
    jroot: root ? Buffer.from(root) : Buffer.alloc(32),
    zeroRoot: state.flux.zeroRoot ? Buffer.from(state.flux.zeroRoot) : null,
  };
  if (keepsFrontier(height, state.loadTip, state.reorgHaltDepth)) {
    row.frontier = state.flux.frontier || null;
    row.zeroFrontier = state.flux.zeroFrontier || null;
  }
  state.anchors[height] = row;
  state.mtp.push(ts);
  if (state.mtp.length > MTP_WINDOW) state.mtp.splice(0, state.mtp.length - MTP_WINDOW);
  state.prevLink = link;
  state.prevDecoded = decoded;
  state.prevHeight = height;
  return null;
}

function finishLoaded(begun) {
  if (begun.empty) return { ok: true };
  if (!begun.ok) return begun;
  const state = begun.state;
  if (!state.sawCheckpoint) return { ok: false, reason: 'checkpoint' };
  retainFrontierBlobs(state.anchors, state.loadTip, state.reorgHaltDepth);
  return {
    ok: true,
    owedRows: state.owedIn,
    acceptedSeries: state.acceptedSeries,
    spentIds: [...state.spentB],
    flux: state.flux,
    genesisMs: state.genesisMs,
    supply: state.supply,
    supplyAt: state.supplyAt,
    anchors: state.anchors,
  };
}

export function noteFromAnchor(flux, anchors, anchor) {
  const rec = anchors && anchors[Number(anchor)];
  if (!rec || !rec.jroot || !flux || !Array.isArray(flux.pubs)) return null;
  const n = Number(rec.n);
  if (!Number.isInteger(n) || n < 1 || n > flux.pubs.length) return null;
  const commits = Array.isArray(flux.commits) ? flux.commits : [];
  return {
    jroot: rec.jroot,
    n,
    pubs: flux.pubs.slice(0, n),
    commits: commits.slice(0, n),
  };
}

/** A prefix view. Load uses this so each height does not copy the chain. */
export function historyPrefix(list, end) {
  const n = Math.max(0, Number(end) || 0);
  const target = [];
  target.length = n;
  return new Proxy(target, {
    get(obj, prop, recv) {
      if (typeof prop === 'string') {
        const idx = Number(prop);
        if (Number.isInteger(idx) && String(idx) === prop && idx >= 0 && idx < n) return list[idx];
      }
      const val = Reflect.get(obj, prop, recv);
      return typeof val === 'function' ? val.bind(recv) : val;
    },
  });
}

export function verifyLoadedChain(blocks, opts = {}) {
  const begun = beginLoaded(blocks, opts);
  if (!begun.ok || begun.empty) return finishLoaded(begun);
  const { list, state } = begun;
  const report = typeof opts.onBlock === 'function';
  const total = list.length;
  const stride = report ? Math.max(1, Math.ceil((total - state.start) / 8)) : 0;
  for (let i = state.start; i < list.length; i += 1) {
    if (report) {
      const n = i + 1;
      let line = null;
      if (!opts.quiet && (i === state.start || n === total || (n - state.start) % stride === 0)) {
        line = `book-replay ${n}/${total}\n`;
      }
      opts.onBlock({ height: n, total, line });
    }
    const stop = stepLoaded(state, list, i);
    if (stop) return stop;
  }
  return finishLoaded(begun);
}

/** Clock captured on the parent. The worker must not sample Date.now() later. */
function bootVerifyNowMs(opts) {
  const given = Number(opts?.nowMs);
  if (Number.isFinite(given) && given > 0) return given;
  return Date.now();
}

/**
 * burialOf runs on the parent. The worker only receives the integer tips,
 * keyed by height, because stepLoaded calls it after height === i + 1.
 */
function bootBurialTips(list, burialOf) {
  if (typeof burialOf !== 'function') return null;
  const tips = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const tip = burialOf(list[i]);
    tips[i] = Number.isInteger(tip) ? tip : null;
  }
  return tips;
}

/** Stay on the parent. The worker cannot call them, and they are not load rules. */
const BOOT_VERIFY_PARENT_KEYS = new Set(['burialOf', 'onProgress', 'onBlock']);

/**
 * The option set verifyLoadedChain sees on this thread.
 * Functions stay here. Every other field is forwarded, including ones added
 * after this worker existed (magic, oracle activation, and whatever is next).
 * nowMs is this thread's clock so the worker does not sample Date.now().
 */
function bootVerifyPayload(list, opts) {
  const given = opts && typeof opts === 'object' ? opts : {};
  const verifyOpts = {};
  for (const key of Object.keys(given)) {
    if (BOOT_VERIFY_PARENT_KEYS.has(key)) continue;
    if (typeof given[key] === 'function') continue;
    verifyOpts[key] = given[key];
  }
  verifyOpts.nowMs = bootVerifyNowMs(given);
  return {
    blocks: list,
    burialTips: bootBurialTips(list, given.burialOf),
    verifyOpts,
  };
}

function runBootVerifyWorker(payload, opts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./boot_verify_worker.js', import.meta.url), { workerData: payload });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      fn(value);
    };
    worker.on('message', (msg) => {
      if (settled || !msg) return;
      if (msg.type === 'block') {
        try {
          if (msg.line) process.stderr.write(msg.line);
          if (typeof opts.onProgress === 'function') opts.onProgress({ height: msg.height, total: msg.total });
        } catch (err) {
          finish(reject, err);
        }
        return;
      }
      if (msg.type === 'result') finish(resolve, msg.result);
      else if (msg.type === 'error') finish(reject, new Error(msg.message || 'boot_verify'));
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => {
      if (!settled) finish(reject, new Error(`boot_verify_exit_${code}`));
    });
  });
}

/** Same load rules as verifyLoadedChain. stepLoaded runs in a worker, not on this event loop. */
export async function verifyLoadedChainAsync(blocks, opts = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (!list.length) return verifyLoadedChain(blocks, opts);
  return runBootVerifyWorker(bootVerifyPayload(list, opts), opts || {});
}

/**
 * Consensus verify. When the body has a Reserve vortice call or an EVM SHE
 * value transfer, runs pinned Reserve bytecode (fail closed) and returns a Promise.
 */
export function verifyBlock(block, prev, opts = {}) {
  const consensus = verifyBlockConsensus(block, prev, opts);
  if (consensus && typeof consensus.then === 'function') {
    return consensus.then((done) => {
      if (!done?.ok) return done;
      const txs = Array.isArray(block?.txs) ? block.txs : [];
      if (!blockNeedsEvm(txs)) return { ...done, evmRan: false };
      return verifyBlockEvm(done, block, opts);
    });
  }
  if (!consensus.ok) return consensus;
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  if (!blockNeedsEvm(txs)) return { ...consensus, evmRan: false };
  return verifyBlockEvm(consensus, block, opts);
}

export function chainWorkOf(blocks) {
  let sum = 0n;
  for (const b of blocks) {
    const bits = decodeHeader(Buffer.from(b.header)).bits;
    sum += blockWorkBig(bits);
  }
  return sum;
}

function tipHashHex(blocks) {
  const tip = blocks[blocks.length - 1];
  if (!tip?.hash) return '';
  try {
    return Buffer.from(tip.hash).toString('hex').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * One chain, whoever found the blocks.
 * More work wins. Equal work: the lower tip hash wins.
 * First-seen is not a rule, and the pool is not a special tip.
 */
export function shouldAdopt(local, remote) {
  const L = Array.isArray(local) ? local : [];
  const R = Array.isArray(remote) ? remote : [];
  if (!R.length) return false;
  if (!L.length) return true;
  const lw = chainWorkOf(L);
  const rw = chainWorkOf(R);
  if (rw > lw) return true;
  if (rw < lw) return false;
  const rh = tipHashHex(R);
  const lh = tipHashHex(L);
  return rh !== '' && lh !== '' && rh < lh;
}

/** Consecutive sealed header gaps, oldest first. A bad stamp is the 90s pad. */
export function headerGapsMs(chain) {
  const blocks = Array.isArray(chain) ? chain : [];
  const gaps = [];
  for (let i = 1; i < blocks.length; i += 1) {
    try {
      const a = decodeHeader(Buffer.from(blocks[i - 1].header));
      const b = decodeHeader(Buffer.from(blocks[i].header));
      const d = Number(b.timestamp) - Number(a.timestamp);
      gaps.push(Number.isFinite(d) && d > 0 ? d : TARGET_BLOCK_INTERVAL_MS);
    } catch {
      gaps.push(TARGET_BLOCK_INTERVAL_MS);
    }
  }
  return gaps;
}

/** Solve time of the tip, used as the next block's difficulty. Missing history uses 90s. */
export function parentSolveIntervalMs(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 2) return TARGET_BLOCK_INTERVAL_MS;
  try {
    const last = decodeHeader(Buffer.from(blocks[blocks.length - 1].header));
    const prev = decodeHeader(Buffer.from(blocks[blocks.length - 2].header));
    const d = Number(last.timestamp) - Number(prev.timestamp);
    return Number.isFinite(d) ? d : TARGET_BLOCK_INTERVAL_MS;
  } catch {
    return TARGET_BLOCK_INTERVAL_MS;
  }
}

/** aserti3-2d quote for the next header, including the emergency ease window.
 *  candidateTimestamp is the stamp the template will seal. A missing stamp
 *  means one target interval after the tip. The anchor is genesis, never
 *  the parent bits. Template issuance uses `packed`. A stall timer may issue
 *  `eased` only when `easeBits > 0`.
 */
export function retargetQuote(chain, candidateTimestamp) {
  if (!chain.length) return { ok: false, reason: 'asert_anchor' };
  let genesis;
  let last;
  try {
    genesis = decodeHeader(Buffer.from(chain[0].header));
    last = decodeHeader(Buffer.from(chain[chain.length - 1].header));
  } catch {
    return { ok: false, reason: 'asert_anchor' };
  }
  const parentTime = Number(last.timestamp);
  let blockTime = Number(candidateTimestamp);
  if (!Number.isFinite(blockTime)) blockTime = parentTime + TARGET_BLOCK_INTERVAL_MS;
  return asertNextBits({
    anchorBits: Number(genesis.bits) || GENESIS_BITS_PACKED,
    anchorTimeMs: Number(genesis.timestamp),
    anchorHeight: Number(chain[0].height || 1),
    blockTimeMs: blockTime,
    blockHeight: Number(chain[chain.length - 1].height || chain.length) + 1,
    parentTimeMs: parentTime,
  });
}

/** Full aserti3-2d packed bits for the next header.
 *  The emergency ease window is not this return value. A fresh template
 *  issues the full target. `retargetQuote` carries the ease window.
 */
export function retarget(chain, candidateTimestamp, magic = undefined) {
  const quote = retargetQuote(chain, candidateTimestamp);
  if (!quote.ok) return regtestBitsOverride(magic) ?? GENESIS_BITS_PACKED;
  return quote.packed;
}

export function genesisBlock({ miner, now = Date.now() }) {
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner,
    samples: [],
    txs: [],
    now,
    bits: GENESIS_BITS_PACKED,
  });
  let found = null;
  for (let n = 0n; n < 5_000_000n; n += 1n) {
    const header = setNonce(tpl.header, n);
    const hash = shearHash(header);
    if (meetsTarget(hash, GENESIS_BITS_PACKED)) {
      found = { header, hash, nonce: n };
      break;
    }
  }
  if (!found) throw new Error('genesis_pow');
  return {
    magic: MAGIC_TESTNET,
    height: 1,
    header: found.header,
    hash: found.hash,
    txs: tpl.txs,
    samples: [],
    shareBatch: [],
    miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
  };
}

export function publicJob(tpl, { jobId, shareBits }) {
  const decoded = decodeHeader(tpl.header);
  const job = {
    jobId: String(jobId),
    height: tpl.height,
    version: decoded.version,
    prevBlockHash: decoded.prevBlockHash.toString('hex'),
    merkleRoot: decoded.merkleRoot.toString('hex'),
    continuityRoot: decoded.continuityRoot.toString('hex'),
    timestamp: decoded.timestamp.toString(),
    bits: decoded.bits,
    shareBits,
    blockBits: decoded.bits,
    header: tpl.header.toString('hex'),
    nonce: '0',
    baseFee: decoded.baseFee.toString(),
  };
  return job;
}

export { hashHex };

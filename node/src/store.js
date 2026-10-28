import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { blockArrivalRejected } from '../../crypto/arrival_fields.js';
import { MAGIC_TESTNET, templateStampMs, HASH_TX_LIVE, consensusFingerprint, HASH_BONUS_NANOS, hashBonusUnitNanos, medianTimePast, MTP_WINDOW, GENESIS_BPS } from '../../crypto/asert.js';
import { oracleContextFor, reserveApplyFields, windowBlocksFor, coinbaseObserveRejected } from '../../crypto/reserve_oracle.js';
import { MAGIC_REGTEST, regtestPermitOk } from '../../crypto/regtest_bits.js';

import { HEADER_LEN, hashHex } from '../../crypto/shear_hash.js';
import { chainIndexOf, emptyChainIndex } from './chain_index.js';
import { asCommitFault } from './process_guard.js';
import { chainBSpendsRejected } from '../../crypto/clearing.js';
import {
  buildTemplate,
  verifyBlock,
  blockNeedsEvm,
  retarget,
  GENESIS_PREV,
  publicJob,
  headerHash,
  SAMPLE_PRUNE_CONFIRMATIONS,
  shouldPruneSamples,
  pruneSamples,
  leanBlock,
  sealedExplorerRows,
  lag1Continuity,
  shouldAdopt,
  chainWorkOf,
  headerGapsMs,
  shareCreditBound,
  verifyLoadedChain,
  verifyLoadedChainAsync,
  chainLoadSeal,
  chainLoadSealHash,
  chainLoadSealUpdate,
  V12_GENESIS_BLOCK_HASH,
  V12_BOOTSTRAP_CHECKPOINT,
  assessHeader,
  headerPowReason,
  headerLinkReason,
  rootHeaderReason,
  discardPreparedHeader,
  holdPreparedHeader,
  preparedHeaderHash,
  noteFromAnchor,
  OWED_CHECKPOINT_SPACING,
  keepsFrontier,
  frontierWindow,
  retainFrontierBlobs,
  blockLeaves,
  arrivedRowsKey,
  earlyRowsRejected,
} from './chain.js';
import { merkleRoot } from '../../crypto/merkle.js';

export { OWED_CHECKPOINT_SPACING, keepsFrontier, frontierWindow, retainFrontierBlobs };

/**
 * `a` is exactly `b`: the same keys (an undefined value is no key), the same
 * prototypes, the same types (a Buffer is not a bare Uint8Array) and the
 * same values, all the way down. Anything else, NaN included, is not the
 * same, and the store then validates the compact copy (compactOrSame).
 */
export function sameCompactShape(a, b) {
  if (a === b) return true;
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (a instanceof Uint8Array || b instanceof Uint8Array) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!sameCompactShape(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !sameCompactShape(a[k], b[k])) return false;
    return true;
  }
  return false;
}
import { bookSealKeyFor } from './book_seal_key.js';
import { ensureDatadir } from './datadir_acl.js';
import { acquireDatadirLock } from './datadir_lock.js';
import { chainStateError } from './process_guard.js';

/** R28: carry the records a load derived onto the loaded blocks (both load paths). */
function attachLoadedRecords(list, records) {
  if (!Array.isArray(records)) return;
  for (let i = 0; i < list.length && i < records.length; i += 1) {
    if (records[i]) list[i].blunoteRecord = records[i];
  }
}

function throwBookFault(message) {
  const msg = String(message || '');
  let code = '';
  if (msg.startsWith('datadir_magic')) code = 'datadir_magic';
  else if (msg.startsWith('spent_checkpoint')) code = 'spent_checkpoint';
  else if (msg.startsWith('supply_state')) code = 'supply_state';
  else if (msg.startsWith('chain_state')) code = 'chain_state';
  else if (msg.startsWith('book_seal')) code = 'book_seal';
  if (!code) throw new Error(msg);
  throw chainStateError(msg, code);
}
import { emptySupplyState, foldSupply, supplyFromScalar, fillSnapInterest, supplyLinks, supplyStep, publishedSupply, vaultParent, vaultAfterBlock } from './supply.js';
import { hashHeaderOffLoop } from '../../crypto/hash_offloop.js';
import {
  verifyShareBatch,
  paidWorkKeys,
  stashSharePow,
  hasLiveSharePow,
  sharePowCounters,
} from '../../crypto/share_batch.js';
import { advanceHashOwed, freshCreditsFromShares, replayHashOwed, unpackHashCreditBytes } from '../../crypto/hash_owed.js';
import { unpackShareBatchBytes } from '../../crypto/pack.js';
import { decodeHeader } from '../../crypto/header.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { isDestAddress } from '../../crypto/address.js';
import { compactChainBlock, compactTx } from '../../crypto/chronoflux.js';
import { publicExplorerRow } from '../../crypto/dummy.js';
import { reviveBytes, reviveTx, noteCommitOfDest20 } from '../../crypto/note.js';
import { hash20FromAddress } from '../../crypto/address.js';
import { createNoteLedger } from './note_ledger.js';
import { rememberStoredJob } from './job_cap.js';
import { bLeafId, bindBSpend, canonicalBLeaf, bLeafAskRejected } from '../../crypto/clearing.js';
import { setNonce } from '../../crypto/header.js';
import { requiredJobFields } from '../../crypto/header.js';
import { emptyVault, cloneVault, applyReserveBlock, unitsAlongChain, verifyReservePayout, portalPrincipalNanos, trialReserveApply, txIsReserveAction, RESERVE_ACTION_CAP, coinbaseRewardRoot, txRetireDleqs, retireCapHit, leafVoteLeakRejected, compactLockLeakRejected, withdrawLeakRejected, commitVaultLockRoot } from '../../crypto/reserve_vault.js';
import {
  vaultCommitment,
  makeVaultSeal,
  chainHasSealAncestry,
  reorgBreaksVaultSeal,
  vaultSealBanner,
} from '../../crypto/vault_seal.js';
import { explorerSpendable } from '../../crypto/chronoflux.js';
import { fundedDebit, reconcileSpendable, mempoolDebitNanos, flowSendNeedsOpen, verifyDestOpening, verifySpendSig, reserveAuth, typedCommitRejected, typedCommitSum, boundReserveWithdraw, reserveWithdrawMintId, spendPackDigest, verifyPoolWithdrawBound, paintedSpendSig, unsignedRefusedSpend, v12KindRejected, userCoinbaseRejected, explicitTypedKindRejected, typedClockRejected, openingBeforeCarry, unsignedBodyField, feeFieldRejected, bSpendFeeRejected } from '../../crypto/spend.js';
import { valueOpenRejected, bSpendVinRejected } from '../../crypto/chronoflux.js';
import { checkAdmitAnchor, typedKindNeedsAdmitV3, verifyFlowAdmitV3, verifyTypedAdmitFunding, v12FlowVersionRejected } from '../../crypto/admit_v3.js';
import { chainStage0Rejected, v3BucketProofRejected } from '../../crypto/fs1_send_gate.js';
import { txNoteRuleRejected } from '../../crypto/n1.js';
import { rememberFundVerdict, readFundVerdict } from '../../crypto/fund_verdict.js';
import { createVorticeCatalog } from './vortice.js';
import {
  writeChainBin,
  readChainBin,
  packEpochBlock,
  appendChainBin,
  chainRecordIndex,
  spliceChainRecordAt,
  readChainSegments,
  writeChainSegments,
  replaceSegmentRecord,
  segmentFileName,
  segmentRecordBodies,
  CHAIN_SEGMENT_BLOCKS,
  unpackEpochBlock,
} from '../../crypto/chainbin.js';
import {
  writeLatestBootstrap,
  shouldPublishBootstrap,
  latestPaths,
  reorgBreaksCheckpoint,
  bootstrapCheckpoint,
  CHECKPOINT_FIRST_HEIGHT,
  CHECKPOINT_EVERY_BLOCKS,
} from './bootstrap.js';
import { createBurialHold, createBurialProof, settledHeight } from './burial_hold.js';
import { blockWeight, custodialPullRejected } from '../../crypto/levy.js';
import { admitMempool, emptyMempool, rememberMempoolTag, retargetMempool, txBodyKey, heldBodyKey, keepHeldKey, sealedFormOf } from '../../crypto/mempool.js';
import { fluxsetFromBlocks, applyBlockToFluxset, appendFluxBlock, emptyFluxset, fluxWithLeaves, receiptAdmitRejected } from '../../crypto/admit.js';
import {
  frameDigest,
  legacyFrameDigest,
  stableDigest,
  STABLE_DIGEST_DOMAIN,
  blockFrameTag,
  stableBlockTag,
  unprunedBodyTag,
  diskDigestFromSegments,
  readBookSnap,
  writeBookSnap,
  writeAtomicFile,
} from './book_snap.js';

/** Full book.snap rewrite cadence after the opening window. Short books snap every block. */
export const BOOK_SNAP_EVERY = 32;
import { flowNeedsDummy, publicReserveReceiptRejected } from '../../crypto/dummy.js';
import { performance } from 'node:perf_hooks';
import { asU8, flowInputsBound, unboundMembershipCarry, txSpendTags, canonicalSpendTag, txIoCap } from '../../crypto/note.js';
import { txBudget, selectBodyIndexes, TEMPLATE_BUDGET_MS, W_PAYEE, payeeCapLive } from '../../crypto/block_budget.js';
import { blockWork, HEADER_AHEAD_MS } from '../../crypto/asert.js';
import {
  emptyPolicyState,
  recordReorg,
  applySignals,
  getpolicy as policyView,
  hashRatioFromHours,
  hourlyWorkBuckets,
} from '../../crypto/confirm_policy.js';

function toRow(block) {
  const compact = compactChainBlock(block);
  return {
    ...compact,
    header: Buffer.from(block.header).toString('hex'),
    hash: Buffer.from(block.hash).toString('hex'),
  };
}

function hex32(h) {
  if (Buffer.isBuffer(h)) return h.toString('hex');
  return String(h || '');
}

function workOfBlock(block) {
  try {
    return blockWork(decodeHeader(Buffer.from(block.header)).bits);
  } catch {
    return 0;
  }
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i += 1) {
    if (!Buffer.from(a[i].hash).equals(Buffer.from(b[i].hash))) break;
  }
  return i;
}

/** The label a tx's sender picked. Reported, never a key: see txBodyKey. */
function txIdOf(tx) {
  return String(tx?.id || '');
}

/** A vin's prev as its 32 bytes, from a Buffer, hex (with or without 0x) or {$hex}; null otherwise. */
function prevBytes(prev) {
  if (prev == null || prev === '') return null;
  let raw = prev;
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw) && !(raw instanceof Uint8Array) && typeof raw.$hex === 'string') raw = raw.$hex;
  if (typeof raw === 'string') {
    const hex = raw.trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
    return Buffer.from(hex, 'hex');
  }
  try {
    const b = Buffer.from(asU8(raw));
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/** A real outpoint a vin names, as one canonical key. An FS-1 vin names none (it is a C~ only). */
function vinOutpoint(vin) {
  const prev = prevBytes(vin?.prev);
  const index = Number(vin?.index);
  if (!prev || vin?.index == null || vin.index === '' || !Number.isSafeInteger(index) || index < 0) return '';
  return `out:${prev.toString('hex')}:${index}`;
}

/**
 * The notes `tx` spends, one canonical key each: `out:` a real outpoint
 * (vinOutpoint), `tag:` a spend tag (an FS-1 input's nullifier). Two
 * separate FS-1 vins never share a key; the same note does however its
 * bytes are held.
 */
export function spentNoteKeys(tx) {
  const keys = new Set();
  for (const tag of txSpendTags(tx).tags) keys.add(`tag:${tag.toString('hex')}`);
  for (const vin of tx?.vin || []) {
    const out = vinOutpoint(vin);
    if (out) keys.add(out);
  }
  return keys;
}

/**
 * What a reorg's winning blocks spend (spentNoteKeys of their txs). The
 * returned test is true when `tx` spends one of those notes.
 */
export function winnerSpends(connected) {
  const spent = new Set();
  for (const b of connected || []) {
    for (const tx of (b?.txs || []).slice(1)) {
      for (const k of spentNoteKeys(tx)) spent.add(k);
    }
  }
  return (tx) => [...spentNoteKeys(tx)].some((k) => spent.has(k));
}

/** True when `tx` spends a note `held` spends: a shared spend tag or outpoint. */
function spendsHeldNote(held, tx) {
  const keys = spentNoteKeys(held);
  return [...spentNoteKeys(tx)].some((k) => keys.has(k));
}

function spendLeafOf(tx) {
  return canonicalBLeaf(tx);
}

// Ids the block's own b-spend txs name. No merkle verify. Null fails closed.
function deriveSpendIds(block) {
  const ids = [];
  const seen = new Set();
  for (const tx of block?.txs || []) {
    if (!tx || tx.kind !== 'b-spend') continue;
    const leaf = spendLeafOf(tx);
    if (!leaf) return null;
    let id;
    try {
      id = bLeafId(leaf, Number(tx.commitHeight || 0), Number(tx.index || 0));
    } catch {
      return null;
    }
    if (!id || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// Trailer is a checksum of those ids. Peer blocks never arrive through it.
function matchedSpendIds(block) {
  const derived = deriveSpendIds(block);
  if (derived == null) return { ok: false, reason: 'spent_checkpoint_mismatch' };
  const stamped = Array.isArray(block?.bSpendIds);
  if (!stamped) {
    if (derived.length > 0) return { ok: false, reason: 'spent_checkpoint_missing' };
    return { ok: true, ids: [] };
  }
  const keys = [];
  for (const id of block.bSpendIds) {
    const key = String(id ?? '');
    if (!key) return { ok: false, reason: 'spent_checkpoint_missing' };
    keys.push(key);
  }
  if (derived.length > 0 && keys.length === 0) return { ok: false, reason: 'spent_checkpoint_missing' };
  if (keys.length !== derived.length) return { ok: false, reason: 'spent_checkpoint_mismatch' };
  const want = new Set(derived);
  for (const key of keys) {
    if (!want.has(key)) return { ok: false, reason: 'spent_checkpoint_mismatch' };
  }
  return { ok: true, ids: derived.slice() };
}

function potIdsOf(block) {
  const hid = hex32(block.hash);
  const ids = [];
  const cb = (block.txs || [])[0];
  if (cb?.coinbase && Array.isArray(cb.vout)) {
    for (const o of cb.vout) {
      if (o.kind === 'hash' || o.kind === 'finder-fee' || o.kind === 'reserve-fee') continue;
      ids.push(`${hid}-${o.kind || 'cb'}`);
    }
  }
  return ids;
}

/** Windows can refuse the replace while a scanner still holds the new file. */
function replaceFileSync(tmp, dest) {
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      last = err;
      const code = err && err.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
  throw last;
}

/** Wallet-readable tip. Stop saves this height; Start reads it and syncs forward. */
export function writeTipFile(dir, tip) {
  const height = Math.max(0, Math.floor(Number(tip?.height || 0)));
  let hash = '';
  if (tip?.hash != null && tip.hash !== '') {
    hash = Buffer.isBuffer(tip.hash) || tip.hash instanceof Uint8Array
      ? Buffer.from(tip.hash).toString('hex')
      : String(tip.hash);
  }
  const tipPath = path.join(dir, 'tip.json');
  const tmp = `${tipPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ height, hash })}\n`);
  replaceFileSync(tmp, tipPath);
  return { height, hash };
}

/** Header of the block before the parent. The chain's last row is the parent. */
function grandparentHeader(chain) {
  if (!Array.isArray(chain) || chain.length < 2) return null;
  return chain[chain.length - 2]?.header || null;
}

const loadResumeToken = Symbol('shear-load-resume');

/** Fault injection is for node:test and regtest books. A production store ignores it. */
function faultHooksOpen(magic) {
  if (String(magic || '') === MAGIC_REGTEST) return true;
  const ctx = String(process.env.NODE_TEST_CONTEXT || '');
  return ctx === 'child' || ctx === 'child-v8';
}
/** Open-round rows are a format-checked advertisement, not a proof. */
export const OPEN_ROUND_CAP = 1024;
/** Distinct tags one peer address may land in the open-round map. */
export const OPEN_ROUND_PEER_TAGS = 64;
/** Updates one peer address may land per window. The rest are dropped. */
export const OPEN_ROUND_PEER_RATE = 64;
export const OPEN_ROUND_PEER_WINDOW_MS = 30_000;
const OPEN_ROUND_PEER_BUDGETS = 4096;

/** Two headers pages per peer. A pruned block needs SAMPLE_PRUNE_CONFIRMATIONS of them. */
export const OFFER_PEER_CAP = 4000;
export const OFFER_PEER_SLOTS = 8;
export const PROVEN_HEADER_CAP = 6000;
export const OFFER_DROP_MS = 10 * 60_000;
/** Rows an inbound or outbound slot may hand the cheap check at once, and its refill. */
export const OFFER_RATE_BURST = 4000;
export const OFFER_RATE_PER_SEC = 2000;
const OFFER_DROPPED_CAP = 1024;
const LOCAL_HEADER_INDEX = 4096;
const PROOF_HASH_BATCH = 16;

/** JSON with sorted object keys, so a digest does not depend on key order. */
function canonicalJson(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  const out = JSON.stringify(value);
  return out === undefined ? 'null' : out;
}

export function createStore(dir, {
  pruneAfter = SAMPLE_PRUNE_CONFIRMATIONS,
  reorgHaltDepth = Number(process.env.SHEAR_REORG_HALT_DEPTH || 0),
  fastSync = String(process.env.SHEAR_FAST_SYNC || '').trim() === '1',
  firstCheckpoint = CHECKPOINT_FIRST_HEIGHT,
  checkpointEvery = CHECKPOINT_EVERY_BLOCKS,
  genesisHash = V12_GENESIS_BLOCK_HASH,
  checkpoint = V12_BOOTSTRAP_CHECKPOINT,
  loadNowMs = null,
  yieldForeign = false,
  onLoadProgress = null,
  network = process.env.SHEAR_NETWORK || MAGIC_TESTNET,
  oracleActivationHeight = undefined,
  magic: magicIn = null,
  regtestPermit = null,
  snapEvery = BOOK_SNAP_EVERY,
  // In-memory suites still verify and append. They do not rewrite the book,
  // the vault file, or the load seal on every block.
  diskJournal = true,
  lock = true,
  // Ignored unless this process is node:test or the book is regtest.
  bookFault = null,
} = {}, resume = null) {
  // shear-regtest is not a public book. A genesis pin (the v12 hash, or any
  // caller pin) refuses it outright. An unpinned open still needs the permit
  // that only node/tests/regtest_store.js can seal. Env vars do not.
  // magic wins when a caller sets it. network stays the node and datadir path.
  // The check runs before the datadir is created or locked down, so a refused
  // regtest open does not touch the directory.
  const journalDisk = diskJournal !== false;
  const configuredMagic = String(magicIn || network || MAGIC_TESTNET);
  const faultHooks = faultHooksOpen(configuredMagic);
  const injectedFault = faultHooks ? (bookFault || null) : null;
  if (configuredMagic === MAGIC_REGTEST) {
    const genesisPin = String(genesisHash || '');
    if (genesisPin) throw new Error('regtest_genesis_pin');
    if (!regtestPermitOk(regtestPermit)) throw new Error('regtest_magic');
  }
  ensureDatadir(dir);
  if (lock !== false) acquireDatadirLock(dir);
  const file = path.join(dir, 'chain.jsonl');
  const binFile = path.join(dir, 'chain.bin');
  const segDir = path.join(dir, 'segments');
  let segmented = false;
  const explorerFile = path.join(dir, 'explorer.jsonl');
  const vaultFile = path.join(dir, 'reserve.json');
  const magicFile = path.join(dir, 'book.magic');
  const sealFile = path.join(dir, 'book.seal');
  const snapFile = path.join(dir, 'book.snap');
  const vaultSnapFile = path.join(dir, 'vault.snap');
  const blocks = [];
  // Our chain by hash for locateFork and ingest; see chain_index.js.
  const chainIndex = emptyChainIndex();
  const explorer = [];
  const spentB = new Set();
  const headers = new Map();
  const forks = new Map();
  const listeners = { reorg: [], credits_frozen: [], tip: [] };
  const reorgs = [];
  let policyState = emptyPolicyState();
  const pause = { poolWithdraw: false };
  const haltDepth = Math.max(0, Math.floor(Number(reorgHaltDepth) || 0));
  const archiveFast = !!fastSync;
  const sealFirst = Math.max(1, Math.floor(Number(firstCheckpoint) || CHECKPOINT_FIRST_HEIGHT));
  const sealEvery = Math.max(1, Math.floor(Number(checkpointEvery) || CHECKPOINT_EVERY_BLOCKS));
  const checkpointOpts = { first: sealFirst, every: sealEvery };
  let evmSession = null;
  let vaultSeal = null;
  let owedRows = [];
  let acceptedSeries = [];
  let owedSeriesAll = acceptedSeries;
  let owedCkpt = [];
  let vaultCkpt = [];
  let seedCache = null;
  const owedSeed = {
    forkAdvances: 0,
    forkGenesis: 0,
    cached: 0,
    suffixAdvances: 0,
    loadBlocks: 0,
    refused: 0,
  };
  // A legacy snap has no checkpoint trailer. Back-fill once, then rewrite
  // the snap so the next start does not replay the prefix again.
  let snapRewrite = false;
  let unitAt = [];
  let supplyTip = null;
  let supplyAt = [];
  let anchorAt = [];
  let loadMode = 'empty';
  let preFlux = null;
  let prefixHeight = 0;
  let segLive = [];
  let unprunedLive = null;
  let snapVaultRaw = null;
  // Body digest the accepted book.snap bound for reserve.json (exact snap only).
  let snapVaultBind = '';
  let frameTags = [];
  let frameStream = null;
  let frameAt = 0;
  let frameCkpt = [];
  let stableTags = [];
  let stableStream = null;
  let stableAt = 0;
  let stableCkpt = [];
  let sealStream = null;
  let sealAt = 0;
  // Archive copies of pruned bodies, on disk only, until the reorg floor settles them.
  const burialHold = createBurialHold({ dir, write: !archiveFast, checkpoints: checkpointOpts });

  const segLoaded = readChainSegments(segDir);
  if (segLoaded) {
    segmented = true;
    for (const b of segLoaded) blocks.push(b);
  } else if (fs.existsSync(binFile)) {
    for (const b of readChainBin(binFile)) {
      blocks.push(b);
    }
  } else if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const b = JSON.parse(line, reviveBytes);
      if (!b || !b.header) continue;
      b.header = Buffer.from(b.header, 'hex');
      b.hash = Buffer.from(b.hash, 'hex');
      if (typeof b.hashCreditPacked === 'string' && b.hashCreditPacked) {
        const credits = unpackHashCreditBytes(Buffer.from(b.hashCreditPacked, 'hex'));
        if (credits) b.hashCredits = credits;
      }
      if (typeof b.hashSpillPacked === 'string' && b.hashSpillPacked) {
        const spill = unpackShareBatchBytes(Buffer.from(b.hashSpillPacked, 'hex'));
        if (Array.isArray(spill)) b.hashSpill = spill;
      }
      if (typeof b.hashSpillCreditPacked === 'string' && b.hashSpillCreditPacked) {
        const spillCredits = unpackHashCreditBytes(Buffer.from(b.hashSpillCreditPacked, 'hex'));
        if (spillCredits) b.hashSpillCredits = spillCredits;
      }
      blocks.push(b);
    }
  }
  burialHold.load(Number(blocks[blocks.length - 1]?.height) || blocks.length);
  const fileMagic = fs.existsSync(magicFile) ? fs.readFileSync(magicFile, 'utf8').trim() : '';
  let chainMagic = '';
  for (const row of blocks) {
    const stamped = String(row?.magic || '').trim();
    if (!stamped) continue;
    if (!chainMagic) chainMagic = stamped;
    else if (stamped !== chainMagic) throwBookFault(`datadir_magic:${stamped}`);
  }
  if (fileMagic && chainMagic && fileMagic !== chainMagic) throwBookFault(`datadir_magic:${fileMagic}`);
  const book = fileMagic || chainMagic;
  if (book && configuredMagic && book !== configuredMagic) throwBookFault(`datadir_magic:${book}`);
  // One network for this book. The datadir check, the fingerprint, the
  // book.magic writes, and every block stamp below all use bookMagic.
  const bookMagic = book || configuredMagic;
  // book.seal skips the header ShearHash when it matches this install's key.
  // book.snap skips the body prefix only when that same key verifies it and
  // the snap binds this chain. A miss replays. A foreign book never uses it.
  const sealKey = bookSealKeyFor(dir);
  loadSegLive();
  const burialProof = createBurialProof({ dir, key: sealKey, checkpoints: checkpointOpts });
  burialProof.load();
  loadMode = blocks.length ? 'full' : 'empty';
  const snapExpect = {
    rules: consensusFingerprint(bookMagic),
    genesisPin: String(genesisHash || ''),
    checkpoint,
  };
  function tipBuf(rows) {
    if (!rows.length) return Buffer.alloc(0);
    try { return Buffer.from(rows[rows.length - 1].hash); } catch { return Buffer.alloc(0); }
  }
  const resumed = !!(resume && resume.token === loadResumeToken && resume.verified === true
    && resume.height === blocks.length && tipBuf(blocks).equals(Buffer.from(resume.tipHash || [])));
  let trustStoredHash = false;
  if (blocks.length && !resumed) {
    const want = chainLoadSeal(blocks, sealKey, bookMagic);
    let got = '';
    if (fs.existsSync(sealFile)) {
      try { got = fs.readFileSync(sealFile, 'utf8').trim(); } catch { got = ''; }
    }
    trustStoredHash = got.length > 0 && got === want;
  }
  if (blocks.length) {
    const gated = chainStage0Rejected(blocks);
    if (gated) throw new Error(gated.reason);
    // N-1 runs inside verifyLoadedChain, after the header, the coinbase
    // cap, and the block budget. A matching bookseal2 seal may skip that
    // rescan. An in-process resume already checked.
  }
  if (blocks.length && !resumed) {
    const plan = trustStoredHash ? acceptBookSnap(readBookSnap(snapFile, sealKey, snapExpect)) : null;
    const planOk = plan && planSupplyLinks(plan);
    const snapRows = planOk ? supplyRowsFromPlan(plan) : null;
    if (snapRows && plan.height === blocks.length) {
      applySnap(plan, plan.height);
      installSupplyPlan(plan, snapRows);
      loadMode = 'snap';
    } else if (snapRows) {
      const priorFlux = fluxWithLeaves(plan.pubs, plan.commits, plan.spendTags, { trust: true });
      const checked = verifyLoadedChain(blocks, {
        trustStoredHash: true,
        nowMs: loadNowMs,
        genesisHash,
        checkpoint,
        reorgHaltDepth: haltDepth,
        burialOf: provenTipOf,
        fromIndex: plan.height,
        magic: bookMagic,
        oracleActivationHeight,
        prior: {
          owedRows: plan.owedRows,
          acceptedSeries: plan.acceptedSeries.slice(),
          spentIds: plan.spentIds,
          flux: priorFlux,
          supply: snapRows[plan.height - 1],
          supplyAt: snapRows,
          anchors: anchorsFromPlan(plan),
        },
      });
      if (!checked.ok) throwBookFault(checked.reason || 'pow');
      attachLoadedRecords(blocks, checked.records);
      if (!checked.supply) throwBookFault('supply_state');
      supplyTip = checked.supply;
      supplyAt = Array.isArray(checked.supplyAt) ? checked.supplyAt : [];
      anchorAt = Array.isArray(checked.anchors) ? checked.anchors : [];
      adoptPlanCheckpoints(plan);
      owedRows = checked.owedRows;
      acceptedSeries = checked.acceptedSeries.slice();
      owedSeriesAll = acceptedSeries;
      spentB.clear();
      for (const id of checked.spentIds) spentB.add(id);
      preFlux = checked.flux;
      unitAt = plan.unitAt.slice(0, plan.height);
      prefixHeight = plan.height;
      loadMode = 'suffix';
    } else if (yieldForeign) {
      const tipHash = tipBuf(blocks);
      const height = blocks.length;
      return verifyLoadedChainAsync(blocks, {
        trustStoredHash,
        nowMs: loadNowMs,
        genesisHash,
        checkpoint,
        reorgHaltDepth: haltDepth,
        burialOf: provenTipOf,
        onProgress: onLoadProgress,
        magic: bookMagic,
        oracleActivationHeight,
      }).then((checked) => {
        if (!checked.ok) throwBookFault(checked.reason || 'pow');
        // The reopen reads chain.bin again, so the records this verify
        // derived travel in the resume token (a book whose chain.bin lacks
        // them would otherwise reopen without them and fail hash_owed).
        return createStore(dir, {
          pruneAfter,
          reorgHaltDepth,
          fastSync,
          firstCheckpoint,
          checkpointEvery,
          genesisHash,
          checkpoint,
          loadNowMs,
          yieldForeign: false,
          onLoadProgress,
          network: bookMagic,
          oracleActivationHeight,
          magic: bookMagic,
          regtestPermit,
        }, {
          token: loadResumeToken,
          verified: true,
          height,
          tipHash,
          records: Array.isArray(checked.records) ? checked.records : null,
        });
      });
    } else {
      const checked = verifyLoadedChain(blocks, {
        trustStoredHash,
        nowMs: loadNowMs,
        genesisHash,
        checkpoint,
        reorgHaltDepth: haltDepth,
        burialOf: provenTipOf,
        magic: bookMagic,
        oracleActivationHeight,
      });
      if (!checked.ok) throwBookFault(checked.reason || 'pow');
      attachLoadedRecords(blocks, checked.records);
      if (!checked.supply) throwBookFault('supply_state');
      supplyTip = checked.supply;
      supplyAt = Array.isArray(checked.supplyAt) ? checked.supplyAt : [];
      anchorAt = Array.isArray(checked.anchors) ? checked.anchors : [];
      if (!trustStoredHash) writeLoadSeal(blocks);
    }
  } else if (resumed) {
    // The same blocks the async verify checked (height and tip matched above).
    attachLoadedRecords(blocks, resume.records);
    writeLoadSeal(blocks);
    const folded = foldSupply(blocks, { burialOf: provenTipOf, magic: bookMagic });
    if (!folded.ok) throw new Error(folded.reason || 'supply');
    supplyTip = folded.state;
  }
  if (blocks.length) noteBurial(Number(blocks[blocks.length - 1].height) || blocks.length);
  // Snap and a suffix prefix skip verifyBlock. The b-spend predicate still runs,
  // including the vin format check verifyBlock runs before bindBSpend.
  if ((loadMode === 'snap' || loadMode === 'suffix') && blocks.length) {
    for (const block of blocks) {
      const rows = Array.isArray(block?.txs) ? block.txs : [];
      for (const tx of rows) {
        const vinAdmit = bSpendVinRejected(tx);
        if (vinAdmit) throw new Error(vinAdmit.reason || 'vin_link');
        const spendFee = bSpendFeeRejected(tx);
        if (spendFee) throw new Error(spendFee.reason || 'fee');
      }
    }
    const sealedSpend = chainBSpendsRejected(blocks);
    if (sealedSpend) throw new Error(sealedSpend.reason || 'unsigned');
  }
  if (loadMode !== 'snap' && loadMode !== 'suffix') restoreSpentB();

  function segmentNames() {
    if (!segmented || !fs.existsSync(segDir)) return [];
    return fs.readdirSync(segDir)
      .filter((name) => /^seg-\d+\.bin$/.test(name))
      .sort((a, b) => Number(/^seg-(\d+)\.bin$/.exec(a)[1]) - Number(/^seg-(\d+)\.bin$/.exec(b)[1]));
  }

  function loadSegLive() {
    segLive = [];
    if (!segmented) return;
    for (const name of segmentNames()) {
      const buf = fs.readFileSync(path.join(segDir, name));
      segLive.push({ hash: createHash('sha256').update(buf), length: buf.length });
    }
  }

  function rememberSegmentBytes(idx, buf) {
    const chunk = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    while (segLive.length < idx) segLive.push({ hash: createHash('sha256'), length: 0 });
    if (!segLive[idx]) segLive[idx] = { hash: createHash('sha256'), length: 0 };
    segLive[idx].hash.update(chunk);
    segLive[idx].length += chunk.length;
  }

  function rehashSegmentFile(idx) {
    const file = path.join(segDir, segmentFileName(idx));
    if (!fs.existsSync(file)) return;
    const buf = fs.readFileSync(file);
    while (segLive.length < idx) segLive.push({ hash: createHash('sha256'), length: 0 });
    segLive[idx] = { hash: createHash('sha256').update(buf), length: buf.length };
  }

  function noteUnprunedBody(index, body) {
    if (!unprunedLive || !Buffer.isBuffer(body)) return;
    if (blocks[index]?.samplesPruned) unprunedLive.delete(index);
    else unprunedLive.set(index, unprunedBodyTag(body));
  }

  function scanUnprunedBodies() {
    const bodies = diskRecordBodies();
    if (!bodies) return null;
    const live = new Map();
    const n = Math.min(bodies.length, blocks.length);
    for (let i = 0; i < n; i += 1) {
      if (blocks[i]?.samplesPruned) continue;
      live.set(i, unprunedBodyTag(bodies[i]));
    }
    return live;
  }

  function unprunedBodiesForSnap() {
    if (!unprunedLive) {
      const built = scanUnprunedBodies();
      if (!built) return null;
      unprunedLive = built;
    }
    const rows = [];
    for (const [index, hash] of unprunedLive) {
      if (index < 0 || index >= blocks.length) continue;
      if (blocks[index]?.samplesPruned) continue;
      rows.push({ index, hash });
    }
    rows.sort((a, b) => a.index - b.index);
    return rows;
  }

  function chainDiskDigest() {
    if (segmented && segLive.length) {
      return diskDigestFromSegments(segLive.map((s) => ({
        length: s.length,
        contentHash: s.hash.copy().digest(),
      })));
    }
    return legacyDiskDigest();
  }

  /** bookdisk1. One full read, only when an older snap is opened. */
  function legacyDiskDigest() {
    const h = createHash('sha256');
    h.update('bookdisk1');
    if (segmented && fs.existsSync(segDir)) {
      for (const name of segmentNames()) {
        const buf = fs.readFileSync(path.join(segDir, name));
        const n = Buffer.alloc(4);
        n.writeUInt32LE(buf.length >>> 0, 0);
        h.update(n);
        h.update(buf);
      }
      return h.digest('hex');
    }
    const rawFile = fs.existsSync(binFile) ? binFile : (fs.existsSync(file) ? file : '');
    if (rawFile) {
      const buf = fs.readFileSync(rawFile);
      const n = Buffer.alloc(4);
      n.writeUInt32LE(buf.length >>> 0, 0);
      h.update(n);
      h.update(buf);
    }
    return h.digest('hex');
  }

  function diskDigestMatches(snap) {
    if (!snap?.diskDigest) return false;
    if (snap.diskDigest === chainDiskDigest()) return true;
    return snap.diskDigest === legacyDiskDigest();
  }

  // A snap boot installs reserve.json or vault.snap without a replay, so the
  // snap binds every field of that body. vaultCommitment() covers only the seal
  // fields (pot, stakes, epoch pins). mintedIds, votes, freezes, tranches, and
  // the reward book sit outside it and must not ride in unbound.
  function vaultBodyDigest(raw) {
    if (!raw || typeof raw !== 'object' || !raw.portals) return '';
    const body = { ...raw };
    delete body.vaultSeal;
    delete body.blankFork;
    return createHash('sha256').update('shear-vault-body-v1').update(canonicalJson(body)).digest('hex');
  }

  function vaultBindFromFile() {
    if (!fs.existsSync(vaultFile)) return '';
    try {
      return vaultBodyDigest(JSON.parse(fs.readFileSync(vaultFile, 'utf8')));
    } catch {
      return '';
    }
  }

  function writeVaultSnap(height) {
    if (!fs.existsSync(vaultFile)) return;
    const body = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
    if (!body || typeof body !== 'object' || !body.portals) return;
    delete body.vaultSeal;
    delete body.blankFork;
    writeAtomicFile(vaultSnapFile, Buffer.from(JSON.stringify({ height, body })));
  }

  function readVaultSnap() {
    try {
      if (!fs.existsSync(vaultSnapFile)) return null;
      const raw = JSON.parse(fs.readFileSync(vaultSnapFile, 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      if (raw.body && raw.body.portals) {
        delete raw.body.vaultSeal;
        delete raw.body.blankFork;
        return { height: Number(raw.height) || 0, body: raw.body };
      }
      if (raw.portals) {
        delete raw.vaultSeal;
        delete raw.blankFork;
        return { height: 0, body: raw };
      }
      return null;
    } catch {
      return null;
    }
  }

  function prefixFrameOk(snap) {
    const prefix = blocks.slice(0, snap.height);
    try {
      if (frameDigest(prefix) === snap.frameDigest) return true;
    } catch { /* try the previous domain */ }
    try {
      return legacyFrameDigest(prefix) === snap.frameDigest;
    } catch {
      return false;
    }
  }

  function diskRecordBodies() {
    if (segmented) {
      const names = segmentNames();
      const bodies = [];
      for (let s = 0; s < names.length; s += 1) {
        const id = /^seg-(\d+)\.bin$/.exec(names[s]);
        if (!id || Number(id[1]) !== s) return null;
        const got = segmentRecordBodies(path.join(segDir, names[s]));
        if (!got) return null;
        bodies.push(...got);
      }
      return bodies;
    }
    if (fs.existsSync(binFile)) return segmentRecordBodies(binFile);
    return null;
  }

  function unprunedDiskOk(snap) {
    const tags = snap?.unprunedBodies;
    if (!Array.isArray(tags)) return false;
    const bodies = diskRecordBodies();
    if (!bodies) return false;
    const want = new Map();
    for (const row of tags) {
      const index = Number(row?.index);
      const hash = row?.hash;
      if (!Number.isInteger(index) || index < 0 || want.has(index)) return false;
      if (!Buffer.isBuffer(hash) || hash.length !== 32) return false;
      want.set(index, hash);
    }
    for (let i = 0; i < snap.height; i += 1) {
      if (blocks[i]?.samplesPruned) continue;
      const expected = want.get(i);
      const body = bodies[i];
      if (!expected || !body || !expected.equals(unprunedBodyTag(body))) return false;
    }
    return true;
  }

  function vaultSnapBody(snap) {
    const saved = readVaultSnap();
    if (!saved || saved.height !== snap.height) return null;
    if (vaultBodyDigest(saved.body) !== snap.vaultCommitment) return null;
    return saved.body;
  }

  function acceptBookSnap(snap) {
    if (!snap || snap.height < 1 || snap.height > blocks.length) return null;
    let tipHash;
    try { tipHash = Buffer.from(blocks[snap.height - 1].hash); } catch { return null; }
    if (tipHash.length !== 32 || !tipHash.equals(snap.tipHash)) return null;
    const gms = genesisHeaderMs(blocks);
    if (!gms || gms !== snap.genesisMs) return null;
    // vault.snap is written after book.snap. A crash between them, or a
    // lagged snap whose vault file does not match, replays. reserve.json
    // is not a substitute for that file.
    const vaultBody = vaultSnapBody(snap);
    if (!vaultBody) return null;
    snapVaultRaw = vaultBody;
    const vaultNow = vaultBindFromFile();
    if (snap.height === blocks.length) {
      if (!diskDigestMatches(snap)) return null;
      if (!vaultNow || vaultNow !== snap.vaultCommitment) return null;
      snapVaultBind = vaultNow;
      return snap;
    }
    const prefix = blocks.slice(0, snap.height);
    let stableOk = false;
    if (snap.stableDigest) {
      try { stableOk = stableDigest(prefix) === snap.stableDigest; } catch { stableOk = false; }
    }
    const listed = Array.isArray(snap.unprunedBodies);
    const bodiesOk = listed && unprunedDiskOk(snap);
    // Stable tags omit samples. Unpruned share bytes are the raw record tags.
    // A snap that lists those tags cannot skip a mismatch via the frame digest.
    if (stableOk && bodiesOk) return snap;
    if (prefixFrameOk(snap) && (!listed || bodiesOk)) return snap;
    return null;
  }

  function adoptPlanCheckpoints(plan) {
    if (!Array.isArray(plan?.owedCheckpoints)) {
      owedCkpt = [];
      return;
    }
    owedCkpt = plan.owedCheckpoints.map((c) => ({
      at: Number(c.at),
      seriesEnd: Number(c.seriesEnd),
      rows: c.rows,
    }));
  }

  function applySnap(plan, height) {
    owedRows = plan.owedRows;
    acceptedSeries = plan.acceptedSeries.slice();
    owedSeriesAll = acceptedSeries;
    adoptPlanCheckpoints(plan);
    spentB.clear();
    for (const id of plan.spentIds) spentB.add(String(id));
    preFlux = fluxWithLeaves(plan.pubs, plan.commits, plan.spendTags, { trust: true });
    unitAt = plan.unitAt.slice();
    prefixHeight = height;
  }

  function on(ev, fn) {
    if (!listeners[ev]) listeners[ev] = [];
    listeners[ev].push(fn);
    return () => {
      listeners[ev] = (listeners[ev] || []).filter((x) => x !== fn);
    };
  }

  function emit(ev, payload) {
    for (const fn of listeners[ev] || []) {
      try { fn(payload); } catch { /* keep */ }
    }
  }

  function rememberHeaders(chain, status) {
    if (!Array.isArray(chain)) return;
    for (const b of chain) {
      let prev = '';
      try {
        prev = Buffer.from(decodeHeader(Buffer.from(b.header)).prevBlockHash).toString('hex');
      } catch { prev = ''; }
      const h = hex32(b.hash);
      headers.set(h, {
        hash: h,
        height: Number(b.height || 0),
        work: workOfBlock(b),
        status,
        prev,
      });
    }
  }

  function rememberFork(chain, status) {
    if (!Array.isArray(chain) || !chain.length) return;
    rememberHeaders(chain, status);
    const tipB = chain[chain.length - 1];
    forks.set(hex32(tipB.hash), { blocks: chain.slice(), work: chainWorkOf(chain), status });
  }

  function writeExplorer() {
    const body = explorer.map((r) => JSON.stringify(publicExplorerRow(r))).join('\n');
    fs.writeFileSync(explorerFile, body ? `${body}\n` : '');
  }

  function rebuildExplorer() {
    explorer.length = 0;
    for (const b of blocks) explorer.push(...sealedExplorerRows(b));
    writeExplorer();
    rebuildHist();
    noteLedger.sync(blocks);
  }

  function indexSealed(block) {
    const rows = sealedExplorerRows(block);
    explorer.push(...rows);
    for (const r of rows) addHist(r);
    histN = explorer.length;
    histAnchor = explorer.length ? explorer[explorer.length - 1] : null;
    if (rows.length) {
      fs.appendFileSync(explorerFile, `${rows.map((r) => JSON.stringify(publicExplorerRow(r))).join('\n')}\n`);
    }
    return rows;
  }

  function loadExplorer() {
    if (fs.existsSync(explorerFile)) {
      try {
        for (const line of fs.readFileSync(explorerFile, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          explorer.push(JSON.parse(line, reviveBytes));
        }
        if (explorer.length) return;
      } catch {
        explorer.length = 0;
      }
    }
    rebuildExplorer();
  }

  const histTo = new Map();
  const histFrom = new Map();
  const histNc = new Map();
  const histD20 = new Map();
  let histN = 0;
  let histAnchor = null;
  let histQueryRows = 0;
  let histSyncRows = 0;
  let spendChecks = 0;
  let forkSpendChecks = 0;

  function histCommitHex(v) {
    try {
      const b = Buffer.from(asU8(v));
      return b.length === 32 ? b.toString('hex') : '';
    } catch {
      return '';
    }
  }

  function histDestHex(field) {
    if (!field) return '';
    try {
      const raw = field.data || field;
      const buf = Buffer.from(raw);
      return buf.length === 20 ? buf.toString('hex') : '';
    } catch {
      return '';
    }
  }

  function pushHist(map, key, row) {
    if (!key) return;
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(row);
  }

  function addHist(row) {
    if (!row || typeof row !== 'object') return;
    if (row.to) pushHist(histTo, String(row.to), row);
    if (row.from) pushHist(histFrom, String(row.from), row);
    const nc = histCommitHex(row.noteCommit);
    if (nc) pushHist(histNc, nc, row);
    const to20 = histDestHex(row.toDest20);
    const from20 = histDestHex(row.fromDest20);
    if (to20) pushHist(histD20, to20, row);
    if (from20) pushHist(histD20, from20, row);
  }

  function rebuildHist() {
    histTo.clear();
    histFrom.clear();
    histNc.clear();
    histD20.clear();
    for (const row of explorer) addHist(row);
    histN = explorer.length;
    histAnchor = explorer.length ? explorer[explorer.length - 1] : null;
  }

  function syncHist() {
    if (explorer.length < histN || (histN > 0 && explorer[histN - 1] !== histAnchor)) {
      const n = explorer.length;
      rebuildHist();
      histSyncRows += n;
      return;
    }
    for (let i = histN; i < explorer.length; i += 1) {
      addHist(explorer[i]);
      histSyncRows += 1;
    }
    histN = explorer.length;
    histAnchor = explorer.length ? explorer[explorer.length - 1] : null;
  }

  function histCandidates(addr, h20, wantNc) {
    const seen = new Set();
    const out = [];
    const take = (arr) => {
      for (const row of arr || []) {
        if (seen.has(row)) continue;
        seen.add(row);
        out.push(row);
      }
    };
    take(histTo.get(addr));
    take(histFrom.get(addr));
    if (h20) take(histD20.get(Buffer.from(h20).toString('hex')));
    if (wantNc) take(histNc.get(Buffer.from(wantNc).toString('hex')));
    histQueryRows += out.length;
    return out;
  }

  function digestsOf(block) {
    const out = [];
    for (const tx of (block?.txs || []).slice(1)) {
      if (flowSendNeedsOpen(tx)) out.push(spendPackDigest(tx).toString('hex'));
    }
    return out;
  }

  const noteLedger = createNoteLedger({ digestsOf });
  const chainLedgers = new WeakMap();

  function ledgerFor(chain) {
    const book = chain || blocks;
    if (book === blocks) return noteLedger;
    let led = chainLedgers.get(book);
    if (!led) {
      led = createNoteLedger({ digestsOf });
      chainLedgers.set(book, led);
    }
    return led;
  }

  function syncNoteLedger(chain = blocks) {
    return ledgerFor(chain).sync(chain);
  }

  loadExplorer();
  if (histN !== explorer.length || (histN > 0 && explorer[histN - 1] !== histAnchor)) rebuildHist();
  noteLedger.sync(blocks);
  rememberHeaders(blocks, 'active');

  let liveFlux = preFlux || fluxsetFromBlocks(blocks);
  function refreshFlux() {
    liveFlux = fluxsetFromBlocks(blocks);
  }

  const reserveVault = emptyVault();
  reserveVault.magic = bookMagic;

  function saveReserve() {
    if (!journalDisk) return;
    const raw = JSON.parse(JSON.stringify(reserveVault, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    delete raw.blankFork;
    delete raw.vaultSeal;
    if (vaultSeal) raw.vaultSeal = vaultSeal;
    fs.writeFileSync(vaultFile, JSON.stringify(raw));
  }

  function tipHasSealAncestry(chain = blocks, seal = vaultSeal) {
    if (!seal) return true;
    return chainHasSealAncestry(chain, seal);
  }

  function deriveVaultSeal(chain, vault) {
    const tipH = Number(chain.at(-1)?.height || 0);
    const cpH = bootstrapCheckpoint(tipH, sealFirst, sealEvery);
    if (cpH < sealFirst) return null;
    const b = chain.find((x) => Number(x.height) === cpH);
    if (!b) return null;
    return makeVaultSeal({
      height: cpH,
      hash: b.hash,
      commitment: vaultCommitment(vault),
      genesisHash: chain[0]?.hash,
    });
  }

  function refreshVaultSeal() {
    const next = deriveVaultSeal(blocks, reserveVault);
    if (!next) return vaultSeal;
    if (!vaultSeal) {
      vaultSeal = next;
      return vaultSeal;
    }
    if (chainHasSealAncestry(blocks, vaultSeal)) vaultSeal = next;
    return vaultSeal;
  }

  function syncBlankFlag() {
    reserveVault.blankFork = !!(vaultSeal && !tipHasSealAncestry());
  }

  function vaultSealView() {
    const ancestry = tipHasSealAncestry();
    const tipH = Number(tip()?.height || 0);
    return {
      height: vaultSeal ? Number(vaultSeal.height) : 0,
      hash: vaultSeal ? String(vaultSeal.hash || '') : '',
      commitment: vaultSeal ? String(vaultSeal.commitment || '') : '',
      genesisHash: vaultSeal ? String(vaultSeal.genesisHash || '') : '',
      ancestry,
      banner: vaultSealBanner({
        seal: vaultSeal,
        ancestry,
        tipHeight: tipH,
        first: sealFirst,
      }),
      blankFork: !ancestry,
    };
  }

  function payoutOnTip(tx, clockMs) {
    if (vaultSeal && !tipHasSealAncestry()) return { ok: false, reason: 'no_vault' };
    const given = Number(clockMs);
    const clock = Number.isFinite(given) && given > 0 ? given : (blockTimeMs(tip()) + 1);
    return verifyReservePayout(reserveVault, tx, clock);
  }

  function blockTimeMs(block) {
    try {
      return Number(decodeHeader(Buffer.from(block.header)).timestamp);
    } catch {
      return 0;
    }
  }

  /** Next header stamp. Mempool and template trial the vault at this time. */
  function headerStamp(nowMs) {
    const t = tip();
    const given = Number(nowMs);
    const wall = Number.isFinite(given) && given > 0 ? given : Date.now();
    if (!t?.header) return wall;
    try {
      const parent = decodeHeader(Buffer.from(t.header));
      const mtp = medianTimePast(blocks.slice(-MTP_WINDOW).map((b) => blockTimeMs(b)));
      return templateStampMs(parent.timestamp, wall, null, mtp);
    } catch {
      return wall;
    }
  }

  /** Canonical genesis header time. 0 when this list does not start at genesis. */
  function genesisHeaderMs(list) {
    const rows = Array.isArray(list) ? list : [];
    const g = rows.find((b) => Number(b?.height) === 1) || null;
    if (!g?.header) return 0;
    try {
      const decoded = decodeHeader(Buffer.from(g.header));
      if (!decoded.prevBlockHash.equals(GENESIS_PREV)) return 0;
      const ts = Number(decoded.timestamp);
      return Number.isFinite(ts) && ts > 0 ? ts : 0;
    } catch {
      return 0;
    }
  }

  function commitReserveApply(applied) {
    if (applied && applied.ok === false) throw new Error(applied.reason || 'epoch_open');
    return applied;
  }

  function bookVault() {
    const vault = emptyVault();
    vault.magic = bookMagic;
    if (oracleActivationHeight !== undefined) vault.oracleActivationHeight = oracleActivationHeight;
    return vault;
  }

  function unitsOnBook(spec) {
    const walked = { ...spec, magic: bookMagic };
    if (walked.activationHeight === undefined && oracleActivationHeight !== undefined) {
      walked.activationHeight = oracleActivationHeight;
    }
    return unitsAlongChain(walked);
  }

  function vaultArgs(state, block, prior) {
    const rows = Array.isArray(prior) ? prior : [];
    const parent = rows.length ? rows[rows.length - 1] : null;
    // The oracle window is a fixed block count. Mapping the whole prefix
    // on every apply made a side block cost grow with chain height.
    const cap = windowBlocksFor(bookMagic);
    const tail = rows.length > cap ? rows.slice(rows.length - cap) : rows;
    const fields = reserveApplyFields({
      prior: tail,
      block,
      magic: bookMagic,
      parentMs: parent ? blockTimeMs(parent) : 0,
      genesisMs: genesisHeaderMs(rows) || genesisHeaderMs(block ? [block] : []) || genesisHeaderMs(blocks),
      nowMs: blockTimeMs(block),
    });
    if (oracleActivationHeight !== undefined) fields.activationHeight = oracleActivationHeight;
    return { state, ...fields, requireStakeReward: true };
  }

  function oracleVerifyFields(prior, nextHeight) {
    const ctx = oracleContextFor(prior, { height: nextHeight }, bookMagic);
    return {
      oracleWindow: ctx.oracleWindow,
      oracleWindowSize: ctx.oracleWindowSize,
      oracleActivationHeight: oracleActivationHeight !== undefined
        ? oracleActivationHeight
        : ctx.activationHeight,
    };
  }

  function applyReserve(block) {
    commitReserveApply(applyReserveBlock(vaultArgs(reserveVault, block, blocks)));
    saveReserve();
  }

  function replayVault() {
    if (vaultSeal && blocks.length && !chainHasSealAncestry(blocks, vaultSeal)) {
      syncBlankFlag();
      saveReserve();
      return;
    }
    const fresh = bookVault();
    for (const k of Object.keys(reserveVault)) delete reserveVault[k];
    Object.assign(reserveVault, fresh);
    reserveVault.portals = Object.create(null);
    reserveVault.votes = { increase: 0, decrease: 0, hold: 0 };
    reserveVault.blankFork = false;
    unitAt = [];
    vaultCkpt = [];
    const tipAt = blocks.length - 1;
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      unitAt.push(hashBonusUnitNanos(reserveVault.liveHashBonusNanos));
      commitReserveApply(applyReserveBlock(vaultArgs(reserveVault, b, blocks.slice(0, i))));
      if (keepOwedIndex(i, tipAt)) vaultCkpt.push({ at: i, vault: cloneVault(reserveVault) });
    }
    refreshVaultSeal();
    syncBlankFlag();
    saveReserve();
  }

  function installVault(raw) {
    const coerced = cloneVault(raw);
    for (const k of Object.keys(reserveVault)) delete reserveVault[k];
    Object.assign(reserveVault, coerced);
    reserveVault.liveHashBonusNanos = hashBonusUnitNanos(reserveVault.liveHashBonusNanos);
  }

  function bootVault() {
    let loaded = null;
    if (fs.existsSync(vaultFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
        if (raw && typeof raw === 'object' && raw.portals) {
          if (raw.vaultSeal && raw.vaultSeal.hash) vaultSeal = raw.vaultSeal;
          delete raw.vaultSeal;
          delete raw.blankFork;
          loaded = raw;
        }
      } catch { /* rebuild from chain */ }
    }
    // An exact snap already committed this file. Replaying it would walk every block.
    if (loadMode === 'snap' && loaded && snapVaultBind && vaultBodyDigest(loaded) === snapVaultBind) {
      installVault(loaded);
      syncBlankFlag();
      return;
    }
    // A shorter snap committed the prefix vault. Apply only the unsealed suffix.
    // reserve.json may already be at the tip; vault.snap is the prefix vault.
    // The index is the prior height vaultArgs uses to pin the chain genesis.
    // acceptBookSnap sets snapVaultRaw for every suffix plan. reserve.json may be
    // at the tip, so it is never the prefix vault.
    if (loadMode === 'suffix' && snapVaultRaw) {
      installVault(snapVaultRaw);
      const suffix = blocks.slice(prefixHeight);
      for (let s = 0; s < suffix.length; s += 1) {
        const b = suffix[s];
        unitAt.push(hashBonusUnitNanos(reserveVault.liveHashBonusNanos));
        commitReserveApply(applyReserveBlock(vaultArgs(reserveVault, b, blocks.slice(0, prefixHeight + s))));
      }
      refreshVaultSeal();
      syncBlankFlag();
      saveReserve();
      return;
    }
    replayVault();
  }

  bootVault();
  syncOwed(blocks);
  ensureVaultCheckpoints();
  if (loadMode !== 'snap' || snapRewrite) persistBookSnap();
  writeTipFile(dir, blocks.length ? blocks[blocks.length - 1] : null);

  function destSpendableNanos(addr, tipH, chain = blocks, _rows = explorer) {
    void _rows;
    // A lock tranche is not a send input. The note walk omits lock outputs.
    // A hidden funding leaf can still sit in the walk, so subtract the vault
    // principal once. A hidden Vault lock does not cover that subtraction,
    // before or after unlock. A non-Vault lock that has passed its unlock
    // covers it, including after the output is spent. The tranche itself
    // stays out of this sum.
    // The live book and a fork book each keep their own suffix index.
    // A request does not open notes that belong to someone else.
    if (chain === blocks) spendChecks += 1;
    else forkSpendChecks += 1;
    syncNoteLedger(chain);
    const tipBlock = chain[Math.max(0, Math.min(chain.length, Math.floor(Number(tipH) || 0)) - 1)] || null;
    const tipMs = tipBlock ? blockTimeMs(tipBlock) : 0;
    const clock = {
      coinbaseOnly: false,
      tipMs,
      genesisMs: Number(reserveVault.genesisMs) || 0,
      magic: bookMagic,
    };
    const book = ledgerFor(chain);
    const noteNanos = book.spendable(addr, tipH, clock);
    const opened = reconcileSpendable([], addr, tipH, noteNanos);
    const principal = Math.max(0, Math.floor(Number(portalPrincipalNanos(reserveVault, addr)) || 0));
    const covered = Math.max(0, Math.floor(Number(book.coveredLockNanos(addr, tipH, clock)) || 0));
    const locked = Math.max(0, principal - covered);
    return Math.max(0, opened - locked);
  }

  const vortice = createVorticeCatalog(dir);

  function slimRow(block) {
    const hash = hex32(block?.hash);
    return JSON.stringify({ h: Number(block?.height) || 0, hash });
  }

  function writeSlimIndex() {
    const tmpJson = `${file}.tmp`;
    const body = blocks.map((b) => slimRow(b)).join('\n');
    fs.writeFileSync(tmpJson, body ? `${body}\n` : '');
    fs.renameSync(tmpJson, file);
  }

  function dropSegmentsFrom(keep) {
    if (!fs.existsSync(segDir)) return;
    for (const name of fs.readdirSync(segDir)) {
      const m = /^seg-(\d+)\.bin$/.exec(name);
      if (!m) continue;
      if (Number(m[1]) >= keep) fs.unlinkSync(path.join(segDir, name));
    }
  }

  function ensureSeal() {
    if (!sealStream || sealAt > blocks.length) {
      sealStream = chainLoadSealHash(sealKey, bookMagic);
      sealAt = 0;
    }
    while (sealAt < blocks.length) {
      chainLoadSealUpdate(sealStream, blocks[sealAt]);
      sealAt += 1;
    }
  }

  function writeLoadSeal(rows) {
    if (!journalDisk) return;
    if (rows !== blocks) {
      fs.writeFileSync(sealFile, `${chainLoadSeal(rows, sealKey, bookMagic)}\n`);
      return;
    }
    ensureSeal();
    fs.writeFileSync(sealFile, `${sealStream.copy().digest('hex')}\n`);
  }

  function resetFrameHash() {
    invalidateTags();
  }

  function invalidateTags() {
    frameTags = [];
    frameStream = null;
    frameAt = 0;
    frameCkpt = [];
    stableTags = [];
    stableStream = null;
    stableAt = 0;
    stableCkpt = [];
  }

  function resetSeal() {
    sealStream = null;
    sealAt = 0;
  }

  function tagCacheWarm() {
    return frameTags.length === blocks.length && stableTags.length === blocks.length;
  }

  function ensureTags() {
    while (frameTags.length < blocks.length) {
      const i = frameTags.length;
      frameTags.push(blockFrameTag(blocks[i]));
      stableTags.push(stableBlockTag(blocks[i]));
    }
    if (frameTags.length > blocks.length || stableTags.length > blocks.length) invalidateTags();
  }

  function foldTags(kind) {
    ensureTags();
    const frame = kind === 'frame';
    let stream = frame ? frameStream : stableStream;
    let at = frame ? frameAt : stableAt;
    let ckpt = frame ? frameCkpt : stableCkpt;
    const tags = frame ? frameTags : stableTags;
    const end = blocks.length;
    if (!stream || at > end) {
      stream = createHash('sha256');
      stream.update(frame ? 'bookframe2' : STABLE_DIGEST_DOMAIN);
      at = 0;
      for (let i = ckpt.length - 1; i >= 0; i -= 1) {
        if (ckpt[i].at <= end) {
          stream = ckpt[i].hash.copy();
          at = ckpt[i].at;
          break;
        }
      }
      ckpt = ckpt.filter((c) => c.at <= at);
    }
    while (at < end) {
      stream.update(tags[at]);
      at += 1;
      if (at % 64 === 0) ckpt.push({ at, hash: stream.copy() });
    }
    while (ckpt.length && ckpt[ckpt.length - 1].at > end) ckpt.pop();
    if (frame) {
      frameStream = stream;
      frameAt = at;
      frameCkpt = ckpt;
    } else {
      stableStream = stream;
      stableAt = at;
      stableCkpt = ckpt;
    }
    return stream.copy().digest('hex');
  }

  function noteAppendedBlock() {
    const i = blocks.length - 1;
    if (i < 0 || frameTags.length !== i) return;
    let nextFrame;
    let nextStable;
    try {
      nextFrame = blockFrameTag(blocks[i]);
      nextStable = stableBlockTag(blocks[i]);
    } catch {
      invalidateTags();
      return;
    }
    frameTags.push(nextFrame);
    stableTags.push(nextStable);
    if (frameStream && frameAt === i) {
      frameStream.update(frameTags[i]);
      frameAt += 1;
      if (frameAt % 64 === 0) frameCkpt.push({ at: frameAt, hash: frameStream.copy() });
    }
    if (stableStream && stableAt === i) {
      stableStream.update(stableTags[i]);
      stableAt += 1;
      if (stableAt % 64 === 0) stableCkpt.push({ at: stableAt, hash: stableStream.copy() });
    }
  }

  // Burial rewrites one block's packed body. A burial-hold lift that puts a
  // share batch back must call this too, so the frame and stable tags move
  // with the segment bytes.
  function noteReplacedBlock(index) {
    retag(index);
  }

  function retag(index) {
    if (!tagCacheWarm() || index < 0 || index >= blocks.length) return;
    let nextFrame;
    let nextStable;
    try {
      nextFrame = blockFrameTag(blocks[index]);
      nextStable = stableBlockTag(blocks[index]);
    } catch {
      invalidateTags();
      return;
    }
    const frameChanged = !frameTags[index].equals(nextFrame);
    const stableChanged = !stableTags[index].equals(nextStable);
    frameTags[index] = nextFrame;
    stableTags[index] = nextStable;
    if (frameChanged && frameAt > index) {
      frameStream = null;
      frameAt = 0;
      frameCkpt = frameCkpt.filter((c) => c.at <= index);
    }
    if (stableChanged && stableAt > index) {
      stableStream = null;
      stableAt = 0;
      stableCkpt = stableCkpt.filter((c) => c.at <= index);
    }
  }

  function frameDigestNow() {
    return foldTags('frame');
  }

  function stableDigestNow() {
    return foldTags('stable');
  }

  const snapGap = Math.floor(Number(snapEvery));
  function shouldSnap(height) {
    const h = Number(height) || 0;
    if (h < 1 || !Number.isInteger(snapGap) || snapGap <= 0) return false;
    if (h <= snapGap) return true;
    return h % snapGap === 0;
  }

  function maybeSnap(height) {
    if (shouldSnap(height)) persistBookSnap();
  }

  function supplySnapsForSnap() {
    if (supplyAt.length !== blocks.length) return undefined;
    const snaps = [];
    for (let i = 0; i < supplyAt.length; i += 1) {
      const s = supplyAt[i];
      if (!supplyLinks(s, blocks[i])) return undefined;
      snaps.push({
        height: s.height,
        blockHash: s.blockHash,
        schedulePot: s.schedulePot,
        carry: s.carry,
        mintedPot: s.mintedPot,
        mintedHash: s.mintedHash,
        mintedLevy: s.mintedLevy,
        bLocked: s.bLocked,
        permittedHashAll: s.permittedHashAll,
        acceptedHash: s.acceptedHash,
        dust: s.dust,
        overflow: s.overflow,
        liveUnit: s.liveUnit,
        genesisMs: s.genesisMs,
      });
    }
    return snaps;
  }

  function anchorWindowForSnap() {
    const tipH = blocks.length ? (Number(blocks[blocks.length - 1]?.height) || blocks.length) : 0;
    if (tipH < 1) return undefined;
    const window = [];
    for (let h = 1; h <= tipH; h += 1) {
      if (!keepsFrontier(h, tipH, haltDepth)) continue;
      const rec = anchorAt[h];
      if (!rec?.jroot || !rec.frontier?.length || !rec.zeroFrontier?.length) return undefined;
      window.push({
        height: h,
        n: rec.n,
        jroot: rec.jroot,
        frontier: rec.frontier,
        zeroFrontier: rec.zeroFrontier,
        zeroRoot: rec.zeroRoot || null,
      });
    }
    return window.length ? window : undefined;
  }

  // Small rows for every height. The frontier blobs stay in anchorWindow.
  function anchorRootsForSnap() {
    const tipH = blocks.length ? (Number(blocks[blocks.length - 1]?.height) || blocks.length) : 0;
    if (tipH < 1) return undefined;
    const roots = [];
    for (let h = 1; h <= tipH; h += 1) {
      const rec = anchorAt[h];
      if (!rec?.jroot || rec.jroot.length !== 32) return undefined;
      const n = Number(rec.n);
      if (!Number.isInteger(n) || n < 0) return undefined;
      const zr = rec.zeroRoot?.length === 32 ? rec.zeroRoot : rec.jroot;
      roots.push({
        height: h,
        n,
        jroot: Buffer.from(rec.jroot),
        zeroRoot: Buffer.from(zr),
      });
    }
    return roots;
  }

  function supplyRowsFromPlan(plan) {
    const rows = [];
    const series = Array.isArray(plan?.acceptedSeries) ? plan.acceptedSeries : [];
    const snaps = Array.isArray(plan?.supplySnaps) ? plan.supplySnaps : [];
    const byAt = new Map();
    for (const c of plan?.owedCheckpoints || []) byAt.set(Number(c.at), c);
    for (let i = 0; i < snaps.length; i += 1) {
      const tip = i === snaps.length - 1;
      const ck = byAt.get(i);
      const owedKnown = tip || !!ck;
      rows[i] = supplyFromScalar(snaps[i], {
        owedRows: owedKnown ? (tip ? plan.owedRows : ck.rows) : [],
        acceptedSeries: owedKnown ? series.slice(0, tip ? series.length : ck.seriesEnd) : [],
        owedKnown,
      });
    }
    if (!rows.length) return rows;
    const walked = fillSnapInterest(rows, blocks.slice(0, rows.length), { magic: bookMagic });
    if (!walked.ok) return null;
    return rows;
  }

  function installSupplyPlan(plan, rows = null) {
    const got = rows || supplyRowsFromPlan(plan);
    if (!got) return false;
    supplyAt = got;
    supplyTip = supplyAt[supplyAt.length - 1] || null;
    anchorAt = anchorsFromPlan(plan);
    const tipH = blocks.length ? (Number(blocks[blocks.length - 1]?.height) || blocks.length) : 0;
    retainFrontierBlobs(anchorAt, tipH, haltDepth);
    return true;
  }

  function anchorFromSnap(a) {
    const rec = { n: a.n, jroot: Buffer.from(a.jroot) };
    if (a.frontier?.length) rec.frontier = Buffer.from(a.frontier);
    if (a.zeroFrontier?.length) rec.zeroFrontier = Buffer.from(a.zeroFrontier);
    if (a.zeroRoot?.length === 32) rec.zeroRoot = Buffer.from(a.zeroRoot);
    return rec;
  }

  function anchorsFromPlan(plan) {
    const at = [];
    for (const a of plan?.anchorRoots || []) {
      const h = Number(a?.height);
      if (!Number.isInteger(h) || h < 1 || !a?.jroot) continue;
      at[h] = {
        n: a.n,
        jroot: Buffer.from(a.jroot),
        zeroRoot: a.zeroRoot?.length === 32 ? Buffer.from(a.zeroRoot) : null,
      };
    }
    for (const a of plan?.anchorWindow || []) {
      const h = Number(a?.height);
      if (!Number.isInteger(h) || h < 1) continue;
      const prev = at[h];
      const rec = prev || anchorFromSnap(a);
      if (a.frontier?.length) rec.frontier = Buffer.from(a.frontier);
      if (a.zeroFrontier?.length) rec.zeroFrontier = Buffer.from(a.zeroFrontier);
      if (!rec.zeroRoot && a.zeroRoot?.length === 32) rec.zeroRoot = Buffer.from(a.zeroRoot);
      if (!rec.jroot && a.jroot) rec.jroot = Buffer.from(a.jroot);
      at[h] = rec;
    }
    return at;
  }

  function anchorRootsCover(plan) {
    const roots = plan?.anchorRoots;
    if (!Array.isArray(roots) || roots.length !== plan.height) return false;
    for (let h = 1; h <= plan.height; h += 1) {
      const row = roots[h - 1];
      if (Number(row?.height) !== h) return false;
      const n = Number(row?.n);
      if (!Number.isInteger(n) || n < 0) return false;
      if (!row?.jroot || row.jroot.length !== 32) return false;
      if (!row?.zeroRoot || row.zeroRoot.length !== 32) return false;
    }
    for (const a of plan.anchorWindow || []) {
      const h = Number(a?.height);
      const row = roots[h - 1];
      if (!row) return false;
      if (Number(row.n) !== Number(a.n)) return false;
      if (!Buffer.from(row.jroot).equals(Buffer.from(a.jroot))) return false;
    }
    return true;
  }

  function planSupplyLinks(plan) {
    if (!plan || !Array.isArray(plan.supplySnaps) || plan.supplySnaps.length !== plan.height) return false;
    if (!Array.isArray(plan.anchorWindow) || !plan.anchorWindow.length) return false;
    if (!anchorRootsCover(plan)) return false;
    for (let i = 0; i < plan.supplySnaps.length; i += 1) {
      const row = supplyFromScalar(plan.supplySnaps[i], { owedKnown: true });
      if (!supplyLinks(row, blocks[i])) return false;
    }
    return true;
  }

  function persistBookSnap() {
    if (!journalDisk) return;
    if (!blocks.length) return;
    if (acceptedSeries.length !== blocks.length || unitAt.length !== blocks.length) return;
    try {
      const commit = vaultBindFromFile();
      const gms = genesisHeaderMs(blocks);
      const tipHash = Buffer.from(blocks[blocks.length - 1].hash);
      if (!commit || !gms || tipHash.length !== 32) return;
      const cp = snapExpect.checkpoint || {};
      const cpH = Math.floor(Number(cp.height) || 0);
      const anchorRoots = anchorRootsForSnap();
      if (!anchorRoots) return;
      writeBookSnap(snapFile, sealKey, {
        rules: snapExpect.rules,
        genesisPin: snapExpect.genesisPin,
        checkpointHeight: cpH,
        checkpointHash: cpH > 0 ? String(cp.hash || '') : '',
        height: blocks.length,
        tipHash,
        diskDigest: chainDiskDigest(),
        frameDigest: frameDigestNow(),
        stableDigest: stableDigestNow(),
        unprunedBodies: unprunedBodiesForSnap(),
        genesisMs: gms,
        vaultCommitment: commit,
        owedRows,
        acceptedSeries,
        owedCheckpoints: owedCkpt.map((c) => ({
          at: c.at,
          seriesEnd: c.seriesEnd,
          rows: c.rows,
        })),
        spentIds: [...spentB],
        pubs: liveFlux?.pubs || [],
        commits: liveFlux?.commits || [],
        spendTags: [...(liveFlux?.spendTags || [])],
        unitAt,
        supplySnaps: supplySnapsForSnap(),
        anchorWindow: anchorWindowForSnap(),
        anchorRoots,
      });
      writeVaultSnap(blocks.length);
    } catch { /* leave the previous snap; the next load replays */ }
  }

  function migrateMonolith(diskBlocks) {
    const tmp = path.join(dir, 'segments.migrating');
    fs.rmSync(tmp, { recursive: true, force: true });
    writeChainSegments(tmp, diskBlocks);
    fs.mkdirSync(segDir, { recursive: true });
    for (const name of fs.readdirSync(tmp)) {
      fs.renameSync(path.join(tmp, name), path.join(segDir, name));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (fs.existsSync(binFile)) fs.renameSync(binFile, `${binFile}.legacy`);
    segmented = true;
    unprunedLive = null;
    writeLoadSeal(diskBlocks);
  }

  function holdFromBlock(block) {
    return {
      shareBatch: block.shareBatch || [],
      samples: Array.isArray(block.samples) ? block.samples : [],
      hashSpill: Array.isArray(block.hashSpill) ? block.hashSpill : [],
      hashSpillCredits: block.hashSpillCredits,
      bLeaves: Array.isArray(block.bLeaves) ? block.bLeaves : [],
      txSamples: (block.txs || []).map((tx) => (tx && tx.coinbase ? (tx.samples || []) : null)),
    };
  }

  // Archive only, and only until the reorg floor settles the block. A later
  // tip that no longer buries it serves the full block again.
  function rememberPrunedBody(block, tipH) {
    burialHold.remember(blockHex(block), Number(block?.height), () => packEpochBlock(block), tipH);
  }

  function liftPrunedBlock(block) {
    const key = blockHex(block);
    const bytes = key ? burialHold.read(key) : null;
    if (!bytes) return null;
    let held;
    try {
      const body = unpackEpochBlock(bytes);
      if (!body?.hash || !Buffer.from(body.hash).equals(Buffer.from(block.hash))) return null;
      held = holdFromBlock(body);
    } catch {
      return null;
    }
    const txs = (block.txs || []).map((tx, i) => {
      if (!tx?.coinbase || held.txSamples[i] == null) return tx;
      return { ...tx, samples: held.txSamples[i] };
    });
    const next = {
      ...block,
      shareBatch: held.shareBatch || [],
      samples: held.samples || [],
      hashSpill: held.hashSpill || [],
      bLeaves: held.bLeaves || [],
      samplesPruned: false,
      bLeavesPruned: false,
      txs,
    };
    if (held.hashSpillCredits) next.hashSpillCredits = held.hashSpillCredits;
    return next;
  }

  function provenTipOf(block) {
    if (!block || block.samplesPruned !== true) return null;
    return burialProof.tipOf(blockHex(block), Number(block.height));
  }

  /**
   * The pruned block and the tip that buries it. Buried under this tip, or
   * under a proven-work header chain this store validated: the sealed credit
   * root stands for the share batch. Archive and fast-sync answer the same,
   * because the archive hold is never read here. Neither fails closed.
   */
  function blockForTip(block, tipH) {
    if (!block || block.samplesPruned !== true) return { ok: true, block, tip: tipH };
    const h = Number(block.height) || 0;
    if (shouldPruneSamples(h, tipH)) return { ok: true, block, tip: tipH };
    const proven = provenTipOf(block);
    if (proven != null && shouldPruneSamples(h, proven)) return { ok: true, block, tip: proven };
    return { ok: false, block: null, tip: tipH };
  }

  function noteBurial(tipH) {
    const settled = settledHeight(tipH, checkpointOpts);
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const b = blocks[i];
      const h = Number(b?.height) || i + 1;
      if (h <= settled) break;
      if (b?.samplesPruned !== true || !shouldPruneSamples(h, tipH)) continue;
      if (provenTipOf(b) == null) burialProof.note(blockHex(b), h, tipH);
    }
    burialProof.evict(tipH);
    burialHold.evict(tipH);
    burialProof.save();
  }

  function persist(block) {
    if (!journalDisk) return;
    fs.writeFileSync(magicFile, bookMagic);
    const tipH = Number(block?.height || 0);
    // The block being written is the tip. Fast-sync must not mark it pruned.
    // pruneBuried puts a share batch back when a later tip lifts the block
    // above the depth-1000 line.
    const row = archiveFast && shouldPruneSamples(tipH, tipH)
      ? pruneSamples(block)
      : block;
    const diskBlocks = blocks.slice(0, -1).concat([row]);
    if (!segmented && diskBlocks.length > 1 && fs.existsSync(binFile)) {
      migrateMonolith(diskBlocks);
      loadSegLive();
    } else {
      fs.mkdirSync(segDir, { recursive: true });
      const idx = Math.floor((diskBlocks.length - 1) / CHAIN_SEGMENT_BLOCKS);
      const rec = packEpochBlock(row);
      const written = appendChainBin(path.join(segDir, segmentFileName(idx)), row);
      segmented = true;
      if (written && written.length) rememberSegmentBytes(idx, written);
      noteUnprunedBody(diskBlocks.length - 1, rec);
    }
    fs.appendFileSync(file, `${slimRow(row)}\n`);
    writeTipFile(dir, blocks.length ? blocks[blocks.length - 1] : null);
    writeLoadSeal(blocks);
  }

  function rewriteChain() {
    fs.writeFileSync(magicFile, bookMagic);
    fs.mkdirSync(segDir, { recursive: true });
    writeChainSegments(segDir, blocks);
    dropSegmentsFrom(Math.ceil(blocks.length / CHAIN_SEGMENT_BLOCKS));
    writeSlimIndex();
    writeTipFile(dir, blocks.length ? blocks[blocks.length - 1] : null);
    segmented = true;
    loadSegLive();
    unprunedLive = null;
    resetFrameHash();
    resetSeal();
    writeLoadSeal(blocks);
  }

  function tip() {
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  // One buried body replaces one length-prefixed record. A null result means
  // the segment was torn or short, and the caller repacks those segments.
  function spliceChangedRecords(image, idxs) {
    const bySeg = new Map();
    for (const i of idxs) {
      const seg = Math.floor(i / CHAIN_SEGMENT_BLOCKS);
      if (!bySeg.has(seg)) bySeg.set(seg, []);
      bySeg.get(seg).push(i);
    }
    const written = new Map();
    for (const [seg, list] of bySeg) {
      list.sort((a, b) => b - a);
      const file = path.join(segDir, segmentFileName(seg));
      let buf = null;
      for (const i of list) {
        buf = replaceSegmentRecord(file, i % CHAIN_SEGMENT_BLOCKS, image[i]);
        if (!buf) return false;
      }
      written.set(seg, buf);
    }
    for (const [seg, buf] of written) {
      while (segLive.length < seg) segLive.push({ hash: createHash('sha256'), length: 0 });
      segLive[seg] = { hash: createHash('sha256').update(buf), length: buf.length };
    }
    return written.size > 0;
  }

  function pruneBuried() {
    const tipH = tip()?.height || 0;
    const asked = Number(pruneAfter);
    const pruneDepth = Math.max(
      SAMPLE_PRUNE_CONFIRMATIONS,
      Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : SAMPLE_PRUNE_CONFIRMATIONS,
    );
    const dirtySegs = new Set();
    const dirtyIdx = [];
    const changedIdx = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      if (b.samplesPruned === true && !shouldPruneSamples(b.height, tipH, pruneDepth)) {
        const lifted = liftPrunedBlock(b);
        if (!lifted) continue;
        blocks[i] = lifted;
        dirtySegs.add(Math.floor(i / CHAIN_SEGMENT_BLOCKS));
        changedIdx.push(i);
        noteUnprunedBody(i, packEpochBlock(lifted));
        noteReplacedBlock(i);
        continue;
      }
      if (b.samplesPruned) continue;
      if (!shouldPruneSamples(b.height, tipH, pruneDepth)) continue;
      const nTx = (b.txs || []).length;
      const nVout = (b.txs?.[0]?.vout || []).length;
      rememberPrunedBody(b, tipH);
      const next = pruneSamples(b);
      if ((next.txs || []).length !== nTx) throw new Error('prune_dropped_txs');
      if ((next.txs?.[0]?.vout || []).length !== nVout) throw new Error('prune_dropped_coinbase');
      blocks[i] = next;
      dirtyIdx.push(i);
      changedIdx.push(i);
      dirtySegs.add(Math.floor(i / CHAIN_SEGMENT_BLOCKS));
    }
    if (dirtySegs.size) {
      fs.mkdirSync(segDir, { recursive: true });
      // Only a block this tip buries is stored without its share batch.
      const image = archiveFast
        ? blocks.map((b) => (
          shouldPruneSamples(b.height, tipH, pruneDepth)
            ? (b.samplesPruned ? b : pruneSamples(b))
            : b
        ))
        : blocks;
      // One buried body is one record. Repacking the whole segment rewrites
      // hundreds of untouched blocks on every append past the prune depth.
      const spliced = segmented && changedIdx.length > 0 && changedIdx.length <= 4
        && spliceChangedRecords(image, changedIdx);
      if (!segmented) {
        writeChainSegments(segDir, image);
        segmented = true;
        loadSegLive();
      } else if (!spliced) {
        writeChainSegments(segDir, image, { only: dirtySegs });
        for (const idx of dirtySegs) rehashSegmentFile(idx);
      }
      for (const i of dirtyIdx) {
        if (unprunedLive) unprunedLive.delete(i);
        noteReplacedBlock(i);
      }
      maybePublishBootstrap();
    }
    noteBurial(tipH);
    return dirtySegs.size > 0;
  }

  // Record offsets for the published image. A full rewrite drops the cache.
  // Between 200-block snapshots the file still has to match this tip: one
  // newly buried body is spliced and the new tip is appended. The prefix
  // is not rewritten, so append cost stays flat.
  let bootIndex = null;

  function bootstrapPruneDepth() {
    const asked = Number(pruneAfter);
    return Math.max(
      SAMPLE_PRUNE_CONFIRMATIONS,
      Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : SAMPLE_PRUNE_CONFIRMATIONS,
    );
  }

  function rewriteBootstrapImage() {
    bootIndex = null;
    try { writeLatestBootstrap(dir, blocks); } catch { /* observer must not halt append */ }
  }

  function extendBootstrapImage(manifest) {
    const tipH = Number(tip()?.height || 0);
    const published = Number(manifest?.height) || 0;
    const paths = latestPaths(dir);
    if (!published || tipH < published || !fs.existsSync(paths.bin)) {
      rewriteBootstrapImage();
      return;
    }
    const anchor = blocks[published - 1];
    if (!anchor || Number(anchor.height) !== published || hex32(anchor.hash) !== String(manifest.hash || '')) {
      rewriteBootstrapImage();
      return;
    }
    if (tipH === published) return;
    if (!bootIndex || bootIndex.length !== published) bootIndex = chainRecordIndex(paths.bin);
    if (!bootIndex || bootIndex.length !== published) {
      rewriteBootstrapImage();
      return;
    }
    const depth = bootstrapPruneDepth();
    for (let h = published + 1; h <= tipH; h += 1) {
      const bury = h - depth;
      if (bury >= 1) {
        const victim = blocks[bury - 1];
        const rec = bootIndex[bury - 1];
        if (victim && victim.samplesPruned === true && rec) {
          const newLen = spliceChainRecordAt(paths.bin, rec, victim);
          if (newLen == null) {
            bootIndex = null;
            rewriteBootstrapImage();
            return;
          }
          const delta = newLen - rec.len;
          rec.len = newLen;
          for (let i = bury; i < bootIndex.length; i += 1) bootIndex[i].off += delta;
        }
      }
      const block = blocks[h - 1];
      if (!block || Number(block.height) !== h) {
        bootIndex = null;
        rewriteBootstrapImage();
        return;
      }
      const prev = bootIndex[bootIndex.length - 1];
      const eof = prev.off + 4 + prev.len;
      let size = 0;
      try { size = fs.statSync(paths.bin).size; } catch { size = -1; }
      if (size !== eof) {
        bootIndex = null;
        rewriteBootstrapImage();
        return;
      }
      const written = appendChainBin(paths.bin, block);
      if (!written || written.length < 4) {
        bootIndex = null;
        rewriteBootstrapImage();
        return;
      }
      bootIndex.push({ off: eof, len: written.length - 4 });
    }
    if (bootIndex.length !== tipH) {
      bootIndex = null;
      rewriteBootstrapImage();
      return;
    }
    const last = blocks[tipH - 1];
    const next = {
      ...manifest,
      height: tipH,
      hash: hex32(last.hash),
      n: tipH,
      checkpoint: bootstrapCheckpoint(tipH),
      createdAt: Date.now(),
    };
    const tmp = `${paths.json}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`);
    fs.renameSync(tmp, paths.json);
  }

  function maybePublishBootstrap() {
    const tipH = Number(tip()?.height || 0);
    const paths = latestPaths(dir);
    let manifest = null;
    try {
      if (fs.existsSync(paths.json)) manifest = JSON.parse(fs.readFileSync(paths.json, 'utf8'));
    } catch { manifest = null; }
    const last = Number(manifest?.checkpoint) || 0;
    // The 200-block cadence still rewrites the whole image. A tip between
    // those heights has to be in the file too, or a bootstrap node stops
    // on the previous snapshot.
    if (!manifest || shouldPublishBootstrap(tipH, last)) {
      rewriteBootstrapImage();
      return;
    }
    try { extendBootstrapImage(manifest); } catch { /* observer must not halt append */ }
  }

  function hourlyWork(nowMs) {
    return hourlyWorkBuckets(blocks, nowMs, { workOf: workOfBlock, timeOf: blockTimeMs });
  }

  function sideLeadWork() {
    const active = Number(blocks.length ? chainWorkOf(blocks) : 0n);
    const activeHash = tip() ? hex32(tip().hash) : '';
    let best = 0;
    for (const [h, f] of forks) {
      if (h === activeHash) continue;
      const w = Number(f.work) || 0;
      if (w > best) best = w;
    }
    return best - active;
  }

  const policyStatePath = path.join(dir, 'payout-policy-state.json');
  function loadPolicyState() {
    try {
      const raw = JSON.parse(fs.readFileSync(policyStatePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      const base = emptyPolicyState();
      base.reorgLog = Array.isArray(raw.reorgLog)
        ? raw.reorgLog.filter((r) => r && Number.isFinite(Number(r.atMs)) && Number.isFinite(Number(r.depth)))
        : [];
      base.d_max = Math.max(0, Number(raw.d_max) || 0);
      base.h_ratio = Number.isFinite(Number(raw.h_ratio)) ? Number(raw.h_ratio) : 1;
      base.side_lead = Number(raw.side_lead) || 0;
      base.frozen = !!raw.frozen;
      base.freezeReason = String(raw.freezeReason || raw.freeze_reason || '');
      base.quietBlocks = Math.max(0, Math.floor(Number(raw.quietBlocks ?? raw.quiet_blocks) || 0));
      base.hRatioLow = !!raw.hRatioLow || !!raw.h_ratio_low;
      base.hRatioRecoverBlocks = Math.max(0, Math.floor(Number(raw.hRatioRecoverBlocks ?? raw.h_ratio_recover_blocks) || 0));
      base.hRatioPayoutHeld = !!raw.hRatioPayoutHeld
        || !!raw.h_ratio_payout_held
        || base.hRatioLow
        || (base.frozen && base.freezeReason === 'h_ratio');
      base.reorg_risk = !!raw.reorg_risk;
      policyState = base;
    } catch { /* no saved counters yet */ }
  }
  function savePolicyState() {
    const body = JSON.stringify({
      reorgLog: policyState.reorgLog || [],
      d_max: policyState.d_max || 0,
      h_ratio: policyState.h_ratio,
      side_lead: policyState.side_lead || 0,
      frozen: !!policyState.frozen,
      freezeReason: policyState.freezeReason || '',
      quietBlocks: policyState.quietBlocks || 0,
      hRatioLow: !!policyState.hRatioLow,
      hRatioRecoverBlocks: policyState.hRatioRecoverBlocks || 0,
      hRatioPayoutHeld: !!policyState.hRatioPayoutHeld,
      reorg_risk: !!policyState.reorg_risk,
    });
    try {
      const tmp = `${policyStatePath}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, policyStatePath);
    } catch { /* counters remain in memory */ }
  }

  function refreshPolicy({ newBlock = false, reorgDepth = 0, nowMs = Date.now() } = {}) {
    if (reorgDepth > 0) {
      policyState = recordReorg(policyState, { depth: reorgDepth, atMs: nowMs });
    }
    const before = policyState.frozen;
    policyState = applySignals(policyState, {
      nowMs,
      h_ratio: hashRatioFromHours(hourlyWork(nowMs)),
      side_lead: sideLeadWork(),
      newBlock,
    });
    if (before !== policyState.frozen) {
      emit('credits_frozen', {
        frozen: policyState.frozen,
        reason: policyState.freezeReason,
        d_max: policyState.d_max,
        side_lead: policyState.side_lead,
        h_ratio: policyState.h_ratio,
      });
    }
    savePolicyState();
  }

  function stampCredits(block, unit) {
    if (!block) return;
    const haveCredits = Object.prototype.hasOwnProperty.call(block, 'hashCredits');
    if (!haveCredits && !(block.samplesPruned === true && !(block.shareBatch || []).length)) {
      block.hashCredits = freshCreditsFromShares(block.shareBatch || [], unit);
    }
    if (Object.prototype.hasOwnProperty.call(block, 'hashSpillCredits')) return;
    const spill = Array.isArray(block.hashSpill) ? block.hashSpill : [];
    if (!spill.length) return;
    block.hashSpillCredits = freshCreditsFromShares(spill, unit);
  }

  function keepOwedIndex(at, tipAt) {
    if (!Number.isInteger(at) || at < 0 || at > tipAt) return false;
    if (at === 0 || at === tipAt) return true;
    return ((at + 1) % OWED_CHECKPOINT_SPACING) === 0;
  }

  function compressReplaySnaps(snaps, n) {
    const tipAt = n - 1;
    const out = [];
    for (let i = 0; i < snaps.length; i += 1) {
      if (!keepOwedIndex(i, tipAt)) continue;
      const s = snaps[i];
      out.push({
        at: i,
        rows: s.rows,
        seriesEnd: Number.isInteger(s.seriesEnd) ? s.seriesEnd : i + 1,
      });
    }
    return out;
  }

  function checkpointsCover(n) {
    if (n <= 0) return true;
    if (!owedCkpt.length) return false;
    let prev = -1;
    for (const c of owedCkpt) {
      if (!c || !Number.isInteger(c.at) || c.at <= prev) return false;
      if (c.at - prev > OWED_CHECKPOINT_SPACING) return false;
      if (!Array.isArray(c.rows) || !Number.isInteger(c.seriesEnd) || c.seriesEnd < 0) return false;
      prev = c.at;
    }
    const tip = owedCkpt[owedCkpt.length - 1];
    return tip.at === n - 1 && tip.seriesEnd === acceptedSeries.length && prev === n - 1;
  }

  function replayOwedFrom(list, fromAt, rowsIn, seriesIn) {
    const tipAt = list.length - 1;
    let rows = rowsIn;
    let series = seriesIn;
    const unitWalk = unitAt.length === list.length
      ? { ok: true, units: unitAt }
      : unitsOnBook({ fork: list, timeOf: (block) => blockTimeMs(block) });
    if (!unitWalk.ok) return null;
    const units = unitWalk.units;
    const tipH = Number(list[tipAt]?.height || tipAt + 1);
    for (let i = fromAt; i <= tipAt; i += 1) {
      const viewed = blockForTip(list[i], tipH);
      if (!viewed.ok) return null;
      const next = advanceHashOwed({
        owedIn: rows,
        acceptedSeries: series,
        block: viewed.block,
        unit: units[i],
        height: Number(list[i]?.height) || i + 1,
        tipHeight: viewed.tip,
      });
      if (!next.ok) return null;
      rows = next.rows;
      series = next.acceptedSeries;
      owedSeed.loadBlocks += 1;
      if (keepOwedIndex(i, tipAt)) {
        owedCkpt = owedCkpt.filter((c) => c.at !== i);
        owedCkpt.push({ at: i, rows: copyOwedRows(rows), seriesEnd: series.length });
      }
    }
    owedCkpt.sort((a, b) => a.at - b.at);
    return { rows, series };
  }

  function syncOwed(chain) {
    const list = chain || [];
    if ((loadMode === 'snap' || loadMode === 'suffix') && acceptedSeries.length === list.length) {
      owedSeriesAll = acceptedSeries;
      if (!checkpointsCover(list.length)) {
        const last = owedCkpt.length ? owedCkpt[owedCkpt.length - 1] : null;
        const canExtend = last
          && last.at < list.length
          && last.seriesEnd <= acceptedSeries.length
          && last.seriesEnd === last.at + 1;
        if (!canExtend) {
          const unitWalk = unitAt.length === list.length
            ? { ok: true, units: unitAt }
            : unitsOnBook({ fork: list, timeOf: (block) => blockTimeMs(block) });
          if (!unitWalk.ok) throw new Error(unitWalk.reason || 'epoch_open');
          const units = unitWalk.units;
          const got = replayHashOwed(list, { units, burialOf: provenTipOf });
          if (!got.ok) throw new Error(got.reason || 'hash_owed_replay');
          owedRows = got.rows;
          acceptedSeries = got.accepted;
          owedSeriesAll = acceptedSeries;
          owedCkpt = compressReplaySnaps(got.snaps || [], list.length);
          owedSeed.loadBlocks += list.length;
          snapRewrite = true;
        } else {
          const filled = replayOwedFrom(
            list,
            last.at + 1,
            last.rows.slice(),
            acceptedSeries.slice(0, last.seriesEnd),
          );
          if (!filled) throw new Error('hash_owed_replay');
          owedRows = filled.rows;
          acceptedSeries = filled.series;
          owedSeriesAll = acceptedSeries;
          snapRewrite = true;
        }
      }
      seedCache = null;
      return;
    }
    const unitWalk = unitAt.length === list.length
      ? { ok: true, units: unitAt }
      : unitsOnBook({ fork: list, timeOf: (block) => blockTimeMs(block) });
    if (!unitWalk.ok) throw new Error(unitWalk.reason || 'epoch_open');
    const units = unitWalk.units;
    const got = replayHashOwed(list, { units, burialOf: provenTipOf });
    if (!got.ok) throw new Error(got.reason || 'hash_owed_replay');
    owedRows = got.rows;
    acceptedSeries = got.accepted;
    owedSeriesAll = acceptedSeries;
    owedCkpt = compressReplaySnaps(got.snaps || [], list.length);
    seedCache = null;
  }

  function copyOwedRows(rows) {
    return Array.isArray(rows) ? rows.slice() : [];
  }

  function rememberOwed(at) {
    const tipAt = at;
    owedCkpt = owedCkpt.filter((c) => keepOwedIndex(c.at, tipAt) && c.at !== tipAt);
    owedCkpt.push({ at: tipAt, rows: copyOwedRows(owedRows), seriesEnd: acceptedSeries.length });
    owedCkpt.sort((a, b) => a.at - b.at);
    seedCache = null;
  }

  function rememberVault(at) {
    const tipAt = at;
    vaultCkpt = vaultCkpt.filter((c) => keepOwedIndex(c.at, tipAt) && c.at !== tipAt);
    vaultCkpt.push({ at: tipAt, vault: cloneVault(reserveVault) });
    vaultCkpt.sort((a, b) => a.at - b.at);
  }

  function fillAllVaultCheckpoints() {
    const trial = cloneVault(bookVault());
    if (reserveVault?.oracle) {
      try { trial.oracle = JSON.parse(JSON.stringify(reserveVault.oracle)); } catch { /* empty oracle */ }
    }
    vaultCkpt = [];
    const tipAt = blocks.length - 1;
    for (let i = 0; i <= tipAt; i += 1) {
      commitReserveApply(applyReserveBlock(vaultArgs(trial, blocks[i], blocks.slice(0, i))));
      if (keepOwedIndex(i, tipAt)) vaultCkpt.push({ at: i, vault: cloneVault(trial) });
    }
  }

  function vaultGapsOk() {
    const tipAt = blocks.length - 1;
    if (tipAt < 0) return true;
    if (!vaultCkpt.length) return false;
    let prev = -1;
    for (const c of vaultCkpt) {
      if (!c || c.at <= prev || c.at - prev > OWED_CHECKPOINT_SPACING) return false;
      prev = c.at;
    }
    return vaultCkpt[vaultCkpt.length - 1].at === tipAt && prev === tipAt;
  }

  function ensureVaultCheckpoints() {
    if (vaultGapsOk()) return;
    fillAllVaultCheckpoints();
  }

  function vaultAfter(at) {
    if (at < 0) return cloneVault(bookVault());
    let best = null;
    for (const c of vaultCkpt) {
      if (c.at <= at && (!best || c.at > best.at)) best = c;
    }
    const trial = best ? cloneVault(best.vault) : cloneVault(bookVault());
    const start = best ? best.at + 1 : 0;
    const chain = blocks.slice(0, start);
    for (let i = start; i <= at; i += 1) {
      commitReserveApply(applyReserveBlock(vaultArgs(trial, blocks[i], chain)));
      chain.push(blocks[i]);
    }
    return trial;
  }

  function unitsAlong(history, fork) {
    const rows = Array.isArray(history) ? history : [];
    return unitsOnBook({
      unitAt,
      history: rows,
      fork,
      vault: rows.length ? vaultAfter(rows.length - 1) : bookVault(),
      timeOf: (block) => blockTimeMs(block),
    });
  }

  // Trailer must match ids derived from this block's own b-spend txs.
  function restoreSpentB() {
    for (let i = 0; i < blocks.length; i += 1) {
      const got = matchedSpendIds(blocks[i]);
      if (!got.ok) throwBookFault(got.reason || 'spent_checkpoint_missing');
      for (const id of got.ids) {
        if (spentB.has(id)) throw new Error('double_open');
        spentB.add(id);
      }
    }
  }

  function spentDelta(before, after) {
    const ids = [];
    for (const id of after) if (!before.has(id)) ids.push(id);
    return ids;
  }

  function rollbackSpent(book, before) {
    if (!(book instanceof Set)) return;
    for (const id of book) if (!before.has(id)) book.delete(id);
  }

  let reorgFrom = null;
  let reorgAccepted = null;
  let reorgLca = 0;

  function clearReorgMarkers() {
    reorgFrom = null;
    reorgAccepted = null;
    reorgLca = 0;
  }
  let lastReorgMeasure = null;

  function rebuildSpentB() {
    const fromBlocks = reorgFrom || blocks;
    const accepted = reorgAccepted || blocks;
    const lca = reorgFrom ? reorgLca : 0;
    const t0 = performance.now();
    const shareOpts = { skipSharePow: false };
    const disconnected = fromBlocks.slice(lca);
    const connected = accepted.slice(lca);
    for (let i = 0; i < accepted.length; i += 1) {
      const b = accepted[i];
      let trustedPowHash = null;
      try {
        if (b?.hash && Buffer.from(b.hash).length === 32) trustedPowHash = Buffer.from(b.hash);
      } catch { trustedPowHash = null; }
      if (!trustedPowHash) return { ok: false, reason: 'share_credit_bind', at: i };
      const chainTip = Number(accepted[accepted.length - 1]?.height || 0);
      // The adopted tip, or the proven-work tip that buried this pruned block.
      const viewed = blockForTip(b, chainTip);
      if (!viewed.ok) return { ok: false, reason: 'samples_pruned', at: i };
      const bound = shareCreditBound(viewed.block, viewed.tip);
      if (!bound.ok) return { ok: false, reason: bound.reason || 'share_credit_bind', at: i };
    }
    const dropIds = [];
    for (const b of disconnected) {
      const got = matchedSpendIds(b);
      if (!got.ok) return { ok: false, reason: got.reason || 'spent_checkpoint_missing', at: lca };
      dropIds.push(got.ids);
    }
    const addIds = [];
    for (const b of connected) {
      const got = matchedSpendIds(b);
      if (!got.ok) return { ok: false, reason: got.reason || 'spent_checkpoint_missing', at: lca };
      addIds.push(got.ids);
    }
    const nextSpent = new Set(spentB);
    for (const ids of dropIds) {
      for (const id of ids) nextSpent.delete(id);
    }
    for (const ids of addIds) {
      for (const id of ids) {
        if (nextSpent.has(id)) return { ok: false, reason: 'double_open', at: lca };
        nextSpent.add(id);
      }
    }
    const cold = [];
    for (let i = 0; i < connected.length; i += 1) {
      const b = connected[i];
      const shares = Array.isArray(b.shareBatch) ? b.shareBatch : [];
      if (!shares.length) continue;
      const parentIdx = lca + i - 1;
      const parentHeader = parentIdx >= 0 ? accepted[parentIdx]?.header : null;
      if (!parentHeader) return { ok: false, reason: 'parent_header', at: lca + i };
      const priorHeader = parentIdx >= 1 ? accepted[parentIdx - 1]?.header : null;
      for (const s of shares) {
        const nonce = s?.nonce;
        const queue = (header) => {
          if (!header || hasLiveSharePow(header, nonce)) return;
          cold.push({ header, nonce });
        };
        const slot = s?.proofSlot;
        const workRow = (s?.shareBits != null && s.shareBits !== '')
          || (s?.creditedShareBits != null && s.creditedShareBits !== '');
        if (slot === 1 || slot === '1') queue(priorHeader);
        else if (slot === 0 || slot === '0') queue(parentHeader);
        else if (!workRow) {
          queue(parentHeader);
          queue(priorHeader);
        }
      }
    }
    const measure = (syncSharePow, loopLagMs) => {
      const ms = performance.now() - t0;
      lastReorgMeasure = {
        ms,
        suffix: connected.length,
        prefix: lca,
        coldShares: cold.length,
        syncSharePow,
        loopLagMs,
      };
      return {
        ok: true,
        spent: nextSpent.size,
        nextSpent,
        suffix: connected.length,
        prefix: lca,
        ms,
        coldShares: cold.length,
        syncSharePow,
      };
    };
    if (!cold.length) return measure(0, 0);
    const beforeSync = sharePowCounters().sync;
    return Promise.all(cold.map((c) => {
      const header = setNonce(Buffer.from(c.header), BigInt(c.nonce));
      c.stamped = header;
      return hashHeaderOffLoop(header);
    })).then((hashes) => {
      for (let i = 0; i < cold.length; i += 1) stashSharePow(cold[i].stamped, hashes[i]);
      for (let i = 0; i < connected.length; i += 1) {
        const shares = connected[i].shareBatch || [];
        if (!shares.length) continue;
        const parentIdx = lca + i - 1;
        const parentHeader = accepted[parentIdx].header;
        const priorHeader = parentIdx >= 1 ? accepted[parentIdx - 1]?.header : null;
        const paid = paidWorkKeys(accepted[parentIdx]?.shareBatch, priorHeader);
        const got = verifyShareBatch({
          parentHeader,
          priorHeader,
          excludeNonces: paid,
          shares,
          skipPow: shareOpts.skipSharePow,
          issuedJobKeys: connected[i].txs?.[0]?.issuedJobKeys,
        });
        if (!got.ok) return { ok: false, reason: got.reason || 'share_pow', at: lca + i };
      }
      const syncSharePow = sharePowCounters().sync - beforeSync;
      return new Promise((resolve) => {
        const y0 = performance.now();
        setImmediate(() => {
          resolve(measure(syncSharePow, performance.now() - y0));
        });
      });
    }).catch((err) => ({
      ok: false,
      reason: 'share_pow',
      error: String(err?.message || err),
    }));
  }

  /**
   * A flow proof that is not byte 3 with an anchor is dropped even when the
   * v2 verifier would still accept it. A byte-3 proof stays only while it
   * verifies against the current root. Reserve actions and painted holds stay.
   * Template still keeps an admit_membership miss that has not been swept here.
   */
  function dropStaleFlowSpends() {
    const live = liveFlux;
    if (!live?.jroot || !Array.isArray(live.pubs) || live.pubs.length < 1) return;
    const keep = [];
    for (const tx of mempool) {
      if (!flowNeedsDummy(tx)) {
        keep.push(tx);
        continue;
      }
      // A non-v3 flow proof must not stay even when it still verifies.
      if (v12FlowVersionRejected(tx)) continue;
      const parsed = txSpendTags(tx);
      if (!parsed.proofs.length || parsed.reason === 'admit_tag') {
        keep.push(tx);
        continue;
      }
      const tipNow = tip();
      const proved = verifyFlowAdmitV3(tx, {
        height: Number(tipNow?.height || 0) + 1,
        blocks,
        spentTags: live.spendTags,
        magic: bookMagic,
        noteAtAnchor: (anchor) => noteFromAnchor(liveFlux, anchorAt, anchor),
      });
      if (proved.ok && !proved.skip) keep.push(tx);
    }
    if (keep.length !== mempool.length) {
      mempool.length = 0;
      mempool.push(...keep);
      syncMempoolTags();
    }
  }

  function bounceMempool(disconnected, connected) {
    // By body key, not by the label a sender picks: a winner that only shares
    // a held tx's id neither evicts it nor stops a loser's body coming back.
    const winnerKeys = new Set();
    for (const b of connected || []) {
      for (const tx of (b.txs || []).slice(1)) {
        const key = txBodyKey(tx);
        if (key) winnerKeys.add(key);
      }
    }
    const spentByWinner = winnerSpends(connected);
    for (let i = mempool.length - 1; i >= 0; i -= 1) {
      const tx = mempool[i];
      const key = heldBodyKey(tx);
      if ((key && winnerKeys.has(key)) || spentByWinner(tx)) mempool.splice(i, 1);
    }
    let base = 1;
    const t = tip();
    try {
      if (t?.header) base = Number(decodeHeader(Buffer.from(t.header)).baseFee || 1n);
    } catch { base = 1; }
    // The chain vault moved with the tip. Rebuild once, then each returned
    // reserve tx is applied on its own.
    mempoolVault = null;
    const stamp = headerStamp();
    let carried = ensureMempoolVault(stamp);
    syncMempoolTags();
    const book = emptyMempool();
    book.txs = mempool.slice();
    book.tagIndex = mempoolTags;
    const heldKeys = new Set(mempool.map(heldBodyKey).filter(Boolean));
    for (const b of disconnected || []) {
      for (const tx of (b.txs || []).slice(1)) {
        if (tx?.coinbase) continue;
        const key = txBodyKey(tx);
        if (key && winnerKeys.has(key)) continue;
        if (spentByWinner(tx)) continue;
        if (key && heldKeys.has(key)) continue;
        const row = {
          ...tx,
          kind: tx.kind,
          to: tx.to || tx.vout?.[0]?.address,
          from: tx.from || tx.vin?.[0]?.address,
          nanos: tx.nanos || tx.vout?.[0]?.nanos,
          fee: tx.fee,
        };
        const admitOpts = {
          baseFee: base,
          reserveState: reserveVault,
          nowMs: stamp,
          fluxset: liveFlux,
          spendTags: liveFlux?.spendTags,
          commits: liveFlux?.commits,
          height: Number(t?.height || 0) + 1,
          blocks,
          magic: bookMagic,
          noteAtAnchor: (anchor) => noteFromAnchor(liveFlux, anchorAt, anchor),
        };
        if (txIsReserveAction(row)) {
          admitOpts.reserveCarried = carried;
          admitOpts.verifiedFund = fundVerdictFor(row);
        }
        const got = admitMempool(book, row, admitOpts);
        if (got && got.ok && got.vaultState) carried = got.vaultState;
      }
    }
    mempool.length = 0;
    mempool.push(...book.txs);
    mempoolVault = carried;
  }

  function makeReorgEvent({ fromBlocks, toBlocks, lca }) {
    const disconnected = fromBlocks.slice(lca);
    const connected = toBlocks.slice(lca);
    const fromB = fromBlocks[fromBlocks.length - 1];
    const toB = toBlocks[toBlocks.length - 1];
    const forkB = lca > 0 ? fromBlocks[lca - 1] : null;
    const depth = disconnected.length;
    const forkHeight = lca > 0 ? Number(fromBlocks[lca - 1].height || lca) : 0;
    const tipH = Number(toB?.height || toBlocks.length);
    const samples_pruned = forkHeight > 0 && (tipH - forkHeight) >= SAMPLE_PRUNE_CONFIRMATIONS;
    const orphaned_txids = [];
    const orphaned_pots = [];
    for (const b of disconnected) {
      orphaned_pots.push(...potIdsOf(b));
      for (const tx of (b.txs || []).slice(1)) {
        const id = txIdOf(tx);
        if (id) orphaned_txids.push(id);
      }
    }
    return {
      type: 'reorg',
      from_hash: fromB ? hex32(fromB.hash) : '',
      to_hash: toB ? hex32(toB.hash) : '',
      fork_hash: forkB ? hex32(forkB.hash) : '',
      from_height: Number(fromB?.height || fromBlocks.length),
      to_height: Number(toB?.height || toBlocks.length),
      depth,
      work_delta: chainWorkOf(toBlocks) - chainWorkOf(fromBlocks),
      orphaned_txids,
      orphaned_pots,
      disconnected: disconnected.map((b) => Number(b.height || 0)),
      connected: connected.map((b) => Number(b.height || 0)),
      samples_pruned,
    };
  }

  function getchaintips() {
    const activeHash = tip() ? hex32(tip().hash) : '';
    const inActive = new Set(blocks.map((b) => hex32(b.hash)));
    const hasChild = new Set();
    for (const rec of headers.values()) {
      if (rec.prev) hasChild.add(rec.prev);
    }
    const out = [];
    const seen = new Set();
    if (tip()) {
      out.push({
        height: Number(tip().height || blocks.length),
        hash: activeHash,
        branchlen: 0,
        status: 'active',
      });
      seen.add(activeHash);
    }
    for (const rec of headers.values()) {
      if (hasChild.has(rec.hash)) continue;
      if (seen.has(rec.hash)) continue;
      seen.add(rec.hash);
      let lca = 0;
      let walk = rec;
      let guard = 0;
      while (walk && !inActive.has(walk.hash) && guard++ < 10_000) {
        lca += 1;
        walk = walk.prev ? headers.get(walk.prev) : null;
      }
      out.push({
        height: rec.height,
        hash: rec.hash,
        branchlen: lca,
        status: rec.status === 'valid-headers' ? 'valid-headers' : 'valid-fork',
      });
    }
    return out.sort((a, b) => b.height - a.height || a.status.localeCompare(b.status));
  }

  function settleCheck(check, onOk) {
    if (check && typeof check.then === 'function') {
      return check.then((c) => (c?.ok ? onOk(c) : c));
    }
    if (!check?.ok) return check;
    return onOk(check);
  }

  function verifyAgainstTip(block, extra = {}) {
    const prev = tip();
    const parentH = prev ? prev.height : 0;
    const tipHeight = parentH;
    const probe = extra.probeBody === true;
    // A peer-advertised height must not prune or skip validation.
    // Burial uses only the parent already on this chain. The next block
    // is that parent plus one, so this path does not set samplesPruned.
    const toVerify = block;
    const spentBefore = new Set(spentB);
    const check = verifyBlock(toVerify, prev ? {
      hash: prev.hash,
      header: prev.header,
      height: prev.height,
      rootA: prev.rootA,
      rootB: prev.rootB,
      txs: prev.txs,
      bLeaves: prev.bLeaves,
      weight: prev.weight,
      shareBatch: prev.shareBatch,
      blunoteRecord: prev.blunoteRecord,
    } : null, {
      spentB,
      tipHeight,
      hashBonusNanos: hashBonusUnitNanos(reserveVault.liveHashBonusNanos),
      evmSession,
      evmHistory: blocks,
      spendableOf: (addr) => Math.max(0, destSpendableNanos(addr, parentH)),
      committedBps: Number(reserveVault.epochBps ?? GENESIS_BPS),
      ...oracleVerifyFields(blocks, (prev ? prev.height : 0) + 1),
      reserveState: reserveVault,
      seenDigests: sealedSpendDigests(),
      mtpTimestamps: blocks.slice(-11).map((b) => {
        try { return Number(decodeHeader(Buffer.from(b.header)).timestamp); } catch { return 0; }
      }),
      nowMs: Date.now(),
      genesisMs: (() => {
        try {
          const g = blocks[0];
          if (!g?.header) return 0;
          return Number(decodeHeader(Buffer.from(g.header)).timestamp) || 0;
        } catch { return 0; }
      })(),
      magic: bookMagic,
      trustedPowHash: probe ? null : (extra.trustedPowHash || null),
      skipSharePow: probe ? true : !!extra.skipSharePow,
      offLoopPow: probe ? false : !!extra.offLoopPow,
      probeBody: probe,
      // This block's EVM calls run in a checkpoint on the live session:
      // reverted for a probe or a failure, committed once it is stored.
      evmCheckpoint: true,
      grandparentHeader: grandparentHeader(blocks),
      sealedIntervalsMs: headerGapsMs(blocks),
      parentFluxset: liveFlux,
      parentSpendTags: liveFlux.spendTags,
      ...(blocks.length && supplyTip ? { parentSupply: supplyTip } : {}),
      noteAtAnchor: (anchor) => noteFromAnchor(liveFlux, anchorAt, anchor),
      ...(Number.isInteger(extra.burialTip) ? { burialTip: extra.burialTip } : {}),
      poolDest: extra.poolDest
        || block?.poolDest
        || (block?.miner && isDestAddress(block.miner) ? block.miner : null),
      owedIn: owedRows,
      hashAcceptedSeries: acceptedSeries.slice(),
      arrivedRows: extra.arrivedRows,
    });
    return { check, spentBefore };
  }

  /**
   * The node has one live EVM session, and a block whose calls run on it
   * (blockNeedsEvm) holds it from its checkpoint to its commit or revert.
   * SimpleStateManager commit and revert act on the top layer, so an append
   * and a probe that overlapped would merge or drop each other's calls. A
   * block with no EVM calls never touches the session and runs as before.
   */
  let evmTail = Promise.resolve();
  function evmExclusive(block, run) {
    if (!blockNeedsEvm(block?.txs || [])) return run();
    const go = evmTail.then(run, run);
    evmTail = go.then(() => {}, () => {});
    return go;
  }

  /**
   * append's verdict on `block`, with nothing kept. The body is compacted
   * first, as append does (arrivedBody), so a template probe and the real
   * append judge the same bytes.
   */
  function probeBlock(block) {
    return evmExclusive(block, () => probeBlockNow(block));
  }

  function probeBlockNow(block) {
    const refused = arrivalReason(block);
    const { check, spentBefore } = verifyAgainstTip(arrivedBody(block), { probeBody: true, arrivedRows: arrivedRows(block) });
    const finish = (c) => {
      rollbackSpent(spentB, spentBefore);
      if (!c?.ok) return { ok: false, reason: c?.reason || 'append' };
      // As append: the compact body verified, and a field it may not carry is refused.
      if (refused) return { ok: false, reason: refused.reason, field: refused.field };
      return { ok: true, reason: '' };
    };
    if (check && typeof check.then === 'function') {
      return check.then(finish, (err) => {
        rollbackSpent(spentB, spentBefore);
        return { ok: false, reason: 'append', error: String(err?.message || err) };
      });
    }
    return finish(check);
  }

  // Peer headers ahead of this tip, cached per slot and unproven until a
  // pruned block needs them. Inbound peers share a slot per network group
  // (/24, /64); outbound, pinned and local callers have their own pool that
  // inbound peers cannot take. A proven header keeps its bytes in its own
  // pool, so junk from any slot cannot push out a run this store hashed.
  const offeredRows = new Map();
  const provenRows = new Map();
  const headerKids = new Map();
  const offerSlots = new Map();
  const droppedPeers = new Map();
  const offerStats = { hashed: 0, rejected: 0, orphaned: 0, dropped: 0, limited: 0, refused: 0 };
  let offerSeq = 0;
  let localIndex = { len: -1, tipHex: '', map: new Map() };

  function headerRowOf(hex) {
    return provenRows.get(hex) || offeredRows.get(hex) || null;
  }

  function unlinkHeaderRow(hex, prevHex) {
    if (provenRows.has(hex) || offeredRows.has(hex)) return;
    const kids = headerKids.get(prevHex);
    if (!kids) return;
    kids.delete(hex);
    if (!kids.size) headerKids.delete(prevHex);
  }

  function linkHeaderRow(row) {
    if (!headerKids.has(row.prevHex)) headerKids.set(row.prevHex, new Set());
    headerKids.get(row.prevHex).add(row.hex);
  }

  function releaseOffered(hex, slotKey) {
    const row = offeredRows.get(hex);
    if (!row) return;
    row.slots.delete(slotKey);
    if (row.slots.size) return;
    offeredRows.delete(hex);
    unlinkHeaderRow(hex, row.prevHex);
  }

  function evictOfferSlot(slotKey) {
    const slot = offerSlots.get(slotKey);
    if (!slot) return;
    offerSlots.delete(slotKey);
    for (const hex of slot.rows.keys()) releaseOffered(hex, slotKey);
  }

  function banOfferKey(key, nowMs) {
    droppedPeers.delete(key);
    droppedPeers.set(key, nowMs + OFFER_DROP_MS);
    while (droppedPeers.size > OFFER_DROPPED_CAP) droppedPeers.delete(droppedPeers.keys().next().value);
  }

  /**
   * Drop a peer that sent a bad link: its slot's unproven headers go, and the
   * peer is refused for a while. A shared group slot is refused with it, so a
   * /24 or /64 cannot come straight back under the next address.
   */
  function dropOfferPeer(peer, slotKey, nowMs = Date.now()) {
    const slot = offerSlots.get(slotKey);
    evictOfferSlot(slotKey);
    banOfferKey(peer, nowMs);
    if (slot && slot.tier !== 'pinned' && slot.tier !== 'local') banOfferKey(slotKey, nowMs);
    offerStats.dropped += 1;
  }

  function offerKeyDropped(key, nowMs) {
    const until = droppedPeers.get(key);
    if (until == null) return false;
    if (until > nowMs) return true;
    droppedPeers.delete(key);
    return false;
  }

  function offerPeerDropped(peer, nowMs = Date.now()) {
    return offerKeyDropped(String(peer), nowMs);
  }

  const TIER_RANK = { local: 2, pinned: 2, outbound: 1, inbound: 0 };

  function slotKeyOf(peer, tier, group) {
    if (tier === 'inbound' || tier === 'outbound') return `${tier === 'inbound' ? 'in' : 'out'}:${group || peer}`;
    return peer;
  }

  function poolOf(tier) {
    return tier === 'inbound' ? 'inbound' : 'reserved';
  }

  /** The best cached run above this tip, as deep as a burial proof needs. */
  function pathFromTip() {
    const t = tip();
    const from = t?.hash ? blockHex(t) : GENESIS_PREV.toString('hex');
    return bestPath(from, SAMPLE_PRUNE_CONFIRMATIONS + 1).rows;
  }

  /**
   * The fewest slots that still hold the whole best path: the slot holding
   * the most of it first, then the higher tier, then the oldest. A slot that
   * only replays part of that path is not kept for it.
   */
  function protectedSlots() {
    const keep = new Set();
    let left = pathFromTip().map((row) => row && offeredRows.get(row.hex)).filter(Boolean);
    while (left.length) {
      const held = new Map();
      for (const row of left) for (const k of row.slots) held.set(k, (held.get(k) || 0) + 1);
      let pick = null;
      for (const [k, n] of held) {
        const s = offerSlots.get(k);
        if (!s) continue;
        const better = !pick || n > pick.n
          || (n === pick.n && (TIER_RANK[s.tier] > TIER_RANK[pick.s.tier]
            || (TIER_RANK[s.tier] === TIER_RANK[pick.s.tier] && s.born < pick.s.born)));
        if (better) pick = { k, n, s };
      }
      if (!pick) break;
      keep.add(pick.k);
      left = left.filter((row) => !row.slots.has(pick.k));
    }
    return keep;
  }

  /**
   * A slot for this caller, or null when every slot it may take holds the
   * proof path or outranks it. Within a pool the slot with the fewest proven
   * headers, then the smallest bucket, then the stalest is evicted.
   */
  function offerSlot(slotKey, tier) {
    let slot = offerSlots.get(slotKey);
    if (!slot) {
      const pool = poolOf(tier);
      const mates = [...offerSlots].filter(([, s]) => poolOf(s.tier) === pool);
      if (mates.length >= OFFER_PEER_SLOTS) {
        const keep = protectedSlots();
        const below = (x, y) => TIER_RANK[x.tier] - TIER_RANK[y.tier]
          || x.proven - y.proven || x.rows.size - y.rows.size || x.last - y.last;
        let worst = null;
        for (const [k, s] of mates) {
          if (keep.has(k) || TIER_RANK[s.tier] > TIER_RANK[tier]) continue;
          if (!worst || below(s, worst[1]) < 0) worst = [k, s];
        }
        if (!worst) return null;
        evictOfferSlot(worst[0]);
      }
      slot = { tier, rows: new Map(), proven: 0, last: 0, born: (offerSeq += 1), tokens: OFFER_RATE_BURST, tokAt: null };
      offerSlots.set(slotKey, slot);
    }
    slot.last = (offerSeq += 1);
    return slot;
  }

  function offerBudget(slot, nowMs) {
    if (slot.tier !== 'inbound' && slot.tier !== 'outbound') return Infinity;
    if (slot.tokAt != null) {
      const add = Math.max(0, nowMs - slot.tokAt) * (OFFER_RATE_PER_SEC / 1000);
      slot.tokens = Math.min(OFFER_RATE_BURST, slot.tokens + add);
    }
    slot.tokAt = nowMs;
    return Math.floor(slot.tokens);
  }

  function localBlockByHex(hex) {
    const t = tip();
    const tipHex = t?.hash ? blockHex(t) : '';
    if (localIndex.len !== blocks.length || localIndex.tipHex !== tipHex) {
      const map = new Map();
      for (let i = Math.max(0, blocks.length - LOCAL_HEADER_INDEX); i < blocks.length; i += 1) {
        map.set(blockHex(blocks[i]), blocks[i]);
      }
      localIndex = { len: blocks.length, tipHex, map };
    }
    return localIndex.map.get(hex) || null;
  }

  function localGenesisMs() {
    return blocks.length ? blockTimeMs(blocks[0]) : null;
  }

  /**
   * Cheap work check before a header is cached: it links to a known parent,
   * its ASERT bits and timestamp follow that parent, and its claimed hash
   * meets its own bits. No ShearHash runs here; proveBurial hashes the run
   * it uses. A bad link drops the peer. An unknown parent or a header ahead
   * of this clock is ignored.
   *
   * `tier` is 'inbound', 'outbound', 'pinned' or 'local' (the default, also
   * IPC). `group` is the inbound or outbound peer's /24 or /64. Inbound and
   * outbound slots read at most OFFER_RATE_BURST rows at once, refilled at
   * OFFER_RATE_PER_SEC; rows past that are skipped unread.
   */
  function offerHeaders(list, { peer = 'local', tier = 'local', group = '', nowMs = Date.now() } = {}) {
    const out = { accepted: 0, rejected: 0, limited: 0, dropped: false, refused: false };
    const key = String(peer || 'local');
    const kind = Object.prototype.hasOwnProperty.call(TIER_RANK, tier) ? tier : 'inbound';
    const slotKey = slotKeyOf(key, kind, String(group || ''));
    if (offerKeyDropped(key, nowMs) || offerKeyDropped(slotKey, nowMs)) {
      out.dropped = true;
      return out;
    }
    const slot = offerSlot(slotKey, kind);
    if (!slot) {
      out.refused = true;
      offerStats.refused += 1;
      return out;
    }
    const rows = Array.isArray(list) ? list : [];
    const budget = offerBudget(slot, nowMs);
    const take = Math.min(rows.length, budget);
    if (budget !== Infinity) slot.tokens -= take;
    out.limited = rows.length - take;
    offerStats.limited += out.limited;
    for (let r = 0; r < take; r += 1) {
      const raw = rows[r];
      let header;
      let hash;
      try {
        header = Buffer.isBuffer(raw?.header) ? Buffer.from(raw.header) : Buffer.from(String(raw?.header || ''), 'hex');
        hash = Buffer.isBuffer(raw?.hash) ? Buffer.from(raw.hash) : Buffer.from(String(raw?.hash || ''), 'hex');
      } catch { out.rejected += 1; continue; }
      if (header.length !== 128 || hash.length !== 32) { out.rejected += 1; continue; }
      const hex = hash.toString('hex');
      if (localBlockByHex(hex) || provenRows.has(hex)) continue;
      const known = offeredRows.get(hex);
      if (known) {
        if (!known.header.equals(header)) { out.dropped = true; break; }
        known.slots.add(slotKey);
        slot.rows.delete(hex);
        slot.rows.set(hex, true);
        continue;
      }
      let decoded;
      try { decoded = decodeHeader(header); } catch { out.dropped = true; break; }
      if (Number(decoded.timestamp) > nowMs + HEADER_AHEAD_MS) { offerStats.orphaned += 1; continue; }
      const prevHex = decoded.prevBlockHash.toString('hex');
      let parent = null;
      let rootMs = localGenesisMs();
      let checked;
      if (decoded.prevBlockHash.equals(GENESIS_PREV)) {
        if (blocks.length) { offerStats.orphaned += 1; continue; }
        checked = rootHeaderReason(header, hash, bookMagic);
        rootMs = Number(decoded.timestamp);
      } else {
        const local = localBlockByHex(prevHex);
        if (local) {
          parent = { header: Buffer.from(local.header), hash: Buffer.from(local.hash), height: Number(local.height) };
        } else {
          const up = headerRowOf(prevHex);
          if (up) {
            parent = up;
            if (rootMs == null) rootMs = up.rootMs;
          }
        }
        if (!parent) { offerStats.orphaned += 1; continue; }
        checked = headerLinkReason(header, hash, parent, { genesisMs: rootMs || 0, magic: bookMagic });
      }
      if (!checked.ok) { out.dropped = true; break; }
      const row = {
        hex,
        header,
        hash,
        prevHex,
        height: parent ? Number(parent.height) + 1 : 1,
        rootMs,
        seq: (offerSeq += 1),
        slots: new Set([slotKey]),
        senders: new Set([key]),
      };
      offeredRows.set(hex, row);
      linkHeaderRow(row);
      slot.rows.set(hex, true);
      out.accepted += 1;
      while (slot.rows.size > OFFER_PEER_CAP) {
        const old = slot.rows.keys().next().value;
        slot.rows.delete(old);
        releaseOffered(old, slotKey);
      }
    }
    if (out.dropped) {
      offerStats.rejected += 1;
      dropOfferPeer(key, slotKey, nowMs);
    }
    return out;
  }

  function rememberProvenRow(row) {
    let timeMs = Number(row.timeMs);
    if (!Number.isFinite(timeMs)) {
      try { timeMs = Number(decodeHeader(Buffer.from(row.header)).timestamp); } catch { timeMs = NaN; }
    }
    const kept = {
      hex: row.hex,
      header: row.header,
      hash: row.hash,
      prevHex: row.prevHex,
      height: row.height,
      rootMs: row.rootMs,
      timeMs,
    };
    provenRows.delete(row.hex);
    provenRows.set(row.hex, kept);
    linkHeaderRow(kept);
    for (const s of row.slots || []) {
      const slot = offerSlots.get(s);
      if (slot) slot.proven += 1;
    }
    while (provenRows.size > PROVEN_HEADER_CAP) {
      const old = provenRows.values().next().value;
      provenRows.delete(old.hex);
      unlinkHeaderRow(old.hex, old.prevHex);
    }
  }

  // Proven first, then the highest tier that offered it, then slots whose
  // headers proved out, then the first seen. A count of offering groups is
  // not a rank: sybils can always bring more groups than honest peers.
  function kidRank(hex) {
    if (provenRows.has(hex)) return [3, 0, 0];
    const row = offeredRows.get(hex);
    let rank = -1;
    let proven = 0;
    for (const s of row?.slots || []) {
      const slot = offerSlots.get(s);
      if (!slot) continue;
      rank = Math.max(rank, TIER_RANK[slot.tier]);
      proven = Math.max(proven, slot.proven);
    }
    return [rank, proven, -(row?.seq || 0)];
  }

  function rankOrder(a, b) {
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  }

  /** The deepest cached run above `fromHex`, up to `want` headers, by claimed links only. */
  function bestPath(fromHex, want) {
    const stack = [[fromHex, 0]];
    const trail = [];
    let best = [];
    const seen = new Set([fromHex]);
    while (stack.length) {
      const [hex, depth] = stack.pop();
      trail.length = Math.max(0, depth - 1);
      if (depth > 0) trail.push(hex);
      if (trail.length > best.length) best = trail.slice();
      if (trail.length >= want) break;
      const kids = headerKids.get(hex);
      if (!kids) continue;
      const next = [...kids].filter((k) => !seen.has(k) && headerRowOf(k));
      const ranks = new Map(next.map((k) => [k, kidRank(k)]));
      next.sort((a, b) => rankOrder(ranks.get(a), ranks.get(b)));
      for (const k of next) {
        seen.add(k);
        stack.push([k, depth + 1]);
      }
    }
    return { rows: best.map(headerRowOf) };
  }

  // A run of PRUNE cached headers above `fromHex`.
  function offeredPath(fromHex) {
    const { rows } = bestPath(fromHex, SAMPLE_PRUNE_CONFIRMATIONS);
    return rows.length >= SAMPLE_PRUNE_CONFIRMATIONS ? rows.slice(0, SAMPLE_PRUNE_CONFIRMATIONS) : null;
  }

  /**
   * A pruned block extending this tip needs SAMPLE_PRUNE_CONFIRMATIONS
   * proven-work headers above it before its sealed credits stand for the
   * share batch. Returns { ok, top, claimed }. `top` is the burial tip
   * verify and the owed step both use. Fewer headers, or one bad link, is
   * not burial. Each bad link drops the peers that offered it, so a retry
   * costs at most one hash batch per bad peer.
   */
  function proveBurial(block, verifyOpts = {}, anchor = null) {
    const parent = tip();
    // A fork block is not this tip plus one. The caller passes that block's
    // own height and the MTP of the chain under it. Null keeps the tip path.
    const anchored = !!(anchor && Number.isInteger(anchor.height) && anchor.height > 0);
    const h = anchored ? anchor.height : ((Number(parent?.height) || 0) + 1);
    const fail = { ok: false, reason: 'samples_pruned' };
    let claimed;
    let own;
    try {
      claimed = Buffer.from(block.hash);
      own = decodeHeader(Buffer.from(block.header));
    } catch { return fail; }
    if (claimed.length !== 32) return fail;
    const genesisMs = anchored && Number(anchor.genesisMs) > 0
      ? Number(anchor.genesisMs)
      : (blocks.length ? blockTimeMs(blocks[0]) : Number(own.timestamp));
    const mtp = anchored && Array.isArray(anchor.mtp) && anchor.mtp.length
      ? anchor.mtp.slice()
      : blocks.slice(-(MTP_WINDOW - 1)).map(blockTimeMs).concat([Number(own.timestamp)]);
    const nowMs = verifyOpts.nowMs != null ? verifyOpts.nowMs : Date.now();
    const trust = verifyOpts.trustBlockHash === true;
    const standIn = verifyOpts.trustedHeaderHashes instanceof Set ? verifyOpts.trustedHeaderHashes : null;
    const known = (row) => trust || provenRows.has(row.hex) || !!standIn?.has(row.hex);
    const attempt = (tries) => {
      const rows = offeredPath(claimed.toString('hex'));
      if (!rows) return fail;
      let up = { header: Buffer.from(block.header), hash: claimed, height: h };
      const window = mtp.slice();
      const link = (i, ready) => {
        const got = Buffer.from(ready || []);
        const row = rows[i];
        // This header's ShearHash and link already passed. Walk the cached
        // timestamp so the next new header still sees a real MTP window.
        if (
          known(row)
          && got.length === 32
          && got.equals(row.hash)
          && row.prevHex === up.hash.toString('hex')
          && Number.isFinite(row.timeMs)
        ) {
          window.push(row.timeMs);
          if (window.length > MTP_WINDOW) window.shift();
          up = { header: row.header, hash: row.hash, height: h + i + 1 };
          return true;
        }
        const linked = got.equals(row.hash)
          ? headerLinkReason(row.header, got, up, { genesisMs, mtpTimestamps: window, nowMs, magic: bookMagic })
          : { ok: false };
        if (!linked.ok) {
          const bad = offeredRows.get(row.hex);
          const senders = [...(bad?.senders || [])];
          for (const slotKey of [...(bad?.slots || [])]) {
            for (const p of senders) dropOfferPeer(p, slotKey, nowMs);
            if (!senders.length) evictOfferSlot(slotKey);
          }
          if (provenRows.has(row.hex)) {
            provenRows.delete(row.hex);
            unlinkHeaderRow(row.hex, row.prevHex);
          }
          return false;
        }
        if (!trust) rememberProvenRow(offeredRows.get(row.hex) || row);
        window.push(Number(linked.decoded.timestamp));
        if (window.length > MTP_WINDOW) window.shift();
        up = { header: rows[i].header, hash: rows[i].hash, height: h + i + 1 };
        return true;
      };
      const proven = { ok: true, top: h + rows.length, claimed };
      const retry = () => (tries > 0 ? attempt(tries - 1) : fail);
      if (!verifyOpts.offLoopPow || rows.every(known)) {
        for (let i = 0; i < rows.length; i += 1) {
          let got = rows[i].hash;
          if (!known(rows[i])) {
            got = headerHash(rows[i].header);
            offerStats.hashed += 1;
          }
          if (!link(i, got)) return retry();
        }
        return proven;
      }
      const batch = async () => {
        // Start small and grow, so a bad run costs a couple of hashes, not a full batch.
        let size = 2;
        for (let i = 0; i < rows.length; i += size, size = Math.min(PROOF_HASH_BATCH, size * 2)) {
          const part = rows.slice(i, i + size);
          const hashes = await Promise.all(part.map((row) => {
            if (known(row)) return row.hash;
            offerStats.hashed += 1;
            return hashHeaderOffLoop(row.header);
          }));
          for (let j = 0; j < part.length; j += 1) {
            if (!link(i + j, hashes[j])) return retry();
          }
        }
        return proven;
      };
      return batch().catch(() => fail);
    };
    return attempt(2 * OFFER_PEER_SLOTS + 1);
  }

  /**
   * The block this store serves for getblock. A held body comes back whole.
   * A pruned block this tip does not bury, with no held body, is not served:
   * the asking peer could not bury it either.
   */
  function servableBlock(block) {
    if (!block || block.samplesPruned !== true) return block || null;
    const lifted = liftPrunedBlock(block);
    if (lifted) return lifted;
    const tipH = Number(tip()?.height) || 0;
    return shouldPruneSamples(Number(block.height) || 0, tipH) ? block : null;
  }

  /**
   * A field an arrived block may not carry, read on the block as it arrived,
   * before arrivedBody compacts it (crypto/arrival_fields.js): compaction
   * strips secrets and local-only fields and never decides validity. The
   * refusal rides in verifyOpts.arrivalRefusal and is applied once the
   * compact body verifies, before anything is stored or staged, so a block
   * that fails consensus keeps its own reason. Null when every row may be
   * carried.
   */
  function arrivalReason(blocks) {
    const list = Array.isArray(blocks) ? blocks : [blocks];
    for (let i = 0; i < list.length; i += 1) {
      const refused = blockArrivalRejected(list[i]);
      if (refused) return { ok: false, reason: refused.reason, field: refused.field, at: i };
    }
    return null;
  }

  /**
   * The verdicts verifyBlock gave on each arrived block's full rows, by
   * header (chain.js arrivedRowsKey), or null: `early`, the row checks it
   * ran before proof of work (chain.js earlyRowsRejected), and `opening`,
   * its first body check (spend.js openingBeforeCarry). Compaction strips
   * fields both read, so verifyBlock returns them from here at those same
   * points: a block keeps the reason its full body had.
   */
  function arrivedRows(blocks) {
    const list = Array.isArray(blocks) ? blocks : [blocks];
    let out = null;
    for (const b of list) {
      const early = earlyRowsRejected(b);
      let opening = null;
      for (const tx of Array.isArray(b?.txs) ? b.txs : []) {
        opening = openingBeforeCarry(tx);
        if (opening) break;
      }
      if (!early && !opening) continue;
      const key = arrivedRowsKey(b);
      if (key) (out ||= new Map()).set(key, { early, opening });
    }
    return out;
  }

  /** verifyOpts carrying the arrival refusal and full-row verdicts of `arrived`, if it has them. */
  function withArrival(arrived, verifyOpts = {}) {
    if (verifyOpts?.arrivalRefusal || verifyOpts?.arrivedRows) return verifyOpts;
    const refused = arrivalReason(arrived);
    const rows = arrivedRows(arrived);
    if (!refused && !rows) return verifyOpts;
    return {
      ...verifyOpts,
      ...(refused ? { arrivalRefusal: refused } : {}),
      ...(rows ? { arrivedRows: rows } : {}),
    };
  }

  /**
   * The arrival refusal as a result, for a block that verified. The compact
   * body the header commits passed, so the fault is only in the rows the
   * peer sent: peerOnly (p2p scores that peer and never soft-notes the hash).
   */
  function arrivalRefused(verifyOpts) {
    const r = verifyOpts?.arrivalRefusal;
    return r ? { ok: false, reason: r.reason, field: r.field, at: r.at, peerOnly: true, tip: tip() } : null;
  }

  /**
   * A block as it is validated: its txs in the compact form it is stored,
   * served, read back and hashed in (chain.js digestTx). A field compaction
   * drops, added or changed by a relayer, so never reaches a check.
   * Coinbase samples move to the block, as leanBlock stores them.
   */
  function arrivedBody(block) {
    if (!block || typeof block !== 'object' || !Array.isArray(block.txs)) return block;
    const cb = block.txs[0];
    const samples = Array.isArray(block.samples) ? block.samples : (cb?.coinbase && Array.isArray(cb.samples) ? cb.samples : block.samples);
    return { ...block, samples, txs: block.txs.map((tx) => {
      if (tx?.coinbase) {
        if (!Object.prototype.hasOwnProperty.call(tx, 'samples')) return compactOrSame(tx, compactTx(tx));
        const { samples: _s, ...rest } = tx;
        return compactTx({ ...rest, coinbase: true });
      }
      return compactOrSame(tx, compactTx(tx));
    }) };
  }

  /**
   * A row that arrived already compact (a peer's block, a block read back
   * from disk) is validated as that object, not a byte-identical copy
   * (Russell 26 Oct, ruling B: keep). It is that object only when
   * sameCompactShape says it equals its compact form exactly, so the verdict
   * is the one the copy would get: it can never make an invalid body valid.
   * Why it is kept: the read walk (tests/compact_reads.js) watches the
   * objects validators read, and on the reserve kinds a fresh copy hid
   * those reads (two mutations went uncaught without it). Its cost is one
   * strict deep compare per tx.
   */
  function compactOrSame(tx, compact) {
    return sameCompactShape(tx, compact) ? tx : compact;
  }

  /**
   * Header rules and proof-of-work before any book walk. An invalid header
   * must not scan sealed hashes, decode every gap, or copy the owed series.
   * A trusted hash, an off-loop hash, or a pruned burial still uses the
   * full append path. Returns a reason, or null when the header may proceed.
   */
  function unprovenAppendReason(block, verifyOpts) {
    if (verifyOpts?.offLoopPow || verifyOpts?.probeBody === true) return null;
    if (block?.samplesPruned === true) return null;
    if (trustedHashFor(block, verifyOpts)) return null;
    const observed = coinbaseObserveRejected(block?.txs);
    if (observed) return observed.reason || 'observe_unattested';
    const stage0 = chainStage0Rejected([block]);
    if (stage0) return stage0.reason || 'stage0';
    for (const tx of block?.txs || []) {
      const unsignedField = unsignedBodyField(tx);
      if (unsignedField) return unsignedField.reason || 'unsigned';
    }
    const prev = tip();
    const assessed = assessHeader(block, prev ? {
      hash: prev.hash,
      header: prev.header,
      height: prev.height,
      rootA: prev.rootA,
      rootB: prev.rootB,
      txs: prev.txs,
      bLeaves: prev.bLeaves,
      weight: prev.weight,
      shareBatch: prev.shareBatch,
      blunoteRecord: prev.blunoteRecord,
    } : null, {
      mtpTimestamps: blocks.slice(-11).map((b) => {
        try { return Number(decodeHeader(Buffer.from(b.header)).timestamp); } catch { return 0; }
      }),
      nowMs: Date.now(),
      genesisMs: (() => {
        try {
          const g = blocks[0];
          if (!g?.header) return 0;
          return Number(decodeHeader(Buffer.from(g.header)).timestamp) || 0;
        } catch { return 0; }
      })(),
      magic: bookMagic,
      consumePrepared: false,
    });
    if (assessed?.ok) return null;
    let claimed = null;
    try {
      if (block?.hash != null) {
        const raw = Buffer.from(block.hash);
        if (raw.length === 32) claimed = raw;
      }
    } catch { claimed = null; }
    if (claimed && block?.header) {
      try {
        const header = Buffer.from(block.header);
        if (header.length === HEADER_LEN) {
          // assessHeader stashed the hash when it got that far; hash once.
          const got = preparedHeaderHash(header) || Buffer.from(headerHash(header));
          if (!claimed.equals(got)) {
            discardPreparedHeader(block.header);
            return 'hash_claim';
          }
        }
      } catch { /* keep the assess reason */ }
    }
    discardPreparedHeader(block?.header);
    return assessed?.reason || 'pow';
  }

  /** Header-target options for a block on this tip. The book's own magic. */
  function tipExtendPowOpts(nowMs = Date.now()) {
    const n = blocks.length;
    return {
      grandparentHeader: n >= 2 ? blocks[n - 2]?.header || null : null,
      magic: bookMagic,
      nowMs,
    };
  }

  function tipPowView(t) {
    return {
      hash: t.hash,
      header: t.header,
      height: t.height,
      txs: t.txs,
      bLeaves: t.bLeaves,
      weight: t.weight,
      shareBatch: t.shareBatch,
      rootA: t.rootA,
      rootB: t.rootB,
    };
  }

  function extendsThisTip(block) {
    const t = tip();
    if (!t?.hash || !t.header || !block?.header) return false;
    try {
      return decodeHeader(Buffer.from(block.header)).prevBlockHash.equals(Buffer.from(t.hash));
    } catch {
      return false;
    }
  }

  /**
   * Off-loop header target for one block on this tip, before its claimed hash
   * is compared to the book. `{ applies: false }` for any other block.
   * `release` drops the stash when the full check does not consume it.
   */
  function tipExtendPowReason(block, nowMs = Date.now()) {
    if (!extendsThisTip(block)) return Promise.resolve({ applies: false });
    return headerPowReason(block, tipPowView(tip()), tipExtendPowOpts(nowMs)).then((early) => (
      early.reason
        ? { applies: true, reason: early.reason }
        : { applies: true, reason: null, release: early.release }
    ));
  }

  function append(arrived, verifyOpts = {}) {
    verifyOpts = withArrival(arrived, verifyOpts);
    const block = arrivedBody(arrived);
    const early = unprovenAppendReason(block, verifyOpts);
    if (early) return { ok: false, reason: early, tip: tip() };
    // The off-loop path proves the header target here, so every caller of
    // append is gated, not only p2p. A trusted hash is the caller's own proof.
    // samplesPruned is wire data and does not skip it: an unburied pruned
    // header skips only the slot commitment, never the target.
    const offLoopGate = !!verifyOpts.offLoopPow
      && verifyOpts.probeBody !== true
      && !trustedHashFor(block, verifyOpts)
      && extendsThisTip(block);
    if (offLoopGate) {
      return tipExtendPowReason(block).then((gate) => {
        if (gate.reason) return { ok: false, reason: gate.reason, tip: tip() };
        return Promise.resolve().then(() => appendProven(block, verifyOpts)).then((out) => {
          gate.release?.();
          return out;
        }, (err) => {
          gate.release?.();
          throw err;
        });
      });
    }
    return appendProven(block, verifyOpts);
  }

  function appendProven(block, verifyOpts) {
    const claimedHash = () => {
      try {
        if (block?.hash == null) return null;
        const raw = Buffer.from(block.hash);
        return raw.length === 32 ? raw : null;
      } catch {
        return null;
      }
    };
    // The id is the hash we computed. A present block.hash that differs is a
    // claim lie, before the book treats that claim as a duplicate.
    const judged = (computed) => {
      const claimed = claimedHash();
      if (claimed && computed && computed.length === 32 && !claimed.equals(computed)) {
        discardPreparedHeader(block?.header);
        return { ok: false, reason: 'hash_claim', tip: tip() };
      }
      if (computed && computed.length === 32) {
        for (const b of blocks) {
          if (b.hash && Buffer.from(b.hash).equals(computed)) {
            discardPreparedHeader(block?.header);
            return { ok: false, reason: 'not_heavier', tip: tip() };
          }
        }
      }
      return null;
    };
    const trusted = trustedHashFor(block, verifyOpts);
    if (trusted && trusted.length === 32) {
      const stop = judged(Buffer.from(trusted));
      if (stop) return stop;
      return appendProvenBody(block, verifyOpts);
    }
    const claimed = claimedHash();
    if (claimed) {
      const provenHex = String(verifyOpts?.provenHeaderHash || '').toLowerCase();
      if (/^[0-9a-f]{64}$/.test(provenHex)) {
        const stop = judged(Buffer.from(provenHex, 'hex'));
        if (stop) return stop;
        return appendProvenBody(block, verifyOpts);
      }
      let header = null;
      try { if (block?.header) header = Buffer.from(block.header); } catch { header = null; }
      if (!header || header.length !== HEADER_LEN) {
        discardPreparedHeader(block?.header);
        return { ok: false, reason: 'hash_claim', tip: tip() };
      }
      const finish = (buf) => {
        try { holdPreparedHeader(header, buf); } catch { /* verify hashes again */ }
        const stop = judged(Buffer.from(buf));
        if (stop) return stop;
        return appendProvenBody(block, verifyOpts);
      };
      if (verifyOpts.offLoopPow) return hashHeaderOffLoop(header).then(finish);
      return finish(headerHash(header));
    }
    return appendProvenBody(block, verifyOpts);
  }

  function appendProvenBody(block, verifyOpts) {
    if (block?.samplesPruned === true) {
      // No proven run is samples_pruned before any header hash. A height field
      // that is not this tip plus one still answers height first.
      const structuralH = (Number(tip()?.height) || 0) + 1;
      const liedHeight = block.height != null && block.height !== '' && Number(block.height) !== structuralH;
      // One or two new headers still have to hash. The block header can hash
      // on the other worker at the same time. A long run keeps both workers.
      // Advertised height is not an input. A failed run discards the hash.
      let earlyHash = null;
      const overlapPow = !!verifyOpts.offLoopPow
        && !verifyOpts.trustedPowHash
        && verifyOpts.trustBlockHash !== true
        && block.header;
      if (overlapPow) {
        let claimedHex = '';
        try { claimedHex = Buffer.from(block.hash).toString('hex'); } catch { claimedHex = ''; }
        const rows = claimedHex ? offeredPath(claimedHex) : null;
        if (rows) {
          let unknown = 0;
          for (const row of rows) {
            if (!provenRows.has(row.hex)) unknown += 1;
            if (unknown > 2) break;
          }
          if (unknown >= 1 && unknown <= 2) {
            earlyHash = hashHeaderOffLoop(Buffer.from(block.header)).then((hash) => {
              holdPreparedHeader(block.header, hash);
              return hash;
            }, () => null);
          }
        }
      }
      const proved = proveBurial(block, verifyOpts);
      const go = (p) => {
        if (p.ok) return appendVerified(block, verifyOpts, p);
        if (liedHeight) return appendVerified(block, verifyOpts, null);
        if (earlyHash) discardPreparedHeader(block.header);
        return { ok: false, reason: 'samples_pruned', tip: tip() };
      };
      const waitEarly = earlyHash || Promise.resolve(null);
      if (proved && typeof proved.then === 'function') return Promise.all([proved, waitEarly]).then(([p]) => go(p));
      if (earlyHash) return waitEarly.then(() => go(proved));
      return go(proved);
    }
    return appendVerified(block, verifyOpts, null);
  }

  function appendVerified(block, verifyOpts, burial) {
    return evmExclusive(block, () => appendVerifiedNow(block, verifyOpts, burial));
  }

  function appendVerifiedNow(block, verifyOpts, burial) {
    // The tip this block was verified against. An off-loop or EVM verify
    // settles later, and an ingest or adopt may move the tip meanwhile.
    const parentAtStart = tip();
    const { check, spentBefore } = verifyAgainstTip(block, {
      trustedPowHash: trustedHashFor(block, verifyOpts),
      skipSharePow: !!verifyOpts.skipSharePow,
      offLoopPow: !!verifyOpts.offLoopPow,
      poolDest: verifyOpts.poolDest,
      arrivedRows: verifyOpts.arrivedRows,
      ...(burial ? { burialTip: burial.top } : {}),
    });
    // Test hook (node:test or the regtest book only, as the other fault
    // hooks): an awaited step between verify and store, where a test moves
    // the tip, so the tip re-check below is reached on demand.
    const beforeStore = faultHooks && typeof verifyOpts.beforeStore === 'function' ? verifyOpts.beforeStore : null;
    const after = (c) => (beforeStore && c?.ok
      ? Promise.resolve(beforeStore()).then(() => storeChecked(c))
      : storeChecked(c));
    const storeChecked = (c) => {
      let claimedNow = null;
      try {
        if (block?.hash != null) {
          const raw = Buffer.from(block.hash);
          if (raw.length === 32) claimedNow = raw;
        }
      } catch { claimedNow = null; }
      let computedNow = null;
      try {
        if (c?.hash) {
          const raw = Buffer.from(c.hash);
          if (raw.length === 32) computedNow = raw;
        }
      } catch { computedNow = null; }
      if (claimedNow && computedNow && !claimedNow.equals(computedNow)) {
        rollbackSpent(spentB, spentBefore);
        discardPreparedHeader(block?.header);
        return { ok: false, reason: 'hash_claim', tip: tip() };
      }
      // A failed consensus check keeps its own reason. The vault clock is a
      // second gate only after the block verifies.
      if (!c?.ok) {
        rollbackSpent(spentB, spentBefore);
        return c;
      }
      // The tip moved while this block verified: it no longer extends the
      // tip, so it is not stored on top of another chain. prev is retryable.
      if (tip() !== parentAtStart) {
        rollbackSpent(spentB, spentBefore);
        return { ok: false, reason: 'prev', tip: tip() };
      }
      // The proven header run hangs off the claimed hash. Verify hashed the header.
      if (burial && !(c.hash && Buffer.from(c.hash).equals(burial.claimed))) {
        rollbackSpent(spentB, spentBefore);
        return { ok: false, reason: 'pow', tip: tip() };
      }
      // A field the block may not carry, read before compaction.
      const carried = arrivalRefused(verifyOpts);
      if (carried) {
        rollbackSpent(spentB, spentBefore);
        return carried;
      }
      const vaultClock = blockTimeMs(block);
      for (const tx of (block.txs || []).slice(1)) {
        const pay = payoutOnTip(tx, vaultClock);
        if (!pay.ok) {
          rollbackSpent(spentB, spentBefore);
          return pay;
        }
      }
      block.bSpendIds = spentDelta(spentBefore, spentB);
      return settleCheck(c, (okCheck) => completeAppend(okCheck, block, burial));
    };
    // The block's EVM checkpoint (chain.js verifyBlockEvm) is committed only
    // when the block is stored; any later refusal reverts it, so the node's
    // EVM state never holds the calls of a block it did not append.
    const settled = (c) => {
      if (!c?.evmOpen) return after(c);
      const sm = c.evmSession?.evm?.stateManager;
      let out;
      try {
        out = after(c);
      } catch (err) {
        return Promise.resolve(sm.revert()).then(() => { throw err; });
      }
      const close = (o) => Promise.resolve(o?.ok ? sm.commit() : sm.revert()).then(() => o);
      if (out && typeof out.then === 'function') {
        return out.then(close, (err) => Promise.resolve(sm.revert()).then(() => { throw err; }));
      }
      return close(out);
    };
    if (check && typeof check.then === 'function') return check.then(settled);
    return settled(check);
  }

  function stageFaultRow(i, block, verifyOpts) {
    if (injectedFault !== 'stage') return null;
    if (!Number.isInteger(verifyOpts?.stageAt) || verifyOpts.stageAt !== i) return null;
    return {
      ok: false,
      reason: 'apply_stage',
      at: i,
      header: block?.header,
      tip: tip(),
    };
  }

  function completeAppend(check, block, burial = null) {
    let staged;
    try {
      staged = stageAppend(check, block, burial);
    } catch (err) {
      // A throw here is local state, still before owedRows is replaced.
      // The block stays retryable and the node stays up. The peer is not
      // scored: the same local bug would otherwise ban every relayer.
      // The log is the ops signal. The reason the peer sees is stable.
      const detail = String(err?.message || 'apply').slice(0, 80);
      try {
        console.error(JSON.stringify({ event: 'apply_stage', ok: false, reason: detail }));
      } catch { /* ignore */ }
      return {
        ok: false,
        reason: 'apply_stage',
        at: 0,
        header: block?.header,
        tip: tip(),
      };
    }
    if (!staged || staged.ready !== true) return staged;
    try {
      return commitStagedAppend(staged);
    } catch (err) {
      throw asCommitFault(err, 'mid-commit');
    }
  }

  // Everything through the hash-owed check. Nothing here writes the book.
  function stageAppend(check, block, burial = null) {
    if (!check.ok) return check;
    if (!check.supplyState) return { ok: false, reason: 'supply_state' };
    const prev = tip();
    const full = {
      ...block,
      magic: bookMagic,
      hash: check.hash,
      // R28: the block's compact record, from its own verify.
      ...(check.blunoteRecord ? { blunoteRecord: check.blunoteRecord } : {}),
      height: prev ? prev.height + 1 : 1,
      weight: block.weight ?? blockWeight(block.txs || [], block.bLeaves || []),
    };
    const unitNow = hashBonusUnitNanos(reserveVault.liveHashBonusNanos);
    stampCredits(full, unitNow);
    const stored = leanBlock(full);
    const owedNext = advanceHashOwed({
      owedIn: owedRows,
      acceptedSeries,
      block: stored,
      unit: unitNow,
      // Verify buried a pruned block under the proven header run. Commit uses that same tip.
      tipHeight: burial ? burial.top : full.height,
    });
    if (!owedNext.ok) return { ok: false, reason: owedNext.reason || 'hash_owed', tip: tip() };
    if (injectedFault === 'hash-owed') return { ok: false, reason: 'hash_owed', tip: tip() };
    if (injectedFault === 'stage') throw new Error('stage_local');
    return { ok: true, ready: true, stored, owedNext, unitNow, burial, check };
  }

  function commitStagedAppend({ stored, owedNext, unitNow, burial, check }) {
    if (injectedFault === 'append') throw new Error('append_fault');
    owedRows = owedNext.rows;
    acceptedSeries = owedNext.acceptedSeries;
    owedSeriesAll = acceptedSeries;
    unitAt.push(unitNow);
    indexSealed(stored);
    applyReserve(stored);
    blocks.push(stored);
    if (burial) {
      // Saved before the block is, so a restart never loads it without its burial.
      burialProof.note(blockHex(stored), stored.height, burial.top);
      burialProof.save();
    }
    syncNoteLedger(blocks);
    rememberOwed(blocks.length - 1);
    rememberVault(blocks.length - 1);
    refreshVaultSeal();
    syncBlankFlag();
    saveReserve();
    liveFlux = applyBlockToFluxset(liveFlux, stored);
    dropStaleFlowSpends();
    const idx = stored.height - 1;
    supplyTip = check.supplyState;
    supplyAt[idx] = supplyTip;
    if (idx > 0 && !keepOwedIndex(idx - 1, idx)) {
      const priorSupply = supplyAt[idx - 1];
      if (priorSupply) supplyAt[idx - 1] = supplyFromScalar(priorSupply, { owedKnown: false });
    }
    anchorAt[stored.height] = anchorRecord(liveFlux, true);
    releaseExitedFrontier(stored.height);
    persist(stored);
    noteAppendedBlock();
    rememberHeaders([stored], 'active');
    {
      // The block's own bodies, by key: a sealed tx that only carries a held
      // tx's id does not evict it. A held body whose note the block spent goes.
      const sealedKeys = new Set((stored.txs || []).slice(1).map(txBodyKey).filter(Boolean));
      const spentNow = liveFlux?.spendTags || new Set();
      for (let i = mempool.length - 1; i >= 0; i -= 1) {
        const row = mempool[i];
        const sealedHit = sealedKeys.has(heldBodyKey(row));
        const tagHit = txSpendTags(row).tags.some((tag) => spentNow.has(tag.toString('hex')));
        if (sealedHit || tagHit) mempool.splice(i, 1);
      }
    }
    for (const tx of (stored.txs || []).slice(1)) {
      if (String(tx.kind || '') === 'vortice-register' && typeof vortice.registerFromTx === 'function') {
        vortice.registerFromTx(tx);
      }
    }
    pruneBuried();
    maybeSnap(stored.height);
    try {
      const bf = Number(decodeHeader(Buffer.from(stored.header)).baseFee || 1n);
      const book = emptyMempool();
      book.txs = mempool.slice();
      const { dropped } = retargetMempool(book, bf);
      mempool.length = 0;
      mempool.push(...book.txs);
      syncMempoolTags();
      void dropped;
    } catch { /* keep */ }
    mempoolVault = null;
    refreshPolicy({ newBlock: true, nowMs: blockTimeMs(stored) });
    emit('tip', { hash: hex32(stored.hash), height: stored.height });
    if (check.evmSession) evmSession = check.evmSession;
    // The active tip grew. The other branch stays, so a later heavier child of it can still win.
    return { ok: true, block: stored, evmSession: check.evmSession || evmSession };
  }

  function sealedSpendDigests() {
    syncNoteLedger(blocks);
    return new Set(noteLedger.spendDigests());
  }

  function rootHex(jroot) {
    try {
      if (!jroot) return '';
      const b = Buffer.from(asU8(jroot));
      return b.length === 32 ? b.toString('hex') : '';
    } catch {
      return '';
    }
  }

  function fundVerdictFor(tx) {
    const height = Number(tip()?.height || 0) + 1;
    const anchored = checkAdmitAnchor(tx, height);
    if (!anchored.ok || anchored.anchor == null) return null;
    const anchor = Number(anchored.anchor);
    if (!Number.isInteger(anchor)) return null;
    const rec = noteFromAnchor(liveFlux, anchorAt, anchor);
    const root = rootHex(rec?.jroot);
    if (!root) return null;
    return readFundVerdict(tx, tip(), anchor, root);
  }

  /** Apply each mempool reserve tx once onto a clone of the chain vault. */
  function ensureMempoolVault(nowMs) {
    if (mempoolVault) return mempoolVault;
    let carried = cloneVault(reserveVault);
    let n = 0;
    let retireUsed = 0;
    for (const row of mempool) {
      if (!txIsReserveAction(row)) continue;
      if (n >= RESERVE_ACTION_CAP) break;
      const adding = txRetireDleqs(row);
      if (retireCapHit(retireUsed, row)) continue;
      const tried = trialReserveApply({ state: carried, txs: [row], nowMs, inPlace: true });
      if (!tried.ok) continue;
      carried = tried.state;
      n += 1;
      if (adding != null) retireUsed += adding;
    }
    mempoolVault = carried;
    return mempoolVault;
  }

  function insertMempool(run) {
    const snapTxs = mempool.slice();
    const snapTags = new Map(mempoolTags);
    const snapVault = mempoolVault;
    try {
      return run();
    } catch (err) {
      mempool.length = 0;
      mempool.push(...snapTxs);
      mempoolTags.clear();
      for (const [key, val] of snapTags) mempoolTags.set(key, val);
      mempoolVault = snapVault;
      return {
        ok: false,
        reason: String(err?.message || 'mempool').slice(0, 80),
        scorePeer: true,
      };
    }
  }

  function queueTx(tx, opts = {}) {
    if (injectedFault === 'mempool') {
      return insertMempool(() => {
        mempool.push({ id: 'partial' });
        throw new Error('mempool_partial');
      });
    }
    const capped = txIoCap(tx);
    if (!capped.ok) return capped;
    const budget = txBudget(tx);
    if (!budget.ok) return budget;
    const owedRaw = Number(opts && opts.paintedOwedNanos);
    const paintedOwedNanos = Number.isFinite(owedRaw) && owedRaw > 0 ? Math.floor(owedRaw) : 0;
    tx = reviveTx(tx);
    const feeHit = feeFieldRejected(tx);
    if (feeHit) return feeHit;
    const spendFee = bSpendFeeRejected(tx);
    if (spendFee) return spendFee;
    const bucket = v3BucketProofRejected(tx);
    if (bucket) return bucket;
    const noteRule = txNoteRuleRejected(tx, 1);
    if (noteRule) return noteRule;
    // The fee note stays in the wallet. Naming it is vote_leak, not an unknown field.
    const leakedVote = leafVoteLeakRejected(tx);
    if (leakedVote) return leakedVote;
    const leakedLock = compactLockLeakRejected(tx);
    if (leakedLock) return leakedLock;
    const leakedWithdraw = withdrawLeakRejected(tx);
    if (leakedWithdraw) return leakedWithdraw;
    const unsignedField = unsignedBodyField(tx);
    if (unsignedField) return unsignedField;
    // Name a disabled pool-withdraw before the kind gate. That kind is not a
    // v12 value kind, so the later reject would hide this reason.
    const pull = custodialPullRejected(tx);
    if (pull) return pull;
    const earlyOpen = openingBeforeCarry(tx);
    if (earlyOpen) return earlyOpen;
    // A refused kind that spends a note without a signature is unsigned.
    // A signed refused kind, and a refused kind with no note, stay kind.
    const unsignedNote = unsignedRefusedSpend(tx);
    if (unsignedNote) return unsignedNote;
    // A refused kind returns kind before an unbound proof, tag, or commit vin
    // is membership. Lock, vote, and withdraw still fail that vin as
    // admit_membership. The custodial_pull gate above stays first.
    const kindGate = v12KindRejected(tx);
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
    const vinAdmit = bSpendVinRejected(tx);
    if (vinAdmit) return vinAdmit;
    if (String(tx.kind || '') === 'b-spend') {
      const tipNow = tip();
      let boundB;
      try {
        boundB = bindBSpend(tx, {
          history: blocks,
          prev: tipNow,
          tipHeight: Number(tipNow?.height || 0) + 1,
          spent: new Set(spentB),
        });
      } catch {
        return { ok: false, reason: 'leaf' };
      }
      if (!boundB || !boundB.ok) return boundB || { ok: false, reason: 'leaf' };
    }
    if (pause.poolWithdraw && String(tx?.kind || '') === 'pool-withdraw') {
      return { ok: false, reason: 'paused' };
    }
    const bound = verifyPoolWithdrawBound(tx);
    if (!bound.ok) return bound;
    let base = 1;
    const t = tip();
    try {
      if (t?.header) base = Number(decodeHeader(Buffer.from(t.header)).baseFee || 1n);
    } catch { base = 1; }
    // Same byte rule as verify and the mempool. A lock commit vin already
    // returned admit_membership above. A refused kind already returned kind.
    // A membership shape has no version byte. The version gate refuses it
    // before any tag parse, so an arrival is not counted as a parse.
    const flowVersion = v12FlowVersionRejected(tx);
    if (flowVersion) return flowVersion;
    const anchored = checkAdmitAnchor(tx, Number(t?.height || 0) + 1);
    if (!anchored.ok) return anchored;
    const book = emptyMempool();
    book.txs = mempool;
    book.tagIndex = mempoolTags;
    // A held body is known by its key (txBodyKey), not by the id its sender
    // picks. The same body again is a duplicate. Another body under a held id
    // that spends a note the held body spends is that sender changing a queued
    // tx: refused, so an ok never tells a wallet its changed body is in. Any
    // other body under that id is judged on its own: a label cannot keep a
    // real tx out.
    const bodyKey = txBodyKey(tx);
    if (bodyKey && mempool.some((m) => heldBodyKey(m) === bodyKey)) return { ok: true, tx, duplicate: true };
    const id = String(tx?.id || '');
    if (id && mempool.some((m) => String(m.id) === id && spendsHeldNote(m, tx))) {
      return { ok: false, reason: 'id_reused' };
    }
    const debitNow = fundedDebit(tx);
    // Chain notes minus every queued debit from this dest. paintedOwedNanos is the
    // pull book's full owed, not the remainder after those debits, so this is the
    // only subtraction. A remainder posted here would refuse a second painted spend.
    const chainHave = debitNow
      ? destSpendableNanos(debitNow.from, Number(t?.height || 0)) - mempoolDebitNanos(mempool, debitNow.from)
      : 0;
    // Owed nanos come from the pool pull book, not from the tx. A note vin never qualifies.
    const paintedHold = !!(debitNow
      && paintedSpendSig(tx)
      && chainHave < debitNow.nanos
      && chainHave + paintedOwedNanos >= debitNow.nanos);
    const selfId = bodyKey;
    const chainTags = liveFlux.spendTags;
    const spentNow = {
      has(tag) {
        const hex = String(tag);
        if (chainTags && typeof chainTags.has === 'function' && chainTags.has(hex)) return true;
        if (!mempoolTags.has(hex)) return false;
        const owner = String(mempoolTags.get(hex) || '');
        return !(selfId && owner === selfId);
      },
    };
    if (flowNeedsDummy(tx)) {
      const boundIns = flowInputsBound(tx);
      if (!boundIns.ok) return boundIns;
      const parsed = txSpendTags(tx);
      const hasProof = parsed.proofs.length > 0;
      if (!hasProof && !paintedHold) return { ok: false, reason: 'admit_membership' };
      if (hasProof) {
      if (!parsed.ok && parsed.reason === 'admit_tag') return { ok: false, reason: 'admit_tag' };
      const live = liveFlux;
      const rlen = Array.isArray(tx.admit_proof?.r) ? tx.admit_proof.r.length : -1;
      const n = (live.pubs || []).length;
      const flowProof = verifyFlowAdmitV3(tx, {
        height: Number(t?.height || 0) + 1,
        blocks,
        spentTags: spentNow,
        magic: bookMagic,
        noteAtAnchor: (anchor) => noteFromAnchor(liveFlux, anchorAt, anchor),
      });
      if (!flowProof.ok) {
        try {
          console.error(JSON.stringify({
            event: 'admit_fail',
            why: 'flow_v3',
            reason: String(flowProof.reason || ''),
            id: String(tx?.id || ''),
            n,
            rlen,
          }));
        } catch { /* ignore */ }
        return flowProof;
      }
      if (!parsed.ok) return { ok: false, reason: parsed.reason || 'admit_link_tag' };
      }
    }
    const typed = typedCommitRejected(tx);
    if (typed) return typed;
    const clockField = typedClockRejected(tx);
    if (clockField) return clockField;
    const receiptPub = receiptAdmitRejected(tx);
    if (receiptPub) return receiptPub;
    // Membership already named a commit vin. A portal vote that got this far
    // is retired and must not enter the pool or a template.
    if (String(tx?.kind || '') === 'vote') return { ok: false, reason: 'vote_retired' };
    const publicReceipt = publicReserveReceiptRejected(tx);
    if (publicReceipt) return publicReceipt;
    if (txIsReserveAction(tx) && mempool.filter(txIsReserveAction).length >= RESERVE_ACTION_CAP) {
      return { ok: false, reason: 'reserve_cap' };
    }
    const noteFund = verifyTypedAdmitFunding(tx, {
      height: Number(t?.height || 0) + 1,
      blocks,
      spentTags: spentNow,
      magic: bookMagic,
      noteAtAnchor: (anchor) => noteFromAnchor(liveFlux, anchorAt, anchor),
    });
    if (!noteFund.ok) return noteFund;
    const stamp = headerStamp(opts.nowMs);
    const summed = typedCommitSum(tx, {
      height: Number(t?.height || 0) + 1,
      magic: bookMagic,
      state: reserveVault,
      nowMs: stamp,
    });
    if (!summed.ok) return summed;
    const drawn = new Set();
    for (const m of mempool) {
      const id = reserveWithdrawMintId(m, reserveVault);
      if (id) drawn.add(id);
    }
    const stake = boundReserveWithdraw(tx, reserveVault, drawn, stamp);
    if (!stake.ok) return stake;
    const noteBound = Array.isArray(tx.vin) && tx.vin.some((v) => v && (v.commit || v.prev));
    const debit = fundedDebit(tx);
    // A painted owed figure and the note walk are not inputs. Only a
    // note-bound Flow spend carries value.
    if (debit && !(noteBound && flowNeedsDummy(tx))) {
      return { ok: false, reason: 'kind', from: debit.from };
    }
    if (debit && flowSendNeedsOpen(tx)) {
      if (!verifySpendSig(tx)) {
        return { ok: false, reason: 'unsigned' };
      }
      const digest = spendPackDigest(tx).toString('hex');
      const inMem = mempool.some((m) => flowSendNeedsOpen(m) && spendPackDigest(m).toString('hex') === digest);
      if (inMem) return { ok: false, reason: 'replay' };
      for (const b of blocks) {
        for (const sealed of (b.txs || []).slice(1)) {
          if (flowSendNeedsOpen(sealed) && spendPackDigest(sealed).toString('hex') === digest) {
            return { ok: false, reason: 'replay' };
          }
        }
      }
    }
    const auth = reserveAuth(tx, reserveVault, null);
    if (!auth.ok) {
      try {
        console.error(JSON.stringify({ event: 'admit_fail', id: String(tx?.id || ''), reason: auth.reason || 'unsigned' }));
      } catch { /* ignore */ }
      return auth;
    }
    if (txIsReserveAction(tx)) {
      if (vaultSeal && !tipHasSealAncestry()) return { ok: false, reason: 'no_vault' };
      ensureMempoolVault(stamp);
    }
    const live = liveFlux;
    // The book's own magic, as block verify uses. FS-1 binds it into the
    // spend digest; the verifier's MAGIC_TESTNET default is wrong off testnet.
    const admitOpts = {
      baseFee: base,
      fluxset: live,
      spendTags: live.spendTags,
      commits: live.commits,
      paintedHold,
      reserveState: reserveVault,
      nowMs: stamp,
      height: Number(t?.height || 0) + 1,
      blocks,
      magic: bookMagic,
      noteAtAnchor: (anchor) => noteFromAnchor(liveFlux, anchorAt, anchor),
    };
    if (txIsReserveAction(tx)) {
      admitOpts.reserveCarried = mempoolVault;
      admitOpts.verifiedFund = fundVerdictFor(tx);
    }
    admitOpts.selfKey = bodyKey;
    return insertMempool(() => {
      const got = admitMempool(book, tx, admitOpts);
      if (got && got.ok && got.vaultState) mempoolVault = got.vaultState;
      if (got.ok && got.tx && !got.duplicate && txIsReserveAction(got.tx) && noteFund?.ok && noteFund.anchor != null) {
        const rec = noteFromAnchor(liveFlux, anchorAt, noteFund.anchor);
        const root = rootHex(rec?.jroot);
        const own = txSpendTags(got.tx).tags.map((tag) => tag.toString('hex'));
        if (root && own.length) rememberFundVerdict(got.tx, tip(), noteFund.anchor, root, own);
      }
      if (got.ok && got.tx && !got.duplicate) {
        emit('tx', got.tx);
        try {
          console.error(JSON.stringify({
            event: 'queue_ok',
            id: String(got.tx.id || ''),
            kind: String(got.tx.kind || ''),
          }));
        } catch { /* ignore */ }
      } else if (got && got.ok === false) {
        try {
          console.error(JSON.stringify({
            event: 'admit_fail',
            id: String(tx?.id || ''),
            reason: String(got.reason || 'admit'),
          }));
        } catch { /* ignore */ }
      }
      return got;
    });
  }

  function trialVaultAtForkRoot() {
    const trial = cloneVault(bookVault());
    if (reserveVault?.oracle) {
      trial.oracle = JSON.parse(JSON.stringify(reserveVault.oracle));
    }
    return trial;
  }

  /** Trial from LCA along a fork that still has the seal. A fork with no seal ancestry gets no vault. */
  function trialVaultForFork(fork) {
    const list = Array.isArray(fork) ? fork : [];
    if (vaultSeal && !chainHasSealAncestry(list, vaultSeal)) {
      return { trialVault: null, lca: 0, noVault: true };
    }
    const trial = trialVaultAtForkRoot();
    const lca = commonPrefixLen(blocks, list);
    return { trialVault: trial, lca, noVault: false };
  }

  function trustedHashFor(block, verifyOpts) {
    if (verifyOpts?.trustBlockHash && block?.hash) {
      try {
        const h = Buffer.from(block.hash);
        if (h.length === 32) return h;
      } catch { /* header is hashed when the stored id is not 32 bytes */ }
    }
    return verifyOpts?.trustedPowHash || null;
  }

  // A header run buries only the pruned block it stands above. The fork's
  // own length stays the tip for every other block. The height also keeps
  // the hash that run was proved against.
  function burialAt(at, height) {
    if (!at) return null;
    const row = at[height];
    if (row == null) return null;
    if (typeof row === 'number') return Number.isInteger(row) ? { top: row, claimed: null } : null;
    const top = Number(row.top);
    if (!Number.isInteger(top)) return null;
    let claimed = null;
    try {
      if (row.claimed != null) {
        const raw = Buffer.from(row.claimed);
        if (raw.length === 32) claimed = raw;
      }
    } catch { claimed = null; }
    return { top, claimed };
  }

  function headerRunTip(block, structuralH, chainTip, at) {
    if (block?.samplesPruned !== true || !at) return chainTip;
    const rec = burialAt(at, structuralH);
    if (!rec) return chainTip;
    const own = rec.top;
    if (!Number.isInteger(own) || !(own > chainTip)) return chainTip;
    if (!shouldPruneSamples(structuralH, own)) return chainTip;
    return own;
  }

  // The run was proved for the hash the block claimed. Verify's hash is the
  // one the header produced. A borrowed burial is pow, on every entry.
  // A failed verify that never produced a hash keeps its own reason.
  function burialClaimPow(structuralH, computed, at, verifiedOk = true) {
    const rec = burialAt(at, structuralH);
    if (!rec?.claimed) return null;
    let got = null;
    try {
      if (computed != null) {
        const raw = Buffer.from(computed);
        if (raw.length === 32) got = raw;
      }
    } catch { got = null; }
    if (!got) return verifiedOk ? { ok: false, reason: 'pow' } : null;
    if (!got.equals(rec.claimed)) return { ok: false, reason: 'pow' };
    return null;
  }

  function verifyOneForkBlock(fork, i, accepted, trialSpent, trialSession = null, trialVault = null, verifyOpts = {}) {
    const noVault = verifyOpts.noVault === true;
    const vault = noVault ? null : (trialVault || reserveVault);
    const prev = i === 0 ? null : {
      hash: accepted[i - 1].hash,
      header: accepted[i - 1].header,
      height: accepted[i - 1].height,
      rootA: accepted[i - 1].rootA,
      rootB: accepted[i - 1].rootB,
      txs: accepted[i - 1].txs,
      bLeaves: accepted[i - 1].bLeaves,
      weight: accepted[i - 1].weight,
      shareBatch: accepted[i - 1].shareBatch,
      // R28: the parent's compact record, from its own verify in this walk.
      blunoteRecord: accepted[i - 1].blunoteRecord,
    };
    const parentH = i === 0 ? 0 : Number(accepted[i - 1].height || i);
    const rows = Array.isArray(verifyOpts.explorerRows) ? verifyOpts.explorerRows : [];
    for (const tx of (fork[i]?.txs || []).slice(1)) {
      // `accepted` is this fork's prefix, not the live book. The opened sum
      // is not a verdict. A plaintext row cannot fund the debit.
      const debit = fundedDebit(tx);
      if (debit) destSpendableNanos(debit.from, parentH, accepted, rows);
      const clockField = typedClockRejected(tx);
      if (clockField) return clockField;
      const receiptPub = receiptAdmitRejected(tx);
      if (receiptPub) return receiptPub;
      const pay = verifyReservePayout(vault, tx, blockTimeMs(fork[i]));
      if (!pay.ok) return pay;
    }
    const beforeSpent = new Set(trialSpent);
    const owedWalk = verifyOpts.owedWalk || { owedIn: [], hashAcceptedSeries: [] };
    const owedUnit = verifyOpts.unitAt != null
      ? hashBonusUnitNanos(verifyOpts.unitAt)
      : hashBonusUnitNanos(vault?.liveHashBonusNanos);
    const chainTip = Number.isInteger(verifyOpts.burialTip)
      ? verifyOpts.burialTip
      : forkBurial(fork);
    const burialTip = headerRunTip(fork[i], parentH + 1, chainTip, verifyOpts.provenBurialAt);
    const check = verifyBlock(fork[i], prev, {
      parentSupply: verifyOpts.parentSupply,
      parentFluxset: verifyOpts.parentFlux,
      noteAtAnchor: verifyOpts.noteAtAnchor,
      spentB: trialSpent,
      tipHeight: Number(prev?.height || 0),
      burialTip,
      hashBonusNanos: owedUnit,
      owedIn: owedWalk.owedIn,
      hashAcceptedSeries: owedWalk.hashAcceptedSeries,
      evmSession: trialSession,
      // The session already executed this prefix. Admit still needs the blocks.
      evmHistory: accepted,
      spendableOf: (addr) => Math.max(0, destSpendableNanos(addr, parentH, accepted, rows)),
      committedBps: Number(vault?.epochBps ?? GENESIS_BPS),
      ...oracleVerifyFields(accepted, (prev ? prev.height : 0) + 1),
      reserveState: vault,
      offLoopPow: verifyOpts.probeBody === true ? false : !!verifyOpts.offLoopPow,
      trustedPowHash: verifyOpts.probeBody === true ? null : trustedHashFor(fork[i], verifyOpts),
      skipSharePow: verifyOpts.probeBody === true ? true : !!verifyOpts.skipSharePow,
      probeBody: verifyOpts.probeBody === true,
      grandparentHeader: grandparentHeader(accepted),
      sealedIntervalsMs: headerGapsMs(accepted),
      nowMs: verifyOpts.nowMs != null ? verifyOpts.nowMs : Date.now(),
      genesisMs: genesisHeaderMs(accepted) || Number(verifyOpts.genesisMs) || 0,
      magic: bookMagic,
      arrivedRows: verifyOpts.arrivedRows,
    });
    const stamp = (c) => {
      const lie = burialClaimPow(parentH + 1, c?.hash, verifyOpts.provenBurialAt, c?.ok === true);
      if (lie) {
        rollbackSpent(trialSpent, beforeSpent);
        return lie;
      }
      if (!c?.ok) {
        rollbackSpent(trialSpent, beforeSpent);
        return c;
      }
      const owedNext = advanceHashOwed({
        owedIn: owedWalk.owedIn,
        acceptedSeries: owedWalk.hashAcceptedSeries,
        block: fork[i],
        unit: owedUnit,
        // Structural tip. A height field on a later decoy must not bury this block.
        tipHeight: burialTip,
      });
      if (!owedNext.ok) {
        rollbackSpent(trialSpent, beforeSpent);
        return { ok: false, reason: owedNext.reason || 'hash_owed' };
      }
      owedWalk.owedIn = owedNext.rows;
      owedWalk.hashAcceptedSeries = owedNext.acceptedSeries;
      c.bSpendIds = spentDelta(beforeSpent, trialSpent);
      return c;
    };
    if (check && typeof check.then === 'function') return check.then(stamp);
    return stamp(check);
  }

  function noteForkSnap(snaps, at, rows, seriesEnd, tipAt) {
    if (!keepOwedIndex(at, tipAt)) return;
    snaps.push({ at, rows: copyOwedRows(rows), seriesEnd });
  }

  function forkRunState(fork) {
    const gms = genesisHeaderMs(fork) || 0;
    let supply = emptySupplyState(gms);
    const flux = emptyFluxset();
    const anchors = [];
    const rows = [];
    return {
      opts() {
        return {
          parentSupply: supply,
          parentFlux: flux,
          explorerRows: rows,
          noteAtAnchor: (anchor) => noteFromAnchor(flux, anchors, anchor),
        };
      },
      take(check, lean) {
        if (!check?.supplyState) return { ok: false, reason: 'supply_state' };
        supply = check.supplyState;
        appendFluxBlock(flux, lean);
        const h = Number(lean?.height) || 0;
        anchors[h] = anchorRecord(flux, false);
        rows.push(...sealedExplorerRows(lean));
        return { ok: true };
      },
      supply() { return supply; },
    };
  }

  /**
   * A later header fault must not hide an earlier body fault. When the
   * header gate fails at index i > 0, body-check 0..i-1 and return that
   * reason. Index 0 stays the header reason, so pow stays pow. This pass
   * does not stamp credits or apply the reserve.
   */
  function prefixBodyFault(fork, gated, verifyOpts) {
    const at = Number(gated?.at);
    if (!Number.isInteger(at) || at <= 0) return gated;
    const accepted = [];
    const trialSpent = new Set();
    const walkedUnits = unitsOnBook({ fork, timeOf: (block) => blockTimeMs(block) });
    if ((!walkedUnits.ok && Number(walkedUnits.at) < at) || !walkedUnits.units) {
      return { ok: false, reason: walkedUnits.reason || 'epoch_open', at: walkedUnits.at || 0 };
    }
    const units = walkedUnits.units;
    const owedWalk = { owedIn: [], hashAcceptedSeries: [] };
    const { trialVault, noVault } = trialVaultForFork(fork);
    const forkRun = forkRunState(fork);
    const burialTip = forkBurial(fork);
    // A long prefix is a loop. Recursing once per block overflows on a
    // multi-thousand-block adopt, which hid the earlier body fault.
    const takeOne = (i, c) => {
      if (!c?.ok) return { ok: false, reason: c.reason, at: i, ...(c.peerOnly ? { peerOnly: true } : {}) };
      const lean = leanBlock({
        ...fork[i],
        magic: bookMagic,
        hash: c.hash,
        ...(c.blunoteRecord ? { blunoteRecord: c.blunoteRecord } : {}),
        height: i + 1,
        weight: fork[i].weight ?? blockWeight(fork[i].txs || [], fork[i].bLeaves || []),
        bSpendIds: Array.isArray(c.bSpendIds) ? c.bSpendIds : [],
      });
      accepted.push(lean);
      const stepped = forkRun.take(c, lean);
      if (!stepped.ok) return { ok: false, reason: stepped.reason || 'supply_state', at: i };
      if (!noVault && trialVault) {
        const applied = applyReserveBlock(vaultArgs(trialVault, lean, accepted.slice(0, -1)));
        if (applied && applied.ok === false) return { ok: false, reason: applied.reason || 'epoch_open', at: i };
      }
      return null;
    };
    const runFrom = (start) => {
      for (let i = start; i < at; i += 1) {
        const check = verifyOneForkBlock(fork, i, accepted, trialSpent, null, trialVault, {
          ...verifyOpts,
          noVault: !!noVault,
          owedWalk,
          unitAt: units[i],
          burialTip,
          ...forkRun.opts(),
        });
        if (check && typeof check.then === 'function') {
          const index = i;
          return check.then((c) => {
            const found = takeOne(index, c);
            if (found) return found;
            return runFrom(index + 1);
          });
        }
        const found = takeOne(i, check);
        if (found) return found;
      }
      return null;
    };
    const fault = runFrom(0);
    if (fault && typeof fault.then === 'function') return fault.then((found) => found || gated);
    return fault || gated;
  }

  function verifyFork(fork, verifyOpts = {}) {
    const stage0 = chainStage0Rejected(fork || []);
    if (stage0) return stage0;
    const needs = (fork || []).some((b) => blockNeedsEvm(b?.txs || []));
    if (needs) return verifyForkAsync(fork, verifyOpts);
    if (!verifyOpts.headerGate) {
      const gated = gateForkChain(fork, verifyOpts);
      if (gated && typeof gated.then === 'function') {
        return gated.then((g) => (g.ok ? verifyFork(fork, { ...verifyOpts, headerGate: true }) : prefixBodyFault(fork, g, verifyOpts)));
      }
      if (!gated.ok) return prefixBodyFault(fork, gated, verifyOpts);
    }
    const accepted = [];
    const trialSpent = new Set();
    const walkedUnits = unitsOnBook({ fork, timeOf: (block) => blockTimeMs(block) });
    if (!walkedUnits.ok || !walkedUnits.units) {
      return { ok: false, reason: walkedUnits.reason || 'epoch_open', at: walkedUnits.at || 0 };
    }
    const units = walkedUnits.units;
    const owedWalk = { owedIn: [], hashAcceptedSeries: [] };
    const owedSnaps = [];
    const { trialVault, lca, noVault } = trialVaultForFork(fork);
    const forkRun = forkRunState(fork);
    const burialTip = forkBurial(fork);
    for (let i = 0; i < fork.length; i += 1) {
      const staged = stageFaultRow(i, fork[i], verifyOpts);
      if (staged) return staged;
      const check = verifyOneForkBlock(fork, i, accepted, trialSpent, null, trialVault, {
        ...verifyOpts,
        noVault: !!noVault,
        owedWalk,
        unitAt: units[i],
        ...forkRun.opts(),
        burialTip,
      });
      if (!check.ok) return { ok: false, reason: check.reason, at: i, ...(check.peerOnly ? { peerOnly: true } : {}) };
      stampCredits(fork[i], units[i]);
      const lean = leanBlock({
        ...fork[i],
        magic: bookMagic,
        hash: check.hash,
        ...(check.blunoteRecord ? { blunoteRecord: check.blunoteRecord } : {}),
        height: i + 1,
        weight: fork[i].weight ?? blockWeight(fork[i].txs || [], fork[i].bLeaves || []),
        bSpendIds: Array.isArray(check.bSpendIds) ? check.bSpendIds : [],
      });
      accepted.push(lean);
      const stepped = forkRun.take(check, lean);
      if (!stepped.ok) return { ok: false, reason: stepped.reason || 'supply_state', at: i };
      if (!noVault && trialVault) {
        const applied = applyReserveBlock(vaultArgs(trialVault, lean, accepted.slice(0, -1)));
        if (applied && applied.ok === false) return { ok: false, reason: applied.reason || 'epoch_open', at: i };
      }
      noteForkSnap(owedSnaps, i, owedWalk.owedIn, owedWalk.hashAcceptedSeries.length, fork.length - 1);
    }
    return {
      ok: true,
      accepted,
      owedRows: owedWalk.owedIn,
      owedSeries: owedWalk.hashAcceptedSeries.slice(),
      owedSnaps,
      supply: forkRun.supply(),
      units,
      burialTip,
    };
  }

  async function verifyForkAsync(fork, verifyOpts = {}) {
    const stage0 = chainStage0Rejected(fork || []);
    if (stage0) return stage0;
    const gated = await Promise.resolve(gateForkChain(fork, verifyOpts));
    if (!gated.ok) return prefixBodyFault(fork, gated, verifyOpts);
    const accepted = [];
    const trialSpent = new Set();
    let trialSession = null;
    const walkedUnits = unitsOnBook({ fork, timeOf: (block) => blockTimeMs(block) });
    if (!walkedUnits.ok || !walkedUnits.units) {
      return { ok: false, reason: walkedUnits.reason || 'epoch_open', at: walkedUnits.at || 0 };
    }
    const units = walkedUnits.units;
    const owedWalk = { owedIn: [], hashAcceptedSeries: [] };
    const owedSnaps = [];
    const { trialVault, lca, noVault } = trialVaultForFork(fork);
    const forkRun = forkRunState(fork);
    const burialTip = forkBurial(fork);
    for (let i = 0; i < fork.length; i += 1) {
      const staged = stageFaultRow(i, fork[i], verifyOpts);
      if (staged) return staged;
      const check = await Promise.resolve(
        verifyOneForkBlock(fork, i, accepted, trialSpent, trialSession, trialVault, {
          ...verifyOpts,
          noVault: !!noVault,
          owedWalk,
          unitAt: units[i],
          ...forkRun.opts(),
          burialTip,
        }),
      );
      if (check.evmSession) trialSession = check.evmSession;
      if (!check.ok) return { ok: false, reason: check.reason, at: i, ...(check.peerOnly ? { peerOnly: true } : {}) };
      stampCredits(fork[i], units[i]);
      const lean = leanBlock({
        ...fork[i],
        magic: bookMagic,
        hash: check.hash,
        ...(check.blunoteRecord ? { blunoteRecord: check.blunoteRecord } : {}),
        height: i + 1,
        weight: fork[i].weight ?? blockWeight(fork[i].txs || [], fork[i].bLeaves || []),
        bSpendIds: Array.isArray(check.bSpendIds) ? check.bSpendIds : [],
      });
      accepted.push(lean);
      const stepped = forkRun.take(check, lean);
      if (!stepped.ok) return { ok: false, reason: stepped.reason || 'supply_state', at: i };
      if (!noVault && trialVault) {
        const applied = applyReserveBlock(vaultArgs(trialVault, lean, accepted.slice(0, -1)));
        if (applied && applied.ok === false) return { ok: false, reason: applied.reason || 'epoch_open', at: i };
      }
      noteForkSnap(owedSnaps, i, owedWalk.owedIn, owedWalk.hashAcceptedSeries.length, fork.length - 1);
    }
    return {
      ok: true,
      accepted,
      owedRows: owedWalk.owedIn,
      owedSeries: owedWalk.hashAcceptedSeries.slice(),
      owedSnaps,
      supply: forkRun.supply(),
      units,
      burialTip,
    };
  }

  let sideAnchor = -1;
  let sideBlocks = [];

  function sideTipHash() {
    if (!sideBlocks.length) return '';
    return hex32(sideBlocks[sideBlocks.length - 1].hash).toLowerCase();
  }

  function clearSide() {
    sideAnchor = -1;
    sideBlocks = [];
  }

  function sideChain() {
    if (!sideBlocks.length) return [];
    if (sideAnchor < 0) return sideBlocks.slice();
    return blocks.slice(0, sideAnchor + 1).concat(sideBlocks);
  }

  /** Remember one competing branch: the one fork-choice prefers. */
  function stageSide(anchor, staged) {
    const rows = Array.isArray(staged) ? staged : [];
    if (!rows.length) return;
    const next = anchor < 0 ? rows.slice() : blocks.slice(0, anchor + 1).concat(rows);
    const cur = sideChain();
    if (cur.length && !shouldAdopt(cur, next)) return;
    sideAnchor = anchor;
    sideBlocks = rows.slice();
  }

  function prevHexOf(block) {
    try {
      return Buffer.from(decodeHeader(Buffer.from(block.header)).prevBlockHash).toString('hex').toLowerCase();
    } catch {
      return '';
    }
  }

  function parentView(block) {
    return {
      hash: block.hash,
      header: block.header,
      height: block.height,
      rootA: block.rootA,
      rootB: block.rootB,
      txs: block.txs,
      bLeaves: block.bLeaves,
      weight: block.weight,
      shareBatch: block.shareBatch,
      blunoteRecord: block.blunoteRecord,
    };
  }

  function leanVerified(block, check, prev) {
    return leanBlock({
      ...block,
      magic: bookMagic,
      hash: check.hash,
      ...(check.blunoteRecord ? { blunoteRecord: check.blunoteRecord } : {}),
      height: prev ? Number(prev.height || 0) + 1 : 1,
      weight: block.weight ?? blockWeight(block.txs || [], block.bLeaves || []),
    });
  }

  function blockHex(block) {
    try { return hex32(block?.hash).toLowerCase(); } catch { return ''; }
  }

  function nearestOwedCheckpoint(at) {
    let best = null;
    for (const c of owedCkpt) {
      if (!c || !Number.isInteger(c.at) || c.at > at) continue;
      if (!Number.isInteger(c.seriesEnd) || c.seriesEnd < 0) continue;
      if (!best || c.at > best.at) best = c;
    }
    return best;
  }

  function gatePrevFrom(block, hash, prev) {
    return {
      hash,
      header: block.header,
      height: (prev ? Number(prev.height || 0) : 0) + 1,
      txs: block.txs,
      bLeaves: block.bLeaves,
      weight: block.weight,
      shareBatch: block.shareBatch,
    };
  }

  function gateOneHeader(block, prev, history, verifyOpts) {
    const opts = {
      trustedPowHash: trustedHashFor(block, verifyOpts),
      genesisMs: genesisHeaderMs(history) || Number(verifyOpts.genesisMs) || 0,
      nowMs: verifyOpts.nowMs != null ? verifyOpts.nowMs : Date.now(),
      consumePrepared: false,
      magic: bookMagic,
      probeBody: verifyOpts.probeBody === true,
    };
    const finish = (assessed) => {
      if (!assessed.ok) discardPreparedHeader(block?.header);
      return assessed;
    };
    const offLoop = !!verifyOpts.offLoopPow && !opts.trustedPowHash && opts.probeBody !== true;
    if (offLoop) {
      return hashHeaderOffLoop(Buffer.from(block.header)).then((hash) => (
        finish(assessHeader(block, prev, { ...opts, preparedHash: hash }))
      ), () => finish({ ok: false, reason: 'pow_worker' }));
    }
    return finish(assessHeader(block, prev, opts));
  }

  /**
   * Header proof-of-work and the cheap header rules, before any owed walk.
   * The sync path is a loop: a few thousand blocks (a voted unit change)
   * overflowed the old per-block recursion inside adopt.
   */
  function gateForkHeaders(fork, parent, history, verifyOpts) {
    const claimLie = (assessed, prev) => burialClaimPow(
      (prev ? Number(prev.height || 0) : 0) + 1,
      assessed.hash,
      verifyOpts.provenBurialAt,
    );
    const resume = async (start, assessed, prev) => {
      if (!assessed?.ok) return { ok: false, reason: assessed?.reason || 'pow', at: start };
      const first = claimLie(assessed, prev);
      if (first) return { ...first, at: start };
      let p = gatePrevFrom(fork[start], assessed.hash, prev);
      for (let i = start + 1; i < fork.length; i += 1) {
        const got = gateOneHeader(fork[i], p, history, verifyOpts);
        const next = got && typeof got.then === 'function' ? await got : got;
        if (!next?.ok) return { ok: false, reason: next?.reason || 'pow', at: i };
        const lie = claimLie(next, p);
        if (lie) return { ...lie, at: i };
        p = gatePrevFrom(fork[i], next.hash, p);
      }
      return { ok: true };
    };
    let prev = parent;
    for (let i = 0; i < fork.length; i += 1) {
      const got = gateOneHeader(fork[i], prev, history, verifyOpts);
      if (got && typeof got.then === 'function') {
        const at = i;
        const parentHere = prev;
        return got.then((assessed) => resume(at, assessed, parentHere));
      }
      if (!got?.ok) return { ok: false, reason: got?.reason || 'pow', at: i };
      const lie = claimLie(got, prev);
      if (lie) return { ...lie, at: i };
      prev = gatePrevFrom(fork[i], got.hash, prev);
    }
    return { ok: true };
  }

  /** Same gate for a chain that does not share this store's prefix. */
  function gateForkChain(fork, verifyOpts) {
    return gateForkHeaders(fork, null, fork, verifyOpts);
  }

  /**
   * Owed state at the end of `history`. A shared prefix replays only from
   * the checkpoint at or below the anchor. It never replays from genesis.
   * `candidateTipAt` selects which checkpoints to keep. `candidateTipHeight`
   * is the height burial would see on the candidate chain.
   */
  function seedHistory(history, candidateTipAt = null, candidateTipHeight = null) {
    const list = Array.isArray(history) ? history : [];
    let n = 0;
    while (n < list.length && n < blocks.length && blockHex(list[n]) && blockHex(list[n]) === blockHex(blocks[n])) n += 1;
    // The chain being validated. A height field and the local tip are not this.
    const tipH = candidateTipHeight != null && Number.isFinite(Number(candidateTipHeight))
      ? Number(candidateTipHeight)
      : list.length;
    const tipAt = candidateTipAt != null ? Number(candidateTipAt) : Math.max(0, list.length - 1);
    const anchorHash = n > 0 ? blockHex(blocks[n - 1]) : '';
    const key = `${n}|${blocks.length}|${tipH}|${tipAt}|${anchorHash}|${list.length}`;
    if (seedCache && seedCache.key === key) {
      owedSeed.cached += 1;
      return {
        ok: true,
        rows: copyOwedRows(seedCache.rows),
        series: seedCache.series.slice(),
        snaps: seedCache.snaps.map((s) => ({
          at: s.at,
          rows: copyOwedRows(s.rows),
          seriesEnd: s.seriesEnd,
        })),
      };
    }
    const snaps = [];
    let rows = [];
    let series = [];
    if (n > 0) {
      const ck = nearestOwedCheckpoint(n - 1);
      if (!ck || ck.seriesEnd !== ck.at + 1 || !Array.isArray(owedSeriesAll) || owedSeriesAll.length < ck.seriesEnd) {
        owedSeed.refused += 1;
        return { ok: false, reason: 'owed_checkpoint' };
      }
      for (const c of owedCkpt) {
        if (!c || c.at > ck.at || c.at >= list.length) continue;
        if (!keepOwedIndex(c.at, tipAt)) continue;
        snaps.push({ at: c.at, rows: copyOwedRows(c.rows), seriesEnd: c.seriesEnd });
      }
      rows = copyOwedRows(ck.rows);
      series = owedSeriesAll.slice(0, ck.seriesEnd);
    }
    const walked = n > 0
      ? unitsAlong(list.slice(0, n), list.slice(n))
      : (list.length
        ? unitsOnBook({ fork: list, timeOf: (block) => blockTimeMs(block) })
        : { ok: true, reason: '', units: [] });
    if (!walked.ok || !walked.units) return { ok: false, reason: walked.reason || 'epoch_open' };
    const units = walked.units;
    const from = n > 0 ? (nearestOwedCheckpoint(n - 1).at + 1) : 0;
    for (let i = from; i < list.length; i += 1) {
      const viewed = blockForTip(list[i], tipH);
      if (!viewed.ok) return { ok: false, reason: 'samples_pruned' };
      const next = advanceHashOwed({
        owedIn: rows,
        acceptedSeries: series,
        block: viewed.block,
        unit: units[i],
        height: Number(list[i]?.height) || i + 1,
        tipHeight: viewed.tip,
      });
      if (!next.ok) {
        // A rewritten share on a block this node already accepted is the
        // share-credit bind, not a new owed ledger. The suffix check still
        // runs only after this prefix agrees.
        if (i < n) {
          const bound = shareCreditBound(viewed.block, viewed.tip);
          if (!bound.ok) return { ok: false, reason: bound.reason || 'share_credit_bind' };
        }
        return { ok: false, reason: next.reason || 'hash_owed' };
      }
      rows = next.rows;
      series = next.acceptedSeries;
      owedSeed.forkAdvances += 1;
      if (keepOwedIndex(i, tipAt)) {
        snaps.push({ at: i, rows: copyOwedRows(rows), seriesEnd: series.length });
      }
    }
    seedCache = {
      key,
      rows: copyOwedRows(rows),
      series: series.slice(),
      snaps: snaps.map((s) => ({ at: s.at, rows: copyOwedRows(s.rows), seriesEnd: s.seriesEnd })),
    };
    return {
      ok: true,
      rows: copyOwedRows(rows),
      series: series.slice(),
      snaps: seedCache.snaps.map((s) => ({
        at: s.at,
        rows: copyOwedRows(s.rows),
        seriesEnd: s.seriesEnd,
      })),
    };
  }

  function snapsCoverTip(snaps, n, series) {
    if (!Array.isArray(snaps) || !Array.isArray(series) || series.length !== n || n < 1) return false;
    let tip = null;
    const seen = new Set();
    for (const s of snaps) {
      if (!s || !Number.isInteger(s.at) || s.at < 0 || s.at >= n || seen.has(s.at)) return false;
      if (!Array.isArray(s.rows) || !Number.isInteger(s.seriesEnd) || s.seriesEnd < 0) return false;
      seen.add(s.at);
      if (s.at === n - 1) tip = s;
    }
    return !!tip && tip.seriesEnd === n;
  }

  function anchorRecord(flux, keepBlobs = true) {
    const rec = {
      n: flux?.pubs?.length || 0,
      jroot: flux?.jroot ? Buffer.from(flux.jroot) : Buffer.alloc(32),
      zeroRoot: flux?.zeroRoot ? Buffer.from(flux.zeroRoot) : null,
    };
    if (keepBlobs) {
      rec.frontier = flux?.frontier || null;
      rec.zeroFrontier = flux?.zeroFrontier || null;
    }
    return rec;
  }

  function releaseExitedFrontier(tipHeight) {
    const exited = tipHeight - frontierWindow(haltDepth);
    if (exited < 1) return;
    const rec = anchorAt[exited];
    if (!rec || keepsFrontier(exited, tipHeight, haltDepth)) return;
    rec.frontier = null;
    rec.zeroFrontier = null;
  }

  function indexAtHeight(list, height, endIdx) {
    const guess = height - 1;
    if (guess >= 0 && guess <= endIdx) {
      const bh = Number(list[guess]?.height) || guess + 1;
      if (bh === height) return guess;
    }
    for (let i = 0; i <= endIdx; i += 1) {
      const bh = Number(list[i]?.height) || i + 1;
      if (bh === height) return i;
    }
    return -1;
  }

  function tagsThrough(list, endIdx) {
    const spendTags = new Set();
    const n = Math.min(list?.length || 0, endIdx + 1);
    for (let i = 0; i < n; i += 1) {
      for (const tx of list[i]?.txs || []) {
        for (const tag of txSpendTags(tx).tags) {
          const hex = tag.toString('hex');
          if (hex) spendTags.add(hex);
        }
      }
    }
    return spendTags;
  }

  function assembleFlux(rec, list, endIdx) {
    const n = Number(rec?.n) || 0;
    if (!rec?.jroot || !rec.frontier || !rec.zeroFrontier) return null;
    if (!liveFlux || !Array.isArray(liveFlux.pubs) || n > liveFlux.pubs.length) return null;
    return {
      pubs: liveFlux.pubs.slice(0, n),
      commits: (liveFlux.commits || []).slice(0, n),
      spendTags: tagsThrough(list, endIdx),
      jroot: Buffer.from(rec.jroot),
      frontier: rec.frontier,
      zeroFrontier: rec.zeroFrontier,
      zeroRoot: rec.zeroRoot ? Buffer.from(rec.zeroRoot) : Buffer.from(rec.jroot),
    };
  }

  /**
   * Flux through list[endIdx]. A missing blob replays from the nearest kept
   * frontier. A missing anchor row is a snap hole and replays the same way.
   * A stored jroot that the replay does not match fails closed.
   */
  function fluxThroughIndex(list, endIdx) {
    if (!Array.isArray(list) || endIdx < 0 || endIdx >= list.length) return null;
    if (!liveFlux || !Array.isArray(liveFlux.pubs)) return null;
    const h = Number(list[endIdx]?.height) || endIdx + 1;
    const direct = anchorAt[h];
    if (direct?.frontier && direct?.zeroFrontier && direct?.jroot) {
      return assembleFlux(direct, list, endIdx);
    }
    let baseH = 0;
    for (let at = h - 1; at >= 1; at -= 1) {
      const prior = anchorAt[at];
      if (prior?.frontier && prior?.zeroFrontier && prior?.jroot) {
        baseH = at;
        break;
      }
    }
    let flux;
    if (baseH > 0) {
      const baseIdx = indexAtHeight(list, baseH, endIdx);
      if (baseIdx < 0) return null;
      flux = assembleFlux(anchorAt[baseH], list, baseIdx);
      if (!flux) return null;
    } else {
      flux = emptyFluxset();
    }
    for (let i = 0; i <= endIdx; i += 1) {
      const bh = Number(list[i]?.height) || i + 1;
      if (bh <= baseH) continue;
      appendFluxBlock(flux, list[i]);
    }
    if (direct?.jroot) {
      if (!flux.jroot || !Buffer.from(flux.jroot).equals(Buffer.from(direct.jroot))) return null;
    }
    if (!flux.frontier || !flux.zeroFrontier) return null;
    return flux;
  }

  function fluxKeptThrough(index, list) {
    if (index <= 0) return emptyFluxset();
    return fluxThroughIndex(list, index - 1);
  }

  /**
   * Burial for a from-genesis fork. The tip is this fork's own length.
   * The local store tip does not bury a shorter chain. A height field on
   * a block is not this number.
   */
  function forkBurial(fork) {
    return Array.isArray(fork) ? fork.length : 0;
  }

  function supplyCarriedTo(endIdx, tipH) {
    if (endIdx < 0 || endIdx >= blocks.length) return null;
    let from = endIdx;
    while (from > 0 && !(supplyAt[from] && supplyAt[from].owedKnown && supplyLinks(supplyAt[from], blocks[from]))) {
      from -= 1;
    }
    const base = supplyAt[from];
    if (!base || base.owedKnown !== true || !supplyLinks(base, blocks[from])) return null;
    const burial = Number.isInteger(tipH) && tipH >= 0 ? tipH : (Number(blocks[endIdx]?.height) || endIdx + 1);
    const carriedVault = vaultParent(blocks, from + 1, bookMagic);
    if (!carriedVault.ok) return null;
    let vault = carriedVault.vault;
    let state = base;
    for (let i = from + 1; i <= endIdx; i += 1) {
      const viewed = blockForTip(blocks[i], burial);
      if (!viewed.ok) return null;
      const block = viewed.block;
      const stepped = supplyStep(state, block, {
        unit: unitAt[i] == null ? undefined : unitAt[i],
        height: Number(block?.height) || i + 1,
        tipHeight: viewed.tip,
        genesisMs: state.genesisMs,
        blockHash: block?.hash,
        magic: bookMagic,
        vault,
      });
      if (!stepped.ok) return null;
      state = stepped.state;
      const advanced = vaultAfterBlock(vault, block, [], { magic: bookMagic });
      if (!advanced.ok) return null;
      vault = advanced.vault;
    }
    return state;
  }

  function fluxCarriedTo(endIdx) {
    return fluxThroughIndex(blocks, endIdx);
  }

  /** Verify only the new suffix. Header rules run before any owed replay. */
  function verifySuffix(fork, parent, history, verifyOpts) {
    const gated = gateForkHeaders(fork, parent, history, verifyOpts);
    const go = () => verifySuffixBody(fork, parent, history, verifyOpts);
    if (gated && typeof gated.then === 'function') {
      return gated.then((g) => (g.ok ? go() : { ok: false, reason: g.reason || 'pow', at: g.at }));
    }
    if (!gated.ok) return { ok: false, reason: gated.reason || 'pow', at: gated.at };
    return go();
  }

  /**
   * Vault at the end of `rows`. A canonical prefix resumes from the last
   * owed checkpoint. Only a side tail past that prefix is applied. A losing
   * side block does not walk the snapped book from genesis.
   */
  function vaultThrough(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { ok: true, vault: cloneVault(bookVault()) };
    let prefix = 0;
    const limit = Math.min(list.length, blocks.length);
    while (prefix < limit && list[prefix] === blocks[prefix]) prefix += 1;
    const trial = prefix > 0 ? vaultAfter(prefix - 1) : cloneVault(bookVault());
    if (prefix === list.length) return { ok: true, vault: trial };
    const chain = list.slice(0, prefix);
    for (let i = prefix; i < list.length; i += 1) {
      const applied = applyReserveBlock(vaultArgs(trial, list[i], chain));
      if (applied && applied.ok === false) return { ok: false, reason: applied.reason || 'epoch_open' };
      chain.push(list[i]);
    }
    return { ok: true, vault: trial };
  }

  function verifySuffixBody(fork, parent, history, verifyOpts) {
    const out = [];
    let prev = parent;
    const trialSpent = new Set();
    const rows = Array.isArray(history) ? history : [];
    const tipAt = rows.length + fork.length - 1;
    // One burial tip: the chain being validated. Linked length, not a height
    // field and not max(local tip, fork length). Commit uses this same tip.
    const baseH = rows.length ? (Number(rows[rows.length - 1]?.height) || rows.length) : 0;
    const candidateTip = baseH + fork.length;
    const tipH = candidateTip;
    const seeded = seedHistory(rows, tipAt, candidateTip);
    if (!seeded.ok) return { ok: false, reason: seeded.reason || 'hash_owed' };
    const allUnitsWalk = unitsAlong(rows, fork);
    if (!allUnitsWalk.ok || !allUnitsWalk.units) {
      return { ok: false, reason: allUnitsWalk.reason || 'epoch_open' };
    }
    const allUnits = allUnitsWalk.units;
    const gms = genesisHeaderMs(rows) || Number(verifyOpts.genesisMs) || 0;
    const canonical = rows.length > 0 && rows.length <= blocks.length
      && rows.every((row, i) => row === blocks[i]);
    let supply = null;
    let flux = null;
    let anchors = null;
    if (!rows.length) {
      supply = emptySupplyState(gms);
      flux = emptyFluxset();
      anchors = [];
    } else if (canonical) {
      const endIdx = rows.length - 1;
      supply = supplyCarriedTo(endIdx, candidateTip);
      flux = fluxCarriedTo(endIdx);
      if (supply && flux) anchors = anchorAt.slice();
    }
    if (!supply || !flux || !anchors) {
      const prefix = commonPrefixLen(blocks, rows);
      let from = 0;
      supply = emptySupplyState(gms);
      flux = emptyFluxset();
      anchors = [];
      if (prefix > 0) {
        const carried = supplyCarriedTo(prefix - 1, candidateTip);
        const restored = fluxThroughIndex(blocks, prefix - 1);
        if (carried && restored?.frontier) {
          supply = carried;
          flux = restored;
          anchors = anchorAt.slice();
          from = prefix;
        }
      }
      const historyVault = vaultParent(rows, from, bookMagic);
      if (!historyVault.ok) return { ok: false, reason: 'supply' };
      let vault = historyVault.vault;
      // One prefix. A slice at every height made the reorg walk cost grow with the chain.
      const chain = rows.slice(0, from);
      for (let hi = from; hi < rows.length; hi += 1) {
        const viewed = blockForTip(rows[hi], candidateTip);
        if (!viewed.ok) return { ok: false, reason: 'samples_pruned' };
        const stepped = supplyStep(supply, viewed.block, {
          unit: allUnits[hi],
          height: Number(rows[hi]?.height) || hi + 1,
          tipHeight: viewed.tip,
          genesisMs: gms,
          blockHash: rows[hi]?.hash,
          magic: bookMagic,
          vault,
        });
        if (!stepped.ok) return { ok: false, reason: stepped.reason || 'supply' };
        supply = stepped.state;
        const advanced = vaultAfterBlock(vault, viewed.block, chain, { magic: bookMagic });
        if (!advanced.ok) return { ok: false, reason: 'supply' };
        vault = advanced.vault;
        chain.push(rows[hi]);
        appendFluxBlock(flux, rows[hi]);
        const hh = Number(rows[hi]?.height) || hi + 1;
        anchors[hh] = anchorRecord(flux, false);
      }
    }
    const resumedVault = vaultThrough(rows);
    if (!resumedVault.ok) return { ok: false, reason: resumedVault.reason || 'epoch_open' };
    const trialVault = resumedVault.vault;
    const owedWalk = { owedIn: seeded.rows, hashAcceptedSeries: seeded.series.slice() };
    const suffixSnaps = [];
    const done = () => ({
      ok: true,
      blocks: out,
      owedRows: owedWalk.owedIn,
      owedSeries: owedWalk.hashAcceptedSeries.slice(),
      owedSnaps: seeded.snaps.concat(suffixSnaps),
      supply,
      units: allUnits,
      burialTip: tipH,
    });
    // Same rule as the header gate: a long suffix must not recurse per block.
    const takeOne = (i, c, beforeSpent, structuralH, blockTip) => {
      const lie = burialClaimPow(structuralH, c?.hash, verifyOpts.provenBurialAt, c?.ok === true);
      if (lie) {
        rollbackSpent(trialSpent, beforeSpent);
        return lie;
      }
      if (!c?.ok) {
        rollbackSpent(trialSpent, beforeSpent);
        return c;
      }
      const owedUnit = allUnits[rows.length + i];
      const owedNext = advanceHashOwed({
        owedIn: owedWalk.owedIn,
        acceptedSeries: owedWalk.hashAcceptedSeries,
        block: fork[i],
        unit: owedUnit,
        height: structuralH,
        tipHeight: blockTip,
      });
      if (!owedNext.ok) {
        rollbackSpent(trialSpent, beforeSpent);
        return { ok: false, reason: owedNext.reason || 'hash_owed' };
      }
      stampCredits(fork[i], owedUnit);
      owedWalk.owedIn = owedNext.rows;
      owedWalk.hashAcceptedSeries = owedNext.acceptedSeries;
      owedSeed.suffixAdvances += 1;
      const at = rows.length + i;
      if (keepOwedIndex(at, tipAt)) {
        suffixSnaps.push({
          at,
          rows: copyOwedRows(owedNext.rows),
          seriesEnd: owedNext.acceptedSeries.length,
        });
      }
      const lean = leanVerified(fork[i], c, prev);
      lean.bSpendIds = spentDelta(beforeSpent, trialSpent);
      const applied = applyReserveBlock(vaultArgs(trialVault, lean, rows.concat(out)));
      if (applied && applied.ok === false) return { ok: false, reason: applied.reason || 'epoch_open' };
      if (!c.supplyState) return { ok: false, reason: 'supply_state' };
      supply = c.supplyState;
      appendFluxBlock(flux, lean);
      const ah = Number(lean.height) || 0;
      anchors[ah] = anchorRecord(flux, false);
      out.push(lean);
      prev = lean;
      return null;
    };
    const runFrom = (start) => {
      for (let i = start; i < fork.length; i += 1) {
        const staged = stageFaultRow(i, fork[i], verifyOpts);
        if (staged) return staged;
        const beforeSpent = new Set(trialSpent);
        const structuralH = (Number(prev?.height) || 0) + 1;
        const blockTip = headerRunTip(fork[i], structuralH, tipH, verifyOpts.provenBurialAt);
        const check = verifyBlock(fork[i], parentView(prev), {
          ...verifyOpts,
          hashBonusNanos: allUnits[rows.length + i],
          owedIn: owedWalk.owedIn,
          hashAcceptedSeries: owedWalk.hashAcceptedSeries,
          spentB: trialSpent,
          trustedPowHash: trustedHashFor(fork[i], verifyOpts),
          tipHeight: structuralH,
          burialTip: blockTip,
          evmHistory: rows.concat(out),
          parentSupply: supply,
          parentFluxset: flux,
          noteAtAnchor: (anchor) => noteFromAnchor(flux, anchors, anchor),
          grandparentHeader: grandparentHeader(rows.concat(out)),
          sealedIntervalsMs: headerGapsMs(rows.concat(out)),
          nowMs: verifyOpts.nowMs != null ? verifyOpts.nowMs : Date.now(),
          genesisMs: genesisHeaderMs(rows) || Number(verifyOpts.genesisMs) || 0,
          reserveState: trialVault,
          committedBps: Number(trialVault.epochBps ?? GENESIS_BPS),
          ...oracleVerifyFields(rows.concat(out), (Number(prev?.height) || 0) + 1),
          magic: bookMagic,
        });
        if (check && typeof check.then === 'function') {
          const index = i;
          const spentSnap = beforeSpent;
          const heightHere = structuralH;
          const tipHere = blockTip;
          return check.then((c) => {
            const failed = takeOne(index, c, spentSnap, heightHere, tipHere);
            if (failed) return failed;
            return runFrom(index + 1);
          });
        }
        const failed = takeOne(i, check, beforeSpent, structuralH, blockTip);
        if (failed) return failed;
      }
      return done();
    };
    return runFrom(0);
  }

  /** Keep a competing branch until it has more work, then adopt it in place. */
  function stageOrAdopt(fork, verifyOpts, anchorIdx) {
    const prevHex = prevHexOf(fork[0]);
    let anchor;
    let parent;
    let prior;
    if (sideBlocks.length && prevHex === sideTipHash()) {
      anchor = sideAnchor;
      parent = sideBlocks[sideBlocks.length - 1];
      prior = sideBlocks;
    } else if (anchorIdx >= 0) {
      anchor = anchorIdx;
      parent = blocks[anchor];
      prior = [];
    } else {
      return { ok: false, reason: 'prev', tip: tip() };
    }
    const history = blocks.slice(0, anchor + 1).concat(prior);
    const checked = verifySuffix(fork, parent, history, verifyOpts);
    const apply = (verified) => {
      if (!verified?.ok) return verified;
      const carried = arrivalRefused(verifyOpts);
      if (carried) return carried;
      const staged = prior.concat(verified.blocks);
      if (staged.length > 8192) return { ok: false, reason: 'side_hold', tip: tip() };
      const candidate = blocks.slice(0, anchor + 1).concat(staged);
      let prefer = false;
      try {
        prefer = shouldAdopt(blocks, candidate);
      } catch {
        return { ok: false, reason: 'bad_header', tip: tip() };
      }
      if (!prefer) {
        rememberRunBurial(staged, verified.burialTip, verifyOpts.provenBurialAt);
        stageSide(anchor, staged);
        return { ok: false, reason: 'side_hold', tip: tip() };
      }
      return finishAdopt({
        ok: true,
        accepted: candidate,
        owedRows: verified.owedRows,
        owedSeries: verified.owedSeries,
        owedSnaps: verified.owedSnaps,
        supply: verified.supply,
        units: verified.units,
        burialTip: verified.burialTip,
      }, verifyOpts);
    };
    if (checked && typeof checked.then === 'function') return checked.then(apply);
    return apply(checked);
  }

  // A copy appendFluxBlock can extend without touching the live book.
  function detachFlux(flux) {
    if (!flux || !Array.isArray(flux.pubs) || !(flux.spendTags instanceof Set)) return emptyFluxset();
    return {
      pubs: flux.pubs.slice(),
      commits: (flux.commits || []).slice(),
      spendTags: new Set(flux.spendTags),
      jroot: flux.jroot ? Buffer.from(flux.jroot) : null,
      frontier: flux.frontier ? Buffer.from(flux.frontier) : null,
      zeroFrontier: flux.zeroFrontier ? Buffer.from(flux.zeroFrontier) : null,
      zeroRoot: flux.zeroRoot ? Buffer.from(flux.zeroRoot) : null,
    };
  }

  function fileBytes(file) {
    try {
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  }

  function putFileBytes(file, bytes) {
    if (bytes == null) {
      try { if (fs.existsSync(file)) fs.rmSync(file); } catch { /* absent before publish */ }
      return;
    }
    fs.writeFileSync(file, bytes);
  }

  function captureAdoptImage() {
    return {
      spent: new Set(spentB),
      blocks: blocks.slice(),
      liveFlux,
      anchorAt,
      supplyAt,
      supplyTip,
      unitAt,
      vaultCkpt,
      vault: cloneVault(reserveVault),
      vaultSeal,
      owedRows,
      acceptedSeries,
      owedSeriesAll,
      owedCkpt,
      sideAnchor,
      sideBlocks: sideBlocks.slice(),
      mempool: mempool.slice(),
      mempoolVault,
      seedCache,
      evmSession,
      reorgs: reorgs.slice(),
      explorer: explorer.slice(),
      policy: policyState,
      headers: new Map(headers),
      forks: new Map(forks),
      snap: fileBytes(snapFile),
      vaultSnap: fileBytes(vaultSnapFile),
      vaultBytes: fileBytes(vaultFile),
      explorerBytes: fileBytes(explorerFile),
      policyBytes: fileBytes(policyStatePath),
    };
  }

  function restoreAdoptImage(image) {
    spentB.clear();
    for (const id of image.spent) spentB.add(id);
    blocks.length = 0;
    for (const b of image.blocks) blocks.push(b);
    liveFlux = image.liveFlux;
    anchorAt = image.anchorAt;
    supplyAt = image.supplyAt;
    supplyTip = image.supplyTip;
    unitAt = image.unitAt;
    vaultCkpt = image.vaultCkpt;
    installVault(image.vault);
    vaultSeal = image.vaultSeal;
    owedRows = image.owedRows;
    acceptedSeries = image.acceptedSeries;
    owedSeriesAll = image.owedSeriesAll;
    owedCkpt = image.owedCkpt;
    sideAnchor = image.sideAnchor;
    sideBlocks = image.sideBlocks;
    mempool.length = 0;
    mempool.push(...image.mempool);
    syncMempoolTags();
    mempoolVault = image.mempoolVault;
    seedCache = image.seedCache;
    evmSession = image.evmSession;
    reorgs.length = 0;
    reorgs.push(...image.reorgs);
    explorer.length = 0;
    explorer.push(...image.explorer);
    rebuildHist();
    syncNoteLedger(blocks);
    policyState = image.policy;
    headers.clear();
    for (const [k, v] of image.headers) headers.set(k, v);
    forks.clear();
    for (const [k, v] of image.forks) forks.set(k, v);
    try { rewriteChain(); } catch { /* memory is already the pre-publish book */ }
    putFileBytes(snapFile, image.snap);
    putFileBytes(vaultSnapFile, image.vaultSnap);
    putFileBytes(vaultFile, image.vaultBytes);
    putFileBytes(explorerFile, image.explorerBytes);
    putFileBytes(policyStatePath, image.policyBytes);
    clearReorgMarkers();
  }

  function stageAdoptFlux(lca, fromBlocks, accepted, connected, keptFlux, adoptedTip) {
    let flux;
    let anchors;
    if (keptFlux) {
      flux = detachFlux(keptFlux);
      if (lca > 0) {
        const keepH = Number(fromBlocks[lca - 1]?.height) || lca;
        anchors = anchorAt.slice(0, keepH + 1).map((rec) => (rec ? { ...rec } : rec));
      } else {
        anchors = [];
      }
    } else {
      flux = emptyFluxset();
      anchors = [];
      for (const b of accepted.slice(0, lca)) {
        appendFluxBlock(flux, b);
        const h = Number(b?.height) || 0;
        anchors[h] = anchorRecord(flux, keepsFrontier(h, adoptedTip, haltDepth));
      }
    }
    for (const b of connected) {
      appendFluxBlock(flux, b);
      const h = Number(b?.height) || 0;
      anchors[h] = anchorRecord(flux, keepsFrontier(h, adoptedTip, haltDepth));
    }
    retainFrontierBlobs(anchors, adoptedTip, haltDepth);
    return { flux, anchors };
  }

  // Replay the vault on a clone. The live checkpoints and unit list stay put until publish.
  function stageAdoptVault(lca, accepted, failAt) {
    if (vaultSeal && accepted.length && !chainHasSealAncestry(accepted, vaultSeal)) {
      return {
        blankOnly: true,
        ckpt: vaultCkpt.filter((c) => c.at < lca).map((c) => ({ at: c.at, vault: cloneVault(c.vault) })),
      };
    }
    const ckpt = vaultCkpt.filter((c) => c.at < lca).map((c) => ({ at: c.at, vault: cloneVault(c.vault) }));
    const units = unitAt.slice(0, Math.min(unitAt.length, lca));
    const tipAt = accepted.length - 1;
    const last = ckpt.length ? ckpt[ckpt.length - 1] : null;
    const trial = last ? cloneVault(last.vault) : cloneVault(bookVault());
    const start = last ? last.at + 1 : 0;
    const chain = accepted.slice(0, start);
    for (let i = start; i <= tipAt; i += 1) {
      const unit = hashBonusUnitNanos(trial.liveHashBonusNanos);
      if (i >= lca || i === units.length) units.push(unit);
      if (Number.isInteger(failAt) && failAt >= 0 && i === lca + failAt) throw new Error('epoch_open');
      commitReserveApply(applyReserveBlock(vaultArgs(trial, accepted[i], chain)));
      chain.push(accepted[i]);
      if (keepOwedIndex(i, tipAt)) ckpt.push({ at: i, vault: cloneVault(trial) });
    }
    let seal = vaultSeal;
    const next = deriveVaultSeal(accepted, trial);
    if (next && (!seal || chainHasSealAncestry(accepted, seal))) seal = next;
    return { blankOnly: false, ckpt, unitAt: units, trial, seal };
  }

  function adopt(arrived, verifyOpts = {}) {
    if (!Array.isArray(arrived) || !arrived.length) return { ok: false, reason: 'empty' };
    verifyOpts = withArrival(arrived, verifyOpts);
    const fork = arrived.map(arrivedBody);
    const knownBad = knownHashBodyReason(fork);
    if (knownBad) return { ...knownBad, tip: tip() };
    const verified = verifyOpts.offLoopPow ? verifyForkAsync(fork, verifyOpts) : verifyFork(fork, verifyOpts);
    const take = (v) => finishAdopt(v, verifyOpts);
    if (verified && typeof verified.then === 'function') return verified.then(take);
    return take(verified);
  }

  function finishAdopt(verified, verifyOpts = {}) {
    if (!verified.ok) return verified;
    const carried = arrivalRefused(verifyOpts);
    if (carried) return carried;
    // The shared prefix is our own block objects: supply, flux and the vault
    // carry from them below, so the chain written to disk is those same
    // blocks, not a peer's copies (knownHashBodyReason held them to our
    // headers and merkle roots; their other fields are not taken).
    const shared = commonPrefixLen(blocks, verified.accepted);
    const accepted = shared > 0 ? blocks.slice(0, shared).concat(verified.accepted.slice(shared)) : verified.accepted;
    rememberFork(accepted, 'valid-fork');
    if (!shouldAdopt(blocks, accepted)) {
      const holdAt = commonPrefixLen(blocks, accepted);
      if (holdAt <= 0) stageSide(-1, accepted);
      else stageSide(holdAt - 1, accepted.slice(holdAt));
      return { ok: false, reason: 'side_hold', tip: tip() };
    }
    const fromBlocks = blocks.slice();
    const broken = reorgBreaksCheckpoint(fromBlocks, accepted, checkpointOpts);
    if (broken) {
      return {
        ok: false,
        reason: 'reorg_checkpoint',
        height: broken.height,
        hash: broken.hash,
        tip: tip(),
      };
    }
    const sealBreak = reorgBreaksVaultSeal(fromBlocks, accepted, vaultSeal);
    if (sealBreak) {
      return {
        ok: false,
        reason: 'reorg_vault_seal',
        height: sealBreak.height,
        hash: sealBreak.hash,
        tip: tip(),
      };
    }
    if (!snapsCoverTip(verified.owedSnaps, accepted.length, verified.owedSeries)) {
      return { ok: false, reason: 'hash_owed', tip: tip() };
    }
    const lca = commonPrefixLen(fromBlocks, accepted);
    const depth = fromBlocks.length - lca;
    if (haltDepth > 0 && depth >= haltDepth) {
      console.error(JSON.stringify({ type: 'REORG_HALT', depth, halt: haltDepth }));
      return { ok: false, reason: 'reorg_halt', depth, halt: haltDepth, tip: tip() };
    }
    const disconnected = fromBlocks.slice(lca);
    const connected = accepted.slice(lca);
    reorgFrom = fromBlocks;
    reorgAccepted = accepted;
    reorgLca = lca;
    const spent = rebuildSpentB();
    const commit = (spentResult) => {
      if (!spentResult || spentResult.ok === false) {
        clearReorgMarkers();
        return {
          ok: false,
          reason: spentResult?.reason || 'share_credit_bind',
          at: spentResult?.at,
          tip: tip(),
        };
      }
      // Fault injection for the adopt tests. A peer ingest does not pass these fields.
      if (verifyOpts.failCommitAfterSpent === true) {
        clearReorgMarkers();
        return { ok: false, reason: 'adopt_aborted', tip: tip() };
      }
      const adoptedTip = Number(accepted[accepted.length - 1]?.height) || accepted.length;
      // One burial tip for the prefix and the suffix: the chain being adopted.
      // Verify already returned this height. The local tip does not raise it.
      // A pruned suffix block keeps that tip unless its own header run is deeper.
      let suffixBurial = Number.isInteger(verified.burialTip) && verified.burialTip >= 0
        ? verified.burialTip
        : adoptedTip;
      const chainBurial = suffixBurial;
      let adoptedSupply;
      let stagedFlux;
      let stagedVault;
      try {
        const keptFlux = fluxKeptThrough(lca, fromBlocks);
        const prefixSupply = lca > 0
          ? supplyCarriedTo(lca - 1, suffixBurial)
          : emptySupplyState(genesisHeaderMs(accepted) || 0);
        if (!prefixSupply) {
          clearReorgMarkers();
          return { ok: false, reason: 'supply', tip: tip() };
        }
        adoptedSupply = supplyAt.slice(0, lca);
        let carriedSupply = prefixSupply;
        const openedVault = vaultParent(accepted, lca, bookMagic);
        if (!openedVault.ok) {
          clearReorgMarkers();
          return { ok: false, reason: 'supply', tip: tip() };
        }
        let carriedVault = openedVault.vault;
        const units = Array.isArray(verified.units) ? verified.units : null;
        const failSupplyAt = Number.isInteger(verifyOpts.failSupplyAt) && verifyOpts.failSupplyAt >= 0
          ? verifyOpts.failSupplyAt
          : null;
        for (let i = lca; i < accepted.length; i += 1) {
          if (verifyOpts.throwSupply === true && i === lca) throw new Error('supply_throw');
          const block = accepted[i];
          const stepH = Number(block?.height) || i + 1;
          suffixBurial = headerRunTip(block, stepH, chainBurial, verifyOpts.provenBurialAt);
          const stepped = supplyStep(carriedSupply, block, {
            unit: units && units[i] != null ? units[i] : undefined,
            height: stepH,
            tipHeight: suffixBurial,
            genesisMs: carriedSupply.genesisMs,
            blockHash: block?.hash,
            magic: bookMagic,
            vault: carriedVault,
          });
          if (!stepped.ok || failSupplyAt === i - lca) {
            clearReorgMarkers();
            return { ok: false, reason: stepped.ok ? 'supply' : (stepped.reason || 'supply'), tip: tip() };
          }
          carriedSupply = stepped.state;
          const advanced = vaultAfterBlock(carriedVault, block, [], { magic: bookMagic });
          if (!advanced.ok) {
            clearReorgMarkers();
            return { ok: false, reason: 'supply', tip: tip() };
          }
          carriedVault = advanced.vault;
          adoptedSupply.push(carriedSupply);
        }
        stagedFlux = stageAdoptFlux(lca, fromBlocks, accepted, connected, keptFlux, adoptedTip);
        const failVaultAt = Number.isInteger(verifyOpts.failVaultApplyAt) && verifyOpts.failVaultApplyAt >= 0
          ? verifyOpts.failVaultApplyAt
          : null;
        stagedVault = stageAdoptVault(lca, accepted, failVaultAt);
      } catch (err) {
        clearReorgMarkers();
        return { ok: false, reason: err?.message || 'adopt_aborted', tip: tip() };
      }
      const nextSpent = spentResult.nextSpent;
      if (!(nextSpent instanceof Set)) {
        clearReorgMarkers();
        return { ok: false, reason: 'share_credit_bind', tip: tip() };
      }
      const image = captureAdoptImage();
      // Same gate as bookFault. A production book ignores the option.
      const fault = (stage) => {
        if (faultHooks && verifyOpts.throwAfterPublish === stage) throw new Error(`adopt_throw_${stage}`);
      };
      try {
        if (injectedFault === 'reorg' || injectedFault === 'reorg-restore') throw new Error('reorg_fault');
        for (const id of spentB) if (!nextSpent.has(id)) spentB.delete(id);
        for (const id of nextSpent) spentB.add(id);
        fault('spent');
        if (fromBlocks.length) rememberFork(fromBlocks, 'valid-fork');
        const event = makeReorgEvent({ fromBlocks, toBlocks: accepted, lca });
        blocks.length = 0;
        for (const b of accepted) blocks.push(b);
        rememberRunBurial(accepted, chainBurial, verifyOpts.provenBurialAt);
        owedRows = verified.owedRows || [];
        acceptedSeries = (verified.owedSeries || []).slice();
        owedSeriesAll = acceptedSeries;
        owedCkpt = verified.owedSnaps
          .filter((s) => keepOwedIndex(s.at, accepted.length - 1))
          .map((s) => ({ at: s.at, rows: copyOwedRows(s.rows), seriesEnd: s.seriesEnd }))
          .sort((a, b) => a.at - b.at);
        seedCache = null;
        if (disconnected.length) {
          sideAnchor = lca > 0 ? lca - 1 : -1;
          sideBlocks = (lca > 0 ? disconnected : fromBlocks).slice();
        } else if (sideTipHash() && sideTipHash() === hex32(blocks[blocks.length - 1]?.hash).toLowerCase()) {
          clearSide();
        }
        rememberHeaders(accepted, 'active');
        fault('blocks');
        rewriteChain();
        fault('chain');
        rebuildExplorer();
        fault('explorer');
        liveFlux = stagedFlux.flux;
        anchorAt = stagedFlux.anchors;
        supplyAt = adoptedSupply;
        supplyTip = supplyAt.length ? supplyAt[supplyAt.length - 1] : null;
        fault('flux');
        if (stagedVault.blankOnly) {
          vaultCkpt = stagedVault.ckpt;
          syncBlankFlag();
          saveReserve();
        } else {
          vaultCkpt = stagedVault.ckpt;
          unitAt = stagedVault.unitAt;
          installVault(stagedVault.trial);
          vaultSeal = stagedVault.seal;
          syncBlankFlag();
          saveReserve();
        }
        fault('vault');
        bounceMempool(disconnected, connected);
        dropStaleFlowSpends();
        pruneBuried();
        fault('tail');
        reorgs.push(event);
        if (reorgs.length > 64) reorgs.splice(0, reorgs.length - 64);
        refreshPolicy({ reorgDepth: event.depth, nowMs: Date.now() });
        persistBookSnap();
        fault('snap');
        fault('emit');
        emit('reorg', event);
        emit('tip', { hash: hex32(tip().hash), height: tip().height, reorg: true });
        evmSession = null;
        clearReorgMarkers();
        return { ok: true, reorg: true, tip: tip(), event };
      } catch (err) {
        try {
          if (injectedFault === 'reorg-restore' || (faultHooks && verifyOpts.failRestore === true)) {
            throw new Error('restore failed');
          }
          restoreAdoptImage(image);
        } catch (restoreErr) {
          throw asCommitFault(restoreErr, 'post-commit');
        }
        return { ok: false, reason: err?.message || 'adopt_aborted', tip: tip() };
      }
    };
    if (spent && typeof spent.then === 'function') return spent.then(commit);
    return commit(spent);
  }

  // The header run is stored against the block hash, including a side chain
  // that has not won yet. A later extension reads it back. The chain tip is
  // not raised for blocks this run does not stand above.
  function rememberRunBurial(list, chainTip, at) {
    if (!at) return;
    const floor = Number(chainTip) || 0;
    let noted = false;
    for (const b of list || []) {
      const h = Number(b?.height) || 0;
      const rec = burialAt(at, h);
      if (!rec || b?.samplesPruned !== true) continue;
      const own = rec.top;
      if (!Number.isInteger(own) || !(own > floor) || !shouldPruneSamples(h, own)) continue;
      if (rec.claimed) {
        let got = null;
        try {
          const raw = Buffer.from(b.hash);
          if (raw.length === 32) got = raw;
        } catch { got = null; }
        if (!got || !got.equals(rec.claimed)) continue;
      }
      if (provenTipOf(b) != null) continue;
      burialProof.note(blockHex(b), h, own);
      noted = true;
    }
    if (noted) burialProof.save();
  }

  function locateFork(fork) {
    let decoded;
    try { decoded = decodeHeader(Buffer.from(fork[0].header)); } catch { return null; }
    const t = tip();
    const prev = decoded.prevBlockHash;
    // The prefix is built only when a pruned block needs its history: a copy
    // of the chain per ingested block made IBD quadratic.
    if (t ? prev.equals(Buffer.from(t.hash)) : prev.equals(GENESIS_PREV)) {
      return { parentH: Number(t?.height) || 0, prefixOf: () => blocks.slice() };
    }
    const prevHex = Buffer.from(prev).toString('hex').toLowerCase();
    const anchorIdx = chainIndexOf(chainIndex, blocks, prevHex);
    if (anchorIdx >= 0) {
      const parent = blocks[anchorIdx];
      return {
        parentH: Number(parent?.height) || (anchorIdx + 1),
        prefixOf: () => blocks.slice(0, anchorIdx + 1),
      };
    }
    if (sideBlocks.length && prevHex === sideTipHash()) {
      const chain = sideChain();
      const last = chain[chain.length - 1];
      return { parentH: Number(last?.height) || chain.length, prefixOf: () => chain };
    }
    if (prev.equals(GENESIS_PREV)) return { parentH: 0, prefixOf: () => [] };
    return null;
  }

  function burialAnchor(block, structuralH, history) {
    let ownTs = 0;
    try { ownTs = Number(decodeHeader(Buffer.from(block.header)).timestamp); } catch { ownTs = 0; }
    const prior = (history || []).slice(-(MTP_WINDOW - 1)).map(blockTimeMs);
    const genesisMs = history && history.length ? blockTimeMs(history[0]) : ownTs;
    return { height: structuralH, genesisMs, mtp: prior.concat([ownTs]) };
  }

  function heightFieldLied(block, structuralH) {
    return block?.height != null && block.height !== '' && Number(block.height) !== structuralH;
  }

  // Fork and adopt paths. A tip-extending single block stays on append, which
  // already proves. A missing run is not hashed; verify answers continuity
  // or height before samples_pruned. A full run is hashed off-loop when the
  // caller asked for that, and only that block's tip is raised.
  function ensurePrunedBurial(fork, verifyOpts) {
    const located = locateFork(fork);
    if (!located) return { ok: true, verifyOpts };
    const { parentH, prefixOf } = located;
    const forkTip = parentH + fork.length;
    const need = [];
    for (let i = 0; i < fork.length; i += 1) {
      const block = fork[i];
      if (block?.samplesPruned !== true) continue;
      const structuralH = parentH + i + 1;
      if (shouldPruneSamples(structuralH, forkTip)) continue;
      if (heightFieldLied(block, structuralH)) continue;
      let hex = '';
      try { hex = Buffer.from(block.hash).toString('hex'); } catch { hex = ''; }
      // No cached run is not hashed. Verify still answers continuity, height,
      // then samples_pruned. A present run is the only thing proved here.
      if (!hex || !offeredPath(hex)) continue;
      need.push({ block, structuralH, index: i });
    }
    if (!need.length) return { ok: true, verifyOpts };
    const prefix = prefixOf();
    const proveAt = (n, at) => {
      if (n >= need.length) return { ok: true, verifyOpts: { ...verifyOpts, provenBurialAt: at } };
      const item = need[n];
      const history = prefix.concat(fork.slice(0, item.index));
      const proved = proveBurial(item.block, verifyOpts, burialAnchor(item.block, item.structuralH, history));
      const take = (p) => {
        let claimed = null;
        try {
          if (p?.ok && p.claimed != null) {
            const raw = Buffer.from(p.claimed);
            if (raw.length === 32) claimed = raw;
          }
        } catch { claimed = null; }
        const next = claimed
          ? { ...at, [item.structuralH]: { top: p.top, claimed } }
          : at;
        return proveAt(n + 1, next);
      };
      if (proved && typeof proved.then === 'function') return proved.then(take);
      return take(proved);
    };
    return proveAt(0, {});
  }

  function ingestBuried(fork, verifyOpts, apply) {
    const ready = ensurePrunedBurial(fork, verifyOpts);
    const go = (row) => (row?.ok ? apply(row.verifyOpts) : row);
    if (ready && typeof ready.then === 'function') return ready.then(go);
    return go(ready);
  }

  let offLoopGate = Promise.resolve();

  /**
   * A block under a hash this chain already holds is that block only if it
   * carries our header bytes and its body rebuilds the merkle root that
   * header seals. Otherwise it is refused, never taken as ours: a known hash
   * does not stand in for a body check.
   */
  function knownHashBodyReason(fork) {
    for (let i = 0; i < fork.length; i += 1) {
      const b = fork[i];
      const hex = blockHex(b);
      const at = hex ? chainIndexOf(chainIndex, blocks, hex) : -1;
      if (at < 0) continue;
      let header;
      try { header = Buffer.from(b.header); } catch { return { ok: false, reason: 'bad_header', at: i }; }
      if (!header.equals(Buffer.from(blocks[at].header))) return { ok: false, reason: 'known_hash_header', at: i };
      let sealed;
      try { sealed = Buffer.from(decodeHeader(header).merkleRoot); } catch { return { ok: false, reason: 'bad_header', at: i }; }
      const leaves = blockLeaves(b.txs || []);
      if (!leaves) return { ok: false, reason: 'duplicate_tx', at: i };
      if (!merkleRoot(leaves).equals(sealed)) return { ok: false, reason: 'merkle', at: i };
    }
    return null;
  }

  function ingestInner(arrived, verifyOpts = {}) {
    if (!Array.isArray(arrived) || !arrived.length) return { ok: false, reason: 'empty' };
    verifyOpts = withArrival(arrived, verifyOpts);
    const fork = arrived.map(arrivedBody);
    const knownBad = knownHashBodyReason(fork);
    if (knownBad) return { ...knownBad, tip: tip() };
    const stage0 = chainStage0Rejected(fork);
    if (stage0) return stage0;
    const t = tip();
    let decoded;
    try {
      decoded = decodeHeader(Buffer.from(fork[0].header));
    } catch {
      return { ok: false, reason: 'bad_header' };
    }
    const extendsTip = t
      ? decoded.prevBlockHash.equals(Buffer.from(t.hash))
      : decoded.prevBlockHash.equals(GENESIS_PREV);
    // One new block extends the tip in place. A batch is one chain: burial
    // is that batch's own height, so pruned history is not judged at depth 0.
    if (extendsTip && fork.length === 1) {
      if (verifyOpts.offLoopPow || fork.some((b) => blockNeedsEvm(b?.txs || []))) {
        return (async () => {
          let last = null;
          for (const b of fork) {
            const got = await Promise.resolve(append(b, verifyOpts));
            if (!got.ok) return last || got;
            last = got;
          }
          return last;
        })();
      }
      let last = null;
      for (const b of fork) {
        const got = append(b, verifyOpts);
        if (!got.ok) return last || got;
        last = got;
      }
      return last;
    }
    if (extendsTip && fork.length > 1) {
      if (!blocks.length) return ingestBuried(fork, verifyOpts, (opts) => adopt(fork, opts));
      return ingestBuried(fork, verifyOpts, (opts) => stageOrAdopt(fork, opts, blocks.length - 1));
    }
    const prevHex = Buffer.from(decoded.prevBlockHash).toString('hex').toLowerCase();
    const anchorIdx = chainIndexOf(chainIndex, blocks, prevHex);
    if (anchorIdx >= 0 || (sideBlocks.length && prevHex === sideTipHash())) {
      return ingestBuried(fork, verifyOpts, (opts) => stageOrAdopt(fork, opts, anchorIdx));
    }
    return ingestBuried(fork, verifyOpts, (opts) => adopt(fork, opts));
  }

  function ingest(fork, verifyOpts = {}) {
    if (!verifyOpts?.offLoopPow) return ingestInner(fork, verifyOpts || {});
    const run = () => ingestInner(fork, verifyOpts);
    const queued = offLoopGate.then(run, run);
    offLoopGate = queued.then(() => {}, () => {});
    return queued;
  }

  function dest20Equals(row20, want) {
    if (!row20 || !want) return false;
    try {
      return Buffer.from(asU8(row20)).equals(Buffer.from(want));
    } catch {
      return false;
    }
  }

  function noteCommitAgrees(rowNc, wantNc) {
    if (!wantNc || rowNc == null || rowNc === '') return null;
    try {
      const nc = Buffer.from(asU8(rowNc));
      if (nc.length !== 32) return null;
      return nc.equals(Buffer.from(wantNc));
    } catch {
      return null;
    }
  }

  // Pot and hash rows are sealed to a noteCommit. A painted `to` or `toDest20`
  // must not spend that row to a different dest (sole hasher ← N × 0.99).
  function coinbaseLike(r) {
    const k = String(r?.kind || '');
    return k === 'coinbase' || k === 'hash' || k === 'pot' || k === 'pool-fee';
  }

  function historyFor(address) {
    const addr = String(address || '').trim();
    const h20 = hash20FromAddress(addr);
    const wantNc = h20 ? noteCommitOfDest20(h20) : null;
    const toOwns = (r) => {
      if (r.to !== addr) return false;
      if (coinbaseLike(r) && noteCommitAgrees(r.noteCommit, wantNc) === false) return false;
      if (h20 && r.toDest20 && !dest20Equals(r.toDest20, h20)) return false;
      return true;
    };
    const fromOwns = (r) => {
      if (r.from !== addr) return false;
      if (h20 && r.fromDest20 && !dest20Equals(r.fromDest20, h20)) return false;
      return true;
    };
    const toDestOwns = (r) => {
      if (!h20 || !dest20Equals(r.toDest20, h20)) return false;
      if (coinbaseLike(r) && noteCommitAgrees(r.noteCommit, wantNc) === false) return false;
      return true;
    };
    syncHist();
    return histCandidates(addr, h20, wantNc).filter((r) => {
      if (toOwns(r) || fromOwns(r)) return true;
      if (h20 && dest20Equals(r.fromDest20, h20)) return true;
      if (toDestOwns(r)) return true;
      if (noteCommitAgrees(r.noteCommit, wantNc) === true) return true;
      return false;
    }).map((r) => {
      let row = r;
      const ncOk = noteCommitAgrees(r.noteCommit, wantNc) === true;
      if (h20 && dest20Equals(r.fromDest20, h20)) row = { ...row, from: addr };
      if (h20 && dest20Equals(r.toDest20, h20) && !(coinbaseLike(r) && noteCommitAgrees(r.noteCommit, wantNc) === false)) {
        row = { ...row, to: addr };
      } else if (ncOk) {
        row = { ...row, to: addr };
      }
      return row;
    });
  }

  function spendableNanos(address) {
    const tipH = tip()?.height || 0;
    return destSpendableNanos(address, tipH);
  }

  const viewByAddress = new Map();
  const addressByView = new Map();
  function registerViewKey(address, viewKey) {
    const addr = String(address || '').trim();
    const vk = String(viewKey || '').trim();
    if (!addr || !vk) return { ok: false };
    viewByAddress.set(addr, vk);
    addressByView.set(vk, addr);
    return { ok: true, address: addr };
  }
  function addressForViewKey(viewKey) {
    return addressByView.get(String(viewKey || '').trim()) || '';
  }
  function viewKeyForAddress(address) {
    return viewByAddress.get(String(address || '').trim()) || '';
  }

  let jobSeq = 1;
  const jobs = new Map();
  const mempool = [];
  const mempoolTags = new Map();
  function syncMempoolTags() {
    mempoolTags.clear();
    for (const row of mempool) rememberMempoolTag(mempoolTags, row);
  }
  // Null means the running trial is stale. The next reserve arrival rebuilds it.
  let mempoolVault = null;
  const openRound = new Map();
  const OPEN_ROUND_TTL_MS = 180_000;
  const peerRoundBudget = new Map();

  function dropOldestPeerRound() {
    let oldestKey = '';
    let oldestAt = Infinity;
    for (const [key, row] of openRound) {
      if (row.source === 'local') continue;
      if (row.at < oldestAt) {
        oldestAt = row.at;
        oldestKey = key;
      }
    }
    if (!oldestKey) return false;
    openRound.delete(oldestKey);
    return true;
  }

  function peerBudget(peer, now) {
    const key = String(peer || '');
    let row = peerRoundBudget.get(key);
    if (row) peerRoundBudget.delete(key);
    if (!row) {
      while (peerRoundBudget.size >= OPEN_ROUND_PEER_BUDGETS) {
        const oldest = peerRoundBudget.keys().next().value;
        if (oldest == null) break;
        peerRoundBudget.delete(oldest);
      }
      row = { windowStart: now, used: 0, tags: new Set() };
    } else if (now - row.windowStart >= OPEN_ROUND_PEER_WINDOW_MS) {
      row.windowStart = now;
      row.used = 0;
      row.tags.clear();
    }
    peerRoundBudget.set(key, row);
    return row;
  }

  function noteOpenRound(rows = [], { source = 'local', peer = '', now = Date.now() } = {}) {
    const local = source === 'local';
    const inspect = local ? OPEN_ROUND_CAP : OPEN_ROUND_PEER_TAGS * 4;
    const list = Array.isArray(rows) ? rows.slice(0, inspect) : [];
    const budget = local ? null : peerBudget(peer, now);
    const accepted = [];
    for (const [key, row] of openRound) {
      if (now - row.at > OPEN_ROUND_TTL_MS) {
        openRound.delete(key);
        const owner = peerRoundBudget.get(row.peer);
        if (owner) owner.tags.delete(key);
      }
    }
    for (const r of list) {
      const tag = String(r?.tag || '').trim().toLowerCase();
      if (!/^m[0-9a-f]{8}$/.test(tag)) continue;
      const count = Math.floor(Number(r.count) || 0);
      if (count < 1) continue;
      if (budget) {
        const known = budget.tags.has(tag);
        if (!known && budget.tags.size >= OPEN_ROUND_PEER_TAGS) continue;
        if (budget.used >= OPEN_ROUND_PEER_RATE) continue;
      }
      const prev = openRound.get(tag);
      const take = !prev || local || count >= prev.count || (now - prev.at) > 12_000;
      if (!take) continue;
      if (!prev && openRound.size >= OPEN_ROUND_CAP && !(local && dropOldestPeerRound())) continue;
      openRound.set(tag, {
        tag,
        count,
        at: now,
        source: local ? 'local' : 'peer',
        peer: local ? '' : String(peer || ''),
      });
      if (budget) {
        budget.used += 1;
        budget.tags.add(tag);
      }
      if (!prev || count > prev.count) accepted.push({ tag, count });
    }
    return accepted;
  }

  function clearOpenRound() {
    openRound.clear();
  }

  function openRoundRows() {
    const now = Date.now();
    const out = [];
    for (const [k, v] of openRound) {
      if (now - v.at > OPEN_ROUND_TTL_MS) openRound.delete(k);
      else out.push({ tag: v.tag, count: v.count, source: v.source });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  // Chain tags stay in the live set. Copying them once per admit, or once per
  // template, grows with chain history. The overlay is only this build's tags.
  function chainSpendView(chain) {
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

  function template({ miner, samples = [], shareBits = 16, bits: bitsIn, potShares = null, now: nowIn, wallIntervalMs = null, shareBatch = null, hashSpill = null, poolDest = null, feeDest = null, finderDest, hashBonusCustodyDest = null, issuedHeaders = null, feeKey = null, feeBps = 0, potToFee = false } = {}) {
    void hashBonusCustodyDest;
    const t = tip();
    const height = t ? t.height + 1 : 1;
    const wall = nowIn != null ? Number(nowIn) : Date.now();
    let now = wall;
    if (bitsIn == null && t?.header) {
      try {
        const parent = decodeHeader(Buffer.from(t.header));
        const mtp = medianTimePast(blocks.slice(-MTP_WINDOW).map((b) => blockTimeMs(b)));
        now = templateStampMs(parent.timestamp, wall, wallIntervalMs, mtp);
      } catch { /* keep wall */ }
    }
    // Sealed parent interval only. Caller bits (share target, boot override,
    // a private easier job) must not undercut the header miners are offered.
    const bits = retarget(blocks, now, bookMagic);
    void bitsIn;
    const lag1 = lag1Continuity(t ? t.header : null);
    let baseFeeNow = 1;
    try {
      if (t?.header) baseFeeNow = Number(decodeHeader(Buffer.from(t.header)).baseFee || 1n);
    } catch { baseFeeNow = 1; }
    const book = emptyMempool();
    book.baseFee = baseFeeNow;
    const pendingTxs = [];
    const keep = [];
    const spendSeen = chainSpendView(liveFlux.spendTags);
    const bSpent = new Set(spentB);
    // One clone of the chain vault. Each accepted reserve tx mutates that
    // clone. A miss undoes itself and does not clone the portal map again.
    let carried = cloneVault(reserveVault);
    let reserveIncluded = 0;
    let retireIncluded = 0;
    let reserveDropped = false;
    const budgetStarted = performance.now();
    const announced = Array.isArray(shareBatch) ? shareBatch.length
      : (Array.isArray(t?.nextShareBatch) ? t.nextShareBatch.length : 0);
    const coinbaseWeight = W_PAYEE * (Math.min(payeeCapLive(), announced) + 3);
    const chosen = new Set(selectBodyIndexes(mempool, { coinbaseWeight }));
    const walk = [];
    for (let i = 0; i < mempool.length; i += 1) {
      if (chosen.has(i)) walk.push(i);
      else keep.push(mempool[i]);
    }
    for (const idx of walk) {
      const raw = mempool[idx];
      const m = keepHeldKey(reviveTx(raw), raw);
      const tx = sealedFormOf(m, { continuityRoot: lag1, height });
      if (pause.poolWithdraw && tx.kind === 'pool-withdraw') continue;
      const bucket = v3BucketProofRejected(tx);
      if (bucket) {
        try {
          console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: bucket.reason }));
        } catch { /* ignore */ }
        continue;
      }
      const userCb = userCoinbaseRejected(tx);
      if (userCb) {
        try {
          console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: userCb.reason }));
        } catch { /* ignore */ }
        continue;
      }
      const earlyKind = v12KindRejected(tx);
      if (earlyKind) {
        try {
          console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: earlyKind.reason }));
        } catch { /* ignore */ }
        continue;
      }
      const explicitKind = explicitTypedKindRejected(tx);
      if (explicitKind) {
        try {
          console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: explicitKind.reason }));
        } catch { /* ignore */ }
        continue;
      }
      const typedVin = typedCommitRejected(tx);
      if (typedVin) {
        try {
          console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: typedVin.reason }));
        } catch { /* ignore */ }
        continue;
      }
      const earlyOpen = valueOpenRejected(tx);
      if (earlyOpen) {
        try {
          console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: earlyOpen.reason }));
        } catch { /* ignore */ }
        continue;
      }
      const leafAsk = bLeafAskRejected(tx);
      if (leafAsk) {
        try {
          console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: leafAsk.reason }));
        } catch { /* ignore */ }
        continue;
      }
      if (String(tx.kind || '') === 'b-spend') {
        const carriedProof = unboundMembershipCarry(tx);
        if (!carriedProof.ok) {
          try {
            console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: carriedProof.reason }));
          } catch { /* ignore */ }
          continue;
        }
        let boundB;
        try {
          boundB = bindBSpend(tx, {
            history: blocks,
            prev: t,
            tipHeight: height,
            spent: bSpent,
          });
        } catch {
          boundB = { ok: false, reason: 'leaf' };
        }
        if (!boundB.ok) {
          try {
            console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: boundB.reason }));
          } catch { /* ignore */ }
          if (boundB.reason === 'immature' || boundB.reason === 'pre_seal') keep.push(m);
          continue;
        }
      }
      if (txIsReserveAction(tx) && reserveIncluded >= RESERVE_ACTION_CAP) {
        keep.push(m);
        continue;
      }
      const retireAdding = txIsReserveAction(tx) ? txRetireDleqs(tx) : 0;
      if (retireCapHit(retireIncluded, tx)) {
        keep.push(m);
        try {
          console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: 'retire_cap' }));
        } catch { /* ignore */ }
        continue;
      }
      // Chain notes do not cover a painted spend, so it stays queued and out of the block.
      if (paintedSpendSig(tx)) {
        const held = fundedDebit(tx);
        const boundVin = Array.isArray(tx.vin) && tx.vin.some((v) => v && (v.commit || v.prev));
        if (held && !boundVin) {
          const have = destSpendableNanos(held.from, Number(t?.height || 0));
          if (have < held.nanos) {
            keep.push(m);
            try {
              console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: 'painted_hold' }));
            } catch { /* ignore */ }
            continue;
          }
        }
      }
      const live = liveFlux;
      const admitOpts = {
        baseFee: baseFeeNow,
        fluxset: live,
        spendTags: spendSeen,
        commits: live.commits,
        reserveState: reserveVault,
        nowMs: now,
        height,
        blocks,
        magic: bookMagic,
        noteAtAnchor: (anchor) => noteFromAnchor(liveFlux, anchorAt, anchor),
      };
      if (txIsReserveAction(tx)) {
        if (performance.now() - budgetStarted >= TEMPLATE_BUDGET_MS) {
          keep.push(m);
          continue;
        }
        admitOpts.reserveCarried = carried;
        admitOpts.verifiedFund = fundVerdictFor(tx);
        // Mark the leaf now. One tree rebuild, after this walk, covers the body.
        admitOpts.deferVaultRoot = true;
      }
      admitOpts.selfKey = heldBodyKey(raw);
      const got = admitMempool(book, tx, admitOpts);
      if (got.ok) {
        pendingTxs.push(got.tx);
        keep.push(m);
        if (got.vaultState) {
          carried = got.vaultState;
          reserveIncluded += 1;
          if (retireAdding != null) retireIncluded += retireAdding;
        }
        for (const tag of txSpendTags(got.tx).tags) spendSeen.add(tag.toString('hex'));
        if (Array.isArray(got.tags)) {
          for (const th of got.tags) if (th) spendSeen.add(String(th));
        }
      } else {
        console.error(JSON.stringify({ event: 'mempool_skip', id: m.id, reason: got.reason }));
        if (txIsReserveAction(tx) && (got.vault || got.reason === 'admit' || got.reason === 'admit_link_tag')) {
          reserveDropped = true;
        }
        const permanent = got.reason === 'kind'
          || got.reason === 'b_debit'
          || got.reason === 'b_leaves'
          || got.reason === 'commit_sum'
          || got.reason === 'proof'
          || got.reason === 'continuity'
          || got.reason === 'bad_header'
          || got.reason === 'double_open'
          || got.reason === 'no_header'
          || got.reason === 'admit'
          || got.reason === 'admit_link_tag';
        if (!got.vault && !permanent) keep.push(m);
      }
    }
    if (carried && carried.vaultLockDirty) {
      const rooted = commitVaultLockRoot(carried);
      if (!rooted) reserveDropped = true;
    }
    mempool.length = 0;
    mempool.push(...keep);
    syncMempoolTags();
    if (reserveDropped) mempoolVault = null;
    else if (mempool.filter(txIsReserveAction).length === reserveIncluded) mempoolVault = carried;
    const tpl = buildTemplate({
      prev: t ? t.hash : GENESIS_PREV,
      prevHeader: t ? t.header : null,
      prevBlock: t,
      parentWeight: t ? (t.weight ?? undefined) : 1,
      height,
      miner,
      samples,
      potShares,
      txs: pendingTxs,
      now,
      bits,
      hashBonusNanos: hashBonusUnitNanos(reserveVault.liveHashBonusNanos),
      shareBatch: Array.isArray(shareBatch) ? shareBatch : (Array.isArray(t?.nextShareBatch) ? t.nextShareBatch : []),
      hashSpill: Array.isArray(hashSpill) ? hashSpill : [],
      poolDest,
      feeDest,
      finderDest,
      parentBlocks: blocks,
      parentFluxset: liveFlux,
      hashOwedIn: owedRows,
      hashAcceptedSeries: acceptedSeries.slice(),
      issuedHeaders,
      // R28: the pool's own one-time fee key and fee rate (no address).
      feeKey,
      feeBps,
      potToFee,
      prepareCoinbase: (cb) => {
        const root = coinbaseRewardRoot(reserveVault, now);
        if (root) cb.rewardRoot = root;
        // The contract reads the frozen period root and the census from this
        // coinbase. A claim looks the root up by its earn epoch, and a leaf
        // vote is NotVoter until both are stored.
        const starts = new Map();
        const censusRows = new Map();
        for (const tx of pendingTxs) {
          if (!tx) continue;
          const kind = String(tx.kind || '');
          if (kind !== 'reward-claim' && kind !== 'leaf-vote') continue;
          if (kind === 'reward-claim' && !tx.vaultProof) continue;
          if (kind === 'leaf-vote' && !tx.voteProof) continue;
          const earn = Math.floor(Number(tx.earnEpoch ?? tx.rootEpoch) || 0);
          if (!Number.isInteger(earn) || earn < 0) continue;
          const start = String(reserveVault.epochStartRoots?.[String(earn)] || '').toLowerCase();
          if (/^[0-9a-f]{64}$/.test(start)) starts.set(earn, start);
          if (kind !== 'leaf-vote') continue;
          const census = reserveVault.epochCensus?.[String(earn)];
          const leaves = Math.floor(Number(census?.leafCount) || 0);
          const openH = Math.floor(Number(census?.openHeight) || 0);
          if (census?.known && leaves >= 1 && openH >= 0) {
            censusRows.set(earn, { epoch: earn, leafCount: leaves, openHeight: openH });
          }
        }
        if (starts.size) {
          cb.epochStartCommits = [...starts.entries()].map(([epoch, rootHex]) => ({ epoch, root: rootHex }));
          cb.epochStartRoot = cb.epochStartCommits[0].root;
        }
        if (censusRows.size) cb.epochCensusCommit = [...censusRows.values()];
      },
    });
    const jobId = `shear-${height}-${jobSeq++}`;
    const job = publicJob(tpl, { jobId, shareBits });
    const gate = requiredJobFields(job);
    if (!gate.ok) throw new Error(`incomplete_job:${gate.missing.join(',')}`);
    rememberStoredJob(jobs, jobId, { tpl, job, shareBits });
    return { tpl, job };
  }

  function submitHeader({ jobId, nonce, miner, powHash, skipSharePow, trustedPowHash } = {}, verifyOpts = {}) {
    const rec = jobs.get(String(jobId));
    if (!rec) return { ok: false, reason: 'stale_job' };
    const header = setNonce(rec.tpl.header, BigInt(nonce));
    const block = {
      header,
      txs: rec.tpl.txs,
      samples: rec.tpl.samples,
      shareBatch: rec.tpl.shareBatch || [],
      hashSpill: Array.isArray(rec.tpl.hashSpill) ? rec.tpl.hashSpill : [],
      miner: destForLogin(miner) || miner || rec.tpl.miner,
      poolDest: rec.tpl.poolDest || rec.tpl.miner || '',
      aLeaves: rec.tpl.aLeaves,
      bLeaves: rec.tpl.bLeaves,
      rootA: rec.tpl.rootA,
      rootB: rec.tpl.rootB,
    };
    // Wire/RPC/P2P cannot skip share PoW. In-process pool may pass { trusted: true }
    // after it has already verified the claimed digest.
    const allowTrust = verifyOpts?.trusted === true;
    const claimed = powHash ? Buffer.from(String(powHash), 'hex') : null;
    const okHash = allowTrust && claimed && claimed.length === 32 ? claimed : null;
    if (claimed && claimed.length === 32) block.hash = claimed;
    void skipSharePow;
    void trustedPowHash;
    return append(block, { trustedPowHash: okHash, skipSharePow: !!okHash });
  }

  loadPolicyState();
  refreshPolicy({ newBlock: false });

  return {
    dir,
    blocks,
    loadMode,
    explorer,
    tip,
    chainWorkHex() {
      try {
        return `0x${chainWorkOf(blocks).toString(16)}`;
      } catch {
        return '0x0';
      }
    },
    append,
    verifyFork,
    adopt,
    ingest,
    template,
    submitHeader,
    probeBlock,
    /**
     * A digest (hex) of the live Reserve EVM state: every account, code and
     * storage slot the session holds, in key order. Null before the first EVM
     * block. Read-only. The session's SimpleStateManager keeps no trie, so
     * this hashes its live maps instead of asking for a state root.
     */
    evmStateDigest() {
      const sm = evmSession?.evm?.stateManager;
      if (!sm || typeof sm.topAccountStack !== 'function') return null;
      const h = createHash('sha256').update('shear-evm-state-digest-v1');
      const part = (tag, map, enc) => {
        for (const key of [...map.keys()].sort()) {
          const v = enc(map.get(key));
          h.update(`${tag}:${key}:${v.length}:`).update(v);
        }
      };
      const bytes = (v) => (v == null ? Buffer.alloc(0) : Buffer.from(v));
      part('a', sm.topAccountStack(), (a) => (a == null ? Buffer.from('-') : Buffer.from(a.serialize())));
      part('c', sm.topCodeStack(), bytes);
      part('s', sm.topStorageStack(), bytes);
      return h.digest('hex');
    },
    jobs,
    mempool,
    spentB,
    reorgMeasure() {
      return lastReorgMeasure;
    },
    queueTx,
    noteOpenRound,
    openRoundRows,
    clearOpenRound,
    hashHex,
    headerHash,
    historyFor,
    spendableNanos,
    noteRefs(address) {
      syncNoteLedger(blocks);
      return noteLedger.refs(address);
    },
    walletWalkStats() {
      const notes = noteLedger.stats();
      return {
        ...notes,
        histQueryRows,
        histSyncRows,
        spendChecks,
        forkSpendChecks,
      };
    },
    resetWalletWalkStats() {
      noteLedger.resetQuery();
      histQueryRows = 0;
      histSyncRows = 0;
      spendChecks = 0;
      forkSpendChecks = 0;
    },
    sideTipHash,
    sideHashes() {
      return sideBlocks.map((b) => hex32(b.hash).toLowerCase()).filter(Boolean);
    },
    flushBookSnap() {
      persistBookSnap();
    },
    pruneBuried,
    pruneAfter,
    fastSync: archiveFast,
    archival: !archiveFast,
    registerViewKey,
    addressForViewKey,
    viewKeyForAddress,
    reserveVault,
    saveReserve,
    vortice,
    mintVorticeDeployKey: vortice.mintVorticeDeployKey,
    mintVorticeFromOrigin: vortice.mintFromOrigin,
    lookupVorticeKey: vortice.lookupByKey,
    listPublicVortices: vortice.listPublic,
    on,
    emit,
    getpolicy: () => {
      const p = policyView(policyState);
      const v = vaultSealView();
      return {
        ...p,
        vault_seal_height: v.height,
        vault_seal_hash: v.hash,
        vault_seal_commitment: v.commitment,
        vault_seal_ancestry: v.ancestry,
        vault_seal_banner: v.banner,
        blank_fork: v.blankFork,
      };
    },
    vaultSeal: () => (vaultSeal ? { ...vaultSeal } : null),
    vaultSealView,
    getchaintips,
    getreorgs: () => reorgs.slice(),
    fluxset: () => ({
      pubs: liveFlux.pubs.slice(),
      commits: (liveFlux.commits || []).slice(),
      spendTags: new Set(liveFlux.spendTags),
      jroot: liveFlux.jroot,
    }),
    // Flux through blocks[index], frontiers included. A fork template extends
    // this instead of rebuilding J from genesis.
    fluxThrough(index) {
      const end = Number(index);
      if (!Number.isInteger(end) || end < 0) return null;
      const flux = fluxThroughIndex(blocks, end);
      return flux ? detachFlux(flux) : null;
    },
    offerHeaders,
    offerPeerDropped,
    servableBlock,
    burialView() {
      const tipH = Number(tip()?.height) || 0;
      return {
        tip: tipH,
        settled: settledHeight(tipH, checkpointOpts),
        held: burialHold.count(),
        heldHeights: burialHold.heights(),
        heldBytes: burialHold.diskBytes(),
        proven: burialProof.count(),
        provenHeights: burialProof.heights(),
        offered: offeredRows.size,
        provenHeaders: provenRows.size,
        offerPeers: offerSlots.size,
        offerPeerRows: Object.fromEntries([...offerSlots].map(([p, slot]) => [p, slot.rows.size])),
        offerSlotTiers: Object.fromEntries([...offerSlots].map(([p, slot]) => [p, slot.tier])),
        droppedPeers: [...droppedPeers.keys()],
        ...offerStats,
      };
    },
    provenBurialTip(block) {
      return provenTipOf(block);
    },
    anchorNote(anchor) {
      return noteFromAnchor(liveFlux, anchorAt, Number(anchor));
    },
    jroot: () => liveFlux.jroot,
    anchorView() {
      const tipH = blocks.length ? (Number(blocks[blocks.length - 1]?.height) || blocks.length) : 0;
      let roots = 0;
      let withFrontier = 0;
      let blobBytes = 0;
      let maxBlob = 0;
      const heights = [];
      for (let h = 1; h <= tipH; h += 1) {
        const rec = anchorAt[h];
        if (!rec?.jroot || rec.jroot.length !== 32) continue;
        roots += 1;
        const f = rec.frontier?.length || 0;
        const z = rec.zeroFrontier?.length || 0;
        if (f > maxBlob) maxBlob = f;
        if (z > maxBlob) maxBlob = z;
        if (f || z) {
          withFrontier += 1;
          blobBytes += f + z;
          heights.push(h);
        }
      }
      return { tip: tipH, roots, withFrontier, blobBytes, maxBlob, heights };
    },
    hashTxLive: HASH_TX_LIVE,
    magic: bookMagic,
    tipExtendPowOpts,
    tipExtendPowReason,
    consensusFingerprint,
    pause,
    reorgHaltDepth: haltDepth,
    headers,
    policyState,
    supplyState() {
      return publishedSupply(supplyTip, tip());
    },
    owedView() {
      return {
        rows: copyOwedRows(owedRows),
        series: acceptedSeries.slice(),
        checkpoints: owedCkpt.map((c) => ({
          at: c.at,
          seriesEnd: c.seriesEnd,
          rowCount: Array.isArray(c.rows) ? c.rows.length : 0,
        })),
      };
    },
    owedSeedStats() {
      return { ...owedSeed };
    },
  };
}

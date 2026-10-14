import { createHash } from 'node:crypto';
import { epochMs, epochDays, vortexEpochIndex } from './pot_sched.js';

/**
 * The Reserve oracle. The epoch rate is the attested 14-bank bundle below.
 * Live fetches of central-bank sites are not consensus: two nodes cannot
 * be required to see the same page at the same time. Disk JSON, a coinbase
 * field, an admin, and a miner observation are not inputs.
 */
export const RESERVE_ORACLE_ID = 'shear-reserve-oracle-v1';
/**
 * Trimmed mean of the bundled policy rates (drop 2 high and 2 low, half-up
 * the middle 10). 2840 tenths → 284 bps. Not a single-bank print.
 * Attester keys are not consensus until Russell decides.
 */
export const GENESIS_BPS = 284;
export const RESERVE_ORACLE_DEFAULT_BPS = GENESIS_BPS;
export const REWARD_DENOM_DAYS = 400;
export const INTEREST_DENOM_DAYS = REWARD_DENOM_DAYS;
export const ORACLE_MAX_AGE_MS = 14 * 86_400_000;
export const ORACLE_STALE_MS = 30 * 86_400_000;
export const ORACLE_QUORUM = 14;
/** Fresh in-range sources required before a window replaces the last rate. */
export const ORACLE_MIN_SOURCES = 10;
export const SOURCE_TENTHS_MIN = -1000;
/** +100% in tenths of a basis point. −1000 tenths is −1%. */
export const SOURCE_TENTHS_MAX = 100_000;
export const TRIM_EACH_SIDE = 2;
/** 3b stays off until a fork sets this height. Null ships the fixed genesis rate. */
export const ORACLE_ACTIVATION_HEIGHT = null;
export const ORACLE_SUPERMAJORITY_NUM = 2;
export const ORACLE_SUPERMAJORITY_DEN = 3;
/**
 * One week of 90 s blocks. Same interval as TARGET_BLOCK_INTERVAL_MS.
 * asert.js imports this module, so the interval is not imported back.
 */
export const ORACLE_BLOCK_MS = 90_000;
/** Mainnet report window is one week by duration, counted in block heights. */
export const ORACLE_WINDOW_MS = 7 * 86_400_000;
export const ORACLE_WINDOW_MAINNET = ORACLE_WINDOW_MS / ORACLE_BLOCK_MS;
export const PRODUCER_SHARE_ALERT = 0.4;

/**
 * Developed-economy (first-world) central banks, display order.
 * The observation root sorts `id:tenths`. Adding or removing a name is a
 * different book.
 */
export const POLICY_BANK_IDS = Object.freeze([
  'FED', 'BOE', 'ECB', 'BOJ', 'BOC', 'RBA', 'RBNZ', 'SNB',
  'RIKSBANK', 'NORGES', 'DNBANK', 'BOK', 'BOI', 'CNB',
]);

/**
 * Attested policy rates in tenths of a basis point, as of 2026-08-01.
 * These constants are the consensus observation. `reserve/latest.json`
 * documents the same integers; a node does not read that file to freeze.
 * Fed is the target-range median. ECB is median(deposit facility, MRO).
 */
export const BUNDLED_POLICY_TENTHS = Object.freeze({
  FED: 3625,
  BOE: 3750,
  ECB: 2075,
  BOJ: 500,
  BOC: 2750,
  RBA: 3600,
  RBNZ: 3000,
  SNB: 0,
  RIKSBANK: 2000,
  NORGES: 4000,
  DNBANK: 1600,
  BOK: 2500,
  BOI: 4000,
  CNB: 3500,
});

export function bundledComponents() {
  return POLICY_BANK_IDS.map((id) => ({ id, tenths: BUNDLED_POLICY_TENTHS[id] }));
}

/** Integer division, half away from zero. Matches Python ROUND_HALF_UP. */
export function halfUpDiv(num, den) {
  const n = Math.trunc(Number(num));
  const d = Math.trunc(Number(den));
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  const sign = n < 0 ? -1 : 1;
  const q = Math.floor((Math.abs(n) + Math.floor(Math.abs(d) / 2)) / Math.abs(d));
  return sign * q;
}

export function sourceTenthsOk(tenths) {
  return Number.isInteger(tenths) && tenths >= SOURCE_TENTHS_MIN && tenths <= SOURCE_TENTHS_MAX;
}

/**
 * Trimmed mean in whole bps. Negatives stay in the average. The 0 floor is
 * applied to the result only. Null when fewer than ORACLE_MIN_SOURCES values
 * are in range: the caller keeps the previous rate.
 */
export function trimmedMeanBps(tenthsList) {
  const vals = [];
  for (const raw of tenthsList || []) {
    const tenths = Math.trunc(Number(raw));
    if (!sourceTenthsOk(tenths)) continue;
    vals.push(tenths);
  }
  if (vals.length < ORACLE_MIN_SOURCES) return null;
  vals.sort((a, b) => a - b);
  const mid = vals.slice(TRIM_EACH_SIDE, vals.length - TRIM_EACH_SIDE);
  if (mid.length < 1) return null;
  let sum = 0;
  for (const t of mid) sum += t;
  const tenthsMean = halfUpDiv(sum, mid.length);
  const bps = halfUpDiv(tenthsMean, 10);
  return bps > 0 ? bps : 0;
}

/**
 * Whole bps from a component list. Null unless the list is exactly the 14
 * canonical ids, once each, with the attested in-range tenths.
 * A shorter basket, a duplicate, an unknown id, or a substituted tenth
 * is not this release's bundle — the caller keeps the previous epoch rate.
 */
export function quorumEpochBps(components) {
  const list = Array.isArray(components) ? components : [];
  if (list.length !== ORACLE_QUORUM) return null;
  const seen = new Set();
  const tenths = [];
  for (const c of list) {
    const id = String(c?.id || '').trim();
    if (!Object.prototype.hasOwnProperty.call(BUNDLED_POLICY_TENTHS, id) || seen.has(id)) return null;
    const n = Math.trunc(Number(c?.tenths));
    if (!sourceTenthsOk(n) || n !== BUNDLED_POLICY_TENTHS[id]) return null;
    seen.add(id);
    tenths.push(n);
  }
  if (seen.size !== ORACLE_QUORUM) return null;
  return trimmedMeanBps(tenths);
}

/** Consensus proposal for this software version. Null if the constants fail quorum. */
export function bundledEpochBps() {
  return quorumEpochBps(bundledComponents());
}

/** sha256 of sorted `id:tenths` rows. Pinned in the consensus fingerprint. */
export function bundleObservationRoot() {
  const rows = POLICY_BANK_IDS.map((id) => `${id}:${BUNDLED_POLICY_TENTHS[id]}`).sort();
  return createHash('sha256').update(rows.join('|')).digest('hex');
}

/**
 * Basis points used to pay a lock. Negative and non-numeric rates are 0.
 * There is no aggregate cap. Per-source bounds are applied before this.
 */
export function issuanceBps(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/**
 * Adopt an observed aggregate with no per-epoch step and no aggregate cap.
 * A non-integer leaves `prev`. A negative aggregate is floored at 0%.
 */
export function adoptObservedBps(prev, observed) {
  const prior = issuanceBps(prev);
  if (typeof observed !== 'number' || !Number.isInteger(observed)) return prior;
  if (observed < 0) return 0;
  return observed;
}

function componentTenths(c) {
  if (Number.isInteger(c?.tenths)) return c.tenths;
  if (Number.isInteger(c?.normalisedInteger)) return c.normalisedInteger;
  if (Number.isInteger(c?.tenthsBp)) return c.tenthsBp;
  return null;
}

/**
 * Block-time freshness. `asOf` after the block is `oracle_future`.
 * Older than 30 days is excluded. The producer's clock is not the judge.
 */
export function sourceFreshness(asOfMs, blockTimeMs) {
  const at = Number(asOfMs);
  const block = Number(blockTimeMs);
  if (!Number.isInteger(at) || !Number.isInteger(block)) return 'bad_rate';
  if (at > block) return 'oracle_future';
  if (block - at > ORACLE_STALE_MS) return 'stale';
  return 'fresh';
}

export function oracleActivationPin(activationHeight = ORACLE_ACTIVATION_HEIGHT) {
  return activationHeight == null ? 'fixed' : String(activationHeight);
}

/** `fixed` until the activation height. From that height, the miner median (3b) applies. */
export function oracleRuleAt(height, { activationHeight = ORACLE_ACTIVATION_HEIGHT } = {}) {
  if (activationHeight == null) return 'fixed';
  const h = Math.floor(Number(height) || 0);
  return h >= Math.floor(Number(activationHeight)) ? 'median3b' : 'fixed';
}

/**
 * Testnet uses the same week-of-epoch fraction as mainnet.
 * 7/400 of a 4-day epoch is 67 blocks at 90 s.
 */
export function windowBlocksFor(magic) {
  if (String(magic) === 'shear-v1') return ORACLE_WINDOW_MAINNET;
  const mainMs = epochMs('shear-v1');
  const hereMs = epochMs(magic);
  if (!mainMs || !hereMs) return ORACLE_WINDOW_MAINNET;
  return Math.max(1, Math.round((ORACLE_WINDOW_MAINNET * hereMs) / mainMs));
}

export const ORACLE_WINDOW_TESTNET = windowBlocksFor('shear-testnet-v12');

/**
 * Reports that count for the boundary. Selection is by height:
 * [boundaryHeight − N, boundaryHeight). Miner timestamps are not an input.
 */
export function selectReportWindow(blocks, boundaryHeight, {
  magic = 'shear-testnet-v12',
  windowBlocks = null,
} = {}) {
  const cap = windowBlocks == null ? windowBlocksFor(magic) : Math.floor(Number(windowBlocks));
  const boundary = Math.floor(Number(boundaryHeight));
  const picked = [];
  for (const block of blocks || []) {
    const h = Number(block?.height);
    if (!Number.isInteger(h)) continue;
    if (Number.isInteger(boundary)) {
      if (h >= boundary || h < boundary - cap) continue;
    }
    picked.push(block);
  }
  picked.sort((a, b) => Number(a.height) - Number(b.height));
  if (picked.length <= cap) return picked;
  return picked.slice(picked.length - cap);
}

export function epochIndexAt(timeMs, genesisMs, magic) {
  return vortexEpochIndex({
    nowMs: timeMs,
    genesisMs,
    epochDays: epochDays(magic),
  });
}

/** First block whose header epoch is later than its parent. Timestamps are the header clock, not a report filter. */
export function isReportBoundary({ headerMs, parentMs, genesisMs, magic } = {}) {
  if (!(Number(genesisMs) > 0) || !(Number(headerMs) > 0) || !(Number(parentMs) > 0)) return false;
  return epochIndexAt(headerMs, genesisMs, magic) > epochIndexAt(parentMs, genesisMs, magic);
}

/** Window the node passes into verifyBlock. Prior blocks only; this block is the boundary. */
export function oracleContextFor(priorBlocks, block, magic = 'shear-testnet-v12') {
  const height = Math.floor(Number(block?.height) || 0);
  const windowSize = windowBlocksFor(magic);
  const rows = (priorBlocks || []).map((b) => ({
    height: Number(b?.height),
    miner: b?.miner || b?.producer || '',
    reports: b?.txs?.[0]?.reports || b?.reports || null,
  }));
  return {
    height,
    oracleWindow: selectReportWindow(rows, height, { magic, windowBlocks: windowSize }),
    oracleWindowSize: windowSize,
    activationHeight: ORACLE_ACTIVATION_HEIGHT,
  };
}

/** Fields applyReserveBlock needs. The caller supplies header times. */
export function reserveApplyFields({
  prior = [],
  block,
  magic = 'shear-testnet-v12',
  parentMs = 0,
  genesisMs = 0,
  nowMs = 0,
} = {}) {
  const ctx = oracleContextFor(prior, block, magic);
  return {
    block,
    nowMs,
    oracleWindow: ctx.oracleWindow,
    oracleWindowSize: ctx.oracleWindowSize,
    activationHeight: ctx.activationHeight,
    height: Math.floor(Number(block?.height) || ctx.height || 0),
    parentMs,
    genesisMs,
  };
}

/**
 * One coinbase report. Absent is fine. The template must not invent one.
 * A value outside −1%..+100%, or a value that is not an integer tenth, is `bad_rate`.
 */
export function verifyMinerReport(reports) {
  if (reports == null) return { ok: true, present: false };
  if (!Array.isArray(reports)) return { ok: false, reason: 'bad_rate' };
  if (reports.length === 0) return { ok: true, present: false };
  if (reports.length > POLICY_BANK_IDS.length) return { ok: false, reason: 'report_count' };
  const seen = new Set();
  for (const row of reports) {
    const id = String(row?.id || '').trim();
    if (!Object.prototype.hasOwnProperty.call(BUNDLED_POLICY_TENTHS, id)) {
      return { ok: false, reason: 'bad_rate' };
    }
    if (seen.has(id)) return { ok: false, reason: 'report_dup' };
    seen.add(id);
    const tenths = row?.tenths;
    if (typeof tenths !== 'number' || !Number.isInteger(tenths) || !sourceTenthsOk(tenths)) {
      return { ok: false, reason: 'bad_rate' };
    }
  }
  return { ok: true, present: true };
}

export function canonicalReports(reports) {
  return (reports || [])
    .map((row) => ({ id: String(row?.id || '').trim(), tenths: Math.trunc(Number(row?.tenths)) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Lower median. A value is used only when at least 2/3 of the window reports that exact tenth. */
export function medianBankTenths(values, windowSize) {
  const W = Math.floor(Number(windowSize) || 0);
  const list = Array.isArray(values) ? values : [];
  if (W <= 0 || list.length * ORACLE_SUPERMAJORITY_DEN < W * ORACLE_SUPERMAJORITY_NUM) return null;
  const sorted = list.slice().sort((a, b) => a - b);
  const mid = sorted[Math.floor((sorted.length - 1) / 2)];
  let count = 0;
  for (const v of list) if (v === mid) count += 1;
  if (count * ORACLE_SUPERMAJORITY_DEN < W * ORACLE_SUPERMAJORITY_NUM) return null;
  return mid;
}

/**
 * 3b. Per-bank supermajority, then the trimmed mean, then the 0 floor.
 * Fewer than 10 valid banks keeps `prev`.
 */
export function epochBpsFromReports(prevEpochBps, blocks, { windowSize = null } = {}) {
  const prev = issuanceBps(prevEpochBps);
  const rows = Array.isArray(blocks) ? blocks : [];
  const W = windowSize == null ? rows.length : Math.floor(Number(windowSize) || 0);
  const byBank = new Map(POLICY_BANK_IDS.map((id) => [id, []]));
  for (const block of rows) {
    const reports = Array.isArray(block?.reports) ? block.reports : [];
    const seen = new Set();
    for (const row of reports) {
      const id = String(row?.id || '').trim();
      if (seen.has(id) || !byBank.has(id)) continue;
      seen.add(id);
      const tenths = Math.trunc(Number(row?.tenths));
      if (!sourceTenthsOk(tenths)) continue;
      byBank.get(id).push(tenths);
    }
  }
  const medians = [];
  for (const id of POLICY_BANK_IDS) {
    const value = medianBankTenths(byBank.get(id), W);
    if (value != null) medians.push(value);
  }
  if (medians.length < ORACLE_MIN_SOURCES) return prev;
  const mean = trimmedMeanBps(medians);
  return mean == null ? prev : mean;
}

/** Fixed mode always returns the genesis rate. 3b uses the report window. */
export function boundaryEpochBps({
  prevEpochBps = GENESIS_BPS,
  height = 0,
  activationHeight = ORACLE_ACTIVATION_HEIGHT,
  windowBlocks = null,
  windowSize = null,
} = {}) {
  if (oracleRuleAt(height, { activationHeight }) !== 'median3b') return issuanceBps(GENESIS_BPS);
  return epochBpsFromReports(prevEpochBps, windowBlocks || [], { windowSize });
}

/** Telemetry only. One producer above 40% of the window does not change the rate. */
export function producerShareAlert(blocks) {
  const rows = Array.isArray(blocks) ? blocks : [];
  const counts = new Map();
  for (const block of rows) {
    const producer = String(block?.miner || block?.producer || '');
    if (!producer) continue;
    counts.set(producer, (counts.get(producer) || 0) + 1);
  }
  const n = rows.length || 1;
  let top = null;
  for (const [producer, count] of counts) {
    const share = count / n;
    if (share > PRODUCER_SHARE_ALERT && (!top || share > top.share)) {
      top = { alert: true, producer, share, count, window: rows.length };
    }
  }
  return top || { alert: false, window: rows.length };
}

/**
 * Why a source does not enter the average. `fresh` counts.
 * A repeated bank id is `att_dup` (the first copy already counted).
 * Attester signatures are not checked here.
 */
export function classifySource(source, blockTimeMs, seen) {
  const id = String(source?.id || '').trim();
  if (!Object.prototype.hasOwnProperty.call(BUNDLED_POLICY_TENTHS, id)) return 'bad_rate';
  if (seen?.has(id)) return 'att_dup';
  const tenths = componentTenths(source);
  if (!sourceTenthsOk(tenths)) return 'bad_rate';
  if (blockTimeMs != null) {
    const fresh = sourceFreshness(source?.asOfMs ?? source?.observedAtMs, blockTimeMs);
    if (fresh !== 'fresh') return fresh;
  }
  return 'fresh';
}

/**
 * Per-source plausibility, then trimmed mean. One producer annualBps is
 * not a source list and cannot select the rate: a missing list recomputes
 * this release's bundle. Fewer than 10 fresh in-range banks keeps `prev`.
 */
export function recomputeEpochBps(prevEpochBps, sources, blockTimeMs) {
  const prev = issuanceBps(prevEpochBps);
  if (!Array.isArray(sources)) return bundledEpochBps() ?? prev;
  const byId = new Map();
  for (const s of sources) {
    if (classifySource(s, blockTimeMs, byId) !== 'fresh') continue;
    byId.set(String(s.id).trim(), componentTenths(s));
  }
  if (byId.size < ORACLE_MIN_SOURCES) return prev;
  const mean = trimmedMeanBps([...byId.values()]);
  return mean == null ? prev : mean;
}

export function rateCommitFor({
  prevEpochBps = GENESIS_BPS,
  sources,
  blockTimeMs,
  epochIndex = 0,
  magic,
} = {}) {
  const epochBps = recomputeEpochBps(prevEpochBps, sources, blockTimeMs);
  return {
    epochIndex: Math.max(0, Math.floor(Number(epochIndex) || 0)),
    epochBps,
    magic: magic == null ? undefined : String(magic),
    attRoot: bundleObservationRoot(),
  };
}

export function verifyRateCommit(commit, {
  prevEpochBps = GENESIS_BPS,
  sources,
  blockTimeMs,
  epochIndex = 0,
  magic,
  expectedBps = null,
} = {}) {
  if (!commit || typeof commit !== 'object') return { ok: false, reason: 'rate_commit' };
  if (magic != null && String(commit.magic || '') !== String(magic)) {
    return { ok: false, reason: 'att_magic' };
  }
  if (Number(commit.epochIndex) !== Math.floor(Number(epochIndex) || 0)) {
    return { ok: false, reason: 'att_epoch' };
  }
  const expected = expectedBps == null
    ? (Array.isArray(sources)
      ? recomputeEpochBps(prevEpochBps, sources, blockTimeMs)
      : (bundledEpochBps() ?? issuanceBps(prevEpochBps)))
    : Math.floor(Number(expectedBps));
  if (Math.floor(Number(commit.epochBps)) !== expected) return { ok: false, reason: 'rate_commit' };
  return { ok: true, epochBps: expected };
}

/**
 * Epoch rate from the bundled quorum only. A failed quorum keeps `prev`.
 * There is no per-epoch step: a later bundle is adopted in full.
 */
export function epochRateBps(prevEpochBps = GENESIS_BPS) {
  const prev = issuanceBps(prevEpochBps);
  const proposal = bundledEpochBps();
  if (proposal == null) return prev;
  return adoptObservedBps(prev, proposal);
}

/** Display helper. Uses the same trimmed mean as consensus, negatives included. Not a freeze. */
export function averagePolicyBps(components = []) {
  const tenths = [];
  for (const c of components || []) {
    const n = componentTenths(c);
    if (n != null) tenths.push(n);
  }
  const mean = trimmedMeanBps(tenths);
  return mean == null ? RESERVE_ORACLE_DEFAULT_BPS : mean;
}

export function emptyOracle({ annualBps = RESERVE_ORACLE_DEFAULT_BPS, nowMs = 0 } = {}) {
  return {
    id: RESERVE_ORACLE_ID,
    annualBps: Math.floor(Number(annualBps) || RESERVE_ORACLE_DEFAULT_BPS),
    observedAtMs: nowMs,
  };
}

/** A passed rate does not become the oracle. The bundle is the only observation. */
export function observeRate(oracle, { annualBps, nowMs } = {}) {
  void annualBps;
  void nowMs;
  void oracle;
  return { ok: false, reason: 'rate_bundled' };
}

/**
 * A coinbase observe is one integer bps and one integer time.
 * Absent is no observation. Anything else is not a rate.
 */
export function parseCoinbaseObserve(tx) {
  if (!tx || tx.observe == null) return { ok: true, observe: null };
  if (!tx.coinbase) return { ok: false, reason: 'bad_rate' };
  const raw = tx.observe;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'bad_rate' };
  }
  const bps = raw.annualBps;
  const at = raw.observedAtMs;
  if (typeof bps !== 'number' || !Number.isSafeInteger(bps) || bps < 0) {
    return { ok: false, reason: 'bad_rate' };
  }
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
    return { ok: false, reason: 'bad_rate' };
  }
  return { ok: true, observe: { annualBps: bps, observedAtMs: at } };
}

/** Any observe is unattested. Miner reports use `reports`, not this field. */
export function coinbaseObserveRejected(txs) {
  const list = Array.isArray(txs) ? txs : [];
  for (const tx of list) {
    if (tx && tx.observe != null) return { ok: false, reason: 'observe_unattested' };
  }
  return null;
}

/** Bound into the coinbase digest. A bad field still changes the digest. */
export function observeDigestSuffix(tx) {
  if (!tx?.coinbase || tx.observe == null) return null;
  const parsed = parseCoinbaseObserve(tx);
  if (!parsed.ok || !parsed.observe) return Buffer.from('observebad1');
  const b = Buffer.alloc(12);
  b.writeUInt32LE(parsed.observe.annualBps, 0);
  b.writeBigUInt64LE(BigInt(parsed.observe.observedAtMs), 4);
  return Buffer.concat([Buffer.from('observe1'), b]);
}

function asUnit(n) {
  if (typeof n === 'bigint') return n < 0n ? 0n : n;
  const v = Math.floor(Number(n) || 0);
  if (!Number.isFinite(v) || v <= 0) return 0n;
  return BigInt(v);
}

/**
 * Full-epoch reserve reward: floor(activeNanos * epochBps / 10000).
 * `days` is ignored. do not use 365.
 */
export function reserveRewardNanos(activeNanos, epochBps, days = REWARD_DENOM_DAYS) {
  void days;
  const p = asUnit(activeNanos);
  const bps = BigInt(issuanceBps(epochBps));
  if (p <= 0n || bps <= 0n) return 0;
  return Number((p * bps) / 10000n);
}

export function interestNanos(activeNanos, epochBps, days = REWARD_DENOM_DAYS) {
  return reserveRewardNanos(activeNanos, epochBps, days);
}

const MS_PER_DAY = 86_400_000n;

/** Ongoing accrual on staked SHE. Idle SHE is not passed in. Caps at this book's epoch. */
export function accruedNanos(stakedNanos, epochBps, elapsedMs, magic) {
  const p = asUnit(stakedNanos);
  const bps = BigInt(issuanceBps(epochBps));
  let ms = asUnit(elapsedMs);
  const cap = BigInt(epochMs(magic));
  if (ms > cap) ms = cap;
  if (p <= 0n || ms <= 0n || cap <= 0n) return 0;
  return Number((p * bps * ms) / (10000n * cap));
}

/**
 * Freeze used to mint. A caller rate is not an input. Staleness uses
 * `blockTimeMs` against each source `asOf`, never a self-asserted age.
 */
export function freezeEpochBps({
  prevEpochBps = GENESIS_BPS,
  annualBps,
  observedAtMs = 0,
  nowMs = 0,
  blockTimeMs,
  sources,
  magic,
} = {}) {
  void annualBps;
  void observedAtMs;
  void nowMs;
  void magic;
  const clock = blockTimeMs == null ? null : blockTimeMs;
  if (Array.isArray(sources)) return recomputeEpochBps(prevEpochBps, sources, clock);
  return epochRateBps(prevEpochBps);
}

export function observationRoot(components = []) {
  const rows = (components || [])
    .map((c) => `${String(c?.id || c?.bank || '').trim()}:${Math.floor(Number(c?.bps) || 0)}`)
    .filter(Boolean)
    .sort();
  return createHash('sha256').update(rows.join('|')).digest('hex');
}

export function makeFreezeRecord({
  epochIndex = 0,
  prevEpochBps = GENESIS_BPS,
  annualBps,
  observedAtMs = 0,
  nowMs = 0,
  components,
  magic,
} = {}) {
  void annualBps;
  void observedAtMs;
  const idx = Math.max(0, Math.floor(Number(epochIndex) || 0));
  const prev = issuanceBps(prevEpochBps);
  const epochBps = freezeEpochBps({
    prevEpochBps: prev,
    sources: components,
    blockTimeMs: nowMs,
    magic,
  });
  return {
    ok: true,
    epochIndex: idx,
    epochBps,
    prevEpochBps: prev,
    magic: magic == null ? undefined : String(magic),
    sources: Array.isArray(components) ? components : undefined,
    blockTimeMs: nowMs == null ? undefined : Number(nowMs) || 0,
    observationRoot: bundleObservationRoot(),
    frozenAtMs: Number(nowMs) || 0,
    sourceCount: Array.isArray(components) ? components.length : ORACLE_QUORUM,
    source: 'bundle-trim-10',
    thin: false,
  };
}

/** Consensus view of a coinbase observe. Extra fields are not part of the digest. */
export function canonicalObserve(observe) {
  if (!observe || typeof observe !== 'object') return null;
  const row = {
    annualBps: observe.annualBps,
    observedAtMs: observe.observedAtMs,
  };
  if (observe.magic != null) row.magic = String(observe.magic);
  if (observe.epochIndex != null) row.epochIndex = Math.floor(Number(observe.epochIndex) || 0);
  if (Array.isArray(observe.sources)) {
    row.sources = observe.sources.map((s) => ({
      id: s?.id,
      annualBps: s?.annualBps,
      observedAtMs: s?.observedAtMs,
    }));
  }
  return row;
}

/**
 * The single-producer observe is not a rate input. Any observe is
 * `observe_unattested`. Miner reports use `reports` and the 3b window.
 */
export function observeVerdict(observe) {
  if (observe == null) return { ok: true, present: false };
  return { ok: false, reason: 'observe_unattested', present: true };
}

export function verifyFreezeRecord(rec, {
  epochIndex,
  prevFreeze,
  magic,
} = {}) {
  if (!rec) return { ok: false, reason: 'freeze_missing' };
  if (Number(rec.epochIndex) !== Number(epochIndex)) return { ok: false, reason: 'freeze_epoch' };
  const bps = Math.floor(Number(rec.epochBps));
  if (!Number.isFinite(bps)) return { ok: false, reason: 'freeze_bps' };
  if (bps < 0) return { ok: false, reason: 'freeze_bps' };
  const prev = Math.floor(Number(rec.prevEpochBps ?? prevFreeze?.epochBps ?? GENESIS_BPS));
  if (magic != null && String(rec.magic || '') !== String(magic)) {
    return { ok: false, reason: 'att_magic' };
  }
  if (prevFreeze && Number(prevFreeze.epochIndex) === Number(rec.epochIndex)) {
    if (Number(prevFreeze.epochBps) !== bps
      || String(prevFreeze.observationRoot || '') !== String(rec.observationRoot || '')) {
      return { ok: false, reason: 'freeze_equivocation' };
    }
  }
  const expected = freezeEpochBps({
    prevEpochBps: prev,
    sources: rec.sources,
    blockTimeMs: rec.blockTimeMs,
    magic,
  });
  if (bps !== expected) return { ok: false, reason: 'rate_commit' };
  if (String(rec.observationRoot || '') !== bundleObservationRoot()) {
    return { ok: false, reason: 'freeze_root' };
  }
  return { ok: true };
}

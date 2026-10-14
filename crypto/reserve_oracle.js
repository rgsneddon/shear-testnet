import { createHash } from 'node:crypto';
import { epochMs } from './pot_sched.js';

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
/** Wire bound for a lone producer observe. Not an aggregate cap. */
export const RESERVE_ORACLE_MAX_BPS = 10_000;
export const REWARD_DENOM_DAYS = 400;
export const INTEREST_DENOM_DAYS = REWARD_DENOM_DAYS;
export const ORACLE_MAX_AGE_MS = 14 * 86_400_000;
export const ORACLE_STALE_MS = 30 * 86_400_000;
export const ORACLE_QUORUM = 14;
/** Fresh in-range sources required before a window replaces the last rate. */
export const ORACLE_MIN_SOURCES = 10;
export const SOURCE_TENTHS_MIN = -1000;
export const SOURCE_TENTHS_MAX = 10_000;
export const TRIM_EACH_SIDE = 2;

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
} = {}) {
  if (!commit || typeof commit !== 'object') return { ok: false, reason: 'rate_commit' };
  if (magic != null && String(commit.magic || '') !== String(magic)) {
    return { ok: false, reason: 'att_magic' };
  }
  if (Number(commit.epochIndex) !== Math.floor(Number(epochIndex) || 0)) {
    return { ok: false, reason: 'att_epoch' };
  }
  const expected = Array.isArray(sources)
    ? recomputeEpochBps(prevEpochBps, sources, blockTimeMs)
    : (bundledEpochBps() ?? issuanceBps(prevEpochBps));
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
 * One producer observation is not a rate. A block observe is accepted only
 * when it carries the 14 distinct bundled bank ids, all agreeing on the
 * attested bps. Anything short of that quorum is `oracle_quorum`. A value
 * that is not an in-range integer is `bad_rate` and does not reach the quorum check.
 */
export function observeVerdict(observe) {
  if (observe == null) return { ok: true, present: false };
  const srcs = Array.isArray(observe.sources) && observe.sources.length
    ? observe.sources
    : [observe];
  for (const s of srcs) {
    const bps = s?.annualBps;
    const at = s?.observedAtMs;
    if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > RESERVE_ORACLE_MAX_BPS) {
      return { ok: false, reason: 'bad_rate' };
    }
    if (typeof at !== 'number' || !Number.isInteger(at) || at < 0) {
      return { ok: false, reason: 'bad_rate' };
    }
  }
  const ids = new Set(srcs.map((s) => String(s?.id || '')).filter(Boolean));
  const bundle = bundledEpochBps();
  const agree = srcs.every((s) => s.annualBps === bundle);
  if (ids.size < ORACLE_QUORUM || !agree || bundle == null) {
    return { ok: false, reason: 'oracle_quorum' };
  }
  for (const id of POLICY_BANK_IDS) {
    if (!ids.has(id)) return { ok: false, reason: 'oracle_quorum' };
  }
  return { ok: true, present: true, quorum: true };
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

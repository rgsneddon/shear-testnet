import { createHash } from 'node:crypto';
import { epochMs, MAGIC_MAINNET } from './pot_sched.js';

/**
 * The Reserve oracle. The epoch rate is the attested 14-bank bundle below.
 * Live fetches of central-bank sites are not consensus: two nodes cannot
 * be required to see the same page at the same time. Disk JSON, a coinbase
 * field, an admin, and a miner observation are not inputs.
 */
export const RESERVE_ORACLE_ID = 'shear-reserve-oracle-v1';
/**
 * Unweighted arithmetic mean of the bundled developed-economy policy rates
 * (14 banks, half-up). 2.636% → 264 bps. Not a median. Not a single-bank print.
 */
export const RESERVE_ORACLE_DEFAULT_BPS = 264;
export const GENESIS_BPS = 264;
export const RESERVE_ORACLE_MAX_BPS = 10_000;
export const REWARD_DENOM_DAYS = 400;
export const INTEREST_DENOM_DAYS = REWARD_DENOM_DAYS;
export const EPOCH_BPS_MAX_STEP = 100;
export const ORACLE_MAX_AGE_MS = 14 * 86_400_000;
export const ORACLE_QUORUM = 14;
export const ORACLE_MIN_SOURCES = 8;

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

/**
 * Whole bps from a component list. Null unless the list is exactly the 14
 * canonical ids, once each, with the attested non-negative tenths.
 * A shorter basket, a duplicate, an unknown id, or a substituted tenth
 * is not a quorum — the caller keeps the previous epoch rate.
 */
export function quorumEpochBps(components) {
  const list = Array.isArray(components) ? components : [];
  if (list.length !== ORACLE_QUORUM) return null;
  const seen = new Set();
  let sum = 0;
  for (const c of list) {
    const id = String(c?.id || '').trim();
    if (!Object.prototype.hasOwnProperty.call(BUNDLED_POLICY_TENTHS, id) || seen.has(id)) return null;
    const tenths = Math.floor(Number(c?.tenths));
    if (!Number.isInteger(tenths) || tenths < 0) return null;
    if (tenths !== BUNDLED_POLICY_TENTHS[id]) return null;
    seen.add(id);
    sum += tenths;
  }
  if (seen.size !== ORACLE_QUORUM) return null;
  const tenthsMean = Math.floor((sum + Math.floor(ORACLE_QUORUM / 2)) / ORACLE_QUORUM);
  return Math.floor((tenthsMean + 5) / 10);
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
 * Epoch rate from the previous freeze and the bundled quorum only.
 * A failed quorum keeps `prev`. The ±100 bps step applies when a later
 * consensus release changes the bundle.
 */
export function epochRateBps(prevEpochBps = GENESIS_BPS) {
  const prev = Math.floor(Number(prevEpochBps));
  const base = Number.isFinite(prev) && prev >= 0 ? prev : GENESIS_BPS;
  const proposal = bundledEpochBps();
  if (proposal == null) return base;
  return clampBpsStep(base, proposal);
}

/** Display helper for the published JSON. Not a consensus freeze. */
export function averagePolicyBps(components = []) {
  const rates = [];
  for (const c of components || []) {
    let bps = Number(c?.bps);
    if (!Number.isFinite(bps) && c?.normalisedPercent != null) {
      bps = Number(c.normalisedPercent) * 100;
    }
    if (!Number.isFinite(bps) && c?.normalisedInteger != null) {
      bps = Number(c.normalisedInteger) / 10;
    }
    if (Number.isFinite(bps) && bps >= 0) rates.push(bps);
  }
  if (!rates.length) return RESERVE_ORACLE_DEFAULT_BPS;
  const sum = rates.reduce((a, n) => a + n, 0);
  return Math.round(sum / rates.length);
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
  const bps = asUnit(epochBps);
  if (p <= 0n) return 0;
  return Number((p * bps) / 10000n);
}

export function interestNanos(activeNanos, epochBps, days = REWARD_DENOM_DAYS) {
  return reserveRewardNanos(activeNanos, epochBps, days);
}

const MS_PER_DAY = 86_400_000n;

/** Ongoing accrual on staked SHE. Idle SHE is not passed in. Caps at this book's epoch. */
export function accruedNanos(stakedNanos, epochBps, elapsedMs, magic) {
  const p = asUnit(stakedNanos);
  const bps = asUnit(epochBps);
  let ms = asUnit(elapsedMs);
  const cap = BigInt(epochMs(magic));
  if (ms > cap) ms = cap;
  if (p <= 0n || ms <= 0n || cap <= 0n) return 0;
  return Number((p * bps * ms) / (10000n * cap));
}

export function clampBpsStep(prev, next, cap = EPOCH_BPS_MAX_STEP) {
  const p = Math.floor(Number(prev) || 0);
  let n = Math.floor(Number(next) || 0);
  const step = Math.floor(Number(cap) || EPOCH_BPS_MAX_STEP);
  if (n > p + step) n = p + step;
  if (n < p - step) n = p - step;
  if (n < 0) n = 0;
  if (n > RESERVE_ORACLE_MAX_BPS) n = RESERVE_ORACLE_MAX_BPS;
  return n;
}

/**
 * Freeze used to mint. Caller `annualBps`, `observedAtMs`, and env
 * `SHEAR_ORACLE_BPS` are ignored. Mainnet and testnet use the same bundle.
 */
export function freezeEpochBps({
  prevEpochBps = GENESIS_BPS,
  annualBps,
  observedAtMs = 0,
  nowMs = 0,
  magic,
} = {}) {
  void annualBps;
  void observedAtMs;
  void nowMs;
  if (String(magic) === MAGIC_MAINNET) {
    void process.env.SHEAR_ORACLE_BPS;
  }
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
  void components;
  const idx = Math.max(0, Math.floor(Number(epochIndex) || 0));
  const prev = Math.floor(Number(prevEpochBps) || GENESIS_BPS);
  const epochBps = freezeEpochBps({ prevEpochBps: prev, magic });
  const quorum = bundledEpochBps();
  return {
    ok: quorum != null,
    epochIndex: idx,
    epochBps,
    prevEpochBps: prev,
    observationRoot: bundleObservationRoot(),
    frozenAtMs: Number(nowMs) || 0,
    sourceCount: quorum == null ? 0 : ORACLE_QUORUM,
    source: 'bundle-quorum-14',
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
  if (!Number.isFinite(bps) || bps < 0 || bps > RESERVE_ORACLE_MAX_BPS) {
    return { ok: false, reason: 'freeze_bps' };
  }
  const prev = Math.floor(Number(rec.prevEpochBps ?? prevFreeze?.epochBps ?? GENESIS_BPS));
  if (Math.abs(bps - prev) > EPOCH_BPS_MAX_STEP) return { ok: false, reason: 'freeze_step' };
  if (prevFreeze && Number(prevFreeze.epochIndex) === Number(rec.epochIndex)) {
    if (Number(prevFreeze.epochBps) !== bps
      || String(prevFreeze.observationRoot || '') !== String(rec.observationRoot || '')) {
      return { ok: false, reason: 'freeze_equivocation' };
    }
  }
  const expected = epochRateBps(prev);
  if (bps !== expected) return { ok: false, reason: 'freeze_bundle' };
  if (String(rec.observationRoot || '') !== bundleObservationRoot()) {
    return { ok: false, reason: 'freeze_root' };
  }
  void magic;
  return { ok: true };
}

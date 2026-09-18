import { createHash } from 'node:crypto';
import { epochMs, MAGIC_MAINNET } from './pot_sched.js';

/** The Reserve oracle — observed basket; freeze is consensus-checked. Cannot move pot. */
export const RESERVE_ORACLE_ID = 'shear-reserve-oracle-v1';
/**
 * Unweighted arithmetic mean of all observed first-world policy rates in
 * `reserve/latest.json` (14 banks, half-up). 2.636% → 264 bps.
 * Not a median. Not a single-bank print.
 */
export const RESERVE_ORACLE_DEFAULT_BPS = 264;
export const GENESIS_BPS = 264;
export const RESERVE_ORACLE_MAX_BPS = 10_000;
export const INTEREST_DENOM_DAYS = 400;
export const EPOCH_BPS_MAX_STEP = 100;
export const ORACLE_MAX_AGE_MS = 14 * 86_400_000;
export const ORACLE_QUORUM = 14;
export const ORACLE_MIN_SOURCES = 8;

/** Average of every listed bank's policy rate in bps (half-up). */
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

export function observeRate(oracle, { annualBps, nowMs }) {
  const n = Math.floor(Number(annualBps));
  if (!Number.isFinite(n) || n < 0 || n > RESERVE_ORACLE_MAX_BPS) {
    return { ok: false, reason: 'bad_rate' };
  }
  oracle.annualBps = n;
  oracle.observedAtMs = nowMs;
  return { ok: true, annualBps: n, observedAtMs: nowMs };
}

function asUnit(n) {
  if (typeof n === 'bigint') return n < 0n ? 0n : n;
  const v = Math.floor(Number(n) || 0);
  if (!Number.isFinite(v) || v <= 0) return 0n;
  return BigInt(v);
}

/**
 * Full-epoch interest: floor(stakedNanos * epochBps / 10000).
 * `days` is ignored. do not use 365.
 */
export function interestNanos(stakedNanos, epochBps, days = INTEREST_DENOM_DAYS) {
  void days;
  const p = asUnit(stakedNanos);
  const bps = asUnit(epochBps);
  if (p <= 0n) return 0;
  return Number((p * bps) / 10000n);
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

/** Freeze used to mint. Stale proposal (>14d) reuses previous epochBps. */
export function freezeEpochBps({
  prevEpochBps = GENESIS_BPS,
  annualBps,
  observedAtMs = 0,
  nowMs = 0,
  magic,
} = {}) {
  if (String(magic) === MAGIC_MAINNET) {
    void process.env.SHEAR_ORACLE_BPS;
  }
  const prev = Math.floor(Number(prevEpochBps));
  const base = Number.isFinite(prev) && prev >= 0 ? prev : GENESIS_BPS;
  const asOf = Number(observedAtMs) || 0;
  const now = Number(nowMs) || 0;
  const stale = !(asOf > 0) || (now > 0 && now - asOf > ORACLE_MAX_AGE_MS);
  if (stale) return base;
  return clampBpsStep(base, annualBps);
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
  const idx = Math.max(0, Math.floor(Number(epochIndex) || 0));
  const prev = Math.floor(Number(prevEpochBps) || GENESIS_BPS);
  const epochBps = freezeEpochBps({
    prevEpochBps: prev,
    annualBps,
    observedAtMs,
    nowMs,
    magic,
  });
  const n = Array.isArray(components) ? components.length : 0;
  return {
    ok: true,
    epochIndex: idx,
    epochBps,
    prevEpochBps: prev,
    observationRoot: observationRoot(components || []),
    frozenAtMs: Number(nowMs) || 0,
    sourceCount: n,
    thin: n > 0 && n < ORACLE_MIN_SOURCES,
  };
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
  void magic;
  return { ok: true };
}

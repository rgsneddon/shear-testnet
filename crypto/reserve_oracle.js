/** The Reserve oracle — variable annual rate, observed on every node. Not consensus-critical. */
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
const EPOCH_MS = 400n * MS_PER_DAY;

/** Ongoing accrual on staked SHE. Idle SHE is not passed in. Caps at 400 days. do not use 365. */
export function accruedNanos(stakedNanos, epochBps, elapsedMs) {
  const p = asUnit(stakedNanos);
  const bps = asUnit(epochBps);
  let ms = asUnit(elapsedMs);
  if (ms > EPOCH_MS) ms = EPOCH_MS;
  if (p <= 0n || ms <= 0n) return 0;
  return Number((p * bps * ms) / (10000n * EPOCH_MS));
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
} = {}) {
  const prev = Math.floor(Number(prevEpochBps));
  const base = Number.isFinite(prev) && prev >= 0 ? prev : GENESIS_BPS;
  const asOf = Number(observedAtMs) || 0;
  const now = Number(nowMs) || 0;
  const stale = !(asOf > 0) || (now > 0 && now - asOf > ORACLE_MAX_AGE_MS);
  if (stale) return base;
  return clampBpsStep(base, annualBps);
}

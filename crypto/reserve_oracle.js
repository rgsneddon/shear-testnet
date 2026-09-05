/** The Reserve oracle — variable annual rate, observed on every node. Not consensus-critical. */
export const RESERVE_ORACLE_ID = 'shear-reserve-oracle-v1';
/**
 * Unweighted arithmetic mean of all observed first-world policy rates in
 * `reserve/latest.json` (14 banks, half-up). 2.636% → 264 bps.
 * Not a median. Not a single-bank print.
 */
export const RESERVE_ORACLE_DEFAULT_BPS = 264;
export const RESERVE_ORACLE_MAX_BPS = 10_000;

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
  const v = Math.floor(Number(n) || 0);
  if (!Number.isFinite(v) || v <= 0) return 0n;
  return BigInt(v);
}

export function interestNanos(stakedNanos, annualBps, days = 400) {
  const p = asUnit(stakedNanos);
  const bps = asUnit(annualBps);
  const d = asUnit(days);
  if (p <= 0n || d <= 0n) return 0;
  return Number((p * bps * d) / (10000n * 365n));
}

const MS_PER_DAY = 86_400_000n;
const EPOCH_MS = 400n * MS_PER_DAY;
const YEAR_MS = 365n * MS_PER_DAY;

/** Ongoing accrual on staked SHE. Idle SHE is not passed in. Caps at 400 days. */
export function accruedNanos(stakedNanos, annualBps, elapsedMs) {
  const p = asUnit(stakedNanos);
  const bps = asUnit(annualBps);
  let ms = asUnit(elapsedMs);
  if (ms > EPOCH_MS) ms = EPOCH_MS;
  if (p <= 0n || ms <= 0n) return 0;
  return Number((p * bps * ms) / (10000n * YEAR_MS));
}

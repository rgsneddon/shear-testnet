/**
 * Epoch rate_e (genesis 281 bps) is the total for the whole epoch, not a
 * daily rate and not an annual rate. One π leaf earns
 *
 *   floor(π × rate_e × held_blocks / (epoch_blocks × 10000)).
 *
 * A full epoch cancels to floor(π × rate_e / 10000). A day is
 * blocks-per-day / epoch_blocks of that total, which is 1/epoch_days.
 * Paying floor(π × rate_e / 10000) every day would be about epoch_days
 * times too much. That is not this rule.
 *
 * Periods tile the epoch. Sixteen of them are the nearest split of the
 * 400-day epoch to 30 days (25 days, 24,000 blocks of 90s). A claim of a
 * leaf that sits in a period's frozen start root publishes one period
 * constant, the same floor with held_blocks = period_blocks.
 *
 * The arrival stub is that same floor from the next day boundary after
 * the lock to the end of the first period. It is paid once, inside the
 * epoch-end withdraw. There is no exit stub: withdraws happen at epoch
 * end, which is a period boundary. A withdraw publishes the lock height
 * and the hold, because the stub is computed from those public numbers.
 *
 * The rate table is append-only. Accrual from height A to B is one
 * prefix subtraction and one floor, not a loop over days.
 */
import { epochDays } from './pot_sched.js';

export const VAULT_BLOCK_MS = 90_000;
export const VAULT_DAY_MS = 86_400_000;
/** 90s blocks. 86_400_000 / 90_000 = 960. */
export const VAULT_DAY_BLOCKS = VAULT_DAY_MS / VAULT_BLOCK_MS;
/** Splits a 400-day epoch into 25-day periods. Testnet (4 days) uses the same count. */
export const VAULT_PERIODS_PER_EPOCH = 16;
export const VAULT_BPS_DENOM = 10000n;
const MAX_NANOS = 9007199254740991n;

export function vaultEpochBlocks(magic) {
  return epochDays(magic) * VAULT_DAY_BLOCKS;
}

export function vaultPeriodBlocks(magic) {
  const blocks = vaultEpochBlocks(magic);
  if (blocks % VAULT_PERIODS_PER_EPOCH !== 0) return null;
  return blocks / VAULT_PERIODS_PER_EPOCH;
}

/**
 * floor(amount × bps × heldBlocks / (epochBlocks × 10000)).
 * Null unless amount is positive, the rate is positive, and the hold is
 * inside one epoch. held == epochBlocks is the whole-epoch total.
 */
export function vaultAccrualNanos(amount, bps, heldBlocks, epochBlocks) {
  let a;
  let rate;
  let held;
  let width;
  try {
    a = BigInt(amount);
    rate = BigInt(bps);
    held = BigInt(heldBlocks);
    width = BigInt(epochBlocks);
  } catch {
    return null;
  }
  if (a <= 0n || rate <= 0n || width <= 0n || held <= 0n || held > width) return null;
  const denom = width * VAULT_BPS_DENOM;
  const product = a * rate * held;
  if (product < 0n) return null;
  const nanos = product / denom;
  if (nanos <= 0n || nanos > MAX_NANOS) return null;
  return { nanos, rem: product % denom, denom: VAULT_BPS_DENOM, held, epochBlocks: width };
}

export function vaultPeriodReward(amount, bps, magic) {
  const period = vaultPeriodBlocks(magic);
  const width = vaultEpochBlocks(magic);
  if (period == null) return null;
  return vaultAccrualNanos(amount, bps, period, width);
}

export function vaultEpochReward(amount, bps, magic) {
  const width = vaultEpochBlocks(magic);
  return vaultAccrualNanos(amount, bps, width, width);
}

/** Next day boundary at or after the lock. An exact boundary stays put. */
export function nextDayHeight(lockHeight, dayBlocks = VAULT_DAY_BLOCKS) {
  let h;
  try { h = BigInt(lockHeight); } catch { return null; }
  const day = BigInt(dayBlocks);
  if (h < 0n || day <= 0n) return null;
  const rem = h % day;
  return rem === 0n ? h : h + (day - rem);
}

export function periodIndexAt(height, magic) {
  const period = vaultPeriodBlocks(magic);
  if (period == null) return null;
  let h;
  try { h = BigInt(height); } catch { return null; }
  if (h < 0n) return null;
  return h / BigInt(period);
}

export function epochOfPeriod(periodIndex) {
  const p = Math.floor(Number(periodIndex) || 0);
  if (p < 0) return 0;
  return Math.floor(p / VAULT_PERIODS_PER_EPOCH);
}

/**
 * Prefix[e] is the rate-weighted blocks before epoch e.
 * A missing epoch keeps the previous rate. Building the prefix walks
 * epochs once. Reading a height does not walk days.
 */
export function buildRatePrefix(rates, epochs, epochBlocks) {
  const n = Math.floor(Number(epochs) || 0);
  const width = BigInt(epochBlocks);
  if (n < 0 || width <= 0n) return null;
  const prefix = [0n];
  let rate = 0n;
  for (let e = 0; e < n; e += 1) {
    const named = rates?.[e] ?? rates?.[String(e)];
    if (named != null && named !== '') rate = BigInt(named);
    prefix.push(prefix[e] + rate * width);
  }
  return { prefix, rateAtEnd: rate, epochBlocks: width };
}

/** Weighted blocks in [0, height). No day loop. */
export function weightedBlocks(height, built, rates) {
  if (!built) return null;
  let h;
  try { h = BigInt(height); } catch { return null; }
  if (h < 0n) return null;
  const width = built.epochBlocks;
  const epoch = h / width;
  const into = h - epoch * width;
  const idx = Number(epoch);
  if (!Number.isSafeInteger(idx)) return null;
  if (idx < built.prefix.length - 1) {
    const named = rates?.[idx] ?? rates?.[String(idx)];
    const rate = named != null && named !== '' ? BigInt(named) : rateBefore(built, rates, idx);
    return built.prefix[idx] + rate * into;
  }
  const rate = rateBefore(built, rates, idx);
  const tail = built.prefix[built.prefix.length - 1] + rate * ((epoch - BigInt(built.prefix.length - 1)) * width + into);
  return tail;
}

function rateBefore(built, rates, idx) {
  let rate = built.rateAtEnd;
  for (let e = Math.min(idx, (built.prefix.length - 1)); e >= 0; e -= 1) {
    const named = rates?.[e] ?? rates?.[String(e)];
    if (named != null && named !== '') return BigInt(named);
  }
  return rate;
}

/**
 * One floor over [h0, h1). The rate of each epoch is inside the prefix,
 * so a lock that crosses an epoch accrues at each epoch's rate without a
 * second floor per day.
 */
export function accrualBetween(amount, h0, h1, rates, epochBlocks) {
  let start;
  let end;
  try {
    start = BigInt(h0);
    end = BigInt(h1);
  } catch {
    return null;
  }
  if (end < start) return null;
  if (end === start) return { nanos: 0n, weighted: 0n, from: start, to: end };
  const epochs = Number(end / BigInt(epochBlocks)) + 1;
  const built = buildRatePrefix(rates, epochs, epochBlocks);
  const w1 = weightedBlocks(end, built, rates);
  const w0 = weightedBlocks(start, built, rates);
  if (w1 == null || w0 == null || w1 < w0) return null;
  const weighted = w1 - w0;
  const width = BigInt(epochBlocks);
  const product = BigInt(amount) * weighted;
  const nanos = product / (width * VAULT_BPS_DENOM);
  return { nanos, weighted, from: start, to: end };
}

/**
 * Arrival stub for a leaf locked at lockHeight. Zero when the lock is on
 * the period boundary (that period is a claim) or the next day is already
 * past the period end.
 */
export function arrivalStubNanos({ amount, lockHeight, magic, rates, rate }) {
  const period = vaultPeriodBlocks(magic);
  const width = vaultEpochBlocks(magic);
  if (period == null) return null;
  let h;
  try { h = BigInt(lockHeight); } catch { return null; }
  const size = BigInt(period);
  const periodStart = (h / size) * size;
  const periodEnd = periodStart + size;
  if (h === periodStart) return { nanos: 0n, from: h, to: periodEnd };
  const from = nextDayHeight(h);
  if (from == null || from >= periodEnd) return { nanos: 0n, from, to: periodEnd };
  const table = rates && typeof rates === 'object' ? { ...rates } : {};
  if (rate != null && table[0] == null && table['0'] == null) table[0] = rate;
  const got = accrualBetween(amount, from, periodEnd, table, width);
  if (!got) return null;
  return { ...got, from, to: periodEnd };
}

/** Sum of the sixteen period floors against the single full-epoch floor. */
export function fullEpochByPeriods(amount, bps, magic) {
  const one = vaultPeriodReward(amount, bps, magic);
  const whole = vaultEpochReward(amount, bps, magic);
  if (!one || !whole) return null;
  const n = BigInt(VAULT_PERIODS_PER_EPOCH);
  const sum = one.nanos * n;
  return {
    period: one.nanos,
    periods: n,
    sum,
    whole: whole.nanos,
    gap: whole.nanos - sum,
  };
}

/**
 * Public supply for one period: the period constant times the live leaves,
 * plus the arrival stubs paid at withdraw. Both use the same floor.
 */
export function periodSupplyNanos({ leaves, stubs = [], amount, bps, magic } = {}) {
  const one = vaultPeriodReward(amount, bps, magic);
  if (!one) return null;
  const n = BigInt(Math.floor(Number(leaves) || 0));
  if (n < 0n) return null;
  let stubSum = 0n;
  for (const row of stubs) {
    const v = typeof row === 'bigint' ? row : BigInt(row || 0);
    if (v < 0n) return null;
    stubSum += v;
  }
  const claims = one.nanos * n;
  return { each: one.nanos, claims, stubs: stubSum, total: claims + stubSum };
}

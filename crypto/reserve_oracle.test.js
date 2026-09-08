import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVE_ORACLE_ID,
  RESERVE_ORACLE_DEFAULT_BPS,
  GENESIS_BPS,
  INTEREST_DENOM_DAYS,
  EPOCH_BPS_MAX_STEP,
  ORACLE_MAX_AGE_MS,
  emptyOracle,
  observeRate,
  interestNanos,
  accruedNanos,
  averagePolicyBps,
  freezeEpochBps,
  clampBpsStep,
} from './reserve_oracle.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PI_SHE_NANOS, NANOS_PER_SHE, HASH_BONUS_NANOS } from './asert.js';

describe('Reserve oracle', () => {
  it('observes a variable annual rate and pays interest on staked SHE only', () => {
    const o = emptyOracle();
    assert.equal(o.id, RESERVE_ORACLE_ID);
    assert.equal(o.annualBps, RESERVE_ORACLE_DEFAULT_BPS);
    assert.equal(o.annualBps, 264);
    assert.equal(observeRate(o, { annualBps: 250, nowMs: 10 }).ok, true);
    assert.equal(o.annualBps, 250);
    assert.equal(interestNanos(0, 250, 400), 0);
    const paid = interestNanos(PI_SHE_NANOS, 250, 400);
    assert.ok(paid > 0);
    assert.equal(paid, Number((BigInt(PI_SHE_NANOS) * 250n) / 10000n));
    assert.equal(observeRate(o, { annualBps: -1, nowMs: 11 }).ok, false);
    assert.equal(o.annualBps, 250);
  });

  it('golden vector 1 SHE × 425 bps is 0.0425 SHE (fixture only)', () => {
    assert.equal(interestNanos(NANOS_PER_SHE, 425), 4_250_000_000);
    assert.equal(interestNanos(NANOS_PER_SHE, 425) / NANOS_PER_SHE, 0.0425);
    assert.equal(interestNanos(NANOS_PER_SHE, 264), 2_640_000_000);
    assert.equal(interestNanos(NANOS_PER_SHE, 264) / NANOS_PER_SHE, 0.0264);
    assert.notEqual(interestNanos(NANOS_PER_SHE, GENESIS_BPS), 4_250_000_000);
  });

  it('accrues on elapsed time and matches full-epoch interest at 400 days', () => {
    const day = 86_400_000;
    assert.equal(accruedNanos(PI_SHE_NANOS, 425, 0), 0);
    const day1 = accruedNanos(PI_SHE_NANOS, 425, day);
    const day200 = accruedNanos(PI_SHE_NANOS, 425, 200 * day);
    const full = accruedNanos(PI_SHE_NANOS, 425, 400 * day);
    assert.ok(day1 > 0);
    assert.ok(day200 > day1);
    assert.ok(full > day200);
    assert.equal(full, interestNanos(PI_SHE_NANOS, 425, 400));
    assert.equal(accruedNanos(PI_SHE_NANOS, 425, 500 * day), full);
    assert.equal(accruedNanos(0, 425, 200 * day), 0);
  });

  it('default bps is the unweighted average of all observed policy rates', () => {
    const latest = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../reserve/latest.json'), 'utf8'));
    const avg = averagePolicyBps(latest.components);
    assert.equal(RESERVE_ORACLE_DEFAULT_BPS, avg);
    assert.equal(GENESIS_BPS, 264);
    assert.equal(INTEREST_DENOM_DAYS, 400);
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.notEqual(RESERVE_ORACLE_DEFAULT_BPS, 425);
  });

  it('|bps step| > 100 is clamped; stale observe reuses freeze', () => {
    assert.equal(clampBpsStep(264, 9999), 364);
    assert.equal(clampBpsStep(264, 0), 164);
    assert.equal(EPOCH_BPS_MAX_STEP, 100);
    const t0 = 1_700_000_000_000;
    assert.equal(freezeEpochBps({
      prevEpochBps: 264,
      annualBps: 425,
      observedAtMs: 0,
      nowMs: t0,
    }), 264);
    assert.equal(freezeEpochBps({
      prevEpochBps: 264,
      annualBps: 425,
      observedAtMs: t0,
      nowMs: t0,
    }), 364);
    assert.equal(freezeEpochBps({
      prevEpochBps: 364,
      annualBps: 9999,
      observedAtMs: t0,
      nowMs: t0 + ORACLE_MAX_AGE_MS + 1,
    }), 364);
  });
});

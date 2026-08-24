import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVE_ORACLE_ID,
  RESERVE_ORACLE_DEFAULT_BPS,
  emptyOracle,
  observeRate,
  interestNanos,
  accruedNanos,
} from './reserve_oracle.js';
import { PI_SHE_NANOS } from './asert.js';

describe('Reserve oracle', () => {
  it('observes a variable annual rate and pays interest on staked SHE only', () => {
    const o = emptyOracle();
    assert.equal(o.id, RESERVE_ORACLE_ID);
    assert.equal(o.annualBps, RESERVE_ORACLE_DEFAULT_BPS);
    assert.equal(observeRate(o, { annualBps: 250, nowMs: 10 }).ok, true);
    assert.equal(o.annualBps, 250);
    assert.equal(interestNanos(0, 250, 400), 0);
    const paid = interestNanos(PI_SHE_NANOS, 250, 400);
    assert.ok(paid > 0);
    assert.equal(paid, Math.floor((PI_SHE_NANOS * 250 * 400) / (10_000 * 365)));
    assert.equal(observeRate(o, { annualBps: -1, nowMs: 11 }).ok, false);
    assert.equal(o.annualBps, 250);
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
});

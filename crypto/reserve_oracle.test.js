import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVE_ORACLE_ID,
  RESERVE_ORACLE_DEFAULT_BPS,
  GENESIS_BPS,
  INTEREST_DENOM_DAYS,
  EPOCH_BPS_MAX_STEP,
  ORACLE_QUORUM,
  POLICY_BANK_IDS,
  BUNDLED_POLICY_TENTHS,
  emptyOracle,
  observeRate,
  interestNanos,
  accruedNanos,
  averagePolicyBps,
  freezeEpochBps,
  clampBpsStep,
  bundledEpochBps,
  quorumEpochBps,
  bundledComponents,
  epochRateBps,
  bundleObservationRoot,
} from './reserve_oracle.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PI_SHE_NANOS, NANOS_PER_SHE, HASH_BONUS_NANOS } from './asert.js';
import { MAGIC_MAINNET } from './pot_sched.js';

describe('Reserve oracle', () => {
  it('refuses a caller rate and pays the pure floor on staked SHE only', () => {
    const o = emptyOracle();
    assert.equal(o.id, RESERVE_ORACLE_ID);
    assert.equal(o.annualBps, RESERVE_ORACLE_DEFAULT_BPS);
    assert.equal(o.annualBps, 264);
    assert.equal(observeRate(o, { annualBps: 250, nowMs: 10 }).reason, 'rate_bundled');
    assert.equal(o.annualBps, 264);
    assert.equal(interestNanos(0, 250, 400), 0);
    const paid = interestNanos(PI_SHE_NANOS, 250, 400);
    assert.ok(paid > 0);
    assert.equal(paid, Number((BigInt(PI_SHE_NANOS) * 250n) / 10000n));
    assert.equal(observeRate(o, { annualBps: -1, nowMs: 11 }).ok, false);
    assert.equal(o.annualBps, 264);
  });

  it('golden vector 1 SHE × 425 bps is 0.0425 SHE (fixture only)', () => {
    assert.equal(interestNanos(NANOS_PER_SHE, 425), 4_250_000_000);
    assert.equal(interestNanos(NANOS_PER_SHE, 425) / NANOS_PER_SHE, 0.0425);
    assert.equal(interestNanos(NANOS_PER_SHE, 264), 2_640_000_000);
    assert.equal(interestNanos(NANOS_PER_SHE, 264) / NANOS_PER_SHE, 0.0264);
    assert.notEqual(interestNanos(NANOS_PER_SHE, GENESIS_BPS), 4_250_000_000);
  });

  it('accrues on elapsed time; testnet caps at 4 days, mainnet at 400', () => {
    const day = 86_400_000;
    assert.equal(accruedNanos(PI_SHE_NANOS, 425, 0), 0);
    const day1 = accruedNanos(PI_SHE_NANOS, 425, day);
    const full4 = accruedNanos(PI_SHE_NANOS, 425, 4 * day);
    assert.ok(day1 > 0);
    assert.ok(full4 > day1);
    assert.equal(full4, interestNanos(PI_SHE_NANOS, 425));
    assert.equal(accruedNanos(PI_SHE_NANOS, 425, 10 * day), full4);
    const day200 = accruedNanos(PI_SHE_NANOS, 425, 200 * day, MAGIC_MAINNET);
    const full400 = accruedNanos(PI_SHE_NANOS, 425, 400 * day, MAGIC_MAINNET);
    assert.ok(full400 > day200);
    assert.equal(full400, interestNanos(PI_SHE_NANOS, 425));
    assert.equal(accruedNanos(0, 425, 200 * day, MAGIC_MAINNET), 0);
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

  it('|bps step| > 100 is clamped; a caller observe cannot move the freeze', () => {
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
    }), 264);
    assert.equal(freezeEpochBps({
      prevEpochBps: 264,
      annualBps: 9999,
      observedAtMs: t0,
      nowMs: t0,
      magic: MAGIC_MAINNET,
    }), 264);
    assert.equal(epochRateBps(0), 100);
    assert.equal(epochRateBps(364), 264);
  });

  it('quorum is the 14 attested banks; a partial or substituted basket is not a rate', () => {
    const parts = bundledComponents();
    assert.equal(POLICY_BANK_IDS.length, ORACLE_QUORUM);
    assert.equal(parts.length, 14);
    const sum = parts.reduce((n, c) => n + c.tenths, 0);
    assert.equal(sum, 36900);
    assert.equal(bundledEpochBps(), 264);
    assert.equal(bundleObservationRoot(), bundleObservationRoot());
    assert.equal(quorumEpochBps(parts.slice(0, 13)), null);
    assert.equal(quorumEpochBps(parts.concat(parts[0])), null);
    const swapped = parts.map((c) => ({ ...c }));
    swapped[0] = { id: swapped[0].id, tenths: swapped[0].tenths + 10 };
    assert.equal(quorumEpochBps(swapped), null);
    const unknown = parts.map((c) => ({ ...c }));
    unknown[13] = { id: 'SOFR', tenths: BUNDLED_POLICY_TENTHS.CNB };
    assert.equal(quorumEpochBps(unknown), null);
    assert.equal(epochRateBps(264), epochRateBps(264));
  });
});

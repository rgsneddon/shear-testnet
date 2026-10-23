import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS } from './asert.js';
import { MAGIC_MAINNET } from './pot_sched.js';
import { interestNanos } from './reserve_oracle.js';
import {
  VAULT_DAY_BLOCKS,
  VAULT_TESTNET_DAY_BLOCKS,
  vaultDayBlocks,
  VAULT_PERIODS_PER_EPOCH,
  accrualBetween,
  arrivalStubNanos,
  buildRatePrefix,
  fullEpochByPeriods,
  nextDayHeight,
  periodSupplyNanos,
  vaultAccrualNanos,
  vaultEpochBlocks,
  vaultEpochReward,
  vaultPeriodBlocks,
  vaultPeriodReward,
  weightedBlocks,
} from './vault_accrual.js';
import { cloneVault, emptyVault } from './reserve_vault.js';

const PI = PI_SHE_NANOS;
const RATE = GENESIS_BPS;

describe('epoch rate is the total, not a daily rate', () => {
  it('one leaf held a full epoch earns floor(pi * 281 / 10000), within per-period flooring', () => {
    for (const magic of [MAGIC_TESTNET, MAGIC_MAINNET]) {
      const whole = vaultEpochReward(PI, RATE, magic);
      assert.equal(whole.nanos, BigInt(interestNanos(PI, RATE)));
      assert.equal(whole.nanos, (BigInt(PI) * BigInt(RATE)) / 10000n);
      const split = fullEpochByPeriods(PI, RATE, magic);
      assert.equal(split.periods, BigInt(VAULT_PERIODS_PER_EPOCH));
      assert.ok(split.sum <= split.whole);
      assert.ok(split.gap >= 0n);
      assert.ok(split.gap < split.periods);
      const day = vaultAccrualNanos(PI, RATE, VAULT_DAY_BLOCKS, vaultEpochBlocks(magic));
      const days = BigInt(vaultEpochBlocks(magic) / VAULT_DAY_BLOCKS);
      assert.ok(day.nanos * days <= whole.nanos);
    }
  });

  it('a day earns 1/epoch_days of the epoch total, never ~281 bps per day', () => {
    const width = vaultEpochBlocks(MAGIC_MAINNET);
    assert.equal(width / VAULT_DAY_BLOCKS, 400);
    const whole = vaultEpochReward(PI, RATE, MAGIC_MAINNET).nanos;
    const day = vaultAccrualNanos(PI, RATE, VAULT_DAY_BLOCKS, width).nanos;
    const perDayMistake = (BigInt(PI) * BigInt(RATE)) / 10000n;
    assert.equal(perDayMistake, whole);
    assert.ok(day * 400n <= whole);
    assert.ok(day * 2n < whole);
    assert.ok(whole / day > 300n && whole / day <= 400n);
    const period = vaultPeriodReward(PI, RATE, MAGIC_MAINNET).nanos;
    assert.ok(period < whole);
    assert.ok(period > day);
    assert.equal(vaultPeriodBlocks(MAGIC_MAINNET), width / VAULT_PERIODS_PER_EPOCH);
  });

  it('the arrival stub plus later period claims stay under the integral', () => {
    const magic = MAGIC_MAINNET;
    const width = vaultEpochBlocks(magic);
    const period = vaultPeriodBlocks(magic);
    const lock = 100;
    const stub = arrivalStubNanos({ amount: PI, lockHeight: lock, magic, rate: RATE });
    assert.ok(stub.nanos > 0n);
    assert.equal(stub.from, nextDayHeight(lock));
    assert.equal(stub.to, BigInt(period));
    const claims = vaultPeriodReward(PI, RATE, magic).nanos * BigInt(VAULT_PERIODS_PER_EPOCH - 1);
    const integral = vaultAccrualNanos(PI, RATE, BigInt(width) - 100n, width).nanos;
    assert.ok(stub.nanos + claims <= (BigInt(PI) * BigInt(RATE) * BigInt(width)) / (BigInt(width) * 10000n));
    assert.ok(stub.nanos + claims <= integral + BigInt(VAULT_PERIODS_PER_EPOCH));
    const onBoundary = arrivalStubNanos({ amount: PI, lockHeight: 0, magic, rate: RATE });
    assert.equal(onBoundary.nanos, 0n);
  });

  it('stubs plus claims across three epochs stay under pi times the integral', () => {
    const magic = MAGIC_MAINNET;
    const width = vaultEpochBlocks(magic);
    const epochs = 3;
    const lock = 100;
    const end = BigInt(epochs) * BigInt(width);
    const stub = arrivalStubNanos({ amount: PI, lockHeight: lock, magic, rate: RATE });
    assert.ok(stub.nanos > 0n);
    const periodReward = vaultPeriodReward(PI, RATE, magic).nanos;
    const claims = periodReward * (BigInt(epochs) * BigInt(VAULT_PERIODS_PER_EPOCH) - 1n);
    const rates = { 0: RATE };
    const integral = accrualBetween(PI, lock, end, rates, width);
    const held = end - BigInt(lock);
    const closed = (BigInt(PI) * BigInt(RATE) * held) / (BigInt(width) * 10000n);
    assert.equal(integral.nanos, closed);
    assert.ok(stub.nanos + claims <= integral.nanos);
    assert.ok(stub.nanos + claims <= closed);
  });

  it('a rate change is a prefix subtraction, and a reorg restores the table', () => {
    const width = vaultEpochBlocks(MAGIC_TESTNET);
    const rates = { 0: RATE, 1: RATE + 20 };
    const built = buildRatePrefix(rates, 2, width);
    const end = BigInt(width) + BigInt(width) / 2n;
    const weighted = weightedBlocks(end, built, rates) - weightedBlocks(0, built, rates);
    const closed = accrualBetween(PI, 0, end, rates, width);
    assert.equal(closed.weighted, weighted);
    const manual = (BigInt(PI) * BigInt(RATE) * BigInt(width)
      + BigInt(PI) * BigInt(RATE + 20) * (end - BigInt(width))) / (BigInt(width) * 10000n);
    assert.equal(closed.nanos, manual);
    const state = emptyVault();
    state.rateTable = { 0: RATE };
    const fork = cloneVault(state);
    fork.rateTable[1] = RATE + 20;
    assert.equal(state.rateTable[1], undefined);
    assert.equal(fork.rateTable[0], RATE);
  });

  it('supply is the period constant times the leaves, plus stubs', () => {
    const magic = MAGIC_TESTNET;
    for (const leaves of [1, 5, 20]) {
      const heights = [0, 10, 50, 240, 500];
      for (const lock of heights) {
        const stub = arrivalStubNanos({ amount: PI, lockHeight: lock, magic, rate: RATE });
        const supply = periodSupplyNanos({
          leaves,
          stubs: Array.from({ length: leaves }, () => stub.nanos),
          amount: PI,
          bps: RATE,
          magic,
        });
        const each = vaultPeriodReward(PI, RATE, magic).nanos;
        assert.equal(supply.claims, each * BigInt(leaves));
        assert.equal(supply.stubs, stub.nanos * BigInt(leaves));
        assert.equal(supply.total, supply.claims + supply.stubs);
      }
    }
    const changed = accrualBetween(PI, 0, vaultEpochBlocks(MAGIC_TESTNET), { 0: RATE + 5 }, vaultEpochBlocks(MAGIC_TESTNET));
    const base = vaultEpochReward(PI, RATE, MAGIC_TESTNET);
    assert.ok(changed.nanos > base.nanos);
  });
});

describe('testnet stub day fits inside the period', () => {
  it('a mid-period testnet lock has a nonzero stub and mainnet periods stay 24,000', () => {
    // Russell 21:34 17 Oct: the 960-block day was longer than the 240-block
    // testnet period, so the stub was always 0. The testnet stub day is 24.
    // Epoch width is still 960, so the mainnet period stays 24,000.
    assert.equal(vaultPeriodBlocks(MAGIC_MAINNET), 24_000);
    assert.equal(vaultPeriodBlocks(MAGIC_TESTNET), 240);
    assert.equal(VAULT_DAY_BLOCKS, 960);
    assert.equal(vaultDayBlocks(MAGIC_TESTNET), VAULT_TESTNET_DAY_BLOCKS);
    assert.ok(VAULT_TESTNET_DAY_BLOCKS < vaultPeriodBlocks(MAGIC_TESTNET));
    assert.equal(vaultDayBlocks(MAGIC_MAINNET), VAULT_DAY_BLOCKS);
    const boundary = arrivalStubNanos({ amount: PI, lockHeight: 0, magic: MAGIC_TESTNET, rate: RATE });
    assert.equal(boundary.nanos, 0n);
    const mid = arrivalStubNanos({ amount: PI, lockHeight: 1, magic: MAGIC_TESTNET, rate: RATE });
    assert.ok(mid.nanos > 0n);
    assert.equal(mid.from, nextDayHeight(1, VAULT_TESTNET_DAY_BLOCKS));
    const main = arrivalStubNanos({ amount: PI, lockHeight: 100, magic: MAGIC_MAINNET, rate: RATE });
    assert.ok(main.nanos > 0n);
    assert.equal(main.from, nextDayHeight(100));
  });
});

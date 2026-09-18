import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EPOCH_DAYS_TESTNET,
  EPOCH_DAYS_MAINNET,
  POT_START_NANOS,
  POT_STEP_NANOS,
  POT_FLOOR_NANOS,
  POT_EPOCHS_TO_FLOOR,
  epochDays,
  vortexEpochIndex,
  potSubsidyNanos,
  potSubsidyAt,
  nextPotNanos,
  potSchedPin,
  epochView,
} from './pot_sched.js';
import {
  MAGIC_TESTNET,
  MAGIC_MAINNET,
  consensusFingerprint,
  mainnetFingerprint,
  BLOCK_SUBSIDY_NANOS,
} from './asert.js';
import {
  freezeEpochBps,
  makeFreezeRecord,
  verifyFreezeRecord,
  clampBpsStep,
  GENESIS_BPS,
  EPOCH_BPS_MAX_STEP,
  RESERVE_ORACLE_MAX_BPS,
} from './reserve_oracle.js';


const DAY = 86_400_000;

describe('I1 pot schedule', () => {
  it('epoch 0/1/80/81+ nanos', () => {
    assert.equal(potSubsidyNanos(0), POT_START_NANOS);
    assert.equal(potSubsidyNanos(0), BLOCK_SUBSIDY_NANOS);
    assert.equal(potSubsidyNanos(1), POT_START_NANOS - POT_STEP_NANOS);
    assert.equal(potSubsidyNanos(1), 99_000_000_000);
    assert.equal(potSubsidyNanos(80), POT_FLOOR_NANOS);
    assert.equal(potSubsidyNanos(81), POT_FLOOR_NANOS);
    assert.equal(potSubsidyNanos(10_000), POT_FLOOR_NANOS);
    assert.equal(POT_EPOCHS_TO_FLOOR, 80);
    assert.equal((POT_START_NANOS - POT_FLOOR_NANOS) / POT_STEP_NANOS, 80);
  });

  it('boundary ms uses the new epoch on the first ms of N+1', () => {
    const g = 1_700_000_000_000;
    const four = EPOCH_DAYS_TESTNET * DAY;
    assert.equal(vortexEpochIndex({ nowMs: g, genesisMs: g, epochDays: 4 }), 0);
    assert.equal(vortexEpochIndex({ nowMs: g + four - 1, genesisMs: g, epochDays: 4 }), 0);
    assert.equal(vortexEpochIndex({ nowMs: g + four, genesisMs: g, epochDays: 4 }), 1);
    assert.equal(potSubsidyAt({ nowMs: g + four - 1, genesisMs: g, magic: MAGIC_TESTNET }), POT_START_NANOS);
    assert.equal(potSubsidyAt({ nowMs: g + four, genesisMs: g, magic: MAGIC_TESTNET }), 99_000_000_000);
  });

  it('testnet 4d vs mainnet 400d fingerprint', () => {
    assert.equal(epochDays(MAGIC_TESTNET), 4);
    assert.equal(epochDays(MAGIC_MAINNET), 400);
    const tn = consensusFingerprint(MAGIC_TESTNET);
    const mn = mainnetFingerprint();
    assert.match(tn, /EPOCH_DAYS=4/);
    assert.match(tn, /POT_SCHED=lin-epoch:start=100000000000:step=1000000000:floor=20000000000:epochDays=4/);
    assert.match(mn, /EPOCH_DAYS=400/);
    assert.match(mn, /epochDays=400/);
    assert.match(mn, /NETWORK=shear-v1/);
    assert.equal(tn.includes('EPOCH_DAYS=400'), false);
    assert.equal(potSchedPin(4).includes('epochDays=4'), true);
  });

  it('mainnet cannot take a 4-day env override', () => {
    const prev = process.env.SHEAR_EPOCH_DAYS;
    process.env.SHEAR_EPOCH_DAYS = '4';
    assert.equal(epochDays(MAGIC_MAINNET), 400);
    if (prev == null) delete process.env.SHEAR_EPOCH_DAYS;
    else process.env.SHEAR_EPOCH_DAYS = prev;
  });
});

describe('I2 three 4-day rollovers', () => {
  it('steps pot and freeze across three testnet epochs', () => {
    const g = 1_800_000_000_000;
    const span = 4 * DAY;
    const pots = [];
    for (let i = 0; i < 4; i += 1) {
      const t = g + i * span;
      pots.push(potSubsidyAt({ nowMs: t, genesisMs: g, magic: MAGIC_TESTNET }));
    }
    assert.deepEqual(pots, [
      100_000_000_000,
      99_000_000_000,
      98_000_000_000,
      97_000_000_000,
    ]);
    const view = epochView({ nowMs: g + span, genesisMs: g, magic: MAGIC_TESTNET });
    assert.equal(view.epoch, 1);
    assert.equal(view.potNanos, 99_000_000_000);
    assert.equal(view.nextPotNanos, 98_000_000_000);
    assert.equal(view.tailActive, false);
    assert.equal(view.epochDays, 4);
  });
});

describe('I3 oracle anti-game', () => {
  it('step/max/stale/equivocation; freeze cannot move pot', () => {
    assert.equal(clampBpsStep(264, 9999), 264 + EPOCH_BPS_MAX_STEP);
    assert.equal(freezeEpochBps({
      prevEpochBps: 264,
      annualBps: 9999,
      observedAtMs: 1,
      nowMs: 1,
    }) <= 264 + EPOCH_BPS_MAX_STEP, true);
    const stale = freezeEpochBps({
      prevEpochBps: 264,
      annualBps: 9000,
      observedAtMs: 1,
      nowMs: 1 + 15 * DAY,
    });
    assert.equal(stale, 264);
    const rec = makeFreezeRecord({
      epochIndex: 1,
      prevEpochBps: GENESIS_BPS,
      annualBps: 400,
      observedAtMs: 50,
      nowMs: 50,
    });
    assert.equal(verifyFreezeRecord(rec, { epochIndex: 1 }).ok, true);
    assert.equal(verifyFreezeRecord(rec, { epochIndex: 2 }).ok, false);
    const clash = { ...rec, observationRoot: 'other-root' };
    assert.equal(verifyFreezeRecord(clash, { epochIndex: 1, prevFreeze: rec }).reason, 'freeze_equivocation');
    const over = { ...rec, epochBps: RESERVE_ORACLE_MAX_BPS + 1 };
    assert.equal(verifyFreezeRecord(over, { epochIndex: 1 }).reason, 'freeze_bps');
    assert.equal(potSubsidyNanos(1), 99_000_000_000);
    assert.notEqual(rec.epochBps, potSubsidyNanos(1));
  });
});

describe('I4 governance separation', () => {
  it('next pot is schedule-only; votes do not appear in potSubsidyNanos', () => {
    assert.equal(nextPotNanos(0), potSubsidyNanos(1));
    assert.equal(potSubsidyNanos(0) - potSubsidyNanos(1), POT_STEP_NANOS);
  });
});

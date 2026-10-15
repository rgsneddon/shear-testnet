/**
 * A lock is a time-locked note under the user's key. It is spendable when
 * its lock epoch ends. Only the reward is minted, once per portal per epoch.
 * A withdraw of that mint id is rejected. Nine rewards in one block are not
 * given a payout rule while STAKE_REWARD_OVERFLOW is null.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, spendDestOf } from './address.js';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS } from './asert.js';
import { K_VW } from './block_budget.js';
import { outputJoinsAdmitSet } from './admit.js';
import { fs1LeafFor } from './fs1_leaf.js';
import {
  STAKE_REWARD_BLOCK_CAP,
  STAKE_REWARD_KIND,
  STAKE_REWARD_OVERFLOW,
  applyReserveBlock,
  cloneVault,
  deposit,
  emptyVault,
  lockTx,
  lockNoteSpendRejected,
  planStakeRewards,
  portalEpochInterest,
  stakeRewardNote,
  stakeRewardSupply,
  trialReserveApply,
  voteTx,
  VOTE_HOLD,
  withdraw,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  decodeWithdraw,
  encodeCredit,
  encodeDeposit,
  encodePinClock,
  encodeWithdraw,
} from './reserve_evm.js';
import { createNoteLedger } from '../node/src/note_ledger.js';

const T0 = 1_700_000_000_000;

function who() {
  return spendDestOf(newIdentity().spendPub);
}

function vault() {
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  state.genesisMs = T0;
  return state;
}

function lockNote(dest, nanos, id) {
  return lockTx({
    from: dest,
    to: dest,
    nanos,
    id,
    timeLock: true,
    lockEpoch: 0,
    unlockAtMs: T0 + RESERVE_EPOCH_MS,
  });
}

describe('time-locked lock notes', () => {
  it('indexes a lock and spends it only after the epoch ends', () => {
    const dest = who();
    const tx = lockNote(dest, 1000, 'lock-note');
    const out = tx.vout[0];
    assert.equal(outputJoinsAdmitSet(tx, out), true);
    assert.ok(fs1LeafFor(out));
    const book = createNoteLedger();
    book.sync([{ height: 1, hash: Buffer.alloc(32, 1), txs: [tx] }]);
    const before = book.spendable(dest, 1, { need: 1, tipMs: T0 + 1, genesisMs: T0 });
    const after = book.spendable(dest, 1, {
      need: 1,
      tipMs: T0 + RESERVE_EPOCH_MS,
      genesisMs: T0,
    });
    assert.equal(before, 0);
    assert.equal(after, 1000);
  });

  it('keeps two top-ups as two notes that unlock together', () => {
    const dest = who();
    const first = lockNote(dest, 400, 'top-a');
    const second = lockNote(dest, 600, 'top-b');
    assert.equal(first.vout[0].unlockAtMs, second.vout[0].unlockAtMs);
    assert.notEqual(first.vout[0].commit.toString('hex'), second.vout[0].commit.toString('hex'));
    const book = createNoteLedger();
    book.sync([{ height: 1, hash: Buffer.alloc(32, 2), txs: [first, second] }]);
    const held = book.spendable(dest, 1, { need: 1, tipMs: T0 + 1, genesisMs: T0 });
    const free = book.spendable(dest, 1, {
      need: 1,
      tipMs: T0 + RESERVE_EPOCH_MS,
      genesisMs: T0,
    });
    assert.equal(held, 0);
    assert.equal(free, 1000);
  });

  it('rejects a spend of the lock note before unlock', () => {
    const dest = who();
    const state = vault();
    const tx = lockNote(dest, PI_SHE_NANOS, 'lock-spend');
    const applied = applyReserveBlock({
      state,
      block: { height: 1, txs: [tx] },
      nowMs: T0 + 1_000,
      genesisMs: T0,
    });
    assert.equal(applied.ok, true, applied.reason);
    const spend = { vin: [{ commit: tx.vout[0].commit }] };
    assert.equal(lockNoteSpendRejected(state, spend, T0 + 2_000).reason, 'locked');
    assert.equal(lockNoteSpendRejected(state, spend, T0 + RESERVE_EPOCH_MS), null);
  });
});

describe('reward minted once', () => {
  it('coinbase-mints the reward and rejects a withdraw of that mint', () => {
    const dest = who();
    const state = vault();
    const locked = deposit({
      state,
      dest,
      nanos: PI_SHE_NANOS,
      nowMs: T0 + 1_000,
      payout: dest,
    });
    assert.equal(locked.ok, true, locked.reason);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = planStakeRewards(state, draw);
    assert.equal(plan.ok, true, plan.reason);
    assert.equal(plan.pay.length, 1);
    assert.ok(plan.pay[0].nanos > 0);
    assert.ok(plan.pay[0].nanos < PI_SHE_NANOS);
    const interest = portalEpochInterest(state, state.portals[plan.pay[0].portalId], draw);
    assert.equal(plan.pay[0].nanos, interest);
    const note = stakeRewardNote(plan.pay[0].dest, plan.pay[0].nanos, plan.pay[0].epoch, plan.pay[0].portalId);
    assert.ok(note);
    assert.equal(note.kind, STAKE_REWARD_KIND);
    assert.equal(Number(note.valueProof.v), plan.pay[0].nanos);
    assert.ok(fs1LeafFor(note));
    assert.equal(outputJoinsAdmitSet({ coinbase: true }, note), true);
    const block = { height: 2, txs: [{ coinbase: true, vout: [note] }] };
    const supply = stakeRewardSupply(state, block, draw);
    assert.equal(supply.ok, true, supply.reason);
    assert.equal(supply.minted, BigInt(plan.pay[0].nanos));
    assert.equal(supply.permitted, supply.minted);
    const applied = applyReserveBlock({
      state,
      block,
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(applied.ok, true, applied.reason);
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal(Number(state.mintBankNanos), plan.pay[0].nanos);
    const drawn = withdraw({ state, dest, nowMs: draw });
    assert.equal(drawn.ok, false);
    assert.equal(drawn.reason, 'double_mint');
    const again = applyReserveBlock({
      state,
      block: { height: 3, txs: [{ coinbase: true, vout: [] }] },
      nowMs: draw + 1,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(again.ok, true, again.reason);
    assert.equal(Number(state.mintBankNanos), plan.pay[0].nanos);
  });

  it('undoes the mint when the block is rejected', () => {
    const dest = who();
    const state = vault();
    assert.equal(deposit({
      state,
      dest,
      nanos: PI_SHE_NANOS,
      nowMs: T0 + 1_000,
      payout: dest,
    }).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = planStakeRewards(state, draw);
    const note = stakeRewardNote(plan.pay[0].dest, plan.pay[0].nanos, plan.pay[0].epoch, plan.pay[0].portalId);
    const beforeLocked = Number(state.totalLockedNanos);
    const trial = trialReserveApply({
      state,
      block: {
        height: 2,
        txs: [
          { coinbase: true, vout: [note] },
          voteTx({ from: dest, dest, choice: VOTE_HOLD, id: 'late-vote' }),
        ],
      },
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
      inPlace: true,
    });
    assert.equal(trial.ok, false);
    assert.equal(Number(state.totalLockedNanos), beforeLocked);
    assert.equal(Number(state.mintBankNanos), 0);
    assert.equal(withdraw({ state, dest, nowMs: draw }).ok, true);
  });

  it('matches the EVM credit and then rejects withdraw', async () => {
    const dest = who();
    const state = vault();
    const when = T0 + 1_000;
    assert.equal(deposit({
      state,
      dest,
      nanos: PI_SHE_NANOS,
      nowMs: when,
      payout: dest,
    }).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = planStakeRewards(state, draw);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, when))).ok, true);
    const credited = await callReserve(session, encodeCredit(dest, draw));
    assert.equal(credited.ok, true, credited.reason);
    const paid = decodeWithdraw(credited.returnValue);
    assert.equal(paid.principal, PI_SHE_NANOS);
    assert.equal(paid.interest, plan.pay[0].nanos);
    assert.ok(paid.interest > 0);
    assert.ok(paid.interest < PI_SHE_NANOS);
    const again = await callReserve(session, encodeWithdraw(dest, draw));
    assert.equal(again.ok, false);
  });
});

describe('more than eight rewards', () => {
  it('does not choose a payout while the overflow rule is unset', () => {
    assert.equal(STAKE_REWARD_BLOCK_CAP, K_VW);
    assert.equal(STAKE_REWARD_BLOCK_CAP, 8);
    assert.equal(STAKE_REWARD_OVERFLOW, null);
    const state = vault();
    for (let i = 0; i < 9; i += 1) {
      const dest = who();
      const got = deposit({
        state,
        dest,
        nanos: PI_SHE_NANOS,
        nowMs: T0 + 1_000,
        payout: dest,
      });
      assert.equal(got.ok, true, got.reason);
    }
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = planStakeRewards(state, draw);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'reward_overflow_unset');
    assert.equal(plan.pay.length, 0);
    assert.equal(plan.held.length, 9);
    const locked = Number(state.totalLockedNanos);
    const applied = applyReserveBlock({
      state,
      block: { height: 2, txs: [{ coinbase: true, vout: [] }] },
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(applied.ok, true, applied.reason);
    assert.equal(Number(state.mintBankNanos), 0);
    assert.equal(Number(state.totalLockedNanos), locked);
    const one = cloneVault(state);
    const row = plan.held[0];
    const note = stakeRewardNote(row.dest, row.nanos, row.epoch, row.portalId);
    const forced = applyReserveBlock({
      state: one,
      block: { height: 2, txs: [{ coinbase: true, vout: [note] }] },
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(forced.ok, false);
    assert.equal(forced.reason, 'stake_reward');
  });
});

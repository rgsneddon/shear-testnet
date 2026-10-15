/**
 * A lock is a time-locked note under the user's key. It is spendable when
 * its lock epoch ends. The epoch-end block commits one reward root. The user
 * claims that reward once, in their own tx. A second claim or a withdraw of
 * the same id is rejected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, spendDestOf } from './address.js';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, RESERVE_PROGRAM, extraMintAllowed } from './asert.js';
import { outputJoinsAdmitSet } from './admit.js';
import { compactTx } from './chronoflux.js';
import { fs1LeafFor } from './fs1_leaf.js';
import { selectBodyIndexes, txVerifyWeight } from './block_budget.js';
import { FEE_SPLIT_FINDER_BPS, LEVY_CAP_NANOS, levyNanos, levyNeed, levyTaxed, splitLevy } from './levy.js';
import { admitMempool, emptyMempool } from './mempool.js';
import { EMPTY_ROOT, merkleRoot } from './merkle.js';
import {
  KIND_REWARD_CLAIM,
  applyReserveBlock,
  coinbaseRewardRoot,
  deposit,
  emptyVault,
  lockStampRejected,
  lockTx,
  lockNoteSpendRejected,
  packRewardProof,
  portalEpochInterest,
  portalIdFromDest,
  portalPrincipalNanos,
  rewardClaimProof,
  rewardClaimTx,
  rewardCommitment,
  txIsReserveAction,
  rewardLeaf,
  stakeRewardSupply,
  trialReserveApply,
  voteTx,
  VOTE_HOLD,
  withdraw,
  withdrawMintId,
} from './reserve_vault.js';
import { handleWalletApi } from '../pool/src/wallet_api.js';
import {
  bootReserveEvm,
  callReserve,
  decodeBytes32,
  decodePublicView,
  encodeClaim,
  encodeCommitRewards,
  encodeDeposit,
  encodePinClock,
  encodePublicView,
  encodeWithdraw,
  executeBlockEvm,
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

  it('keeps the unlock on the sealed lock and refuses a different one', () => {
    const dest = who();
    const tx = lockNote(dest, 1000, 'lock-wire');
    const wire = compactTx(tx);
    assert.equal(wire.vout[0].unlockAtMs, T0 + RESERVE_EPOCH_MS);
    assert.equal(wire.vout[0].lockEpoch, 0);
    assert.ok(wire.vout[0].admitPub);
    assert.equal(wire.vout[0].r, undefined);
    const plain = compactTx(lockTx({ from: dest, to: dest, nanos: 1000, id: 'plain-lock' }));
    assert.equal(plain.vout[0].unlockAtMs, undefined);
    assert.equal(plain.vout[0].lockEpoch, undefined);
    const state = vault();
    const bad = lockTx({
      from: dest,
      to: dest,
      nanos: 1000,
      id: 'early-lock',
      timeLock: true,
      lockEpoch: 0,
      unlockAtMs: T0 + 1,
    });
    assert.equal(lockStampRejected(state, bad, T0 + 1_000).reason, 'lock_unlock');
    const refused = applyReserveBlock({
      state,
      block: { height: 1, txs: [bad] },
      nowMs: T0 + 1_000,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'lock_unlock');
    assert.equal(Number(state.totalLockedNanos), 0);
    const book = createNoteLedger();
    book.sync([{ height: 1, hash: Buffer.alloc(32, 7), txs: [wire] }]);
    assert.equal(book.spendable(dest, 1, { need: 1, tipMs: T0 + 1, genesisMs: T0 }), 0);
    assert.equal(book.spendable(dest, 1, {
      need: 1,
      tipMs: T0 + RESERVE_EPOCH_MS,
      genesisMs: T0,
    }), 1000);
  });

  it('holds the funding coins after the lock note is the principal', () => {
    const payer = who();
    const dest = who();
    const state = vault();
    const tx = lockTx({
      from: payer,
      to: dest,
      nanos: PI_SHE_NANOS,
      id: 'principal-note',
      timeLock: true,
      lockEpoch: 0,
      unlockAtMs: T0 + RESERVE_EPOCH_MS,
    });
    const locked = applyReserveBlock({
      state,
      block: { height: 1, txs: [tx] },
      nowMs: T0 + 1_000,
      genesisMs: T0,
    });
    assert.equal(locked.ok, true, locked.reason);
    const portal = state.portals[Object.keys(state.portals)[0]];
    assert.equal(portal.tranches[0].noteIsPrincipal, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 1);
    const credited = applyReserveBlock({
      state,
      block: { height: 2, txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] },
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(credited.ok, true, credited.reason);
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal(portalPrincipalNanos(state, payer), PI_SHE_NANOS);
    assert.equal(portalPrincipalNanos(state, dest), PI_SHE_NANOS);
    const book = createNoteLedger();
    book.sync([{ height: 1, hash: Buffer.alloc(32, 8), txs: [compactTx(tx)] }]);
    const clock = { need: 1, tipMs: draw, genesisMs: T0 };
    const opened = book.spendable(dest, 1, clock);
    const released = book.unlockedLockNanos(dest, 1, clock);
    const principal = portalPrincipalNanos(state, dest);
    assert.equal(opened, PI_SHE_NANOS);
    assert.equal(Math.max(0, opened - Math.max(0, principal - released)), PI_SHE_NANOS);
    const payerOpened = book.spendable(payer, 1, clock);
    const payerReleased = book.unlockedLockNanos(payer, 1, clock);
    const payerPrincipal = portalPrincipalNanos(state, payer);
    assert.equal(Math.max(0, payerOpened - Math.max(0, payerPrincipal - payerReleased)), 0);
  });
});

function lockPortal(state, dest, when = T0 + 1_000) {
  return deposit({
    state,
    dest,
    nanos: PI_SHE_NANOS,
    nowMs: when,
    payout: dest,
  });
}

function commitBlock(plan) {
  return { height: 2, txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] };
}

describe('aggregated reward root', () => {
  it('commits one root of rate × principal × pro-rata time, with the pi gate and the cutoff', () => {
    const dest = who();
    const state = vault();
    assert.equal(lockPortal(state, dest).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const portal = state.portals[portalIdFromDest(dest)];
    const tranche = portal.tranches[0];
    const span = RESERVE_EPOCH_MS;
    const expected = Number(
      (BigInt(PI_SHE_NANOS) * BigInt(GENESIS_BPS) * BigInt(tranche.remainMs)) / (BigInt(span) * 10000n),
    );
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 1);
    assert.equal(plan.rows[0].nanos, expected);
    assert.equal(plan.rows[0].nanos, portalEpochInterest(state, portal, draw));
    assert.equal(plan.rows[0].nullifier, withdrawMintId(portal.id, plan.rows[0].epoch));
    const leaf = rewardLeaf(plan.rows[0].nullifier, plan.rows[0].nanos);
    assert.equal(plan.root, Buffer.from(merkleRoot([leaf])).toString('hex'));
    const below = vault();
    assert.equal(deposit({
      state: below, dest: who(), nanos: 1, nowMs: T0 + 1_000, payout: who(),
    }).ok, true);
    assert.equal(rewardCommitment(below, draw).rows.length, 0);
    const late = vault();
    const lateDest = who();
    assert.equal(lockPortal(late, lateDest, T0 + RESERVE_EPOCH_MS - 1_000).ok, true);
    assert.equal(rewardCommitment(late, draw).rows.length, 0);
    const many = vault();
    for (let i = 0; i < 9; i += 1) assert.equal(lockPortal(many, who()).ok, true);
    const wide = rewardCommitment(many, draw);
    assert.equal(wide.rows.length, 9);
    const leaves = wide.rows.map((row) => rewardLeaf(row.nullifier, row.nanos));
    assert.equal(wide.root, Buffer.from(merkleRoot(leaves)).toString('hex'));
    const committed = applyReserveBlock({
      state: many,
      block: commitBlock(wide),
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(Number(many.mintBankNanos), 0);
    assert.equal(Number(many.totalLockedNanos), 0);
    const rowNote = { coinbase: true, vout: [{ kind: 'stake-reward' }], rewardRoot: wide.root };
    const refused = applyReserveBlock({
      state: vault(),
      block: { height: 2, txs: [rowNote] },
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(refused.reason, 'stake_reward');
  });

  it('mints a claim once, rejects a second claim and a withdraw, and still pays epochs later', () => {
    const lockDest = who();
    const payDest = who();
    const state = vault();
    assert.equal(lockPortal(state, lockDest).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = rewardCommitment(state, draw);
    const row = plan.rows[0];
    assert.notEqual(payDest, lockDest);
    const committed = applyReserveBlock({
      state,
      block: commitBlock(plan),
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(Number(state.mintBankNanos), 0);
    const proof = rewardClaimProof(state, row.nullifier);
    const claim = rewardClaimTx({
      to: payDest,
      nanos: row.nanos,
      nullifier: row.nullifier,
      proof,
      id: 'claim-once',
    });
    assert.equal(claim.kind, KIND_REWARD_CLAIM);
    assert.equal(claim.portalId, undefined);
    assert.equal(claim.vout[0].portalId, undefined);
    assert.equal(claim.nullifier, withdrawMintId(portalIdFromDest(lockDest), row.epoch));
    assert.ok(fs1LeafFor(claim.vout[0]));
    assert.equal(outputJoinsAdmitSet(claim, claim.vout[0]), true);
    assert.equal(levyTaxed(claim), true);
    assert.equal(claim.fee, levyNanos(0, { tx: { ...claim, fee: undefined } }));
    const later = draw + 3 * RESERVE_EPOCH_MS;
    const paid = applyReserveBlock({
      state,
      block: { height: 9, txs: [{ coinbase: true, vout: [] }, claim] },
      nowMs: later,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(Number(state.mintBankNanos), row.nanos);
    const supply = stakeRewardSupply(state, { txs: [{ coinbase: true, vout: [] }, claim] }, later);
    assert.equal(supply.ok, false);
    const fresh = vault();
    assert.equal(lockPortal(fresh, lockDest).ok, true);
    const againPlan = rewardCommitment(fresh, draw);
    const other = who();
    assert.equal(lockPortal(fresh, other).ok, true);
    const both = rewardCommitment(fresh, draw);
    assert.equal(both.rows.length, 2);
    assert.equal(applyReserveBlock({
      state: fresh,
      block: commitBlock(both),
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    }).ok, true);
    const one = both.rows.find((item) => item.nullifier === againPlan.rows[0].nullifier);
    const claimOne = rewardClaimTx({
      to: payDest,
      nanos: one.nanos,
      nullifier: one.nullifier,
      proof: rewardClaimProof(fresh, one.nullifier),
      id: 'claim-one',
    });
    const block = { height: 4, txs: [{ coinbase: true, vout: [] }, claimOne] };
    assert.equal(applyReserveBlock({
      state: fresh,
      block,
      nowMs: later,
      genesisMs: T0,
    }).ok, true);
    const summed = stakeRewardSupply(fresh, block, later);
    assert.equal(summed.ok, false);
    const beforeClaim = vault();
    assert.equal(lockPortal(beforeClaim, lockDest).ok, true);
    assert.equal(lockPortal(beforeClaim, other).ok, true);
    const open = rewardCommitment(beforeClaim, draw);
    const only = open.rows[0];
    const supplyState = beforeClaim;
    const supplyProof = rewardClaimProof({
      rewardBook: Object.fromEntries(open.rows.map((item) => [item.nullifier, {
        nanos: item.nanos,
        rootKey: String(open.index),
        portalId: item.portalId,
      }])),
      rewardSets: { [String(open.index)]: open.rows },
    }, only.nullifier);
    const supplyBlock = {
      height: 4,
      txs: [
        { coinbase: true, vout: [], rewardRoot: open.root },
        rewardClaimTx({
          to: payDest,
          nanos: only.nanos,
          nullifier: only.nullifier,
          proof: supplyProof,
          id: 'claim-supply',
        }),
      ],
    };
    const got = stakeRewardSupply(supplyState, supplyBlock, draw);
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.minted, 0n);
    assert.equal(got.claimed, BigInt(only.nanos));
    const unclaimed = open.rows.reduce((sum, item) => sum + item.nanos, 0) - only.nanos;
    assert.ok(unclaimed > 0);
    assert.notEqual(got.claimed, BigInt(only.nanos + unclaimed));
    const spent = applyReserveBlock({
      state: supplyState,
      block: supplyBlock,
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(spent.ok, true, spent.reason);
    const second = rewardClaimTx({
      to: payDest,
      nanos: only.nanos,
      nullifier: only.nullifier,
      proof: supplyProof,
      id: 'claim-again',
    });
    const doubled = applyReserveBlock({
      state: supplyState,
      block: { height: 5, txs: [{ coinbase: true, vout: [] }, second] },
      nowMs: later,
      genesisMs: T0,
    });
    assert.equal(doubled.ok, false);
    assert.equal(doubled.reason, 'double_mint');
    assert.equal(withdraw({ state: supplyState, dest: lockDest, nowMs: later }).reason, 'double_mint');
    assert.equal(Number(supplyState.mintBankNanos), only.nanos);
  });

  it('undoes the root and its claim when the block is rejected', () => {
    const dest = who();
    const state = vault();
    assert.equal(lockPortal(state, dest).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = rewardCommitment(state, draw);
    const row = plan.rows[0];
    const preview = {
      rewardBook: { [row.nullifier]: { nanos: row.nanos, epoch: row.epoch, rootKey: String(plan.index), portalId: row.portalId } },
      rewardSets: { [String(plan.index)]: plan.rows },
      rewardRoots: { [String(plan.index)]: plan.root },
    };
    const claim = rewardClaimTx({
      to: who(),
      nanos: row.nanos,
      nullifier: row.nullifier,
      proof: rewardClaimProof(preview, row.nullifier),
      id: 'claim-undo',
    });
    const beforeLocked = Number(state.totalLockedNanos);
    const trial = trialReserveApply({
      state,
      block: {
        height: 2,
        txs: [
          { coinbase: true, vout: [], rewardRoot: plan.root },
          claim,
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
    assert.equal(state.rewardRoots[String(plan.index)], undefined);
    assert.equal(withdraw({ state, dest, nowMs: draw }).ok, true);
  });

  it('matches the EVM root and then rejects a second claim and a withdraw', async () => {
    const dest = who();
    const state = vault();
    const when = T0 + 1_000;
    assert.equal(lockPortal(state, dest, when).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = rewardCommitment(state, draw);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, when))).ok, true);
    const committed = await callReserve(session, encodeCommitRewards(draw));
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(decodeBytes32(committed.returnValue), plan.root);
    const row = plan.rows[0];
    const preview = {
      rewardBook: { [row.nullifier]: { nanos: row.nanos, rootKey: String(plan.index), portalId: row.portalId } },
      rewardSets: { [String(plan.index)]: plan.rows },
    };
    const proof = packRewardProof(rewardClaimProof(preview, row.nullifier));
    const claimed = await callReserve(session, encodeClaim(row.nullifier, row.nanos, proof));
    assert.equal(claimed.ok, true, claimed.reason);
    assert.equal(decodeBytes32(claimed.returnValue), row.nanos.toString(16).padStart(64, '0'));
    const again = await callReserve(session, encodeClaim(row.nullifier, row.nanos, proof));
    assert.equal(again.ok, false);
    const drawn = await callReserve(session, encodeWithdraw(dest, draw));
    assert.equal(drawn.ok, false);
  });

  it('orders mempool claims by fee rate and pays the whole fee to miners', () => {
    const state = vault();
    const lockDest = who();
    const other = who();
    assert.equal(lockPortal(state, lockDest).ok, true);
    assert.equal(lockPortal(state, other).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 2);
    assert.equal(applyReserveBlock({
      state,
      block: commitBlock(plan),
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    }).ok, true);
    const [first, second] = plan.rows;
    const pay = who();
    const low = rewardClaimTx({
      to: pay,
      nanos: first.nanos,
      nullifier: first.nullifier,
      proof: rewardClaimProof(state, first.nullifier),
      id: 'claim-low',
      fee: 1_000,
    });
    const high = rewardClaimTx({
      to: who(),
      nanos: second.nanos,
      nullifier: second.nullifier,
      proof: rewardClaimProof(state, second.nullifier),
      id: 'claim-high',
      fee: 8_000,
    });
    assert.equal(low.fee, 1_000);
    assert.equal(high.fee, 8_000);
    assert.equal(txIsReserveAction(low), false);
    assert.equal(levyTaxed(low), true);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'reward-claim' }), true);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'claim' }), false);
    const floor = rewardClaimTx({
      to: pay,
      nanos: first.nanos,
      nullifier: first.nullifier,
      proof: rewardClaimProof(state, first.nullifier),
      id: 'claim-floor',
    });
    assert.ok(floor.fee >= levyNanos(0, { tx: { ...floor, fee: undefined } }));
    assert.equal(floor.fee, levyNanos(0, { tx: floor }));
    assert.ok(low.fee >= levyNeed(low));
    assert.ok(low.fee <= LEVY_CAP_NANOS);
    assert.ok(high.fee > low.fee);

    const book = emptyMempool();
    const admittedLow = admitMempool(book, low);
    const admittedHigh = admitMempool(book, high);
    assert.equal(admittedLow.ok, true, admittedLow.reason);
    assert.equal(admittedHigh.ok, true, admittedHigh.reason);
    const picks = selectBodyIndexes(book.txs);
    assert.equal(book.txs[picks[0]].id, 'claim-high');
    assert.equal(book.txs[picks[1]].id, 'claim-low');

    const heavy = {
      ...high,
      id: 'claim-heavy',
      fee: 1_500,
      vout: [high.vout[0], { ...high.vout[0] }],
    };
    const light = { ...low, id: 'claim-light', fee: 1_000 };
    assert.ok(txVerifyWeight(heavy) > txVerifyWeight(light));
    assert.ok(heavy.fee > light.fee);
    assert.ok(light.fee * txVerifyWeight(heavy) > heavy.fee * txVerifyWeight(light));
    assert.deepEqual(selectBodyIndexes([heavy, light]), [1, 0]);

    const crowd = [];
    for (let i = 0; i < 33; i += 1) {
      const lock = lockTx({ from: who(), to: who(), nanos: 1, id: `busy-lock-${i}` });
      lock.fee = 50_000;
      crowd.push(lock);
    }
    crowd.push(low);
    const busy = selectBodyIndexes(crowd);
    const busyLocks = busy.filter((i) => crowd[i].kind === 'lock');
    assert.equal(busyLocks.length, 32);
    assert.ok(busy.some((i) => crowd[i].id === 'claim-low'));

    assert.equal(FEE_SPLIT_FINDER_BPS, 10_000);
    assert.deepEqual(splitLevy(low.fee + high.fee), {
      finder: low.fee + high.fee,
      reserve: 0,
    });

    const posted = [];
    const body = {
      kind: 'reward-claim',
      programId: 'shear-reserve-v1',
      to: pay,
      nanos: first.nanos,
      nullifier: first.nullifier,
      proof: low.proof,
      vout: low.vout,
      id: 'claim-post',
      fee: 8_000,
    };
    const accepted = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', body, {
      queueSend: (tx) => {
        posted.push(tx);
        return tx;
      },
    });
    assert.equal(accepted.status, 200, accepted.json && accepted.json.reason);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].fee, 8_000);
    assert.equal(posted[0].kind, 'reward-claim');
    const short = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', {
      ...body,
      fee: 1,
      id: 'claim-short',
    }, { queueSend: (tx) => tx });
    assert.equal(short.status, 400);
    assert.equal(short.json.reason, 'levy');
    const bare = { ...body, id: 'claim-bare' };
    delete bare.fee;
    const noFee = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', bare, {
      queueSend: (tx) => tx,
    });
    assert.equal(noFee.status, 400);
    assert.equal(noFee.json.reason, 'bad_send');
  });
});

describe('empty reward epochs still release principal', () => {
  const draw = T0 + RESERVE_EPOCH_MS + 1;
  const emptyRoot = Buffer.from(EMPTY_ROOT).toString('hex');

  function timeLock(state, dest, nanos, when, id) {
    const tx = lockTx({
      from: dest,
      to: dest,
      nanos,
      id,
      timeLock: true,
      lockEpoch: 0,
      unlockAtMs: T0 + RESERVE_EPOCH_MS,
    });
    const applied = applyReserveBlock({
      state,
      block: { height: 1, txs: [tx] },
      nowMs: when,
      genesisMs: T0,
    });
    return { tx, applied };
  }

  function settle(state, root) {
    const cb = { coinbase: true, vout: [] };
    if (root != null) cb.rewardRoot = root;
    return applyReserveBlock({
      state,
      block: { height: 2, txs: [cb] },
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
  }

  function released(state, dest, nanos) {
    const portal = state.portals[portalIdFromDest(dest)];
    assert.equal(portal.tranches.length, 0);
    assert.equal(Number(portal.staked) + Number(portal.idle), 0);
    assert.equal(Number(portal.redeemedNanos), nanos);
    assert.equal(Number(state.totalLockedNanos), 0);
  }

  it('an epoch with no earning portals still releases principal', () => {
    const dest = who();
    const state = vault();
    state.epochBps = 0;
    state.pendingRates[0] = 0;
    const { tx, applied } = timeLock(state, dest, PI_SHE_NANOS, T0 + 1_000, 'zero-rate');
    assert.equal(applied.ok, true, applied.reason);
    assert.equal(rewardCommitment(state, draw).rows.length, 0);
    assert.equal(coinbaseRewardRoot(state, draw), emptyRoot);
    assert.equal(lockNoteSpendRejected(state, { vin: [{ commit: tx.vout[0].commit }] }, T0 + 2_000).reason, 'locked');
    const settled = settle(state);
    assert.equal(settled.ok, true, settled.reason);
    released(state, dest, PI_SHE_NANOS);
    assert.equal(lockNoteSpendRejected(state, { vin: [{ commit: tx.vout[0].commit }] }, draw), null);
    assert.equal(coinbaseRewardRoot(state, draw), '');
    assert.equal(Number(state.mintBankNanos), 0);

    const earning = vault();
    assert.equal(lockPortal(earning, who()).ok, true);
    const missing = settle(earning);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'stake_reward');
    assert.equal(Number(earning.totalLockedNanos), PI_SHE_NANOS);
  });

  it('an empty-root epoch releases principal', async () => {
    const dest = who();
    const state = vault();
    const { applied } = timeLock(state, dest, 1, T0 + 1_000, 'empty-root');
    assert.equal(applied.ok, true, applied.reason);
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 0);
    assert.equal(plan.root, emptyRoot);
    const settled = settle(state, emptyRoot);
    assert.equal(settled.ok, true, settled.reason);
    released(state, dest, 1);
    assert.equal(state.rewardRoots[String(plan.index)], undefined);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, 1, T0 + 1_000))).ok, true);
    const committed = await callReserve(session, encodeCommitRewards(draw));
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(decodeBytes32(committed.returnValue), emptyRoot);
    const view = decodePublicView(
      (await callReserve(session, encodePublicView(draw), { staticCall: true })).returnValue,
    );
    assert.equal(view.totalLockedNanos, 0);

    const again = await bootReserveEvm();
    assert.equal((await callReserve(again, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(again, encodeDeposit(dest, 1, T0 + 1_000))).ok, true);
    const ran = await executeBlockEvm(again, [{
      coinbase: true,
      vout: [],
      rewardRoot: emptyRoot,
    }], draw, T0);
    assert.equal(ran.ok, true, ran.reason);
    const ranView = decodePublicView(
      (await callReserve(again, encodePublicView(draw), { staticCall: true })).returnValue,
    );
    assert.equal(ranView.totalLockedNanos, 0);
  });

  it('post-cutoff and below-pi locks still unlock', async () => {
    const lateWhen = T0 + RESERVE_EPOCH_MS - 1_000;
    const lateDest = who();
    const late = vault();
    const lateLock = timeLock(late, lateDest, PI_SHE_NANOS, lateWhen, 'post-cutoff');
    assert.equal(lateLock.applied.ok, true, lateLock.applied.reason);
    assert.equal(rewardCommitment(late, draw).rows.length, 0);
    assert.equal(settle(late).ok, true);
    released(late, lateDest, PI_SHE_NANOS);
    assert.equal(lockNoteSpendRejected(late, { vin: [{ commit: lateLock.tx.vout[0].commit }] }, draw), null);

    const smallDest = who();
    const small = vault();
    const smallLock = timeLock(small, smallDest, 1, T0 + 1_000, 'below-pi');
    assert.equal(smallLock.applied.ok, true, smallLock.applied.reason);
    assert.equal(rewardCommitment(small, draw).rows.length, 0);
    assert.equal(settle(small).ok, true);
    released(small, smallDest, 1);
    assert.equal(lockNoteSpendRejected(small, { vin: [{ commit: smallLock.tx.vout[0].commit }] }, draw), null);

    const book = createNoteLedger();
    const wire = compactTx(smallLock.tx);
    book.sync([
      { height: 1, hash: Buffer.alloc(32, 4), txs: [wire] },
      {
        height: 2,
        hash: Buffer.alloc(32, 5),
        txs: [{ vin: [{ noteCommit: wire.vout[0].noteCommit }], vout: [] }],
      },
    ]);
    const clock = { need: 1, tipMs: draw, genesisMs: T0 };
    assert.equal(book.unlockedLockNanos(smallDest, 2, clock), 0);
    assert.equal(book.coveredLockNanos(smallDest, 2, clock), 1);
    const inbound = 500;
    const principal = portalPrincipalNanos(small, smallDest);
    assert.equal(principal, 1);
    assert.equal(
      Math.max(0, inbound - Math.max(0, principal - book.coveredLockNanos(smallDest, 2, clock))),
      inbound,
    );

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(lateDest, PI_SHE_NANOS, lateWhen))).ok, true);
    const lateCommit = await callReserve(session, encodeCommitRewards(draw));
    assert.equal(lateCommit.ok, true, lateCommit.reason);
    assert.equal(decodeBytes32(lateCommit.returnValue), emptyRoot);
    const lateView = decodePublicView(
      (await callReserve(session, encodePublicView(draw), { staticCall: true })).returnValue,
    );
    assert.equal(lateView.totalLockedNanos, 0);
  });
});

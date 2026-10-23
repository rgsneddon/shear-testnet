import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity, spendDestOf, hash20FromAddress } from '../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
} from '../../crypto/asert.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { txDigestV3 } from '../../crypto/admit_v3.js';
import { pointBytes, pointFrom, proveRange } from '../../crypto/note.js';
import {
  GENESIS_BPS,
  ORACLE_QUORUM,
  bundledEpochBps,
  interestNanos,
  observeVerdict,
} from '../../crypto/reserve_oracle.js';
import {
  emptyVault,
  cloneVault,
  deposit,
  withdraw,
  portalEpochInterest,
  lockTx,
  lockWitnessOf,
  attachLockEquality,
  consensusUnlockPeriod,
  withdrawTx,
  verifyReservePayout,
  supplyIdentity,
  creditFeeBank,
  payoutStakeReward,
  portalIdFromDest,
  applyReserveBlock,
  appendVaultLockNote,
  chainPeriodIndex,
  hiddenWithdrawOpening,
  leafEpochsToBurn,
  leafStubNanos,
  lockUnlockOf,
  provePrincipalOpen,
} from '../../crypto/reserve_vault.js';
import { proveLeafRetire, subtractUnlock, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { randomScalar } from '../../crypto/note.js';
import { extraMintAllowed } from '../../crypto/asert.js';
import { reserveFeeDest } from '../../crypto/levy.js';
import { publicReserveReceipt } from '../../crypto/dummy.js';
import {
  signSpendTx,
  boundReserveWithdraw,
  verifyReservePortalOpen,
  reserveAuth,
} from '../../crypto/spend.js';
import { GENESIS_PREV, buildTemplate, verifyBlock, digestTx } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { adminWalletBalance } from '../../pool/src/operator_wallet.js';
import {
  bootReserveEvm,
  callReserve,
  encodeDeposit,
  encodeVote,
  encodeEnact,
  encodeWithdraw,
  encodeObserveRate,
  encodePublicView,
  decodePublicView,
  SYSTEM,
  createAddressFromString,
} from '../../crypto/reserve_evm.js';
import { ownerFor } from '../../crypto/owned_portal.js';

const T0 = 1_700_000_000_000;
const END = T0 + RESERVE_EPOCH_MS;
const DAY = 86_400_000;
const PRINCIPALS = [PI_SHE_NANOS, PI_SHE_NANOS + 1, PI_SHE_NANOS * 10, 2 ** 40];
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
// arrivalStubOf, noteBlockHeight, and stepBonus are the v12 selectors.
const ABI_NAMES = [
  'CUTOFF_MS', 'DAY_MS', 'EPOCH_DAYS', 'EPOCH_DAYS_MAINNET', 'EPOCH_DAYS_TESTNET',
  'EPOCH_MS', 'GENESIS_BONUS', 'GENESIS_BPS', 'JOIN_CUTOFF_DAYS', 'ORACLE_MAX_AGE_MS',
  'PI_NANOS', 'PROGRAM_ID', 'REWARD_DENOM_DAYS', 'SHEAR_MAINNET', 'SHEAR_TESTNET',
  'SHEAR_TESTNET_V1', 'SHEAR_TESTNET_V10', 'SHEAR_TESTNET_V11', 'SHEAR_TESTNET_V12',
  'SHEAR_TESTNET_V3', 'SHEAR_TESTNET_V4', 'SHEAR_TESTNET_V5', 'SHEAR_TESTNET_V6',
  'SHEAR_TESTNET_V7', 'SHEAR_TESTNET_V8', 'SHEAR_TESTNET_V9', 'STAKE_CUTOFF_QUARTER_DEN', 'annualBps', 'arrivalStubOf',
  'bonusEnacted', 'canJoin', 'castVote', 'claim', 'clearWithdrawHolds', 'commitEpochCensus', 'commitEpochStartRoot', 'commitRate', 'commitRewards', 'commitVaultRoot', 'currentEpoch', 'cutoffLengthMs', 'enact', 'enactedAtEpoch',
  'enactedAtMs', 'enactedDelta', 'enactedDown', 'enactedHold', 'enactedLiveBonus', 'enactedUp',
  'epochBps', 'epochDaysOf', 'epochLengthMs', 'epochOpen', 'epochRateOf', 'epochStart', 'holdEpochRoll', 'holdWithdraw', 'liveHashBonusNanos',
  'lock', 'lockNote', 'magic', 'nextEpochBps', 'noteBlockHeight', 'observeRate', 'oracleAsOfMs', 'piProofWord', 'pinClock', 'portalId', 'portalOf',
  'publicView', 'rateCommitEpoch', 'remainingDays', 'remainingMs', 'retire', 'rewardNanos', 'roll', 'stepBonus', 'syncEpoch', 'tallyBallot', 'totalLocked', 'trimmedMeanBps', 'vote', 'votesDecrease',
  'votesHold', 'votesIncrease', 'withdraw', 'withdrawRetire',
];

function owner() {
  const id = newIdentity();
  return { id, dest: spendDestOf(id.spendPub), pub: Buffer.from(id.spendPub).toString('hex') };
}

function notedOwnerLock(who, id, ownerPub = who.pub) {
  const tx = lockTx({
    from: who.dest,
    to: who.dest,
    nanos: PI_SHE_NANOS,
    id,
    ownerPub,
  });
  tx.ownerPub = ownerPub;
  const held = lockWitnessOf(tx);
  const leaf = vaultLockNote(held.amount, randomScalar(), held.blind, consensusUnlockPeriod(0));
  assert.ok(leaf, id);
  tx.vaultLockNote = leaf.note;
  assert.equal(attachLockEquality(tx), true, id);
  return tx;
}

function openPortal(principal, when = T0, { payout = null } = {}) {
  const who = owner();
  const state = emptyVault();
  state.genesisMs = T0;
  const got = deposit({
    state,
    dest: who.dest,
    nanos: principal,
    nowMs: when,
    payout: payout || undefined,
    ownerPub: who.pub,
  });
  assert.equal(got.ok, true, got.reason);
  return { who, state };
}

function signedWithdraw(who, state, dest, nanos) {
  const tx = withdrawTx({
    from: who.dest,
    to: dest,
    nanos,
    id: `w-${nanos}-${String(dest).slice(-6)}`,
  });
  return signSpendTx(tx, who.id.privateKey);
}

/** The opened lock integer, with the principal proof bound to this tx. */
function provedWithdraw(who, state, dest, when, id) {
  const peek = hiddenWithdrawOpening(state, who.dest, when);
  assert.ok(peek, id);
  const tx = withdrawTx({ from: who.dest, to: dest, nanos: peek.nanos, id });
  const open = hiddenWithdrawOpening(state, who.dest, when, tx);
  assert.ok(open?.proof, id);
  tx.principalProof = open.proof;
  signSpendTx(tx, who.id.privateKey);
  return { tx, open };
}

function payOpened(source, target, who, when, id, payout = undefined) {
  const opened = provedWithdraw(who, source, payout || who.dest, when, id);
  const paid = withdraw({
    state: target,
    dest: who.dest,
    nowMs: when,
    payout,
    principal: opened.open.nanos,
    principalProof: opened.open.proof,
    tx: opened.tx,
  });
  return { paid, opened };
}

/**
 * One indexed π leaf. A helper deposit leaves an unindexed hidden tranche,
 * and withdraw() refuses that as stake_reward. The owner still receives π.
 * The receipt on the tx is π plus this leaf's arrival stub.
 */
function plantIndexedPi(state, who, nowMs, { payout = who.dest, lockHeight = 1 } = {}) {
  const magic = state.magic || MAGIC_TESTNET;
  const stamp = lockUnlockOf({ genesisMs: state.genesisMs, magic }, nowMs);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const scalar = randomScalar();
  const blind = randomScalar();
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
  assert.ok(leaf);
  const ranged = pointBytes(subtractUnlock(pointFrom(leaf.commit), unlock));
  const got = deposit({
    state,
    dest: who.dest,
    nanos: PI_SHE_NANOS,
    nowMs,
    ownerPub: who.pub,
    payout,
    commit: leaf.commit,
    rangeProof: proveRange(BigInt(PI_SHE_NANOS), blind),
    unlock,
    rangeCommit: ranged,
    piProof: proveRange(0n, blind),
  });
  assert.equal(got.ok, true, got.reason);
  const rooted = appendVaultLockNote(state, leaf.note, {
    earnEpoch: Math.floor(Number(stamp.epoch) || 0),
    bornEpoch: chainPeriodIndex(state, nowMs),
    unlockEpoch: unlock,
    lockHeight,
  });
  assert.ok(rooted);
  return { leaf, unlock };
}

function indexedWithdraw(state, who, when, id, payout, planted) {
  const commitHex = planted.leaf.commit.toString('hex');
  const stub = leafStubNanos(state, [commitHex]);
  const nanos = PI_SHE_NANOS + Number(stub);
  const tx = withdrawTx({ from: who.dest, to: payout, nanos, id });
  const portalId = portalIdFromDest(who.dest);
  const magic = state.magic || MAGIC_TESTNET;
  const proof = provePrincipalOpen(
    planted.leaf.commit, PI_SHE_NANOS, planted.leaf.blind, tx, portalId, magic, planted.leaf.unlock,
  );
  assert.ok(proof, id);
  tx.principalProof = proof;
  const period = chainPeriodIndex(state, when);
  const retire = proveLeafRetire({
    scalar: planted.leaf.scalar,
    epochs: leafEpochsToBurn(state, planted.leaf.note.toString('hex'), period),
    leaf: planted.leaf.note,
    txBind: txDigestV3(tx, magic),
    unlockEpoch: period,
    magic,
  });
  assert.ok(retire?.proof, id);
  tx.retireProof = retire.proof;
  signSpendTx(tx, who.id.privateKey);
  const paid = withdraw({
    state,
    dest: who.dest,
    nowMs: when,
    payout,
    principal: nanos,
    principalProof: proof,
    retireProof: tx.retireProof,
    tx,
  });
  return { paid, tx, nanos, stub: Number(stub) };
}

describe('Vault Security test map', () => {
  it('P1-a a bound payout portal cannot be redirected', () => {
    for (const principal of PRINCIPALS) {
      const payTo = owner();
      const { who, state } = openPortal(principal, T0, { payout: payTo.dest });
      const home = provedWithdraw(who, state, payTo.dest, END, `home-${principal}`).tx;
      const foreign = signedWithdraw(who, state, spendDestOf(newIdentity().spendPub), 0);
      const published = signedWithdraw(who, state, payTo.dest, principal);
      assert.equal(verifyReservePayout(state, foreign, END).reason, 'payout_mismatch');
      assert.equal(boundReserveWithdraw(foreign, state, null, END).reason, 'payout_mismatch');
      assert.equal(boundReserveWithdraw(published, state, null, END).reason, 'stake_reward');
      assert.equal(verifyReservePayout(state, home, END).ok, true, verifyReservePayout(state, home, END).reason);
    }
  });

  it('P1-b the lock stays under the owner key', () => {
    const who = owner();
    const sealed = notedOwnerLock(who, 'lock-pi');
    const out = sealed.vout[0];
    const want20 = Buffer.from(hash20FromAddress(who.dest)).toString('hex');
    assert.equal(Buffer.from(out.dest20).toString('hex'), want20);
    const state = emptyVault();
    state.genesisMs = T0;
    const applied = applyReserveBlock({
      state,
      block: {
        height: 1,
        txs: [
          { coinbase: true, vout: [] },
          sealed,
        ],
      },
      nowMs: T0,
      height: 1,
      genesisMs: T0,
    });
    assert.equal(applied.ok, true, applied.reason);
    const portal = state.portals[sealed.portalId];
    assert.equal(Number(portal.staked) + Number(portal.idle), 0);
    assert.equal(portal.tranches[0].amount, undefined);
    assert.equal(String(portal.tranches[0].commit).length, 64);
    assert.equal(portal.qualified, true);
    const again = notedOwnerLock(who, 'lock-pi-2');
    const second = applyReserveBlock({
      state,
      block: { height: 2, txs: [again] },
      nowMs: T0 + 1,
      height: 2,
      genesisMs: T0,
    });
    // One portal per lock. A second lock of the same portal id is a duplicate.
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'portal_exists');
    const stranger = owner();
    const foreign = notedOwnerLock(who, 'lock-stranger', stranger.pub);
    const denied = applyReserveBlock({
      state,
      block: { height: 3, txs: [foreign] },
      nowMs: T0 + 2,
      height: 3,
      genesisMs: T0,
    });
    assert.equal(denied.reason, 'unsigned');
    assert.equal(state.portals[portalIdFromDest(who.dest)].ownerPub, who.pub);
    for (const principal of [PI_SHE_NANOS * 3, PI_SHE_NANOS * 100]) {
      const wide = lockTx({
        from: who.dest,
        to: who.dest,
        nanos: principal,
        id: `lock-wide-${principal}`,
        ownerPub: who.pub,
      });
      assert.ok(wide.vout.filter((row) => row.kind === 'lock').length > 1);
      const refused = applyReserveBlock({
        state,
        block: { height: 4, txs: [wide] },
        nowMs: T0 + 3,
        height: 4,
        genesisMs: T0,
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'stake_reward');
      assert.equal(state.portals[portalIdFromDest(who.dest)].ownerPub, who.pub);
    }
  });

  it('P1-c reward lands in the owner wallet', () => {
    const splits = ['staked', 'idle', 'half', 'rho'];
    for (const split of splits) {
      for (const bps of [0, 1, 284, 10000]) {
        const who = owner();
        const state = emptyVault();
        state.genesisMs = T0;
        // Indexed π leaf. The helper deposit is an unindexed tranche and withdraws as stake_reward.
        const planted = plantIndexedPi(state, who, T0, { payout: who.dest });
        if (split === 'idle') {
          const bob = owner();
          deposit({
            state, dest: bob.dest, nanos: PI_SHE_NANOS, nowMs: END - 1, payout: bob.dest, ownerPub: bob.pub,
          });
        } else if (split === 'half') {
          deposit({ state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: END - 1, ownerPub: who.pub });
        } else if (split === 'rho') {
          deposit({ state, dest: who.dest, nanos: 1, nowMs: END - 1, ownerPub: who.pub });
        }
        state.epochBps = bps;
        const portal = state.portals[portalIdFromDest(who.dest)];
        const active = Number(portal.staked);
        const idle = Number(portal.idle);
        const reward = portalEpochInterest(state, portal, END);
        const { paid: done, tx: exact } = indexedWithdraw(
          cloneVault(state), who, END, `p1c-${split}-${bps}`, who.dest, planted,
        );
        assert.equal(done.ok, true, `${split} ${bps} ${done.reason}`);
        assert.equal(active + idle, 0);
        assert.equal(reward, 0);
        assert.equal(done.payout, PI_SHE_NANOS);
        assert.equal(done.to, who.dest);
        assert.equal(done.reward, 0);
        assert.equal(done.earned, 0);
        assert.equal(verifyReservePayout(state, exact, END).ok, true, verifyReservePayout(state, exact, END).reason);
        const wrong = signedWithdraw(who, state, spendDestOf(newIdentity().spendPub), 0);
        assert.equal(verifyReservePayout(state, wrong, END).reason, 'payout_mismatch');
        const fat = signedWithdraw(who, state, who.dest, 1);
        // No leaf proofs. An indexed withdraw that does not open the leaf is mint_amount.
        assert.equal(boundReserveWithdraw(fat, state, null, END).reason, 'mint_amount');
      }
    }
  });

  it('P1-d unsigned or foreign-key withdraw, and the owner key verifies', () => {
    const pool = owner();
    for (const principal of PRINCIPALS) {
      const { who, state } = openPortal(principal, T0, { payout: null });
      const good = signedWithdraw(who, state, who.dest, 0);
      const none = { ...good, spendPub: undefined, sig: undefined };
      const random = signSpendTx({ ...good, sig: undefined, spendPub: undefined, id: `r-${principal}` }, newIdentity().privateKey);
      const poolSigned = signSpendTx({ ...good, sig: undefined, spendPub: undefined, id: `p-${principal}` }, pool.id.privateKey);
      assert.equal(verifyReservePortalOpen(none), false);
      assert.equal(reserveAuth(none, state).reason, 'unsigned');
      for (const tx of [random, poolSigned]) {
        assert.equal(verifyReservePortalOpen(tx), false);
        assert.equal(reserveAuth(tx, state).reason, 'unsigned');
      }
      assert.equal(verifyReservePortalOpen(good), true);
      assert.equal(reserveAuth(good, state).ok, true, reserveAuth(good, state).reason);
      assert.equal(boundReserveWithdraw(good, state, null, END).ok, true, boundReserveWithdraw(good, state, null, END).reason);
    }
  });

  it('P1-e a sealed withdraw is not a public receipt', () => {
    for (const principal of PRINCIPALS) {
      const { who, state } = openPortal(principal);
      const tx = signedWithdraw(who, state, who.dest, principal);
      delete tx.spendPub;
      delete tx.sig;
      assert.equal(publicReserveReceipt(tx), false);
      assert.equal(verifyReservePortalOpen(tx), false);
      assert.equal(reserveAuth(tx, state).reason, 'unsigned');
    }
  });

  it('P2-a and P2-b epoch release follows header time, not a caller clock', () => {
    const early = [T0, T0 + 1, END - 1, END - DAY];
    const walls = [0, 30 * DAY, 2 * RESERVE_EPOCH_MS];
    const { who, state } = openPortal(PI_SHE_NANOS);
    const tx = provedWithdraw(who, state, who.dest, END, 'header-clock').tx;
    const realNow = Date.now;
    try {
      for (const stamp of early) {
        for (const ahead of walls) {
          Date.now = () => stamp + ahead;
          tx.nowMs = END + ahead;
          const got = verifyReservePayout(state, tx, stamp);
          assert.equal(got.reason, 'epoch_open', `${stamp} wall+${ahead} ${got.reason}`);
          const drawn = withdraw({ state: cloneVault(state), dest: who.dest, nowMs: stamp });
          assert.equal(drawn.reason, 'epoch_open', `${stamp} ${drawn.reason}`);
        }
      }
      Date.now = () => END + 2 * RESERVE_EPOCH_MS;
      tx.nowMs = END + 9 * DAY;
      assert.equal(verifyReservePayout(state, tx, END).ok, true);
      // The funded receipt is an indexed leaf. The unindexed helper above stays epoch_open early.
      const fundedWho = owner();
      const funded = emptyVault();
      funded.genesisMs = T0;
      const planted = plantIndexedPi(funded, fundedWho, T0, { payout: fundedWho.dest });
      const drawnAtEnd = indexedWithdraw(funded, fundedWho, END, 'header-draw', fundedWho.dest, planted);
      assert.equal(drawnAtEnd.paid.ok, true, drawnAtEnd.paid.reason);
    } finally {
      Date.now = realNow;
    }
  });

  it('P2-c a withdraw is not repeatable across the epoch or a reorg', () => {
    const who = owner();
    const state = emptyVault();
    state.genesisMs = T0;
    const planted = plantIndexedPi(state, who, T0, { payout: who.dest });
    const first = indexedWithdraw(state, who, END, 'once', who.dest, planted).paid;
    assert.equal(first.ok, true, first.reason);
    assert.equal(withdraw({ state, dest: who.dest, nowMs: END + 1 }).reason, 'double_mint');
    assert.equal(withdraw({ state, dest: who.dest, nowMs: END + DAY }).reason, 'double_mint');
    state.currentEpoch = Number(state.currentEpoch || 1) + 1;
    state.epochStartMs = END;
    state.bonusEnacted = false;
    assert.equal(withdraw({ state, dest: who.dest, nowMs: END + RESERVE_EPOCH_MS }).reason, 'empty');

    const freshWho = owner();
    const freshState = emptyVault();
    freshState.genesisMs = T0;
    const freshPlanted = plantIndexedPi(freshState, freshWho, T0, { payout: freshWho.dest });
    const snap = cloneVault(freshState);
    const sealedOpen = indexedWithdraw(freshState, freshWho, END, 'reorg-seal', freshWho.dest, freshPlanted);
    const sealed = sealedOpen.paid;
    assert.equal(sealed.ok, true, sealed.reason);
    const minted = Number(freshState.mintBankNanos);
    const restored = cloneVault(snap);
    const readded = withdraw({
      state: restored,
      dest: freshWho.dest,
      nowMs: END,
      payout: freshWho.dest,
      principal: sealedOpen.nanos,
      principalProof: sealedOpen.tx.principalProof,
      retireProof: sealedOpen.tx.retireProof,
      tx: sealedOpen.tx,
    });
    assert.equal(readded.ok, true, readded.reason);
    assert.equal(Number(restored.mintBankNanos), minted);
    assert.equal(supplyIdentity(restored).mintedReward, minted);
    assert.equal(withdraw({ state: restored, dest: freshWho.dest, nowMs: END + 1 }).reason, 'double_mint');
  });

  it('P2-d a withdraw before the epoch end is locked', () => {
    const times = [T0, T0 + 1, END - 1, END - DAY];
    for (const stamp of times) {
      const { who, state } = openPortal(PI_SHE_NANOS);
      const tx = provedWithdraw(who, state, who.dest, END, `locked-${stamp}`).tx;
      assert.equal(verifyReservePayout(state, tx, stamp).reason, 'epoch_open');
      tx.nowMs = END + 10 * DAY;
      assert.equal(verifyReservePayout(state, tx, stamp).reason, 'epoch_open');
      assert.equal(verifyReservePayout(state, tx, END).ok, true, verifyReservePayout(state, tx, END).reason);
    }
  });

  it('P3-a transaction fees are not a vault balance or a reward', () => {
    const dirty = emptyVault();
    dirty.feeBankNanos = 1n;
    assert.equal(supplyIdentity(dirty).reason, 'supply');
    for (const n of [1, 3, 17]) {
      const state = emptyVault();
      state.genesisMs = T0;
      const people = [];
      for (let i = 0; i < n; i += 1) {
        const who = owner();
        people.push(who);
        // Indexed π. The fee bank is not this leaf's arrival stub.
        who.planted = plantIndexedPi(state, who, T0 + i, { payout: who.dest });
      }
      const dues = people.map((who) => portalEpochInterest(
        state,
        state.portals[portalIdFromDest(who.dest)],
        END,
      ));
      const reward = dues[0];
      for (const bank of [0, Math.max(0, reward - 1), reward, reward + 1, reward * 10]) {
        const trial = cloneVault(state);
        trial.feeBankNanos = BigInt(bank);
        assert.equal(creditFeeBank(trial, bank), 0);
        applyReserveBlock({
          state: trial,
          block: { txs: [{ coinbase: true, vout: [{ kind: 'reserve-fee', nanos: bank }, { kind: 'finder-fee', nanos: bank }] }] },
          nowMs: T0 + 10,
        });
        assert.equal(Number(trial.feeBankNanos), 0);
        let mintedSum = 0;
        for (let i = 0; i < people.length; i += 1) {
          const paid = indexedWithdraw(
            trial, people[i], END, `fee-${n}-${bank}-${i}`, people[i].dest, people[i].planted,
          ).paid;
          assert.equal(paid.ok, true, `${n} ${bank} ${paid.reason}`);
          assert.equal(paid.reward, 0);
          assert.equal(paid.earned, dues[i]);
          assert.equal(paid.rewardSource, undefined);
          // Stake interest stays 0. The mint is the arrival stub, not the fee bank.
          mintedSum += Number(paid.arrival);
        }
        assert.equal(Number(trial.feeBankNanos), 0);
        const idn = supplyIdentity(trial);
        assert.equal(idn.mintedReward, mintedSum);
        assert.equal(idn.ok, false, idn.reason);
        assert.equal(idn.reason, 'supply');
        assert.equal(idn.feeBankRewardNanos, 0);
        assert.equal(idn.mintedReward, mintedSum);
        const probe = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
        const minted = payoutStakeReward({ state: emptyVault(), reward: probe, id: `fee-${n}-${bank}` });
        assert.equal(minted.fromFee, 0);
        assert.equal(minted.minted, probe);
        assert.equal(minted.source, 'coinbase');
        assert.equal(minted.feeBank, 0);
      }
    }
  });

  it('P3-b supply identity holds across epochs and a boundary reorg', () => {
    const oddWho = owner();
    const odd = emptyVault();
    odd.genesisMs = T0;
    assert.equal(deposit({
      state: odd, dest: oddWho.dest, nanos: PI_SHE_NANOS + 1, nowMs: T0, ownerPub: oddWho.pub,
    }).ok, true);
    const refused = withdraw({ state: odd, dest: oddWho.dest, nowMs: END, principal: PI_SHE_NANOS + 1 });
    // A non-π hidden tranche is not an indexed leaf, so it does not mint.
    assert.equal(refused.reason, 'stake_reward');
    assert.equal(supplyIdentity(odd).mintedReward, 0);
    const rand = (() => {
      let a = 0x5EED;
      return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    for (const epochs of [1, 5, 40]) {
      const state = emptyVault();
      state.genesisMs = T0;
      let expected = 0;
      let cursor = T0;
      for (let e = 0; e < epochs; e += 1) {
        const people = 1 + Math.floor(rand() * 3);
        const locked = [];
        for (let i = 0; i < people; i += 1) {
          const who = owner();
          const at = cursor + Math.floor(rand() * DAY);
          // Indexed π. Stake interest stays 0. The mint tracked below is the arrival stub.
          who.planted = plantIndexedPi(state, who, at, { payout: who.dest });
          locked.push(who);
        }
        const end = state.epochStartMs + RESERVE_EPOCH_MS;
        if (e === epochs - 1 && epochs > 1) {
          const snap = cloneVault(state);
          const openings = [];
          for (let i = 0; i < locked.length; i += 1) {
            const who = locked[i];
            const drawn = indexedWithdraw(state, who, end, `id-${e}-${i}`, who.dest, who.planted);
            assert.equal(drawn.paid.ok, true, drawn.paid.reason);
            assert.equal(drawn.paid.interest, 0);
            openings.push(drawn);
          }
          const reorg = cloneVault(snap);
          let reorgMint = Number(snap.mintBankNanos);
          for (const drawn of openings) {
            const paid = withdraw({
              state: reorg,
              dest: drawn.tx.from,
              nowMs: end,
              payout: drawn.tx.to,
              principal: drawn.nanos,
              principalProof: drawn.tx.principalProof,
              retireProof: drawn.tx.retireProof,
              tx: drawn.tx,
            });
            assert.equal(paid.ok, true, paid.reason);
            reorgMint += Number(paid.arrival);
          }
          assert.equal(Number(reorg.mintBankNanos), reorgMint);
          assert.equal(supplyIdentity(reorg).mintedReward, reorgMint);
          Object.assign(state, reorg);
          expected = reorgMint;
        } else {
          for (let i = 0; i < locked.length; i += 1) {
            const who = locked[i];
            const when = end + Math.floor(rand() * 1000);
            const paid = indexedWithdraw(state, who, when, `id-${e}-${i}-${when}`, who.dest, who.planted).paid;
            assert.equal(paid.ok, true, paid.reason);
            assert.equal(paid.interest, 0);
            expected += Number(paid.arrival);
          }
          if (e + 1 < epochs) {
            const nxt = owner();
            assert.equal(deposit({
              state, dest: nxt.dest, nanos: PI_SHE_NANOS, nowMs: end + 1, ownerPub: nxt.pub,
            }).ok, true);
            cursor = end + 1;
          }
        }
        const idn = supplyIdentity(state);
        assert.equal(idn.mintedReward, expected);
        assert.equal(idn.ok, false, JSON.stringify(idn));
        assert.equal(idn.reason, 'supply');
      }
      const ceiling = supplyIdentity(state).permittedReward;
      const broken = cloneVault(state);
      broken.mintBankNanos = BigInt(ceiling + 1);
      const bad = supplyIdentity(broken);
      assert.equal(bad.ok, false);
      assert.equal(bad.reason, 'supply');
      assert.ok(bad.mintedReward > bad.permittedReward);
    }
  });

  it('P3-c a foreign reserve output is mint_forbidden', () => {
    const amounts = [1, PI_SHE_NANOS, 2 ** 40];
    const kinds = ['reserve', 'reserve-interest', 'reserve-shortfall', 'reserve-reward'];
    for (const kind of kinds) {
      for (const nanos of amounts) {
        assert.equal(extraMintAllowed('not-reserve', { kind }), false);
        const { who, state } = openPortal(Math.max(nanos, PI_SHE_NANOS));
        const tx = signedWithdraw(who, state, who.dest, Math.max(nanos, PI_SHE_NANOS));
        tx.programId = 'not-reserve';
        tx.kind = kind === 'reserve-reward' ? 'withdraw' : kind;
        tx.mint = true;
        if (kind === 'reserve-reward') {
          assert.equal(boundReserveWithdraw(tx, state, null, END).reason, 'mint_forbidden');
        }
      }
    }
    assert.equal(RESERVE_PROGRAM, 'shear-reserve-v1');
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'reserve-reward' }), true);
  });

  it('P4-a and P4-c a miner or pool observe does not move the rate', async () => {
    const ages = [T0, T0 - 13 * DAY, T0 - 15 * DAY];
    const rates = [0, 1, GENESIS_BPS - 100, GENESIS_BPS + 100, 9999, 10000];
    const state = emptyVault();
    deposit({ state, dest: owner().dest, nanos: PI_SHE_NANOS, nowMs: T0 });
    const prior = state.epochBps;
    for (const k of [1, 5, 13]) {
      for (const bps of rates) {
        for (const observedAtMs of ages) {
          const observe = { annualBps: bps, observedAtMs, producer: 'miner-1' };
          assert.equal(observeVerdict(observe).reason, 'observe_unattested');
          const tpl = buildTemplate({
            prev: GENESIS_PREV,
            height: 1,
            miner: spendDestOf(newIdentity().spendPub),
            bits: GENESIS_BITS_PACKED,
            now: T0,
            txs: [],
          });
          const decoded = decodeHeader(Buffer.from(tpl.header));
          const cb = { ...tpl.txs[0], observe };
          const header = encodeHeader({
            version: decoded.version,
            prevBlockHash: decoded.prevBlockHash,
            merkleRoot: merkleRoot([digestTx(cb)]),
            continuityRoot: decoded.continuityRoot,
            timestamp: decoded.timestamp,
            bits: decoded.bits,
            nonce: 0n,
            baseFee: decoded.baseFee,
          });
          const got = await verifyBlock({
            header,
            txs: [cb],
            samples: tpl.samples,
            shareBatch: tpl.shareBatch || [],
            miner: tpl.miner,
            height: 1,
          }, null, { probeBody: true });
          assert.equal(got.reason, 'observe_unattested', `${k} ${bps} ${observedAtMs} ${got.reason}`);
          assert.equal(state.epochBps, prior);
          assert.ok(k < ORACLE_QUORUM);
        }
      }
    }
    assert.equal(bundledEpochBps(), GENESIS_BPS);
  });

  it('P4-b an operator snapshot cannot reach consensus', () => {
    const rates = [0, 1, 164, 364, 9999, 10000];
    const nodes = rates.slice(0, 3).map((bps, i) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-snap-${i}-`));
      fs.writeFileSync(path.join(dir, 'oracle-snapshot.json'), JSON.stringify({
        averagePercent: bps / 100,
        observedAt: '2026-08-01T00:00:00Z',
        annualBps: bps,
      }));
      fs.writeFileSync(path.join(dir, 'reserve.json'), JSON.stringify({
        epochBps: bps,
        oracle: { annualBps: bps },
        portals: {},
      }));
      return createStore(dir);
    });
    const bps = nodes.map((s) => s.reserveVault.epochBps);
    assert.equal(bps[0], GENESIS_BPS);
    assert.equal(bps[1], bps[0]);
    assert.equal(bps[2], bps[0]);
    for (const store of nodes) {
      const who = owner();
      const { tpl } = store.template({ miner: who.dest, now: T0 });
      assert.equal(tpl.txs[0].observe, undefined);
      assert.equal(tpl.txs[0].rateCommit, undefined);
      store.reserveVault.genesisMs = T0;
      const planted = plantIndexedPi(store.reserveVault, who, T0, { payout: who.dest });
      const paid = indexedWithdraw(
        store.reserveVault, who, END, `snap-${store.reserveVault.epochBps}`, who.dest, planted,
      ).paid;
      assert.equal(paid.ok, true, paid.reason);
      assert.equal(paid.reward, 0);
      assert.equal(paid.earned, 0);
      assert.ok(interestNanos(PI_SHE_NANOS, GENESIS_BPS) > 0);
    }
  });

  it('P5-a Reserve bytecode has no admin', () => {
    const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/Reserve.json'), 'utf8'));
    const names = pin.abi.filter((row) => row.type === 'function').map((row) => row.name);
    assert.deepEqual(names, ABI_NAMES);
    for (const banned of ['onlyOwner', 'owner', 'pause', 'upgradeTo', 'upgradeToAndCall', 'MAX_BPS']) {
      assert.equal(names.includes(banned), false, banned);
    }
    const code = Buffer.from(String(pin.bytecode).replace(/^0x/i, ''), 'hex');
    const ipfs = Buffer.from('a2646970667358', 'hex');
    let end = code.length;
    const at = code.lastIndexOf(ipfs);
    if (at > 0) end = at;
    const found = new Set();
    for (let i = 0; i < end; i += 1) {
      const op = code[i];
      if (op >= 0x60 && op <= 0x7f) {
        i += op - 0x5f;
        continue;
      }
      if (op === 0xff) found.add('SELFDESTRUCT');
      if (op === 0xf4) found.add('DELEGATECALL');
      if (op === 0xf2) found.add('CALLCODE');
    }
    assert.equal(found.size, 0, [...found].join(','));
    const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/reserve-pin.yml'), 'utf8');
    assert.match(yml, /test_vault_security_map\.js/);
  });

  it('P5-b msg.sender does not change Reserve', async () => {
    const callers = [
      createAddressFromString(`0x${'00'.repeat(20)}`),
      createAddressFromString(`0x${'ab'.repeat(20)}`),
      SYSTEM,
    ];
    const views = [];
    const results = [];
    for (const caller of callers) {
      const s = await bootReserveEvm();
      const lockDest = 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
      const lockOwner = ownerFor(lockDest);
      const lock = await callReserve(s, encodeDeposit(lockDest, Buffer.alloc(32, 9), T0, { key: lockOwner.key }), { caller });
      const vote = await callReserve(s, encodeVote('ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 1, T0 + 2), { caller });
      const observe = await callReserve(s, encodeObserveRate(9999, Math.floor(T0 / 1000)), { caller, staticCall: true });
      const enacted = await callReserve(s, encodeEnact(END), { caller });
      const drawn = await callReserve(s, encodeWithdraw('ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', END), { caller });
      const view = decodePublicView((await callReserve(s, encodePublicView(END), { staticCall: true, caller })).returnValue);
      results.push([lock.ok, vote.ok, observe.ok, enacted.ok, drawn.ok]);
      views.push([view.oracleBps, view.liveHashBonusNanos, view.totalLockedNanos, view.currentEpoch]);
    }
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
    assert.equal(results[0][2], false);
    assert.deepEqual(views[1], views[0]);
    assert.deepEqual(views[2], views[0]);
  });

  it('P5-c no foreign key can move a lock, and admin-spendable ignores it', () => {
    const keys = [owner(), owner(), owner()];
    for (const principal of PRINCIPALS) {
      const { who, state } = openPortal(principal);
      for (const key of keys) {
        const tx = withdrawTx({ from: who.dest, to: who.dest, nanos: principal, id: `fk-${principal}-${key.dest.slice(-4)}` });
        signSpendTx(tx, key.id.privateKey);
        assert.equal(verifyReservePortalOpen(tx), false);
        assert.equal(reserveAuth(tx, state).reason, 'unsigned');
      }
      const missing = withdrawTx({ from: who.dest, to: reserveFeeDest(), nanos: principal, id: `miss-${principal}` });
      assert.equal(verifyReservePortalOpen(missing), false);
    }
    const src = fs.readFileSync(path.join(ROOT, 'pool/src/operator_wallet.js'), 'utf8');
    const slice = src.slice(src.indexOf('function adminWalletBalance'), src.indexOf('function adminSpendFrom'));
    assert.equal(/totalLocked|mintBank|reserveVault/.test(slice), false);
    const store = { historyFor: () => [], tip: () => null };
    const bal = adminWalletBalance(store, spendDestOf(newIdentity().spendPub), null);
    assert.equal(bal.spendableNanos, 0);
  });

  it('P5-d no env or pause flag halts a withdraw', () => {
    const src = fs.readFileSync(path.join(ROOT, 'node/src/store.js'), 'utf8');
    assert.equal(/pause\.reserveInterest/.test(src), false);
    assert.equal(/SHEAR_[A-Z0-9_]*(DISABLE|PAUSE|HALT).*RESERVE|RESERVE_.*DISABLE/.test(src), false);
    const flags = {
      SHEAR_ORACLE_BPS: '9999',
      SHEAR_MAINNET_EMIT: '1',
      SHEAR_NETWORK: 'shear-testnet-v12',
      SHEAR_FAST_SYNC: '1',
    };
    const prev = {};
    for (const [k, v] of Object.entries(flags)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const who = owner();
      const state = emptyVault();
      state.genesisMs = T0;
      const planted = plantIndexedPi(state, who, T0, { payout: who.dest });
      const paid = indexedWithdraw(state, who, END, 'no-pause', who.dest, planted).paid;
      assert.equal(paid.ok, true, paid.reason);
      assert.equal(paid.reward, 0);
      assert.equal(paid.earned, 0);
      assert.ok(interestNanos(PI_SHE_NANOS, GENESIS_BPS) > 0);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

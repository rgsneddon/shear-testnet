import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { GENESIS_BPS, interestNanos } from './reserve_oracle.js';
import { STAKE_CUTOFF_QUARTER_DEN } from './pot_sched.js';
import { encodeDest, newIdentity, spendDestOf } from './address.js';
import { vaultDest } from './flow_sheet.js';
import { levyTaxed } from './levy.js';
import {
  applyReserveBlock,
  applyRewardClaim,
  cloneVault,
  deposit,
  enact,
  emptyVault,
  packRewardAuth,
  packRewardProof,
  portalEpochInterest,
  portalIdFromDest,
  previewWithdraw,
  rewardClaimProof,
  rewardClaimTx,
  rewardCommitment,
  rewardOwnerCommit,
  roll,
  rollTx,
  signRollReward,
  signWithdrawReward,
  supplyIdentity,
  withdraw,
  withdrawTx,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  decodeBytes32,
  decodePortal,
  decodePublicView,
  decodeWithdraw,
  encodeClaim,
  encodeCommitRewards,
  encodeDeposit,
  encodeEnact,
  encodePinClock,
  encodePortalOf,
  encodePublicView,
  encodeRoll,
  encodeWithdraw,
} from './reserve_evm.js';

const T0 = 1_700_000_000_000;
const epoch = RESERVE_EPOCH_MS;

function freshDest() {
  const id = newIdentity();
  return vaultDest(id.address, { viewKey: id.viewKey });
}

async function openLock(dest, when) {
  const state = emptyVault();
  state.genesisMs = T0;
  state.magic = MAGIC_TESTNET;
  const opened = deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: when });
  assert.equal(opened.ok, true, opened.reason);
  const session = await bootReserveEvm();
  assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
  assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, when))).ok, true);
  return { state, session };
}

function trancheOf(state, dest) {
  const portal = state.portals[portalIdFromDest(dest)];
  assert.ok(portal);
  return portal.tranches[portal.tranches.length - 1];
}

async function balances(session, dest, nowMs) {
  const portal = decodePortal((await callReserve(session, encodePortalOf(dest), { staticCall: true })).returnValue);
  const view = decodePublicView((await callReserve(session, encodePublicView(nowMs), { staticCall: true })).returnValue);
  return { portal, view };
}

describe('a finished tranche rolls once or sits idle', () => {
  it('roll is levy-taxed and a vote is not', () => {
    assert.equal(levyTaxed({ kind: 'roll' }), true);
    assert.equal(levyTaxed({ kind: 'vote' }), false);
  });

  it('roll pays the arrival reward once and JS matches the EVM', async () => {
    const dest = freshDest();
    const { state, session } = await openLock(dest, T0);
    const at = T0 + epoch;
    const want = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    assert.ok(want > 0);
    const rolled = roll({ state, dest, nowMs: at });
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(rolled.principal, PI_SHE_NANOS);
    assert.equal(rolled.interest, want);
    assert.equal(rolled.locked, PI_SHE_NANOS + want);
    assert.equal(Number(state.totalLockedNanos), PI_SHE_NANOS + want);
    const credit = trancheOf(state, dest);
    assert.equal(credit.epoch, 1);
    assert.equal(Number(credit.amount), PI_SHE_NANOS + want);
    assert.equal(credit.partialPaid, false);
    const idn = supplyIdentity(state);
    assert.equal(idn.ok, true, idn.reason);

    const evm = await callReserve(session, encodeRoll(dest, at));
    assert.equal(evm.ok, true, evm.reason);
    const decoded = decodeWithdraw(evm.returnValue);
    assert.equal(decoded.principal, rolled.principal);
    assert.equal(decoded.interest, rolled.interest);
    const after = await balances(session, dest, at);
    assert.equal(after.portal.staked + after.portal.idle, rolled.locked);
    assert.equal(after.view.totalLockedNanos, Number(state.totalLockedNanos));

    const again = roll({ state, dest, nowMs: at });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'epoch_open');
    const evmAgain = await callReserve(session, encodeRoll(dest, at));
    assert.equal(evmAgain.ok, false);
    const pulled = withdraw({ state, dest, nowMs: at });
    assert.equal(pulled.ok, false);
    assert.equal(pulled.reason, 'epoch_open');
    const evmPull = await callReserve(session, encodeWithdraw(dest, at));
    assert.equal(evmPull.ok, false);
  });

  it('withdraw then roll, and roll then withdraw, each fail', async () => {
    const end = T0 + epoch;
    const left = freshDest();
    const leftSide = await openLock(left, T0);
    const paid = withdraw({ state: leftSide.state, dest: left, nowMs: end });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.interest, interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    const afterPay = roll({ state: leftSide.state, dest: left, nowMs: end });
    assert.equal(afterPay.ok, false);
    assert.equal(afterPay.reason, 'empty');
    const evmPaid = await callReserve(leftSide.session, encodeWithdraw(left, end));
    assert.equal(evmPaid.ok, true, evmPaid.reason);
    assert.equal(decodeWithdraw(evmPaid.returnValue).interest, paid.interest);
    const evmRoll = await callReserve(leftSide.session, encodeRoll(left, end));
    assert.equal(evmRoll.ok, false);

    const right = freshDest();
    const rightSide = await openLock(right, T0);
    const rolled = roll({ state: rightSide.state, dest: right, nowMs: end });
    assert.equal(rolled.ok, true, rolled.reason);
    const then = withdraw({ state: rightSide.state, dest: right, nowMs: end });
    assert.equal(then.ok, false);
    assert.equal(then.reason, 'epoch_open');
    const evmFirst = await callReserve(rightSide.session, encodeRoll(right, end));
    assert.equal(evmFirst.ok, true, evmFirst.reason);
    const evmThen = await callReserve(rightSide.session, encodeWithdraw(right, end));
    assert.equal(evmThen.ok, false);
  });

  it('idle funds earn nothing more, stay locked, and can still roll later', async () => {
    const dest = freshDest();
    const { state, session } = await openLock(dest, T0);
    const end = T0 + epoch;
    const later = T0 + 2 * epoch;
    const muchLater = T0 + 5 * epoch;
    const one = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const idleBlock = applyReserveBlock({
      state,
      block: { height: 2, txs: [{ coinbase: true, vout: [] }] },
      nowMs: end,
      genesisMs: T0,
    });
    assert.equal(idleBlock.ok, true, idleBlock.reason);
    assert.equal(idleBlock.some((row) => row && row.action === 'roll'), false);
    const portal = state.portals[portalIdFromDest(dest)];
    assert.equal(portal.tranches.length, 1);
    assert.equal(portal.tranches[0].epoch, 0);
    assert.equal(Number(state.totalLockedNanos), PI_SHE_NANOS);
    assert.equal(portalEpochInterest(state, portal, later), one);
    assert.equal(portalEpochInterest(state, portal, muchLater), one);
    assert.notEqual(portalEpochInterest(state, portal, muchLater), one * 2);

    const rolled = roll({ state, dest, nowMs: muchLater });
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(rolled.principal, PI_SHE_NANOS);
    assert.equal(rolled.interest, one);
    assert.equal(rolled.locked, PI_SHE_NANOS + one);
    assert.equal(trancheOf(state, dest).epoch, 5);
    const idn = supplyIdentity(state);
    assert.equal(idn.ok, true, idn.reason);

    const evm = await callReserve(session, encodeRoll(dest, muchLater));
    assert.equal(evm.ok, true, evm.reason);
    const decoded = decodeWithdraw(evm.returnValue);
    assert.equal(decoded.principal, rolled.principal);
    assert.equal(decoded.interest, rolled.interest);
    const after = await balances(session, dest, muchLater);
    assert.equal(after.portal.staked + after.portal.idle, rolled.locked);
    assert.equal(after.view.totalLockedNanos, Number(state.totalLockedNanos));
  });

  it('a rolled sum earns the next epoch once, under the cutoff', async () => {
    const dest = freshDest();
    const { state, session } = await openLock(dest, T0);
    const at = T0 + epoch;
    const next = T0 + 2 * epoch;
    const first = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const rolled = roll({ state, dest, nowMs: at });
    assert.equal(rolled.ok, true, rolled.reason);
    const evmRoll = await callReserve(session, encodeRoll(dest, at));
    assert.equal(evmRoll.ok, true, evmRoll.reason);
    const second = interestNanos(PI_SHE_NANOS + first, GENESIS_BPS);
    const paid = withdraw({ state, dest, nowMs: next });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS + first);
    assert.equal(paid.interest, second);
    assert.notEqual(paid.interest, first);
    const evm = await callReserve(session, encodeWithdraw(dest, next));
    assert.equal(evm.ok, true, evm.reason);
    const decoded = decodeWithdraw(evm.returnValue);
    assert.equal(decoded.principal, paid.principal);
    assert.equal(decoded.interest, paid.interest);
  });

  it('a post-cutoff roll earns the next epoch and nothing before it', async () => {
    const dest = freshDest();
    const quarter = Math.floor(epoch / STAKE_CUTOFF_QUARTER_DEN);
    const lateAt = T0 + epoch - quarter + 1000;
    const { state, session } = await openLock(dest, lateAt);
    const end = T0 + epoch;
    const next = T0 + 2 * epoch;
    const portal = state.portals[portalIdFromDest(dest)];
    assert.equal(portalEpochInterest(state, portal, end), 0);
    assert.equal(portalEpochInterest(state, portal, next), interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    const rolled = roll({ state, dest, nowMs: end });
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(rolled.interest, 0);
    assert.equal(rolled.principal, PI_SHE_NANOS);
    assert.equal(rolled.locked, PI_SHE_NANOS);
    assert.equal(trancheOf(state, dest).epoch, 1);
    const evmRoll = await callReserve(session, encodeRoll(dest, end));
    assert.equal(evmRoll.ok, true, evmRoll.reason);
    assert.equal(decodeWithdraw(evmRoll.returnValue).interest, 0);
    assert.equal(decodeWithdraw(evmRoll.returnValue).principal, PI_SHE_NANOS);
    const after = await balances(session, dest, end);
    assert.equal(after.portal.staked + after.portal.idle, PI_SHE_NANOS);

    const paid = withdraw({ state, dest, nowMs: next });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS);
    assert.equal(paid.interest, interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    const evm = await callReserve(session, encodeWithdraw(dest, next));
    assert.equal(evm.ok, true, evm.reason);
    assert.equal(decodeWithdraw(evm.returnValue).principal, paid.principal);
    assert.equal(decodeWithdraw(evm.returnValue).interest, paid.interest);
  });

  function commitRoot(state, nowMs, root) {
    const got = applyReserveBlock({
      state,
      block: { height: 2, txs: [{ coinbase: true, vout: [], rewardRoot: root }] },
      nowMs,
      genesisMs: T0,
    });
    assert.equal(got.ok, true, got.reason);
  }

  function leafProof(plan, row) {
    const key = String(plan.index);
    const preview = {
      rewardBook: { [row.nullifier]: { nanos: row.nanos, epoch: row.epoch, rootKey: key, portalId: row.portalId } },
      rewardSets: { [key]: plan.rows },
    };
    return packRewardProof(rewardClaimProof(preview, row.nullifier));
  }

  it('a roll consumes the unclaimed reward leaf and a claim cannot', async () => {
    const at = T0 + epoch;
    const spent = freshDest();
    const spentSide = await openLock(spent, T0);
    const spentPlan = rewardCommitment(spentSide.state, at);
    const spentRow = spentPlan.rows[0];
    assert.ok(spentRow);
    const spentProof = leafProof(spentPlan, spentRow);
    commitRoot(spentSide.state, at, spentPlan.root);
    const spentRoll = roll({ state: spentSide.state, dest: spent, nowMs: at });
    assert.equal(spentRoll.ok, true, spentRoll.reason);
    assert.equal(spentRoll.principal, PI_SHE_NANOS);
    assert.equal(spentRoll.interest, spentRow.nanos);
    assert.equal(spentSide.state.mintedIds[spentRow.nullifier], true);
    assert.equal(spentSide.state.rewardBook[spentRow.nullifier].settledByWithdraw, true);
    const claimAfter = applyRewardClaim(spentSide.state, rewardClaimTx({
      to: freshDest(),
      nanos: spentRow.nanos,
      nullifier: spentRow.nullifier,
      proof: rewardClaimProof(spentSide.state, spentRow.nullifier),
      id: 'claim-after-roll',
    }));
    assert.equal(claimAfter.ok, false);
    assert.equal(claimAfter.reason, 'double_mint');
    assert.equal(supplyIdentity(spentSide.state).ok, true);
    const evmCommit = await callReserve(spentSide.session, encodeCommitRewards(at, spentPlan.root));
    assert.equal(evmCommit.ok, true, evmCommit.reason);
    assert.equal((await callReserve(spentSide.session, encodeRoll(spent, at))).ok, false);
    const evmRoll = await callReserve(spentSide.session, encodeRoll(spent, at, {
      nullifier: spentRow.nullifier,
      nanos: spentRow.nanos,
      epoch: spentPlan.index - 1,
      proof: spentProof,
    }));
    assert.equal(evmRoll.ok, true, evmRoll.reason);
    assert.equal(decodeWithdraw(evmRoll.returnValue).principal, spentRoll.principal);
    assert.equal(decodeWithdraw(evmRoll.returnValue).interest, spentRoll.interest);
    const evmClaim = await callReserve(
      spentSide.session,
      encodeClaim(spentRow.nullifier, spentRow.nanos, spentPlan.index - 1, spentProof),
    );
    assert.equal(evmClaim.ok, false);

    const sealed = freshDest();
    const sealedSide = await openLock(sealed, T0);
    const sealedPlan = rewardCommitment(sealedSide.state, at);
    const sealedRow = sealedPlan.rows[0];
    const sealedRoll = roll({ state: sealedSide.state, dest: sealed, nowMs: at });
    assert.equal(sealedRoll.ok, true, sealedRoll.reason);
    assert.equal(sealedSide.state.mintedIds[sealedRow.nullifier], true);
    assert.equal(rewardCommitment(sealedSide.state, at).rows.some((row) => row.nullifier === sealedRow.nullifier), false);
    sealedSide.state.rewardRoots[String(sealedPlan.index)] = sealedPlan.root;
    sealedSide.state.rewardSets[String(sealedPlan.index)] = sealedPlan.rows;
    sealedSide.state.rewardBook[sealedRow.nullifier] = {
      nanos: sealedRow.nanos,
      epoch: sealedRow.epoch,
      rootKey: String(sealedPlan.index),
      portalId: sealedRow.portalId,
    };
    const lateClaim = applyRewardClaim(sealedSide.state, rewardClaimTx({
      to: freshDest(),
      nanos: sealedRow.nanos,
      nullifier: sealedRow.nullifier,
      proof: rewardClaimProof(sealedSide.state, sealedRow.nullifier),
      id: 'claim-after-seal',
    }));
    assert.equal(lateClaim.ok, false);
    assert.equal(lateClaim.reason, 'double_mint');
    const evmSeal = await callReserve(sealedSide.session, encodeRoll(sealed, at));
    assert.equal(evmSeal.ok, true, evmSeal.reason);
    const evmStore = await callReserve(sealedSide.session, encodeCommitRewards(at, sealedPlan.root));
    assert.equal(evmStore.ok, true, evmStore.reason);
    assert.equal(decodeBytes32(evmStore.returnValue), sealedPlan.root);
    const evmLate = await callReserve(
      sealedSide.session,
      encodeClaim(sealedRow.nullifier, sealedRow.nanos, sealedPlan.index - 1, leafProof(sealedPlan, sealedRow)),
    );
    assert.equal(evmLate.ok, false);

    const claimed = freshDest();
    const claimedSide = await openLock(claimed, T0);
    const claimedPlan = rewardCommitment(claimedSide.state, at);
    const claimedRow = claimedPlan.rows[0];
    commitRoot(claimedSide.state, at, claimedPlan.root);
    const firstClaim = applyRewardClaim(claimedSide.state, rewardClaimTx({
      to: freshDest(),
      nanos: claimedRow.nanos,
      nullifier: claimedRow.nullifier,
      proof: rewardClaimProof(claimedSide.state, claimedRow.nullifier),
      id: 'claim-before-roll',
    }));
    assert.equal(firstClaim.ok, true, firstClaim.reason);
    const afterClaim = roll({ state: claimedSide.state, dest: claimed, nowMs: at });
    assert.equal(afterClaim.ok, true, afterClaim.reason);
    assert.equal(afterClaim.interest, 0);
    assert.equal(afterClaim.principal, PI_SHE_NANOS);
    assert.equal(afterClaim.locked, PI_SHE_NANOS);
    const evmRoot = await callReserve(claimedSide.session, encodeCommitRewards(at, claimedPlan.root));
    assert.equal(evmRoot.ok, true, evmRoot.reason);
    const evmFirst = await callReserve(
      claimedSide.session,
      encodeClaim(claimedRow.nullifier, claimedRow.nanos, claimedPlan.index - 1, leafProof(claimedPlan, claimedRow)),
    );
    assert.equal(evmFirst.ok, true, evmFirst.reason);
    const evmAfter = await callReserve(claimedSide.session, encodeRoll(claimed, at));
    assert.equal(evmAfter.ok, true, evmAfter.reason);
    assert.equal(decodeWithdraw(evmAfter.returnValue).interest, 0);
    assert.equal(decodeWithdraw(evmAfter.returnValue).principal, PI_SHE_NANOS);
  });

  it('a late roll locks into the current epoch and earns nothing for that arrival', async () => {
    const dest = freshDest();
    const { state, session } = await openLock(dest, T0);
    const quarter = Math.floor(epoch / STAKE_CUTOFF_QUARTER_DEN);
    const late = T0 + 2 * epoch - 1000;
    assert.ok(quarter > 1000);
    const first = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const rolled = roll({ state, dest, nowMs: late });
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(rolled.interest, first);
    assert.equal(rolled.principal, PI_SHE_NANOS);
    const credit = trancheOf(state, dest);
    assert.equal(credit.epoch, 1);
    assert.notEqual(credit.epoch, 0);
    assert.equal(roll({ state, dest, nowMs: late }).reason, 'epoch_open');
    const portal = state.portals[portalIdFromDest(dest)];
    assert.equal(portalEpochInterest(state, portal, T0 + 2 * epoch), 0);
    const evm = await callReserve(session, encodeRoll(dest, late));
    assert.equal(evm.ok, true, evm.reason);
    assert.equal(decodeWithdraw(evm.returnValue).interest, first);
    assert.equal(decodeWithdraw(evm.returnValue).principal, PI_SHE_NANOS);
    assert.equal((await callReserve(session, encodeRoll(dest, late))).ok, false);

    const againAt = T0 + 2 * epoch;
    const again = roll({ state, dest, nowMs: againAt });
    assert.equal(again.ok, true, again.reason);
    assert.equal(again.interest, 0);
    assert.equal(again.principal, PI_SHE_NANOS + first);
    assert.equal(trancheOf(state, dest).epoch, 2);
    const evmAgain = await callReserve(session, encodeRoll(dest, againAt));
    assert.equal(evmAgain.ok, true, evmAgain.reason);
    assert.equal(decodeWithdraw(evmAgain.returnValue).interest, 0);
    assert.equal(decodeWithdraw(evmAgain.returnValue).principal, PI_SHE_NANOS + first);

    const end = T0 + 3 * epoch;
    const one = interestNanos(PI_SHE_NANOS + first, GENESIS_BPS);
    const paid = withdraw({ state, dest, nowMs: end });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS + first);
    assert.equal(paid.interest, one);
    const evmPaid = await callReserve(session, encodeWithdraw(dest, end));
    assert.equal(evmPaid.ok, true, evmPaid.reason);
    assert.equal(decodeWithdraw(evmPaid.returnValue).principal, paid.principal);
    assert.equal(decodeWithdraw(evmPaid.returnValue).interest, paid.interest);
  });

  it('idle funds stay out of a later reward root', async () => {
    const early = freshDest();
    const live = freshDest();
    const { state, session } = await openLock(early, T0);
    const end = T0 + epoch;
    const next = T0 + 2 * epoch;
    const first = rewardCommitment(state, end);
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].portalId, portalIdFromDest(early));
    const idleId = first.rows[0].nullifier;
    assert.equal(enact({ state, nowMs: end }).ok, true);
    assert.equal(deposit({ state, dest: live, nanos: PI_SHE_NANOS, nowMs: end }).ok, true);
    const later = rewardCommitment(state, next);
    assert.equal(later.rows.length, 1);
    assert.equal(later.rows[0].portalId, portalIdFromDest(live));
    assert.equal(later.rows.some((row) => row.nullifier === idleId), false);
    assert.equal(later.rows.some((row) => row.portalId === portalIdFromDest(early)), false);

    assert.equal((await callReserve(session, encodeEnact(end))).ok, true);
    const storedFirst = await callReserve(session, encodeCommitRewards(end, first.root));
    assert.equal(storedFirst.ok, true, storedFirst.reason);
    assert.equal(decodeBytes32(storedFirst.returnValue), first.root);
    assert.equal((await callReserve(session, encodeDeposit(live, PI_SHE_NANOS, end))).ok, true);
    const storedLater = await callReserve(session, encodeCommitRewards(next, later.root));
    assert.equal(storedLater.ok, true, storedLater.reason);
    assert.equal(decodeBytes32(storedLater.returnValue), later.root);
    const claim = await callReserve(
      session,
      encodeClaim(idleId, first.rows[0].nanos, later.index - 1, leafProof(first, first.rows[0])),
    );
    assert.equal(claim.ok, false);
  });

  it('refuses a signed claim below the FS-1 height', async () => {
    const owner = newIdentity();
    const ownerPub = Buffer.from(owner.spendPub).toString('hex');
    const dest = spendDestOf(owner.spendPub);
    const payout = encodeDest(Buffer.alloc(20, 0x31));
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub }).ok, true);
    const at = T0 + epoch;
    const plan = rewardCommitment(state, at);
    assert.equal(plan.rows.length, 1);
    commitRoot(state, at, plan.root);
    const row = plan.rows[0];
    const proof = rewardClaimProof(state, row.nullifier);
    const claim = rewardClaimTx({
      to: payout,
      nanos: row.nanos,
      nullifier: row.nullifier,
      proof,
      ownerKey: owner.privateKey,
      id: 'owner-claim-early',
    });
    const refused = applyReserveBlock({
      state,
      block: { height: VAULT_FS1_ACTIVATION_HEIGHT - 1, txs: [{ coinbase: true, vout: [] }, claim] },
      nowMs: at + 1,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'reward_unavailable');
    assert.equal(Number(state.totalLockedNanos), PI_SHE_NANOS);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, T0, rewardOwnerCommit(ownerPub)))).ok, true);
    assert.equal((await callReserve(session, encodeCommitRewards(at, plan.root))).ok, true);
    const packed = packRewardProof(proof);
    const auth = packRewardAuth({ ownerPub, sig: claim.sig, dest: payout });
    const evmEarly = await callReserve(
      session,
      encodeClaim(row.nullifier, row.nanos, plan.index - 1, packed, auth),
      { blockNumber: VAULT_FS1_ACTIVATION_HEIGHT },
    );
    assert.equal(evmEarly.ok, false);
  });

  it('refuses a third-party roll and still rolls for the owner', async () => {
    const owner = newIdentity();
    const ownerPub = Buffer.from(owner.spendPub).toString('hex');
    const dest = spendDestOf(owner.spendPub);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub }).ok, true);
    const at = T0 + epoch;
    const plan = rewardCommitment(state, at);
    const row = plan.rows[0];
    assert.ok(row);
    commitRoot(state, at, plan.root);
    const proof = rewardClaimProof(state, row.nullifier);
    const stranger = newIdentity();
    const stolen = rollTx({ from: dest, id: 'roll-stolen' });
    signRollReward(stolen, stranger.privateKey, {
      nullifier: row.nullifier,
      nanos: row.nanos,
      proof,
      dest,
    });
    const refused = applyReserveBlock({
      state: cloneVault(state),
      block: { height: 3, txs: [{ coinbase: true, vout: [] }, stolen] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unsigned');
    const bare = applyReserveBlock({
      state: cloneVault(state),
      block: { height: 3, txs: [{ coinbase: true, vout: [] }, rollTx({ from: dest, id: 'roll-bare' })] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(bare.ok, false);
    assert.equal(bare.reason, 'unsigned');
    const owned = rollTx({ from: dest, id: 'roll-owner' });
    signRollReward(owned, owner.privateKey, {
      nullifier: row.nullifier,
      nanos: row.nanos,
      proof,
      dest,
    });
    const paid = applyReserveBlock({
      state,
      block: { height: 4, txs: [{ coinbase: true, vout: [] }, owned] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(state.mintedIds[row.nullifier], true);
    const claimAfter = applyRewardClaim(state, rewardClaimTx({
      to: freshDest(),
      nanos: row.nanos,
      nullifier: row.nullifier,
      proof,
      ownerKey: owner.privateKey,
      id: 'claim-after-owner-roll',
    }));
    assert.equal(claimAfter.ok, false);
    assert.equal(claimAfter.reason, 'double_mint');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, T0, rewardOwnerCommit(ownerPub)))).ok, true);
    assert.equal((await callReserve(session, encodeCommitRewards(at, plan.root))).ok, true);
    const packed = packRewardProof(proof);
    const leaf = { nullifier: row.nullifier, nanos: row.nanos, epoch: plan.index - 1, proof: packed };
    const stolenAuth = packRewardAuth({ ownerPub: stolen.spendPub, sig: stolen.rewardSig, dest });
    assert.equal((await callReserve(session, encodeRoll(dest, at, leaf, stolenAuth))).ok, false);
    assert.equal((await callReserve(session, encodeRoll(dest, at, leaf))).ok, false);
    const auth = packRewardAuth({ ownerPub, sig: owned.rewardSig, dest });
    const evmRoll = await callReserve(session, encodeRoll(dest, at, leaf, auth));
    assert.equal(evmRoll.ok, true, evmRoll.reason);
    assert.equal(decodeWithdraw(evmRoll.returnValue).interest, row.nanos);
    const after = rewardClaimTx({
      to: freshDest(),
      nanos: row.nanos,
      nullifier: row.nullifier,
      proof,
      ownerKey: owner.privateKey,
      id: 'evm-claim-after-roll',
    });
    const claimAuth = packRewardAuth({ ownerPub, sig: after.sig, dest: after.to });
    const evmClaim = await callReserve(
      session,
      encodeClaim(row.nullifier, row.nanos, plan.index - 1, packed, claimAuth),
    );
    assert.equal(evmClaim.ok, false);
  });

  it('refuses a reward withdraw that is not signed by the portal owner', async () => {
    const owner = newIdentity();
    const ownerPub = Buffer.from(owner.spendPub).toString('hex');
    const dest = spendDestOf(owner.spendPub);
    const payout = encodeDest(Buffer.alloc(20, 0x44));
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub }).ok, true);
    const at = T0 + epoch;
    const plan = rewardCommitment(state, at);
    const preview = previewWithdraw(state, dest, at);
    assert.ok(preview.interest > 0);
    const portalId = portalIdFromDest(dest);
    const bare = withdrawTx({ from: dest, to: payout, nanos: preview.payout, id: 'wd-bare' });
    const refused = applyReserveBlock({
      state: cloneVault(state),
      block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }, bare] },
      nowMs: at,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unsigned');
    const stranger = newIdentity();
    const stolen = withdrawTx({ from: dest, to: payout, nanos: preview.payout, id: 'wd-stolen' });
    signWithdrawReward(stolen, stranger.privateKey, {
      portalId, nanos: preview.interest, dest: payout, epoch: 1, tranches: state.portals[portalId].tranches,
    });
    const stolenApply = applyReserveBlock({
      state: cloneVault(state),
      block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }, stolen] },
      nowMs: at,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(stolenApply.ok, false);
    assert.equal(stolenApply.reason, 'unsigned');
    const tx = withdrawTx({ from: dest, to: payout, nanos: preview.payout, id: 'wd-owner' });
    signWithdrawReward(tx, owner.privateKey, {
      portalId, nanos: preview.interest, dest: payout, epoch: 1, tranches: state.portals[portalId].tranches,
    });
    const applied = applyReserveBlock({
      state,
      block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }, tx] },
      nowMs: at,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(applied.ok, true, applied.reason);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, T0, rewardOwnerCommit(ownerPub)))).ok, true);
    assert.equal((await callReserve(session, encodeWithdraw(dest, at))).ok, false);
    const stolenAuth = packRewardAuth({ ownerPub: stolen.spendPub, sig: stolen.rewardSig, dest: payout });
    assert.equal((await callReserve(session, encodeWithdraw(dest, at, stolenAuth))).ok, false);
    const auth = packRewardAuth({ ownerPub, sig: tx.rewardSig, dest: payout });
    const drawn = await callReserve(session, encodeWithdraw(dest, at, auth));
    assert.equal(drawn.ok, true, drawn.reason);
    assert.equal(decodeWithdraw(drawn.returnValue).interest, preview.interest);
    assert.equal(decodeWithdraw(drawn.returnValue).principal, PI_SHE_NANOS);
  });
});

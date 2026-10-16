import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { newIdentity, spendDestOf } from './address.js';
import { STAKE_CUTOFF_QUARTER_DEN } from './pot_sched.js';
import { levyTaxed } from './levy.js';
import {
  applyReserveBlock,
  deposit,
  emptyVault,
  packRewardAuth,
  portalEpochInterest,
  portalIdFromDest,
  hiddenWithdrawOpening,
  previewWithdraw,
  rewardClaimTx,
  rewardOwnerCommit,
  rollTx,
  rollTrancheSet,
  signRollReward,
  signWithdrawReward,
  withdrawTx,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  decodePublicView,
  decodeWithdraw,
  encodeDeposit,
  encodePinClock,
  encodePublicView,
  encodeRoll,
  encodeWithdraw,
} from './reserve_evm.js';

const T0 = 1_700_000_000_000;
const epoch = RESERVE_EPOCH_MS;
const HEIGHT = VAULT_FS1_ACTIVATION_HEIGHT;

function who() {
  const id = newIdentity();
  return {
    dest: spendDestOf(id.spendPub),
    pub: Buffer.from(id.spendPub).toString('hex'),
    key: id.privateKey,
  };
}

function openState(owner, when = T0) {
  const state = emptyVault();
  state.genesisMs = T0;
  state.magic = MAGIC_TESTNET;
  const opened = deposit({
    state,
    dest: owner.dest,
    nanos: PI_SHE_NANOS,
    nowMs: when,
    ownerPub: owner.pub,
  });
  assert.equal(opened.ok, true, opened.reason);
  return state;
}

async function openEvm(owner, commit = Buffer.alloc(32, 9), when = T0) {
  const session = await bootReserveEvm();
  assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
  assert.equal((await callReserve(session, encodeDeposit(owner.dest, commit, when, rewardOwnerCommit(owner.pub), true))).ok, true);
  return session;
}

function signedRoll(owner, state, { epochIndex = 0, id = 'roll' } = {}) {
  const tx = rollTx({ from: owner.dest, id });
  tx.earnEpoch = epochIndex;
  tx.rootEpoch = epochIndex;
  signRollReward(tx, owner.key, { portalId: tx.portalId, epoch: epochIndex, state });
  return tx;
}

describe('a roll is the owner signed transaction', () => {
  it('roll is levy-taxed and a vote is not', () => {
    assert.equal(levyTaxed({ kind: 'roll' }), true);
    assert.equal(levyTaxed({ kind: 'vote' }), false);
  });

  it('refuses a roll with no owner signature, on JS and the EVM', async () => {
    const owner = who();
    const state = openState(owner);
    const at = T0 + epoch;
    const bare = rollTx({ from: owner.dest, id: 'roll-bare' });
    bare.earnEpoch = 0;
    const refused = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, bare] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unsigned');
    assert.equal(Number(state.totalLockedNanos), 0);

    const stranger = who();
    const foreign = signedRoll(stranger, state, { id: 'roll-stranger' });
    foreign.from = owner.dest;
    foreign.portalId = portalIdFromDest(owner.dest);
    const stolen = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, foreign] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(stolen.ok, false);
    assert.equal(stolen.reason, 'unsigned');

    const session = await openEvm(owner);
    const evm = await callReserve(session, encodeRoll(owner.dest, at, 0, new Uint8Array()));
    assert.equal(evm.ok, false);
  });

  it('rolls on the owner signature when reward is due and leaves principal unchanged', async () => {
    const owner = who();
    const state = openState(owner);
    const at = T0 + epoch;
    const portal = state.portals[portalIdFromDest(owner.dest)];
    assert.equal(portal.qualified, true);
    assert.equal(portalEpochInterest(state, portal, at), 0);
    const commit = portal.tranches[0].commit;
    const tx = signedRoll(owner, state, { id: 'roll-due' });
    const rolled = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, tx] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(rolled.find((row) => row.action === 'roll').interest, 0);
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal(portal.tranches[0].commit, commit);
    assert.equal(portal.tranches[0].amount, undefined);
    assert.equal(state.mintedIds?.[tx.nullifier], undefined);

    const session = await openEvm(owner, Buffer.from(String(commit), 'hex'));
    const auth = packRewardAuth({ ownerPub: owner.pub, sig: tx.rewardSig, dest: owner.dest });
    const evm = await callReserve(session, encodeRoll(owner.dest, at, 0, auth));
    assert.equal(evm.ok, true, evm.reason);
    const view = decodePublicView((await callReserve(session, encodePublicView(at), { staticCall: true })).returnValue);
    assert.equal(view.totalLockedNanos, 0);
  });

  it('a post-cutoff roll with nothing due needs only the owner signature', async () => {
    const owner = who();
    const quarter = Math.floor(epoch / STAKE_CUTOFF_QUARTER_DEN);
    const lateAt = T0 + epoch - quarter + 1000;
    const state = openState(owner, lateAt);
    const end = T0 + epoch;
    const portal = state.portals[portalIdFromDest(owner.dest)];
    assert.equal(portalEpochInterest(state, portal, end), 0);
    const tx = signedRoll(owner, state, { epochIndex: 0, id: 'roll-idle' });
    const rolled = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, tx] },
      nowMs: end,
      genesisMs: T0,
    });
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(rolled.find((row) => row.action === 'roll').interest, 0);
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal(portal.tranches[0].epoch, 0);

    const evmCommit = Buffer.alloc(32, 9);
    const session = await openEvm(owner, evmCommit, lateAt);
    const evmTx = rollTx({ from: owner.dest, id: 'roll-idle-evm' });
    signRollReward(evmTx, owner.key, {
      portalId: evmTx.portalId,
      epoch: 0,
      trancheSet: rollTrancheSet({ tranches: [{ commit: evmCommit.toString('hex'), epoch: 0 }] }),
    });
    const auth = packRewardAuth({ ownerPub: owner.pub, sig: evmTx.rewardSig, dest: owner.dest });
    const evm = await callReserve(session, encodeRoll(owner.dest, end, 0, auth));
    assert.equal(evm.ok, true, evm.reason);
    const view = decodePublicView((await callReserve(session, encodePublicView(end), { staticCall: true })).returnValue);
    assert.equal(view.totalLockedNanos, 0);
  });

  it('withdraw pays principal only, and a claim below the FS-1 height stays closed', async () => {
    const owner = who();
    const state = openState(owner);
    const at = T0 + epoch;
    const preview = previewWithdraw(state, owner.dest, at);
    const lockedCommit = Buffer.from(state.portals[portalIdFromDest(owner.dest)].tranches[0].commit, 'hex');
    assert.equal(preview.interest, 0);
    assert.equal(preview.payout, 0);
    const peek = hiddenWithdrawOpening(state, owner.dest, at);
    assert.equal(peek.nanos, PI_SHE_NANOS);
    const tx = withdrawTx({ from: owner.dest, to: owner.dest, nanos: peek.nanos, id: 'withdraw-principal' });
    const open = hiddenWithdrawOpening(state, owner.dest, at, tx);
    assert.ok(open?.proof);
    tx.principalProof = open.proof;
    signWithdrawReward(tx, owner.key, {
      portalId: portalIdFromDest(owner.dest),
      nanos: open.nanos,
      dest: owner.dest,
      state,
      nowMs: at,
    });
    const evmAuth = { to: owner.dest };
    signWithdrawReward(evmAuth, owner.key, {
      portalId: portalIdFromDest(owner.dest),
      nanos: 0,
      dest: owner.dest,
      state,
      nowMs: at,
    });
    const paid = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, tx] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);
    const row = paid.find((item) => item.action === 'withdraw');
    assert.equal(row.principal, PI_SHE_NANOS);
    assert.equal(row.interest, 0);
    assert.equal(Number(state.totalLockedNanos), 0);

    const session = await openEvm(owner, lockedCommit);
    const auth = packRewardAuth({ ownerPub: owner.pub, sig: evmAuth.rewardSig, dest: owner.dest });
    const evm = await callReserve(session, encodeWithdraw(owner.dest, at, auth));
    assert.equal(evm.ok, true, evm.reason);
    assert.equal(decodeWithdraw(evm.returnValue).principal, 0);
    assert.equal(decodeWithdraw(evm.returnValue).interest, 0);
    const evmRoll = await callReserve(session, encodeRoll(owner.dest, at, 0, auth));
    assert.equal(evmRoll.ok, false);

    const early = applyReserveBlock({
      state: openState(who()),
      block: {
        height: HEIGHT - 1,
        txs: [{ coinbase: true, vout: [] }, rewardClaimTx({ to: owner.dest, nanos: 1, nullifier: 'ab'.repeat(32), id: 'early-claim' })],
      },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(early.ok, false);
    assert.equal(early.reason, 'claim_unavailable');
  });
});

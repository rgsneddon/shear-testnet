import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { encodeDest, hash20FromAddress, newIdentity, spendDestOf } from './address.js';
import { vaultDest } from './flow_sheet.js';
import { interestNanos } from './reserve_oracle.js';
import {
  appendVaultLockNote,
  applyReserveBlock,
  cloneVault,
  deposit,
  emptyVault,
  lockTx,
  portalEpochInterest,
  portalIdFromDest,
  previewWithdraw,
  rewardClaimTx,
  rewardCommitment,
  rollTx,
  packRewardAuth,
  rewardOwnerCommit,
  signWithdrawReward,
  withdrawTx,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  decodeBytes32,
  decodeWithdraw,
  encodeClaim,
  encodeCommitRewards,
  encodeDeposit,
  encodePinClock,
  encodeRoll,
  encodeWithdraw,
} from './reserve_evm.js';
import {
  RELATION_BOUND,
  packVaultOutput,
  proveEpochMint,
  proveVaultReward,
  vaultLockBlind,
  vaultLockNote,
  vaultLockOwnerScalar,
  vaultRewardNanos,
  verifyVaultReward,
} from './vault_reward_fs1.js';
import { blockBudget, fs1VerifyWeight, txVerifyWeight, W_OUT, W_TX } from './block_budget.js';
import { consensusFingerprint, MAX_BLOCK_VAULT_CLAIMS } from './asert.js';
import { stakeRewardSupply } from './reserve_vault.js';

const T0 = 1_700_000_000_000;
const span = RESERVE_EPOCH_MS;
const at = T0 + span;
const HEIGHT = VAULT_FS1_ACTIVATION_HEIGHT;

function freshDest() {
  const id = newIdentity();
  return vaultDest(id.address, { viewKey: id.viewKey });
}

function openVault(dest) {
  const state = emptyVault();
  state.genesisMs = T0;
  state.magic = MAGIC_TESTNET;
  const opened = deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: T0 });
  assert.equal(opened.ok, true, opened.reason);
  return state;
}

function word(ret) {
  const raw = Buffer.from(ret instanceof Uint8Array ? ret : []);
  return BigInt(`0x${raw.subarray(0, 32).toString('hex') || '0'}`);
}

function claimBlock(tx, rootHex, height = HEIGHT, proved = null) {
  const coinbase = { coinbase: true, vout: [], vaultLockRoot: rootHex };
  if (proved) {
    const opened = proveEpochMint(proved.nanos, proved.rewardBlind);
    coinbase.epochMint = opened.nanos;
    coinbase.epochMintProof = opened.proof;
  }
  return { height, txs: [coinbase, tx] };
}

function plantLocks(state, proved, remain, earnEpoch) {
  state.vaultLockNotes = [];
  state.vaultLockRoot = '';
  state.vaultRemains = Object.create(null);
  for (const lock of proved.locks) {
    const note = vaultLockNote(lock.amount, lock.scalar, lock.blind).note;
    assert.ok(appendVaultLockNote(state, note, {
      earnEpoch, remain, bps: GENESIS_BPS, span,
    }));
  }
  assert.equal(state.vaultLockRoot, proved.rootHex);
}

function termsOf(remain, earnEpoch) {
  return { bps: GENESIS_BPS, span, remain, earnEpoch };
}

function zkRoll(from, proof, id) {
  const tx = rollTx({ from, id });
  tx.vaultProof = proof.blob;
  tx.nullifier = proof.nullifier;
  tx.rootEpoch = proof.rootEpoch;
  tx.earnEpoch = proof.earnEpoch;
  assert.equal(tx.portalId, undefined);
  return tx;
}

function applyClaim(state, tx, rootHex, proved = null) {
  return applyReserveBlock({
    state,
    block: claimBlock(tx, rootHex, HEIGHT, proved),
    nowMs: at,
    genesisMs: T0,
  });
}

function corruptReward(blob) {
  const buf = Buffer.from(blob);
  const fs1Len = buf.readUInt32LE(1);
  const atCommit = 5 + fs1Len + 321 + 4 + 24 + 64;
  buf[atCommit] ^= 0x01;
  return buf;
}

/** The proof opens under the prover's own public inputs. Consensus must still refuse them. */
function proofOpens(forged, terms, magic = MAGIC_TESTNET) {
  return verifyVaultReward({
    blob: forged.blob,
    root: forged.root,
    rootEpoch: forged.rootEpoch,
    nanos: forged.nanos,
    nullifier: Buffer.from(forged.nullifier, 'hex'),
    output: forged.note,
    terms,
    magic,
  });
}

let forgedReady;
function forgedFixture() {
  if (!forgedReady) forgedReady = Promise.resolve().then(() => buildForgedFixture());
  return forgedReady;
}

function buildForgedFixture() {
  const lockDest = freshDest();
  const payTo = encodeDest(Buffer.alloc(20, 0x51));
  const dest20 = hash20FromAddress(payTo);
  const booked = openVault(lockDest);
  const plan = rewardCommitment(booked, at);
  const row = plan.rows[0];
  const remain = Number(booked.portals[row.portalId].tranches[0].remainMs);
  const proved = proveVaultReward({
    locks: [{ amount: PI_SHE_NANOS }],
    which: 0,
    rootEpoch: row.epoch,
    earnEpoch: row.epoch,
    bps: GENESIS_BPS,
    remainMs: remain,
    span,
    dest20,
  });
  assert.ok(proved);
  const locks = proved.locks;
  const prove = (over = {}) => proveVaultReward({
    locks,
    which: 0,
    rootEpoch: row.epoch,
    earnEpoch: row.epoch,
    bps: GENESIS_BPS,
    remainMs: remain,
    span,
    dest20,
    ...over,
  });
  const bpsProof = prove({ bps: GENESIS_BPS + 1 });
  const spanProof = prove({ span: span + 1 });
  const later = prove({ rootEpoch: row.epoch + 1, earnEpoch: row.epoch + 1 });
  const foreign = prove({ magic: 'shear-other-net' });
  assert.ok(bpsProof && spanProof && later && foreign);
  assert.equal(bpsProof.rootHex, proved.rootHex);
  assert.equal(spanProof.rootHex, proved.rootHex);
  assert.equal(later.rootHex, proved.rootHex);
  assert.equal(foreign.rootHex, proved.rootHex);
  assert.ok(bpsProof.nanos > proved.nanos);
  const state = openVault(lockDest);
  plantLocks(state, proved, remain, row.epoch);
  state.vaultLockRoots[String(row.epoch)] = state.vaultLockRoot;
  return {
    lockDest, payTo, dest20, plan, row, remain, proved, state, bpsProof, spanProof, later, foreign,
  };
}

describe('vault-lock reward proof', () => {
  it('pays the owner once, refuses a stranger and the wrong amount, and JS matches the EVM', async () => {
    const lockDest = freshDest();
    const payTo = encodeDest(Buffer.alloc(20, 0x44));
    const dest20 = hash20FromAddress(payTo);
    const booked = openVault(lockDest);
    const plan = rewardCommitment(booked, at);
    const row = plan.rows[0];
    const remain = Number(booked.portals[row.portalId].tranches[0].remainMs);
    assert.equal(remain, span);
    assert.equal(plan.index, 1);
    assert.equal(row.epoch, 0);
    assert.equal(row.nanos, interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }, { amount: PI_SHE_NANOS }],
      which: 0,
    rootEpoch: row.epoch,
    earnEpoch: row.epoch,
      bps: GENESIS_BPS,
      remainMs: remain,
      span,
      dest20,
    });
    assert.ok(proved, 'owner proof');
    assert.equal(proved.nanos, row.nanos);
    assert.equal(Buffer.from(proved.blob)[0], 0xa2);
    const stranger = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
    rootEpoch: row.epoch,
    earnEpoch: row.epoch,
      bps: GENESIS_BPS,
      remainMs: remain,
      span,
      dest20,
    });
    assert.ok(stranger, 'stranger proof');
    assert.notEqual(stranger.rootHex, proved.rootHex);
    assert.notEqual(stranger.nullifier, proved.nullifier);
    const ownerRoot = Buffer.from(proved.rootHex, 'hex');
    const badAmount = verifyVaultReward({
      blob: corruptReward(proved.blob),
      root: ownerRoot,
      rootEpoch: proved.rootEpoch,
      nullifier: Buffer.from(proved.nullifier, 'hex'),
      output: proved.note,
      terms: termsOf(remain, row.epoch),
    });
    assert.equal(badAmount.ok, false);
    assert.equal(badAmount.code, 2);
    assert.equal(badAmount.reason, 'stake_reward');
    const notMember = verifyVaultReward({
      blob: stranger.blob,
      root: ownerRoot,
      rootEpoch: proved.rootEpoch,
      nanos: stranger.nanos,
      nullifier: Buffer.from(stranger.nullifier, 'hex'),
      terms: termsOf(remain, row.epoch),
    });
    assert.equal(notMember.ok, false);
    assert.equal(notMember.code, 0);

    const state = openVault(lockDest);
    plantLocks(state, proved, remain, row.epoch);
    const claim = rewardClaimTx({ to: payTo, vault: proved, id: 'claim-owner' });
    assert.equal(claim.vout[0].amtCt.length, 8);
    assert.ok(claim.vout[0].rangeProof.length > 0);
    assert.equal(claim.vout[0].valueProof, undefined);
    assert.equal(claim.portalId, undefined);
    const lock20 = hash20FromAddress(lockDest);
    const blob = Buffer.from(proved.blob);
    assert.equal(blob.includes(lock20), false);
    assert.equal(blob.includes(Buffer.from(dest20)), true);
    const paid = applyReserveBlock({
      state,
      block: claimBlock(claim, proved.rootHex, HEIGHT, proved),
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(Number(state.mintBankNanos), proved.nanos);
    assert.equal(Number(state.totalLockedNanos), PI_SHE_NANOS);

    const third = rewardClaimTx({ to: payTo, vault: stranger, id: 'claim-stranger' });
    const stolen = applyReserveBlock({
      state: cloneVault(state),
      block: claimBlock(third, proved.rootHex),
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(stolen.ok, false);
    assert.equal(stolen.reason, 'unsigned');

    const wrong = rewardClaimTx({ to: payTo, vault: proved, id: 'claim-wrong' });
    wrong.vaultProof = corruptReward(wrong.vaultProof);
    const over = applyReserveBlock({
      state: cloneVault(state),
      block: claimBlock(wrong, proved.rootHex),
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'stake_reward');

    const early = applyReserveBlock({
      state: openVault(lockDest),
      block: {
        height: HEIGHT - 1,
        txs: [{ coinbase: true, vout: [] }, rewardClaimTx({ to: payTo, vault: proved, id: 'claim-early' })],
      },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(early.ok, false);
    assert.equal(early.reason, 'reward_unavailable');

    const again = applyReserveBlock({
      state,
      block: claimBlock({ ...claim, id: 'claim-again' }, proved.rootHex),
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double_mint');
    assert.equal(Number(state.mintBankNanos), proved.nanos);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(lockDest, PI_SHE_NANOS, T0))).ok, true);
    const stored = await callReserve(session, encodeCommitRewards(at, proved.rootHex));
    assert.equal(stored.ok, true, stored.reason);
    const evmPaid = await callReserve(
      session,
      encodeClaim(proved.nullifier, proved.nanos, proved.rootEpoch, proved.blob, packVaultOutput(proved.note)),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmPaid.ok, true, evmPaid.reason);
    assert.equal(word(evmPaid.returnValue), 1n);
    const evmEarly = await callReserve(
      session,
      encodeClaim(stranger.nullifier, stranger.nanos, stranger.rootEpoch, stranger.blob),
      { blockNumber: HEIGHT - 1 },
    );
    assert.equal(evmEarly.ok, false);
    const evmStranger = await callReserve(
      session,
      encodeClaim(stranger.nullifier, stranger.nanos, proved.rootEpoch, stranger.blob),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmStranger.ok, false);
    const evmWrong = await callReserve(
      session,
      encodeClaim(proved.nullifier, proved.nanos + 1, proved.rootEpoch, proved.blob),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmWrong.ok, false);
    const evmAgain = await callReserve(
      session,
      encodeClaim(proved.nullifier, proved.nanos, proved.rootEpoch, proved.blob, packVaultOutput(proved.note)),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmAgain.ok, false);
  });

  it('refuses a third-party roll and a wrong roll amount, and the roll spends the claim', async () => {
    const lockDest = freshDest();
    const payTo = encodeDest(Buffer.alloc(20, 0x45));
    const dest20 = hash20FromAddress(payTo);
    const booked = openVault(lockDest);
    const plan = rewardCommitment(booked, at);
    const row = plan.rows[0];
    const remain = Number(booked.portals[row.portalId].tranches[0].remainMs);
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }, { amount: PI_SHE_NANOS }],
      which: 0,
    rootEpoch: row.epoch,
    earnEpoch: row.epoch,
      bps: GENESIS_BPS,
      remainMs: remain,
      span,
      dest20,
    });
    const stranger = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
    rootEpoch: row.epoch,
    earnEpoch: row.epoch,
      bps: GENESIS_BPS,
      remainMs: remain,
      span,
      dest20,
    });
    assert.ok(proved && stranger);
    assert.equal(portalEpochInterest(booked, booked.portals[row.portalId], at), proved.nanos);

    const state = openVault(lockDest);
    plantLocks(state, proved, remain, row.epoch);
    const stolen = applyReserveBlock({
      state: cloneVault(state),
      block: claimBlock(zkRoll(lockDest, stranger, 'roll-stranger'), proved.rootHex),
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(stolen.ok, false);
    assert.equal(stolen.reason, 'unsigned');
    assert.equal(Number(state.totalLockedNanos), PI_SHE_NANOS);

    const wrong = applyReserveBlock({
      state: cloneVault(state),
      block: claimBlock(zkRoll(lockDest, { ...proved, blob: corruptReward(proved.blob) }, 'roll-wrong'), proved.rootHex),
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'stake_reward');

    const rolled = applyReserveBlock({
      state,
      block: claimBlock(zkRoll(lockDest, proved, 'roll-owner'), proved.rootHex),
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(rolled.find((item) => item.action === 'roll').interest, proved.nanos);
    assert.equal(state.mintedIds[proved.nullifier], true);
    assert.equal(Number(state.totalLockedNanos), PI_SHE_NANOS + proved.nanos);
    const after = applyReserveBlock({
      state,
      block: claimBlock(rewardClaimTx({ to: payTo, vault: proved, id: 'claim-after-roll' }), proved.rootHex),
      nowMs: at + span,
      genesisMs: T0,
    });
    assert.equal(after.ok, false);
    assert.equal(after.reason, 'double_mint');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(lockDest, PI_SHE_NANOS, T0))).ok, true);
    assert.equal((await callReserve(session, encodeCommitRewards(at, proved.rootHex))).ok, true);
    const evmStolen = await callReserve(
      session,
      encodeRoll(lockDest, at, {
        nullifier: stranger.nullifier,
        nanos: stranger.nanos,
        epoch: proved.rootEpoch,
        proof: stranger.blob,
      }),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmStolen.ok, false);
    const evmWrong = await callReserve(
      session,
      encodeRoll(lockDest, at, {
        nullifier: proved.nullifier,
        nanos: 0,
        epoch: proved.rootEpoch,
        proof: corruptReward(proved.blob),
      }),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmWrong.ok, false);
    const evmRoll = await callReserve(
      session,
      encodeRoll(lockDest, at, {
        nullifier: proved.nullifier,
        nanos: proved.nanos,
        epoch: proved.rootEpoch,
        proof: proved.blob,
      }),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmRoll.ok, true, evmRoll.reason);
    const decoded = decodeWithdraw(evmRoll.returnValue);
    assert.equal(decoded.principal, PI_SHE_NANOS);
    assert.equal(decoded.interest, proved.nanos);
    const evmClaim = await callReserve(
      session,
      encodeClaim(proved.nullifier, proved.nanos, proved.rootEpoch, proved.blob, packVaultOutput(proved.note)),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmClaim.ok, false);
  });

  it('a reward withdraw still carries the owner signature', () => {
    const owner = newIdentity();
    const ownerPub = Buffer.from(owner.spendPub).toString('hex');
    const dest = spendDestOf(owner.spendPub);
    const to = encodeDest(Buffer.alloc(20, 0x21));
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub }).ok, true);
    const preview = previewWithdraw(state, dest, at);
    assert.ok(preview.interest > 0);
    const bare = withdrawTx({ from: dest, to, nanos: preview.payout, id: 'withdraw-bare' });
    const refused = applyReserveBlock({
      state: cloneVault(state),
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, bare] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unsigned');
    const signed = withdrawTx({ from: dest, to, nanos: preview.payout, id: 'withdraw-owner' });
    const portalId = portalIdFromDest(dest);
    signWithdrawReward(signed, owner.privateKey, {
      portalId,
      nanos: preview.interest,
      dest: to,
      epoch: 1,
      tranches: state.portals[portalId].tranches,
    });
    const paid = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, signed] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.find((item) => item.action === 'withdraw').interest, preview.interest);
    assert.equal(ownerPub.length, 64);
  });

  it('refuses a withdraw signature from an earlier epoch or an older tranche set', async () => {
    const owner = newIdentity();
    const ownerPub = Buffer.from(owner.spendPub).toString('hex');
    const dest = spendDestOf(owner.spendPub);
    const to = encodeDest(Buffer.alloc(20, 0x21));
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub }).ok, true);
    const preview = previewWithdraw(state, dest, at);
    const portalId = portalIdFromDest(dest);
    const signed = withdrawTx({ from: dest, to, nanos: preview.payout, id: 'withdraw-replay' });
    signWithdrawReward(signed, owner.privateKey, {
      portalId,
      nanos: preview.interest,
      dest: to,
      epoch: 1,
      tranches: state.portals[portalId].tranches,
    });
    const later = applyReserveBlock({
      state: cloneVault(state),
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, signed] },
      nowMs: T0 + 2 * span,
      genesisMs: T0,
    });
    assert.equal(later.ok, false);
    assert.equal(later.reason, 'unsigned');
    const topped = cloneVault(state);
    assert.equal(deposit({ state: topped, dest, nanos: 1, nowMs: T0, ownerPub }).ok, true);
    const changed = applyReserveBlock({
      state: topped,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, signed] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(changed.ok, false);
    assert.equal(changed.reason, 'unsigned');
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, T0, rewardOwnerCommit(ownerPub)))).ok, true);
    const auth = packRewardAuth({ ownerPub, sig: signed.rewardSig, dest: to });
    assert.equal((await callReserve(session, encodeWithdraw(dest, T0 + 2 * span, auth))).ok, false);
    const fresh = await bootReserveEvm();
    assert.equal((await callReserve(fresh, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(fresh, encodeDeposit(dest, PI_SHE_NANOS, T0, rewardOwnerCommit(ownerPub)))).ok, true);
    const paid = await callReserve(fresh, encodeWithdraw(dest, at, auth));
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(decodeWithdraw(paid.returnValue).interest, preview.interest);
  });

  it('refuses a coinbase root, a prover-chosen rate, and a second spend of the nullifier', () => {
    const lockDest = freshDest();
    const payTo = encodeDest(Buffer.alloc(20, 0x46));
    const dest20 = hash20FromAddress(payTo);
    const state = openVault(lockDest);
    const plan = rewardCommitment(state, at);
    const row = plan.rows[0];
    const remain = Number(state.portals[row.portalId].tranches[0].remainMs);
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
    rootEpoch: row.epoch,
    earnEpoch: row.epoch,
      bps: GENESIS_BPS,
      remainMs: remain,
      span,
      dest20,
    });
    assert.ok(proved);
    plantLocks(state, proved, remain, row.epoch);
    const claim = rewardClaimTx({ to: payTo, vault: proved, id: 'claim-root' });
    const lied = applyReserveBlock({
      state: cloneVault(state),
      block: claimBlock(claim, 'ab'.repeat(32)),
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(lied.ok, false);
    assert.equal(lied.reason, 'stake_reward');
    const chosen = proveVaultReward({
      locks: proved.locks,
      which: 0,
    rootEpoch: row.epoch,
    earnEpoch: row.epoch,
      bps: GENESIS_BPS + 1,
      remainMs: remain,
      span,
      dest20,
    });
    assert.ok(chosen);
    const rate = verifyVaultReward({
      blob: chosen.blob,
      root: Buffer.from(proved.rootHex, 'hex'),
      rootEpoch: row.epoch,
      nanos: chosen.nanos,
      nullifier: Buffer.from(chosen.nullifier, 'hex'),
      output: chosen.note,
      terms: termsOf(remain, row.epoch),
    });
    assert.equal(rate.ok, false);
    assert.equal(rate.code, 2);
    const paid = applyReserveBlock({
      state,
      block: claimBlock(claim, proved.rootHex, HEIGHT, proved),
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);
    const rolled = applyReserveBlock({
      state,
      block: claimBlock(zkRoll(lockDest, proved, 'roll-after-claim'), proved.rootHex),
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(rolled.ok, false);
    assert.equal(rolled.reason, 'double_mint');
  });

  it('rebuilds the lock note from the seed and keeps the relation under 2^110', () => {
    const seed = Buffer.alloc(32, 7);
    const blind = vaultLockBlind(seed, 3, PI_SHE_NANOS, T0);
    const again = vaultLockBlind(seed, 3, PI_SHE_NANOS, T0);
    const owner = vaultLockOwnerScalar(seed, 3);
    assert.equal(blind, again);
    const note = vaultLockNote(PI_SHE_NANOS, owner, blind);
    const rebuilt = vaultLockNote(PI_SHE_NANOS, vaultLockOwnerScalar(seed, 3), again);
    assert.equal(note.note.equals(rebuilt.note), true);
    const reward = vaultRewardNanos(PI_SHE_NANOS, GENESIS_BPS, span, span);
    assert.ok(reward);
    const prod = BigInt(PI_SHE_NANOS) * BigInt(GENESIS_BPS) * BigInt(span);
    assert.ok(prod < RELATION_BOUND);
    assert.equal(Number(reward.nanos), interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, seed, index: 3, lockMs: T0 }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: Buffer.alloc(20, 9),
    });
    assert.ok(proved);
    assert.equal(proved.locks[0].blind, blind);
    const huge = vaultRewardNanos(2n ** 100n, 1_000_000, 2n ** 20n, 2n ** 20n);
    assert.equal(huge, null);
  });

  it('caps claims in a block and the supply walk uses the block height', () => {
    const lockDest = freshDest();
    const payTo = encodeDest(Buffer.alloc(20, 0x47));
    const state = openVault(lockDest);
    const plan = rewardCommitment(state, at);
    const row = plan.rows[0];
    const remain = Number(state.portals[row.portalId].tranches[0].remainMs);
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
    rootEpoch: row.epoch,
    earnEpoch: row.epoch,
      bps: GENESIS_BPS,
      remainMs: remain,
      span,
      dest20: hash20FromAddress(payTo),
    });
    plantLocks(state, proved, remain, row.epoch);
    const claim = rewardClaimTx({ to: payTo, vault: proved, id: 'claim-weight' });
    assert.ok(txVerifyWeight(claim) > txVerifyWeight({ kind: 'reward-claim', vin: [], vout: claim.vout }));
    const many = [claim];
    for (let i = 0; i < MAX_BLOCK_VAULT_CLAIMS; i += 1) {
      many.push({ ...claim, id: `claim-cap-${i}` });
    }
    const capped = blockBudget([{ coinbase: true, vout: [] }, ...many]);
    assert.equal(capped.ok, false);
    assert.equal(capped.reason, 'claim_cap');
    const over = applyReserveBlock({
      state: cloneVault(state),
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [], vaultLockRoot: proved.rootHex }, ...many] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'claim_cap');
    state.vaultLockRoots[String(row.epoch)] = state.vaultLockRoot;
    const early = stakeRewardSupply(state, {
      height: HEIGHT - 1,
      txs: [{ coinbase: true, vout: [] }, claim],
    }, at, HEIGHT - 1);
    assert.equal(early.ok, false);
    const walked = stakeRewardSupply(state, {
      height: HEIGHT,
      txs: [claimBlock(claim, proved.rootHex, HEIGHT, proved).txs[0], claim],
    }, at, HEIGHT);
    assert.equal(walked.ok, true, walked.reason);
    assert.equal(walked.claimed, BigInt(proved.nanos));
    assert.match(consensusFingerprint(), /VAULT_REWARD=fs1-lock-root-v1/);
    assert.match(consensusFingerprint(), /NETWORK=shear-testnet-v12/);
  });

  it('refuses a stranger lock that does not fund the one-time owner', () => {
    const stranger = newIdentity();
    const dest = spendDestOf(stranger.spendPub);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const tx = lockTx({ from: dest, to: dest, nanos: PI_SHE_NANOS, id: 'stranger-lock' });
    tx.spendPub = Buffer.from(stranger.spendPub).toString('hex');
    const refused = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, tx] },
      nowMs: T0,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unsigned');
    assert.equal(state.portals[portalIdFromDest(dest)], undefined);
    assert.notEqual(vaultLockOwnerScalar(Buffer.alloc(32, 4), 0), null);
    assert.notEqual(String(tx.spendPub || ''), '');
  });

  it('refuses a forged coinbase root and a stale root for another epoch', async () => {
    const fx = await forgedFixture();
    const honest = rewardClaimTx({ to: fx.payTo, vault: fx.proved, id: 'forged-root-honest' });
    const coinbase = applyClaim(
      cloneVault(fx.state),
      { ...honest, id: 'forged-coinbase' },
      'ab'.repeat(32),
    );
    assert.equal(coinbase.ok, false);
    assert.equal(coinbase.reason, 'stake_reward');
    assert.equal(Number(fx.state.mintBankNanos), 0);

    const missing = applyClaim(
      cloneVault(fx.state),
      rewardClaimTx({ to: fx.payTo, vault: fx.later, id: 'stale-missing' }),
      fx.proved.rootHex,
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'stake_reward');

    const decoy = cloneVault(fx.state);
    decoy.vaultLockRoots[String(fx.row.epoch + 1)] = '11'.repeat(32);
    decoy.vaultRemains[String(fx.row.epoch + 1)] = { [String(fx.remain)]: true };
    const opened = proofOpens(fx.later, {
      bps: GENESIS_BPS, span, remain: fx.remain, earnEpoch: fx.row.epoch + 1,
    });
    assert.equal(opened.ok, true, opened.reason);
    const stale = applyClaim(
      decoy,
      rewardClaimTx({ to: fx.payTo, vault: fx.later, id: 'stale-root' }),
      fx.proved.rootHex,
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'unsigned');
    assert.equal(Number(decoy.mintBankNanos), 0);

    const paidState = cloneVault(fx.state);
    const paid = applyClaim(paidState, honest, fx.proved.rootHex, fx.proved);
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(Number(paid.find((row) => row.action === 'reward-claim').nanos), 0);
    assert.equal(Number(paidState.mintBankNanos), fx.proved.nanos);
  });

  it('refuses a forged bps, span, remain, and epoch on the block', async () => {
    const fx = await forgedFixture();
    const cases = [
      {
        id: 'forged-bps',
        proof: fx.bpsProof,
        terms: { bps: GENESIS_BPS + 1, span, remain: fx.remain, earnEpoch: fx.row.epoch },
      },
      {
        id: 'forged-span',
        proof: fx.spanProof,
        terms: { bps: GENESIS_BPS, span: span + 1, remain: fx.remain, earnEpoch: fx.row.epoch },
      },
      {
        id: 'forged-epoch',
        proof: fx.later,
        terms: { bps: GENESIS_BPS, span, remain: fx.remain, earnEpoch: fx.row.epoch + 1 },
      },
    ];
    for (const item of cases) {
      const opened = proofOpens(item.proof, item.terms);
      assert.equal(opened.ok, true, item.id);
      const tx = rewardClaimTx({ to: fx.payTo, vault: item.proof, id: item.id });
      tx.rootEpoch = fx.row.epoch;
      tx.earnEpoch = fx.row.epoch;
      const state = cloneVault(fx.state);
      const got = applyClaim(state, tx, fx.proved.rootHex);
      assert.equal(got.ok, false, item.id);
      assert.equal(got.reason, 'stake_reward', item.id);
      assert.equal(Number(state.mintBankNanos), 0, item.id);
    }

    const short = fx.remain - 5000;
    assert.ok(short > 0);
    const recorded = cloneVault(fx.state);
    recorded.vaultRemains[String(fx.row.epoch)] = { [String(short)]: true };
    const inflated = vaultRewardNanos(PI_SHE_NANOS, GENESIS_BPS, fx.remain, span);
    const capped = vaultRewardNanos(PI_SHE_NANOS, GENESIS_BPS, short, span);
    assert.ok(inflated.nanos > capped.nanos);
    const remainTx = rewardClaimTx({ to: fx.payTo, vault: fx.proved, id: 'forged-remain' });
    const remain = applyClaim(recorded, remainTx, fx.proved.rootHex);
    assert.equal(remain.ok, false);
    assert.equal(remain.reason, 'stake_reward');
    assert.equal(Number(recorded.mintBankNanos), 0);
  });

  it('refuses a forged nullifier and a second claim or roll of that leaf', async () => {
    const fx = await forgedFixture();
    assert.notEqual(fx.later.nullifier, fx.proved.nullifier);
    const other = rewardClaimTx({ to: fx.payTo, vault: fx.later, id: 'other-epoch-nullifier' });
    other.rootEpoch = fx.row.epoch;
    other.earnEpoch = fx.row.epoch;
    const wrongEpoch = applyClaim(cloneVault(fx.state), other, fx.proved.rootHex);
    assert.equal(wrongEpoch.ok, false);
    assert.equal(wrongEpoch.reason, 'stake_reward');

    const swapped = rewardClaimTx({ to: fx.payTo, vault: fx.proved, id: 'swapped-nullifier' });
    swapped.nullifier = fx.later.nullifier;
    const badNf = applyClaim(cloneVault(fx.state), swapped, fx.proved.rootHex);
    assert.equal(badNf.ok, false);
    assert.equal(badNf.reason, 'unsigned');
    assert.equal(Number(fx.state.mintBankNanos), 0);

    const once = cloneVault(fx.state);
    const paid = applyClaim(once, rewardClaimTx({ to: fx.payTo, vault: fx.proved, id: 'claim-once' }), fx.proved.rootHex, fx.proved);
    assert.equal(paid.ok, true, paid.reason);
    const twice = applyClaim(once, rewardClaimTx({ to: fx.payTo, vault: fx.proved, id: 'claim-twice' }), fx.proved.rootHex);
    assert.equal(twice.ok, false);
    assert.equal(twice.reason, 'double_mint');
    assert.equal(Number(once.mintBankNanos), fx.proved.nanos);

    const rolled = cloneVault(fx.state);
    const didRoll = applyClaim(rolled, zkRoll(fx.lockDest, fx.proved, 'roll-first'), fx.proved.rootHex);
    assert.equal(didRoll.ok, true, didRoll.reason);
    const claimAfter = applyClaim(rolled, rewardClaimTx({ to: fx.payTo, vault: fx.proved, id: 'claim-after-roll' }), fx.proved.rootHex);
    assert.equal(claimAfter.ok, false);
    assert.equal(claimAfter.reason, 'double_mint');

    const claimed = cloneVault(fx.state);
    const didClaim = applyClaim(claimed, rewardClaimTx({ to: fx.payTo, vault: fx.proved, id: 'claim-first' }), fx.proved.rootHex, fx.proved);
    assert.equal(didClaim.ok, true, didClaim.reason);
    const rollAfter = applyClaim(claimed, zkRoll(fx.lockDest, fx.proved, 'roll-after'), fx.proved.rootHex);
    assert.equal(rollAfter.ok, false);
    assert.equal(rollAfter.reason, 'double_mint');
  });

  it('counts claim weight and refuses a fifth vault claim in the block', async () => {
    const fx = await forgedFixture();
    const claim = rewardClaimTx({ to: fx.payTo, vault: fx.proved, id: 'claim-weight' });
    const plain = { ...claim, id: 'claim-plain' };
    delete plain.vaultProof;
    assert.equal(txVerifyWeight(claim), W_TX + fs1VerifyWeight(1) + W_OUT);
    assert.ok(txVerifyWeight(claim) > txVerifyWeight(plain));
    const many = [];
    for (let i = 0; i < MAX_BLOCK_VAULT_CLAIMS + 1; i += 1) {
      many.push({ ...claim, id: `forged-cap-${i}` });
    }
    const budget = blockBudget([{ coinbase: true, vout: [] }, ...many]);
    assert.equal(budget.ok, false);
    assert.equal(budget.reason, 'claim_cap');
    const over = applyReserveBlock({
      state: cloneVault(fx.state),
      block: {
        height: HEIGHT,
        txs: [{ coinbase: true, vout: [], vaultLockRoot: fx.proved.rootHex }, ...many],
      },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'claim_cap');
    assert.equal(Number(fx.state.mintBankNanos), 0);
    const one = applyClaim(cloneVault(fx.state), claim, fx.proved.rootHex, fx.proved);
    assert.equal(one.ok, true, one.reason);
  });

  it('refuses a supply-walk claim at the wrong height and a foreign network id', async () => {
    const fx = await forgedFixture();
    const claim = rewardClaimTx({ to: fx.payTo, vault: fx.proved, id: 'supply-height' });
    const openedMint = proveEpochMint(fx.proved.nanos, fx.proved.rewardBlind);
    const coinbase = {
      coinbase: true,
      vout: [],
      vaultLockRoot: fx.proved.rootHex,
      epochMint: openedMint.nanos,
      epochMintProof: openedMint.proof,
    };
    const early = stakeRewardSupply(fx.state, {
      height: HEIGHT,
      txs: [coinbase, claim],
    }, at, HEIGHT - 1);
    assert.equal(early.ok, false);
    const fromBlock = stakeRewardSupply(fx.state, {
      height: HEIGHT - 1,
      txs: [coinbase, { ...claim, id: 'supply-block-height' }],
    }, at);
    assert.equal(fromBlock.ok, false);

    const opened = proofOpens(fx.foreign, termsOf(fx.remain, fx.row.epoch), 'shear-other-net');
    assert.equal(opened.ok, true, opened.reason);
    const foreignTx = rewardClaimTx({ to: fx.payTo, vault: fx.foreign, id: 'foreign-net' });
    const foreign = applyClaim(cloneVault(fx.state), foreignTx, fx.proved.rootHex);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.reason, 'unsigned');
    assert.equal(Number(fx.state.mintBankNanos), 0);
    const walked = stakeRewardSupply(fx.state, {
      height: HEIGHT,
      txs: [coinbase, foreignTx],
    }, at, HEIGHT);
    assert.equal(walked.ok, false);

    const paid = stakeRewardSupply(fx.state, {
      height: HEIGHT,
      txs: [coinbase, claim],
    }, at, HEIGHT);
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.claimed, BigInt(fx.proved.nanos));
  });

  it('keeps the wallet prover and drops the anonymity-set line', () => {
    const copy = readFileSync(new URL('../wallet/lib/shear_reserve.dart', import.meta.url), 'utf8');
    const screen = readFileSync(new URL('../wallet/lib/main.dart', import.meta.url), 'utf8');
    const sentence = 'The anonymity set for a claim or a roll is the vault-lock set, never the full chain.';
    assert.equal(copy.includes(sentence), false);
    assert.equal(screen.includes(sentence), false);
    assert.equal(copy.includes('kReserveAnonymitySet'), false);
    assert.equal(screen.includes('kReserveAnonymitySet'), false);
    assert.equal(screen.includes("Key('reserve-anonymity-set')"), false);
    assert.equal(copy.includes('full chain admit'), false);
    assert.equal(copy.includes('does not build this proof'), false);
    const prover = readFileSync(new URL('../wallet/lib/shear_vault_reward.dart', import.meta.url), 'utf8');
    const pack = readFileSync(new URL('../wallet/lib/shear_pack.dart', import.meta.url), 'utf8');
    assert.match(prover, /proveVaultLockReward/);
    assert.match(prover, /fs1_prover_unavailable/);
    assert.match(prover, /admit_native_required/);
    assert.match(prover, /shear-vault-lock-blind-v1/);
    assert.match(prover, /shear-vault-null-key-v1/);
    assert.match(prover, /shear-vault-null-prf-v1/);
    assert.match(prover, /shear-vault-reward-bal-v1/);
    assert.match(prover, /0xa2/);
    assert.equal(prover.includes('shear-vault-lock-null-v1'), false);
    assert.match(prover, /scalarFromBigInt/);
    assert.match(prover, /BigInt\.one << 110/);
    assert.match(screen, /proveVaultLockRewardWire/);
    assert.match(screen, /postReserveVaultClaim/);
    assert.match(copy, /proveVaultLockRewardWire/);
    assert.match(copy, /'rootEpoch': p\.lockEpoch/);
    assert.match(copy, /'earnEpoch': p\.lockEpoch/);
    assert.match(pack, /shear-reward-owner-v1/);
  });

  it('hides the lock amount, mints only the epoch total, and caps that total', async () => {
    const lockDest = freshDest();
    const payTo = encodeDest(Buffer.alloc(20, 0x61));
    const dest20 = hash20FromAddress(payTo);
    const booked = openVault(lockDest);
    const plan = rewardCommitment(booked, at);
    const row = plan.rows[0];
    const remain = Number(booked.portals[row.portalId].tranches[0].remainMs);
    assert.equal(proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
      rootEpoch: plan.index,
      earnEpoch: row.epoch,
      bps: GENESIS_BPS,
      remainMs: remain,
      span,
      dest20,
    }), null);
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
      rootEpoch: row.epoch,
      earnEpoch: row.epoch,
      bps: GENESIS_BPS,
      remainMs: remain,
      span,
      dest20,
    });
    assert.ok(proved);
    const amountBytes = Buffer.alloc(8);
    amountBytes.writeBigUInt64LE(BigInt(PI_SHE_NANOS));
    const rewardBytes = Buffer.alloc(8);
    rewardBytes.writeBigUInt64LE(BigInt(proved.nanos));
    const blob = Buffer.from(proved.blob);
    assert.equal(blob.includes(amountBytes), false);
    assert.equal(blob.includes(rewardBytes), false);
    const state = openVault(lockDest);
    plantLocks(state, proved, remain, row.epoch);
    const portal = state.portals[portalIdFromDest(lockDest)];
    portal.tranches[0].vaultLocked = true;
    const claim = rewardClaimTx({ to: payTo, vault: proved, id: 'hidden-claim' });
    assert.equal(claim.nanos, 0);
    claim.nanos = 1;
    const bare = applyClaim(cloneVault(state), claim, proved.rootHex);
    assert.equal(bare.ok, false);
    assert.equal(bare.reason, 'stake_reward');
    const lied = claimBlock(claim, proved.rootHex, HEIGHT, proved);
    lied.txs[0].epochMint = proved.nanos + 1;
    lied.txs[0].epochMintProof = proveEpochMint(proved.nanos + 1, proved.rewardBlind).proof;
    const lie = applyReserveBlock({ state: cloneVault(state), block: lied, nowMs: at, genesisMs: T0 });
    assert.equal(lie.ok, false);
    assert.equal(lie.reason, 'stake_reward');
    const low = cloneVault(state);
    low.epochRewardDue[String(row.epoch)] = String(proved.nanos - 1);
    const overCap = applyClaim(low, { ...claim, id: 'over-cap' }, proved.rootHex, proved);
    assert.equal(overCap.ok, false);
    assert.equal(overCap.reason, 'epoch_cap');
    const fit = cloneVault(state);
    fit.epochRewardDue[String(row.epoch)] = String(proved.nanos);
    const paid = applyClaim(fit, { ...claim, id: 'fit-cap' }, proved.rootHex, proved);
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(Number(fit.mintBankNanos), proved.nanos);
    assert.equal(fit.mintedIds[proved.nullifier], true);
    const split = rewardClaimTx({ to: payTo, vault: proved, id: 'split-epoch' });
    split.earnEpoch = row.epoch + 1;
    const splitState = cloneVault(state);
    splitState.vaultRemains[String(row.epoch + 1)] = { [String(remain)]: true };
    splitState.vaultLockRoots[String(row.epoch + 1)] = proved.rootHex;
    const refused = applyClaim(splitState, split, proved.rootHex, proved);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');

    const fs1Len = blob.readUInt32LE(1);
    const tag = blob.subarray(5 + fs1Len + 1, 5 + fs1Len + 33);
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(BigInt(row.epoch));
    const oldNf = createHash('sha256').update('shear-vault-lock-null-v1').update(tag).update(epochBuf).digest('hex');
    assert.notEqual(oldNf, proved.nullifier);
    const old = rewardClaimTx({ to: payTo, vault: proved, id: 'old-nullifier' });
    old.nullifier = oldNf;
    const oldPaid = applyClaim(cloneVault(state), old, proved.rootHex, proved);
    assert.equal(oldPaid.ok, false);
    assert.equal(oldPaid.reason, 'unsigned');

    const roll = rollTx({ from: lockDest, id: 'hidden-roll' });
    assert.equal(roll.portalId, undefined);
    assert.equal(Buffer.from(proved.blob).includes(Buffer.from(portal.id, 'hex')), false);

    const owner = newIdentity();
    const ownerPub = Buffer.from(owner.spendPub).toString('hex');
    const owned = openVault(lockDest);
    owned.portals[portal.id].ownerPub = ownerPub;
    owned.portals[portal.id].tranches[0].vaultLocked = true;
    plantLocks(owned, proved, remain, row.epoch);
    const firstOut = encodeDest(Buffer.alloc(20, 0x62));
    const preview = previewWithdraw(owned, lockDest, at);
    const wd = withdrawTx({ from: lockDest, to: firstOut, nanos: preview.payout, id: 'wd-first' });
    wd.nullifier = proved.nullifier;
    signWithdrawReward(wd, owner.privateKey, {
      portalId: portal.id,
      nanos: proved.nanos,
      dest: firstOut,
      epoch: 1,
      tranches: owned.portals[portal.id].tranches,
    });
    const withdrew = applyReserveBlock({
      state: owned,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, wd] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(withdrew.ok, true, withdrew.reason);
    assert.equal(withdrew.find((item) => item.action === 'withdraw').interest, proved.nanos);
    assert.equal(owned.mintedIds[proved.nullifier], true);
    const afterWd = applyClaim(
      owned,
      rewardClaimTx({ to: payTo, vault: proved, id: 'claim-after-wd' }),
      proved.rootHex,
      proved,
    );
    assert.equal(afterWd.ok, false);
    assert.equal(afterWd.reason, 'double_mint');
    assert.equal(Number(owned.mintBankNanos), proved.nanos);

    const claimedFirst = cloneVault(state);
    claimedFirst.portals[portal.id].tranches[0].vaultLocked = true;
    const did = applyClaim(
      claimedFirst,
      rewardClaimTx({ to: payTo, vault: proved, id: 'claim-then-wd' }),
      proved.rootHex,
      proved,
    );
    assert.equal(did.ok, true, did.reason);
    const secondOut = encodeDest(Buffer.alloc(20, 0x63));
    const laterWd = withdrawTx({ from: lockDest, to: secondOut, nanos: PI_SHE_NANOS, id: 'wd-after-claim' });
    laterWd.nullifier = proved.nullifier;
    const principalOnly = applyReserveBlock({
      state: claimedFirst,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, laterWd] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(principalOnly.ok, true, principalOnly.reason);
    assert.equal(principalOnly.find((item) => item.action === 'withdraw').interest, 0);
    assert.equal(Number(claimedFirst.mintBankNanos), proved.nanos);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(lockDest, PI_SHE_NANOS, T0))).ok, true);
    const stored = await callReserve(session, encodeCommitRewards(at, proved.rootHex));
    assert.equal(stored.ok, true, stored.reason);
    assert.equal(decodeBytes32(stored.returnValue), proved.rootHex);
    const foreign = proveVaultReward({
      locks: proved.locks,
      which: 0,
      rootEpoch: row.epoch,
      earnEpoch: row.epoch,
      bps: GENESIS_BPS,
      remainMs: remain,
      span,
      dest20,
      magic: 'shear-other-net',
    });
    assert.ok(foreign);
    const evmForeign = await callReserve(
      session,
      encodeClaim(foreign.nullifier, 0, row.epoch, foreign.blob, packVaultOutput(foreign.note)),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmForeign.ok, false);
    const badOut = packVaultOutput(proved.note);
    badOut[0] ^= 0x01;
    const evmOut = await callReserve(
      session,
      encodeClaim(proved.nullifier, 0, row.epoch, proved.blob, badOut),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmOut.ok, false);
    const evmPaid = await callReserve(
      session,
      encodeClaim(proved.nullifier, 0, row.epoch, proved.blob, packVaultOutput(proved.note)),
      { blockNumber: HEIGHT },
    );
    assert.equal(evmPaid.ok, true, evmPaid.reason);
    assert.equal(word(evmPaid.returnValue), 1n);
  });
});

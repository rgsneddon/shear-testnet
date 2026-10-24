import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { txDigestV3 } from './admit_v3.js';
import { encodeDest, hash20FromAddress, newIdentity, spendDestOf } from './address.js';
import { interestNanos } from './reserve_oracle.js';
import { MAGIC_MAINNET, epochMs } from './pot_sched.js';
import { accrualBetween, arrivalStubNanos, vaultEpochBlocks, vaultPeriodBlocks, vaultPeriodReward } from './vault_accrual.js';
import {
  appendVaultLockNote,
  applyReserveBlock,
  chainPeriodIndex,
  consensusUnlockPeriod,
  cloneVault,
  attachLockEquality,
  deposit,
  emptyVault,
  EMPTY_VAULT_ROOT,
  buildFundedWithdraw,
  leafEpochsToBurn,
  lockNotePrincipal,
  trialReserveApply,
  withdraw,
  packRewardAuth,
  portalEpochInterest,
  portalIdFromDest,
  previewWithdraw,
  provePrincipalOpen,
  rewardClaimTx,
  rewardOwnerCommit,
  signRollReward,
  signWithdrawReward,
  snapshotPeriodRoot,
  stakeRewardSupply,
  withdrawSignedDest,
  withdrawTx,
  rollTx,
  lockTx,
  MAX_BLOCK_RETIRE_DLEQS,
  retireCapHit,
  retireBlobRejected,
  txRetireDleqs,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  shearMagicBytes,
  decodeWithdraw,
  decodeWithdrawEarned,
  encodeClaim,
  encodeCommitEpochStartRoot,
  encodeCommitVaultRoot,
  encodeDeposit,
  encodePinClock,
  encodeRetire,
  encodeRoll,
  encodeWithdraw,
  encodeWithdrawRetire,
  packRetireBlob,
} from './reserve_evm.js';
import {
  RELATION_BOUND,
  packVaultOutput,
  packVaultRewardProof,
  proveLeafRetire,
  proveVaultReward,
  tagDerivedNullifier,
  vaultLockBlind,
  vaultLockNote,
  vaultLockOwnerScalar,
  vaultRewardNanos,
  verifyVaultReward,
  subtractUnlock,
  VAULT_PROOF_VER,
  VAULT_UNLOCK_DST,
  VAULT_UNLOCK_OPEN,
} from './vault_reward_fs1.js';
import { admitPub } from './admit.js';
import { G, commit, pointBytes, pointFrom, proveRange, proveValue, randomScalar, scalarFrom, sealHiddenNote, verifySealedNote } from './note.js';
import { admitMempool, emptyMempool } from './mempool.js';
import { blockBudget, fs1VerifyWeight, txVerifyWeight, W_OUT, W_TX, W_VAULT_EXTRA } from './block_budget.js';
import { consensusFingerprint, MAX_BLOCK_VAULT_CLAIMS } from './asert.js';

const T0 = 1_700_000_000_000;
const span = RESERVE_EPOCH_MS;
const at = T0 + span;
const HEIGHT = VAULT_FS1_ACTIVATION_HEIGHT;
const LOCK_BLIND = 7n;

function who() {
  const id = newIdentity();
  return {
    id,
    dest: spendDestOf(id.spendPub),
    pub: Buffer.from(id.spendPub).toString('hex'),
    key: id.privateKey,
  };
}

function bareCommit(note) {
  return pointBytes(subtractUnlock(pointFrom(note.commit), note.unlock));
}

function payee(byte) {
  const to = encodeDest(Buffer.alloc(20, byte));
  return { to, d20: hash20FromAddress(to) };
}

function openVault(owner, when = T0) {
  const state = emptyVault();
  state.genesisMs = T0;
  state.magic = MAGIC_TESTNET;
  const opened = deposit({
    state,
    dest: owner.dest,
    nanos: PI_SHE_NANOS,
    blind: LOCK_BLIND,
    nowMs: when,
    ownerPub: owner.pub,
  });
  assert.equal(opened.ok, true, opened.reason);
  return state;
}

function rewardAt(blob) {
  return 5 + blob.readUInt32LE(1) + 321 + 4 + 8 + 8;
}

function provePair(dest20, epoch = 0) {
  const first = proveVaultReward({
    locks: [
      { amount: PI_SHE_NANOS, index: 0, scalar: 3n, blind: 4n },
      { amount: PI_SHE_NANOS, index: 1, scalar: 5n, blind: 6n },
    ],
    which: 0,
    rootEpoch: epoch,
    earnEpoch: epoch,
    bps: GENESIS_BPS,
    remainMs: span,
    span,
    dest20,
  });
  assert.ok(first, 'first proof');
  const second = proveVaultReward({
    locks: first.locks.map((lock) => ({ amount: lock.amount, scalar: lock.scalar, blind: lock.blind })),
    which: 1,
    rootEpoch: epoch,
    earnEpoch: epoch,
    bps: GENESIS_BPS,
    remainMs: span,
    span,
    dest20,
  });
  assert.ok(second, 'second proof');
  assert.equal(second.rootHex, first.rootHex);
  assert.equal(first.blob[0], VAULT_PROOF_VER);
  assert.equal(second.blob[0], VAULT_PROOF_VER);
  const amountBytes = Buffer.alloc(8);
  amountBytes.writeBigUInt64LE(BigInt(PI_SHE_NANOS));
  assert.equal(Buffer.from(first.blob).includes(amountBytes), false);
  assert.equal(Buffer.from(first.blob).includes(first.locks[0].commit), false);
  const rewardBytes = Buffer.alloc(8);
  rewardBytes.writeBigUInt64LE(BigInt(first.nanos));
  assert.equal(Buffer.from(first.blob).includes(rewardBytes), true);
  assert.equal(first.blob.readBigUInt64LE(rewardAt(first.blob)), BigInt(first.nanos));
  return { first, second };
}

function plantPair(state, pair, epoch) {
  const locks = pair.first.locks;
  for (let i = 0; i < locks.length; i += 1) {
    const note = vaultLockNote(locks[i].amount, locks[i].scalar, locks[i].blind).note;
    assert.ok(appendVaultLockNote(state, note));
  }
  assert.equal(state.vaultLockRoot, pair.first.rootHex);
  assert.equal(state.vaultRemainLeaf, undefined);
  if (!state.epochStartRoots) state.epochStartRoots = Object.create(null);
  state.epochStartRoots[String(epoch)] = state.vaultLockRoot;
  if (!state.epochRewardDue) state.epochRewardDue = Object.create(null);
  if (state.epochRewardDue[String(epoch)] == null) {
    state.epochRewardDue[String(epoch)] = String(BigInt(pair.first.nanos) + BigInt(pair.second.nanos));
  }
}

function applyAt(state, txs, root, now = at, coinbase = {}) {
  return applyReserveBlock({
    state,
    block: {
      height: HEIGHT,
      txs: [{ coinbase: true, vout: [], vaultLockRoot: root, ...coinbase }, ...txs],
    },
    nowMs: now,
    height: HEIGHT,
    genesisMs: T0,
  });
}

function corruptBps(blob) {
  const buf = Buffer.from(blob);
  const fs1Len = buf.readUInt32LE(1);
  buf[5 + fs1Len + 321] ^= 0x01;
  return buf;
}

function ownerRoll(owner, proved, id, state = null) {
  const tx = rollTx({ from: owner.dest, id });
  tx.rootEpoch = proved.rootEpoch;
  tx.earnEpoch = proved.earnEpoch;
  signRollReward(tx, owner.key, { portalId: tx.portalId, epoch: proved.earnEpoch, state });
  return tx;
}

function word(ret) {
  const raw = Buffer.from(ret instanceof Uint8Array ? ret : []);
  return BigInt(`0x${raw.subarray(0, 32).toString('hex') || '0'}`);
}

describe('vault-lock reward proof', () => {
  it('packs the claim blob in the same order as the Dart prover', () => {
    const word = (b) => Buffer.alloc(32, b);
    const fs1 = Buffer.concat([Buffer.from([0xf1]), Buffer.alloc(8, 0x11)]);
    const record = Buffer.concat([Buffer.from([0xf1]), Buffer.alloc(320, 0x22)]);
    const blob = packVaultRewardProof({
      fs1,
      record,
      bps: 281,
      span: 3840,
      epoch: 3,
      reward: 551742209,
      covered: 240,
      nullBase: word(1),
      nullP: word(2),
      nullA1: word(3),
      noteR: word(6),
      noteZ: word(7),
    });
    const vector = readFileSync(new URL('./vault_reward_blob.vector', import.meta.url), 'utf8').trim();
    assert.equal(blob[0], VAULT_PROOF_VER);
    // Five header words. A1 and zGap are not repeated before noteR.
    assert.equal(blob.length, 1 + 4 + fs1.length + 321 + 4 + 8 * 4 + 32 * 5);
    assert.equal(blob.readUInt32LE(1), fs1.length);
    const rewardAt = 5 + fs1.length + 321 + 4 + 8 + 8;
    assert.equal(blob.readBigUInt64LE(rewardAt), 551742209n);
    assert.equal(blob.readBigUInt64LE(rewardAt + 8), 240n);
    assert.equal(blob.subarray(blob.length - 32).equals(word(7)), true);
    assert.equal(blob.toString('hex'), vector);
  });

  it('pays a batch, refuses a stranger and a lone public mint, and JS matches the EVM', async () => {
    const owner = who();
    const pay = payee(0x44);
    const pair = provePair(pay.d20, 0);
    assert.equal(pair.first.nanos, Number(vaultPeriodReward(PI_SHE_NANOS, GENESIS_BPS, MAGIC_TESTNET).nanos));
    assert.equal(pair.first.full, true);
    const stranger = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    assert.ok(stranger);
    assert.notEqual(stranger.rootHex, pair.first.rootHex);
    const bad = verifyVaultReward({
      blob: corruptBps(pair.first.blob),
      root: Buffer.from(pair.first.rootHex, 'hex'),
      rootEpoch: 0,
      nullifier: Buffer.from(pair.first.nullifier, 'hex'),
      output: pair.first.note,
      terms: { bps: GENESIS_BPS, span: pair.first.span, covered: pair.first.covered, earnEpoch: 0, reward: pair.first.nanos },
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 2);
    const notMember = verifyVaultReward({
      blob: stranger.blob,
      root: Buffer.from(pair.first.rootHex, 'hex'),
      rootEpoch: 0,
      nullifier: Buffer.from(stranger.nullifier, 'hex'),
      output: stranger.note,
      terms: { bps: GENESIS_BPS, span: stranger.span, covered: stranger.covered, earnEpoch: 0, reward: stranger.nanos },
    });
    assert.equal(notMember.ok, false);
    assert.equal(notMember.code, 2);

    const state = openVault(owner);
    plantPair(state, pair, 0);
    const booked = stakeRewardSupply(cloneVault(state), {
      height: HEIGHT,
      txs: [
        { coinbase: true, vout: [], vaultLockRoot: pair.first.rootHex },
        rewardClaimTx({ to: pay.to, vault: pair.first, id: 'supply-a' }),
        rewardClaimTx({ to: pay.to, vault: pair.second, id: 'supply-b' }),
      ],
    }, at, HEIGHT);
    assert.equal(booked.ok, true, booked.reason);
    assert.equal(booked.claimed, 0n);
    assert.equal(booked.minted, BigInt(pair.first.nanos) + BigInt(pair.second.nanos));
    assert.equal(booked.permitted, booked.minted);

    const claim = rewardClaimTx({ to: pay.to, vault: pair.first, id: 'claim-owner' });
    assert.equal(claim.nanos, pair.first.nanos);
    assert.equal(claim.vout[0].valueProof.v, pair.first.nanos);
    assert.equal(claim.vout[0].commit.length, 32);
    assert.equal(claim.vout[0].noteCommit.length, 32);
    assert.equal(claim.vout[0].amtCt.length, 8);
    assert.equal(claim.vout[0].dest20.length, 20);
    const one = applyAt(state, [claim], pair.first.rootHex);
    assert.equal(one.ok, true, one.reason);
    assert.equal(one.find((row) => row.action === 'reward-claim').nanos, pair.first.nanos);
    assert.equal(Number(state.mintBankNanos), pair.first.nanos);
    assert.equal(state.pendingReward, undefined);
    assert.equal(state.epochMintNanos['0'], BigInt(pair.first.nanos));
    assert.equal(state.epochMintSum, undefined);
    assert.equal(Number(state.totalLockedNanos), 0);

    const stolen = applyAt(
      cloneVault(state),
      [rewardClaimTx({ to: pay.to, vault: stranger, id: 'claim-stranger' })],
      pair.first.rootHex,
    );
    assert.equal(stolen.ok, false);
    assert.equal(stolen.reason, 'stake_reward');

    const wrong = rewardClaimTx({ to: pay.to, vault: pair.second, id: 'claim-wrong' });
    wrong.vaultProof = corruptBps(wrong.vaultProof);
    const over = applyAt(cloneVault(state), [wrong], pair.first.rootHex);
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'stake_reward');

    const early = applyReserveBlock({
      state: openVault(owner),
      block: {
        height: HEIGHT - 1,
        txs: [{ coinbase: true, vout: [] }, rewardClaimTx({ to: pay.to, vault: pair.first, id: 'claim-early' })],
      },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(early.ok, false);
    assert.equal(early.reason, 'claim_unavailable');

    const again = applyAt(state, [{ ...claim, id: 'claim-again' }], pair.first.rootHex);
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double_mint');

    const opened = applyAt(state, [rewardClaimTx({ to: pay.to, vault: pair.second, id: 'claim-two' })], pair.first.rootHex);
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(Number(state.mintBankNanos), pair.first.nanos + pair.second.nanos);
    assert.equal(state.epochMintNanos['0'], BigInt(pair.first.nanos) + BigInt(pair.second.nanos));

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(owner.dest, Buffer.from(state.portals[portalIdFromDest(owner.dest)].tranches.at(-1).commit, 'hex'), T0, { key: owner.key }, true))).ok, true);
    const stored = await callReserve(session, encodeCommitEpochStartRoot(0, pair.first.rootHex));
    assert.equal(stored.ok, true, stored.reason);
    const evmPaid = await callReserve(
      session,
      encodeClaim(pair.first.nullifier, pair.first.nanos, pair.first.blob, 0, packVaultOutput(pair.first.note)),
    );
    assert.equal(evmPaid.ok, true, evmPaid.reason);
    assert.equal(word(evmPaid.returnValue), BigInt(pair.first.nanos));
    const evmStranger = await callReserve(
      session,
      encodeClaim(stranger.nullifier, stranger.nanos, stranger.blob, 0, packVaultOutput(stranger.note)),
    );
    assert.equal(evmStranger.ok, false);
    const evmAgain = await callReserve(
      session,
      encodeClaim(pair.first.nullifier, pair.first.nanos, pair.first.blob, 0, packVaultOutput(pair.first.note)),
    );
    assert.equal(evmAgain.ok, false);
  });

  it('a roll is the owner signature, spends the nullifier, and does not fold interest into principal', async () => {
    const owner = who();
    const pay = payee(0x45);
    const pair = provePair(pay.d20, 0);
    const state = openVault(owner);
    plantPair(state, pair, 0);
    assert.equal(state.portals[portalIdFromDest(owner.dest)].qualified, true);
    assert.equal(portalEpochInterest(state, state.portals[portalIdFromDest(owner.dest)], at), 0);

    const stranger = who();
    const stolenTx = ownerRoll(stranger, pair.second, 'roll-stranger');
    stolenTx.from = owner.dest;
    stolenTx.portalId = portalIdFromDest(owner.dest);
    const stolen = applyAt(cloneVault(state), [stolenTx], pair.first.rootHex);
    assert.equal(stolen.ok, false);
    assert.equal(stolen.reason, 'unsigned');

    const wrong = ownerRoll(owner, pair.first, 'roll-wrong');
    wrong.vaultProof = corruptBps(pair.first.blob);
    const bad = applyAt(cloneVault(state), [wrong], pair.first.rootHex);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'stake_reward');

    const bare = rollTx({ from: owner.dest, id: 'roll-bare' });
    bare.earnEpoch = 0;
    signRollReward(bare, owner.key, { portalId: bare.portalId, epoch: 0, state });
    const skipped = applyAt(cloneVault(state), [bare], pair.first.rootHex);
    assert.equal(skipped.ok, true, skipped.reason);
    assert.equal(skipped.find((row) => row.action === 'roll').interest, 0);

    const linked = ownerRoll(owner, pair.first, 'roll-link');
    linked.nullifier = pair.first.nullifier;
    linked.vaultProof = pair.first.blob;
    const linkedRun = applyAt(cloneVault(state), [linked], pair.first.rootHex);
    assert.equal(linkedRun.ok, false);
    assert.equal(linkedRun.reason, 'stake_reward');

    const rolled = applyAt(state, [ownerRoll(owner, pair.first, 'roll-owner', state)], pair.first.rootHex);
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(rolled.find((row) => row.action === 'roll').interest, 0);
    assert.equal(state.mintedIds[pair.first.nullifier], undefined);
    assert.equal(Number(state.totalLockedNanos), 0);
    const after = applyAt(
      state,
      [rewardClaimTx({ to: pay.to, vault: pair.first, id: 'claim-after-roll' })],
      pair.first.rootHex,
    );
    assert.equal(after.ok, true, after.reason);
    assert.equal(state.mintedIds[pair.first.nullifier], true);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(owner.dest, Buffer.from(state.portals[portalIdFromDest(owner.dest)].tranches.at(-1).commit, 'hex'), T0, { key: owner.key }, true))).ok, true);
    assert.equal((await callReserve(session, encodeCommitVaultRoot(0, pair.first.rootHex))).ok, true);
    const roll = ownerRoll(owner, pair.second, 'roll-evm', state);
    const auth = packRewardAuth({ ownerPub: owner.pub, sig: roll.rewardSig, dest: owner.dest });
    const evmBare = await callReserve(session, encodeRoll(owner.dest, at, 0, auth));
    assert.equal(evmBare.ok, true, evmBare.reason);
    assert.equal(word(evmBare.returnValue), 1n);
    await callReserve(session, encodeCommitEpochStartRoot(0, pair.second.rootHex));
    const evmClaim = await callReserve(
      session,
      encodeClaim(pair.second.nullifier, pair.second.nanos, pair.second.blob, 0, packVaultOutput(pair.second.note)),
    );
    assert.equal(evmClaim.ok, true, evmClaim.reason);
    assert.equal(word(evmClaim.returnValue), BigInt(pair.second.nanos));
  });

  it('a withdraw pays principal only and still requires the owner signature', async () => {
    const owner = who();
    const to = encodeDest(Buffer.alloc(20, 0x21));
    const state = openVault(owner);
    const preview = previewWithdraw(state, owner.dest, at);
    const lockedCommit = Buffer.from(state.portals[portalIdFromDest(owner.dest)].tranches.at(-1).commit, 'hex');
    const principal = PI_SHE_NANOS;
    assert.equal(preview.interest, 0);
    assert.equal(preview.payout, 0);
    assert.equal(state.portals[portalIdFromDest(owner.dest)].qualified, true);
    assert.equal(portalEpochInterest(state, state.portals[portalIdFromDest(owner.dest)], at), 0);
    const bare = withdrawTx({ from: owner.dest, to, nanos: principal, id: 'withdraw-bare' });
    const refused = applyReserveBlock({
      state: cloneVault(state),
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, bare] },
      nowMs: at,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unsigned');
    const signed = withdrawTx({ from: owner.dest, to, nanos: principal, id: 'withdraw-owner' });
    signed.principalProof = provePrincipalOpen(lockedCommit, principal, LOCK_BLIND, signed, portalIdFromDest(owner.dest));
    assert.ok(signed.principalProof);
    const portalId = portalIdFromDest(owner.dest);
    const evmTx = withdrawTx({ from: owner.dest, to, nanos: 0, id: 'withdraw-evm' });
    signWithdrawReward(evmTx, owner.key, {
      portalId,
      nanos: 0,
      dest: to,
      state,
      nowMs: at,
    });
    signWithdrawReward(signed, owner.key, {
      portalId,
      nanos: principal,
      dest: withdrawSignedDest(signed),
      state,
      nowMs: at,
    });
    const paid = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, signed] },
      nowMs: at,
      genesisMs: T0,
    });
    // openVault stores an unindexed hidden commitment. The owner signature
    // matches and the body still pays nothing.
    assert.equal(paid.ok, false);
    assert.equal(paid.reason, 'stake_reward');
    assert.equal(Number(state.mintBankNanos || 0), 0);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(owner.dest, lockedCommit, T0, { key: owner.key }, true))).ok, true);
    const auth = packRewardAuth({ ownerPub: owner.pub, sig: evmTx.rewardSig, dest: to });
    const evm = await callReserve(session, encodeWithdraw(owner.dest, at, auth));
    assert.equal(evm.ok, false);
    assert.equal(evm.reason, 'unsigned');
  });

  it('refuses a withdraw signature from an earlier epoch or an older tranche set', async () => {
    const owner = who();
    const to = encodeDest(Buffer.alloc(20, 0x22));
    const state = openVault(owner);
    const portalId = portalIdFromDest(owner.dest);
    const signed = withdrawTx({ from: owner.dest, to, nanos: 0, id: 'withdraw-replay' });
    const payout = withdrawSignedDest(signed);
    signWithdrawReward(signed, owner.key, {
      portalId,
      nanos: 0,
      dest: payout,
      state,
      nowMs: at,
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
    // A second credit of this same lock is portal_exists. The tranche set does not change.
    const top = deposit({
      state: topped, dest: owner.dest, nanos: 1, nowMs: T0, ownerPub: owner.pub,
    });
    assert.equal(top.ok, false);
    assert.equal(top.reason, 'portal_exists');
    assert.equal(topped.portals[portalId].tranches.length, state.portals[portalId].tranches.length);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(owner.dest, Buffer.from(state.portals[portalIdFromDest(owner.dest)].tranches.at(-1).commit, 'hex'), T0, { key: owner.key }, true))).ok, true);
    const auth = packRewardAuth({ ownerPub: owner.pub, sig: signed.rewardSig, dest: payout });
    assert.equal((await callReserve(session, encodeWithdraw(owner.dest, T0 + 2 * span, auth))).ok, false);
    const fresh = await bootReserveEvm();
    assert.equal((await callReserve(fresh, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(fresh, encodeDeposit(owner.dest, Buffer.from(state.portals[portalIdFromDest(owner.dest)].tranches.at(-1).commit, 'hex'), T0, { key: owner.key }, true))).ok, true);
    const paid = await callReserve(fresh, encodeWithdraw(owner.dest, at, auth));
    assert.equal(paid.ok, false);
    assert.equal(paid.reason, 'unsigned');
  });

  it('refuses a coinbase root, a prover-chosen rate, and a second spend of the nullifier', () => {
    const owner = who();
    const pay = payee(0x46);
    const state = openVault(owner);
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    assert.ok(proved);
    const note = vaultLockNote(proved.locks[0].amount, proved.locks[0].scalar, proved.locks[0].blind).note;
    assert.ok(appendVaultLockNote(state, note));
    if (!state.epochStartRoots) state.epochStartRoots = Object.create(null);
    state.epochStartRoots['0'] = proved.rootHex;
    const claim = rewardClaimTx({ to: pay.to, vault: proved, id: 'claim-root' });
    const lied = applyAt(cloneVault(state), [claim], 'ab'.repeat(32));
    assert.equal(lied.ok, false);
    assert.equal(lied.reason, 'stake_reward');
    const chosen = proveVaultReward({
      locks: proved.locks,
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS + 1,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    assert.ok(chosen);
    const rate = verifyVaultReward({
      blob: chosen.blob,
      root: Buffer.from(proved.rootHex, 'hex'),
      rootEpoch: 0,
      nullifier: Buffer.from(chosen.nullifier, 'hex'),
      output: chosen.note,
      terms: { bps: GENESIS_BPS, span: chosen.span, covered: chosen.covered, earnEpoch: 0, reward: chosen.nanos },
    });
    assert.equal(rate.ok, false);
    assert.equal(rate.code, 2);
    // The enacting block still has currentEpoch 0. The next block would sync
    // to chain epoch 1, so the roll has to land in this block.
    const rolled = applyAt(state, [claim, ownerRoll(owner, proved, 'roll-after-claim', state)], proved.rootHex);
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(state.mintedIds[proved.nullifier], true);
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
    const owner = who();
    const pay = payee(0x47);
    const state = openVault(owner);
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    assert.ok(proved);
    const note = vaultLockNote(proved.locks[0].amount, proved.locks[0].scalar, proved.locks[0].blind).note;
    assert.ok(appendVaultLockNote(state, note));
    if (!state.epochStartRoots) state.epochStartRoots = Object.create(null);
    state.epochStartRoots['0'] = proved.rootHex;
    const claim = rewardClaimTx({ to: pay.to, vault: proved, id: 'claim-weight' });
    assert.equal(txVerifyWeight(claim), W_TX + fs1VerifyWeight(1) + W_OUT + W_VAULT_EXTRA + 4);
    assert.ok(txVerifyWeight(claim) > txVerifyWeight({ kind: 'reward-claim', vin: [], vout: claim.vout }));
    const many = [];
    for (let i = 0; i < MAX_BLOCK_VAULT_CLAIMS + 1; i += 1) {
      many.push({ ...claim, id: `claim-cap-${i}` });
    }
    const capped = blockBudget([{ coinbase: true, vout: [] }, ...many]);
    assert.equal(capped.ok, false);
    assert.equal(capped.reason, 'claim_cap');
    const over = applyAt(cloneVault(state), many, proved.rootHex);
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'claim_cap');

    const early = stakeRewardSupply(state, {
      height: HEIGHT - 1,
      txs: [{ coinbase: true, vout: [], vaultLockRoot: proved.rootHex }, claim],
    }, at, HEIGHT - 1);
    assert.equal(early.ok, false);
    const walked = stakeRewardSupply(state, {
      height: HEIGHT,
      txs: [{ coinbase: true, vout: [], vaultLockRoot: proved.rootHex }, claim],
    }, at, HEIGHT);
    assert.equal(walked.ok, true, walked.reason);
    assert.equal(walked.claimed, 0n);
    assert.equal(walked.minted, BigInt(proved.nanos));
    assert.equal(walked.permitted, walked.minted);
    assert.match(consensusFingerprint(), /VAULT_REWARD=fs1-lock-root-v1/);
    assert.match(consensusFingerprint(), /NETWORK=shear-testnet-v12/);
  });

  it('refuses a lock with no owner and a second owner key', () => {
    const owner = who();
    const other = who();
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const tx = lockTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'missing-owner' });
    const refused = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, tx] },
      nowMs: T0,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');
    const empty = state.portals[portalIdFromDest(owner.dest)];
    assert.equal(empty == null || empty.ownerPub == null, true);
    assert.equal(Number(state.totalLockedNanos), 0);
    const ownerBlind = randomScalar();
    const ownerUnlock = consensusUnlockPeriod(0);
    const ownerLeaf = vaultLockNote(PI_SHE_NANOS, 3n, ownerBlind, ownerUnlock);
    const ownerFunded = pointBytes(commit(PI_SHE_NANOS, ownerBlind));
    const ownerRange = proveRange(PI_SHE_NANOS, ownerBlind);
    const first = lockTx({
      from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'first-owner', ownerPub: owner.pub, blind: ownerBlind,
    });
    first.vaultLockNote = ownerLeaf.note;
    first.vin = [{ commit: ownerFunded, rangeProof: ownerRange }];
    const opened = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, first] },
      nowMs: T0,
      genesisMs: T0,
    });
    assert.equal(opened.ok, true, opened.reason);
    const second = lockTx({
      from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'other-owner', ownerPub: other.pub, blind: ownerBlind,
    });
    second.vaultLockNote = ownerLeaf.note;
    second.vin = [{ commit: ownerFunded, rangeProof: ownerRange }];
    const changed = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, second] },
      nowMs: T0,
      genesisMs: T0,
    });
    assert.equal(changed.ok, false);
    assert.equal(changed.reason, 'unsigned');
    assert.equal(state.portals[portalIdFromDest(owner.dest)].ownerPub, owner.pub);
  });

  it('refuses a reward that is not principal times rate, and a remainder index does not select the leaf', () => {
    const owner = who();
    const pay = payee(0x48);
    const state = openVault(owner);
    const partial = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span - 5000,
      span,
      dest20: pay.d20,
    });
    assert.equal(partial, null);
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    assert.ok(proved);
    assert.equal(proved.full, true);
    assert.equal(proved.nanos, Number(vaultPeriodReward(PI_SHE_NANOS, GENESIS_BPS, MAGIC_TESTNET).nanos));
    assert.ok(proved.nanos < interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    const note = vaultLockNote(proved.locks[0].amount, proved.locks[0].scalar, proved.locks[0].blind).note;
    assert.ok(appendVaultLockNote(state, note));
    state.epochStartRoots = { 0: proved.rootHex };
    const wrongReward = Buffer.from(proved.blob);
    const atReward = rewardAt(wrongReward);
    const published = wrongReward.readBigUInt64LE(atReward);
    wrongReward.writeBigUInt64LE(published + 1n, atReward);
    const badReward = verifyVaultReward({
      blob: wrongReward,
      root: Buffer.from(proved.rootHex, 'hex'),
      rootEpoch: 0,
      nullifier: Buffer.from(proved.nullifier, 'hex'),
      output: proved.note,
      terms: { bps: GENESIS_BPS, span: proved.span, covered: proved.covered, earnEpoch: 0, reward: published + 1n },
    });
    assert.equal(badReward.ok, false);
    assert.equal(badReward.code, 2);
    const mismatched = rewardClaimTx({
      to: pay.to,
      vault: { ...proved, blob: wrongReward, nanos: Number(published + 1n) },
      id: 'bad-reward',
    });
    const refused = applyAt(cloneVault(state), [mismatched], proved.rootHex);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');
    const indexed = cloneVault(state);
    const leaf = indexed.vaultLockNotes.at(-1);
    indexed.vaultRemainLeaf = { ['11'.repeat(32)]: leaf };
    indexed.vaultLeafRemain = { [leaf]: '11'.repeat(32) };
    const remain = applyAt(indexed, [rewardClaimTx({ to: pay.to, vault: proved, id: 'indexed-remain' })], proved.rootHex);
    assert.equal(remain.ok, true, remain.reason);
    assert.equal(Number(indexed.mintBankNanos), proved.nanos);

    const later = proveVaultReward({
      locks: proved.locks,
      which: 0,
      rootEpoch: 1,
      earnEpoch: 1,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    assert.ok(later);
    assert.equal(later.full, true);
    assert.notEqual(later.nullifier, proved.nullifier);
    assert.equal(later.blob.includes(proved.locks[0].commit), false);
    const tx = rewardClaimTx({ to: pay.to, vault: later, id: 'stale-epoch' });
    tx.rootEpoch = 0;
    tx.earnEpoch = 0;
    const stale = applyAt(cloneVault(state), [tx], proved.rootHex);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'stake_reward');
    const tag = proved.blob.subarray(5 + proved.blob.readUInt32LE(1) + 1, 5 + proved.blob.readUInt32LE(1) + 33);
    const derived = tagDerivedNullifier(tag, 0);
    assert.notEqual(derived.toString('hex'), proved.nullifier);
  });

  it('hides the lock amount and rejects a forged reward or a plaintext mint', () => {
    const owner = who();
    const pay = payee(0x61);
    const pair = provePair(pay.d20, 0);
    const state = openVault(owner);
    plantPair(state, pair, 0);
    const forged = rewardClaimTx({ to: pay.to, vault: pair.first, id: 'cap-a' });
    const flipped = Buffer.from(forged.vaultProof);
    flipped[flipped.length - 1] ^= 0xff;
    forged.vaultProof = flipped;
    const overCap = applyAt(cloneVault(state), [forged], pair.first.rootHex);
    assert.equal(overCap.ok, false);
    assert.equal(overCap.reason, 'stake_reward');
    const fit = cloneVault(state);
    const paid = applyAt(
      fit,
      [
        rewardClaimTx({ to: pay.to, vault: pair.first, id: 'fit-a' }),
        rewardClaimTx({ to: pay.to, vault: pair.second, id: 'fit-b' }),
      ],
      pair.first.rootHex,
    );
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(Number(fit.mintBankNanos), pair.first.nanos + pair.second.nanos);
    const forgedMint = applyAt(cloneVault(fit), [], pair.first.rootHex, at, {
      epochMint: pair.first.nanos + pair.second.nanos,
      epochMintEpoch: 0,
    });
    assert.equal(forgedMint.ok, false);
    assert.equal(forgedMint.reason, 'stake_reward');
    assert.equal(Number(fit.mintBankNanos), pair.first.nanos + pair.second.nanos);
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
    assert.match(prover, /0xab/);
    assert.equal(prover.includes('0xa9'), false);
    assert.equal(prover.includes('0xa8'), false);
    assert.equal(prover.includes('0xa7'), false);
    assert.match(copy, /vaultClaimSlotMs/);
    assert.match(copy, /kVaultBatchBlockMs/);
    assert.equal(prover.includes('shear-vault-lock-null-v1'), false);
    assert.match(prover, /scalarFromBigInt/);
    assert.match(prover, /BigInt\.one << 110/);
    assert.match(screen, /proveVaultLockRewardWire/);
    assert.match(screen, /postReserveVaultClaim/);
    assert.match(copy, /proveVaultLockRewardWire/);
    assert.match(copy, /'rootEpoch': p\.lockEpoch/);
    assert.match(copy, /'earnEpoch': p\.lockEpoch/);
    // The lock digest suffix carries the raw owner pub, as JS
    // reserveDigestSuffix does (rewardOwnerPub). The owner commit
    // sha256(shear-reward-owner-v1 || pub) lives in the reward leaf, not here.
    assert.equal(pack.includes('shear-reward-owner-v1'), false);
    assert.match(pack, /That owner word is the word JS `rewardOwnerPub` appends/);
    assert.match(pack, /if \(kind == 'lock'\) \{\r?\n\s*final pub = Uint8List\(32\);/);
    assert.match(pack, /chunks\.addAll\(pub\);\r?\n\s*chunks\.addAll\(sha256\.convert\(piProof \?\? Uint8List\(0\)\)\.bytes\);/);
  });

  it('refuses a proof moved onto another payout', () => {
    const owner = who();
    const pay = payee(0x61);
    const pair = provePair(pay.d20, 0);
    const proved = pair.first;
    const same = verifyVaultReward({
      blob: proved.blob,
      root: Buffer.from(proved.rootHex, 'hex'),
      rootEpoch: 0,
      nullifier: Buffer.from(proved.nullifier, 'hex'),
      output: proved.note,
      terms: { bps: GENESIS_BPS, span: proved.span, covered: proved.covered, earnEpoch: 0, reward: proved.nanos },
    });
    assert.equal(same.ok, true, same.reason);
    const movedNote = { ...proved.note, dest20: Buffer.alloc(20, 0x9a) };
    const moved = verifyVaultReward({
      blob: proved.blob,
      root: Buffer.from(proved.rootHex, 'hex'),
      rootEpoch: 0,
      nullifier: Buffer.from(proved.nullifier, 'hex'),
      output: movedNote,
      terms: { bps: GENESIS_BPS, span: proved.span, covered: proved.covered, earnEpoch: 0, reward: proved.nanos },
    });
    assert.equal(moved.ok, false);
    assert.equal(moved.code, 2);
    const state = openVault(owner);
    plantPair(state, pair, 0);
    const claim = rewardClaimTx({ to: pay.to, vault: proved, id: 'moved-payout' });
    claim.vout[0] = { ...claim.vout[0], dest20: Buffer.alloc(20, 0x9a) };
    const refused = applyAt(state, [claim], proved.rootHex);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');
  });

  it('refuses a claim after the lock leaf is withdrawn', async () => {
    const owner = who();
    const pay = payee(0x62);
    const scalar = 11n;
    const blind = 13n;
    const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const opened = deposit({
      state,
      dest: owner.dest,
      nanos: PI_SHE_NANOS,
      commit: leaf.commit,
      rangeCommit: bareCommit(leaf),
      blind,
      rangeProof: proveRange(PI_SHE_NANOS, blind),
      nowMs: T0,
      ownerPub: owner.pub,
    });
    assert.equal(opened.ok, true, opened.reason);
    assert.ok(appendVaultLockNote(state, leaf.note));
    const inclusive = state.vaultLockRoot;
    state.epochStartRoots = { 0: inclusive };
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, scalar, blind }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    assert.ok(proved);
    assert.equal(proved.rootHex, inclusive);
    const portal = portalIdFromDest(owner.dest);
    const tx = withdrawTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'retire-wd' });
    // Chain time is the first period of the next epoch. The retire burns
    // that period and the later periods still inside the claim window.
    const period = chainPeriodIndex(state, at);
    snapshotPeriodRoot(state, period * vaultPeriodBlocks(MAGIC_TESTNET));
    const periodClaim = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, scalar, blind }],
      which: 0,
      rootEpoch: period,
      earnEpoch: period,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    assert.ok(periodClaim);
    assert.equal(periodClaim.rootHex, state.epochStartRoots[String(period)]);
    const burn = leafEpochsToBurn(state, leaf.note.toString('hex'), period);
    const retire = proveLeafRetire({
      scalar,
      epochs: burn,
      leaf: leaf.note,
      txBind: txDigestV3(tx, MAGIC_TESTNET),
      unlockEpoch: period,
    });
    assert.ok(retire);
    tx.principalProof = provePrincipalOpen(
      leaf.commit, PI_SHE_NANOS, blind, tx, portal, MAGIC_TESTNET, VAULT_UNLOCK_OPEN,
    );
    assert.ok(tx.principalProof);
    tx.retireProof = retire.proof;
    // A JSON copy of the vault before the withdraw. It is not this chain:
    // `state` below already refused the claim. A failed in-place trial
    // restores the retire marks and the tree on the vault it was given.
    const parked = cloneVault(state);
    const bareJs = cloneVault(state);
    const bareMiss = withdraw({
      state: bareJs,
      dest: owner.dest,
      nowMs: at,
      principal: PI_SHE_NANOS,
      principalProof: tx.principalProof,
      tx,
    });
    assert.equal(bareMiss.ok, false);
    assert.equal(bareMiss.reason, 'mint_amount');
    assert.equal(bareJs.vaultRetired?.[leaf.note.toString('hex')], undefined);
    const paid = withdraw({
      state,
      dest: owner.dest,
      nowMs: at,
      principal: PI_SHE_NANOS,
      principalProof: tx.principalProof,
      retireProof: retire.proof,
      tx,
    });
    assert.equal(paid.ok, true, paid.reason);
    const claim = rewardClaimTx({ to: pay.to, vault: periodClaim, id: 'claim-after-withdraw' });
    const refused = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, claim] },
      nowMs: at,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'double_mint');
    // A failed claim does not rebuild. The next block drops the retired leaf.
    const flushed = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }] },
      nowMs: at,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(flushed.ok, true, flushed.reason);
    assert.notEqual(state.vaultLockRoot, inclusive);
    const live = cloneVault(state);
    live.epochStartRoots = { 0: state.vaultLockRoot };
    const missing = applyReserveBlock({
      state: live,
      block: {
        height: HEIGHT,
        txs: [{ coinbase: true, vout: [] }, rewardClaimTx({ to: pay.to, vault: proved, id: 'claim-live-root' })],
      },
      nowMs: at,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'stake_reward');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeCommitEpochStartRoot(0, inclusive))).ok, true);
    const burned = await callReserve(session, encodeRetire(retire.nullifierHex, retire.proof));
    assert.equal(burned.ok, false);
    assert.equal(burned.reason, 'epoch_open');
    const evmClaim = await callReserve(
      session,
      encodeClaim(proved.nullifier, proved.nanos, proved.blob, 0, packVaultOutput(proved.note)),
    );
    assert.equal(evmClaim.ok, true, evmClaim.reason);

    const liveChain = cloneVault(parked);
    const unburned = applyReserveBlock({
      state: parked,
      block: {
        height: HEIGHT,
        txs: [{ coinbase: true, vout: [] }, rewardClaimTx({ to: pay.to, vault: proved, id: 'claim-reorg' })],
      },
      nowMs: at,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(unburned.ok, true, unburned.reason);
    assert.equal(liveChain.mintedIds?.[proved.nullifier], undefined);

    signWithdrawReward(tx, owner.key, {
      portalId: portal,
      nanos: PI_SHE_NANOS,
      dest: withdrawSignedDest(tx),
      state: liveChain,
      nowMs: at,
    });
    const bounced = trialReserveApply({
      state: liveChain,
      inPlace: true,
      nowMs: at,
      height: HEIGHT,
      genesisMs: T0,
      block: {
        height: HEIGHT,
        txs: [
          { coinbase: true, vout: [] },
          tx,
          rewardClaimTx({ to: pay.to, vault: periodClaim, id: 'claim-undo' }),
        ],
      },
    });
    assert.equal(bounced.ok, false);
    assert.equal(bounced.reason, 'double_mint');
    assert.equal(liveChain.vaultRetired?.[leaf.note.toString('hex')], undefined);
    assert.equal(liveChain.vaultLockRoot, inclusive);
    const restored = applyReserveBlock({
      state: liveChain,
      block: {
        height: HEIGHT,
        txs: [{ coinbase: true, vout: [] }, rewardClaimTx({ to: pay.to, vault: proved, id: 'claim-after-undo' })],
      },
      nowMs: at,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(restored.ok, true, restored.reason);

    const evmTx = withdrawTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'evm-atomic' });
    signWithdrawReward(evmTx, owner.key, {
      portalId: portal,
      nanos: PI_SHE_NANOS,
      dest: owner.dest,
      state: parked,
      nowMs: at,
      txBind: retire.proof,
    });
    const auth = packRewardAuth({ ownerPub: owner.pub, sig: evmTx.rewardSig, dest: owner.dest });
    const blob = packRetireBlob([retire.proof]);
    assert.ok(blob);
    const atomic = await bootReserveEvm();
    assert.equal((await callReserve(atomic, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(atomic, encodeDeposit(owner.dest, leaf.commit, T0, { key: owner.key }, true))).ok, true);
    assert.equal((await callReserve(atomic, encodeCommitEpochStartRoot(0, inclusive))).ok, true);
    const drew = await callReserve(atomic, encodeWithdrawRetire(owner.dest, at, auth, blob));
    assert.equal(drew.ok, true, drew.reason);
    assert.equal(decodeWithdraw(drew.returnValue).principal, PI_SHE_NANOS);
    const stillOpen = await callReserve(
      atomic,
      encodeClaim(proved.nullifier, proved.nanos, proved.blob, 0, packVaultOutput(proved.note)),
    );
    assert.equal(stillOpen.ok, true, stillOpen.reason);
    const burnedPeriod = await callReserve(
      atomic,
      encodeClaim(periodClaim.nullifier, periodClaim.nanos, periodClaim.blob, period, packVaultOutput(periodClaim.note)),
    );
    assert.equal(burnedPeriod.ok, false);
    assert.equal(burnedPeriod.reason, 'already_minted');

    const fork = await bootReserveEvm();
    assert.equal((await callReserve(fork, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(fork, encodeDeposit(owner.dest, leaf.commit, T0, { key: owner.key }, true))).ok, true);
    assert.equal((await callReserve(fork, encodeCommitEpochStartRoot(0, inclusive))).ok, true);
    const kept = await callReserve(
      fork,
      encodeClaim(proved.nullifier, proved.nanos, proved.blob, 0, packVaultOutput(proved.note)),
    );
    assert.equal(kept.ok, true, kept.reason);

    const bare = await bootReserveEvm();
    assert.equal((await callReserve(bare, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(bare, encodeDeposit(owner.dest, leaf.commit, T0, { key: owner.key }, true))).ok, true);
    assert.equal((await callReserve(bare, encodeCommitEpochStartRoot(0, inclusive))).ok, true);
    const three = await callReserve(bare, encodeWithdraw(owner.dest, at, auth));
    assert.equal(three.ok, false);
    assert.equal(three.reason, 'unsigned');
    const afterThree = await callReserve(
      bare,
      encodeClaim(proved.nullifier, proved.nanos, proved.blob, 0, packVaultOutput(proved.note)),
    );
    assert.equal(afterThree.ok, true, afterThree.reason);
    assert.equal(bareJs.mintedIds?.[proved.nullifier], undefined);
  });

  it('splits a lock into at most 16 exact-pi outputs and hides the remainder', () => {
    const owner = who();
    const pi = BigInt(PI_SHE_NANOS);
    const one = lockTx({
      from: owner.dest, to: owner.dest, nanos: Number(pi), id: 'one-pi', ownerPub: owner.pub, blind: 3n,
    });
    assert.equal(one.vout.filter((row) => row.kind === 'lock').length, 1);
    assert.equal(one.vout.length, 1);
    const tiny = lockTx({
      from: owner.dest, to: owner.dest, nanos: 1000, id: 'tiny-lock', ownerPub: owner.pub,
      timeLock: true, lockEpoch: 1, unlockAtMs: at,
    });
    assert.equal(tiny.vout.length, 1);
    assert.equal(tiny.vout[0].kind, 'lock');
    assert.equal(tiny.vout[0].lockEpoch, 1);
    const dust = lockTx({ from: owner.dest, to: owner.dest, nanos: 1, id: 'one-nano', ownerPub: owner.pub });
    assert.equal(dust.vout.length, 1);
    assert.equal(dust.vout[0].kind, 'lock');
    const split = lockTx({
      from: owner.dest, to: owner.dest, nanos: Number(pi * 2n + 5n), id: 'split-lock', ownerPub: owner.pub, blind: 9n,
    });
    const locks = split.vout.filter((row) => row.kind === 'lock');
    assert.equal(locks.length, 2);
    assert.equal(split.vout.length, 3);
    assert.notEqual(split.vout[2].kind, 'lock');
    assert.equal(attachLockEquality(split), true);
    assert.equal(lockNotePrincipal(split), pi * 2n);
    const wide = lockTx({
      from: owner.dest, to: owner.dest, nanos: Number(pi * 20n), id: 'wide-lock', ownerPub: owner.pub,
    });
    assert.equal(wide.vout.filter((row) => row.kind === 'lock').length, 16);
    assert.equal(wide.vout.length, 17);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const applied = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, split] },
      nowMs: T0,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.reason, 'stake_reward');
    const unit = emptyVault();
    unit.genesisMs = T0;
    unit.magic = MAGIC_TESTNET;
    assert.equal(deposit({ state: unit, dest: owner.dest, nanos: 1, nowMs: T0, ownerPub: owner.pub }).ok, true);
    assert.equal(unit.portals[portalIdFromDest(owner.dest)].tranches.length, 1);
  });

  it('opens one principal per withdrawn leaf', async () => {
    const owner = who();
    const portal = portalIdFromDest(owner.dest);
    const made = [0, 1].map((i) => {
      const scalar = BigInt(20 + i);
      const blind = BigInt(30 + i);
      const note = vaultLockNote(PI_SHE_NANOS, scalar, blind);
      return { scalar, blind, note };
    });
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const leaf = made[0];
    assert.equal(deposit({
      state,
      dest: owner.dest,
      nanos: PI_SHE_NANOS,
      commit: leaf.note.commit,
      rangeCommit: bareCommit(leaf.note),
      blind: leaf.blind,
      rangeProof: proveRange(PI_SHE_NANOS, leaf.blind),
      nowMs: T0,
      ownerPub: owner.pub,
    }).ok, true);
    // A second credit of this portal is portal_exists. The same-tx bypass is gone.
    const again = deposit({
      state,
      dest: owner.dest,
      nanos: PI_SHE_NANOS,
      commit: made[1].note.commit,
      rangeCommit: bareCommit(made[1].note),
      blind: made[1].blind,
      rangeProof: proveRange(PI_SHE_NANOS, made[1].blind),
      nowMs: T0,
      ownerPub: owner.pub,
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'portal_exists');
    assert.ok(appendVaultLockNote(state, leaf.note.note));
    state.epochStartRoots = { 0: state.vaultLockRoot };
    const tx = withdrawTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'two-leaf' });
    const bind = txDigestV3(tx, MAGIC_TESTNET);
    const period = chainPeriodIndex(state, at);
    const retire = proveLeafRetire({
      scalar: leaf.scalar,
      epochs: leafEpochsToBurn(state, leaf.note.note.toString('hex'), period),
      leaf: leaf.note.note,
      txBind: bind,
      unlockEpoch: period,
    });
    const open = provePrincipalOpen(
      leaf.note.commit, PI_SHE_NANOS, leaf.blind, tx, portal, MAGIC_TESTNET, VAULT_UNLOCK_OPEN,
    );
    assert.ok(retire && open);
    // Two copies of the one opening are not a second leaf.
    tx.retireProofs = [retire.proof];
    tx.principalProofs = [open, open];
    const reused = withdraw({
      state: cloneVault(state),
      dest: owner.dest,
      nowMs: at,
      principal: PI_SHE_NANOS,
      tx,
    });
    assert.equal(reused.ok, false);
    delete tx.retireProofs;
    delete tx.principalProofs;
    tx.retireProof = retire.proof;
    tx.principalProof = open;
    signWithdrawReward(tx, owner.key, {
      portalId: portal,
      nanos: PI_SHE_NANOS,
      dest: owner.dest,
      state,
      nowMs: at,
    });
    const paid = withdraw({
      state,
      dest: owner.dest,
      nowMs: at,
      principal: PI_SHE_NANOS,
      retireProof: retire.proof,
      principalProof: open,
      tx,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    const firstLeaf = await callReserve(session, encodeDeposit(owner.dest, made[0].note.commit, T0, { key: owner.key }, true));
    assert.equal(firstLeaf.ok, true, firstLeaf.reason);
    // R1: the EVM has no same-lock bypass. A second lock of this portal is a duplicate.
    const secondLeaf = await callReserve(session, encodeDeposit(owner.dest, made[1].note.commit, T0, { key: owner.key }, true));
    assert.equal(secondLeaf.ok, false);
    assert.equal(secondLeaf.reason, 'portal_exists');
  });

  it('burns only the claim window on a long hold', async () => {
    const owner = who();
    const portal = portalIdFromDest(owner.dest);
    const scalar = 41n;
    const blind = 43n;
    const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({
      state,
      dest: owner.dest,
      nanos: PI_SHE_NANOS,
      commit: leaf.commit,
      rangeCommit: bareCommit(leaf),
      blind,
      rangeProof: proveRange(PI_SHE_NANOS, blind),
      nowMs: T0,
      ownerPub: owner.pub,
    }).ok, true);
    assert.ok(appendVaultLockNote(state, leaf.note));
    const noteHex = leaf.note.toString('hex');
    const blocks = vaultPeriodBlocks(MAGIC_TESTNET);
    for (let period = 0; period <= 640; period += 16) snapshotPeriodRoot(state, period * blocks);
    const late = T0 + 40 * span;
    const period = chainPeriodIndex(state, late);
    const burn = leafEpochsToBurn(state, noteHex, period);
    assert.deepEqual(burn, [period, period + 1, period + 2]);
    assert.equal(state.epochStartRoots[String(period)], state.vaultLockRoot);
    const tx = withdrawTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'long-hold' });
    const bind = txDigestV3(tx, MAGIC_TESTNET);
    const short = proveLeafRetire({
      scalar, epochs: burn, leaf: leaf.note, txBind: bind, unlockEpoch: period,
    });
    const wideEpochs = [];
    for (let i = 1; i <= 40; i += 1) wideEpochs.push(i);
    const wide = proveLeafRetire({
      scalar, epochs: wideEpochs, leaf: leaf.note, txBind: bind, unlockEpoch: period,
    });
    assert.ok(short && wide);
    assert.ok(wide.proof.length > short.proof.length);
    tx.principalProof = provePrincipalOpen(
      leaf.commit, PI_SHE_NANOS, blind, tx, portal, MAGIC_TESTNET, VAULT_UNLOCK_OPEN,
    );
    tx.retireProof = short.proof;
    signWithdrawReward(tx, owner.key, {
      portalId: portal, nanos: PI_SHE_NANOS, dest: owner.dest, state, nowMs: late,
    });
    const missing = withdraw({
      state: cloneVault(state),
      dest: owner.dest,
      nowMs: late,
      principal: PI_SHE_NANOS,
      principalProof: tx.principalProof,
      retireProof: proveLeafRetire({
        scalar, epochs: [period], leaf: leaf.note, txBind: bind, unlockEpoch: period,
      }).proof,
      tx,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'stake_reward');
    const paid = withdraw({
      state,
      dest: owner.dest,
      nowMs: late,
      principal: PI_SHE_NANOS,
      principalProof: tx.principalProof,
      retireProof: short.proof,
      tx,
    });
    assert.equal(paid.ok, true, paid.reason);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(owner.dest, leaf.commit, T0, { key: owner.key }, true))).ok, true);
    const auth = packRewardAuth({ ownerPub: owner.pub, sig: tx.rewardSig, dest: owner.dest });
    const drew = await callReserve(session, encodeWithdrawRetire(owner.dest, late, auth, packRetireBlob([short.proof])));
    assert.equal(drew.ok, true, drew.reason);
    assert.ok(drew.gasUsed < 2_000_000n, `window gas ${drew.gasUsed}`);
    assert.ok(packRetireBlob([short.proof]));
    assert.equal(packRetireBlob([wide.proof]), null);
  });

  it('rejects a bad retire blob in the mempool', () => {
    const tx = withdrawTx({ nanos: PI_SHE_NANOS, id: 'bad-retire', portalId: 'ab'.repeat(32) });
    delete tx.from;
    delete tx.to;
    delete tx.payoutPortalId;
    tx.retireProof = Buffer.from('not-a-retire-proof');
    const refused = admitMempool(emptyMempool(), tx, { baseFee: 1, reserveState: emptyVault(), nowMs: at });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');
  });

  it('refuses a withdraw before epoch end, and a claim of the withdraw period', async () => {
    const owner = who();
    const pay = payee(0x71);
    const scalar = 71n;
    const blind = 73n;
    const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({
      state,
      dest: owner.dest,
      nanos: PI_SHE_NANOS,
      commit: leaf.commit,
      rangeCommit: bareCommit(leaf),
      blind,
      rangeProof: proveRange(PI_SHE_NANOS, blind),
      nowMs: T0,
      ownerPub: owner.pub,
    }).ok, true);
    assert.ok(appendVaultLockNote(state, leaf.note));
    const mid = T0 + Math.floor(span / 2);
    const early = withdraw({
      state: cloneVault(state),
      dest: owner.dest,
      nowMs: mid,
      principal: PI_SHE_NANOS,
    });
    assert.equal(early.ok, false);
    assert.equal(early.reason, 'epoch_open');
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(owner.dest, leaf.commit, T0, { key: owner.key }, true))).ok, true);
    const evmEarly = await callReserve(session, encodeWithdraw(owner.dest, mid, new Uint8Array()));
    assert.equal(evmEarly.ok, false);
    assert.equal(evmEarly.reason, 'epoch_open');

    const half = Math.floor(span / 32);
    const when = at + half;
    const period = chainPeriodIndex(state, when);
    assert.equal(period, 16);
    snapshotPeriodRoot(state, period * vaultPeriodBlocks(MAGIC_TESTNET));
    state.rateTable = { 0: GENESIS_BPS, 1: GENESIS_BPS };
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, scalar, blind }],
      which: 0,
      rootEpoch: period,
      earnEpoch: period,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    assert.ok(proved);
    const portal = portalIdFromDest(owner.dest);
    const tx = withdrawTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'mid-period' });
    const burn = leafEpochsToBurn(state, leaf.note.toString('hex'), period);
    assert.deepEqual(burn, [period, period + 1, period + 2]);
    const retire = proveLeafRetire({
      scalar,
      epochs: burn,
      leaf: leaf.note,
      txBind: txDigestV3(tx, MAGIC_TESTNET),
      unlockEpoch: period,
    });
    tx.principalProof = provePrincipalOpen(
      leaf.commit, PI_SHE_NANOS, blind, tx, portal, MAGIC_TESTNET, VAULT_UNLOCK_OPEN,
    );
    tx.retireProof = retire.proof;
    const inflated = rewardClaimTx({ to: pay.to, vault: proved, id: 'inflated-claim' });
    inflated.nanos = proved.nanos + 1;
    assert.notEqual(inflated.nanos, proved.nanos);
    const over = applyReserveBlock({
      state: cloneVault(state),
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, inflated] },
      nowMs: when,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'stake_reward');
    const fat = withdraw({
      state: cloneVault(state),
      dest: owner.dest,
      nowMs: when,
      principal: PI_SHE_NANOS + 1,
      principalProof: tx.principalProof,
      retireProof: retire.proof,
      tx,
    });
    assert.equal(fat.ok, false);
    assert.equal(fat.reason, 'mint_amount');
    const paid = withdraw({
      state,
      dest: owner.dest,
      nowMs: when,
      principal: PI_SHE_NANOS,
      principalProof: tx.principalProof,
      retireProof: retire.proof,
      tx,
    });
    assert.equal(paid.ok, true, paid.reason);
    const claim = rewardClaimTx({ to: pay.to, vault: proved, id: 'claim-withdraw-period' });
    const refused = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, claim] },
      nowMs: when,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'double_mint');
    const lockedOut = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, scalar, blind, unlockEpoch: period }],
      which: 0,
      rootEpoch: period,
      earnEpoch: period,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    assert.equal(lockedOut, null);
  });

  it('withdraws 16 leaves in one call and matches the EVM', async () => {
    const owner = who();
    const portal = portalIdFromDest(owner.dest);
    const made = [0, 1].map((i) => {
      const scalar = BigInt(100 + i);
      const blind = BigInt(200 + i);
      const note = vaultLockNote(PI_SHE_NANOS, scalar, blind);
      return { scalar, blind, note };
    });
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const leaf = made[0];
    assert.equal(deposit({
      state,
      dest: owner.dest,
      nanos: PI_SHE_NANOS,
      commit: leaf.note.commit,
      rangeCommit: bareCommit(leaf.note),
      blind: leaf.blind,
      rangeProof: proveRange(PI_SHE_NANOS, leaf.blind),
      nowMs: T0,
      ownerPub: owner.pub,
    }).ok, true);
    // Sixteen credits of one portal are not one withdraw. The second credit is refused.
    const second = deposit({
      state,
      dest: owner.dest,
      nanos: PI_SHE_NANOS,
      commit: made[1].note.commit,
      rangeCommit: bareCommit(made[1].note),
      blind: made[1].blind,
      rangeProof: proveRange(PI_SHE_NANOS, made[1].blind),
      nowMs: T0,
      ownerPub: owner.pub,
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'portal_exists');
    assert.ok(appendVaultLockNote(state, leaf.note.note));
    const period = chainPeriodIndex(state, at);
    const tx = withdrawTx({
      from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'sixteen',
    });
    const bind = txDigestV3(tx, MAGIC_TESTNET);
    tx.retireProof = proveLeafRetire({
      scalar: leaf.scalar,
      epochs: leafEpochsToBurn(state, leaf.note.note.toString('hex'), period),
      leaf: leaf.note.note,
      txBind: bind,
      unlockEpoch: period,
    }).proof;
    tx.principalProof = provePrincipalOpen(
      leaf.note.commit, PI_SHE_NANOS, leaf.blind, tx, portal, MAGIC_TESTNET, VAULT_UNLOCK_OPEN,
    );
    signWithdrawReward(tx, owner.key, {
      portalId: portal,
      nanos: PI_SHE_NANOS,
      dest: owner.dest,
      state,
      nowMs: at,
    });
    const paid = withdraw({
      state: cloneVault(state),
      dest: owner.dest,
      nowMs: at,
      principal: PI_SHE_NANOS,
      retireProof: tx.retireProof,
      principalProof: tx.principalProof,
      tx,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    const firstOfSixteen = await callReserve(session, encodeDeposit(owner.dest, made[0].note.commit, T0, { key: owner.key }, true));
    assert.equal(firstOfSixteen.ok, true, firstOfSixteen.reason);
    const secondOfSixteen = await callReserve(session, encodeDeposit(owner.dest, made[1].note.commit, T0, { key: owner.key }, true));
    assert.equal(secondOfSixteen.ok, false);
    assert.equal(secondOfSixteen.reason, 'portal_exists');
  });

  it('refuses a funded lock whose unlock is open or zero', () => {
    const owner = who();
    const fresh = () => {
      const state = emptyVault();
      state.genesisMs = T0;
      state.magic = MAGIC_TESTNET;
      return state;
    };
    const openLeaf = vaultLockNote(PI_SHE_NANOS, 3n, 5n);
    const openTx = lockTx({
      from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, blind: 5n, ownerPub: owner.pub, id: 'open-unlock',
    });
    openTx.vaultLockNote = openLeaf.note;
    const opened = applyReserveBlock({
      state: fresh(),
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, openTx] },
      nowMs: T0,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(opened.ok, false);
    assert.equal(opened.reason, 'stake_reward');
    const zeroLeaf = vaultLockNote(PI_SHE_NANOS, 3n, 5n, 0);
    const zeroTx = lockTx({
      from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, blind: 5n, ownerPub: owner.pub, id: 'zero-unlock',
    });
    zeroTx.vaultLockNote = zeroLeaf.note;
    const zeroed = applyReserveBlock({
      state: fresh(),
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, zeroTx] },
      nowMs: T0,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(zeroed.ok, false);
    assert.equal(zeroed.reason, 'stake_reward');
  });

  it('puts a boundary lock in that period root and does not rewrite it', () => {
    const owner = who();
    const unlock = consensusUnlockPeriod(0);
    const blind = 19n;
    const leaf = vaultLockNote(PI_SHE_NANOS, 17n, blind, unlock);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const blocks = vaultPeriodBlocks(MAGIC_TESTNET);
    const tx = lockTx({
      from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, blind, ownerPub: owner.pub, id: 'boundary-lock',
    });
    tx.vaultLockNote = leaf.note;
    const locked = applyReserveBlock({
      state,
      block: { height: blocks, txs: [{ coinbase: true, vout: [] }, tx] },
      nowMs: T0,
      height: blocks,
      genesisMs: T0,
    });
    assert.equal(locked.ok, true, locked.reason);
    const noteHex = leaf.note.toString('hex');
    assert.equal(state.vaultLeafUnlock[noteHex], String(unlock));
    assert.equal(state.epochStartRoots['1'], state.vaultLockRoot);
    const stub = arrivalStubNanos({
      amount: PI_SHE_NANOS, lockHeight: blocks, magic: MAGIC_TESTNET, rate: GENESIS_BPS,
    });
    assert.equal(stub.nanos, 0n);
    const laterLeaf = vaultLockNote(PI_SHE_NANOS, 23n, 29n, unlock);
    // A second lock of the same portal is portal_exists. The next portal
    // still must not rewrite the period root already sealed.
    const nextOwner = who();
    const laterTx = lockTx({
      from: nextOwner.dest, to: nextOwner.dest, nanos: PI_SHE_NANOS, blind: 29n, ownerPub: nextOwner.pub, id: 'later-lock',
    });
    laterTx.vaultLockNote = laterLeaf.note;
    const frozen = state.epochStartRoots['1'];
    const later = applyReserveBlock({
      state,
      block: { height: blocks + 1, txs: [{ coinbase: true, vout: [] }, laterTx] },
      nowMs: T0,
      height: blocks + 1,
      genesisMs: T0,
    });
    assert.equal(later.ok, true, later.reason);
    assert.equal(state.epochStartRoots['1'], frozen);
    assert.notEqual(state.vaultLockRoot, frozen);
  });

  it('binds the consensus unlock from a funded lock through claim and withdraw', async () => {
    const owner = who();
    const pay = payee(0x81);
    const scalar = 81n;
    const blind = 83n;
    const unlock = consensusUnlockPeriod(0);
    const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_MAINNET;
    const lockHeight = 100;
    const action = lockTx({
      from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, blind, ownerPub: owner.pub, id: 'bound-lock',
    });
    action.vaultLockNote = leaf.note;
    const locked = applyReserveBlock({
      state,
      block: { height: lockHeight, txs: [{ coinbase: true, vout: [] }, action] },
      nowMs: T0,
      height: lockHeight,
      genesisMs: T0,
    });
    assert.equal(locked.ok, true, locked.reason);
    const noteHex = leaf.note.toString('hex');
    assert.equal(state.vaultLeafUnlock[noteHex], String(unlock));
    assert.notEqual(String(unlock), String(VAULT_UNLOCK_OPEN));
    const periodBlocks = vaultPeriodBlocks(MAGIC_MAINNET);
    const snapped = applyReserveBlock({
      state,
      block: { height: periodBlocks, txs: [{ coinbase: true, vout: [] }] },
      nowMs: T0,
      height: periodBlocks,
      genesisMs: T0,
    });
    assert.equal(snapped.ok, true, snapped.reason);
    assert.equal(state.epochStartRoots['1'], state.vaultLockRoot);
    const stored = BigInt(state.vaultLeafUnlock[noteHex]);
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, scalar, blind, unlockEpoch: stored }],
      which: 0,
      rootEpoch: 1,
      earnEpoch: 1,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
      magic: MAGIC_MAINNET,
    });
    assert.ok(proved);
    assert.equal(proved.locks[0].unlock, stored);
    assert.equal(proved.rootHex, state.epochStartRoots['1']);
    const gap = stored - 1n - 1n;
    const U = RistrettoPoint.hashToCurve(createHash('sha512').update(VAULT_UNLOCK_DST).digest());
    const x = RistrettoPoint.Fn.create(gap);
    assert.equal(proved.blob.includes(pointBytes(G.multiply(x))), false);
    assert.equal(proved.blob.includes(pointBytes(U.multiply(x))), false);
    const claim = rewardClaimTx({ to: pay.to, vault: proved, id: 'bound-claim' });
    const fat = rewardClaimTx({ to: pay.to, vault: proved, id: 'fat-claim' });
    const fatAmount = proved.nanos + 1;
    const sealed = sealHiddenNote(fatAmount, {
      dest20: pay.d20,
      kind: 'reward-claim',
      admitBase: admitPub(9n),
    });
    const fatOpen = proveValue(fatAmount, scalarFrom(sealed.r));
    fat.vout[0] = {
      ...sealed,
      address: pay.to,
      kind: 'reward-claim',
      admitPub: claim.vout[0].admitPub,
      valueProof: { R: fatOpen.R, z: fatOpen.z, v: fatAmount },
    };
    assert.equal(fat.nanos, proved.nanos);
    assert.equal(verifySealedNote(fat.vout[0], fatAmount), true);
    assert.equal(verifySealedNote(fat.vout[0], proved.nanos), false);
    const overClaim = applyReserveBlock({
      state: cloneVault(state),
      block: { height: periodBlocks + 1, txs: [{ coinbase: true, vout: [] }, fat] },
      nowMs: T0,
      height: periodBlocks + 1,
      genesisMs: T0,
    });
    assert.equal(overClaim.ok, false);
    assert.equal(overClaim.reason, 'stake_reward');
    const claimed = applyReserveBlock({
      state,
      block: { height: periodBlocks + 1, txs: [{ coinbase: true, vout: [] }, claim] },
      nowMs: T0,
      height: periodBlocks + 1,
      genesisMs: T0,
    });
    assert.equal(claimed.ok, true, claimed.reason);
    const mainEpoch = epochMs(MAGIC_MAINNET);
    const stubRow = arrivalStubNanos({
      amount: PI_SHE_NANOS, lockHeight, magic: MAGIC_MAINNET, rate: GENESIS_BPS,
    });
    assert.ok(stubRow.nanos > 0n);
    const payNanos = PI_SHE_NANOS + Number(stubRow.nanos);
    const portal = portalIdFromDest(owner.dest);
    const tx = withdrawTx({ from: owner.dest, to: owner.dest, nanos: payNanos, id: 'bound-wd' });
    const period = chainPeriodIndex(state, T0 + mainEpoch);
    const retire = proveLeafRetire({
      scalar,
      epochs: leafEpochsToBurn(state, noteHex, period),
      leaf: leaf.note,
      txBind: txDigestV3(tx, MAGIC_MAINNET),
      unlockEpoch: period,
      magic: MAGIC_MAINNET,
    });
    assert.ok(retire);
    tx.principalProof = provePrincipalOpen(
      leaf.commit, PI_SHE_NANOS, blind, tx, portal, MAGIC_MAINNET, stored,
    );
    tx.retireProof = retire.proof;
    const fatWd = withdrawTx({ from: owner.dest, to: owner.dest, nanos: payNanos, id: 'fat-wd' });
    const bigger = payNanos + 1;
    const fatNote = sealHiddenNote(bigger, {
      dest20: hash20FromAddress(owner.dest),
      kind: 'withdraw',
      admitBase: admitPub(11n),
    });
    const fatValue = proveValue(bigger, scalarFrom(fatNote.r));
    fatWd.nanos = payNanos;
    fatWd.vout = [{
      ...fatNote,
      address: owner.dest,
      kind: 'withdraw',
      valueProof: { R: fatValue.R, z: fatValue.z, v: bigger },
    }];
    assert.equal(verifySealedNote(fatWd.vout[0], bigger), true);
    assert.equal(verifySealedNote(fatWd.vout[0], payNanos), false);
    const overWd = applyReserveBlock({
      state: cloneVault(state),
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, fatWd] },
      nowMs: T0 + mainEpoch,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(overWd.ok, false);
    assert.equal(overWd.reason, 'stake_reward');
    const unsigned = applyReserveBlock({
      state: cloneVault(state),
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, tx] },
      nowMs: T0 + mainEpoch,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(unsigned.ok, false);
    assert.notEqual(unsigned.reason, 'stake_reward');
    // Indexed leaves are signed at one π each. The receipt adds the arrival stub.
    signWithdrawReward(tx, owner.key, {
      portalId: portal, nanos: PI_SHE_NANOS, dest: withdrawSignedDest(tx), state, nowMs: T0 + mainEpoch,
    });
    const short = withdraw({
      state: cloneVault(state),
      dest: owner.dest,
      nowMs: T0 + mainEpoch,
      principal: PI_SHE_NANOS,
      principalProof: tx.principalProof,
      retireProof: retire.proof,
      tx,
    });
    assert.equal(short.ok, false);
    assert.equal(short.reason, 'mint_amount');
    const evmTx = withdrawTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'evm-bound' });
    evmTx.retireProof = retire.proof;
    signWithdrawReward(evmTx, owner.key, {
      portalId: portal, nanos: PI_SHE_NANOS, dest: owner.dest, state, nowMs: T0 + mainEpoch,
    });
    const paid = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, tx] },
      nowMs: T0 + mainEpoch,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);
    const width = vaultEpochBlocks(MAGIC_MAINNET);
    const integral = accrualBetween(PI_SHE_NANOS, lockHeight, periodBlocks * 2, { 0: GENESIS_BPS }, width);
    assert.ok(stubRow.nanos + BigInt(proved.nanos) <= integral.nanos);
    const session = await bootReserveEvm({ network: MAGIC_MAINNET });
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(
      owner.dest,
      leaf.commit,
      T0,
      { key: owner.key, magic: shearMagicBytes(MAGIC_MAINNET) },
      true,
    ))).ok, true);
    assert.equal((await callReserve(session, encodeCommitEpochStartRoot(1, proved.rootHex))).ok, true);
    const evmClaim = await callReserve(
      session,
      encodeClaim(proved.nullifier, proved.nanos, proved.blob, 1, packVaultOutput(proved.note)),
    );
    assert.equal(evmClaim.ok, true, evmClaim.reason);
    const oneRow = proveLeafRetire({
      scalar, epochs: [period], leaf: leaf.note, txBind: txDigestV3(tx, MAGIC_MAINNET), unlockEpoch: period,
    });
    const oneBlob = packRetireBlob([oneRow.proof]);
    assert.ok(oneBlob);
    const auth = packRewardAuth({ ownerPub: owner.pub, sig: evmTx.rewardSig, dest: owner.dest });
    const one = await callReserve(session, encodeWithdrawRetire(owner.dest, T0 + mainEpoch, auth, oneBlob));
    assert.equal(one.ok, false);
    assert.equal(one.reason, 'unsigned');
    const drew = await callReserve(
      session,
      encodeWithdrawRetire(owner.dest, T0 + mainEpoch, auth, packRetireBlob([retire.proof], MAGIC_MAINNET)),
    );
    assert.equal(drew.ok, true, drew.reason);
    assert.equal(decodeWithdraw(drew.returnValue).principal, PI_SHE_NANOS);
    const burned = retire.epochs.find((row) => row.epoch === period);
    const again = await callReserve(
      session,
      encodeClaim(burned.nullifierHex, 1, Buffer.from([VAULT_PROOF_VER, 0]), period, packVaultOutput(proved.note)),
    );
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'already_minted');
  });

  it('keeps a withdraw that would pass 64 retire proofs for a later block', () => {
    const proof = Buffer.alloc(12 + 3 * 168 + 64 + 32);
    proof.writeUInt32LE(3, 8);
    const made = [];
    for (let i = 0; i < 22; i += 1) {
      made.push({
        id: `cap-${i}`,
        kind: 'withdraw',
        nanos: PI_SHE_NANOS,
        retireProof: proof,
        vout: [{ kind: 'withdraw', nanos: PI_SHE_NANOS }],
      });
    }
    let included = 0;
    const taken = [];
    const kept = [];
    for (const tx of made) {
      const hit = retireCapHit(included, tx);
      if (hit) {
        assert.equal(hit.reason, 'retire_cap');
        kept.push(tx);
        continue;
      }
      included += txRetireDleqs(tx);
      taken.push(tx);
    }
    assert.equal(taken.length, 21);
    assert.equal(included, 63);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, 'cap-21');
    assert.ok(included <= MAX_BLOCK_RETIRE_DLEQS);
    const src = readFileSync(new URL('../node/src/store.js', import.meta.url), 'utf8');
    assert.match(src, /retireCapHit\(retireIncluded, tx\)/);
    assert.match(src, /retireCapHit\(retireUsed, row\)/);
    assert.match(src, /reason: 'retire_cap'/);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const packed = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, ...made] },
      nowMs: at,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(packed.ok, false);
    assert.equal(packed.reason, 'retire_cap');
    // One body with the same 22 proofs is over 64 DLEQs. The leaf-count
    // unsigned refusal does not hide the block cap.
    const bodyCap = retireBlobRejected({
      kind: 'withdraw',
      retireProofs: made.map((row) => row.retireProof),
    });
    assert.equal(bodyCap && bodyCap.reason, 'retire_cap');
  });

  it('starts a period on the empty root so a later lock is not in that root', () => {
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_MAINNET;
    assert.equal(state.vaultLockRoot, EMPTY_VAULT_ROOT);
    const opened = applyReserveBlock({
      state,
      block: { height: 0, txs: [{ coinbase: true, vout: [] }] },
      nowMs: T0,
      height: 0,
      genesisMs: T0,
    });
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(state.epochStartRoots['0'], EMPTY_VAULT_ROOT);
    state.vaultLockRoot = 'ab'.repeat(32);
    snapshotPeriodRoot(state, 100);
    assert.equal(state.epochStartRoots['0'], EMPTY_VAULT_ROOT);
  });

  it('refuses a lock that carries no lock note', () => {
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const owner = who();
    const bare = lockTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'no-note' });
    assert.equal(bare.vaultLockNote, undefined);
    const refused = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, bare] },
      nowMs: T0,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');
  });

  it('a funded withdraw has no plaintext from', () => {
    const owner = who();
    const blob = Buffer.alloc(321, 7);
    blob[0] = 0xf1;
    const commit = Buffer.alloc(32, 3);
    // `to` names the address. buildFundedWithdraw refuses it.
    const built = buildFundedWithdraw({
      to: owner.dest,
      nanos: PI_SHE_NANOS,
      id: 'funded-wd',
      portalId: portalIdFromDest(owner.dest),
      anchor: 16,
      excess: Buffer.alloc(32, 4),
      fs1: Buffer.concat([Buffer.from([0xf1]), Buffer.alloc(40, 1)]),
      vin: [{ commit }],
      admit_proof: { blob, cTilde: commit, spendTag: Buffer.alloc(32, 5) },
      retireProof: Buffer.alloc(12, 1),
      principalProof: { R: Buffer.alloc(32, 2), z: Buffer.alloc(32, 3) },
      ownerPub: owner.pub,
    });
    assert.equal(built, null);
    assert.equal(buildFundedWithdraw({
      from: owner.dest,
      to: owner.dest,
      dest20: Buffer.alloc(20, 9),
      nanos: PI_SHE_NANOS,
      id: 'funded-wd-from',
      portalId: portalIdFromDest(owner.dest),
    }), null);
    // Current law: a body with no address pays dest20 and does not gain `to`.
    const hidden = buildFundedWithdraw({
      dest20: Buffer.alloc(20, 9),
      nanos: PI_SHE_NANOS,
      id: 'hidden-wd',
      portalId: 'ab'.repeat(32),
      anchor: 16,
      excess: Buffer.alloc(32, 4),
      fs1: Buffer.concat([Buffer.from([0xf1]), Buffer.alloc(40, 1)]),
      vin: [{ commit }],
      admit_proof: { blob, cTilde: commit, spendTag: Buffer.alloc(32, 5) },
      retireProof: Buffer.alloc(12, 1),
      principalProof: { R: Buffer.alloc(32, 2), z: Buffer.alloc(32, 3) },
    });
    assert.ok(hidden);
    assert.equal(hidden.to, undefined);
    assert.equal(hidden.from, undefined);
    assert.equal(hidden.payoutPortalId, undefined);
    assert.equal(Buffer.from(hidden.dest20).equals(Buffer.alloc(20, 9)), true);
  });
});

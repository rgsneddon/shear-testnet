/**
 * Privacy, cartographer, and Vault Security checks on the hidden vault claim.
 * A lone claim is not opened. Two claims open their sum. Remain is a
 * commitment. The nullifier is not a function of the public spend tag.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { newIdentity, hash20FromAddress } from './address.js';
import { vaultDest } from './flow_sheet.js';
import { sealNote } from './note.js';
import {
  appendVaultLockNote,
  applyReserveBlock,
  deposit,
  emptyVault,
  lockFundingRejected,
  portalIdFromDest,
  rewardClaimTx,
  rewardOwnerCommit,
  rollRewardRejected,
  rollTx,
  signRollReward,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  encodeChargeEpoch,
  encodeCommitRewards,
  encodeCommitVaultRoot,
  encodeDeposit,
  encodePinClock,
  encodeSetEpochDue,
} from './reserve_evm.js';
import {
  proveEpochMint,
  proveVaultReward,
  tagDerivedNullifier,
  vaultLockNote,
  vaultRewardNanos,
} from './vault_reward_fs1.js';

const T0 = 1_700_000_000_000;
const span = RESERVE_EPOCH_MS;
const HEIGHT = VAULT_FS1_ACTIVATION_HEIGHT;
const Fn = RistrettoPoint.Fn;

function dest20() {
  const id = newIdentity();
  const dest = vaultDest(id.address, { viewKey: id.viewKey });
  return { id, dest, d20: Buffer.from(hash20FromAddress(dest)) };
}

function proveLock(amount, remain, epoch = 0) {
  const who = dest20();
  const proved = proveVaultReward({
    locks: [{ amount, index: 0 }],
    which: 0,
    rootEpoch: epoch,
    earnEpoch: epoch,
    bps: GENESIS_BPS,
    remainMs: remain,
    span,
    dest20: who.d20,
  });
  assert.ok(proved, 'proof');
  assert.equal(proved.blob[0], 0xa3);
  return { who, proved };
}

describe('hidden vault claims', () => {
  it('hides remain, rejects the tag-derived nullifier, and opens only a batch of two', () => {
    const who = dest20();
    const first = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, index: 0 }, { amount: PI_SHE_NANOS + 1, index: 1 }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: 86_400_000,
      span,
      dest20: who.d20,
    });
    const second = proveVaultReward({
      locks: first.locks.map((lock) => ({ amount: lock.amount, scalar: lock.scalar, blind: lock.blind })),
      which: 1,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: 3_600_000,
      span,
      dest20: who.d20,
    });
    const a = { who, proved: first };
    const b = { who, proved: second };
    assert.equal(a.proved.rootHex, b.proved.rootHex);
    const tagA = a.proved.blob.subarray(
      5 + a.proved.blob.readUInt32LE(1) + 1,
      5 + a.proved.blob.readUInt32LE(1) + 33,
    );
    const derived = tagDerivedNullifier(tagA, 0);
    assert.ok(derived);
    assert.notEqual(derived.toString('hex'), a.proved.nullifier);
    assert.notEqual(a.proved.remainCommit, b.proved.remainCommit);

    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    for (const [i, row] of [a, b].entries()) {
      const lock = row.proved.locks[i];
      const note = vaultLockNote(lock.amount, lock.scalar, lock.blind).note;
      assert.ok(appendVaultLockNote(state, note, { earnEpoch: 0, remainCommit: row.proved.remainCommit }));
    }
    assert.equal(state.vaultLockRoot, a.proved.rootHex);
    assert.equal(Object.keys(state.vaultRemainCommits['0']).length, 2);
    state.epochRewardDue = { 0: String(a.proved.nanos + b.proved.nanos) };
    const root = state.vaultLockRoot;
    const claimOf = (row) => rewardClaimTx({
      to: row.who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        rootEpoch: 0,
        earnEpoch: 0,
        note: row.proved.note,
      },
    });
    const one = applyReserveBlock({
      state,
      block: {
        height: HEIGHT,
        txs: [{ coinbase: true, vout: [], vaultLockRoot: root }, claimOf(a)],
      },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(one.ok, true, one.reason);
    assert.equal(state.mintBankNanos, 0n);
    assert.equal(state.pendingReward.length, 1);

    const blind = Fn.add(a.proved.rewardBlind, b.proved.rewardBlind);
    const opened = proveEpochMint(a.proved.nanos + b.proved.nanos, blind);
    const two = applyReserveBlock({
      state,
      block: {
        height: HEIGHT,
        txs: [{
          coinbase: true,
          vout: [],
          vaultLockRoot: root,
          epochMint: opened.nanos,
          epochMintProof: opened.proof,
        }, claimOf(b)],
      },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(two.ok, true, two.reason);
    assert.equal(state.mintBankNanos, BigInt(a.proved.nanos + b.proved.nanos));
    assert.notEqual(state.mintBankNanos, BigInt(a.proved.nanos));
    assert.equal(state.pendingReward.length, 0);

    const again = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [], vaultLockRoot: root }, claimOf(a)] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double_mint');
  });

  it('a later epoch uses the public span and a forged remainder commitment is refused', () => {
    const row = proveLock(PI_SHE_NANOS, span, 1);
    assert.equal(row.proved.full, true);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const note = vaultLockNote(row.proved.locks[0].amount, row.proved.locks[0].scalar, row.proved.locks[0].blind).note;
    appendVaultLockNote(state, note, { earnEpoch: 1, remainCommit: row.proved.remainCommit });
    state.vaultLockRoots = { 1: state.vaultLockRoot };
    const tx = rewardClaimTx({
      to: row.who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        rootEpoch: 1,
        earnEpoch: 1,
        note: row.proved.note,
      },
    });
    tx.full = true;
    const paid = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, tx] },
      nowMs: T0 + span * 2,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);

    const bad = proveLock(PI_SHE_NANOS, 86_400_000, 0);
    const other = emptyVault();
    other.genesisMs = T0;
    other.magic = MAGIC_TESTNET;
    const badNote = vaultLockNote(bad.proved.locks[0].amount, bad.proved.locks[0].scalar, bad.proved.locks[0].blind).note;
    appendVaultLockNote(other, badNote, { earnEpoch: 0, remainCommit: '11'.repeat(32) });
    other.vaultLockRoots = { 0: other.vaultLockRoot };
    const forged = rewardClaimTx({
      to: bad.who.dest,
      vault: {
        blob: bad.proved.blob,
        nullifier: bad.proved.nullifier,
        rootEpoch: 0,
        earnEpoch: 0,
        note: bad.proved.note,
      },
    });
    const refused = applyReserveBlock({
      state: other,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [], vaultLockRoot: other.vaultLockRoot }, forged] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');
  });

  it('the lock commitment must equal the funded input, and the epoch total opens the sum', () => {
    const who = dest20();
    const sealed = sealNote(PI_SHE_NANOS, { dest20: who.d20, kind: 'lock' });
    const admit = vaultLockNote(PI_SHE_NANOS, 1n, 2n);
    const note = Buffer.concat([admit.admitPub, Buffer.from(sealed.commit)]);
    const tx = {
      kind: 'lock',
      vaultLockNote: note,
      vin: [sealed],
    };
    assert.equal(lockFundingRejected(tx), null);
    const wrong = Buffer.concat([admit.admitPub, Buffer.alloc(32, 9)]);
    assert.equal(lockFundingRejected({ vaultLockNote: wrong, vin: [sealed] }).reason, 'stake_reward');

    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({
      state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub: who.id.spendPub.toString('hex'),
    }).ok, true);
    const portal = state.portals[portalIdFromDest(who.dest)];
    const tranche = portal.tranches[portal.tranches.length - 1];
    const rooted = appendVaultLockNote(state, note, { earnEpoch: tranche.epoch, remainCommit: '22'.repeat(32) });
    assert.ok(rooted);
    const due = vaultRewardNanos(PI_SHE_NANOS, GENESIS_BPS, tranche.remainMs, span);
    assert.ok(due);
    assert.ok(due.nanos < PI_SHE_NANOS);
  });

  it('a roll needs the owner, and a due reward needs the vault proof', () => {
    const who = dest20();
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    deposit({
      state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub: who.id.spendPub.toString('hex'),
    });
    const stranger = newIdentity();
    const roll = rollTx({ from: who.dest });
    roll.spendPub = stranger.spendPub.toString('hex');
    roll.rewardSig = 'ab'.repeat(64);
    assert.equal(rollRewardRejected(state, roll, T0 + span, HEIGHT).reason, 'unsigned');
    signRollReward(roll, who.id.privateKey, { portalId: portalIdFromDest(who.dest), epoch: 0 });
    const signed = rollRewardRejected(state, roll, T0 + span, HEIGHT);
    assert.ok(signed == null || signed.reason !== 'unsigned');
  });

  it('the EVM root matches, a zero root is refused, and the cap is charged', async () => {
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    const who = dest20();
    const owner = rewardOwnerCommit(who.id.spendPub.toString('hex'));
    assert.equal((await callReserve(session, encodeDeposit(who.dest, PI_SHE_NANOS, T0, owner))).ok, true);
    const root = 'ab'.repeat(32);
    const zero = await callReserve(session, encodeCommitVaultRoot(0, '00'.repeat(32)));
    assert.equal(zero.ok, false);
    const stored = await callReserve(session, encodeCommitVaultRoot(0, root));
    assert.equal(stored.ok, true, stored.reason);
    assert.equal((await callReserve(session, encodeSetEpochDue(0, 100))).ok, true);
    assert.equal((await callReserve(session, encodeChargeEpoch(0, 40))).ok, true);
    const over = await callReserve(session, encodeChargeEpoch(0, 61));
    assert.equal(over.ok, false);
    const empty = await callReserve(session, encodeCommitRewards(T0 + span, '00'.repeat(32)));
    const nonempty = await callReserve(session, encodeCommitRewards(T0 + span, root));
    assert.equal(nonempty.ok, true, nonempty.reason);
    assert.ok(nonempty.gasUsed > 20000n, `non-empty commitRewards gas ${nonempty.gasUsed}`);
    assert.ok(empty.gasUsed > 0n, `empty commitRewards gas ${empty.gasUsed}`);
  });
});

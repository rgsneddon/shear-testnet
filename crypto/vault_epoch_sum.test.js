import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { hash20FromAddress, newIdentity } from './address.js';
import { vaultDest } from './flow_sheet.js';
import {
  appendVaultLockNote,
  applyReserveBlock,
  consensusUnlockPeriod,
  emptyVault,
  lockTx,
  lockWitnessOf,
  portalIdFromDest,
  publicVaultView,
  rewardClaimTx,
  stakeRewardSupply,
  supplyIdentity,
  VAULT_MINT_DELAY_BLOCKS,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  encodeClaim,
  encodeCommitEpochStartRoot,
  encodePinClock,
} from './reserve_evm.js';
import { readFileSync } from 'node:fs';
import { packVaultOutput, proveVaultReward, vaultLockNote } from './vault_reward_fs1.js';
import { randomScalar } from './note.js';

const T0 = 1_700_000_000_000;
const span = RESERVE_EPOCH_MS;
const HEIGHT = VAULT_FS1_ACTIVATION_HEIGHT;

function who() {
  const id = newIdentity();
  const dest = vaultDest(id.address, { viewKey: id.viewKey });
  return { id, dest, d20: Buffer.from(hash20FromAddress(dest)) };
}

function fresh() {
  const state = emptyVault();
  state.genesisMs = T0;
  state.magic = MAGIC_TESTNET;
  state.epochBps = GENESIS_BPS;
  return state;
}

function applyLock(state, tx, height) {
  return applyReserveBlock({
    state,
    block: { height, txs: [{ coinbase: true, vout: [] }, tx] },
    nowMs: T0 + 1_000,
    height,
    genesisMs: T0,
  });
}

/** A π lock carries the leaf note. The output commitment hides the amount. */
function notedPiLock(owner, id) {
  const tx = lockTx({
    from: owner.dest,
    to: owner.dest,
    nanos: PI_SHE_NANOS,
    id,
    ownerPub: owner.id.spendPub.toString('hex'),
    bps: GENESIS_BPS,
  });
  const held = lockWitnessOf(tx);
  const leaf = vaultLockNote(held.amount, randomScalar(), held.blind, consensusUnlockPeriod(0));
  if (!leaf) return null;
  tx.vaultLockNote = leaf.note;
  return tx;
}

describe('epoch sums stay commitments', () => {
  for (const amount of [1, 1_000, 2 ** 53 - 1]) {
    it(`amount ${amount} has no π lock note and is refused`, () => {
      const owner = who();
      const tx = lockTx({
        from: owner.dest,
        to: owner.dest,
        nanos: amount,
        id: `bare-${amount}`,
        ownerPub: owner.id.spendPub.toString('hex'),
        bps: GENESIS_BPS,
      });
      assert.equal(tx.vaultLockNote, undefined);
      const applied = applyLock(fresh(), tx, HEIGHT);
      assert.equal(applied.ok, false);
      assert.equal(applied.reason, 'stake_reward');
    });
  }

  for (const count of [1, 2, 5]) {
    it(`π with ${count} lock(s) passes close+4 without a halt`, () => {
      const owner = who();
      const state = fresh();
      for (let i = 0; i < count; i += 1) {
        const tx = notedPiLock(owner, `probe-pi-${count}-${i}`);
        assert.ok(tx);
        assert.equal(tx.vout.length, 1);
        assert.equal(tx.vout[0].kind, 'lock');
        assert.equal(tx.nanos, 0);
        const applied = applyLock(state, tx, HEIGHT + i);
        assert.equal(applied.ok, true, applied.reason);
      }
      const closeHeight = HEIGHT + count + 1;
      const closed = applyReserveBlock({
        state,
        block: { height: closeHeight, txs: [{ coinbase: true, vout: [] }] },
        nowMs: T0 + span,
        height: closeHeight,
        genesisMs: T0,
      });
      assert.equal(closed.ok, true, closed.reason);
      const past = applyReserveBlock({
        state,
        block: { height: closeHeight + VAULT_MINT_DELAY_BLOCKS, txs: [{ coinbase: true, vout: [] }] },
        nowMs: T0 + span + 1,
        height: closeHeight + VAULT_MINT_DELAY_BLOCKS,
        genesisMs: T0,
      });
      assert.equal(past.ok, true, past.reason);
      assert.equal(Number(state.totalLockedNanos), 0);
      const portal = state.portals[portalIdFromDest(owner.dest)];
      assert.equal(Number(portal.staked) + Number(portal.idle), 0);
      assert.equal(portal.tranches.length, count);
      for (const tranche of portal.tranches) {
        assert.equal(tranche.amount, undefined);
      }
      const identity = supplyIdentity(state);
      assert.equal(identity.ok, true, identity.reason);
      assert.equal(identity.principalNanos, 0);
      assert.equal(identity.principalCommit.length, 64);
      const view = publicVaultView(state, T0 + span + 1);
      assert.equal(view.totalLockedNanos, 0);
      assert.equal(view.totalStakedNanos, 0);
      assert.equal(view.totalAccruedNanos, 0);
    });
  }

  it('a singleton epoch does not reveal the amount, and a forged sum is rejected', () => {
    const owner = who();
    const state = fresh();
    const tx = notedPiLock(owner, 'singleton');
    assert.ok(tx);
    assert.equal(applyLock(state, tx, HEIGHT).ok, true);
    const past = applyReserveBlock({
      state,
      block: { height: HEIGHT + 1 + VAULT_MINT_DELAY_BLOCKS, txs: [{ coinbase: true, vout: [] }] },
      nowMs: T0 + span,
      height: HEIGHT + 1 + VAULT_MINT_DELAY_BLOCKS,
      genesisMs: T0,
    });
    assert.equal(past.ok, true, past.reason);
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.notEqual(Number(state.totalLockedNanos), PI_SHE_NANOS);
    assert.equal(state.epochLockTotal, undefined);
    assert.equal(state.openedEpochPrincipal, undefined);
    const forged = applyReserveBlock({
      state,
      block: {
        height: HEIGHT + 2 + VAULT_MINT_DELAY_BLOCKS,
        txs: [{ coinbase: true, vout: [], epochLockEpoch: 0, epochLockTotal: PI_SHE_NANOS }],
      },
      nowMs: T0 + span,
      height: HEIGHT + 2 + VAULT_MINT_DELAY_BLOCKS,
      genesisMs: T0,
    });
    assert.equal(forged.ok, false);
    assert.equal(forged.reason, 'stake_reward');
    const broken = { ...state, vaultPrincipalSum: 'ab'.repeat(32) };
    assert.equal(supplyIdentity(broken).ok, false);
    assert.equal(supplyIdentity(state).ok, true);
  });

  it('a lone claim mints its public reward, and JS matches the EVM', async () => {
    const pay = who();
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
    const state = fresh();
    const note = vaultLockNote(
      proved.locks[0].amount,
      proved.locks[0].scalar,
      proved.locks[0].blind,
    ).note;
    assert.ok(appendVaultLockNote(state, note));
    assert.equal(state.vaultRemainLeaf, undefined);
    state.epochStartRoots = { 0: state.vaultLockRoot };
    const claim = rewardClaimTx({ to: pay.dest, vault: proved, id: 'lone' });
    assert.equal(claim.nanos, proved.nanos);
    const walked = stakeRewardSupply(state, {
      height: HEIGHT,
      txs: [{ coinbase: true, vout: [], vaultLockRoot: proved.rootHex }, claim],
    }, T0 + span, HEIGHT);
    assert.equal(walked.ok, true, walked.reason);
    assert.equal(walked.minted, BigInt(proved.nanos));
    assert.equal(walked.permitted, walked.minted);
    assert.equal(walked.claimed, 0n);
    const paid = applyReserveBlock({
      state,
      block: {
        height: HEIGHT,
        txs: [{ coinbase: true, vout: [], vaultLockRoot: proved.rootHex }, claim],
      },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(Number(state.mintBankNanos), proved.nanos);
    assert.equal(state.epochMintNanos['0'], BigInt(proved.nanos));
    assert.equal(state.epochMintSum, undefined);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeCommitEpochStartRoot(0, proved.rootHex))).ok, true);
    const evm = await callReserve(
      session,
      encodeClaim(proved.nullifier, proved.nanos, proved.blob, 0, packVaultOutput(proved.note)),
    );
    assert.equal(evm.ok, true, evm.reason);
    const word = BigInt(`0x${Buffer.from(evm.returnValue).subarray(0, 32).toString('hex')}`);
    assert.equal(word, BigInt(proved.nanos));
    const again = await callReserve(
      session,
      encodeClaim(proved.nullifier, proved.nanos, proved.blob, 0, packVaultOutput(proved.note)),
    );
    assert.equal(again.ok, false);
  });

  it('JS and the EVM publish the reward at the proof-version offset and refuse a reward that does not match', async () => {
    const pay = who();
    const locks = [{ amount: PI_SHE_NANOS, scalar: 4n, blind: 5n }];
    const first = proveVaultReward({
      locks,
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    const second = proveVaultReward({
      locks,
      which: 0,
      rootEpoch: 1,
      earnEpoch: 1,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    const partial = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS + 1 }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: 86_400_000,
      span,
      dest20: pay.d20,
    });
    assert.ok(first && second);
    assert.equal(partial, null);
    const headerAt = (blob) => 5 + blob.readUInt32LE(1) + 321 + 4 + 8 + 8;
    const off = headerAt(first.blob);
    assert.equal(first.blob[0], 0xab);
    assert.equal(first.blob.readBigUInt64LE(off), BigInt(first.nanos));
    assert.equal(first.blob.includes(first.locks[0].commit), false);
    assert.equal(second.blob.includes(second.locks[0].commit), false);
    const tagOf = (blob) => {
      const fs1 = blob.readUInt32LE(1);
      return blob.subarray(5 + fs1 + 1, 5 + fs1 + 33).toString('hex');
    };
    const memberOf = (blob) => {
      const fs1 = blob.readUInt32LE(1);
      return blob.subarray(5 + fs1 + 33, 5 + fs1 + 65).toString('hex');
    };
    assert.notEqual(tagOf(first.blob), tagOf(second.blob));
    assert.notEqual(memberOf(first.blob), memberOf(second.blob));
    assert.notEqual(first.nullifier, second.nullifier);
    const sol = readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    assert.match(sol, /proof\[0\] != 0xab/);
    assert.match(sol, /5 \+ fs1Len \+ 321 \+ 4 \+ 8 \+ 8/);
    assert.equal(sol.includes('off + 1 + 32:off + 1 + 64'), false);

    const wrong = Buffer.from(first.blob);
    wrong.writeBigUInt64LE(wrong.readBigUInt64LE(off) + 1n, off);
    const claimOf = (proved, id) => rewardClaimTx({ to: pay.dest, vault: proved, id });
    const planted = fresh();
    const note = vaultLockNote(first.locks[0].amount, first.locks[0].scalar, first.locks[0].blind).note;
    appendVaultLockNote(planted, note, { earnEpoch: 0, remainCommit: '11'.repeat(32) });
    planted.epochStartRoots = { 0: first.rootHex };
    const indexed = applyReserveBlock({
      state: planted,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, claimOf(first, 'indexed-remain')] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(indexed.ok, true, indexed.reason);
    assert.equal(Number(planted.mintBankNanos), first.nanos);

    const borrowed = fresh();
    appendVaultLockNote(borrowed, note);
    borrowed.epochStartRoots = { 0: 'ab'.repeat(32) };
    const borrowedPaid = applyReserveBlock({
      state: borrowed,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, claimOf(first, 'borrowed-root')] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(borrowedPaid.ok, false);
    assert.equal(borrowedPaid.reason, 'stake_reward');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeCommitEpochStartRoot(0, first.rootHex))).ok, true);
    const evmWrong = await callReserve(session, encodeClaim(first.nullifier, Number(wrong.readBigUInt64LE(off)), wrong, 0, packVaultOutput(first.note)));
    assert.equal(evmWrong.ok, false);

    const honest = await bootReserveEvm();
    assert.equal((await callReserve(honest, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(honest, encodeCommitEpochStartRoot(0, first.rootHex))).ok, true);
    const evmHonest = await callReserve(honest, encodeClaim(first.nullifier, first.nanos, first.blob, 0, packVaultOutput(first.note)));
    assert.equal(evmHonest.ok, true, evmHonest.reason);
    const evmWord = BigInt(`0x${Buffer.from(evmHonest.returnValue).subarray(0, 32).toString('hex')}`);
    assert.equal(evmWord, BigInt(first.nanos));
    const evmAgain = await callReserve(honest, encodeClaim(first.nullifier, first.nanos, first.blob, 0, packVaultOutput(first.note)));
    assert.equal(evmAgain.ok, false);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { hash20FromAddress, newIdentity } from './address.js';
import { vaultDest } from './flow_sheet.js';
import {
  appendVaultLockNote,
  applyReserveBlock,
  emptyVault,
  lockTx,
  portalIdFromDest,
  publicVaultView,
  rewardClaimTx,
  supplyIdentity,
  VAULT_MINT_DELAY_BLOCKS,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  encodeClaim,
  encodeCommitEpochStartRoot,
  encodeNoteVaultLeaf,
  encodePinClock,
} from './reserve_evm.js';
import { readFileSync } from 'node:fs';
import { packVaultOutput, proveVaultReward, vaultLockNote, vaultRewardCommit } from './vault_reward_fs1.js';

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

describe('epoch sums stay commitments', () => {
  const amounts = [1, 1_000, PI_SHE_NANOS, 2 ** 53 - 1];
  const counts = [1, 2, 5];

  for (const amount of amounts) {
    for (const count of counts) {
      it(`amount ${amount} with ${count} lock(s) passes close+4 without a halt`, () => {
        const owner = who();
        const state = fresh();
        for (let i = 0; i < count; i += 1) {
          const tx = lockTx({
            from: owner.dest,
            to: owner.dest,
            nanos: amount,
            id: `probe-${amount}-${count}-${i}`,
            ownerPub: owner.id.spendPub.toString('hex'),
            bps: GENESIS_BPS,
          });
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
          assert.notEqual(Number(tranche.amount), amount);
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
  }

  it('a singleton epoch does not reveal the amount, and a forged sum is rejected', () => {
    const amount = 123_456_789;
    const owner = who();
    const state = fresh();
    const tx = lockTx({
      from: owner.dest,
      to: owner.dest,
      nanos: amount,
      id: 'singleton',
      ownerPub: owner.id.spendPub.toString('hex'),
      bps: GENESIS_BPS,
    });
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
    assert.notEqual(Number(state.totalLockedNanos), amount);
    assert.equal(state.epochLockTotal, undefined);
    assert.equal(state.openedEpochPrincipal, undefined);
    const forged = applyReserveBlock({
      state,
      block: {
        height: HEIGHT + 2 + VAULT_MINT_DELAY_BLOCKS,
        txs: [{ coinbase: true, vout: [], epochLockEpoch: 0, epochLockTotal: amount }],
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

  it('a lone claim mints without the amount, and JS matches the EVM', async () => {
    const owner = who();
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
    assert.ok(appendVaultLockNote(state, note, { earnEpoch: 0, remainCommit: proved.remainCommit }));
    state.epochStartRoots = { 0: state.vaultLockRoot };
    const claim = rewardClaimTx({ to: pay.dest, vault: proved, id: 'lone' });
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
    assert.equal(Number(state.mintBankNanos), 0);
    assert.notEqual(Number(state.mintBankNanos), proved.nanos);
    assert.equal(state.epochMintSum['0'], vaultRewardCommit(proved.blob).toString('hex'));
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeCommitEpochStartRoot(0, proved.rootHex))).ok, true);
    assert.equal((await callReserve(session, encodeNoteVaultLeaf(proved.lockCommit, proved.remainCommit))).ok, true);
    const evm = await callReserve(
      session,
      encodeClaim(proved.nullifier, 0, proved.blob, 0, packVaultOutput(proved.note)),
    );
    assert.equal(evm.ok, true, evm.reason);
    const word = BigInt(`0x${Buffer.from(evm.returnValue).subarray(0, 32).toString('hex')}`);
    assert.equal(word, 1n);
    assert.notEqual(word, BigInt(proved.nanos));
  });

  it('JS and the EVM refuse a forged remain and a borrowed lock, at the 0xa7 offsets', async () => {
    const pay = who();
    const first = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: pay.d20,
    });
    const second = proveVaultReward({
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
    const headerAt = (blob) => 5 + blob.readUInt32LE(1) + 321 + 4 + 8 + 8;
    const off = headerAt(first.blob);
    assert.equal(first.blob[0], 0xa7);
    assert.equal(first.blob[off], 1);
    assert.equal(first.blob.subarray(off + 1 + 32, off + 1 + 64).toString('hex'), first.remainCommit);
    assert.equal(first.blob.subarray(off + 1 + 64, off + 1 + 96).toString('hex'), first.capCommit);
    assert.notEqual(first.capCommit, first.lockCommit);
    const sol = readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    assert.match(sol, /proof\[0\] != 0xa7/);
    assert.match(sol, /5 \+ fs1Len \+ 321 \+ 4 \+ 8 \+ 8/);
    assert.match(sol, /off \+ 1 \+ 32:off \+ 1 \+ 64/);

    const claimOf = (proved, id) => rewardClaimTx({ to: pay.dest, vault: proved, id });
    const forged = fresh();
    const forgedNote = vaultLockNote(first.locks[0].amount, first.locks[0].scalar, first.locks[0].blind).note;
    appendVaultLockNote(forged, forgedNote, { earnEpoch: 0, remainCommit: '11'.repeat(32) });
    forged.epochStartRoots = { 0: first.rootHex };
    const forgedPaid = applyReserveBlock({
      state: forged,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, claimOf(first, 'forged-remain')] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(forgedPaid.ok, false);
    assert.equal(forgedPaid.reason, 'stake_reward');

    const borrowed = fresh();
    const borrowedNote = vaultLockNote(second.locks[0].amount, second.locks[0].scalar, second.locks[0].blind).note;
    appendVaultLockNote(borrowed, borrowedNote, { earnEpoch: 0, remainCommit: first.remainCommit });
    borrowed.epochStartRoots = { 0: first.rootHex };
    const borrowedPaid = applyReserveBlock({
      state: borrowed,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, claimOf(first, 'borrowed-lock')] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(borrowedPaid.ok, false);
    assert.equal(borrowedPaid.reason, 'stake_reward');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeCommitEpochStartRoot(0, first.rootHex))).ok, true);
    assert.equal((await callReserve(session, encodeNoteVaultLeaf(first.lockCommit, '11'.repeat(32)))).ok, true);
    const evmForged = await callReserve(session, encodeClaim(first.nullifier, 0, first.blob, 0, packVaultOutput(first.note)));
    assert.equal(evmForged.ok, false);

    const other = await bootReserveEvm();
    assert.equal((await callReserve(other, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(other, encodeCommitEpochStartRoot(0, first.rootHex))).ok, true);
    assert.equal((await callReserve(other, encodeNoteVaultLeaf(second.lockCommit, first.remainCommit))).ok, true);
    const evmBorrowed = await callReserve(other, encodeClaim(first.nullifier, 0, first.blob, 0, packVaultOutput(first.note)));
    assert.equal(evmBorrowed.ok, false);

    const honest = await bootReserveEvm();
    assert.equal((await callReserve(honest, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(honest, encodeCommitEpochStartRoot(0, first.rootHex))).ok, true);
    assert.equal((await callReserve(honest, encodeNoteVaultLeaf(first.lockCommit, first.remainCommit))).ok, true);
    const evmHonest = await callReserve(honest, encodeClaim(first.nullifier, 0, first.blob, 0, packVaultOutput(first.note)));
    assert.equal(evmHonest.ok, true, evmHonest.reason);
    const evmWord = BigInt(`0x${Buffer.from(evmHonest.returnValue).subarray(0, 32).toString('hex')}`);
    assert.equal(evmWord, 1n);
  });
});

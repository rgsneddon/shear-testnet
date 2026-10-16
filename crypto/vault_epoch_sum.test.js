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
  encodeNoteVaultLock,
  encodeNoteVaultRemain,
  encodePinClock,
} from './reserve_evm.js';
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
    assert.equal((await callReserve(session, encodeNoteVaultRemain(0, proved.remainCommit))).ok, true);
    assert.equal((await callReserve(session, encodeNoteVaultLock(proved.lockCommit))).ok, true);
    const evm = await callReserve(
      session,
      encodeClaim(proved.nullifier, 0, proved.blob, 0, packVaultOutput(proved.note)),
    );
    assert.equal(evm.ok, true, evm.reason);
    const word = BigInt(`0x${Buffer.from(evm.returnValue).subarray(0, 32).toString('hex')}`);
    assert.equal(word, 1n);
    assert.notEqual(word, BigInt(proved.nanos));
  });
});

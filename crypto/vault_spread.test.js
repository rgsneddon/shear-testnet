/**
 * One JS==EVM spread: lock height, claim height, leaves {1,5,20},
 * two epochs, a rate change, and a real reorg on both sides.
 * Supply is the period constant times the leaves, plus each leaf's arrival stub.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { txDigestV3 } from './admit_v3.js';
import { encodeDest, hash20FromAddress, newIdentity, spendDestOf } from './address.js';
import { arrivalStubNanos, periodSupplyNanos, vaultPeriodBlocks, vaultPeriodReward } from './vault_accrual.js';
import {
  appendVaultLockNote,
  applyReserveBlock,
  chainPeriodIndex,
  cloneVault,
  deposit,
  emptyVault,
  leafEpochsToBurn,
  packRewardAuth,
  portalIdFromDest,
  rewardClaimTx,
  provePrincipalOpen,
  rewardOwnerCommit,
  signWithdrawReward,
  snapshotPeriodRoot,
  trialReserveApply,
  withdrawTx,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  decodeWithdraw,
  encodeClaim,
  encodeCommitEpochStartRoot,
  encodeCommitRate,
  encodeDeposit,
  encodeEnact,
  encodePinClock,
  encodeSyncEpoch,
  encodeWithdrawRetire,
  packRetireBlob,
} from './reserve_evm.js';
import {
  packVaultOutput,
  proveLeafRetire,
  proveVaultReward,
  vaultLockNote,
  VAULT_UNLOCK_OPEN,
} from './vault_reward_fs1.js';
import { proveRange } from './note.js';

const T0 = 1_700_000_000_000;
const span = RESERVE_EPOCH_MS;
const at = T0 + span;
const lateAt = T0 + 3 * span;
const HEIGHT = VAULT_FS1_ACTIVATION_HEIGHT;
const NEXT_BPS = GENESIS_BPS + 19;
const LOCK_HEIGHTS = [0, 10, 50, 240];
const LEAF_COUNTS = [1, 5, 20];
const PERIOD_NANOS = 551742209n;

function who() {
  const id = newIdentity();
  return {
    dest: spendDestOf(id.spendPub),
    pub: Buffer.from(id.spendPub).toString('hex'),
    key: id.privateKey,
  };
}

function word(ret) {
  const raw = Buffer.from(ret instanceof Uint8Array ? ret : []);
  return BigInt(`0x${raw.subarray(0, 32).toString('hex') || '0'}`);
}

function applyAt(state, txs, root, now = at) {
  return applyReserveBlock({
    state,
    block: {
      height: HEIGHT,
      txs: [{ coinbase: true, vout: [], vaultLockRoot: root }, ...txs],
    },
    nowMs: now,
    height: HEIGHT,
    genesisMs: T0,
  });
}

function plant(state, rows, epoch, rootHex) {
  for (const row of rows) {
    const note = vaultLockNote(row.amount, row.scalar, row.blind).note;
    assert.ok(appendVaultLockNote(state, note));
  }
  assert.equal(state.vaultLockRoot, rootHex);
  if (!state.epochStartRoots) state.epochStartRoots = Object.create(null);
  state.epochStartRoots[String(epoch)] = rootHex;
}

describe('JS and EVM vault spread', { timeout: 300000 }, () => {
  it('matches lock height, claim height, leaves, epochs, a rate change, and a reorg', async () => {
    const owner = who();
    const dest20 = hash20FromAddress(encodeDest(Buffer.alloc(20, 0x71)));
    const locks = Array.from({ length: 20 }, (_, index) => ({
      amount: PI_SHE_NANOS,
      index,
      scalar: BigInt(100 + index),
      blind: BigInt(200 + index),
    }));
    const proved = [];
    for (let which = 0; which < locks.length; which += 1) {
      const row = proveVaultReward({
        locks: which === 0 ? locks : proved[0].locks,
        which,
        rootEpoch: 0,
        earnEpoch: 0,
        bps: GENESIS_BPS,
        remainMs: span,
        span,
        dest20,
      });
      assert.ok(row, `leaf ${which}`);
      proved.push(row);
    }
    const root = proved[0].rootHex;
    for (const row of proved) {
      assert.equal(row.rootHex, root);
      assert.equal(BigInt(row.nanos), PERIOD_NANOS);
    }
    const period = vaultPeriodReward(PI_SHE_NANOS, GENESIS_BPS, MAGIC_TESTNET);
    assert.equal(period.nanos, PERIOD_NANOS);

    for (const leaves of LEAF_COUNTS) {
      for (const height of LOCK_HEIGHTS) {
        const stub = arrivalStubNanos({
          amount: PI_SHE_NANOS,
          lockHeight: height,
          magic: MAGIC_TESTNET,
          rate: GENESIS_BPS,
        });
        assert.ok(stub);
        const supply = periodSupplyNanos({
          leaves,
          stubs: Array.from({ length: leaves }, () => stub.nanos),
          amount: PI_SHE_NANOS,
          bps: GENESIS_BPS,
          magic: MAGIC_TESTNET,
        });
        const claims = proved.slice(0, leaves).reduce((sum, row) => sum + BigInt(row.nanos), 0n);
        assert.equal(supply.claims, claims);
        assert.equal(supply.total, claims + stub.nanos * BigInt(leaves));
      }
    }

    const live = emptyVault();
    live.genesisMs = T0;
    live.magic = MAGIC_TESTNET;
    plant(live, proved[0].locks, 0, root);
    const pay = encodeDest(Buffer.alloc(20, 0x71));
    for (let i = 0; i < proved.length; i += 1) {
      const claimed = applyAt(live, [rewardClaimTx({ to: pay, vault: proved[i], id: `spread-${i}` })], root, at);
      assert.equal(claimed.ok, true, `${i} ${claimed.reason}`);
    }
    assert.equal(live.mintBankNanos, PERIOD_NANOS * 20n);
    const freshLate = emptyVault();
    freshLate.genesisMs = T0;
    freshLate.magic = MAGIC_TESTNET;
    plant(freshLate, proved[0].locks, 0, root);
    const outside = applyAt(
      freshLate,
      [rewardClaimTx({ to: pay, vault: proved[0], id: 'spread-outside' })],
      root,
      lateAt,
    );
    assert.equal(outside.ok, false);
    assert.equal(outside.reason, 'stake_reward');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeCommitEpochStartRoot(0, root))).ok, true);
    for (let i = 0; i < proved.length; i += 1) {
      const evm = await callReserve(
        session,
        encodeClaim(proved[i].nullifier, proved[i].nanos, proved[i].blob, 0, packVaultOutput(proved[i].note)),
      );
      assert.equal(evm.ok, true, `${i} ${evm.reason}`);
      assert.equal(word(evm.returnValue), BigInt(proved[i].nanos));
    }
    const late = await bootReserveEvm();
    assert.equal((await callReserve(late, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(late, encodeDeposit(
      owner.dest,
      proved[0].locks[0].commit,
      T0,
      rewardOwnerCommit(owner.pub),
      true,
    ))).ok, true);
    assert.equal((await callReserve(late, encodeCommitEpochStartRoot(0, root))).ok, true);
    assert.equal((await callReserve(late, encodeEnact(lateAt))).ok, true);
    assert.equal((await callReserve(late, encodeSyncEpoch(lateAt))).ok, true);
    const lateClaim = await callReserve(
      late,
      encodeClaim(proved[0].nullifier, proved[0].nanos, proved[0].blob, 0, packVaultOutput(proved[0].note)),
    );
    assert.equal(lateClaim.ok, false);
    assert.equal(lateClaim.reason, 'claim_unavailable');

    const nextLeaf = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, index: 0, scalar: 7n, blind: 8n }],
      which: 0,
      rootEpoch: 16,
      earnEpoch: 16,
      bps: NEXT_BPS,
      remainMs: span,
      span,
      dest20,
    });
    assert.ok(nextLeaf);
    const nextEach = vaultPeriodReward(PI_SHE_NANOS, NEXT_BPS, MAGIC_TESTNET);
    assert.equal(BigInt(nextLeaf.nanos), nextEach.nanos);
    for (const leaves of LEAF_COUNTS) {
      const stub = arrivalStubNanos({
        amount: PI_SHE_NANOS,
        lockHeight: 10,
        magic: MAGIC_TESTNET,
        rates: { 1: NEXT_BPS },
        rate: NEXT_BPS,
      });
      const supply = periodSupplyNanos({
        leaves,
        stubs: Array.from({ length: leaves }, () => stub.nanos),
        amount: PI_SHE_NANOS,
        bps: NEXT_BPS,
        magic: MAGIC_TESTNET,
      });
      assert.equal(supply.claims, nextEach.nanos * BigInt(leaves));
      assert.equal(supply.total, supply.claims + stub.nanos * BigInt(leaves));
    }
    const rated = emptyVault();
    rated.genesisMs = T0;
    rated.magic = MAGIC_TESTNET;
    rated.pendingRates = { 1: NEXT_BPS };
    plant(rated, nextLeaf.locks, 16, nextLeaf.rootHex);
    const ratedClaim = applyAt(
      rated,
      [rewardClaimTx({ to: pay, vault: nextLeaf, id: 'spread-rate' })],
      nextLeaf.rootHex,
      at,
    );
    assert.equal(ratedClaim.ok, true, ratedClaim.reason);
    assert.equal(rated.mintBankNanos, nextEach.nanos);
    const ratedEvm = await bootReserveEvm();
    assert.equal((await callReserve(ratedEvm, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(ratedEvm, encodeCommitRate(1, NEXT_BPS, at, T0))).ok, true);
    assert.equal((await callReserve(ratedEvm, encodeCommitEpochStartRoot(16, nextLeaf.rootHex))).ok, true);
    const ratedPaid = await callReserve(
      ratedEvm,
      encodeClaim(nextLeaf.nullifier, nextLeaf.nanos, nextLeaf.blob, 16, packVaultOutput(nextLeaf.note)),
    );
    assert.equal(ratedPaid.ok, true, ratedPaid.reason);
    assert.equal(word(ratedPaid.returnValue), nextEach.nanos);

    const leaf = proved[0].locks[0];
    const note = vaultLockNote(leaf.amount, leaf.scalar, leaf.blind);
    const undo = emptyVault();
    undo.genesisMs = T0;
    undo.magic = MAGIC_TESTNET;
    assert.equal(deposit({
      state: undo,
      dest: owner.dest,
      nanos: PI_SHE_NANOS,
      commit: note.commit,
      blind: leaf.blind,
      rangeProof: proveRange(PI_SHE_NANOS, leaf.blind),
      nowMs: T0,
      ownerPub: owner.pub,
    }).ok, true);
    plant(undo, proved[0].locks, 0, root);
    const portal = portalIdFromDest(owner.dest);
    const tx = withdrawTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, id: 'spread-undo' });
    const chainPeriod = chainPeriodIndex(undo, at);
    const retire = proveLeafRetire({
      scalar: leaf.scalar,
      epochs: leafEpochsToBurn(undo, note.note.toString('hex'), chainPeriod),
      leaf: note.note,
      txBind: txDigestV3(tx, MAGIC_TESTNET),
      unlockEpoch: chainPeriod,
    });
    tx.retireProof = retire.proof;
    tx.principalProof = provePrincipalOpen(
      note.commit, PI_SHE_NANOS, leaf.blind, tx, portal, MAGIC_TESTNET, VAULT_UNLOCK_OPEN,
    );
    snapshotPeriodRoot(undo, chainPeriod * vaultPeriodBlocks(MAGIC_TESTNET));
    const periodClaim = proveVaultReward({
      locks: proved[0].locks.map((lock) => ({ amount: lock.amount, scalar: lock.scalar, blind: lock.blind })),
      which: 0,
      rootEpoch: chainPeriod,
      earnEpoch: chainPeriod,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20,
    });
    assert.ok(periodClaim);
    signWithdrawReward(tx, owner.key, {
      portalId: portal,
      nanos: PI_SHE_NANOS,
      dest: owner.dest,
      state: undo,
      nowMs: at,
    });
    const bounced = trialReserveApply({
      state: undo,
      inPlace: true,
      nowMs: at,
      height: HEIGHT,
      genesisMs: T0,
      block: {
        height: HEIGHT,
        txs: [
          { coinbase: true, vout: [] },
          tx,
          rewardClaimTx({ to: pay, vault: periodClaim, id: 'spread-undo-claim' }),
        ],
      },
    });
    assert.equal(bounced.ok, false);
    assert.equal(bounced.reason, 'double_mint');
    assert.equal(undo.vaultRetired?.[note.note.toString('hex')], undefined);
    assert.equal(undo.vaultLockRoot, root);
    const restored = applyAt(undo, [rewardClaimTx({ to: pay, vault: proved[0], id: 'spread-restored' })], root, at);
    assert.equal(restored.ok, true, restored.reason);

    const evmUndo = await bootReserveEvm();
    assert.equal((await callReserve(evmUndo, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(evmUndo, encodeDeposit(owner.dest, note.commit, T0, rewardOwnerCommit(owner.pub), true))).ok, true);
    assert.equal((await callReserve(evmUndo, encodeCommitEpochStartRoot(0, root))).ok, true);
    const sm = evmUndo.evm.stateManager;
    await sm.checkpoint();
    const auth = packRewardAuth({ ownerPub: owner.pub, sig: tx.rewardSig, dest: owner.dest });
    const drew = await callReserve(evmUndo, encodeWithdrawRetire(owner.dest, at, auth, packRetireBlob([retire.proof])));
    assert.equal(drew.ok, true, drew.reason);
    assert.equal(decodeWithdraw(drew.returnValue).principal, PI_SHE_NANOS);
    const early = await callReserve(
      evmUndo,
      encodeClaim(proved[0].nullifier, proved[0].nanos, proved[0].blob, 0, packVaultOutput(proved[0].note)),
    );
    assert.equal(early.ok, true, early.reason);
    const burned = await callReserve(
      evmUndo,
      encodeClaim(periodClaim.nullifier, periodClaim.nanos, periodClaim.blob, chainPeriod, packVaultOutput(periodClaim.note)),
    );
    assert.equal(burned.ok, false);
    assert.equal(burned.reason, 'already_minted');
    await sm.revert();
    const revived = await callReserve(
      evmUndo,
      encodeClaim(proved[0].nullifier, proved[0].nanos, proved[0].blob, 0, packVaultOutput(proved[0].note)),
    );
    assert.equal(revived.ok, true, revived.reason);
    assert.equal(word(revived.returnValue), PERIOD_NANOS);
  });
});

/**
 * Heavier-fork reorg across a withdraw on the store vault.
 * A withdraw tx is not fundable in a block at this stage, so the losing
 * fork applies withdraw() — the transition a withdraw block would run.
 * Replay of the heavier fork, which has no withdraw, restores the portal
 * and returns the minted interest to 0.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, hash20FromAddress } from '../../crypto/address.js';
import {
  PI_SHE_NANOS,
  GENESIS_BPS,
  EPOCH_DAYS_TESTNET,
} from '../../crypto/asert.js';
import { MS_PER_DAY } from '../../crypto/pot_sched.js';
import { withdraw, portalIdFromDest } from '../../crypto/reserve_vault.js';
import { lockTx } from '../../crypto/owned_portal.js';
import { levyNeed } from '../../crypto/levy.js';
import { createStore } from '../src/store.js';

const EPOCH_MS = EPOCH_DAYS_TESTNET * MS_PER_DAY;
const T0 = 1_700_000_000_000;
const TRUST = { trustBlockHash: true, skipSharePow: true };

function dest(byte) {
  return encodeDest(Buffer.alloc(20, byte));
}

function pow(tail) {
  return `${'00'.repeat(31)}${tail}`;
}

function publicLock(miner, portal) {
  const tx = lockTx({ from: miner, to: portal, nanos: PI_SHE_NANOS, id: 'reorg-lock' });
  const o = tx.vout[0];
  delete o.commit;
  delete o.rangeProof;
  delete o.r;
  delete o.noteCommit;
  delete o.admitPub;
  tx.vin = [{ dest20: hash20FromAddress(miner) }];
  tx.fee = levyNeed(tx, []);
  tx.maxLevy = tx.fee;
  return tx;
}

async function seal(store, miner, now, tail) {
  const { job } = store.template({ miner, now });
  return store.submitHeader({
    jobId: job.jobId,
    nonce: 0n,
    miner,
    powHash: pow(tail),
  }, { trusted: true });
}

function nanosOf(n) {
  return typeof n === 'bigint' ? n : BigInt(n);
}

describe('store reorg across a withdraw', () => {
  it('a heavier fork restores the portal and clears minted interest', async () => {
    const miner = dest(3);
    const portal = dest(9);
    const pid = portalIdFromDest(portal);
    const lockDelay = 90_000;
    const remain = EPOCH_MS - lockDelay;
    const interest = Number(
      (BigInt(PI_SHE_NANOS) * BigInt(GENESIS_BPS) * BigInt(remain))
      / (BigInt(EPOCH_MS) * 10000n),
    );
    assert.ok(interest > 0);
    const local = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wd-reorg-local-')));
    const peer = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wd-reorg-peer-')));

    const genesis = await seal(local, miner, T0, '11');
    assert.equal(genesis.ok, true, genesis.reason);
    const queued = local.queueTx(publicLock(miner, portal));
    assert.equal(queued.ok, true, queued.reason);
    const locked = await seal(local, miner, T0 + 90_000, '12');
    assert.equal(locked.ok, true, locked.reason);
    assert.equal(nanosOf(local.reserveVault.portals[pid].staked), BigInt(PI_SHE_NANOS));
    assert.equal(local.supplyState().mintedInterest, 0n);

    const shared = await Promise.resolve(peer.ingest(local.blocks.slice(0, 2), TRUST));
    assert.equal(shared.ok, true, shared.reason);

    const feeBefore = nanosOf(local.reserveVault.feeBankNanos);
    const drawn = withdraw({
      state: local.reserveVault,
      dest: portal,
      portalId: pid,
      nowMs: T0 + 90_000 + EPOCH_MS + 1,
    });
    assert.equal(drawn.ok, true, drawn.reason);
    assert.equal(drawn.interest, 0);
    assert.equal(drawn.earned, interest);
    assert.equal(drawn.mint, null);
    const minted = nanosOf(local.reserveVault.mintBankNanos);
    const fromFee = feeBefore - nanosOf(local.reserveVault.feeBankNanos);
    assert.equal(minted, 0n);
    assert.equal(fromFee, 0n);
    assert.equal(nanosOf(local.reserveVault.portals[pid].staked), 0n);
    assert.equal(local.supplyState().mintedInterest, 0n);

    const side = await seal(local, miner, T0 + 180_000, '13');
    assert.equal(side.ok, true, side.reason);
    assert.equal(local.tip().height, 3);
    assert.equal(nanosOf(local.reserveVault.portals[pid].staked), 0n);
    assert.equal(nanosOf(local.reserveVault.mintBankNanos), minted);

    const heavyA = await seal(peer, miner, T0 + 180_000, '21');
    assert.equal(heavyA.ok, true, heavyA.reason);
    const heavyB = await seal(peer, miner, T0 + 270_000, '22');
    assert.equal(heavyB.ok, true, heavyB.reason);
    assert.equal(peer.blocks.slice(2).some((b) => (b.txs || []).some((tx) => tx?.kind === 'withdraw')), false);

    const reorged = await Promise.resolve(local.ingest(peer.blocks.slice(2), TRUST));
    assert.equal(reorged.ok, true, reorged.reason);
    assert.equal(reorged.reorg, true);
    assert.equal(Buffer.from(local.tip().hash).equals(Buffer.from(peer.tip().hash)), true);
    assert.equal(nanosOf(local.reserveVault.portals[pid].staked), BigInt(PI_SHE_NANOS));
    assert.equal(nanosOf(local.reserveVault.totalLockedNanos), BigInt(PI_SHE_NANOS));
    assert.equal(local.reserveVault.portals[pid].joined, true);
    assert.equal(nanosOf(local.reserveVault.mintBankNanos), 0n);
    assert.equal(local.supplyState().mintedInterest, 0n);
  });
});

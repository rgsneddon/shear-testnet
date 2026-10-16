/**
 * Heavier-fork reorg of a note-funded lock.
 * A lock tx is not fundable in a block at this stage, and a public dest20
 * receipt is refused, so the losing fork applies the lock with
 * applyReserveBlock — the transition a note-funded lock block would run.
 * The input opens to at least the lock. Replay of the heavier fork, which
 * has no lock, unwinds that principal. A withdraw of the same lock pays
 * principal only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, newIdentity } from '../../crypto/address.js';
import { destCommitFromSpendPub } from '../../crypto/stealth_ed25519.js';
import { signSpendTx } from '../../crypto/spend.js';
import {
  PI_SHE_NANOS,
  GENESIS_BPS,
  EPOCH_DAYS_TESTNET,
} from '../../crypto/asert.js';
import { MS_PER_DAY } from '../../crypto/pot_sched.js';
import { applyReserveBlock, cloneVault, portalIdFromDest, withdraw } from '../../crypto/reserve_vault.js';
import { lockTx } from '../../crypto/owned_portal.js';
import { levyNeed } from '../../crypto/levy.js';
import { kernelExcess, noteU64, sealCoinbaseNote, verifySealedNote } from '../../crypto/note.js';
import { publicReserveReceipt } from '../../crypto/dummy.js';
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

function noteLock(portal, key) {
  const tx = lockTx({ from: portal, to: portal, nanos: PI_SHE_NANOS, id: 'reorg-lock' });
  let fee = 0;
  const arm = (nextFee) => {
    const sealed = sealCoinbaseNote(PI_SHE_NANOS + nextFee, {
      dest20: Buffer.alloc(20, 7),
      kind: 'pot',
    });
    tx.vin = [{
      commit: sealed.commit,
      valueProof: sealed.valueProof,
      rangeProof: sealed.rangeProof,
    }];
    tx.fee = nextFee;
    tx.maxLevy = nextFee;
    tx.excess = kernelExcess(tx.vout, [{ r: sealed.r }]);
  };
  arm(0);
  for (let i = 0; i < 6; i += 1) {
    const next = levyNeed(tx, []);
    if (next === fee) break;
    fee = next;
    arm(fee);
  }
  signSpendTx(tx, key);
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

describe('store reorg across a note-funded lock', () => {
  it('a heavier fork unwinds principal the losing fork locked', async () => {
    const miner = dest(3);
    const who = newIdentity();
    const portal = encodeDest(destCommitFromSpendPub(who.spendPub));
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
    const shared = await Promise.resolve(peer.ingest(local.blocks.slice(0, 1), TRUST));
    assert.equal(shared.ok, true, shared.reason);
    const side = await seal(local, miner, T0 + 90_000, '13');
    assert.equal(side.ok, true, side.reason);
    assert.equal(local.tip().height, 2);

    const lock = noteLock(portal, who.privateKey);
    const opened = noteU64(lock.vin[0].valueProof.v);
    assert.equal(publicReserveReceipt(lock), false);
    assert.equal(opened != null && verifySealedNote(lock.vin[0], opened), true);
    assert.ok(opened >= BigInt(PI_SHE_NANOS));
    const applied = applyReserveBlock({
      state: local.reserveVault,
      block: { height: 2, txs: [lock] },
      nowMs: T0 + 90_000,
      genesisMs: T0,
    });
    const lockedRow = (applied || []).find((row) => row && row.action === 'lock');
    assert.equal(lockedRow && lockedRow.ok, true, lockedRow && lockedRow.reason);
    assert.equal(nanosOf(local.reserveVault.portals[pid].staked), BigInt(PI_SHE_NANOS));
    assert.equal(nanosOf(local.reserveVault.totalLockedNanos), BigInt(PI_SHE_NANOS));
    assert.equal(local.supplyState().mintedInterest, 0n);

    const paid = cloneVault(local.reserveVault);
    const feeBefore = nanosOf(paid.feeBankNanos);
    const drawn = withdraw({
      state: paid,
      dest: portal,
      portalId: pid,
      nowMs: T0 + 90_000 + EPOCH_MS + 1,
    });
    assert.equal(drawn.ok, true, drawn.reason);
    assert.equal(drawn.interest, 0);
    assert.equal(drawn.earned, interest);
    assert.equal(drawn.mint, null);
    const minted = nanosOf(paid.mintBankNanos);
    const fromFee = feeBefore - nanosOf(paid.feeBankNanos);
    assert.equal(minted, 0n);
    assert.equal(fromFee, 0n);
    assert.equal(nanosOf(paid.portals[pid].staked), 0n);
    assert.equal(nanosOf(local.reserveVault.portals[pid].staked), BigInt(PI_SHE_NANOS));
    assert.equal(local.supplyState().mintedInterest, 0n);

    assert.equal(nanosOf(local.reserveVault.portals[pid].staked), BigInt(PI_SHE_NANOS));
    assert.equal(nanosOf(local.reserveVault.totalLockedNanos), BigInt(PI_SHE_NANOS));

    const heavyA = await seal(peer, miner, T0 + 180_000, '21');
    assert.equal(heavyA.ok, true, heavyA.reason);
    const heavyB = await seal(peer, miner, T0 + 270_000, '22');
    assert.equal(heavyB.ok, true, heavyB.reason);
    assert.equal(peer.blocks.slice(1).some((b) => (b.txs || []).some((tx) => tx?.kind === 'lock')), false);

    const reorged = await Promise.resolve(local.ingest(peer.blocks.slice(1), TRUST));
    assert.equal(reorged.ok, true, reorged.reason);
    assert.equal(reorged.reorg, true);
    assert.equal(Buffer.from(local.tip().hash).equals(Buffer.from(peer.tip().hash)), true);
    assert.equal(local.reserveVault.portals[pid], undefined);
    assert.equal(nanosOf(local.reserveVault.totalLockedNanos), 0n);
    assert.equal(nanosOf(local.reserveVault.mintBankNanos), 0n);
    assert.equal(local.supplyState().mintedInterest, 0n);
  });
});

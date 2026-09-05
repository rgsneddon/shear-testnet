import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printConfig } from '../src/node.js';
import { createStore } from '../src/store.js';
import { mineTemplate } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  RESERVE_PROGRAM,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  LIVE_MIN_BITS,
  SPENDABLE_CONFIRMATIONS,
  NANOS_PER_SHE,
} from '../../crypto/asert.js';
import { RESERVE_ORACLE_ID, RESERVE_ORACLE_DEFAULT_BPS, interestNanos } from '../../crypto/reserve_oracle.js';
import {
  publicVaultView,
  previewWithdraw,
  lockTx,
  withdrawTx,
  portalIdFromDest,
} from '../../crypto/reserve_vault.js';
import { newIdentity, destOpeningFromView, hash20FromAddress, payoutDest } from '../../crypto/address.js';
import { vaultDest } from '../../crypto/flow_sheet.js';
import { matureSpendableNanos } from '../../crypto/spend.js';

async function mineOne(store, dest, { bits = 4, now } = {}) {
  const parent = store.tip();
  const stamp = now != null
    ? now
    : (parent
      ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
      : Date.now());
  const { tpl } = store.template({ miner: dest, bits, shareBits: bits, now: stamp });
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: bits });
  assert.ok(found && found.block, 'need pow');
  const got = await store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
  });
  assert.equal(got.ok, true, got.reason || got.error);
  return got;
}

function spendableOf(store, dest) {
  const tipH = Number(store.tip()?.height || 0);
  return matureSpendableNanos(store.historyFor(dest), dest, tipH);
}

describe('node Reserve vault', () => {
  it('printConfig names the Reserve oracle and epoch', () => {
    const c = printConfig();
    assert.equal(c.reserveProgram, RESERVE_PROGRAM);
    assert.equal(c.extraMintOnlyReserve, true);
    assert.equal(c.reserveEpochDays, 400);
    assert.equal(c.reserveJoinCutoffDays, 99);
    assert.equal(c.reserveOracle, RESERVE_ORACLE_ID);
    assert.equal(c.reserveOracleDefaultBps, RESERVE_ORACLE_DEFAULT_BPS);
    assert.equal(c.mainnet, false);
  });

  it('lock spends mature Continuum, refuses when spendable is short, withdraw returns principal + staked interest', { timeout: 600_000 }, async () => {
    const alice = newIdentity();
    const continuum = payoutDest(alice.paymentCode);
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const open = destOpeningFromView(alice.viewKey, hash20FromAddress(alice.address), 0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reserve-append-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    const pid = portalIdFromDest(vault);

    const lock = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-1' });
    lock.open = open;

    const unfunded = store.queueTx(lock);
    assert.equal(unfunded.ok, false);
    assert.equal(unfunded.reason, 'insufficient');
    assert.equal(store.reserveVault.totalLockedNanos, 0);

    const fundBlocks = 4;
    for (let i = 0; i < fundBlocks + SPENDABLE_CONFIRMATIONS; i += 1) {
      await mineOne(store, continuum, { bits: LIVE_MIN_BITS, now: t0 + i * 90_000 });
    }
    const before = spendableOf(store, continuum);
    assert.ok(before >= fundBlocks * NANOS_PER_SHE, `spendable ${before} after ${fundBlocks} pots`);
    assert.ok(before >= PI_SHE_NANOS);

    const unsigned = store.queueTx(lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-unsigned' }));
    assert.equal(unsigned.ok, false);
    assert.equal(unsigned.reason, 'unsigned');
    assert.equal(store.reserveVault.totalLockedNanos, 0);
    assert.equal(spendableOf(store, continuum), before);

    const tooMuch = lockTx({
      from: continuum,
      to: vault,
      nanos: before + NANOS_PER_SHE,
      id: 'lock-too-much',
    });
    tooMuch.open = open;
    const refused = store.queueTx(tooMuch);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'insufficient');
    assert.equal(store.reserveVault.totalLockedNanos, 0);
    assert.equal(store.reserveVault.portals[pid], undefined);
    assert.equal(spendableOf(store, continuum), before);

    const queued = store.queueTx(lock);
    assert.equal(queued.ok, true, queued.reason);
    await mineOne(store, continuum, {
      bits: LIVE_MIN_BITS,
      now: t0 + (fundBlocks + SPENDABLE_CONFIRMATIONS) * 90_000,
    });
    assert.equal(store.reserveVault.epochStartMs > 0, true);
    assert.equal(store.reserveVault.totalLockedNanos, PI_SHE_NANOS);
    assert.equal(store.reserveVault.portals[pid].staked, PI_SHE_NANOS);
    assert.equal(store.reserveVault.portals[pid].joined, true);
    const afterLock = spendableOf(store, continuum);
    // Mining the lock block also matures one more prior pot (same miner).
    assert.equal(afterLock, before - PI_SHE_NANOS + NANOS_PER_SHE);
    const pub = JSON.stringify(publicVaultView(store.reserveVault, t0));
    assert.equal(pub.includes(alice.address), false);
    assert.equal(pub.includes(alice.viewKey), false);
    assert.equal(pub.includes('shear1'), false);

    const preview = previewWithdraw(store.reserveVault, vault);
    assert.equal(preview.to, continuum);
    assert.ok(preview.interest > 0);
    assert.equal(preview.interest, interestNanos(PI_SHE_NANOS, RESERVE_ORACLE_DEFAULT_BPS, 400));

    const lockStamp = Number(decodeHeader(Buffer.from(store.tip().header)).timestamp);
    const t1 = lockStamp + RESERVE_EPOCH_MS;
    const wd = withdrawTx({
      from: vault,
      to: continuum,
      nanos: preview.payout,
      id: 'wd-1',
    });
    const qwd = store.queueTx(wd);
    assert.equal(qwd.ok, true, qwd.reason);
    await mineOne(store, continuum, { bits: LIVE_MIN_BITS, now: t1 });
    assert.equal(store.reserveVault.totalLockedNanos, 0);
    assert.equal(store.reserveVault.portals[pid].staked, 0);
    for (let i = 1; i <= SPENDABLE_CONFIRMATIONS; i += 1) {
      await mineOne(store, continuum, { bits: LIVE_MIN_BITS, now: t1 + i * 90_000 });
    }
    const afterWd = spendableOf(store, continuum);
    assert.ok(afterWd >= afterLock + preview.payout, `withdraw must credit Continuum, have ${afterWd}`);

    const again = createStore(dir);
    assert.equal(again.reserveVault.totalLockedNanos, 0);
    assert.equal(JSON.stringify(again.reserveVault).includes(alice.address), false);
    assert.equal(JSON.stringify(again.reserveVault).includes(alice.viewKey), false);
  });
});

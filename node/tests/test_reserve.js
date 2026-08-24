import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printConfig } from '../src/node.js';
import { createStore } from '../src/store.js';
import {
  buildTemplate,
  mineTemplate,
  GENESIS_PREV,
} from '../src/chain.js';
import { RESERVE_PROGRAM, PI_SHE_NANOS, RESERVE_EPOCH_MS } from '../../crypto/asert.js';
import { RESERVE_ORACLE_ID, RESERVE_ORACLE_DEFAULT_BPS, interestNanos } from '../../crypto/reserve_oracle.js';
import {
  publicVaultView,
  previewWithdraw,
  lockTx,
  withdrawTx,
  portalIdFromDest,
} from '../../crypto/reserve_vault.js';
import { newIdentity } from '../../crypto/address.js';
import { vaultDest, destForLogin } from '../../crypto/flow_sheet.js';

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
  };
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

  it('append of a lock to vaultDest updates the node vault; withdraw pays Continuum', () => {
    const alice = newIdentity();
    const continuum = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reserve-append-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    const lock = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-1' });
    const b1 = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: continuum,
      bits: 8,
      now: t0,
      txs: [lock],
    }));
    const appended = store.append(b1);
    assert.equal(appended.ok, true, appended.reason);
    assert.equal(store.reserveVault.epochStartMs, t0);
    assert.equal(store.reserveVault.totalLockedNanos, PI_SHE_NANOS);
    const pid = portalIdFromDest(vault);
    assert.equal(store.reserveVault.portals[pid].staked, PI_SHE_NANOS);
    assert.equal(store.reserveVault.portals[pid].joined, true);
    const pub = JSON.stringify(publicVaultView(store.reserveVault, t0));
    assert.equal(pub.includes(alice.address), false);
    assert.equal(pub.includes(alice.viewKey), false);
    assert.equal(pub.includes('shear1'), false);

    const preview = previewWithdraw(store.reserveVault, vault);
    assert.equal(preview.to, continuum);
    assert.ok(preview.interest > 0);
    assert.equal(preview.interest, interestNanos(PI_SHE_NANOS, RESERVE_ORACLE_DEFAULT_BPS, 400));
    const t1 = t0 + RESERVE_EPOCH_MS;
    const wd = withdrawTx({
      from: vault,
      to: continuum,
      nanos: preview.payout,
      id: 'wd-1',
    });
    const tip = store.tip();
    const b2 = mine(buildTemplate({
      prev: tip.hash,
      prevHeader: tip.header,
      height: 2,
      miner: continuum,
      bits: 8,
      now: t1,
      txs: [wd],
    }));
    const released = store.append(b2);
    assert.equal(released.ok, true, released.reason);
    assert.equal(store.reserveVault.totalLockedNanos, 0);
    assert.equal(store.reserveVault.portals[pid].staked, 0);
    const rows = store.historyFor(continuum);
    const payout = rows.find((r) => r.kind === 'withdraw' && r.to === continuum);
    assert.ok(payout);
    assert.equal(payout.nanos, preview.payout);
    assert.equal(payout.nanos, PI_SHE_NANOS + preview.interest);

    const again = createStore(dir);
    assert.equal(again.reserveVault.epochStartMs, t0);
    assert.equal(again.reserveVault.totalLockedNanos, 0);
    assert.equal(JSON.stringify(again.reserveVault).includes(alice.address), false);
    assert.equal(JSON.stringify(again.reserveVault).includes(alice.viewKey), false);
  });
});

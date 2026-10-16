import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { consensusFingerprint, MAGIC_TESTNET, PI_SHE_NANOS, PRODUCT_VERSION } from '../../crypto/asert.js';
import { NODE_DISPLAY } from '../src/product.js';
import { deposit, emptyVault } from '../../crypto/reserve_vault.js';
import { encodeDest } from '../../crypto/address.js';
import { createRpc } from '../src/rpc.js';
import { printConfig } from '../src/node.js';
import { bpsFromSnapshot, loadOracleSnapshot, oracleView } from '../src/oracle_feed.js';

describe('Shear Sentinel staking oracle', () => {
  it('reads the bundled basket without moving the sealed epoch rate', () => {
    const vault = emptyVault();
    vault.epochBps = 264;
    vault.oracle.annualBps = 264;
    const snap = loadOracleSnapshot();
    assert.equal(bpsFromSnapshot(snap).annualBps, 281);
    const now = Date.parse('2026-11-15T12:00:00Z');
    const view = oracleView(vault, snap, now);
    assert.equal(view.id, 'shear-reserve-oracle-v1');
    assert.equal(view.annualBps, 281);
    assert.equal(view.displayOnly, true);
    assert.equal(view.stale, true);
    assert.equal(view.wouldFreezeBps, 281);
    assert.equal(view.epochBps, 264);
    assert.equal(view.mintUses, 'epochBps');
    assert.equal(view.sourceCount, 14);
    assert.equal(vault.epochBps, 264);
    assert.equal(vault.oracle.annualBps, 264);
    assert.equal(consensusFingerprint().includes('Sentinel'), false);
    assert.equal(consensusFingerprint().includes('11.0'), false);
    assert.equal(consensusFingerprint().includes('12.0'), false);
    assert.equal(consensusFingerprint().includes('13.0'), false);
  });

  it('a fresh local basket does not name the next freeze', () => {
    const vault = emptyVault();
    vault.epochBps = 264;
    const now = Date.parse('2026-09-29T12:00:00Z');
    const snap = {
      version: 'shear-reserve-oracle-v1',
      observedAt: new Date(now).toISOString(),
      averagePercent: 4,
      components: [],
    };
    const view = oracleView(vault, snap, now);
    assert.equal(view.stale, false);
    assert.equal(view.annualBps, 281);
    assert.equal(view.wouldFreezeBps, 281);
    assert.equal(view.callerBasketIgnored, true);
    assert.equal(vault.epochBps, 264);
    assert.equal(bpsFromSnapshot({ version: 'other', averagePercent: 4 }), null);
  });

  it('getoracle and getreserve answer staking without opening a portal', () => {
    const vault = emptyVault();
    const dest = encodeDest(Buffer.alloc(20, 4));
    const rpc = createRpc({
      store: {
        reserveVault: vault,
        oracleSnapshot: loadOracleSnapshot(),
        tip: () => null,
        mempool: [],
      },
      port: 0,
      host: '127.0.0.1',
    });
    try {
      const oracle = rpc.dispatch('getoracle');
      assert.equal(oracle.ok, true);
      assert.equal(oracle.id, 'shear-reserve-oracle-v1');
      assert.equal(oracle.mintUses, 'epochBps');
      assert.equal(typeof oracle.observeCall, 'string');
      assert.equal(oracle.observeCall.length > 8, true);
      const pub = rpc.dispatch('getreserve');
      assert.equal(pub.ok, true);
      assert.equal(pub.votes.increase, 0);
      assert.equal(pub.address, undefined);
      const one = rpc.dispatch('reserve', { address: dest });
      assert.equal(one.ok, true);
      assert.equal(one.portal.staked, 0);
      assert.equal(one.portal.accrued, 0);
      assert.equal(Object.keys(vault.portals).length, 0);
      const cfg = printConfig();
      assert.equal(cfg.display, NODE_DISPLAY);
      assert.equal(cfg.version, PRODUCT_VERSION);
      assert.equal(NODE_DISPLAY, `Shear Sentinel v${PRODUCT_VERSION.split('.')[0]}`);
    } finally {
      rpc.close();
    }
  });

  it('GET /api/reserve?address= shows zero staked, idle, and accrued for a hidden lock', async () => {
    const vault = emptyVault();
    vault.genesisMs = 1_700_000_000_000;
    vault.magic = MAGIC_TESTNET;
    const dest = encodeDest(Buffer.alloc(20, 4));
    const locked = deposit({
      state: vault,
      dest,
      nanos: PI_SHE_NANOS,
      nowMs: vault.genesisMs,
      ownerPub: '11'.repeat(32),
    });
    assert.equal(locked.ok, true, locked.reason);
    assert.equal(Number(vault.portals[Object.keys(vault.portals)[0]].staked), 0);
    assert.equal(Number(vault.portals[Object.keys(vault.portals)[0]].idle), 0);
    const rpc = createRpc({
      store: {
        reserveVault: vault,
        oracleSnapshot: loadOracleSnapshot(),
        tip: () => null,
        mempool: [],
      },
      port: 0,
      host: '127.0.0.1',
    });
    try {
      const info = await rpc.listen();
      const res = await fetch(`http://127.0.0.1:${info.port}/api/reserve?address=${encodeURIComponent(dest)}`);
      assert.equal(res.status, 200);
      const one = await res.json();
      assert.equal(one.ok, true, one.reason);
      assert.equal(one.portal.staked, 0);
      assert.equal(one.portal.idle, 0);
      assert.equal(one.portal.accrued, 0);
    } finally {
      await rpc.close();
    }
  });
});

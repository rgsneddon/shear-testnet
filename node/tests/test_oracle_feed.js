import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { consensusFingerprint } from '../../crypto/asert.js';
import { emptyVault } from '../../crypto/reserve_vault.js';
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
    assert.equal(bpsFromSnapshot(snap).annualBps, 264);
    const now = Date.parse('2026-09-29T12:00:00Z');
    const view = oracleView(vault, snap, now);
    assert.equal(view.id, 'shear-reserve-oracle-v1');
    assert.equal(view.annualBps, 264);
    assert.equal(view.stale, true);
    assert.equal(view.wouldFreezeBps, 264);
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

  it('a fresh basket names the next freeze and leaves this epoch untouched', () => {
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
    assert.equal(view.annualBps, 400);
    assert.equal(view.wouldFreezeBps, 364);
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
      assert.equal(cfg.display, 'Shear Sentinel v18');
      assert.equal(cfg.version, '18.0');
    } finally {
      rpc.close();
    }
  });
});

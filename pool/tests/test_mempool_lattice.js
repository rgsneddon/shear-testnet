import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDest } from '../../crypto/address.js';
import { mempoolLattice } from '../src/wallet_api.js';

describe('mempool lattice pending rings', () => {
  it('exposes forming-block hashes and fee-weighted pending sends', () => {
    const dest = encodeDest(Buffer.alloc(20, 7));
    const store = {
      blocks: [{ height: 10, hash: Buffer.alloc(32, 1), header: Buffer.alloc(128), txs: [{ coinbase: true, vout: [{ address: dest, nanos: 1, kind: 'coinbase' }] }] }],
      tip() { return this.blocks[0]; },
      mempool: [
        { id: 'tx-hi', kind: 'send', to: dest, nanos: 3, fee: 8, vout: [{ address: dest }] },
        { id: 'tx-lo', kind: 'send', to: dest, nanos: 1, fee: 1, vout: [{ address: dest }] },
      ],
      jobs: new Map(),
      reserveVault: { liveHashBonusNanos: 1 },
    };
    const miners = new Map([
      ['a', { login: `${dest}.rig`, roundHashes: 40, clientHashes: 40, clientHashesRound0: 0 }],
    ]);
    const out = mempoolLattice(store, { miners, lastJob: { height: 11, jobId: 'j1', bits: 21 } });
    assert.equal(out.ok, true);
    assert.equal(out.pendingBlock.height, 11);
    assert.equal(out.pendingBlock.hashes, 40);
    assert.equal(out.pendingBlock.txs[0].kind, 'hash');
    assert.equal(out.pendingBlock.txs[0].count, 40);
    assert.ok(out.pending.length >= 2);
    assert.equal(out.pending[0].id, 'tx-hi');
    assert.ok(out.pending[0].priority > out.pending[1].priority);
    assert.ok(out.pending[0].weight >= 1);
    assert.equal(out.pending[0].fee, 8);
    assert.equal(out.targetBlockIntervalMs, 90_000);
    assert.equal(out.scope, 'network');
  });

  it('unions peer open-round rows into the lattice without a local stratum table', () => {
    const dest = encodeDest(Buffer.alloc(20, 9));
    const store = {
      blocks: [{ height: 4, hash: Buffer.alloc(32, 2), header: Buffer.alloc(128), txs: [{ coinbase: true, vout: [{ address: dest, nanos: 1, kind: 'coinbase' }] }] }],
      tip() { return this.blocks[0]; },
      mempool: [{ id: 'peer-send', kind: 'send', to: dest, nanos: 2, fee: 3, vout: [{ address: dest }] }],
      jobs: new Map(),
      reserveVault: { liveHashBonusNanos: 1 },
      openRoundRows() {
        return [{ tag: 'she1cafef00d', count: 77, source: 'peer' }];
      },
    };
    const out = mempoolLattice(store, {
      miners: new Map(),
      lastJob: { height: 5, jobId: 'solo', bits: 21 },
      nodesOnline: 3,
    });
    assert.equal(out.ok, true);
    assert.equal(out.scope, 'network');
    assert.equal(out.nodesOnline, 3);
    assert.equal(out.pending.some((t) => t.id === 'peer-send'), true);
    const row = out.pendingBlock.txs.find((t) => t.tag === 'she1cafef00d');
    assert.ok(row, 'peer miner row missing from forming hoop');
    assert.equal(row.kind, 'hash');
    assert.equal(row.count, 77);
    assert.equal(row.source, 'peer');
    assert.equal(out.pendingBlock.hashes, 77);
  });
});

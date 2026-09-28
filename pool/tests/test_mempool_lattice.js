import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { networkMempoolWire } from '../../node/src/p2p_ipc.js';
import { createPool } from '../src/pool.js';
import { mempoolLattice } from '../src/wallet_api.js';

describe('mempool lattice pending rings', () => {
  it('exposes forming-block hashes and fee-weighted pending sends', () => {
    const dest = encodeDest(Buffer.alloc(20, 7));
    const store = {
      blocks: [{ height: 10, hash: Buffer.alloc(32, 1), header: Buffer.alloc(128), txs: [{ coinbase: true, vout: [{ address: dest, nanos: 1, kind: 'coinbase' }, { address: dest, nanos: 256, kind: 'hash' }] }] }],
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
    assert.match(out.pendingBlock.txs[0].tag, /^m[0-9a-f]{8}$/);
    assert.doesNotMatch(out.pendingBlock.txs[0].tag, /^she1/);
    assert.ok(out.pending.length >= 2);
    assert.equal(out.pending[0].id, 'tx-hi');
    assert.ok(out.pending[0].priority > out.pending[1].priority);
    assert.ok(out.pending[0].weight >= 1);
    assert.equal(out.pending[0].fee, 8);
    assert.equal(out.targetBlockIntervalMs, 90_000);
    assert.equal(out.scope, 'network');
    for (const row of out.pending) {
      assert.equal(row.to, undefined);
      assert.equal(row.amount, undefined);
      assert.equal(row.nanos, undefined);
    }
    for (const g of out.generations) {
      assert.ok(Number(g.confirmations) >= 1);
      assert.equal(typeof g.spendable, 'boolean');
      for (const tx of g.txs || []) {
        assert.equal(tx.to, undefined);
        assert.equal(tx.amount, undefined);
        assert.equal(tx.nanos, undefined);
        assert.ok(tx.kind);
      }
    }
    for (const h of out.pendingBlock.txs) {
      assert.equal(h.amount, undefined);
      assert.equal(h.to, undefined);
    }
    const gen = out.generations.find((g) => g.height === 10);
    assert.ok(gen, 'sealed height missing from lattice generations');
    assert.equal(gen.txs.some((t) => t.kind === 'hash'), true);
    assert.equal(typeof gen.confirming, 'boolean');
    const blob = JSON.stringify(out);
    assert.doesNotMatch(blob, /ssa1/);
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
        return [{ tag: 'mcafef00d', count: 77, source: 'peer' }];
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
    const row = out.pendingBlock.txs.find((t) => t.tag === 'mcafef00d');
    assert.ok(row, 'peer miner row missing from forming hoop');
    assert.equal(row.kind, 'hash');
    assert.equal(row.count, 77);
    assert.equal(row.source, 'peer');
    assert.equal(out.pendingBlock.hashes, 77);
    assert.equal(out.pending.find((t) => t.id === 'peer-send').to, undefined);
    assert.equal(out.pending.find((t) => t.id === 'peer-send').amount, undefined);
    assert.equal(row.amount, undefined);
    assert.doesNotMatch(JSON.stringify(out), /ssa1/);
  });

  it('network snapshot replaces the pool private list', () => {
    const dest = encodeDest(Buffer.alloc(20, 4));
    const store = {
      blocks: [],
      tip() { return null; },
      mempool: [{ id: 'pool-private', kind: 'send', fee: 9, to: dest, vout: [{ address: dest }] }],
      jobs: new Map(),
      openRoundRows() { return [{ tag: 'm00112233', count: 3, source: 'local' }]; },
    };
    const out = mempoolLattice(store, {
      miners: new Map(),
      nodesOnline: 4,
      networkPending: [{ id: 'net-send', kind: 'send', fee: 4, weight: 3, to: dest }],
      networkRounds: [{ tag: 'mabcdef01', count: 12, source: 'peer' }],
    });
    assert.equal(out.pending.some((t) => t.id === 'pool-private'), false);
    assert.equal(out.pending.find((t) => t.id === 'net-send').fee, 4);
    assert.equal(out.pending.find((t) => t.id === 'net-send').weight, 3);
    assert.equal(out.pending.find((t) => t.id === 'net-send').to, undefined);
    assert.equal(out.pendingBlock.txs.some((t) => t.tag === 'm00112233'), false);
    assert.equal(out.pendingBlock.txs.find((t) => t.tag === 'mabcdef01').count, 12);
    assert.equal(out.nodesOnline, 4);
    assert.doesNotMatch(JSON.stringify(out), /ssa1/);
  });

  it('a public snapshot ignores the pool stratum table and private mempool', () => {
    const dest = encodeDest(Buffer.alloc(20, 8));
    const store = {
      blocks: [],
      tip() { return null; },
      mempool: [{ id: 'pool-private', kind: 'send', fee: 9, to: dest, vout: [{ address: dest }] }],
      jobs: new Map(),
      openRoundRows() { return [{ tag: 'm00112233', count: 3, source: 'local' }]; },
    };
    const miners = new Map([
      ['a', { login: `${dest}.rig`, roundHashes: 40, clientHashes: 40, clientHashesRound0: 0 }],
    ]);
    const out = mempoolLattice(store, {
      miners,
      networkPending: [],
      networkRounds: [],
    });
    assert.equal(out.pending.length, 0);
    assert.equal(out.pendingBlock.txs.length, 0);
    assert.equal(out.pendingBlock.hashes, 0);
    const direct = mempoolLattice(store, { miners });
    assert.equal(direct.pending.some((t) => t.id === 'pool-private'), true);
    assert.equal(direct.pendingBlock.txs.some((t) => t.count === 40), true);
    assert.equal(direct.pendingBlock.txs.some((t) => t.tag === 'm00112233'), true);
  });

  it('the sidecar wire carries id, kind, fee, and weight only', () => {
    const dest = encodeDest(Buffer.alloc(20, 5));
    const wire = networkMempoolWire({
      mempool: [{ id: 'net-1', kind: 'lock', fee: 2, to: dest, vout: [{ address: dest, nanos: 9 }] }],
      openRoundRows() { return [{ tag: 'mabcdef01', count: 5, source: 'peer' }]; },
    }, {
      syncedOnline: () => 3,
      liveOnline: () => 4,
    });
    assert.equal(wire.txs[0].id, 'net-1');
    assert.equal(wire.txs[0].kind, 'lock');
    assert.equal(wire.txs[0].fee, 2);
    assert.ok(wire.txs[0].weight >= 1);
    assert.equal(wire.synced, 3);
    assert.equal(wire.peers, 4);
    assert.equal(wire.rounds[0].tag, 'mabcdef01');
    assert.equal(JSON.stringify(wire).includes(dest), false);
    assert.doesNotMatch(JSON.stringify(wire), /ssa1|nanos|address/);
  });

  it('GET /api/mempool paints the network snapshot, not the pool private list', async () => {
    const dest = encodeDest(Buffer.alloc(20, 6));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-net-mempool-'));
    const pool = createPool({
      dataDir: dir,
      miner: dest,
      stratumPort: 0,
      httpPort: 0,
    });
    try {
      const heard = await pool.listen();
      pool.store.mempool.push({
        id: 'pool-private',
        kind: 'send',
        fee: 9,
        to: dest,
        vout: [{ address: dest }],
      });
      const hidden = await fetch(`http://127.0.0.1:${heard.httpPort}/api/mempool`).then((r) => r.json());
      assert.equal(hidden.ok, true);
      assert.equal(hidden.pending.some((t) => t.id === 'pool-private'), false);
      pool.setNetworkView({
        txs: [{ id: 'net-send', kind: 'send', fee: 4, weight: 3, to: dest }],
        rounds: [{ tag: 'mabcdef01', count: 9, source: 'peer' }],
        synced: 4,
      });
      const shown = await fetch(`http://127.0.0.1:${heard.httpPort}/api/mempool`).then((r) => r.json());
      assert.equal(shown.pending.some((t) => t.id === 'pool-private'), false);
      assert.equal(shown.pending.find((t) => t.id === 'net-send').fee, 4);
      assert.equal(shown.nodesOnline, 4);
      assert.equal(shown.pendingBlock.txs.find((t) => t.tag === 'mabcdef01').count, 9);
      assert.equal(JSON.stringify(shown).includes(dest), false);
      const stats = await fetch(`http://127.0.0.1:${heard.httpPort}/api/stats`).then((r) => r.json());
      assert.equal(stats.gossipWorkers.length, 1);
      assert.equal(stats.gossipWorkers[0].miner, 'mabcdef01');
      assert.equal(stats.gossipWorkers[0].roundHashes, 9);
      assert.equal(stats.nodesOnline, 4);
    } finally {
      pool.close();
    }
  });
});

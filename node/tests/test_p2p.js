import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { P2P_PORT } from '../src/p2p.js';
import { mineTemplate } from '../src/chain.js';
import { printConfig, startNode } from '../src/node.js';
import { countSyncedOnline } from '../src/p2p.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 5));
}

function mineOne(store, dest, bits = 8) {
  const { tpl } = store.template({ miner: dest, bits, shareBits: bits });
  const found = mineTemplate({ ...tpl, bits }, { maxTries: 3_000_000, shareBits: bits });
  assert.ok(found && found.block, 'need pow');
  return store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
  });
}

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe('p2p gossip', () => {
  it('two loopback nodes converge on the same most-work tip', async () => {
    const dest = destMiner();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      const mined = mineOne(a.store, dest);
      assert.equal(mined.ok, true, mined.reason);
      a.p2p.announce();
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const synced = await waitFor(() => {
        const ta = a.store.tip();
        const tb = b.store.tip();
        if (!ta || !tb) return false;
        return ta.height === tb.height
          && Buffer.from(ta.hash).equals(Buffer.from(tb.hash));
      });
      assert.equal(synced, true);
      assert.equal(a.store.tip().height, 1);
      assert.equal(b.store.tip().height, 1);
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
  });

  it('counts currently seen synced remotes, not historical uniques', () => {
    const local = 'abc';
    const live = [
      { remote: '1.1.1.1', hash: 'abc', id: 1 },
      { remote: '2.2.2.2', hash: 'abc', id: 2 },
      { remote: '3.3.3.3', hash: 'old', id: 3 },
    ];
    assert.equal(countSyncedOnline({ localHash: local, peers: live }), 3);
    assert.equal(countSyncedOnline({
      localHash: local,
      peers: live.filter((p) => p.remote !== '2.2.2.2'),
    }), 2);
    assert.equal(countSyncedOnline({
      localHash: local,
      peers: [
        { remote: '1.1.1.1', hash: 'abc', id: 1 },
        { remote: '1.1.1.1', hash: 'abc', id: 9 },
      ],
    }), 2);
    assert.equal(countSyncedOnline({ localHash: local, peers: [] }), 1);
  });

  it('two connected empty nodes each see the other as online, then drop on close', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-on-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-on-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      assert.equal(a.p2p.syncedOnline(), 1);
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const both = await waitFor(() => a.p2p.syncedOnline() === 2 && b.p2p.syncedOnline() === 2);
      assert.equal(both, true);
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
    assert.equal(a.p2p.syncedOnline(), 1);
  });

  it('gossips pending sends and open-round miner rows onto a peer lattice', async () => {
    const dest = destMiner();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-mem-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-mem-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const linked = await waitFor(() => a.p2p.syncedOnline() === 2 && b.p2p.syncedOnline() === 2);
      assert.equal(linked, true);
      const { levyNanos } = await import('../../crypto/levy.js');
      const sendNanos = 2;
      const fee = levyNanos(sendNanos);
      const queued = a.store.queueTx({
        id: 'net-send-1',
        kind: 'send',
        from: dest,
        to: dest,
        nanos: sendNanos,
        fee,
        vin: [{ address: dest }],
        vout: [{ address: dest, nanos: sendNanos, kind: 'send' }],
      });
      assert.equal(queued.ok, true, queued.reason);
      const tag = 'she1cafef00d';
      a.p2p.publishWork([{ tag, count: 42 }]);
      const saw = await waitFor(() => {
        const tx = (b.store.mempool || []).some((t) => String(t.id) === 'net-send-1');
        const work = typeof b.store.openRoundRows === 'function'
          && b.store.openRoundRows().some((r) => r.tag === tag && Number(r.count) === 42);
        return tx && work;
      }, 5000);
      assert.equal(saw, true, 'peer book never received send or miner row');
      const { mempoolLattice } = await import('../../pool/src/wallet_api.js');
      const out = mempoolLattice(b.store, {
        miners: new Map(),
        lastJob: { height: 1, jobId: 'peer' },
        nodesOnline: b.p2p.syncedOnline(),
      });
      assert.equal(out.scope, 'network');
      assert.equal(out.pending.some((t) => t.id === 'net-send-1'), true);
      const row = out.pendingBlock.txs.find((t) => t.tag === tag);
      assert.ok(row, 'lattice payload missing peer miner row');
      assert.equal(row.count, 42);
      assert.equal(row.kind, 'hash');
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
  });

  it('printConfig pins p2p 30303, testnet magic, not mainnet', () => {
    const cfg = printConfig();
    assert.equal(cfg.p2p, P2P_PORT);
    assert.equal(cfg.p2p, 30303);
    assert.equal(cfg.magic, MAGIC_TESTNET);
    assert.equal(cfg.magic, 'shear-testnet-v2');
    assert.equal(cfg.mainnet, false);
    assert.equal(cfg.phaseBGate, true);
    assert.equal(cfg.rpc, 18332);
  });
});

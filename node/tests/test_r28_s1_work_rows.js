// S1 / T-S1. A node must not store, relay, or serve per-miner work rows.
// Frozen §1.1 item 9. Cite FROZEN-v2
// dc1e64a173886f9c156c3c105250e84db3261b5b7a30848b4d6089750b35682f.
// Peer rows are {tag, count}. Publishing them links a miner tag to a hash
// count. This fails while noteOpenRound keeps the row, publishWork relays
// it, and /api/network echoes openRoundRows.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { createStore } from '../src/store.js';
import { createRpc } from '../src/rpc.js';
import { createP2p, fingerprintHelloHash } from '../src/p2p.js';
import { networkMempoolWire } from '../src/p2p_ipc.js';
import { openRoundHashRows } from '../../pool/src/wallet_api.js';

const TAG = 'mdeadbeef';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function helloLine() {
  return `${JSON.stringify({
    type: 'hello',
    magic: MAGIC_TESTNET,
    fingerprint: fingerprintHelloHash(MAGIC_TESTNET),
  })}\n`;
}

describe('R28 S1: per-miner work rows are not kept or served', () => {
  it('a peer work row is not stored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-r28-s1-store-'));
    const store = createStore(dir, { pruneAfter: 1_000_000 });
    try {
      const kept = store.noteOpenRound(
        [{ tag: TAG, count: 42, dest: 'ssa1qshouldnottravel' }],
        { source: 'peer', peer: '203.0.113.8' },
      );
      assert.deepEqual(kept, []);
      assert.deepEqual(store.openRoundRows(), []);
      const local = store.noteOpenRound([{ tag: TAG, count: 9 }], { source: 'local' });
      assert.deepEqual(local, []);
      assert.deepEqual(store.openRoundRows(), []);
    } finally {
      if (typeof store.close === 'function') store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /api/network and the pool sidecar omit per-miner rounds', async () => {
    const store = {
      tip: () => ({ height: 7, hash: Buffer.alloc(32, 0xcd) }),
      openRoundRows: () => [{ tag: TAG, count: 4, source: 'peer' }],
      mempool: [],
    };
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    try {
      const heard = await rpc.listen();
      const body = await fetch(`http://127.0.0.1:${heard.port}/api/network`).then((r) => r.json());
      assert.deepEqual(body.rounds, []);
      assert.equal(body.miners, 0);
      assert.equal(body.provenRoundHashes, 0);
      assert.equal(JSON.stringify(body).includes(TAG), false);
      const via = await rpc.dispatch('getnetwork');
      assert.deepEqual(via.rounds, []);
      assert.equal(via.provenRoundHashes, 0);
    } finally {
      await rpc.close();
    }
    const wire = networkMempoolWire(store, { syncedOnline: () => 1, liveOnline: () => 1 });
    assert.deepEqual(wire.rounds, []);
    assert.equal(JSON.stringify(wire).includes(TAG), false);
  });

  it('a work frame is not relayed and a local publish is not gossiped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-r28-s1-p2p-'));
    const store = createStore(dir, { pruneAfter: 1_000_000 });
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      maxPeers: 4,
      outboundReserve: 0,
      helloMs: 5000,
      idleMs: 5000,
    });
    const bound = await p2p.listen();
    const heard = [];
    const socks = [];
    try {
      const attacker = await new Promise((resolve, reject) => {
        const sock = net.connect(bound.port, '127.0.0.1', () => resolve(sock));
        sock.on('error', reject);
      });
      const listener = await new Promise((resolve, reject) => {
        const sock = net.connect(bound.port, '127.0.0.1', () => resolve(sock));
        sock.on('data', (buf) => { heard.push(buf.toString()); });
        sock.on('error', reject);
      });
      socks.push(attacker, listener);
      attacker.write(helloLine());
      listener.write(helloLine());
      await delay(200);
      heard.length = 0;
      attacker.write(`${JSON.stringify({
        type: 'work',
        magic: MAGIC_TESTNET,
        rows: [{ tag: TAG, count: 42 }],
      })}\n`);
      await delay(200);
      const relays = heard.join('').split('\n').filter((line) => line.includes('"type":"work"'));
      assert.deepEqual(relays, []);
      assert.deepEqual(store.openRoundRows(), []);
      p2p.publishWork([{ tag: TAG, count: 50, dest: 'ssa1qshouldnottravel', hashrate: 9 }]);
      await delay(200);
      const again = heard.join('').split('\n').filter((line) => line.includes('"type":"work"'));
      assert.deepEqual(again, []);
      assert.deepEqual(store.openRoundRows(), []);
    } finally {
      for (const sock of socks) {
        try { sock.destroy(); } catch { /* closed */ }
      }
      p2p.close();
      if (typeof store.close === 'function') store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the mempool lattice builder does not mint a per-miner hash row', () => {
    const rows = openRoundHashRows([
      { login: 'pa_canary_7Q', workerKey: 'pa_canary_7Q.abcd', roundHashes: 40 },
    ]);
    assert.deepEqual(rows, []);
  });
});

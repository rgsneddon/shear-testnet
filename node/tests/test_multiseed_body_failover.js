import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { createP2p, GETBLOCK_MISS_LIMIT } from '../src/p2p.js';
import { nodeStatus } from '../src/status.js';

function listenSeed(onLine) {
  const sockets = new Set();
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const raw = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          onLine(sock, msg);
        }
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close() {
          for (const sock of sockets) sock.destroy();
          server.close();
        },
      });
    });
  });
}

function waitFor(pred, ms, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = setInterval(() => {
      let ok = false;
      try { ok = !!pred(); } catch (err) {
        clearInterval(tick);
        reject(err);
        return;
      }
      if (ok) {
        clearInterval(tick);
        resolve();
        return;
      }
      if (Date.now() - start >= ms) {
        clearInterval(tick);
        reject(new Error(label));
      }
    }, 20);
  });
}

describe('multi-seed body-proven failover', () => {
  it('a body-less seed cannot stay the catch-up peer once another seed serves a body', async () => {
    let height = 4;
    const hash = Buffer.alloc(32, 3);
    const store = {
      blocks: [{ header: Buffer.alloc(128, 3), hash, height: 4 }],
      tip: () => ({ height, hash }),
      chainWorkHex: () => '0x10',
      ingest() {
        height = 5;
        return { ok: true };
      },
    };
    const hollowHash = 'ab'.repeat(32);
    const bodyHash = '22'.repeat(32);
    let hollowAsked = false;
    let hollowNacked = false;
    let earlyOk = false;
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const hollow = await listenSeed((sock, msg) => {
      if (msg.type === 'hello' && !hollowAsked) {
        sock.write(`${JSON.stringify({
          type: 'tip', magic: MAGIC_TESTNET, height: 30, hash: '11'.repeat(32), work: '0x80',
        })}\n`);
      }
      if (msg.type === 'getheaders') {
        hollowAsked = true;
        sock.write(`${JSON.stringify({
          type: 'headers',
          magic: MAGIC_TESTNET,
          headers: [{ hash: hollowHash, height: 5 }],
        })}\n`);
      }
      if (msg.type === 'getblock' && !hollowNacked) {
        const snap = p2p.syncSnapshot();
        const row = nodeStatus({ store, p2p });
        assert.equal(snap.syncEligiblePeers, 0);
        assert.equal(row.ibd, true);
        assert.notEqual(row.syncPeerHeight, 30);
        assert.notEqual(row.peerMaxHeight, row.syncPeerHeight);
        earlyOk = true;
        hollowNacked = true;
        for (let i = 0; i < GETBLOCK_MISS_LIMIT; i += 1) {
          sock.write(`${JSON.stringify({
            type: 'getblock_nak', magic: MAGIC_TESTNET, hash: hollowHash,
          })}\n`);
        }
      }
    });
    const body = await listenSeed((sock, msg) => {
      if (msg.type === 'hello') {
        setTimeout(() => {
          try {
            sock.write(`${JSON.stringify({
              type: 'tip', magic: MAGIC_TESTNET, height: 8, hash: '33'.repeat(32), work: '0x30',
            })}\n`);
          } catch { /* closed */ }
        }, 1500);
      }
      if (msg.type === 'getheaders') {
        sock.write(`${JSON.stringify({
          type: 'headers',
          magic: MAGIC_TESTNET,
          headers: [{ hash: bodyHash, height: 5 }],
        })}\n`);
      }
      if (msg.type === 'getblock' && msg.hash === bodyHash) {
        sock.write(`${JSON.stringify({
          type: 'block',
          magic: MAGIC_TESTNET,
          block: {
            header: '11'.repeat(64),
            hash: bodyHash,
            height: 5,
            txs: [],
            shareBatch: [],
          },
        })}\n`);
      }
    });
    let bound = null;
    try {
      bound = await p2p.listen();
      await p2p.dialSeeds([
        `127.0.0.1:${hollow.port}`,
        `127.0.0.1:${body.port}`,
      ]);
      await waitFor(() => earlyOk, 3000, 'body-less seed was never asked for the block');
      await waitFor(() => {
        const snap = p2p.syncSnapshot();
        const eligible = [...p2p.peers.values()].find((r) => r.syncEligible === true);
        return snap.syncEligiblePeers === 1 && eligible && eligible.gossipHeight === 8;
      }, 4000, 'body-proven seed did not become the catch-up peer');
      const snap = p2p.syncSnapshot();
      const row = nodeStatus({ store, p2p });
      const eligible = [...p2p.peers.values()].find((r) => r.syncEligible === true);
      const hollowRec = [...p2p.peers.values()].find((r) => r.gossipHeight === 30);
      assert.ok(eligible);
      assert.equal(eligible.gossipHeight, 8);
      assert.equal(eligible.eligibleReason, 'body');
      assert.ok((eligible.bodiesServed || 0) >= 1);
      assert.equal(eligible.height, 5);
      assert.ok(hollowRec);
      assert.notEqual(hollowRec.syncEligible, true);
      assert.ok(Number(hollowRec.demoteUntil) > Date.now());
      assert.equal(snap.peerMaxHeight, 30);
      assert.equal(snap.syncPeerHeight, 5);
      assert.notEqual(snap.syncPeerHeight, snap.peerMaxHeight);
      assert.equal(snap.syncEligiblePeers, 1);
      assert.equal(row.ibd, true);
      assert.equal(row.syncEligiblePeers, 1);
      assert.equal(row.peerMaxHeight, 30);
      assert.equal(row.syncPeerHeight, 5);
      assert.equal(bound.port > 0, true);
    } finally {
      hollow.close();
      body.close();
      p2p.close();
    }
  });
});

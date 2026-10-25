import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { createP2p, fingerprintHelloHash, shouldClearWantOnNextZero } from '../src/p2p.js';
import { nodeStatus } from '../src/status.js';
import { shearHash } from '../../crypto/shear_hash.js';

function readJsonLines(sock, min, ms) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let buf = '';
    const timer = setTimeout(() => {
      sock.off('data', onData);
      if (lines.length >= min) resolve(lines);
      else reject(new Error(`wanted ${min} lines, got ${lines.length}: ${JSON.stringify(lines)}`));
    }, ms);
    function onData(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        try { lines.push(JSON.parse(raw)); } catch { /* ignore */ }
        if (lines.length >= min) {
          clearTimeout(timer);
          sock.off('data', onData);
          resolve(lines);
        }
      }
    }
    sock.on('data', onData);
  });
}

function collect(sock) {
  const lines = [];
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!raw) continue;
      try { lines.push(JSON.parse(raw)); } catch { /* ignore */ }
    }
  });
  return lines;
}

// Polls until done() is true. A timeout clears the poll as well, so a failed
// wait cannot keep the test process alive.
function waitFor(done, ms, why) {
  return new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      if (!done()) return;
      clearInterval(tick);
      clearTimeout(timer);
      resolve();
    }, 20);
    const timer = setTimeout(() => {
      clearInterval(tick);
      reject(new Error(typeof why === 'function' ? why() : why));
    }, ms);
  });
}

async function connectPeer(port) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  await readJsonLines(sock, 2, 2000);
  sock.write(`${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET, fingerprint: fingerprintHelloHash(MAGIC_TESTNET) })}\n`);
  return sock;
}

describe('empty want recovers from an eligible peer', () => {
  it('does not drop another peer local+1 want when a shorter peer says next 0', () => {
    assert.equal(shouldClearWantOnNextZero({
      fromEligible: false,
      fromShorter: true,
      otherWantsLocalPlusOne: true,
    }), false);
    assert.equal(shouldClearWantOnNextZero({
      fromEligible: true,
      fromShorter: false,
      otherWantsLocalPlusOne: true,
    }), true);
  });

  it('an eligible peer ahead with an empty want is asked for headers within 1s', async () => {
    let height = 3;
    const hash = Buffer.alloc(32, 7);
    const store = {
      blocks: [{ header: Buffer.alloc(128, 7), hash, height: 3 }],
      tip: () => ({ height, hash }),
      chainWorkHex: () => '0x10',
      ingest() {
        height = 4;
        return { ok: true };
      },
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = await connectPeer(bound.port);
    const lines = collect(sock);
    try {
      sock.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 11, hash: '99'.repeat(32), work: '0x55',
      })}\n`);
      await waitFor(() => lines.some((m) => m.type === 'getheaders'), 2000, 'probe headers');
      const before = lines.filter((m) => m.type === 'getheaders').length;
      assert.equal(p2p.syncSnapshot().syncEligiblePeers, 0);
      // A full header that claims its own ShearHash, so the claim check
      // passes and the block reaches ingest.
      const header = Buffer.alloc(128, 0x33);
      // Its parent is our tip, as the next block a peer serves is. A body under
      // an unknown parent is answered prev before ingest (p2p parentKnown).
      hash.copy(header, 4);
      // bits 0: a target any hash meets, as a real block's id meets its own
      // header's target. The claim check refuses a claim that misses it unhashed.
      header.writeUInt32LE(0, 108);
      sock.write(`${JSON.stringify({
        type: 'block',
        magic: MAGIC_TESTNET,
        block: {
          header: header.toString('hex'),
          hash: shearHash(header).toString('hex'),
          height: 4,
          txs: [],
          shareBatch: [],
        },
      })}\n`);
      const started = Date.now();
      await waitFor(() => {
        const snap = p2p.syncSnapshot();
        const headers = lines.filter((m) => m.type === 'getheaders').length;
        const rec = [...p2p.peers.values()].find((r) => r.syncEligible === true);
        const pendingN = rec?.pending instanceof Set ? rec.pending.size : 0;
        const wantN = Array.isArray(rec?.want) ? rec.want.length : 0;
        return snap.syncEligiblePeers === 1 && snap.syncPeerHeight === height && snap.syncPeerHeight !== 11 && headers > before && pendingN + wantN >= 0;
      }, 1000, () => `no recovery headers ${JSON.stringify(lines)}`);
      assert.ok(Date.now() - started < 1000);
      const snap = p2p.syncSnapshot();
      assert.equal(snap.peerMaxHeight, 11);
      assert.equal(snap.syncPeerHeight, 4);
      assert.notEqual(snap.syncPeerHeight, 11);
      assert.ok(snap.syncPeerHeight <= snap.peerMaxHeight);
    } finally {
      sock.destroy();
      p2p.close();
    }
  });

  it('a caught-up node drops a stale want so IBD can clear', async () => {
    const hash = Buffer.alloc(32, 9);
    const store = {
      blocks: [{ header: Buffer.alloc(128, 9), hash, height: 5 }],
      tip: () => ({ height: 5, hash }),
      chainWorkHex: () => '0x10',
      ingest: () => ({ ok: true }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = await connectPeer(bound.port);
    try {
      sock.write(`${JSON.stringify({
        type: 'tip',
        magic: MAGIC_TESTNET,
        height: 5,
        hash: Buffer.from(hash).toString('hex'),
        work: '0x10',
      })}\n`);
      await waitFor(() => p2p.peers.size === 1, 2000, 'peer record');
      const rec = [...p2p.peers.values()][0];
      rec.want = ['ab'.repeat(32)];
      rec.wantHeight = 6;
      rec.syncing = true;
      const started = Date.now();
      await waitFor(() => {
        const row = nodeStatus({ store, p2p });
        return row.want === 0 && row.ibd === false;
      }, 1000, 'stale want stayed');
      assert.ok(Date.now() - started < 1000);
      const row = nodeStatus({ store, p2p });
      assert.equal(row.height, 5);
      assert.equal(row.want, 0);
      assert.equal(row.ibd, false);
      assert.equal(p2p.syncSnapshot().peerMaxHeight, 5);
    } finally {
      sock.destroy();
      p2p.close();
    }
  });

  it('a shorter peer next 0 does not clear the eligible peer local+1 want', async () => {
    const hash = Buffer.alloc(32, 8);
    const store = {
      blocks: [{ header: Buffer.alloc(128, 8), hash, height: 5 }],
      tip: () => ({ height: 5, hash }),
      chainWorkHex: () => '0x10',
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const tall = await connectPeer(bound.port);
    const short = await connectPeer(bound.port);
    const tallLines = collect(tall);
    try {
      tall.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 15, hash: 'ab'.repeat(32), work: '0x30',
      })}\n`);
      short.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 5, hash: 'cd'.repeat(32), work: '0x10',
      })}\n`);
      await waitFor(() => tallLines.some((m) => m.type === 'getheaders'), 2000, 'tall headers');
      const missing = 'ef'.repeat(32);
      tall.write(`${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [{ hash: missing, height: 6 }],
      })}\n`);
      await waitFor(() => tallLines.some((m) => m.type === 'getblock'), 2000, 'tall getblock');
      const tallRec = [...p2p.peers.values()].find((r) => r.adHeight === 15);
      assert.equal(tallRec.wantHeight, 6);
      const held = (tallRec.want || []).includes(missing) || tallRec.pending?.has(missing);
      assert.equal(held, true);
      short.write(`${JSON.stringify({
        type: 'headers', magic: MAGIC_TESTNET, next: 0, headers: [],
      })}\n`);
      await new Promise((r) => setTimeout(r, 200));
      const still = (tallRec.want || []).includes(missing) || tallRec.pending?.has(missing);
      assert.equal(still, true);
      assert.equal(tallRec.wantHeight, 6);
    } finally {
      tall.destroy();
      short.destroy();
      p2p.close();
    }
  });
});

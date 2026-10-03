import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { createP2p, applyTipAdvertisement, catchupFields, countSyncedOnline } from '../src/p2p.js';
import { nodeStatus } from '../src/status.js';

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

async function connectPeer(port) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  await readJsonLines(sock, 2, 2000);
  return sock;
}

function tipStore(height) {
  const hash = Buffer.alloc(32, 1);
  return {
    blocks: [{ header: Buffer.alloc(128, 1), hash, height }],
    tip: () => ({ height, hash }),
    chainWorkHex: () => '0x10',
    ingest: () => ({ ok: true }),
  };
}

describe('tip gossip does not inflate catch-up', () => {
  it('a relayed tip does not set catch-up height or work', () => {
    const rec = { height: 0, hash: null, work: null };
    applyTipAdvertisement(rec, {
      type: 'tip', relay: true, height: 270, hash: 'ab'.repeat(32), work: '0xff',
    }, { localHeight: 210, localHash: '11'.repeat(32) });
    assert.equal(rec.gossipHeight, 270);
    assert.equal(rec.syncEligible, undefined);
    assert.notEqual(rec.height, 270);
    assert.notEqual(rec.work, '0xff');
    const fields = catchupFields(rec);
    assert.equal(fields.height, null);
    assert.equal(fields.work, null);
    assert.equal(fields.hash, '');
    assert.notEqual(fields.height, 270);
    assert.notEqual(fields.work, '0xff');
  });

  it('an empty direct tip is counted at the empty book and is not sync-eligible', () => {
    const rec = { height: 0, hash: null, work: null, nodeId: 'abc12345' };
    applyTipAdvertisement(rec, {
      type: 'tip', height: 0, hash: '', work: '0x0',
    }, { localHeight: 0, localHash: '' });
    assert.equal(rec.hash, '');
    assert.notEqual(rec.syncEligible, true);
    const fields = catchupFields(rec);
    assert.equal(fields.height, null);
    assert.equal(fields.work, null);
    assert.equal(countSyncedOnline({
      localHash: '',
      peers: [rec],
      includeSelf: true,
    }), 2);
  });

  it('a direct tip advertisement is not sync-eligible until a body applies', async () => {
    const store = tipStore(4);
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = await connectPeer(bound.port);
    try {
      sock.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 20, hash: 'cd'.repeat(32), work: '0x20',
      })}\n`);
      const asked = await readJsonLines(sock, 1, 2000);
      assert.ok(asked.some((m) => m.type === 'getheaders'));
      const snap = p2p.syncSnapshot();
      assert.equal(snap.peerMaxHeight, 20);
      assert.equal(snap.syncEligiblePeers, 0);
      assert.equal(snap.syncPeerHeight, null);
      const rec = [...p2p.peers.values()].find((r) => r.gossipHeight === 20);
      assert.ok(rec);
      assert.notEqual(rec.height, 20);
      assert.notEqual(rec.syncEligible, true);
      const row = nodeStatus({ store, p2p });
      assert.equal(row.ibd, true);
      assert.equal(row.syncEligiblePeers, 0);
      assert.equal(row.peerMaxHeight, 20);
    } finally {
      sock.destroy();
      p2p.close();
    }
  });

  it('a relayed tip is not asked for headers and cannot look synced', async () => {
    const store = tipStore(4);
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = await connectPeer(bound.port);
    try {
      sock.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, relay: true, height: 40, hash: 'ee'.repeat(32), work: '0x99',
      })}\n`);
      let headers = false;
      const timer = new Promise((resolve) => setTimeout(resolve, 400));
      sock.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (text.includes('"getheaders"')) headers = true;
      });
      await timer;
      assert.equal(headers, false);
      const snap = p2p.syncSnapshot();
      assert.equal(snap.peerMaxHeight, 40);
      assert.equal(snap.syncEligiblePeers, 0);
      const row = nodeStatus({ store, p2p });
      assert.equal(row.ibd, true);
      assert.notEqual(row.syncPeerHeight, 40);
    } finally {
      sock.destroy();
      p2p.close();
    }
  });

  it('a served body makes that peer sync-eligible', async () => {
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
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = await connectPeer(bound.port);
    try {
      sock.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 9, hash: 'aa'.repeat(32), work: '0x30',
      })}\n`);
      await readJsonLines(sock, 1, 2000);
      assert.equal(p2p.syncSnapshot().syncEligiblePeers, 0);
      const block = {
        type: 'block',
        magic: MAGIC_TESTNET,
        block: {
          header: '11'.repeat(64),
          hash: '22'.repeat(32),
          height: 5,
          txs: [],
          shareBatch: [],
        },
      };
      sock.write(`${JSON.stringify(block)}\n`);
      await new Promise((r) => setTimeout(r, 300));
      const snap = p2p.syncSnapshot();
      assert.equal(snap.syncEligiblePeers, 1);
      assert.equal(snap.peerMaxHeight, 9);
      assert.equal(snap.syncPeerHeight, 5);
      assert.notEqual(snap.syncPeerHeight, 9);
      const rec = [...p2p.peers.values()].find((r) => r.syncEligible === true);
      assert.ok(rec);
      assert.equal(rec.eligibleReason, 'body');
      assert.ok((rec.bodiesServed || 0) >= 1);
    } finally {
      sock.destroy();
      p2p.close();
    }
  });

  it('while IBD a getblock burst is served with a cap of 8 to 32', async () => {
    const blocks = [];
    for (let i = 1; i <= 4; i += 1) {
      const hash = Buffer.alloc(32);
      hash.writeUInt32BE(i, 28);
      const header = Buffer.alloc(128);
      header.writeUInt32BE(i, 0);
      blocks.push({ header, hash, height: i, txs: [], shareBatch: [] });
    }
    const store = {
      blocks,
      tip: () => blocks[blocks.length - 1],
      chainWorkHex: () => '0x10',
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const logs = [];
    const orig = console.error;
    console.error = (...args) => {
      logs.push(args.map((a) => String(a)).join(' '));
      orig.apply(console, args);
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = await connectPeer(bound.port);
    try {
      sock.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 40, hash: 'cd'.repeat(32), work: '0x80',
      })}\n`);
      await readJsonLines(sock, 1, 2000);
      const row = nodeStatus({ store, p2p });
      assert.equal(row.ibd, true);
      assert.equal(row.syncEligiblePeers, 0);
      sock.write(blocks.map((b) => `${JSON.stringify({
        type: 'getblock',
        magic: MAGIC_TESTNET,
        hash: Buffer.from(b.hash).toString('hex'),
      })}\n`).join(''));
      const ev = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no serve\n${logs.slice(-12).join('\n')}`)), 2000);
        const tick = setInterval(() => {
          for (const line of logs) {
            const start = line.indexOf('{');
            if (start < 0 || !line.includes('p2p_getblock_serve')) continue;
            try {
              const parsed = JSON.parse(line.slice(start));
              if (parsed.event === 'p2p_getblock_serve') {
                clearInterval(tick);
                clearTimeout(timer);
                resolve(parsed);
                return;
              }
            } catch { /* ignore */ }
          }
        }, 20);
      });
      assert.ok(ev.cap >= 8 && ev.cap <= 32, JSON.stringify(ev));
      assert.ok(ev.n > 1, JSON.stringify(ev));
    } finally {
      console.error = orig;
      sock.destroy();
      p2p.close();
    }
  });
});

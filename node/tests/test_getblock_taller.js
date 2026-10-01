import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { createP2p } from '../src/p2p.js';

function fakeHash(n) {
  const hash = Buffer.alloc(32);
  hash.writeUInt32BE(n, 28);
  return hash.toString('hex');
}

function fakeBlocks(n) {
  const blocks = [];
  for (let i = 1; i <= n; i += 1) {
    const hash = Buffer.alloc(32);
    hash.writeUInt32BE(i, 28);
    const header = Buffer.alloc(128);
    header.writeUInt32BE(i, 0);
    blocks.push({ header, hash, height: i });
  }
  return blocks;
}

function readJsonLines(sock, want, ms = 2500) {
  const lines = [];
  let buf = '';
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(t);
      sock.off('data', onData);
      resolve(lines);
    };
    const t = setTimeout(finish, ms);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        try { lines.push(JSON.parse(raw)); } catch { /* ignore */ }
        if (want > 0 && lines.length >= want) finish();
      }
    };
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

describe('getblock prefers the taller peer', () => {
  it('does not fetch the next block from a local+1 mesh peer while a taller peer is connected', async () => {
    const blocks = fakeBlocks(100);
    const store = {
      blocks,
      tip: () => blocks[blocks.length - 1],
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const mesh = await connectPeer(bound.port);
    const tall = await connectPeer(bound.port);
    try {
      const meshAfter = readJsonLines(mesh, 0, 600);
      const tallAfter = readJsonLines(tall, 0, 600);
      tall.write(`${JSON.stringify({
        type: 'tip',
        magic: MAGIC_TESTNET,
        height: 125,
        hash: fakeHash(125),
        work: '0x20',
      })}\n`);
      mesh.write(`${JSON.stringify({
        type: 'tip',
        magic: MAGIC_TESTNET,
        height: 101,
        hash: fakeHash(101),
        work: '0x10',
      })}\n`);
      const [meshMsgs, tallMsgs] = await Promise.all([meshAfter, tallAfter]);
      assert.equal(meshMsgs.some((m) => m.type === 'getblock'), false);
      assert.ok(tallMsgs.some((m) => m.type === 'getheaders'), 'taller peer should be asked for headers');

      const meshBlocks = readJsonLines(mesh, 0, 600);
      const tallBlocks = readJsonLines(tall, 0, 600);
      const nextHash = fakeHash(101);
      mesh.write(`${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [{ hash: nextHash, height: 101 }],
      })}\n`);
      tall.write(`${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [{ hash: nextHash, height: 101, header: '00'.repeat(64) }],
      })}\n`);
      const [fromMesh, fromTall] = await Promise.all([meshBlocks, tallBlocks]);
      assert.equal(fromMesh.some((m) => m.type === 'getblock'), false);
      assert.ok(fromTall.some((m) => m.type === 'getblock'), 'getblock should go to the taller peer');
      const asked = fromTall.find((m) => m.type === 'getblock');
      assert.equal(String(asked.hash).toLowerCase(), nextHash);
    } finally {
      mesh.destroy();
      tall.destroy();
      p2p.close();
    }
  });
});

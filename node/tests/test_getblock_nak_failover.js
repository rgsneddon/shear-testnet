import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { createP2p, GETBLOCK_MISS_LIMIT } from '../src/p2p.js';

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

async function connectPeer(port) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  await readJsonLines(sock, 2, 2000);
  return sock;
}

describe('getblock nack failover', () => {
  it('three misses demote the body-less peer and hand the want to the next', async () => {
    const hash = Buffer.alloc(32, 4);
    const store = {
      blocks: [{ header: Buffer.alloc(128, 4), hash, height: 2 }],
      tip: () => ({ height: 2, hash }),
      chainWorkHex: () => '0x10',
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const logs = [];
    const orig = console.error;
    console.error = (s) => { logs.push(String(s)); };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const tall = await connectPeer(bound.port);
    const next = await connectPeer(bound.port);
    const tallLines = collect(tall);
    const nextLines = collect(next);
    const missing = 'ab'.repeat(32);
    try {
      tall.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 12, hash: '11'.repeat(32), work: '0x40',
      })}\n`);
      next.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 6, hash: '22'.repeat(32), work: '0x20',
      })}\n`);
      const headers = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no getheaders')), 2000);
        const tick = setInterval(() => {
          if (tallLines.some((m) => m.type === 'getheaders')) {
            clearInterval(tick);
            clearTimeout(timer);
            resolve(true);
          }
        }, 20);
      });
      assert.equal(headers, true);
      tall.write(`${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [{ hash: missing, height: 3 }],
      })}\n`);
      const asked = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no getblock ${JSON.stringify(tallLines)}`)), 2000);
        const tick = setInterval(() => {
          if (tallLines.some((m) => m.type === 'getblock' && m.hash === missing)) {
            clearInterval(tick);
            clearTimeout(timer);
            resolve(true);
          }
        }, 20);
      });
      assert.equal(asked, true);
      for (let i = 0; i < GETBLOCK_MISS_LIMIT; i += 1) {
        tall.write(`${JSON.stringify({
          type: 'getblock_nak', magic: MAGIC_TESTNET, hash: missing,
        })}\n`);
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no header ask ${JSON.stringify(nextLines)}`)), 2000);
        const tick = setInterval(() => {
          if (nextLines.some((m) => m.type === 'getheaders')) {
            clearInterval(tick);
            clearTimeout(timer);
            resolve();
          }
        }, 20);
      });
      assert.equal(nextLines.some((m) => m.type === 'getblock'), false);
      assert.equal(nextLines.some((m) => m.type === 'getblock' && m.hash === missing), false);
      const tallRec = [...p2p.peers.values()].find((r) => r.gossipHeight === 12);
      assert.ok(tallRec);
      assert.ok(Number(tallRec.demoteUntil) > Date.now());
      assert.equal(tallRec.syncEligible, false);
      const misses = logs.filter((line) => line.includes('p2p_getblock_miss') && line.includes(missing));
      assert.equal(misses.length, 1);
      assert.equal(logs.some((line) => line.includes('"found":false')), false);
    } finally {
      console.error = orig;
      tall.destroy();
      next.destroy();
      p2p.close();
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import {
  P2P_HELLO_MS,
  P2P_IDLE_MS,
  createP2p,
  peerIsBusy,
  peerShouldEvict,
} from '../src/p2p.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(port) {
  const sock = net.connect(port, '127.0.0.1');
  sock.on('data', () => {});
  sock.on('error', () => {});
  return new Promise((resolve, reject) => {
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

function closedWithin(sock, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    sock.once('close', () => { clearTimeout(t); resolve(true); });
    sock.once('error', () => {});
  });
}

describe('p2p hello deadline and idle eviction', () => {
  it('keeps a busy or freshly heard peer and drops a silent or idle one', () => {
    assert.equal(P2P_HELLO_MS, 20_000);
    assert.ok(P2P_IDLE_MS >= 90_000);
    assert.equal(P2P_IDLE_MS > 2_000, true);
    const now = 10_000;
    const silent = { attachedAt: now - P2P_HELLO_MS, helloAt: 0, lastRx: 0 };
    assert.equal(peerShouldEvict(silent, now), true);
    const early = { attachedAt: now - 1000, helloAt: 0, lastRx: 0 };
    assert.equal(peerShouldEvict(early, now), false);
    const healthy = { attachedAt: 0, helloAt: now - 10_000, lastRx: now - 1000 };
    assert.equal(peerShouldEvict(healthy, now), false);
    const idle = { attachedAt: 0, helloAt: now - P2P_IDLE_MS - 5, lastRx: now - P2P_IDLE_MS - 1 };
    assert.equal(peerShouldEvict(idle, now), true);
    const syncing = { ...idle, syncing: true };
    assert.equal(peerIsBusy(syncing), true);
    assert.equal(peerShouldEvict(syncing, now), false);
    const verifying = { ...idle, verifying: new Set(['h']) };
    assert.equal(peerShouldEvict(verifying, now), false);
  });

  it('evicts a silent socket and an idle hello, and keeps a live and a syncing peer', async () => {
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
    };
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      helloMs: 200,
      idleMs: 500,
    });
    const bound = await p2p.listen();
    try {
      const silent = await connect(bound.port);
      const silentClosed = await closedWithin(silent, 800);
      assert.equal(silentClosed, true);

      const idle = await connect(bound.port);
      idle.write(`${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET })}\n`);
      await delay(80);
      const idleClosed = await closedWithin(idle, 1200);
      assert.equal(idleClosed, true);

      const healthy = await connect(bound.port);
      healthy.write(`${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET })}\n`);
      const beat = setInterval(() => {
        try {
          healthy.write(`${JSON.stringify({ type: 'census', magic: MAGIC_TESTNET, hop: 0, nodes: [] })}\n`);
        } catch { /* closed */ }
      }, 100);
      await delay(900);
      assert.equal(healthy.destroyed, false);
      clearInterval(beat);
      healthy.destroy();
      await delay(50);

      const mark = Date.now();
      const syncing = await connect(bound.port);
      syncing.write(`${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET })}\n`);
      let rec = null;
      for (let i = 0; i < 25 && !rec; i += 1) {
        await delay(20);
        rec = [...p2p.peers.values()].find((row) => Number(row?.helloAt) >= mark) || null;
      }
      assert.ok(rec?.helloAt, 'expected a hello peer');
      // A block verify is in flight. The idle sweep must leave this socket up
      // even though nothing has arrived since the hello.
      rec.syncing = true;
      rec.verifying = new Set(['catch-up']);
      rec.lastRx = Date.now() - 60_000;
      await delay(800);
      assert.equal(syncing.destroyed, false);
      assert.equal(peerIsBusy(rec), true);
      rec.syncing = false;
      rec.pending = new Set();
      rec.verifying = new Set();
      rec.want = [];
      rec.retryPrev = [];
      rec.lastRx = Date.now() - 60_000;
      const dropped = await closedWithin(syncing, 800);
      assert.equal(dropped, true);
    } finally {
      p2p.close();
    }
  });
});

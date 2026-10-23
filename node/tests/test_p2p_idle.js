import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import {
  P2P_HELLO_FLOOR_MS,
  P2P_HELLO_MS,
  P2P_IDLE_FLOOR_MS,
  P2P_IDLE_MS,
  P2P_OUTBOUND_RESERVE,
  createP2p,
  p2pHelloMs,
  p2pIdleMs,
  p2pInboundCap,
  p2pOutboundReserve,
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
    if (sock.destroyed) {
      resolve(true);
      return;
    }
    const t = setTimeout(() => resolve(false), ms);
    sock.once('close', () => { clearTimeout(t); resolve(true); });
    sock.once('error', () => {});
  });
}

function helloLine() {
  return `${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET })}\n`;
}

function listenSink() {
  const sockets = new Set();
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('data', () => {});
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => {});
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

describe('p2p hello deadline and idle eviction', () => {
  it('keeps recent progress and drops a silent advertisement or a late hello', () => {
    assert.equal(P2P_HELLO_MS, 20_000);
    assert.equal(P2P_HELLO_FLOOR_MS, 5_000);
    assert.equal(P2P_IDLE_FLOOR_MS, 60_000);
    assert.ok(P2P_IDLE_MS >= 90_000);
    const prevHello = process.env.SHEAR_P2P_HELLO_MS;
    const prevIdle = process.env.SHEAR_P2P_IDLE_MS;
    try {
      process.env.SHEAR_P2P_HELLO_MS = '1000';
      process.env.SHEAR_P2P_IDLE_MS = '1000';
      assert.equal(p2pHelloMs(), P2P_HELLO_FLOOR_MS);
      assert.equal(p2pIdleMs(), P2P_IDLE_FLOOR_MS);
      assert.equal(p2pHelloMs(200), 200);
      assert.equal(p2pIdleMs(350), 350);
      process.env.SHEAR_P2P_HELLO_MS = '600000';
      process.env.SHEAR_P2P_IDLE_MS = '600000';
      assert.equal(p2pHelloMs(), 600_000);
      assert.equal(p2pIdleMs(), 600_000);
    } finally {
      if (prevHello == null) delete process.env.SHEAR_P2P_HELLO_MS;
      else process.env.SHEAR_P2P_HELLO_MS = prevHello;
      if (prevIdle == null) delete process.env.SHEAR_P2P_IDLE_MS;
      else process.env.SHEAR_P2P_IDLE_MS = prevIdle;
    }
    assert.equal(P2P_IDLE_MS > 2_000, true);
    assert.equal(P2P_OUTBOUND_RESERVE, 8);
    assert.equal(p2pOutboundReserve(32), 8);
    assert.equal(p2pInboundCap(32), 24);
    assert.equal(8 * 4 > p2pInboundCap(32), true);
    assert.equal(p2pOutboundReserve(1), 0);
    assert.equal(p2pInboundCap(1), 1);
    const now = 1_000_000;
    const silent = { attachedAt: now - P2P_HELLO_MS, helloAt: 0, lastRx: 0 };
    assert.equal(peerShouldEvict(silent, now), true);
    const early = { attachedAt: now - 1000, helloAt: 0, lastRx: 0 };
    assert.equal(peerShouldEvict(early, now), false);
    const healthy = { attachedAt: 0, helloAt: now - 10_000, lastRx: now - 1000 };
    assert.equal(peerShouldEvict(healthy, now), false);
    const idle = { attachedAt: 0, helloAt: now - P2P_IDLE_MS - 5, lastRx: now - P2P_IDLE_MS - 1 };
    assert.equal(peerShouldEvict(idle, now), true);
    const advertised = {
      ...idle,
      syncing: true,
      want: ['h'],
      pending: new Set(['h']),
      verifying: new Set(['h']),
      retryPrev: ['h'],
    };
    assert.equal(peerIsBusy(advertised, now), false);
    assert.equal(peerShouldEvict(advertised, now), true);
    const progressing = { ...idle, progressAt: now - 1000 };
    assert.equal(peerIsBusy(progressing, now), true);
    assert.equal(peerShouldEvict(progressing, now), false);
    const staleProgress = { ...idle, progressAt: now - P2P_IDLE_MS - 1, syncing: true };
    assert.equal(peerIsBusy(staleProgress, now), false);
    assert.equal(peerShouldEvict(staleProgress, now), true);
    const busyBeforeHello = {
      attachedAt: now - P2P_HELLO_MS,
      helloAt: 0,
      progressAt: now,
      syncing: true,
      lastRx: now,
    };
    assert.equal(peerShouldEvict(busyBeforeHello, now), true);
  });

  it('hello timing spread keeps an in-window arrival under latency and jitter', () => {
    const helloMs = P2P_HELLO_MS;
    const idleMs = P2P_IDLE_MS;
    const attachedAt = 0;
    const sentAt = [5_000, 15_000, 19_000, 21_000, 30_000];
    const latencyMs = [500, 2_000, 5_000, 10_000];
    const jitterMs = [-50, 0, 120];
    for (const hello of sentAt) {
      for (const latency of latencyMs) {
        for (const jitter of jitterMs) {
          const arrived = hello;
          const processed = hello + latency + jitter;
          const sitting = {
            attachedAt,
            helloAt: 0,
            bufAt: arrived,
            lastRx: 0,
          };
          const evict = peerShouldEvict(sitting, processed, { helloMs, idleMs });
          const inWindow = arrived < helloMs && (processed - arrived) < helloMs;
          assert.equal(evict, !inWindow, `hello ${hello} latency ${latency} jitter ${jitter}`);
          if (inWindow) {
            const accepted = {
              attachedAt,
              helloAt: arrived,
              lastRx: arrived,
              bufAt: 0,
            };
            assert.equal(peerShouldEvict(accepted, processed, { helloMs, idleMs }), false);
          }
        }
      }
    }
    const busyReceiver = {
      attachedAt: 0,
      helloAt: 0,
      bufAt: 19_000,
      lastRx: 0,
    };
    assert.equal(peerShouldEvict(busyReceiver, 19_000 + 10_000, { helloMs, idleMs }), false);
    assert.equal(peerShouldEvict({ ...busyReceiver, bufAt: 21_000 }, 21_000 + 500, { helloMs, idleMs }), true);
  });

  it('evicts a silent taller tip and a no-hello socket, and keeps recent progress', async () => {
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
      helloMs: 400,
      idleMs: 350,
    });
    const bound = await p2p.listen();
    try {
      const advertised = await connect(bound.port);
      advertised.write(helloLine());
      advertised.write(`${JSON.stringify({
        type: 'tip',
        magic: MAGIC_TESTNET,
        height: 5,
        hash: 'ab'.repeat(32),
        work: '0x10',
      })}\n`);
      let rec = null;
      for (let i = 0; i < 20 && !rec?.adHeight; i += 1) {
        await delay(20);
        rec = [...p2p.peers.values()].find((row) => Number(row?.adHeight) === 5) || null;
      }
      assert.equal(Number(rec?.adHeight), 5);
      assert.equal(peerIsBusy(rec), false);
      assert.equal(await closedWithin(advertised, 900), true);

      const mute = await connect(bound.port);
      mute.write(`${JSON.stringify({
        type: 'tip',
        magic: MAGIC_TESTNET,
        height: 9,
        hash: 'cd'.repeat(32),
      })}\n`);
      mute.write(`${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [{ hash: 'ee'.repeat(32), height: 1 }],
      })}\n`);
      await delay(80);
      const muteRec = [...p2p.peers.values()].find((row) => !row.helloAt);
      assert.ok(muteRec);
      assert.equal(muteRec.adHeight, undefined);
      assert.equal(await closedWithin(mute, 800), true);

      const healthy = await connect(bound.port);
      healthy.write(helloLine());
      const beat = setInterval(() => {
        try {
          healthy.write(`${JSON.stringify({ type: 'census', magic: MAGIC_TESTNET, hop: 0, nodes: [] })}\n`);
        } catch { /* closed */ }
      }, 80);
      await delay(700);
      assert.equal(healthy.destroyed, false);
      clearInterval(beat);
      healthy.destroy();
      await delay(40);

      const syncing = await connect(bound.port);
      syncing.write(helloLine());
      let live = null;
      for (let i = 0; i < 25 && !live?.helloAt; i += 1) {
        await delay(20);
        live = [...p2p.peers.values()].find((row) => Number(row?.helloAt) > 0 && row.inbound) || null;
      }
      assert.ok(live?.helloAt);
      live.progressAt = Date.now();
      live.syncing = true;
      live.want = ['catch-up'];
      live.lastRx = Date.now() - 60_000;
      await delay(250);
      assert.equal(syncing.destroyed, false);
      assert.equal(peerIsBusy(live), true);
      live.progressAt = Date.now() - 60_000;
      live.lastRx = Date.now() - 60_000;
      assert.equal(await closedWithin(syncing, 800), true);
    } finally {
      p2p.close();
    }
  });

  it('reserves outbound slots and evicts an idle inbound when the table is full', async () => {
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
      maxPeers: 3,
      outboundReserve: 1,
      helloMs: 5000,
      idleMs: 5000,
    });
    const bound = await p2p.listen();
    const sink = await listenSink();
    try {
      const first = await connect(bound.port);
      const second = await connect(bound.port);
      first.write(helloLine());
      second.write(helloLine());
      await delay(60);
      const third = await connect(bound.port);
      await delay(50);
      assert.equal(third.destroyed, false);
      assert.equal(first.destroyed || second.destroyed, true);
      assert.equal([...p2p.peers.values()].filter((rec) => rec.inbound).length, 2);

      const out1 = await p2p.connect('127.0.0.1', sink.port);
      assert.ok(out1);
      assert.equal(p2p.peers.size, 3);
      const out2 = await p2p.connect('127.0.0.1', sink.port);
      assert.ok(out2 && !out2.destroyed);
      await delay(50);
      const inbound = [...p2p.peers.values()].filter((rec) => rec.inbound).length;
      const outbound = [...p2p.peers.values()].filter((rec) => rec.inbound === false).length;
      assert.equal(inbound, 1);
      assert.equal(outbound, 2);
      assert.equal(first.destroyed || second.destroyed, true);
    } finally {
      p2p.close();
      sink.close();
    }
  });

  it('does not credit a header offer before the hash is verified', async () => {
    let offers = 0;
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
      offerHeaders() {
        offers += 1;
        return { accepted: 1 };
      },
    };
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      helloMs: 5000,
      idleMs: 5000,
    });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      sock.write(`${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [{ hash: 'ab'.repeat(32), header: '11'.repeat(128), height: 1 }],
      })}\n`);
      let rec = null;
      for (let i = 0; i < 20 && offers < 1; i += 1) {
        await delay(20);
        rec = [...p2p.peers.values()].find((row) => row.helloAt) || null;
      }
      assert.equal(offers, 1);
      assert.ok(rec);
      assert.equal(rec.progressAt || 0, 0);
      assert.equal(peerIsBusy(rec), false);
      sock.destroy();
    } finally {
      p2p.close();
    }
  });

  it('an inbound arrival at the cap evicts an idle inbound', async () => {
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
      maxPeers: 2,
      outboundReserve: 0,
      helloMs: 5000,
      idleMs: 5000,
    });
    const bound = await p2p.listen();
    try {
      const first = await connect(bound.port);
      const second = await connect(bound.port);
      first.write(helloLine());
      second.write(helloLine());
      await delay(80);
      assert.equal([...p2p.peers.values()].filter((rec) => rec.inbound && rec.helloAt).length, 2);
      const third = await connect(bound.port);
      third.write(helloLine());
      await delay(80);
      assert.equal(third.destroyed, false);
      assert.equal(first.destroyed || second.destroyed, true);
      assert.equal([...p2p.peers.values()].filter((rec) => rec.inbound).length, 2);
    } finally {
      p2p.close();
    }
  });

  it('does not evict a second idle inbound while the cap cooldown holds', async () => {
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
      maxPeers: 2,
      outboundReserve: 0,
      helloMs: 5000,
      idleMs: 5000,
    });
    const bound = await p2p.listen();
    try {
      const first = await connect(bound.port);
      const second = await connect(bound.port);
      first.write(helloLine());
      second.write(helloLine());
      await delay(80);
      const third = await connect(bound.port);
      third.write(helloLine());
      await delay(80);
      assert.equal(third.destroyed, false);
      const fourth = await connect(bound.port);
      fourth.write(helloLine());
      await delay(80);
      assert.equal(fourth.destroyed, true);
      const live = [first, second, third].filter((sock) => !sock.destroyed);
      assert.equal(live.length, 2);
      assert.equal([...p2p.peers.values()].filter((rec) => rec.inbound).length, 2);
    } finally {
      p2p.close();
    }
  });

  it('a malformed message penalises that peer and leaves the node up', async () => {
    const tip = { height: 4, hash: Buffer.alloc(32, 7) };
    let offers = 0;
    const store = {
      blocks: [],
      tip() { return tip; },
      on() { return () => {}; },
      offerHeaders() {
        offers += 1;
        throw new Error('malformed header');
      },
    };
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      helloMs: 5000,
      idleMs: 5000,
    });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      sock.write(`${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [{ hash: 'ab'.repeat(32), height: 1 }],
      })}\n`);
      let rec = null;
      for (let i = 0; i < 30 && !(offers >= 1 && rec?.expensiveFails); i += 1) {
        await delay(20);
        rec = [...p2p.peers.values()].find((row) => row.helloAt) || null;
      }
      assert.equal(offers, 1);
      assert.ok(rec);
      assert.equal(rec.expensiveFails, 1);
      assert.equal(sock.destroyed, false);
      assert.equal(store.tip(), tip);
      const again = await connect(bound.port);
      assert.equal(again.destroyed, false);
      again.destroy();
      sock.destroy();
    } finally {
      p2p.close();
    }
  });
});

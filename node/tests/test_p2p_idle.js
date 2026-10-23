import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { OPEN_ROUND_PEER_RATE, createStore } from '../src/store.js';
import {
  P2P_HELLO_FLOOR_MS,
  P2P_HELLO_MS,
  P2P_IDLE_FLOOR_MS,
  P2P_IDLE_MS,
  P2P_OUTBOUND_RESERVE,
  createP2p,
  isFinalIngestFail,
  p2pHelloMs,
  p2pIdleMs,
  p2pInboundCap,
  p2pOutboundReserve,
  peerIsBusy,
  peerShouldEvict,
  recordIngestFail,
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

function frame(msg) {
  return `${JSON.stringify({ ...msg, magic: MAGIC_TESTNET })}\n`;
}

function recFor(p2p, sock) {
  return [...p2p.peers.entries()].find(([live]) => live.remotePort === sock.localPort)?.[1];
}

function ageInbound(p2p, ms = 120_000) {
  const at = Date.now() - ms;
  for (const rec of p2p.peers.values()) {
    if (rec?.inbound && rec.helloAt) rec.capIdleAt = at;
  }
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
      ageInbound(p2p);
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
      ageInbound(p2p);
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
      ageInbound(p2p);
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

  it('cap eviction waits out the idle timeout and ignores a census refresh', async () => {
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
      maxPeers: 1,
      outboundReserve: 0,
      helloMs: 5000,
      idleMs: 5000,
      evictCooldownMs: 0,
    });
    const bound = await p2p.listen();
    try {
      const first = await connect(bound.port);
      first.write(helloLine());
      await delay(60);
      const live = [...p2p.peers.values()].find((rec) => rec.inbound && rec.helloAt);
      assert.ok(live);
      live.lastRx = Date.now() - 1000;
      const refused = await connect(bound.port);
      await delay(40);
      assert.equal(refused.destroyed, true);
      assert.equal(first.destroyed, false);

      ageInbound(p2p);
      first.write(`${JSON.stringify({ type: 'census', magic: MAGIC_TESTNET, hop: 0, nodes: [] })}\n`);
      await delay(40);
      const aged = [...p2p.peers.values()].find((rec) => rec.inbound && rec.helloAt);
      assert.ok(aged);
      assert.ok(Date.now() - Number(aged.capIdleAt) >= 5000);
      assert.ok(Date.now() - Number(aged.lastRx) < 500);
      const next = await connect(bound.port);
      await delay(40);
      assert.equal(next.destroyed, false);
      assert.equal(first.destroyed, true);
    } finally {
      p2p.close();
    }
  });

  it('junk does not refresh cap idle and accepted traffic is kept', async () => {
    const store = {
      blocks: [],
      mempool: [],
      tip: () => null,
      on() { return () => {}; },
      queueTx(tx) { return { ok: true, tx }; },
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
      evictCooldownMs: 0,
    });
    const bound = await p2p.listen();
    try {
      const junk = await connect(bound.port);
      const real = await connect(bound.port);
      junk.write(helloLine());
      real.write(helloLine());
      await delay(80);
      ageInbound(p2p);
      junk.write(frame({ type: 'not-a-message' }));
      real.write(frame({ type: 'tx', tx: { id: 'kept-tx' } }));
      await delay(40);
      const junkRec = recFor(p2p, junk);
      const realRec = recFor(p2p, real);
      assert.ok(junkRec && realRec);
      assert.ok(Date.now() - Number(junkRec.capIdleAt) >= 5000);
      assert.ok(Date.now() - Number(realRec.capIdleAt) < 5000);
      const next = await connect(bound.port);
      await delay(40);
      assert.equal(junk.destroyed, true);
      assert.equal(real.destroyed, false);
      assert.equal(next.destroyed, false);
    } finally {
      p2p.close();
    }
  });

  it('each cheap message leaves an aged cap idle clock where it is', async () => {
    let ingested = 0;
    const store = {
      blocks: [],
      mempool: [],
      tip: () => null,
      on() { return () => {}; },
      openRoundRows() { return []; },
      noteOpenRound() {},
      offerHeaders() { return { accepted: 0 }; },
      queueTx() { return { ok: false, reason: 'shape' }; },
      ingest() {
        ingested += 1;
        return { ok: false, reason: 'pow' };
      },
    };
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      maxPeers: 4,
      outboundReserve: 0,
      helloMs: 5000,
      idleMs: 5000,
      evictCooldownMs: 0,
    });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(60);
      ageInbound(p2p);
      const rec = () => [...p2p.peers.values()].find((row) => row.inbound && row.helloAt);
      const stuck = rec()?.capIdleAt;
      assert.ok(stuck);
      assert.ok(Date.now() - Number(stuck) >= 5000);
      const cheap = [
        { type: 'hello' },
        { type: 'addr', peers: [] },
        { type: 'getmempool' },
        { type: 'getheaders', locator: [] },
        { type: 'getblocks' },
        { type: 'getblock', hash: '11'.repeat(32) },
        { type: 'getblock_nak', hash: '22'.repeat(32) },
        { type: 'block_not_found', hash: '33'.repeat(32) },
        { type: 'tip', height: 0, hash: '' },
        { type: 'inv', height: 0, hash: '' },
        { type: 'census', hop: 0, nodes: [] },
        { type: 'not-a-message' },
        { type: 'mempool', txs: [], work: [] },
        { type: 'work', rows: [] },
        { type: 'headers', headers: [] },
        { type: 'tx', tx: { id: 'cheap-reject' } },
      ];
      for (const msg of cheap) {
        sock.write(frame(msg));
        await delay(30);
        assert.equal(sock.destroyed, false, msg.type);
        assert.equal(rec()?.capIdleAt, stuck, msg.type);
      }
      sock.write(frame({
        type: 'block',
        block: { hash: 'ab'.repeat(32), height: 1, header: '00'.repeat(80) },
      }));
      for (let i = 0; i < 40 && ingested < 1; i += 1) await delay(25);
      assert.equal(ingested, 1);
      assert.equal(rec()?.capIdleAt, stuck, 'block');
      assert.equal(sock.destroyed, false);
    } finally {
      p2p.close();
    }
  });

  it('an accepted tx or a verified block refreshes cap idle', async () => {
    let ingested = 0;
    const store = {
      blocks: [],
      mempool: [],
      tip: () => ({ height: 5, hash: Buffer.alloc(32, 4) }),
      on() { return () => {}; },
      queueTx(tx) { return { ok: true, tx }; },
      offerHeaders() { return { accepted: 1 }; },
      noteOpenRound(rows) {
        return (rows || []).map((row) => ({ tag: row.tag, count: row.count }));
      },
      ingest() {
        ingested += 1;
        return { ok: true };
      },
    };
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      maxPeers: 8,
      outboundReserve: 0,
      helloMs: 5000,
      idleMs: 5000,
      evictCooldownMs: 0,
    });
    const bound = await p2p.listen();
    try {
      const txSock = await connect(bound.port);
      const headerSock = await connect(bound.port);
      const workSock = await connect(bound.port);
      const blockSock = await connect(bound.port);
      txSock.write(helloLine());
      headerSock.write(helloLine());
      workSock.write(helloLine());
      blockSock.write(helloLine());
      await delay(80);
      ageInbound(p2p);
      const before = {
        tx: recFor(p2p, txSock)?.capIdleAt,
        headers: recFor(p2p, headerSock)?.capIdleAt,
        work: recFor(p2p, workSock)?.capIdleAt,
        block: recFor(p2p, blockSock)?.capIdleAt,
      };
      assert.ok(before.tx && before.headers && before.work && before.block);
      txSock.write(frame({ type: 'tx', tx: { id: 'accepted-tx' } }));
      headerSock.write(frame({
        type: 'headers',
        headers: [{ hash: 'ab'.repeat(32), height: 9, header: '00'.repeat(80) }],
      }));
      workSock.write(frame({ type: 'work', rows: [{ tag: 'mabcdef01', count: 4 }] }));
      workSock.write(frame({
        type: 'mempool',
        txs: [],
        work: [{ tag: 'mabcdef02', count: 5 }],
      }));
      blockSock.write(frame({
        type: 'block',
        block: { hash: 'cd'.repeat(32), height: 1, header: '11'.repeat(80) },
      }));
      for (let i = 0; i < 40 && ingested < 1; i += 1) await delay(25);
      assert.equal(ingested, 1);
      assert.ok(Date.now() - Number(recFor(p2p, txSock)?.capIdleAt) < 5000);
      assert.notEqual(recFor(p2p, txSock)?.capIdleAt, before.tx);
      assert.equal(recFor(p2p, headerSock)?.capIdleAt, before.headers);
      assert.equal(recFor(p2p, workSock)?.capIdleAt, before.work);
      assert.ok(Date.now() - Number(recFor(p2p, blockSock)?.capIdleAt) < 5000);
      assert.notEqual(recFor(p2p, blockSock)?.capIdleAt, before.block);
    } finally {
      p2p.close();
    }
  });

  it('a served getheaders, getblocks, or getblock refreshes cap idle', async () => {
    const hash = Buffer.alloc(32, 0x11);
    const header = Buffer.alloc(80, 0x22);
    const hex = hash.toString('hex');
    const store = {
      blocks: [{ hash, header, height: 1, txs: [] }],
      mempool: [],
      tip: () => ({ height: 1, hash, header }),
      on() { return () => {}; },
    };
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      maxPeers: 8,
      outboundReserve: 0,
      helloMs: 5000,
      idleMs: 5000,
      evictCooldownMs: 0,
    });
    const bound = await p2p.listen();
    try {
      const hit = async (msg) => {
        const sock = await connect(bound.port);
        sock.write(helloLine());
        await delay(40);
        ageInbound(p2p);
        const before = recFor(p2p, sock)?.capIdleAt;
        assert.ok(before);
        sock.write(frame(msg));
        await delay(40);
        assert.notEqual(recFor(p2p, sock)?.capIdleAt, before, msg.type);
        assert.equal(sock.destroyed, false);
        sock.destroy();
      };
      const miss = async (msg) => {
        const sock = await connect(bound.port);
        sock.write(helloLine());
        await delay(40);
        ageInbound(p2p);
        const before = recFor(p2p, sock)?.capIdleAt;
        assert.ok(before);
        sock.write(frame(msg));
        await delay(40);
        assert.equal(recFor(p2p, sock)?.capIdleAt, before, msg.type);
        assert.equal(sock.destroyed, false);
        sock.destroy();
      };
      await hit({ type: 'getheaders', locator: [] });
      await miss({ type: 'getheaders', locator: [hex] });
      await hit({ type: 'getblocks', locator: [] });
      await miss({ type: 'getblocks', locator: [hex] });
      await hit({ type: 'getblock', hash: hex });
      await miss({ type: 'getblock', hash: '00'.repeat(32) });
    } finally {
      p2p.close();
    }
  });

  it('a stage reject leaves the block retryable and does not score the peer', async () => {
    assert.equal(isFinalIngestFail('apply_stage'), false);
    assert.equal(isFinalIngestFail('pow'), true);
    assert.equal(isFinalIngestFail('merkle'), true);
    const plain = { expensiveFails: 0 };
    assert.equal(recordIngestFail(plain, 'apply_stage'), false);
    assert.equal(plain.expensiveFails || 0, 0);
    const hash = 'cd'.repeat(32);
    let calls = 0;
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
      ingest() {
        calls += 1;
        return { ok: false, reason: 'apply_stage' };
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
      await delay(40);
      const body = frame({
        type: 'block',
        block: { hash, height: 1, header: '00'.repeat(80) },
      });
      sock.write(body);
      const rec = () => [...p2p.peers.values()].find((row) => row.helloAt);
      for (let i = 0; i < 40 && calls < 1; i += 1) await delay(25);
      assert.equal(calls, 1);
      for (let i = 0; i < 40 && rec()?.verifying?.size; i += 1) await delay(25);
      assert.equal(Number(rec()?.expensiveFails) || 0, 0);
      assert.equal(rec()?.failed instanceof Set && rec().failed.has(hash), false);
      assert.equal(sock.destroyed, false);
      sock.write(body);
      for (let i = 0; i < 40 && calls < 2; i += 1) await delay(25);
      assert.equal(calls, 2);
      assert.equal(Number(rec()?.expensiveFails) || 0, 0);
      assert.equal(rec()?.failed instanceof Set && rec().failed.has(hash), false);
      assert.equal(sock.destroyed, false);
    } finally {
      p2p.close();
    }
  });

  it('a repeatable stage throw does not ban honest peers', async () => {
    for (const peersN of [1, 4, 8, 16]) {
      for (const deliveries of [1, 4, 10]) {
        let calls = 0;
        const store = {
          blocks: [],
          tip: () => null,
          on() { return () => {}; },
          ingest() {
            calls += 1;
            return { ok: false, reason: 'apply_stage' };
          },
        };
        const p2p = createP2p({
          store,
          port: 0,
          host: '127.0.0.1',
          magic: MAGIC_TESTNET,
          maxPeers: 32,
          outboundReserve: 0,
          inboundPer24: 32,
          helloMs: 5000,
          idleMs: 5000,
        });
        const bound = await p2p.listen();
        try {
          const sockets = [];
          for (let i = 0; i < peersN; i += 1) {
            const sock = await connect(bound.port);
            sock.write(helloLine());
            sockets.push(sock);
          }
          await delay(60);
          assert.equal([...p2p.peers.values()].filter((row) => row.helloAt).length, peersN);
          const body = frame({
            type: 'block',
            block: { hash: 'ee'.repeat(32), height: 1, header: '33'.repeat(80) },
          });
          for (let n = 0; n < deliveries; n += 1) {
            for (const sock of sockets) sock.write(body);
            const want = (n + 1) * peersN;
            for (let i = 0; i < 80 && calls < want; i += 1) await delay(25);
            for (const sock of sockets) {
              const rec = recFor(p2p, sock);
              if (rec?.verifying?.size) {
                for (let i = 0; i < 40 && rec.verifying.size; i += 1) await delay(15);
              }
            }
          }
          assert.equal(calls, peersN * deliveries, `${peersN}x${deliveries}`);
          for (const sock of sockets) {
            const rec = recFor(p2p, sock);
            assert.equal(sock.destroyed, false, `${peersN}x${deliveries}`);
            assert.equal(Number(rec?.expensiveFails) || 0, 0, `${peersN}x${deliveries}`);
            assert.equal(rec?.failed instanceof Set && rec.failed.has('ee'.repeat(32)), false);
          }
        } finally {
          p2p.close();
        }
      }
    }
  });

  it('unproven traffic sent inside 180s is evicted at the idle limit', async () => {
    let workN = 0;
    const store = {
      blocks: [],
      mempool: [],
      tip: () => ({ height: 5, hash: Buffer.alloc(32, 4) }),
      on() { return () => {}; },
      offerHeaders() { return { accepted: 1 }; },
      noteOpenRound() { return []; },
      queueTx(tx) {
        if (String(tx?.id || '').startsWith('bad')) return { ok: false, reason: 'bad' };
        return { ok: true, tx };
      },
    };
    const kinds = [
      {
        name: 'fake headers',
        send(sock) {
          sock.write(frame({
            type: 'headers',
            headers: [{ hash: 'ab'.repeat(32), height: 50, header: '00'.repeat(80) }],
          }));
        },
      },
      {
        name: 'stale headers',
        send(sock) {
          sock.write(frame({
            type: 'headers',
            headers: [{ hash: 'cd'.repeat(32), height: 1, header: '11'.repeat(80) }],
          }));
        },
      },
      {
        name: 'never-followed headers',
        send(sock) {
          sock.write(frame({
            type: 'headers',
            headers: [{ hash: 'ef'.repeat(32), height: 9, header: '22'.repeat(80) }],
          }));
        },
      },
      {
        name: 'random work tags',
        send(sock) {
          workN += 1;
          const tag = `m${workN.toString(16).padStart(8, '0')}`;
          sock.write(frame({ type: 'work', rows: [{ tag, count: workN }] }));
          sock.write(frame({ type: 'mempool', txs: [], work: [{ tag, count: workN + 1 }] }));
        },
      },
      {
        name: 'duplicate tx',
        async prepare(sock) {
          sock.write(frame({ type: 'tx', tx: { id: 'dup-tx' } }));
          await delay(30);
        },
        send(sock) {
          sock.write(frame({ type: 'tx', tx: { id: 'dup-tx' } }));
        },
      },
      {
        name: 'invalid tx',
        send(sock) {
          sock.write(frame({ type: 'tx', tx: { id: 'bad-tx' } }));
        },
      },
    ];
    for (const kind of kinds) {
      const p2p = createP2p({
        store,
        port: 0,
        host: '127.0.0.1',
        magic: MAGIC_TESTNET,
        maxPeers: 1,
        outboundReserve: 0,
        helloMs: 5000,
        idleMs: 180_000,
        evictCooldownMs: 0,
      });
      const bound = await p2p.listen();
      try {
        const sock = await connect(bound.port);
        sock.write(helloLine());
        await delay(40);
        if (kind.prepare) await kind.prepare(sock);
        for (const age of [30_000, 90_000, 170_000]) {
          const rec = recFor(p2p, sock);
          assert.ok(rec, kind.name);
          rec.capIdleAt = Date.now() - age;
          const stuck = rec.capIdleAt;
          kind.send(sock);
          await delay(40);
          assert.equal(recFor(p2p, sock)?.capIdleAt, stuck, `${kind.name} at ${age}`);
          const intruder = await connect(bound.port);
          await delay(40);
          assert.equal(sock.destroyed, false, `${kind.name} kept at ${age}`);
          assert.equal(intruder.destroyed, true, `${kind.name} intruder at ${age}`);
        }
        const rec = recFor(p2p, sock);
        rec.capIdleAt = Date.now() - 180_000;
        const stuck = rec.capIdleAt;
        kind.send(sock);
        await delay(40);
        assert.equal(recFor(p2p, sock)?.capIdleAt, stuck, `${kind.name} at 180s`);
        const next = await connect(bound.port);
        await delay(40);
        assert.equal(sock.destroyed, true, `${kind.name} evicted at 180s`);
        assert.equal(next.destroyed, false, `${kind.name} replacement`);
      } finally {
        p2p.close();
      }
    }
  });

  it('a peer work flood is stored and relayed only up to the per-peer cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-work-relay-'));
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
    try {
      const attacker = await connect(bound.port);
      const listener = await connect(bound.port);
      listener.on('data', (buf) => { heard.push(buf.toString()); });
      attacker.write(helloLine());
      listener.write(helloLine());
      await delay(80);
      heard.length = 0;
      ageInbound(p2p);
      const stuck = recFor(p2p, attacker)?.capIdleAt;
      assert.ok(stuck);
      const rows = [];
      for (let i = 0; i < 400; i += 1) {
        rows.push({ tag: `m${i.toString(16).padStart(8, '0')}`, count: i + 1 });
      }
      attacker.write(frame({ type: 'work', rows }));
      await delay(80);
      const relays = heard.join('').split('\n').filter((line) => line.includes('"type":"work"'));
      assert.equal(relays.length, 1);
      const relayed = JSON.parse(relays[0]);
      assert.ok(relayed.rows.length > 0);
      assert.ok(relayed.rows.length <= OPEN_ROUND_PEER_RATE);
      assert.equal(store.openRoundRows().length, relayed.rows.length);
      assert.equal(recFor(p2p, attacker)?.capIdleAt, stuck);
    } finally {
      p2p.close();
    }
  });

  it('a rolled-back mempool insert scores the peer', async () => {
    const store = {
      blocks: [],
      mempool: [],
      tip: () => null,
      on() { return () => {}; },
      queueTx() {
        return { ok: false, reason: 'mempool_partial', scorePeer: true };
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
      await delay(40);
      sock.write(`${JSON.stringify({ type: 'tx', magic: MAGIC_TESTNET, tx: { id: 'rolled' } })}\n`);
      sock.write(`${JSON.stringify({ type: 'tx', magic: MAGIC_TESTNET, tx: { id: 'rolled' } })}\n`);
      let rec = null;
      for (let i = 0; i < 20 && !(rec && rec.expensiveFails >= 2); i += 1) {
        await delay(20);
        rec = [...p2p.peers.values()].find((row) => row.helloAt) || null;
      }
      assert.equal(rec?.expensiveFails, 2);
      assert.equal(sock.destroyed, false);
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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GENESIS_BITS_PACKED, MAGIC_TESTNET } from '../../crypto/asert.js';
import { p2pHashStats, resetP2pHashStats } from '../../crypto/hash_offloop.js';
import { encodeHeader } from '../../crypto/header.js';
import { assessHeader, GENESIS_PREV, headerHash } from '../src/chain.js';
import { OPEN_ROUND_PEER_RATE, createStore } from '../src/store.js';
import {
  HEADERS_PAGE,
  P2P_ASK_BLOCKS,
  P2P_ASK_WINDOW_MS,
  P2P_BUSY_LIMIT,
  P2P_CLAIM_QUEUE,
  P2P_HELLO_FLOOR_MS,
  P2P_HELLO_MS,
  P2P_IDLE_FLOOR_MS,
  P2P_IDLE_MS,
  P2P_OUTBOUND_RESERVE,
  P2P_SERVE_BLOCK_PER_WINDOW,
  P2P_SERVE_CREDIT_BLOCKS,
  P2P_SERVE_HEADERS_PER_WINDOW,
  P2P_SERVE_WINDOW_MS,
  STAGE_HOLD_BASE_MS,
  STAGE_HOLD_MAX_MS,
  createP2p,
  isFinalIngestFail,
  nextStageHold,
  p2pHelloMs,
  p2pIdleMs,
  p2pInboundCap,
  p2pOutboundReserve,
  peerDemoted,
  peerIsBusy,
  peerShouldEvict,
  recordIngestFail,
  stageHoldActive,
  takeBlockAsk,
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

const wireBlocks = new Map();
function matchingBlock(fill) {
  const key = String(fill);
  if (!wireBlocks.has(key)) {
    const header = Buffer.alloc(128, fill);
    wireBlocks.set(key, {
      header: header.toString('hex'),
      hash: headerHash(header).toString('hex'),
    });
  }
  return wireBlocks.get(key);
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
      for (let i = 0; i < 40 && !(Number(rec()?.expensiveFails) > 0); i += 1) await delay(25);
      assert.equal(ingested, 0);
      assert.ok(Number(rec()?.expensiveFails) > 0);
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
      const proven = matchingBlock(0x11);
      blockSock.write(frame({
        type: 'block',
        block: { hash: proven.hash, height: 1, header: proven.header },
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

  it('a full header page refreshes cap idle and one new header does not', async () => {
    const short = [];
    for (let h = 1; h <= 3; h += 1) {
      const hash = Buffer.alloc(32);
      hash.writeUInt32BE(h, 0);
      short.push({ hash, header: Buffer.alloc(80), height: h, txs: [] });
    }
    const store = {
      blocks: short,
      mempool: [],
      tip: () => store.blocks[store.blocks.length - 1],
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
      const tipHex = short[short.length - 1].hash.toString('hex');
      await miss({ type: 'getheaders', locator: [] });
      await miss({ type: 'getheaders', locator: [tipHex] });
      await miss({ type: 'getblocks', locator: [] });
      await miss({ type: 'getblocks', locator: [tipHex] });
      await miss({ type: 'getblock', hash: tipHex });
      await miss({ type: 'getblock', hash: '00'.repeat(32) });
      const full = [];
      for (let h = 1; h <= HEADERS_PAGE; h += 1) {
        const hash = Buffer.alloc(32);
        hash.writeUInt32BE(h, 28);
        full.push({ hash, header: Buffer.alloc(80), height: h, txs: [] });
      }
      store.blocks = full;
      await hit({ type: 'getheaders', locator: [] });
      await hit({ type: 'getblocks', locator: [] });

      store.blocks = short;
      const again = await connect(bound.port);
      again.write(helloLine());
      await delay(40);
      again.write(frame({ type: 'getheaders', locator: [] }));
      await delay(40);
      ageInbound(p2p);
      const stuck = recFor(p2p, again)?.capIdleAt;
      assert.equal(recFor(p2p, again)?.servedHeight, short.length);
      again.write(frame({ type: 'getheaders', locator: [] }));
      again.write(frame({ type: 'getblocks', locator: [] }));
      again.write(frame({ type: 'getblock', hash: tipHex }));
      await delay(40);
      assert.equal(recFor(p2p, again)?.capIdleAt, stuck);
      const one = Buffer.alloc(32);
      const nextHeight = store.blocks.length + 1;
      one.writeUInt32BE(nextHeight, 0);
      store.blocks.push({ hash: one, header: Buffer.alloc(80), height: nextHeight, txs: [] });
      again.write(frame({ type: 'getblock', hash: one.toString('hex') }));
      await delay(40);
      assert.equal(recFor(p2p, again)?.capIdleAt, stuck);
      assert.equal(recFor(p2p, again)?.servedHeight, nextHeight);
      const anchor = store.blocks[store.blocks.length - 1].hash.toString('hex');
      const base = store.blocks.length;
      for (let n = 1; n <= HEADERS_PAGE; n += 1) {
        const hash = Buffer.alloc(32);
        hash.writeUInt32BE(base + n, 8);
        store.blocks.push({ hash, header: Buffer.alloc(80), height: base + n, txs: [] });
      }
      again.write(frame({ type: 'getheaders', locator: [anchor] }));
      await delay(40);
      assert.notEqual(recFor(p2p, again)?.capIdleAt, stuck);
      assert.equal(recFor(p2p, again)?.servedHeight, base + HEADERS_PAGE);
      assert.equal(again.destroyed, false);
    } finally {
      p2p.close();
    }
  });

  it('header and block serves are rate-limited per peer', async () => {
    const hash = Buffer.alloc(32, 0x11);
    const store = {
      blocks: [{ hash, header: Buffer.alloc(80, 0x22), height: 1, txs: [] }],
      mempool: [],
      tip: () => ({ height: 1, hash }),
      on() { return () => {}; },
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
    });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      let headers = 0;
      sock.on('data', (buf) => {
        headers += buf.toString().split('\n').filter((line) => line.includes('"type":"headers"')).length;
      });
      sock.write(helloLine());
      await delay(40);
      let busy = 0;
      sock.on('data', (buf) => {
        busy += buf.toString().split('\n').filter((line) => line.includes('"type":"serve_busy"')).length;
      });
      const burst = P2P_SERVE_HEADERS_PER_WINDOW + 4;
      for (let i = 0; i < burst; i += 1) sock.write(frame({ type: 'getheaders', locator: [] }));
      await delay(80);
      assert.equal(headers, P2P_SERVE_HEADERS_PER_WINDOW);
      assert.equal(busy, 4);
    } finally {
      p2p.close();
    }
  });

  it('an old locator or getblock is evicted at 180s and a forward peer stays', async () => {
    const blocks = [1, 2, 3].map((n) => ({
      hash: Buffer.alloc(32, n),
      header: Buffer.alloc(80, n),
      height: n,
      txs: [],
    }));
    const store = {
      blocks,
      mempool: [],
      tip: () => blocks[blocks.length - 1],
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
      idleMs: 180_000,
      evictCooldownMs: 0,
    });
    const bound = await p2p.listen();
    try {
      const squatter = await connect(bound.port);
      const forward = await connect(bound.port);
      squatter.write(helloLine());
      forward.write(helloLine());
      await delay(40);
      // A short page records the height and does not move the clock. Repeats
      // of that locator, and one new block, do not either. A full page does.
      squatter.write(frame({ type: 'getheaders', locator: [] }));
      forward.write(frame({ type: 'getheaders', locator: [] }));
      await delay(40);
      assert.equal(recFor(p2p, squatter)?.servedHeight, 3);
      assert.equal(recFor(p2p, forward)?.servedHeight, 3);
      const oldBlock = blocks[0].hash.toString('hex');
      const tipHash = blocks[2].hash.toString('hex');
      for (const age of [30_000, 90_000, 170_000]) {
        const rec = recFor(p2p, squatter);
        rec.capIdleAt = Date.now() - age;
        const stuck = rec.capIdleAt;
        squatter.write(frame({ type: 'getheaders', locator: [] }));
        squatter.write(frame({ type: 'getblocks', locator: [tipHash] }));
        squatter.write(frame({ type: 'getblock', hash: oldBlock }));
        await delay(30);
        assert.equal(recFor(p2p, squatter)?.capIdleAt, stuck, `squatter at ${age}`);
        assert.equal(squatter.destroyed, false);
      }
      recFor(p2p, squatter).capIdleAt = Date.now() - 180_000;
      recFor(p2p, forward).capIdleAt = Date.now() - 170_000;
      const squatAt = recFor(p2p, squatter).capIdleAt;
      squatter.write(frame({ type: 'getheaders', locator: [] }));
      squatter.write(frame({ type: 'getblock', hash: oldBlock }));
      await delay(40);
      assert.equal(recFor(p2p, squatter)?.capIdleAt, squatAt);
      const higher = {
        hash: Buffer.alloc(32, 4),
        header: Buffer.alloc(80, 4),
        height: 4,
        txs: [],
      };
      const past = {
        hash: Buffer.alloc(32, 5),
        header: Buffer.alloc(80, 5),
        height: 5,
        txs: [],
      };
      blocks.push(higher);
      const forwardAged = recFor(p2p, forward).capIdleAt;
      forward.write(frame({ type: 'getblock', hash: higher.hash.toString('hex') }));
      await delay(40);
      assert.equal(recFor(p2p, squatter)?.capIdleAt, squatAt);
      assert.equal(recFor(p2p, forward)?.capIdleAt, forwardAged);
      assert.equal(recFor(p2p, forward)?.servedHeight, 4);
      blocks.push(past);
      for (let n = blocks.length + 1; n <= 3 + HEADERS_PAGE; n += 1) {
        const hash = Buffer.alloc(32);
        hash.writeUInt32BE(n, 12);
        blocks.push({ hash, header: Buffer.alloc(80), height: n, txs: [] });
      }
      forward.write(frame({ type: 'getheaders', locator: [tipHash] }));
      await delay(80);
      assert.equal(recFor(p2p, squatter)?.capIdleAt, squatAt);
      assert.notEqual(recFor(p2p, forward)?.capIdleAt, forwardAged);
      assert.equal(recFor(p2p, forward)?.servedHeight, 3 + HEADERS_PAGE);
      const next = await connect(bound.port);
      await delay(40);
      assert.equal(squatter.destroyed, true);
      assert.equal(forward.destroyed, false);
      assert.equal(next.destroyed, false);
    } finally {
      p2p.close();
    }
  });

  it('walking one block at a time is evicted and a header page stays', async () => {
    const blocks = [1, 2, 3, 4, 5].map((n) => ({
      hash: Buffer.alloc(32, n),
      header: Buffer.alloc(80, n),
      height: n,
      txs: [],
    }));
    const store = {
      blocks,
      mempool: [],
      tip: () => blocks[blocks.length - 1],
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
      idleMs: 180_000,
      evictCooldownMs: 0,
    });
    const bound = await p2p.listen();
    try {
      const walker = await connect(bound.port);
      const stayer = await connect(bound.port);
      walker.write(helloLine());
      stayer.write(helloLine());
      await delay(40);
      stayer.write(frame({ type: 'getheaders', locator: [] }));
      await delay(40);
      assert.equal(recFor(p2p, stayer)?.servedHeight, 5);
      for (const [age, height] of [[30_000, 1], [90_000, 2], [170_000, 3]]) {
        const rec = recFor(p2p, walker);
        rec.capIdleAt = Date.now() - age;
        const stuck = rec.capIdleAt;
        const block = blocks[height - 1];
        walker.write(frame({ type: 'getblock', hash: block.hash.toString('hex') }));
        await delay(30);
        assert.equal(recFor(p2p, walker)?.capIdleAt, stuck, `walker at ${age}`);
        assert.equal(walker.destroyed, false);
      }
      assert.equal(recFor(p2p, walker)?.servedHeight, 3);
      recFor(p2p, walker).capIdleAt = Date.now() - 180_000;
      const next = await connect(bound.port);
      await delay(40);
      assert.equal(walker.destroyed, true);
      assert.equal(stayer.destroyed, false);
      assert.equal(next.destroyed, false);
    } finally {
      p2p.close();
    }
  });

  it('sixty four new blocks refresh cap idle and the tip does not', async () => {
    const blocks = [];
    for (let n = 1; n <= P2P_SERVE_CREDIT_BLOCKS; n += 1) {
      blocks.push({
        hash: Buffer.alloc(32, n),
        header: Buffer.alloc(80, n),
        height: n,
        txs: [],
      });
    }
    const store = {
      blocks,
      mempool: [],
      tip: () => blocks[blocks.length - 1],
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
      idleMs: 180_000,
      evictCooldownMs: 0,
    });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const rec = recFor(p2p, sock);
      rec.capIdleAt = Date.now() - 170_000;
      const stuck = rec.capIdleAt;
      for (let n = 1; n < P2P_SERVE_CREDIT_BLOCKS; n += 1) {
        sock.write(frame({ type: 'getblock', hash: blocks[n - 1].hash.toString('hex') }));
      }
      await delay(80);
      assert.equal(recFor(p2p, sock)?.capIdleAt, stuck);
      assert.equal(recFor(p2p, sock)?.servedHeight, P2P_SERVE_CREDIT_BLOCKS - 1);
      sock.write(frame({
        type: 'getblock',
        hash: blocks[P2P_SERVE_CREDIT_BLOCKS - 1].hash.toString('hex'),
      }));
      await delay(40);
      assert.notEqual(recFor(p2p, sock)?.capIdleAt, stuck);
      assert.equal(recFor(p2p, sock)?.servedHeight, P2P_SERVE_CREDIT_BLOCKS);
      const fresh = recFor(p2p, sock).capIdleAt;
      recFor(p2p, sock).capIdleAt = Date.now() - 170_000;
      const aged = recFor(p2p, sock).capIdleAt;
      sock.write(frame({ type: 'getheaders', locator: [] }));
      sock.write(frame({
        type: 'getblock',
        hash: blocks[P2P_SERVE_CREDIT_BLOCKS - 1].hash.toString('hex'),
      }));
      await delay(40);
      assert.equal(recFor(p2p, sock)?.capIdleAt, aged);
      assert.notEqual(aged, fresh);
    } finally {
      p2p.close();
    }
  });

  it('a stage reject is held without a score and retried after the backoff', async () => {
    assert.equal(isFinalIngestFail('apply_stage'), false);
    assert.equal(isFinalIngestFail('pow'), true);
    assert.equal(nextStageHold(null, 1_000).delay, STAGE_HOLD_BASE_MS);
    assert.equal(nextStageHold(null, 1_000).until, 1_000 + STAGE_HOLD_BASE_MS);
    assert.equal(nextStageHold({ delay: STAGE_HOLD_BASE_MS }, 1_000).delay, STAGE_HOLD_BASE_MS * 2);
    assert.equal(nextStageHold({ delay: STAGE_HOLD_MAX_MS }, 1_000).delay, STAGE_HOLD_MAX_MS);
    assert.equal(stageHoldActive({ until: 100 }, 99), true);
    assert.equal(stageHoldActive({ until: 100 }, 100), false);
    const plain = { expensiveFails: 0 };
    assert.equal(recordIngestFail(plain, 'apply_stage'), false);
    assert.equal(plain.expensiveFails || 0, 0);
    const wire = matchingBlock(0);
    const hash = wire.hash;
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
    const holdMs = 200;
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      helloMs: 5000,
      idleMs: 5000,
      stageHoldBaseMs: holdMs,
    });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const body = frame({
        type: 'block',
        block: { hash: wire.hash, height: 1, header: wire.header },
      });
      sock.write(body);
      const rec = () => [...p2p.peers.values()].find((row) => row.helloAt);
      for (let i = 0; i < 40 && calls < 1; i += 1) await delay(25);
      assert.equal(calls, 1);
      for (let i = 0; i < 40 && rec()?.verifying?.size; i += 1) await delay(25);
      resetP2pHashStats();
      sock.write(body);
      await delay(80);
      assert.equal(calls, 1);
      assert.equal(p2pHashStats().started, 0);
      assert.equal(Number(rec()?.expensiveFails) || 0, 0);
      assert.equal(rec()?.failed instanceof Set && rec().failed.has(hash), false);
      assert.equal(sock.destroyed, false);
      await delay(holdMs + 40);
      sock.write(body);
      for (let i = 0; i < 40 && calls < 2; i += 1) await delay(25);
      assert.equal(calls, 2);
      assert.equal(Number(rec()?.expensiveFails) || 0, 0);
      assert.equal(sock.destroyed, false);
    } finally {
      p2p.close();
    }
  });

  it('a replay of our own blocks hashes nothing', async () => {
    const owned = [0x61, 0x62, 0x63].map((fill) => matchingBlock(fill));
    const store = {
      blocks: owned.map((row, i) => ({
        hash: Buffer.from(row.hash, 'hex'),
        header: Buffer.from(row.header, 'hex'),
        height: i + 1,
        txs: [],
      })),
      tip: () => store.blocks[store.blocks.length - 1],
      on() { return () => {}; },
      ingest() { throw new Error('replay must not ingest'); },
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
      resetP2pHashStats();
      for (const row of owned) {
        sock.write(frame({
          type: 'block',
          block: { hash: row.hash, height: 1, header: row.header },
        }));
      }
      await delay(80);
      assert.equal(p2pHashStats().started, 0);
      const rec = () => [...p2p.peers.values()].find((row) => row.helloAt);
      assert.equal(Number(rec()?.expensiveFails) || 0, 0);
      assert.equal(sock.destroyed, false);
      resetP2pHashStats();
      sock.write(frame({
        type: 'block',
        block: { hash: owned[0].hash, height: 1, header: owned[1].header },
      }));
      for (let i = 0; i < 20 && !(Number(rec()?.expensiveFails) > 0); i += 1) await delay(20);
      assert.equal(p2pHashStats().started, 0);
      assert.equal(Number(rec()?.expensiveFails), 1);
      assert.equal(rec()?.failed instanceof Set && rec().failed.has(owned[0].hash), false);
      assert.equal(sock.destroyed, false);
    } finally {
      p2p.close();
    }
  });

  it('queued claim hashes are capped per peer', async () => {
    let calls = 0;
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
      ingest() {
        calls += 1;
        return { ok: true };
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
      resetP2pHashStats();
      const burst = P2P_CLAIM_QUEUE + 4;
      for (let n = 0; n < burst; n += 1) {
        const row = matchingBlock(n + 1);
        sock.write(frame({
          type: 'block',
          block: { hash: row.hash, height: 1, header: row.header },
        }));
      }
      for (let i = 0; i < 80 && calls < P2P_CLAIM_QUEUE; i += 1) await delay(25);
      await delay(80);
      assert.equal(p2pHashStats().started, P2P_CLAIM_QUEUE);
      assert.equal(calls, P2P_CLAIM_QUEUE);
    } finally {
      p2p.close();
    }
  });

  it('a wrong claimed hash is dropped before the hold and does not block the real block', async () => {
    const header = encodeHeader({
      prevBlockHash: GENESIS_PREV,
      merkleRoot: Buffer.alloc(32, 1),
      continuityRoot: Buffer.alloc(32, 2),
      timestamp: 1_700_000_000_000,
      bits: GENESIS_BITS_PACKED,
      nonce: 1n,
      baseFee: 1n,
    });
    const claimed = Buffer.alloc(32, 0xab);
    const assessed = assessHeader({
      header,
      hash: claimed,
      height: 1,
    }, null, {
      preparedHash: Buffer.alloc(32),
      stopAfterPow: true,
      magic: MAGIC_TESTNET,
    });
    assert.equal(assessed.ok, true);
    assert.equal(Buffer.from(assessed.hash).equals(claimed), false);

    const evil = matchingBlock(0x44);
    const honest = matchingBlock(0x55);
    let calls = 0;
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
      ingest(fork) {
        calls += 1;
        const hex = Buffer.from(fork[0].header).toString('hex');
        if (hex === evil.header) return { ok: false, reason: 'apply_stage', at: 0 };
        return { ok: true };
      },
    };
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      helloMs: 5000,
      idleMs: 5000,
      stageHoldBaseMs: 60_000,
    });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const rec = () => [...p2p.peers.values()].find((row) => row.helloAt);
      const lie = frame({
        type: 'block',
        block: { hash: honest.hash, height: 1, header: evil.header },
      });
      sock.write(lie);
      for (let i = 0; i < 40 && !(Number(rec()?.expensiveFails) > 0); i += 1) await delay(25);
      assert.equal(calls, 0);
      assert.equal(Number(rec()?.expensiveFails), 1);
      assert.equal(rec()?.failed instanceof Set && rec().failed.has(honest.hash), false);
      assert.equal(sock.destroyed, false);
      const evilBody = frame({
        type: 'block',
        block: { hash: evil.hash, height: 1, header: evil.header },
      });
      sock.write(evilBody);
      for (let i = 0; i < 80 && calls < 1; i += 1) await delay(25);
      assert.equal(calls, 1);
      for (let i = 0; i < 40 && rec()?.verifying?.size; i += 1) await delay(25);
      sock.write(evilBody);
      await delay(80);
      assert.equal(calls, 1);
      // A held header is dropped before the claim check, so this lie is free.
      sock.write(lie);
      await delay(80);
      assert.equal(calls, 1);
      assert.equal(Number(rec()?.expensiveFails), 1);
      assert.equal(rec()?.failed instanceof Set && rec().failed.has(honest.hash), false);
      const other = matchingBlock(0x66);
      sock.write(frame({
        type: 'block',
        block: { hash: honest.hash, height: 1, header: other.header },
      }));
      for (let i = 0; i < 40 && Number(rec()?.expensiveFails) < 2; i += 1) await delay(25);
      assert.equal(calls, 1);
      assert.equal(Number(rec()?.expensiveFails), 2);
      assert.equal(rec()?.failed instanceof Set && rec().failed.has(honest.hash), false);
      const honestBody = frame({
        type: 'block',
        block: { hash: honest.hash, height: 1, header: honest.header },
      });
      sock.write(honestBody);
      for (let i = 0; i < 80 && calls < 2; i += 1) await delay(25);
      assert.equal(calls, 2);
      assert.equal(sock.destroyed, false);
    } finally {
      p2p.close();
    }
  });

  it('a multi-block stage throw holds the block that threw', async () => {
    const parts = [0x21, 0x22, 0x23].map((fill) => matchingBlock(fill));
    let calls = 0;
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
      ingest(fork) {
        calls += 1;
        if (fork.length > 1) return { ok: false, reason: 'apply_stage', at: 1 };
        return { ok: true };
      },
    };
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      helloMs: 5000,
      idleMs: 5000,
      stageHoldBaseMs: 60_000,
    });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const batch = frame({
        type: 'block',
        blocks: parts.map((part) => ({ hash: part.hash, height: 1, header: part.header })),
      });
      sock.write(batch);
      for (let i = 0; i < 80 && calls < 1; i += 1) await delay(25);
      assert.equal(calls, 1);
      const rec = () => [...p2p.peers.values()].find((row) => row.helloAt);
      for (let i = 0; i < 40 && rec()?.verifying?.size; i += 1) await delay(25);
      sock.write(batch);
      await delay(80);
      assert.equal(calls, 1);
      assert.equal(Number(rec()?.expensiveFails) || 0, 0);
      const alone = (part) => frame({
        type: 'block',
        block: { hash: part.hash, height: 1, header: part.header },
      });
      sock.write(alone(parts[0]));
      for (let i = 0; i < 80 && calls < 2; i += 1) await delay(25);
      assert.equal(calls, 2);
      sock.write(alone(parts[2]));
      for (let i = 0; i < 80 && calls < 3; i += 1) await delay(25);
      assert.equal(calls, 3);
      sock.write(alone(parts[1]));
      await delay(80);
      assert.equal(calls, 3);
      assert.equal(sock.destroyed, false);
    } finally {
      p2p.close();
    }
  });

  it('an over-limit getblock is busy and our client does not count a miss', async () => {
    const ask = {};
    const t0 = 5_000_000;
    for (let i = 0; i < P2P_ASK_BLOCKS; i += 1) assert.equal(takeBlockAsk(ask, t0), true);
    assert.equal(takeBlockAsk(ask, t0 + P2P_ASK_WINDOW_MS - 1), false);
    assert.equal(takeBlockAsk(ask, t0 + P2P_ASK_WINDOW_MS), true);
    assert.ok(P2P_ASK_BLOCKS * (P2P_SERVE_WINDOW_MS / P2P_ASK_WINDOW_MS) < P2P_SERVE_BLOCK_PER_WINDOW);

    const hash = Buffer.alloc(32, 0x11);
    const store = {
      blocks: [{ hash, header: Buffer.alloc(80, 0x22), height: 1, txs: [] }],
      mempool: [],
      tip: () => ({ height: 1, hash }),
      on() { return () => {}; },
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
    });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      let busy = 0;
      let nak = 0;
      sock.on('data', (buf) => {
        const text = buf.toString();
        busy += text.split('\n').filter((line) => line.includes('"type":"serve_busy"')).length;
        nak += text.split('\n').filter((line) => line.includes('"type":"getblock_nak"')).length;
      });
      sock.write(helloLine());
      await delay(40);
      const hex = hash.toString('hex');
      const burst = P2P_SERVE_BLOCK_PER_WINDOW + 2;
      for (let i = 0; i < burst; i += 1) sock.write(frame({ type: 'getblock', hash: hex }));
      await delay(80);
      assert.equal(busy, 2);
      assert.equal(nak, 0);
    } finally {
      p2p.close();
    }

    let remote = null;
    const listener = net.createServer((sock) => {
      remote = sock;
      sock.on('data', (buf) => {
        if (buf.toString().includes('"type":"hello"')) sock.write(helloLine());
      });
      sock.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const client = createP2p({
      store: { blocks: [], mempool: [], tip: () => null, on() { return () => {}; } },
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      helloMs: 5000,
      idleMs: 5000,
    });
    try {
      await client.connect('127.0.0.1', listener.address().port);
      for (let i = 0; i < 40 && !remote; i += 1) await delay(25);
      await delay(40);
      const peer = [...client.peers.values()][0];
      assert.ok(peer?.helloAt);
      const id = 'ab'.repeat(32);
      peer.pending = new Set([id]);
      peer.want = [];
      remote.write(frame({ type: 'serve_busy', what: 'getblock', hash: id }));
      await delay(40);
      assert.equal(Number(peer.getblockMiss) || 0, 0);
      assert.equal(peer.pending.has(id), false);
      assert.ok(peer.want.includes(id));
      assert.equal(peerDemoted(peer), false);
      peer.pending = new Set([id]);
      remote.write(frame({ type: 'getblock_nak', hash: id }));
      await delay(40);
      assert.equal(Number(peer.getblockMiss) || 0, 1);
    } finally {
      client.close();
      remote?.destroy();
      listener.close();
    }

    const heard = [[], []];
    const remotes = [null, null];
    const servers = await Promise.all([0, 1].map((i) => new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        remotes[i] = sock;
        sock.on('data', (buf) => {
          const text = buf.toString();
          if (text.includes('"type":"hello"')) sock.write(helloLine());
          if (text.includes('"type":"getblock"')) heard[i].push(text);
        });
        sock.on('error', () => {});
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    })));
    const mesh = createP2p({
      store: { blocks: [], mempool: [], tip: () => null, on() { return () => {}; } },
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      helloMs: 5000,
      idleMs: 5000,
    });
    try {
      await mesh.connect('127.0.0.1', servers[0].address().port);
      await mesh.connect('127.0.0.1', servers[1].address().port);
      for (let i = 0; i < 40 && (!remotes[0] || !remotes[1]); i += 1) await delay(25);
      await delay(40);
      const peerAt = (port) => [...mesh.peers.entries()].find(([sock]) => sock.remotePort === port);
      const asker = peerAt(servers[0].address().port)?.[1];
      const other = peerAt(servers[1].address().port)?.[1];
      assert.ok(asker?.helloAt);
      assert.ok(other?.helloAt);
      const id = 'cd'.repeat(32);
      const busy = (hash) => `${JSON.stringify({ type: 'serve_busy', magic: MAGIC_TESTNET, what: 'getblock', hash })}\n`;
      asker.pending = new Set([id]);
      other.want = [];
      remotes[1].write(busy(id));
      await delay(50);
      assert.equal(asker.pending.has(id), true);
      assert.equal(other.want.includes(id), false);
      for (let n = 1; n < P2P_BUSY_LIMIT; n += 1) {
        asker.pending = new Set([id]);
        remotes[0].write(busy(id));
        await delay(50);
        assert.equal(asker.pending.has(id), false);
        assert.ok(asker.want.includes(id));
      }
      heard[1].length = 0;
      asker.pending = new Set([id]);
      remotes[0].write(busy(id));
      await delay(40);
      assert.equal(asker.pending.has(id), false);
      assert.equal(asker.want.includes(id), false);
      assert.equal(other.pending.has(id), true);
      assert.ok(heard[1].some((line) => line.includes('"type":"getblock"') && line.includes(id)));
    } finally {
      mesh.close();
      for (const server of servers) server.close();
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
        const holdMs = 150;
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
          stageHoldBaseMs: holdMs,
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
          const wire = matchingBlock(0x33);
          const body = frame({
            type: 'block',
            block: { hash: wire.hash, height: 1, header: wire.header },
          });
          sockets[0].write(body);
          for (let i = 0; i < 40 && calls < 1; i += 1) await delay(25);
          assert.equal(calls, 1, `${peersN}x${deliveries} first`);
          for (let n = 0; n < deliveries; n += 1) {
            for (const sock of sockets) sock.write(body);
          }
          await delay(60);
          assert.equal(calls, 1, `${peersN}x${deliveries} held`);
          for (const sock of sockets) {
            const rec = recFor(p2p, sock);
            assert.equal(sock.destroyed, false, `${peersN}x${deliveries}`);
            assert.equal(Number(rec?.expensiveFails) || 0, 0, `${peersN}x${deliveries}`);
            assert.equal(rec?.failed instanceof Set && rec.failed.has(wire.hash), false);
          }
          await delay(holdMs + 30);
          sockets[0].write(body);
          for (let i = 0; i < 40 && calls < 2; i += 1) await delay(25);
          assert.equal(calls, 2, `${peersN}x${deliveries} retry`);
          assert.equal(sockets[0].destroyed, false);
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

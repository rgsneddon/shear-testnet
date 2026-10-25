import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GENESIS_BITS_PACKED, MAGIC_TESTNET } from '../../crypto/asert.js';
import { p2pHashStats, resetP2pHashStats } from '../../crypto/hash_offloop.js';
import { encodeHeader } from '../../crypto/header.js';
import { packHashCreditBytes, unpackHashCreditBytes } from '../../crypto/hash_owed.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import { assessHeader, GENESIS_PREV, headerHash } from '../src/chain.js';
import { OPEN_ROUND_PEER_RATE, createStore } from '../src/store.js';
import {
  HEADERS_PAGE,
  ORPHAN_PARENT_MAX,
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
  STAGE_HOLD_BODIES,
  STAGE_HOLD_MAX_MS,
  createP2p,
  fingerprintHelloHash,
  getblockBatch,
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
  stageBodyKey,
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
  return `${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET, fingerprint: fingerprintHelloHash(MAGIC_TESTNET) })}\n`;
}

function frame(msg) {
  return `${JSON.stringify({ ...msg, magic: MAGIC_TESTNET })}\n`;
}

// headerHash is RandomX on the test thread, about 0.5 s per header on a slow
// box. Build every row before a socket connects. Hashing inside a live test
// stalls the node's own loop past its idle limit and it evicts the peer.
const wireBlocks = new Map();
function matchingBlock(fill) {
  const key = String(fill);
  if (!wireBlocks.has(key)) {
    const header = Buffer.alloc(128, fill);
    // bits 0: a target any hash meets, as a real block's id meets its own
    // header's target. The claim check refuses a claim that misses it unhashed.
    header.writeUInt32LE(0, 108);
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
        { type: 'hello', fingerprint: fingerprintHelloHash(MAGIC_TESTNET) },
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
    const proven = matchingBlock(0x11);
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
    const burst = P2P_CLAIM_QUEUE + 4;
    const rows = [];
    for (let n = 0; n < burst; n += 1) rows.push(matchingBlock(n + 1));
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
      for (const row of rows) {
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

  it('a peer\'s blocks reach ingest in arrival order when a later claim hashes first', async () => {
    const first = matchingBlock(0x71);
    const second = matchingBlock(0x72);
    const order = [];
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
      ingest(fork) {
        order.push(Buffer.from(fork[0].header).toString('hex'));
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
      const send = (row) => sock.write(frame({
        type: 'block',
        block: { hash: row.hash, height: 1, header: row.header },
      }));
      // The second block's claim is hashed once and cached, so the next time
      // it resolves at once while the first block's claim is still hashing.
      send(second);
      for (let i = 0; i < 200 && order.length < 1; i += 1) await delay(25);
      assert.equal(order.length, 1, 'warm-up body ingested');
      order.length = 0;
      send(first);
      send(second);
      for (let i = 0; i < 200 && order.length < 2; i += 1) await delay(25);
      assert.deepEqual(order, [first.header, second.header], 'arrival order');
    } finally {
      p2p.close();
    }
  });

  it('a full getblock window of asked bodies is hashed, and an over-cap body goes back to want', async () => {
    const window = getblockBatch();
    const rows = [];
    for (let n = 0; n < window; n += 1) rows.push(matchingBlock(200 + n));
    const extra = matchingBlock(250);
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
      const rec = recFor(p2p, sock);
      assert.ok(rec, 'peer record');
      assert.ok(window > P2P_CLAIM_QUEUE, 'the window is wider than the unsolicited cap');
      // The peer is ahead, as it is during IBD. Otherwise the first verified
      // body releases the idle catch-up and clears pending.
      rec.height = 1000;
      rec.pending = new Set(rows.map((row) => row.hash));
      rec.want = [];
      resetP2pHashStats();
      for (const row of rows) {
        sock.write(frame({
          type: 'block',
          block: { hash: row.hash, height: 1, header: row.header },
        }));
      }
      for (let i = 0; i < 200 && calls < window; i += 1) await delay(25);
      assert.equal(p2pHashStats().started, window);
      assert.equal(calls, window);

      rec.pending = new Set([extra.hash]);
      rec.want = [];
      rec.claimQueued = window;
      sock.write(frame({
        type: 'block',
        block: { hash: extra.hash, height: 1, header: extra.header },
      }));
      await delay(80);
      assert.equal(rec.pending.has(extra.hash), false, 'not left in flight');
      assert.equal(rec.want[0], extra.hash, 'asked again later');
      assert.equal(calls, window);
      rec.claimQueued = 0;
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
    const other = matchingBlock(0x66);
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
    // One serve window overlaps up to ceil(serve / ask) + 1 fixed ask windows.
    const overlap = Math.ceil(P2P_SERVE_WINDOW_MS / P2P_ASK_WINDOW_MS) + 1;
    assert.ok(P2P_ASK_BLOCKS * overlap < P2P_SERVE_BLOCK_PER_WINDOW, 'an honest fast IBD stays under the serve cap with headroom');

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
      // The other peer is not ahead of us, so the hash stays with the asker.
      heard[1].length = 0;
      asker.pending = new Set([id]);
      remotes[0].write(busy(id));
      await delay(40);
      assert.equal(asker.pending.has(id), false);
      assert.equal(asker.want[0], id);
      assert.equal(other.pending?.has(id) || false, false);
      assert.equal(heard[1].some((line) => line.includes(id)), false);
      // Once it is ahead, the third busy in a row hands the hash to it.
      other.height = 5;
      for (let n = 1; n < P2P_BUSY_LIMIT; n += 1) {
        asker.pending = new Set([id]);
        remotes[0].write(busy(id));
        await delay(50);
      }
      asker.pending = new Set([id]);
      asker.want = asker.want.filter((h) => h !== id);
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

  it('census does not end a busy streak, and a busy header page clears syncing', async () => {
    const server = net.createServer((sock) => {
      sock.on('data', (buf) => {
        if (buf.toString().includes('"type":"hello"')) sock.write(helloLine());
      });
      sock.on('error', () => {});
    });
    let remote = null;
    server.on('connection', (sock) => { remote = sock; });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const mesh = createP2p({
      store: { blocks: [], mempool: [], tip: () => null, on() { return () => {}; } },
      port: 0,
      host: '127.0.0.1',
      magic: MAGIC_TESTNET,
      helloMs: 5000,
      idleMs: 5000,
    });
    try {
      await mesh.connect('127.0.0.1', server.address().port);
      for (let i = 0; i < 40 && !remote; i += 1) await delay(25);
      await delay(40);
      const rec = [...mesh.peers.values()][0];
      assert.ok(rec?.helloAt);
      const id = 'ef'.repeat(32);
      const line = (msg) => `${JSON.stringify({ magic: MAGIC_TESTNET, ...msg })}
`;
      rec.pending = new Set([id]);
      remote.write(line({ type: 'serve_busy', what: 'getblock', hash: id }));
      await delay(50);
      assert.equal(rec.busyStreak, 1);
      remote.write(line({ type: 'census', hop: 0, nodes: [] }));
      await delay(50);
      assert.equal(rec.busyStreak, 1, 'census leaves the streak');

      rec.pending = new Set();
      rec.syncing = true;
      rec.softHoldUntil = 0;
      remote.write(line({ type: 'serve_busy', what: 'getheaders' }));
      await delay(50);
      assert.ok(Number(rec.softHoldUntil) > Date.now(), 'soft retry armed');
      assert.ok(Number(rec.softHoldUntil) <= Date.now() + P2P_SERVE_WINDOW_MS, 'held for one serve window');
      assert.ok(rec.softTimer, 'retry clears syncing');
    } finally {
      mesh.close();
      server.close();
    }
  });

  it('a claim that misses its own header target is scored unhashed, and a lying frame costs one hash', async () => {
    let calls = 0;
    const store = { blocks: [], tip: () => null, on() { return () => {}; }, ingest() { calls += 1; return { ok: true }; } };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 5000 });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const rec = () => [...p2p.peers.values()].find((row) => row.helloAt);
      // Header bits ask for 200 leading zero bits; a random claim misses it.
      const header = Buffer.alloc(128, 0x44);
      header.writeUInt32LE(200, 108);
      resetP2pHashStats();
      sock.write(frame({ type: 'block', block: { hash: 'ab'.repeat(32), height: 1, header: header.toString('hex') } }));
      for (let i = 0; i < 40 && !(Number(rec()?.expensiveFails) > 0); i += 1) await delay(25);
      assert.ok(Number(rec()?.expensiveFails) > 0, 'scored');
      assert.equal(p2pHashStats().started, 0, 'no ShearHash for a claim that misses its target');
      // Three blocks whose first claim lies: hashing stops at the first.
      const a = matchingBlock(0x51);
      const b = matchingBlock(0x52);
      const c = matchingBlock(0x53);
      const before = Number(rec()?.expensiveFails) || 0;
      resetP2pHashStats();
      sock.write(frame({ type: 'block', blocks: [
        { hash: 'cd'.repeat(32), height: 1, header: a.header },
        { hash: b.hash, height: 2, header: b.header },
        { hash: c.hash, height: 3, header: c.header },
      ] }));
      for (let i = 0; i < 80 && (Number(rec()?.expensiveFails) || 0) === before; i += 1) await delay(25);
      assert.ok((Number(rec()?.expensiveFails) || 0) > before, 'lying frame scored');
      assert.equal(p2pHashStats().started, 1, 'one hash for a frame whose first claim lies');
      assert.equal(calls, 0, 'nothing ingested');
    } finally {
      p2p.close();
    }
  });

  it('junk does not reset a busy streak, busy at the limit is a miss, and an unsolicited nak changes nothing', async () => {
    const server = net.createServer((sock) => {
      sock.on('data', (buf) => { if (buf.toString().includes('"type":"hello"')) sock.write(helloLine()); });
      sock.on('error', () => {});
    });
    let remote = null;
    server.on('connection', (sock) => { remote = sock; });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const mesh = createP2p({
      store: { blocks: [], mempool: [], tip: () => null, on() { return () => {}; } },
      port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 5000,
    });
    try {
      await mesh.connect('127.0.0.1', server.address().port);
      for (let i = 0; i < 40 && !remote; i += 1) await delay(25);
      await delay(40);
      const rec = [...mesh.peers.values()][0];
      assert.ok(rec?.helloAt);
      const line = (msg) => `${JSON.stringify({ magic: MAGIC_TESTNET, ...msg })}\n`;
      const id = 'ef'.repeat(32);
      rec.pending = new Set([id]);
      remote.write(line({ type: 'serve_busy', what: 'getblock', hash: id }));
      await delay(50);
      assert.equal(rec.busyStreak, 1);
      // Old code reset the streak on any block-type message.
      remote.write(line({ type: 'blocks', blocks: [{}, {}] }));
      remote.write(line({ type: 'block_not_found', hash: '11'.repeat(32) }));
      await delay(50);
      assert.equal(rec.busyStreak, 1, 'junk and unsolicited answers leave the streak');
      const missesBefore = Number(rec.getblockMiss) || 0;
      rec.pending = new Set([id]);
      remote.write(line({ type: 'serve_busy', what: 'getblock', hash: id }));
      await delay(50);
      rec.pending = new Set([id]);
      remote.write(line({ type: 'serve_busy', what: 'getblock', hash: id }));
      await delay(50);
      assert.equal(Number(rec.getblockMiss) || 0, missesBefore + 1, 'busy at the limit counts a miss');
      // An unsolicited nak does not add to want or count a miss.
      const wantBefore = [...(rec.want || [])];
      const missAt = Number(rec.getblockMiss) || 0;
      remote.write(line({ type: 'getblock_nak', hash: '22'.repeat(32) }));
      await delay(50);
      assert.deepEqual(rec.want || [], wantBefore);
      assert.equal(Number(rec.getblockMiss) || 0, missAt);
      // A busy answer to a burial ask is retried, not left quiet.
      rec.pending = new Set();
      rec.syncing = false;
      rec.burialWait = new Set(['33'.repeat(32)]);
      rec.burialAskHeight = 7;
      rec.softHoldUntil = 0;
      remote.write(line({ type: 'serve_busy', what: 'getheaders' }));
      await delay(50);
      assert.equal(rec.burialAskHeight, 0, 'burial ask no longer quiet');
      assert.ok(Number(rec.softHoldUntil) > Date.now(), 'retry armed');
    } finally {
      mesh.close();
      server.close();
    }
  });

  it('a stage hold keys on the exact body, so a malleated copy does not hold the honest block', async () => {
    const wire = matchingBlock(0x61);
    let calls = 0;
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
      ingest(fork) {
        calls += 1;
        // The malleated copy throws in staging; the honest one is accepted.
        return fork?.[0]?.samplesPruned === true ? { ok: false, reason: 'apply_stage' } : { ok: true };
      },
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 5000, stageHoldBaseMs: 60_000 });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const rec = () => [...p2p.peers.values()].find((row) => row.helloAt);
      const malleated = { hash: wire.hash, height: 1, header: wire.header, samplesPruned: true };
      sock.write(frame({ type: 'block', block: malleated }));
      for (let i = 0; i < 40 && calls < 1; i += 1) await delay(25);
      assert.equal(calls, 1);
      for (let i = 0; i < 40 && rec()?.verifying?.size; i += 1) await delay(25);
      // The same malleated body again is held (no second verify).
      sock.write(frame({ type: 'block', block: malleated }));
      await delay(80);
      assert.equal(calls, 1, 'malleated body held');
      // The honest body for the same header is not held. Old code keyed the
      // hold on the header alone and dropped it.
      sock.write(frame({ type: 'block', block: { hash: wire.hash, height: 1, header: wire.header } }));
      for (let i = 0; i < 40 && calls < 2; i += 1) await delay(25);
      assert.equal(calls, 2, 'honest body verified');
    } finally {
      p2p.close();
    }
  });

  it('a free or undecodable block frame does not reset a busy streak, and only a page answering our ask resets the header streak', async () => {
    const server = net.createServer((sock) => {
      sock.on('data', (buf) => { if (buf.toString().includes('"type":"hello"')) sock.write(helloLine()); });
      sock.on('error', () => {});
    });
    let remote = null;
    server.on('connection', (sock) => { remote = sock; });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const mesh = createP2p({
      store: { blocks: [], mempool: [], tip: () => null, on() { return () => {}; } },
      port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 5000,
    });
    try {
      await mesh.connect('127.0.0.1', server.address().port);
      for (let i = 0; i < 40 && !remote; i += 1) await delay(25);
      await delay(40);
      const rec = [...mesh.peers.values()][0];
      assert.ok(rec?.helloAt);
      const line = (msg) => `${JSON.stringify({ magic: MAGIC_TESTNET, ...msg })}\n`;
      const id = 'ab'.repeat(32);
      rec.pending = new Set([id]);
      remote.write(line({ type: 'serve_busy', what: 'getblock', hash: id }));
      await delay(50);
      assert.equal(rec.busyStreak, 1);
      // A two-row `blocks` frame ending in the hash we asked for is returned
      // unread, and a `block` that does not decode is too. Neither is an answer.
      remote.write(line({ type: 'blocks', blocks: [{}, { hash: id }] }));
      remote.write(line({ type: 'block', block: { hash: id, header: 'zz' } }));
      // A second busy for the same ask, after the free frames: frames are read
      // in order, so once it lands both frames were handled. A reset by
      // either would leave the streak at 1, not 2.
      rec.pending = new Set([id]);
      remote.write(line({ type: 'serve_busy', what: 'getblock', hash: id }));
      for (let i = 0; i < 80 && rec.busyStreak !== 2; i += 1) await delay(25);
      assert.equal(rec.busyStreak, 2, 'free frames leave the busy streak');
      // The header streak: a page answering our getheaders ends it, empty or
      // not (an empty page is the peer's answer that it has nothing more); a
      // page we did not ask for leaves it.
      const page = [{ hash: '45'.repeat(32), height: 1, header: Buffer.alloc(128, 0x45).toString('hex') }];
      rec.headerBusyStreak = 2;
      rec.headersAskedAt = Date.now();
      remote.write(line({ type: 'headers', headers: [] }));
      for (let i = 0; i < 80 && rec.headerBusyStreak !== 0; i += 1) await delay(25);
      assert.equal(rec.headerBusyStreak, 0, 'an empty page answering our ask ends the streak');
      rec.headerBusyStreak = 2;
      rec.headersAskedAt = 0;
      remote.write(line({ type: 'headers', headers: page }));
      // Sentinel: a not-found for an asked hash counts a miss once handled.
      const sentinel = 'cd'.repeat(32);
      rec.pending = new Set([sentinel]);
      const missBefore = Number(rec.getblockMiss) || 0;
      remote.write(line({ type: 'block_not_found', hash: sentinel }));
      for (let i = 0; i < 80 && (Number(rec.getblockMiss) || 0) === missBefore; i += 1) await delay(25);
      assert.equal(Number(rec.getblockMiss) || 0, missBefore + 1, 'sentinel handled');
      assert.equal(rec.headerBusyStreak, 2, 'an unsolicited page is not an answer');
      rec.headersAskedAt = Date.now();
      remote.write(line({ type: 'headers', headers: page }));
      for (let i = 0; i < 80 && rec.headerBusyStreak !== 0; i += 1) await delay(25);
      assert.equal(rec.headerBusyStreak, 0, 'the page we asked for ends the streak');
    } finally {
      mesh.close();
      server.close();
    }
  });

  it('a body carrying hash credits is stage-held like any other', async () => {
    const wire = matchingBlock(0x63);
    const dest20 = Buffer.alloc(20, 0x2c);
    // Hash-credit rows decode with BigInt nanos; the hold key must still form.
    const credits = packHashCreditBytes([{ noteCommit: noteCommitOfDest20(dest20), dest20, nanos: 7n }]).toString('hex');
    let calls = 0;
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
      ingest(fork) {
        calls += 1;
        assert.equal(typeof fork?.[0]?.hashCredits?.[0]?.nanos, 'bigint', 'credits decode to BigInt nanos');
        return { ok: false, reason: 'apply_stage' };
      },
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 5000, stageHoldBaseMs: 60_000 });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const rec = () => [...p2p.peers.values()].find((row) => row.helloAt);
      const body = { hash: wire.hash, height: 1, header: wire.header, hashCreditPacked: credits };
      sock.write(frame({ type: 'block', block: body }));
      for (let i = 0; i < 40 && calls < 1; i += 1) await delay(25);
      assert.equal(calls, 1);
      for (let i = 0; i < 40 && rec()?.verifying?.size; i += 1) await delay(25);
      // Old code could not key this body (JSON.stringify throws on a BigInt),
      // so the hold was never written and every resend verified again.
      sock.write(frame({ type: 'block', block: body }));
      // Sentinel: another body for the same header is verified once the held
      // resend before it has been handled.
      sock.write(frame({ type: 'block', block: { ...body, miner: 'sentinel' } }));
      for (let i = 0; i < 80 && calls < 2; i += 1) await delay(25);
      assert.equal(calls, 2, 'the credit-carrying body is held; only the sentinel verified');
    } finally {
      p2p.close();
    }
  });

  it('a header holds at most STAGE_HOLD_BODIES bodies', async () => {
    const wire = matchingBlock(0x65);
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
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 5000, stageHoldBaseMs: 60_000 });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const rec = () => [...p2p.peers.values()].find((row) => row.helloAt);
      // Bodies that differ outside the header commitment, each throwing in stage.
      const variants = STAGE_HOLD_BODIES + 3;
      for (let i = 0; i < variants; i += 1) {
        sock.write(frame({ type: 'block', block: { hash: wire.hash, height: 1, header: wire.header, miner: `variant-${i}` } }));
        for (let k = 0; k < 40 && calls < i + 1; k += 1) await delay(25);
        for (let k = 0; k < 40 && rec()?.verifying?.size; k += 1) await delay(25);
      }
      assert.equal(calls, variants, 'each distinct body was verified once');
      const held = p2p.stageHoldBodies(Buffer.from(wire.header, 'hex').toString('hex'));
      assert.equal(held, STAGE_HOLD_BODIES, `held bodies ${held}`);
    } finally {
      p2p.close();
    }
  });

  it('a hold key writes every value with its type, so a text-nanos copy cannot hold the packed body', async () => {
    const dest20 = Buffer.alloc(20, 0x2d);
    const packed = packHashCreditBytes([{ noteCommit: noteCommitOfDest20(dest20), dest20, nanos: 7n }]);
    const rows = unpackHashCreditBytes(packed);
    // What a peer can send unpacked: the decoded rows as JSON, Buffers as
    // {type, data} and the BigInt nanos as the text "7n". 5e43ec02 wrote a
    // BigInt as `${v}n` and a Buffer through its toJSON, so this copy had the
    // packed body's key.
    const forgedRows = JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
    assert.notEqual(stageBodyKey({ header: 'aa', hashCredits: rows }), stageBodyKey({ header: 'aa', hashCredits: forgedRows }));
    assert.notEqual(stageBodyKey({ x: 7n }), stageBodyKey({ x: 7 }));
    assert.notEqual(stageBodyKey({ x: 7n }), stageBodyKey({ x: '7' }));
    assert.notEqual(stageBodyKey({ x: Buffer.from('ab', 'hex') }), stageBodyKey({ x: 'ab' }));
    assert.equal(stageBodyKey({ x: Buffer.from('ab', 'hex') }), stageBodyKey({ x: new Uint8Array([0xab]) }));
    assert.equal(stageBodyKey({ header: 'aa', hash: 'claim', height: 9 }), stageBodyKey({ header: 'aa' }), 'the claim and the height hint are not the body');

    // End to end: the forged copy throws in staging and is held; the honest
    // packed body for the same header is still verified.
    const wire = matchingBlock(0x67);
    let calls = 0;
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
      ingest(fork) {
        calls += 1;
        return typeof fork?.[0]?.hashCredits?.[0]?.nanos === 'string' ? { ok: false, reason: 'apply_stage' } : { ok: true };
      },
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 5000, stageHoldBaseMs: 60_000 });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const rec = () => [...p2p.peers.values()].find((row) => row.helloAt);
      sock.write(frame({ type: 'block', block: { hash: wire.hash, height: 1, header: wire.header, hashCredits: forgedRows } }));
      for (let i = 0; i < 40 && calls < 1; i += 1) await delay(25);
      assert.equal(calls, 1);
      for (let i = 0; i < 40 && rec()?.verifying?.size; i += 1) await delay(25);
      sock.write(frame({ type: 'block', block: { hash: wire.hash, height: 1, header: wire.header, hashCreditPacked: packed.toString('hex') } }));
      for (let i = 0; i < 80 && calls < 2; i += 1) await delay(25);
      assert.equal(calls, 2, 'the honest packed body is verified, not held by the forged copy');
    } finally {
      p2p.close();
    }
  });

  it('an asked body we already hold ends the busy streak', async () => {
    const wire = matchingBlock(0x69);
    const stored = { hash: Buffer.from(wire.hash, 'hex'), header: Buffer.from(wire.header, 'hex'), height: 1 };
    const server = net.createServer((sock) => {
      sock.on('data', (buf) => { if (buf.toString().includes('"type":"hello"')) sock.write(helloLine()); });
      sock.on('error', () => {});
    });
    let remote = null;
    server.on('connection', (sock) => { remote = sock; });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const mesh = createP2p({
      store: { blocks: [stored], mempool: [], tip: () => stored, on() { return () => {}; }, ingest: () => ({ ok: true }) },
      port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 5000,
    });
    try {
      await mesh.connect('127.0.0.1', server.address().port);
      for (let i = 0; i < 40 && !remote; i += 1) await delay(25);
      await delay(40);
      const rec = [...mesh.peers.values()][0];
      assert.ok(rec?.helloAt);
      const line = (msg) => `${JSON.stringify({ magic: MAGIC_TESTNET, ...msg })}\n`;
      rec.pending = new Set([wire.hash]);
      remote.write(line({ type: 'serve_busy', what: 'getblock', hash: wire.hash }));
      for (let i = 0; i < 40 && rec.busyStreak !== 1; i += 1) await delay(25);
      assert.equal(rec.busyStreak, 1);
      // The peer then serves the body: ours already, byte for byte. Old code
      // returned before the reset, so an honest peer that lost the race kept
      // its streak and could be demoted for busy answers to separate asks.
      rec.pending = new Set([wire.hash]);
      remote.write(line({ type: 'block', block: { hash: wire.hash, height: 1, header: wire.header } }));
      for (let i = 0; i < 80 && rec.busyStreak !== 0; i += 1) await delay(25);
      assert.equal(rec.busyStreak, 0, 'the answer ends the streak');
    } finally {
      mesh.close();
      server.close();
    }
  });

  it('an orphan flood queues at most ORPHAN_PARENT_MAX parents, and a demoted peer\'s orphan asks never move to an honest peer', { timeout: 600_000 }, async () => {
    // Orphans under parents nobody has: each header's prev is its fill bytes.
    const count = ORPHAN_PARENT_MAX + 4;
    const orphans = Array.from({ length: count }, (_v, i) => matchingBlock(0x80 + i));
    const parents = orphans.map((o) => Buffer.from(o.header, 'hex').subarray(4, 36).toString('hex'));
    const tipBlock = { hash: Buffer.alloc(32, 0x01), header: Buffer.alloc(128, 0x01), height: 1 };
    const servers = [];
    const listen = () => new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        sock.on('data', (buf) => { if (buf.toString().includes('"type":"hello"')) sock.write(helloLine()); });
        sock.on('error', () => {});
      });
      const row = { server, remote: null };
      server.on('connection', (sock) => { row.remote = sock; });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { servers.push(row); resolve(row); });
    });
    const attacker = await listen();
    const honest = await listen();
    let ingests = 0;
    const mesh = createP2p({
      store: { blocks: [tipBlock], mempool: [], tip: () => tipBlock, on() { return () => {}; }, ingest: () => { ingests += 1; return { ok: false, reason: 'prev' }; } },
      port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 600_000,
    });
    const prevs = [];
    const orig = console.error;
    console.error = (...args) => {
      try {
        const ev = JSON.parse(String(args[0] || ''));
        if (ev.event === 'p2p_ingest' && ev.reason === 'prev') prevs.push(ev);
      } catch { /* not ours */ }
    };
    try {
      await mesh.connect('127.0.0.1', attacker.server.address().port);
      await mesh.connect('127.0.0.1', honest.server.address().port);
      for (let i = 0; i < 80 && !(attacker.remote && honest.remote); i += 1) await delay(25);
      await delay(60);
      const recOf = (row) => [...mesh.peers.entries()].find(([sock]) => sock.remotePort === row.server.address().port)?.[1];
      const a = recOf(attacker);
      const h = recOf(honest);
      assert.ok(a?.helloAt && h?.helloAt);
      const line = (msg) => `${JSON.stringify({ magic: MAGIC_TESTNET, ...msg })}\n`;
      // One orphan at a time, each after the last is answered prev.
      for (let n = 0; n < count; n += 1) {
        attacker.remote.write(line({ type: 'block', block: { hash: orphans[n].hash, height: 9, header: orphans[n].header } }));
        for (let i = 0; i < 400 && prevs.length < n + 1; i += 1) await delay(10);
      }
      assert.equal(prevs.length, count, 'every orphan answered prev');
      assert.equal(ingests, 0, 'an unknown parent never reaches store.ingest');
      assert.equal(a.orphanAsk.size, ORPHAN_PARENT_MAX, 'orphan parents per peer are capped');
      const queued = new Set([...(a.want || []), ...(a.pending || [])]);
      for (const parent of parents.slice(ORPHAN_PARENT_MAX)) assert.equal(queued.has(parent), false, 'an orphan past the cap is not queued');
      assert.ok((a.retryPrev || []).length <= ORPHAN_PARENT_MAX, `retryPrev ${(a.retryPrev || []).length}`);
      // A hash the honest mesh did advertise, waiting on the attacker.
      const real = 'ab'.repeat(32);
      a.want = [...(a.want || []), real];
      // The honest peer is ahead; the attacker answers not-found for three of
      // its own orphan parents and is demoted, which hands its asks off.
      h.height = 1000;
      h.syncEligible = true;
      for (let k = 0; k < 3; k += 1) {
        a.pending = new Set([parents[k]]);
        attacker.remote.write(line({ type: 'block_not_found', hash: parents[k] }));
        for (let i = 0; i < 80 && (Number(a.getblockMiss) || 0) < k + 1; i += 1) await delay(25);
      }
      assert.equal(Number(a.getblockMiss) || 0, 3);
      assert.equal(peerDemoted(a), true, 'the attacker is demoted');
      const moved = new Set([...(h.want || []), ...(h.pending || [])]);
      const own = new Set([...parents, ...orphans.map((o) => o.hash)]);
      for (const hash of moved) assert.equal(own.has(hash), false, `orphan ask ${hash} moved to the honest peer`);
      assert.equal(moved.has(real), true, 'an advertised hash still moves');
    } finally {
      console.error = orig;
      mesh.close();
      for (const row of servers) row.server.close();
    }
  });

  it('a late answer behind our own asks is not scored as an unsolicited claim burst', async () => {
    const asked = [];
    for (let n = 0; n < P2P_CLAIM_QUEUE; n += 1) asked.push(matchingBlock(0x80 + n));
    const late = matchingBlock(0x9f);
    const store = {
      blocks: [],
      tip: () => null,
      on() { return () => {}; },
      ingest() { return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 200)); },
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 5000 });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const rec = [...p2p.peers.values()].find((row) => row.helloAt);
      // P2P_CLAIM_QUEUE bodies we asked this peer for, then one body we did
      // not (a late answer after a handoff). Old code counted the asked
      // claims against the unsolicited cap and scored the late one.
      rec.pending = new Set(asked.map((row) => row.hash));
      for (const row of asked) sock.write(frame({ type: 'block', block: { hash: row.hash, height: 1, header: row.header } }));
      sock.write(frame({ type: 'block', block: { hash: late.hash, height: 1, header: late.header } }));
      await delay(400);
      assert.equal(Number(rec.expensiveFails) || 0, 0, 'no claim_queue score for an honest late answer');
    } finally {
      p2p.close();
    }
  });

  it('a lying claim for a hash we asked for releases that hash', async () => {
    const wire = matchingBlock(0x71);
    const store = { blocks: [], tip: () => null, on() { return () => {}; }, ingest() { return { ok: true }; } };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, helloMs: 5000, idleMs: 5000 });
    const bound = await p2p.listen();
    try {
      const sock = await connect(bound.port);
      sock.write(helloLine());
      await delay(40);
      const rec = [...p2p.peers.values()].find((row) => row.helloAt);
      const asked = 'aa'.repeat(32);
      rec.pending = new Set([asked]);
      // Our asked id, but a header whose ShearHash is something else.
      sock.write(frame({ type: 'block', block: { hash: asked, height: 1, header: wire.header } }));
      // Wait for the refusal itself (the score), not for pending to clear:
      // the getblock sweep can also clear it, before the hash is done.
      for (let i = 0; i < 200 && !(Number(rec.expensiveFails) > 0); i += 1) await delay(25);
      assert.ok(Number(rec.expensiveFails) > 0, 'scored');
      rec.pending.add(asked);
      // A second lying frame for an asked hash: the refusal releases it.
      const before = Number(rec.expensiveFails);
      sock.write(frame({ type: 'block', block: { hash: asked, height: 1, header: wire.header } }));
      for (let i = 0; i < 200 && Number(rec.expensiveFails) === before; i += 1) await delay(25);
      assert.ok(Number(rec.expensiveFails) > before, 'scored again (the claim is cached, no second hash)');
      assert.equal(rec.pending.has(asked), false, 'the asked hash is no longer pending on the liar');
    } finally {
      p2p.close();
    }
  });

  it('a repeatable stage throw does not ban honest peers', async () => {
    const wire = matchingBlock(0x33);
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

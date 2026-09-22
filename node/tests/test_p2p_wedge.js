import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GENESIS_BITS_PACKED, MAGIC_TESTNET } from '../../crypto/asert.js';
import { VERSION, decodeHeader, encodeHeader, setNonce } from '../../crypto/header.js';
import { meetsTarget, setHashBackend, shearHash } from '../../crypto/shear_hash.js';
import { hashHeaderOffLoop, p2pHashCap, p2pHashStats, resetP2pHashStats } from '../../crypto/hash_offloop.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

import { createStore } from '../src/store.js';
import { createRpc } from '../src/rpc.js';
import {
  P2P_VERIFY_CAP,
  GETBLOCK_SERVE_PER_TURN,
  catchupPeerBetter,
  createP2p,
  encodeWireBlock,
  decodeWireBlock,
  jsonWire,
  parseChainWork,
  peerTipAheadOf,
  p2pVerifyCap,
  p2pVerifyStats,
  resetP2pVerifyStats,
} from '../src/p2p.js';

function loadChain() {
  const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/p2p-wedge-blocks.json', import.meta.url), 'utf8'));
  return raw.blocks.map((b) => decodeWireBlock(b));
}

function cloneBlock(block) {
  return {
    header: Buffer.from(block.header),
    hash: Buffer.from(block.hash),
    height: block.height,
    txs: block.txs,
    samples: block.samples || [],
    shareBatch: block.shareBatch || [],
    miner: block.miner,
    poolDest: block.poolDest,
    aLeaves: block.aLeaves,
    bLeaves: block.bLeaves,
    rootA: block.rootA,
    rootB: block.rootB,
    weight: block.weight,
  };
}

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

async function readJsonLines(sock, want, ms = 3000) {
  const lines = [];
  let buf = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        try { lines.push(JSON.parse(raw)); } catch { continue; }
        if (lines.length >= want) {
          clearTimeout(t);
          sock.off('data', onData);
          resolve();
        }
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
  return lines;
}

function blockLine(block, extra = {}) {
  const wire = encodeWireBlock(block);
  return `${JSON.stringify({ type: 'block', magic: MAGIC_TESTNET, block: { ...wire, ...extra } })}\n`;
}

async function listenNode(store) {
  const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
  const rpc = createRpc({ store, p2p, port: 0, host: '127.0.0.1' });
  const bound = await p2p.listen();
  const rpcBound = await rpc.listen();
  return { p2p, rpc, port: bound.port, rpcPort: rpcBound.port };
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

function missHeader(header, salt) {
  const bits = decodeHeader(Buffer.from(header)).bits;
  for (let n = BigInt(salt); n < BigInt(salt) + 80n; n += 1n) {
    const h = setNonce(Buffer.from(header), n);
    if (!meetsTarget(shearHash(h), bits)) return h;
  }
  throw new Error('nonce still hit target');
}

describe('p2p wedge', { concurrency: 1, timeout: 180_000 }, () => {
  it('worker ShearHash matches the in-process digest', async () => {
    const header = Buffer.alloc(128, 3);
    const local = shearHash(header);
    const remote = await hashHeaderOffLoop(header);
    assert.equal(Buffer.from(remote).length, 32);
    assert.equal(Buffer.from(remote).equals(local), true);
    assert.equal(p2pHashCap(), 2);
    assert.equal(p2pVerifyCap(), 2);
    assert.equal(P2P_VERIFY_CAP, p2pHashCap());
    assert.equal(GETBLOCK_SERVE_PER_TURN, 1);
  });

  it('peerTipAhead ignores hash inequality and catch-up picks the best peer', () => {
    assert.equal(peerTipAheadOf({
      localHeight: 5,
      localWork: '0x20',
      peerHeight: 5,
      peerWork: '0x20',
    }), false);
    assert.equal(peerTipAheadOf({
      localHeight: 5,
      localWork: '0x20',
      peerHeight: 4,
      peerWork: '0x20',
    }), false);
    assert.equal(peerTipAheadOf({
      localHeight: 5,
      peerHeight: 5,
    }), false);
    assert.equal(peerTipAheadOf({
      localHeight: 5,
      localWork: '0x20',
      peerHeight: 8,
    }), true);
    assert.equal(peerTipAheadOf({
      localHeight: 5,
      localWork: '0x20',
      peerHeight: 5,
      peerWork: '0x21',
    }), true);
    assert.equal(catchupPeerBetter({ height: 10 }, { height: 4 }), true);
    assert.equal(catchupPeerBetter(
      { height: 5, work: '0x30' },
      { height: 9, work: '0x11' },
    ), true);
    assert.equal(parseChainWork('0x10'), 16n);
    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    assert.match(src, /offLoopPow:\s*true/);
    assert.doesNotMatch(src, /hashAhead/);
    const wire = encodeWireBlock({
      header: Buffer.alloc(128, 1),
      hash: Buffer.alloc(32, 2),
      height: 1,
      txs: [],
      shareBatch: [{ nonce: 1 }],
    });
    assert.equal(Object.hasOwn(wire, 'trustedPowHash'), false);
    assert.equal(JSON.stringify(wire).includes('trustedPowHash'), false);
    const decoded = decodeWireBlock(JSON.parse(jsonWire({ ...wire, trustedPowHash: 'aa' })));
    assert.equal(decoded.trustedPowHash, undefined);
  });

  it('two peers: only the best is asked for headers and blocks', async () => {
    const blocks = [{
      header: Buffer.alloc(128, 1),
      hash: Buffer.alloc(32, 1),
      height: 1,
    }];
    const store = {
      blocks,
      tip: () => blocks[0],
      chainWorkHex: () => '0x10',
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const tall = await connectPeer(bound.port);
    const short = await connectPeer(bound.port);
    try {
      tall.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 10, hash: 'b'.repeat(64),
      })}\n`);
      short.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 4, hash: 'c'.repeat(64),
      })}\n`);
      const tallMsg = await readJsonLines(tall, 1, 2000);
      const shortMsg = await readJsonLines(short, 1, 800);
      assert.ok(tallMsg.some((m) => m.type === 'getheaders'), 'taller peer should be asked for headers');
      assert.equal(shortMsg.some((m) => m.type === 'getheaders'), false);
      const missing = `${'d'.repeat(64)}`;
      tall.write(`${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [{ hash: missing, height: 2 }],
      })}\n`);
      short.write(`${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [{ hash: 'e'.repeat(64), height: 2 }],
      })}\n`);
      const tallBlocks = await readJsonLines(tall, 1, 2000);
      const shortBlocks = await readJsonLines(short, 1, 800);
      assert.ok(tallBlocks.some((m) => m.type === 'getblock'), 'best peer should be asked for the block');
      assert.equal(shortBlocks.some((m) => m.type === 'getblock'), false);
    } finally {
      tall.destroy();
      short.destroy();
      p2p.close();
    }
  });

  it('heavier work beats a taller peer, and a same-height hash change is not ahead', async () => {
    const blocks = [{
      header: Buffer.alloc(128, 2),
      hash: Buffer.alloc(32, 2),
      height: 5,
    }];
    const store = {
      blocks,
      tip: () => ({ ...blocks[0], height: 5 }),
      chainWorkHex: () => '0x10',
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const heavy = await connectPeer(bound.port);
    const tall = await connectPeer(bound.port);
    const same = await connectPeer(bound.port);
    try {
      heavy.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 5, hash: '1'.repeat(64), work: '0x30',
      })}\n`);
      tall.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 9, hash: '2'.repeat(64), work: '0x11',
      })}\n`);
      same.write(`${JSON.stringify({
        type: 'tip', magic: MAGIC_TESTNET, height: 5, hash: '3'.repeat(64), work: '0x10',
      })}\n`);
      const heavyMsg = await readJsonLines(heavy, 1, 2000);
      const tallMsg = await readJsonLines(tall, 1, 800);
      const sameMsg = await readJsonLines(same, 1, 800);
      assert.ok(heavyMsg.some((m) => m.type === 'getheaders'), 'heavier work should win catch-up');
      assert.equal(tallMsg.some((m) => m.type === 'getheaders'), false);
      assert.equal(sameMsg.some((m) => m.type === 'getheaders'), false);
    } finally {
      heavy.destroy();
      tall.destroy();
      same.destroy();
      p2p.close();
    }
  });

  it('caps overlapping verifies, still checks the queued block, and rejects bad pow', async () => {
    resetP2pVerifyStats();
    resetP2pHashStats();
    const [parentBlock] = loadChain();
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wedge-cap-b-'));
    const b = createStore(dirB);
    const t0 = 1_700_000_000_000;
    const copied = b.append(cloneBlock(parentBlock));
    assert.equal(copied.ok, true, copied.reason);
    const { p2p, rpc, port } = await listenNode(b);
    const events = [];
    const orig = console.error;
    console.error = (...args) => {
      try {
        const ev = JSON.parse(String(args[0] || ''));
        if (ev.event === 'p2p_ingest') events.push(ev);
      } catch { /* ignore */ }
      orig.apply(console, args);
    };
    const sock = await connectPeer(port);
    try {
      const lines = [];
      for (let i = 0; i < 3; i += 1) {
        let header = encodeHeader({
          version: VERSION,
          prevBlockHash: parentBlock.hash,
          merkleRoot: Buffer.alloc(32, i + 1),
          continuityRoot: Buffer.alloc(32, 9),
          timestamp: BigInt(t0 + 90_000),
          bits: GENESIS_BITS_PACKED,
          nonce: BigInt(i + 1),
          baseFee: 1n,
        });
        header = missHeader(header, i * 30 + 1);
        lines.push(blockLine({
          header,
          hash: Buffer.alloc(32, i + 3),
          height: 2,
          txs: [],
          shareBatch: [{ nonce: 1 + i }, { nonce: 50 + i }],
        }));
      }
      const joined = lines.join('');
      assert.equal(joined.includes('trustedPowHash'), false);
      sock.write(joined);
      const saw = await waitFor(() => events.filter((e) => e.reason === 'pow').length >= 3, 60_000);
      assert.equal(saw, true, `pow rejects ${events.length}: ${JSON.stringify(events.slice(0, 6))}`);
      const verify = p2pVerifyStats();
      const hash = p2pHashStats();
      assert.ok(verify.maxActive <= P2P_VERIFY_CAP);
      assert.ok(verify.maxActive >= 1);
      assert.ok(verify.maxQueued >= 1, `verify queue never formed ${JSON.stringify(verify)}`);
      assert.ok(verify.completed >= 3);
      assert.ok(hash.maxActive <= p2pHashCap());
      assert.ok(hash.maxQueued >= 1, `hash queue never formed ${JSON.stringify(hash)}`);
      assert.ok(hash.completed >= 9);
      assert.ok(hash.workerMaxActive >= 1);
      assert.equal(b.tip().height, 1);
    } finally {
      console.error = orig;
      sock.destroy();
      p2p.close();
      await rpc.close();
    }
  });

  it('serves /api/stats while share-batch blocks are still ingesting', async () => {
    const [first, second, third] = loadChain();
    assert.ok((second.shareBatch || []).length >= 1);
    assert.ok((third.shareBatch || []).length >= 1);

    async function once() {
      resetP2pVerifyStats();
      resetP2pHashStats();
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wedge-http-'));
      const store = createStore(dirB);
      const parent = store.append(cloneBlock(first));
      assert.equal(parent.ok, true, parent.reason);
      const { p2p, rpc, port, rpcPort } = await listenNode(store);
      const during = [];
      rpc.server.on('request', (req) => {
        const url = String(req.url || '');
        if (!url.includes('/api/stats')) return;
        during.push({
          verify: { ...p2pVerifyStats() },
          hash: { ...p2pHashStats() },
          height: Number(store.tip()?.height ?? 0),
        });
      });
      const sock = await connectPeer(port);
      try {
        const payload = blockLine(second) + blockLine(third);
        assert.equal(payload.includes('trustedPowHash'), false);
        const polls = [];
        const polling = (async () => {
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline && store.tip()?.height !== 3) {
            const res = await fetch(`http://127.0.0.1:${rpcPort}/api/stats`);
            const body = await res.json();
            polls.push({ status: res.status, height: body.height });
            assert.equal(res.status, 200);
            assert.equal(Number.isFinite(Number(body.height)), true);
            if (during.some((d) => d.verify.started >= 1 && d.verify.completed < 2)) break;
          }
        })();
        sock.write(payload);
        await polling;
        const caught = await waitFor(() => store.tip()?.height === 3, 60_000);
        assert.equal(caught, true, `tip ${store.tip()?.height}`);
        assert.equal(Buffer.from(store.tip().hash).equals(Buffer.from(third.hash)), true);
        assert.ok(polls.some((p) => p.status === 200 && Number.isFinite(Number(p.height))));
        assert.ok(
          during.some((d) => d.verify.started >= 1 && d.verify.completed < 2 && Number.isFinite(d.height)),
          `stats never landed during ingest ${JSON.stringify(during.slice(0, 8))}`,
        );
        assert.ok(p2pHashStats().completed >= 2);
      } finally {
        sock.destroy();
        p2p.close();
        await rpc.close();
      }
    }

    await once();
    await once();
  });

  it('rejects a bad share and ignores trustedPowHash on the wire', async () => {
    const [first, second] = loadChain();
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wedge-bad-b-'));
    const store = createStore(dirB);
    assert.equal(store.append(cloneBlock(first)).ok, true);
    const { p2p, rpc, port } = await listenNode(store);
    const events = [];
    const orig = console.error;
    console.error = (...args) => {
      try {
        const ev = JSON.parse(String(args[0] || ''));
        if (ev.event === 'p2p_ingest') events.push(ev);
      } catch { /* ignore */ }
      orig.apply(console, args);
    };
    const sock = await connectPeer(port);
    try {
      const badShare = cloneBlock(second);
      badShare.shareBatch = (badShare.shareBatch || []).map((row, i) => (
        i === 0 ? { ...row, nonce: String((BigInt(row.nonce || 0) + 9n)) } : row
      ));
      const badHeader = cloneBlock(second);
      badHeader.header = missHeader(second.header, 90);
      const goodHash = Buffer.from(second.hash).toString('hex');
      sock.write(blockLine(badShare));
      sock.write(blockLine(badHeader, { trustedPowHash: goodHash }));
      const sawShare = await waitFor(() => events.some((e) => e.reason === 'share_pow'), 60_000);
      const sawPow = await waitFor(() => events.some((e) => e.reason === 'pow'), 60_000);
      assert.equal(sawShare, true, JSON.stringify(events));
      assert.equal(sawPow, true, JSON.stringify(events));
      assert.equal(store.tip().height, 1);
    } finally {
      console.error = orig;
      sock.destroy();
      p2p.close();
      await rpc.close();
    }
  });

  it('a getblock burst does not encode every block before HTTP, and the rest still arrive', async () => {
    const blocks = [];
    for (let i = 1; i <= 8; i += 1) {
      const hash = Buffer.alloc(32);
      hash.writeUInt32BE(i, 28);
      const header = Buffer.alloc(128);
      header.writeUInt32BE(i, 0);
      blocks.push({ header, hash, height: i, txs: [], shareBatch: [] });
    }
    const store = {
      blocks,
      tip: () => blocks[blocks.length - 1],
      chainWorkHex: () => '0x1',
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const httpServer = http.createServer((req, res) => {
      const height = Number(store.tip()?.height ?? 0);
      const snap = {
        status: 200,
        height,
        sent: p2p.getblockServeSent(),
        backlog: p2p.getblockServeBacklog(),
      };
      samples.push(snap);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ height }));
    });
    const samples = [];
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const httpPort = httpServer.address().port;
    const sock = await connectPeer(bound.port);
    let buf = '';
    let got = 0;
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'block') got += 1;
        } catch { /* ignore */ }
      }
    });
    try {
      const burst = blocks.map((b) => `${JSON.stringify({
        type: 'getblock',
        magic: MAGIC_TESTNET,
        hash: Buffer.from(b.hash).toString('hex'),
      })}\n`).join('');
      sock.write(burst);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (got < blocks.length || samples.length < 1)) {
        const res = await fetch(`http://127.0.0.1:${httpPort}/api/stats`);
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(Number.isFinite(Number(body.height)), true);
        if (got >= blocks.length && samples.some((s) => s.sent < blocks.length)) break;
      }
      assert.ok(samples.some((s) => s.status === 200 && Number.isFinite(s.height)));
      assert.ok(
        samples.some((s) => s.sent < blocks.length),
        `every block was encoded before HTTP ${JSON.stringify(samples.slice(0, 6))}`,
      );
      const rest = await waitFor(() => got === blocks.length && p2p.getblockServeBacklog() === 0, 5000);
      assert.equal(rest, true, `delivered ${got} backlog ${p2p.getblockServeBacklog()}`);
      assert.ok(p2p.getblockServeMaxBacklog() >= 2);
    } finally {
      sock.destroy();
      p2p.close();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    }
  });
});

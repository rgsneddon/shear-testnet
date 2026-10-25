/**
 * A p2p block frame has a bounded cost.
 *
 * A `block` message may carry a `blocks` array. Before this fix its length was
 * bounded only by the 16 MiB frame, and replayFate, the claim prefilter,
 * freshClaimJobs and claimVerdict each walked our whole chain from the tip,
 * hexing every stored hash, once per block: O(N x H) on the main thread for
 * one frame, for one score point (Attack Cartographer lane, PR 130). A frame
 * now carries at most one getblock window, and stored blocks are found through
 * a hash index rebuilt once per tip.
 *
 * Cost is counted, not timed: store.blocks is wrapped in a Proxy that counts
 * every element read the node makes while it handles the frame.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { LOCATOR_MAX, createP2p, fingerprintHelloHash, getblockBatch } from '../src/p2p.js';
import { shearHash } from '../../crypto/shear_hash.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

const threads = Math.max(1, Math.min(4, os.cpus().length));
const T0 = 1_700_000_000_000;

after(() => closeMineWorkers());

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mineOne(store, dest) {
  const parent = store.tip();
  const now = parent ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000 : T0;
  const { tpl } = store.template({ miner: dest, bits: regtestBitsOverride(MAGIC_REGTEST), shareBits: 4, now });
  const found = await mineHeaderParallel(tpl.header, tpl.bits, 8_192, threads);
  assert.ok(found && found.block, 'need pow');
  const got = await Promise.resolve(store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }));
  assert.equal(got.ok, true, got.reason);
}

/** Count element reads of store.blocks while `fn` runs. */
function countReads(store) {
  const real = store.blocks;
  let reads = 0;
  const proxy = new Proxy(real, {
    get(target, key, recv) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, recv);
    },
  });
  return {
    install() { store.blocks = proxy; },
    restore() { store.blocks = real; },
    get reads() { return reads; },
    reset() { reads = 0; },
  };
}

function frame(msg) {
  return `${JSON.stringify({ ...msg, magic: MAGIC_REGTEST })}\n`;
}

async function helloPeer(port) {
  const sock = net.connect(port, '127.0.0.1');
  sock.on('data', () => {});
  sock.on('error', () => {});
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  sock.write(`${JSON.stringify({ type: 'hello', magic: MAGIC_REGTEST, fingerprint: fingerprintHelloHash(MAGIC_REGTEST) })}\n`);
  return sock;
}

function recFor(p2p, sock) {
  return [...p2p.peers.entries()].find(([live]) => live.remotePort === sock.localPort)?.[1];
}

/** An unknown block row: a 128-byte header and a claimed hash that is not stored. */
function unknownRow(fill) {
  return { header: Buffer.alloc(128, fill & 0xff).toString('hex'), hash: randomBytes(32).toString('hex'), height: 9 };
}

describe('a p2p block frame has a bounded cost', () => {
  it('refuses an oversized frame before any lookup, and costs a capped frame at most one index build', { timeout: 300_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-frame-cost-'));
    const store = createRegtestStore(dir, { bits: 4 });
    const dest = encodeDest(randomBytes(20));
    // A chain tall enough that O(N x H) and O(H + N) differ by an order of magnitude.
    for (let i = 0; i < 24; i += 1) await mineOne(store, dest);
    const H = store.blocks.length;
    assert.ok(H >= 24);
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_REGTEST, helloMs: 5000, idleMs: 60_000 });
    const bound = await p2p.listen();
    const counter = countReads(store);
    try {
      const sock = await helloPeer(bound.port);
      for (let i = 0; i < 40 && !recFor(p2p, sock)?.helloAt; i += 1) await delay(25);
      assert.ok(recFor(p2p, sock)?.helloAt, 'hello');

      // 100,000 unknown blocks in one frame. Old code: about 3 x H reads per
      // block, millions in all. Now: refused and scored with no read at all.
      counter.install();
      counter.reset();
      // Tiny rows, as the attack sends them, so 100,000 fit well inside the
      // 16 MiB frame limit and reach the handler.
      const huge = Array.from({ length: 100_000 }, () => ({ header: '00', hash: randomBytes(32).toString('hex') }));
      sock.write(frame({ type: 'block', blocks: huge }));
      for (let i = 0; i < 200 && !(Number(recFor(p2p, sock)?.expensiveFails) > 0); i += 1) await delay(25);
      assert.ok(Number(recFor(p2p, sock)?.expensiveFails) > 0, 'oversized frame is scored');
      assert.equal(counter.reads, 0, `oversized frame read store.blocks ${counter.reads} times`);

      // A frame of one getblock window of unknown blocks: one index build
      // (H reads) at most, then O(1) per lookup (a tip read to see a reorg),
      // a few lookups per block. Old code: about 3 x N x H.
      counter.reset();
      const window = Array.from({ length: getblockBatch() }, (_, i) => unknownRow(i + 7));
      const before = Number(recFor(p2p, sock)?.expensiveFails) || 0;
      sock.write(frame({ type: 'block', blocks: window }));
      for (let i = 0; i < 200 && (Number(recFor(p2p, sock)?.expensiveFails) || 0) === before; i += 1) await delay(25);
      const N = window.length;
      assert.ok(counter.reads <= H + 4 * N, `capped frame read store.blocks ${counter.reads} times for H=${H}, N=${N}`);
      assert.ok(counter.reads < 3 * N * H, 'well under the old per-block chain walks');
      // It is unsolicited and past the claim queue, so it is scored, not
      // dropped silently.
      assert.ok((Number(recFor(p2p, sock)?.expensiveFails) || 0) > before, 'unsolicited burst past the claim queue is scored');
      sock.destroy();
    } finally {
      counter.restore();
      await p2p.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a repeated orphan, a headers frame and a long locator cost O(1) per item, not a chain walk', { timeout: 300_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-frame-cost-orphan-'));
    const store = createRegtestStore(dir, { bits: 4 });
    const dest = encodeDest(randomBytes(20));
    for (let i = 0; i < 24; i += 1) await mineOne(store, dest);
    const H = store.blocks.length;
    // An orphan the attacker hashes once: a header under an unknown parent,
    // at bits 0 so its own ShearHash meets its target and passes the claim.
    const orphan = Buffer.alloc(128, 0x5c);
    randomBytes(32).copy(orphan, 4);
    orphan.writeUInt32LE(0, 108);
    const orphanHex = orphan.toString('hex');
    const orphanHash = shearHash(orphan).toString('hex');
    let orphanIngests = 0;
    const realIngest = store.ingest.bind(store);
    store.ingest = (fork, opts) => {
      if ((fork || []).some((b) => Buffer.from(b.header).toString('hex') === orphanHex)) orphanIngests += 1;
      return realIngest(fork, opts);
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_REGTEST, helloMs: 5000, idleMs: 60_000 });
    const bound = await p2p.listen();
    const counter = countReads(store);
    const events = [];
    const orig = console.error;
    console.error = (...args) => {
      try {
        const ev = JSON.parse(String(args[0] || ''));
        if (ev.event === 'p2p_ingest') events.push(ev);
      } catch { /* not ours */ }
      orig.apply(console, args);
    };
    try {
      const sock = await helloPeer(bound.port);
      for (let i = 0; i < 40 && !recFor(p2p, sock)?.helloAt; i += 1) await delay(25);
      counter.install();

      // The same orphan 20 times. Old code: two full-chain Sets and
      // store.ingest's own parent walk per copy, unscored. Now: one index
      // build, an O(1) parent check, and store.ingest is never called.
      counter.reset();
      const copies = 20;
      const orphanFrame = frame({ type: 'block', block: { header: orphanHex, hash: orphanHash, height: H + 5 } });
      // One copy at a time, each after the last is answered: a copy that
      // arrives while the same header is still verifying is dropped as a
      // duplicate, so this sends every copy down the orphan path. The first is
      // hashed once; the rest are served from the claim cache.
      for (let n = 1; n <= copies; n += 1) {
        sock.write(orphanFrame);
        for (let i = 0; i < 400 && events.filter((e) => e.reason === 'prev').length < n; i += 1) await delay(10);
      }
      // A few tip reads per copy (about 10), not a chain walk per copy (3 x H).
      assert.ok(counter.reads <= H + 16 * copies, `orphans read store.blocks ${counter.reads} times for H=${H}`);
      assert.ok(counter.reads < 3 * H * copies / 2, 'well under a chain walk per copy');
      assert.equal(orphanIngests, 0, 'store.ingest never walks the chain for an unknown parent');
      assert.equal(events.filter((e) => e.reason === 'prev').length, copies, 'each orphan copy is answered prev');

      // Empty headers frames. Old code: a full-chain Set per frame (seenHashes).
      counter.reset();
      for (let i = 0; i < copies; i += 1) sock.write(frame({ type: 'headers', headers: [] }));
      await delay(400);
      assert.ok(counter.reads <= H + 4 * copies, `headers frames read store.blocks ${counter.reads} times for H=${H}`);

      // A getheaders with 1000 unknown locator hashes. Old code: one chain
      // walk per locator hash, 1000 x H. Now: LOCATOR_MAX lookups, then the
      // page itself (at most H rows).
      counter.reset();
      const longLocator = Array.from({ length: 1000 }, () => randomBytes(32).toString('hex'));
      sock.write(frame({ type: 'getheaders', locator: longLocator, stopHash: '' }));
      await delay(400);
      assert.ok(counter.reads <= 3 * H + LOCATOR_MAX, `getheaders read store.blocks ${counter.reads} times for H=${H}`);
      assert.ok(counter.reads < 1000 * H / 4, 'well under one walk per locator hash');
      sock.destroy();
    } finally {
      console.error = orig;
      counter.restore();
      await p2p.close?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * IPC and HTTP follow use the same phase rule as p2p.
 * Decode and verify stay up. A mid-commit throw exits 70.
 * A hash-owed miss before any book write returns not-ok.
 * A reorg restore that throws exits 70. A partial mempool insert rolls back.
 * Restarting after an injected commit fault loads the same book the disk holds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newIdentity } from '../../crypto/address.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { buildTemplate, retarget, shouldAdopt } from '../src/chain.js';
import { startHttpFollow } from '../src/http_follow.js';
import { createP2p } from '../src/p2p.js';
import { attachPoolIpc } from '../src/p2p_ipc.js';
import { STORE_CORRUPT_EXIT, installNodeGuards } from '../src/process_guard.js';
import {
  OPEN_ROUND_CAP,
  OPEN_ROUND_PEER_RATE,
  OPEN_ROUND_PEER_TAGS,
  createStore,
} from '../src/store.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const self = fileURLToPath(import.meta.url);
const T0 = 1_700_000_000_000;
const STEP = 90_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function phaseError(phase) {
  const err = new Error(`phase ${phase}`);
  err.shearPhase = phase;
  return err;
}

function bookDigest(dir) {
  const hash = createHash('sha256');
  const files = [];
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    names.sort();
    for (const name of names) {
      if (name === 'before.json' || name.startsWith('datadir.lock')) continue;
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  for (const file of files) {
    hash.update(path.relative(dir, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

function writeBefore(dir) {
  fs.writeFileSync(path.join(dir, 'before.json'), `${JSON.stringify({ digest: bookDigest(dir) })}\n`);
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function sealNext(store, dest, tag) {
  const tip = store.tip();
  const now = tip ? headerTime(tip) + STEP : T0;
  const { tpl } = store.template({ miner: dest, now });
  return store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: easyPow(tag), skipSharePow: true });
}

function grow(store, dest, n, tagBase) {
  for (let i = 0; i < n; i += 1) {
    const got = sealNext(store, dest, tagBase + i + 1);
    if (!got.ok) return got;
  }
  return { ok: true, height: store.tip().height };
}

function heavierFork(store, dest, parentIndex, count, tagBase) {
  const prefix = store.blocks.slice(0, parentIndex + 1);
  const out = [];
  let prev = prefix[prefix.length - 1];
  let now = headerTime(prev) + STEP;
  for (let i = 0; i < count; i += 1) {
    const chain = prefix.concat(out);
    const bits = retarget(chain, now);
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height) + 1,
      miner: dest,
      now,
      bits,
      parentBlocks: chain,
    });
    const block = {
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      hash: easyPow(tagBase + i),
      height: Number(prev.height) + 1,
      weight: tpl.weight,
      bSpendIds: [],
    };
    out.push(block);
    prev = block;
    now += STEP;
  }
  return out;
}

function rootHex(store) {
  const root = store.jroot();
  if (!root) return '';
  return Buffer.from(root).toString('hex');
}

if (process.argv.includes('--feed')) {
  const phase = process.argv[process.argv.indexOf('--feed') + 1];
  const via = process.argv[process.argv.indexOf('--via') + 1];
  runFeed(via, phase);
}

if (process.argv.includes('--book')) {
  const mode = process.argv[process.argv.indexOf('--book') + 1];
  const dir = process.argv[process.argv.indexOf('--dir') + 1];
  runBook(mode, dir);
}

async function runFeed(via, phase) {
  installNodeGuards();
  const height = { n: 0 };
  if (via === 'ipc') {
    const store = {
      blocks: [],
      mempool: [],
      tip() { return { height: height.n }; },
      on() { return () => {}; },
      append() { throw phaseError(phase); },
      ingest() { throw phaseError(phase); },
    };
    const ipc = await attachPoolIpc({ store, port: 0 });
    const sock = net.connect(ipc.port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    sock.write(`${JSON.stringify({
      type: 'ipc_block',
      magic: MAGIC_TESTNET,
      powHash: 'ab'.repeat(32),
      block: { header: '00', height: 1, hash: 'cd'.repeat(32) },
    })}\n`);
    await delay(500);
    console.log(`BOOK ${height.n}`);
    console.log('alive');
    try { sock.destroy(); } catch { /* ignore */ }
    ipc.close();
    process.exit(0);
  }
  if (via === 'http') {
    process.env.SHEAR_HTTP_FOLLOW = '1';
    const store = {
      tip() { return { height: height.n }; },
      offerHeaders() { return { accepted: 1 }; },
      ingest() { throw phaseError(phase); },
    };
    const stats = { magic: MAGIC_TESTNET, height: 3 };
    const block = { ok: true, header: '00', height: 1, hash: 'cd'.repeat(32) };
    startHttpFollow({
      store,
      seeds: ['http://follow.invalid'],
      fetchImpl: async (url) => ({
        ok: true,
        text: async () => JSON.stringify(String(url).includes('/block') ? block : stats),
      }),
    });
    await delay(500);
    console.log(`BOOK ${height.n}`);
    console.log('alive');
    process.exit(0);
  }
  const store = {
    blocks: [],
    tip() {
      if (height.n) throw phaseError(phase);
      return null;
    },
    on() { return () => {}; },
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
  const sock = net.connect(bound.port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  sock.write(`${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET })}\n`);
  let rec = null;
  for (let i = 0; i < 25 && !rec?.helloAt; i += 1) {
    await delay(20);
    rec = [...p2p.peers.values()].find((row) => Number(row?.helloAt) > 0) || null;
  }
  if (!rec) throw new Error('no hello');
  rec.syncing = true;
  rec.pending = new Set(['ab'.repeat(32)]);
  rec.pendingAt = Date.now() - 10_000;
  height.n = 1;
  await delay(500);
  console.log('BOOK 0');
  console.log('alive');
  p2p.close();
  process.exit(0);
}

async function runBook(mode, dir) {
  installNodeGuards();
  if (mode === 'prod-ignore') {
    delete process.env.NODE_TEST_CONTEXT;
    const store = createStore(dir, { bookFault: 'hash-owed', pruneAfter: 1_000_000 });
    const got = sealNext(store, minerDest(), 3);
    console.log(JSON.stringify({
      ok: got?.ok === true,
      reason: got?.reason || '',
      height: store.tip()?.height || 0,
    }));
    process.exit(got?.ok === true ? 0 : 2);
  }
  if (mode === 'append') {
    const store = createStore(dir, { bookFault: 'append', pruneAfter: 1_000_000 });
    writeBefore(dir);
    sealNext(store, minerDest(), 1);
    console.log('alive');
    process.exit(0);
  }
  if (mode === 'publish-throw' || mode === 'publish-ignore') {
    if (mode === 'publish-ignore') delete process.env.NODE_TEST_CONTEXT;
    const store = createStore(dir, { pruneAfter: 1_000_000 });
    const dest = minerDest();
    const built = grow(store, dest, 2, 100);
    if (!built.ok) {
      console.log(JSON.stringify({ stage: 'grow', reason: built.reason || '' }));
      process.exit(2);
    }
    const fork = heavierFork(store, dest, 0, 3, 500);
    const candidate = store.blocks.slice(0, 1).concat(fork);
    if (!shouldAdopt(store.blocks, candidate)) {
      console.log(JSON.stringify({ stage: 'weight', height: store.tip().height }));
      process.exit(2);
    }
    const before = store.tip().height;
    const got = await Promise.resolve(store.ingest(fork, {
      trustBlockHash: true,
      throwAfterPublish: 'spent',
    }));
    console.log(JSON.stringify({
      ok: got?.ok === true,
      reason: got?.reason || '',
      height: store.tip()?.height || 0,
      before,
    }));
    console.log('alive');
    process.exit(0);
  }
  const store = createStore(dir, { bookFault: mode, pruneAfter: 1_000_000 });
  const dest = minerDest();
  const built = grow(store, dest, 2, 100);
  if (!built.ok) {
    console.log(JSON.stringify({ stage: 'grow', reason: built.reason || '' }));
    process.exit(2);
  }
  const fork = heavierFork(store, dest, 0, 3, 500);
  const candidate = store.blocks.slice(0, 1).concat(fork);
  if (!shouldAdopt(store.blocks, candidate)) {
    console.log(JSON.stringify({ stage: 'weight', height: store.tip().height }));
    process.exit(2);
  }
  writeBefore(dir);
  const got = await Promise.resolve(store.ingest(fork, { trustBlockHash: true }));
  console.log(JSON.stringify({
    ok: got?.ok === true,
    reason: got?.reason || '',
    height: store.tip()?.height || 0,
  }));
  console.log('alive');
  process.exit(0);
}

function runChild(args, timeout, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [self, ...args], { timeout, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => { stdout += buf; });
    child.stderr.on('data', (buf) => { stderr += buf; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function stayedUp(res) {
  assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /BOOK 0/);
  assert.match(res.stdout, /alive/);
  assert.doesNotMatch(res.stderr, /SHEAR exit/);
}

function openedBook(dir, height) {
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'before.json'), 'utf8'));
  assert.equal(bookDigest(dir), saved.digest);
  const first = createStore(dir);
  const second = createStore(dir);
  assert.equal(first.tip()?.height || 0, height);
  assert.equal(second.tip()?.height || 0, height);
  assert.equal(first.blocks.length, second.blocks.length);
  assert.equal(rootHex(first), rootHex(second));
}

if (!process.argv.includes('--feed') && !process.argv.includes('--book')) {
  describe('feed faults', () => {
    for (const via of ['ipc', 'http']) {
      for (const phase of ['decode', 'verify']) {
        it(`${via} ${phase} stays up and leaves the tip`, async () => {
          stayedUp(await runChild(['--feed', phase, '--via', via], 8_000));
        });
      }
      it(`${via} mid-commit exits 70`, async () => {
        const res = await runChild(['--feed', 'mid-commit', '--via', via], 8_000);
        assert.equal(res.code, STORE_CORRUPT_EXIT, `${res.stdout}\n${res.stderr}`);
        assert.doesNotMatch(res.stdout, /alive/);
      });
    }

    it('a pre-commit timer fault stays up', async () => {
      stayedUp(await runChild(['--feed', 'pre-commit', '--via', 'timer'], 8_000));
    });

    it('a mid-commit timer fault exits 70', async () => {
      const res = await runChild(['--feed', 'mid-commit', '--via', 'timer'], 8_000);
      assert.equal(res.code, STORE_CORRUPT_EXIT, `${res.stdout}\n${res.stderr}`);
      assert.doesNotMatch(res.stdout, /alive/);
    });
  });

  describe('book faults', () => {
    it('hash_owed before a write returns not-ok and leaves the tip', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hash-owed-'));
      const store = createStore(dir, { bookFault: 'hash-owed', pruneAfter: 1_000_000 });
      const before = bookDigest(dir);
      const got = sealNext(store, minerDest(), 7);
      assert.equal(got.ok, false);
      assert.equal(got.reason, 'hash_owed');
      assert.equal(store.tip(), null);
      assert.equal(store.blocks.length, 0);
      assert.equal(bookDigest(dir), before);
    });

    it('a staging throw is logged and does not write the book', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stage-fault-'));
      const store = createStore(dir, { bookFault: 'stage', pruneAfter: 1_000_000 });
      const notes = [];
      const orig = console.error;
      console.error = (...args) => {
        notes.push(args.map(String).join(' '));
        orig(...args);
      };
      try {
        const got = sealNext(store, minerDest(), 8);
        assert.equal(got.ok, false);
        assert.equal(got.reason, 'apply_stage');
        assert.equal(got.scorePeer, undefined);
        assert.equal(store.tip(), null);
        assert.equal(store.blocks.length, 0);
        assert.ok(notes.some((line) => line.includes('"event":"apply_stage"') && line.includes('stage_local')));
      } finally {
        console.error = orig;
      }
    });

    it('peer work rows are rate-limited and the open-round map is capped', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-open-round-'));
      const store = createStore(dir, { pruneAfter: 1_000_000 });
      const tag = (n) => `m${n.toString(16).padStart(8, '0')}`;
      const flood = [];
      for (let i = 0; i < 400; i += 1) flood.push({ tag: tag(i), count: 1 });
      const kept = store.noteOpenRound(flood, { source: 'peer', peer: '203.0.113.8' });
      assert.equal(kept.length, OPEN_ROUND_PEER_RATE);
      assert.equal(store.openRoundRows().length, OPEN_ROUND_PEER_RATE);
      const again = store.noteOpenRound(flood, { source: 'peer', peer: '203.0.113.8' });
      assert.equal(again.length, 0);
      assert.equal(store.openRoundRows().length, OPEN_ROUND_PEER_RATE);
      let next = OPEN_ROUND_PEER_RATE;
      let peerN = 1;
      while (store.openRoundRows().length < OPEN_ROUND_CAP) {
        const batch = [];
        for (let i = 0; i < OPEN_ROUND_PEER_RATE; i += 1) batch.push({ tag: tag(next + i), count: 1 });
        next += OPEN_ROUND_PEER_RATE;
        peerN += 1;
        store.noteOpenRound(batch, { source: 'peer', peer: `198.51.100.${peerN}` });
      }
      assert.equal(store.openRoundRows().length, OPEN_ROUND_CAP);
      const overflow = store.noteOpenRound(
        [{ tag: tag(900000), count: 3 }],
        { source: 'peer', peer: '203.0.113.9' },
      );
      assert.equal(overflow.length, 0);
      assert.equal(store.openRoundRows().length, OPEN_ROUND_CAP);
      assert.ok(OPEN_ROUND_PEER_TAGS < OPEN_ROUND_CAP);
      const local = store.noteOpenRound([{ tag: tag(900001), count: 9 }], { source: 'local' });
      assert.equal(local.length, 1);
      assert.equal(store.openRoundRows().length, OPEN_ROUND_CAP);
      assert.equal(store.openRoundRows().some((row) => row.tag === tag(900001) && row.count === 9), true);
    });

    it('a partial mempool insert rolls back', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-mempool-rollback-'));
      const store = createStore(dir, { bookFault: 'mempool' });
      const got = store.queueTx({ id: 'not-a-tx' });
      assert.equal(got.ok, false);
      assert.equal(got.reason, 'mempool_partial');
      assert.equal(got.scorePeer, true);
      assert.equal(store.mempool.length, 0);
      assert.equal(store.mempool.some((row) => row && row.id === 'partial'), false);
    });

    it('an append fault exits 70 and the restarted book matches disk', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-append-fault-'));
      const res = await runChild(['--book', 'append', '--dir', dir], 120_000);
      assert.equal(res.code, STORE_CORRUPT_EXIT, `${res.stdout}\n${res.stderr}`);
      assert.doesNotMatch(res.stdout, /alive/);
      openedBook(dir, 0);
    });

    it('a reorg fault restores and stays up with disk unchanged', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reorg-fault-'));
      const res = await runChild(['--book', 'reorg', '--dir', dir], 120_000);
      assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout, /"reason":"reorg_fault"/);
      assert.match(res.stdout, /"height":2/);
      assert.match(res.stdout, /alive/);
      openedBook(dir, 2);
    });

    it('throwAfterPublish fires under node:test and leaves the tip', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-publish-throw-'));
      const res = await runChild(['--book', 'publish-throw', '--dir', dir], 120_000);
      assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout, /alive/);
      const row = JSON.parse(res.stdout.trim().split('\n').find((line) => line.startsWith('{')));
      assert.equal(row.ok, false);
      assert.equal(row.reason, 'adopt_throw_spent');
      assert.equal(row.height, row.before);
    });

    it('a production store ignores throwAfterPublish', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-publish-ignore-'));
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const res = await runChild(['--book', 'publish-ignore', '--dir', dir], 120_000, env);
      assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout, /alive/);
      const row = JSON.parse(res.stdout.trim().split('\n').find((line) => line.startsWith('{')));
      assert.equal(row.ok, true);
      assert.equal(row.reason, '');
      assert.ok(row.height > row.before);
    });

    it('a production store ignores bookFault', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-prod-fault-'));
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const res = await runChild(['--book', 'prod-ignore', '--dir', dir], 120_000, env);
      assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
      const row = JSON.parse(res.stdout.trim().split('\n').filter(Boolean).pop());
      assert.equal(row.ok, true);
      assert.equal(row.height, 1);
      assert.notEqual(row.reason, 'hash_owed');
    });

    it('a reorg restore fault exits 70 and the restarted book matches disk', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-restore-fault-'));
      const res = await runChild(['--book', 'reorg-restore', '--dir', dir], 120_000);
      assert.equal(res.code, STORE_CORRUPT_EXIT, `${res.stdout}\n${res.stderr}`);
      assert.doesNotMatch(res.stdout, /alive/);
      openedBook(dir, 2);
    });
  });
}

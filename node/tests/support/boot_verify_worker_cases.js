/**
 * A chain.bin book of public v12 coinbases. The main thread must accept it
 * (coinbase outputs open, then verifyLoadedChain returns ok) before any
 * worker comparison. One reject case stays per option: height, magic,
 * oracle activation, and burial.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  TARGET_BLOCK_INTERVAL_MS,
} from '../../../crypto/asert.js';
import { applyBlockToFluxset, emptyFluxset } from '../../../crypto/admit.js';
import { readChainBin, writeChainBin } from '../../../crypto/chainbin.js';
import { destForLogin } from '../../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../../crypto/header.js';
import { merkleRoot } from '../../../crypto/merkle.js';
import { coinbaseVoutsBound } from '../../../crypto/note.js';
import { meetsTarget } from '../../../crypto/shear_hash.js';
import { potSubsidyAt } from '../../../crypto/pot_sched.js';
import { bundledEpochBps, GENESIS_BPS, issuanceBps } from '../../../crypto/reserve_oracle.js';
import { bookSealKeyFor } from '../../src/book_seal_key.js';
import {
  GENESIS_PREV,
  buildTemplate,
  chainLoadSeal,
  digestTx,
  verifyLoadedChain,
  verifyLoadedChainAsync,
} from '../../src/chain.js';
import { createStore } from '../../src/store.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let tagN = 1;
function tagHash() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(tagN, 4);
  tagN += 1;
  assert.equal(meetsTarget(h, GENESIS_BITS_PACKED), true);
  return h;
}

function restamp(block) {
  const decoded = decodeHeader(Buffer.from(block.header));
  const txs = block.txs || [];
  return {
    ...block,
    header: encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: merkleRoot(txs.map(digestTx)),
      continuityRoot: decoded.continuityRoot,
      timestamp: Number(decoded.timestamp),
      bits: decoded.bits,
      nonce: decoded.nonce,
      baseFee: decoded.baseFee,
    }),
  };
}

/** Coinbase-only templates at the testnet pot, tagged under genesis bits. */
function buildBook(n) {
  const dest = minerDest();
  const chain = [];
  let prevHash = GENESIS_PREV;
  let prevHeader = null;
  let flux = emptyFluxset();
  const t0 = 1_700_000_000_000;
  for (let h = 1; h <= n; h += 1) {
    const now = t0 + (h - 1) * TARGET_BLOCK_INTERVAL_MS;
    const genesisMs = h === 1 ? now : Number(decodeHeader(Buffer.from(chain[0].header)).timestamp);
    const subsidy = potSubsidyAt({ nowMs: now, genesisMs, magic: MAGIC_TESTNET });
    const tpl = buildTemplate({
      prev: prevHash,
      prevHeader,
      prevBlock: chain[chain.length - 1] || null,
      height: h,
      miner: dest,
      now,
      bits: GENESIS_BITS_PACKED,
      potShares: [{ address: dest, nanos: subsidy, kind: 'pot' }],
      parentFluxset: flux.pubs,
      parentBlocks: chain.length ? [chain[0]] : null,
    });
    const block = {
      header: tpl.header,
      txs: tpl.txs,
      shareBatch: tpl.shareBatch || [],
      hashCredits: tpl.hashCredits,
      miner: dest,
      height: h,
      hash: tagHash(),
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
      samples: tpl.samples,
    };
    chain.push(block);
    flux = applyBlockToFluxset(flux, block);
    prevHash = block.hash;
    prevHeader = tpl.header;
  }
  return chain;
}

/** Disk form createStore re-verifies: compact txs, then a fresh merkle. */
function loadBook(n) {
  const chain = buildBook(n);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-verify-'));
  const bin = path.join(dir, 'chain.bin');
  writeChainBin(bin, chain);
  const stamped = readChainBin(bin).map(restamp);
  writeChainBin(bin, stamped);
  return readChainBin(bin);
}

function assertCoinbaseOpens(blocks) {
  for (const block of blocks) {
    const tx = block.txs?.[0];
    assert.equal(tx?.coinbase, true, `height ${block.height} coinbase`);
    const bound = coinbaseVoutsBound(tx.vout, tx.excess);
    assert.equal(bound.ok, true, `height ${block.height} ${bound.reason || 'coinbase'}`);
  }
}

function view(got) {
  return {
    ok: got?.ok === true,
    reason: got?.reason || '',
    genesisMs: Number(got?.genesisMs) || 0,
    height: Number(got?.supply?.height) || 0,
  };
}

/** Buffers, bigints, and maps from the worker clone compare as data. */
function canon(value, seen = new WeakMap()) {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value == null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $hex: Buffer.from(value).toString('hex') };
  }
  if (seen.has(value)) return { $cycle: seen.get(value) };
  seen.set(value, seen.size + 1);
  if (value instanceof Map) {
    return { $map: [...value.entries()].map(([k, v]) => [canon(k, seen), canon(v, seen)]) };
  }
  if (value instanceof Set) return { $set: [...value].map((v) => canon(v, seen)) };
  if (Array.isArray(value)) return value.map((v) => canon(v, seen));
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (typeof value[key] === 'function') continue;
    const next = canon(value[key], seen);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

async function assertParity(blocks, opts) {
  const sync = verifyLoadedChain(structuredClone(blocks), opts);
  const asyncGot = await verifyLoadedChainAsync(structuredClone(blocks), opts);
  assert.equal(asyncGot.ok, sync.ok, `${sync.reason || 'ok'} vs ${asyncGot.reason || 'ok'}`);
  assert.equal(asyncGot.reason || '', sync.reason || '');
  if (sync.ok) assert.deepEqual(canon(asyncGot), canon(sync));
  return sync;
}

function withRateCommit(blocks) {
  const next = structuredClone(blocks);
  const bps = bundledEpochBps() ?? issuanceBps(GENESIS_BPS);
  next[1].txs[0].rateCommit = { epochIndex: 0, epochBps: bps, magic: MAGIC_TESTNET };
  next[1] = restamp(next[1]);
  return next;
}

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: 'Buffer', data: [...Buffer.from(value)] };
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = jsonSafe(value[key]);
    return out;
  }
  return value;
}

function writeJsonlBook(dir, blocks, magic) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = blocks.map((block) => {
    const plain = jsonSafe(block);
    plain.header = Buffer.from(block.header).toString('hex');
    plain.hash = Buffer.from(block.hash).toString('hex');
    return JSON.stringify(plain);
  });
  fs.writeFileSync(path.join(dir, 'chain.jsonl'), `${lines.join('\n')}\n`);
  const key = bookSealKeyFor(dir);
  fs.writeFileSync(path.join(dir, 'book.seal'), `${chainLoadSeal(blocks, key, magic)}\n`);
}

function tipHex(store) {
  return Buffer.from(store.tip().hash).toString('hex');
}

describe('boot-verify worker', () => {
  const nowMs = 1_800_000_000_000;
  const opts = { trustStoredHash: true, nowMs, magic: MAGIC_TESTNET };
  const book = loadBook(4);

  it('matches the synchronous load on a good book and on a bad height', async () => {
    assertCoinbaseOpens(book);
    const sync = verifyLoadedChain(structuredClone(book), opts);
    const asyncGot = await verifyLoadedChainAsync(structuredClone(book), opts);
    assert.equal(sync.ok, true, sync.reason || 'sync');
    assert.equal(sync.supply?.height, 4);
    assert.deepEqual(view(asyncGot), view(sync));

    const bad = structuredClone(book);
    bad[1].height = 9;
    const syncBad = verifyLoadedChain(structuredClone(bad), opts);
    const asyncBad = await verifyLoadedChainAsync(structuredClone(bad), opts);
    assert.equal(syncBad.ok, false);
    assert.equal(syncBad.reason, 'height');
    assert.deepEqual(view(asyncBad), view(syncBad));
  });

  it('lets an event-loop timer run during a multi-block verify', async () => {
    const heights = [];
    const lines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, enc, cb) => {
      lines.push(String(chunk));
      return orig(chunk, enc, cb);
    };
    let turns = 0;
    let stop = false;
    const spin = () => {
      if (stop) return;
      turns += 1;
      setImmediate(spin);
    };
    setImmediate(spin);
    try {
      const got = await verifyLoadedChainAsync(structuredClone(book), {
        magic: MAGIC_TESTNET,
        ...opts,
        onProgress: (p) => heights.push(p.height),
      });
      assert.equal(got.ok, true, got.reason || 'replay');
    } finally {
      stop = true;
      process.stderr.write = orig;
    }
    assert.ok(turns >= 2, `turns ${turns}`);
    assert.deepEqual(heights, [1, 2, 3, 4]);
    assert.ok(lines.some((l) => l.includes('book-replay 1/4')));
    assert.ok(lines.some((l) => l.includes('book-replay 4/4')));
    console.log(`boot-verify-timer turns ${turns}`);
  });

  it('keeps an empty book on the caller', async () => {
    const sync = verifyLoadedChain([], opts);
    const asyncGot = await verifyLoadedChainAsync([], opts);
    assert.deepEqual(asyncGot, sync);
    assert.equal(asyncGot.ok, true);
  });
});

describe('worker re-verify uses the main-thread option set', () => {
  const nowMs = 1_800_000_000_000;
  const opts = { trustStoredHash: true, nowMs, magic: MAGIC_TESTNET };
  const book = loadBook(4);
  const committed = withRateCommit(book);

  it('matches magic, including a network the default book rejects', async () => {
    assertCoinbaseOpens(committed);
    const testnet = await assertParity(committed, { ...opts, magic: MAGIC_TESTNET });
    assert.equal(testnet.ok, true, testnet.reason || 'testnet');
    const mainnet = await assertParity(committed, { ...opts, magic: MAGIC_MAINNET });
    assert.equal(mainnet.ok, false);
    assert.equal(mainnet.reason, 'att_magic');
  });

  it('matches oracle activation, including a height that rejects this commit', async () => {
    const later = await assertParity(committed, {
      ...opts,
      magic: MAGIC_TESTNET,
      oracleActivationHeight: 100_000,
    });
    assert.equal(later.ok, true, later.reason || 'later');
    const live = await assertParity(committed, {
      ...opts,
      magic: MAGIC_TESTNET,
      oracleActivationHeight: 0,
    });
    assert.equal(live.ok, false);
    assert.equal(live.reason, 'rate_commit');
  });

  it('matches burial tips copied per height', async () => {
    const pruned = structuredClone(book);
    pruned[0].samplesPruned = true;
    const buried = await assertParity(pruned, {
      ...opts,
      burialOf: (block) => (Number(block?.height) === 1 ? 5000 : null),
    });
    assert.equal(buried.ok, true, buried.reason || 'buried');
    const open = await assertParity(pruned, opts);
    assert.equal(open.ok, false);
    assert.equal(open.reason, 'samples_pruned');
  });

  it('verifies a copy of the book, so a later parent edit does not change the result', async () => {
    const source = structuredClone(book);
    const pending = verifyLoadedChainAsync(source, { ...opts, magic: MAGIC_TESTNET });
    source[1].height = 9;
    source[0].hash = Buffer.alloc(32, 9);
    const got = await pending;
    const sync = verifyLoadedChain(structuredClone(book), { ...opts, magic: MAGIC_TESTNET });
    assert.equal(sync.ok, true, sync.reason || 'sync');
    assert.equal(got.ok, true, got.reason || 'copy');
    assert.deepEqual(canon(got), canon(sync));
    assert.equal(source[1].height, 9);
  });

  it('does not keep a hand-picked list of load options', () => {
    const worker = fs.readFileSync(new URL('../../src/boot_verify_worker.js', import.meta.url), 'utf8');
    const chain = fs.readFileSync(new URL('../../src/chain.js', import.meta.url), 'utf8');
    const payloadStart = chain.indexOf('function bootVerifyPayload');
    const payloadEnd = chain.indexOf('function runBootVerifyWorker', payloadStart);
    const payload = chain.slice(payloadStart, payloadEnd);
    assert.match(worker, /verifyOpts/);
    assert.match(payload, /Object\.keys/);
    assert.doesNotMatch(worker, /trustStoredHash/);
    assert.doesNotMatch(worker, /oracleActivationHeight/);
    assert.doesNotMatch(worker, /genesisHash/);
    assert.doesNotMatch(payload, /oracleActivationHeight/);
    assert.doesNotMatch(payload, /if \('genesisHash'/);
  });
});

describe('restart re-verify matches the main thread', () => {
  const nowMs = 1_800_000_000_000;
  const loadOpts = { loadNowMs: nowMs };
  const committed = withRateCommit(buildBook(4));

  before(() => {
    process.env.SHEAR_SEAL_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-seal-'));
  });

  async function openPair(blocks, magic, extra = {}) {
    const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-sync-'));
    const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-async-'));
    writeJsonlBook(syncDir, blocks, magic);
    writeJsonlBook(asyncDir, blocks, magic);
    const opts = { ...loadOpts, magic, ...extra };
    let syncErr = null;
    let syncStore = null;
    try {
      syncStore = createStore(syncDir, opts);
    } catch (err) {
      syncErr = err;
    }
    let asyncErr = null;
    let asyncStore = null;
    try {
      asyncStore = await createStore(asyncDir, { ...opts, yieldForeign: true });
    } catch (err) {
      asyncErr = err;
    }
    return { syncErr, syncStore, asyncErr, asyncStore };
  }

  it('a foreign restart agrees on magic and on oracle activation', async () => {
    const good = await openPair(committed, MAGIC_TESTNET, { oracleActivationHeight: 100_000 });
    assert.equal(good.syncErr, null, good.syncErr?.message);
    assert.equal(good.asyncErr, null, good.asyncErr?.message);
    assert.equal(good.asyncStore.loadMode, 'full');
    assert.equal(good.syncStore.loadMode, 'full');
    assert.equal(tipHex(good.asyncStore), tipHex(good.syncStore));
    assert.equal(good.asyncStore.tip().height, 4);

    const otherNet = await openPair(committed, MAGIC_MAINNET);
    assert.match(otherNet.syncErr?.message || '', /att_magic/);
    assert.match(otherNet.asyncErr?.message || '', /att_magic/);

    const live = await openPair(committed, MAGIC_TESTNET, { oracleActivationHeight: 0 });
    assert.match(live.syncErr?.message || '', /rate_commit/);
    assert.match(live.asyncErr?.message || '', /rate_commit/);
  });
});

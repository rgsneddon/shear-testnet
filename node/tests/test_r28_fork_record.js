// R28: a fork block is stepped with the record its own verify derived.
// A peer may send a block with no record, or with one whose W is forged,
// and W feeds the next block's hash budget. Both fork walks (a suffix on a
// known parent, and a whole book) used the record the block came with; a
// record-less block fell back to the retired owed ledger and was refused
// as hash_owed. The blocks here are the honest store's own templates.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { decodeRecord, encodeRecord } from '../../crypto/blunote.js';
import { bookSealKeyFor, bookSealKeyPath } from '../src/book_seal_key.js';
import { readBookSnap } from '../src/book_snap.js';
import { createStore } from '../src/store.js';

const T0 = 1_700_000_000_000;
const STEP = 90_000;

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

function grow(store, dest, n, tagBase, stepMs = STEP) {
  for (let i = 0; i < n; i += 1) {
    const tip = store.tip();
    const now = tip ? headerTime(tip) + stepMs : T0;
    const { tpl } = store.template({ miner: dest, now });
    const got = store.append({
      header: tpl.header,
      txs: tpl.txs,
      shareBatch: tpl.shareBatch || [],
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }, { trustedPowHash: easyPow(tagBase + i + 1), skipSharePow: true });
    assert.equal(got.ok, true, got.reason);
  }
}

function copyBook(dir, prefix) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(dir, copy, { recursive: true });
  fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(copy));
  return copy;
}

/** A wire copy of a stored block, carrying `record` (undefined drops it). */
function wire(block, record) {
  const out = {
    header: block.header,
    txs: block.txs,
    shareBatch: block.shareBatch || [],
    aLeaves: block.aLeaves,
    bLeaves: block.bLeaves,
    rootA: block.rootA,
    rootB: block.rootB,
    hash: block.hash,
    height: block.height,
    weight: block.weight,
    bSpendIds: [],
  };
  if (record !== undefined) out.blunoteRecord = record;
  return out;
}

/**
 * The same record claiming one share of weight 2^40: what a lying peer would
 * send. An empty round's record counts 0 accepted units whatever its W, so
 * the lie names a share too.
 */
function forgedW(hex) {
  const rec = decodeRecord(Buffer.from(hex, 'hex'));
  assert.ok(rec);
  return encodeRecord({ ...rec, n: Math.max(1, rec.n), W: rec.W + (1n << 40n) }).toString('hex');
}

/**
 * Two books share a 4-block prefix. The honest one grows 2 more, the
 * other 3 more (heavier). Returns the honest store, its dir, and the
 * heavier book's blocks.
 */
function twoBooks(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-r28-fork-${tag}-`));
  const store = createStore(dir, { pruneAfter: 1_000_000 });
  const dest = minerDest();
  grow(store, dest, 4, 100);
  const otherDir = copyBook(dir, `shear-r28-fork-${tag}-b-`);
  grow(store, dest, 2, 200);
  const other = createStore(otherDir, { pruneAfter: 1_000_000 });
  grow(other, dest, 3, 300, STEP + 1_000);
  const heavier = other.blocks.map((b) => b);
  assert.equal(heavier.length, 7);
  for (const b of heavier) assert.ok(b.blunoteRecord, 'the heavier book derived each record');
  if (typeof other.close === 'function') other.close();
  return { dir, store, otherDir, heavier };
}

/** The accepted-W series the book persists (book.snap), one entry per height. */
function persistedSeries(store, dir) {
  store.flushBookSnap();
  const snap = readBookSnap(path.join(dir, 'book.snap'), bookSealKeyFor(dir), {});
  assert.ok(snap, 'the book wrote a snap');
  return snap.acceptedSeries.map((n) => BigInt(n));
}

describe('R28 fork walks step each block with its verified record', () => {
  it('a suffix fork with no records is adopted, and keeps the records its verify derived', async () => {
    const { dir, store, otherDir, heavier } = twoBooks('suffix');
    try {
      const fork = heavier.slice(4).map((b) => wire(b));
      assert.ok(fork.every((b) => b.blunoteRecord === undefined));
      const got = await Promise.resolve(store.ingest(fork, { trustBlockHash: true }));
      assert.equal(got.ok, true, got.reason);
      assert.equal(store.blocks.length, 7);
      for (let i = 4; i < 7; i += 1) {
        assert.equal(store.blocks[i].blunoteRecord, heavier[i].blunoteRecord, `record at ${i + 1}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('a suffix fork with a forged W is adopted with the derived record, not the forged one', async () => {
    const { dir, store, otherDir, heavier } = twoBooks('forged');
    try {
      const fork = heavier.slice(4).map((b) => wire(b, forgedW(b.blunoteRecord)));
      const got = await Promise.resolve(store.ingest(fork, { trustBlockHash: true }));
      assert.equal(got.ok, true, got.reason);
      for (let i = 4; i < 7; i += 1) {
        assert.equal(store.blocks[i].blunoteRecord, heavier[i].blunoteRecord, `record at ${i + 1}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('a whole-book fork with no records is adopted', async () => {
    const { dir, store, otherDir, heavier } = twoBooks('book');
    try {
      const fork = heavier.map((b) => wire(b));
      const got = await Promise.resolve(store.ingest(fork, { trustBlockHash: true }));
      assert.equal(got.ok, true, got.reason);
      assert.equal(store.blocks.length, 7);
      assert.equal(Buffer.from(store.tip().hash).toString('hex'), Buffer.from(heavier[6].hash).toString('hex'));
      for (let i = 0; i < 7; i += 1) {
        assert.equal(store.blocks[i].blunoteRecord, heavier[i].blunoteRecord, `record at ${i + 1}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  // The accepted W of each block feeds the next block's hash budget
  // (hashBudgetNanos over the series). A forged record must not enter it.
  for (const shape of ['suffix', 'book']) {
    it(`a ${shape} fork with a forged W leaves the derived W in the accepted series`, async () => {
      const { dir, store, otherDir, heavier } = twoBooks(`series-${shape}`);
      try {
        const want = heavier.map((b) => decodeRecord(Buffer.from(b.blunoteRecord, 'hex')).W);
        const blocks = shape === 'suffix' ? heavier.slice(4) : heavier;
        const fork = blocks.map((b) => wire(b, forgedW(b.blunoteRecord)));
        const got = await Promise.resolve(store.ingest(fork, { trustBlockHash: true }));
        assert.equal(got.ok, true, got.reason);
        const series = persistedSeries(store, dir);
        assert.equal(series.length, 7);
        assert.deepEqual(series, want, 'each entry is the W its own verify derived');
        for (const w of series) assert.ok(w < (1n << 40n), 'no forged W reached the series');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });
  }
});

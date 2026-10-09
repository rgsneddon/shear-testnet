/**
 * P0-da9-1: a commit failure after the spent-set is built does not publish it.
 * N-21: a reorg does not verify a coinbase range proof that this process already accepted.
 * N-22: a snap restart keeps the ancestor frontier, so a competing branch does not rebuild J.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { takeFrontierStats } from '../../crypto/admit.js';
import { createStore } from '../src/store.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { buildTemplate, retarget, shouldAdopt } from '../src/chain.js';
import { coinbaseRangeVerifies } from '../src/supply.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

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

function spentIds(store) {
  return [...store.spentB].sort();
}

function proofCount(blocks) {
  let n = 0;
  for (const block of blocks) {
    for (const o of block?.txs?.[0]?.vout || []) {
      const pr = o?.rangeProof;
      if (pr && pr.length) n += 1;
    }
  }
  return n;
}

function snapshot(store) {
  return {
    tip: Buffer.from(store.tip().hash).toString('hex'),
    length: store.blocks.length,
    spent: spentIds(store),
    reorgs: store.getreorgs().length,
    side: store.sideHashes(),
  };
}

describe('v12 adopt publishes the spent set only after supply agrees', () => {
  it('a forced commit failure leaves the store as it was, and a later adopt still lands', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-adopt-abort-'));
    const store = createStore(dir, { pruneAfter: 1_000_000 });
    const dest = minerDest();
    const built = grow(store, dest, 6, 1000);
    assert.equal(built.ok, true, built.reason);
    const before = snapshot(store);
    const parent = store.blocks.length - 2;
    const fork = heavierFork(store, dest, parent, 2, 50_000);
    const candidate = store.blocks.slice(0, parent + 1).concat(fork);
    assert.equal(shouldAdopt(store.blocks, candidate), true);
    const aborted = await Promise.resolve(store.ingest(fork, {
      trustBlockHash: true,
      failCommitAfterSpent: true,
    }));
    assert.equal(aborted.ok, false);
    assert.equal(aborted.reason, 'adopt_aborted');
    const after = snapshot(store);
    assert.deepEqual(after, before);
    const again = heavierFork(store, dest, parent, 2, 60_000);
    assert.equal(shouldAdopt(store.blocks, store.blocks.slice(0, parent + 1).concat(again)), true);
    const t0 = performance.now();
    const adopted = await Promise.resolve(store.ingest(again, { trustBlockHash: true }));
    const wall = performance.now() - t0;
    assert.equal(adopted.ok, true, adopted.reason);
    assert.equal(store.blocks.length, before.length + 1);
    assert.notEqual(Buffer.from(store.tip().hash).toString('hex'), before.tip);
    assert.ok(wall < 90_000, String(wall));
  });

  it('a one-block reorg does not verify coinbase range proofs that already passed', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-adopt-range-'));
    const store = createStore(dir, { pruneAfter: 1_000_000 });
    const dest = minerDest();
    const built = grow(store, dest, 8, 2000);
    assert.equal(built.ok, true, built.reason);
    const parent = store.blocks.length - 2;
    const fork = heavierFork(store, dest, parent, 2, 70_000);
    const fresh = proofCount(fork);
    assert.ok(fresh > 0);
    const before = coinbaseRangeVerifies();
    const t0 = performance.now();
    const adopted = await Promise.resolve(store.ingest(fork, { trustBlockHash: true }));
    const wall = performance.now() - t0;
    assert.equal(adopted.ok, true, adopted.reason);
    const delta = coinbaseRangeVerifies() - before;
    assert.equal(delta, fresh);
    assert.ok(wall < 90_000, String(wall));
  });

  it('a snap restart extends a competing branch from the stored frontier', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-adopt-snap-'));
    const store = createStore(dir, { pruneAfter: 1_000_000 });
    const dest = minerDest();
    const built = grow(store, dest, 6, 3000);
    assert.equal(built.ok, true, built.reason);
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-adopt-snap-copy-'));
    fs.cpSync(dir, copy, { recursive: true });
    fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(copy));
    const restarted = createStore(copy, { pruneAfter: 1_000_000 });
    assert.equal(restarted.loadMode, 'snap');
    assert.equal(restarted.blocks.length, store.blocks.length);
    takeFrontierStats();
    const parent = 2;
    const fork = heavierFork(restarted, dest, parent, 5, 80_000);
    const candidate = restarted.blocks.slice(0, parent + 1).concat(fork);
    assert.equal(shouldAdopt(restarted.blocks, candidate), true);
    const adopted = await Promise.resolve(restarted.ingest(fork, { trustBlockHash: true }));
    assert.equal(adopted.ok, true, adopted.reason);
    const stats = takeFrontierStats();
    assert.equal(stats.fullRoots, 0);
    assert.equal(restarted.tip().height, parent + 1 + fork.length);
  });
});

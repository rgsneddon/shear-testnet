/**
 * Append cost after pruning must not grow with chain length.
 * Tip, supply, and owed rows stay the same across a snap reload,
 * a lagged snap, and a full replay. A torn book.snap is ignored.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { encodeDest } from '../../crypto/address.js';
import { SAMPLE_PRUNE_CONFIRMATIONS } from '../../crypto/asert.js';
import { pruneSamples } from '../../crypto/chronoflux.js';
import { packEpochBlock, unpackEpochBlock } from '../../crypto/chainbin.js';
import { bookSealKeyFor, bookSealKeyPath } from '../src/book_seal_key.js';
import {
  decodeBookSnap,
  diskDigestFromSegments,
  frameDigest,
  segmentContentHash,
  stableDigest,
} from '../src/book_snap.js';
import { BOOK_SNAP_EVERY, createStore } from '../src/store.js';

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

function powAt(n) {
  const h = Buffer.alloc(32);
  h[4] = n & 0xff;
  h[5] = (n >> 8) & 0xff;
  h[6] = (n >> 16) & 0xff;
  return h;
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function stateKey(store) {
  const owed = store.owedView();
  const rows = owed.rows.map((r) => `${Buffer.from(r.noteCommit).toString('hex')}:${String(r.nanos)}`).join('|');
  return {
    height: store.tip().height,
    tip: Buffer.from(store.tip().hash).toString('hex'),
    supply: JSON.stringify(store.supplyState(), (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    series: owed.series.map((n) => String(n)).join(','),
    rows,
  };
}

function segmentDigest(dir) {
  const segDir = path.join(dir, 'segments');
  const names = fs.readdirSync(segDir).filter((n) => /^seg-\d+\.bin$/.test(n)).sort();
  return diskDigestFromSegments(names.map((name) => {
    const buf = fs.readFileSync(path.join(segDir, name));
    return { length: buf.length, contentHash: segmentContentHash(buf) };
  }));
}

async function appendOne(store, dest, now, n) {
  const { tpl } = store.template({ miner: dest, shareBits: 4, now });
  const t0 = performance.now();
  const got = await Promise.resolve(store.append({
    header: tpl.header,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: powAt(n), skipSharePow: true }));
  const ms = performance.now() - t0;
  assert.equal(got.ok, true, got.reason || 'append');
  return ms;
}

describe('append cost stays flat after pruning', { timeout: 900_000 }, () => {
  it('a buried block keeps the same stable digest and a different frame digest', async () => {
    const dir = tmp('shear-stable-');
    const dest = encodeDest(Buffer.alloc(20, 6));
    const store = createStore(dir);
    await appendOne(store, dest, Date.now() - 90_000, 1);
    const block = store.blocks[0];
    const buried = pruneSamples(block);
    assert.equal(stableDigest([buried]), stableDigest([block]));
    assert.notEqual(frameDigest([buried]), frameDigest([block]));
    const withLeaf = {
      ...block,
      aLeaves: [{ dest20: Buffer.alloc(20, 4), noteCommit: Buffer.alloc(32, 5), count: 1 }],
    };
    const leafBuried = pruneSamples(withLeaf);
    const leafDisk = unpackEpochBlock(packEpochBlock(leafBuried));
    assert.equal(stableDigest([leafDisk]), stableDigest([withLeaf]));
  });

  it('append time does not grow linearly, and restart matches replay', async () => {
    const dir = tmp('shear-amort-');
    const dest = encodeDest(Buffer.alloc(20, 8));
    const store = createStore(dir);
    const firstAt = SAMPLE_PRUNE_CONFIRMATIONS + 24;
    const secondAt = firstAt + 1600;
    const t0 = Date.now() - (secondAt + 30) * 90_000;
    const window = 8;
    let n = 0;
    async function growTo(height) {
      while ((store.tip()?.height || 0) < height) {
        n += 1;
        await appendOne(store, dest, t0 + (n - 1) * 90_000, n);
      }
    }
    async function sample() {
      const xs = [];
      for (let i = 0; i < window; i += 1) {
        n += 1;
        xs.push(await appendOne(store, dest, t0 + (n - 1) * 90_000, n));
      }
      return xs;
    }

    await growTo(firstAt - window);
    const low = await sample();
    const lowMed = median(low);
    const lowH = store.tip().height;
    assert.ok(lowH > SAMPLE_PRUNE_CONFIRMATIONS);

    const live = stateKey(store);
    const snap = decodeBookSnap(fs.readFileSync(path.join(dir, 'book.snap')), bookSealKeyFor(dir));
    assert.ok(snap);
    assert.ok(snap.height <= live.height);
    assert.ok(snap.height === live.height || snap.height % BOOK_SNAP_EVERY === 0);
    if (snap.height === live.height) {
      assert.equal(snap.diskDigest, segmentDigest(dir));
    }
    assert.equal(snap.frameDigest, frameDigest(store.blocks.slice(0, snap.height)));
    assert.equal(snap.stableDigest, stableDigest(store.blocks.slice(0, snap.height)));

    const reopened = createStore(dir);
    assert.notEqual(reopened.loadMode, 'full');
    assert.deepEqual(stateKey(reopened), live);

    const replayDir = tmp('shear-amort-replay-');
    fs.cpSync(dir, replayDir, { recursive: true });
    fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(replayDir));
    fs.rmSync(path.join(replayDir, 'book.snap'), { force: true });
    fs.rmSync(path.join(replayDir, 'vault.snap'), { force: true });
    const replayed = createStore(replayDir);
    assert.equal(replayed.loadMode, 'full');
    assert.deepEqual(stateKey(replayed), live);

    const tornDir = tmp('shear-amort-torn-');
    fs.cpSync(dir, tornDir, { recursive: true });
    fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(tornDir));
    const tornPath = path.join(tornDir, 'book.snap');
    const raw = fs.readFileSync(tornPath);
    raw[raw.length - 1] ^= 0xff;
    fs.writeFileSync(tornPath, raw);
    const torn = createStore(tornDir);
    assert.equal(torn.loadMode, 'full');
    assert.deepEqual(stateKey(torn), live);

    await growTo(secondAt - window);
    const high = await sample();
    const highMed = median(high);
    const highH = store.tip().height;
    console.log(JSON.stringify({
      lowH,
      lowMed: Math.round(lowMed * 10) / 10,
      low,
      highH,
      highMed: Math.round(highMed * 10) / 10,
      high,
    }));
    assert.ok(highH > lowH * 2, `second window ${highH} should be past twice ${lowH}`);
    assert.ok(highMed < lowMed * 1.8, `append grew with the chain low ${lowMed} high ${highMed}`);
    assert.ok(highMed < 750, `append still slow at ${highH}: ${highMed}ms`);

    const later = stateKey(store);
    const laterOpen = createStore(dir);
    assert.notEqual(laterOpen.loadMode, 'full');
    assert.deepEqual(stateKey(laterOpen), later);
  });
});

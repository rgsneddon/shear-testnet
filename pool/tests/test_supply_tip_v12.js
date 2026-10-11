/**
 * Tip-path supply. The cache key is the tip, not the vout list. A book with
 * no consensus tally stays pending, with null totals, until its own audit
 * finishes. A pool-found block broadcasts the next job before the stats paint,
 * and that paint does not re-verify historical range proofs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPool } from '../src/pool.js';
import { networkSupply, networkSupplySettled, supplyCacheKey } from '../src/wallet_api.js';
import { coinbaseRangeVerifies } from '../../node/src/supply.js';

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const HEIGHTS = [1, 8, 32];
const VOUTS = [1, 64, 256];

function fatBook(height, mark, vouts) {
  const blocks = [];
  for (let h = 1; h <= height; h += 1) {
    const hash = Buffer.alloc(32);
    hash[0] = mark;
    hash[1] = h;
    const vout = [];
    for (let i = 0; i < vouts; i += 1) {
      vout.push({ i, commit: Buffer.alloc(4) });
    }
    blocks.push({ height: h, hash, txs: [{ vout }] });
  }
  return {
    blocks,
    tip() { return blocks[blocks.length - 1]; },
  };
}

function rawBook(mark) {
  const hash = Buffer.alloc(32);
  hash[0] = mark;
  const block = { height: 8, hash, txs: [{ vout: [{ kind: 'pot' }] }] };
  return { blocks: [block], tip() { return block; }, reserveVault: {} };
}

function nextPow(tag) {
  const hash = Buffer.alloc(32);
  hash.writeUInt32LE(tag >>> 0, 4);
  return hash.toString('hex');
}

describe('v12 tip supply paint', { concurrency: 1 }, () => {
  it('keys supply on the tip and does not walk vouts', () => {
    for (const height of HEIGHTS) {
      for (const vouts of VOUTS) {
        const book = fatBook(height, 3, vouts);
        const key = supplyCacheKey(book);
        const victim = height === 1 ? 0 : Math.floor(height / 2);
        book.blocks[victim].txs[0].vout[0].i = vouts + height;
        book.blocks[victim].txs[0].vout.push({ i: -1, commit: Buffer.alloc(4) });
        assert.equal(supplyCacheKey(book), key, `vout walk h=${height} n=${vouts}`);
        book.blocks[book.blocks.length - 1].hash[31] ^= 0xff;
        assert.notEqual(supplyCacheKey(book), key, `same-height hash h=${height}`);
        const other = fatBook(height, 9, vouts);
        assert.notEqual(supplyCacheKey(other), key, `mark h=${height} n=${vouts}`);
      }
    }
    const bare = fatBook(32, 4, 64);
    delete bare.tip;
    const bareKey = supplyCacheKey(bare);
    bare.blocks[0].txs[0].vout[0].i = 7;
    assert.equal(supplyCacheKey(bare), bareKey);
    bare.blocks[bare.blocks.length - 1].hash[2] ^= 0x5a;
    assert.notEqual(supplyCacheKey(bare), bareKey);
  });

  it('stays pending per book until that book is audited', async () => {
    const left = rawBook(1);
    const right = rawBook(2);
    assert.equal(left.tip().height, right.tip().height);
    assert.notEqual(supplyCacheKey(left), supplyCacheKey(right));
    const before = coinbaseRangeVerifies();
    const pending = networkSupply(left);
    assert.equal(pending.supplyStatus, 'pending');
    assert.equal(pending.circulatingNanos, null);
    assert.notEqual(pending.circulatingNanos, 0);
    assert.equal(pending.potNanos, null);
    assert.equal(pending.schedulePotNanos, null);
    assert.equal(pending.differenceNanos, null);
    assert.equal(pending.asOfHeight, 8);
    assert.equal(coinbaseRangeVerifies(), before);
    const settled = await networkSupplySettled(left);
    assert.notEqual(settled.supplyStatus, 'pending');
    const again = networkSupply(left);
    assert.equal(again.supplyStatus, settled.supplyStatus);
    assert.equal(coinbaseRangeVerifies(), before);
    const keyBefore = supplyCacheKey(left);
    left.blocks[0].hash[31] ^= 0xff;
    assert.notEqual(supplyCacheKey(left), keyBefore);
    const moved = networkSupply(left);
    assert.equal(moved.supplyStatus, 'pending');
    assert.equal(moved.circulatingNanos, null);
    const other = networkSupply(right);
    assert.equal(other.supplyStatus, 'pending');
    assert.equal(other.circulatingNanos, null);
    assert.notEqual(other.supplyStatus, settled.supplyStatus);
    await networkSupplySettled(left);
    await networkSupplySettled(right);
  });

  it('broadcasts the next job before the stats paint', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-supply-tip-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
    try {
      await new Promise((resolve) => { setImmediate(resolve); });
      const opened = pool.issueJob(undefined, { force: true });
      assert.ok(opened && opened.jobId, 'opening job');
      const mark = pool.tipWork().length;
      const got = await pool.sealFoundShare({
        jobId: opened.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: nextPow(11),
      });
      assert.equal(got.ok, true, got.reason || 'seal');
      assert.ok(pool.store.supplyState(), 'seal publishes a supply tally');
      const verified = coinbaseRangeVerifies();
      const job = pool.issueJob(undefined, { force: true });
      assert.ok(job, 'job after the seal');
      pool.broadcastJob(job, { force: true });
      const mid = pool.tipWork().slice(mark);
      assert.equal(mid.includes('job'), true);
      assert.equal(mid.includes('stats'), false);
      await new Promise((resolve) => { setImmediate(resolve); });
      const done = pool.tipWork().slice(mark);
      const jobAt = done.indexOf('job');
      const statsAt = done.indexOf('stats');
      assert.ok(jobAt >= 0 && statsAt > jobAt, done.join(','));
      assert.equal(coinbaseRangeVerifies(), verified);
      const painted = pool.publicStats();
      assert.ok(painted.supplyStatus === 'verified' || painted.supplyStatus === 'mismatch');
      assert.equal(typeof painted.circulatingNanos, 'number');
      assert.equal(painted.asOfHeight, pool.store.tip().height);
      const linked = pool.store.supplyState;
      pool.store.supplyState = () => null;
      let drain = null;
      try {
        const held = pool.publicStats();
        drain = networkSupplySettled(pool.store);
        assert.equal(held.supplyStatus, 'pending');
        assert.equal(held.circulatingNanos, null);
        assert.equal(held.schedulePotNanos, null);
        assert.equal(held.hashOwedNanos, null);
        assert.equal(held.supplyDifferenceNanos, null);
        assert.notEqual(held.circulatingNanos, 0);
        assert.equal(held.asOfHeight, pool.store.tip().height);
        assert.equal(coinbaseRangeVerifies(), verified);
      } finally {
        pool.store.supplyState = linked;
      }
      if (drain) await drain;
    } finally {
      try { pool.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

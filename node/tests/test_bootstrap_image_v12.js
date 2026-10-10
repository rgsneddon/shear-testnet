import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SAMPLE_PRUNE_CONFIRMATIONS } from '../../crypto/asert.js';
import { shouldPruneSamples } from '../../crypto/chronoflux.js';
import { readChainBin } from '../../crypto/chainbin.js';
import { writeLatestBootstrap, latestPaths } from '../src/bootstrap.js';

const DEPTH = SAMPLE_PRUNE_CONFIRMATIONS;

function block(height, { pruned = false } = {}) {
  return {
    height,
    hash: Buffer.alloc(32, height % 255),
    header: Buffer.alloc(128, height & 255),
    rootA: Buffer.alloc(32, 1),
    rootB: Buffer.alloc(32, 2),
    samplesPruned: pruned,
    bLeavesPruned: pruned,
    samples: [],
    shareBatch: pruned ? [] : [{ nonce: String(height) }],
    bLeaves: [],
    aLeaves: [],
    txs: [{ coinbase: true, height, vout: [{ kind: 'pot', nanos: height }] }],
  };
}

function chain(n, pruneThrough) {
  const out = [];
  for (let h = 1; h <= n; h += 1) out.push(block(h, { pruned: h <= pruneThrough }));
  return out;
}

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-img-'));
}

describe('a bootstrap image is buried by its own tip', () => {
  it('any chain length keeps the confirming suffix, or publishes nothing', () => {
    const lengths = [1, 3, DEPTH, DEPTH + 1, DEPTH + 4];
    for (const n of lengths) {
      const src = dir();
      const buriedThrough = Math.max(0, n - DEPTH);
      const manifest = writeLatestBootstrap(src, chain(n, buriedThrough), { pruneDepth: 0 });
      if (n < DEPTH + 1) {
        assert.equal(manifest, null, `length ${n}`);
        assert.equal(fs.existsSync(latestPaths(src).bin), false);
        continue;
      }
      assert.ok(manifest, `length ${n}`);
      assert.equal(manifest.height, n);
      assert.equal(manifest.n, n);
      const got = readChainBin(latestPaths(src).bin);
      assert.equal(got.length, n);
      assert.equal(Number(got[0].height), 1);
      assert.equal(Number(got[n - 1].height), n);
      assert.equal(got[0].samplesPruned, true);
      assert.equal(got[n - 1].samplesPruned === true, false);
      for (const row of got) {
        if (!row.samplesPruned) continue;
        assert.equal(shouldPruneSamples(row.height, n, DEPTH), true, `height ${row.height} of ${n}`);
      }
    }
  });

  it('refuses a pruned block inside the window, a gap, a duplicate, and a short depth', () => {
    const n = DEPTH + 4;
    const src = dir();
    assert.equal(writeLatestBootstrap(src, chain(n, n)), null);
    const onBoundary = writeLatestBootstrap(src, chain(n, n - DEPTH));
    assert.ok(onBoundary);
    assert.equal(onBoundary.height, n);
    assert.equal(onBoundary.n, n);
    assert.equal(writeLatestBootstrap(src, chain(n, n - DEPTH + 1)), null);
    const gapped = chain(n, 1).filter((row) => row.height !== Math.floor(n / 2));
    assert.equal(writeLatestBootstrap(src, gapped), null);
    const dup = chain(n, 1);
    dup.push(block(1, { pruned: true }));
    assert.equal(writeLatestBootstrap(src, dup), null);
    for (const asked of [0, 1, 8, DEPTH - 1]) {
      assert.equal(
        writeLatestBootstrap(src, chain(DEPTH, DEPTH), { pruneDepth: asked }),
        null,
        `pruneDepth ${asked}`,
      );
    }
  });
});

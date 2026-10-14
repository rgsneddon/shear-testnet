import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encodeHeader } from '../../crypto/header.js';
import { CERTIFY_WINDOW, intervalCertify } from '../src/posture.js';
import {
  AVG_BLOCK_WINDOW,
  avgBlockIntervalMs,
  sealedIntervalSpan,
} from '../src/pool.js';

function headerAt(ms) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: BigInt(ms),
    bits: 16,
  });
}

function chain(n, stepMs, { prefixStep = null } = {}) {
  let reads = 0;
  const blocks = [];
  const window = AVG_BLOCK_WINDOW;
  const tailFrom = Math.max(0, n - window);
  for (let i = 0; i < n; i += 1) {
    const inTail = i >= tailFrom;
    const ms = inTail
      ? 1_000_000 + (i - tailFrom) * stepMs
      : (i + 1) * (prefixStep == null ? stepMs : prefixStep);
    const raw = headerAt(ms);
    blocks.push({
      get header() {
        reads += 1;
        return raw;
      },
    });
  }
  return {
    blocks,
    takeReads() {
      const nRead = reads;
      reads = 0;
      return nRead;
    },
  };
}

describe('sealed interval paint stays on the certify window', { concurrency: 1 }, () => {
  it('a longer chain does not decode more headers, and a prefix outside the window does not move the mean', () => {
    assert.equal(Number.isFinite(AVG_BLOCK_WINDOW), true);
    assert.equal(AVG_BLOCK_WINDOW, CERTIFY_WINDOW + 1);
    assert.ok(AVG_BLOCK_WINDOW > 20);

    const lengths = [0, 1, 2, 4, 20, CERTIFY_WINDOW, AVG_BLOCK_WINDOW, AVG_BLOCK_WINDOW + 1, AVG_BLOCK_WINDOW * 2];
    const steps = [1, 90_000, 190_000];
    const prefixes = [1, 50_000, 1_000_000];
    for (const n of lengths) {
      for (const step of steps) {
        for (const prefix of prefixes) {
          const built = chain(n, step, { prefixStep: prefix });
          const span = sealedIntervalSpan(built.blocks);
          const reads = built.takeReads();
          const expectReads = n < 2 ? 0 : Math.min(n, AVG_BLOCK_WINDOW);
          assert.equal(reads, expectReads, `reads n=${n} step=${step} prefix=${prefix}`);
          assert.equal(span.samples, Math.max(0, Math.min(n, AVG_BLOCK_WINDOW) - 1));
          if (n < 2) {
            assert.equal(span.meanMs, null);
            continue;
          }
          assert.equal(span.meanMs, step, `mean n=${n} step=${step} prefix=${prefix}`);
          if (n > AVG_BLOCK_WINDOW && prefix !== step) {
            assert.notEqual(span.meanMs, prefix);
          }
          assert.equal(avgBlockIntervalMs(built.blocks), span.meanMs);
        }
      }
    }

    const classic = [
      { header: headerAt(1_000_000) },
      { header: headerAt(1_090_000) },
      { header: headerAt(1_180_000) },
      { header: headerAt(1_370_000) },
    ];
    assert.equal(avgBlockIntervalMs(classic), (90_000 + 90_000 + 190_000) / 3);
    assert.equal(sealedIntervalSpan(classic).meanMs, (90_000 + 90_000 + 190_000) / 3);
    assert.equal(sealedIntervalSpan(classic).samples, 3);

    const short = sealedIntervalSpan(chain(CERTIFY_WINDOW, 90_000).blocks);
    assert.equal(short.samples, CERTIFY_WINDOW - 1);
    assert.equal(intervalCertify({
      sealedSamples: short.samples,
      sealedMeanMs: short.meanMs,
    }).soaking, true);

    const settled = sealedIntervalSpan(chain(AVG_BLOCK_WINDOW, 90_000).blocks);
    assert.equal(settled.samples, CERTIFY_WINDOW);
    const gate = intervalCertify({
      sealedSamples: settled.samples,
      ewmaMs: 90_000,
      sealedMeanMs: settled.meanMs,
    });
    assert.equal(gate.soaking, false);
    assert.equal(gate.certified90s, true);

    const longer = sealedIntervalSpan(chain(AVG_BLOCK_WINDOW * 2, 90_000, { prefixStep: 1 }).blocks);
    assert.equal(longer.samples, settled.samples);
    assert.equal(longer.meanMs, settled.meanMs);

    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.equal((src.match(/sealedIntervalSpan\(store\.blocks\)/g) || []).length, 1);
    assert.equal((src.match(/avgBlockIntervalMs\(store\.blocks\)/g) || []).length, 0);
    assert.match(src, /networkAvgBlockTimeMs: sealed\.meanMs/);
    assert.match(src, /sealedMeanMs: sealed\.meanMs/);
    assert.doesNotMatch(src, /networkAvgBlockTimeMs: avgMs/);
  });
});

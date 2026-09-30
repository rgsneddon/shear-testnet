import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { decodeHeader } from '../../crypto/header.js';
import { retarget } from '../src/chain.js';
import { encodeDest } from '../../crypto/address.js';
import {
  nextBits,
  medianIntervalMs,
  TARGET_BLOCK_INTERVAL_MS,
  GENESIS_BITS_PACKED,
} from '../../crypto/asert.js';

function dest(byte) {
  return encodeDest(Buffer.alloc(20, byte));
}

function powHex(n) {
  return `${'00'.repeat(31)}${n.toString(16).padStart(2, '0')}`;
}

describe('template and pool job bits', () => {
  it('follows the median of 11 sealed gaps, not a caller target or one gap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-job-bits-'));
    const store = createStore(dir);
    const miner = dest(4);
    const t0 = 1_700_000_000_000;
    const oneGap = nextBits(GENESIS_BITS_PACKED, 2_000);
    assert.ok(oneGap > GENESIS_BITS_PACKED);

    const genesis = store.template({ miner, bits: oneGap, shareBits: 8, now: t0 });
    assert.equal(genesis.job.blockBits, GENESIS_BITS_PACKED);
    assert.equal(genesis.job.bits, GENESIS_BITS_PACKED);
    assert.equal(decodeHeader(Buffer.from(genesis.tpl.header)).bits, GENESIS_BITS_PACKED);
    assert.notEqual(genesis.job.blockBits, oneGap);
    const g = store.submitHeader({
      jobId: genesis.job.jobId, nonce: 0n, miner, powHash: powHex(0),
    }, { trusted: true });
    assert.equal(g.ok, true, g.reason);

    const child = store.template({ miner, bits: oneGap, shareBits: 8, now: t0 + 2_000 });
    const median = medianIntervalMs([2_000]);
    const want = retarget(store.blocks);
    assert.equal(median, TARGET_BLOCK_INTERVAL_MS);
    assert.equal(want, nextBits(GENESIS_BITS_PACKED, median));
    assert.equal(want, GENESIS_BITS_PACKED);
    assert.equal(child.job.blockBits, want);
    assert.equal(child.job.bits, want);
    assert.equal(decodeHeader(Buffer.from(child.tpl.header)).bits, want);
    assert.notEqual(child.job.blockBits, oneGap);
    const c = store.submitHeader({
      jobId: child.job.jobId, nonce: 0n, miner, powHash: powHex(1),
    }, { trusted: true });
    assert.equal(c.ok, true, c.reason);
    assert.equal(decodeHeader(Buffer.from(store.tip().header)).bits, want);

    let now = t0 + 2_000;
    for (let i = 0; i < 6; i += 1) {
      now += 2_000;
      const step = store.template({ miner, bits: 1, shareBits: 8, now });
      const got = store.submitHeader({
        jobId: step.job.jobId, nonce: 0n, miner, powHash: powHex(i + 2),
      }, { trusted: true });
      assert.equal(got.ok, true, `${got.reason || ''} at gap ${i}`);
    }
    const after = store.template({ miner, bits: 1, shareBits: 8, now: now + 2_000 });
    const moved = retarget(store.blocks);
    assert.equal(after.job.blockBits, moved);
    assert.equal(after.job.bits, moved);
    assert.equal(decodeHeader(Buffer.from(after.tpl.header)).bits, moved);
    assert.ok(moved > GENESIS_BITS_PACKED);
    assert.notEqual(moved, 1);
    console.log(`JOB_BITS genesis=${GENESIS_BITS_PACKED} oneFastCaller=${oneGap} oneGapJob=${child.job.blockBits} sixShortJob=${after.job.blockBits}`);
  });
});

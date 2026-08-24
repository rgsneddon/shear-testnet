import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextBits,
  TARGET_BLOCK_INTERVAL_MS,
  GENESIS_BITS,
  LIVE_MIN_BITS,
  MAX_BITS,
  clampBits,
} from './asert.js';

describe('ASERT 90s block retarget', () => {
  it('holds bits when the interval is 90 seconds', () => {
    assert.equal(TARGET_BLOCK_INTERVAL_MS, 90_000);
    assert.equal(nextBits(GENESIS_BITS, TARGET_BLOCK_INTERVAL_MS), GENESIS_BITS);
    assert.equal(nextBits(21, 90_000), 21);
  });

  it('raises bits when blocks arrive faster than 90s', () => {
    const next = nextBits(21, 45_000);
    assert.ok(next > 21, `expected harden from 21, got ${next}`);
  });

  it('lowers bits when blocks arrive slower than 90s', () => {
    const next = nextBits(21, 180_000);
    assert.ok(next < 21, `expected ease from 21, got ${next}`);
    assert.ok(next >= LIVE_MIN_BITS);
  });

  it('is not stuck at 32 bits / 4.29e9 work', () => {
    assert.equal(MAX_BITS, 256);
    assert.equal(clampBits(32), 32);
    assert.equal(clampBits(40), 40);
    assert.equal(clampBits(256), 256);
    assert.equal(clampBits(300), 256);
    assert.equal(nextBits(32, 250), 40);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextBits,
  TARGET_BLOCK_INTERVAL_MS,
  GENESIS_BITS,
  LIVE_MIN_BITS,
  MAX_BITS,
  clampBits,
  SHE_DECIMALS,
  SHE_PUBLIC_DIGITS,
  NANOS_PER_SHE,
  HASH_BONUS_NANOS,
  formatShe,
  HASH_BONUS_VOTE_DELTA_NANOS,
  HASH_BONUS_VOTE_DELTA,
  BLOCK_SUBSIDY_NANOS,
  JOIN_PROGRAM,
  JOIN_KIND_GENESIS,
  extraMintAllowed,
  RESERVE_PROGRAM,
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

describe('SHEAR 11-decimal protocol unit', () => {
  it('pays 1 SHE per block and 0.00000000001 SHE per hash; public frame is eight digits', () => {
    assert.equal(SHE_DECIMALS, 11);
    assert.equal(SHE_PUBLIC_DIGITS, 8);
    assert.equal(NANOS_PER_SHE, 100_000_000_000);
    assert.equal(BLOCK_SUBSIDY_NANOS, NANOS_PER_SHE);
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.equal(HASH_BONUS_NANOS / NANOS_PER_SHE, 1e-11);
    assert.equal(HASH_BONUS_VOTE_DELTA_NANOS, 1);
    assert.equal(HASH_BONUS_VOTE_DELTA, 1 / NANOS_PER_SHE);
    assert.equal(HASH_BONUS_VOTE_DELTA, 1e-11);
    assert.equal(formatShe(1), '1');
    assert.equal(formatShe(1e-11), '0.00000000');
    assert.equal(formatShe(1e-8), '0.00000001');
  });
});

describe('Join extra mint is genesis-only', () => {
  it('allows join-genesis and refuses a plain Join mint', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM), false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS }), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS, funded: true }), false);
  });
});

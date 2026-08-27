import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  nextBits,
  bitsForBlock,
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
  MAGIC_TESTNET,
  MAGIC_TESTNET_V1,
  HASH_TX_LIVE,
  SPENDABLE_CONFIRMATIONS,
  MIN_CONFIRMS_POLICY,
  PRODUCT_VERSION,
  MINER_VERSION,
  consensusFingerprint,
  consensusLaw,
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
    assert.equal(nextBits(32, 250), 34);
    assert.ok(nextBits(36, 250) - 36 <= 2);
    assert.equal(nextBits(36, 1), 38);
    assert.equal(nextBits(36, 90_000), 36);
    const parentTs = 1_700_000_000_000;
    const eased = bitsForBlock(36, parentTs, parentTs + 12 * 3600_000);
    assert.ok(eased < 36, `12h header delta must ease 36-bit freeze, got ${eased}`);
    assert.equal(eased, bitsForBlock(36, parentTs, parentTs + 12 * 3600_000));
  });
});

describe('SHEAR 11-decimal protocol unit', () => {
  it('pays 1 SHE per block and 0.00000000001 SHE per hash; public frame is eight digits', () => {
    assert.equal(SHE_DECIMALS, 11);
    assert.equal(SHE_PUBLIC_DIGITS, 8);
    assert.equal(NANOS_PER_SHE, 100_000_000_000);
    assert.equal(BLOCK_SUBSIDY_NANOS, 100_000_000_000);
    assert.equal(BLOCK_SUBSIDY_NANOS / NANOS_PER_SHE, 1);
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.equal(HASH_BONUS_NANOS / NANOS_PER_SHE, 1e-11);
    assert.equal(HASH_BONUS_VOTE_DELTA_NANOS, 1);
    assert.equal(HASH_BONUS_VOTE_DELTA, 1 / NANOS_PER_SHE);
    assert.equal(HASH_BONUS_VOTE_DELTA, 1e-11);
    assert.equal(formatShe(1), '1');
    assert.equal(formatShe(1e-11), '0.00000000');
    assert.equal(formatShe(1e-8), '0.00000001');
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v1');
    assert.equal(MAGIC_TESTNET_V1, 'shear-testnet-v1');
  });
});

describe('hash-tx consensus law', () => {
  it('bakes HASH_TX_LIVE=1 into the fingerprint; env cannot revert it', () => {
    process.env.HASH_TX_LIVE = '0';
    assert.equal(HASH_TX_LIVE, 1);
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
    assert.equal(MIN_CONFIRMS_POLICY, 12);
    const fp = consensusFingerprint();
    assert.equal(fp.includes(':12:'), false);
    assert.match(fp, /^shear-book-law-1:shear-v1:/);
    assert.match(fp, /:90000:/);
    assert.match(fp, /:ssa:/);
    assert.match(fp, /:100000000000:/);
    assert.match(fp, /:6:1$/);
    assert.equal(fp.endsWith(':1'), true);
    const law = consensusLaw();
    assert.equal(PRODUCT_VERSION, '0.1');
    assert.equal(MINER_VERSION, '0.5');
    assert.equal(PRODUCT_VERSION.split('.').length, 2);
    assert.equal(MINER_VERSION.split('.').length, 2);
    assert.equal(/^\d+\.\d+$/.test(PRODUCT_VERSION), true);
    assert.equal(/^\d+\.\d+$/.test(MINER_VERSION), true);
    assert.equal(/^\d+\.\d+\.\d+$/.test(PRODUCT_VERSION), false);
    assert.equal(/^\d+\.\d+\.\d+$/.test(MINER_VERSION), false);
    assert.equal(/^\d+\.\d+$/.test('0.10'), true);
    assert.equal(/^\d+\.\d+$/.test('0.1.0'), false);
    assert.equal(law.productVersion, '0.1');
    assert.equal(law.minerVersion, '0.5');
    assert.equal(law.hashTxLive, 1);
    assert.equal(law.hashTxCollate, 1);
    assert.equal(law.hashTxConfirmOnBlock, 1);
    assert.equal(law.minerMintOnly, 1);
    assert.equal(law.bookLawFingerprint, fp);
    assert.equal(Number(process.env.HASH_TX_LIVE), 0);
    assert.notEqual(law.hashTxLive, Number(process.env.HASH_TX_LIVE));
    const src = fs.readFileSync(new URL('./asert.js', import.meta.url), 'utf8');
    assert.equal(/process\.env\.HASH_TX_LIVE/.test(src), false);
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

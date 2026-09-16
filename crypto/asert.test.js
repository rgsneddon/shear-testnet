import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  nextBits,
  bitsForBlock,
  templateStampMs,
  TARGET_BLOCK_INTERVAL_MS,
  GENESIS_BITS,
  LIVE_MIN_BITS,
  MAX_BITS,
  clampBits,
  packBits,
  unpackBits,
  ASERT_HALFLIFE_MS,
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
  JOIN_WINDOW_DAYS,
  JOIN_WINDOW_MS,
  extraMintAllowed,
  wrapMintForbidden,
  RESERVE_PROGRAM,
  MAGIC_TESTNET,
  MAGIC_TESTNET_V1,
  MAGIC_TESTNET_V2,
  MAGIC_TESTNET_V3,
  MAGIC_TESTNET_V4,
  HASH_FN,
  HASH_TX_LIVE,
  SPENDABLE_CONFIRMATIONS,
  MIN_CONFIRMS_POLICY,
  PRODUCT_VERSION,
  MINER_VERSION,
  SHEARK_MINER_VERSION,
  consensusFingerprint,
  consensusLaw,
  mainnetFingerprint,
  GENESIS_MAINNET,
  mainnetMayEmit,
} from './asert.js';

describe('ASERT 90s block retarget', () => {
  it('holds packed bits when the interval is 90 seconds', () => {
    assert.equal(TARGET_BLOCK_INTERVAL_MS, 90_000);
    assert.equal(nextBits(GENESIS_BITS, TARGET_BLOCK_INTERVAL_MS), packBits(GENESIS_BITS));
    assert.equal(nextBits(packBits(21), 90_000), packBits(21));
  });

  it('raises packed bits when blocks arrive faster than 90s, without a full integer jump', () => {
    const next = unpackBits(nextBits(packBits(21), 45_000));
    assert.ok(next > 21, `expected harden from 21, got ${next}`);
    const from16 = unpackBits(nextBits(packBits(16), 59_000));
    assert.ok(from16 > 16, `59s must climb off 16, got ${from16}`);
    assert.ok(from16 < 17, `59s must not double work, got ${from16}`);
    assert.equal(nextBits(packBits(16), 90_000), packBits(16));
    const stuck = unpackBits(nextBits(packBits(16), 82_000));
    assert.ok(stuck > 16, `82s must not sit in a dead band, got ${stuck}`);
  });

  it('lowers packed bits when blocks arrive slower than 90s', () => {
    const next = unpackBits(nextBits(packBits(21), 180_000));
    assert.ok(next < 21, `expected ease from 21, got ${next}`);
    assert.ok(next >= LIVE_MIN_BITS);
  });

  it('constant hashrate that would average 82s on integer-16 lands near 90s', () => {
    const hashesPerMs = (2 ** 16) / 82_000;
    let packed = packBits(16);
    const last = [];
    for (let i = 0; i < 2000; i += 1) {
      const fp = unpackBits(packed);
      const interval = (2 ** fp) / hashesPerMs;
      packed = nextBits(packed, interval);
      if (i >= 1800) last.push(interval);
    }
    const mean = last.reduce((a, b) => a + b, 0) / last.length;
    assert.ok(mean > 85_000 && mean < 95_000, `mean last-200 ${mean}`);
  });

  it('is not stuck at 32 bits / 4.29e9 work', () => {
    assert.equal(MAX_BITS, 256);
    assert.equal(clampBits(32), packBits(32));
    assert.equal(clampBits(40), packBits(40));
    assert.equal(clampBits(256), packBits(256));
    assert.equal(clampBits(300), packBits(256));
    assert.ok(unpackBits(nextBits(packBits(32), 250)) > 32);
    assert.ok(unpackBits(nextBits(packBits(36), 250)) - 36 <= 2);
    assert.equal(nextBits(packBits(36), 90_000), packBits(36));
    const parentTs = 1_700_000_000_000;
    const eased = unpackBits(bitsForBlock(packBits(36), parentTs, parentTs + 12 * 3600_000));
    assert.ok(eased < 36, `12h header delta must ease 36-bit freeze, got ${eased}`);
  });

  it('template stamp is never after wall and never parent+90s ahead', () => {
    const parentTs = 1_700_000_000_000;
    const oneSec = templateStampMs(parentTs, parentTs + 1_000);
    assert.equal(oneSec, parentTs + 1_000);
    assert.notEqual(oneSec, parentTs + TARGET_BLOCK_INTERVAL_MS);
    assert.ok(oneSec <= parentTs + 1_000);
    assert.ok(oneSec >= parentTs);
    assert.equal(templateStampMs(parentTs, parentTs + TARGET_BLOCK_INTERVAL_MS), parentTs + TARGET_BLOCK_INTERVAL_MS);
    const late = templateStampMs(parentTs, parentTs + 400_000);
    assert.equal(late, parentTs + 400_000);
    assert.ok(late <= parentTs + 400_000);
    assert.ok(unpackBits(bitsForBlock(packBits(21), parentTs, late)) < 21);
    const src = fs.readFileSync(new URL('./asert.js', import.meta.url), 'utf8');
    assert.equal(/parent \+ TARGET_BLOCK_INTERVAL_MS/.test(src), false);
    assert.equal(/holdAimed/.test(src), false);
  });

  it('fast wall rounds may raise bits; clock skew does not stamp a negative interval', () => {
    const parentTs = 1_700_000_000_000;
    const parentBits = packBits(21);
    const fast = templateStampMs(parentTs, parentTs + 1_000, 26_000);
    assert.equal(fast, parentTs + 1_000);
    assert.ok(fast <= parentTs + 1_000);
    assert.ok(unpackBits(bitsForBlock(parentBits, parentTs, fast)) > 21);
    const stillFast = templateStampMs(parentTs, parentTs + 1_000, 10_000);
    assert.equal(stillFast, parentTs + 1_000);
    const hold = templateStampMs(parentTs, parentTs + 90_000, 90_000);
    assert.equal(hold, parentTs + 90_000);
    assert.equal(bitsForBlock(parentBits, parentTs, hold), parentBits);
    const late = templateStampMs(parentTs, parentTs + 400_000, 26_000);
    assert.equal(late, parentTs + 400_000);
    assert.ok(unpackBits(bitsForBlock(parentBits, parentTs, late)) < 21);
    const skew = templateStampMs(parentTs, parentTs - 5_000);
    assert.equal(skew, parentTs);
    assert.ok(skew >= parentTs);
    assert.notEqual(skew, parentTs - 5_000);
    const storeSrc = fs.readFileSync(new URL('../node/src/store.js', import.meta.url), 'utf8');
    assert.match(storeSrc, /templateStampMs\(parent\.timestamp, wall, wallIntervalMs\)/);
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
    assert.equal(formatShe(1e-9), '0.00000000');
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v4');
    assert.equal(MAGIC_TESTNET_V1, 'shear-testnet-v1');
    assert.equal(MAGIC_TESTNET_V2, 'shear-testnet-v2');
    assert.equal(MAGIC_TESTNET_V3, 'shear-testnet-v3');
  });
});

describe('hash-tx consensus law', () => {
  it('bakes HASH_TX_LIVE=1 into the fingerprint; env cannot revert it', () => {
    process.env.HASH_TX_LIVE = '0';
    assert.equal(HASH_TX_LIVE, 1);
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
    assert.equal(MIN_CONFIRMS_POLICY, 12);
    const fp = consensusFingerprint();
    assert.match(fp, new RegExp(`:${LIVE_MIN_BITS}:${GENESIS_BITS}:`));
    assert.equal(MIN_CONFIRMS_POLICY, 12);
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
    assert.match(fp, /^shear-book-law-2:shear-v1:/);
    assert.match(fp, /:90000:/);
    assert.match(fp, /:ssa:/);
    assert.match(fp, /:100000000000:/);
    assert.match(fp, /HASH_FN=ShearHash-v3/);
    assert.match(fp, /RX_MODE=light/);
    assert.match(fp, /RX_SALT=ShearHash-v3\/rx/);
    assert.match(fp, /SHARE_FLOOR_BITS=8/);
    assert.match(fp, /MAX_SHARES_PER_BLOCK=8192/);
    assert.match(fp, /SPEND_SIG=ed25519-shear-spend-v1/);
    assert.match(fp, /DEST_HRP_SSA_ONLY=1/);
    assert.match(fp, /SPEND_SIG_ONLY=1/);
    assert.match(fp, /MEMO_NOT_DEST_KEYED=1/);
    assert.equal(HASH_TX_LIVE, 1);
    assert.match(fp, /:1:/); // HASH_TX_LIVE pin stays 1
    assert.match(fp, /INTEREST=400d-bps-floor/);
    assert.match(fp, /ORACLE=basket-mean-14/);
    assert.match(fp, /HASH_UNIT_FLOOR=1/);
    assert.match(fp, /POT_PROP=shareBatch/);
    assert.match(fp, /POOL_WITHDRAW=eip712-spend-bound/);
    assert.match(fp, /NETWORK=shear-testnet-v4/);
    assert.match(fp, /HASH_TX_LIVE=1/);
    assert.match(fp, /LAG1_SHAREBATCH=1/);
    assert.match(fp, /POOL_FEE_BPS=100/);
    assert.match(fp, /AMOUNT=confidential/);
    assert.match(fp, /DUMMY_OUTS=1/);
    assert.match(fp, /ENC_SHARE=v5/);
    assert.match(fp, /DANDELIONPP=1/);
    assert.match(fp, /VIEW_TAG=1/);
    assert.match(fp, /KDF=argon2id-shewall/);
    assert.match(fp, /RESERVE=shear-reserve-v1/);
    assert.match(fp, /RESERVE_EVM=1/);
    assert.match(fp, /RESERVE_INTEREST=400d-bps-floor/);
    assert.match(fp, /VORTEX=vort1-pin/);
    assert.match(fp, /VORTICE_NO_MINT=1/);
    assert.match(fp, /LEVY_CAP=0.001-SHE/);
    assert.match(fp, /LEVY_SPLIT=50-50-finder-reserve/);
    assert.match(fp, /ADMIT=ADMITv2/);
    assert.match(fp, /RANGE=bpplus/);
    assert.match(fp, /LEVY=weight/);
    assert.match(fp, /BITS=q16\.16/);
    assert.match(fp, new RegExp(`ASERT_TAU_MS=${ASERT_HALFLIFE_MS}`));
    assert.equal(/fcmp/i.test(fp), false);
    assert.equal(/2026-\d{2}-\d{2}T/.test(fp), false);
    const mfp = mainnetFingerprint();
    assert.match(mfp, /NETWORK=shear-v1/);
    assert.match(mfp, /GENESIS=2026-09-18T21:00:00\+01:00/);
    assert.equal(GENESIS_MAINNET, '2026-09-18T21:00:00+01:00');
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET) - 1), false);
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET)), true);
    assert.equal(HASH_FN, 'ShearHash-v3');
    assert.equal(fp.includes('HASH_FN=ShearHash-v3'), true);
    assert.equal(fp.includes('HASH_FN=ShearHash-v2'), false);
    const law = consensusLaw();
    assert.equal(PRODUCT_VERSION, '0.4');
    assert.equal(MINER_VERSION, '1.1');
    assert.equal(SHEARK_MINER_VERSION, '1.7');
    assert.equal(PRODUCT_VERSION.split('.').length, 2);
    assert.equal(MINER_VERSION.split('.').length, 2);
    assert.equal(SHEARK_MINER_VERSION.split('.').length, 2);
    assert.equal(/^\d+\.\d+$/.test(PRODUCT_VERSION), true);
    assert.equal(/^\d+\.\d+$/.test(MINER_VERSION), true);
    assert.equal(/^\d+\.\d+\.\d+$/.test(PRODUCT_VERSION), false);
    assert.equal(/^\d+\.\d+\.\d+$/.test(MINER_VERSION), false);
    assert.equal(/^\d+\.\d+$/.test('0.10'), true);
    assert.equal(/^\d+\.\d+$/.test('0.1.0'), false);
    assert.equal(law.productVersion, '0.4');
    assert.equal(law.minerVersion, '1.1');
    assert.equal(law.shearkMinerVersion, '1.7');
    assert.equal(fp.includes(SHEARK_MINER_VERSION), false);
    assert.equal(fp.includes('shearkMinerVersion'), false);
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

describe('snapshot genesis extra mint is refused', () => {
  it('never allows a dead-id genesis mint', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM), false);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'lock' }), false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM), false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: 'claim' }), false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS }), false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS, funded: true }), false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS, funded: false }), false);
    assert.equal(extraMintAllowed('third-party-vortice'), false);
    assert.equal(extraMintAllowed('stake-pool-a', { kind: 'withdraw' }), false);
  });
});

describe('wrap mint is forbidden', () => {
  it('rejects wrap kinds and wrapped tickers', () => {
    assert.equal(wrapMintForbidden({ kind: 'wrap', programId: 'x' }), true);
    assert.equal(wrapMintForbidden({ ticker: 'wSHE' }), true);
    assert.equal(wrapMintForbidden({ programId: 'shear-reserve-v1', kind: 'withdraw' }), false);
  });
});

describe('dead-id claim window', () => {
  it('is closed', () => {
    assert.equal(JOIN_WINDOW_DAYS, 0);
    assert.equal(JOIN_WINDOW_MS, 0);
  });
});

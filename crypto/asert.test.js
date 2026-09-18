import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  nextBits,
  bitsForBlock,
  templateStampMs,
  TARGET_BLOCK_INTERVAL_MS,
  MTP_FUTURE_MS,
  GENESIS_BITS,
  GENESIS_BITS_PACKED,
  LIVE_MIN_BITS,
  MAX_BITS,
  clampBits,
  packBits,
  unpackBits,
  displayBits,
  ASERT_HARDEN_MAX,
  ASERT_EASE_MAX,
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
    assert.ok(next <= 23, `45s harden is +1 log2, got ${next}`);
    const from16 = unpackBits(nextBits(packBits(16), 59_000));
    assert.ok(from16 > 16, `59s must climb off 16, got ${from16}`);
    assert.ok(from16 < 17, `59s must not double work, got ${from16}`);
    assert.equal(nextBits(packBits(16), 90_000), packBits(16));
    const stuck = unpackBits(nextBits(packBits(16), 82_000));
    assert.ok(stuck > 16, `82s must not sit in a dead band, got ${stuck}`);
  });

  it('4 GH/s at 12 bits is ~1µs; log2 step catches 90s in tens of blocks, not hours', () => {
    const farmHs = 4e9;
    const t12 = (2 ** 12) / farmHs;
    assert.ok(t12 < 2e-6 && t12 > 5e-7, `12-bit @ 4GH/s ${t12}s`);
    let packed = packBits(12);
    let t = (2 ** 12) / farmHs;
    let n = 0;
    while (t < 80 && n < 40) {
      packed = nextBits(packed, Math.max(1, t * 1000));
      t = (2 ** unpackBits(packed)) / farmHs;
      n += 1;
    }
    assert.ok(n <= 20, `4GH/s from genesis 12 reached ~90s in ${n} blocks (t=${t}s)`);
    assert.ok(t >= 80 && t <= 200, `settled interval ${t}s`);
  });

  it('a 3s farm hardens +2 bits per block, not 0.003; HUD bits stay ≤ 256', () => {
    assert.equal(ASERT_HARDEN_MAX, 2);
    assert.equal(ASERT_EASE_MAX, 1);
    const jumped = unpackBits(nextBits(packBits(21), 3_500));
    assert.ok(jumped >= 23, `3.5s must +2, got ${jumped}`);
    assert.ok(jumped <= 23.01, `3.5s must cap at +2, got ${jumped}`);
    const packedPaint = 731501;
    assert.ok(packedPaint > 256);
    assert.ok(displayBits(packedPaint) < 12);
    assert.ok(displayBits(packedPaint) > 11);
    assert.ok(displayBits(GENESIS_BITS_PACKED) <= MAX_BITS);
    assert.equal(displayBits(GENESIS_BITS_PACKED), GENESIS_BITS);
    const fp = consensusFingerprint();
    assert.match(fp, /ASERT_STEP=log2/);
    assert.match(fp, /ASERT_HARDEN=2/);
    assert.match(fp, /ASERT_EASE=1/);
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
    assert.equal(/holdAimed/.test(src), false);
    assert.notEqual(oneSec, parentTs + TARGET_BLOCK_INTERVAL_MS);
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
    assert.equal(skew, parentTs + 1);
    assert.ok(skew > parentTs);
    assert.notEqual(skew, parentTs - 5_000);
    const storeSrc = fs.readFileSync(new URL('../node/src/store.js', import.meta.url), 'utf8');
    assert.match(storeSrc, /templateStampMs\(parent\.timestamp, wall, wallIntervalMs/);
    assert.match(storeSrc, /medianTimePast/);
  });

  it('wall far ahead of MTP clamps so the header is not future-illegal', () => {
    const parentTs = 1_700_000_000_000;
    const wall = parentTs + 3 * 3600_000;
    const clamped = templateStampMs(parentTs, wall, null, parentTs);
    assert.equal(clamped, parentTs + MTP_FUTURE_MS);
    assert.ok(clamped > parentTs);
    assert.ok(clamped <= parentTs + MTP_FUTURE_MS);
    const tightMtp = parentTs - MTP_FUTURE_MS + 1_000;
    const atCap = templateStampMs(parentTs, wall, null, tightMtp);
    assert.ok(atCap <= tightMtp + MTP_FUTURE_MS);
    assert.ok(atCap > parentTs || atCap === parentTs + 1);
    const uncapped = templateStampMs(parentTs, wall);
    assert.equal(uncapped, wall);
  });

  it('a tip sitting on the old 15 min MTP cap eases instead of hardening +2', () => {
    const parentTs = 1_700_000_000_000;
    const mtp = parentTs - 15 * 60_000 + 3_000;
    const wall = parentTs + 3_600_000;
    const stamp = templateStampMs(parentTs, wall, null, mtp);
    assert.ok(stamp - parentTs > 60_000, `interval ${stamp - parentTs} must not be the 3s cap`);
    const parentBits = packBits(21);
    const want = bitsForBlock(parentBits, parentTs, stamp);
    assert.ok(unpackBits(want) < 21, `long wall must ease, got ${unpackBits(want)}`);
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
    assert.match(fp, /SHARE_BIND=rx\+noteCommit/);
    assert.match(fp, /POOL_FEE_BPS=100/);
    assert.match(fp, /AMOUNT=confidential/);
    assert.match(fp, /DUMMY_OUTS=1/);
    assert.match(fp, /ENC_SHARE=v5/);
    assert.match(fp, /SHARE_BIND=rx\+noteCommit/);
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
    assert.match(fp, /SHARE_BIND=rx\+noteCommit/);
    assert.match(fp, /BITS=q16\.16/);
    assert.equal(MTP_FUTURE_MS, 7_200_000);
    assert.match(fp, /MTP_FUTURE_MS=7200000/);
    assert.match(fp, new RegExp(`ASERT_TAU_MS=${ASERT_HALFLIFE_MS}`));
    assert.equal(/fcmp/i.test(fp), false);
    assert.equal(/2026-\d{2}-\d{2}T/.test(fp), false);
    const mfp = mainnetFingerprint();
    assert.match(mfp, /NETWORK=shear-v1/);
    assert.match(mfp, /GENESIS=2026-09-18T21:00:00\+01:00/);
    assert.equal(GENESIS_MAINNET, '2026-09-18T21:00:00+01:00');
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET) - 1), false);
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET)), false);
    const prevEmit = process.env.SHEAR_MAINNET_EMIT;
    process.env.SHEAR_MAINNET_EMIT = '1';
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET) - 1), false);
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET)), true);
    if (prevEmit === undefined) delete process.env.SHEAR_MAINNET_EMIT;
    else process.env.SHEAR_MAINNET_EMIT = prevEmit;
    assert.equal(HASH_FN, 'ShearHash-v3');
    assert.equal(fp.includes('HASH_FN=ShearHash-v3'), true);
    assert.equal(fp.includes('HASH_FN=ShearHash-v2'), false);
    const law = consensusLaw();
    assert.equal(PRODUCT_VERSION, '0.4');
    assert.equal(MINER_VERSION, '1.1');
    assert.equal(SHEARK_MINER_VERSION, '2.4');
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
    assert.equal(law.shearkMinerVersion, '2.4');
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

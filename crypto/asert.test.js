import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  ASERT_EASE_MAX_TESTNET,
  ASERT_EASE_MAX_MAINNET,
  asertEaseMax,
  asertHardenMax,
  ASERT_HALFLIFE_MS,
  ASERT_CURVE_WINDOW,
  medianIntervalMs,
  SHE_DECIMALS,
  SHE_PUBLIC_DIGITS,
  NANOS_PER_SHE,
  HASH_BONUS_NANOS,
  HASH_BONUS_NANOS_FLOOR,
  hashBonusUnitNanos,
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
  MAGIC_TESTNET_V6,
  MAGIC_TESTNET_V7,
  MAGIC_TESTNET_V8,
  MAGIC_TESTNET_V9,
  MAGIC_MAINNET,
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

  it('raises packed bits when blocks arrive faster than 90s', () => {
    const next = unpackBits(nextBits(packBits(21), 45_000));
    assert.ok(next > 21, `expected harden from 21, got ${next}`);
    assert.ok(next - 21 <= ASERT_HARDEN_MAX, `45s stays inside the farm lid, got ${next}`);
    const from16 = unpackBits(nextBits(packBits(16), 59_000));
    assert.ok(from16 > 16, `59s must climb off 16, got ${from16}`);
    assert.ok(from16 - 16 < 1, `one 59s gap is under a full bit, got ${from16}`);
    assert.equal(nextBits(packBits(16), 90_000), packBits(16));
    const held = nextBits(packBits(15), TARGET_BLOCK_INTERVAL_MS);
    assert.equal(nextBits(packBits(15), 0), held);
    assert.equal(nextBits(packBits(15), -1), held);
    assert.equal(nextBits(packBits(15), Number.NaN), held);
    assert.equal(nextBits(packBits(15), 0.5), nextBits(packBits(15), 1));
    const stuck = unpackBits(nextBits(packBits(16), 82_000));
    assert.ok(stuck > 16, `82s must not sit in a dead band, got ${stuck}`);
  });

  it('asert source describes the recursive parent step, not a spew lid', () => {
    const src = fs.readFileSync(new URL('./asert.js', import.meta.url), 'utf8');
    assert.equal(src.includes('stops a farm spew'), false);
    assert.equal(/restore\b[^\n]{0,80}log2/.test(src), false);
    assert.match(src, /median of the last 11 sealed header gaps/i);
    assert.match(src, /function medianIntervalMs/);
  });

  it('median of 11 pads one short gap to 90s and moves when six are short', () => {
    assert.equal(ASERT_CURVE_WINDOW, 11);
    assert.equal(medianIntervalMs([2_000]), TARGET_BLOCK_INTERVAL_MS);
    const six = medianIntervalMs([2_000, 2_000, 2_000, 2_000, 2_000, 2_000]);
    assert.equal(six, 2_000);
    const held = unpackBits(nextBits(GENESIS_BITS_PACKED, medianIntervalMs([2_000])));
    assert.equal(held, GENESIS_BITS);
    const moved = unpackBits(nextBits(GENESIS_BITS_PACKED, six));
    assert.ok(moved > GENESIS_BITS, `six short gaps must harden, got ${moved}`);
    assert.ok(moved - GENESIS_BITS <= ASERT_HARDEN_MAX, `six short gaps stay inside the lid, got ${moved}`);
  });

  it('eight 2000ms gaps from genesis add at least one bit; one fast gap stays under the lid', () => {
    let packed = GENESIS_BITS_PACKED;
    for (let n = 0; n < 8; n += 1) packed = nextBits(packed, 2_000);
    const after8 = unpackBits(packed);
    assert.ok(after8 >= GENESIS_BITS + 1, `eight 2000ms gaps must add >=1 bit, got ${after8}`);
    const held = nextBits(packed, TARGET_BLOCK_INTERVAL_MS);
    assert.equal(unpackBits(held), unpackBits(packed), `90000ms must not raise, got ${unpackBits(held)}`);
    const one = unpackBits(nextBits(packBits(12), 1));
    assert.ok(one > 12, `1ms must harden, got ${one}`);
    assert.ok(one - 12 <= ASERT_HARDEN_MAX, `1ms stays inside the farm lid, got ${one}`);
  });

  it('fast-gap step keeps farm lid constants; stall at 8τ eases by ease max; HUD ≤ 256', () => {
    assert.equal(ASERT_HARDEN_MAX, 1);
    assert.equal(ASERT_EASE_MAX, 1);
    assert.equal(ASERT_EASE_MAX_TESTNET, 1);
    assert.equal(ASERT_EASE_MAX_MAINNET, 1);
    assert.equal(asertEaseMax(MAGIC_TESTNET), 1);
    assert.equal(asertEaseMax(MAGIC_MAINNET), 1);
    assert.equal(asertHardenMax(MAGIC_TESTNET), 1);
    assert.equal(asertHardenMax(MAGIC_MAINNET), 6);
    const jumped = unpackBits(nextBits(packBits(21), 3_500));
    assert.ok(jumped > 21, `3.5s must harden, got ${jumped}`);
    assert.ok(jumped - 21 <= ASERT_HARDEN_MAX, `3.5s stays inside the farm lid, got ${jumped}`);
    const oneMs = unpackBits(nextBits(packBits(21), 1));
    assert.ok(oneMs - 21 <= ASERT_HARDEN_MAX, `1ms stays inside the farm lid, got ${oneMs}`);
    assert.ok(oneMs > 21, `1ms must harden, got ${oneMs}`);
    const stall = unpackBits(nextBits(packBits(21), ASERT_HALFLIFE_MS * 8));
    const stallDrop = 21 - stall;
    assert.ok(stallDrop > 0, `8τ stall must ease, got ${stall}`);
    assert.ok(stallDrop <= ASERT_EASE_MAX + 1e-9, `8τ stall stays inside the ease lid, got ${stall}`);
    const packedPaint = 731501;
    assert.ok(packedPaint > 256);
    assert.ok(displayBits(packedPaint) < 12);
    assert.ok(displayBits(packedPaint) > 11);
    assert.ok(displayBits(GENESIS_BITS_PACKED) <= MAX_BITS);
    assert.equal(displayBits(GENESIS_BITS_PACKED), GENESIS_BITS);
    const fp = consensusFingerprint();
    assert.match(fp, /ASERT_STEP=median11\(log2\(T\/seen\)\)\*\(T\/tau\)/);
    assert.equal(fp.includes('ASERT_STEP=(T-seen)/tau'), false);
    assert.equal(fp.includes('ASERT_STEP=8x2000ms=+1bit'), false);
    assert.match(fp, /ASERT_HARDEN=1/);
    assert.match(fp, /HEADER_AHEAD_MS=15000/);
    assert.match(fp, /ASERT_EASE=1/);
    assert.match(fp, /ASERT_FLOOR=above-min-until-8tau/);
    assert.equal(ASERT_HALFLIFE_MS, 32 * TARGET_BLOCK_INTERVAL_MS);
    assert.match(fp, /ASERT_TAU_MS=2880000/);
    assert.doesNotMatch(fp, /ASERT_HARDEN=6/);
    assert.doesNotMatch(fp, /NETWORK=shear-testnet-v9/);
    assert.match(mainnetFingerprint(), /ASERT_EASE=1/);
    assert.match(mainnetFingerprint(), /ASERT_HARDEN=6/);
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

  it('farm on then off: tau-damped ASERT recenters near 90s; ease lid differs testnet vs mainnet on stall', () => {
    const target = TARGET_BLOCK_INTERVAL_MS;
    const baseHs = (2 ** GENESIS_BITS) / (target / 1000);
    function run(magic) {
      let packed = packBits(GENESIS_BITS);
      const intervals = [];
      const pushHs = (hs, n) => {
        for (let i = 0; i < n; i += 1) {
          const fp = unpackBits(packed);
          const intervalMs = ((2 ** fp) / hs) * 1000;
          intervals.push(intervalMs);
          packed = nextBits(packed, intervalMs, magic);
        }
      };
      pushHs(baseHs, 40);
      for (let c = 0; c < 200; c += 1) {
        pushHs(baseHs * 8, 1);
        pushHs(baseHs, 1);
      }
      const afterOsc = intervals.length;
      pushHs(baseHs, 350);
      return { intervals, afterOsc, packed };
    }
    function ewma(dts) {
      const half = 288;
      const alpha = 1 - 2 ** (-1 / half);
      let e = target;
      for (const dt of dts) {
        const c = Math.max(target / 8, Math.min(target * 8, dt));
        e = alpha * c + (1 - alpha) * e;
      }
      return e;
    }
    const tn = run(MAGIC_TESTNET);
    const mn = run(MAGIC_MAINNET);
    const tnSettle = ewma(tn.intervals.slice(-288));
    const tnOsc = ewma(tn.intervals.slice(40, tn.afterOsc));
    assert.ok(tnSettle > 80_000 && tnSettle < 105_000, `testnet long EWMA ${tnSettle}`);
    assert.ok(tnOsc < 400_000, `testnet oscillation EWMA ${tnOsc}`);
    // 8τ stall hits the ease lid. v10 testnet ease is −1, same as mainnet.
    // Mainnet harden stays wider: a 1 ms gap climbs further on shear-v1.
    const stall = ASERT_HALFLIFE_MS * 8;
    const tnStall = unpackBits(nextBits(packBits(21), stall, MAGIC_TESTNET));
    const mnStall = unpackBits(nextBits(packBits(21), stall, MAGIC_MAINNET));
    assert.ok(tnStall < 21, `testnet 8τ must ease, got ${tnStall}`);
    assert.ok(mnStall < 21, `mainnet 8τ must ease, got ${mnStall}`);
    assert.ok(21 - tnStall <= asertEaseMax(MAGIC_TESTNET) + 1e-9, `testnet ease lid, got ${tnStall}`);
    assert.ok(21 - mnStall <= asertEaseMax(MAGIC_MAINNET) + 1e-9, `mainnet ease lid, got ${mnStall}`);
  });

  it('is not stuck at 32 bits / 4.29e9 work', () => {
    assert.equal(MAX_BITS, 256);
    assert.equal(clampBits(32), packBits(32));
    assert.equal(clampBits(40), packBits(40));
    assert.equal(clampBits(256), packBits(256));
    assert.equal(clampBits(300), packBits(256));
    assert.ok(unpackBits(nextBits(packBits(32), 250)) > 32);
    const fast36 = unpackBits(nextBits(packBits(36), 250)) - 36;
    assert.ok(fast36 > 0.05, `250ms must move 36-bit work, got ${fast36}`);
    assert.ok(fast36 <= ASERT_HARDEN_MAX);
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
    assert.equal(HASH_BONUS_NANOS_FLOOR, 1);
    assert.equal(hashBonusUnitNanos(0), 1);
    assert.equal(hashBonusUnitNanos(-1), 1);
    assert.equal(hashBonusUnitNanos(null), 1);
    assert.equal(hashBonusUnitNanos(0n), 1);
    assert.equal(hashBonusUnitNanos(3), 3);
    assert.equal(HASH_BONUS_NANOS / NANOS_PER_SHE, 1e-11);
    assert.equal(HASH_BONUS_VOTE_DELTA_NANOS, 1);
    assert.equal(HASH_BONUS_VOTE_DELTA, 1 / NANOS_PER_SHE);
    assert.equal(HASH_BONUS_VOTE_DELTA, 1e-11);
    assert.equal(formatShe(1), '1');
    assert.equal(formatShe(1e-11), '0.00000000');
    assert.equal(formatShe(1e-8), '0.00000001');
    assert.equal(formatShe(1e-9), '0.00000000');
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v10');
    assert.equal(MAGIC_TESTNET_V9, 'shear-testnet-v9');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V9);
    assert.equal(MAGIC_TESTNET_V8, 'shear-testnet-v8');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V8);
    assert.equal(MAGIC_TESTNET_V7, 'shear-testnet-v7');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V7);
    assert.equal(MAGIC_TESTNET_V6, 'shear-testnet-v6');
    assert.equal(MAGIC_TESTNET_V4, 'shear-testnet-v4');
    assert.equal(MAGIC_TESTNET_V1, 'shear-testnet-v1');
    assert.equal(MAGIC_TESTNET_V2, 'shear-testnet-v2');
    assert.equal(MAGIC_TESTNET_V3, 'shear-testnet-v3');
  });

  it('pool, admin, and Continuum cannot set consensus nextBits', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const gate = [
      'pool/src/main.js',
      'pool/src/pool.js',
      'node/src/store.js',
      'node/src/chain.js',
      'node/src/node.js',
      'crypto/asert.js',
    ].map((rel) => fs.readFileSync(path.join(root, rel), 'utf8')).join('\n');
    assert.equal(gate.includes('process.env.SHEAR_BITS'), false);
    assert.match(gate, /void bitsIn/);
    const chain = fs.readFileSync(path.join(root, 'node/src/chain.js'), 'utf8');
    assert.match(chain, /void candidateTimestamp/);
    assert.match(chain, /medianIntervalMs\(headerGapsMs\(chain\)\)/);
    assert.match(chain, /Difficulty is network-wide/);
    const consensus = fs.readFileSync(path.join(root, 'specs/consensus.md'), 'utf8');
    const ops = fs.readFileSync(path.join(root, 'docs/OPS-testnet-v10-90s.md'), 'utf8');
    assert.match(consensus, /Difficulty is network-wide/);
    assert.match(ops, /Difficulty is network-wide/);
    const lib = path.join(root, 'wallet/lib');
    const dart = fs.readdirSync(lib).filter((name) => name.endsWith('.dart'));
    assert.ok(dart.length > 5);
    for (const name of dart) {
      const text = fs.readFileSync(path.join(lib, name), 'utf8');
      assert.equal(/nextBits|ASERT_|bitsForBlock|asertHarden|asertEase|SHEAR_BITS/.test(text), false, name);
    }
  });
});

describe('hash bonus never zero (law)', () => {
  it('HASH_UNIT_FLOOR=1 is fingerprinted and hashBonusUnitNanos never returns 0', () => {
    assert.equal(HASH_BONUS_NANOS_FLOOR, 1);
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.ok(HASH_BONUS_NANOS_FLOOR >= 1);
    for (const bad of [0, -1, -99, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '', '0', 0n, -1n]) {
      const got = hashBonusUnitNanos(bad);
      assert.equal(got, HASH_BONUS_NANOS_FLOOR, `hashBonusUnitNanos(${String(bad)}) → ${got}`);
      assert.ok(got >= 1);
    }
    assert.equal(hashBonusUnitNanos(2), 2);
    assert.equal(hashBonusUnitNanos(7n), 7);
    const fp = consensusFingerprint();
    assert.match(fp, /HASH_UNIT_FLOOR=1/);
    assert.match(mainnetFingerprint(), /HASH_UNIT_FLOOR=1/);
  });
});

describe('hash-tx consensus law', () => {
  it('bakes HASH_TX_LIVE=1 into the fingerprint; env cannot revert it', () => {
    process.env.HASH_TX_LIVE = '0';
    assert.equal(HASH_TX_LIVE, 1);
    assert.equal(SPENDABLE_CONFIRMATIONS, 9);
    assert.equal(MIN_CONFIRMS_POLICY, 12);
    const fp = consensusFingerprint();
    assert.match(fp, new RegExp(`:${LIVE_MIN_BITS}:${GENESIS_BITS}:`));
    assert.equal(MIN_CONFIRMS_POLICY, 12);
    assert.equal(SPENDABLE_CONFIRMATIONS, 9);
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
    assert.match(fp, /INTEREST=epoch-bps-floor/);
    assert.match(fp, /EPOCH_DAYS=4/);
    assert.match(fp, /POT_SCHED=lin-epoch/);
    assert.match(fp, /ORACLE=basket-mean-14/);
    assert.match(fp, /HASH_UNIT_FLOOR=1/);
    assert.match(fp, /POT_PROP=shareBatch/);
    assert.match(fp, /POOL_WITHDRAW=eip712-spend-bound/);
    assert.match(fp, /NETWORK=shear-testnet-v10/);
    assert.doesNotMatch(fp, /NETWORK=shear-testnet-v8/);
    assert.doesNotMatch(fp, /NETWORK=shear-testnet-v7/);
    assert.match(fp, /:4:15:/);
    assert.equal(GENESIS_BITS, 15);
    assert.equal(LIVE_MIN_BITS, 4);
    assert.equal(TARGET_BLOCK_INTERVAL_MS, 90000);
    assert.match(fp, /HASH_TX_LIVE=1/);
    assert.match(fp, /SHARE_BIND=rx\+noteCommit/);
    assert.match(fp, /POOL_FEE_MAX_BPS=300/);
    assert.doesNotMatch(fp, /POOL_FEE_BPS=100/);
    assert.match(fp, /AMOUNT=confidential/);
    assert.match(fp, /DUMMY_OUTS=1/);
    assert.match(fp, /ENC_SHARE=v5/);
    assert.match(fp, /SHARE_BIND=rx\+noteCommit/);
    assert.match(fp, /DANDELIONPP=1/);
    assert.match(fp, /VIEW_TAG=1/);
    assert.match(fp, /KDF=argon2id-shewall/);
    assert.match(fp, /RESERVE=shear-reserve-v1/);
    assert.match(fp, /RESERVE_EVM=1/);
    assert.match(fp, /RESERVE_INTEREST=4d-bps-floor/);
    assert.match(fp, /VORTEX=vort1-pin/);
    assert.match(fp, /VORTICE_NO_MINT=1/);
    assert.match(fp, /LEVY_CAP=0.001-SHE/);
    assert.match(fp, /LEVY_SPLIT=50-50-finder-reserve/);
    assert.match(fp, /ADMIT=ADMITv2/);
    assert.match(fp, /RANGE=bpplus/);
    assert.match(fp, /LEVY=weight/);
    assert.match(fp, /SHARE_BIND=rx\+noteCommit/);
    assert.match(fp, /BITS=q16\.16/);
    assert.match(fp, /ASERT_HARDEN=1/);
    assert.match(fp, /ASERT_EASE=1/);
    assert.match(fp, /ASERT_FLOOR=above-min-until-8tau/);
    assert.doesNotMatch(fp, /NETWORK=shear-testnet-v9/);
    assert.equal(MTP_FUTURE_MS, 7_200_000);
    assert.match(fp, /MTP_FUTURE_MS=7200000/);
    assert.match(fp, new RegExp(`ASERT_TAU_MS=${ASERT_HALFLIFE_MS}`));
    assert.equal(/fcmp/i.test(fp), false);
    assert.equal(/2026-\d{2}-\d{2}T/.test(fp), false);
    const mfp = mainnetFingerprint();
    assert.match(mfp, /NETWORK=shear-v1/);
    assert.match(mfp, /ASERT_EASE=1/);
    assert.match(mfp, /ASERT_HARDEN=6/);
    assert.match(mfp, /GENESIS=2026-09-18T21:00:00\+01:00/);
    assert.equal(GENESIS_MAINNET, '2026-09-18T21:00:00+01:00');
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET) - 1), false);
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET)), false);
    const prevEmit = process.env.SHEAR_MAINNET_EMIT;
    const prevConfirm = process.env.SHEAR_MAINNET_EMIT_CONFIRM;
    process.env.SHEAR_MAINNET_EMIT = '1';
    delete process.env.SHEAR_MAINNET_EMIT_CONFIRM;
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET) - 1), false);
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET)), false);
    process.env.SHEAR_MAINNET_EMIT_CONFIRM = 'I_UNDERSTAND_SHEAR_MAINNET';
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET) - 1), false);
    assert.equal(mainnetMayEmit(Date.parse(GENESIS_MAINNET)), true);
    if (prevEmit === undefined) delete process.env.SHEAR_MAINNET_EMIT;
    else process.env.SHEAR_MAINNET_EMIT = prevEmit;
    if (prevConfirm === undefined) delete process.env.SHEAR_MAINNET_EMIT_CONFIRM;
    else process.env.SHEAR_MAINNET_EMIT_CONFIRM = prevConfirm;
    assert.equal(HASH_FN, 'ShearHash-v3');
    assert.equal(fp.includes('HASH_FN=ShearHash-v3'), true);
    assert.equal(fp.includes('HASH_FN=ShearHash-v2'), false);
    const law = consensusLaw();
    assert.equal(PRODUCT_VERSION, '17.0');
    assert.equal(MINER_VERSION, '1.1');
    assert.equal(SHEARK_MINER_VERSION, '2.8');
    assert.equal(PRODUCT_VERSION.split('.').length, 2);
    assert.equal(MINER_VERSION.split('.').length, 2);
    assert.equal(SHEARK_MINER_VERSION.split('.').length, 2);
    assert.equal(/^\d+\.\d+$/.test(PRODUCT_VERSION), true);
    assert.equal(/^\d+\.\d+$/.test(MINER_VERSION), true);
    assert.equal(/^\d+\.\d+\.\d+$/.test(PRODUCT_VERSION), false);
    assert.equal(/^\d+\.\d+\.\d+$/.test(MINER_VERSION), false);
    assert.equal(/^\d+\.\d+$/.test('0.10'), true);
    assert.equal(/^\d+\.\d+$/.test('0.1.0'), false);
    assert.equal(law.productVersion, '17.0');
    assert.equal(fp.includes('17.0'), false);
    assert.equal(fp.includes('16.0'), false);
    assert.equal(fp.includes('15.0'), false);
    assert.equal(fp.includes('0.66'), false);
    assert.equal(fp.includes('14.0'), false);
    assert.equal(fp.includes('11.0'), false);
    assert.equal(fp.includes('10.0'), false);
    assert.equal(fp.includes('12.0'), false);
    assert.equal(fp.includes('13.0'), false);
    assert.equal(fp.includes('PRODUCT_VERSION'), false);
    assert.equal(fp.includes('9.0'), false);
    assert.equal(fp.includes('8.0'), false);
    assert.equal(fp.includes('7.0'), false);
    assert.equal(fp.includes('6.0'), false);
    assert.equal(fp.includes('0.52'), false);
    assert.equal(fp.includes('0.53'), false);
    assert.equal(fp.includes('0.54'), false);
    assert.equal(fp.includes('0.55'), false);
    assert.equal(fp.includes('0.55.1'), false);
    assert.equal(fp.includes('0.55.2'), false);
    assert.equal(fp.includes('0.56'), false);
    assert.equal(fp.includes('0.57'), false);
    assert.equal(fp.includes('0.58'), false);
    assert.equal(fp.includes('0.59'), false);
    assert.equal(fp.includes('0.60'), false);
    assert.equal(fp.includes('0.61'), false);
    assert.equal(fp.includes('0.62'), false);
    assert.equal(fp.includes('0.63'), false);
    assert.equal(fp.includes('0.64'), false);
    assert.equal(fp.includes('0.65'), false);
    assert.match(fp, /FORK=work-then-lowhash/);
    assert.equal(fp.includes(PRODUCT_VERSION), false);
    assert.equal(law.minerVersion, '1.1');
    assert.equal(law.shearkMinerVersion, '2.8');
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

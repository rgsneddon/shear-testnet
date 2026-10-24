/**
 * Shipped v12 genesis-anchored aserti3-2d (7b50960a) under a moving hashrate.
 * The retired median-11 nextBits step is 0-lidded on testnet and does not
 * move, so the closed loop drives asertNextBits from a genesis anchor.
 * The scenario hashrate lives in this test. It is not a law constant.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  nextBits,
  asertNextBits,
  unpackBits,
  GENESIS_BITS,
  GENESIS_BITS_PACKED,
  LIVE_MIN_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  ASERT_HALFLIFE_MS,
  ASERT_TAU_MS,
} from './asert.js';

const T = TARGET_BLOCK_INTERVAL_MS;
const T0 = 1_700_000_000_000;

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

/** The consensus quote for a block at `height` stamped `ts`; genesis is height 1 at T0. */
function quote(height, ts, parentTs = null) {
  const q = asertNextBits({
    anchorBits: GENESIS_BITS_PACKED,
    anchorTimeMs: T0,
    anchorHeight: 1,
    blockTimeMs: ts,
    blockHeight: height,
    parentTimeMs: parentTs,
  });
  assert.equal(q.ok, true, q.reason);
  return q;
}

/**
 * Closed loop: a block's bits are the full quote at its own stamp, and its
 * expected solve time is 2^bits / H. The few rounds settle that fixed point
 * (the quote moves by interval / tau bits, far under one bit).
 */
function closedLoop(schedule) {
  let t = T0;
  let height = 1;
  const rows = [];
  for (const step of schedule) {
    for (let i = 0; i < step.n; i += 1) {
      const prev = height === 1 ? GENESIS_BITS : rows[rows.length - 1].next;
      let interval = T;
      let packed = GENESIS_BITS_PACKED;
      for (let k = 0; k < 6; k += 1) {
        packed = quote(height + 1, Math.floor(t + interval), t).packed;
        interval = ((2 ** unpackBits(packed)) / step.h) * 1000;
      }
      t = Math.floor(t + interval);
      height += 1;
      rows.push({
        h: step.h,
        prev,
        next: unpackBits(packed),
        interval,
      });
    }
  }
  return rows;
}

describe('v12 tempo tracks a moving hashrate toward 90s', () => {
  it('module source has no baked hashrate equilibrium', () => {
    const src = fs.readFileSync(new URL('./asert.js', import.meta.url), 'utf8');
    assert.equal(/log2\s*\(\s*H\s*[*·×]/.test(src), false);
    assert.equal(/log2\(H/.test(src), false);
    assert.equal(/HASHRATE\s*=\s*\d/.test(src), false);
    // v12: tau = 2 h = 80·T (v11 closed with 16·T = 1_440_000 ms).
    assert.equal(ASERT_HALFLIFE_MS, ASERT_TAU_MS);
    assert.equal(ASERT_HALFLIFE_MS, 80 * T);
    assert.equal(ASERT_HALFLIFE_MS, 7_200_000);
    assert.equal(GENESIS_BITS, 17);
  });

  it('on schedule holds, ahead of schedule hardens, behind eases, and T holds', () => {
    // The retired step does not move testnet work.
    assert.equal(nextBits(GENESIS_BITS_PACKED, 2_000), GENESIS_BITS_PACKED);
    assert.equal(nextBits(GENESIS_BITS_PACKED, 180_000), GENESIS_BITS_PACKED);
    const held = quote(12, T0 + 11 * T);
    assert.equal(held.packed, GENESIS_BITS_PACKED);
    const burstTs = T0 + 11 * 2_000;
    const burst = quote(12, burstTs);
    const hardened = unpackBits(burst.packed);
    assert.ok(hardened > GENESIS_BITS, `ahead of schedule must harden, got ${hardened}`);
    const lateTs = burstTs + 11 * 180_000;
    const late = quote(23, lateTs);
    const eased = unpackBits(late.packed);
    assert.ok(eased < hardened, `behind schedule must ease, got ${eased}`);
    assert.ok(eased > LIVE_MIN_BITS, `180s gaps are not a stall, got ${eased}`);
    const again = quote(24, lateTs + T);
    assert.equal(again.packed, late.packed);
  });

  it('a sub-10s burst then an ease under continuous H does not park on the floor', () => {
    const h0 = (2 ** GENESIS_BITS) / (T / 1000);
    const rows = closedLoop([
      { h: h0 * 16, n: 40 },
      { h: h0 / 8, n: 50 },
      // tau = 80 blocks: the absolute schedule repays the drop's time debt
      // over a few tau, so the settle leg is long.
      { h: h0, n: 480 },
    ]);
    const spike = rows.slice(0, 40);
    const drop = rows.slice(40, 90);
    const settle = rows.slice(-30);
    assert.ok(Math.max(...spike.map((r) => r.next)) > GENESIS_BITS, 'H spike hardens');
    assert.ok(
      Math.min(...drop.map((r) => r.next)) < Math.max(...spike.map((r) => r.next)),
      'H drop eases',
    );
    for (const row of rows) {
      assert.ok(row.h > 0);
      assert.ok(row.next > LIVE_MIN_BITS, `parked at floor after interval ${row.interval}`);
    }
    const tail = settle.map((r) => r.interval);
    const m = mean(tail);
    const med = median(tail);
    assert.ok(m > 70_000 && m < 120_000, `settled mean ${m}`);
    assert.ok(med > 70_000 && med < 120_000, `settled median ${med}`);
  });
});

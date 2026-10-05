/**
 * Shipped median11 nextBits under a moving hashrate.
 * The scenario hashrate lives in this test. It is not a law constant.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  nextBits,
  medianIntervalMs,
  packBits,
  unpackBits,
  GENESIS_BITS,
  GENESIS_BITS_PACKED,
  LIVE_MIN_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  ASERT_HALFLIFE_MS,
} from './asert.js';

const T = TARGET_BLOCK_INTERVAL_MS;

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

/** Closed loop: interval = 2^bits / H, then the shipped median and nextBits. */
function closedLoop(schedule) {
  let packed = GENESIS_BITS_PACKED;
  const window = [];
  const rows = [];
  for (const step of schedule) {
    for (let i = 0; i < step.n; i += 1) {
      const prev = unpackBits(packed);
      const interval = ((2 ** prev) / step.h) * 1000;
      window.push(interval);
      const med = medianIntervalMs(window);
      packed = nextBits(packed, med);
      rows.push({
        h: step.h,
        prev,
        next: unpackBits(packed),
        interval,
        med,
      });
    }
  }
  return rows;
}

describe('v10 tempo tracks a moving hashrate toward 90s', () => {
  it('module source has no baked hashrate equilibrium', () => {
    const src = fs.readFileSync(new URL('./asert.js', import.meta.url), 'utf8');
    assert.equal(/log2\s*\(\s*H\s*[*·×]/.test(src), false);
    assert.equal(/log2\(H/.test(src), false);
    assert.equal(/HASHRATE\s*=\s*\d/.test(src), false);
    assert.equal(ASERT_HALFLIFE_MS, 16 * T);
    assert.equal(ASERT_HALFLIFE_MS, 1_440_000);
    assert.equal(GENESIS_BITS, 17);
  });

  it('a short median hardens, a long median eases, and T holds', () => {
    const held = nextBits(GENESIS_BITS_PACKED, medianIntervalMs(Array(11).fill(T)));
    assert.equal(unpackBits(held), GENESIS_BITS);
    const burst = medianIntervalMs(Array(11).fill(2_000));
    assert.ok(burst < 10_000);
    const hardened = unpackBits(nextBits(GENESIS_BITS_PACKED, burst));
    assert.ok(hardened > GENESIS_BITS, `short median must harden, got ${hardened}`);
    const eased = unpackBits(nextBits(packBits(hardened), medianIntervalMs(Array(11).fill(180_000))));
    assert.ok(eased < hardened, `long median must ease, got ${eased}`);
    assert.ok(eased > LIVE_MIN_BITS, `180s is not an 8τ stall, got ${eased}`);
    const again = unpackBits(nextBits(packBits(eased), T));
    assert.equal(again, eased);
  });

  it('a sub-10s burst then an ease under continuous H does not park on the floor', () => {
    const h0 = (2 ** GENESIS_BITS) / (T / 1000);
    const rows = closedLoop([
      { h: h0 * 16, n: 40 },
      { h: h0 / 8, n: 50 },
      { h: h0, n: 80 },
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
      assert.ok(row.next > LIVE_MIN_BITS, `parked at floor after med ${row.med}`);
    }
    const tail = settle.map((r) => r.interval);
    const m = mean(tail);
    const med = median(tail);
    assert.ok(m > 70_000 && m < 120_000, `settled mean ${m}`);
    assert.ok(med > 70_000 && med < 120_000, `settled median ${med}`);
  });
});

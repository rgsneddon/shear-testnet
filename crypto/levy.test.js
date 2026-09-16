import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  levyNanos,
  levyBase,
  levyFromWeight,
  flowWeight,
  splitLevy,
  nextBaseFee,
  reserveFeeDest,
  levyTaxed,
  quoteLevy,
  levyNeed,
  LEVY_FLOOR_UNITS,
  LEVY_CAP_NANOS,
  LEVY_WEIGHT_RATE_NUM,
  LEVY_WEIGHT_RATE_DEN,
} from './levy.js';
import { NANOS_PER_SHE as UNITS } from './asert.js';
import { isDestAddress, bech32Hrp } from './address.js';

describe('LEVY=weight Flow levy', () => {
  it('same weight ⇒ same fee for 1 and 10^9; not 2 bps of amount; default << cap', () => {
    assert.equal(LEVY_FLOOR_UNITS, 100);
    assert.equal(LEVY_CAP_NANOS, Math.floor(0.001 * UNITS));
    assert.equal(levyBase(1), 100);
    assert.equal(levyBase(UNITS), 100);
    assert.equal(levyNanos(1), 100);
    assert.equal(levyNanos(1e9), 100);
    const w = 4000;
    const a = levyFromWeight(w);
    const b = levyFromWeight(w);
    assert.equal(a, b);
    const tx1 = { kind: 'send', nanos: '0000000001', vin: [{}], vout: [{ kind: 'send' }], pad: 'x'.repeat(200) };
    const tx9 = { kind: 'send', nanos: '1000000000', vin: [{}], vout: [{ kind: 'send' }], pad: 'x'.repeat(200) };
    assert.equal(flowWeight(tx1), flowWeight(tx9));
    assert.equal(levyNeed(tx1), levyNeed(tx9));
    const oldBps = Math.ceil((1e9 * 2) / 10000);
    assert.notEqual(levyNeed(tx9), oldBps);
    assert.ok(levyNeed(tx9) < oldBps || oldBps === 0);
    const tiny = { kind: 'send', nanos: 1, vin: [{}], vout: [{}] };
    const twoBpsTiny = Math.ceil((1 * 2) / 10000);
    assert.ok(levyNeed(tiny) > twoBpsTiny);
    assert.ok(levyNanos(0) === 100);
    assert.ok(levyNanos(0) < 0.01 * LEVY_CAP_NANOS);
    assert.ok(levyFromWeight(1) === 100);
    assert.equal(levyFromWeight(64 * 100), Math.max(100, Math.ceil((6400 * LEVY_WEIGHT_RATE_NUM) / LEVY_WEIGHT_RATE_DEN)));
    assert.ok(levyFromWeight(1e12) > LEVY_CAP_NANOS || levyFromWeight(1e12) >= LEVY_FLOOR_UNITS);
    assert.deepEqual(splitLevy(12), { finder: 6, reserve: 6 });
    assert.deepEqual(splitLevy(1), { finder: 0, reserve: 1 });
    assert.equal(nextBaseFee(1, 8), 1);
    assert.ok(nextBaseFee(1, 32) > 1);
    assert.equal(bech32Hrp(reserveFeeDest()), 'ssa');
    assert.equal(isDestAddress(reserveFeeDest()), true);
    assert.equal(levyTaxed({ kind: 'send', vin: [{}] }), true);
    assert.equal(levyTaxed({ kind: 'withdraw' }), false);
    const q = quoteLevy(UNITS, { weight: 200 });
    assert.equal(q.L, levyFromWeight(200));
    assert.equal(q.finder + q.reserve, q.L);
    assert.equal(q.spaceNotPercent, true);
  });
});

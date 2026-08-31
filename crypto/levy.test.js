import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  levyNanos,
  levyBase,
  levySurge,
  splitLevy,
  nextBaseFee,
  reserveFeeDest,
  levyTaxed,
  quoteLevy,
  levyNeed,
  mempoolDepthBytes,
  SURGE_MAX,
  LEVY_FLOOR_UNITS,
} from './levy.js';
import { NANOS_PER_SHE as UNITS } from './asert.js';
import { isDestAddress, bech32Hrp } from './address.js';

describe('Phase B Flow levy', () => {
  it('dust empty mempool is 100 units; 1 SHE empty is 0.0002 SHE; surge caps at 4× L_base', () => {
    assert.equal(LEVY_FLOOR_UNITS, 100);
    const dust = Math.floor(0.000005 * UNITS);
    assert.equal(levyBase(1), 100);
    assert.equal(levyBase(dust), 100);
    assert.equal(levyNanos(dust), 100);
    assert.equal(levyNanos(dust, { depth: 0 }), 100);
    const one = UNITS;
    assert.equal(levyBase(one), 20_000_000);
    assert.equal(levyNanos(one), 20_000_000);
    assert.equal(levyNanos(one) / UNITS, 0.0002);
    assert.equal(levySurge(0), 0);
    assert.equal(levySurge(1e12), SURGE_MAX);
    const full = levyNanos(dust, { depth: 1e12 });
    assert.equal(full, 100 * (1 + SURGE_MAX));
    assert.equal(full, 4 * levyBase(dust));
    assert.deepEqual(splitLevy(12), { finder: 6, reserve: 6 });
    assert.deepEqual(splitLevy(1), { finder: 0, reserve: 1 });
    assert.equal(nextBaseFee(1, 8), 1);
    assert.ok(nextBaseFee(1, 32) > 1);
    assert.equal(bech32Hrp(reserveFeeDest()), 'ssa');
    assert.equal(isDestAddress(reserveFeeDest()), true);
    assert.equal(levyTaxed({ kind: 'send', vin: [{}] }), true);
    assert.equal(levyTaxed({ kind: 'evm-value' }), true);
    assert.equal(levyTaxed({ kind: 'claim' }), false);
    assert.equal(levyTaxed({ kind: 'hash', coinbase: true }), false);
    const q = quoteLevy(one, { depth: 0 });
    assert.equal(q.L, 20_000_000);
    assert.equal(q.finder + q.reserve, q.L);
    const first = { kind: 'send', nanos: 2, vin: [{}], vout: [{ nanos: 2 }] };
    assert.equal(levyNeed(first, []), 100);
    const fat = { kind: 'send', nanos: 2, pad: 'x'.repeat(3000), vin: [{}], vout: [{ nanos: 2 }] };
    assert.ok(mempoolDepthBytes([fat]) > 2048);
    assert.ok(levyNeed(first, [fat]) > 100);
  });
});

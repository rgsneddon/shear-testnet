import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { levyNanos, txWeight, splitLevy, nextBaseFee, reserveFeeDest } from './levy.js';
import { isDestAddress, bech32Hrp } from './address.js';

describe('Flow levy', () => {
  it('charges base × weight and splits finder/Reserve', () => {
    assert.equal(txWeight({ vouts: 2, memoChunks: 1, bFlag: 1 }), 4);
    assert.equal(levyNanos(3, 4), 12);
    assert.deepEqual(splitLevy(12), { finder: 6, reserve: 6 });
    assert.deepEqual(splitLevy(1), { finder: 0, reserve: 1 });
    assert.equal(nextBaseFee(1, 8), 1);
    assert.ok(nextBaseFee(1, 32) > 1);
    assert.equal(bech32Hrp(reserveFeeDest()), 'ssa');
    assert.equal(isDestAddress(reserveFeeDest()), true);
  });
});

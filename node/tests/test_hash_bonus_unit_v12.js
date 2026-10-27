/**
 * The hash-bonus unit: a voted 0 is off, a malformed unit clamps to the floor.
 *
 * Split out of test_hash_bonus_cap.js, which is a PRHASH pending row (its
 * mining lanes wait on the native ShearHash thread-safety PR), so these cheap
 * checks stay in the full suite. No mining.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { SHARE_FLOOR_BITS, HASH_BONUS_NANOS_FLOOR } from '../../crypto/asert.js';
import { nonceWithShareTarget } from '../../crypto/share_batch.js';
import { hashBonusByMiner } from '../src/chain.js';

function destMiner() {
  return freshStealthDest(newIdentity()).dest;
}

describe('hash bonus unit: a voted 0 is off, a malformed unit clamps', () => {
  it('hashBonusByMiner pays 0 at unit 0 and the floor for a malformed unit', () => {
    const dest = destMiner();
    const unit = 2 ** SHARE_FLOOR_BITS;
    // Credit reads the nonce high byte. A bare nonce 1 has byte 0 and is dropped.
    const nonce = nonceWithShareTarget(1n, SHARE_FLOOR_BITS);
    // A passed down vote sets unit 0 and it stays 0 (cfe93bf5, HASH_BONUS_OFF=0).
    const zero = hashBonusByMiner([], 0, [{ dest, nonce, lz: SHARE_FLOOR_BITS }]);
    assert.equal(zero.get(dest), 0);
    const zeroBig = hashBonusByMiner([], 0n, [{ dest, nonce, lz: SHARE_FLOOR_BITS }]);
    assert.equal(zeroBig.get(dest), 0);
    const neg = hashBonusByMiner([], -9, [{ dest, nonce, lz: SHARE_FLOOR_BITS }]);
    assert.equal(neg.get(dest), unit * HASH_BONUS_NANOS_FLOOR);
    assert.ok(neg.get(dest) > 0);
    const junk = hashBonusByMiner([], 'x', [{ dest, nonce, lz: SHARE_FLOOR_BITS }]);
    assert.equal(junk.get(dest), unit * HASH_BONUS_NANOS_FLOOR);
  });
});

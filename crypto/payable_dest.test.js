import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDest, encodeAddress, encodeHrp, isDestAddress, isPayableDest, checkAddressField, newIdentity } from './address.js';
import { admitBasePub } from './admit.js';
import { pointBytes } from './note.js';

const FEE_DEST = 'ssa1q4ke8sdxgma3sstuf6h0lsqh08w0e8qqkf7mfv6';

function longDest(tag, seedByte) {
  const dest20 = Buffer.alloc(20, tag);
  const seed = Buffer.alloc(32, seedByte);
  seed[0] = tag;
  return encodeDest(dest20, pointBytes(admitBasePub(seed)));
}

describe('payable dest', () => {
  it('accepts any long ssa1 with a canonical B and refuses every short or bad form', () => {
    const tags = [0, 1, 7, 19, 255];
    const seeds = [1, 9, 40, 200];
    for (const tag of tags) {
      for (const seedByte of seeds) {
        const dest = longDest(tag, seedByte);
        assert.equal(isDestAddress(dest), true, dest);
        assert.equal(isPayableDest(dest), true, dest);
        assert.equal(checkAddressField(dest).ok, true);
      }
      const short = encodeDest(Buffer.alloc(20, tag));
      assert.equal(isDestAddress(short), true);
      assert.equal(isPayableDest(short), false);
      assert.equal(checkAddressField(short).ok, true);
    }
    const bad = encodeDest(Buffer.alloc(20, 3), Buffer.alloc(32, 1));
    assert.equal(isDestAddress(bad), true);
    assert.equal(isPayableDest(bad), false);
    const extra = Buffer.alloc(53, 2);
    extra.set(pointBytes(admitBasePub(Buffer.alloc(32, 5))), 20);
    const trailed = encodeHrp('ssa', extra);
    assert.equal(isPayableDest(trailed), false);
    const id = newIdentity();
    assert.equal(isPayableDest(id.address), false);
    assert.equal(isPayableDest(id.paymentCode), false);
    assert.equal(isPayableDest(''), false);
    assert.equal(isDestAddress(FEE_DEST), true);
    assert.equal(isPayableDest(FEE_DEST), false);
    assert.equal(checkAddressField(FEE_DEST).ok, true);
    assert.equal(isPayableDest(encodeAddress(Buffer.alloc(20, 4))), false);
  });
});

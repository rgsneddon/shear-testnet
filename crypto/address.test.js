import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDest, encodeAddress, encodeHrp, decodeBech32Payload, hash20FromAddress, admitBaseFromAddress, newIdentity, SHORT_ADDR_MAX, HRP_DEST } from './address.js';

describe('bech32 checksum (P0-2)', () => {
  it('valid dest decodes; single-char corruption rejects', () => {
    const dest20 = Buffer.alloc(20, 7);
    const good = encodeDest(dest20);
    assert.match(good, /^ssa1/);
    const got = decodeBech32Payload(good);
    assert.ok(got);
    assert.equal(got.subarray(0, 20).equals(dest20), true);
    assert.equal(hash20FromAddress(good).equals(dest20), true);
    const last = good[good.length - 1];
    const flip = last === 'q' ? 'p' : 'q';
    const bad = `${good.slice(0, -1)}${flip}`;
    assert.notEqual(bad, good);
    assert.equal(decodeBech32Payload(bad), null);
    assert.equal(hash20FromAddress(bad), null);
    assert.equal(decodeBech32Payload(good.slice(0, -2)), null);
    assert.equal(HRP_DEST, 'ssa');
  });

  it('public she1 / ssa1 / shear1 stay dest20-sized; long dest20||B still decodes', () => {
    const dest20 = Buffer.alloc(20, 7);
    const admit = Buffer.alloc(32, 9);
    const dest = encodeDest(dest20, admit);
    assert.match(dest, /^ssa1/);
    assert.ok(dest.length <= SHORT_ADDR_MAX, dest);
    assert.equal(admitBaseFromAddress(dest), null);
    assert.equal(hash20FromAddress(dest).equals(dest20), true);
    const long = encodeHrp('ssa', Buffer.concat([dest20, admit]));
    assert.ok(long.length > SHORT_ADDR_MAX, long);
    assert.ok(admitBaseFromAddress(long).equals(admit));
    assert.equal(hash20FromAddress(long).equals(dest20), true);
    const id = newIdentity();
    assert.match(id.paymentCode, /^she1/);
    assert.ok(id.paymentCode.length <= SHORT_ADDR_MAX, id.paymentCode);
    assert.ok(id.address.startsWith('shear1'));
    assert.ok(id.address.length <= 50, id.address);
    assert.ok(encodeAddress(dest20).length <= 50);
  });
});

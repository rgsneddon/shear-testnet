import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { byteContainer, canonicalEncode, canonicalHash } from './canonical_row.js';

describe('canonical tx body encoding', () => {
  const bytes = Buffer.from('00ab7f', 'hex');

  it('every byte container is one form', () => {
    const want = canonicalEncode(bytes);
    assert.equal(want, '{"$b":"00ab7f"}');
    assert.equal(canonicalEncode(new Uint8Array(bytes)), want, 'Uint8Array');
    assert.equal(canonicalEncode({ $hex: '00ab7f' }), want, 'p2p {$hex}');
    assert.equal(canonicalEncode(JSON.parse(JSON.stringify(bytes))), want, 'JSON {type:Buffer,data}');
    const view = new Uint8Array(Buffer.from('ff00ab7fee', 'hex').buffer, 1, 3);
    assert.equal(canonicalEncode(Buffer.from('ff00ab7fee', 'hex').subarray(1, 4)), want, 'a Buffer view');
    assert.equal(byteContainer(view).length, 3);
  });

  it('a string is its exact text: hex text is not bytes and case is kept', () => {
    assert.notEqual(canonicalEncode('00ab7f'), canonicalEncode(bytes), 'hex text is a string');
    assert.notEqual(canonicalEncode('00AB7F'), canonicalEncode('00ab7f'), 'case is kept');
    assert.notEqual(canonicalEncode({ $hex: '00AB7F' }), canonicalEncode(bytes), 'an upper-case {$hex} is not a byte frame');
  });

  it('keys are sorted, undefined is absent, bigints and numbers are distinct', () => {
    assert.equal(canonicalEncode({ b: 1, a: [2, { d: 3, c: undefined }] }), canonicalEncode({ a: [2, { d: 3 }], b: 1 }));
    assert.notEqual(canonicalEncode({ a: 1 }), canonicalEncode({ a: '1' }), 'number vs string');
    assert.notEqual(canonicalEncode({ a: 1n }), canonicalEncode({ a: 1 }), 'bigint vs number');
    assert.equal(canonicalEncode({ a: 1n }), '{"a":{"$big":"1"}}');
    assert.equal(canonicalEncode([undefined, NaN, Infinity]), '[null,null,null]', 'as JSON writes them');
    assert.notEqual(canonicalEncode({ a: null }), canonicalEncode({}), 'null is present, undefined is absent');
  });

  it('the hash is domain separated', () => {
    assert.notEqual(canonicalHash('one', { a: 1 }).toString('hex'), canonicalHash('two', { a: 1 }).toString('hex'));
    assert.equal(canonicalHash('one', { a: 1 }).length, 32);
  });
});

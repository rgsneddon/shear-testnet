import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { byteContainer, canonicalAliasPath, canonicalEncode, canonicalHash } from './canonical_row.js';
import { arrivalFieldRejected } from './arrival_fields.js';
import { admitMempool, emptyMempool } from './mempool.js';

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


describe('body-v2 has no aliases (Russell 26 Oct)', () => {
  const real = Buffer.from('00ab7f', 'hex');
  const body = (patch) => ({ kind: 'send', fee: 100, vin: [{ commit: Buffer.alloc(32, 1) }], vout: [{ kind: 'send', commit: Buffer.alloc(32, 2) }], ...patch });
  // Each shape and the value it would pass for.
  const shapes = [
    ['{$b}', { $b: real.toString('hex') }, real, 'vout[0].commit.$b', (v) => body({ vout: [{ kind: 'send', commit: v }] })],
    ['{$big}', { $big: '100' }, 100n, 'fee.$big', (v) => body({ fee: v })],
    ['NaN', Number.NaN, null, 'fee', (v) => body({ fee: v })],
    ['Infinity', Number.POSITIVE_INFINITY, null, 'fee', (v) => body({ fee: v })],
    ['-Infinity', Number.NEGATIVE_INFINITY, null, 'vin[0].index', (v) => body({ vin: [{ commit: Buffer.alloc(32, 1), index: v }] })],
  ];

  for (const [name, shape, twin, at, plant] of shapes) {
    it(`${name} encodes like another value, so it is refused on arrival and in the mempool`, () => {
      assert.equal(canonicalEncode(shape), canonicalEncode(twin), `${name} aliases`);
      const tx = plant(shape);
      assert.equal(canonicalAliasPath(tx), at);
      assert.deepEqual(arrivalFieldRejected(tx), { ok: false, reason: 'canonical_alias', field: at });
      const pooled = admitMempool(emptyMempool(), tx);
      assert.equal(pooled.ok, false);
      assert.equal(pooled.reason, 'canonical_alias');
      assert.equal(pooled.field, at);
    });
  }

  it('real bytes, a bigint, a finite number and the byte forms a frame carries are no alias', () => {
    const tx = body({ fee: 100n, vout: [{ kind: 'send', commit: { $hex: real.toString('hex') }, other: { type: 'Buffer', data: [...real] } }], height: 7 });
    assert.equal(canonicalAliasPath(tx), '');
    // A "$b" key beside another key encodes as itself, not as bytes.
    assert.notEqual(canonicalEncode({ $b: real.toString('hex'), x: 1 }), canonicalEncode(real));
    assert.equal(canonicalAliasPath({ $b: 'ab', x: 1 }), '');
  });
});

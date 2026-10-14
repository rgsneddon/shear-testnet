import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commit, pointBytes, proveRange, randomScalar, verifyRange } from './note.js';

const U64_MAX = (1n << 64n) - 1n;

/** Any u64, including values a JS number or a signed int64 cannot hold. */
const AMOUNTS = [
  0n,
  1n,
  256n,
  9007199254740991n,
  9007199254740993n,
  1n << 62n,
  1n << 63n,
  U64_MAX,
];

describe('range prove keeps any u64', () => {
  it('proves the decimal that was asked for', () => {
    for (const v of AMOUNTS) {
      const r = randomScalar();
      const proof = proveRange(v.toString(), r);
      assert.ok(proof && proof.length > 1 && proof[0] === 2, `proof ${v}`);
      const exact = pointBytes(commit(v, r));
      assert.equal(verifyRange(exact, proof), true, `open ${v}`);
      const neighbor = v === U64_MAX ? v - 1n : v + 1n;
      assert.equal(verifyRange(pointBytes(commit(neighbor, r)), proof), false, `neighbor ${v}`);
    }
    const r = randomScalar();
    assert.equal(proveRange((U64_MAX + 1n).toString(), r).length, 0);
    assert.equal(proveRange('-1', r).length, 0);
    assert.equal(proveRange('1.5', r).length, 0);
    assert.equal(proveRange(' 1', r).length, 0);
    assert.equal(verifyRange(pointBytes(commit(256n, r)), proveRange(256, r)), true);
  });
});

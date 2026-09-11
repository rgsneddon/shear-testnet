import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomScalar } from './note.js';
import { fcmpPub, proveFcmp, verifyFcmp, keyImage } from './fcmp.js';

describe('FCMP full-chain membership', () => {
  it('proves one spend in the full set; a sampled subset is the wrong set', () => {
    const n = 8;
    const xs = Array.from({ length: n }, () => randomScalar());
    const pubs = xs.map(fcmpPub);
    const index = 3;
    const proof = proveFcmp({ x: xs[index], index, pubs });
    assert.equal(verifyFcmp(proof, pubs), true);
    assert.equal(verifyFcmp(proof, pubs.slice(0, 4)), false);
    const other = proveFcmp({ x: xs[0], index: 0, pubs });
    assert.equal(Buffer.from(proof.keyImage).equals(Buffer.from(other.keyImage)), false);
    const I = keyImage(xs[index], pubs[index]);
    assert.equal(Buffer.from(proof.keyImage).equals(Buffer.from(I.toBytes())), true);
  });
});

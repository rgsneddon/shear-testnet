import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomScalar } from './note.js';
import { admitPub, admitProve, admitVerify, spendTag, jroot } from './admit.js';

describe('Admit v1 fluxset membership', () => {
  it('proves a spend is admissible in the fluxset; a sampled subset is the wrong set', () => {
    const n = 8;
    const xs = Array.from({ length: n }, () => randomScalar());
    const fluxset = xs.map(admitPub);
    const index = 3;
    const admit_proof = admitProve({ x: xs[index], index, pubs: fluxset });
    assert.equal(admit_proof.admit_proof, true);
    assert.equal(admitVerify(admit_proof, fluxset), true);
    assert.equal(admitVerify(admit_proof, fluxset.slice(0, 4)), false);
    const other = admitProve({ x: xs[0], index: 0, pubs: fluxset });
    assert.equal(Buffer.from(admit_proof.spendTag).equals(Buffer.from(other.spendTag)), false);
    const tag = spendTag(xs[index], fluxset[index]);
    assert.equal(Buffer.from(admit_proof.spendTag).equals(Buffer.from(tag.toBytes())), true);
    const root = Buffer.from(jroot(fluxset));
    const otherRoot = Buffer.from(jroot(fluxset.slice(0, 4)));
    assert.equal(root.length, 32);
    assert.equal(root.equals(otherRoot), false);
  });
});

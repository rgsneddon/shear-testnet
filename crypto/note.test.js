import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  commit, proveValue, verifyValue, proveRange, verifyRange,
  sealNote, verifySealedNote, verifyMintSum, excessOf, randomScalar,
  noteCommitOfDest20, G, H,
} from './note.js';

describe('Pedersen notes', () => {
  it('opens an exact public value and rejects a wrong value', () => {
    const r = randomScalar();
    const proof = proveValue(256, r);
    assert.equal(verifyValue(proof.C, 256, proof), true);
    assert.equal(verifyValue(proof.C, 255, proof), false);
    const C = commit(256, r);
    const range = proveRange(256, r);
    assert.equal(verifyRange(proof.C, range), true);
    assert.equal(C.toBytes().length, 32);
    assert.ok(!G.equals(H));
  });

  it('seals two hasher notes; mint sum matches units; dest20 is not the commit', () => {
    const dA = Buffer.alloc(20, 1);
    const dB = Buffer.alloc(20, 2);
    const a = sealNote(256, { dest20: dA, kind: 'hash' });
    const b = sealNote(256, { dest20: dB, kind: 'hash' });
    assert.equal(verifySealedNote(a, 256), true);
    assert.equal(verifySealedNote(b, 256), true);
    assert.equal(verifySealedNote(a, 512), false);
    assert.equal(a.noteCommit.equals(noteCommitOfDest20(dA)), true);
    assert.equal(a.noteCommit.equals(dA), false);
    const excess = excessOf([a, b]);
    assert.equal(verifyMintSum([a, b], 512, excess), true);
    assert.equal(verifyMintSum([a, b], 256, excess), false);
  });
});

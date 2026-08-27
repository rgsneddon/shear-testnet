import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDualTree, spendB, bProof } from './clearing.js';
import { encodeHeader } from './header.js';
import { EMPTY_ROOT } from './merkle.js';

const dest20 = Buffer.alloc(20, 7);

function sealedHeader(tree) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: EMPTY_ROOT,
    continuityRoot: tree.continuityRoot,
    timestamp: 1n,
    bits: 14,
    nonce: 0n,
    baseFee: 1n,
  });
}

describe('B-spend against shipped spendB', () => {
  const leaf = { dest20, unit: 9, nonce: 1, memoH: Buffer.alloc(32), tag: 'b' };

  it('rejects spend before the committing block is accepted (pre-seal)', () => {
    const tree = buildDualTree({ aLeaves: [{ dest20, count: 1 }], bLeaves: [leaf] });
    const header = sealedHeader(tree);
    const proof = bProof([leaf], 0);
    const pre = spendB({
      leaf,
      proof,
      header,
      rootA: tree.rootA,
      rootB: tree.rootB,
      height: 4,
      index: 0,
      tipHeight: 3,
      spent: new Set(),
    });
    assert.equal(pre.ok, false);
    assert.equal(pre.reason, 'pre_seal');
  });

  it('accepts spend after the committing header with a valid B proof', () => {
    const tree = buildDualTree({ aLeaves: [{ dest20, count: 1 }], bLeaves: [leaf] });
    const header = sealedHeader(tree);
    const proof = bProof([leaf], 0);
    const got = spendB({
      leaf,
      proof,
      header,
      rootA: tree.rootA,
      rootB: tree.rootB,
      height: 4,
      index: 0,
      tipHeight: 4,
      spent: new Set(),
    });
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.unit, 9);
  });

  it('rejects double-open of the same B unit', () => {
    const tree = buildDualTree({ aLeaves: [{ dest20, count: 1 }], bLeaves: [leaf] });
    const header = sealedHeader(tree);
    const proof = bProof([leaf], 0);
    const spent = new Set();
    const first = spendB({
      leaf,
      proof,
      header,
      rootA: tree.rootA,
      rootB: tree.rootB,
      height: 4,
      index: 0,
      tipHeight: 5,
      spent,
    });
    assert.equal(first.ok, true, first.reason);
    const twice = spendB({
      leaf,
      proof,
      header,
      rootA: tree.rootA,
      rootB: tree.rootB,
      height: 4,
      index: 0,
      tipHeight: 6,
      spent,
    });
    assert.equal(twice.ok, false);
    assert.equal(twice.reason, 'double_open');
  });
});

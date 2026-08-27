import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  packALeaf,
  packBLeaf,
  packTx,
  packDigest,
  unpackALeaf,
  unpackBLeaf,
  ENC_MAGIC,
} from './pack.js';
import { aLeafBytes, bLeafBytes, buildDualTree, spendB, bProof } from './clearing.js';
import { encodeHeader } from './header.js';
import { EMPTY_ROOT } from './merkle.js';

const dest20 = Buffer.alloc(20, 7);

describe('shear-enc-v1 pack', () => {
  it('packs A/B/tx and matches frozen digests', () => {
    const a = packALeaf({ dest20, count: 3 });
    assert.equal(a.subarray(0, 12).equals(ENC_MAGIC), true);
    assert.equal(packDigest(a).toString('hex'), 'f1e4aa9bf56bfdd19c0a60b2e6dd0b8c4f0d58e7df87ed631673a646a55a8774');
    const round = unpackALeaf(a);
    assert.equal(Number(round.count), 3);
    assert.ok(round.dest20.equals(dest20));

    const b = packBLeaf({ dest20, unit: 1, nonce: 2, memoH: Buffer.alloc(32, 9), tag: 'b-spend' });
    assert.equal(packDigest(b).toString('hex'), '693ca5f2fc44619b8b20fe2df4de76477c7c3120aa1f86a788eb0fe89e979e12');
    const br = unpackBLeaf(b);
    assert.equal(Number(br.unit), 1);
    assert.equal(br.tag, 'b-spend');

    const tx = packTx({
      vins: [{ prev: Buffer.alloc(32, 1), index: 0, dest20 }],
      vouts: [{ dest20, nanos: 5, kind: 0 }],
    });
    assert.equal(packDigest(tx).toString('hex'), '016143271e11c70f09a73dd9a245738ba81a59ad08a020cc6f260a5bff6e16cd');
  });
});

describe('dual continuity_root', () => {
  it('is H(rootA||rootB) and B-spend waits for seal', () => {
    const dual = buildDualTree({ aLeaves: [{ dest20, count: 3 }], bLeaves: [] });
    assert.equal(dual.rootA.toString('hex'), aLeafBytes({ dest20, count: 3 }).toString('hex'));
    assert.equal(dual.continuityRoot.toString('hex'), '1a3fa5248cce6f8e9fecb110e67610255a937041c73e58691159b19b571f2206');

    const leaf = { dest20, unit: 9, nonce: 1, memoH: Buffer.alloc(32), tag: 'b' };
    const tree = buildDualTree({ aLeaves: [{ dest20, count: 1 }], bLeaves: [leaf] });
    const header = encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: EMPTY_ROOT,
      continuityRoot: tree.continuityRoot,
      timestamp: 1n,
      bits: 14,
      nonce: 0n,
      baseFee: 1n,
    });
    const proof = bProof([leaf], 0);
    const pre = spendB({
      leaf, proof, header, rootA: tree.rootA, rootB: tree.rootB, height: 1, index: 0, tipHeight: 0, spent: new Set(),
    });
    assert.equal(pre.ok, false);
    assert.equal(pre.reason, 'pre_seal');
    const spent = new Set();
    const ok = spendB({
      leaf, proof, header, rootA: tree.rootA, rootB: tree.rootB, height: 1, index: 0, tipHeight: 7, spent,
    });
    assert.equal(ok.ok, true);
    const twice = spendB({
      leaf, proof, header, rootA: tree.rootA, rootB: tree.rootB, height: 1, index: 0, tipHeight: 8, spent,
    });
    assert.equal(twice.ok, false);
    assert.equal(twice.reason, 'double_open');
  });
});

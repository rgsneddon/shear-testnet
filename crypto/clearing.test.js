import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDualTree, spendB, bProof } from './clearing.js';
import { encodeHeader } from './header.js';
import { EMPTY_ROOT } from './merkle.js';
import { SPENDABLE_CONFIRMATIONS } from './asert.js';

const dest20 = Buffer.alloc(20, 7);
const HEIGHTS = [1, 4];
const UNITS = [1, 9, 2 ** 20];

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

function callSpend(leaf, height, tipHeight, spent) {
  const tree = buildDualTree({ aLeaves: [{ dest20, count: 1 }], bLeaves: [leaf] });
  const header = sealedHeader(tree);
  const proof = bProof([leaf], 0);
  return spendB({
    leaf,
    proof,
    header,
    rootA: tree.rootA,
    rootB: tree.rootB,
    height,
    index: 0,
    tipHeight,
    spent,
  });
}

describe('B-spend against shipped spendB', () => {
  it('rejects spend before the committing block is accepted (pre-seal)', () => {
    assert.equal(SPENDABLE_CONFIRMATIONS >= 1, true);
    for (const height of HEIGHTS) {
      for (const unit of UNITS) {
        const leaf = { dest20, unit, nonce: 1, memoH: Buffer.alloc(32), tag: 'b' };
        const pre = callSpend(leaf, height, height - 1, new Set());
        assert.equal(pre.ok, false, `${height} ${unit}`);
        assert.equal(pre.reason, 'pre_seal', `${height} ${unit} ${pre.reason}`);
      }
    }
  });

  it('accepts a canonical spend once confirmations reach the floor', () => {
    for (const height of HEIGHTS) {
      for (const unit of UNITS) {
        const leaf = { dest20, unit, nonce: height, memoH: Buffer.alloc(32), tag: 'b' };
        const immatureTip = height + SPENDABLE_CONFIRMATIONS - 2;
        const matureTip = height + SPENDABLE_CONFIRMATIONS - 1;
        assert.equal(immatureTip - height + 1, SPENDABLE_CONFIRMATIONS - 1);
        assert.equal(matureTip - height + 1, SPENDABLE_CONFIRMATIONS);
        const early = callSpend(leaf, height, immatureTip, new Set());
        assert.equal(early.ok, false, `${height} ${unit}`);
        assert.equal(early.reason, 'immature', `${height} ${unit} ${early.reason}`);
        const got = callSpend(leaf, height, matureTip, new Set());
        assert.equal(got.ok, true, `${height} ${unit} ${got.reason}`);
        assert.equal(got.unit, unit);
      }
    }
  });

  it('rejects double-open of the same B unit once the floor is met', () => {
    for (const height of HEIGHTS) {
      for (const unit of UNITS) {
        const leaf = { dest20, unit, nonce: 1, memoH: Buffer.alloc(32), tag: 'b' };
        const matureTip = height + SPENDABLE_CONFIRMATIONS - 1;
        const spent = new Set();
        const first = callSpend(leaf, height, matureTip, spent);
        assert.equal(first.ok, true, `${height} ${unit} ${first.reason}`);
        const twice = callSpend(leaf, height, matureTip, spent);
        assert.equal(twice.ok, false, `${height} ${unit}`);
        assert.equal(twice.reason, 'double_open', `${height} ${unit} ${twice.reason}`);
      }
    }
  });
});

// R39 + R28 (Russell 28 Oct, ruling 9): a block carries at most
// MAX_SHARES_PER_BLOCK shares, each at or above the floor its own bits set,
// max(SHARE_FLOOR_BITS, ceil(B) - SHARE_FLOOR_SPAN_BITS). The template seats
// the widest shares when more qualify and writes them in canonical order;
// verify refuses a narrower share (share_target) and a longer batch
// (share_cap). Share PoW is real ShearHash-v3.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { shareSlotRoot } from '../../crypto/pack.js';
import {
  GENESIS_BITS_PACKED,
  MAX_SHARES_PER_BLOCK,
  SHARE_FLOOR_BITS,
  SHARE_FLOOR_SPAN_BITS,
  packBits,
  shareFloorBits,
} from '../../crypto/asert.js';
import { compareBluShares } from '../../crypto/share_batch.js';
import { GENESIS_PREV, bluTemplateBatch, buildTemplate, digestTx, verifyBlock } from '../src/chain.js';
import { bluWallet, mineBluShare } from './support/blunote_mine.js';
import { oneTimeKey } from '../../crypto/blunote.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const MINER = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const NOW = 1_700_000_000_000;

/** A trusted PoW tag that meets any block target here (zero high bytes). */
function powTag(n) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(n, 28);
  return h;
}

function feeKey() {
  const k = oneTimeKey(bluWallet());
  return { R: k.R, P: k.P, viewTag: k.tag };
}

function asBlock(tpl, hash) {
  return {
    header: tpl.header, txs: tpl.txs, samples: tpl.samples || [], shareBatch: tpl.shareBatch || [],
    miner: tpl.miner, aLeaves: tpl.aLeaves, bLeaves: tpl.bLeaves, rootA: tpl.rootA, rootB: tpl.rootB,
    weight: tpl.weight, hash, height: tpl.height,
  };
}

function restamp(block, shares) {
  const txs = block.txs.map((tx, i) => (i === 0 ? { ...tx, shareSlotRoot: shareSlotRoot(shares) } : tx));
  const decoded = decodeHeader(Buffer.from(block.header));
  decoded.merkleRoot = merkleRoot(txs.map(digestTx));
  return { ...block, txs, shareBatch: shares, header: encodeHeader(decoded) };
}

function genesis() {
  const tpl = buildTemplate({ prev: GENESIS_PREV, height: 1, miner: MINER, bits: GENESIS_BITS_PACKED, now: NOW, feeKey: feeKey(), feeBps: 100 });
  const hash = Buffer.alloc(32);
  hash.writeUInt32LE(1, 4);
  return asBlock(tpl, hash);
}

function childTpl(parent, shareBatch) {
  return buildTemplate({
    prev: parent.hash, prevHeader: parent.header, prevBlock: parent, parentBlocks: [parent], height: 2,
    miner: MINER, bits: GENESIS_BITS_PACKED, now: NOW + 90_000, shareBatch, feeKey: feeKey(), feeBps: 100,
  });
}

describe('R39: share cap and floor', () => {
  it('the floor follows ceil(block bits) and never drops below SHARE_FLOOR_BITS', () => {
    assert.equal(MAX_SHARES_PER_BLOCK, 256);
    assert.equal(SHARE_FLOOR_SPAN_BITS, 7);
    assert.equal(shareFloorBits(GENESIS_BITS_PACKED), 10, 'genesis bits 17');
    assert.equal(shareFloorBits(17), 10);
    assert.equal(shareFloorBits(packBits(17.25)), 11, 'fractional bits round up');
    assert.equal(shareFloorBits(packBits(30)), 23);
    assert.equal(shareFloorBits(12), SHARE_FLOOR_BITS);
    assert.equal(shareFloorBits(4), SHARE_FLOOR_BITS);
    // Expected floor-width shares per block from the whole network, 2^(B - floor), is at most 128.
    for (const b of [9, 15, 15.01, 17, 17.5, 17.99, 24, 31.7, 40]) {
      const floor = shareFloorBits(packBits(b));
      assert.ok(2 ** (b - floor) <= 2 ** SHARE_FLOOR_SPAN_BITS, `B=${b} floor ${floor}`);
    }
  });

  it('the template seats only shares at the floor, widest first under a cap, in canonical order', () => {
    const g = genesis();
    const floor = shareFloorBits(decodeHeader(Buffer.from(g.header)).bits);
    const miner = bluWallet();
    const narrow = mineBluShare(miner, g.header, { bits: floor - 1 });
    const atFloor = [mineBluShare(miner, g.header), mineBluShare(miner, g.header)];
    const wide = mineBluShare(miner, g.header, { bits: floor + 2 });
    const rows = [narrow, ...atFloor, wide];
    const all = bluTemplateBatch(rows, null, { floorBits: floor });
    assert.equal(all.length, 3, 'the narrow share is never seated');
    assert.ok(!all.includes(narrow));
    const sorted = all.slice().sort(compareBluShares);
    assert.deepEqual(all, sorted, 'canonical order');
    const two = bluTemplateBatch(rows, null, { floorBits: floor, cap: 2 });
    assert.equal(two.length, 2);
    assert.ok(two.includes(wide), 'the widest share is seated first');
    // The real template drops the narrow share and its block verifies.
    const tpl = childTpl(g, rows);
    assert.equal(tpl.shareBatch.length, 3);
    const ok = verifyBlock(asBlock(tpl, powTag(7)), g, { trustedPowHash: powTag(7), nowMs: NOW + 90_000 });
    assert.equal(ok.ok, true, ok.reason);
  });

  it('verify refuses a share below the block floor, and a batch past the cap before any hash', () => {
    const g = genesis();
    const floor = shareFloorBits(decodeHeader(Buffer.from(g.header)).bits);
    const miner = bluWallet();
    const good = mineBluShare(miner, g.header);
    const narrow = mineBluShare(miner, g.header, { bits: floor - 1 });
    const tpl = childTpl(g, [good]);
    // A block that names the narrow share as well: same template, its batch widened by hand.
    // Slot root and merkle root restamped, so only the floor is wrong.
    const forced = restamp(asBlock(tpl, powTag(8)), [good, narrow].sort(compareBluShares));
    const bad = verifyBlock(forced, g, { trustedPowHash: powTag(8), nowMs: NOW + 90_000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'share_target');
    const over = restamp(asBlock(tpl, powTag(8)), Array.from({ length: MAX_SHARES_PER_BLOCK + 1 }, () => good));
    const capped = verifyBlock(over, g, { trustedPowHash: powTag(8), nowMs: NOW + 90_000 });
    assert.equal(capped.ok, false);
    assert.equal(capped.reason, 'share_cap');
  });
});

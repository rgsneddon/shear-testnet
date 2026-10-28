// A share is credited 2^b only when the nonce's high byte, the frame's claim
// and the digest agree. R28: shares are BluNotes frames (one-time key, nonce
// bound to it), the target is on the RandomX digest itself, and the per-payee
// pro-rata pot is replaced by the per-block draw (D1, D2). Digests are
// stashed as the prepared RandomX output for each header and nonce; real
// ShearHash coverage of the same rules is in test_r28_share_rules.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { decodeHeader, encodeHeader, setNonce } from '../../crypto/header.js';
import {
  GENESIS_BITS_PACKED,
  MAX_HASH_UNITS_PER_BLOCK,
  SAMPLE_PRUNE_CONFIRMATIONS,
  SHARE_FLOOR_BITS,
  shareFloorBits,
  asertNextBits,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { leadingZeroBits, meetsTarget } from '../../crypto/shear_hash.js';
import {
  clearLiveSharePow,
  compareBluShares,
  creditBitsForShare,
  rememberLiveSharePow,
  shareTargetByte,
  stashSharePow,
  unitsForShare,
  verifyShareBatch,
} from '../../crypto/share_batch.js';
import { bindNonce, oneTimeKey } from '../../crypto/blunote.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { shareSlotRoot } from '../../crypto/pack.js';
import { GENESIS_PREV, buildTemplate, digestTx, verifyBlock } from '../src/chain.js';
import { blunoteSettle } from '../src/blunote_payout.js';
import { bluWallet } from './support/blunote_mine.js';

const MINER = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';

function parentHeader() {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: 1_700_000_000_000,
    bits: GENESIS_BITS_PACKED,
  });
}

/**
 * A digest whose leading zeros are exactly `bits`, without ShearHash: hashed
 * candidates hit an exact width about once in 2^(bits+1) draws.
 */
function rxExact(bits, seed = 0) {
  const limit = Math.min(1 << 24, Math.max(1 << 16, 2 ** (bits + 1) * 16));
  const tag = Buffer.alloc(8);
  tag.writeUInt32LE(seed >>> 0, 0);
  for (let i = 0; i < limit; i += 1) {
    tag.writeUInt32LE(i, 4);
    const rx = createHash('sha256').update('shear-test-rx').update(tag).digest();
    if (meetsTarget(rx, bits) && !meetsTarget(rx, bits + 1)) return rx;
  }
  return null;
}

/** A BluNotes share for `owner` claiming width `bits`, its nonce bound on `header`. */
function shareAt(owner, header, bits, counter = 0, { claim = true } = {}) {
  const k = oneTimeKey(owner);
  return {
    shareR: k.R,
    shareP: k.P,
    viewTag: k.tag,
    nonce: bindNonce(header, k.R, k.P, counter, bits),
    lz: bits & 0xff,
    ...(claim ? { shareBits: bits } : {}),
    proofSlot: 0,
  };
}

describe('v12 share credit is the nonce high byte', () => {
  it('rejects any claim that is not the committed byte, at every illegal width', () => {
    const owner = bluWallet();
    const parent = parentHeader();
    const maxB = shareCreditMaxBits();
    assert.equal(maxB, Math.min(52, Math.floor(Math.log2(MAX_HASH_UNITS_PER_BLOCK))));
    const illegal = [0, 1, SHARE_FLOOR_BITS - 1, maxB + 1, 30, 52, 255];
    for (const bits of illegal) {
      const row = shareAt(owner, parent, bits);
      assert.equal(shareTargetByte(row.nonce), bits & 0xff);
      const got = verifyShareBatch({ parentHeader: parent, shares: [row], skipPow: true });
      assert.equal(got.ok, false, `byte ${bits}`);
      assert.equal(got.reason, 'share_target');
      assert.equal(creditBitsForShare(row).ok, false);
    }
    // A nonce with no width byte, claimed at the floor or above.
    const k = oneTimeKey(owner);
    const unstamped = { shareR: k.R, shareP: k.P, viewTag: 0, nonce: 1n, lz: SHARE_FLOOR_BITS, shareBits: SHARE_FLOOR_BITS, proofSlot: 0 };
    assert.equal(shareTargetByte(unstamped.nonce), 0);
    assert.equal(verifyShareBatch({ parentHeader: parent, shares: [unstamped], skipPow: true }).reason, 'share_target');
    assert.equal(verifyShareBatch({ parentHeader: parent, shares: [{ ...unstamped, shareBits: SHARE_FLOOR_BITS + 4 }], skipPow: true }).reason, 'share_target');
  });

  it('credits 2^b only when the byte, the packed claim, and the digest agree', () => {
    const owner = bluWallet();
    const parent = parentHeader();
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, SHARE_FLOOR_BITS + 4, 16];
    for (const bits of widths) {
      const row = shareAt(owner, parent, bits, 7);
      const rx = rxExact(bits);
      assert.ok(rx, `digest at ${bits}`);
      assert.equal(leadingZeroBits(rx), bits);
      const header = setNonce(parent, row.nonce);
      clearLiveSharePow();
      stashSharePow(header, rx);
      const cold = verifyShareBatch({ parentHeader: parent, shares: [row] });
      assert.equal(cold.ok, true, `${bits} ${cold.reason}`);
      assert.equal(cold.units, unitsForShare(bits));
      const relabel = verifyShareBatch({ parentHeader: parent, shares: [{ ...row, shareBits: bits + 1 }] });
      assert.equal(relabel.reason, 'share_target');
      const low = rxExact(bits - 1, 1);
      assert.ok(low, `digest below ${bits}`);
      stashSharePow(header, low);
      const miss = verifyShareBatch({ parentHeader: parent, shares: [{ ...row, lz: bits - 1 }] });
      assert.equal(miss.reason, 'share_pow');
      assert.equal(rememberLiveSharePow(parent, row.nonce, { noteCommit: row.shareP, shareBits: bits, lz: bits }), true);
      const hot = verifyShareBatch({ parentHeader: parent, shares: [row], skipPow: true });
      assert.equal(hot.ok, true, hot.reason);
      assert.equal(hot.units, cold.units);
      clearLiveSharePow();
      const wiped = verifyShareBatch({ parentHeader: parent, shares: [row], skipPow: true });
      assert.equal(wiped.reason, 'share_pow');
    }
    // A frame that omits its claim is read at the floor, and only the floor.
    const omit = shareAt(owner, parent, SHARE_FLOOR_BITS, 11, { claim: false });
    clearLiveSharePow();
    stashSharePow(setNonce(parent, omit.nonce), rxExact(SHARE_FLOOR_BITS, 2));
    const omitOk = verifyShareBatch({ parentHeader: parent, shares: [omit] });
    assert.equal(omitOk.ok, true, omitOk.reason);
    assert.equal(omitOk.units, unitsForShare(SHARE_FLOOR_BITS));
    const omitHigh = shareAt(owner, parent, SHARE_FLOOR_BITS + 4, 12, { claim: false });
    assert.equal(verifyShareBatch({ parentHeader: parent, shares: [omitHigh], skipPow: true }).reason, 'share_target');
  });

  it('a batch credits its committed units for any miner count, and the draw conserves them', () => {
    const maxB = shareCreditMaxBits();
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 4, 16, 20];
    const parent = parentHeader();
    for (const nOwner of [1, 2, 8]) {
      const owners = Array.from({ length: nOwner }, () => bluWallet());
      const batch = [];
      owners.forEach((owner, i) => {
        const bits = widths[i % widths.length];
        for (let c = 0; c < 1 + (i % 3); c += 1) batch.push(shareAt(owner, parent, bits, c));
      });
      batch.sort(compareBluShares);
      clearLiveSharePow();
      for (const row of batch) stashSharePow(setNonce(parent, row.nonce), rxExact(row.shareBits, Number(row.nonce & 0xffffn)));
      const got = verifyShareBatch({ parentHeader: parent, shares: batch });
      assert.equal(got.ok, true, got.reason);
      const raw = batch.reduce((n, row) => n + unitsForShare(shareTargetByte(row.nonce)), 0);
      assert.equal(got.units, raw, `owners ${nOwner}`);
      for (const subsidy of [10_000n, 100_000_003n]) {
        for (const budget of [null, 1n << 20n]) {
          const s = blunoteSettle({ shares: got.shares, powHash: randomBytes(32), potPayable: subsidy, unitNanos: 1n, budgetNanos: budget });
          assert.equal(s.minted + s.carryOut + s.reserveExtra, subsidy + s.hashNanos);
          assert.equal(s.hashNanos, budget == null ? BigInt(raw) : (BigInt(raw) < budget ? BigInt(raw) : budget));
        }
      }
    }
    // Out of order is refused, so a batch has exactly one valid order.
    const two = [shareAt(bluWallet(), parent, SHARE_FLOOR_BITS), shareAt(bluWallet(), parent, SHARE_FLOOR_BITS)].sort(compareBluShares);
    assert.equal(verifyShareBatch({ parentHeader: parent, shares: [two[1], two[0]], skipPow: true }).reason, 'share_order');
    // Past the credit cap is refused, not clamped.
    assert.equal(verifyShareBatch({ parentHeader: parent, shares: [shareAt(bluWallet(), parent, maxB + 2)], skipPow: true }).reason, 'share_target');
  });

  it('a buried prune still rejects a share whose nonce byte is illegal', () => {
    const genesisMs = 1_700_000_000_000;
    function trustedPow(tag) {
      const h = Buffer.alloc(32);
      h[31] = tag & 0xff;
      return h;
    }
    function viewOf(block, hash, height) {
      return { hash, header: block.header, txs: block.txs, height, weight: block.weight, bLeaves: block.bLeaves, blunoteRecord: block.blunoteRecord };
    }
    function bitsAt(parentHdr, childNow, childHeight) {
      const ph = decodeHeader(parentHdr);
      const quote = asertNextBits({
        anchorBits: GENESIS_BITS_PACKED,
        anchorTimeMs: genesisMs,
        anchorHeight: 1,
        blockTimeMs: childNow,
        blockHeight: childHeight,
        parentTimeMs: Number(ph.timestamp),
      });
      assert.equal(quote.ok, true, quote.reason || 'asert');
      return quote.packed;
    }
    function sealEmpty(prev, prevHash, height, now, tag, parents) {
      const tpl = buildTemplate({
        prev: height === 1 ? GENESIS_PREV : prevHash,
        prevHeader: prev?.header,
        prevBlock: prev,
        height,
        miner: MINER,
        bits: height === 1 ? GENESIS_BITS_PACKED : bitsAt(prev.header, now, height),
        now,
      });
      const block = {
        header: tpl.header, txs: tpl.txs, samples: tpl.samples, shareBatch: tpl.shareBatch || [],
        aLeaves: tpl.aLeaves, bLeaves: tpl.bLeaves, weight: tpl.weight, height,
      };
      const pow = trustedPow(tag);
      const res = verifyBlock(block, prev ? viewOf(prev, prevHash, height - 1) : null, {
        trustedPowHash: pow,
        genesisMs,
        ...(Array.isArray(parents) ? { supplyParents: parents } : {}),
      });
      assert.equal(res.ok, true, `h=${height} ${res.reason}`);
      block.hash = res.hash;
      block.blunoteRecord = res.blunoteRecord;
      return { block, hash: res.hash, pow };
    }
    function restamp(block, shares) {
      block.shareBatch = shares;
      block.txs[0].shareSlotRoot = shareSlotRoot(shares);
      const decoded = decodeHeader(block.header);
      decoded.merkleRoot = merkleRoot(block.txs.map(digestTx));
      block.header = encodeHeader(decoded);
    }
    const owner = bluWallet();
    const g = sealEmpty(null, null, 1, genesisMs, 1);
    const mid = sealEmpty(g.block, g.hash, 2, genesisMs + 90_000, 2);
    const child = sealEmpty(mid.block, mid.hash, 3, genesisMs + 180_000, 3, [g.block, mid.block]);
    child.block.samplesPruned = true;
    const parentView = viewOf(mid.block, mid.hash, mid.block.height);
    const burialTip = child.block.height + SAMPLE_PRUNE_CONFIRMATIONS;
    const swapped = [shareAt(owner, mid.block.header, 0)];
    child.block.shareBatch = swapped;
    const unbound = verifyBlock(child.block, parentView, { trustedPowHash: child.pow, skipSharePow: true, genesisMs, burialTip });
    assert.equal(unbound.ok, false);
    assert.equal(unbound.reason, 'share_slot');
    restamp(child.block, swapped);
    const buried = verifyBlock(child.block, parentView, { trustedPowHash: child.pow, skipSharePow: true, genesisMs, burialTip });
    assert.equal(buried.ok, false);
    assert.equal(buried.reason, 'share_target');
    // R39: the block's own floor (genesis-schedule bits).
    restamp(child.block, [shareAt(owner, mid.block.header, shareFloorBits(decodeHeader(child.block.header).bits), 4)]);
    clearLiveSharePow();
    const unproven = verifyBlock(child.block, parentView, { trustedPowHash: child.pow, skipSharePow: true, genesisMs, burialTip });
    assert.equal(unproven.reason, 'share_pow');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader, setNonce } from '../../crypto/header.js';
import {
  GENESIS_BITS_PACKED,
  MAX_HASH_UNITS_PER_BLOCK,
  SAMPLE_PRUNE_CONFIRMATIONS,
  SHARE_FLOOR_BITS,
  asertNextBits,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  clearLiveSharePow,
  creditBitsForShare,
  destBoundShareHash,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
  retainedUnitsByCommit,
  shareTargetByte,
  stashSharePow,
  unitsForShare,
  verifyShareBatch,
} from '../../crypto/share_batch.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { shareSlotRoot } from '../../crypto/pack.js';
import { GENESIS_PREV, buildTemplate, digestTx, potSharesFromBatch, verifyBlock } from '../src/chain.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

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
 * A dest-bound digest that meets `meet` and misses `miss`, without ShearHash.
 * A one-bit band at width b lands about once in 2^(b+1) draws. Eight expected
 * hits keeps a miss under a percent at every width this file uses.
 */
function rxForBits(noteCommit, meet, miss) {
  const width = Math.max(1, Math.floor(Number(meet) || 1));
  const band = miss == null ? width : width + 1;
  const span = band >= 31 ? Number.MAX_SAFE_INTEGER : (2 ** band);
  const limit = Math.min(2_000_000, Math.max(20_000, span * 8));
  for (let i = 0; i < limit; i += 1) {
    const rx = Buffer.alloc(32);
    rx.writeUInt32LE(i, 0);
    rx.writeUInt32LE((i * 17) >>> 0, 4);
    const bound = destBoundShareHash(rx, noteCommit);
    const highEnough = meetsTarget(bound, meet);
    const notHigher = miss == null || !meetsTarget(bound, miss);
    if (highEnough && notHigher) return rx;
  }
  return null;
}

function shareAt(dest, low, bits) {
  return {
    dest,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    proofSlot: 0,
  };
}

describe('v12 share credit is the nonce high byte', () => {
  it('rejects any claim that is not the committed byte, at every illegal width', () => {
    const dest = minerDest();
    const parent = parentHeader();
    const maxB = shareCreditMaxBits();
    assert.equal(maxB, Math.min(52, Math.floor(Math.log2(MAX_HASH_UNITS_PER_BLOCK))));
    const illegal = [0, 1, SHARE_FLOOR_BITS - 1, maxB + 1, 30, 52, 255];
    for (const bits of illegal) {
      const row = shareAt(dest, 1n, bits);
      assert.equal(shareTargetByte(row.nonce), bits & 0xff);
      const got = verifyShareBatch({ parentHeader: parent, shares: [row], skipPow: true });
      assert.equal(got.ok, false, `byte ${bits}`);
      assert.equal(got.reason, 'share_target');
      assert.equal(creditBitsForShare(row).ok, false);
    }
    const unstamped = { dest, nonce: 1n, lz: SHARE_FLOOR_BITS, shareBits: SHARE_FLOOR_BITS };
    assert.equal(shareTargetByte(unstamped.nonce), 0);
    const floorLie = verifyShareBatch({ parentHeader: parent, shares: [unstamped], skipPow: true });
    assert.equal(floorLie.reason, 'share_target');
    const raised = verifyShareBatch({
      parentHeader: parent,
      shares: [{ ...unstamped, shareBits: SHARE_FLOOR_BITS + 4 }],
      skipPow: true,
    });
    assert.equal(raised.reason, 'share_target');
  });

  it('credits 2^b only when the byte, the packed claim, and the dest-bound digest agree', () => {
    const dest = minerDest();
    const parent = parentHeader();
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, SHARE_FLOOR_BITS + 4, 16];
    for (const bits of widths) {
      const row = shareAt(dest, 7n, bits);
      const nc = noteCommitOfShare(row);
      const rx = rxForBits(nc, bits, bits + 1);
      assert.ok(rx, `bound digest at ${bits}`);
      const header = setNonce(parent, row.nonce);
      clearLiveSharePow();
      stashSharePow(header, rx);
      const cold = verifyShareBatch({ parentHeader: parent, shares: [row] });
      assert.equal(cold.ok, true, `${bits} ${cold.reason}`);
      assert.equal(cold.units, unitsForShare(bits));
      const relabel = verifyShareBatch({
        parentHeader: parent,
        shares: [{ ...row, shareBits: bits + 1, creditedShareBits: bits + 1 }],
      });
      assert.equal(relabel.reason, 'share_target');
      const low = rxForBits(nc, bits - 1, bits);
      assert.ok(low, `digest below ${bits}`);
      stashSharePow(header, low);
      const miss = verifyShareBatch({ parentHeader: parent, shares: [row] });
      assert.equal(miss.reason, 'share_pow');
      assert.equal(rememberLiveSharePow(parent, row.nonce, {
        noteCommit: nc,
        shareBits: bits,
        lz: bits,
      }), true);
      const hot = verifyShareBatch({ parentHeader: parent, shares: [row], skipPow: true });
      assert.equal(hot.ok, true, hot.reason);
      assert.equal(hot.units, cold.units);
      clearLiveSharePow();
      const wiped = verifyShareBatch({ parentHeader: parent, shares: [row], skipPow: true });
      assert.equal(wiped.reason, 'share_pow');
    }
    const omitDest = minerDest();
    const omit = {
      dest: omitDest,
      nonce: nonceWithShareTarget(11n, SHARE_FLOOR_BITS),
      lz: SHARE_FLOOR_BITS,
    };
    const omitNc = noteCommitOfShare(omit);
    const omitRx = rxForBits(omitNc, SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1);
    assert.ok(omitRx, 'floor digest for an omitted claim');
    clearLiveSharePow();
    stashSharePow(setNonce(parent, omit.nonce), omitRx);
    const omitOk = verifyShareBatch({ parentHeader: parent, shares: [omit] });
    assert.equal(omitOk.ok, true, omitOk.reason);
    assert.equal(omitOk.units, unitsForShare(SHARE_FLOOR_BITS));
    const omitHigh = verifyShareBatch({
      parentHeader: parent,
      shares: [{
        dest: omitDest,
        nonce: nonceWithShareTarget(12n, SHARE_FLOOR_BITS + 4),
        lz: SHARE_FLOOR_BITS,
      }],
      skipPow: true,
    });
    assert.equal(omitHigh.reason, 'share_target');
  });

  it('pays the committed units for any miner count, shuffled, under and over the cap', () => {
    const maxB = shareCreditMaxBits();
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 4, 16, maxB];
    const destCounts = [1, 2, 8];
    const subsidies = [10_000, 100_000_003];
    const carries = [0, 17];
    for (const nDest of destCounts) {
      const dests = Array.from({ length: nDest }, () => minerDest());
      const batch = [];
      dests.forEach((dest, i) => {
        const bits = widths[i % widths.length];
        const copies = 1 + (i % 3);
        for (let c = 0; c < copies; c += 1) {
          batch.push(shareAt(dest, BigInt(batch.length + 1), bits));
        }
      });
      const orders = [batch, [...batch].reverse()];
      if (batch.length > 1) orders.push([...batch.slice(1), batch[0]]);
      const first = retainedUnitsByCommit(orders[0]);
      let sum = 0;
      for (const u of first.values()) sum += u;
      const raw = batch.reduce((n, row) => n + unitsForShare(shareTargetByte(row.nonce)), 0);
      assert.equal(sum, Math.min(raw, MAX_HASH_UNITS_PER_BLOCK), `dests ${nDest}`);
      for (const order of orders.slice(1)) {
        const other = retainedUnitsByCommit(order);
        assert.equal(other.size, first.size);
        for (const [hex, u] of first) assert.equal(other.get(hex), u);
      }
      for (const subsidy of subsidies) {
        for (const carry of carries) {
          const pays = potSharesFromBatch(batch, null, subsidy, carry);
          assert.equal(pays.reduce((a, row) => a + row.nanos, 0), subsidy + carry);
          const flipped = potSharesFromBatch(orders[1], null, subsidy, carry);
          const by = (rows) => new Map(rows.map((row) => [row.address, row.nanos]));
          const a = by(pays);
          const b = by(flipped);
          assert.equal(a.size, b.size);
          for (const [addr, nanos] of a) assert.equal(b.get(addr), nanos);
        }
      }
    }
    const alone = shareAt(minerDest(), 1n, maxB);
    const leaf = retainedUnitsByCommit([alone]);
    assert.equal([...leaf.values()][0], unitsForShare(maxB));
    const over = shareAt(minerDest(), 1n, maxB + 2);
    assert.equal(retainedUnitsByCommit([over]).size, 0);
  });

  it('a buried prune still rejects a share whose nonce byte is illegal', () => {
    const dest = minerDest();
    const genesisMs = 1_700_000_000_000;
    function trustedPow(tag) {
      const h = Buffer.alloc(32);
      h[31] = tag & 0xff;
      return h;
    }
    function viewOf(block, hash, height) {
      return {
        hash,
        header: block.header,
        txs: block.txs,
        height,
        weight: block.weight,
        bLeaves: block.bLeaves,
      };
    }
    function bitsAt(parentHeader, childNow, childHeight) {
      const ph = decodeHeader(parentHeader);
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
    function sealEmpty(prev, prevHash, height, now, tag) {
      const tpl = buildTemplate({
        prev: height === 1 ? GENESIS_PREV : prevHash,
        prevHeader: prev?.header,
        prevBlock: prev,
        height,
        miner: dest,
        bits: height === 1 ? GENESIS_BITS_PACKED : bitsAt(prev.header, now, height),
        now,
      });
      const block = {
        header: tpl.header,
        txs: tpl.txs,
        samples: tpl.samples,
        shareBatch: tpl.shareBatch || [],
        miner: dest,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        weight: tpl.weight,
        height,
      };
      const pow = trustedPow(tag);
      const res = verifyBlock(block, prev ? viewOf(prev, prevHash, height - 1) : null, {
        trustedPowHash: pow,
        genesisMs,
      });
      assert.equal(res.ok, true, `h=${height} ${res.reason}`);
      return { block, hash: res.hash, pow };
    }
    function restamp(block, shares) {
      const rows = shares.map((row) => ({ ...row, noteCommit: noteCommitOfShare(row) }));
      block.shareBatch = rows;
      block.txs[0].shareSlotRoot = shareSlotRoot(rows);
      const decoded = decodeHeader(block.header);
      decoded.merkleRoot = merkleRoot(block.txs.map(digestTx));
      block.header = encodeHeader(decoded);
    }
    const g = sealEmpty(null, null, 1, genesisMs, 1);
    const mid = sealEmpty(g.block, g.hash, 2, genesisMs + 90_000, 2);
    const childNow = genesisMs + 180_000;
    const child = sealEmpty(mid.block, mid.hash, 3, childNow, 3);
    child.block.samplesPruned = true;
    const buriedPrev = viewOf(mid.block, mid.hash, child.block.height + SAMPLE_PRUNE_CONFIRMATIONS);
    const swapped = [shareAt(dest, 1n, 0)];
    child.block.shareBatch = swapped;
    const unbound = verifyBlock(child.block, buriedPrev, {
      trustedPowHash: child.pow,
      skipSharePow: true,
      genesisMs,
    });
    assert.equal(unbound.ok, false);
    assert.equal(unbound.reason, 'share_slot');
    restamp(child.block, swapped);
    const buried = verifyBlock(child.block, buriedPrev, {
      trustedPowHash: child.pow,
      skipSharePow: true,
      genesisMs,
    });
    assert.equal(buried.ok, false);
    assert.equal(buried.reason, 'share_target');
    restamp(child.block, [shareAt(dest, 4n, SHARE_FLOOR_BITS)]);
    clearLiveSharePow();
    const unproven = verifyBlock(child.block, buriedPrev, {
      trustedPowHash: child.pow,
      skipSharePow: true,
      genesisMs,
    });
    assert.equal(unproven.reason, 'share_pow');
  });
});

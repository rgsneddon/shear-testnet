import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { BLOCK_SUBSIDY_NANOS, POOL_FEE_BPS, SHARE_FLOOR_BITS, GENESIS_BITS_PACKED, bitsForBlock } from '../../crypto/asert.js';
import { poolFeeDest } from '../../crypto/levy.js';
import { splitPot } from '../../pool/src/pool.js';
import { findShare, dest20OfShare } from '../../crypto/share_batch.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
  digestTx,
  potSharesFromBatch,
} from '../src/chain.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { coinbaseSplit as mintSplit } from '../../crypto/mint.js';
import { sealCoinbaseNote, excessOf } from '../../crypto/note.js';

function destOf(id) {
  return freshStealthDest(id).dest;
}

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    hash: found.hash,
  };
}

describe('coinbase pot is PROP across shareBatch dests', () => {
  it('kind:pot totals 1 SHE; hashers get pot minus 100 bps; pool dest gets only the fee', () => {
    const alice = destOf(newIdentity());
    const bob = destOf(newIdentity());
    const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
    const rest = BLOCK_SUBSIDY_NANOS - fee;
    const shares = splitPot([
      { miner: alice, count: 2 },
      { miner: bob, count: 2 },
    ], poolFeeDest());
    const pot = shares.filter((s) => s.kind === 'pot').reduce((a, s) => a + s.nanos, 0);
    const pool = shares.filter((s) => s.kind === 'pool-fee').reduce((a, s) => a + s.nanos, 0);
    assert.equal(pot + pool, BLOCK_SUBSIDY_NANOS);
    assert.equal(pot, rest);
    assert.equal(pool, fee);
    assert.equal(shares.find((s) => s.kind === 'pool-fee').address, poolFeeDest());
    assert.equal(shares.find((s) => s.address === alice).nanos, rest / 2);
    assert.equal(shares.find((s) => s.address === bob).nanos, rest / 2);

    const batch = [
      { dest: alice, dest20: dest20OfShare({ dest: alice }), nonce: 1n, lz: 8 },
      { dest: bob, dest20: dest20OfShare({ dest: bob }), nonce: 2n, lz: 8 },
    ];
    const prop = potSharesFromBatch(batch, poolFeeDest());
    const propPot = prop.reduce((a, s) => a + s.nanos, 0);
    assert.equal(propPot, BLOCK_SUBSIDY_NANOS);
    assert.equal(prop.find((s) => s.address === poolFeeDest()).nanos, fee);
  });

  it('rejects a block that pays the whole pot to the pool dest', () => {
    const hasher = destOf(newIdentity());
    const pool = poolFeeDest();
    const TRUSTED = Buffer.alloc(32);
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: hasher,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
    });
    const parent = {
      header: parentTpl.header,
      txs: parentTpl.txs,
      samples: parentTpl.samples,
      shareBatch: parentTpl.shareBatch || [],
      miner: hasher,
      aLeaves: parentTpl.aLeaves,
      bLeaves: parentTpl.bLeaves,
      weight: parentTpl.weight,
    };
    const okP = verifyBlock(parent, null, { trustedPowHash: TRUSTED });
    assert.equal(okP.ok, true, okP.reason);
    const now = 1_700_000_090_000;
    const ph = decodeHeader(parent.header);
    const row = { dest20: dest20OfShare({ dest: hasher }), dest: hasher, nonce: 1n, lz: 8 };
    const childTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner: hasher,
      bits: bitsForBlock(ph.bits, ph.timestamp, now),
      now,
      shareBatch: [row],
      poolDest: pool,
    });
    const cb = childTpl.txs[0];
    const keep = (cb.vout || []).filter((o) => o.kind !== 'pot' && o.kind !== 'pool-fee');
    const whole = sealCoinbaseNote(BLOCK_SUBSIDY_NANOS, {
      dest20: hash20FromAddress(pool),
      kind: 'pot',
    });
    cb.vout = [whole, ...keep];
    cb.excess = excessOf(cb.vout);
    const decoded = decodeHeader(childTpl.header);
    childTpl.header = encodeHeader({
      ...decoded,
      merkleRoot: merkleRoot(childTpl.txs.map(digestTx)),
    });
    const child = {
      header: childTpl.header,
      txs: childTpl.txs,
      samples: childTpl.samples,
      shareBatch: childTpl.shareBatch || [],
      miner: hasher,
      aLeaves: childTpl.aLeaves,
      bLeaves: childTpl.bLeaves,
      weight: childTpl.weight,
    };
    const got = verifyBlock(child, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
      weight: parent.weight,
    }, { poolDest: pool, trustedPowHash: TRUSTED, skipSharePow: true });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'pot_prop');
  });
});

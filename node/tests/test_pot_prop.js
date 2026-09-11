import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { BLOCK_SUBSIDY_NANOS, POOL_FEE_BPS, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
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

function destOf(id) {
  return destForLogin(id.address, { spendPub: id.spendPub });
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

  it('rejects a block that pays the whole pot to the pool dest', async () => {
    const hasher = destOf(newIdentity());
    const pool = poolFeeDest();
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: hasher,
      bits: 4,
      now: 1_700_000_000_000,
    });
    const parent = mine(parentTpl);
    const okP = verifyBlock(parent, null);
    assert.equal(okP.ok, true, okP.reason);
    const share = findShare(parent.header, { dest: hasher, floorBits: SHARE_FLOOR_BITS, maxTries: 2_000_000 });
    assert.ok(share, 'need share');
    const row = { dest20: share.dest20, dest: hasher, nonce: share.nonce, lz: share.lz };
    const childTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 2,
      miner: hasher,
      bits: 4,
      now: 1_700_000_090_000,
      shareBatch: [row],
      poolDest: pool,
    });
    const cb = childTpl.txs[0];
    cb.vout = cb.vout.filter((o) => o.kind !== 'pot' && o.kind !== 'pool-fee');
    cb.vout.unshift({ address: pool, nanos: BLOCK_SUBSIDY_NANOS, kind: 'pot' });
    const decoded = decodeHeader(childTpl.header);
    childTpl.header = encodeHeader({
      ...decoded,
      merkleRoot: merkleRoot(childTpl.txs.map(digestTx)),
    });
    const child = mine(childTpl);
    const got = verifyBlock(child, { ...parent, hash: okP.hash, header: parent.header, height: 1 }, { poolDest: pool });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'pot_prop');
    assert.equal(mintSplit(child.txs[0]).potNanos, BLOCK_SUBSIDY_NANOS);
  });
});

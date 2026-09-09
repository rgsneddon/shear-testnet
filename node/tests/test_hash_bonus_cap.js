import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDest, newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  SHARE_FLOOR_BITS,
  HASH_BONUS_NANOS_FLOOR,
  SAMPLE_PRUNE_CONFIRMATIONS,
} from '../../crypto/asert.js';
import { unitsForShare, findShare, dest20OfShare } from '../../crypto/share_batch.js';
import { roundActualHashes } from '../../pool/src/hash_credit.js';
import { hashesCreditedForShare } from '../../pool/src/share_vardiff.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
  coinbaseTx,
  digestTx,
} from '../src/chain.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { applyMinerSelfRate } from '../../pool/src/pool.js';

function destMiner() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
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

describe('proven hash bonus cap', { timeout: 600_000 }, () => {
  it('rejects count: 1e12 with no shareBatch', () => {
    const dest = destMiner();
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: Date.now(),
      samples: [],
    });
    tpl.txs[0].vout.push({ address: dest, nanos: 1e12, kind: 'hash' });
    const decoded = decodeHeader(tpl.header);
    tpl.header = encodeHeader({
      ...decoded,
      merkleRoot: merkleRoot(tpl.txs.map(digestTx)),
    });
    const block = mine(tpl);
    block.shareBatch = [];
    const got = verifyBlock(block, null);
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'hash_bonus');
  });

  it('accepts one valid ShearHash-v3 share on the parent job header', () => {
    const dest = destMiner();
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: 1_700_000_000_000,
      samples: [],
    });
    const parent = mine(parentTpl);
    const okP = verifyBlock(parent, null);
    assert.equal(okP.ok, true, okP.reason);
    const share = findShare(parent.header, { dest, floorBits: SHARE_FLOOR_BITS, maxTries: 2_000_000 });
    assert.ok(share, 'need a floor share');
    const units = unitsForShare();
    const childTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: { ...parent, hash: okP.hash, header: parent.header },
      height: 2,
      miner: dest,
      bits: 4,
      now: 1_700_000_090_000,
      shareBatch: [{ dest20: share.dest20, dest, nonce: share.nonce, lz: share.lz }],
    });
    const child = mine(childTpl);
    const got = verifyBlock(child, { ...parent, hash: okP.hash, header: parent.header, height: 1 });
    assert.equal(got.ok, true, got.reason);
    const hashV = child.txs[0].vout.filter((o) => o.kind === 'hash');
    assert.equal(hashV.length, 1);
    assert.equal(hashV[0].nanos, units * HASH_BONUS_NANOS);
    assert.equal(hashV[0].address, dest);
    assert.equal(HASH_BONUS_NANOS_FLOOR, 1);
  });

  it('rejects a share that misses SHARE_FLOOR_BITS', () => {
    const dest = destMiner();
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: 1_700_000_000_000,
    });
    const parent = mine(parentTpl);
    const okP = verifyBlock(parent, null);
    assert.equal(okP.ok, true, okP.reason);
    const childTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: 4,
      now: 1_700_000_090_000,
      shareBatch: [{
        dest20: dest20OfShare({ dest }),
        dest,
        nonce: 0n,
        lz: 0,
      }],
    });
    const child = mine(childTpl);
    const got = verifyBlock(child, { ...parent, hash: okP.hash, header: parent.header, height: 1 });
    assert.equal(got.ok, false);
    assert.ok(got.reason === 'share_pow' || got.reason === 'hash_bonus', got.reason);
  });

  it('rejects duplicate nonce as dup_share', () => {
    const dest = destMiner();
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: 1_700_000_000_000,
    });
    const parent = mine(parentTpl);
    const okP = verifyBlock(parent, null);
    assert.equal(okP.ok, true, okP.reason);
    const share = findShare(parent.header, { dest, maxTries: 2_000_000 });
    assert.ok(share, 'need share');
    const row = { dest20: share.dest20, dest, nonce: share.nonce, lz: share.lz };
    const childTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: 4,
      now: 1_700_000_090_000,
      shareBatch: [row, row],
    });
    const child = mine(childTpl);
    const got = verifyBlock(child, { ...parent, hash: okP.hash, header: parent.header, height: 1 });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'dup_share');
  });

  it('rejects a hash dest that is not in the shareBatch', () => {
    const dest = destMiner();
    const other = encodeDest(Buffer.alloc(20, 9));
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: 1_700_000_000_000,
    });
    const parent = mine(parentTpl);
    const okP = verifyBlock(parent, null);
    const share = findShare(parent.header, { dest, maxTries: 2_000_000 });
    assert.ok(share, 'need share');
    const childTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      height: 2,
      miner: dest,
      bits: 4,
      now: 1_700_000_090_000,
      shareBatch: [{ dest20: share.dest20, dest, nonce: share.nonce, lz: share.lz }],
    });
    const hashV = childTpl.txs[0].vout.find((o) => o.kind === 'hash');
    assert.ok(hashV);
    hashV.address = other;
    const decoded = decodeHeader(childTpl.header);
    childTpl.header = encodeHeader({
      ...decoded,
      merkleRoot: merkleRoot(childTpl.txs.map(digestTx)),
    });
    const child = mine(childTpl);
    const got = verifyBlock(child, { ...parent, hash: okP.hash, header: parent.header, height: 1 });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'hash_bonus');
  });

  it('samplesPruned does not skip shareBatch until 1000 confirms vs tip', async () => {
    const dest = destMiner();
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: 1_700_000_000_000,
      samples: [],
    });
    const parent = mine(parentTpl);
    const okP = verifyBlock(parent, null);
    assert.equal(okP.ok, true, okP.reason);
    const share = findShare(parent.header, { dest, floorBits: SHARE_FLOOR_BITS, maxTries: 2_000_000 });
    assert.ok(share, 'need a floor share');
    const childTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: { ...parent, hash: okP.hash, header: parent.header },
      height: 2,
      miner: dest,
      bits: 4,
      now: 1_700_000_090_000,
      shareBatch: [{ dest20: share.dest20, dest, nonce: share.nonce, lz: share.lz }],
    });
    const child = mine(childTpl);
    child.samplesPruned = true;
    child.shareBatch = [];
    const live = await Promise.resolve(verifyBlock(child, {
      ...parent, hash: okP.hash, header: parent.header, height: 1,
    }, { tipHeight: 2 }));
    assert.equal(live.ok, false);
    assert.equal(live.reason, 'hash_bonus');
    const buried = await Promise.resolve(verifyBlock(child, {
      ...parent, hash: okP.hash, header: parent.header, height: 1,
    }, { tipHeight: 2 + SAMPLE_PRUNE_CONFIRMATIONS }));
    assert.equal(buried.ok, true, buried.reason);
  });
});

describe('pool honesty: clientHashes cannot inflate units', () => {
  it('roundActualHashes has no client-hash branch', () => {
    const src = roundActualHashes.toString();
    assert.equal(/clientHashes\s*-/.test(src), false);
    const miner = {
      roundHashes: 256,
      clientHashes: 1e12,
      clientHashesRound0: 0,
    };
    assert.equal(roundActualHashes(miner), 256);
    miner.roundHashes = 0;
    assert.equal(roundActualHashes(miner), 0);
    const session = {};
    applyMinerSelfRate(session, { hashes: 9e12 });
    session.roundHashes = 256;
    session.clientHashes = 9e12;
    assert.equal(roundActualHashes(session), 256);
    assert.equal(hashesCreditedForShare({ shareBits: 4 }), 2 ** SHARE_FLOOR_BITS);
    const cb = coinbaseTx({
      height: 2,
      miner: destMiner(),
      samples: [{ miner: destMiner(), count: 1e12 }],
      shareBatch: [],
    });
    const hashNanos = cb.vout.filter((o) => o.kind === 'hash').reduce((a, o) => a + o.nanos, 0);
    assert.equal(hashNanos, 0);
    assert.equal(cb.vout.filter((o) => o.kind === 'pot').reduce((a, o) => a + o.nanos, 0), BLOCK_SUBSIDY_NANOS);
  });
});

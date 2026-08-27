import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { levyNanos, txWeight } from '../../crypto/levy.js';
import { bProof } from '../../crypto/clearing.js';
import { decodeHeader } from '../../crypto/header.js';
import { bitsForBlock, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

describe('verifyBlock B-spend uses the committing header', () => {
  it('rejects pre-seal, accepts after seal with proof, rejects double-open', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const dest20 = hash20FromAddress(dest);
    const leaf = {
      dest20,
      unit: 9,
      nonce: 1,
      memoH: Buffer.alloc(32),
      tag: 'b-extra',
    };
    const t0 = Date.now();
    const commitTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 8,
      now: t0,
      samples: [{ miner: dest, nonce: '1', tag: 'a', count: 1 }],
      bLeaves: [leaf],
    });
    const commit = mine(commitTpl);
    const commitOk = verifyBlock(commit, null);
    assert.equal(commitOk.ok, true, commitOk.reason);
    const commitBlock = { ...commit, hash: commitOk.hash, height: 1 };
    const proof = bProof([leaf], 0);
    const fee = levyNanos(Number(decodeHeader(commit.header).baseFee || 1), txWeight({
      vouts: 1,
      memoChunks: 0,
      bFlag: 1,
    }));
    const spendTx = {
      id: 'bspend-1',
      kind: 'b-spend',
      from: dest,
      to: dest,
      nanos: 9,
      fee,
      commitHeight: 1,
      commitHeader: commit.header,
      commitRootA: commit.rootA,
      commitRootB: commit.rootB,
      leaf,
      proof,
      index: 0,
      vin: [{ address: dest }],
      vout: [{ address: dest, nanos: 9 }],
    };

    const t1 = t0 + 90_000;
    const bits2 = bitsForBlock(
      decodeHeader(commit.header).bits,
      decodeHeader(commit.header).timestamp,
      t1,
    );
    const early = mine(buildTemplate({
      prev: commitBlock.hash,
      prevHeader: commit.header,
      prevBlock: commitBlock,
      parentWeight: commit.weight,
      height: 2,
      miner: dest,
      bits: bits2,
      now: t1,
      samples: [{ miner: dest, nonce: '2', tag: 'a', count: 1 }],
      txs: [{ ...spendTx, commitHeight: 3 }],
    }));
    const pre = verifyBlock(early, commitBlock, { tipHeight: 2, spentB: new Set() });
    assert.equal(pre.ok, false);
    assert.equal(pre.reason, 'pre_seal');

    const sealed = mine(buildTemplate({
      prev: commitBlock.hash,
      prevHeader: commit.header,
      prevBlock: commitBlock,
      parentWeight: commit.weight,
      height: 2,
      miner: dest,
      bits: bits2,
      now: t1,
      samples: [{ miner: dest, nonce: '2', tag: 'a', count: 1 }],
      txs: [spendTx],
    }));
    const spent = new Set();
    assert.equal(SPENDABLE_CONFIRMATIONS, 1);
    // 1-conf: the committing block is spendable as soon as tip >= commitHeight.
    const justSealed = verifyBlock(sealed, commitBlock, { tipHeight: 2, spentB: new Set() });
    assert.equal(justSealed.ok, true, justSealed.reason);
    const ok = verifyBlock(sealed, commitBlock, {
      tipHeight: Math.max(1, SPENDABLE_CONFIRMATIONS),
      spentB: spent,
    });
    assert.equal(ok.ok, true, ok.reason);

    const laterBits = bitsForBlock(
      decodeHeader(sealed.header).bits,
      decodeHeader(sealed.header).timestamp,
      t1 + 90_000,
    );
    const sealedOk = verifyBlock(sealed, commitBlock, {
      tipHeight: Math.max(1, SPENDABLE_CONFIRMATIONS),
    });
    const sealedBlock = { ...sealed, hash: sealedOk.hash, height: 2, weight: sealed.weight };
    const twice = mine(buildTemplate({
      prev: sealedBlock.hash,
      prevHeader: sealed.header,
      prevBlock: sealedBlock,
      parentWeight: sealed.weight,
      height: 3,
      miner: dest,
      bits: laterBits,
      now: t1 + 90_000,
      samples: [{ miner: dest, nonce: '3', tag: 'a', count: 1 }],
      txs: [spendTx],
    }));
    const dup = verifyBlock(twice, sealedBlock, {
      tipHeight: Math.max(1, SPENDABLE_CONFIRMATIONS),
      spentB: spent,
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, 'double_open');
  });
});

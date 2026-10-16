import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hash20FromAddress } from '../../crypto/address.js';
import { bProof } from '../../crypto/clearing.js';
import { decodeHeader } from '../../crypto/header.js';
import { bitsForBlock, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { signSpendTx } from '../../crypto/spend.js';
import {
  buildTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';
import { payerIdentity, sealMintOut } from './b_leaf_fund.js';

function mine(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

function check(block, prev, opts) {
  return verifyBlock(block, prev, { probeBody: true, ...(opts || {}) });
}

describe('verifyBlock B-spend uses the committing header', () => {
  it('rejects pre-seal, accepts after seal with proof, rejects double-open', () => {
    const who = payerIdentity();
    const dest = who.dest;
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
      now: t0,
      samples: [{ miner: dest, nonce: '1', tag: 'a', count: 1 }],
    });
    const commit = mine(commitTpl);
    const commitOk = check(commit, null);
    assert.equal(commitOk.ok, true, commitOk.reason);
    const commitBlock = { ...commit, hash: commitOk.hash, height: 1, supplyState: commitOk.supplyState };
    const proof = bProof([leaf], 0);
    const fee = 0;
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
      vout: [sealMintOut(9, dest, 'b-spend')],
    };
    signSpendTx(spendTx, who.key);

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
    const pre = check(early, commitBlock, { tipHeight: 2, spentB: new Set() });
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
    assert.equal(SPENDABLE_CONFIRMATIONS, 9);
    // 9-conf law: commit at height 1 is not spendable at tip 2.
    // Maturity is the parent height plus one. A caller's tipHeight does not open it.
    const justSealed = check(sealed, commitBlock, { tipHeight: 2, spentB: new Set(), evmHistory: [commitBlock] });
    assert.equal(justSealed.ok, false, justSealed.reason);
    assert.equal(justSealed.reason, 'immature');
    const history = [commitBlock];
    let parent = commitBlock;
    let cursor = t0;
    while (parent.height < SPENDABLE_CONFIRMATIONS - 1) {
      cursor += 90_000;
      const nextBits = bitsForBlock(
        decodeHeader(parent.header).bits,
        decodeHeader(parent.header).timestamp,
        cursor,
      );
      const pad = mine(buildTemplate({
        prev: parent.hash,
        prevHeader: parent.header,
        prevBlock: parent,
        parentWeight: parent.weight,
        height: parent.height + 1,
        miner: dest,
        bits: nextBits,
        now: cursor,
        parentBlocks: history,
      }));
      const padded = check(pad, parent, { evmHistory: history, parentSupply: parent.supplyState });
      assert.equal(padded.ok, true, `${parent.height + 1} ${padded.reason}`);
      parent = { ...pad, hash: padded.hash, height: parent.height + 1, supplyState: padded.supplyState };
      history.push(parent);
    }
    const matureTip = parent.height + 1;
    assert.equal(matureTip, 1 + SPENDABLE_CONFIRMATIONS - 1);
    const matureBits = bitsForBlock(
      decodeHeader(parent.header).bits,
      decodeHeader(parent.header).timestamp,
      cursor + 90_000,
    );
    const mature = mine(buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: matureTip,
      miner: dest,
      bits: matureBits,
      now: cursor + 90_000,
      parentBlocks: history,
      txs: [spendTx],
    }));
    const ok = check(mature, parent, {
      tipHeight: matureTip,
      spentB: spent,
      evmHistory: history,
      parentSupply: parent.supplyState,
    });
    assert.equal(ok.ok, true, ok.reason);

    const laterBits = bitsForBlock(
      decodeHeader(mature.header).bits,
      decodeHeader(mature.header).timestamp,
      cursor + 180_000,
    );
    const sealedOk = ok;
    const sealedBlock = { ...mature, hash: sealedOk.hash, height: matureTip, weight: mature.weight };
    const twice = mine(buildTemplate({
      prev: sealedBlock.hash,
      prevHeader: mature.header,
      prevBlock: sealedBlock,
      parentWeight: sealedBlock.weight,
      height: matureTip + 1,
      miner: dest,
      bits: laterBits,
      now: cursor + 180_000,
      parentBlocks: history.concat([sealedBlock]),
      txs: [spendTx],
    }));
    const dup = check(twice, sealedBlock, {
      tipHeight: matureTip + 1,
      spentB: spent,
      evmHistory: history.concat([sealedBlock]),
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, 'double_open');
  });
});

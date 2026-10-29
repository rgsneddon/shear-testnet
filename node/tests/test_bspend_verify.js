import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bProof } from '../../crypto/clearing.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { excessOf } from '../../crypto/note.js';
import { signSpendTx } from '../../crypto/spend.js';
import { openStore, payerIdentity, sealMintOut, templateOn, appendTpl } from './b_leaf_fund.js';
import { publishBLeaves } from './b_leaf_fs1.js';

async function attempt(store, dest, txs) {
  const tpl = templateOn(store, { miner: dest, txs });
  const carried = (tpl.txs || []).some((tx) => tx && tx.kind === 'b-spend');
  assert.equal(carried, true, 'template dropped the b-spend');
  return appendTpl(store, tpl);
}

describe('verifyBlock B-spend uses the committing header', () => {
  it('rejects pre-seal, accepts after seal with proof, rejects double-open', async () => {
    const who = payerIdentity();
    const dest = who.dest;
    const book = openStore('shear-bspend-verify-');
    try {
      const funded = await publishBLeaves(book.store, who, [{
        unit: 9,
        nonce: 1,
        tag: 'b-extra',
        memoH: Buffer.alloc(32),
        id: 'fund-bspend-1',
      }]);
      const leaf = funded.leaves[0];
      const commit = funded.block;
      assert.equal(leaf.unit, 9);
      const spendTx = {
        id: 'bspend-1',
        kind: 'b-spend',
        from: dest,
        to: dest,
        nanos: 9,
        fee: 0,
        commitHeight: funded.height,
        commitHeader: commit.header,
        commitRootA: commit.rootA,
        commitRootB: commit.rootB,
        leaf,
        proof: bProof(funded.leaves, 0),
        index: 0,
        vin: [{ address: dest }],
        vout: [sealMintOut(9, dest, 'b-spend')],
      };
      spendTx.excess = excessOf(spendTx.vout);
      signSpendTx(spendTx, who.key, { magic: 'shear-testnet-v12' });

      const pre = await attempt(book.store, dest, [{ ...spendTx, id: 'bspend-pre', commitHeight: funded.height + 3 }]);
      assert.equal(pre.ok, false);
      assert.equal(pre.reason, 'pre_seal');
      assert.equal(book.store.tip().height, funded.height);

      assert.equal(SPENDABLE_CONFIRMATIONS, 9);
      const justSealed = await attempt(book.store, dest, [{ ...spendTx, id: 'bspend-immature' }]);
      assert.equal(justSealed.ok, false, justSealed.reason);
      assert.equal(justSealed.reason, 'immature');
      assert.equal(book.store.tip().height, funded.height);

      const matureParent = funded.height + SPENDABLE_CONFIRMATIONS - 2;
      while ((book.store.tip()?.height || 0) < matureParent) {
        const pad = await appendTpl(book.store, templateOn(book.store, { miner: dest }));
        assert.equal(pad.ok, true, `${book.store.tip()?.height || 0} ${pad.reason}`);
      }
      assert.equal(book.store.tip().height, matureParent);
      const ok = await attempt(book.store, dest, [spendTx]);
      assert.equal(ok.ok, true, ok.reason);
      assert.equal(book.store.tip().height, matureParent + 1);

      const dup = await attempt(book.store, dest, [{ ...spendTx, id: 'bspend-twice' }]);
      assert.equal(dup.ok, false);
      assert.equal(dup.reason, 'double_open');
      assert.equal(book.store.tip().height, matureParent + 1);
    } finally {
      book.close();
    }
  });
});

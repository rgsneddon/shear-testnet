/**
 * L-1: a b-spend mints only the leaf the chain committed.
 * The leaf is a debit, not a free list. Any amount, any output split.
 * The tx does not choose the header.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, retarget } from '../src/chain.js';
import { decodeHeader, encodeHeader, VERSION } from '../../crypto/header.js';
import { bProof, buildDualTree } from '../../crypto/clearing.js';
import { GENESIS_BITS_PACKED, SPENDABLE_CONFIRMATIONS, hashBonusUnitNanos } from '../../crypto/asert.js';
import { excessOf, openedCoinbaseNanos } from '../../crypto/note.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { V12_VALUE_KINDS } from '../../crypto/spend.js';
import { hash20FromAddress } from '../../crypto/address.js';
import {
  asBlock,
  easyPowHash,
  fundedUnitSpread,
  openStore,
  payerIdentity,
  sealBalanced,
  sealEmpty,
  sealMintOut,
  T0,
} from './b_leaf_fund.js';

const REJECT = [1, 2 ** 20, 2 ** 40];

describe('v12 b-spend mint is the chain leaf', () => {
  it('rejects a missing kind, a foreign header, and an output above the leaf, for any amount', { timeout: 180_000 }, async () => {
    assert.ok(REJECT.length >= 3);
    assert.ok(REJECT.every((n) => Number.isSafeInteger(n) && n > 0));
    assert.equal(new Set(REJECT).size, REJECT.length);
    const payer = payerIdentity();
    const dest = payer.dest;
    const book = openStore('shear-l1-');
    const store = book.store;
    try {
      const genesis = await sealEmpty(store, dest);
      assert.equal(genesis.ok, true, `${genesis.reason || ''} ${genesis.error || ''}`);
      assert.ok(genesis.pot?.r, 'pot blinding');
      const opened = openedCoinbaseNanos(genesis.pot);
      const amounts = fundedUnitSpread(opened);
      assert.ok(amounts, `pot ${opened} has no funded spread`);
      assert.ok(REJECT.some((n) => n > opened), 'one rejected unit is larger than the pot');
      const committed = [];
      let pot = genesis.pot;
      for (let i = 0; i < amounts.length; i += 1) {
        const unit = amounts[i];
        const sealed = await sealBalanced(store, payer, {
          ask: true,
          lockInInputs: true,
          unit,
          nonce: i + 1,
          id: `l1-leaf-${unit}`,
          spentNote: pot,
        });
        assert.equal(sealed.ok, true, `${unit} ${sealed.reason || ''}`);
        assert.equal(sealed.got.ok, true, `${unit} ${sealed.got.reason || ''} ${sealed.got.error || ''}`);
        assert.equal(sealed.leaves.length, 1, unit);
        assert.equal(sealed.leaf.unit, unit);
        assert.ok(sealed.nextPot?.r, unit);
        pot = sealed.nextPot;
        committed.push({
          leaf: sealed.leaf,
          height: sealed.height,
          proof: sealed.proof,
          header: sealed.tip.header,
          rootA: sealed.tip.rootA,
          rootB: sealed.tip.rootB,
        });
      }

      const youngest = Math.max(...committed.map((rec) => rec.height));
      while (store.tip().height < youngest + SPENDABLE_CONFIRMATIONS - 2) {
        const parentTs = Number(decodeHeader(Buffer.from(store.tip().header)).timestamp);
        const { tpl } = store.template({
          miner: dest,
          shareBits: 4,
          now: parentTs + 90_000,
        });
        const got = await Promise.resolve(store.append(asBlock(tpl), {
          trustedPowHash: easyPowHash(),
          skipSharePow: true,
        }));
        assert.equal(got.ok, true, `filler ${got.reason || ''} ${got.error || ''}`);
      }
      const parentHeight = store.tip().height;
      const matureTip = parentHeight + 1;
      for (const rec of committed) {
        assert.ok(matureTip - rec.height + 1 >= SPENDABLE_CONFIRMATIONS, rec.height);
      }

      const nextBlock = (txs) => {
        const t = store.tip();
        const parentTs = Number(decodeHeader(Buffer.from(t.header)).timestamp);
        const now = parentTs + 90_000;
        const built = buildTemplate({
          prev: t.hash,
          prevHeader: t.header,
          prevBlock: t,
          parentWeight: t.weight,
          height: t.height + 1,
          miner: dest,
          txs,
          now,
          bits: retarget(store.blocks, now),
          parentBlocks: store.blocks,
          parentFluxset: store.fluxset(),
          hashBonusNanos: hashBonusUnitNanos(store.reserveVault.liveHashBonusNanos),
          shareBatch: [],
        });
        return asBlock(built);
      };
      const probe = (txs) => Promise.resolve(store.probeBlock(nextBlock(txs)));

      const hidden = sealMintOut(amounts[0], dest, 'b-spend');
      assert.equal(openedCoinbaseNanos(hidden), amounts[0]);
      const missing = {
        id: 'l1-missing-kind',
        from: dest,
        to: dest,
        nanos: amounts[0],
        fee: 0,
        vin: [{}],
        vout: [hidden],
      };
      assert.equal(missing.kind, undefined);
      assert.equal(missing.vout[0].kind, 'b-spend');
      const queuedMissing = store.queueTx(missing);
      assert.equal(queuedMissing.ok, false);
      assert.equal(queuedMissing.reason, 'kind');
      const parked = admitMempool(emptyMempool(), missing, { baseFee: 1 });
      assert.equal(parked.ok, false);
      assert.equal(parked.reason, 'kind');
      const missingBlock = await probe([missing]);
      assert.equal(missingBlock.ok, false, missingBlock.reason);
      assert.equal(missingBlock.reason, 'kind');

      const disagreed = {
        id: 'l1-kind-disagree',
        kind: 'b-spend',
        from: dest,
        to: dest,
        nanos: amounts[1],
        fee: 0,
        vin: [{ address: dest }],
        vout: [sealMintOut(amounts[1], dest, 'send')],
      };
      const queuedDisagree = store.queueTx(disagreed);
      assert.equal(queuedDisagree.ok, false);
      assert.equal(queuedDisagree.reason, 'kind');

      const spendOf = (rec, outs, extra = {}) => ({
        id: `l1-${rec.leaf.unit}-${extra.id || 'spend'}`,
        kind: 'b-spend',
        from: dest,
        to: dest,
        nanos: rec.leaf.unit,
        fee: 0,
        commitHeight: rec.height,
        leaf: rec.leaf,
        proof: rec.proof,
        index: 0,
        excess: excessOf(outs),
        vin: [{ address: dest }],
        vout: outs,
        ...extra,
      });

      for (let i = 0; i < REJECT.length; i += 1) {
        const amount = REJECT[i];
        const fakeLeaf = {
          dest20: Buffer.from(hash20FromAddress(dest)),
          unit: amount,
          nonce: 50_000 + i,
          memoH: Buffer.alloc(32, i + 1),
          tag: 'forged',
        };
        const dual = buildDualTree({ aLeaves: [], bLeaves: [fakeLeaf] });
        const fakeHeader = encodeHeader({
          version: VERSION,
          prevBlockHash: Buffer.alloc(32),
          merkleRoot: Buffer.alloc(32),
          continuityRoot: dual.continuityRoot,
          timestamp: T0,
          bits: GENESIS_BITS_PACKED,
          nonce: 0n,
          baseFee: 1n,
        });
        const forged = {
          id: `l1-forged-${amount}`,
          kind: 'b-spend',
          from: dest,
          to: dest,
          nanos: amount,
          fee: 0,
          commitHeight: 1,
          commitHeader: fakeHeader,
          commitRootA: dual.rootA,
          commitRootB: dual.rootB,
          leaf: fakeLeaf,
          proof: bProof([fakeLeaf], 0),
          index: 0,
          vin: [{ address: dest }],
          vout: [sealMintOut(amount, dest, 'b-spend')],
        };
        const forgedBlock = await probe([forged]);
        assert.equal(forgedBlock.ok, false, `${amount} ${forgedBlock.reason}`);
        assert.ok(
          forgedBlock.reason === 'proof' || forgedBlock.reason === 'continuity',
          `${amount} forged ${forgedBlock.reason}`,
        );
        const forgedQueue = store.queueTx(forged);
        assert.equal(forgedQueue.ok, false, amount);
        assert.ok(
          forgedQueue.reason === 'proof' || forgedQueue.reason === 'continuity',
          forgedQueue.reason,
        );
      }

      for (const rec of committed) {
        const amount = rec.leaf.unit;
        const overOut = sealMintOut(amount + amount, dest, 'b-spend');
        assert.equal(openedCoinbaseNanos(overOut), amount + amount);
        const over = spendOf(rec, [overOut], {
          id: 'over',
          commitHeader: rec.header,
          commitRootA: rec.rootA,
          commitRootB: rec.rootB,
          nanos: amount + amount,
        });
        const overBlock = await probe([over]);
        assert.equal(overBlock.ok, false, `${amount} ${overBlock.reason}`);
        assert.equal(overBlock.reason, 'commit_sum', `${amount} ${overBlock.reason}`);
        const overQueue = store.queueTx(over);
        assert.equal(overQueue.ok, false, amount);
        assert.equal(overQueue.reason, 'commit_sum', overQueue.reason);
      }

      const honest = committed.map((rec, i) => {
        const amount = rec.leaf.unit;
        const outs = i === committed.length - 1 && amount > 1
          ? [sealMintOut(1, dest, 'b-spend'), sealMintOut(amount - 1, dest, 'b-spend')]
          : [sealMintOut(amount, dest, 'b-spend')];
        const openedSum = outs.reduce((sum, o) => sum + openedCoinbaseNanos(o), 0);
        assert.equal(openedSum, amount);
        return spendOf(rec, outs, {
          id: 'honest',
          commitHeader: Buffer.alloc(128, 3),
          commitRootA: Buffer.alloc(32, 4),
          commitRootB: Buffer.alloc(32, 5),
        });
      });
      const honestProbe = await probe(honest);
      assert.equal(honestProbe.ok, true, honestProbe.reason);
      const sealed = await Promise.resolve(store.append(nextBlock(honest), {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
      }));
      assert.equal(sealed.ok, true, `${sealed.reason || ''} ${sealed.error || ''}`);
      assert.equal(store.tip().height, matureTip);
      const again = await probe([honest[0]]);
      assert.equal(again.ok, false);
      assert.equal(again.reason, 'double_open');

      const parkedForged = {
        id: 'l1-parked-forged',
        kind: 'b-spend',
        from: dest,
        to: dest,
        nanos: REJECT[0],
        fee: 0,
        commitHeight: 1,
        commitHeader: Buffer.alloc(128, 9),
        leaf: {
          dest20: Buffer.from(hash20FromAddress(dest)),
          unit: REJECT[0],
          nonce: 77,
          memoH: Buffer.alloc(32, 7),
          tag: 'parked',
        },
        proof: [],
        index: 0,
        vin: [{ address: dest }],
        vout: [sealMintOut(REJECT[0], dest, 'b-spend')],
      };
      store.mempool.push(parkedForged);
      const parentTs = Number(decodeHeader(Buffer.from(store.tip().header)).timestamp);
      const { tpl } = store.template({ miner: dest, shareBits: 4, now: parentTs + 90_000 });
      assert.ok(!(tpl.txs || []).some((row) => row && row.id === parkedForged.id));
      assert.ok(!store.mempool.some((row) => row && row.id === parkedForged.id));

      for (const kind of V12_VALUE_KINDS) {
        if (kind === 'b-spend') continue;
        const tx = {
          id: `l1-over-${kind}-${REJECT[2]}`,
          kind,
          from: dest,
          to: dest,
          nanos: REJECT[2],
          fee: 0,
          vin: [{ address: dest }],
          vout: [sealMintOut(REJECT[2], dest, kind)],
        };
        const got = store.queueTx(tx);
        assert.equal(got.ok, false, `${kind} ${got.reason || 'accepted'}`);
      }
    } finally {
      book.close();
    }
  });
});

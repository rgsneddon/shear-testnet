/**
 * N-55: a B leaf is a debit in the same block, counted by the supply step.
 * Any unit. A send that already balances does not mint a leaf.
 * A published list that the body did not debit is rejected.
 * A b-spend with nothing locked halts the supply step.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { excessOf, openedCoinbaseNanos, verifyMintSum } from '../../crypto/note.js';
import { signSpendTx } from '../../crypto/spend.js';
import { hash20FromAddress } from '../../crypto/address.js';
import { auditCirculatingSupply } from '../src/supply.js';
import {
  PAY_NANOS,
  appendTpl,
  asBlock,
  fundedUnitSpread,
  openStore,
  payerIdentity,
  potOutput,
  sealBalanced,
  sealEmpty,
  sealMintOut,
  stampNow,
  templateOn,
} from './b_leaf_fund.js';

const FREE_UNITS = [1, 2 ** 20, 2 ** 40];
const BAD_UNITS = ['5.0', -1, true, 0];

describe('v12 B leaves are debited', () => {
  it('a balanced send that also asks for a leaf is rejected, for any unit', { timeout: 180_000 }, async () => {
    assert.ok(FREE_UNITS.length >= 3);
    assert.ok(FREE_UNITS.every((n) => Number.isSafeInteger(n) && n > 0));
    assert.equal(new Set(FREE_UNITS).size, FREE_UNITS.length);
    const payer = payerIdentity();
    const book = openStore('shear-b55-free-');
    try {
      const genesis = await sealEmpty(book.store, payer.dest);
      assert.equal(genesis.ok, true, `${genesis.reason || ''} ${genesis.error || ''}`);
      assert.ok(genesis.pot?.r, 'pot blinding');
      const opened = openedCoinbaseNanos(genesis.pot);
      assert.ok(Number.isSafeInteger(opened) && opened > PAY_NANOS);
      assert.ok(FREE_UNITS.some((n) => n > opened), 'one unit is larger than the pot');
      const heightBefore = book.store.tip().height;
      const pot = genesis.pot;
      for (const unit of FREE_UNITS) {
        const sealed = await sealBalanced(book.store, payer, {
          ask: true,
          lockInInputs: false,
          unit,
          nonce: unit,
          id: `free-${unit}`,
          spentNote: pot,
        });
        assert.equal(sealed.ok, true, `${unit} ${sealed.reason || ''}`);
        assert.equal(sealed.wire.bFlag, 1);
        assert.equal(sealed.wire.unit, unit);
        assert.equal(
          sealed.got.ok,
          false,
          `unit ${unit} appended ${sealed.got.ok} ${sealed.got.reason || ''} ${sealed.got.error || ''}`,
        );
        assert.equal(sealed.got.reason, 'b_debit', `unit ${unit} ${sealed.got.reason}`);
        assert.equal(book.store.tip().height, heightBefore);
        const queued = book.store.queueTx(sealed.wire);
        assert.equal(queued.ok, false, `${unit} ${queued.reason || 'queued'}`);
        assert.equal(queued.reason, 'b_debit', `${unit} ${queued.reason}`);
        const parked = admitMempool(emptyMempool(), sealed.wire, {
          baseFee: 1,
          fluxset: book.store.fluxset(),
        });
        assert.equal(parked.ok, false, `${unit} ${parked.reason || 'admitted'}`);
        assert.equal(parked.reason, 'b_debit', `${unit} ${parked.reason}`);
        book.store.mempool.push(sealed.wire);
        const { tpl } = book.store.template({
          miner: payer.dest,
          shareBits: 4,
          now: stampNow(book.store),
        });
        assert.ok(!(tpl.txs || []).some((row) => row && row.id === sealed.wire.id), unit);
        assert.equal((tpl.bLeaves || []).length, 0, unit);
        assert.ok(!book.store.mempool.some((row) => row && row.id === sealed.wire.id), unit);
      }
      const sample = await sealBalanced(book.store, payer, {
        ask: true,
        lockInInputs: false,
        unit: FREE_UNITS[0],
        nonce: 7,
        id: 'free-bad-base',
        spentNote: pot,
      });
      assert.equal(sample.ok, true, sample.reason);
      for (const bad of BAD_UNITS) {
        const tx = { ...sample.wire, unit: bad, id: `bad-${String(bad)}` };
        const got = book.store.queueTx(tx);
        assert.equal(got.ok, false, `${String(bad)} ${got.reason || 'queued'}`);
        assert.equal(got.reason, 'b_debit', `${String(bad)} ${got.reason}`);
      }
      const plain = await sealBalanced(book.store, payer, {
        ask: false,
        id: 'plain-send',
        spentNote: pot,
      });
      assert.equal(plain.ok, true, plain.reason);
      assert.equal(plain.got.ok, true, `${plain.got.reason || ''} ${plain.got.error || ''}`);
      const afterPlain = auditCirculatingSupply(book.store.blocks);
      assert.equal(afterPlain.status, 'verified', afterPlain.reason);
      assert.equal(afterPlain.bLockedNanos, 0);
    } finally {
      book.close();
    }
  });

  it('a block whose bLeaves is not the debited list is rejected', async () => {
    const payer = payerIdentity();
    const book = openStore('shear-b55-list-');
    try {
      const genesis = await sealEmpty(book.store, payer.dest);
      assert.equal(genesis.ok, true, `${genesis.reason || ''} ${genesis.error || ''}`);
      const opened = openedCoinbaseNanos(potOutput(book.store.tip()));
      const freeUnits = [1, 2 ** 20, 2 ** 40].filter((n) => n !== opened);
      assert.ok(freeUnits.length >= 3);
      for (const unit of freeUnits) {
        const free = [{
          dest20: Buffer.from(hash20FromAddress(payer.dest)),
          unit,
          nonce: unit,
          memoH: Buffer.alloc(32),
          tag: 'b-extra',
        }];
        const tpl = templateOn(book.store, { miner: payer.dest, bLeaves: free });
        const got = await appendTpl(book.store, tpl);
        assert.equal(
          got.ok,
          false,
          `unit ${unit} appended ${got.ok} ${got.reason || ''} ${got.error || ''}`,
        );
        assert.equal(got.reason, 'b_leaves', `unit ${unit} ${got.reason}`);
        const pruned = asBlock(tpl);
        pruned.samplesPruned = true;
        const early = await Promise.resolve(book.store.probeBlock(pruned));
        assert.equal(early.ok, false, unit);
        assert.equal(early.reason, 'b_leaves', `${unit} ${early.reason}`);
      }
    } finally {
      book.close();
    }
  });

  it('an unbacked b-spend halts the supply step, for any unit', async () => {
    const payer = payerIdentity();
    const book = openStore('shear-b55-mint-');
    try {
      const genesis = await sealEmpty(book.store, payer.dest);
      assert.equal(genesis.ok, true, `${genesis.reason || ''} ${genesis.error || ''}`);
      const child = asBlock(templateOn(book.store, { miner: payer.dest }));
      const clean = auditCirculatingSupply(book.store.blocks.concat([child]));
      assert.equal(clean.status, 'verified', clean.reason);
      for (const unit of FREE_UNITS) {
        const outs = [sealMintOut(unit, payer.dest, 'b-spend')];
        assert.equal(openedCoinbaseNanos(outs[0]), unit);
        const excess = excessOf(outs);
        assert.ok(excess);
        assert.equal(verifyMintSum(outs, unit, excess), true);
        const tx = {
          id: `unbacked-${unit}`,
          kind: 'b-spend',
          bFlag: 1,
          fee: 0,
          unit,
          leaf: {
            dest20: Buffer.from(hash20FromAddress(payer.dest)),
            unit,
            nonce: 1,
            memoH: Buffer.alloc(32),
            tag: 'b-extra',
          },
          excess,
          vin: [{}],
          vout: outs,
        };
        const block = { ...child, txs: [child.txs[0], tx] };
        const audit = auditCirculatingSupply(book.store.blocks.concat([block]));
        assert.equal(audit.status, 'mismatch', `${unit} ${audit.status} ${audit.reason}`);
        assert.equal(audit.reason, 'supply', `${unit} ${audit.reason}`);
      }
    } finally {
      book.close();
    }
  });

  it('a funded debit locks the unit, and the matching spend releases it', { timeout: 180_000 }, async () => {
    const payer = payerIdentity();
    const book = openStore('shear-b55-fund-');
    try {
      const genesis = await sealEmpty(book.store, payer.dest);
      assert.equal(genesis.ok, true, `${genesis.reason || ''} ${genesis.error || ''}`);
      assert.ok(genesis.pot?.r, 'pot blinding');
      const opened = openedCoinbaseNanos(genesis.pot);
      const units = fundedUnitSpread(opened);
      assert.ok(units, `pot ${opened} has no funded spread`);
      const leaves = [];
      let locked = 0;
      let pot = genesis.pot;
      for (let i = 0; i < units.length; i += 1) {
        const unit = units[i];
        const sealed = await sealBalanced(book.store, payer, {
          ask: true,
          lockInInputs: true,
          unit,
          nonce: i + 1,
          id: `debit-${unit}`,
          spentNote: pot,
        });
        assert.equal(sealed.ok, true, `${unit} ${sealed.reason || ''}`);
        assert.equal(sealed.got.ok, true, `${unit} ${sealed.got.reason || ''} ${sealed.got.error || ''}`);
        assert.ok(sealed.nextPot?.r, `${unit} next pot`);
        pot = sealed.nextPot;
        assert.equal(sealed.leaves.length, 1, unit);
        assert.equal(sealed.leaf.unit, unit);
        locked += unit;
        leaves.push({
          leaf: sealed.leaf,
          height: sealed.height,
          proof: sealed.proof,
          header: sealed.tip.header,
          rootA: sealed.tip.rootA,
          rootB: sealed.tip.rootB,
        });
        const audit = auditCirculatingSupply(book.store.blocks);
        assert.equal(audit.status, 'verified', `${unit} ${audit.reason}`);
        assert.equal(audit.bLockedNanos, locked, unit);
      }
      const youngest = Math.max(...leaves.map((rec) => rec.height));
      const needParent = youngest + SPENDABLE_CONFIRMATIONS - 2;
      while (book.store.tip().height < needParent) {
        const pad = await sealEmpty(book.store, payer.dest);
        assert.equal(pad.ok, true, `${pad.reason || ''} ${pad.error || ''}`);
      }
      const parentHeight = book.store.tip().height;
      const spendTip = parentHeight + 1;
      for (const rec of leaves) {
        assert.ok(spendTip - rec.height + 1 >= SPENDABLE_CONFIRMATIONS, rec.height);
      }
      const spends = leaves.map((rec, i) => {
        const amount = rec.leaf.unit;
        const outs = i === leaves.length - 1 && amount > 1
          ? [sealMintOut(1, payer.dest, 'b-spend'), sealMintOut(amount - 1, payer.dest, 'b-spend')]
          : [sealMintOut(amount, payer.dest, 'b-spend')];
        const sum = outs.reduce((n, o) => n + openedCoinbaseNanos(o), 0);
        assert.equal(sum, amount);
        const excess = excessOf(outs);
        assert.ok(excess);
        assert.equal(verifyMintSum(outs, amount, excess), true);
        const tx = {
          id: `draw-${amount}`,
          kind: 'b-spend',
          bFlag: 1,
          fee: 0,
          unit: amount,
          nonce: rec.leaf.nonce,
          dest20: rec.leaf.dest20,
          leaf: rec.leaf,
          proof: rec.proof,
          index: 0,
          commitHeight: rec.height,
          commitHeader: Buffer.alloc(128, 3),
          commitRootA: Buffer.alloc(32, 4),
          commitRootB: Buffer.alloc(32, 5),
          excess,
          vin: [{ address: payer.dest }],
          vout: outs,
        };
        signSpendTx(tx, payer.key);
        return tx;
      });
      const tpl = templateOn(book.store, { miner: payer.dest, txs: spends });
      assert.equal((tpl.bLeaves || []).length, 0);
      const got = await appendTpl(book.store, tpl);
      assert.equal(got.ok, true, `${got.reason || ''} ${got.error || ''}`);
      assert.equal(book.store.tip().height, spendTip);
      const released = auditCirculatingSupply(book.store.blocks);
      assert.equal(released.status, 'verified', released.reason);
      assert.equal(released.bLockedNanos, 0);
      const again = await Promise.resolve(book.store.probeBlock(
        asBlock(templateOn(book.store, { miner: payer.dest, txs: [spends[0]] })),
      ));
      assert.equal(again.ok, false);
      assert.equal(again.reason, 'double_open');
    } finally {
      book.close();
    }
  });
});

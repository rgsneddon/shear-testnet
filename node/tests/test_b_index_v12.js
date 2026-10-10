/**
 * N-56: one B leaf opens once, at the position the proof path names.
 * A tx-supplied index that is not that position is proof.
 * The padded slot beside an odd leaf is not a second position.
 * The same position again is double_open, including after a restart.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { bLeafBytes, bProof, bindBSpend, buildDualTree, spendB } from '../../crypto/clearing.js';
import { encodeHeader } from '../../crypto/header.js';
import { EMPTY_ROOT, merkleVerify } from '../../crypto/merkle.js';
import { sha256 } from '../../crypto/shear_hash.js';
import { excessOf, openedCoinbaseNanos, verifyMintSum } from '../../crypto/note.js';
import {
  appendTpl,
  asBlock,
  openStore,
  payerIdentity,
  sealBalanced,
  sealEmpty,
  sealMintOut,
  stampNow,
  templateOn,
} from './b_leaf_fund.js';

const COUNTS = [1, 2, 3, 5];
const UNITS = [1, 2 ** 20];
const FOREIGN = [0, 1, 7, 123456];
const HEIGHT = 1;

function leafAt(unit, n) {
  return {
    dest20: Buffer.alloc(20, n + 1),
    unit,
    nonce: n + 1,
    memoH: Buffer.alloc(32, n + 3),
    tag: 'b',
  };
}

function headerFor(tree) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: EMPTY_ROOT,
    continuityRoot: tree.continuityRoot,
    timestamp: 1n,
    bits: 14,
    nonce: 0n,
    baseFee: 1n,
  });
}

function matureTip(height) {
  return height + SPENDABLE_CONFIRMATIONS - 1;
}

/** Flip the n-th honest self-pad step from R to L. That is the padded slot. */
function paddedProof(digest, proof, nth) {
  let h = Buffer.from(digest);
  let seen = 0;
  const next = proof.map((step) => ({ side: step.side, hash: step.hash }));
  for (let i = 0; i < next.length; i += 1) {
    const sib = Buffer.from(String(next[i].hash || ''), 'hex');
    const pad = next[i].side === 'R' && sib.length === 32 && sib.equals(h);
    if (pad && seen === nth) {
      next[i] = { side: 'L', hash: next[i].hash };
      return next;
    }
    if (pad) seen += 1;
    const left = next[i].side === 'L' ? sib : h;
    const right = next[i].side === 'L' ? h : sib;
    h = sha256(Buffer.concat([left, right]));
  }
  return null;
}

function spendAt(tree, leaves, index, proof, spent, indexValue) {
  const leaf = leaves[index];
  return spendB({
    leaf,
    proof,
    header: headerFor(tree),
    rootA: tree.rootA,
    rootB: tree.rootB,
    height: HEIGHT,
    index: indexValue === undefined ? index : indexValue,
    tipHeight: matureTip(HEIGHT),
    spent,
  });
}

describe('v12 one B leaf per position', () => {
  it('a foreign index or a padded slot does not open the leaf', () => {
    assert.equal(SPENDABLE_CONFIRMATIONS >= 1, true);
    assert.ok(COUNTS.includes(1) && COUNTS.includes(3) && COUNTS.includes(5));
    assert.ok(UNITS.some((n) => n > 1));
    const dest = payerIdentity().dest;
    for (const unit of UNITS) {
      const opened = sealMintOut(unit, dest, 'b-spend');
      assert.equal(openedCoinbaseNanos(opened), unit);
      for (const count of COUNTS) {
        const leaves = [];
        for (let n = 0; n < count; n += 1) leaves.push(leafAt(unit, n));
        const tree = buildDualTree({ aLeaves: [{ dest20: leaves[0].dest20, count: 1 }], bLeaves: leaves });
        const block = {
          height: HEIGHT,
          header: headerFor(tree),
          rootA: tree.rootA,
          rootB: tree.rootB,
          bLeaves: leaves,
        };
        for (let index = 0; index < count; index += 1) {
          const leaf = leaves[index];
          const proof = bProof(leaves, index);
          const digest = bLeafBytes(leaf);
          assert.equal(merkleVerify(digest, proof, tree.rootB), true, `${unit} ${count} ${index}`);
          const spent = new Set();
          const honest = spendAt(tree, leaves, index, proof, spent);
          assert.equal(honest.ok, true, `${unit} ${count} ${index} ${honest.reason}`);
          assert.equal(spent.size, 1);
          const again = spendAt(tree, leaves, index, proof, spent);
          assert.equal(again.ok, false, `${unit} ${count} ${index}`);
          assert.equal(again.reason, 'double_open', `${unit} ${count} ${index} ${again.reason}`);
          assert.equal(spent.size, 1);
          const fresh = new Set();
          for (const foreign of FOREIGN) {
            if (foreign === index) continue;
            const got = spendAt(tree, leaves, index, proof, fresh, foreign);
            assert.equal(got.ok, false, `${unit} ${count} ${index} idx ${foreign} opened ${got.ok}`);
            assert.equal(got.reason, 'proof', `${unit} ${count} ${index} idx ${foreign} ${got.reason}`);
            assert.equal(fresh.size, 0, foreign);
          }
          for (const bad of ['7', true, -1, 1.5]) {
            const got = spendAt(tree, leaves, index, proof, fresh, bad);
            assert.equal(got.ok, false, `${unit} ${count} ${String(bad)}`);
            assert.equal(got.reason, 'proof', `${unit} ${count} ${String(bad)} ${got.reason}`);
            assert.equal(fresh.size, 0);
          }
          if (index !== 0) {
            const omitted = spendB({
              leaf,
              proof,
              header: block.header,
              rootA: tree.rootA,
              rootB: tree.rootB,
              height: HEIGHT,
              tipHeight: matureTip(HEIGHT),
              spent: fresh,
            });
            assert.equal(omitted.ok, false, `${unit} ${count} ${index} omitted ${omitted.reason}`);
            assert.equal(omitted.reason, 'proof');
          }
          const outs = [opened];
          const bound = bindBSpend({
            kind: 'b-spend',
            leaf,
            proof,
            index,
            commitHeight: HEIGHT,
            vout: outs,
          }, {
            history: [block],
            tipHeight: matureTip(HEIGHT),
            spent: new Set(),
          });
          assert.equal(bound.ok, true, `${unit} ${count} ${index} ${bound.reason}`);
          for (const foreign of [1, 7, 123456]) {
            if (foreign === index) continue;
            const miss = bindBSpend({
              kind: 'b-spend',
              leaf,
              proof,
              index: foreign,
              commitHeight: HEIGHT,
              vout: outs,
            }, {
              history: [block],
              tipHeight: matureTip(HEIGHT),
              spent: new Set(),
            });
            assert.equal(miss.ok, false, `${unit} ${count} bind ${foreign}`);
            assert.equal(miss.reason, 'proof', `${unit} ${count} bind ${foreign} ${miss.reason}`);
          }
        }
        if (count % 2 === 1 && count > 1) {
          const index = count - 1;
          const leaf = leaves[index];
          const proof = bProof(leaves, index);
          const digest = bLeafBytes(leaf);
          const pads = count >= 5 ? [0, 1] : [0];
          for (const nth of pads) {
            const phantom = paddedProof(digest, proof, nth);
            assert.ok(phantom, `${unit} ${count} pad ${nth}`);
            assert.equal(merkleVerify(digest, phantom, tree.rootB), true, `${count} pad ${nth}`);
            for (const claimed of [index, count, count + nth]) {
              const got = spendAt(tree, leaves, index, phantom, new Set(), claimed);
              assert.equal(got.ok, false, `${unit} ${count} pad ${nth} idx ${claimed} opened ${got.ok}`);
              assert.equal(got.reason, 'proof', `${unit} ${count} pad ${nth} idx ${claimed} ${got.reason}`);
            }
          }
        }
      }
    }
  });

  it('queue, template, append, and restart open one position once', { timeout: 180_000 }, async () => {
    const payer = payerIdentity();
    const book = openStore('shear-b56-');
    try {
      const genesis = await sealEmpty(book.store, payer.dest);
      assert.equal(genesis.ok, true, `${genesis.reason || ''} ${genesis.error || ''}`);
      const sealed = await sealBalanced(book.store, payer, {
        ask: true,
        lockInInputs: true,
        unit: 1,
        nonce: 1,
        id: 'debit-1',
        spentNote: genesis.pot,
      });
      assert.equal(sealed.ok, true, sealed.reason);
      assert.equal(sealed.got.ok, true, `${sealed.got.reason || ''} ${sealed.got.error || ''}`);
      assert.equal(sealed.leaves.length, 1);
      assert.equal(sealed.leaf.unit, 1);
      const youngest = sealed.height;
      while (book.store.tip().height < youngest + SPENDABLE_CONFIRMATIONS - 2) {
        const pad = await sealEmpty(book.store, payer.dest);
        assert.equal(pad.ok, true, `${pad.reason || ''} ${pad.error || ''}`);
      }
      const spendTip = book.store.tip().height + 1;
      assert.ok(spendTip - youngest + 1 >= SPENDABLE_CONFIRMATIONS);
      const amount = sealed.leaf.unit;
      const outs = [sealMintOut(amount, payer.dest, 'b-spend')];
      assert.equal(verifyMintSum(outs, amount, excessOf(outs)), true);
      const base = {
        kind: 'b-spend',
        bFlag: 1,
        fee: 0,
        unit: amount,
        nonce: sealed.leaf.nonce,
        dest20: sealed.leaf.dest20,
        leaf: sealed.leaf,
        proof: sealed.proof,
        commitHeight: sealed.height,
        commitHeader: Buffer.alloc(128, 3),
        commitRootA: Buffer.alloc(32, 4),
        commitRootB: Buffer.alloc(32, 5),
        excess: excessOf(outs),
        vin: [{ address: payer.dest }],
        vout: outs,
      };
      const foreigners = [1, 7, 123456, '7', true, -1];
      for (const foreign of foreigners) {
        const tx = { ...base, id: `foreign-${String(foreign)}`, index: foreign };
        const queued = book.store.queueTx(tx);
        assert.equal(queued.ok, false, `${String(foreign)} ${queued.reason || 'queued'}`);
        assert.equal(queued.reason, 'proof', `${String(foreign)} ${queued.reason}`);
        book.store.mempool.push(tx);
      }
      const dirty = book.store.template({
        miner: payer.dest,
        shareBits: 4,
        now: stampNow(book.store),
      });
      assert.equal((dirty.tpl.bLeaves || []).length, 0);
      assert.ok(!(dirty.tpl.txs || []).some((row) => row && String(row.id || '').startsWith('foreign-')));
      assert.equal(book.store.mempool.length, 0);
      const honest = { ...base, id: 'draw-1', index: 0 };
      const queued = book.store.queueTx(honest);
      assert.equal(queued.ok, true, queued.reason);
      const twin = { ...honest, id: 'draw-1-twin' };
      book.store.mempool.push(twin);
      const paired = book.store.template({
        miner: payer.dest,
        shareBits: 4,
        now: stampNow(book.store),
      });
      const ids = (paired.tpl.txs || []).map((row) => row && row.id).filter(Boolean);
      assert.equal(ids.filter((id) => id === 'draw-1' || id === 'draw-1-twin').length, 1);
      assert.ok(!book.store.mempool.some((row) => row && row.id === 'draw-1-twin'));
      const got = await appendTpl(book.store, templateOn(book.store, { miner: payer.dest, txs: [honest] }));
      assert.equal(got.ok, true, `${got.reason || ''} ${got.error || ''}`);
      assert.equal(book.store.tip().height, spendTip);
      const replay = book.store.probeBlock(asBlock(templateOn(book.store, {
        miner: payer.dest,
        txs: [{ ...honest, id: 'draw-again' }],
      })));
      assert.equal(replay.ok, false, replay.reason);
      assert.equal(replay.reason, 'double_open');
      const bounced = createStore(book.dir);
      const after = bounced.probeBlock(asBlock(templateOn(bounced, {
        miner: payer.dest,
        txs: [{ ...honest, id: 'draw-restart' }],
      })));
      assert.equal(after.ok, false, after.reason);
      assert.equal(after.reason, 'double_open');
      const foreignAgain = bounced.queueTx({ ...base, id: 'foreign-restart', index: 7 });
      assert.equal(foreignAgain.ok, false, foreignAgain.reason);
      assert.equal(foreignAgain.reason, 'proof');
      assert.equal(bounced.tip().height, spendTip);
    } finally {
      book.close();
    }
  });
});

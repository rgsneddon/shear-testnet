/**
 * N-57: a b-spend pays leaf.dest20 and carries the leaf owner's signature.
 * A foreign dest is owner. A matching dest with no signature, or a stranger's
 * signature, is unsigned. Both checks run before the leaf is marked spent.
 * Any amount. A split pays that same dest on every output.
 * The sealed body keeps spendPub, so a compact b-spend still binds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { bindBSpend, bProof, buildDualTree, spendB } from '../../crypto/clearing.js';
import { encodeHeader } from '../../crypto/header.js';
import { EMPTY_ROOT } from '../../crypto/merkle.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { excessOf, noteCommitOfDest20, openedCoinbaseNanos } from '../../crypto/note.js';
import { signSpendTx } from '../../crypto/spend.js';
import { hash20FromAddress } from '../../crypto/address.js';
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

const AMOUNTS = [1, 2 ** 20];
const HEIGHT = 1;

function matureTip(height) {
  return height + SPENDABLE_CONFIRMATIONS - 1;
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

function sameCommit(note, dest20) {
  const want = noteCommitOfDest20(dest20);
  try {
    const got = Buffer.from(note?.noteCommit || []);
    return got.length === want.length && got.equals(want);
  } catch {
    return false;
  }
}

function leafFor(dest20, amount, nonce) {
  return {
    dest20: Buffer.from(dest20),
    unit: amount,
    nonce,
    memoH: Buffer.alloc(32, nonce),
    tag: 'b',
  };
}

function blockFor(leaf) {
  const tree = buildDualTree({ aLeaves: [], bLeaves: [leaf] });
  return {
    height: HEIGHT,
    header: headerFor(tree),
    rootA: tree.rootA,
    rootB: tree.rootB,
    bLeaves: [leaf],
  };
}

function spendBody(leaf, outs, extra = {}) {
  return {
    kind: 'b-spend',
    fee: 0,
    commitHeight: HEIGHT,
    index: 0,
    leaf,
    proof: bProof([leaf], 0),
    excess: excessOf(outs),
    vin: [{ address: extra.from || '' }],
    vout: outs,
    ...extra,
  };
}

describe('v12 b-spend pays its owner', () => {
  it('rejects a foreign dest and an unsigned spend on bindBSpend for any amount', () => {
    assert.ok(AMOUNTS.length >= 2);
    assert.ok(AMOUNTS.some((n) => n === 1));
    assert.ok(AMOUNTS.some((n) => n > 1));
    assert.equal(new Set(AMOUNTS).size, AMOUNTS.length);
    const owner = payerIdentity();
    const stranger = payerIdentity();
    const dest20 = hash20FromAddress(owner.dest);
    assert.equal(Buffer.from(dest20).length, 20);
    const tipHeight = matureTip(HEIGHT);
    const pictures = [];
    let rejected = true;
    for (const amount of AMOUNTS) {
      const leaf = leafFor(dest20, amount, amount === 1 ? 1 : 2);
      const block = blockFor(leaf);
      const own = sealMintOut(amount, owner.dest, 'b-spend');
      const foreign = sealMintOut(amount, stranger.dest, 'b-spend');
      assert.equal(openedCoinbaseNanos(own), amount);
      assert.equal(openedCoinbaseNanos(foreign), amount);
      assert.equal(sameCommit(own, leaf.dest20), true, amount);
      assert.equal(sameCommit(foreign, leaf.dest20), false, amount);
      const spentForeign = new Set();
      const stolenBody = spendBody(leaf, [foreign], { id: `foreign-${amount}`, from: stranger.dest });
      stolenBody.vin = [{}];
      delete stolenBody.from;
      signSpendTx(stolenBody, stranger.key);
      const foreignBound = bindBSpend(stolenBody, {
        history: [block],
        tipHeight,
        spent: spentForeign,
      });
      const bare = spendBody(leaf, [own], { id: `bare-${amount}`, from: owner.dest });
      delete bare.sig;
      delete bare.spendPub;
      const spentBare = new Set();
      const bareBound = bindBSpend(bare, {
        history: [block],
        tipHeight,
        spent: spentBare,
      });
      const strangerBody = spendBody(leaf, [own], { id: `stranger-${amount}` });
      strangerBody.vin = [{}];
      delete strangerBody.from;
      signSpendTx(strangerBody, stranger.key);
      const strangerBound = bindBSpend(strangerBody, {
        history: [block],
        tipHeight,
        spent: new Set(),
      });
      let splitText = 'split n/a';
      if (amount > 1) {
        const mixed = [
          sealMintOut(1, owner.dest, 'b-spend'),
          sealMintOut(amount - 1, stranger.dest, 'b-spend'),
        ];
        const mixedBody = spendBody(leaf, mixed, { id: `split-${amount}` });
        signSpendTx(mixedBody, owner.key);
        const mixedBound = bindBSpend(mixedBody, {
          history: [block],
          tipHeight,
          spent: new Set(),
        });
        splitText = `split ${mixedBound.ok}/${mixedBound.reason}`;
        if (mixedBound.ok !== false || mixedBound.reason !== 'owner') rejected = false;
      }
      const direct = spendB({
        leaf,
        proof: bProof([leaf], 0),
        header: block.header,
        rootA: block.rootA,
        rootB: block.rootB,
        height: HEIGHT,
        index: 0,
        tipHeight,
        spent: new Set(),
      });
      assert.equal(direct.ok, true, `${amount} spendB ${direct.reason}`);
      const row = [
        `${amount}`,
        `foreign ${foreignBound.ok}/${foreignBound.reason}/spent ${spentForeign.size}`,
        `bare ${bareBound.ok}/${bareBound.reason}/spent ${spentBare.size}`,
        `stranger ${strangerBound.ok}/${strangerBound.reason}`,
        splitText,
      ].join(' ');
      pictures.push(row);
      if (foreignBound.ok !== false || foreignBound.reason !== 'owner' || spentForeign.size !== 0) rejected = false;
      if (bareBound.ok !== false || bareBound.reason !== 'unsigned' || spentBare.size !== 0) rejected = false;
      if (strangerBound.ok !== false || strangerBound.reason !== 'unsigned') rejected = false;
    }
    assert.equal(rejected, true, pictures.join(' | '));

    for (const amount of AMOUNTS) {
      const leaf = leafFor(dest20, amount, 9);
      const block = blockFor(leaf);
      const own = sealMintOut(amount, owner.dest, 'b-spend');
      const overOut = sealMintOut(amount + amount, owner.dest, 'b-spend');
      const over = bindBSpend(spendBody(leaf, [overOut], { id: `over-${amount}` }), {
        history: [block],
        tipHeight,
        spent: new Set(),
      });
      assert.equal(over.ok, false, amount);
      assert.equal(over.reason, 'commit_sum', `${amount} ${over.reason}`);
      const badLeaf = { ...leaf, unit: `${amount}.0` };
      const bad = bindBSpend({
        ...spendBody(leaf, [own], { id: `bad-${amount}` }),
        leaf: badLeaf,
      }, {
        history: [block],
        tipHeight,
        spent: new Set(),
      });
      assert.equal(bad.ok, false, amount);
      assert.equal(bad.reason, 'leaf', `${amount} ${bad.reason}`);
      const stripped = { ...own };
      delete stripped.noteCommit;
      const missing = bindBSpend(spendBody(leaf, [stripped], { id: `nocommit-${amount}`, from: owner.dest }), {
        history: [block],
        tipHeight,
        spent: new Set(),
      });
      assert.equal(missing.ok, false, amount);
      assert.equal(missing.reason, 'owner', `${amount} ${missing.reason}`);
      const spent = new Set();
      const honest = spendBody(leaf, [own], { id: `honest-${amount}`, from: owner.dest });
      honest.vin = [{ address: owner.dest }];
      signSpendTx(honest, owner.key);
      const bound = bindBSpend(honest, { history: [block], tipHeight, spent });
      assert.equal(bound.ok, true, `${amount} ${bound.reason}`);
      assert.equal(spent.size, 1, amount);
      const again = bindBSpend(honest, { history: [block], tipHeight, spent });
      assert.equal(again.ok, false, amount);
      assert.equal(again.reason, 'double_open', `${amount} ${again.reason}`);
      if (amount > 1) {
        const parts = [
          sealMintOut(1, owner.dest, 'b-spend'),
          sealMintOut(amount - 1, owner.dest, 'b-spend'),
        ];
        assert.equal(parts.every((o) => sameCommit(o, leaf.dest20)), true);
        const split = spendBody(leaf, parts, { id: `ownersplit-${amount}`, from: owner.dest });
        split.vin = [{ address: owner.dest }];
        signSpendTx(split, owner.key);
        const opened = bindBSpend(split, {
          history: [block],
          tipHeight,
          spent: new Set(),
        });
        assert.equal(opened.ok, true, `${amount} split ${opened.reason}`);
      }
      const sealed = compactTx(honest);
      assert.ok(sealed.spendPub, `${amount} compact dropped spendPub`);
      assert.equal(sealed.sig, honest.sig, amount);
      const sealedBound = bindBSpend(sealed, {
        history: [block],
        tipHeight,
        spent: new Set(),
      });
      assert.equal(sealedBound.ok, true, `${amount} compact ${sealedBound.reason}`);
      const dropped = { ...sealed };
      delete dropped.spendPub;
      const droppedBound = bindBSpend(dropped, {
        history: [block],
        tipHeight,
        spent: new Set(),
      });
      assert.equal(droppedBound.ok, false, amount);
      assert.equal(droppedBound.reason, 'unsigned', `${amount} ${droppedBound.reason}`);
    }
  });

  it('queue, template, and append reject a foreign or unsigned spend', { timeout: 180_000 }, async () => {
    const owner = payerIdentity();
    const stranger = payerIdentity();
    const book = openStore('shear-n57-');
    try {
      const genesis = await sealEmpty(book.store, owner.dest);
      assert.equal(genesis.ok, true, `${genesis.reason || ''} ${genesis.error || ''}`);
      const opened = openedCoinbaseNanos(genesis.pot);
      assert.ok(Number.isSafeInteger(opened) && opened > (2 ** 20));
      const leaves = [];
      let pot = genesis.pot;
      for (let i = 0; i < AMOUNTS.length; i += 1) {
        const unit = AMOUNTS[i];
        const sealed = await sealBalanced(book.store, owner, {
          ask: true,
          lockInInputs: true,
          unit,
          nonce: i + 1,
          id: `fund-${unit}`,
          spentNote: pot,
        });
        assert.equal(sealed.ok, true, `${unit} ${sealed.reason || ''}`);
        assert.equal(sealed.got.ok, true, `${unit} ${sealed.got.reason || ''} ${sealed.got.error || ''}`);
        assert.equal(sealed.leaf.unit, unit);
        assert.ok(sealed.nextPot?.r, unit);
        pot = sealed.nextPot;
        leaves.push(sealed);
      }
      const youngest = Math.max(...leaves.map((rec) => rec.height));
      while (book.store.tip().height < youngest + SPENDABLE_CONFIRMATIONS - 2) {
        const pad = await sealEmpty(book.store, owner.dest);
        assert.equal(pad.ok, true, `${pad.reason || ''} ${pad.error || ''}`);
      }
      const spendTip = book.store.tip().height + 1;
      for (const rec of leaves) {
        assert.ok(spendTip - rec.height + 1 >= SPENDABLE_CONFIRMATIONS, rec.height);
      }

      const pictures = [];
      let rejected = true;
      const attacks = [];
      for (const rec of leaves) {
        const amount = rec.leaf.unit;
        const own = sealMintOut(amount, owner.dest, 'b-spend');
        const foreignOut = sealMintOut(amount, stranger.dest, 'b-spend');
        assert.equal(sameCommit(own, rec.leaf.dest20), true, amount);
        assert.equal(sameCommit(foreignOut, rec.leaf.dest20), false, amount);
        const foreign = {
          id: `atk-foreign-${amount}`,
          kind: 'b-spend',
          fee: 0,
          commitHeight: rec.height,
          index: 0,
          leaf: rec.leaf,
          proof: rec.proof,
          excess: excessOf([foreignOut]),
          vin: [{}],
          vout: [foreignOut],
        };
        signSpendTx(foreign, stranger.key);
        const bare = {
          id: `atk-bare-${amount}`,
          kind: 'b-spend',
          fee: 0,
          commitHeight: rec.height,
          index: 0,
          leaf: rec.leaf,
          proof: rec.proof,
          excess: excessOf([own]),
          vin: [{ address: owner.dest }],
          vout: [own],
        };
        const strangerTx = {
          id: `atk-stranger-${amount}`,
          kind: 'b-spend',
          fee: 0,
          commitHeight: rec.height,
          index: 0,
          leaf: rec.leaf,
          proof: rec.proof,
          excess: excessOf([own]),
          vin: [{}],
          vout: [own],
        };
        signSpendTx(strangerTx, stranger.key);
        const qForeign = book.store.queueTx(foreign);
        const qBare = book.store.queueTx(bare);
        const qStranger = book.store.queueTx(strangerTx);
        for (const tx of [foreign, bare, strangerTx]) {
          if (!book.store.mempool.some((m) => m && m.id === tx.id)) book.store.mempool.push(tx);
          attacks.push(tx);
        }
        const probed = await Promise.resolve(book.store.probeBlock(asBlock(templateOn(book.store, {
          miner: owner.dest,
          txs: [foreign],
        }))));
        const probedBare = await Promise.resolve(book.store.probeBlock(asBlock(templateOn(book.store, {
          miner: owner.dest,
          txs: [bare],
        }))));
        const row = [
          `${amount}`,
          `queue ${qForeign.ok}/${qForeign.reason}`,
          `bare ${qBare.ok}/${qBare.reason}`,
          `stranger ${qStranger.ok}/${qStranger.reason}`,
          `probe ${probed.ok}/${probed.reason}`,
          `probeBare ${probedBare.ok}/${probedBare.reason}`,
        ].join(' ');
        pictures.push(row);
        if (qForeign.ok !== false || qForeign.reason !== 'owner') rejected = false;
        if (qBare.ok !== false || qBare.reason !== 'unsigned') rejected = false;
        if (qStranger.ok !== false || qStranger.reason !== 'unsigned') rejected = false;
        if (probed.ok !== false || probed.reason !== 'owner') rejected = false;
        if (probedBare.ok !== false || probedBare.reason !== 'unsigned') rejected = false;
      }
      const dirty = book.store.template({
        miner: owner.dest,
        shareBits: 4,
        now: stampNow(book.store),
      });
      const ids = (dirty.tpl.txs || []).map((row) => row && row.id).filter((id) => String(id || '').startsWith('atk-'));
      pictures.push(`template ${ids.join(',') || 'none'} mempool ${book.store.mempool.length}`);
      if (ids.length !== 0 || book.store.mempool.length !== 0) rejected = false;
      assert.equal(rejected, true, pictures.join(' | '));

      const honest = leaves.map((rec) => {
        const amount = rec.leaf.unit;
        const outs = amount > 1
          ? [sealMintOut(1, owner.dest, 'b-spend'), sealMintOut(amount - 1, owner.dest, 'b-spend')]
          : [sealMintOut(amount, owner.dest, 'b-spend')];
        assert.equal(outs.reduce((sum, o) => sum + openedCoinbaseNanos(o), 0), amount);
        assert.equal(outs.every((o) => sameCommit(o, rec.leaf.dest20)), true, amount);
        const tx = {
          id: `draw-${amount}`,
          kind: 'b-spend',
          fee: 0,
          commitHeight: rec.height,
          index: 0,
          leaf: rec.leaf,
          proof: rec.proof,
          excess: excessOf(outs),
          vin: [{ address: owner.dest }],
          vout: outs,
        };
        signSpendTx(tx, owner.key);
        return tx;
      });
      for (const tx of honest) {
        const sealed = compactTx(tx);
        assert.ok(sealed.spendPub, `${tx.id} compact dropped spendPub`);
        const bound = bindBSpend(sealed, {
          history: book.store.blocks,
          prev: book.store.tip(),
          tipHeight: spendTip,
          spent: new Set(),
        });
        assert.equal(bound.ok, true, `${tx.id} compact ${bound.reason}`);
        const probed = await Promise.resolve(book.store.probeBlock(asBlock(templateOn(book.store, {
          miner: owner.dest,
          txs: [sealed],
        }))));
        assert.equal(probed.ok, true, `${tx.id} compact probe ${probed.reason}`);
      }
      for (const tx of honest) {
        const queued = book.store.queueTx(tx);
        assert.equal(queued.ok, true, `${tx.id} ${queued.reason}`);
      }
      const got = await appendTpl(book.store, templateOn(book.store, { miner: owner.dest, txs: honest }));
      assert.equal(got.ok, true, `${got.reason || ''} ${got.error || ''}`);
      assert.equal(book.store.tip().height, spendTip);
      const again = await Promise.resolve(book.store.probeBlock(asBlock(templateOn(book.store, {
        miner: owner.dest,
        txs: [{ ...honest[0], id: 'draw-again' }],
      }))));
      assert.equal(again.ok, false, again.reason);
      assert.equal(again.reason, 'double_open');
      const bounced = createStore(book.dir);
      const after = await Promise.resolve(bounced.probeBlock(asBlock(templateOn(bounced, {
        miner: owner.dest,
        txs: [{ ...honest[0], id: 'draw-restart' }],
      }))));
      assert.equal(after.ok, false, after.reason);
      assert.equal(after.reason, 'double_open');
      assert.equal(bounced.tip().height, spendTip);
    } finally {
      book.close();
    }
  });
});

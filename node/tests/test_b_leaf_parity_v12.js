/**
 * N-59: a b-spend carries a canonical tx.leaf.
 * The leaf is never derived from to, nanos, or an output address.
 * compactTx strips those fields. Raw and leanBlock must agree.
 * Any amount. A rejected leaf-less spend does not mark the leaf spent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { bindBSpend, bProof, buildDualTree } from '../../crypto/clearing.js';
import { encodeHeader } from '../../crypto/header.js';
import { EMPTY_ROOT } from '../../crypto/merkle.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { compactTx, leanBlock } from '../../crypto/chronoflux.js';
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

function outsFor(amount, dest) {
  if (amount > 1) {
    return [
      sealMintOut(1, dest, 'b-spend'),
      sealMintOut(amount - 1, dest, 'b-spend'),
    ];
  }
  return [sealMintOut(amount, dest, 'b-spend')];
}

function spendOf(leaf, outs, extra = {}) {
  const tx = {
    kind: 'b-spend',
    fee: 0,
    commitHeight: extra.commitHeight || HEIGHT,
    index: 0,
    proof: extra.proof || bProof([leaf], 0),
    excess: excessOf(outs),
    vin: [{ address: extra.payer || '' }],
    vout: outs,
    unit: leaf.unit,
    nonce: leaf.nonce,
    memoH: leaf.memoH,
    tag: leaf.tag,
    ...extra,
  };
  delete tx.payer;
  delete tx.dropTo;
  delete tx.dropUnit;
  delete tx.proof;
  tx.proof = extra.proof || bProof([leaf], 0);
  if (extra.dropTo) delete tx.to;
  if (extra.dropUnit) delete tx.unit;
  if (extra.dropLeaf) delete tx.leaf;
  return tx;
}

function bindAt(tx, block, tipHeight) {
  const spent = new Set();
  const raw = bindBSpend(tx, { history: [block], tipHeight, spent });
  const sealed = compactTx(tx);
  const spentSeal = new Set();
  const compact = bindBSpend(sealed, { history: [block], tipHeight, spent: spentSeal });
  return { raw, compact, spent: spent.size, spentSeal: spentSeal.size, sealed };
}

function textOf(bound, spent) {
  return `${bound.ok}/${bound.reason || ''}/spent ${spent}`;
}

describe('v12 b-spend leaf is canonical on the raw and lean body', () => {
  it('rejects a leaf-less spend on bindBSpend for any amount, raw and compact', () => {
    assert.ok(AMOUNTS.length >= 2);
    assert.ok(AMOUNTS.some((n) => n === 1));
    assert.ok(AMOUNTS.some((n) => n > 1));
    assert.equal(new Set(AMOUNTS).size, AMOUNTS.length);
    const owner = payerIdentity();
    const dest20 = hash20FromAddress(owner.dest);
    assert.equal(Buffer.from(dest20).length, 20);
    const tipHeight = matureTip(HEIGHT);
    const pictures = [];
    let agreed = true;
    for (const amount of AMOUNTS) {
      const leaf = leafFor(dest20, amount, amount === 1 ? 1 : 2);
      const block = blockFor(leaf);
      const outs = outsFor(amount, owner.dest);
      assert.equal(outs.reduce((sum, o) => sum + openedCoinbaseNanos(o), 0), amount);
      assert.equal(outs.every((o) => sameCommit(o, leaf.dest20)), true, amount);

      const honest = spendOf(leaf, outs, {
        id: `canon-${amount}`,
        leaf,
        to: owner.dest,
        payer: owner.dest,
      });
      signSpendTx(honest, owner.key);
      const canon = bindAt(honest, block, tipHeight);
      assert.equal(canon.raw.ok, true, `${amount} canon ${canon.raw.reason}`);
      assert.equal(canon.compact.ok, true, `${amount} canon compact ${canon.compact.reason}`);
      assert.equal(canon.spent, 1, amount);
      assert.equal(canon.sealed.to, undefined, amount);
      assert.equal(canon.sealed.nanos, undefined, amount);
      assert.ok(canon.sealed.leaf && canon.sealed.leaf.dest20, amount);
      assert.ok(canon.sealed.spendPub, amount);
      const again = bindBSpend(honest, { history: [block], tipHeight, spent: new Set([canon.raw.id]) });
      assert.equal(again.ok, false, amount);
      assert.equal(again.reason, 'double_open', `${amount} ${again.reason}`);

      const badLeaf = { ...leaf, unit: `${amount}.0` };
      const bad = spendOf(leaf, outs, {
        id: `bad-${amount}`,
        leaf: badLeaf,
        to: owner.dest,
        unit: amount,
        payer: owner.dest,
      });
      signSpendTx(bad, owner.key);
      const badBound = bindAt(bad, block, tipHeight);
      assert.equal(badBound.raw.ok, false, amount);
      assert.equal(badBound.raw.reason, 'leaf', `${amount} bad ${badBound.raw.reason}`);
      assert.equal(badBound.compact.ok, false, amount);
      assert.equal(badBound.compact.reason, 'leaf', `${amount} bad compact ${badBound.compact.reason}`);
      assert.equal(badBound.spent, 0, amount);

      const bare = spendOf(leaf, outs, {
        id: `bare-${amount}`,
        to: owner.dest,
        payer: owner.dest,
        dropLeaf: true,
      });
      signSpendTx(bare, owner.key);
      const bareBound = bindAt(bare, block, tipHeight);
      assert.equal(bareBound.sealed.to, undefined, amount);
      assert.equal(bareBound.sealed.nanos, undefined, amount);
      assert.equal(bareBound.sealed.leaf, undefined, amount);

      const byNanos = spendOf(leaf, outs, {
        id: `nanos-${amount}`,
        to: owner.dest,
        nanos: amount,
        payer: owner.dest,
        dropLeaf: true,
        dropUnit: true,
      });
      signSpendTx(byNanos, owner.key);
      const nanosBound = bindAt(byNanos, block, tipHeight);
      assert.equal(nanosBound.sealed.to, undefined, amount);
      assert.equal(nanosBound.sealed.nanos, undefined, amount);
      assert.equal(nanosBound.sealed.unit, undefined, amount);

      const byAddr = spendOf(leaf, outs, {
        id: `addr-${amount}`,
        payer: owner.dest,
        dropLeaf: true,
        dropTo: true,
      });
      signSpendTx(byAddr, owner.key);
      const addrBound = bindAt(byAddr, block, tipHeight);
      assert.equal(addrBound.sealed.to, undefined, amount);
      assert.equal(addrBound.sealed.vout[0].address, undefined, amount);

      const partialLeaf = { ...leaf };
      delete partialLeaf.dest20;
      const partial = spendOf(leaf, outs, {
        id: `part-${amount}`,
        leaf: partialLeaf,
        to: owner.dest,
        payer: owner.dest,
      });
      signSpendTx(partial, owner.key);
      const partBound = bindAt(partial, block, tipHeight);

      const row = [
        `${amount}`,
        `bare ${textOf(bareBound.raw, bareBound.spent)} compact ${textOf(bareBound.compact, bareBound.spentSeal)}`,
        `nanos ${textOf(nanosBound.raw, nanosBound.spent)} compact ${textOf(nanosBound.compact, nanosBound.spentSeal)}`,
        `addr ${textOf(addrBound.raw, addrBound.spent)} compact ${textOf(addrBound.compact, addrBound.spentSeal)}`,
        `part ${textOf(partBound.raw, partBound.spent)} compact ${textOf(partBound.compact, partBound.spentSeal)}`,
      ].join(' ');
      pictures.push(row);
      for (const got of [bareBound, nanosBound, addrBound, partBound]) {
        if (got.raw.ok !== false || got.raw.reason !== 'leaf' || got.spent !== 0) agreed = false;
        if (got.compact.ok !== false || got.compact.reason !== 'leaf' || got.spentSeal !== 0) agreed = false;
      }
    }
    assert.equal(agreed, true, pictures.join(' | '));
  });

  it('queue, template, append, and restart agree for any amount', { timeout: 180_000 }, async () => {
    const owner = payerIdentity();
    const book = openStore('shear-n59-');
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
        assert.ok(sealed.leaf.dest20, unit);
        assert.ok(Buffer.from(hash20FromAddress(owner.dest)).equals(Buffer.from(sealed.leaf.dest20)), unit);
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

      const bindOn = (tx) => {
        const spent = new Set();
        const raw = bindBSpend(tx, {
          history: book.store.blocks,
          prev: book.store.tip(),
          tipHeight: spendTip,
          spent,
        });
        const sealed = compactTx(tx);
        const spentSeal = new Set();
        const compact = bindBSpend(sealed, {
          history: book.store.blocks,
          prev: book.store.tip(),
          tipHeight: spendTip,
          spent: spentSeal,
        });
        return { raw, compact, spent: spent.size, spentSeal: spentSeal.size, sealed };
      };

      const pictures = [];
      let agreed = true;
      let poison = null;
      for (const rec of leaves) {
        const amount = rec.leaf.unit;
        const outs = outsFor(amount, owner.dest);
        assert.equal(outs.reduce((sum, o) => sum + openedCoinbaseNanos(o), 0), amount);
        assert.equal(outs.every((o) => sameCommit(o, rec.leaf.dest20)), true, amount);
        const bare = spendOf(rec.leaf, [sealMintOut(amount, owner.dest, 'b-spend')], {
          id: `bare-${amount}`,
          to: owner.dest,
          payer: owner.dest,
          commitHeight: rec.height,
          proof: rec.proof,
          dropLeaf: true,
        });
        signSpendTx(bare, owner.key);
        const bareBound = bindOn(bare);
        assert.equal(bareBound.sealed.to, undefined, amount);
        assert.equal(bareBound.sealed.leaf, undefined, amount);

        const byNanos = spendOf(rec.leaf, [sealMintOut(amount, owner.dest, 'b-spend')], {
          id: `nanos-${amount}`,
          to: owner.dest,
          nanos: amount,
          payer: owner.dest,
          commitHeight: rec.height,
          proof: rec.proof,
          dropLeaf: true,
          dropUnit: true,
        });
        signSpendTx(byNanos, owner.key);
        const nanosBound = bindOn(byNanos);

        const byAddr = spendOf(rec.leaf, [sealMintOut(amount, owner.dest, 'b-spend')], {
          id: `addr-${amount}`,
          payer: owner.dest,
          commitHeight: rec.height,
          proof: rec.proof,
          dropLeaf: true,
          dropTo: true,
        });
        signSpendTx(byAddr, owner.key);
        const addrBound = bindOn(byAddr);
        assert.equal(addrBound.sealed.vout[0].address, undefined, amount);

        const partialLeaf = { ...rec.leaf };
        delete partialLeaf.dest20;
        const partial = spendOf(rec.leaf, [sealMintOut(amount, owner.dest, 'b-spend')], {
          id: `part-${amount}`,
          leaf: partialLeaf,
          to: owner.dest,
          payer: owner.dest,
          commitHeight: rec.height,
          proof: rec.proof,
        });
        signSpendTx(partial, owner.key);
        const partBound = bindOn(partial);

        const queued = {
          bare: book.store.queueTx(bare),
          nanos: book.store.queueTx(byNanos),
          addr: book.store.queueTx(byAddr),
          part: book.store.queueTx(partial),
        };
        const rawTpl = templateOn(book.store, { miner: owner.dest, txs: [bare] });
        const probed = await Promise.resolve(book.store.probeBlock(asBlock(rawTpl)));
        const leaned = await Promise.resolve(book.store.probeBlock(leanBlock(asBlock(rawTpl))));
        if (probed.ok && !poison) poison = bare;

        const row = [
          `${amount}`,
          `bare ${textOf(bareBound.raw, bareBound.spent)} compact ${textOf(bareBound.compact, bareBound.spentSeal)}`,
          `queue ${queued.bare.ok}/${queued.bare.reason || ''}`,
          `nanos ${textOf(nanosBound.raw, nanosBound.spent)} q ${queued.nanos.ok}/${queued.nanos.reason || ''}`,
          `addr ${textOf(addrBound.raw, addrBound.spent)} q ${queued.addr.ok}/${queued.addr.reason || ''}`,
          `part ${textOf(partBound.raw, partBound.spent)} q ${queued.part.ok}/${queued.part.reason || ''}`,
          `probe ${probed.ok}/${probed.reason || ''}`,
          `lean ${leaned.ok}/${leaned.reason || ''}`,
        ].join(' ');
        pictures.push(row);
        for (const got of [bareBound, nanosBound, addrBound, partBound]) {
          if (got.raw.ok !== false || got.raw.reason !== 'leaf' || got.spent !== 0) agreed = false;
          if (got.compact.ok !== false || got.compact.reason !== 'leaf' || got.spentSeal !== 0) agreed = false;
        }
        for (const q of Object.values(queued)) {
          if (q.ok !== false || q.reason !== 'leaf') agreed = false;
        }
        if (probed.ok !== false || probed.reason !== 'leaf') agreed = false;
        if (leaned.ok !== false || leaned.reason !== 'leaf') agreed = false;
      }

      try {
        const dirty = book.store.template({
          miner: owner.dest,
          shareBits: 4,
          now: stampNow(book.store),
        });
        const ids = (dirty.tpl.txs || []).map((row) => row && row.id).filter((id) => /^(bare|nanos|addr|part)-/.test(String(id || '')));
        pictures.push(`template ${ids.join(',') || 'none'} mempool ${book.store.mempool.length}`);
        if (ids.length !== 0 || book.store.mempool.length !== 0) agreed = false;
      } catch (err) {
        pictures.push(`template throw ${err && err.message ? err.message : err}`);
        agreed = false;
      }

      let reload = 'not-appended';
      if (poison) {
        try {
          const got = await appendTpl(book.store, templateOn(book.store, { miner: owner.dest, txs: [poison] }));
          reload = `append ${got.ok}/${got.reason || ''} ${got.error || ''}`.trim();
          if (got.ok) {
            const stored = (book.store.tip().txs || []).find((row) => row && row.id === poison.id);
            const addr = stored?.vout?.[0]?.address;
            reload += stored
              ? ` stored to ${stored.to == null ? 'no' : 'yes'} leaf ${stored.leaf && stored.leaf.dest20 != null ? 'yes' : 'no'} unit ${stored.unit == null ? 'no' : 'yes'} nanos ${stored.nanos == null ? 'no' : 'yes'} addr ${addr == null ? 'no' : 'yes'} ids ${(book.store.tip().bSpendIds || []).length}`
              : ' stored missing';
            try {
              const snap = createStore(book.dir);
              reload += ` snap ${snap.tip().height}`;
            } catch (err) {
              reload += ` snap ${err && err.message ? err.message : err}`;
            }
            const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n59-replay-'));
            try {
              fs.cpSync(book.dir, replayDir, { recursive: true });
              fs.copyFileSync(bookSealKeyPath(book.dir), bookSealKeyPath(replayDir));
              fs.rmSync(path.join(replayDir, 'book.snap'), { force: true });
              try {
                const full = createStore(replayDir);
                reload += ` replay ${full.tip().height}`;
              } catch (err) {
                reload += ` replay ${err && err.message ? err.message : err}`;
              }
            } finally {
              fs.rmSync(replayDir, { recursive: true, force: true });
              fs.rmSync(bookSealKeyPath(replayDir), { force: true });
            }
          }
        } catch (err) {
          reload = `throw ${err && err.message ? err.message : err}`;
        }
      }
      pictures.push(reload);
      if (reload !== 'not-appended') agreed = false;
      assert.equal(agreed, true, pictures.join(' | '));

      const honest = leaves.map((rec) => {
        const amount = rec.leaf.unit;
        const outs = outsFor(amount, owner.dest);
        const tx = spendOf(rec.leaf, outs, {
          id: `draw-${amount}`,
          leaf: rec.leaf,
          to: owner.dest,
          payer: owner.dest,
          commitHeight: rec.height,
          proof: rec.proof,
        });
        signSpendTx(tx, owner.key);
        return tx;
      });
      for (const tx of honest) {
        const sealed = compactTx(tx);
        assert.equal(sealed.to, undefined, tx.id);
        assert.equal(sealed.nanos, undefined, tx.id);
        assert.ok(sealed.leaf && sealed.leaf.dest20, tx.id);
        assert.ok(sealed.spendPub, tx.id);
        const bound = bindOn(sealed);
        assert.equal(bound.raw.ok, true, `${tx.id} compact ${bound.raw.reason}`);
        const rawTpl = templateOn(book.store, { miner: owner.dest, txs: [tx] });
        const leaned = await Promise.resolve(book.store.probeBlock(leanBlock(asBlock(rawTpl))));
        assert.equal(leaned.ok, true, `${tx.id} lean ${leaned.reason}`);
        const queued = book.store.queueTx(tx);
        assert.equal(queued.ok, true, `${tx.id} ${queued.reason}`);
      }
      const got = await appendTpl(book.store, templateOn(book.store, { miner: owner.dest, txs: honest }));
      assert.equal(got.ok, true, `${got.reason || ''} ${got.error || ''}`);
      assert.equal(book.store.tip().height, spendTip);
      for (const tx of honest) {
        const stored = (book.store.tip().txs || []).find((row) => row && row.id === tx.id);
        assert.ok(stored, tx.id);
        assert.equal(stored.to, undefined, tx.id);
        assert.equal(stored.nanos, undefined, tx.id);
        assert.ok(stored.leaf && stored.leaf.dest20, tx.id);
        const bound = bindBSpend(stored, {
          history: book.store.blocks,
          prev: book.store.tip(),
          tipHeight: book.store.tip().height,
          spent: new Set(),
        });
        assert.equal(bound.ok, true, `${tx.id} stored ${bound.reason}`);
      }
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
      const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n59-full-'));
      try {
        fs.cpSync(book.dir, replayDir, { recursive: true });
        fs.copyFileSync(bookSealKeyPath(book.dir), bookSealKeyPath(replayDir));
        fs.rmSync(path.join(replayDir, 'book.snap'), { force: true });
        const full = createStore(replayDir);
        const replayed = await Promise.resolve(full.probeBlock(asBlock(templateOn(full, {
          miner: owner.dest,
          txs: [{ ...honest[0], id: 'draw-replay' }],
        }))));
        assert.equal(replayed.ok, false, replayed.reason);
        assert.equal(replayed.reason, 'double_open');
        assert.equal(full.tip().height, spendTip);
      } finally {
        fs.rmSync(replayDir, { recursive: true, force: true });
        fs.rmSync(bookSealKeyPath(replayDir), { force: true });
      }
    } finally {
      book.close();
    }
  });
});

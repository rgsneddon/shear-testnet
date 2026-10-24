import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, spendDestOf, hash20FromAddress } from '../../crypto/address.js';
import { SPENDABLE_CONFIRMATIONS, GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import {
  noteCommitSpendableNanos,
  noteCommitBlocksWalked,
  resetNoteCommitBlocksWalked,
} from '../../crypto/coinbase_notes.js';
import { sealCoinbaseNote, sealHiddenNote, noteCommitOfDest20 } from '../../crypto/note.js';
import { signSpendTx } from '../../crypto/spend.js';
import { createStore } from '../src/store.js';
import { buildTemplate, GENESIS_PREV } from '../src/chain.js';

/**
 * A painted send that names its amount in clear (tx.nanos). Since AL-1 a
 * hidden-kind tx with a plaintext amount is amount_field on queue and in the
 * template walk, before any painted debit is priced against the book.
 */
function paintedSend(from, to, nanos, key, id) {
  const pay = sealCoinbaseNote(nanos, { dest20: hash20FromAddress(to), kind: 'send' });
  delete pay.valueProof;
  const dummy = sealCoinbaseNote(0, { dest20: Buffer.alloc(20, 9), kind: 'dummy' });
  const tx = {
    id,
    kind: 'send',
    from,
    to,
    nanos,
    fee: 0,
    vin: [{ address: from }],
    vout: [{ ...pay, address: to }, dummy],
  };
  signSpendTx(tx, key);
  return tx;
}

/**
 * The same painted spend on the v12 wire: the paid output is hidden (range
 * proof, rEph, rCt, amtCt to the payee), the tx names no amount, and there is
 * no membership proof. Nothing on the body prices a debit, so the node never
 * opens the book for it, and it is admit_membership at any amount.
 */
function hiddenPaintedSend(from, to, toAdmitBase, nanos, key, id) {
  const pay = sealHiddenNote(nanos, { dest20: hash20FromAddress(to), kind: 'send', admitBase: toAdmitBase });
  assert.ok(pay.rEph && pay.rCt && pay.amtCt, 'hidden pay output is wrapped to the payee');
  assert.equal(Object.prototype.hasOwnProperty.call(pay, 'valueProof'), false);
  const dummy = sealCoinbaseNote(0, { dest20: Buffer.alloc(20, 9), kind: 'dummy' });
  const tx = {
    id,
    kind: 'send',
    from,
    to,
    fee: 0,
    vin: [{ address: from }],
    vout: [{ ...pay, address: to }, dummy],
  };
  signSpendTx(tx, key);
  return tx;
}

function loadBook(store, H, amount, notes, dest, other) {
  store.blocks.length = 0;
  store.explorer.length = 0;
  const note = sealCoinbaseNote(amount, { dest20: hash20FromAddress(dest), kind: 'pot' });
  const otherNc = noteCommitOfDest20(hash20FromAddress(other));
  for (let h = 1; h <= H; h += 1) {
    const hash = Buffer.alloc(32, 0);
    hash.writeUInt32BE(h, 28);
    hash[0] = amount & 0xff;
    hash[1] = notes & 0xff;
    const vout = [];
    if (h === 1) {
      for (let n = 0; n < notes; n += 1) vout.push(note);
      vout.push({ ...note, kind: 'lock' });
      vout.push({ kind: 'pot', noteCommit: note.noteCommit, nanos: amount });
    } else {
      vout.push({ kind: 'pot', noteCommit: otherNc });
    }
    store.blocks.push({
      height: h,
      hash,
      header: Buffer.alloc(128),
      txs: [{ coinbase: true, vout }],
    });
    store.explorer.push({
      id: `plain-${H}-${amount}-${notes}-${h}`,
      to: dest,
      from: 'coinbase',
      height: h,
      kind: 'send',
      nanos: amount * 1000,
      noteCommit: note.noteCommit,
    });
  }
}

describe('spend paths use the note index', { concurrency: 1 }, () => {
  it('queueTx, painted template hold, and fork verify stay on the indexed book', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-spend-paths-v12-'));
    const who = newIdentity();
    const otherId = newIdentity();
    const dest = spendDestOf(who.spendPub);
    const other = spendDestOf(otherId.spendPub);
    const store = createStore(dir);
    const skips = [];
    const orig = console.error;
    console.error = (...args) => {
      skips.push(args.map((part) => String(part)).join(' '));
    };
    try {
      const heights = [1, SPENDABLE_CONFIRMATIONS + 2, 64, 256];
      const amounts = [1, 1000, 7_000_003];
      const counts = [1, 4];
      for (const H of heights) {
        for (const amount of amounts) {
          for (const notes of counts) {
            loadBook(store, H, amount, notes, dest, other);
            store.spendableNanos(dest);
            store.resetWalletWalkStats();
            resetNoteCommitBlocksWalked();
            const have = store.spendableNanos(dest);
            const mature = H >= 1 + SPENDABLE_CONFIRMATIONS;
            const want = mature ? amount * notes : 0;
            assert.equal(have, want, `H=${H} amount=${amount} notes=${notes}`);
            assert.equal(have, noteCommitSpendableNanos(store.blocks, dest, H));
            assert.notEqual(have, want + amount);
            assert.notEqual(have, amount * 1000);
            resetNoteCommitBlocksWalked();
            store.resetWalletWalkStats();
            const asks = [1, Math.max(1, have), have + 1];
            for (const ask of asks) {
              // A plaintext amount is amount_field (AL-1) before the book is read.
              const plain = store.queueTx(paintedSend(dest, other, ask, who.privateKey, `q-${H}-${amount}-${notes}-${ask}`));
              assert.equal(plain.ok, false, `H=${H} ask=${ask}`);
              assert.equal(plain.reason, 'amount_field');
              // The v12 wire names no amount. With no proof it is never funded.
              const got = store.queueTx(hiddenPaintedSend(dest, other, otherId.admitBase, ask, who.privateKey, `h-${H}-${amount}-${notes}-${ask}`));
              assert.equal(got.ok, false, `H=${H} ask=${ask}`);
              assert.equal(got.reason, 'admit_membership', `H=${H} ask=${ask} ${got.reason}`);
            }
            assert.equal(store.mempool.length, 0);
            const st = store.walletWalkStats();
            // No painted debit reaches the book: neither spend names an amount the queue may price.
            assert.equal(st.spendChecks, 0, `H=${H} amount=${amount} notes=${notes}`);
            assert.equal(st.forkSpendChecks, 0);
            assert.equal(st.syncBlocks, 0, `H=${H}`);
            assert.equal(noteCommitBlocksWalked(), 0, `H=${H} amount=${amount} notes=${notes}`);
            assert.equal(store.spendableNanos(dest), have);
          }
        }
      }

      loadBook(store, 64, 1000, 4, dest, other);
      store.spendableNanos(dest);
      store.resetWalletWalkStats();
      resetNoteCommitBlocksWalked();
      const have = store.spendableNanos(dest);
      assert.equal(have, 4000);
      // Pushed past queueTx, as a peer relay or an old mempool would hold them.
      store.mempool.push(paintedSend(dest, other, have + 5, who.privateKey, 'held'));
      store.mempool.push(hiddenPaintedSend(dest, other, otherId.admitBase, 1, who.privateKey, 'covered'));
      skips.length = 0;
      // The lookup above is one spend check. The template must add none: no
      // painted send is held against owed nanos any more (e2bd74cf).
      const checksBefore = store.walletWalkStats().spendChecks;
      const built = store.template({ miner: dest });
      const packed = new Set((built.tpl.txs || []).map((tx) => tx.id).filter(Boolean));
      assert.equal(packed.has('held'), false);
      assert.equal(packed.has('covered'), false);
      // The plaintext painted spend is dropped as amount_field. It is never held
      // against owed nanos, so a painted amount cannot wait in the pool for cover.
      assert.ok(skips.some((line) => line.includes('amount_field') && line.includes('held')));
      assert.equal(skips.some((line) => line.includes('painted_hold')), false);
      assert.ok(skips.some((line) => line.includes('admit_membership') && line.includes('covered')));
      assert.deepEqual(store.mempool.map((tx) => tx.id), ['covered']);
      assert.equal(noteCommitBlocksWalked(), 0);
      assert.equal(store.walletWalkStats().spendChecks, checksBefore);
      assert.equal(store.spendableNanos(dest), have);

      store.mempool.length = 0;
      const debit = hiddenPaintedSend(dest, other, otherId.admitBase, 50, who.privateKey, 'fork-debit');
      const forkTpl = buildTemplate({
        prev: GENESIS_PREV,
        height: 1,
        miner: dest,
        now: 1_700_000_000_000,
        bits: GENESIS_BITS_PACKED,
        txs: [debit],
        parentBlocks: [],
      });
      const block = {
        header: forkTpl.header,
        txs: forkTpl.txs,
        samples: forkTpl.samples,
        shareBatch: forkTpl.shareBatch || [],
        miner: dest,
        aLeaves: forkTpl.aLeaves,
        bLeaves: forkTpl.bLeaves,
        rootA: forkTpl.rootA,
        rootB: forkTpl.rootB,
        hash: Buffer.alloc(32, 7),
      };
      assert.ok((block.txs || []).some((tx) => tx.id === 'fork-debit'));
      store.resetWalletWalkStats();
      resetNoteCommitBlocksWalked();
      const before = store.spendableNanos(dest);
      store.resetWalletWalkStats();
      resetNoteCommitBlocksWalked();
      const verdict = store.verifyFork([block], { probeBody: true, skipSharePow: true });
      assert.equal(typeof verdict.then, 'undefined');
      assert.equal(verdict.ok, false, verdict.reason);
      // Stage 0 refuses a fork carrying a proofless send before any spend check or walk.
      assert.equal(verdict.reason, 'send_unavailable');
      const forkStats = store.walletWalkStats();
      assert.equal(forkStats.forkSpendChecks, 0, `fork checks ${forkStats.forkSpendChecks} reason ${verdict.reason}`);
      assert.equal(forkStats.spendChecks, 0);
      assert.equal(noteCommitBlocksWalked(), 0);
      assert.equal(store.spendableNanos(dest), before);
      assert.equal(store.walletWalkStats().forkSpendChecks, forkStats.forkSpendChecks);
    } finally {
      console.error = orig;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

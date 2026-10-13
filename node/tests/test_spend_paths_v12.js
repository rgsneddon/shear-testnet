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
import { sealCoinbaseNote, noteCommitOfDest20 } from '../../crypto/note.js';
import { signSpendTx } from '../../crypto/spend.js';
import { createStore } from '../src/store.js';
import { buildTemplate, GENESIS_PREV } from '../src/chain.js';

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
              const got = store.queueTx(paintedSend(dest, other, ask, who.privateKey, `q-${H}-${amount}-${notes}-${ask}`));
              assert.equal(got.ok, false, `H=${H} ask=${ask}`);
              assert.equal(got.reason, 'admit_membership');
            }
            assert.equal(store.mempool.length, 0);
            const st = store.walletWalkStats();
            assert.equal(st.spendChecks, asks.length, `H=${H} amount=${amount} notes=${notes}`);
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
      store.mempool.push(paintedSend(dest, other, have + 5, who.privateKey, 'held'));
      store.mempool.push(paintedSend(dest, other, 1, who.privateKey, 'covered'));
      skips.length = 0;
      const built = store.template({ miner: dest });
      const packed = new Set((built.tpl.txs || []).map((tx) => tx.id).filter(Boolean));
      assert.equal(packed.has('held'), false);
      assert.equal(packed.has('covered'), false);
      assert.deepEqual(store.mempool.map((tx) => tx.id), ['held', 'covered']);
      assert.ok(skips.some((line) => line.includes('painted_hold') && line.includes('held')));
      assert.ok(skips.some((line) => line.includes('admit_membership') && line.includes('covered')));
      assert.equal(noteCommitBlocksWalked(), 0);
      assert.ok(store.walletWalkStats().spendChecks >= 1);
      assert.equal(store.spendableNanos(dest), have);

      store.mempool.length = 0;
      const debit = paintedSend(dest, other, 50, who.privateKey, 'fork-debit');
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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, spendDestOf, hash20FromAddress, destOpeningFromView } from '../../crypto/address.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import {
  noteCommitSpendableNanos,
  noteCommitBlocksWalked,
  resetNoteCommitBlocksWalked,
} from '../../crypto/coinbase_notes.js';
import { noteCommitOfDest20, sealCoinbaseNote } from '../../crypto/note.js';
import { createStore } from '../src/store.js';
import { handleWalletApi, reconstructOwner } from '../../pool/src/wallet_api.js';

function url(pathAndQuery) {
  return new URL(`http://127.0.0.1${pathAndQuery}`);
}

function loadBook(store, H, fan, own, dest, other, destNc, otherNc) {
  store.blocks.length = 0;
  store.explorer.length = 0;
  let placed = 0;
  let total = 0;
  for (let h = 1; h <= H; h += 1) {
    const hash = Buffer.alloc(32);
    hash.writeUInt32BE(h, 28);
    hash.writeUInt16BE(fan, 24);
    hash.writeUInt16BE(own, 22);
    const vout = [];
    for (let j = 0; j < fan; j += 1) {
      const mine = placed < own;
      if (mine) placed += 1;
      total += 1;
      const nc = mine ? destNc : otherNc;
      vout.push({ kind: 'pot', noteCommit: nc });
      store.explorer.push({
        id: `${h}:${j}:${own}:${fan}`,
        to: mine ? dest : other,
        from: 'coinbase',
        height: h,
        kind: 'send',
        noteCommit: nc,
        nanos: 0,
      });
    }
    store.blocks.push({
      height: h,
      hash,
      header: Buffer.alloc(128),
      txs: [{ coinbase: true, vout }],
    });
  }
  return { placed, total };
}

function measure(store, dest, open) {
  store.spendableNanos(dest);
  store.historyFor(dest);
  reconstructOwner(store, dest);
  const balance = handleWalletApi(
    url(`/api/wallet/balance?address=${encodeURIComponent(dest)}&open=${open}`),
    'GET',
    {},
    { store },
  );
  const history = handleWalletApi(
    url(`/api/wallet/history?address=${encodeURIComponent(dest)}&open=${open}`),
    'GET',
    {},
    { store },
  );
  const notes = handleWalletApi(
    url(`/api/wallet/notes?address=${encodeURIComponent(dest)}&open=${open}`),
    'GET',
    {},
    { store },
  );
  assert.equal(balance.json.ok, true);
  assert.equal(history.json.ok, true);
  assert.equal(notes.json.ok, true);
  return store.walletWalkStats();
}

describe('wallet walks stay on the caller notes', { concurrency: 1 }, () => {
  it('balance, history, notes, and spendable stay flat as height and fanout grow', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-walk-v12-'));
    const who = newIdentity();
    const otherId = newIdentity();
    const dest = spendDestOf(who.spendPub);
    const other = spendDestOf(otherId.spendPub);
    const destNc = noteCommitOfDest20(hash20FromAddress(dest));
    const otherNc = noteCommitOfDest20(hash20FromAddress(other));
    const open = destOpeningFromView(who.viewKey, who.spendPub);
    const store = createStore(dir);
    const seen = new Map();
    try {
      resetNoteCommitBlocksWalked();
      const beforeTpl = noteCommitBlocksWalked();
      store.template({ miner: dest });
      assert.equal(noteCommitBlocksWalked(), beforeTpl);
      assert.equal(store.walletWalkStats().queryBlocks, 0);
      for (const H of [1, 8, 64, 256]) {
        for (const fan of [1, 8, 64]) {
          for (const own of [1, 4, 16]) {
            const built = loadBook(store, H, fan, own, dest, other, destNc, otherNc);
            measure(store, dest, open);
            store.resetWalletWalkStats();
            resetNoteCommitBlocksWalked();
            const st = measure(store, dest, open);
            assert.equal(st.queryBlocks, 0, `H=${H} fan=${fan} own=${own}`);
            assert.equal(st.syncBlocks, 0, `H=${H} fan=${fan} own=${own}`);
            assert.equal(st.histSyncRows, 0, `H=${H} fan=${fan} own=${own}`);
            assert.equal(noteCommitBlocksWalked(), 0, `H=${H} fan=${fan} own=${own}`);
            assert.ok(st.queryOutputs > 0);
            assert.ok(st.queryOutputs <= built.placed * 16, `outputs ${st.queryOutputs} placed ${built.placed}`);
            assert.ok(st.histQueryRows > 0);
            assert.ok(st.histQueryRows <= built.placed * 16, `rows ${st.histQueryRows} placed ${built.placed}`);
            assert.equal(store.historyFor(dest).length, built.placed);
            const key = String(built.placed);
            const prior = seen.get(key);
            if (prior) {
              assert.equal(st.queryOutputs, prior.queryOutputs, `placed ${key} H=${H} fan=${fan}`);
              assert.equal(st.histQueryRows, prior.histQueryRows, `placed ${key} H=${H} fan=${fan}`);
            } else {
              seen.set(key, { queryOutputs: st.queryOutputs, histQueryRows: st.histQueryRows });
            }
            assert.ok(built.total >= built.placed);
            assert.ok(st.queryOutputs <= built.placed * 16);
          }
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opened spendable matches the full walk for any amount, then a later spend, then a rollback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-walk-par-v12-'));
    const who = newIdentity();
    const otherId = newIdentity();
    const dest = spendDestOf(who.spendPub);
    const other = spendDestOf(otherId.spendPub);
    const store = createStore(dir);
    try {
      for (const amount of [1, 1000, 7_000_003]) {
        const note = sealCoinbaseNote(amount, {
          dest20: hash20FromAddress(dest),
          kind: 'pot',
        });
        const otherNc = noteCommitOfDest20(hash20FromAddress(other));
        const fan = amount === 1 ? 1 : (amount === 1000 ? 8 : 32);
        const chain = [];
        for (let h = 1; h <= 30; h += 1) {
          const hash = Buffer.alloc(32);
          hash.writeUInt32BE(h, 28);
          hash[0] = amount & 0xff;
          const vout = [];
          for (let j = 0; j < fan; j += 1) {
            vout.push({ kind: 'pot', noteCommit: otherNc });
          }
          if (h === 2) {
            vout.push(note);
            vout.push({ ...note, kind: 'lock' });
            vout.push({ kind: 'pot', noteCommit: note.noteCommit, nanos: amount });
          }
          const txs = [{ coinbase: true, vout }];
          if (h === 20) txs.push({ vin: [{ noteCommit: note.noteCommit }], vout: [] });
          chain.push({
            height: h,
            hash,
            header: Buffer.alloc(128),
            txs,
          });
        }
        const use = (n) => {
          store.blocks.length = 0;
          for (const b of chain.slice(0, n)) store.blocks.push(b);
        };
        use(2);
        resetNoteCommitBlocksWalked();
        const immature = store.spendableNanos(dest);
        assert.equal(noteCommitBlocksWalked(), 0);
        assert.equal(immature, 0);
        assert.equal(noteCommitSpendableNanos(store.blocks, dest, 2), 0);
        use(30);
        resetNoteCommitBlocksWalked();
        const spent = store.spendableNanos(dest);
        assert.equal(noteCommitBlocksWalked(), 0);
        assert.equal(spent, noteCommitSpendableNanos(store.blocks, dest, 30));
        assert.equal(spent, 0);
        use(19);
        resetNoteCommitBlocksWalked();
        const back = store.spendableNanos(dest);
        assert.equal(noteCommitBlocksWalked(), 0);
        assert.equal(back, noteCommitSpendableNanos(store.blocks, dest, store.tip().height));
        assert.equal(back, amount);
        assert.equal(store.spendableNanos(other), 0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

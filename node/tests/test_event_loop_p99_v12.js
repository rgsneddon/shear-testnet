import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { newIdentity, spendDestOf, hash20FromAddress } from '../../crypto/address.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { sealCoinbaseNote, noteCommitOfDest20 } from '../../crypto/note.js';
import { noteCommitBlocksWalked, resetNoteCommitBlocksWalked } from '../../crypto/coinbase_notes.js';
import { createStore } from '../src/store.js';

function loadBook(store, H, notes, dest, other) {
  store.blocks.length = 0;
  store.explorer.length = 0;
  const amounts = [1, 1000, 7_000_003];
  const otherNc = noteCommitOfDest20(hash20FromAddress(other));
  for (let h = 1; h <= H; h += 1) {
    const hash = Buffer.alloc(32, 0);
    hash.writeUInt32BE(h, 28);
    hash.writeUInt16BE(notes, 24);
    const vout = [];
    if (h === 1) {
      for (let n = 0; n < notes; n += 1) {
        const amount = amounts[n % amounts.length];
        vout.push(sealCoinbaseNote(amount, { dest20: hash20FromAddress(dest), kind: 'pot' }));
      }
    } else {
      for (let n = 0; n < notes; n += 1) vout.push({ kind: 'pot', noteCommit: otherNc });
    }
    store.blocks.push({
      height: h,
      hash,
      header: Buffer.alloc(128),
      txs: [{ coinbase: true, vout }],
    });
  }
}

function p99(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.99) - 1));
  return sorted[at];
}

describe('event-loop spend queries stay flat', { concurrency: 1 }, () => {
  it('p99 of a warm spendable and history burst does not grow with height', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p99-v12-'));
    const who = newIdentity();
    const otherId = newIdentity();
    const dest = spendDestOf(who.spendPub);
    const other = spendDestOf(otherId.spendPub);
    const store = createStore(dir);
    try {
      const heights = [16, 64, 256, 1024];
      const counts = [1, 8];
      const seen = new Map();
      for (const notes of counts) {
        const row = [];
        for (const H of heights) {
          loadBook(store, H, notes, dest, other);
          store.spendableNanos(dest);
          store.historyFor(dest);
          store.resetWalletWalkStats();
          resetNoteCommitBlocksWalked();
          const samples = [];
          for (let i = 0; i < 20; i += 1) {
            const t0 = performance.now();
            store.spendableNanos(dest);
            store.historyFor(dest);
            samples.push(performance.now() - t0);
          }
          const lag = p99(samples);
          const st = store.walletWalkStats();
          assert.equal(noteCommitBlocksWalked(), 0, `H=${H} notes=${notes}`);
          assert.equal(st.syncBlocks, 0, `H=${H} notes=${notes}`);
          assert.equal(st.queryBlocks, 0, `H=${H} notes=${notes}`);
          assert.ok(st.spendChecks === 20, `checks ${st.spendChecks}`);
          row.push(lag);
        }
        const short = row[0];
        const tall = row[row.length - 1];
        const heightRatio = heights[heights.length - 1] / heights[0];
        assert.ok(tall <= short * 4 + 8, `notes=${notes} p99 ${row.join(',')}`);
        assert.ok(tall * 4 < heightRatio * Math.max(short, 1), `notes=${notes} p99 ${row.join(',')}`);
        const prior = seen.get(String(notes));
        assert.equal(prior, undefined);
        seen.set(String(notes), row);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

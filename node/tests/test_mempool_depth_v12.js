/**
 * N-60: admitMempool must not JSON.stringify the book on every accept.
 * Any count. Any blob length. The template admits through this function.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { encodeDest } from '../../crypto/address.js';
import { createStore } from '../src/store.js';

const dest = encodeDest(Buffer.alloc(20, 3));
const COUNTS = [1, 64, 256, 1024];
const BLOBS = [33, 4096];
const WALL_MS = 15_000;

function fatRow(i, blobLen) {
  return {
    id: `fat-${blobLen}-${i}`,
    kind: 'send',
    vin: [{}],
    fat: true,
    blob: 'x'.repeat(blobLen),
  };
}

function bSpend(k, blobLen, i) {
  return {
    id: `b-${blobLen}-${k}-${i}`,
    kind: 'b-spend',
    to: dest,
    fee: 2,
    bFlag: 1,
  };
}

describe('v12 admit does not stringify the mempool', () => {
  it('accepts a growing book without stringifying taxed rows, at any count', () => {
    assert.ok(COUNTS.length >= 4);
    assert.ok(BLOBS.length >= 2);
    assert.ok(COUNTS.includes(1024));
    assert.ok(BLOBS.includes(4096));
    const orig = JSON.stringify;
    for (const blobLen of BLOBS) {
      for (const k of COUNTS) {
        const book = emptyMempool();
        for (let i = 0; i < k; i += 1) book.txs.push(fatRow(i, blobLen));
        let hits = 0;
        JSON.stringify = function stringify(value, ...rest) {
          if (value && value.fat === true) hits += 1;
          return orig.call(JSON, value, ...rest);
        };
        const t0 = performance.now();
        try {
          for (let i = 0; i < k; i += 1) {
            const got = admitMempool(book, bSpend(k, blobLen, i), { baseFee: 1 });
            assert.equal(got.ok, true, `${blobLen} ${k} ${i} ${got.reason || ''}`);
          }
        } finally {
          JSON.stringify = orig;
        }
        const ms = performance.now() - t0;
        assert.equal(hits, 0, `${blobLen} ${k} stringified ${hits} in ${ms}`);
        assert.ok(ms < WALL_MS, `${blobLen} ${k} took ${ms}`);
        assert.equal(book.txs.length, k + k);
      }
    }
  });

  it('a template of 1024 admitted rows finishes under the same bound', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n60-'));
    const store = createStore(dir);
    try {
      const book = emptyMempool();
      for (let i = 0; i < 1024; i += 1) {
        const got = admitMempool(book, bSpend(1024, 33, i), { baseFee: 1 });
        assert.equal(got.ok, true, got.reason);
      }
      store.mempool = book.txs;
      const t0 = performance.now();
      const { tpl } = store.template({ miner: dest, shareBits: 4, now: 1_700_000_000_000 });
      const ms = performance.now() - t0;
      assert.ok(tpl && Array.isArray(tpl.txs));
      assert.ok(ms < WALL_MS, `template ${ms}`);
    } finally {
      try { store.close?.(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

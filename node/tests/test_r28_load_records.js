// R28 bug 9 and its async edge: a book whose chain.bin lacks the BluNotes
// records (an older or stripped trailer) loads with every record derived by
// the verify, on the sync load and on the boot-verify (yieldForeign) load,
// which reopens the store from disk. Before the fix the async reopen read
// chain.bin again and lost the derived records. Share PoW is real
// ShearHash-v3; the book is sealed for its own datadir, as a node's is.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { POOL_FEE_BPS } from '../../crypto/asert.js';
import { admitPubIndex } from '../../crypto/admit.js';
import { writeChainBin } from '../../crypto/chainbin.js';
import { decodeRecord, oneTimeKey, recordRoot } from '../../crypto/blunote.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import { chainLoadSeal } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { bluWallet, mineBluShare } from './support/blunote_mine.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const MINER = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const T0 = 1_700_000_000_000;

function asBlock(tpl) {
  return {
    header: tpl.header, txs: tpl.txs, samples: tpl.samples || [], shareBatch: tpl.shareBatch || [],
    miner: tpl.miner, aLeaves: tpl.aLeaves, bLeaves: tpl.bLeaves, rootA: tpl.rootA, rootB: tpl.rootB, weight: tpl.weight,
  };
}

let powTag = 1;
function pow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag++, 4);
  return h;
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Two blocks from a real store: genesis, then one with real shares and winners. */
async function realBook() {
  const dir = tmp('shear-r28-loadrec-src-');
  const pool = bluWallet();
  const feeKey = () => {
    const k = oneTimeKey(pool);
    return { R: k.R, P: k.P, viewTag: k.tag };
  };
  const store = createStore(dir);
  const g = store.template({ miner: MINER, now: T0, feeKey: feeKey(), feeBps: POOL_FEE_BPS });
  let got = await Promise.resolve(store.append(asBlock(g.tpl), { trustedPowHash: pow() }));
  assert.equal(got.ok, true, got.reason);
  const miner = bluWallet();
  const shares = [mineBluShare(miner, store.tip().header), mineBluShare(miner, store.tip().header)];
  const t2 = store.template({ miner: MINER, now: T0 + 90_000, shareBatch: shares, feeKey: feeKey(), feeBps: POOL_FEE_BPS });
  got = await Promise.resolve(store.append(asBlock(t2.tpl), { trustedPowHash: pow() }));
  assert.equal(got.ok, true, got.reason);
  const blocks = store.blocks.map((b) => ({ ...b }));
  if (typeof store.close === 'function') store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { blocks, feeKey };
}

/** The same book with no record trailers, sealed for a fresh datadir. */
function strippedBook(blocks) {
  const dir = tmp('shear-r28-loadrec-');
  const bare = blocks.map((b) => {
    const { blunoteRecord, ...rest } = b;
    void blunoteRecord;
    return rest;
  });
  writeChainBin(path.join(dir, 'chain.bin'), bare);
  fs.writeFileSync(path.join(dir, 'book.seal'), `${chainLoadSeal(bare, bookSealKeyFor(dir))}\n`);
  return dir;
}

async function checkLoaded(store, blocks, feeKey) {
  assert.equal(store.tip().height, blocks.length);
  for (const [i, b] of blocks.entries()) {
    assert.equal(store.blocks[i].blunoteRecord, b.blunoteRecord, `record at height ${i + 1}`);
  }
  const rec = decodeRecord(Buffer.from(store.tip().blunoteRecord, 'hex'));
  assert.ok(rec.winners.length >= 1);
  const known = admitPubIndex(store.fluxset());
  for (const w of rec.winners) assert.ok(known.has(w.P.toString('hex')), 'winner note in the admit set');
  // The next block binds the derived parent record and appends.
  const t3 = store.template({ miner: MINER, now: T0 + 180_000, feeKey: feeKey(), feeBps: POOL_FEE_BPS });
  assert.equal(Buffer.from(t3.tpl.txs[0].blunote.prev).toString('hex'), recordRoot(Buffer.from(store.tip().blunoteRecord, 'hex')).toString('hex'));
  const got = await Promise.resolve(store.append(asBlock(t3.tpl), { trustedPowHash: pow() }));
  assert.equal(got.ok, true, got.reason);
}

describe('R28: a load derives the records a chain.bin lacks', () => {
  it('on the sync load and on the boot-verify (yieldForeign) reopen', { timeout: 900_000 }, async () => {
    const { blocks, feeKey } = await realBook();
    assert.ok(blocks.every((b) => b.blunoteRecord), 'the source book has records');

    const syncDir = strippedBook(blocks);
    try {
      const store = createStore(syncDir);
      await checkLoaded(store, blocks, feeKey);
      if (typeof store.close === 'function') store.close();
    } finally {
      fs.rmSync(syncDir, { recursive: true, force: true });
    }

    const asyncDir = strippedBook(blocks);
    try {
      const opened = createStore(asyncDir, { yieldForeign: true });
      assert.equal(typeof opened?.then, 'function', 'the foreign book takes the boot-verify path');
      const store = await opened;
      await checkLoaded(store, blocks, feeKey);
      if (typeof store.close === 'function') store.close();
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    }
  });
});

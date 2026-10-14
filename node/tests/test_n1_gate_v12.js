/**
 * N-1 runs after the cheap gates. A missing header or an over-cap tx does
 * not derive a leaf. A header that passes still rejects a bad note.
 * A sealed restart does not rescan. A bad coinbase payee is dropped.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { fs1LeafDeriveCount, resetFs1LeafDerives } from '../../crypto/fs1_leaf.js';
import { MAX_TX_OUTPUTS } from '../../crypto/note.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import {
  GENESIS_PREV,
  chainLoadSeal,
  coinbaseTx,
  digestTx,
  dropBrokenCoinbaseNotes,
  verifyBlock,
} from '../src/chain.js';
import { createStore } from '../src/store.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

const T0 = 1_700_000_000_000;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function badOut() {
  return { kind: 'pot', admitPub: Buffer.alloc(32, 0xff), commit: Buffer.alloc(32, 4) };
}

function badCoinbaseBlock() {
  const tx = {
    coinbase: true,
    id: 'cb-bad',
    kind: 'coinbase',
    vout: [badOut()],
  };
  const header = encodeHeader({
    prevBlockHash: GENESIS_PREV,
    merkleRoot: merkleRoot([digestTx(tx)]),
    continuityRoot: Buffer.alloc(32),
    timestamp: T0,
    bits: GENESIS_BITS_PACKED,
    nonce: 0n,
    baseFee: 1n,
  });
  return { header, height: 1, hash: Buffer.alloc(32), txs: [tx] };
}

describe('N-1 gate order', () => {
  it('does not derive a leaf before the header or the output cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-gate-'));
    const store = createStore(dir);
    try {
      resetFs1LeafDerives();
      const missing = store.verifyFork([{ txs: [{ kind: 'pot', vout: [badOut()] }] }]);
      assert.equal(missing.reason, 'no_header');
      assert.equal(fs1LeafDeriveCount(), 0);

      resetFs1LeafDerives();
      const bare = verifyBlock({ txs: [{ coinbase: true, kind: 'coinbase', vout: [badOut()] }] }, null);
      assert.equal(bare.reason, 'no_header');
      assert.equal(fs1LeafDeriveCount(), 0);

      const over = {
        id: 'over-cap',
        kind: 'pay',
        vout: Array.from({ length: MAX_TX_OUTPUTS + 1 }, () => badOut()),
      };
      resetFs1LeafDerives();
      assert.equal(admitMempool(emptyMempool(), over).reason, 'tx_cap');
      assert.equal(fs1LeafDeriveCount(), 0);
      resetFs1LeafDerives();
      assert.equal(store.queueTx(over).reason, 'tx_cap');
      assert.equal(fs1LeafDeriveCount(), 0);

      const one = { id: 'one-bad', kind: 'pay', vout: [badOut()] };
      resetFs1LeafDerives();
      assert.equal(admitMempool(emptyMempool(), one).reason, 'admit_note_point');
      assert.ok(fs1LeafDeriveCount() > 0);

      const block = badCoinbaseBlock();
      resetFs1LeafDerives();
      assert.equal(verifyBlock(block, null, { probeBody: true }).reason, 'admit_note_point');
      const derived = fs1LeafDeriveCount();
      assert.ok(derived > 0);
      assert.equal(verifyBlock(block, null, { probeBody: true }).reason, 'admit_note_point');
      assert.equal(fs1LeafDeriveCount(), derived);
      resetFs1LeafDerives();
      const forkBlock = badCoinbaseBlock();
      assert.equal(store.verifyFork([forkBlock], { probeBody: true }).reason, 'admit_note_point');
      assert.ok(fs1LeafDeriveCount() > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the leaf rescan when book.seal matches, and still scans an unsealed book', () => {
    const tx = { id: 'bad-load', kind: 'pot', vout: [badOut()] };
    const header = Buffer.alloc(80, 1);
    const hash = Buffer.alloc(32, 2);
    const writeBook = (dir, seal) => {
      fs.mkdirSync(dir, { recursive: true });
      const block = { header, hash, height: 1, txs: [tx] };
      if (seal) {
        const key = bookSealKeyFor(dir);
        fs.writeFileSync(path.join(dir, 'book.seal'), chainLoadSeal([block], key));
      }
      fs.writeFileSync(path.join(dir, 'chain.jsonl'), `${JSON.stringify({
        header: header.toString('hex'),
        hash: hash.toString('hex'),
        height: 1,
        txs: [tx],
      })}\n`);
    };

    const open = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-open-'));
    writeBook(open, false);
    resetFs1LeafDerives();
    assert.throws(() => createStore(open), /admit_note_point/);
    assert.ok(fs1LeafDeriveCount() > 0);
    fs.rmSync(open, { recursive: true, force: true });

    const sealed = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-seal-'));
    writeBook(sealed, true);
    resetFs1LeafDerives();
    assert.throws(() => createStore(sealed), (err) => {
      assert.equal(err.message, 'bad_header');
      return true;
    });
    assert.equal(fs1LeafDeriveCount(), 0);
    fs.rmSync(sealed, { recursive: true, force: true });
  });

  it('drops a broken coinbase payee instead of throwing', () => {
    const dest = minerDest();
    const cb = coinbaseTx({
      height: 1,
      miner: dest,
      potShares: [{ address: dest, nanos: 1000, kind: 'pot' }],
      potNanos: 1000,
    });
    assert.equal(cb.vout.length, 1);
    cb.vout.push(badOut());
    const lines = [];
    const orig = console.error;
    console.error = (line) => lines.push(String(line));
    try {
      assert.doesNotThrow(() => dropBrokenCoinbaseNotes(cb));
    } finally {
      console.error = orig;
    }
    assert.equal(cb.vout.length, 1);
    assert.equal(cb.vout[0].kind, 'pot');
    assert.ok(lines.some((line) => line.includes('coinbase_note_drop') && line.includes('admit_note_point')));
  });
});

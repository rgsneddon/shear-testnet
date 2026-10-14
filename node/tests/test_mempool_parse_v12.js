/**
 * N-30: a template and an arrival parse each proof once.
 * Any mempool size, any blob length, any output amount.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { levyNanos } from '../../crypto/levy.js';
import {
  resetTxSpendTagParses,
  sealNote,
  txSpendTagParses,
  txSpendTags,
} from '../../crypto/note.js';
import { freshStealthDest, hash20FromAddress, newIdentity, ed25519SeedOf } from '../../crypto/address.js';

const COUNTS = [1, 4, 16];
const AMOUNTS = [1, 2 ** 20, 2 ** 40];
const BLOB_LENS = [33, 100, 4096];
const PARSE_PER_TX = 4;

function destOf() {
  const id = newIdentity();
  const pay = freshStealthDest(id);
  return pay.dest;
}

function tagHexOf(tx) {
  const parsed = txSpendTags(tx);
  assert.equal(parsed.tags.length, 1);
  return parsed.tags[0].toString('hex');
}

describe('v12 mempool tag parse stays linear', () => {
  it('parses once per tx for any count, any blob length, and any amount', () => {
    assert.ok(COUNTS.length >= 3);
    assert.ok(AMOUNTS.length >= 3);
    assert.ok(BLOB_LENS.length >= 3);
    assert.ok(new Set(AMOUNTS).size === AMOUNTS.length);
    assert.ok(AMOUNTS.every((n) => Number.isSafeInteger(n) && n > 0));
    const dest = destOf();
    const d20 = hash20FromAddress(dest);
    const pays = AMOUNTS.map((amount) => {
      const note = sealNote(amount, { dest20: Buffer.from(d20), kind: 'send' });
      note.address = dest;
      return note;
    });
    const dummyTx = attachDummyOuts({
      kind: 'send',
      to: dest,
      from: dest,
      nanos: 0,
      vin: [{ address: dest }],
      vout: [],
    });
    const dummy = dummyTx.vout.find((o) => String(o.kind) === 'dummy');
    assert.ok(dummy && dummy.rangeProof);

    const cTilde = Buffer.alloc(32, 9);
    let seq = 0;
    const makeTx = (i, k) => {
      seq += 1;
      const amount = AMOUNTS[i % AMOUNTS.length];
      const len = BLOB_LENS[i % BLOB_LENS.length];
      const blob = Buffer.alloc(len);
      blob[0] = i % 2 === 0 ? 2 : 3;
      blob[1] = seq & 0xff;
      blob[2] = (seq >> 8) & 0xff;
      blob[3] = k & 0xff;
      blob[4] = len & 0xff;
      const tx = {
        id: `n30-${k}-${i}-${seq}`,
        kind: 'send',
        from: dest,
        to: dest,
        nanos: amount,
        vin: [{ address: dest, commit: cTilde }],
        vout: [pays[i % pays.length], dummy],
        admit_proofs: [{ blob, cTilde }],
      };
      tx.fee = levyNanos(0, { tx });
      return tx;
    };

    const opts = { baseFee: 1, fluxset: { pubs: [], commits: [], spendTags: new Set() } };
    let largest = null;
    const bookParses = [];
    for (const k of COUNTS) {
      const book = emptyMempool();
      resetTxSpendTagParses();
      for (let i = 0; i < k; i += 1) {
        const got = admitMempool(book, makeTx(i, k), opts);
        assert.equal(got.ok, true, `k=${k} i=${i} ${got.reason || ''}`);
      }
      const parses = txSpendTagParses();
      bookParses.push({ k, parses });
      assert.ok(parses <= PARSE_PER_TX * k, `book k=${k} parses=${parses}`);
      assert.ok(parses >= k, `book k=${k} parses=${parses}`);
      largest = book;
    }
    assert.equal(largest.tagIndex.size, largest.txs.length);
    for (const tx of largest.txs) {
      const before = txSpendTagParses();
      assert.equal(largest.tagIndex.get(tagHexOf(tx)), String(tx.id));
      assert.equal(txSpendTagParses(), before, 'index read does not parse');
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n30-'));
    try {
      const store = createStore(dir);
      store.mempool.push(...largest.txs);
      assert.equal(store.mempool.length, COUNTS[COUNTS.length - 1]);
      resetTxSpendTagParses();
      const { tpl } = store.template({ miner: dest, shareBits: 4, now: 1_700_000_000_000 });
      const templateParses = txSpendTagParses();
      const k = largest.txs.length;
      assert.ok(templateParses <= PARSE_PER_TX * k, `template k=${k} parses=${templateParses}`);
      assert.ok(templateParses >= k, `template k=${k} parses=${templateParses}`);
      const ids = new Set((tpl.txs || []).map((tx) => tx && tx.id).filter(Boolean));
      for (const tx of largest.txs) assert.ok(ids.has(tx.id), tx.id);
      assert.equal(store.mempool.length, k);

      resetTxSpendTagParses();
      const arrival = store.queueTx(makeTx(0, k + 1));
      const arrivalParses = txSpendTagParses();
      assert.ok(arrivalParses <= PARSE_PER_TX, `arrival parses=${arrivalParses} k=${k}`);
      assert.ok(arrivalParses >= 1, `arrival parses=${arrivalParses}`);
      assert.equal(arrival.ok, false);
      console.error(JSON.stringify({
        event: 'n30_parses',
        book: bookParses,
        template: templateParses,
        arrival: arrivalParses,
        cap: PARSE_PER_TX,
      }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const left = txSpendTags(makeTx(0, 1));
    const right = txSpendTags(makeTx(1, 1));
    assert.equal(left.tags.length, 1);
    assert.ok(!left.tags[0].equals(right.tags[0]));
    const memo = makeTx(2, 1);
    resetTxSpendTagParses();
    const first = txSpendTags(memo);
    const second = txSpendTags(memo);
    assert.equal(txSpendTagParses(), 1, 'one object parses once');
    assert.ok(first.tags[0].equals(second.tags[0]));
    memo.admit_proofs = [{ blob: Buffer.alloc(BLOB_LENS[2], 7), cTilde }];
    memo.admit_proofs[0].blob[0] = 3;
    const third = txSpendTags(memo);
    assert.equal(txSpendTagParses(), 2, 'a replaced proof parses again');
    assert.ok(!first.tags[0].equals(third.tags[0]));
  });
});

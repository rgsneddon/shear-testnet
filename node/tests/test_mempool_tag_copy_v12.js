/**
 * N-752-2: a template must not copy the chain spend-tag set.
 * Set inserts that read the chain set stay independent of how many tags
 * the chain holds, for any mempool size, any blob length, and any amount.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { levyNanos } from '../../crypto/levy.js';
import { sealNote } from '../../crypto/note.js';
import { freshStealthDest, hash20FromAddress, newIdentity } from '../../crypto/address.js';

const CHAIN_SIZES = [1, 64, 4096];
const COUNTS = [1, 4, 16];
const AMOUNTS = [1, 2 ** 20, 2 ** 40];
const BLOB_LENS = [33, 100, 4096];

function destOf() {
  const id = newIdentity();
  return freshStealthDest(id).dest;
}

function makeTxs(dest, k) {
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
  const txs = [];
  for (let i = 0; i < k; i += 1) {
    const amount = AMOUNTS[i % AMOUNTS.length];
    const len = BLOB_LENS[i % BLOB_LENS.length];
    const blob = Buffer.alloc(len);
    blob[0] = i % 2 === 0 ? 2 : 3;
    blob[1] = (i + 1) & 0xff;
    blob[2] = k & 0xff;
    blob[3] = len & 0xff;
    blob[4] = (i * 17) & 0xff;
    const tx = {
      id: `n752-${k}-${i}-${amount}`,
      kind: 'send',
      from: dest,
      to: dest,
      nanos: amount,
      vin: [{ address: dest, commit: cTilde }],
      vout: [pays[i % pays.length], dummy],
      admit_proofs: [{ blob, cTilde }],
    };
    tx.fee = levyNanos(0, { tx });
    txs.push(tx);
  }
  return txs;
}

function installRecordingSet(captured) {
  const NativeSet = globalThis.Set;
  function RecordingSet(iterable) {
    const created = new NativeSet(iterable);
    captured.push(created);
    return created;
  }
  Object.setPrototypeOf(RecordingSet, NativeSet);
  RecordingSet.prototype = NativeSet.prototype;
  globalThis.Set = RecordingSet;
  return NativeSet;
}

function findLiveSpendSet(store, captured) {
  const sentinel = `n752-live-${process.pid}`;
  for (let i = captured.length - 1; i >= 0; i -= 1) {
    const set = captured[i];
    set.add(sentinel);
    let hit = false;
    try {
      hit = store.fluxset().spendTags.has(sentinel);
    } catch {
      hit = false;
    }
    set.delete(sentinel);
    if (hit) return set;
  }
  return null;
}

function fillChainTags(live, count) {
  live.clear();
  for (let i = 0; i < count; i += 1) {
    const hex = `${i.toString(16).padStart(60, '0')}${count.toString(16).padStart(4, '0')}`;
    live.add(hex);
  }
  assert.equal(live.size, count);
}

describe('v12 mempool admit does not copy the chain tag set', () => {
  it('chain-set reads per template stay independent of chain tag count for any mempool size', () => {
    assert.ok(CHAIN_SIZES.length >= 3);
    assert.ok(COUNTS.length >= 3);
    assert.ok(AMOUNTS.length >= 3);
    assert.ok(BLOB_LENS.length >= 3);
    assert.ok(new Set(CHAIN_SIZES).size === CHAIN_SIZES.length);
    assert.ok(new Set(COUNTS).size === COUNTS.length);
    assert.ok(CHAIN_SIZES.every((n) => n > 0));
    assert.ok(AMOUNTS.every((n) => Number.isSafeInteger(n) && n > 0));

    const captured = [];
    const NativeSet = installRecordingSet(captured);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n752-'));
    let store;
    try {
      store = createStore(dir);
    } finally {
      globalThis.Set = NativeSet;
    }
    try {
      const live = findLiveSpendSet(store, captured);
      assert.ok(live, `live spend set was not among ${captured.length} sets`);
      assert.equal(store.fluxset().spendTags.size, live.size);

      const origIter = NativeSet.prototype[Symbol.iterator];
      const origForEach = NativeSet.prototype.forEach;
      const origAdd = NativeSet.prototype.add;
      let chainReads = 0;
      let chainAdds = 0;
      let watching = false;
      NativeSet.prototype[Symbol.iterator] = function iterator() {
        const it = origIter.call(this);
        if (!watching || this !== live) return it;
        return {
          next() {
            const step = it.next();
            if (!step.done) chainReads += 1;
            return step;
          },
          [Symbol.iterator]() { return this; },
        };
      };
      NativeSet.prototype.forEach = function forEach(fn, thisArg) {
        if (!watching || this !== live) return origForEach.call(this, fn, thisArg);
        return origForEach.call(this, (value, key, set) => {
          chainReads += 1;
          return fn.call(thisArg, value, key, set);
        });
      };
      NativeSet.prototype.add = function add(value) {
        if (watching && this === live) chainAdds += 1;
        return origAdd.call(this, value);
      };

      const dest = destOf();
      const rows = [];
      try {
        for (const chainSize of CHAIN_SIZES) {
          fillChainTags(live, chainSize);
          for (const k of COUNTS) {
            store.mempool.length = 0;
            store.mempool.push(...makeTxs(dest, k));
            chainReads = 0;
            chainAdds = 0;
            watching = true;
            let built;
            try {
              built = store.template({ miner: dest, shareBits: 4, now: 1_700_000_000_000 });
            } finally {
              watching = false;
            }
            const ids = new Set((built.tpl.txs || []).map((tx) => tx && tx.id).filter((id) => String(id || '').startsWith('n752-')));
            assert.equal(ids.size, k, `admitted T=${chainSize} k=${k}`);
            assert.equal(live.size, chainSize, `chain set grew T=${chainSize} k=${k}`);
            assert.equal(chainAdds, 0, `chain adds T=${chainSize} k=${k} adds=${chainAdds}`);
            rows.push({ T: chainSize, k, reads: chainReads, adds: chainAdds, admitted: ids.size });
          }
        }
        console.error(JSON.stringify({ event: 'n752_reads', rows }));
        for (const row of rows) {
          assert.equal(row.reads, 0, `chain reads T=${row.T} k=${row.k} reads=${row.reads}`);
        }
        const byCount = new Map();
        for (const row of rows) {
          if (!byCount.has(row.k)) byCount.set(row.k, new Set());
          byCount.get(row.k).add(row.reads);
        }
        for (const [k, reads] of byCount) {
          assert.equal(reads.size, 1, `k=${k} reads depend on chain size ${[...reads].join(',')}`);
        }

        fillChainTags(live, CHAIN_SIZES[CHAIN_SIZES.length - 1]);
        store.mempool.length = 0;
        chainReads = 0;
        chainAdds = 0;
        watching = true;
        try {
          const arrival = store.queueTx(makeTxs(dest, 1)[0]);
          assert.equal(arrival.ok, false);
        } finally {
          watching = false;
        }
        rows.push({
          T: live.size,
          k: 0,
          reads: chainReads,
          adds: chainAdds,
          admitted: 0,
          path: 'queue',
        });
        assert.equal(chainReads, 0, `queue reads=${chainReads}`);
        assert.equal(chainAdds, 0, `queue adds=${chainAdds}`);
        console.error(JSON.stringify({ event: 'n752_reads', rows }));
      } finally {
        NativeSet.prototype[Symbol.iterator] = origIter;
        NativeSet.prototype.forEach = origForEach;
        NativeSet.prototype.add = origAdd;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

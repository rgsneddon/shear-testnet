/**
 * Block verify must not copy the parent spend-tag set.
 * Reads of that set stay independent of how many tags the parent holds,
 * for any probe of a real template.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

const CHAIN_SIZES = [1, 64, 4096];
const PROBES = [1, 2];

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
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
  const sentinel = `block-live-${process.pid}`;
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

function blockFrom(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    shareBatch: tpl.shareBatch || [],
  };
}

describe('v12 block verify does not copy the parent tag set', () => {
  it('parent-set reads stay independent of chain tag count for any probe', async () => {
    assert.ok(CHAIN_SIZES.length >= 3);
    assert.ok(PROBES.length >= 2);
    assert.ok(new Set(CHAIN_SIZES).size === CHAIN_SIZES.length);
    assert.ok(CHAIN_SIZES.every((n) => n > 0));

    const captured = [];
    const NativeSet = installRecordingSet(captured);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-btag-'));
    let store;
    try {
      store = createStore(dir);
    } finally {
      globalThis.Set = NativeSet;
    }
    try {
      const live = findLiveSpendSet(store, captured);
      assert.ok(live, `live spend set was not among ${captured.length} sets`);
      const dest = minerDest();
      const built = store.template({ miner: dest, shareBits: 4, now: 1_700_000_000_000 });
      const block = blockFrom(built.tpl);
      assert.ok(block.header);
      assert.ok(Array.isArray(block.txs) && block.txs.length >= 1);

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

      const rows = [];
      try {
        for (const chainSize of CHAIN_SIZES) {
          fillChainTags(live, chainSize);
          for (const probe of PROBES) {
            chainReads = 0;
            chainAdds = 0;
            watching = true;
            let got;
            try {
              got = await Promise.resolve(store.probeBlock(block));
            } finally {
              watching = false;
            }
            rows.push({
              T: chainSize,
              probe,
              reads: chainReads,
              adds: chainAdds,
              ok: got?.ok === true,
              reason: got?.reason || '',
            });
            assert.equal(live.size, chainSize, `chain set grew T=${chainSize} probe=${probe}`);
            assert.equal(chainAdds, 0, `chain adds T=${chainSize} probe=${probe} adds=${chainAdds}`);
            assert.notEqual(got?.reason, 'pow', `probe stopped at pow T=${chainSize}`);
            assert.notEqual(got?.reason, 'continuity', `probe stopped at continuity T=${chainSize}`);
            assert.notEqual(got?.reason, 'pot_sched', `probe stopped at pot T=${chainSize}`);
          }
        }
        console.error(JSON.stringify({ event: 'block_tag_reads', rows }));
        for (const row of rows) {
          assert.equal(row.reads, 0, `parent reads T=${row.T} probe=${row.probe} reads=${row.reads} reason=${row.reason}`);
        }
        const bySize = new Map();
        for (const row of rows) {
          if (!bySize.has(row.T)) bySize.set(row.T, new Set());
          bySize.get(row.T).add(row.reads);
        }
        for (const [size, reads] of bySize) {
          assert.equal(reads.size, 1, `T=${size} reads changed across probes ${[...reads].join(',')}`);
        }
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

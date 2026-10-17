/**
 * A snap and a suffix reload restore the flux spent set from plan.spendTags.
 * The prefix tags are not rebuilt by scanning those blocks again.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeBookSnap } from '../src/book_snap.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import { createStore } from '../src/store.js';
import { appendTpl, openStore, payerIdentity, templateOn } from './b_leaf_fund.js';
import { publishBLeaves } from './b_leaf_fs1.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tag-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

function tagsOf(store) {
  return [...store.fluxset().spendTags].map(String).sort();
}

describe('snap and suffix restore flux spend tags', () => {
  it('keeps plan.spendTags across a snap reload and a suffix reload', { timeout: 600_000 }, async () => {
    const who = payerIdentity();
    const book = openStore('shear-spend-tags-');
    try {
      await publishBLeaves(book.store, who, [{
        id: 'leaf-tag',
        unit: 9,
        nonce: 1,
        tag: 'b-extra',
      }]);
      const tags = tagsOf(book.store);
      assert.ok(tags.length > 0);
      const snapPath = path.join(book.dir, 'book.snap');
      const snapBytes = fs.readFileSync(snapPath);
      const vault = fs.readFileSync(path.join(book.dir, 'reserve.json'));
      const vaultSnap = fs.readFileSync(path.join(book.dir, 'vault.snap'));
      const key = bookSealKeyFor(book.dir);
      const plan = decodeBookSnap(snapBytes, key);
      assert.ok(plan);
      assert.deepEqual([...plan.spendTags].map(String).sort(), tags);

      const snap = createStore(book.dir);
      assert.equal(snap.loadMode, 'snap');
      assert.deepEqual(tagsOf(snap), tags);

      const tpl = templateOn(snap, { miner: who.dest });
      const got = await appendTpl(snap, tpl);
      assert.equal(got.ok, true, got.reason || 'pad');
      fs.writeFileSync(snapPath, snapBytes);
      fs.writeFileSync(path.join(book.dir, 'reserve.json'), vault);
      fs.writeFileSync(path.join(book.dir, 'vault.snap'), vaultSnap);
      const suffix = createStore(book.dir);
      assert.equal(suffix.loadMode, 'suffix', suffix.loadMode);
      assert.deepEqual(tagsOf(suffix), tags);
    } finally {
      book.close();
    }
  });
});

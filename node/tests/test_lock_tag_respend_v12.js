/**
 * A byte-3 lock is not a spend. The tag inside an FS-1 record is still the
 * spend tag when the JSON field is omitted. Acceptance of an FS-1 lock, and
 * reuse of that tag, is test_vault_fs1_funding_v12.js.
 */
import { describe, it } from 'node:test';
import { fileCapMs } from './slow_caps.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { verifyTypedAdmitFunding } from '../../crypto/admit_v3.js';
import { txSpendTags } from '../../crypto/note.js';

describe('v12 omitted lock spend tag', { timeout: fileCapMs(import.meta.url) }, () => {
  it('a byte-3 lock is unavailable, and an FS-1 record keeps its tag without the JSON field', () => {
    const tag = Buffer.alloc(32, 0x3c);
    const commit = Buffer.alloc(32, 4);
    const bucket = Buffer.alloc(129, 0);
    bucket[0] = 3;
    tag.copy(bucket, 1);
    let reads = 0;
    const locked = {
      kind: 'lock',
      anchor: 8,
      vin: [{ commit, anchor: 8 }],
      admit_proofs: [{ blob: bucket, cTilde: commit }],
    };
    const funded = verifyTypedAdmitFunding(locked, {
      height: 24,
      noteAtAnchor: () => { reads += 1; return null; },
    });
    assert.equal(funded.reason, 'vault_unavailable');
    assert.equal(reads, 0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-tag-'));
    try {
      const store = createStore(dir);
      const queued = store.queueTx({
        id: 'byte3-lock',
        kind: 'lock',
        vin: [{ commit }],
        admit_proofs: [{ blob: bucket, cTilde: commit }],
      });
      assert.equal(queued.ok, false, queued.reason);
      assert.equal(queued.reason, 'vault_unavailable');
      assert.equal(store.mempool.some((tx) => tx.id === 'byte3-lock'), false);
      assert.equal(store.fluxset().spendTags.has(tag.toString('hex')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const record = Buffer.alloc(321, 9);
    record[0] = 0xf1;
    tag.copy(record, 1);
    const parsed = txSpendTags({
      kind: 'lock',
      admit_proofs: [{ blob: record, cTilde: commit }],
    });
    assert.equal(parsed.ok, true, parsed.reason);
    assert.equal(parsed.tags.length, 1);
    assert.ok(parsed.tags[0].equals(tag));
  });
});

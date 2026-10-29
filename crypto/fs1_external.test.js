// External signer (Ledger) split: docs/LEDGER-VORTICE.md §5, ruling D1 (29 Oct).
// The host proves membership without x; the signer gives the tag and the SA+L;
// the unchanged verifier accepts the result. Parity: the same tags as the
// software prover, and the shared vector that the Dart test also checks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitScalarFromSeed, attachAdmitPub } from './admit.js';
import { scalarBytes, sealCoinbaseNote } from './note.js';
import {
  FS1_SAL_REQUEST_BYTES,
  fs1ExternalAssemble,
  fs1ExternalSign,
  fs1ExternalTag,
  fs1NativeLoaded,
  fs1Prove,
  fs1ProveExternal,
  fs1TreeAppend,
  fs1TreeNew,
  fs1TreeRoot,
  fs1Verify,
} from './native_admit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(fs.readFileSync(path.join(here, 'vectors', 'fs1_external_v1.json'), 'utf8'));

describe('FS-1 external signer split', { skip: !fs1NativeLoaded() && 'addon not built' }, () => {
  it('shared tag vector (Dart checks the same file)', () => {
    for (const c of vector.tags) {
      assert.equal(fs1ExternalTag(Buffer.from(c.x, 'hex')).toString('hex'), c.tag);
    }
  });

  it('proves without x, signs on the signer, and verifies unchanged', () => {
    const seed = Buffer.alloc(32, 7);
    const buf = Buffer.alloc(16 * 64);
    const mine = [];
    for (let i = 0; i < 16; i += 1) {
      const note = attachAdmitPub(sealCoinbaseNote(2000 + i, { dest20: Buffer.alloc(20, i + 1), kind: 'pot' }), { spendSeed: seed });
      Buffer.from(note.admitPub).copy(buf, i * 64);
      Buffer.from(note.commit).copy(buf, i * 64 + 32);
      if (i === 2 || i === 11) mine.push({ index: i, x: Buffer.from(scalarBytes(admitScalarFromSeed(seed, note))) });
    }
    const h = fs1TreeNew();
    assert.ok(fs1TreeAppend(h, buf));
    const root = fs1TreeRoot(h);
    const digest = Buffer.alloc(32, 0x5a);
    const tags = mine.map((m) => fs1ExternalTag(m.x));
    const ext = fs1ProveExternal(h, { indices: mine.map((m) => m.index), tags, digest, anchor: 8 });
    assert.ok(ext);
    assert.equal(ext.requests.length, 2 * FS1_SAL_REQUEST_BYTES);
    const reqs = [0, 1].map((k) => ext.requests.subarray(k * FS1_SAL_REQUEST_BYTES, (k + 1) * FS1_SAL_REQUEST_BYTES));
    for (const r of reqs) for (const m of mine) assert.equal(r.indexOf(m.x), -1, 'x is not in a request');
    const sals = reqs.map((r, k) => fs1ExternalSign(r, mine[k].x));
    for (const [k, s] of sals.entries()) assert.equal(s.indexOf(mine[k].x), -1, 'x is not in the SA+L');
    assert.equal(fs1ExternalSign(reqs[0], mine[1].x), null, 'a signer refuses a tag that is not its own');
    const out = fs1ExternalAssemble(ext.ctx, sals);
    assert.ok(out);
    assert.equal(fs1Verify({ fs1: out.fs1, records: out.records, root, digest, anchor: 8 }), true);
    const d2 = Buffer.from(digest);
    d2[0] ^= 1;
    assert.equal(fs1Verify({ fs1: out.fs1, records: out.records, root, digest: d2, anchor: 8 }), false);
    // The software prover posts the same tags for the same keys.
    const soft = fs1Prove(h, { indices: mine.map((m) => m.index), xs: mine.map((m) => m.x), digest, anchor: 8 });
    for (let k = 0; k < 2; k += 1) {
      assert.deepEqual(out.records.subarray(k * 321 + 1, k * 321 + 33), soft.records.subarray(k * 321 + 1, k * 321 + 33));
    }
  });

  it('a forged SA+L does not assemble', () => {
    const seed = Buffer.alloc(32, 9);
    const buf = Buffer.alloc(4 * 64);
    let x = null;
    for (let i = 0; i < 4; i += 1) {
      const note = attachAdmitPub(sealCoinbaseNote(10 + i, { dest20: Buffer.alloc(20, i + 1), kind: 'pot' }), { spendSeed: seed });
      Buffer.from(note.admitPub).copy(buf, i * 64);
      Buffer.from(note.commit).copy(buf, i * 64 + 32);
      if (i === 1) x = Buffer.from(scalarBytes(admitScalarFromSeed(seed, note)));
    }
    const h = fs1TreeNew();
    assert.ok(fs1TreeAppend(h, buf));
    const ext = fs1ProveExternal(h, { indices: [1], tags: [fs1ExternalTag(x)], digest: Buffer.alloc(32, 1), anchor: 4 });
    assert.ok(ext);
    assert.equal(fs1ExternalAssemble(ext.ctx, [Buffer.alloc(160, 1)]), null);
  });
});

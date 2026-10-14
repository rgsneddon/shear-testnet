import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAGIC_TESTNET } from './asert.js';
import { admitPub, admitScalarFromSeed, attachAdmitPub } from './admit.js';
import { pointBytes, sealCoinbaseNote } from './note.js';
import { proofIsV3Bucket } from './fs1_send_gate.js';
import { fs1NativeLoaded, fs1Verify } from './native_admit.js';
import {
  FS1_RECORD_BYTES,
  fs1BlobLen,
  fs1ProveSpend,
  fs1RootAt,
  resetFs1Tree,
  txBodyDigestFs1,
} from './fs1_spend.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(fs.readFileSync(path.join(here, 'vectors', 'fs1_digest_v1.json'), 'utf8'));

function vectorTx(c) {
  return {
    kind: c.kind,
    anchor: c.anchor,
    fee: c.fee,
    vin: Array.from({ length: c.nIn }, () => ({ commit: Buffer.alloc(32, 7) })),
    vout: c.vout,
  };
}

describe('FS-1 body digest', () => {
  it('matches the shared vector (wallet/test/fs1_digest_v1_test.dart)', () => {
    assert.equal(vector.magic, MAGIC_TESTNET);
    assert.ok(vector.cases.length >= 3);
    for (const c of vector.cases) {
      assert.equal(txBodyDigestFs1(vectorTx(c), vector.magic).toString('hex'), c.digest);
    }
  });

  it('binds the fee, anchor, input count, magic, and every output field', () => {
    const c = vector.cases[0];
    const base = txBodyDigestFs1(vectorTx(c)).toString('hex');
    const differs = (tx, magic) => assert.notEqual(txBodyDigestFs1(tx, magic).toString('hex'), base);
    differs({ ...vectorTx(c), fee: c.fee + 1 });
    differs({ ...vectorTx(c), anchor: c.anchor + 8 });
    differs({ ...vectorTx({ ...c, nIn: c.nIn + 1 }) });
    differs(vectorTx(c), 'shear-v1');
    for (const k of ['commit', 'admitPub', 'noteCommit', 'rEph', 'rCt', 'amtCt', 'rangeProof', 'dest20']) {
      const vout = c.vout.map((o) => ({ ...o }));
      const b = Buffer.from(vout[0][k], 'hex');
      b[0] ^= 1;
      vout[0][k] = b.toString('hex');
      differs({ ...vectorTx(c), vout });
    }
    differs({ ...vectorTx(c), vout: [...c.vout].reverse() });
  });

  it('does not bind fields a relay may drop (maxLevy, sig, excess, vin commits)', () => {
    const c = vector.cases[0];
    const base = txBodyDigestFs1(vectorTx(c)).toString('hex');
    const same = { ...vectorTx(c), maxLevy: 9, sig: 'aa', excess: 'bb', vin: [{ commit: Buffer.alloc(32, 1) }] };
    assert.equal(txBodyDigestFs1(same).toString('hex'), base);
  });
});

describe('FS-1 records are not bucket proofs', () => {
  it('a 0xF1 record with v 3 is not the Stage 0 bucket shape', () => {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 1);
    blob[0] = 0xf1;
    assert.equal(proofIsV3Bucket({ v: 3, blob }), false);
    const bucket = Buffer.alloc(64, 1);
    bucket[0] = 3;
    assert.equal(proofIsV3Bucket({ v: 3, blob: bucket }), true);
    assert.equal(proofIsV3Bucket({ v: 3 }), true);
  });
});

describe('FS-1 prove and verify through the addon', { skip: !fs1NativeLoaded() && 'addon not built' }, () => {
  it('proves two inputs, and a changed digest, anchor, root, or record fails', () => {
    resetFs1Tree();
    const seed = Buffer.alloc(32, 5);
    const pubs = [];
    const commits = [];
    const mine = [];
    for (let i = 0; i < 12; i += 1) {
      const note = attachAdmitPub(sealCoinbaseNote(1000 + i, { dest20: Buffer.alloc(20, i + 1), kind: 'pot' }), { spendSeed: seed });
      pubs.push(Buffer.from(note.admitPub));
      commits.push(Buffer.from(note.commit));
      if (i === 3 || i === 9) mine.push({ index: i, x: admitScalarFromSeed(seed, note) });
    }
    for (const m of mine) assert.ok(Buffer.from(pointBytes(admitPub(m.x))).equals(pubs[m.index]));
    const live = { n: 12, jroot: Buffer.alloc(32, 0xab), pubs, commits };
    const tx = vectorTx(vector.cases[0]);
    const proven = fs1ProveSpend({ live, anchor: 8, indices: mine.map((m) => m.index), xs: mine.map((m) => m.x), tx });
    assert.ok(proven);
    assert.equal(proven.fs1.length, fs1BlobLen(2));
    const root = fs1RootAt(live);
    const records = Buffer.concat(proven.proofs.map((p) => p.blob));
    const digest = txBodyDigestFs1({ ...tx, anchor: 8 });
    assert.equal(fs1Verify({ fs1: proven.fs1, records, root, digest, anchor: 8 }), true);
    assert.equal(fs1Verify({ fs1: proven.fs1, records, root, digest, anchor: 16 }), false);
    const d2 = Buffer.from(digest);
    d2[0] ^= 1;
    assert.equal(fs1Verify({ fs1: proven.fs1, records, root, digest: d2, anchor: 8 }), false);
    const r2 = Buffer.from(root);
    r2[5] ^= 1;
    assert.equal(fs1Verify({ fs1: proven.fs1, records, root: r2, digest, anchor: 8 }), false);
    const swapped = Buffer.concat([proven.proofs[1].blob, proven.proofs[0].blob]);
    assert.equal(fs1Verify({ fs1: proven.fs1, records: swapped, root, digest, anchor: 8 }), false);
    const bent = Buffer.from(records);
    bent[200] ^= 1;
    assert.equal(fs1Verify({ fs1: proven.fs1, records: bent, root, digest, anchor: 8 }), false);
    assert.equal(fs1ProveSpend({ live, anchor: 8, indices: [3], xs: [mine[1].x], tx }), null, 'a key that does not own the leaf');
  });
});

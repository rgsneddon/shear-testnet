import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAGIC_TESTNET, PI_SHE_NANOS } from './asert.js';
import { admitPub, admitScalarFromSeed, attachAdmitPub } from './admit.js';
import { commit, pointBytes, proveRange, randomScalar, sealCoinbaseNote } from './note.js';
import { lockQualifies, reserveDigestSuffix } from './reserve_vault.js';
import { spendPackDigest } from './spend.js';
import { compactTx } from './chronoflux.js';
import { proofIsV3Bucket } from './fs1_send_gate.js';
import { fs1NativeLoaded, fs1Verify } from './native_admit.js';
import { verifyFlowAdmitFs1 } from './admit_v3.js';
import {
  FS1_DEPTH,
  FS1_INPUT_MAX,
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobFits,
  fs1BlobLen,
  fs1ProveSpend,
  fs1RootAt,
  resetFs1Tree,
  txBodyDigestFs1,
  fs1MemoDigest,
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
    ...(c.memoCt ? { memoCt: c.memoCt } : {}),
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

  it('signs the top-level memo envelope: stripped, swapped or added, the digest moves (FS1_MEMO=bound)', () => {
    const memoCase = vector.cases.find((c) => c.memoCt);
    assert.ok(memoCase, 'the shared vector has a memo case');
    assert.equal(fs1MemoDigest(memoCase.memoCt).toString('hex'), memoCase.memoDigest);
    const { ct, mac, nonce, v } = memoCase.memoCt;
    assert.equal(fs1MemoDigest({ v, nonce, mac, ct }).toString('hex'), memoCase.memoDigest, 'key order does not matter');
    const signed = txBodyDigestFs1(vectorTx(memoCase)).toString('hex');
    assert.equal(signed, memoCase.digest);
    const { memoCt: _m, ...stripped } = vectorTx(memoCase);
    assert.notEqual(txBodyDigestFs1(stripped).toString('hex'), signed, 'stripped');
    assert.equal(txBodyDigestFs1(stripped).toString('hex'), vector.cases[0].digest, 'a tx with no memo keeps its digest');
    const swapped = { ...vectorTx(memoCase), memoCt: { ...memoCase.memoCt, ct: 'R'.repeat(ct.length) } };
    assert.notEqual(txBodyDigestFs1(swapped).toString('hex'), signed, 'swapped');
    const added = { ...vectorTx(vector.cases[0]), memoCt: memoCase.memoCt };
    assert.notEqual(txBodyDigestFs1(added).toString('hex'), vector.cases[0].digest, 'added');
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

describe('FS-1 size bound', { skip: !fs1NativeLoaded() && 'addon not built' }, () => {
  it('an 8-input blob fits and one extra byte is rejected', () => {
    const n = FS1_INPUT_MAX;
    const max = fs1BlobLen(n);
    assert.ok(max > 35);
    for (let k = 1; k < n; k += 1) {
      const len = fs1BlobLen(k);
      assert.ok(len > 0 && len < max, `n=${k} len=${len}`);
    }
    assert.equal(fs1BlobLen(0), 0);
    assert.equal(fs1BlobLen(n + 1), 0);

    const proofs = [];
    const vin = [];
    for (let i = 0; i < n; i += 1) {
      const blob = Buffer.alloc(FS1_RECORD_BYTES);
      blob[0] = FS1_WIRE;
      blob[1] = i + 1;
      blob[33] = 0x10 + i;
      const spendTag = Buffer.from(blob.subarray(1, 33));
      const cTilde = Buffer.from(blob.subarray(33, 65));
      proofs.push({ blob, spendTag, cTilde });
      vin.push({ commit: cTilde });
    }
    const fs1 = Buffer.alloc(max);
    fs1[0] = FS1_WIRE;
    fs1[1] = FS1_DEPTH;
    fs1[2] = n;
    const tx = { kind: 'send', anchor: 64, vin, admit_proofs: proofs, fs1, spendTag: proofs[0].spendTag };
    assert.equal(fs1BlobFits(fs1, n), true);
    const fit = verifyFlowAdmitFs1(tx, { height: 80, noteAtAnchor: null });
    assert.equal(fit.ok, false);
    assert.equal(fit.reason, 'admit_anchor_root');
    assert.equal(fit.proofChecked, undefined);

    const over = Buffer.concat([fs1, Buffer.from([0])]);
    assert.equal(fs1BlobFits(over, n), false);
    const bad = verifyFlowAdmitFs1({ ...tx, fs1: over }, { height: 80, noteAtAnchor: null });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'admit_membership');
    assert.equal(bad.proofChecked, true);
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

  it('a lock with piProof stripped or replaced is refused, and a bound lock qualifies', () => {
    resetFs1Tree();
    const seed = Buffer.alloc(32, 9);
    const pubs = [];
    const commits = [];
    let spent = null;
    for (let i = 0; i < 12; i += 1) {
      const note = attachAdmitPub(sealCoinbaseNote(5000 + i, { dest20: Buffer.alloc(20, i + 1), kind: 'pot' }), { spendSeed: seed });
      pubs.push(Buffer.from(note.admitPub));
      commits.push(Buffer.from(note.commit));
      if (i === 4) spent = { index: i, x: admitScalarFromSeed(seed, note) };
    }
    const blind = randomScalar();
    const funded = pointBytes(commit(BigInt(PI_SHE_NANOS), blind));
    const range = proveRange(BigInt(PI_SHE_NANOS), blind);
    const piProof = proveRange(0n, blind);
    assert.ok(range && piProof, 'proofs');
    assert.equal(lockQualifies(funded, piProof), true);
    const small = pointBytes(commit(1000n, blind));
    assert.equal(lockQualifies(small, null), false);
    assert.equal(lockQualifies(small, piProof), false);
    const portalId = 'ab'.repeat(32);
    const tx = {
      kind: 'lock',
      anchor: 8,
      fee: 1,
      nanos: 0,
      programId: 'shear-reserve-v1',
      portalId,
      ownerPub: Buffer.alloc(32, 0x22).toString('hex'),
      piProof,
      vin: [{ commit: Buffer.alloc(32, 7) }],
      vout: [{
        kind: 'lock',
        commit: funded,
        rangeProof: range,
        dest20: Buffer.alloc(20, 3),
      }],
    };
    const live = { n: 12, jroot: Buffer.alloc(32, 0xab), pubs, commits };
    const proven = fs1ProveSpend({
      live,
      anchor: 8,
      indices: [spent.index],
      xs: [spent.x],
      tx,
    });
    assert.ok(proven, 'prove');
    const posted = {
      ...tx,
      vin: [{ commit: Buffer.from(proven.proofs[0].cTilde) }],
      fs1: proven.fs1,
      admit_proofs: proven.proofs,
    };
    const boundDigest = txBodyDigestFs1(posted, MAGIC_TESTNET);
    assert.ok(boundDigest.equals(proven.digest), 'bound digest');
    const root = fs1RootAt(live);
    const records = Buffer.concat(proven.proofs.map((p) => p.blob));
    assert.equal(fs1Verify({ fs1: proven.fs1, records, root, digest: boundDigest, anchor: 8 }), true);
    const admit = verifyFlowAdmitFs1(posted, { height: 80, noteAtAnchor: () => live });
    assert.equal(admit.ok, true, admit.reason);

    const stripped = { ...posted };
    delete stripped.piProof;
    const strippedDigest = txBodyDigestFs1(stripped, MAGIC_TESTNET);
    assert.equal(strippedDigest.equals(boundDigest), false);
    assert.equal(fs1Verify({ fs1: proven.fs1, records, root, digest: strippedDigest, anchor: 8 }), false);
    const strippedAdmit = verifyFlowAdmitFs1(stripped, { height: 80, noteAtAnchor: () => live });
    assert.equal(strippedAdmit.ok, false);
    assert.equal(strippedAdmit.reason, 'admit_membership');
    assert.equal(spendPackDigest(stripped).equals(spendPackDigest(posted)), false);

    const other = randomScalar();
    const replaced = { ...posted, piProof: proveRange(0n, other) };
    const replacedDigest = txBodyDigestFs1(replaced, MAGIC_TESTNET);
    assert.equal(replacedDigest.equals(boundDigest), false);
    assert.equal(fs1Verify({ fs1: proven.fs1, records, root, digest: replacedDigest, anchor: 8 }), false);
    const replacedAdmit = verifyFlowAdmitFs1(replaced, { height: 80, noteAtAnchor: () => live });
    assert.equal(replacedAdmit.ok, false);
    assert.equal(replacedAdmit.reason, 'admit_membership');
    assert.equal(lockQualifies(funded, replaced.piProof), false);
  });
});

describe('lock reserve suffix binds H(piProof)', () => {
  it('matches the shared vector (wallet/test/reserve_suffix_parity_test.dart)', () => {
    const vec = JSON.parse(fs.readFileSync(path.join(here, 'vectors', 'reserve_suffix_pi.json'), 'utf8'));
    const tx = {
      kind: 'lock',
      portalId: vec.portalId,
      programId: vec.programId,
      nanos: 0,
      ownerPub: vec.ownerPub,
      piProof: Buffer.from(vec.piProof, 'hex'),
      vout: [{ kind: 'lock', commit: Buffer.from(vec.commit, 'hex') }],
    };
    assert.equal(reserveDigestSuffix(tx).toString('hex'), vec.suffix);
    const empty = { ...tx };
    delete empty.piProof;
    assert.equal(reserveDigestSuffix(empty).toString('hex'), vec.emptySuffix);
  });

  it('a vote or withdraw suffix is unchanged by a pi proof', () => {
    const portalId = 'cd'.repeat(32);
    const commitWord = Buffer.alloc(32, 4);
    const vote = {
      kind: 'vote',
      portalId,
      programId: 'shear-reserve-v1',
      choice: 'hold',
      nanos: 0,
      vout: [{ kind: 'vote', commit: commitWord }],
    };
    assert.ok(reserveDigestSuffix(vote).equals(reserveDigestSuffix({ ...vote, piProof: Buffer.from([1, 2, 3]) })));
    const withdraw = {
      kind: 'withdraw',
      id: 'wd-1',
      portalId,
      programId: 'shear-reserve-v1',
      nanos: 1,
      withdrawNonce: Buffer.alloc(32, 9),
      vout: [{ kind: 'withdraw', commit: commitWord }],
    };
    assert.ok(reserveDigestSuffix(withdraw).equals(reserveDigestSuffix({ ...withdraw, piProof: Buffer.from([1, 2, 3]) })));
    const lock = {
      kind: 'lock',
      portalId,
      programId: 'shear-reserve-v1',
      nanos: 0,
      ownerPub: '11'.repeat(32),
      vout: [{ kind: 'lock', commit: commitWord }],
    };
    const bare = reserveDigestSuffix(lock);
    const withProof = reserveDigestSuffix({ ...lock, piProof: Buffer.from([1, 2, 3]) });
    assert.equal(withProof.length, bare.length);
    assert.equal(withProof.subarray(0, withProof.length - 32).equals(bare.subarray(0, bare.length - 32)), true);
    assert.equal(withProof.subarray(withProof.length - 32).equals(bare.subarray(bare.length - 32)), false);
  });

  it('a full lock and its compact copy sign the same reserve digest (Russell 26 Oct)', () => {
    const portalId = 'aa'.repeat(32);
    const sealed = sealCoinbaseNote(PI_SHE_NANOS, { dest20: Buffer.alloc(20, 4), kind: 'lock' });
    const lockRow = { kind: 'lock', commit: sealed.commit, noteCommit: sealed.noteCommit, dest20: Buffer.alloc(20, 4) };
    const lock = {
      kind: 'lock',
      portalId,
      programId: 'shear-reserve-v1',
      ownerPub: '11'.repeat(32),
      vout: [lockRow],
    };
    const honest = reserveDigestSuffix(lock);
    // A plaintext nanos beside the commitment: compaction drops it, and the
    // digest never read it, so the full row and its compact copy agree.
    for (const planted of [PI_SHE_NANOS, 1, 0, '7']) {
      const fat = { ...lock, vout: [{ ...lockRow, nanos: planted }] };
      assert.ok(reserveDigestSuffix(fat).equals(honest), `planted ${planted}`);
      assert.ok(reserveDigestSuffix(compactTx(fat)).equals(honest), `compact of planted ${planted}`);
    }
    // An empty published v is no amount either.
    assert.ok(reserveDigestSuffix({ ...lock, vout: [{ ...lockRow, valueProof: { v: '' } }] }).equals(honest));
    // A public withdraw row's nanos equals its posted opening and is read as that opening.
    const out = sealCoinbaseNote(5_000, { dest20: Buffer.alloc(20, 6), kind: 'withdraw' });
    const withdraw = {
      kind: 'withdraw',
      id: 'wd-same',
      portalId,
      programId: 'shear-reserve-v1',
      withdrawNonce: Buffer.alloc(32, 9),
      vout: [{ kind: 'withdraw', commit: out.commit, noteCommit: out.noteCommit, valueProof: out.valueProof, nanos: 5_000 }],
    };
    assert.ok(reserveDigestSuffix(withdraw).equals(reserveDigestSuffix(compactTx(withdraw))));
  });
});

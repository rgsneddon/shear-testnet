import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomScalar, commit, pointBytes, proveRange, verifyRange, sealNote } from '../../crypto/note.js';
import { admitPub, admitProve, admitVerify, emptyFluxset, applyBlockToFluxset, jroot } from '../../crypto/admit.js';
import { levyNeed, levyFromWeight, LEVY_CAP_NANOS } from '../../crypto/levy.js';

const SIB = 32 * 32;
const LEAF_PAIRED = 32 * 2 + 64 + 32 * 32 * 5;

describe('ADMITv2 adversary (zero skips)', () => {
  it('native verify rejects from-scratch non-member, self-minted C̃, mixed dest/C siblings', () => {
    const n = 40;
    const xs = Array.from({ length: n }, () => randomScalar());
    const pubs = xs.map(admitPub);
    const commits = xs.map((_, i) => pointBytes(commit(i + 2, randomScalar())));
    const victim = admitProve({ x: xs[7], index: 7, pubs, commits, c: commits[7] });
    const other = admitProve({ x: xs[39], index: 39, pubs, commits, c: commits[39] });
    assert.ok(victim && other);
    const extra = (p) => ({ cTilde: p.cTilde, spendTag: p.spendTag });
    const ax = randomScalar();
    const aPub = admitPub(ax);
    const aC = pointBytes(commit(99, randomScalar()));
    const attackerOwn = admitProve({
      x: ax,
      index: 0,
      pubs: [aPub, ...pubs.slice(1)],
      commits: [aC, ...commits.slice(1)],
      c: aC,
    });
    assert.ok(attackerOwn);
    const forged = admitProve({ x: ax, index: 7, pubs, commits, c: commits[7] });
    assert.ok(forged);
    assert.equal(admitVerify(forged, { pubs, commits }, extra(forged)), false);
    const jr = jroot({ pubs, commits });
    assert.equal(admitVerify(attackerOwn, { pubs: [], commits: [] }, { jroot: jr, cTilde: attackerOwn.cTilde, spendTag: attackerOwn.spendTag }), false);
    const minted = Buffer.from(victim.blob);
    minted[33] ^= 0x5a;
    const fakeCt = Buffer.from(victim.cTilde);
    fakeCt[0] ^= 0x5a;
    assert.equal(admitVerify({ ...victim, blob: minted }, { pubs, commits }, { cTilde: fakeCt, spendTag: victim.spendTag }), false);
    const vBlob = Buffer.from(victim.blob);
    const oBlob = Buffer.from(other.blob);
    const mixed = Buffer.from(vBlob);
    const offV = vBlob.length - LEAF_PAIRED - SIB;
    const offO = oBlob.length - LEAF_PAIRED - SIB;
    oBlob.subarray(offO, offO + SIB).copy(mixed, offV);
    assert.equal(admitVerify({ ...victim, blob: mixed }, { pubs, commits }, extra(victim)), false);
    assert.equal(admitVerify(victim, { pubs, commits }, extra(victim)), true);
  });

  it('v1 linear blob fails; subset J fails; fake C̃ fails; honest verifies', () => {
    const n = 6;
    const xs = Array.from({ length: n }, () => randomScalar());
    const pubs = xs.map(admitPub);
    const commits = xs.map((_, i) => pointBytes(commit(i + 2, randomScalar())));
    const proof = admitProve({ x: xs[2], index: 2, pubs, commits, c: commits[2] });
    assert.ok(proof);
    assert.equal(admitVerify(proof, { pubs, commits }, { cTilde: proof.cTilde, spendTag: proof.spendTag }), true);
    const jr = jroot({ pubs, commits });
    assert.equal(admitVerify(proof, { pubs: [], commits: [] }, { jroot: jr, cTilde: proof.cTilde, spendTag: proof.spendTag }), true);
    const v1 = { r: pubs.map(() => Buffer.alloc(32)), c0: Buffer.alloc(32), spendTag: proof.spendTag };
    assert.equal(admitVerify(v1, { pubs, commits }, { cTilde: proof.cTilde }), false);
    assert.equal(admitVerify(proof, { pubs: pubs.slice(0, 3), commits: commits.slice(0, 3) }, { cTilde: proof.cTilde, spendTag: proof.spendTag }), false);
    const fakeCt = pointBytes(commit(99, randomScalar()));
    assert.equal(admitVerify(proof, { pubs, commits }, { cTilde: fakeCt, spendTag: proof.spendTag }), false);
  });

  it('spent leaves stay in J after a later spend tag is recorded', () => {
    const x = randomScalar();
    const P = admitPub(x);
    const c = pointBytes(commit(1, randomScalar()));
    const b1 = { txs: [{ vout: [{ admitPub: P.toBytes(), commit: c }] }] };
    const live = applyBlockToFluxset(emptyFluxset(), b1);
    assert.equal(live.pubs.length, 1);
    const spent = applyBlockToFluxset(live, { txs: [{ spendTag: Buffer.alloc(32, 9), vout: [] }] });
    assert.equal(spent.pubs.length, 1);
    assert.equal(spent.spendTags.size, 1);
  });

  it('v3 bit-OR range blobs fail native range; dummy 0 proves', () => {
    const note = sealNote(0, { dest20: Buffer.alloc(20, 1), kind: 'dummy' });
    assert.equal(verifyRange(note.commit, note.rangeProof), true);
    assert.equal(verifyRange(note.commit, { bits: new Array(64).fill(0), B: [], cons: {} }), false);
    const p = proveRange(7, randomScalar());
    assert.ok(Buffer.isBuffer(p) && p[0] === 2);
  });

  it('weight levy is not 2 bps; fee > cap is above the emergency brake', () => {
    const tx1 = { kind: 'send', nanos: '0000000001', vin: [{}], vout: [{}] };
    const tx9 = { kind: 'send', nanos: '1000000000', vin: [{}], vout: [{}] };
    assert.equal(levyNeed(tx1), levyNeed(tx9));
    const bps = Math.ceil((1e9 * 2) / 10000);
    assert.notEqual(levyNeed(tx9), bps);
    assert.ok(levyFromWeight(1) < 0.01 * LEVY_CAP_NANOS);
    assert.ok(levyFromWeight(64) <= LEVY_CAP_NANOS);
  });
});

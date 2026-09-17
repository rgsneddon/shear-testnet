import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomScalar, commit, scalarBytes, pointBytes } from './note.js';
import { admitPub, admitProve, admitVerify, spendTag, jroot, emptyFluxset, applyBlockToFluxset, fluxsetFromBlocks } from './admit.js';
import { nativeLoaded, nativeMaxProof, nativeArity } from './native_admit.js';

function sha512(parts) {
  const h = createHash('sha512');
  for (const p of parts) h.update(p);
  return h.digest();
}
function xorPath(buf, nonce) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i += 1) {
    const idx = Buffer.alloc(8);
    idx.writeBigUInt64LE(BigInt(i));
    const w = sha512([Buffer.from('shear-path-blind'), nonce, idx]);
    out[i] ^= w[i % 32];
  }
  return out;
}
function pathOff(blob) {
  const b = Buffer.from(blob);
  return { ld: b.readUInt32LE(354), lc: b.readUInt32LE(358), off: 362, d0: b[353], nonce: Buffer.from(b.subarray(321, 353)) };
}
function reblindPaths(srcBlob, nonceFrom, nonceTo) {
  const { ld, lc, off } = pathOff(srcBlob);
  const dest = xorPath(srcBlob.subarray(off, off + ld), nonceFrom);
  const c = xorPath(srcBlob.subarray(off + ld, off + ld + lc), nonceFrom);
  return { dest: xorPath(dest, nonceTo), c: xorPath(c, nonceTo), ld, lc, off };
}

describe('ADMITv2 fluxset membership', () => {
  it('proves a spend is admissible in the fluxset; a sampled subset is the wrong set', () => {
    const n = 8;
    const xs = Array.from({ length: n }, () => randomScalar());
    const pubs = xs.map(admitPub);
    const commits = xs.map((_, i) => pointBytes(commit(i + 1, randomScalar())));
    const index = 3;
    let admit_proof;
    try {
      admit_proof = admitProve({ x: xs[index], index, pubs, commits, c: commits[index] });
    } catch (e) {
      assert.fail(String(e && e.stack || e));
    }
    assert.ok(admit_proof, `prove failed n=${n} dest=${pubs.length} c=${commits.length} idx=${index} c0=${commits[0] && commits[0].length}`);
    assert.equal(admit_proof.admit_proof, true);
    assert.equal(admit_proof.v, 2);
    assert.ok(admit_proof.blob[0] === 2);
    assert.equal(admitVerify(admit_proof, { pubs, commits }, { cTilde: admit_proof.cTilde, spendTag: admit_proof.spendTag }), true);
    const jr = jroot({ pubs, commits });
    assert.equal(admitVerify(admit_proof, { pubs: [], commits: [] }, { jroot: jr, cTilde: admit_proof.cTilde, spendTag: admit_proof.spendTag }), true);
    assert.equal(admitVerify(admit_proof, { pubs: pubs.slice(0, 4), commits: commits.slice(0, 4) }, { cTilde: admit_proof.cTilde, spendTag: admit_proof.spendTag }), false);
    const other = admitProve({ x: xs[0], index: 0, pubs, commits, c: commits[0] });
    assert.ok(other);
    assert.equal(Buffer.from(admit_proof.spendTag).equals(Buffer.from(other.spendTag)), false);
    const v1 = { admit_proof: true, spendTag: admit_proof.spendTag, c0: Buffer.alloc(32), r: pubs.map(() => Buffer.alloc(32)) };
    assert.equal(admitVerify(v1, { pubs, commits }, { cTilde: admit_proof.cTilde }), false);
    const root = Buffer.from(jr);
    const otherRoot = Buffer.from(jroot({ pubs: pubs.slice(0, 4), commits: commits.slice(0, 4) }));
    assert.equal(root.length, 32);
    assert.equal(root.equals(otherRoot), false);
  });

  it('native verify rejects attacker x on victim path, self-minted C̃, mixed dest/C indices', () => {
    const n = 40;
    const xs = Array.from({ length: n }, () => randomScalar());
    const pubs = xs.map(admitPub);
    const commits = xs.map((_, i) => pointBytes(commit(i + 2, randomScalar())));
    const victim = admitProve({ x: xs[7], index: 7, pubs, commits, c: commits[7] });
    const attacker = admitProve({ x: xs[0], index: 0, pubs, commits, c: commits[0] });
    const other = admitProve({ x: xs[39], index: 39, pubs, commits, c: commits[39] });
    assert.ok(victim && attacker && other);
    const extra = (p) => ({ cTilde: p.cTilde, spendTag: p.spendTag });
    assert.equal(admitVerify(victim, { pubs, commits }, extra(victim)), true);
    const pAtt = pointBytes(pubs[0]);
    const cAtt = Buffer.from(commits[0]);
    assert.equal(Buffer.from(attacker.blob).includes(pAtt), false);
    assert.equal(Buffer.from(attacker.blob).includes(cAtt), false);
    const aBlob = Buffer.from(attacker.blob);
    const vBlob = Buffer.from(victim.blob);
    const oBlob = Buffer.from(other.blob);
    const aMeta = pathOff(aBlob);
    const vMeta = pathOff(vBlob);
    const reb = reblindPaths(vBlob, vMeta.nonce, aMeta.nonce);
    const spliced = Buffer.from(aBlob);
    spliced[353] = vMeta.d0;
    reb.dest.copy(spliced, aMeta.off);
    reb.c.copy(spliced, aMeta.off + aMeta.ld);
    assert.equal(admitVerify({ ...attacker, blob: spliced }, { pubs, commits }, extra(attacker)), false);
    const minted = Buffer.from(vBlob);
    minted[33] ^= 0x5a;
    const fakeCt = Buffer.from(victim.cTilde);
    fakeCt[0] ^= 0x5a;
    assert.equal(admitVerify({ ...victim, blob: minted }, { pubs, commits }, { cTilde: fakeCt, spendTag: victim.spendTag }), false);
    const mixedReb = reblindPaths(oBlob, pathOff(oBlob).nonce, vMeta.nonce);
    const mixed = Buffer.from(vBlob);
    mixedReb.c.copy(mixed, vMeta.off + vMeta.ld);
    assert.equal(admitVerify({ ...victim, blob: mixed }, { pubs, commits }, extra(victim)), false);
  });

  it('applyBlockToFluxset matches fluxsetFromBlocks and empty J has a 32-byte jroot', () => {
    const x = randomScalar();
    const P = admitPub(x);
    const block = { txs: [{ vout: [{ admitPub: P.toBytes(), commit: Buffer.alloc(32, 3) }] }] };
    const live = applyBlockToFluxset(emptyFluxset(), block);
    const rebuilt = fluxsetFromBlocks([block]);
    assert.equal(live.pubs.length, 1);
    assert.equal(live.commits.length, 1);
    assert.equal(Buffer.from(live.jroot).equals(Buffer.from(rebuilt.jroot)), true);
    assert.equal(Buffer.from(emptyFluxset().jroot).length, 32);
    const more = [
      block,
      { txs: [{ vout: [{ admitPub: admitPub(randomScalar()).toBytes(), commit: Buffer.alloc(32, 4) }] }] },
      { txs: [{ vout: [{ admitPub: admitPub(randomScalar()).toBytes(), commit: Buffer.alloc(32, 5) }] }] },
    ];
    let folded = emptyFluxset();
    for (const b of more) folded = applyBlockToFluxset(folded, b);
    const fromBlocks = fluxsetFromBlocks(more);
    assert.equal(folded.pubs.length, 3);
    assert.equal(fromBlocks.pubs.length, 3);
    assert.equal(Buffer.from(folded.jroot).equals(Buffer.from(fromBlocks.jroot)), true);
    const src = fs.readFileSync(fileURLToPath(new URL('./admit.js', import.meta.url)), 'utf8');
    const fn = src.slice(src.indexOf('export function fluxsetFromBlocks'), src.indexOf('export function compactAdmitProof'));
    assert.match(fn, /jroot\(\{ pubs, commits \}\)/);
    assert.equal(fn.includes('applyBlockToFluxset'), false);
  });
});

describe('specs/admit-v2.md pins the shipped native book', () => {
  it('Pasta arity-32 pad_to_arity, leaf DST, Forests, batch, max proof, reject names match native', () => {
    const specPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'specs', 'admit-v2.md');
    const spec = fs.readFileSync(specPath, 'utf8');
    assert.match(spec, /Anonymous Destination Membership Integer Transactions/);
    assert.match(spec, /ADMITv2/);
    assert.match(spec, /Do not write AdmitV2, ADMITV2/);
    assert.match(spec, /Pallas–Vesta|pallas-vesta-pasta/);
    assert.match(spec, /Arity `D` \| \*\*32\*\*/);
    assert.match(spec, /pad_to_arity/);
    assert.match(spec, /shear-admit-leaf-v2/);
    assert.match(spec, /Curve Forests/);
    assert.match(spec, /admit_verify_batch/);
    assert.match(spec, /\*\*16384\*\*/);
    assert.match(spec, /admit_membership/);
    assert.match(spec, /admit_link_tag/);
    assert.match(spec, /range_proof/);
    assert.match(spec, /commit_sum/);
    assert.match(spec, /silent_id_on_chain/);
    assert.match(spec, /not a tower over Ed25519/);
    assert.match(spec, /Helios\/Selene \| \*\*not used\*\*/);
    assert.ok(nativeLoaded(), 'shearadmit.node must load');
    assert.equal(nativeMaxProof(), 16384);
    assert.equal(nativeArity(), 32);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomScalar, commit, pointBytes } from './note.js';
import { admitPub, admitProveV3, admitVerifyV3, jrootPoint, emptyFluxset, applyBlockToFluxset, fluxsetFromBlocks } from './admit.js';
import { nativeLoaded, nativeMaxProof, nativeArity } from './native_admit.js';

describe('fluxset membership', () => {
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
    const fn = src.slice(src.indexOf('export function fluxsetFromBlocks'), src.indexOf('export function fluxsetIndexOf'));
    assert.match(fn, /appendFluxBlock\(live, b\)/);
    assert.equal(fn.includes('applyBlockToFluxset'), false);
    const install = src.slice(src.indexOf('function installFrontiers'), src.indexOf('export function fluxWithLeaves'));
    assert.match(install, /jroot\(\{ pubs: dest\.pubs, commits: dest\.commits \}\)/);
  });
});

describe('ADMITv3 fresh point', () => {
  it('seals an honest note and rejects a fresh point that is not in the set', () => {
    const n = 8;
    const xs = Array.from({ length: n }, () => randomScalar());
    const pubs = xs.map(admitPub);
    const commits = xs.map((_, i) => pointBytes(commit(i + 1, randomScalar())));
    const index = 3;
    const t = randomScalar();
    const ctx = Buffer.alloc(64, 7);
    ctx[0] = 0x33;
    const proof = admitProveV3({ x: xs[index], index, pubs, commits, c: commits[index], t, ctx });
    assert.ok(proof, 'honest v3 seal');
    assert.equal(proof.v, 3);
    assert.equal(proof.blob[0], 3);
    const jr = jrootPoint({ pubs, commits });
    assert.equal(admitVerifyV3(proof, { pubs, commits }, {
      jroot: jr, ctx, cTilde: proof.cTilde, spendTag: proof.spendTag,
    }), true);
    const ax = randomScalar();
    const aC = pointBytes(commit(50000, randomScalar()));
    assert.equal(admitProveV3({
      x: ax, index: 0, pubs, commits, c: aC, t, ctx,
    }), null);
    const aPubs = [admitPub(ax), ...pubs.slice(1)];
    const aCommits = [aC, ...commits.slice(1)];
    const outsider = admitProveV3({
      x: ax, index: 0, pubs: aPubs, commits: aCommits, c: aC, t, ctx,
    });
    assert.ok(outsider, 'a fresh point proves only inside a set that contains it');
    assert.equal(admitVerifyV3(outsider, { pubs, commits }, {
      jroot: jr, ctx, cTilde: outsider.cTilde, spendTag: outsider.spendTag,
    }), false);
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
    assert.match(spec, /\*\*32768\*\*/);
    assert.match(spec, /admit_membership/);
    assert.match(spec, /admit_link_tag/);
    assert.match(spec, /range_proof/);
    assert.match(spec, /commit_sum/);
    assert.match(spec, /silent_id_on_chain/);
    assert.match(spec, /not a tower over Ed25519/);
    assert.match(spec, /Helios\/Selene \| \*\*not used\*\*/);
    assert.ok(nativeLoaded(), 'shearadmit.node must load');
    assert.equal(nativeMaxProof(), 32768);
    assert.equal(nativeArity(), 32);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noteFromAnchor } from '../src/chain.js';
import { verifyTypedAdmitFunding } from '../../crypto/admit_v3.js';
import { jroot, jrootPoint, admitPub } from '../../crypto/admit.js';
import { commit, pointBytes, randomScalar } from '../../crypto/note.js';

describe('anchor notes fund the point book', () => {
  it('noteFromAnchor returns the sliced notes and a lying root fails closed', () => {
    const pub = pointBytes(admitPub(randomScalar()));
    const note = pointBytes(commit(1, randomScalar()));
    const flux = { pubs: [pub, Buffer.alloc(32, 3)], commits: [note, Buffer.alloc(32, 4)] };
    const v2 = jroot({ pubs: [pub], commits: [note] });
    const point = jrootPoint({ pubs: [pub], commits: [note] });
    assert.equal(v2.equals(point), false);
    const rec = noteFromAnchor(flux, { 8: { jroot: v2, n: 1 } }, 8);
    assert.deepEqual(Object.keys(rec).sort(), ['commits', 'jroot', 'n', 'pubs']);
    assert.equal(rec.n, 1);
    assert.equal(rec.pubs.length, 1);
    assert.equal(rec.commits.length, 1);
    assert.equal(Buffer.from(rec.pubs[0]).equals(pub), true);
    const blob = Buffer.alloc(129, 7);
    blob[0] = 3;
    const posted = Buffer.alloc(32, 4);
    const tx = {
      kind: 'lock',
      anchor: 8,
      vin: [{ commit: posted, anchor: 8 }],
      admit_proofs: [{ blob, cTilde: posted }],
    };
    // Until FS-1 a vault bucket proof is refused before any anchor or proof work.
    let anchorReads = 0;
    const chain = verifyTypedAdmitFunding(tx, {
      height: 24,
      noteAtAnchor: (a) => { anchorReads += 1; return noteFromAnchor(flux, { 8: { jroot: v2, n: 1 } }, a); },
    });
    assert.equal(chain.ok, false);
    assert.equal(chain.reason, 'vault_unavailable');
    assert.equal(chain.proofChecked, undefined);
    const lie = verifyTypedAdmitFunding(tx, {
      height: 24,
      noteAtAnchor: () => { anchorReads += 1; return { pubs: [pub], commits: [note], n: 1, jroot: Buffer.alloc(32, 9) }; },
    });
    assert.equal(lie.ok, false);
    assert.equal(lie.reason, 'vault_unavailable');
    assert.equal(anchorReads, 0);
  });
});

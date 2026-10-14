// The consensus admit note set against the FS-1 tree leaf set, on the shared vectors.
//
// Read only: this test calls crypto/admit.js and reads node/src/chain.js; it changes neither.
//
// Documented divergence. Both sets start from the same candidates
// (outputJoinsAdmitSet: an admitPub, and not a lock or vote receipt). Then:
//
// - Consensus (crypto/admit.js absorbFluxBlock, used by fluxsetFromBlocks and
//   applyBlockToFluxset) keeps a candidate whenever its admitPub decodes as
//   Ristretto255, the identity included. The commit is never decoded: a missing
//   commit is stored as 32 zero bytes, and any commit bytes are kept as they are.
// - Consensus in-block view (node/src/chain.js pushPub) skips a candidate with no
//   commit field, but keeps a 32-zero-byte commit and any other commit bytes.
// - The wallet (admit.js attachAdmitPub) only checks that an admitPub is 32 bytes.
// - FS-1 (L-3) keeps a candidate only when admitPub and commit both decode to
//   non-identity points.
//
// So a note with a zero, missing, identity or undecodable commit, or an identity
// admitPub, is in the consensus admit set but takes no FS-1 slot (M76-2). On the
// vectors that is two notes of fork block a3. Adding the matching consensus
// rejection needs Russell's sign-off and is not done here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { fluxsetFromBlocks, outputJoinsAdmitSet } from '../../crypto/admit.js';
import { fs1Leaf, fs1NotesFromBlock } from '../src/fs1_tree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, '../../crypto/native/vendor/monero-oxide-77788c3');
const rows = fs.readFileSync(path.join(vendor, 'shear-fs1/vectors/tree_chain.txt'), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
const real = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/p2p-wedge-blocks.json'), 'utf8')).blocks;
const fork = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/fs1-tree-fork-blocks.json'), 'utf8')).blocks;
const byLabel = new Map([['w1', real[0]], ['w2', real[1]], ['w3', real[2]], ['a3', fork[0]], ['a4', fork[1]]]);

/** Every candidate output, with whether consensus and FS-1 each give it a place. */
function classify(block) {
  const out = [];
  block.txs.forEach((tx, t) => (tx.vout || []).forEach((o, v) => {
    if (!outputJoinsAdmitSet(tx, o)) return;
    const consensus = fluxsetFromBlocks([{ ...block, txs: [{ ...tx, vout: [o] }] }]).pubs.length === 1;
    const [note] = fs1NotesFromBlock({ txs: [{ ...tx, vout: [o] }] });
    out.push({ at: `tx${t}.vout${v}`, consensus, fs1: Boolean(fs1Leaf(note)) });
  }));
  return out;
}

const count = (list, key) => list.filter((c) => c[key]).length;
const vectorLeaves = (label) => rows.filter((r) => r[0] === 'note' && r[1] === label && r[4] !== 'skip').length;
const vectorCount = (op, label) => Number(rows.find((r) => r[0] === op && r[1] === label)[op === 'connect' ? 5 : 3]);

describe('consensus admit set against the FS-1 tree leaf set', () => {
  it('per block: FS-1 counts match the vector, and only a3 diverges, by two notes', () => {
    const want = { w1: [1, 1, 1], w2: [3, 3, 3], w3: [3, 3, 3], a3: [42, 41, 39], a4: [1, 1, 1] };
    for (const [label, block] of byLabel) {
      const c = classify(block);
      assert.deepEqual([c.length, count(c, 'consensus'), count(c, 'fs1')], want[label], label);
      assert.equal(count(c, 'fs1'), vectorLeaves(label), label);
      assert.equal(c.some((x) => x.fs1 && !x.consensus), false, `${label}: FS-1 never keeps what consensus drops`);
    }
  });

  it('a3: the consensus-only notes are exactly the zero commit and the missing commit', () => {
    const a3 = fork[0];
    const c = classify(a3);
    assert.deepEqual(c.filter((x) => x.consensus && !x.fs1).map((x) => x.at), ['tx3.vout0', 'tx3.vout3']);
    assert.equal(a3.txs[3].vout[0].commit.$hex, '00'.repeat(32));
    assert.equal(a3.txs[3].vout[3].commit, undefined);
    assert.deepEqual(c.filter((x) => !x.consensus && !x.fs1).map((x) => x.at), ['tx3.vout1']);
    assert.equal(a3.txs[3].vout[1].admitPub.$hex, 'ff'.repeat(32));
  });

  it('whole chains: consensus and the FS-1 vector agree on the real chain and differ by two on the fork', () => {
    const main = fluxsetFromBlocks(real).pubs.length;
    assert.equal(main, 7);
    assert.equal(main, Number(rows.filter((r) => r[0] === 'connect' && r[1] === 'w3').pop()[5]));
    const side = fluxsetFromBlocks([real[0], real[1], ...fork]).pubs.length;
    assert.equal(side, 46);
    assert.equal(vectorCount('connect', 'a4'), 44);
    assert.equal(side - vectorCount('connect', 'a4'), 2);
  });

  it('edge cases beyond the vectors, as consensus and FS-1 treat them today', () => {
    const g = Buffer.from(RistrettoPoint.BASE.toRawBytes()).toString('hex');
    const z = '00'.repeat(32);
    const cases = [
      ['valid note', { admitPub: g, commit: g }, true, true],
      ['zero commit', { admitPub: g, commit: z }, true, false],
      ['missing commit', { admitPub: g }, true, false],
      ['commit not a point', { admitPub: g, commit: 'ff'.repeat(32) }, true, false],
      ['commit not 32 bytes', { admitPub: g, commit: 'aa' }, true, false],
      ['identity admitPub', { admitPub: z, commit: g }, true, false],
      ['admitPub not a point', { admitPub: 'ff'.repeat(32), commit: g }, false, false],
      ['admitPub not 32 bytes', { admitPub: 'aa', commit: g }, false, false],
    ];
    for (const [name, f, consensus, fs1] of cases) {
      const o = { kind: 'out', admitPub: { $hex: f.admitPub }, ...(f.commit ? { commit: { $hex: f.commit } } : {}) };
      const [got] = classify({ txs: [{ kind: 'send', vout: [o] }] });
      assert.deepEqual([got.consensus, got.fs1], [consensus, fs1], name);
    }
  });

  it('the consensus lines this divergence rests on are unchanged', () => {
    const admit = fs.readFileSync(path.join(here, '../../crypto/admit.js'), 'utf8');
    assert.match(admit, /commits\.push\(o\.commit \? Buffer\.from\(asU8\(o\.commit\)\) : Buffer\.alloc\(32\)\);/);
    assert.match(admit, /if \(!\(vout\.admitPub && Buffer\.from\(asU8\(vout\.admitPub\)\)\.length === 32\)\) \{/);
    const chain = fs.readFileSync(path.join(here, '../src/chain.js'), 'utf8');
    assert.match(chain, /if \(!outputJoinsAdmitSet\(tx, o\) \|\| !o\?\.commit\) return;\n\s+try \{\n\s+pubs\.push\(/);
  });
});

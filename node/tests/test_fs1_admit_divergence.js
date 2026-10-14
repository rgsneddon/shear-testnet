// N-1. The consensus admit set and the FS-1 leaf set are the same set.
//
// Both start from outputJoinsAdmitSet. A note is kept only when admitPub,
// commit, and Hp(admitPub) each decode to a non-identity point, the same
// predicate as shear-fs1 src/leaf.rs. The leaf bytes are pinned in
// vectors/tree_chain.txt and vectors/n1_leaf.txt, which the Rust tests read too.
// A block that still carries a note the predicate skips is rejected with
// admit_note_point. There is no activation height.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fluxsetFromBlocks, outputJoinsAdmitSet } from '../../crypto/admit.js';
import { fs1Leaf, fs1OutputNote } from '../../crypto/fs1_leaf.js';
import { chainNoteRuleRejected } from '../../crypto/n1.js';
import { fs1NotesFromBlock } from '../src/fs1_tree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, '../../crypto/native/vendor/monero-oxide-77788c3');
const rows = fs.readFileSync(path.join(vendor, 'shear-fs1/vectors/tree_chain.txt'), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
const n1Rows = fs.readFileSync(path.join(vendor, 'shear-fs1/vectors/n1_leaf.txt'), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#'));
const real = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/p2p-wedge-blocks.json'), 'utf8')).blocks;
const fork = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/fs1-tree-fork-blocks.json'), 'utf8')).blocks;
const byLabel = new Map([['w1', real[0]], ['w2', real[1]], ['w3', real[2]], ['a3', fork[0]], ['a4', fork[1]]]);

function hexOf(buf) {
  return Buffer.from(buf).toString('hex');
}

/** One row per output that joins the admit set, in the vector's order. */
function classify(block) {
  const out = [];
  block.txs.forEach((tx, t) => (tx.vout || []).forEach((o, v) => {
    if (!outputJoinsAdmitSet(tx, o)) return;
    const consensus = fluxsetFromBlocks([{ ...block, txs: [{ ...tx, vout: [o] }] }]).pubs.length === 1;
    const [note] = fs1NotesFromBlock({ txs: [{ ...tx, vout: [o] }] });
    const leaf = fs1Leaf(note);
    out.push({ at: `tx${t}.vout${v}`, consensus, leaf: leaf ? hexOf(leaf) : null });
  }));
  return out;
}

const vectorNotes = (label) => rows.filter((r) => r[0] === 'note' && r[1] === label);
const vectorCount = (op, label) => Number(rows.find((r) => r[0] === op && r[1] === label)[op === 'connect' ? 5 : 3]);

describe('consensus admit set equals the FS-1 leaf set', () => {
  it('each shared chain note is kept by both, with the same leaf bytes', () => {
    for (const [label, block] of byLabel) {
      const notes = vectorNotes(label);
      const got = classify(block);
      assert.equal(got.length, notes.length, label);
      notes.forEach((row, i) => {
        const wantLeaf = row[4] === 'skip' ? null : row[4];
        assert.equal(got[i].consensus, wantLeaf != null, `${label} ${got[i].at}`);
        assert.equal(got[i].leaf, wantLeaf, `${label} ${got[i].at}`);
      });
    }
  });

  it('a block whose notes the predicate skips is rejected, including the fork', () => {
    assert.equal(chainNoteRuleRejected(real), null);
    assert.equal(chainNoteRuleRejected([fork[1]]), null);
    const rejected = chainNoteRuleRejected([fork[0]]);
    assert.equal(rejected.reason, 'admit_note_point');
    const a3 = classify(fork[0]);
    assert.deepEqual(a3.filter((row) => !row.leaf).map((row) => row.at), ['tx3.vout0', 'tx3.vout1', 'tx3.vout3']);
  });

  it('whole chains keep the vector counts, on the real chain and on the fork', () => {
    const main = fluxsetFromBlocks(real).pubs.length;
    assert.equal(main, 7);
    assert.equal(main, vectorCount('connect', 'w3'));
    const side = fluxsetFromBlocks([real[0], real[1], ...fork]).pubs.length;
    assert.equal(side, vectorCount('connect', 'a4'));
  });

  it('n1_leaf.txt: JS and the file agree, skips included', () => {
    assert.ok(n1Rows.length >= 8);
    for (const line of n1Rows) {
      const [name, admit, commit, want] = line.split('\t');
      const leaf = fs1Leaf(fs1OutputNote({ admitPub: admit, commit }));
      assert.equal(leaf ? hexOf(leaf) : 'skip', want, name);
      const kept = fluxsetFromBlocks([{
        txs: [{ vout: [{ kind: 'pot', admitPub: { $hex: admit }, commit: { $hex: commit } }] }],
      }]).pubs.length;
      assert.equal(kept, want === 'skip' ? 0 : 1, name);
    }
  });
});

// Writes shear-fs1/vectors/tree_chain.txt and node/tests/fixtures/fs1-tree-fork-blocks.json.
//
// Blocks w1..w3 are the real chain blocks in node/tests/fixtures/p2p-wedge-blocks.json.
// Blocks a3 and a4 are a fork off w2 in the same block format. The ops connect the real
// chain, reorg onto the fork, and reorg back. Leaves come from node/src/fs1_tree.js;
// roots come from the crate's fs1_tree tool, which must be built:
//   cargo build --release -p shear-fs1 --features tree-cli --bin fs1_tree
// Run: node node/scripts/fs1_tree_vectors.js

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ristretto255_hasher } from '@noble/curves/ed25519.js';
import { Fs1TreeFollower, fs1NotesFromBlock, fs1Leaf, openFs1TreeEngine } from '../src/fs1_tree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const crate = path.join(here, '../../crypto/native/vendor/monero-oxide-77788c3/shear-fs1');
const fixtures = path.join(here, '../tests/fixtures');

const hx = (b) => Buffer.from(b).toString('hex');
const point = (tag) => hx(ristretto255_hasher.hashToCurve(new TextEncoder().encode(tag), { DST: 'shear-fs1-vector' }).toRawBytes());
const idOf = (label) => createHash('sha256').update(`shear-fs1-vector-block-${label}`).digest('hex');

function out(label, i, extra = {}) {
  return { kind: 'out', admitPub: { $hex: point(`${label}-pub-${i}`) }, commit: { $hex: point(`${label}-commit-${i}`) }, ...extra };
}

function forkBlock(label, height, parent, txs) {
  return { hash: idOf(label), prevHash: { $hex: parent }, height, txs };
}

export function forkBlocks(w2Hash) {
  const a3 = forkBlock('a3', 3, w2Hash, [
    { kind: 'send', vout: Array.from({ length: 30 }, (_, i) => out('a3', i)) },
    { kind: 'lock', vout: [{ kind: 'lock', admitPub: { $hex: point('a3-lock') }, commit: { $hex: point('a3-lock-c') } }, out('a3', 30, { kind: 'change' })] },
    { kind: 'vote', vout: [{ kind: 'vote', admitPub: { $hex: point('a3-vote') }, commit: { $hex: point('a3-vote-c') } }] },
    {
      kind: 'send',
      vout: [
        out('a3', 31, { commit: { $hex: '00'.repeat(32) } }),
        out('a3', 32, { admitPub: { $hex: 'ff'.repeat(32) } }),
        { kind: 'out', commit: { $hex: point('a3-nopub') } },
        out('a3', 33, { commit: undefined }),
        ...Array.from({ length: 8 }, (_, i) => out('a3', 34 + i)),
      ],
    },
  ]);
  const a4 = forkBlock('a4', 4, a3.hash, [{ coinbase: true, kind: 'coinbase', vout: [out('a4', 0)] }]);
  return [a3, a4];
}

async function main() {
  const real = JSON.parse(fs.readFileSync(path.join(fixtures, 'p2p-wedge-blocks.json'), 'utf8')).blocks;
  const [w1, w2, w3] = real;
  const [a3, a4] = forkBlocks(w2.hash);
  fs.writeFileSync(path.join(fixtures, 'fs1-tree-fork-blocks.json'), `${JSON.stringify({ blocks: [a3, a4] }, null, 1)}\n`);

  const engine = openFs1TreeEngine();
  if (!engine) throw new Error('build fs1_tree first');
  const follower = new Fs1TreeFollower({ engine });
  const labels = new Map([[w1, 'w1'], [w2, 'w2'], [w3, 'w3'], [a3, 'a3'], [a4, 'a4']]);
  const rows = [
    '# FS-1 tree over real chain notes. Shared by shear-fs1 src/chain_tree.rs and node/tests/test_fs1_tree.js.',
    '# Written by node/scripts/fs1_tree_vectors.js. w1..w3: node/tests/fixtures/p2p-wedge-blocks.json.',
    '# a3, a4: node/tests/fixtures/fs1-tree-fork-blocks.json, a fork off w2.',
    '# note<TAB>block<TAB>admitPub<TAB>commit<TAB>leaf (O||I||C) or skip',
    '# connect<TAB>block<TAB>height<TAB>id<TAB>parent<TAB>leaves<TAB>root',
    '# disconnect<TAB>block<TAB>id<TAB>leaves<TAB>root',
  ];
  rows.push(`empty_root\t${(await engine.root()).root}`);
  for (const [block, label] of labels) {
    for (const n of fs1NotesFromBlock(block)) {
      const leaf = fs1Leaf(n);
      rows.push(['note', label, hx(n.admitPub), hx(n.commit), leaf ? hx(leaf) : 'skip'].join('\t'));
    }
  }
  const parentOf = (b) => (b.prevHash ? b.prevHash.$hex : b.header.slice(8, 72));
  const connect = async (b) => {
    await follower.connect(b);
    rows.push(['connect', labels.get(b), b.height, b.hash, parentOf(b), follower.leafCount, follower.root].join('\t'));
  };
  const disconnect = async (b) => {
    await follower.disconnect(b);
    rows.push(['disconnect', labels.get(b), b.hash, follower.leafCount, follower.root].join('\t'));
  };
  await connect(w1);
  await connect(w2);
  await connect(w3);
  await disconnect(w3);
  await connect(a3);
  await connect(a4);
  await disconnect(a4);
  await disconnect(a3);
  await connect(w3);
  engine.close();
  fs.writeFileSync(path.join(crate, 'vectors/tree_chain.txt'), `${rows.join('\n')}\n`);
  console.log(`wrote ${rows.length} rows, ${follower.leafCount} leaves, root ${follower.root}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

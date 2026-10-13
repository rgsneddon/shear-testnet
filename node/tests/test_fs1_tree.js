import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FS1_TREE_WIRED,
  Fs1TreeFollower,
  fs1Leaf,
  fs1NotesFromBlock,
  openFs1TreeEngine,
} from '../src/fs1_tree.js';
import { forkBlocks } from '../scripts/fs1_tree_vectors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, '../../crypto/native/vendor/monero-oxide-77788c3');
const VECTORS = path.join(vendor, 'shear-fs1/vectors/tree_chain.txt');
const REQUIRED = process.env.FS1_TREE_REQUIRED === '1';

const rows = fs.readFileSync(VECTORS, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
const real = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/p2p-wedge-blocks.json'), 'utf8')).blocks;
const fork = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/fs1-tree-fork-blocks.json'), 'utf8')).blocks;
const byLabel = new Map([['w1', real[0]], ['w2', real[1]], ['w3', real[2]], ['a3', fork[0]], ['a4', fork[1]]]);
const ops = rows.filter((r) => r[0] === 'connect' || r[0] === 'disconnect');
const hx = (b) => Buffer.from(b).toString('hex');

describe('FS-1 tree follower', () => {
  it('the fork fixture is the one the vector script writes', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(forkBlocks(real[1].hash))), fork);
  });

  it('T-1 and L-1..L-4: block notes and leaves equal the shared vector', () => {
    for (const [label, block] of byLabel) {
      const want = rows.filter((r) => r[0] === 'note' && r[1] === label);
      const notes = fs1NotesFromBlock(block);
      assert.equal(notes.length, want.length, label);
      notes.forEach((n, i) => {
        assert.equal(hx(n.admitPub), want[i][2], label);
        assert.equal(hx(n.commit), want[i][3], label);
        const leaf = fs1Leaf(n);
        assert.equal(leaf ? hx(leaf) : 'skip', want[i][4], label);
      });
    }
  });

  it('lock, vote and keyless outputs are not notes; bad encodings and zero commits take no slot', () => {
    const a3 = rows.filter((r) => r[0] === 'note' && r[1] === 'a3');
    assert.equal(a3.some((r) => r[2] === fork[0].txs[1].vout[0].admitPub.$hex), false);
    assert.equal(a3.some((r) => r[2] === fork[0].txs[2].vout[0].admitPub.$hex), false);
    assert.equal(a3.some((r) => r[3] === fork[0].txs[3].vout[2].commit.$hex), false);
    assert.equal(a3.length, 42);
    assert.deepEqual(a3.filter((r) => r[4] === 'skip').map((r) => [r[2], r[3]]), [
      [fork[0].txs[3].vout[0].admitPub.$hex, '00'.repeat(32)],
      ['ff'.repeat(32), fork[0].txs[3].vout[1].commit.$hex],
      [fork[0].txs[3].vout[3].admitPub.$hex, '00'.repeat(32)],
    ]);
  });

  it('T-3 and T-4: the follower replays the vector ops to the same leaf counts', async () => {
    const f = new Fs1TreeFollower();
    const digests = new Map();
    for (const op of ops) {
      const block = byLabel.get(op[1]);
      if (op[0] === 'connect') await f.connect(block);
      else await f.disconnect(block);
      const count = Number(op[0] === 'connect' ? op[5] : op[3]);
      assert.equal(f.leafCount, count, `${op[0]} ${op[1]}`);
      const prior = digests.get(count);
      if (prior) assert.equal(f.leafDigest(), prior, `${op[0]} ${op[1]}`);
      digests.set(count, f.leafDigest());
    }
  });

  it('T-4: a block that is not on the tip is refused', async () => {
    const f = new Fs1TreeFollower();
    await f.connect(real[0]);
    await assert.rejects(f.connect(real[2]), /fs1_tree_link/);
    await assert.rejects(f.connect(fork[0]), /fs1_tree_link/);
    await assert.rejects(f.disconnect(real[1]), /fs1_tree_link/);
    await f.connect(real[1]);
    await f.connect(fork[0]);
    const all = new Map([...real, ...fork].map((b) => [String(b.hash), b]));
    await f.rewindTo(2, all);
    assert.equal(f.tip.height, 2);
    await f.connect(real[2]);
    assert.equal(f.leafCount, 7);
  });

  it('the follower is not wired into consensus, mempool or store', () => {
    assert.equal(FS1_TREE_WIRED, false);
    for (const name of ['chain.js', 'store.js', 'rpc.js', 'node.js']) {
      const src = fs.readFileSync(path.join(here, '../src', name), 'utf8');
      assert.equal(src.includes('fs1_tree'), false, name);
    }
    const pin = JSON.parse(fs.readFileSync(path.join(vendor, 'ADMIT_PIN.json'), 'utf8'));
    assert.equal(pin.wired, false);
  });
});

describe('FS-1 tree roots from the crate tool', () => {
  let engine = null;
  before(() => {
    engine = openFs1TreeEngine();
    if (REQUIRED) assert.ok(engine, 'fs1_tree is not built; set SHEAR_FS1_TREE_BIN');
  });
  after(() => engine?.close());

  it('roots match the shared vector through a reorg and back', async (t) => {
    if (!engine) return t.skip('fs1_tree not built');
    assert.equal((await engine.root()).root, rows.find((r) => r[0] === 'empty_root')[1]);
    const f = new Fs1TreeFollower({ engine });
    for (const op of ops) {
      const block = byLabel.get(op[1]);
      if (op[0] === 'connect') await f.connect(block);
      else await f.disconnect(block);
      assert.equal(f.root, op[0] === 'connect' ? op[6] : op[4], `${op[0]} ${op[1]}`);
    }
    const final = ops[ops.length - 1];
    const firstW3 = ops.find((r) => r[0] === 'connect' && r[1] === 'w3');
    assert.equal(final[6], firstW3[6]);
  });

  it('the tool refuses an unlinked block', async (t) => {
    if (!engine) return t.skip('fs1_tree not built');
    const fresh = openFs1TreeEngine();
    try {
      const f = new Fs1TreeFollower({ engine: fresh });
      await f.connect(real[0]);
      const id = Buffer.alloc(32, 7);
      await assert.rejects(fresh.connect(5, id, id, []), /fs1_tree_link/);
    } finally {
      fresh.close();
    }
  });
});

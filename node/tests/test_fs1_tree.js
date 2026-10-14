import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  FS1_TREE_BIN_DEFAULT,
  FS1_TREE_MAX_BLOCK_NOTES,
  FS1_TREE_MAX_LINE,
  FS1_TREE_WIRED,
  Fs1TreeFollower,
  fs1Leaf,
  fs1NotesFromBlock,
  fs1TreeBinSha256,
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

const BIN = process.env.SHEAR_FS1_TREE_BIN || FS1_TREE_BIN_DEFAULT;
const BUILT = fs.existsSync(BIN);
// CI passes the hash it computed after the build; a local run pins the binary it finds.
const BIN_SHA = process.env.SHEAR_FS1_TREE_SHA256 || (BUILT ? fs1TreeBinSha256(BIN) : null);
const openReal = () => openFs1TreeEngine({ bin: BIN, sha256: BIN_SHA });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs1-tree-'));
let scripts = 0;
function script(body, mode = 0o755) {
  scripts += 1;
  const file = path.join(tmp, `engine-${scripts}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, mode);
  return file;
}
const pinned = (file) => openFs1TreeEngine({ bin: file, sha256: fs1TreeBinSha256(file) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('FS-1 tree tool pinning', () => {
  it('refuses a tool with no pin, the wrong hash, loose permissions, or a directory', () => {
    const file = script('exit 0');
    assert.throws(() => openFs1TreeEngine({ bin: file, sha256: '' }), /fs1_tree_bin_unpinned/);
    assert.throws(() => openFs1TreeEngine({ bin: file, sha256: 'zz' }), /fs1_tree_bin_unpinned/);
    assert.throws(() => openFs1TreeEngine({ bin: file, sha256: '0'.repeat(64) }), /fs1_tree_bin_hash/);
    const loose = script('exit 0', 0o777);
    fs.chmodSync(loose, 0o777);
    assert.throws(() => pinned(loose), /fs1_tree_bin_writable/);
    assert.throws(() => openFs1TreeEngine({ bin: tmp, sha256: '0'.repeat(64) }), /fs1_tree_bin_not_file/);
    assert.equal(openFs1TreeEngine({ bin: path.join(tmp, 'missing'), sha256: '0'.repeat(64) }), null);
  });

  it('a symlink is checked by what it points at', () => {
    const file = script('exit 0');
    const link = path.join(tmp, 'link');
    fs.symlinkSync(file, link);
    assert.throws(() => openFs1TreeEngine({ bin: link, sha256: '1'.repeat(64) }), /fs1_tree_bin_hash/);
    pinned(link).close();
  });
});

describe('FS-1 tree tool failures reject pending calls', () => {
  it('a tool that exits rejects the call in flight and every later one', async () => {
    const engine = pinned(script('read x\nexit 3'));
    await assert.rejects(engine.root(), /fs1_tree_engine_exit/);
    assert.equal(engine.failed, 'fs1_tree_engine_exit');
    await assert.rejects(engine.root(), /fs1_tree_engine_exit/);
    const gone = pinned(script('exit 0'));
    await assert.rejects(Promise.all([gone.root(), gone.root()]), /fs1_tree_engine_exit/);
  });

  it('a reply line over the cap kills the tool and rejects the call', async () => {
    const engine = pinned(script(`read x\nhead -c ${FS1_TREE_MAX_LINE + 10} /dev/zero | tr '\\000' a\nexec sleep 30`));
    await assert.rejects(engine.root(), /fs1_tree_engine_line/);
    const newline = pinned(script(`read x\nhead -c ${FS1_TREE_MAX_LINE + 10} /dev/zero | tr '\\000' a\necho\nexec sleep 30`));
    await assert.rejects(newline.root(), /fs1_tree_engine_line/);
  });

  it('a line nobody asked for, or a malformed root, fails the tool', async () => {
    const chatty = pinned(script('echo hello\nexec sleep 30'));
    await sleep(300);
    assert.equal(chatty.failed, 'fs1_tree_engine_unsolicited');
    await assert.rejects(chatty.root(), /fs1_tree_engine_unsolicited/);
    const bad = pinned(script('read x\necho "root nothex 0"\nexec sleep 30'));
    await assert.rejects(bad.root(), /fs1_tree_engine_reply/);
    bad.close();
  });

  it('close rejects what is pending', async () => {
    const quiet = pinned(script('exec sleep 30'));
    const pending = quiet.root();
    quiet.close();
    await assert.rejects(pending, /fs1_tree_engine_closed/);
    await assert.rejects(quiet.root(), /fs1_tree_engine_closed/);
  });
});

/** A tool stand-in. It agrees with the follower unless an override says otherwise. */
function fakeEngine(over = {}) {
  const stack = [];
  let count = 0;
  const root = () => String(count).padStart(64, '0');
  const engine = {
    calls: [],
    async connect(height, id, parent, notes) {
      engine.calls.push('connect');
      await sleep(1);
      if (over.connect) return over.connect(notes, { stack, set: (n) => { count = n; } });
      const leaves = notes.map(fs1Leaf);
      stack.push(count);
      count += leaves.filter(Boolean).length;
      return { leaves, count, root: root() };
    },
    async disconnect() {
      engine.calls.push('disconnect');
      if (over.disconnect) return over.disconnect();
      count = stack.pop();
      return { count, root: root() };
    },
  };
  return engine;
}

describe('FS-1 tree follower changes state only after the tool acks', () => {
  it('ops run one at a time, in call order', async () => {
    const f = new Fs1TreeFollower({ engine: fakeEngine() });
    await Promise.all([f.connect(real[0]), f.connect(real[1]), f.connect(real[2])]);
    assert.equal(f.leafCount, 7);
    await Promise.all([f.disconnect(real[2]), f.disconnect(real[1])]);
    assert.equal(f.leafCount, 1);
  });

  it('a leaf mismatch is undone in the tool and leaves the follower as it was', async () => {
    const engine = fakeEngine({ connect: (notes, s) => { s.stack.push(0); s.set(9); return { leaves: notes.map(() => null), count: 9, root: '9'.repeat(64) }; } });
    engine.disconnect = async () => ({ count: 0, root: '0'.repeat(64) });
    const f = new Fs1TreeFollower({ engine });
    await assert.rejects(f.connect(real[0]), /fs1_tree_leaf_mismatch/);
    assert.deepEqual([f.leafCount, f.tip, f.root, f.broken], [0, null, null, false]);
    const right = new Fs1TreeFollower({ engine: fakeEngine() });
    await right.connect(real[0]);
    const wrongCount = fakeEngine({ connect: (notes) => ({ leaves: notes.map(fs1Leaf), count: 5, root: '5'.repeat(64) }) });
    wrongCount.disconnect = async () => ({ count: 0, root: '0'.repeat(64) });
    const g = new Fs1TreeFollower({ engine: wrongCount });
    await assert.rejects(g.connect(real[0]), /fs1_tree_leaf_mismatch/);
    assert.equal(g.leafCount, 0);
  });

  it('a mismatch the tool cannot undo marks the follower desynced until it is rebuilt', async () => {
    const engine = fakeEngine({ connect: (notes) => ({ leaves: notes.map(() => null), count: 0, root: '0'.repeat(64) }) });
    engine.disconnect = async () => { throw new Error('fs1_tree_link'); };
    const f = new Fs1TreeFollower({ engine });
    await assert.rejects(f.connect(real[0]), /fs1_tree_desync/);
    assert.equal(f.broken, true);
    assert.equal(f.leafCount, 0);
    await assert.rejects(f.connect(real[0]), /fs1_tree_desync/);
    await assert.rejects(f.disconnect(real[0]), /fs1_tree_desync/);
    const rebuilt = await Fs1TreeFollower.rebuild({ engine: fakeEngine(), blocks: real });
    assert.equal(rebuilt.leafCount, 7);
  });

  it('a dead tool or a link refusal desyncs; a clean refusal does not', async () => {
    for (const why of ['fs1_tree_engine_exit', 'fs1_tree_link', 'fs1_tree_engine_reply']) {
      const f = new Fs1TreeFollower({ engine: fakeEngine({ connect: () => { throw new Error(why); } }) });
      await assert.rejects(f.connect(real[0]), /fs1_tree_desync/, why);
      assert.equal(f.leafCount, 0, why);
    }
    for (const why of ['fs1_tree_full', 'fs1_tree_tree']) {
      const f = new Fs1TreeFollower({ engine: fakeEngine({ connect: () => { throw new Error(why); } }) });
      await assert.rejects(f.connect(real[0]), new RegExp(why));
      assert.deepEqual([f.leafCount, f.broken], [0, false], why);
    }
  });

  it('a disconnect the tool refuses or miscounts keeps the tip and desyncs', async () => {
    for (const disconnect of [async () => { throw new Error('fs1_tree_engine_exit'); }, async () => ({ count: 3, root: '3'.repeat(64) })]) {
      const engine = fakeEngine();
      const f = new Fs1TreeFollower({ engine });
      await f.connect(real[0]);
      engine.disconnect = disconnect;
      await assert.rejects(f.disconnect(real[0]), /fs1_tree_desync/);
      assert.deepEqual([f.leafCount, f.tip.height], [1, 1]);
    }
  });

  it('a block over the note cap is refused before the tool sees it', async () => {
    const engine = fakeEngine();
    const f = new Fs1TreeFollower({ engine });
    const one = real[0].txs.flatMap((tx) => tx.vout.map((o) => ({ tx, o }))).find(({ tx, o }) => o.admitPub && fs1NotesFromBlock({ txs: [{ ...tx, vout: [o] }] }).length);
    const big = { ...real[0], txs: [{ ...one.tx, vout: Array(FS1_TREE_MAX_BLOCK_NOTES + 1).fill(one.o) }] };
    await assert.rejects(f.connect(big), /fs1_tree_count_cap/);
    assert.deepEqual([engine.calls, f.broken], [[], false]);
  });
});

describe('FS-1 tree roots from the crate tool', () => {
  let engine = null;
  before(() => {
    if (REQUIRED) assert.ok(BUILT, 'fs1_tree is not built; set SHEAR_FS1_TREE_BIN');
    engine = BUILT ? openReal() : null;
  });
  after(() => {
    engine?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

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

  it('the tool refuses an unlinked block and a count over the cap, then keeps serving', async (t) => {
    if (!engine) return t.skip('fs1_tree not built');
    const fresh = openReal();
    try {
      const f = new Fs1TreeFollower({ engine: fresh });
      await f.connect(real[0]);
      const id = Buffer.alloc(32, 7);
      await assert.rejects(fresh.connect(5, id, id, []), /fs1_tree_link/);
      const note = fs1NotesFromBlock(real[0])[0];
      await assert.rejects(fresh.connect(2, id, f.tip.id, Array(FS1_TREE_MAX_BLOCK_NOTES + 1).fill(note)), /fs1_tree_count_cap/);
      assert.deepEqual([(await fresh.root()).count, fresh.failed], [1, null]);
      await f.connect(real[1]);
      assert.equal(f.root, ops.find((r) => r[0] === 'connect' && r[1] === 'w2')[6]);
    } finally {
      fresh.close();
    }
  });
});

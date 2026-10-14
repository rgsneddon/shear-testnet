// FS-1 tree follower. Mirrors shear-fs1 src/chain_tree.rs.
// The leaf map lives in crypto/fs1_leaf.js, the same predicate as src/leaf.rs,
// and consensus (N-1) calls that predicate. This module is still not on the
// accept path: no mempool or store import follows the Selene root.
//
// T-1. The leaf set is every output that joins the admit set (outputJoinsAdmitSet),
//      in block, transaction and output order. A missing or short field reads as
//      32 zero bytes. L-3 then drops it.
// L-1. O = E(admitPub), C = E(commit). E decodes Ristretto255 and keeps the
//      prime-order part of the Edwards representative: E(P) = 8^-1 * (8 * P).
// L-2. I = E(Hp(admitPub)), Hp = ristretto255 hash-to-curve with DST shear-admit-Hp.
// L-3. A note whose admitPub, commit, or Hp(admitPub) does not decode, or decodes
//      to the identity, takes no slot.
// L-4. A leaf is O || I || C, 96 bytes of compressed Ed25519 points.
// T-4. A block connects only on the tip (height + 1, parent = tip id). Only the
//      tip disconnects.
//
// The Selene/Helios root comes from the crate's fs1_tree tool. The follower
// checks that tool's leaves against its own for every block.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputJoinsAdmitSet } from '../../crypto/admit.js';
import {
  FS1_HP_DST,
  FS1_LEAF_BYTES,
  bytesOf,
  fs1Leaf,
  fs1OutputNote,
  ristrettoToEd,
} from '../../crypto/fs1_leaf.js';

export const FS1_TREE_WIRED = false;
export { FS1_HP_DST, FS1_LEAF_BYTES, bytesOf, fs1Leaf, fs1OutputNote, ristrettoToEd };

const here = path.dirname(fileURLToPath(import.meta.url));
export const FS1_TREE_BIN_DEFAULT = path.join(
  here, '../../crypto/native/vendor/monero-oxide-77788c3/target/release/fs1_tree',
);

/** T-1. The notes one block adds, in admit-set order. */
export function fs1NotesFromBlock(block) {
  const notes = [];
  for (const tx of block?.txs || []) {
    for (const o of tx?.vout || []) {
      if (!outputJoinsAdmitSet(tx, o)) continue;
      notes.push(fs1OutputNote(o));
    }
  }
  return notes;
}

function blockId(block) {
  const id = bytesOf(block?.hash);
  if (!id || id.length !== 32) throw new Error('fs1_tree_block_id');
  return Buffer.from(id);
}

/** The parent id: `prevHash` or `prev` when present, else header bytes 4..36. */
export function blockParent(block) {
  for (const v of [block?.prevHash, block?.prev]) {
    const b = bytesOf(v);
    if (b && b.length === 32) return Buffer.from(b);
  }
  const header = bytesOf(block?.header);
  if (header && header.length >= 36) return Buffer.from(header.subarray(4, 36));
  throw new Error('fs1_tree_block_parent');
}

/** Most notes one connect may carry. Matches shear-fs1 tree_cli::MAX_BLOCK_NOTES. */
export const FS1_TREE_MAX_BLOCK_NOTES = 65_536;
/** Longest reply line read from the tool. Its longest real line is 197 bytes. */
export const FS1_TREE_MAX_LINE = 1024;

/** sha256 of a file, hex. */
export function fs1TreeBinSha256(bin) {
  return createHash('sha256').update(fs.readFileSync(bin)).digest('hex');
}

/**
 * Resolve and check the tool before it runs: a regular file, not writable by
 * group or others, whose sha256 is `sha256`. Returns the resolved path.
 */
export function verifyFs1TreeBin(bin, sha256) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) throw new Error('fs1_tree_bin_unpinned');
  const real = fs.realpathSync(path.resolve(bin));
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('fs1_tree_bin_not_file');
  if (st.mode & 0o022) throw new Error('fs1_tree_bin_writable');
  if (fs1TreeBinSha256(real) !== sha256) throw new Error('fs1_tree_bin_hash');
  return real;
}

/**
 * The crate's fs1_tree line tool, or null when no binary is at `bin`.
 *
 * The binary must match the pinned `sha256` (or SHEAR_FS1_TREE_SHA256); any
 * other program is refused. Every pending request is rejected when the tool
 * exits, errors, sends a line longer than FS1_TREE_MAX_LINE, or sends a line
 * no request asked for. After that every request is rejected.
 */
export function openFs1TreeEngine({
  bin = process.env.SHEAR_FS1_TREE_BIN || FS1_TREE_BIN_DEFAULT,
  sha256 = process.env.SHEAR_FS1_TREE_SHA256,
} = {}) {
  if (!bin || !fs.existsSync(bin)) return null;
  const real = verifyFs1TreeBin(bin, sha256);
  const child = spawn(real, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = [];
  let current = [];
  let pending = '';
  let dead = null;

  function fail(reason) {
    if (dead) return;
    dead = new Error(reason);
    for (const w of waiting.splice(0)) w.reject(dead);
    current = [];
    pending = '';
    child.stdout.removeAllListeners('data');
    child.kill('SIGKILL');
  }

  function onLine(line) {
    if (!waiting.length) return fail('fs1_tree_engine_unsolicited');
    current.push(line);
    if (current.length > FS1_TREE_MAX_BLOCK_NOTES + 8) return fail('fs1_tree_engine_reply');
    if (line.startsWith('root ') || line.startsWith('error ')) {
      const done = current;
      current = [];
      waiting.shift().resolve(done);
    }
    return undefined;
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let at;
    while (!dead && (at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.length > FS1_TREE_MAX_LINE) return fail('fs1_tree_engine_line');
      onLine(line);
    }
    if (pending.length > FS1_TREE_MAX_LINE) fail('fs1_tree_engine_line');
    return undefined;
  });
  child.on('exit', () => fail('fs1_tree_engine_exit'));
  child.on('error', () => fail('fs1_tree_engine_exit'));
  child.stdin.on('error', () => fail('fs1_tree_engine_exit'));

  function request(text) {
    if (dead) return Promise.reject(dead);
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      child.stdin.write(`${text}\n`);
    });
  }
  function reply(out) {
    const last = out[out.length - 1].split(' ');
    if (last[0] === 'error') throw new Error(`fs1_tree_${last[1]}`);
    const count = Number(last[2]);
    if (!/^[0-9a-f]{64}$/.test(last[1] || '') || !Number.isSafeInteger(count)) throw new Error('fs1_tree_engine_reply');
    return { lines: out.slice(0, -1), root: last[1], count };
  }
  return {
    async connect(height, id, parent, notes) {
      if (notes.length > FS1_TREE_MAX_BLOCK_NOTES) throw new Error('fs1_tree_count_cap');
      const body = notes.map((n) => `${n.admitPub.toString('hex')} ${n.commit.toString('hex')}`);
      const out = reply(await request([`connect ${height} ${id.toString('hex')} ${parent.toString('hex')} ${notes.length}`, ...body].join('\n')));
      if (out.lines.length !== notes.length) throw new Error('fs1_tree_engine_reply');
      const leaves = out.lines.map((l) => {
        if (l === 'skip') return null;
        if (!/^leaf [0-9a-f]{192}$/.test(l)) throw new Error('fs1_tree_engine_reply');
        return Buffer.from(l.slice(5), 'hex');
      });
      return { ...out, leaves };
    },
    async disconnect(id) {
      return reply(await request(`disconnect ${id.toString('hex')}`));
    },
    async root() {
      return reply(await request('root'));
    },
    /** Why the tool is unusable, or null. */
    get failed() {
      return dead ? dead.message : null;
    },
    close() {
      if (!dead) {
        dead = new Error('fs1_tree_engine_closed');
        for (const w of waiting.splice(0)) w.reject(dead);
      }
      child.stdin.end();
      child.kill();
    },
  };
}

/**
 * Follows one chain's blocks and keeps the FS-1 leaf set, reorg-safe.
 *
 * Operations run one at a time. Local state changes only after the tool has
 * acknowledged the same change. If the tool's leaves disagree with ours, the
 * block is disconnected from the tool again and the connect is refused. If the
 * two can no longer be shown to agree, the follower refuses every further
 * operation with fs1_tree_desync and must be replaced, for example with
 * Fs1TreeFollower.rebuild over the current chain and a fresh tool.
 */
export class Fs1TreeFollower {
  constructor({ engine = null } = {}) {
    this.engine = engine;
    this.leaves = [];
    this.blocks = [];
    this.root = null;
    this.broken = false;
    this.queue = Promise.resolve();
  }

  /** A new follower over `blocks`, oldest first. */
  static async rebuild({ engine = null, blocks = [] } = {}) {
    const f = new Fs1TreeFollower({ engine });
    for (const block of blocks) await f.connect(block);
    return f;
  }

  get tip() {
    return this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
  }

  get leafCount() {
    return this.leaves.length;
  }

  run(op) {
    const next = this.queue.then(() => {
      if (this.broken) throw new Error('fs1_tree_desync');
      return op();
    });
    this.queue = next.catch(() => {});
    return next;
  }

  desync() {
    this.broken = true;
    return new Error('fs1_tree_desync');
  }

  /**
   * The tool's reply to a request. A clean refusal (`full`, `tree`) left the
   * tool unchanged, and so is ours. Anything else, a link refusal on a block we
   * linked, a dead tool or a bad reply, leaves the two unknown to agree.
   */
  async ack(request) {
    try {
      return await request;
    } catch (err) {
      if (err?.message === 'fs1_tree_full' || err?.message === 'fs1_tree_tree') throw err;
      throw this.desync();
    }
  }

  /** sha256 over the leaf count and every leaf, in order. */
  leafDigest() {
    const h = createHash('sha256');
    const n = Buffer.alloc(8);
    n.writeBigUInt64LE(BigInt(this.leaves.length));
    h.update(n);
    for (const leaf of this.leaves) h.update(leaf);
    return h.digest('hex');
  }

  /** T-4 and T-1. Returns one leaf (or null) per note. */
  connect(block) {
    return this.run(() => this.connectNow(block));
  }

  async connectNow(block) {
    const height = Number(block?.height);
    if (!Number.isSafeInteger(height) || height < 0) throw new Error('fs1_tree_height');
    const id = blockId(block);
    const parent = blockParent(block);
    const tip = this.tip;
    if (tip && (height !== tip.height + 1 || !parent.equals(tip.id))) throw new Error('fs1_tree_link');
    const notes = fs1NotesFromBlock(block);
    if (notes.length > FS1_TREE_MAX_BLOCK_NOTES) throw new Error('fs1_tree_count_cap');
    const leaves = notes.map(fs1Leaf);
    const kept = leaves.filter(Boolean);
    let root = this.root;
    if (this.engine) {
      const out = await this.ack(this.engine.connect(height, id, parent, notes));
      const agree = out.leaves.length === leaves.length
        && out.count === this.leaves.length + kept.length
        && leaves.every((a, i) => {
          const b = out.leaves[i];
          return a == null ? b == null : b != null && a.equals(b);
        });
      if (!agree) {
        const undone = await this.engine.disconnect(id).catch(() => null);
        if (!undone || undone.count !== this.leaves.length || (this.root != null && undone.root !== this.root)) throw this.desync();
        throw new Error('fs1_tree_leaf_mismatch');
      }
      root = out.root;
    }
    this.blocks.push({ height, id, start: this.leaves.length });
    for (const leaf of kept) this.leaves.push(leaf);
    this.root = root;
    return leaves;
  }

  /** T-4. Disconnect the tip, which must be `block`. */
  disconnect(block) {
    return this.run(() => this.disconnectNow(block));
  }

  async disconnectNow(block) {
    const tip = this.tip;
    if (!tip || !blockId(block).equals(tip.id)) throw new Error('fs1_tree_link');
    let root = this.root;
    if (this.engine) {
      const out = await this.ack(this.engine.disconnect(tip.id));
      if (out.count !== tip.start) throw this.desync();
      root = out.root;
    }
    this.leaves.length = tip.start;
    this.blocks.pop();
    this.root = root;
    return tip;
  }

  /** Disconnect blocks above `height`, newest first, as a reorg does before it connects the new branch. */
  async rewindTo(height, blocksById) {
    while (this.tip && this.tip.height > height) {
      const block = blocksById.get(this.tip.id.toString('hex'));
      if (!block) throw new Error('fs1_tree_missing_block');
      await this.disconnect(block);
    }
  }
}

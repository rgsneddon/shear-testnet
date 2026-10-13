// FS-1 tree follower. Mirrors shear-fs1 src/leaf.rs and src/chain_tree.rs;
// shear-fs1/vectors/tree_chain.txt is checked against both.
//
// Not wired: no consensus, mempool or store path imports this module.
//
// T-1. The leaf set is every output that joins the admit set (outputJoinsAdmitSet),
//      in block, transaction and output order. A missing commit reads as 32 zero
//      bytes, as crypto/admit.js records it, and a field that is not 32 bytes does
//      too. L-3 then drops it.
// L-1. O = E(admitPub), C = E(commit). E decodes Ristretto255 and keeps the
//      prime-order part of the Edwards representative: E(P) = 8^-1 * (8 * P).
// L-2. I = E(Hp(admitPub)), Hp = ristretto255 hash-to-curve with DST shear-admit-Hp.
// L-3. A note whose admitPub or commit does not decode, or decodes to the identity,
//      takes no slot.
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
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RistrettoPoint, ristretto255_hasher, ed25519 } from '@noble/curves/ed25519.js';
import { outputJoinsAdmitSet } from '../../crypto/admit.js';

export const FS1_TREE_WIRED = false;
export const FS1_LEAF_BYTES = 96;
export const FS1_HP_DST = 'shear-admit-Hp';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FS1_TREE_BIN_DEFAULT = path.join(
  here, '../../crypto/native/vendor/monero-oxide-77788c3/target/release/fs1_tree',
);

const ORDER = ed25519.CURVE.n;
const ZERO32 = Buffer.alloc(32);

function modPow(b, e, m) {
  let r = 1n;
  let x = b % m;
  let k = e;
  while (k > 0n) {
    if (k & 1n) r = (r * x) % m;
    x = (x * x) % m;
    k >>= 1n;
  }
  return r;
}

const INV8 = modPow(8n, ORDER - 2n, ORDER);

/** Any of the chain's byte encodings: Buffer, Uint8Array, {$hex}, hex string, or a point. */
export function bytesOf(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return /^([0-9a-f]{2})*$/i.test(v) ? Buffer.from(v, 'hex') : null;
  if (typeof v.$hex === 'string') return bytesOf(v.$hex);
  if (typeof v.toBytes === 'function') return Buffer.from(v.toBytes());
  if (typeof v.toRawBytes === 'function') return Buffer.from(v.toRawBytes());
  return null;
}

function field32(v) {
  const b = bytesOf(v);
  return b && b.length === 32 ? Buffer.from(b) : Buffer.from(ZERO32);
}

/** T-1. The notes one block adds, in admit-set order. */
export function fs1NotesFromBlock(block) {
  const notes = [];
  for (const tx of block?.txs || []) {
    for (const o of tx?.vout || []) {
      if (!outputJoinsAdmitSet(tx, o)) continue;
      notes.push({ admitPub: field32(o.admitPub), commit: field32(o.commit) });
    }
  }
  return notes;
}

/** L-1. E, or null when the bytes are not a canonical Ristretto255 encoding. */
export function ristrettoToEd(bytes) {
  let p;
  try {
    p = RistrettoPoint.fromHex(Buffer.from(bytes).toString('hex'));
  } catch {
    return null;
  }
  if (p.equals(RistrettoPoint.ZERO)) return ed25519.Point.ZERO;
  return p.ep.multiply(8n).multiply(INV8);
}

/** L-1 to L-4. The 96-byte leaf for one note, or null when L-3 drops it. */
export function fs1Leaf(note) {
  const o = ristrettoToEd(note.admitPub);
  const c = ristrettoToEd(note.commit);
  if (!o || !c || o.is0() || c.is0()) return null;
  const hp = ristretto255_hasher.hashToCurve(new Uint8Array(note.admitPub), { DST: FS1_HP_DST });
  const i = ristrettoToEd(hp.toRawBytes());
  if (!i || i.is0()) return null;
  return Buffer.concat([o.toRawBytes(), i.toRawBytes(), c.toRawBytes()]);
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

/** The crate's fs1_tree line tool, or null when it is not built. */
export function openFs1TreeEngine(bin = process.env.SHEAR_FS1_TREE_BIN || FS1_TREE_BIN_DEFAULT) {
  if (!bin || !fs.existsSync(bin)) return null;
  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = [];
  let current = [];
  lines.on('line', (line) => {
    current.push(line);
    if (line.startsWith('root ') || line.startsWith('error ')) {
      const done = current;
      current = [];
      const next = waiting.shift();
      if (next) next(done);
    }
  });
  function request(text) {
    return new Promise((resolve) => {
      waiting.push(resolve);
      child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
    });
  }
  function reply(out) {
    const last = out[out.length - 1].split(' ');
    if (last[0] === 'error') throw new Error(`fs1_tree_${last[1]}`);
    return { lines: out.slice(0, -1), root: last[1], count: Number(last[2]) };
  }
  return {
    async connect(height, id, parent, notes) {
      const body = notes.map((n) => `${n.admitPub.toString('hex')} ${n.commit.toString('hex')}`);
      const out = reply(await request([`connect ${height} ${id.toString('hex')} ${parent.toString('hex')} ${notes.length}`, ...body].join('\n')));
      return { ...out, leaves: out.lines.map((l) => (l === 'skip' ? null : Buffer.from(l.slice(5), 'hex'))) };
    },
    async disconnect(id) {
      return reply(await request(`disconnect ${id.toString('hex')}`));
    },
    async root() {
      return reply(await request('root'));
    },
    close() {
      child.stdin.end();
      lines.close();
    },
  };
}

/** Follows one chain's blocks and keeps the FS-1 leaf set, reorg-safe. */
export class Fs1TreeFollower {
  constructor({ engine = null } = {}) {
    this.engine = engine;
    this.leaves = [];
    this.blocks = [];
    this.root = null;
  }

  get tip() {
    return this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
  }

  get leafCount() {
    return this.leaves.length;
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
  async connect(block) {
    const height = Number(block?.height);
    if (!Number.isSafeInteger(height) || height < 0) throw new Error('fs1_tree_height');
    const id = blockId(block);
    const parent = blockParent(block);
    const tip = this.tip;
    if (tip && (height !== tip.height + 1 || !parent.equals(tip.id))) throw new Error('fs1_tree_link');
    const notes = fs1NotesFromBlock(block);
    const leaves = notes.map(fs1Leaf);
    if (this.engine) {
      const out = await this.engine.connect(height, id, parent, notes);
      if (out.leaves.length !== leaves.length) throw new Error('fs1_tree_leaf_mismatch');
      for (let i = 0; i < leaves.length; i += 1) {
        const a = leaves[i];
        const b = out.leaves[i];
        if ((a == null) !== (b == null) || (a && !a.equals(b))) throw new Error('fs1_tree_leaf_mismatch');
      }
      this.root = out.root;
    }
    this.blocks.push({ height, id, start: this.leaves.length });
    for (const leaf of leaves) if (leaf) this.leaves.push(leaf);
    if (this.engine && this.leaves.length !== (await this.engine.root()).count) throw new Error('fs1_tree_count');
    return leaves;
  }

  /** T-4. Disconnect the tip, which must be `block`. */
  async disconnect(block) {
    const tip = this.tip;
    if (!tip || !blockId(block).equals(tip.id)) throw new Error('fs1_tree_link');
    if (this.engine) this.root = (await this.engine.disconnect(tip.id)).root;
    this.leaves.length = tip.start;
    this.blocks.pop();
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

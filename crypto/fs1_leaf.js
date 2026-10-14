// FS-1 leaf predicate. The same map as shear-fs1 src/leaf.rs (L-1..L-4),
// including the Hp(admitPub) decode. node/src/fs1_tree.js re-exports it.
// Consensus accepts an admit-set output only when fs1Leaf returns bytes.

import { RistrettoPoint, ristretto255_hasher, ed25519 } from '@noble/curves/ed25519.js';

export const FS1_LEAF_BYTES = 96;
export const FS1_HP_DST = 'shear-admit-Hp';

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

export function field32(v) {
  const b = bytesOf(v);
  return b && b.length === 32 ? Buffer.from(b) : Buffer.from(ZERO32);
}

/** The two fields L-3 reads. A missing or short field is 32 zero bytes. */
export function fs1OutputNote(o) {
  return { admitPub: field32(o?.admitPub), commit: field32(o?.commit) };
}

/** L-1. E, or null when the bytes are not a canonical Ristretto255 encoding.
 *  admitPub and commit are public chain data, so the cofactor clear is variable-time. */
export function ristrettoToEd(bytes) {
  let p;
  try {
    p = RistrettoPoint.fromHex(Buffer.from(bytes).toString('hex'));
  } catch {
    return null;
  }
  if (p.equals(RistrettoPoint.ZERO)) return ed25519.Point.ZERO;
  return p.ep.multiplyUnsafe(8n).multiplyUnsafe(INV8);
}

/**
 * L-1 to L-4. The 96-byte leaf, or null when the note takes no slot.
 * O and C must decode to non-identity points, and so must I = E(Hp(admitPub)).
 */
export function fs1Leaf(note) {
  leafDerives += 1;
  const o = ristrettoToEd(note.admitPub);
  const c = ristrettoToEd(note.commit);
  if (!o || !c || o.is0() || c.is0()) return null;
  const hp = ristretto255_hasher.hashToCurve(new Uint8Array(note.admitPub), { DST: FS1_HP_DST });
  const i = ristrettoToEd(hp.toRawBytes());
  if (!i || i.is0()) return null;
  return Buffer.concat([o.toRawBytes(), i.toRawBytes(), c.toRawBytes()]);
}

let leafDerives = 0;

/** How many times the predicate actually ran. Cache hits do not count. */
export function fs1LeafDeriveCount() {
  return leafDerives;
}

export function resetFs1LeafDerives() {
  leafDerives = 0;
}

const leafByOutput = new WeakMap();

/**
 * The leaf for this output object. The first call derives it. Later calls
 * on the same object, including the other accept-path checks, reuse it.
 * A miss is null and is cached too.
 */
export function fs1LeafFor(output) {
  if (output && typeof output === 'object' && leafByOutput.has(output)) {
    return leafByOutput.get(output);
  }
  const leaf = fs1Leaf(fs1OutputNote(output));
  if (output && typeof output === 'object') leafByOutput.set(output, leaf);
  return leaf;
}

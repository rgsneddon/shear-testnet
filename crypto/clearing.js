/**
 * Dual-tree clearing: continuity_root = H(rootA || rootB).
 * A = one leaf per hasher {dest20, count}. B = opt-in per-hash extras.
 * B spends only after the committing block; proof against that header.
 */
import { sha256 } from './shear_hash.js';
import { merkleRoot, merkleProof, merkleVerify } from './merkle.js';
import { packALeaf, packBLeaf, packDigest } from './pack.js';
import { decodeHeader } from './header.js';
import { SPENDABLE_CONFIRMATIONS } from './asert.js';

export function aLeafBytes({ dest20, count }) {
  return packDigest(packALeaf({ dest20, count }));
}

export function bLeafBytes({ dest20, unit, nonce, memoH, tag }) {
  return packDigest(packBLeaf({ dest20, unit, nonce, memoH, tag }));
}

export function dualContinuityRoot(rootA, rootB) {
  return sha256(Buffer.concat([Buffer.from(rootA), Buffer.from(rootB)]));
}

export function buildDualTree({ aLeaves = [], bLeaves = [] } = {}) {
  const aDigests = aLeaves.map((l) => aLeafBytes(l));
  const bDigests = bLeaves.map((l) => bLeafBytes(l));
  const rootA = merkleRoot(aDigests);
  const rootB = merkleRoot(bDigests);
  return {
    rootA,
    rootB,
    continuityRoot: dualContinuityRoot(rootA, rootB),
    aDigests,
    bDigests,
  };
}

export function bLeafId(leaf, height, index) {
  const d = bLeafBytes(leaf);
  return `${Number(height) || 0}:${Number(index) || 0}:${d.toString('hex')}`;
}

/**
 * Spend a B unit after the committing block has consensus depth
 * (SPENDABLE_CONFIRMATIONS). Proof is merkle of the B digest in tree B.
 */
export function spendB({
  leaf,
  proof,
  header,
  rootA,
  rootB,
  height,
  index,
  tipHeight,
  spent,
} = {}) {
  if (!header) return { ok: false, reason: 'no_header' };
  let decoded;
  try {
    decoded = decodeHeader(Buffer.from(header));
  } catch {
    return { ok: false, reason: 'bad_header' };
  }
  const a = Buffer.from(rootA || Buffer.alloc(32));
  const b = Buffer.from(rootB || Buffer.alloc(32));
  if (!dualContinuityRoot(a, b).equals(decoded.continuityRoot)) {
    return { ok: false, reason: 'continuity' };
  }
  const h = Number(height) || 0;
  const tip = Number(tipHeight) || 0;
  if (!(h >= 1) || tip < h) return { ok: false, reason: 'pre_seal' };
  if (tip - h + 1 < SPENDABLE_CONFIRMATIONS) return { ok: false, reason: 'immature' };
  const digest = bLeafBytes(leaf);
  if (!merkleVerify(digest, proof, b)) return { ok: false, reason: 'proof' };
  const id = bLeafId(leaf, h, index);
  const book = spent instanceof Set ? spent : new Set(spent || []);
  if (book.has(id)) return { ok: false, reason: 'double_open' };
  book.add(id);
  return { ok: true, id, dest20: leaf.dest20, unit: leaf.unit, spent: book };
}

export function bProof(bLeaves, index) {
  const digests = (bLeaves || []).map((l) => bLeafBytes(l));
  return merkleProof(digests, index);
}

import { sha256 } from './shear_hash.js';

export const EMPTY_ROOT = sha256(Buffer.from('shear-empty-root-v1'));

function asLeaf(l) {
  const b = Buffer.from(l);
  return b.length === 32 ? b : sha256(b);
}

export function merkleRoot(leaves) {
  const list = Array.isArray(leaves) ? leaves.map((l) => Buffer.from(l)) : [];
  if (!list.length) return Buffer.from(EMPTY_ROOT);
  let layer = list.map(asLeaf);
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = layer[i + 1] || a;
      next.push(sha256(Buffer.concat([a, b])));
    }
    layer = next;
  }
  return layer[0];
}

export function merkleProof(leaves, index) {
  const list = Array.isArray(leaves) ? leaves.map(asLeaf) : [];
  let idx = Math.floor(Number(index));
  if (!list.length || idx < 0 || idx >= list.length) return [];
  let layer = list;
  const proof = [];
  while (layer.length > 1) {
    const pair = idx ^ 1;
    const sibling = layer[pair] || layer[idx];
    proof.push({ side: idx % 2 === 0 ? 'R' : 'L', hash: Buffer.from(sibling).toString('hex') });
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = layer[i + 1] || a;
      next.push(sha256(Buffer.concat([a, b])));
    }
    layer = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function merkleVerify(leaf, proof, root) {
  let h = asLeaf(leaf);
  const steps = Array.isArray(proof) ? proof : [];
  for (const step of steps) {
    const sib = Buffer.from(String(step.hash || ''), 'hex');
    if (sib.length !== 32) return false;
    h = step.side === 'L' ? sha256(Buffer.concat([sib, h])) : sha256(Buffer.concat([h, sib]));
  }
  return h.equals(Buffer.from(root));
}

export function sampleLeaf({ nonce, tag, nanos = 1 }) {
  return sha256(Buffer.from(JSON.stringify({
    nonce: String(nonce),
    tag: String(tag),
    nanos: Number(nanos) || 1,
  })));
}

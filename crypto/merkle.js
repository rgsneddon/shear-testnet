import { sha256 } from './shear_hash.js';

export const EMPTY_ROOT = sha256(Buffer.from('shear-empty-root-v1'));

export function merkleRoot(leaves) {
  const list = Array.isArray(leaves) ? leaves.map((l) => Buffer.from(l)) : [];
  if (!list.length) return Buffer.from(EMPTY_ROOT);
  let layer = list.map((l) => (l.length === 32 ? l : sha256(l)));
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

export function sampleLeaf({ nonce, tag, nanos = 1 }) {
  return sha256(Buffer.from(JSON.stringify({
    nonce: String(nonce),
    tag: String(tag),
    nanos: Number(nanos) || 1,
  })));
}

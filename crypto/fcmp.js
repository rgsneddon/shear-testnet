/**
 * Full-chain membership (FCMP-class) for shear-testnet-v3.
 * Eligible set is every provided note spend-point (the whole chain set).
 * Linkable ring (LSAG) + key image. Sampled n=16 rings are invalid.
 * A later drop-in may replace LSAG with a curve-tree proof; the set stays full-chain.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { RistrettoPoint, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { hashToScalar, randomScalar, scalarBytes, scalarFrom, pointBytes, pointFrom, G } from './note.js';
import { merkleRoot } from './merkle.js';

const Point = RistrettoPoint;
const Fn = Point.Fn;
const DST = Buffer.from('shear-fcmp-v1');

function Hp(P) {
  return ristretto255_hasher.hashToCurve(pointBytes(P), { DST: 'shear-fcmp-Hp' });
}

export function fcmpPub(x) {
  return G.multiply(x);
}

export function keyImage(x, P) {
  return Hp(P).multiply(x);
}

export function fcmpRoot(pubs) {
  const leaves = (pubs || []).map((p) => Buffer.from(sha256(pointBytes(p instanceof Uint8Array || Buffer.isBuffer(p) ? pointFrom(p) : p))));
  return merkleRoot(leaves);
}

/**
 * LSAG over the full eligible pub set. index is the real spend.
 * Consensus must pass the complete unspent set — not a decoy sample.
 */
export function proveFcmp({ x, index, pubs }) {
  const n = pubs.length;
  if (!n) throw new Error('empty_set');
  if (index < 0 || index >= n) throw new Error('index');
  const ring = pubs.map((p) => (typeof p.toBytes === 'function' ? p : pointFrom(p)));
  const P = ring[index];
  const I = keyImage(x, P);
  const Ibytes = pointBytes(I);
  const c = new Array(n);
  const r = new Array(n);
  const alpha = randomScalar();
  const Lj = G.multiply(alpha);
  const Rj = Hp(P).multiply(alpha);
  c[(index + 1) % n] = hashToScalar(Ibytes, pointBytes(Lj), pointBytes(Rj), DST);
  for (let i = (index + 1) % n; i !== index; i = (i + 1) % n) {
    r[i] = randomScalar();
    const L = G.multiply(r[i]).add(ring[i].multiply(c[i]));
    const Rpt = Hp(ring[i]).multiply(r[i]).add(I.multiply(c[i]));
    c[(i + 1) % n] = hashToScalar(Ibytes, pointBytes(L), pointBytes(Rpt), DST);
  }
  r[index] = Fn.sub(alpha, Fn.mul(c[index], x));
  return {
    keyImage: Ibytes,
    c0: scalarBytes(c[0]),
    r: r.map(scalarBytes),
  };
}

export function verifyFcmp(proof, pubs) {
  try {
    const n = pubs.length;
    if (!n || !proof?.r || proof.r.length !== n) return false;
    const ring = pubs.map((p) => (typeof p.toBytes === 'function' ? p : pointFrom(p)));
    const I = pointFrom(proof.keyImage);
    if (I.equals(Point.ZERO)) return false;
    let c = scalarFrom(proof.c0);
    for (let i = 0; i < n; i += 1) {
      const ri = scalarFrom(proof.r[i]);
      const L = G.multiply(ri).add(ring[i].multiply(c));
      const R = Hp(ring[i]).multiply(ri).add(I.multiply(c));
      c = hashToScalar(proof.keyImage, pointBytes(L), pointBytes(R), DST);
    }
    return Fn.eql(c, scalarFrom(proof.c0));
  } catch {
    return false;
  }
}

/**
 * Admit v1 — Shear admittance proofs (module shear-admit).
 * Proves a spend is an admissible extraction from the committed current J
 * (the fluxset) without revealing which flowline carried it.
 *
 * Day-one statement uses a linkable ring over the full fluxset (not a
 * sampled n=16 decoy list). A later AdmitV2 may replace the ring with a
 * Curve Trees accumulator (Campanelli, Hall-Andersen, Kamp, USENIX
 * Security 23 / ePrint 2022/756) without changing the fluxset.
 *
 * Consensus type: AdmitV1. Fingerprint: ADMIT=AdmitV1.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { RistrettoPoint, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { hashToScalar, randomScalar, scalarBytes, scalarFrom, pointBytes, pointFrom, G } from './note.js';
import { merkleRoot } from './merkle.js';

const Point = RistrettoPoint;
const Fn = Point.Fn;
const DST = Buffer.from('shear-admit-v1');

function Hp(P) {
  return ristretto255_hasher.hashToCurve(pointBytes(P), { DST: 'shear-admit-Hp' });
}

export function admitPub(x) {
  return G.multiply(x);
}

/** Spend-tag (Shear native linkability). */
export function spendTag(x, P) {
  return Hp(P).multiply(x);
}

/** jroot — commitment to J (the fluxset) as of a reference height. */
export function jroot(fluxset) {
  const leaves = (fluxset || []).map((p) => Buffer.from(sha256(pointBytes(p instanceof Uint8Array || Buffer.isBuffer(p) ? pointFrom(p) : p))));
  return merkleRoot(leaves);
}

/**
 * admit_prove. index is the real spend in the fluxset.
 * Consensus must pass the complete unspent fluxset — not a decoy sample.
 * Returns admit_proof (structured; length follows input count).
 */
export function admitProve({ x, index, pubs }) {
  const fluxset = pubs;
  const n = fluxset.length;
  if (!n) throw new Error('empty_fluxset');
  if (index < 0 || index >= n) throw new Error('index');
  const ring = fluxset.map((p) => (typeof p.toBytes === 'function' ? p : pointFrom(p)));
  const P = ring[index];
  const I = spendTag(x, P);
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
    admit_proof: true,
    spendTag: Ibytes,
    c0: scalarBytes(c[0]),
    r: r.map(scalarBytes),
  };
}

/** admit_verify against the fluxset (pubs). */
export function admitVerify(proof, pubs) {
  try {
    const fluxset = pubs;
    const n = fluxset.length;
    if (!n || !proof?.r || proof.r.length !== n) return false;
    const ring = fluxset.map((p) => (typeof p.toBytes === 'function' ? p : pointFrom(p)));
    const tag = proof.spendTag || proof.keyImage;
    const I = pointFrom(tag);
    if (I.equals(Point.ZERO)) return false;
    let c = scalarFrom(proof.c0);
    for (let i = 0; i < n; i += 1) {
      const ri = scalarFrom(proof.r[i]);
      const L = G.multiply(ri).add(ring[i].multiply(c));
      const R = Hp(ring[i]).multiply(ri).add(I.multiply(c));
      c = hashToScalar(tag, pointBytes(L), pointBytes(R), DST);
    }
    return Fn.eql(c, scalarFrom(proof.c0));
  } catch {
    return false;
  }
}

export const admit_prove = admitProve;
export const admit_verify = admitVerify;

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
import { hashToScalar, randomScalar, scalarBytes, scalarFrom, pointBytes, pointFrom, G, asU8 } from './note.js';
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

const XDST = Buffer.from('shear-admit-x-v1');

function kindByte(kind) {
  const k = String(kind || '');
  if (k === 'hash') return 1;
  if (k === 'pot') return 2;
  if (k === 'finder-fee') return 3;
  if (k === 'reserve-fee') return 4;
  if (k === 'dummy') return 5;
  return 0;
}

function hexTag(tag) {
  try {
    return Buffer.from(asU8(tag)).toString('hex');
  } catch {
    return '';
  }
}

/**
 * Note → P = x·G (frozen; coinbase and Flow both use this).
 *
 * Spend seed is the 32-byte Ed25519 seed.
 *   x_base = hashToScalar("shear-admit-x-v1" || "base" || spend_seed)
 *   B      = x_base · G
 * For a sealed note (C, noteCommit, kind):
 *   delta  = hashToScalar("shear-admit-x-v1" || "note" || noteCommit || C || kind)
 *   x      = x_base + delta
 *   P      = B + delta·G = x · G
 *
 * Wallet derives x from the spend seed + sealed note fields.
 * Output creator places P on the vout (`admitPub`) using B from the dest
 * (ssa dest payload dest20 || B). Dummy outs pick a fresh x and drop it.
 */
export function admitBaseScalar(spendSeed) {
  return hashToScalar(XDST, Buffer.from('base'), asU8(spendSeed));
}

export function admitBasePub(spendSeed) {
  return admitPub(admitBaseScalar(spendSeed));
}

export function admitDelta(note) {
  return hashToScalar(
    XDST,
    Buffer.from('note'),
    asU8(note?.noteCommit),
    asU8(note?.commit),
    Buffer.from([kindByte(note?.kind)]),
  );
}

export function admitScalarFromSeed(spendSeed, note) {
  return Fn.add(admitBaseScalar(spendSeed), admitDelta(note));
}

export function admitPubFromBase(admitBase, note) {
  const B = typeof admitBase?.toBytes === 'function' ? admitBase : pointFrom(admitBase);
  return B.add(G.multiply(admitDelta(note)));
}

/** Attach ristretto P to a sealed vout. Prefer dest admit-base; else spend seed; else a dropped random x (dummies). */
export function attachAdmitPub(vout, { admitBase, spendSeed } = {}) {
  if (!vout?.commit) return vout;
  if (vout.admitPub && Buffer.from(asU8(vout.admitPub)).length === 32) return vout;
  if (spendSeed) {
    const x = admitScalarFromSeed(spendSeed, vout);
    return { ...vout, admitPub: pointBytes(admitPub(x)) };
  }
  if (admitBase) {
    return { ...vout, admitPub: pointBytes(admitPubFromBase(admitBase, vout)) };
  }
  const x = randomScalar();
  return { ...vout, admitPub: pointBytes(admitPub(x)) };
}

export function pubFromAdmit(buf) {
  const p = typeof buf?.toBytes === 'function' ? buf : pointFrom(buf);
  return p;
}

/**
 * Live fluxset J: every sealed note's P in appearance order (coinbase then body).
 * Spent notes stay in J (Admit does not reveal which flowline moved).
 * Double-spend is a repeated spendTag.
 */
export function emptyFluxset() {
  return { pubs: [], spendTags: new Set(), jroot: jroot([]) };
}

/** Append one sealed block's notes and spend-tags onto a live J. */
export function applyBlockToFluxset(live, block) {
  const pubs = Array.isArray(live?.pubs) ? live.pubs.slice() : [];
  const spendTags = new Set(live?.spendTags || []);
  for (const tx of block?.txs || []) {
    const tag = tx.admit_proof?.spendTag || tx.spendTag;
    if (tag) {
      const h = hexTag(tag);
      if (h) spendTags.add(h);
    }
    for (const o of tx.vout || []) {
      if (!o?.admitPub) continue;
      try {
        pubs.push(pubFromAdmit(o.admitPub));
      } catch {
        /* skip unreadable */
      }
    }
  }
  return { pubs, spendTags, jroot: jroot(pubs) };
}

export function fluxsetFromBlocks(blocks) {
  let live = emptyFluxset();
  for (const b of blocks || []) live = applyBlockToFluxset(live, b);
  return live;
}

export function compactAdmitProof(proof) {
  if (!proof) return proof;
  return {
    admit_proof: true,
    spendTag: proof.spendTag,
    c0: proof.c0,
    r: proof.r,
  };
}

export function fluxsetIndexOf(pubs, spendSeed, note) {
  const P = admitPub(admitScalarFromSeed(spendSeed, note));
  const want = Buffer.from(pointBytes(P));
  return (pubs || []).findIndex((p) => {
    try {
      const got = Buffer.from(pointBytes(typeof p?.toBytes === 'function' ? p : pointFrom(p)));
      return got.equals(want);
    } catch {
      return false;
    }
  });
}

export function proveFlowSpend(tx, { spendSeed, spentNote, pubs }) {
  const x = admitScalarFromSeed(spendSeed, spentNote);
  const index = fluxsetIndexOf(pubs, spendSeed, spentNote);
  if (index < 0) throw new Error('not_in_fluxset');
  const proof = admitProve({ x, index, pubs });
  tx.admit_proof = proof;
  tx.spendTag = proof.spendTag;
  return tx;
}

/**
 * ADMITv2 — Anonymous Destination Membership Integer Transactions.
 * Curve Trees on Pasta (Pallas–Vesta). Circuit = membership of leaf only.
 * Native prove/verify. ADMITv1 linear r.length === |J| blobs fail.
 * Fingerprint: ADMIT=ADMITv2.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { RistrettoPoint, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { hashToScalar, randomScalar, scalarBytes, scalarFrom, pointBytes, pointFrom, G, asU8, wrapNoteBlind, kernelExcess } from './note.js';
import { merkleRoot } from './merkle.js';
import { nativeJroot, nativeProve, nativeVerify, nativeVerifyBatch } from './native_admit.js';

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

function pubBytes(p) {
  try {
    const pt = typeof p?.toBytes === 'function' ? p : (Buffer.isBuffer(p) || p instanceof Uint8Array ? pointFrom(p) : pointFrom(p));
    return pointBytes(pt);
  } catch {
    return null;
  }
}

function commitBytes(c) {
  try {
    return Buffer.from(asU8(c));
  } catch {
    return null;
  }
}

function leafLists(fluxset) {
  const pubs = Array.isArray(fluxset) ? fluxset : (fluxset?.pubs || []);
  const commits = Array.isArray(fluxset) ? [] : (fluxset?.commits || []);
  const destLeaves = [];
  const cLeaves = [];
  for (let i = 0; i < pubs.length; i += 1) {
    const d = pubBytes(pubs[i]);
    const c = commitBytes(commits[i] || pubs[i]?.commit);
    if (!d || !c || c.length !== 32) continue;
    destLeaves.push(d);
    cLeaves.push(c);
  }
  return { destLeaves, cLeaves };
}

/** jroot — commitment to J (dest tree + C tree) as of a reference height. */
export function jroot(fluxset) {
  const { destLeaves, cLeaves } = leafLists(Array.isArray(fluxset) ? { pubs: fluxset, commits: [] } : fluxset);
  if (Array.isArray(fluxset) && fluxset.length && !cLeaves.length) {
    const dest = fluxset.map(pubBytes).filter(Boolean);
    const zeros = dest.map(() => Buffer.alloc(32));
    return nativeJroot(dest, zeros) || merkleRoot(dest);
  }
  return nativeJroot(destLeaves, cLeaves) || Buffer.alloc(32);
}

/**
 * admit_prove. index is the real spend in J.
 * Native Curve Tree. t rerandomizes C → C̃.
 */
export function admitProve({ x, index, pubs, commits, c, t }) {
  const destLeaves = (pubs || []).map(pubBytes).filter(Boolean);
  const cLeaves = (commits || []).map(commitBytes).filter((b) => b && b.length === 32);
  const n = destLeaves.length;
  if (!n || n !== cLeaves.length) return null;
  if (index < 0 || index >= n) return null;
  if (cLeaves[index].length !== 32 || destLeaves[index].length !== 32) return null;
  const ts = t != null ? t : randomScalar();
  const P = destLeaves[index];
  const C = c || cLeaves[index];
  const got = nativeProve({
    x: scalarBytes(x),
    p: P,
    c: Buffer.from(asU8(C)),
    t: scalarBytes(ts),
    index,
    destLeaves,
    cLeaves,
  });
  if (!got) {
    return null;
  }
  return {
    admit_proof: true,
    v: 2,
    spendTag: got.proof.length >= 33 ? Buffer.from(got.proof.subarray(1, 33)) : pointBytes(spendTag(x, pointFrom(P))),
    blob: got.proof,
    cTilde: got.cTilde,
    t: scalarBytes(ts),
  };
}

/** admit_verify against J. ADMITv1 linear r[] returns false. Never throws. */
export function admitVerify(proof, fluxset, extra = {}) {
  try {
    if (proof?.r && Array.isArray(proof.r)) return false;
    const blob = proof?.blob || proof?.proof;
    if (!blob) return false;
    const pr = Buffer.from(asU8(blob));
    if (!pr.length || pr[0] !== 2) return false;
    if (pr.length > 32768) return false;
    let jr = extra.jroot || (Array.isArray(fluxset) ? null : fluxset?.jroot) || null;
    if (!jr) {
      const { destLeaves, cLeaves } = leafLists(fluxset);
      jr = nativeJroot(destLeaves, cLeaves);
    }
    const tag = extra.spendTag || proof.spendTag;
    const ct = extra.cTilde || extra.c_tilde || proof.cTilde;
    if (!jr || !tag || !ct) return false;
    // Consensus verify is log-time against jroot. Do not copy full J into native.
    return nativeVerify({
      proof: pr,
      jroot: jr,
      cTilde: Buffer.from(asU8(ct)),
      spendTag: Buffer.from(asU8(tag)),
      destLeaves: [],
      cLeaves: [],
    });
  } catch {
    return false;
  }
}

export function admitVerifyBatch(items, fluxset, extra = {}) {
  try {
    let jr = extra.jroot || (Array.isArray(fluxset) ? null : fluxset?.jroot) || null;
    if (!jr) {
      const { destLeaves, cLeaves } = leafLists(fluxset);
      jr = nativeJroot(destLeaves, cLeaves);
    }
    if (!jr || !items?.length) return false;
    return nativeVerifyBatch({
      proofs: items.map((it) => it.proof || it.blob),
      jroot: jr,
      cTildes: items.map((it) => it.cTilde),
      tags: items.map((it) => it.spendTag),
      destLeaves: [],
      cLeaves: [],
    });
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
  let out = vout;
  if (!(vout.admitPub && Buffer.from(asU8(vout.admitPub)).length === 32)) {
    if (spendSeed) {
      const x = admitScalarFromSeed(spendSeed, vout);
      out = { ...vout, admitPub: pointBytes(admitPub(x)) };
    } else if (admitBase) {
      out = { ...vout, admitPub: pointBytes(admitPubFromBase(admitBase, vout)) };
    } else {
      const x = randomScalar();
      out = { ...vout, admitPub: pointBytes(admitPub(x)) };
    }
  }
  if (admitBase) out = wrapNoteBlind(out, admitBase);
  return out;
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
  return { pubs: [], commits: [], spendTags: new Set(), jroot: jroot({ pubs: [], commits: [] }) };
}

/** Append one sealed block's notes and spend-tags onto a live J. */
export function applyBlockToFluxset(live, block) {
  const pubs = Array.isArray(live?.pubs) ? live.pubs.slice() : [];
  const commits = Array.isArray(live?.commits) ? live.commits.slice() : [];
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
        commits.push(o.commit ? Buffer.from(asU8(o.commit)) : Buffer.alloc(32));
      } catch {
        /* skip unreadable */
      }
    }
  }
  return { pubs, commits, spendTags, jroot: jroot({ pubs, commits }) };
}

export function fluxsetFromBlocks(blocks) {
  const pubs = [];
  const commits = [];
  const spendTags = new Set();
  for (const b of blocks || []) {
    for (const tx of b?.txs || []) {
      const tag = tx.admit_proof?.spendTag || tx.spendTag;
      if (tag) {
        const h = hexTag(tag);
        if (h) spendTags.add(h);
      }
      for (const o of tx.vout || []) {
        if (!o?.admitPub) continue;
        try {
          pubs.push(pubFromAdmit(o.admitPub));
          commits.push(o.commit ? Buffer.from(asU8(o.commit)) : Buffer.alloc(32));
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  return { pubs, commits, spendTags, jroot: jroot({ pubs, commits }) };
}

export function compactAdmitProof(proof) {
  if (!proof) return proof;
  if (proof.blob || proof.v === 2) {
    return {
      admit_proof: true,
      v: 2,
      spendTag: proof.spendTag,
      blob: proof.blob,
      cTilde: proof.cTilde,
    };
  }
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

export function proveFlowSpend(tx, { spendSeed, spentNote, pubs, commits }) {
  const x = admitScalarFromSeed(spendSeed, spentNote);
  const index = fluxsetIndexOf(pubs, spendSeed, spentNote);
  if (index < 0) return tx;
  const ps = Array.isArray(pubs) ? pubs : [];
  const cs = Array.isArray(commits) ? commits : [];
  // J is the pair (P_i, C_i). Copying the spent commit onto every leaf
  // proves a different tree than the one the node verifies.
  if (cs.length !== ps.length || cs.length === 0) return tx;
  const tReuse = tx.vin?.[0]?.t != null ? scalarFrom(tx.vin[0].t) : undefined;
  const proof = admitProve({
    x,
    index,
    pubs: ps,
    commits: cs,
    c: spentNote.commit,
    t: tReuse,
  });
  if (!proof) return tx;
  tx.admit_proof = proof;
  tx.spendTag = proof.spendTag;
  if (Array.isArray(tx.vin) && tx.vin[0] && proof.cTilde) {
    tx.vin[0] = {
      commit: proof.cTilde,
      t: proof.t,
      r: tx.vin[0].r || spentNote.r,
    };
    if (tx.vout?.every((o) => o?.r) && tx.vin[0].r) {
      const excess = kernelExcess(tx.vout, tx.vin);
      if (excess) tx.excess = excess;
    }
  }
  return tx;
}

/**
 * Pedersen notes on ristretto255. C = v·G + r·H.
 * Range: 64-bit bit-OR Schnorr (transparent, no ceremony).
 * Coinbase exact-value: Schnorr that C − vG ∈ ⟨H⟩ for v from Tree-A.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sha512 } from '@noble/hashes/sha2.js';
import { RistrettoPoint, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';

const Point = RistrettoPoint;
const Fn = Point.Fn;
export const NOTE_BITS = 64;
export const NOTE_DST = Buffer.from('shear-note-v1');
export const NOTE_COMMIT_PERSONAL = Buffer.from('shear-note-commit-v1');

export const G = Point.BASE;
export const H = ristretto255_hasher.hashToCurve(Buffer.from('shear-note-H-v1'), { DST: NOTE_DST });

/** Accept Buffer, hex, or JSON `{type:'Buffer', data}` from chain.bin / jsonl. */
export function asU8(x) {
  if (x == null) return new Uint8Array();
  if (Buffer.isBuffer(x) || x instanceof Uint8Array) return Uint8Array.from(x);
  if (typeof x === 'string') return Uint8Array.from(Buffer.from(x, 'hex'));
  if (typeof x?.toBytes === 'function') return x.toBytes();
  if (x && typeof x === 'object') {
    if (x.type === 'Buffer' && Array.isArray(x.data)) return Uint8Array.from(x.data);
    if (typeof x.$hex === 'string') return Uint8Array.from(Buffer.from(x.$hex, 'hex'));
  }
  if (Array.isArray(x)) return Uint8Array.from(x);
  return Uint8Array.from(x);
}

/** JSON.parse reviver so Pedersen fields survive chain.bin / jsonl. */
export function reviveBytes(_key, v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && v.type === 'Buffer' && Array.isArray(v.data)) {
    return Buffer.from(v.data);
  }
  if (v && typeof v === 'object' && typeof v.$hex === 'string') return Buffer.from(v.$hex, 'hex');
  return v;
}

function concat(...parts) {
  return Buffer.concat(parts.map((p) => Buffer.from(asU8(p))));
}

export function hashToScalar(...parts) {
  const h = sha512(concat(...parts));
  return Fn.create(bytesToNumberLE(h));
}

export function randomScalar() {
  return hashToScalar(randomBytes(64));
}

export function scalarBytes(s) {
  return Buffer.from(Fn.toBytes(s));
}

export function scalarFrom(buf) {
  const b = Buffer.from(asU8(buf));
  if (b.length === 32) return Fn.fromBytes(b);
  return hashToScalar(b);
}

export function pointBytes(P) {
  return Buffer.from(P.toBytes());
}

export function pointFrom(buf) {
  return Point.fromBytes(asU8(buf));
}

export function noteCommitOfDest20(dest20) {
  const d = Buffer.from(dest20);
  if (d.length !== 20) throw new Error('dest20');
  return createHash('sha256').update(NOTE_COMMIT_PERSONAL).update(d).digest();
}

function mulG(v) {
  const val = BigInt(v);
  if (val === 0n) return Point.ZERO;
  return G.multiply(Fn.create(val));
}

export function commit(v, r) {
  return mulG(v).add(H.multiply(r));
}

function schnorrProveH(P, r, extra) {
  const k = randomScalar();
  const R = H.multiply(k);
  const e = hashToScalar(pointBytes(P), pointBytes(R), extra || Buffer.alloc(0));
  const z = Fn.add(k, Fn.mul(e, r));
  return { R: pointBytes(R), z: scalarBytes(z) };
}

function schnorrVerifyH(P, proof, extra) {
  try {
    const R = pointFrom(proof.R);
    const z = scalarFrom(proof.z);
    const e = hashToScalar(pointBytes(P), proof.R, extra || Buffer.alloc(0));
    const left = H.multiply(z);
    const right = R.add(P.multiply(e));
    return left.equals(right);
  } catch {
    return false;
  }
}

/** Prove C = v·G + r·H for a public v (coinbase / Tree-A units). */
export function proveValue(v, r) {
  const C = commit(v, r);
  const P = C.subtract(mulG(v));
  return { C: pointBytes(C), ...schnorrProveH(P, r, Buffer.from('shear-note-val-v1')) };
}

export function verifyValue(Cbytes, v, proof) {
  try {
    const C = pointFrom(Cbytes);
    const P = C.subtract(mulG(v));
    return schnorrVerifyH(P, proof, Buffer.from('shear-note-val-v1'));
  } catch {
    return false;
  }
}

function bitOrProve(B, b, s) {
  const P0 = B;
  const P1 = B.subtract(G);
  const real = b ? P1 : P0;
  const fake = b ? P0 : P1;
  const eFake = randomScalar();
  const zFake = randomScalar();
  const RFake = H.multiply(zFake).subtract(fake.multiply(eFake));
  const k = randomScalar();
  const RReal = H.multiply(k);
  const R0 = b ? RFake : RReal;
  const R1 = b ? RReal : RFake;
  const e = hashToScalar(pointBytes(B), pointBytes(R0), pointBytes(R1), Buffer.from('shear-note-bit-v1'));
  const eReal = Fn.sub(e, eFake);
  const zReal = Fn.add(k, Fn.mul(eReal, s));
  return {
    R0: pointBytes(R0),
    R1: pointBytes(R1),
    e0: scalarBytes(b ? eFake : eReal),
    e1: scalarBytes(b ? eReal : eFake),
    z0: scalarBytes(b ? zFake : zReal),
    z1: scalarBytes(b ? zReal : zFake),
  };
}

function bitOrVerify(B, proof) {
  try {
    const R0 = pointFrom(proof.R0);
    const R1 = pointFrom(proof.R1);
    const e0 = scalarFrom(proof.e0);
    const e1 = scalarFrom(proof.e1);
    const z0 = scalarFrom(proof.z0);
    const z1 = scalarFrom(proof.z1);
    const e = hashToScalar(pointBytes(B), proof.R0, proof.R1, Buffer.from('shear-note-bit-v1'));
    if (!Fn.eql(Fn.add(e0, e1), e)) return false;
    const P0 = B;
    const P1 = B.subtract(G);
    const L0 = H.multiply(z0);
    const Rhs0 = R0.add(P0.multiply(e0));
    const L1 = H.multiply(z1);
    const Rhs1 = R1.add(P1.multiply(e1));
    return L0.equals(Rhs0) && L1.equals(Rhs1);
  } catch {
    return false;
  }
}

export function proveRange(v, r) {
  const bits = [];
  const s = [];
  const Bpts = [];
  let n = BigInt(v);
  let sSum = Fn.ZERO;
  for (let i = 0; i < NOTE_BITS; i += 1) {
    const b = Number(n & 1n);
    n >>= 1n;
    const si = randomScalar();
    s.push(si);
    const Bi = commit(b, si);
    Bpts.push(Bi);
    bits.push(bitOrProve(Bi, b, si));
    const w = Fn.create(1n << BigInt(i));
    sSum = Fn.add(sSum, Fn.mul(w, si));
  }
  const rDelta = Fn.sub(r, sSum);
  const C = commit(v, r);
  let acc = Point.ZERO;
  for (let i = 0; i < NOTE_BITS; i += 1) {
    const w = Fn.create(1n << BigInt(i));
    acc = acc.add(Bpts[i].multiply(w));
  }
  const P = C.subtract(acc);
  return {
    bits,
    B: Bpts.map(pointBytes),
    cons: schnorrProveH(P, rDelta, Buffer.from('shear-note-cons-v1')),
  };
}

export function verifyRange(Cbytes, proof) {
  try {
    if (!proof?.bits || proof.bits.length !== NOTE_BITS || proof.B?.length !== NOTE_BITS) return false;
    const C = pointFrom(Cbytes);
    let acc = Point.ZERO;
    for (let i = 0; i < NOTE_BITS; i += 1) {
      const Bi = pointFrom(proof.B[i]);
      if (!bitOrVerify(Bi, proof.bits[i])) return false;
      acc = acc.add(Bi.multiply(Fn.create(1n << BigInt(i))));
    }
    const P = C.subtract(acc);
    return schnorrVerifyH(P, proof.cons, Buffer.from('shear-note-cons-v1'));
  } catch {
    return false;
  }
}

/** Coinbase / Tree-A: v is public from collated units. Exact-value proof, no painted nanos. */
export function sealCoinbaseNote(v, { dest20, noteCommit, kind } = {}) {
  const r = randomScalar();
  const value = proveValue(v, r);
  const nc = noteCommit
    ? Buffer.from(noteCommit)
    : (dest20 ? noteCommitOfDest20(dest20) : Buffer.alloc(32));
  return {
    kind: kind || 'hash',
    noteCommit: nc,
    commit: value.C,
    valueProof: { R: value.R, z: value.z },
    r: scalarBytes(r),
  };
}

export function sealNote(v, { dest20, noteCommit, kind } = {}) {
  const sealed = sealCoinbaseNote(v, { dest20, noteCommit, kind });
  sealed.rangeProof = proveRange(v, scalarFrom(sealed.r));
  return sealed;
}

export function verifySealedNote(vout, v) {
  if (!vout?.commit || !vout.valueProof) return false;
  if (v < 0 || v >= 2 ** NOTE_BITS) return false;
  if (!verifyValue(vout.commit, v, vout.valueProof)) return false;
  if (vout.rangeProof && !verifyRange(vout.commit, vout.rangeProof)) return false;
  return true;
}

export function mintTotal(vouts) {
  let acc = Point.ZERO;
  for (const o of vouts || []) {
    if (!o?.commit) return null;
    acc = acc.add(pointFrom(o.commit));
  }
  return acc;
}

export function verifyMintSum(vouts, total, excess) {
  try {
    const acc = mintTotal(vouts);
    if (!acc) return false;
    const T = mulG(total).add(H.multiply(scalarFrom(excess)));
    return acc.equals(T);
  } catch {
    return false;
  }
}

export function excessOf(vouts) {
  let s = Fn.ZERO;
  for (const o of vouts || []) {
    if (!o?.r) return null;
    s = Fn.add(s, scalarFrom(o.r));
  }
  return scalarBytes(s);
}

/**
 * Aggregated range proof (Bulletproofs, Bünz et al. 2018 §4.3) on the note
 * generators G (value) and H (blind). Every value is an n-bit integer and the
 * count m is a power of two. One proof covers all m values.
 *
 * Fiat-Shamir: SHA-512 transcript seeded with the caller's statement bytes,
 * then every commitment and proof point in order.
 */
import { createHash } from 'node:crypto';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { G, H, randomScalar } from './note.js';

const Point = RistrettoPoint;
const Fn = Point.Fn;

export const BP_GEN_DST = 'shear-t21-bp-gen-v1';
const BP_DST = 'shear-t21-bp-v1';

const gens = { G: [], H: [], U: null };

function genPoint(tag, i) {
  const h = createHash('sha512').update(BP_GEN_DST).update(tag);
  const b = Buffer.alloc(4);
  b.writeUInt32LE(i);
  return Point.hashToCurve(h.update(b).digest());
}

function ensureGens(N) {
  if (!gens.U) gens.U = genPoint('U', 0);
  for (let i = gens.G.length; i < N; i += 1) {
    gens.G.push(genPoint('G', i));
    gens.H.push(genPoint('H', i));
  }
}

function sc(n) {
  let x = BigInt(n) % Fn.ORDER;
  if (x < 0n) x += Fn.ORDER;
  return x;
}

class Transcript {
  constructor(seed) {
    this.h = createHash('sha512').update(BP_DST).update(Buffer.from(seed));
  }

  /** A point or its canonical 32-byte encoding; both hash the same bytes. */
  point(P) {
    this.h.update(P instanceof Uint8Array ? P : P.toBytes());
  }

  scalar(s) {
    this.h.update(Fn.toBytes(s));
  }

  challenge(label) {
    const d = this.h.copy().update(label).digest();
    this.h.update(d);
    const c = Fn.create(bytesToNumberLE(d));
    if (Fn.is0(c)) throw new Error('bp_challenge');
    return c;
  }
}

function msm(points, scalars) {
  const ps = [];
  const ss = [];
  for (let i = 0; i < points.length; i += 1) {
    const s = sc(scalars[i]);
    if (s === 0n) continue;
    ps.push(points[i]);
    ss.push(s);
  }
  if (!ps.length) return Point.ZERO;
  return Point.msm(ps, ss);
}

function powers(x, n) {
  const out = new Array(n);
  let acc = 1n;
  for (let i = 0; i < n; i += 1) {
    out[i] = acc;
    acc = Fn.mul(acc, x);
  }
  return out;
}

function inner(a, b) {
  let s = 0n;
  for (let i = 0; i < a.length; i += 1) s = Fn.add(s, Fn.mul(a[i], b[i]));
  return s;
}

function log2(N) {
  let k = 0;
  while ((1 << k) < N) k += 1;
  return k;
}

function isPow2(m) {
  return Number.isInteger(m) && m > 0 && (m & (m - 1)) === 0;
}

/**
 * values: bigint[] (each < 2^n). blinds: scalar[] with V_j = v_j·G + γ_j·H.
 * Returns the proof. The verifier is given the V_j points separately.
 */
export function bpProve(values, blinds, n, seed) {
  const m = values.length;
  if (!isPow2(m) || blinds.length !== m) throw new Error('bp_shape');
  const N = n * m;
  ensureGens(N);
  const Gv = gens.G.slice(0, N);
  const Hv = gens.H.slice(0, N);
  const tr = new Transcript(seed);
  const V = new Array(m);
  for (let j = 0; j < m; j += 1) {
    const v = BigInt(values[j]);
    if (v < 0n || v >= (1n << BigInt(n))) throw new Error('bp_range');
    V[j] = (v === 0n ? Point.ZERO : G.multiply(v)).add(Fn.is0(blinds[j]) ? Point.ZERO : H.multiply(blinds[j]));
    tr.point(V[j]);
  }
  const aL = new Array(N);
  const aR = new Array(N);
  for (let j = 0; j < m; j += 1) {
    const v = BigInt(values[j]);
    for (let i = 0; i < n; i += 1) {
      const bit = (v >> BigInt(i)) & 1n;
      aL[j * n + i] = bit;
      aR[j * n + i] = sc(bit - 1n);
    }
  }
  const alpha = randomScalar();
  const A = H.multiply(alpha).add(msm([...Gv, ...Hv], [...aL, ...aR]));
  const sL = Array.from({ length: N }, () => randomScalar());
  const sR = Array.from({ length: N }, () => randomScalar());
  const rho = randomScalar();
  const S = H.multiply(rho).add(msm([...Gv, ...Hv], [...sL, ...sR]));
  tr.point(A);
  tr.point(S);
  const y = tr.challenge('y');
  const z = tr.challenge('z');
  const yN = powers(y, N);
  const two = powers(2n, n);
  const zp = powers(z, m + 2);
  const l0 = aL.map((a) => Fn.sub(a, z));
  const l1 = sL;
  const r0 = new Array(N);
  const r1 = new Array(N);
  for (let j = 0; j < m; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = j * n + i;
      r0[k] = Fn.add(Fn.mul(yN[k], Fn.add(aR[k], z)), Fn.mul(zp[j + 2], two[i]));
      r1[k] = Fn.mul(yN[k], sR[k]);
    }
  }
  const t1 = Fn.add(inner(l0, r1), inner(l1, r0));
  const t2 = inner(l1, r1);
  const tau1 = randomScalar();
  const tau2 = randomScalar();
  const T1p = (Fn.is0(t1) ? Point.ZERO : G.multiply(t1)).add(H.multiply(tau1));
  const T2p = (Fn.is0(t2) ? Point.ZERO : G.multiply(t2)).add(H.multiply(tau2));
  tr.point(T1p);
  tr.point(T2p);
  const x = tr.challenge('x');
  const l = l0.map((v, i) => Fn.add(v, Fn.mul(l1[i], x)));
  const r = r0.map((v, i) => Fn.add(v, Fn.mul(r1[i], x)));
  const that = inner(l, r);
  let taux = Fn.add(Fn.mul(tau2, Fn.mul(x, x)), Fn.mul(tau1, x));
  for (let j = 0; j < m; j += 1) taux = Fn.add(taux, Fn.mul(zp[j + 2], blinds[j]));
  const mu = Fn.add(alpha, Fn.mul(rho, x));
  tr.scalar(taux);
  tr.scalar(mu);
  tr.scalar(that);
  const w = tr.challenge('w');
  const Uw = gens.U.multiply(w);
  const yInv = Fn.inv(y);
  const yInvN = powers(yInv, N);
  let Gs = Gv.slice();
  let Hs = Hv.map((P, i) => (yInvN[i] === 1n ? P : P.multiplyUnsafe(yInvN[i])));
  let a = l;
  let b = r;
  const Ls = [];
  const Rs = [];
  while (a.length > 1) {
    const h = a.length / 2;
    const aLo = a.slice(0, h);
    const aHi = a.slice(h);
    const bLo = b.slice(0, h);
    const bHi = b.slice(h);
    const GLo = Gs.slice(0, h);
    const GHi = Gs.slice(h);
    const HLo = Hs.slice(0, h);
    const HHi = Hs.slice(h);
    const cL = inner(aLo, bHi);
    const cR = inner(aHi, bLo);
    const Lp = msm([...GHi, ...HLo, Uw], [...aLo, ...bHi, cL]);
    const Rp = msm([...GLo, ...HHi, Uw], [...aHi, ...bLo, cR]);
    Ls.push(Lp);
    Rs.push(Rp);
    tr.point(Lp);
    tr.point(Rp);
    const u = tr.challenge('u');
    const ui = Fn.inv(u);
    a = aLo.map((v, i) => Fn.add(Fn.mul(v, u), Fn.mul(aHi[i], ui)));
    b = bLo.map((v, i) => Fn.add(Fn.mul(v, ui), Fn.mul(bHi[i], u)));
    Gs = GLo.map((P, i) => P.multiplyUnsafe(ui).add(GHi[i].multiplyUnsafe(u)));
    Hs = HLo.map((P, i) => P.multiplyUnsafe(u).add(HHi[i].multiplyUnsafe(ui)));
  }
  const enc = (P) => Buffer.from(P.toBytes());
  const es = (s) => Buffer.from(Fn.toBytes(s));
  return {
    A: enc(A),
    S: enc(S),
    T1: enc(T1p),
    T2: enc(T2p),
    taux: es(taux),
    mu: es(mu),
    that: es(that),
    L: Ls.map(enc),
    R: Rs.map(enc),
    a: es(a[0]),
    b: es(b[0]),
  };
}

/**
 * Verification as one check with random weight on the polynomial equation.
 * Returns the two sides' difference as { points, scalars } so a caller can
 * fold many proofs into one multi-scalar multiplication (T-15 batch weights).
 */
export function bpVerifyTerms(V, proof, n, seed, weight = 1n, Vbytes = null) {
  const m = V.length;
  if (!isPow2(m)) return null;
  const N = n * m;
  const k = log2(N);
  if (!proof || !Array.isArray(proof.L) || !Array.isArray(proof.R)) return null;
  if (proof.L.length !== k || proof.R.length !== k) return null;
  if (Vbytes && Vbytes.length !== m) return null;
  ensureGens(N);
  const raw = (b) => {
    const buf = Uint8Array.from(Buffer.from(b));
    if (buf.length !== 32) throw new Error('bp_point');
    return buf;
  };
  const ds = (b) => {
    const buf = Buffer.from(b);
    if (buf.length !== 32) throw new Error('bp_scalar');
    const s = bytesToNumberLE(buf);
    if (s >= Fn.ORDER) throw new Error('bp_scalar');
    return s;
  };
  const tr = new Transcript(seed);
  V.forEach((P, j) => tr.point(Vbytes ? raw(Vbytes[j]) : P));
  const pt = (b) => {
    const bytes = raw(b);
    tr.point(bytes);
    return Point.fromBytes(bytes);
  };
  const A = pt(proof.A);
  const S = pt(proof.S);
  const y = tr.challenge('y');
  const z = tr.challenge('z');
  const T1 = pt(proof.T1);
  const T2 = pt(proof.T2);
  const x = tr.challenge('x');
  const taux = ds(proof.taux);
  const mu = ds(proof.mu);
  const that = ds(proof.that);
  tr.scalar(taux);
  tr.scalar(mu);
  tr.scalar(that);
  const w = tr.challenge('w');
  const Ls = [];
  const Rs = [];
  const us = [];
  for (let i = 0; i < k; i += 1) {
    Ls.push(pt(proof.L[i]));
    Rs.push(pt(proof.R[i]));
    us.push(tr.challenge('u'));
  }
  const a = ds(proof.a);
  const b = ds(proof.b);
  const yN = powers(y, N);
  const yInvN = powers(Fn.inv(y), N);
  const two = powers(2n, n);
  const zp = powers(z, m + 3);
  let sumY = 0n;
  for (const v of yN) sumY = Fn.add(sumY, v);
  let sum2 = 0n;
  for (const v of two) sum2 = Fn.add(sum2, v);
  let delta = Fn.mul(Fn.sub(z, Fn.mul(z, z)), sumY);
  for (let j = 0; j < m; j += 1) delta = Fn.sub(delta, Fn.mul(zp[j + 3], sum2));
  const uInv = us.map((u) => Fn.inv(u));
  // s_i = Π_j u_j^{±1}; s_{N−1−i} flips every sign, so it is s_i⁻¹.
  const s = new Array(N);
  s[0] = uInv.reduce((acc, v) => Fn.mul(acc, v), 1n);
  for (let i = 1; i < N; i += 1) {
    const j = k - 1 - Math.floor(Math.log2(i & -i));
    s[i] = Fn.mul(s[i - (i & -i)], Fn.mul(us[j], us[j]));
  }
  // Equation 1 (weight c): t̂·G + τx·H − Σ z^{j+2}V_j − δ·G − x·T1 − x²·T2 = 0.
  // Equation 2 (weight 1): the folded inner-product check.
  const c = Fn.mul(weight, Fn.create(bytesToNumberLE(createHash('sha512').update('bp-c').update(Fn.toBytes(w)).digest())) || 1n);
  const pts = [];
  const scs = [];
  const add = (P, s0) => { pts.push(P); scs.push(s0); };
  add(G, Fn.mul(c, Fn.sub(that, delta)));
  add(H, Fn.mul(c, taux));
  for (let j = 0; j < m; j += 1) add(V[j], Fn.neg(Fn.mul(c, zp[j + 2])));
  add(T1, Fn.neg(Fn.mul(c, x)));
  add(T2, Fn.neg(Fn.mul(c, Fn.mul(x, x))));
  add(A, weight);
  add(S, Fn.mul(weight, x));
  add(H, Fn.neg(Fn.mul(weight, mu)));
  add(gens.U, Fn.mul(weight, Fn.mul(w, Fn.sub(that, Fn.mul(a, b)))));
  for (let j = 0; j < k; j += 1) {
    add(Ls[j], Fn.mul(weight, Fn.mul(us[j], us[j])));
    add(Rs[j], Fn.mul(weight, Fn.mul(uInv[j], uInv[j])));
  }
  for (let jj = 0; jj < m; jj += 1) {
    for (let i = 0; i < n; i += 1) {
      const idx = jj * n + i;
      add(gens.G[idx], Fn.mul(weight, Fn.neg(Fn.add(z, Fn.mul(a, s[idx])))));
      const hc = Fn.sub(
        Fn.add(z, Fn.mul(Fn.mul(zp[jj + 2], two[i]), yInvN[idx])),
        Fn.mul(Fn.mul(b, s[N - 1 - idx]), yInvN[idx]),
      );
      add(gens.H[idx], Fn.mul(weight, hc));
    }
  }
  return { points: pts, scalars: scs };
}

export function bpVerify(V, proof, n, seed) {
  try {
    const t = bpVerifyTerms(V, proof, n, seed);
    if (!t) return false;
    return msm(t.points, t.scalars).equals(Point.ZERO);
  } catch {
    return false;
  }
}

/** Fold many term lists (each already weighted) into one MSM. */
export function msmIsZero(terms) {
  const pts = [];
  const scs = [];
  for (const t of terms) {
    if (!t) return false;
    for (let i = 0; i < t.points.length; i += 1) {
      pts.push(t.points[i]);
      scs.push(t.scalars[i]);
    }
  }
  try {
    return msm(pts, scs).equals(Point.ZERO);
  } catch {
    return false;
  }
}

export function bpSize(m, n) {
  const k = log2(m * n);
  return (4 + 2 * k) * 32 + 5 * 32;
}

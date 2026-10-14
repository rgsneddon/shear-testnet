/**
 * T21 hidden coinbase (cb-v3).
 *
 * Every payout row is a Pedersen note C = v·G + r·H to a fresh voucher
 * (B*, Y, λ). The block shows S, c_in, c_out, the fee bps, u and the share
 * weights. It does not show a row's v, W_i, ρ_i, or which shares feed it.
 *
 * Tally: Σ_s w_s/(X−ℓ_s) = Σ_i W_i/(X−λ_i). ℓ_s is hidden in E_s = ℓ_s·G + β_s·H.
 * The share list publishes only (w_s, E_s). Each E_s is the bound value of a
 * proven share in the block's share batch: the share's PoW commits to
 * t21ShareNc(magic, E_s), so a producer cannot add or re-weight a share.
 *
 * Law per row: W·v_i = (R + W·u)·W_i − ρ_i + W·fin_i, 0 ≤ ρ_i < W,
 * R = S + c_in − f. The pool fee is a hidden note that opens to the public f.
 * Mint: Σ C_i = (S + c_in − c_out + u·W + Φ)·G + excess·H.
 *
 * Range: one aggregated range proof per row over 32 16-bit values
 * (20 VE limbs of v and r, three limbs of ρ, three of W−1−ρ, six zero pads).
 * The verifier folds every equation of the coinbase into one multi-scalar
 * multiplication with independent 128-bit random weights.
 */
import { createHash, randomBytes } from 'node:crypto';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { fs1Leaf } from './fs1_leaf.js';
import {
  G, H, asU8, commit, hashToScalar, openNoteAmount, pointBytes as encodePoint, pointFrom,
  randomScalar, scalarBytes, scalarFrom, wrapNoteBlind,
} from './note.js';
import { feeOf, lawDust, scalarOk, splitLaw, t21Big } from './t21_law.js';
import { voucherAt, voucherKeysOk, voucherLambda } from './t21_voucher.js';
import { bpProve, bpVerifyTerms } from './t21_bp.js';
import {
  AMOUNT_KEYS, BP_M, BP_N, CB_FORM, DOM_CB, FEE_BPS_MAX, GEN_H,
  K_MIN, L_MAX, LOGUP_DOM, N_MAX, OUTPUT_MAX, PAYOUT_KIND_CODE, PAYOUT_KINDS,
  RANGE_TAG, RHO_LIMBS, R_CHUNKS, SCALAR_MAX, SHARE_BIND_DOM, T21_REQUIRE_ALL_COINBASES,
  V_CHUNKS, VAULT_KIND_CODE, VAULT_R_DOM, VE_CHUNKS, W_HASH_MAX, W_MAX, W_S_MAX,
} from './t21_params.js';

const Point = RistrettoPoint;
const Fn = Point.Fn;
const ORDER = Fn.ORDER;
const LEAF_TRIES = 8;

export const AGG_KEYS = Object.freeze(['RC', 'RVv', 'RDv', 'RVr', 'RDr', 'zv', 'zr', 'ztv', 'ztr']);
export const CHUNK_KEYS = Object.freeze(['epV', 'epD', 'Mpt', 'bindR1', 'bindR2', 'zT', 'zS']);

function no(reason) {
  return { ok: false, reason };
}

function fail(reason, extra = {}) {
  const err = new Error(reason);
  err.reason = reason;
  Object.assign(err, extra);
  return err;
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n) >>> 0);
  return b;
}

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function mod(n) {
  let x = BigInt(n) % ORDER;
  if (x < 0n) x += ORDER;
  return x;
}

function sb(s) {
  return bytesToNumberLE(Fn.toBytes(s));
}

function mulP(P, n) {
  const v = mod(n);
  if (v === 0n) return Point.ZERO;
  return P.multiply(v);
}

function bytes32(value) {
  try {
    const b = Buffer.from(asU8(value));
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

// Ristretto decoding only accepts the canonical encoding, so a decoded point's
// bytes are its encoding. Both directions are cached to skip field inversions.
const DEC = new Map();
const ENC = new WeakMap();

function pointBytes(P) {
  let b = ENC.get(P);
  if (!b) {
    b = encodePoint(P);
    ENC.set(P, b);
  }
  return b;
}

function pointOk(value) {
  const b = bytes32(value);
  if (!b) return null;
  const hex = b.toString('hex');
  if (DEC.has(hex)) return DEC.get(hex);
  let P = null;
  try {
    P = pointFrom(b);
    if (P.equals(Point.ZERO)) P = null;
  } catch {
    P = null;
  }
  if (DEC.size > 200_000) DEC.clear();
  DEC.set(hex, P);
  if (P) ENC.set(P, Uint8Array.from(b));
  return P;
}

function scalarOkBytes(value) {
  const b = bytes32(value);
  if (!b) return null;
  const s = bytesToNumberLE(b);
  return s < ORDER ? s : null;
}

function sha(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(Buffer.from(asU8(p)));
  return h.digest();
}

function hasKey(o, k) {
  return !!o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
}

/* ---------- multi-scalar equation accumulator ---------- */

class Terms {
  constructor() {
    this.points = [];
    this.scalars = [];
  }

  add(P, s) {
    const v = mod(s);
    if (v === 0n) return this;
    this.points.push(P);
    this.scalars.push(v);
    return this;
  }
}

function weight128() {
  const w = bytesToNumberLE(randomBytes(16));
  return w === 0n ? 1n : w;
}

/** Terms on the same point object (G, H, the range-proof generators) are merged before the MSM. */
function msmZero(lists) {
  const acc = new Map();
  for (const [t, w] of lists) {
    if (!t) return false;
    for (let i = 0; i < t.points.length; i += 1) {
      const P = t.points[i];
      acc.set(P, mod((acc.get(P) || 0n) + t.scalars[i] * w));
    }
  }
  const ps = [];
  const ss = [];
  for (const [P, s] of acc) {
    if (s === 0n) continue;
    ps.push(P);
    ss.push(s);
  }
  if (!ps.length) return true;
  try {
    return Point.msm(ps, ss).equals(Point.ZERO);
  } catch {
    return false;
  }
}

/* ---------- Schnorr on H ---------- */

function proveH(P, s, extra) {
  const k = randomScalar();
  const R = H.multiply(k);
  const e = hashToScalar(pointBytes(P), pointBytes(R), extra);
  return { Rpt: pointBytes(R), z: scalarBytes(Fn.add(k, Fn.mul(e, mod(s)))) };
}

/** z·H − R − e·P = 0. */
function hTerms(P, proof, extra) {
  const R = pointOk(proof?.Rpt);
  const z = scalarOkBytes(proof?.z);
  if (!R || z == null) return null;
  const e = hashToScalar(pointBytes(P), pointBytes(R), extra);
  return new Terms().add(H, z).add(R, -1n).add(P, -e);
}

/* ---------- public helpers ---------- */

export function isT21Coinbase(tx) {
  return !!(tx && (tx.coinbase || tx.kind === 'coinbase') && tx.cbForm === CB_FORM);
}

export function payoutDelta({ magic, height, prevHash, index, commit: C }) {
  return hashToScalar(
    Buffer.from(DOM_CB),
    Buffer.from(String(magic)),
    u64le(height),
    Buffer.from(asU8(prevHash)),
    u32le(index),
    Buffer.from(asU8(C)),
  );
}

export function rowIsLeaf(row) {
  const pub = bytes32(row?.admitPub);
  const C = bytes32(row?.commit);
  if (!pub || !C) return false;
  try {
    return !!fs1Leaf({ admitPub: pub, commit: C });
  } catch {
    return false;
  }
}

/**
 * KT-10 0x23 blind. Public by design (the vault amount is portal state).
 * Uses the parent hash, which is fixed before this block is built.
 */
export function vaultBlind(mintId, height, prevHash) {
  const id = Buffer.from(asU8(mintId));
  const ph = Buffer.from(asU8(prevHash));
  for (let n = 0; n < 256; n += 1) {
    const r = hashToScalar(Buffer.from(VAULT_R_DOM), id, u64le(height), ph, Buffer.from([n]));
    if (!Fn.is0(r)) return r;
  }
  return null;
}

export function vaultCommit(vaultNanos, mintId, height, prevHash) {
  const v = scalarOk(vaultNanos);
  const r = vaultBlind(mintId, height, prevHash);
  if (v == null || !r) return null;
  return { r, commit: pointBytes(commit(v, r)) };
}

/** The parent id a cb-v3 coinbase binds: SHA-256 over the parent header bytes. */
export function t21ParentId(prevHeader) {
  return sha(Buffer.from('shear-t21-parent-v1'), Buffer.from(asU8(prevHeader)));
}

/** Φ and the finder row's B* from a verified cb-v3 coinbase. */
export function t21FinderOf(tx) {
  let phi = 0n;
  let finB = null;
  for (const o of payoutRows(tx || {})) {
    const fin = scalarOk(o.fin || 0);
    if (fin == null) return null;
    if (fin > 0n) {
      phi += fin;
      finB = bytes32(o.B);
    }
  }
  return { phi, finB };
}

/** The 32 bytes a v6 share's PoW is bound to. A share batch row carries it as noteCommit. */
export function t21ShareNc(magic, E) {
  return sha(Buffer.from(SHARE_BIND_DOM), Buffer.from(String(magic)), Buffer.from(asU8(E)));
}

/** Miner side: a share label for voucher λ. ℓ and β stay with the miner and pool. */
export function minerShare(vch, w) {
  const beta = randomScalar();
  const E = mulP(G, sb(vch.lambda)).add(H.multiply(beta));
  return { w: BigInt(w), E: pointBytes(E), ell: vch.lambda, beta };
}

/* ---------- verifiable encryption (R-A′) ---------- */

function limbsOf(n, count) {
  const out = [];
  let x = BigInt(n);
  for (let i = 0; i < count; i += 1) {
    out.push(x & 0xffffn);
    x >>= 16n;
  }
  return out;
}

function encryptLimb(m, Y) {
  const t = randomScalar();
  const s = randomScalar();
  const epV = G.multiply(t);
  const epD = Y.multiply(t).add(mulP(G, m));
  const M = commit(m, s);
  return { m, t, s, epV, epD, M };
}

function finishChunk(enc, Y, extra) {
  const { t, s, epV, epD, M } = enc;
  const kT = randomScalar();
  const kS = randomScalar();
  const R1 = G.multiply(kT);
  const R2 = Y.multiply(kT).subtract(H.multiply(kS));
  const e = hashToScalar(pointBytes(R1), pointBytes(R2), pointBytes(epV), pointBytes(epD), pointBytes(M), extra);
  return {
    epV: pointBytes(epV),
    epD: pointBytes(epD),
    Mpt: pointBytes(M),
    bindR1: pointBytes(R1),
    bindR2: pointBytes(R2),
    zT: scalarBytes(Fn.add(kT, Fn.mul(e, t))),
    zS: scalarBytes(Fn.add(kS, Fn.mul(e, s))),
  };
}

/** G·zT = R1 + e·epV and Y·zT − H·zS = R2 + e·(epD − M). */
function chunkTerms(chunk, Y, extra) {
  const epV = pointOk(chunk?.epV);
  const epD = pointOk(chunk?.epD);
  const M = pointOk(chunk?.Mpt);
  const R1 = pointOk(chunk?.bindR1);
  const R2 = pointOk(chunk?.bindR2);
  const zT = scalarOkBytes(chunk?.zT);
  const zS = scalarOkBytes(chunk?.zS);
  if (!epV || !epD || !M || !R1 || !R2 || zT == null || zS == null) return null;
  const e = hashToScalar(pointBytes(R1), pointBytes(R2), pointBytes(epV), pointBytes(epD), pointBytes(M), extra);
  const a = new Terms().add(G, zT).add(R1, -1n).add(epV, -e);
  const b = new Terms().add(Y, zT).add(H, -zS).add(R2, -1n).add(epD, -e).add(M, e);
  return [a, b];
}

function proveAggregate(chunks, encs, v, r, Y, C, extra) {
  let Tv = 0n;
  let Tr = 0n;
  for (let j = 0; j < V_CHUNKS; j += 1) Tv = Fn.add(Tv, Fn.mul(mod(1n << (16n * BigInt(j))), encs[j].t));
  for (let j = 0; j < R_CHUNKS; j += 1) Tr = Fn.add(Tr, Fn.mul(mod(1n << (16n * BigInt(j))), encs[V_CHUNKS + j].t));
  const kv = randomScalar();
  const kr = randomScalar();
  const ktv = randomScalar();
  const ktr = randomScalar();
  const RC = G.multiply(kv).add(H.multiply(kr));
  const RVv = G.multiply(ktv);
  const RDv = Y.multiply(ktv).add(G.multiply(kv));
  const RVr = G.multiply(ktr);
  const RDr = Y.multiply(ktr).add(G.multiply(kr));
  const e = hashToScalar(
    pointBytes(RC), pointBytes(RVv), pointBytes(RDv), pointBytes(RVr), pointBytes(RDr),
    pointBytes(C), pointBytes(Y), extra,
  );
  // Only the five points and four responses are published. The limbs stay secret.
  return {
    RC: pointBytes(RC),
    RVv: pointBytes(RVv),
    RDv: pointBytes(RDv),
    RVr: pointBytes(RVr),
    RDr: pointBytes(RDr),
    zv: scalarBytes(Fn.add(kv, Fn.mul(e, mod(v)))),
    zr: scalarBytes(Fn.add(kr, Fn.mul(e, mod(r)))),
    ztv: scalarBytes(Fn.add(ktv, Fn.mul(e, Tv))),
    ztr: scalarBytes(Fn.add(ktr, Fn.mul(e, Tr))),
  };
}

function aggTerms(chunks, Y, C, proof, extra) {
  if (!proof || Object.keys(proof).sort().join() !== [...AGG_KEYS].sort().join()) return null;
  const RC = pointOk(proof.RC);
  const RVv = pointOk(proof.RVv);
  const RDv = pointOk(proof.RDv);
  const RVr = pointOk(proof.RVr);
  const RDr = pointOk(proof.RDr);
  const zv = scalarOkBytes(proof.zv);
  const zr = scalarOkBytes(proof.zr);
  const ztv = scalarOkBytes(proof.ztv);
  const ztr = scalarOkBytes(proof.ztr);
  if (!RC || !RVv || !RDv || !RVr || !RDr || zv == null || zr == null || ztv == null || ztr == null) return null;
  const e = hashToScalar(
    pointBytes(RC), pointBytes(RVv), pointBytes(RDv), pointBytes(RVr), pointBytes(RDr),
    pointBytes(C), pointBytes(Y), extra,
  );
  const eq1 = new Terms().add(G, zv).add(H, zr).add(RC, -1n).add(C, -e);
  const eq2 = new Terms().add(G, ztv).add(RVv, -1n);
  const eq3 = new Terms().add(Y, ztv).add(G, zv).add(RDv, -1n);
  const eq4 = new Terms().add(G, ztr).add(RVr, -1n);
  const eq5 = new Terms().add(Y, ztr).add(G, zr).add(RDr, -1n);
  for (let j = 0; j < V_CHUNKS; j += 1) {
    const c = mod(e * (1n << (16n * BigInt(j))));
    eq2.add(pointOk(chunks[j].epV), -c);
    eq3.add(pointOk(chunks[j].epD), -c);
  }
  for (let j = 0; j < R_CHUNKS; j += 1) {
    const c = mod(e * (1n << (16n * BigInt(j))));
    eq4.add(pointOk(chunks[V_CHUNKS + j].epV), -c);
    eq5.add(pointOk(chunks[V_CHUNKS + j].epD), -c);
  }
  return [eq1, eq2, eq3, eq4, eq5];
}

function bsgs(M) {
  const baby = new Map();
  let acc = Point.ZERO;
  for (let i = 0; i < 256; i += 1) {
    baby.set(Buffer.from(pointBytes(acc)).toString('hex'), i);
    acc = acc.add(G);
  }
  const giant = mulP(G, 256n);
  let target = M;
  for (let j = 0; j < 256; j += 1) {
    const hit = baby.get(Buffer.from(pointBytes(target)).toString('hex'));
    if (hit != null) return BigInt(j) * 256n + BigInt(hit);
    target = target.subtract(giant);
  }
  return null;
}

function decryptVe(row, y) {
  try {
    const chunks = row?.ra?.chunks;
    if (!Array.isArray(chunks) || chunks.length !== VE_CHUNKS) return null;
    const ms = [];
    for (const chunk of chunks) {
      const M = pointFrom(chunk.epD).subtract(pointFrom(chunk.epV).multiply(y));
      const m = bsgs(M);
      if (m == null) return null;
      ms.push(m);
    }
    let v = 0n;
    let r = 0n;
    for (let i = 0; i < V_CHUNKS; i += 1) v += ms[i] << (16n * BigInt(i));
    for (let i = 0; i < R_CHUNKS; i += 1) r += ms[V_CHUNKS + i] << (16n * BigInt(i));
    return { v, r: mod(r) };
  } catch {
    return null;
  }
}

/* ---------- LogUp tally ---------- */

function proveProduct(Ca, a, ra, Cb, rInv, extra) {
  const kA = randomScalar();
  const kBlind = randomScalar();
  const kR = randomScalar();
  const Rp = Cb.multiply(kA).subtract(H.multiply(kR));
  const Ra = G.multiply(kA).add(H.multiply(kBlind));
  const e = hashToScalar(pointBytes(Rp), pointBytes(Ra), pointBytes(Ca), pointBytes(Cb), extra);
  return {
    Rp: pointBytes(Rp),
    Ra: pointBytes(Ra),
    zA: scalarBytes(Fn.add(kA, Fn.mul(e, mod(a)))),
    zDiff: scalarBytes(Fn.add(kR, Fn.mul(e, mod(mod(a) * mod(rInv))))),
    zBlind: scalarBytes(Fn.add(kBlind, Fn.mul(e, mod(ra)))),
  };
}

/** a·Cb − d·H = G and Ca = a·G + b·H, so Cb commits to a⁻¹. */
function productTerms(Ca, Cb, proof, extra) {
  const Rp = pointOk(proof?.Rp);
  const Ra = pointOk(proof?.Ra);
  const zA = scalarOkBytes(proof?.zA);
  const zDiff = scalarOkBytes(proof?.zDiff);
  const zBlind = scalarOkBytes(proof?.zBlind);
  if (!Rp || !Ra || zA == null || zDiff == null || zBlind == null) return null;
  const e = hashToScalar(pointBytes(Rp), pointBytes(Ra), pointBytes(Ca), pointBytes(Cb), extra);
  return [
    new Terms().add(Cb, zA).add(H, -zDiff).add(Rp, -1n).add(G, -e),
    new Terms().add(G, zA).add(H, zBlind).add(Ra, -1n).add(Ca, -e),
  ];
}

export function pickChallenge(stmt, lambdas) {
  for (let n = 0; n < 64; n += 1) {
    const X = hashToScalar(Buffer.from(LOGUP_DOM), stmt, Buffer.from([n]));
    if (Fn.is0(X)) continue;
    if (!lambdas.some((lam) => Fn.eql(X, lam))) return { X, n };
  }
  return null;
}

/* ---------- statement ---------- */

function stable(value) {
  if (value == null) return Buffer.from([0]);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.concat([Buffer.from([1]), u32le(value.length), Buffer.from(value)]);
  }
  if (typeof value === 'bigint') return Buffer.concat([Buffer.from([2]), Buffer.from(value.toString(10))]);
  if (typeof value === 'number' || typeof value === 'boolean') return Buffer.concat([Buffer.from([3]), Buffer.from(String(value))]);
  if (typeof value === 'string') return Buffer.concat([Buffer.from([4]), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([5]), u32le(value.length), ...value.map(stable)]);
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [Buffer.from([6]), u32le(keys.length)];
    for (const k of keys) parts.push(Buffer.from(k), stable(value[k]));
    return Buffer.concat(parts);
  }
  return Buffer.from([0]);
}

const pts = (list) => (Array.isArray(list) ? list.map((p) => bytes32(p) || Buffer.alloc(0)) : []);

/**
 * T_stmt. Every public input of every proof. Share labels ℓ_s are not here;
 * a share is (w_s, E_s) only.
 */
export function statementOf(tx) {
  const t21 = tx?.t21 || {};
  const rows = (tx?.vout || []).map((o) => ({
    kind: String(o.kind || ''),
    kindCode: Number(o.kindCode || 0),
    noteCommit: bytes32(o.noteCommit) || Buffer.alloc(0),
    commit: bytes32(o.commit) || Buffer.alloc(0),
    admitPub: bytes32(o.admitPub) || Buffer.alloc(0),
    B: bytes32(o.B) || Buffer.alloc(0),
    Y: bytes32(o.Y) || Buffer.alloc(0),
    lambda: bytes32(o.lambda) || Buffer.alloc(0),
    rEph: bytes32(o.rEph) || Buffer.alloc(0),
    rCt: bytes32(o.rCt) || Buffer.alloc(0),
    amtCt: Buffer.from(asU8(o.amtCt || Buffer.alloc(0))),
    cw: bytes32(o.cw) || Buffer.alloc(0),
    rhoK: pts(o.rhoK),
    delK: pts(o.delK),
    fin: String(o.fin == null ? 0 : o.fin),
    vaultNanos: String(o.vaultNanos == null ? '' : o.vaultNanos),
    mintId: Buffer.from(asU8(o.mintId || Buffer.alloc(0))),
    chunks: (o.ra?.chunks || []).map((c) => ({
      epV: bytes32(c.epV) || Buffer.alloc(0),
      epD: bytes32(c.epD) || Buffer.alloc(0),
      Mpt: bytes32(c.Mpt) || Buffer.alloc(0),
    })),
  }));
  const shares = (t21.shares || []).map((s) => ({
    w: String(s.w),
    E: bytes32(s.E) || Buffer.alloc(0),
  }));
  return sha(stable({
    cbForm: tx?.cbForm,
    S: String(t21.S),
    cin: String(t21.cin),
    cout: String(tx?.carryNanos || 0),
    bps: String(t21.bps),
    u: String(t21.u || 0),
    height: String(t21.height),
    magic: String(t21.magic),
    prevHash: bytes32(t21.prevHash) || Buffer.alloc(0),
    rows,
    shares,
  }));
}

function proofView(tx) {
  return {
    tally: tx?.t21?.tally || null,
    mint: tx?.t21?.mint || null,
    excess: bytes32(tx?.excess) || null,
    rows: (tx?.vout || []).map((o) => ({
      law: o.law || null,
      ra: o.ra ? { agg: o.ra.agg || null, chunks: o.ra.chunks || [] } : null,
      rangeProof: o.rangeProof || null,
    })),
  };
}

export function t21Fin(tx) {
  if (!isT21Coinbase(tx)) return null;
  return sha(statementOf(tx), sha(stable(proofView(tx))));
}

export function t21DigestSuffix(tx) {
  const fin = t21Fin(tx);
  if (!fin) return null;
  return Buffer.concat([Buffer.from('t21v1'), fin]);
}

function bpSeed(stmt, index) {
  return sha(Buffer.from('shear-t21-row-bp-v1'), stmt, u32le(index));
}

/* ---------- builder ---------- */

function voucherPoints(pub) {
  const B = pointOk(pub?.B);
  const Y = pointOk(pub?.Y);
  const lam = scalarOkBytes(pub?.lambda);
  if (!B || !Y || lam == null) return null;
  return { B, Y, lambda: lam, lambdaBytes: Buffer.from(asU8(pub.lambda)) };
}

function planPay(spec, payees) {
  const S = scalarOk(spec.S);
  const cin = scalarOk(spec.cin);
  const bps = t21Big(spec.bps || 0);
  const u = scalarOk(spec.u || 0);
  if (S == null || cin == null || u == null || bps == null) throw fail('pot_sched');
  const f = feeOf(S, bps);
  if (f == null) throw fail('fee_sched');
  const R = S + cin - f;
  if (R < 0n) throw fail('pot_sched');
  let W = 0n;
  const groups = [];
  for (const p of payees) {
    let Wi = 0n;
    for (const s of p.shares || []) {
      const w = scalarOk(s.w);
      if (w == null || w <= 0n || w > W_S_MAX) throw fail('split_cap');
      Wi += w;
    }
    const fin = scalarOk(p.fin || 0);
    if (fin == null) throw fail('split_cap');
    W += Wi;
    groups.push({ ...p, Wi, fin });
  }
  if (W >= W_MAX) throw fail('split_cap');
  const rate = R + W * u;
  let phi = 0n;
  const rows = [];
  for (const g of groups) {
    const law = splitLaw({ R, W, Wi: g.Wi, u, fin: g.fin });
    if (!law) throw fail('pot_sched');
    phi += g.fin;
    rows.push({ ...g, v: law.v, rho: law.rho });
  }
  const dust = lawDust(rows.map((r) => r.rho), W);
  if (dust == null) throw fail('pot_sched');
  return { S, cin, f, bps, u, R, W, rate, phi, rows, dust };
}

/** Phase one: commitment, payout key, N-1 leaf, ρ limbs, AL-7 triple, VE ciphertexts. */
function commitRow(ctx, row, index) {
  const { B, Y } = row.vch;
  let r = null;
  let C = null;
  let P = null;
  for (let n = 0; n < (row.noLeaf ? 0 : LEAF_TRIES); n += 1) {
    const rr = ctx.random();
    const CC = commit(row.v, rr);
    const delta = payoutDelta({ magic: ctx.magic, height: ctx.height, prevHash: ctx.prevHash, index, commit: pointBytes(CC) });
    if (Fn.is0(delta)) continue;
    const PP = B.add(G.multiply(delta));
    if (rowIsLeaf({ admitPub: pointBytes(PP), commit: pointBytes(CC) })) {
      r = rr;
      C = CC;
      P = PP;
      break;
    }
  }
  if (!C) throw fail('admit_note_point', { payee: row.payee });
  const rw = ctx.random();
  const cw = commit(row.Wi, rw);
  const rhoLimbs = limbsOf(row.rho, RHO_LIMBS);
  const sRho = rhoLimbs.map(() => ctx.random());
  let rRho = 0n;
  for (let i = 0; i < RHO_LIMBS; i += 1) rRho = mod(rRho + (1n << (16n * BigInt(i))) * sb(sRho[i]));
  const del = ctx.W - 1n - row.rho;
  const delLimbs = limbsOf(del, RHO_LIMBS);
  const sDel = [ctx.random(), ctx.random()];
  const top = mod(-rRho - sb(sDel[0]) - (1n << 16n) * sb(sDel[1]));
  sDel.push(Fn.mul(top, Fn.inv(mod(1n << 32n))));
  const rhoK = rhoLimbs.map((m, i) => commit(m, sRho[i]));
  const delK = delLimbs.map((m, i) => commit(m, sDel[i]));
  const noteCommit = sha(Buffer.from('shear-t21-nc-v1'), row.vch.lambdaBytes, u32le(index));
  const sealed = wrapNoteBlind({ kind: row.kind, noteCommit, commit: pointBytes(C), r: scalarBytes(r) }, B, row.v);
  const limbMs = [...limbsOf(row.v, V_CHUNKS), ...limbsOf(sb(r), R_CHUNKS)];
  const encs = limbMs.map((m) => encryptLimb(m, Y));
  const pub = {
    kind: row.kind,
    kindCode: PAYOUT_KIND_CODE,
    noteCommit,
    commit: pointBytes(C),
    admitPub: pointBytes(P),
    B: pointBytes(B),
    Y: pointBytes(Y),
    lambda: Buffer.from(row.vch.lambdaBytes),
    rEph: sealed.rEph,
    rCt: sealed.rCt,
    amtCt: sealed.amtCt,
    cw: pointBytes(cw),
    rhoK: rhoK.map(pointBytes),
    delK: delK.map(pointBytes),
    fin: row.finPub === 0n ? 0 : row.finPub.toString(),
    ra: { chunks: encs.map((e) => ({ epV: pointBytes(e.epV), epD: pointBytes(e.epD), Mpt: pointBytes(e.M) })) },
  };
  return {
    row, index, r, C, rw, cw, rRho, sRho, sDel, rhoLimbs, delLimbs, encs, pub,
    rhoC: rhoK.reduce((a, K, i) => a.add(mulP(K, 1n << (16n * BigInt(i)))), Point.ZERO),
  };
}

/** Phase two: every proof against the final statement. */
function proveRow(ctx, item, stmt) {
  const { row, encs } = item;
  const Y = row.vch.Y;
  const chunks = encs.map((enc) => finishChunk(enc, Y, stmt));
  const agg = proveAggregate(chunks, encs, row.v, sb(item.r), Y, item.C, stmt);
  const lawH = mod(mod(ctx.W) * sb(item.r) - mod(ctx.rate) * sb(item.rw) + item.rRho);
  const lawP = mulP(item.C, ctx.W).subtract(mulP(item.cw, ctx.rate)).add(item.rhoC).subtract(mulP(G, ctx.W * row.finEff));
  const law = proveH(lawP, lawH, stmt);
  const pad = BP_M - VE_CHUNKS - 2 * RHO_LIMBS;
  const values = [...encs.map((e) => e.m), ...item.rhoLimbs, ...item.delLimbs, ...new Array(pad).fill(0n)];
  const blinds = [...encs.map((e) => e.s), ...item.sRho, ...item.sDel, ...new Array(pad).fill(0n)];
  const bp = bpProve(values, blinds, BP_N, bpSeed(stmt, item.index));
  return {
    ...item.pub,
    ra: { chunks, agg },
    law,
    rangeProof: { tag: RANGE_TAG, bp },
  };
}

function proveTally(items, shares, W, stmt) {
  const lambdas = items.map((it) => it.row.vch.lambda);
  const picked = pickChallenge(stmt, lambdas);
  if (!picked) throw fail('split_tally');
  const { X } = picked;
  const inv = [];
  let hShare = 0n;
  for (const s of shares) {
    const a = Fn.sub(X, s.ell);
    if (Fn.is0(a)) throw fail('split_tally');
    const ai = Fn.inv(a);
    const rInv = randomScalar();
    const Cb = mulP(G, ai).add(H.multiply(rInv));
    const Ca = mulP(G, X).subtract(pointFrom(s.E));
    inv.push({ Cinv: pointBytes(Cb), proof: proveProduct(Ca, a, mod(-sb(s.beta)), Cb, rInv, stmt) });
    hShare = mod(hShare + mod(s.w) * sb(rInv));
  }
  let Crow = Point.ZERO;
  let hRow = 0n;
  let sumW = Point.ZERO;
  let hW = 0n;
  items.forEach((it, i) => {
    const d = Fn.inv(Fn.sub(X, lambdas[i]));
    Crow = Crow.add(it.cw.multiply(d));
    hRow = mod(hRow + d * sb(it.rw));
    sumW = sumW.add(it.cw);
    hW = mod(hW + sb(it.rw));
  });
  let Cshare = Point.ZERO;
  inv.forEach((p, i) => { Cshare = Cshare.add(mulP(pointFrom(p.Cinv), shares[i].w)); });
  return {
    n: picked.n,
    inv,
    balance: proveH(Cshare.subtract(Crow), hShare - hRow, stmt),
    weight: proveH(sumW.subtract(mulP(G, W)), hW, stmt),
  };
}

function vaultRow(ctx, vrow, index) {
  const B = pointOk(vrow.B);
  const v = scalarOk(vrow.vaultNanos);
  if (!B || v == null || v <= 0n) throw fail('vault_pin');
  const built = vaultCommit(v, vrow.mintId, ctx.height, ctx.prevHash);
  if (!built) throw fail('vault_pin');
  const delta = payoutDelta({ magic: ctx.magic, height: ctx.height, prevHash: ctx.prevHash, index, commit: built.commit });
  const P = B.add(G.multiply(delta));
  if (!rowIsLeaf({ admitPub: pointBytes(P), commit: built.commit })) throw fail('vault_pin');
  return {
    kind: 'vault-withdraw-pinned',
    kindCode: VAULT_KIND_CODE,
    vaultNanos: v.toString(),
    mintId: Buffer.from(asU8(vrow.mintId)),
    B: pointBytes(B),
    commit: built.commit,
    admitPub: pointBytes(P),
    noteCommit: sha(Buffer.from('shear-t21-vault-v1'), Buffer.from(asU8(vrow.mintId)), pointBytes(B)),
  };
}

/** Public levy rows (the reserve half) go last, inside the statement. */
function publicRows(spec) {
  const rows = spec.publicRows || [];
  for (const r of rows) if (r?.kind !== 'reserve-fee' || hasKey(r, 'kindCode')) throw fail('cb_form');
  return rows;
}

function emptyCoinbase(spec, deferred) {
  const S = scalarOk(spec.S);
  const cin = scalarOk(spec.cin);
  if (S == null || cin == null) throw fail('pot_sched');
  const ctx = { magic: spec.magic, height: spec.height, prevHash: spec.prevHash };
  const vaults = (spec.vaults || []).map((v, i) => vaultRow(ctx, v, i)).concat(publicRows(spec));
  const tx = {
    coinbase: true,
    cbForm: CB_FORM,
    height: spec.height,
    vin: [{ coinbase: true, height: spec.height }],
    vout: vaults,
    carryNanos: Number(cin + S),
    t21: {
      S: S.toString(),
      cin: cin.toString(),
      bps: 0,
      u: '0',
      height: spec.height,
      magic: spec.magic,
      prevHash: Buffer.from(asU8(spec.prevHash)),
      shares: [],
    },
  };
  tx.t21.stmt = statementOf(tx);
  return { tx, deferred, batch: [], secrets: [], W: 0n, f: 0n, phi: 0n, dust: cin + S };
}

function buildOnce(spec, payees, deferred) {
  const random = spec.random || randomScalar;
  const planned = planPay(spec, payees);
  if (planned.W === 0n) return emptyCoinbase(spec, deferred);
  const ctx = {
    magic: spec.magic, height: spec.height, prevHash: spec.prevHash, random, W: planned.W, rate: planned.rate,
  };
  const rows = planned.rows.map((g) => ({
    payee: g._index, noLeaf: !!g.forceNonLeaf, kind: 'pot', vch: g._vch, v: g.v, Wi: g.Wi, rho: g.rho, finEff: g.fin, finPub: g.fin,
  }));
  if (planned.f > 0n) {
    const vch = voucherPoints(spec.fee?.voucher);
    if (!vch || !voucherKeysOk(spec.fee.voucher)) throw fail('fee_sched');
    rows.push({ kind: 'pool-fee', vch, v: planned.f, Wi: 0n, rho: 0n, finEff: planned.f, finPub: 0n });
  }
  const dummySecret = spec.dummySecret || randomBytes(32);
  for (let ctr = 0; rows.filter((r) => r.kind === 'pot').length < K_MIN && ctr < 64; ctr += 1) {
    const vch = voucherAt(dummySecret, (spec.dummyStart || 0) + ctr);
    const pub = { B: pointBytes(vch.B), Y: pointBytes(vch.Y), lambda: vch.lambdaBytes };
    if (!voucherKeysOk(pub)) continue;
    rows.push({ kind: 'pot', vch: voucherPoints(pub), v: 0n, Wi: 0n, rho: 0n, finEff: 0n, finPub: 0n });
  }
  // Row order is shuffled so a dummy's position does not mark it.
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const j = Number(bytesToNumberLE(randomBytes(6)) % BigInt(i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  const items = rows.map((row, i) => commitRow(ctx, row, i));
  const vaults = (spec.vaults || []).map((v, i) => vaultRow(ctx, v, items.length + i)).concat(publicRows(spec));
  const shares = [];
  for (const p of payees) {
    for (const s of p.shares || []) shares.push({ w: BigInt(s.w), E: Buffer.from(asU8(s.E)), ell: s.ell, beta: s.beta });
  }
  const skel = {
    coinbase: true,
    cbForm: CB_FORM,
    carryNanos: Number(planned.dust),
    vout: items.map((it) => it.pub).concat(vaults),
    t21: {
      S: planned.S.toString(),
      cin: planned.cin.toString(),
      bps: Number(planned.bps),
      u: planned.u.toString(),
      height: spec.height,
      magic: spec.magic,
      prevHash: Buffer.from(asU8(spec.prevHash)),
      shares: shares.map((s) => ({ w: s.w.toString(), E: s.E })),
    },
  };
  const stmt = statementOf(skel);
  const proved = items.map((it) => proveRow(ctx, it, stmt));
  const tally = proveTally(items, shares, planned.W, stmt);
  const mintG = planned.S + planned.cin - planned.dust + planned.u * planned.W + planned.phi;
  let sumC = Point.ZERO;
  let h = 0n;
  for (const it of items) {
    sumC = sumC.add(it.C);
    h = mod(h + sb(it.r));
  }
  const mint = proveH(sumC.subtract(mulP(G, mintG)), h, stmt);
  const tx = {
    coinbase: true,
    cbForm: CB_FORM,
    height: spec.height,
    vin: [{ coinbase: true, height: spec.height }],
    vout: proved.concat(vaults),
    carryNanos: Number(planned.dust),
    excess: scalarBytes(h),
    t21: { ...skel.t21, tally, mint, stmt },
  };
  return {
    tx,
    deferred,
    batch: payees.flatMap((p) => (p.shares || []).map((s) => ({ E: Buffer.from(asU8(s.E)), w: BigInt(s.w) }))),
    secrets: items.map((it) => ({ kind: it.row.kind, v: it.row.v, r: it.r, index: it.index })),
    W: planned.W,
    f: planned.f,
    phi: planned.phi,
    dust: planned.dust,
    paid: mintG,
  };
}

/**
 * Template builder. A payee is { voucher: {B, Y, lambda}, fin?, shares: [{w, E, ell, beta}] },
 * with lambda = voucherLambda(B, Y).
 * A voucher that fails voucherKeysOk is deferred before proving. A payee whose
 * row cannot be made an FS-1 leaf throws admit_note_point; that payee and its
 * shares are evicted to `deferred` and the coinbase is rebuilt once. There is
 * no last-payee re-split.
 */
export function buildT21Coinbase(spec) {
  const deferred = [];
  const live = [];
  // Tests pass a permissive check to build what a dishonest pool would publish.
  const keysOk = spec.voucherOk || voucherKeysOk;
  (spec.payees || []).forEach((p) => {
    const vch = voucherPoints(p.voucher);
    if (!vch || !keysOk(p.voucher)) {
      deferred.push({ voucher: p.voucher, shares: p.shares || [], reason: 'voucher_key' });
      return;
    }
    live.push({ ...p, _vch: vch });
  });
  const withIndex = (list) => list.map((p, i) => ({ ...p, _index: i }));
  let payees = withIndex(live);
  if (!payees.length) return emptyCoinbase(spec, deferred);
  try {
    return buildOnce(spec, payees, deferred);
  } catch (err) {
    if (err.reason !== 'admit_note_point' || err.payee == null) throw err;
    const bad = payees[err.payee];
    deferred.push({ voucher: bad.voucher, shares: bad.shares || [], reason: 'admit_note_point' });
    payees = withIndex(payees.filter((_, i) => i !== err.payee).map(({ _index, ...rest }) => rest));
    if (!payees.length) return emptyCoinbase(spec, deferred);
    return buildOnce(spec, payees, deferred);
  }
}

/* ---------- verifier ---------- */

function payoutRows(tx) {
  return (tx.vout || []).filter((o) => Number(o?.kindCode) === PAYOUT_KIND_CODE);
}

function vaultRows(tx) {
  return (tx.vout || []).filter((o) => Number(o?.kindCode) === VAULT_KIND_CODE || o?.kind === 'vault-withdraw-pinned');
}

function sameBytes(a, b) {
  try {
    return Buffer.from(asU8(a)).equals(Buffer.from(asU8(b)));
  } catch {
    return false;
  }
}

/**
 * Consensus verify. `expect` is chain state, never the coinbase:
 *   S (subsidy at this height), cin (parent carry), u (hash-bonus unit),
 *   height, magic, prevHash,
 *   shares: [{ nc, units }], the block's retained share units per note commit
 *     (the proven batch, or the header-bound aLeaves of a buried pruned block),
 *   hashBudget: B_h in nanos; u·W must not exceed it,
 *   prevEs: E_s hex set of the parent coinbase (carry window),
 *   vaults: pending pinned withdraws [{ mintId, vaultNanos, B }].
 * Returns paid = S + c_in − c_out + u·W + Φ, Φ, and the finder row's B*.
 */
export function verifyT21Coinbase(input) {
  const tx = input?.tx;
  const expect = input?.expect;
  DEC.clear();
  if (!isT21Coinbase(tx)) return no('cb_form');
  if (!expect || typeof expect !== 'object') return no('pot_sched');
  const vout = Array.isArray(tx.vout) ? tx.vout : [];
  if (vout.length > OUTPUT_MAX) return no('tx_cap');
  const t21 = tx.t21 || {};
  const shares = Array.isArray(t21.shares) ? t21.shares : [];
  if (shares.length > N_MAX) return no('split_cap');
  for (const s of shares) {
    const w = scalarOk(s?.w);
    if (w == null || w <= 0n || w > W_S_MAX) return no('split_cap');
  }
  for (const o of vout) {
    if (!o || typeof o !== 'object') return no('cb_form');
    // The reserve half of the levy is a public row; coinbaseLevyPays opens it.
    if (o.kind === 'reserve-fee' && !hasKey(o, 'kindCode')) continue;
    if (hasKey(o, 'amtCt') && Buffer.from(asU8(o.amtCt)).length !== 8) return no('amount_ct');
    const vault = Number(o.kindCode) === VAULT_KIND_CODE || o.kind === 'vault-withdraw-pinned';
    if (!vault) {
      for (const k of AMOUNT_KEYS) if (hasKey(o, k)) return no('amount_field');
      if (hasKey(o, 'valueProof')) return no('value_open');
    } else if (hasKey(o, 'nonce') || hasKey(o, 'userR')) {
      return no('vault_pin');
    }
    if (!vault && Number(o.kindCode) !== PAYOUT_KIND_CODE) return no('cb_form');
  }
  const payout = payoutRows(tx);
  const payees = payout.filter((o) => o.kind !== 'pool-fee');
  if (payees.length > L_MAX) return no('payee_cap');
  const S = scalarOk(t21.S);
  const cin = scalarOk(t21.cin);
  const u = scalarOk(t21.u || 0);
  const bps = t21Big(t21.bps);
  const cout = scalarOk(tx.carryNanos || 0);
  if (S == null || cin == null || u == null || cout == null || bps == null) return no('split_cap');
  // B3: the public scalars are chain state.
  if (S !== BigInt(expect.S) || cin !== BigInt(expect.cin)) return no('pot_sched');
  if (cout > S + cin) return no('pot_sched');
  if (String(t21.height) !== String(expect.height) || String(t21.magic) !== String(expect.magic)
    || !sameBytes(t21.prevHash, expect.prevHash)) {
    return no('cb_form');
  }
  if (bps < 0n || bps > BigInt(FEE_BPS_MAX)) return no('fee_sched');
  const f = feeOf(S, bps);
  if (f == null) return no('fee_sched');
  const vaultPaid = checkVaults(tx, expect);
  if (!vaultPaid.ok) return vaultPaid;
  if (shares.length === 0) {
    if (payout.length) return no('pot_carry');
    if (cout !== cin + S) return no('pot_sched');
    if (f !== 0n || u !== 0n) return no('fee_sched');
    if (!Array.isArray(expect.shares) || expect.shares.length) return no('share_bind');
    if (!sameBytes(t21.stmt, statementOf(tx))) return no('split_law');
    return { ok: true, reason: null, paid: 0n, phi: 0n, W: 0n, f: 0n, finB: null, vaultPaid: vaultPaid.paid };
  }
  if (u !== BigInt(expect.u)) return no('pot_sched');
  if (payees.length < K_MIN) return no('payee_cap');
  const feeRows = payout.filter((o) => o.kind === 'pool-fee');
  if (f > 0n ? feeRows.length !== 1 : feeRows.length !== 0) return no('fee_sched');
  for (const o of payout) {
    if (!PAYOUT_KINDS.has(String(o.kind || ''))) return no('cb_form');
  }
  // B4: one proven batch share per published share, same weight.
  let W = 0n;
  const seenE = new Set();
  for (const s of shares) {
    if (Object.keys(s).some((k) => k !== 'w' && k !== 'E')) return no('share_label');
    if (!pointOk(s.E)) return no('share_label');
    const hex = Buffer.from(asU8(s.E)).toString('hex');
    if (seenE.has(hex)) return no('share_label');
    if (expect.prevEs && expect.prevEs.has(hex)) return no('share_label');
    seenE.add(hex);
    W += BigInt(s.w);
  }
  if (W <= 0n || W >= W_MAX) return no('split_cap');
  if (W > W_HASH_MAX) return no('hash_units');
  let Bh;
  try {
    Bh = BigInt(expect.hashBudget);
  } catch {
    return no('hash_budget');
  }
  if (Bh < 0n || u * W > Bh) return no('hash_budget');
  if (!Array.isArray(expect.shares) || expect.shares.length !== shares.length) return no('share_bind');
  const pool = new Map();
  for (const p of expect.shares) {
    const k = `${Buffer.from(asU8(p.nc)).toString('hex')}:${String(p.units)}`;
    pool.set(k, (pool.get(k) || 0) + 1);
  }
  for (const s of shares) {
    const k = `${t21ShareNc(t21.magic, s.E).toString('hex')}:${String(s.w)}`;
    const n = pool.get(k) || 0;
    if (!n) return no('share_bind');
    pool.set(k, n - 1);
  }
  let fins = 0;
  let phi = 0n;
  let finB = null;
  const seenL = new Set();
  const parsed = [];
  for (const o of payout) {
    for (const k of ['commit', 'admitPub', 'B', 'Y', 'lambda', 'rEph', 'rCt', 'cw', 'noteCommit']) {
      if (!bytes32(o[k])) return no('cb_form');
    }
    if (!o.amtCt) return no('amount_ct');
    if (!o.ra || !Array.isArray(o.ra.chunks) || o.ra.chunks.length !== VE_CHUNKS) return no('cb_form');
    if (!Array.isArray(o.rhoK) || o.rhoK.length !== RHO_LIMBS || !Array.isArray(o.delK) || o.delK.length !== RHO_LIMBS) {
      return no('cb_form');
    }
    for (const c of o.ra.chunks) {
      if (!c || Object.keys(c).some((k) => !CHUNK_KEYS.includes(k))) return no('cb_wrap');
    }
    if (o.ra.agg && Object.keys(o.ra.agg).some((k) => !AGG_KEYS.includes(k))) return no('cb_wrap');
    const fin = scalarOk(o.fin || 0);
    if (fin == null) return no('split_cap');
    if (o.kind === 'pool-fee' && fin !== 0n) return no('fee_sched');
    if (fin > 0n) {
      fins += 1;
      phi += fin;
      finB = Buffer.from(asU8(o.B));
    }
    const lam = Buffer.from(asU8(o.lambda)).toString('hex');
    if (seenL.has(lam)) return no('split_label');
    seenL.add(lam);
    const B = pointOk(o.B);
    const Y = pointOk(o.Y);
    const C = pointOk(o.commit);
    const P = pointOk(o.admitPub);
    const CW = pointOk(o.cw);
    const lamS = scalarOkBytes(o.lambda);
    if (!B || !Y || !C || !P || !CW || lamS == null) return no('cb_point');
    if (lamS !== voucherLambda(o.B, o.Y)) return no('split_label');
    const rhoK = o.rhoK.map(pointOk);
    const delK = o.delK.map(pointOk);
    for (const c of o.ra.chunks) {
      if (!pointOk(c.epV) || !pointOk(c.epD) || !pointOk(c.Mpt)) return no('cb_point');
    }
    // A zero limb with a zero blind is the identity, which pointOk refuses; ρ limbs always carry a random blind.
    if (rhoK.some((K) => !K) || delK.some((K) => !K)) return no('cb_point');
    const delta = payoutDelta({ magic: t21.magic, height: t21.height, prevHash: t21.prevHash, index: vout.indexOf(o), commit: o.commit });
    if (Fn.is0(delta) || !B.add(G.multiply(delta)).equals(P)) return no('cb_key');
    if (!rowIsLeaf(o)) return no('admit_note_point');
    parsed.push({ o, B, Y, C, CW, lamS, rhoK, delK, fin, index: vout.indexOf(o) });
  }
  if (fins > 1) return no('finder_row');
  const R = S + cin - f;
  if (R < 0n) return no('pot_sched');
  // Full-pot carry is empty-batch only. The law remainder Σρ/W is always carried.
  // Σρ_i/W with every ρ_i < W, so c_out is below the payout row count.
  if (cout >= BigInt(payout.length)) return no('pot_carry');
  const stmt = statementOf(tx);
  if (!sameBytes(t21.stmt, stmt)) return no('split_law');
  const mintG = S + cin - cout + u * W + phi;
  const rate = R + W * u;
  const checks = buildChecks({ tx, parsed, shares, W, rate, f, mintG, stmt });
  if (!checks.ok) return checks;
  const weighted = [];
  for (const c of checks.list) for (const t of c.terms) weighted.push([t, weight128()]);
  if (!msmZero(weighted)) {
    for (const c of checks.list) {
      if (!msmZero(c.terms.map((t) => [t, weight128()]))) return no(c.reason);
    }
    return no('split_law');
  }
  return {
    ok: true, reason: null, paid: mintG, phi, W, f, finB, vaultPaid: vaultPaid.paid,
  };
}

function checkVaults(tx, expect) {
  const rows = vaultRows(tx);
  const pending = Array.isArray(expect.vaults) ? expect.vaults.slice() : [];
  let paid = 0n;
  for (const vrow of rows) {
    const i = pending.findIndex((p) => sameBytes(p.mintId, vrow.mintId)
      && String(p.vaultNanos) === String(vrow.vaultNanos) && sameBytes(p.B, vrow.B));
    if (i < 0) return no('vault_pin');
    pending.splice(i, 1);
    const B = pointOk(vrow.B);
    const want = vaultCommit(vrow.vaultNanos, vrow.mintId, expect.height, expect.prevHash);
    if (!B || !want || !sameBytes(vrow.commit, want.commit)) return no('vault_pin');
    const delta = payoutDelta({
      magic: expect.magic, height: expect.height, prevHash: expect.prevHash, index: tx.vout.indexOf(vrow), commit: vrow.commit,
    });
    if (!B.add(G.multiply(delta)).equals(pointOk(vrow.admitPub) || Point.ZERO)) return no('vault_pin');
    if (!rowIsLeaf(vrow)) return no('admit_note_point');
    paid += BigInt(vrow.vaultNanos);
  }
  return { ok: true, paid };
}

/** Every equation as terms, grouped by the reject it maps to, in rule order. */
function buildChecks({ tx, parsed, shares, W, rate, f, mintG, stmt }) {
  const t21 = tx.t21;
  const list = [];
  // T-8 tally.
  const tally = t21.tally;
  if (!tally || !Array.isArray(tally.inv) || tally.inv.length !== shares.length) return no('split_tally');
  const picked = pickChallenge(stmt, parsed.map((p) => p.lamS));
  if (!picked || picked.n !== tally.n) return no('split_tally');
  const { X } = picked;
  const tallyTerms = [];
  const shareCb = [];
  const ws = [];
  for (let i = 0; i < shares.length; i += 1) {
    const Cb = pointOk(tally.inv[i]?.Cinv);
    if (!Cb) return no('split_tally');
    const Ca = mulP(G, X).subtract(pointOk(shares[i].E));
    const pt = productTerms(Ca, Cb, tally.inv[i].proof, stmt);
    if (!pt) return no('split_tally');
    tallyTerms.push(...pt);
    shareCb.push(Cb);
    ws.push(mod(BigInt(shares[i].w)));
  }
  const rowCw = parsed.map((p) => p.CW);
  const inv = parsed.map((p) => {
    const d = Fn.sub(X, p.lamS);
    return Fn.is0(d) ? null : Fn.inv(d);
  });
  if (inv.some((d) => d == null)) return no('split_tally');
  const balP = Point.msm([...shareCb, ...rowCw], [...ws, ...inv.map((d) => mod(-d))].map(mod));
  const bal = hTerms(balP, tally.balance, stmt);
  let sumW = Point.ZERO;
  for (const p of parsed) sumW = sumW.add(p.CW);
  const wt = hTerms(sumW.subtract(mulP(G, W)), tally.weight, stmt);
  if (!bal || !wt) return no('split_tally');
  list.push({ reason: 'split_tally', terms: [...tallyTerms, bal, wt] });
  // T-9 law and the two-sided ρ range identity.
  const lawTerms = [];
  for (const p of parsed) {
    const finEff = p.o.kind === 'pool-fee' ? f : p.fin;
    let rhoC = Point.ZERO;
    for (let i = 0; i < RHO_LIMBS; i += 1) rhoC = rhoC.add(mulP(p.rhoK[i], 1n << (16n * BigInt(i))));
    const lawP = mulP(p.C, W).subtract(mulP(p.CW, rate)).add(rhoC).subtract(mulP(G, W * finEff));
    const lt = hTerms(lawP, p.o.law, stmt);
    if (!lt) return no('split_law');
    lawTerms.push(lt);
    const sum = new Terms().add(G, -(W - 1n));
    for (let i = 0; i < RHO_LIMBS; i += 1) {
      sum.add(p.rhoK[i], 1n << (16n * BigInt(i)));
      sum.add(p.delK[i], 1n << (16n * BigInt(i)));
    }
    lawTerms.push(sum);
  }
  list.push({ reason: 'split_law', terms: lawTerms });
  // T-10 mint.
  let sumC = Point.ZERO;
  for (const p of parsed) sumC = sumC.add(p.C);
  const mt = hTerms(sumC.subtract(mulP(G, mintG)), t21.mint, stmt);
  const excess = scalarOkBytes(tx.excess);
  if (!mt || excess == null) return no('split_mint');
  const ex = new Terms().add(G, mintG).add(H, excess);
  for (const p of parsed) ex.add(p.C, -1n);
  list.push({ reason: 'split_mint', terms: [mt, ex] });
  // T-5 R-A′.
  const wrap = [];
  for (const p of parsed) {
    for (const c of p.o.ra.chunks) {
      const ct = chunkTerms(c, p.Y, stmt);
      if (!ct) return no('cb_wrap');
      wrap.push(...ct);
    }
    const at = aggTerms(p.o.ra.chunks, p.Y, p.C, p.o.ra.agg, stmt);
    if (!at) return no('cb_wrap');
    wrap.push(...at);
  }
  list.push({ reason: 'cb_wrap', terms: wrap });
  // T-6 range: 0x02 tag, one aggregated proof per row.
  const range = [];
  for (const p of parsed) {
    const rp = p.o.rangeProof;
    if (!rp || rp.tag !== RANGE_TAG || !rp.bp) return no('range_proof');
    const pad = BP_M - VE_CHUNKS - 2 * RHO_LIMBS;
    const V = [
      ...p.o.ra.chunks.map((c) => pointOk(c.Mpt)),
      ...p.rhoK,
      ...p.delK,
      ...new Array(pad).fill(Point.ZERO),
    ];
    const Vb = [...p.o.ra.chunks.map((c) => c.Mpt), ...p.o.rhoK, ...p.o.delK, ...new Array(pad).fill(new Uint8Array(32))];
    let t;
    try {
      t = bpVerifyTerms(V, rp.bp, BP_N, bpSeed(stmt, p.index), 1n, Vb);
    } catch {
      t = null;
    }
    if (!t) return no('range_proof');
    range.push(t);
  }
  list.push({ reason: 'range_proof', terms: range });
  return { ok: true, list };
}

/* ---------- wallet ---------- */

/**
 * One wallet path (T1). Find the voucher whose B* is on the row and whose
 * P − δ·G matches, then try amtCt, then VE, and accept only on the C check.
 */
export function openOutput(row, walletSecret, ctx, { start = 0, gap = 256 } = {}) {
  let misses = 0;
  let vch = null;
  for (let c = start; misses < gap && c < start + 1_000_000; c += 1) {
    const v = voucherAt(walletSecret, c);
    try {
      if (sameBytes(pointBytes(v.B), row.B)) {
        const delta = payoutDelta({ ...ctx, commit: row.commit });
        if (v.B.add(G.multiply(delta)).equals(pointFrom(row.admitPub))) {
          vch = v;
          break;
        }
      }
    } catch { /* not this row */ }
    misses += 1;
  }
  if (!vch) return null;
  const amt = openNoteAmount(row, vch.b);
  if (amt && commit(amt.v, scalarFrom(amt.r)).equals(pointFrom(row.commit))) {
    return { v: amt.v, r: scalarFrom(amt.r), via: 'amtCt', ctr: vch.ctr };
  }
  const ve = decryptVe(row, vch.y);
  if (!ve || !commit(ve.v, ve.r).equals(pointFrom(row.commit))) return null;
  return { v: ve.v, r: ve.r, via: 've', ctr: vch.ctr };
}

/* ---------- observer harness ---------- */

function RESERVE_ROW(o) {
  return Number(o?.kindCode) === VAULT_KIND_CODE || o?.kind === 'vault-withdraw-pinned'
    || o?.kind === 'lock' || o?.kind === 'vote' || o?.kind === 'withdraw' || o?.kind === 'reserve-fee';
}

function walk(value, visit, path = []) {
  if (value == null) return;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    visit(Buffer.from(value), path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, visit, path.concat(i)));
    return;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      visit(k, path.concat(k), true);
      walk(value[k], visit, path.concat(k));
    }
    return;
  }
  visit(value, path);
}

/**
 * Observer harness. Looks at the public coinbase as a chain observer would
 * and reports every way it finds to a per-row amount:
 *  - an amount key or limb list on a hidden row;
 *  - a share that names a row (any share byte string equal to a row field);
 *  - a byte string or integer anywhere in the tx equal to a known v_i,
 *    its u64le, or its 16-bit limbs (only with `truth`, for tests).
 */
export function observerView(tx, { truth = [] } = {}) {
  const leaks = [];
  const fins = [];
  const vout = tx?.vout || [];
  vout.forEach((o, index) => {
    if (RESERVE_ROW(o)) return;
    for (const k of AMOUNT_KEYS) if (hasKey(o, k)) leaks.push({ index, key: k });
    if (hasKey(o, 'valueProof')) leaks.push({ index, key: 'valueProof' });
    walk(o, (v, path, isKey) => {
      if (isKey && (/limb/i.test(String(v)) || /^[mvts]$/.test(String(v)))) leaks.push({ index, key: path.join('.') });
    });
    if ((t21Big(o.fin || 0) || 0n) > 0n) fins.push(index);
  });
  const rowBytes = new Set();
  for (const o of vout) {
    walk(o, (v) => { if (Buffer.isBuffer(v) && v.length >= 16) rowBytes.add(v.toString('hex')); });
  }
  (tx?.t21?.shares || []).forEach((s, i) => {
    for (const k of Object.keys(s)) if (k !== 'w' && k !== 'E') leaks.push({ share: i, key: k });
    walk(s, (v) => { if (Buffer.isBuffer(v) && rowBytes.has(v.toString('hex'))) leaks.push({ share: i, key: 'row_link' }); });
  });
  for (const t of truth) {
    const v = BigInt(t.v);
    if (v < 1000n) continue;
    const needles = [u64le(v).toString('hex'), limbsOf(v, 4).map((l) => l.toString(16).padStart(4, '0')).join('')];
    walk(tx, (x, path, isKey) => {
      if (isKey) return;
      if (typeof x === 'bigint' || typeof x === 'number' || typeof x === 'string') {
        if (String(x) === v.toString() && !['S', 'cin', 'carryNanos', 'cout'].includes(path[path.length - 1])) {
          leaks.push({ amount: v.toString(), key: path.join('.') });
        }
      } else if (Buffer.isBuffer(x)) {
        const hex = x.toString('hex');
        if (needles.some((n) => hex.includes(n))) leaks.push({ amount: v.toString(), key: path.join('.') });
      }
    });
  }
  return {
    leaks,
    fins,
    rows: vout.filter((o) => !RESERVE_ROW(o)).length,
    totals: {
      S: tx?.t21?.S ?? null, cin: tx?.t21?.cin ?? null, cout: tx?.carryNanos ?? null, bps: tx?.t21?.bps ?? null, u: tx?.t21?.u ?? null,
    },
  };
}

export function supplyIdentities(built) {
  const paid = (built.secrets || []).reduce((a, s) => a + s.v, 0n);
  const t = built.tx.t21;
  const right = BigInt(t.S) + BigInt(t.cin) - BigInt(built.tx.carryNanos) + BigInt(t.u || 0) * built.W + built.phi;
  return { paid, fee: built.f, right, ok: paid === right };
}

/* ---------- genesis gate (087q §5) ---------- */

export const GENESIS_GATE = Object.freeze([
  { n: 1, item: 'S0–S8 code', ok: false, note: 'JS consensus path, builder, wallet open, observer harness. No node or pool template calls buildT21Coinbase yet; no ShearK v6 share preimage.' },
  { n: 2, item: 'Vectors on JS, Dart, and Rust', ok: false, note: 'JS and Rust (shear-fs1 tests/t21_vectors.rs) check t21_splitlaw.json and t21_voucher.txt. Dart is a follow-up.' },
  { n: 3, item: 'Observer harness', ok: true, note: 'observerView on a multi-payee block finds no amount, limb, or share-to-row link.' },
  { n: 4, item: 'Full-cap block inside 36,000 wu on the reference box', ok: false, note: 'Not measured on the reference box. Build box, JS: 6.1 KB and about 46 ms verify per row at 17 rows; prove about 3.4 s per row.' },
  { n: 5, item: 'O-1 and O-3 resolved; fingerprint frozen in one commit', ok: false, note: 'O-1: SEND_WEIGHT=25+25n, n<=8, reserve 2,336. FS-1 tree tokens from PR 78 are in. O-3 / M78-1 generator set is open; GEN_H pins note.js H.' },
  { n: 6, item: 'AL-1..7 including Dart', ok: false, note: 'amtCt and the txDigestV3 bind are cherry-picked from PR 81. Dart is a follow-up.' },
  { n: 7, item: 'SUP-V and KT-10/14/17; VP-0', ok: false, note: '0x23 rows need a chain pending-withdraw list; none is wired, so cb-v3 vault rows are refused.' },
  { n: 8, item: 'No plaintext amount on non-reserve outputs', ok: true, note: 'cb-v3 rows refuse nanos, amount, v, value, valueProof, and limb keys.' },
  { n: 9, item: 'Residuals documented', ok: true, note: 'specs/t21-coinbase.md' },
  { n: 10, item: 'PA, CA, ME, and PSA sign-off on S8', ok: false, note: 'CA review of the LogUp, R-A′ and range composition is required.' },
  { n: 11, item: 'cb-v3 is the only coinbase form once the genesis hash is set', ok: true, note: 't21CbOnly() is true whenever V12_GENESIS_BLOCK_HASH is set; verifyBlockConsensus rejects a legacy coinbase with cb_form.' },
]);

export function genesisGateStatus() {
  return {
    requireAllCoinbases: T21_REQUIRE_ALL_COINBASES,
    genH: GEN_H,
    items: GENESIS_GATE,
    open: GENESIS_GATE.filter((item) => !item.ok).map((item) => item.n),
  };
}

/** cb-v3 only: forced on by the genesis pin, or by the flag. */
export function t21CbOnly(genesisHash) {
  return T21_REQUIRE_ALL_COINBASES || String(genesisHash || '') !== '';
}

export { T21_REQUIRE_ALL_COINBASES, SCALAR_MAX };

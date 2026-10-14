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
 * Law per row: W·v_i = (R + Φ + W·u)·W_i − ρ_i, 0 ≤ ρ_i < W, when the round
 * has shares. R = S + c_in − f and Φ is the levy's finder half, split by the
 * same weights. A public fin would redirect that half, so fin is 0. A round
 * with no shares pays Φ as one opened finder-fee note and does not fold it.
 * The pool fee is a hidden note that opens to the public f.
 * Mint: Σ C_i = (S + c_in − c_out − escrowPot + u·W_paid + Φ + settleV)·G + excess·H.
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
  randomScalar, scalarBytes, scalarFrom, wrapBlind,
} from './note.js';
import { feeOf, lawDust, scalarOk, splitLaw, t21Big } from './t21_law.js';
import { composeOwed, owedCapExceeded, priceWeights, settleDuty, weightPay } from './t21_escrow.js';
import { voucherAt, voucherKeysOk, voucherLambda } from './t21_voucher.js';
import { bpProve, bpVerifyTerms } from './t21_bp.js';
import { t21ProverEngine } from './t21_native.js';
import { K_VW, payeeCapLive } from './block_budget.js';
import {
  AMOUNT_KEYS, BP_M, BP_N, CB_FORM, DOM_CB, FEE_BPS_MAX, GEN_H,
  CB_SHARE_MAX, K_MIN, LOGUP_DOM, OUTPUT_MAX, PAYOUT_KIND_CODE, PAYOUT_KINDS,
  RANGE_TAG, RHO_LIMBS, R_CHUNKS, SCALAR_MAX, SHARE_BIND_DOM, T21_REQUIRE_ALL_COINBASES,
  T21_OWED_MAX, T21_OWED_TTL,
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

/* ---------- prover nonces ---------- */

const NONCE_DOM = Buffer.from('shear-t21-nonce-v1');
const NO_BIND = Buffer.alloc(0);

/**
 * Every prover nonce and blind is H_s(dom ‖ seed ‖ bind ‖ len ‖ label ‖ i ‖ j).
 * The seed is fresh per build. Phase-two nonces bind the statement. The
 * native prover derives the same values, so both produce the same bytes.
 */
export function t21Nonce(seed, label, i = 0, j = 0, bind = NO_BIND) {
  const l = Buffer.from(label);
  const s = hashToScalar(NONCE_DOM, Buffer.from(asU8(seed)), Buffer.from(asU8(bind)), Buffer.from([l.length]), l, u32le(i), u32le(j));
  return Fn.is0(s) ? 1n : s;
}

/* ---------- Schnorr on H ---------- */

function proveH(P, s, extra, k) {
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

/** Pool side: the same label from a public voucher. λ is public, so the pool can issue E per job. */
export function poolShareLabel(vchPub) {
  const lam = bytesToNumberLE(Uint8Array.from(asU8(vchPub.lambda)));
  if (lam <= 0n || lam >= Fn.ORDER) return null;
  return minerShare({ lambda: lam }, 1n);
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

export function encryptLimb(m, Y, t, s) {
  const epV = G.multiply(t);
  const epD = Y.multiply(t).add(mulP(G, m));
  const M = commit(m, s);
  return { m, t, s, epV, epD, M };
}

function finishChunk(enc, Y, extra, kT, kS) {
  const { t, s, epV, epD, M } = enc;
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

function proveAggregate(chunks, encs, v, r, Y, C, extra, nk) {
  let Tv = 0n;
  let Tr = 0n;
  for (let j = 0; j < V_CHUNKS; j += 1) Tv = Fn.add(Tv, Fn.mul(mod(1n << (16n * BigInt(j))), encs[j].t));
  for (let j = 0; j < R_CHUNKS; j += 1) Tr = Fn.add(Tr, Fn.mul(mod(1n << (16n * BigInt(j))), encs[V_CHUNKS + j].t));
  const kv = nk('agg-kv');
  const kr = nk('agg-kr');
  const ktv = nk('agg-ktv');
  const ktr = nk('agg-ktr');
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

function proveProduct(Ca, a, ra, Cb, rInv, extra, kA, kBlind, kR) {
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

/** Owed rows bind the voucher, the producer, the sealed value, and each share. The open proof is not in T_stmt. */
function owedStmt(o) {
  const shares = Array.isArray(o?.shares) ? o.shares : [];
  return {
    since: String(o.since),
    by: bytes32(o.by) || Buffer.alloc(0),
    B: bytes32(o.B) || Buffer.alloc(0),
    Y: bytes32(o.Y) || Buffer.alloc(0),
    lambda: bytes32(o.lambda) || Buffer.alloc(0),
    pot: String(o.pot),
    hash: String(o.hash),
    shares: shares.map((s) => ({ w: String(s.w), E: bytes32(s.E) || Buffer.alloc(0) })),
  };
}

/**
 * T_stmt. Every public input of every proof. Share labels ℓ_s are not here;
 * a share is (w_s, E_s) only.
 */
export function statementOf(tx) {
  const t21 = tx?.t21 || {};
  const rows = (tx?.vout || []).map((o) => ({
    kind: String(o.kind || ''),
    kindCode: Number(o.kindCode || 0),
    ...(bytes32(o.escrowE) ? { escrowE: bytes32(o.escrowE) } : {}),
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
  // Deferred rows join T_stmt only when present, so a coinbase without them keeps its vector bytes.
  const defer = Array.isArray(t21.defer) ? t21.defer : [];
  const owed = Array.isArray(t21.owed) ? t21.owed : [];
  const rowsOwed = defer.length || owed.length || (t21.back != null && t21.back !== '' && t21.back !== '0')
    || (t21.potCarry != null && t21.potCarry !== '' && t21.potCarry !== '0')
    ? {
        defer: defer.map((d) => ({ w: String(d.w), E: bytes32(d.E) || Buffer.alloc(0) })),
        owed: owed.map(owedStmt),
        ...(t21.back != null && t21.back !== '' && String(t21.back) !== '0' ? { back: String(t21.back) } : {}),
        ...(t21.potCarry != null && t21.potCarry !== '' && String(t21.potCarry) !== '0' ? { potCarry: String(t21.potCarry) } : {}),
      }
    : {};
  return sha(stable({
    ...rowsOwed,
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

function weightOf(p) {
  let Wi = 0n;
  for (const s of p.shares || []) {
    const w = scalarOk(s.w);
    if (w == null || w <= 0n || w > W_S_MAX) throw fail('split_cap');
    Wi += w;
  }
  return Wi;
}

function planPay(spec, payees, escrowPayees = [], foldPayees = []) {
  const S = scalarOk(spec.S);
  const cin = scalarOk(spec.cin);
  const bps = t21Big(spec.bps || 0);
  const u = scalarOk(spec.u || 0);
  if (S == null || cin == null || u == null || bps == null) throw fail('pot_sched');
  const f = feeOf(S, bps);
  if (f == null) throw fail('fee_sched');
  const R = S + cin - f;
  if (R < 0n) throw fail('pot_sched');
  const groups = [];
  let Wpaid = 0n;
  for (const p of payees) {
    const Wi = weightOf(p);
    const fin = scalarOk(p.fin || 0);
    if (fin == null) throw fail('split_cap');
    if (Wi === 0n && fin <= 0n) throw fail('split_cap');
    Wpaid += Wi;
    groups.push({ ...p, Wi, fin });
  }
  const escrow = [];
  let Wesc = 0n;
  for (const p of escrowPayees) {
    const Wi = weightOf(p);
    if (Wi <= 0n) throw fail('split_cap');
    Wesc += Wi;
    escrow.push({ ...p, Wi, fin: 0n });
  }
  const folding = [];
  let Wfold = 0n;
  for (const p of foldPayees) {
    const Wi = weightOf(p);
    if (Wi <= 0n) throw fail('split_cap');
    Wfold += Wi;
    folding.push({ ...p, Wi, fin: 0n });
  }
  const W = Wpaid + Wesc + Wfold;
  if (W >= W_MAX) throw fail('split_cap');
  // The finder half is split by weight with the pot. A fin on one voucher would
  // redirect it, so a working round rejects that. An empty round has no weights.
  const phiFold = W > 0n ? scalarOk(spec.phi || 0) : 0n;
  if (phiFold == null) throw fail('levy_split');
  if (W > 0n && groups.some((g) => g.fin > 0n)) throw fail('finder_row');
  const Rlaw = R + phiFold;
  if (W === 0n) {
    let phi = 0n;
    const rows = groups.map((g) => {
      phi += g.fin;
      return { ...g, v: g.fin, rho: 0n };
    });
    return {
      S, cin, f, bps, u, R, W, Wpaid, rate: 0n, phi, rows, escrow: [], folds: [], dust: 0n, escrowPot: 0n, escrowHash: 0n,
    };
  }
  const weights = [];
  for (const g of groups) if (g.Wi > 0n) weights.push(g.Wi);
  for (const g of escrow) weights.push(g.Wi);
  for (const g of folding) weights.push(g.Wi);
  const priced = priceWeights(Rlaw, u, weights);
  if (!priced || priced.dust == null || priced.W !== W) throw fail('pot_sched');
  let pricedAt = 0;
  const rows = groups.map((g) => {
    if (g.Wi === 0n) return { ...g, v: g.fin, rho: 0n };
    const law = splitLaw({ R: Rlaw, W, Wi: g.Wi, u, fin: 0n });
    if (!law) throw fail('pot_sched');
    pricedAt += 1;
    return { ...g, v: law.v, rho: law.rho, fin: 0n };
  });
  // Escrow pot is the reference floor, with no finder fin on an overflow row.
  const escrowRows = escrow.map((g) => {
    const pay = priced.rows[pricedAt];
    pricedAt += 1;
    return { ...g, pot: pay.pot, hash: pay.hash, v: pay.v, rho: pay.rho };
  });
  const foldRows = folding.map((g) => {
    const pay = priced.rows[pricedAt];
    pricedAt += 1;
    return { ...g, pot: pay.pot, hash: pay.hash, v: pay.v, rho: pay.rho };
  });
  const dust = lawDust([
    ...rows.map((r) => r.rho), ...escrowRows.map((r) => r.rho), ...foldRows.map((r) => r.rho),
  ], W);
  if (dust == null || dust !== priced.dust) throw fail('pot_sched');
  let escrowPot = 0n;
  let escrowHash = 0n;
  for (const g of escrowRows) {
    escrowPot += g.pot;
    escrowHash += g.hash;
  }
  for (const g of foldRows) {
    escrowPot += g.pot;
    escrowHash += g.hash;
  }
  return {
    S, cin, f, bps, u, R, W, Wpaid, rate: Rlaw + W * u, phi: phiFold,
    rows, escrow: escrowRows, folds: foldRows, dust, escrowPot, escrowHash,
  };
}

/** The owner's blind and amount wrap for a payout row, with the build's ephemeral scalar. */
function sealWrap(r, B, noteCommit, C, v, e) {
  return wrapBlind(r, B, Buffer.concat([Buffer.from(asU8(noteCommit)), Buffer.from(asU8(C))]), v, e);
}

/** Phase one: commitment, payout key, N-1 leaf, ρ limbs, AL-7 triple, VE ciphertexts. */
function commitRow(ctx, row, index) {
  const { B, Y } = row.vch;
  let r = null;
  let C = null;
  let P = null;
  for (let n = 0; n < (row.noLeaf ? 0 : LEAF_TRIES); n += 1) {
    const rr = ctx.nonce('r', index, n);
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
  const rw = ctx.nonce('rw', index);
  const cw = commit(row.Wi, rw);
  const rhoLimbs = limbsOf(row.rho, RHO_LIMBS);
  const sRho = rhoLimbs.map((_, k) => ctx.nonce('srho', index, k));
  let rRho = 0n;
  for (let i = 0; i < RHO_LIMBS; i += 1) rRho = mod(rRho + (1n << (16n * BigInt(i))) * sb(sRho[i]));
  const del = ctx.W - 1n - row.rho;
  const delLimbs = limbsOf(del, RHO_LIMBS);
  const sDel = [ctx.nonce('sdel', index, 0), ctx.nonce('sdel', index, 1)];
  const top = mod(-rRho - sb(sDel[0]) - (1n << 16n) * sb(sDel[1]));
  sDel.push(Fn.mul(top, Fn.inv(mod(1n << 32n))));
  const rhoK = rhoLimbs.map((m, i) => commit(m, sRho[i]));
  const delK = delLimbs.map((m, i) => commit(m, sDel[i]));
  const noteCommit = sha(Buffer.from('shear-t21-nc-v1'), row.vch.lambdaBytes, u32le(index));
  const sealed = sealWrap(r, B, noteCommit, pointBytes(C), row.v, ctx.nonce('wrap', index));
  const limbMs = [...limbsOf(row.v, V_CHUNKS), ...limbsOf(sb(r), R_CHUNKS)];
  const encs = limbMs.map((m, j) => encryptLimb(m, Y, ctx.nonce('enc-t', index, j), ctx.nonce('enc-s', index, j)));
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
  const { row, encs, index } = item;
  const Y = row.vch.Y;
  const nk = (label, j = 0) => ctx.nonce(label, index, j, stmt);
  const chunks = encs.map((enc, j) => finishChunk(enc, Y, stmt, nk('chunk-kt', j), nk('chunk-ks', j)));
  const agg = proveAggregate(chunks, encs, row.v, sb(item.r), Y, item.C, stmt, nk);
  const lawH = mod(mod(ctx.W) * sb(item.r) - mod(ctx.rate) * sb(item.rw) + item.rRho);
  const lawP = mulP(item.C, ctx.W).subtract(mulP(item.cw, ctx.rate)).add(item.rhoC).subtract(mulP(G, ctx.W * row.finEff));
  const law = proveH(lawP, lawH, stmt, nk('law'));
  const pad = BP_M - VE_CHUNKS - 2 * RHO_LIMBS;
  const values = [...encs.map((e) => e.m), ...item.rhoLimbs, ...item.delLimbs, ...new Array(pad).fill(0n)];
  const blinds = [...encs.map((e) => e.s), ...item.sRho, ...item.sDel, ...new Array(pad).fill(0n)];
  const bp = bpProve(values, blinds, BP_N, bpSeed(stmt, index), (label, k = 0) => nk(`bp-${label}`, k));
  return {
    ...item.pub,
    ra: { chunks, agg },
    law,
    rangeProof: { tag: RANGE_TAG, bp },
  };
}

function proveTally(items, shares, W, stmt, nonce) {
  const nk = (label, i = 0) => nonce(label, i, 0, stmt);
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
    const si = inv.length;
    const rInv = nk('tally-rinv', si);
    const Cb = mulP(G, ai).add(H.multiply(rInv));
    const Ca = mulP(G, X).subtract(pointFrom(s.E));
    const proof = proveProduct(Ca, a, mod(-sb(s.beta)), Cb, rInv, stmt, nk('prod-ka', si), nk('prod-kb', si), nk('prod-kr', si));
    inv.push({ Cinv: pointBytes(Cb), proof });
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
    balance: proveH(Cshare.subtract(Crow), hShare - hRow, stmt, nk('tally-bal')),
    weight: proveH(sumW.subtract(mulP(G, W)), hW, stmt, nk('tally-wt')),
  };
}

/** The JS prover steps, for scripts/t21_prover_vectors.mjs, which writes the native prover's vectors. */
export const t21ProverJs = Object.freeze({ commitRow, proveRow, proveTally });

function vaultRow(ctx, vrow, index) {
  const B = pointOk(vrow.B);
  const v = scalarOk(vrow.vaultNanos);
  if (!B || v == null || v <= 0n) throw fail('vault_pin');
  const built = vaultCommit(v, vrow.mintId, ctx.height, ctx.prevHash);
  if (!built) throw fail('vault_pin');
  const delta = payoutDelta({ magic: ctx.magic, height: ctx.height, prevHash: ctx.prevHash, index, commit: built.commit });
  const P = B.add(G.multiply(delta));
  if (!rowIsLeaf({ admitPub: pointBytes(P), commit: built.commit })) return null;
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

/**
 * KT-10 0x23 rows, starting at vout index `start`. Walks the oldest K_VW
 * pending withdraws in order. One whose row is an FS-1 leaf at the next
 * index must be paid there; one whose row is not is skipped and stays
 * pending (the blind is fixed, so only height and parent can change it).
 */
function planVaults(ctx, pending, start) {
  const rows = [];
  for (const p of (pending || []).slice(0, K_VW)) {
    const row = vaultRow(ctx, p, start + rows.length);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Public levy rows go last, inside the statement: the reserve half, and in a
 * round with no shares the finder half as one opened finder-fee note.
 */
function publicRows(spec, empty = false) {
  const rows = spec.publicRows || [];
  const ok = (r) => (r?.kind === 'reserve-fee' || (empty && r?.kind === 'finder-fee')) && !hasKey(r, 'kindCode');
  for (const r of rows) if (!ok(r)) throw fail('cb_form');
  return rows;
}

function hex32(b) {
  const x = bytes32(b);
  return x ? Buffer.from(x).toString('hex') : '';
}

function idBytes(value) {
  const b = bytes32(value);
  if (b) return b;
  if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  return null;
}

/** The row id is its least share commitment, so a later block cannot retarget it.
 *  A folded row pins that id: adding a share must not move the anchor. */
export function t21Anchor(row) {
  const pinned = idBytes(row?.id);
  if (pinned) return Buffer.from(pinned).toString('hex');
  const shares = Array.isArray(row?.shares) ? row.shares : [];
  let best = null;
  for (const s of shares) {
    const h = hex32(s.E);
    if (!h) return '';
    if (best == null || h < best) best = h;
  }
  return best || hex32(row?.E);
}

function copyOwedShare(s) {
  const out = { w: BigInt(s.w).toString(), E: Buffer.from(asU8(s.E)) };
  if (s.open) out.open = { Rpt: Buffer.from(asU8(s.open.Rpt)), z: Buffer.from(asU8(s.open.z)) };
  if (s.pot0 != null && s.pot0 !== '') out.pot0 = BigInt(s.pot0).toString();
  if (s.hash0 != null && s.hash0 !== '') out.hash0 = BigInt(s.hash0).toString();
  return out;
}

function cloneOwed(o) {
  const out = {
    since: Number(o.since),
    by: Buffer.from(asU8(o.by)),
    B: Buffer.from(asU8(o.B)),
    Y: Buffer.from(asU8(o.Y)),
    lambda: Buffer.from(asU8(o.lambda)),
    pot: BigInt(o.pot).toString(),
    hash: BigInt(o.hash).toString(),
    shares: (o.shares || []).map(copyOwedShare),
  };
  const id = idBytes(o.id);
  const folded = (o.shares || []).some((s) => s.pot0 != null && s.pot0 !== '');
  if (id && folded) out.id = Buffer.from(id);
  return out;
}

function boundText(share, row, key) {
  const pinned = share && share[`${key}0`];
  if (pinned != null && pinned !== '') return String(pinned);
  return String(row[key]);
}

function openBind(row, share) {
  return sha(
    Buffer.from('shear-t21-escrow-open-v1'),
    Buffer.from(asU8(share.E)),
    Buffer.from(String(share.w)),
    u64le(row.since),
    Buffer.from(asU8(row.by)),
    Buffer.from(asU8(row.B)),
    Buffer.from(asU8(row.Y)),
    Buffer.from(asU8(row.lambda)),
    Buffer.from(boundText(share, row, 'pot')),
    Buffer.from(boundText(share, row, 'hash')),
  );
}

function proveOpen(row, share, k) {
  const E = pointOk(share.E);
  const lam = scalarOkBytes(row.lambda);
  if (!E || lam == null) throw fail('share_label');
  return proveH(E.subtract(mulP(G, lam)), share.beta, openBind(row, share), k);
}

function openHolds(row, share) {
  const E = pointOk(share.E);
  const lam = scalarOkBytes(row.lambda);
  if (!E || lam == null || !share.open) return false;
  const t = hTerms(E.subtract(mulP(G, lam)), share.open, openBind(row, share));
  return !!t && msmZero([[t, 1n]]);
}

/** Carry that fits a JSON number stays on carryNanos. The rest is t21.potCarry. */
function splitCarry(total) {
  const n = BigInt(total);
  if (n < 0n) throw fail('pot_sched');
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) return { carryNanos: Number(n), potCarry: 0n };
  return { carryNanos: 0, potCarry: n };
}

function carryFields(parts) {
  const out = {};
  if (parts.potCarry > 0n) out.potCarry = parts.potCarry.toString();
  if (parts.back > 0n) out.back = parts.back.toString();
  return out;
}

/**
 * Wire fields. t21.defer is the flat (w, E) of this block's escrow shares.
 * t21.owed is the sealed list. back is escrow value returned to the pot.
 * An empty round can restate owed and return expired value; it cannot defer.
 */
function owedFields({ defer = [], owed = [], back = 0n, potCarry = 0n } = {}, empty = false) {
  if (empty && defer.length) throw fail('share_bind');
  const out = { ...carryFields({ potCarry, back }) };
  if (!empty && defer.length) out.defer = defer.map((d) => ({ w: BigInt(d.w).toString(), E: Buffer.from(asU8(d.E)) }));
  if (owed.length) out.owed = owed.map(cloneOwed);
  return out;
}

/**
 * The owed list after this block: owedIn minus settled ids and rows past
 * T21_OWED_TTL, then this block's fresh escrow. `paidE` is a set of anchors.
 * Expired value is `back` (pot + hash), returned to the pot.
 */
export function t21OwedNext({ owedIn = [], paidE = new Set(), fresh = [], folds = [], height }) {
  const tagged = (owedIn || []).map((o) => ({ ...o, id: t21Anchor(o) }));
  const got = composeOwed({
    owedIn: tagged,
    paid: paidE,
    fresh: fresh.map((o) => ({ ...o, id: t21Anchor(o) })),
    folds,
    height,
  });
  if (!got.ok) {
    const err = fail(got.reason);
    throw err;
  }
  return {
    owed: got.owed.map((o) => cloneOwed(o)),
    backPot: got.backPot,
    backHash: got.backHash,
    back: got.back,
  };
}

/** Entries of owedIn still payable at `height` (not past the TTL). */
export function t21OwedLive(owedIn, height) {
  const h = BigInt(height);
  return (owedIn || []).filter((o) => h - BigInt(o.since) <= BigInt(T21_OWED_TTL));
}

/** The owed list a cb-v3 coinbase published, as the next block's owedIn. Not cb-v3: none. */
export function t21OwedOf(tx) {
  if (!isT21Coinbase(tx)) return [];
  return (Array.isArray(tx.t21?.owed) ? tx.t21.owed : []).map((o) => cloneOwed(o));
}

/** Law dust, or the whole pot of an empty round. Escrow returned on TTL is not in this. */
export function t21DustCarry(tx) {
  if (tx == null) return 0n;
  let nanos = 0n;
  if (tx.carryNanos != null && tx.carryNanos !== '') {
    try {
      nanos = BigInt(tx.carryNanos);
    } catch {
      return null;
    }
    if (typeof tx.carryNanos === 'number' && !Number.isSafeInteger(tx.carryNanos)) return null;
    if (nanos < 0n) return null;
  }
  const pot = tx.t21?.potCarry != null && tx.t21.potCarry !== '' ? t21Big(tx.t21.potCarry) : 0n;
  if (pot == null || pot < 0n) return null;
  return nanos + pot;
}

/** Next block's carry input: law dust (or empty-round pot) plus escrow returned to the pot. */
export function t21EconomicCarry(tx) {
  const dust = t21DustCarry(tx);
  if (dust == null) return null;
  if (tx == null) return dust;
  const back = tx.t21?.back != null && tx.t21.back !== '' ? t21Big(tx.t21.back) : 0n;
  if (back == null || back < 0n) return null;
  return dust + back;
}

function quotaOk(rows) {
  return !owedCapExceeded(rows, (o) => hex32(o.by));
}

function listingFor(spec, fresh, settleRows, folds = []) {
  const paidE = new Set((settleRows || []).map((r) => t21Anchor(r)).filter(Boolean));
  const listed = t21OwedNext({ owedIn: spec.owedIn || [], paidE, fresh, folds, height: spec.height });
  if (!quotaOk(listed.owed)) throw fail('owed_cap');
  return listed;
}

function emptyCoinbase(spec, deferred) {
  const S = scalarOk(spec.S);
  const cin = scalarOk(spec.cin);
  if (S == null || cin == null) throw fail('pot_sched');
  const ctx = { magic: spec.magic, height: spec.height, prevHash: spec.prevHash };
  const vaults = planVaults(ctx, spec.vaults, 0).concat(publicRows(spec, true));
  const listed = listingFor(spec, [], []);
  const pot = splitCarry(cin + S);
  const tx = {
    coinbase: true,
    cbForm: CB_FORM,
    height: spec.height,
    vin: [{ coinbase: true, height: spec.height }],
    vout: vaults,
    carryNanos: pot.carryNanos,
    t21: {
      S: S.toString(),
      cin: cin.toString(),
      bps: 0,
      u: '0',
      height: spec.height,
      magic: spec.magic,
      prevHash: Buffer.from(asU8(spec.prevHash)),
      shares: [],
      ...owedFields({ owed: listed.owed, back: listed.back, potCarry: pot.potCarry }, true),
    },
  };
  tx.t21.stmt = statementOf(tx);
  return {
    tx, deferred, batch: [], secrets: [], W: 0n, f: 0n, phi: 0n, dust: cin + S,
    escrowPot: 0n, settleV: 0n, back: listed.back,
  };
}

/** Phase one on the native prover. The wrap stays in JS; r is re-derived from the leaf try. */
function commitRowsNative(engine, ctx, rows, seed) {
  let got;
  try {
    got = engine.commit({
      seed, magic: ctx.magic, height: ctx.height, prevHash: ctx.prevHash, W: ctx.W,
      rows: rows.map((row) => ({ noLeaf: row.noLeaf, v: row.v, Wi: row.Wi, rho: row.rho, B: pointBytes(row.vch.B), Y: pointBytes(row.vch.Y) })),
    });
  } catch (err) {
    if (err.nativeReason === 'admit_note_point' && err.index != null) {
      throw fail('admit_note_point', { payee: rows[err.index]?.payee });
    }
    throw err;
  }
  return got.map((c, index) => {
    const row = rows[index];
    const r = ctx.nonce('r', index, c.n);
    const noteCommit = sha(Buffer.from('shear-t21-nc-v1'), row.vch.lambdaBytes, u32le(index));
    const sealed = sealWrap(r, row.vch.B, noteCommit, c.C, row.v, ctx.nonce('wrap', index));
    const pub = {
      kind: row.kind,
      kindCode: PAYOUT_KIND_CODE,
      noteCommit,
      commit: c.C,
      admitPub: c.P,
      B: pointBytes(row.vch.B),
      Y: pointBytes(row.vch.Y),
      lambda: Buffer.from(row.vch.lambdaBytes),
      rEph: sealed.rEph,
      rCt: sealed.rCt,
      amtCt: sealed.amtCt,
      cw: c.cw,
      rhoK: c.rhoK,
      delK: c.delK,
      fin: row.finPub === 0n ? 0 : row.finPub.toString(),
      ra: { chunks: c.chunks },
    };
    return { row, index, r, n: c.n, C: pointFrom(c.C), pub };
  });
}

/** Phase two and the tally on the native prover. */
function proveNative(engine, ctx, items, shares, stmt, seed) {
  let got;
  try {
    got = engine.prove({
      seed, stmt, W: ctx.W, rate: ctx.rate, shares,
      rows: items.map((it) => ({
        n: it.n, v: it.row.v, Wi: it.row.Wi, rho: it.row.rho, finEff: it.row.finEff,
        Y: it.pub.Y, lambda: it.pub.lambda, chunks: it.pub.ra.chunks,
      })),
    });
  } catch (err) {
    if (err.nativeReason === 'split_tally') throw fail('split_tally');
    throw err;
  }
  const proved = items.map((it, i) => {
    const p = got.proved[i];
    return { ...it.pub, ra: { chunks: p.chunks, agg: p.agg }, law: p.law, rangeProof: { tag: RANGE_TAG, bp: p.bp } };
  });
  return { proved, tally: got.tally };
}

let nativeWarned = false;

function buildOnce(spec, payees, deferred, seed, engine = null) {
  if (engine) {
    try {
      return buildOnceWith(spec, payees, deferred, seed, engine);
    } catch (err) {
      if (!err.engine || spec.prover === 'native') throw err;
      if (!nativeWarned) {
        nativeWarned = true;
        console.error(JSON.stringify({ event: 't21_prover_native', ok: false, reason: err.message }));
      }
    }
  }
  return buildOnceWith(spec, payees, deferred, seed, null);
}

function freshEscrow(spec, priced) {
  const producer = bytes32(spec.producer);
  if (priced.length && !producer) throw fail('owed_list');
  return priced.map((g) => ({
    since: Number(spec.height),
    by: Buffer.from(producer),
    B: pointBytes(g._vch.B),
    Y: pointBytes(g._vch.Y),
    lambda: Buffer.from(g._vch.lambdaBytes),
    pot: g.pot.toString(),
    hash: g.hash.toString(),
    shares: (g.shares || []).map((s) => ({
      w: BigInt(s.w).toString(), E: Buffer.from(asU8(s.E)), beta: s.beta,
    })),
  }));
}

function buildOnceWith(spec, payees, deferred, seed, engine) {
  const escrowIn = spec.escrowPayees || [];
  const foldIn = Array.isArray(spec.folds) ? spec.folds : [];
  const settleRows = Array.isArray(spec.settle) ? spec.settle : [];
  const planned = planPay(spec, payees, escrowIn, foldIn);
  const settleOnly = planned.W === 0n && settleRows.length > 0;
  if (planned.W === 0n && !settleOnly) return emptyCoinbase(spec, deferred);
  const lawW = settleOnly ? 1n : planned.W;
  const tallyW = settleOnly ? 0n : planned.Wpaid;
  const uPub = settleOnly ? 0n : planned.u;
  const rate = settleOnly ? planned.R : planned.rate;
  const dustCarry = settleOnly ? planned.cin + planned.S - planned.f : planned.dust;
  const escrowPot = settleOnly ? 0n : planned.escrowPot;
  const escrowHash = settleOnly ? 0n : planned.escrowHash;
  if (engine && lawW !== tallyW && spec.prover === 'native') throw fail('t21_prover_native');
  const useEngine = engine && lawW === tallyW ? engine : null;
  const nonce = (label, i = 0, j = 0, bind = NO_BIND) => t21Nonce(seed, label, i, j, bind);
  const ctx = {
    magic: spec.magic, height: spec.height, prevHash: spec.prevHash, nonce, W: lawW, rate,
  };
  const rows = planned.rows.map((g) => ({
    payee: g._index, noLeaf: !!g.forceNonLeaf, kind: 'pot', vch: g._vch, v: g.v, Wi: g.Wi, rho: g.rho, finEff: g.fin, finPub: g.fin,
  }));
  if (planned.f > 0n) {
    const vch = voucherPoints(spec.fee?.voucher);
    if (!vch || !voucherKeysOk(spec.fee.voucher)) throw fail('fee_sched');
    rows.push({ kind: 'pool-fee', vch, v: planned.f, Wi: 0n, rho: 0n, finEff: planned.f, finPub: 0n });
  }
  let settlePot = 0n;
  let settleHash = 0n;
  for (const s of settleRows) {
    const pot = t21Big(s.pot);
    const hash = t21Big(s.hash);
    if (pot == null || hash == null) throw fail('owed_list');
    const v = pot + hash;
    settlePot += pot;
    settleHash += hash;
    const vch = voucherPoints({ B: s.B, Y: s.Y, lambda: s.lambda });
    if (!vch || vch.lambda !== voucherLambda(s.B, s.Y)) throw fail('split_label');
    const anchor = t21Anchor(s);
    if (!anchor) throw fail('owed_list');
    rows.push({
      kind: 'settle', vch, v, Wi: 0n, rho: 0n, finEff: v, finPub: 0n, escrowE: Buffer.from(anchor, 'hex'),
    });
  }
  const dummySecret = spec.dummySecret || sha(seed, Buffer.from('dummy'));
  for (let ctr = 0; rows.filter((r) => r.kind === 'pot').length < K_MIN && ctr < 64; ctr += 1) {
    const vch = voucherAt(dummySecret, (spec.dummyStart || 0) + ctr);
    const pub = { B: pointBytes(vch.B), Y: pointBytes(vch.Y), lambda: vch.lambdaBytes };
    if (!voucherKeysOk(pub)) continue;
    rows.push({ kind: 'pot', vch: voucherPoints(pub), v: 0n, Wi: 0n, rho: 0n, finEff: 0n, finPub: 0n });
  }
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const j = Number(bytesToNumberLE(sha(seed, Buffer.from('shuffle'), u32le(i)).subarray(0, 8)) % BigInt(i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  const items = useEngine ? commitRowsNative(useEngine, ctx, rows, seed) : rows.map((row, i) => commitRow(ctx, row, i));
  for (const it of items) {
    if (it.row.escrowE) it.pub.escrowE = Buffer.from(asU8(it.row.escrowE));
  }
  const vaults = planVaults(ctx, spec.vaults, items.length).concat(publicRows(spec, settleOnly));
  const shares = [];
  for (const p of payees) {
    for (const s of p.shares || []) shares.push({ w: BigInt(s.w), E: Buffer.from(asU8(s.E)), ell: s.ell, beta: s.beta });
  }
  const fresh = settleOnly ? [] : freshEscrow(spec, planned.escrow);
  const foldApplies = [];
  if (!settleOnly) {
    const owedById = new Map((spec.owedIn || []).map((o) => [t21Anchor(o), o]));
    for (const g of planned.folds) {
      const id = String(g.id);
      const parent = owedById.get(id);
      if (!parent) throw fail('owed_list');
      if (hex32(parent.by) !== hex32(spec.producer)) throw fail('owed_list');
      foldApplies.push({
        id,
        addPot: g.pot,
        addHash: g.hash,
        shares: (g.shares || []).map((s) => ({ w: BigInt(s.w).toString(), E: Buffer.from(asU8(s.E)), beta: s.beta })),
      });
    }
  }
  const listed = listingFor(spec, fresh, settleRows, foldApplies);
  const defer = [];
  const freshIds = new Set(fresh.map((row) => t21Anchor(row)));
  const priorCount = new Map((spec.owedIn || []).map((o) => [t21Anchor(o), (o.shares || []).length]));
  const foldIds = new Map(foldApplies.map((f) => [f.id, priorCount.get(f.id) || 0]));
  for (const row of listed.owed) {
    const id = t21Anchor(row);
    if (freshIds.has(id)) {
      for (const s of row.shares) defer.push({ w: s.w, E: Buffer.from(asU8(s.E)) });
    } else if (foldIds.has(id)) {
      const nOld = foldIds.get(id);
      for (const s of row.shares.slice(nOld)) defer.push({ w: s.w, E: Buffer.from(asU8(s.E)) });
    }
  }
  const pot = splitCarry(dustCarry);
  const skel = {
    coinbase: true,
    cbForm: CB_FORM,
    carryNanos: pot.carryNanos,
    vout: items.map((it) => it.pub).concat(vaults),
    t21: {
      S: planned.S.toString(),
      cin: planned.cin.toString(),
      bps: Number(planned.bps),
      u: uPub.toString(),
      height: spec.height,
      magic: spec.magic,
      prevHash: Buffer.from(asU8(spec.prevHash)),
      shares: shares.map((s) => ({ w: s.w.toString(), E: s.E })),
      ...owedFields({ defer, owed: listed.owed, back: listed.back, potCarry: pot.potCarry }, false),
    },
  };
  const stmt = statementOf(skel);
  const betaOf = new Map();
  for (const g of fresh) for (const s of g.shares) betaOf.set(hex32(s.E), s.beta);
  for (const g of foldApplies) for (const s of g.shares) betaOf.set(hex32(s.E), s.beta);
  for (const row of skel.t21.owed || []) {
    row.shares.forEach((s, i) => {
      if (s.open) return;
      const beta = betaOf.get(hex32(s.E));
      if (!beta) throw fail('owed_list');
      const label = Number(row.since) === Number(spec.height) ? 'escrow-open' : 'escrow-fold';
      s.open = proveOpen(row, { ...s, beta }, nonce(label, i, row.shares.length, stmt));
    });
  }
  const { proved, tally } = useEngine
    ? proveNative(useEngine, ctx, items, shares, stmt, seed)
    : { proved: items.map((it) => proveRow(ctx, it, stmt)), tally: proveTally(items, shares, tallyW, stmt, nonce) };
  const settleV = settlePot + settleHash;
  const mintG = planned.S + planned.cin - dustCarry - escrowPot + uPub * tallyW + planned.phi + settleV;
  let sumC = Point.ZERO;
  let h = 0n;
  for (const it of items) {
    sumC = sumC.add(it.C);
    h = mod(h + sb(it.r));
  }
  const mint = proveH(sumC.subtract(mulP(G, mintG)), h, stmt, nonce('mint', 0, 0, stmt));
  const tx = {
    coinbase: true,
    cbForm: CB_FORM,
    height: spec.height,
    vin: [{ coinbase: true, height: spec.height }],
    vout: proved.concat(vaults),
    carryNanos: pot.carryNanos,
    excess: scalarBytes(h),
    t21: { ...skel.t21, tally, mint, stmt },
  };
  return {
    tx,
    deferred,
    batch: payees.flatMap((p) => (p.shares || []).map((s) => ({ E: Buffer.from(asU8(s.E)), w: BigInt(s.w) }))),
    secrets: items.map((it) => ({ kind: it.row.kind, v: it.row.v, r: it.r, index: it.index })),
    W: tallyW,
    f: planned.f,
    phi: planned.phi,
    dust: dustCarry,
    paid: mintG,
    escrowPot,
    escrowHash,
    settleV,
    back: listed.back,
  };
}

/**
 * Payee slot order (MF-3): the finder payee first (Φ must be paid), then by
 * W_i largest first, so many small vouchers cannot take the slots from the
 * hashers that did the work, then by B* bytes. Sorts in place.
 */
function rankPayees(live) {
  const key = (p) => ({
    fin: (scalarOk(p.fin || 0) ?? 0n) > 0n,
    Wi: (p.shares || []).reduce((a, s) => a + (scalarOk(s.w) ?? 0n), 0n),
    B: Buffer.from(asU8(p.voucher?.B || [])).toString('hex'),
  });
  const keys = new Map(live.map((p) => [p, key(p)]));
  live.sort((a, b) => {
    const x = keys.get(a);
    const y = keys.get(b);
    if (x.fin !== y.fin) return x.fin ? -1 : 1;
    if (x.Wi !== y.Wi) return x.Wi > y.Wi ? -1 : 1;
    return x.B < y.B ? -1 : x.B > y.B ? 1 : 0;
  });
}

/**
 * spec.prover: 'js' proves in JS; 'native' requires the pinned native prover;
 * unset uses the native prover when one is pinned (crypto/t21_native.js).
 */
function proverEngine(spec) {
  if (spec.prover === 'js') return null;
  const engine = t21ProverEngine();
  if (!engine && spec.prover === 'native') throw fail('t21_prover_native');
  return engine;
}

/**
 * Template builder. A payee is { voucher: {B, Y, lambda}, fin?, shares: [{w, E, ell, beta}] },
 * with lambda = voucherLambda(B, Y).
 * A voucher that fails voucherKeysOk is deferred before proving. A payee whose
 * row cannot be made an FS-1 leaf throws admit_note_point; that payee and its
 * shares are evicted to `deferred` and the coinbase is rebuilt once. Payees
 * past payeeCapLive() (or a lower spec.payeeMax), in rankPayees order, are
 * sealed as escrow when spec.producer is set. A share total past shareMax
 * is share_cap: a payee is never split. There is no last-payee re-split.
 */
export function buildT21Coinbase(spec) {
  // Every nonce and blind derives from this seed, so a given seed builds the same bytes.
  const seed = spec.seed ? Buffer.from(asU8(spec.seed)) : randomBytes(32);
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
  rankPayees(live);
  const pinned = [];
  const ranked = [];
  for (const p of live) {
    const fin = scalarOk(p.fin || 0) ?? 0n;
    if ((p.shares || []).length === 0 && fin > 0n) pinned.push(p);
    else ranked.push(p);
  }
  const escrow = [];
  for (const p of spec.escrowPayees || []) {
    const vch = voucherPoints(p.voucher);
    if (!vch || !keysOk(p.voucher)) throw fail('voucher_key');
    escrow.push({ ...p, _vch: vch });
  }
  // Dummies only pad a short round, so the cap needs no room for them.
  // Overflow payees are sealed whole. They are not a second leftover list.
  // A finder row with no shares stays in the block; it is not escrow.
  const cap = Math.min(payeeCapLive(), Math.max(0, Math.floor(Number(spec.payeeMax ?? Infinity))));
  // Settle rows are outside the payee cap. They pay a sealed row; they are not a new payee.
  const roomPayees = Math.max(0, cap - pinned.length);
  for (const p of ranked.splice(roomPayees)) escrow.push(p);
  const kept = pinned.concat(ranked);
  const room = Math.min(CB_SHARE_MAX, Math.max(0, Math.floor(Number(spec.shareMax ?? CB_SHARE_MAX))));
  let nShares = 0;
  for (const p of kept) nShares += (p.shares || []).length;
  for (const p of escrow) nShares += (p.shares || []).length;
  if (nShares > room) throw fail('share_cap');
  const withIndex = (list) => list.map((p, i) => ({ ...p, _index: i }));
  let payees = withIndex(kept);
  const specRound = { ...spec, escrowPayees: escrow };
  if (!payees.length && !escrow.length && !(spec.folds || []).length && !(spec.settle || []).length) {
    return emptyCoinbase(specRound, deferred);
  }
  const engine = proverEngine(spec);
  try {
    return buildOnce(specRound, payees, deferred, seed, engine);
  } catch (err) {
    if (err.reason !== 'admit_note_point' || err.payee == null) throw err;
    const bad = payees[err.payee];
    deferred.push({ voucher: bad.voucher, shares: bad.shares || [], reason: 'admit_note_point' });
    payees = withIndex(payees.filter((_, i) => i !== err.payee).map(({ _index, ...rest }) => rest));
    if (!payees.length && !(specRound.escrowPayees || []).length && !(spec.folds || []).length && !(spec.settle || []).length) {
      return emptyCoinbase(specRound, deferred);
    }
    return buildOnce(specRound, payees, deferred, seed, engine);
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
 *   owedIn: the parent coinbase's t21.owed [{E, w, since}] (deferred rows),
 *   vaults: pending pinned withdraws [{ mintId, vaultNanos, B }].
 * Returns paid = S + c_in − c_out − escrowPot + u·W_paid + Φ + settleV.
 * On a working round Φ is expect.phi (the levy finder half) and finB is null.
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
  const defer = Array.isArray(t21.defer) ? t21.defer : [];
  if (t21.defer != null && !Array.isArray(t21.defer)) return no('owed_list');
  if (t21.owed != null && !Array.isArray(t21.owed)) return no('owed_list');
  if (shares.length + defer.length > CB_SHARE_MAX) return no('share_cap');
  for (const s of shares.concat(defer)) {
    const w = scalarOk(s?.w);
    if (w == null || w <= 0n || w > W_S_MAX) return no('split_cap');
  }
  for (const o of vout) {
    if (!o || typeof o !== 'object') return no('cb_form');
    // Public levy rows; coinbaseLevyPays opens them. The finder half is public only with no shares.
    if (o.kind === 'reserve-fee' && !hasKey(o, 'kindCode')) continue;
    if (o.kind === 'finder-fee' && !hasKey(o, 'kindCode')) {
      // Option B is only a round with no new work. Shares or deferred payees fold Φ.
      if (shares.length || defer.length) return no('levy_split');
      continue;
    }
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
  const payees = payout.filter((o) => o.kind !== 'pool-fee' && o.kind !== 'settle');
  // The same cap blockBudget counts (pot rows, dummies included; not the fee row).
  if (payees.length > payeeCapLive()) return no('payee_cap');
  const S = scalarOk(t21.S);
  const cin = scalarOk(t21.cin);
  const u = scalarOk(t21.u || 0);
  const bps = t21Big(t21.bps);
  const cout = scalarOk(tx.carryNanos || 0);
  const potCarry = t21.potCarry != null && t21.potCarry !== '' ? t21Big(t21.potCarry) : 0n;
  if (S == null || cin == null || u == null || cout == null || bps == null || potCarry == null || potCarry < 0n) {
    return no('split_cap');
  }
  const potOut = cout + potCarry;
  // B3: the public scalars are chain state.
  if (S !== BigInt(expect.S) || cin !== BigInt(expect.cin)) return no('pot_sched');
  if (potOut > S + cin) return no('pot_sched');
  if (String(t21.height) !== String(expect.height) || String(t21.magic) !== String(expect.magic)
    || !sameBytes(t21.prevHash, expect.prevHash)) {
    return no('cb_form');
  }
  if (bps < 0n || bps > BigInt(FEE_BPS_MAX)) return no('fee_sched');
  const f = feeOf(S, bps);
  if (f == null) return no('fee_sched');
  const vaultPaid = checkVaults(tx, expect);
  if (!vaultPaid.ok) return vaultPaid;
  const settling = payout.some((o) => o.kind === 'settle');
  const hasWork = shares.length > 0 || defer.length > 0;
  if (!hasWork && !settling) {
    if (payout.length) return no('pot_carry');
    if (potOut !== cin + S) return no('pot_sched');
    if (f !== 0n || u !== 0n) return no('fee_sched');
    if (!Array.isArray(expect.shares) || expect.shares.length) return no('share_bind');
    const owedOk = checkOwed(tx, [], [], expect, null);
    if (!owedOk.ok) return owedOk;
    if (!sameBytes(t21.stmt, statementOf(tx))) return no('split_law');
    return {
      ok: true, reason: null, paid: 0n, phi: 0n, W: 0n, f: 0n, finB: null,
      escrowPot: 0n, settleV: 0n, back: owedOk.back, vaultPaid: vaultPaid.paid,
    };
  }
  if (!hasWork) {
    if (u !== 0n) return no('pot_sched');
    if (!Array.isArray(expect.shares) || expect.shares.length) return no('share_bind');
    if (potOut !== cin + S - f) return no('pot_sched');
  } else if (u !== BigInt(expect.u)) return no('pot_sched');
  if (payees.length < K_MIN) return no('payee_cap');
  const feeRows = payout.filter((o) => o.kind === 'pool-fee');
  if (f > 0n ? feeRows.length !== 1 : feeRows.length !== 0) return no('fee_sched');
  for (const o of payout) {
    if (!PAYOUT_KINDS.has(String(o.kind || ''))) return no('cb_form');
  }
  // B4: every proven A leaf is paid by one published share or deferred by one
  // defer row, same weight; a share may instead pay an owed row at its w.
  let W = 0n;
  const seenE = new Set();
  for (const s of shares.concat(defer)) {
    if (Object.keys(s).some((k) => k !== 'w' && k !== 'E')) return no('share_label');
    if (!pointOk(s.E)) return no('share_label');
    const hex = Buffer.from(asU8(s.E)).toString('hex');
    if (seenE.has(hex)) return no('share_label');
    if (expect.prevEs && expect.prevEs.has(hex)) return no('share_label');
    seenE.add(hex);
  }
  for (const s of shares) W += BigInt(s.w);
  if (shares.length && (W <= 0n || W >= W_MAX)) return no('split_cap');
  if (W > W_HASH_MAX) return no('hash_units');
  let Bh;
  try {
    Bh = BigInt(expect.hashBudget);
  } catch {
    return no('hash_budget');
  }
  if (Bh < 0n) return no('hash_budget');
  if (!Array.isArray(expect.shares) || expect.shares.length !== shares.length + defer.length) return no('share_bind');
  const pool = new Map();
  for (const p of expect.shares) {
    const k = `${Buffer.from(asU8(p.nc)).toString('hex')}:${String(p.units)}`;
    pool.set(k, (pool.get(k) || 0) + 1);
  }
  for (const s of shares.concat(defer)) {
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
  if (fins > 1 || phi !== 0n) return no('finder_row');
  const phiChain = scalarOk(expect.phi || 0);
  if (phiChain == null) return no('levy_split');
  // A working round folds Φ into the pot. The public fin stays 0, so one voucher cannot take it.
  const phiMint = hasWork ? phiChain : 0n;
  const owedOk = checkOwed(tx, shares, defer, expect, finB, phiMint);
  if (!owedOk.ok) return owedOk;
  const wall = W + owedOk.wEsc;
  if (wall >= W_MAX) return no('split_cap');
  if (u * wall > Bh) return no('hash_budget');
  for (const p of parsed) {
    if (p.o.kind !== 'settle') continue;
    const row = owedOk.settleById.get(hex32(p.o.escrowE));
    if (!row || hex32(p.o.B) !== hex32(row.B) || hex32(p.o.Y) !== hex32(row.Y)
      || hex32(p.o.lambda) !== hex32(row.lambda)) {
      return no('owed_list');
    }
    p.finEff = BigInt(row.pot) + BigInt(row.hash);
  }
  const R = S + cin - f;
  if (R < 0n) return no('pot_sched');
  // Full-pot carry is a round with no new work. With work, c_out is the law dust.
  if (hasWork && potOut >= BigInt(payout.length)) return no('pot_carry');
  const stmt = statementOf(tx);
  if (!sameBytes(t21.stmt, stmt)) return no('split_law');
  const lawW = wall > 0n ? wall : 1n;
  const mintG = S + cin - potOut - owedOk.escrowPot + u * W + phiMint + owedOk.settleV;
  const rate = R + phiMint + lawW * u;
  const checks = buildChecks({ tx, parsed, shares, lawW, tallyW: W, rate, f, mintG, stmt });
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
    ok: true, reason: null, paid: mintG, phi: phiMint, W, f, finB,
    escrowPot: owedOk.escrowPot, settleV: owedOk.settleV, back: owedOk.back,
    vaultPaid: vaultPaid.paid,
  };
}

function rowShares(row) {
  return Array.isArray(row?.shares) ? row.shares : [];
}

function sharePin(s, key) {
  const v = s && s[key];
  if (v == null || v === '') return '';
  return String(BigInt(v));
}

function sameRow(got, want) {
  if (Number(got.since) !== Number(want.since)) return false;
  if (!sameBytes(got.by, want.by) || !sameBytes(got.B, want.B) || !sameBytes(got.Y, want.Y)
    || !sameBytes(got.lambda, want.lambda)) return false;
  if (String(got.pot) !== String(want.pot) || String(got.hash) !== String(want.hash)) return false;
  const gid = idBytes(got.id);
  const wid = idBytes(want.id);
  if ((gid == null) !== (wid == null)) return false;
  if (gid && !sameBytes(gid, wid)) return false;
  const gs = rowShares(got);
  const ws = rowShares(want);
  if (gs.length !== ws.length) return false;
  for (let i = 0; i < gs.length; i += 1) {
    if (String(gs[i].w) !== String(ws[i].w) || !sameBytes(gs[i].E, ws[i].E)) return false;
    if (sharePin(gs[i], 'pot0') !== sharePin(ws[i], 'pot0')) return false;
    if (sharePin(gs[i], 'hash0') !== sharePin(ws[i], 'hash0')) return false;
  }
  return true;
}

/**
 * Escrow listing. expect.owedIn is the parent list. Settlement is a settle
 * row bound to the anchor, not a replay of the share. Fresh rows are priced
 * from this round (floor((R+Φ)·w/W_all) + u·w) and bound to expect.producer.
 * Quota is per producer, and the whole list has a global cap.
 * Expired value is back, returned to the pot.
 */
function checkOwed(tx, shares, defer, expect, finB, phiMint = 0n) {
  const t21 = tx.t21 || {};
  const owedIn = Array.isArray(expect.owedIn) ? expect.owedIn : [];
  const height = BigInt(expect.height);
  const byId = new Map();
  for (const o of owedIn) {
    const id = t21Anchor(o);
    if (!id || byId.has(id)) return no('owed_list');
    byId.set(id, o);
  }
  const settleById = new Map();
  const paidE = new Set();
  for (const o of payoutRows(tx)) {
    if (o.kind !== 'settle') continue;
    const id = hex32(o.escrowE);
    if (!id || paidE.has(id)) return no('owed_list');
    const row = byId.get(id);
    if (!row) return no('owed_list');
    if (height - BigInt(row.since) > BigInt(T21_OWED_TTL)) return no('owed_ttl');
    paidE.add(id);
    settleById.set(id, row);
  }
  const got = Array.isArray(t21.owed) ? t21.owed : [];
  const fresh = got.filter((o) => BigInt(o.since) === height);
  const foldIntents = [];
  for (const row of got) {
    const id = t21Anchor(row);
    const parent = byId.get(id);
    if (!parent || BigInt(row.since) === height) continue;
    const old = rowShares(parent);
    const now = rowShares(row);
    const untouched = now.length === old.length
      && String(row.pot) === String(parent.pot) && String(row.hash) === String(parent.hash);
    if (untouched) continue;
    if (now.length <= old.length) return no('owed_list');
    for (let i = 0; i < old.length; i += 1) {
      if (String(now[i].w) !== String(old[i].w) || hex32(now[i].E) !== hex32(old[i].E)) return no('owed_list');
    }
    const added = now.slice(old.length);
    let w = 0n;
    for (const s of added) w += BigInt(s.w);
    const addPot = BigInt(row.pot) - BigInt(parent.pot);
    const addHash = BigInt(row.hash) - BigInt(parent.hash);
    if (w <= 0n || addPot < 0n || addHash < 0n) return no('owed_list');
    foldIntents.push({ id, addPot, addHash, shares: added, w, row, parent });
  }
  let listed;
  try {
    listed = t21OwedNext({
      owedIn, paidE, fresh, height: expect.height,
      folds: foldIntents.map((f) => ({ id: f.id, addPot: f.addPot, addHash: f.addHash, shares: f.shares })),
    });
  } catch (err) {
    return no(err.reason || 'owed_list');
  }
  if (got.length !== listed.owed.length) return no('owed_list');
  for (let i = 0; i < got.length; i += 1) {
    if (!sameRow(got[i], listed.owed[i])) return no('owed_list');
  }
  if (!quotaOk(got)) return no('owed_cap');
  for (let i = 0; i < got.length; i += 1) {
    if (!rowShares(got[i]).every((s) => openHolds(got[i], s))) return no('share_label');
  }
  const backPub = t21.back != null && t21.back !== '' ? t21Big(t21.back) : 0n;
  if (backPub == null || backPub !== listed.back) return no('owed_list');
  const duty = settleDuty({
    owedIn: owedIn.map((o) => ({ ...o, id: t21Anchor(o) })),
    paid: paidE,
    height: expect.height,
    freshPayees: shares.length > 0 || defer.length > 0,
    fit: payeeCapLive(),
  });
  if (!duty.ok) return no(duty.reason);
  const S = scalarOk(t21.S);
  const cin = scalarOk(t21.cin);
  const u = scalarOk(t21.u || 0);
  const bps = t21Big(t21.bps || 0);
  const f = S != null && bps != null ? feeOf(S, bps) : null;
  if (S == null || cin == null || u == null || f == null) return no('pot_sched');
  const R = S + cin - f;
  let wPaid = 0n;
  for (const s of shares) wPaid += BigInt(s.w);
  let wEsc = 0n;
  let escrowPot = 0n;
  const flat = [];
  const who = finB ? hex32(finB) : hex32(expect.producer);
  const seenEscrowE = new Set();
  const noteShare = (s) => {
    const id = hex32(s.E);
    if (!id || seenEscrowE.has(id)) return no('share_label');
    seenEscrowE.add(id);
    if ([...byId.values()].some((prev) => rowShares(prev).some((ps) => hex32(ps.E) === id) || t21Anchor(prev) === id)) {
      return no('share_label');
    }
    flat.push(s);
    return null;
  };
  const foldById = new Map(foldIntents.map((f) => [f.id, f]));
  for (const row of fresh) {
    if (!who || hex32(row.by) !== who) return no('owed_list');
    if (scalarOkBytes(row.lambda) !== voucherLambda(row.B, row.Y)) return no('split_label');
    let w = 0n;
    for (const s of rowShares(row)) w += BigInt(s.w);
    wEsc += w;
  }
  for (const fold of foldIntents) {
    if (!who || hex32(fold.row.by) !== who) return no('owed_list');
    if (Number(fold.row.since) !== Number(fold.parent.since)) return no('owed_list');
    if (hex32(fold.row.by) !== hex32(fold.parent.by) || hex32(fold.row.B) !== hex32(fold.parent.B)
      || hex32(fold.row.Y) !== hex32(fold.parent.Y) || hex32(fold.row.lambda) !== hex32(fold.parent.lambda)) {
      return no('owed_list');
    }
    wEsc += fold.w;
  }
  for (const row of got) {
    const id = t21Anchor(row);
    const sharesOf = BigInt(row.since) === height ? rowShares(row) : (foldById.get(id)?.shares || []);
    for (const s of sharesOf) {
      const bad = noteShare(s);
      if (bad) return bad;
    }
  }
  if (flat.length !== defer.length) return no('owed_list');
  for (let i = 0; i < flat.length; i += 1) {
    if (String(flat[i].w) !== String(defer[i].w) || !sameBytes(flat[i].E, defer[i].E)) return no('owed_list');
  }
  const wall = wPaid + wEsc;
  if (wEsc > 0n) {
    if (wall <= 0n || wall >= W_MAX) return no('split_cap');
    for (const row of fresh) {
      let w = 0n;
      for (const s of rowShares(row)) w += BigInt(s.w);
      const pay = weightPay(R + phiMint, wall, w, u);
      if (!pay || pay.pot !== BigInt(row.pot) || pay.hash !== BigInt(row.hash)) return no('pot_sched');
      escrowPot += pay.pot;
    }
    for (const fold of foldIntents) {
      const pay = weightPay(R + phiMint, wall, fold.w, u);
      if (!pay || pay.pot !== fold.addPot || pay.hash !== fold.addHash) return no('pot_sched');
      escrowPot += pay.pot;
    }
  }
  let settleV = 0n;
  for (const row of settleById.values()) settleV += BigInt(row.pot) + BigInt(row.hash);
  return { ok: true, wEsc, escrowPot, settleV, back: listed.back, settleById };
}

/** The 0x23 rows must be exactly planVaults over chain state, right after the payout rows. */
function checkVaults(tx, expect) {
  const rows = vaultRows(tx);
  const start = payoutRows(tx).length;
  let want;
  try {
    want = planVaults({ magic: expect.magic, height: expect.height, prevHash: expect.prevHash }, expect.vaults, start);
  } catch {
    return no('vault_pin');
  }
  if (rows.length !== want.length) return no('vault_pin');
  let paid = 0n;
  for (let i = 0; i < want.length; i += 1) {
    const got = tx.vout[start + i];
    if (!got || Number(got.kindCode) !== VAULT_KIND_CODE) return no('vault_pin');
    for (const k of ['vaultNanos', 'mintId', 'B', 'commit', 'admitPub', 'noteCommit']) {
      if (k === 'vaultNanos' ? String(got[k]) !== want[i][k] : !sameBytes(got[k], want[i][k])) return no('vault_pin');
    }
    paid += BigInt(want[i].vaultNanos);
  }
  return { ok: true, paid };
}

/** Every equation as terms, grouped by the reject it maps to, in rule order. */
function buildChecks({ tx, parsed, shares, lawW, tallyW, rate, f, mintG, stmt }) {
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
  const wt = hTerms(sumW.subtract(mulP(G, tallyW)), tally.weight, stmt);
  if (!bal || !wt) return no('split_tally');
  list.push({ reason: 'split_tally', terms: [...tallyTerms, bal, wt] });
  // T-9 law and the two-sided ρ range identity.
  const lawTerms = [];
  for (const p of parsed) {
    const finEff = p.o.kind === 'pool-fee' ? f : (p.finEff != null ? p.finEff : p.fin);
    let rhoC = Point.ZERO;
    for (let i = 0; i < RHO_LIMBS; i += 1) rhoC = rhoC.add(mulP(p.rhoK[i], 1n << (16n * BigInt(i))));
    const lawP = mulP(p.C, lawW).subtract(mulP(p.CW, rate)).add(rhoC).subtract(mulP(G, lawW * finEff));
    const lt = hTerms(lawP, p.o.law, stmt);
    if (!lt) return no('split_law');
    lawTerms.push(lt);
    const sum = new Terms().add(G, -(lawW - 1n));
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
  const potCarry = t.potCarry != null && t.potCarry !== '' ? BigInt(t.potCarry) : 0n;
  const dust = BigInt(built.tx.carryNanos || 0) + potCarry;
  const right = BigInt(t.S) + BigInt(t.cin) - dust - (built.escrowPot || 0n)
    + BigInt(t.u || 0) * built.W + built.phi + (built.settleV || 0n);
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
  { n: 12, item: 'Pool and miner share labelling', ok: true, note: 'pool/src/t21_labels.js (SHEAR_POOL_T21_LABELS=1): one pool-issued label per job header, shareBind=note with its noteCommit, E and beta on the wire, dest-free share records; with SHEAR_POOL_T21_FINDER_VOUCHER the pool template builds cb-v3 from its label book and finder/fee vouchers. ShearK binds shares to the noteCommit and mines a label only when E = lambda*G + beta*H for its own voucher.' },
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

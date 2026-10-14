/**
 * T21 hidden coinbase (cb-v3).
 *
 * The tally is the LogUp identity Σ w_s/(X−ℓ_s) = Σ W_i/(X−λ_i).
 * Share labels stay inside E_s. This verifier checks that identity with a
 * per-share inverse product Schnorr and one balance Schnorr. The dalek R1CS
 * encoding of the same relation is the mainnet review item (O-2), not a
 * second rule.
 *
 * Carry of the whole pot is legal only for an empty share batch. A non-empty
 * batch may carry only the law remainder (sum of ρ_i)/W. The last-payee
 * re-split is not used.
 */
import { createHash } from 'node:crypto';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { fs1Leaf } from '../node/src/fs1_tree.js';
import {
  G, H, asU8, bitOrProve, bitOrVerify, commit, hashToScalar, pointBytes,
  pointFrom, randomScalar, scalarBytes, scalarFrom, wrapNoteBlind, openNoteAmount,
} from './note.js';
import { feeOf, lawDust, scalarOk, splitLaw, t21Big } from './t21_law.js';
import { voucherAt } from './t21_voucher.js';
import {
  AMOUNT_KEYS, BATCH_DOM, CB_FORM, CHUNK_BITS, DOM_CB, FEE_BPS_MAX, GEN_H,
  K_MIN, L_MAX, LOGUP_DOM, N_MAX, OUTPUT_MAX, PAYOUT_KIND_CODE, PAYOUT_KINDS,
  RANGE_TAG, R_CHUNKS, SCALAR_MAX, SHARE_BIND_DOM, T21_REQUIRE_ALL_COINBASES,
  V_CHUNKS, VAULT_KIND_CODE, VAULT_R_DOM, VE_CHUNKS, W_MAX, W_S_MAX,
} from './t21_params.js';

const Point = RistrettoPoint;
const Fn = Point.Fn;
const ORDER = Fn.ORDER;

function no(reason) {
  return { ok: false, reason };
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

function f(n) {
  return Fn.create(mod(n));
}

function sb(s) {
  return bytesToNumberLE(Fn.toBytes(s));
}

function mulP(P, n) {
  const v = mod(n);
  if (v === 0n) return Point.ZERO;
  return P.multiply(f(v));
}

function bytes32(value) {
  const b = Buffer.from(asU8(value));
  return b.length === 32 ? b : null;
}

function pointOk(value) {
  const b = bytes32(value);
  if (!b) return null;
  try {
    const P = pointFrom(b);
    if (P.equals(Point.ZERO)) return null;
    if (!Buffer.from(pointBytes(P)).equals(b)) return null;
    return P;
  } catch {
    return null;
  }
}

function proveH(P, s, extra) {
  const k = randomScalar();
  const R = H.multiply(k);
  const e = hashToScalar(pointBytes(P), pointBytes(R), extra);
  const z = Fn.add(k, Fn.mul(e, f(s)));
  return { Rpt: pointBytes(R), z: scalarBytes(z) };
}

function verifyH(P, proof, extra) {
  try {
    const R = pointFrom(proof.Rpt);
    const z = scalarFrom(proof.z);
    const e = hashToScalar(pointBytes(P), proof.Rpt, extra);
    return H.multiply(z).equals(R.add(P.multiply(e)));
  } catch {
    return false;
  }
}

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
  return !!fs1Leaf({ admitPub: pub, commit: C });
}

export function payeePointOk(value) {
  return !!pointOk(value);
}

export function vaultBlind(mintId, height, blockHash) {
  const id = Buffer.from(asU8(mintId));
  const bh = Buffer.from(asU8(blockHash));
  for (let n = 0; n < 256; n += 1) {
    const r = hashToScalar(
      Buffer.from(VAULT_R_DOM), id, u64le(height), bh, Buffer.from([n]),
    );
    if (!Fn.is0(r)) return r;
  }
  return null;
}

export function vaultCommit(vaultNanos, mintId, height, blockHash) {
  const v = scalarOk(vaultNanos);
  const r = vaultBlind(mintId, height, blockHash);
  if (v == null || !r) return null;
  return { r, commit: pointBytes(commit(v, r)) };
}

function header128(header) {
  const out = Buffer.alloc(128);
  const h = Buffer.from(asU8(header));
  h.copy(out, 0, 0, Math.min(128, h.length));
  return out;
}

export function shareBindTag(header, jobKey, E) {
  const inner = createHash('sha256')
    .update(Buffer.from(SHARE_BIND_DOM))
    .update(Buffer.from(asU8(jobKey)))
    .update(Buffer.from(asU8(E)))
    .digest();
  return createHash('sha256').update(header128(header)).update(inner).digest();
}

export function sharePowMessage(header, jobKey, E) {
  return Buffer.concat([header128(header), shareBindTag(header, jobKey, E)]);
}

function proveBits(amount, bits, blind, extra) {
  const rows = [];
  let v = BigInt(amount);
  let acc = 0n;
  for (let k = 0; k < bits; k += 1) {
    const bit = v & 1n;
    v >>= 1n;
    const s = randomScalar();
    const C = commit(bit, s);
    const proof = bitOrProve(C, bit === 1n, s);
    rows.push({ bitC: pointBytes(C), ...proof, s, bit });
    // C_k = b_k·G + s_k·H, so 2^k·C_k carries s_k on H even when the bit is clear.
    acc = mod(acc + mod(1n << BigInt(k)) * sb(s));
  }
  const M = commit(amount, blind);
  let sum = Point.ZERO;
  for (let k = 0; k < rows.length; k += 1) {
    sum = sum.add(mulP(pointFrom(rows[k].bitC), 1n << BigInt(k)));
  }
  const linkP = sum.subtract(M);
  const linkS = mod(acc - sb(blind));
  const link = proveH(linkP, linkS, extra);
  return {
    rows: rows.map(({ bitC, R0, R1, e0, e1, z0, z1 }) => ({ bitC, R0, R1, e0, e1, z0, z1 })),
    link,
  };
}

function verifyBits(amountPoint, bits, proof, extra) {
  try {
    if (!proof || !Array.isArray(proof.rows) || proof.rows.length !== bits) return false;
    let sum = Point.ZERO;
    for (let k = 0; k < bits; k += 1) {
      const row = proof.rows[k];
      const C = pointFrom(row.bitC);
      if (!bitOrVerify(C, row)) return false;
      sum = sum.add(mulP(C, 1n << BigInt(k)));
    }
    return verifyH(sum.subtract(amountPoint), proof.link, extra);
  } catch {
    return false;
  }
}

function encryptLimb(m, Y) {
  const t = randomScalar();
  const s = randomScalar();
  const epV = G.multiply(t);
  const epD = Y.multiply(t).add(mulP(G, m));
  const M = commit(m, s);
  return { m, t, s, epV, epD, M };
}

function proveChunk(m, Y, extra) {
  const enc = encryptLimb(m, Y);
  return finishChunk(enc, Y, extra);
}

function finishChunk(enc, Y, extra) {
  const { t, s, m, epV, epD, M } = enc;
  const kT = randomScalar();
  const kS = randomScalar();
  const R1 = G.multiply(kT);
  const R2 = Y.multiply(kT).subtract(H.multiply(kS));
  const e = hashToScalar(pointBytes(R1), pointBytes(R2), pointBytes(epV), pointBytes(epD), pointBytes(M), extra);
  const zT = Fn.add(kT, Fn.mul(e, t));
  const zS = Fn.add(kS, Fn.mul(e, s));
  const range = proveBits(m, CHUNK_BITS, s, extra);
  return {
    epV: pointBytes(epV),
    epD: pointBytes(epD),
    Mpt: pointBytes(M),
    bindR1: pointBytes(R1),
    bindR2: pointBytes(R2),
    zT: scalarBytes(zT),
    zS: scalarBytes(zS),
    range,
    t,
    m,
  };
}

function verifyChunk(chunk, Y, extra) {
  try {
    const epV = pointOk(chunk.epV);
    const epD = pointOk(chunk.epD);
    const M = pointOk(chunk.Mpt);
    if (!epV || !epD || !M) return false;
    if (!verifyBits(M, CHUNK_BITS, chunk.range, extra)) return false;
    const R1 = pointFrom(chunk.bindR1);
    const R2 = pointFrom(chunk.bindR2);
    const zT = scalarFrom(chunk.zT);
    const zS = scalarFrom(chunk.zS);
    const e = hashToScalar(pointBytes(R1), pointBytes(R2), pointBytes(epV), pointBytes(epD), pointBytes(M), extra);
    const left1 = G.multiply(zT);
    const right1 = R1.add(epV.multiply(e));
    const left2 = Y.multiply(zT).subtract(H.multiply(zS));
    const right2 = R2.add(epD.subtract(M).multiply(e));
    return left1.equals(right1) && left2.equals(right2);
  } catch {
    return false;
  }
}

function limbsOf(n, count) {
  const out = [];
  let x = BigInt(n);
  for (let i = 0; i < count; i += 1) {
    out.push(x & 0xffffn);
    x >>= 16n;
  }
  return out;
}

function proveAggregate(chunks, v, r, Y, C, extra) {
  const vLimbs = limbsOf(v, V_CHUNKS);
  const rLimbs = limbsOf(r, R_CHUNKS);
  let Tv = Fn.ZERO;
  let Tr = Fn.ZERO;
  for (let j = 0; j < V_CHUNKS; j += 1) {
    Tv = Fn.add(Tv, Fn.mul(f(1n << (16n * BigInt(j))), chunks[j].t));
  }
  for (let j = 0; j < R_CHUNKS; j += 1) {
    Tr = Fn.add(Tr, Fn.mul(f(1n << (16n * BigInt(j))), chunks[V_CHUNKS + j].t));
  }
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
  return {
    RC: pointBytes(RC),
    RVv: pointBytes(RVv),
    RDv: pointBytes(RDv),
    RVr: pointBytes(RVr),
    RDr: pointBytes(RDr),
    zv: scalarBytes(Fn.add(kv, Fn.mul(e, f(v)))),
    zr: scalarBytes(Fn.add(kr, Fn.mul(e, f(r)))),
    ztv: scalarBytes(Fn.add(ktv, Fn.mul(e, Tv))),
    ztr: scalarBytes(Fn.add(ktr, Fn.mul(e, Tr))),
    vLimbs,
    rLimbs,
  };
}

function weighted(chunks, from, count, pick) {
  let acc = Point.ZERO;
  for (let j = 0; j < count; j += 1) {
    acc = acc.add(mulP(pointFrom(pick(chunks[from + j])), 1n << (16n * BigInt(j))));
  }
  return acc;
}

function verifyAggregate(chunks, Y, C, proof, extra) {
  try {
    const RC = pointFrom(proof.RC);
    const RVv = pointFrom(proof.RVv);
    const RDv = pointFrom(proof.RDv);
    const RVr = pointFrom(proof.RVr);
    const RDr = pointFrom(proof.RDr);
    const e = hashToScalar(
      pointBytes(RC), pointBytes(RVv), pointBytes(RDv), pointBytes(RVr), pointBytes(RDr),
      pointBytes(C), pointBytes(Y), extra,
    );
    const zv = scalarFrom(proof.zv);
    const zr = scalarFrom(proof.zr);
    const ztv = scalarFrom(proof.ztv);
    const ztr = scalarFrom(proof.ztr);
    const Vv = weighted(chunks, 0, V_CHUNKS, (c) => c.epV);
    const Dv = weighted(chunks, 0, V_CHUNKS, (c) => c.epD);
    const Vr = weighted(chunks, V_CHUNKS, R_CHUNKS, (c) => c.epV);
    const Dr = weighted(chunks, V_CHUNKS, R_CHUNKS, (c) => c.epD);
    if (!G.multiply(zv).add(H.multiply(zr)).equals(RC.add(C.multiply(e)))) return false;
    if (!G.multiply(ztv).equals(RVv.add(Vv.multiply(e)))) return false;
    if (!Y.multiply(ztv).add(G.multiply(zv)).equals(RDv.add(Dv.multiply(e)))) return false;
    if (!G.multiply(ztr).equals(RVr.add(Vr.multiply(e)))) return false;
    if (!Y.multiply(ztr).add(G.multiply(zr)).equals(RDr.add(Dr.multiply(e)))) return false;
    return true;
  } catch {
    return false;
  }
}

function proveNoteRange(v, r, extra) {
  const bits = proveBits(v, 64, r, extra);
  return { tag: RANGE_TAG, ...bits };
}

function verifyNoteRange(C, proof, extra) {
  if (!proof || proof.tag !== RANGE_TAG) return false;
  return verifyBits(C, 64, proof, extra);
}

/** Bits that cover W−1. W < 2^48, so this is at most 48. */
function rhoBits(W) {
  const span = W - 1n;
  if (span <= 0n) return 1;
  return span.toString(2).length;
}

function verifyRhoRange(rhoC, W, proof, stmt) {
  try {
    const k = rhoBits(W);
    if (!proof || proof.k !== k) return false;
    const delC = pointOk(proof.deltaC);
    if (!delC) return false;
    if (!verifyBits(rhoC, k, proof.rho, stmt)) return false;
    if (!verifyBits(delC, k, proof.delta, stmt)) return false;
    const linkP = rhoC.add(delC).subtract(mulP(G, W - 1n));
    return verifyH(linkP, proof.link, stmt);
  } catch {
    return false;
  }
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
      const epV = pointFrom(chunk.epV);
      const epD = pointFrom(chunk.epD);
      const M = epD.subtract(epV.multiply(y));
      const m = bsgs(M);
      if (m == null) return null;
      ms.push(m);
    }
    let v = 0n;
    let r = 0n;
    for (let i = 0; i < V_CHUNKS; i += 1) v += ms[i] << (16n * BigInt(i));
    for (let i = 0; i < R_CHUNKS; i += 1) r += ms[V_CHUNKS + i] << (16n * BigInt(i));
    return { v, r: f(r) };
  } catch {
    return null;
  }
}

function proveProduct(Ca, a, ra, Cb, inv, rInv, extra) {
  const kA = randomScalar();
  const kBlind = randomScalar();
  const kR = randomScalar();
  const Rp = Cb.multiply(kA).subtract(H.multiply(kR));
  const Ra = G.multiply(kA).add(H.multiply(kBlind));
  const e = hashToScalar(pointBytes(Rp), pointBytes(Ra), pointBytes(Ca), pointBytes(Cb), extra);
  const rDiff = mod(mod(a) * mod(rInv));
  return {
    Rp: pointBytes(Rp),
    Ra: pointBytes(Ra),
    zA: scalarBytes(Fn.add(kA, Fn.mul(e, f(a)))),
    zDiff: scalarBytes(Fn.add(kR, Fn.mul(e, f(rDiff)))),
    zBlind: scalarBytes(Fn.add(kBlind, Fn.mul(e, f(ra)))),
  };
}

function verifyProduct(Ca, Cb, one, proof, extra) {
  try {
    const Rp = pointFrom(proof.Rp);
    const Ra = pointFrom(proof.Ra);
    const e = hashToScalar(pointBytes(Rp), pointBytes(Ra), pointBytes(Ca), pointBytes(Cb), extra);
    const zA = scalarFrom(proof.zA);
    const zDiff = scalarFrom(proof.zDiff);
    const zBlind = scalarFrom(proof.zBlind);
    const leftP = Cb.multiply(zA).subtract(H.multiply(zDiff));
    const rightP = Rp.add(one.multiply(e));
    const leftA = G.multiply(zA).add(H.multiply(zBlind));
    const rightA = Ra.add(Ca.multiply(e));
    return leftP.equals(rightP) && leftA.equals(rightA);
  } catch {
    return false;
  }
}

export function pickChallenge(stmt, lambdas) {
  for (let n = 0; n < 64; n += 1) {
    const X = hashToScalar(Buffer.from(LOGUP_DOM), stmt, Buffer.from([n]));
    if (Fn.is0(X)) continue;
    let hit = false;
    for (const lam of lambdas) {
      if (Fn.eql(X, lam)) hit = true;
    }
    if (!hit) return { X, n };
  }
  return null;
}

function stable(value) {
  if (value == null) return Buffer.from([0]);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.concat([Buffer.from([1]), u32le(value.length), Buffer.from(value)]);
  }
  if (typeof value === 'bigint') {
    return Buffer.concat([Buffer.from([2]), Buffer.from(value.toString(10))]);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return Buffer.concat([Buffer.from([3]), Buffer.from(String(value))]);
  }
  if (typeof value === 'string') {
    return Buffer.concat([Buffer.from([4]), Buffer.from(value)]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from([5]), u32le(value.length), ...value.map(stable)]);
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [Buffer.from([6]), u32le(keys.length)];
    for (const k of keys) parts.push(Buffer.from(k), stable(value[k]));
    return Buffer.concat(parts);
  }
  return Buffer.from([0]);
}

function sha(buf) {
  return createHash('sha256').update(buf).digest();
}

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
    rhoC: bytes32(o.rhoC) || Buffer.alloc(0),
    fin: String(o.fin == null ? 0 : o.fin),
    vaultNanos: String(o.vaultNanos == null ? '' : o.vaultNanos),
    rhoDelta: bytes32(o.rhoDelta) || Buffer.alloc(0),
    chunks: (o.ra?.chunks || []).map((c) => ({ epV: bytes32(c.epV), epD: bytes32(c.epD) })),
  }));
  const shares = (t21.shares || []).map((s) => ({
    w: String(s.w),
    lambda: bytes32(s.lambda) || Buffer.alloc(0),
    E: bytes32(s.E) || Buffer.alloc(0),
    bind: Buffer.from(asU8(s.bind || Buffer.alloc(0))),
  }));
  const body = {
    cbForm: tx.cbForm,
    S: String(t21.S),
    cin: String(t21.cin),
    cout: String(tx.carryNanos || 0),
    bps: String(t21.bps),
    u: String(t21.u || 0),
    height: String(t21.height),
    magic: String(t21.magic),
    prevHash: bytes32(t21.prevHash) || Buffer.alloc(0),
    rows,
    shares,
  };
  return sha(stable(body));
}

export function batchWeightOf(stmt) {
  return createHash('sha512').update(Buffer.from(BATCH_DOM)).update(stmt).digest().subarray(0, 16);
}

function proofView(tx) {
  return {
    tally: tx?.t21?.tally || null,
    mint: tx?.t21?.mint || null,
    rows: (tx?.vout || []).map((o) => ({
      law: o.law || null,
      rhoRange: o.rhoRange || null,
      ra: o.ra ? { agg: o.ra.agg, chunks: o.ra.chunks } : null,
      rangeProof: o.rangeProof || null,
    })),
  };
}

export function t21Fin(tx) {
  if (!isT21Coinbase(tx)) return null;
  return sha(Buffer.concat([statementOf(tx), sha(stable(proofView(tx)))]));
}

export function t21DigestSuffix(tx) {
  const fin = t21Fin(tx);
  if (!fin) return null;
  return Buffer.concat([Buffer.from('t21v1'), fin]);
}

function planPay(spec, payees) {
  const S = scalarOk(spec.S);
  const cin = scalarOk(spec.cin);
  const bps = t21Big(spec.bps);
  const u = scalarOk(spec.u || 0);
  if (S == null || cin == null || u == null || bps == null) return null;
  const f = feeOf(S, bps);
  if (f == null) return null;
  const R = S + cin - f;
  if (R < 0n) return null;
  let W = 0n;
  const groups = [];
  for (const p of payees) {
    let Wi = 0n;
    const shares = [];
    for (const s of p.shares || []) {
      const w = scalarOk(s.w);
      if (w == null || w <= 0n || w > W_S_MAX) return { error: 'split_cap' };
      Wi += w;
      shares.push({ ...s, w });
    }
    if (Wi >= W_MAX) return { error: 'split_cap' };
    W += Wi;
    const fin = scalarOk(p.fin || 0);
    if (fin == null) return { error: 'split_cap' };
    groups.push({ ...p, Wi, fin, shares });
  }
  if (W >= W_MAX) return { error: 'split_cap' };
  if (groups.length > N_MAX) return { error: 'split_cap' };
  const rate = R + W * u;
  let phi = 0n;
  const rows = [];
  for (const g of groups) {
    const law = g.Wi === 0n
      ? { v: g.fin, rho: 0n }
      : splitLaw({ R, W, Wi: g.Wi, u, fin: g.fin });
    if (!law) return { error: 'pot_sched' };
    phi += g.fin;
    rows.push({ ...g, v: law.v, rho: law.rho });
  }
  const dust = W === 0n ? (cin + S) : lawDust(rows.map((r) => r.rho), W);
  if (dust == null) return { error: 'pot_sched' };
  return { S, cin, f, bps, u, R, W, rate, phi, rows, dust };
}


function emptyCoinbase(spec, deferred) {
  const S = scalarOk(spec.S);
  const cin = scalarOk(spec.cin);
  if (S == null || cin == null) return null;
  const tx = {
    coinbase: true,
    cbForm: CB_FORM,
    height: spec.height,
    vin: [{ coinbase: true, height: spec.height }],
    vout: [],
    carryNanos: Number(cin + S),
    excess: scalarBytes(Fn.ZERO),
    t21: {
      S: S.toString(),
      cin: cin.toString(),
      bps: 0,
      u: '0',
      height: spec.height,
      magic: spec.magic,
      prevHash: Buffer.from(asU8(spec.prevHash)),
      shares: [],
      tally: null,
      mint: null,
    },
  };
  tx.t21.stmt = statementOf(tx);
  tx.t21.bw = batchWeightOf(tx.t21.stmt);
  tx.t21.fin = t21Fin(tx);
  return { tx, deferred, secrets: [], paid: 0n };
}

function proveTally(rows, shares, W, stmt) {
  const lambdas = rows.map((r) => scalarFrom(r.pub.lambda));
  const picked = pickChallenge(stmt, lambdas);
  if (!picked) return null;
  const { X } = picked;
  const invProofs = [];
  let hShare = Fn.ZERO;
  const one = G;
  for (const share of shares) {
    const ell = share._ell;
    const beta = share._beta;
    const E = share._E;
    const a = Fn.sub(X, ell);
    if (Fn.is0(a)) return null;
    const inv = Fn.inv(a);
    const rInv = randomScalar();
    const Cb = mulP(G, sb(inv)).add(H.multiply(rInv));
    const Ca = mulP(G, sb(X)).subtract(E);
    const proof = proveProduct(Ca, sb(a), mod(-sb(beta)), Cb, sb(inv), sb(rInv), stmt);
    invProofs.push({ Cinv: pointBytes(Cb), proof });
    hShare = Fn.add(hShare, Fn.mul(f(share.wInt), rInv));
  }
  let Crow = Point.ZERO;
  let hRow = Fn.ZERO;
  rows.forEach((row, i) => {
    const lam = lambdas[i];
    const denom = Fn.sub(X, lam);
    const invLam = Fn.inv(denom);
    const CW = pointFrom(row.pub.cw);
    Crow = Crow.add(CW.multiply(invLam));
    hRow = Fn.add(hRow, Fn.mul(invLam, row._rw));
  });
  let Cshare = Point.ZERO;
  invProofs.forEach((p, i) => {
    Cshare = Cshare.add(mulP(pointFrom(p.Cinv), shares[i].wInt));
  });
  const balP = Cshare.subtract(Crow);
  const balS = mod(sb(hShare) - sb(hRow));
  const balance = proveH(balP, balS, stmt);
  let sumW = Point.ZERO;
  let hW = Fn.ZERO;
  for (const row of rows) {
    sumW = sumW.add(pointFrom(row.pub.cw));
    hW = Fn.add(hW, row._rw);
  }
  const weightP = sumW.subtract(mulP(G, W));
  const weight = proveH(weightP, sb(hW), stmt);
  return { n: picked.n, inv: invProofs, balance, weight, bw: batchWeightOf(stmt) };
}

function proveMint(rows, feeRow, mintG, stmt) {
  let sum = Point.ZERO;
  let h = Fn.ZERO;
  for (const row of rows) {
    sum = sum.add(pointFrom(row.pub.commit));
    h = Fn.add(h, row._r);
  }
  if (feeRow) {
    sum = sum.add(pointFrom(feeRow.commit));
    h = Fn.add(h, feeRow._r);
  }
  const P = sum.subtract(mulP(G, mintG));
  return { proof: proveH(P, sb(h), stmt), excess: scalarBytes(h) };
}

export function settleBatch(rows, shares) {
  const bad = new Set();
  for (const row of rows || []) {
    if (!rowIsLeaf(row)) bad.add(Buffer.from(asU8(row.lambda || Buffer.alloc(0))).toString('hex'));
  }
  if (!bad.size) return { evicted: false, rows: rows || [], deferred: [], shares: shares || [] };
  const keep = (s) => !bad.has(Buffer.from(asU8(s.lambda || Buffer.alloc(0))).toString('hex'));
  return {
    evicted: true,
    rows: (rows || []).filter((r) => !bad.has(Buffer.from(asU8(r.lambda || Buffer.alloc(0))).toString('hex'))),
    deferred: (shares || []).filter((s) => !keep(s)),
    shares: (shares || []).filter(keep),
  };
}

function padDummies(spec, rows, random) {
  const secret = spec.dummySecret || randomScalar();
  const dummySecret = Buffer.from(scalarBytes(typeof secret === 'bigint' || secret?.length === 32 ? (Buffer.isBuffer(secret) ? hashToScalar(secret) : secret) : random()));
  let ctr = 0;
  const out = rows.slice();
  while (out.filter((r) => r.kind !== 'pool-fee').length < K_MIN && ctr <= 8) {
    const vch = voucherAt(Buffer.isBuffer(spec.dummySecret) ? spec.dummySecret : dummySecret, ctr);
    ctr += 1;
    out.push({
      secret: Buffer.isBuffer(spec.dummySecret) ? spec.dummySecret : dummySecret,
      ctr: ctr - 1,
      kind: 'dummy',
      fin: 0n,
      Wi: 0n,
      v: 0n,
      rho: 0n,
      shares: [],
      W: rows[0]?.W || 0n,
      rate: rows[0]?.rate || 0n,
      lambdaPreview: vch.lambdaBytes,
    });
    if (ctr > 32) break;
  }
  return out;
}

export function buildT21Coinbase(spec) {
  const random = spec.random || randomScalar;
  const deferred = [];
  const live = [];
  for (const p of spec.payees || []) {
    if (p.breakLeaf) {
      const vch = voucherAt(p.secret, p.ctr);
      for (const s of p.shares || []) {
        deferred.push({
          w: String(s.w),
          lambda: vch.lambdaBytes,
          header: s.header,
          jobKey: s.jobKey,
        });
      }
      continue;
    }
    live.push(p);
  }
  if (spec._rebuilt && (spec.payees || []).some((p) => p.breakLeaf)) {
    const err = new Error('admit_note_point');
    err.reason = 'admit_note_point';
    throw err;
  }
  if (!live.length) return emptyCoinbase(spec, deferred);
  const planned = planPay(spec, live);
  if (!planned || planned.error) {
    const err = new Error(planned?.error || 'pot_sched');
    err.reason = planned?.error || 'pot_sched';
    throw err;
  }
  if (planned.W === 0n) return emptyCoinbase(spec, deferred);
  let work = planned.rows.map((r) => ({ ...r, W: planned.W, rate: planned.rate }));
  work = padDummies({ ...spec, dummySecret: spec.dummySecret }, work, random);
  const vaults = [];
  for (const vrow of spec.vaults || []) {
    const built = vaultCommit(vrow.vaultNanos, vrow.mintId, spec.height, spec.blockHash);
    if (!built) {
      const err = new Error('vault_pin');
      err.reason = 'vault_pin';
      throw err;
    }
    vaults.push({
      kind: 'vault-withdraw-pinned',
      kindCode: VAULT_KIND_CODE,
      vaultNanos: scalarOk(vrow.vaultNanos).toString(),
      commit: built.commit,
      noteCommit: sha(Buffer.concat([Buffer.from('shear-t21-vault'), Buffer.from(asU8(vrow.mintId))])),
      admitPub: pointBytes(G),
    });
  }
  const committed = [];
  for (let index = 0; index < work.length; index += 1) {
    const row = work[index];
    const vch = voucherAt(row.secret, row.ctr);
    let r = random();
    let Cpoint = commit(row.v, r);
    let delta = payoutDelta({
      magic: spec.magic, height: spec.height, prevHash: spec.prevHash, index, commit: pointBytes(Cpoint),
    });
    let guard = 0;
    while (guard < 6 && (Fn.is0(delta) || !rowIsLeaf({
      admitPub: pointBytes(vch.B.add(G.multiply(delta))),
      commit: pointBytes(Cpoint),
    }))) {
      r = random();
      Cpoint = commit(row.v, r);
      delta = payoutDelta({
        magic: spec.magic, height: spec.height, prevHash: spec.prevHash, index, commit: pointBytes(Cpoint),
      });
      guard += 1;
    }
    const P = vch.B.add(G.multiply(delta));
    if (Fn.is0(delta) || !rowIsLeaf({ admitPub: pointBytes(P), commit: pointBytes(Cpoint) })) {
      const err = new Error('admit_note_point');
      err.reason = 'admit_note_point';
      throw err;
    }
    committed.push({ row, vch, r, Cpoint, P, index });
  }
  const skeletonShares = [];
  const shareSecrets = [];
  for (const item of committed) {
    for (const s of item.row.shares || []) {
      const beta = random();
      const E = mulP(G, sb(item.vch.lambda)).add(H.multiply(beta));
      const Ebytes = pointBytes(E);
      const rec = {
        w: s.w.toString(),
        lambda: Buffer.from(item.vch.lambdaBytes),
        E: Ebytes,
        bind: shareBindTag(s.header, s.jobKey, Ebytes),
        header: Buffer.from(asU8(s.header)),
        jobKey: Buffer.from(asU8(s.jobKey)),
      };
      skeletonShares.push(rec);
      shareSecrets.push({ ...rec, _ell: item.vch.lambda, _beta: beta, _E: E, wInt: s.w });
    }
  }
  const skel = {
    coinbase: true,
    cbForm: CB_FORM,
    carryNanos: Number(planned.dust),
    vout: committed.map((item) => ({
      kind: item.row.kind,
      kindCode: PAYOUT_KIND_CODE,
      noteCommit: sha(Buffer.concat([
        Buffer.from('shear-t21-nc-v1'), item.vch.lambdaBytes, u32le(item.index),
      ])),
      commit: pointBytes(item.Cpoint),
      admitPub: pointBytes(item.P),
      B: pointBytes(item.vch.B),
      Y: pointBytes(item.vch.Y),
      lambda: Buffer.from(item.vch.lambdaBytes),
      rEph: Buffer.alloc(32),
      rCt: Buffer.alloc(32),
      amtCt: Buffer.alloc(8),
      cw: Buffer.alloc(32),
      rhoC: Buffer.alloc(32),
      fin: item.row.fin === 0n ? 0 : item.row.fin.toString(),
      ra: { chunks: [] },
    })).concat(vaults),
    t21: {
      S: planned.S.toString(),
      cin: planned.cin.toString(),
      bps: Number(planned.bps),
      u: planned.u.toString(),
      height: spec.height,
      magic: spec.magic,
      prevHash: Buffer.from(asU8(spec.prevHash)),
      shares: skeletonShares,
    },
  };
  // rEph/rCt/amtCt/cw/rhoC change the statement. Fill them before proving,
  // then prove against statementOf(skel). Ranges run once.
  const filled = [];
  for (const item of committed) {
    const rw = random();
    const rRho = random();
    const rDel = random();
    const cw = commit(item.row.Wi, rw);
    const rhoC = commit(item.row.rho, rRho);
    const deltaRho = item.row.W - 1n - item.row.rho;
    const delC = commit(deltaRho, rDel);
    const noteCommit = sha(Buffer.concat([
      Buffer.from('shear-t21-nc-v1'), item.vch.lambdaBytes, u32le(item.index),
    ]));
    let sealed = {
      kind: item.row.kind,
      noteCommit,
      commit: pointBytes(item.Cpoint),
      r: scalarBytes(item.r),
    };
    sealed = wrapNoteBlind(sealed, item.vch.B, item.row.v);
    const limbMs = [...limbsOf(item.row.v, V_CHUNKS), ...limbsOf(sb(item.r), R_CHUNKS)];
    const encs = limbMs.map((m) => encryptLimb(m, item.vch.Y));
    filled.push({
      ...item, rw, rRho, rDel, cw, rhoC, delC, deltaRho, noteCommit, sealed, encs,
    });
  }
  for (let i = 0; i < filled.length; i += 1) {
    const item = filled[i];
    skel.vout[i].rEph = item.sealed.rEph;
    skel.vout[i].rCt = item.sealed.rCt;
    skel.vout[i].amtCt = item.sealed.amtCt;
    skel.vout[i].cw = pointBytes(item.cw);
    skel.vout[i].rhoC = pointBytes(item.rhoC);
    skel.vout[i].rhoDelta = pointBytes(item.delC);
    skel.vout[i].ra = {
      chunks: item.encs.map((enc) => ({ epV: pointBytes(enc.epV), epD: pointBytes(enc.epD) })),
    };
  }
  const stmt = statementOf(skel);
  const pubs = [];
  for (const item of filled) {
    const extra = stmt;
    const chunks = item.encs.map((enc) => finishChunk(enc, item.vch.Y, extra));
    const agg = proveAggregate(chunks, item.row.v, sb(item.r), item.vch.Y, item.Cpoint, extra);
    const rangeProof = proveNoteRange(item.row.v, item.r, extra);
    const hLaw = mod(mod(item.row.W) * sb(item.r) - mod(item.row.rate) * sb(item.rw) + sb(item.rRho));
    const lawPoint = mulP(item.Cpoint, item.row.W)
      .subtract(mulP(item.cw, item.row.rate))
      .add(item.rhoC)
      .subtract(mulP(G, item.row.W * item.row.fin));
    const law = proveH(lawPoint, hLaw, extra);
    const kRho = rhoBits(item.row.W);
    const rhoRange = {
      k: kRho,
      deltaC: pointBytes(item.delC),
      rho: proveBits(item.row.rho, kRho, item.rRho, extra),
      delta: proveBits(item.deltaRho, kRho, item.rDel, extra),
      link: proveH(
        item.rhoC.add(item.delC).subtract(mulP(G, item.row.W - 1n)),
        mod(sb(item.rRho) + sb(item.rDel)),
        extra,
      ),
    };
    const pub = {
      ...skel.vout[item.index],
      ra: {
        chunks: chunks.map(({ epV, epD, Mpt, bindR1, bindR2, zT, zS, range }) => ({
          epV, epD, Mpt, bindR1, bindR2, zT, zS, range,
        })),
        agg,
      },
      law,
      rhoRange,
      rangeProof,
    };
    pubs.push(pub);
  }
  const tallyRows = filled.map((item, i) => ({
    pub: pubs[i],
    _rw: item.rw,
    _r: item.r,
  }));
  const tally = proveTally(tallyRows, shareSecrets, planned.W, stmt);
  if (!tally) {
    const err = new Error('split_tally');
    err.reason = 'split_tally';
    throw err;
  }
  const mintG = planned.S + planned.cin - planned.f - planned.dust + planned.u * planned.W + planned.phi;
  const mint = proveMint(tallyRows, null, mintG, stmt);
  const tx = {
    coinbase: true,
    cbForm: CB_FORM,
    height: spec.height,
    vin: [{ coinbase: true, height: spec.height }],
    vout: pubs.concat(vaults),
    carryNanos: Number(planned.dust),
    excess: mint.excess,
    t21: {
      ...skel.t21,
      shares: skeletonShares,
      tally,
      mint: mint.proof,
      stmt,
      bw: batchWeightOf(stmt),
    },
  };
  tx.t21.fin = t21Fin(tx);
  const paid = filled.reduce((a, item) => a + item.row.v, 0n)
    + vaults.reduce((a, v) => a + BigInt(v.vaultNanos), 0n);
  return {
    tx,
    deferred,
    paid,
    secrets: filled.map((item) => ({
      v: item.row.v,
      r: item.r,
      b: item.vch.b,
      y: item.vch.y,
      lambda: item.vch.lambda,
      ctr: item.row.ctr,
      kind: item.row.kind,
    })),
    dust: planned.dust,
    W: planned.W,
    f: planned.f,
    phi: planned.phi,
  };
}

function hasKey(o, k) {
  return !!o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
}

function payoutRows(tx) {
  return (tx.vout || []).filter((o) => Number(o.kindCode) === PAYOUT_KIND_CODE || PAYOUT_KINDS.has(String(o.kind || '')));
}

function vaultRows(tx) {
  return (tx.vout || []).filter((o) => Number(o.kindCode) === VAULT_KIND_CODE || o.kind === 'vault-withdraw-pinned');
}

export function verifyT21Coinbase(input) {
  const tx = input.tx || input;
  const blockHash = input.blockHash || tx?.t21?.blockHash || Buffer.alloc(32);
  if (!isT21Coinbase(tx)) return no('cb_form');
  const vout = Array.isArray(tx.vout) ? tx.vout : [];
  if (vout.length > OUTPUT_MAX) return no('tx_cap');
  const payees = payoutRows(tx).filter((o) => o.kind !== 'pool-fee');
  const shares = Array.isArray(tx.t21?.shares) ? tx.t21.shares : [];
  if (shares.length > N_MAX) return no('split_cap');
  for (const s of shares) {
    const w = scalarOk(s.w);
    if (w == null || w <= 0n || w > W_S_MAX) return no('split_cap');
  }
  if (payees.length > L_MAX) return no('payee_cap');
  for (const o of vout) {
    if (hasKey(o, 'amtCt')) {
      const n = Buffer.from(asU8(o.amtCt)).length;
      if (n !== 8) return no('amount_ct');
    }
    const vault = Number(o.kindCode) === VAULT_KIND_CODE || o.kind === 'vault-withdraw-pinned';
    if (!vault) {
      for (const k of AMOUNT_KEYS) {
        if (hasKey(o, k)) return no('amount_field');
      }
      if (hasKey(o, 'valueProof')) return no('value_open');
    }
    if (vault && (hasKey(o, 'nonce') || hasKey(o, 'userR'))) return no('vault_pin');
  }
  const S = scalarOk(tx.t21?.S);
  const cin = scalarOk(tx.t21?.cin);
  const u = scalarOk(tx.t21?.u || 0);
  const bps = t21Big(tx.t21?.bps);
  const cout = scalarOk(tx.carryNanos || 0);
  if (S == null || cin == null || u == null || cout == null || bps == null) return no('split_cap');
  if (bps > BigInt(FEE_BPS_MAX)) return no('fee_sched');
  const f = feeOf(S, bps);
  if (f == null) return no('fee_sched');
  let fins = 0;
  for (const o of payees) {
    if (t21Big(o.fin || 0) > 0n) fins += 1;
  }
  if (fins > 1) return no('finder_row');
  if (shares.length === 0) {
    if (payees.length || payoutRows(tx).some((o) => o.kind === 'pool-fee')) return no('pot_carry');
    if (cout !== cin + S) return no('pot_sched');
    if (f !== 0n || u !== 0n) return no('fee_sched');
    for (const vrow of vaultRows(tx)) {
      const want = vaultCommit(vrow.vaultNanos, tx.t21.mintId || vrow.mintId, tx.t21.height, blockHash);
      if (!want || !bytes32(vrow.commit) || !Buffer.from(vrow.commit).equals(want.commit)) return no('vault_pin');
    }
    const stmt = statementOf(tx);
    if (!tx.t21.bw || Buffer.from(tx.t21.bw).length !== 16 || !Buffer.from(tx.t21.bw).equals(batchWeightOf(stmt))) {
      return no('split_tally');
    }
    return { ok: true, reason: null, paid: 0n };
  }
  if (payees.length < K_MIN) return no('payee_cap');
  let W = 0n;
  const seenE = new Set();
  const seenL = new Set();
  for (const s of shares) {
    const w = scalarOk(s.w);
    if (w == null || w <= 0n || w > W_S_MAX) return no('split_cap');
    W += w;
    const E = pointOk(s.E);
    if (!E) return no('share_label');
    const hexE = Buffer.from(s.E).toString('hex');
    if (seenE.has(hexE)) return no('share_label');
    seenE.add(hexE);
    const bind = shareBindTag(s.header, s.jobKey, s.E);
    if (!Buffer.from(asU8(s.bind)).equals(bind)) return no('share_bind');
  }
  if (W <= 0n || W >= W_MAX) return no('split_cap');
  for (const o of payoutRows(tx)) {
    if (!PAYOUT_KINDS.has(String(o.kind || ''))) return no('cb_form');
    if (Number(o.kindCode) !== PAYOUT_KIND_CODE) return no('cb_form');
    const fields = ['commit', 'admitPub', 'B', 'Y', 'lambda', 'rEph', 'rCt', 'cw', 'rhoC', 'noteCommit'];
    for (const k of fields) {
      if (!bytes32(o[k])) return no('cb_form');
    }
    if (!o.amtCt || Buffer.from(asU8(o.amtCt)).length !== 8) return no('amount_ct');
    if (!o.ra || !Array.isArray(o.ra.chunks) || o.ra.chunks.length !== VE_CHUNKS) return no('cb_form');
    const lam = Buffer.from(o.lambda).toString('hex');
    if (seenL.has(lam)) return no('split_label');
    seenL.add(lam);
    const B = pointOk(o.B);
    const Y = pointOk(o.Y);
    const C = pointOk(o.commit);
    const P = pointOk(o.admitPub);
    if (!B || !Y || !C || !P) return no('cb_point');
    for (const chunk of o.ra.chunks) {
      if (!pointOk(chunk.epV) || !pointOk(chunk.epD)) return no('cb_point');
    }
    const delta = payoutDelta({
      magic: tx.t21.magic,
      height: tx.t21.height,
      prevHash: tx.t21.prevHash,
      index: vout.indexOf(o),
      commit: o.commit,
    });
    if (Fn.is0(delta)) return no('cb_key');
    const wantP = B.add(G.multiply(delta));
    if (!wantP.equals(P)) return no('cb_key');
    if (!rowIsLeaf(o)) return no('admit_note_point');
  }
  for (const vrow of vaultRows(tx)) {
    const want = vaultCommit(vrow.vaultNanos, tx.t21.mintId || vrow.mintId, tx.t21.height, blockHash);
    if (!want || !bytes32(vrow.commit) || !Buffer.from(asU8(vrow.commit)).equals(want.commit)) return no('vault_pin');
  }
  const R = S + cin - f;
  if (R < 0n) return no('pot_sched');
  let phi = 0n;
  const rhos = [];
  for (const o of payoutRows(tx)) {
    if (o.kind === 'pool-fee' || o.kind === 'dummy') {
      rhos.push(0n);
      continue;
    }
    phi += t21Big(o.fin || 0) || 0n;
  }
  // ρ is hidden. The dust carried on the coinbase is checked through the mint
  // identity and the published carry. A full-pot carry beside shares is rejected.
  if (cout === cin + S && R !== 0n) return no('pot_carry');
  const stmt = statementOf(tx);
  if (!tx.t21.stmt || !Buffer.from(tx.t21.stmt).equals(stmt)) return no('split_law');
  if (!tx.t21.bw || Buffer.from(asU8(tx.t21.bw)).length !== 16 || !Buffer.from(asU8(tx.t21.bw)).equals(batchWeightOf(stmt))) {
    return no('split_tally');
  }
  const payout = payoutRows(tx);
  // T-8 before T-9: a shifted share weight fails the tally weight-sum before the law.
  if (!verifyTally(tx, payout, shares, W, stmt)) return no('split_tally');
  for (const o of payout) {
    const C = pointFrom(o.commit);
    const CW = pointFrom(o.cw);
    const Cr = pointFrom(o.rhoC);
    const fin = t21Big(o.fin || 0);
    // The verifier does not know W_i. The law Schnorr is an H-opening of
    // W·C − rate·CW + Cρ − (W·fin)·G. Per-row W_i stays inside cw.
    const rate = R + W * u;
    const lawPoint = mulP(C, W).subtract(mulP(CW, rate)).add(Cr).subtract(mulP(G, W * fin));
    if (!verifyH(lawPoint, o.law, stmt)) return no('split_law');
    if (!bytes32(o.rhoDelta) || !o.rhoRange || !Buffer.from(asU8(o.rhoRange.deltaC)).equals(Buffer.from(o.rhoDelta))) {
      return no('split_law');
    }
    // 0 ≤ ρ < W: both ρ and (W−1−ρ) open as k-bit values and sum to W−1.
    if (!verifyRhoRange(Cr, W, o.rhoRange, stmt)) return no('split_law');
  }
  const mintG = S + cin - f - cout + u * W + phi;
  if (!verifyMint(tx, payout, mintG, stmt)) return no('split_mint');
  for (const o of payout) {
    const Y = pointFrom(o.Y);
    const C = pointFrom(o.commit);
    if (!verifyAggregate(o.ra.chunks, Y, C, o.ra.agg, stmt)) return no('cb_wrap');
    for (const chunk of o.ra.chunks) {
      if (!verifyChunk(chunk, Y, stmt)) return no('cb_wrap');
    }
    if (!verifyNoteRange(C, o.rangeProof, stmt)) return no('range_proof');
  }
  let vaultPaid = 0n;
  for (const vrow of vaultRows(tx)) vaultPaid += t21Big(vrow.vaultNanos) || 0n;
  return { ok: true, reason: null, paid: mintG + f + vaultPaid, f, W, phi };
}

function verifyTally(tx, rows, shares, W, stmt) {
  try {
    const tally = tx.t21.tally;
    if (!tally || !Array.isArray(tally.inv) || tally.inv.length !== shares.length) return false;
    const lambdas = rows.map((r) => scalarFrom(r.lambda));
    const picked = pickChallenge(stmt, lambdas);
    if (!picked || picked.n !== tally.n) return false;
    const { X } = picked;
    let Cshare = Point.ZERO;
    for (let i = 0; i < shares.length; i += 1) {
      const E = pointFrom(shares[i].E);
      const Ca = mulP(G, sb(X)).subtract(E);
      const Cb = pointFrom(tally.inv[i].Cinv);
      if (!verifyProduct(Ca, Cb, G, tally.inv[i].proof, stmt)) return false;
      Cshare = Cshare.add(mulP(Cb, t21Big(shares[i].w)));
    }
    let Crow = Point.ZERO;
    for (let i = 0; i < rows.length; i += 1) {
      const denom = Fn.sub(X, lambdas[i]);
      if (Fn.is0(denom)) return false;
      Crow = Crow.add(pointFrom(rows[i].cw).multiply(Fn.inv(denom)));
    }
    if (!verifyH(Cshare.subtract(Crow), tally.balance, stmt)) return false;
    let sumW = Point.ZERO;
    for (const row of rows) sumW = sumW.add(pointFrom(row.cw));
    if (!verifyH(sumW.subtract(mulP(G, W)), tally.weight, stmt)) return false;
    return true;
  } catch {
    return false;
  }
}

function verifyMint(tx, rows, mintG, stmt) {
  try {
    let sum = Point.ZERO;
    for (const row of rows) sum = sum.add(pointFrom(row.commit));
    const P = sum.subtract(mulP(G, mintG));
    if (!verifyH(P, tx.t21.mint, stmt)) return false;
    const excess = bytes32(tx.excess);
    if (!excess) return false;
    const T = mulP(G, mintG).add(H.multiply(scalarFrom(excess)));
    return sum.equals(T);
  } catch {
    return false;
  }
}

export function openOutput(row, walletSecret, ctx, { start = 0, gap = 256 } = {}) {
  const pubs = [];
  const found = [];
  const match = (v) => {
    try {
      if (!Buffer.from(pointBytes(v.B)).equals(Buffer.from(asU8(row.B)))) return false;
      const delta = payoutDelta({
        magic: ctx.magic,
        height: ctx.height,
        prevHash: ctx.prevHash,
        index: ctx.index,
        commit: row.commit,
      });
      const P = v.B.add(G.multiply(delta));
      return P.equals(pointFrom(row.admitPub));
    } catch {
      return false;
    }
  };
  const vouchers = scanFor(walletSecret, match, start, gap);
  if (!vouchers.length) return null;
  const vch = vouchers[0];
  const amt = openNoteAmount(row, vch.b);
  if (amt && commit(amt.v, scalarFrom(amt.r)).equals(pointFrom(row.commit))) {
    return { v: amt.v, r: scalarFrom(amt.r), via: 'amtCt' };
  }
  const ve = decryptVe(row, vch.y);
  if (!ve) return null;
  if (!commit(ve.v, ve.r).equals(pointFrom(row.commit))) return null;
  return { v: ve.v, r: ve.r, via: 've' };
  void pubs;
  void found;
}

function scanFor(secret, match, start, gap) {
  const { scanVouchers } = { scanVouchers: null };
  void scanVouchers;
  const out = [];
  let misses = 0;
  for (let c = start; misses < gap && c < start + 1_000_000; c += 1) {
    const v = voucherAt(secret, c);
    if (match(v)) {
      out.push(v);
      break;
    }
    misses += 1;
  }
  return out;
}

export function observerView(tx) {
  const leaks = [];
  const fins = [];
  for (const o of tx?.vout || []) {
    const vault = Number(o.kindCode) === VAULT_KIND_CODE || RESERVE_ROW(o);
    if (vault) continue;
    for (const k of AMOUNT_KEYS) {
      if (hasKey(o, k)) leaks.push({ index: tx.vout.indexOf(o), key: k });
    }
    if (hasKey(o, 'valueProof')) leaks.push({ index: tx.vout.indexOf(o), key: 'valueProof' });
    if (t21Big(o.fin || 0) > 0n) fins.push(tx.vout.indexOf(o));
  }
  return {
    leaks,
    fins,
    rows: (tx?.vout || []).filter((o) => !RESERVE_ROW(o)).length,
    totals: {
      S: tx?.t21?.S ?? null,
      cin: tx?.t21?.cin ?? null,
      cout: tx?.carryNanos ?? null,
      bps: tx?.t21?.bps ?? null,
      u: tx?.t21?.u ?? null,
    },
  };
}

function RESERVE_ROW(o) {
  return Number(o?.kindCode) === VAULT_KIND_CODE || o?.kind === 'vault-withdraw-pinned'
    || o?.kind === 'lock' || o?.kind === 'vote' || o?.kind === 'withdraw';
}

export function supplyIdentities(built) {
  const paid = (built.secrets || []).reduce((a, s) => a + s.v, 0n);
  const right = t21Big(built.tx.t21.S) + t21Big(built.tx.t21.cin) - t21Big(built.tx.carryNanos)
    + t21Big(built.tx.t21.u || 0) * built.W + built.phi;
  return { paid, fee: built.f, right, ok: paid + built.f === right };
}

export const GENESIS_GATE = Object.freeze([
  { n: 1, item: 'S0–S8 code in this branch', ok: true, note: 'Library, chain hook, and tests. Not merged.' },
  { n: 2, item: 'Vectors on JS, Dart, and Rust', ok: false, note: 'JS consumes crypto/vectors/t21_splitlaw.json. Dart and Rust consumers are a follow-up.' },
  { n: 3, item: 'Observer harness', ok: true, note: 'observerView recovers no per-payee amount for a cb-v3 payout.' },
  { n: 4, item: 'Full-cap block inside 36,000 wu on the reference box', ok: false, note: 'Not measured on the reference box. No number is invented here.' },
  { n: 5, item: 'O-1 and O-3 resolved; fingerprint frozen in one commit', ok: false, note: 'O-1 weight is 25+25n and reserve 2,336. Fingerprint tokens freeze in one commit. O-3 generator review stays open.' },
  { n: 6, item: 'AL-1..7 including Dart', ok: false, note: 'amtCt and the txDigestV3 bind are cherry-picked from PR 81. Dart amtCt is a follow-up. PR 81 stays open.' },
  { n: 7, item: 'SUP-V and KT-10/14/17; VP-0', ok: false, note: '0x23 r derivation is in this branch. Portal flow and the rest of KT stay open.' },
  { n: 8, item: 'No plaintext amount on non-reserve outputs', ok: true, note: 'cb-v3 payout rows reject nanos, amount, v, value, and valueProof.' },
  { n: 9, item: 'Residuals documented', ok: true, note: 'specs/t21-coinbase.md' },
  { n: 10, item: 'PA, CA, ME, and PSA sign-off on S8', ok: false, note: 'Waiting on Russell.' },
]);

export function genesisGateStatus() {
  return {
    requireAllCoinbases: T21_REQUIRE_ALL_COINBASES,
    genH: GEN_H,
    items: GENESIS_GATE,
    open: GENESIS_GATE.filter((item) => !item.ok).map((item) => item.n),
  };
}

export { T21_REQUIRE_ALL_COINBASES };

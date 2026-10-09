/**
 * Pedersen notes on ristretto255. C = v·G + r·H.
 * Range: packed 64-bit OR proofs (RANGE=packed-bit). The wire label is not Bulletproofs+.
 * Coinbase exact-value: Schnorr that C − vG ∈ ⟨H⟩ for v from Tree-A.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sha512 } from '@noble/hashes/sha2.js';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { nativeLoaded, noteH, nativeProveRange, nativeVerifyRange } from './native_admit.js';

const Point = RistrettoPoint;
const Fn = Point.Fn;
export const NOTE_BITS = 64;
export const NOTE_DST = Buffer.from('shear-note-v1');
export const NOTE_COMMIT_PERSONAL = Buffer.from('shear-note-commit-v1');

export const G = Point.BASE;
/** Consensus H: SHA-512("shear-bpplus-v2" || "shear-note-H-v1"), ristretto from_uniform_bytes. */
function consensusNoteH() {
  const wide = sha512(Buffer.concat([
    Buffer.from('shear-bpplus-v2'),
    Buffer.from('shear-note-H-v1'),
  ]));
  return Point.hashToCurve(wide);
}

function loadH() {
  if (nativeLoaded()) {
    const b = noteH();
    if (b && b.length === 32) return Point.fromBytes(b);
  }
  return consensusNoteH();
}
export const H = loadH();

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

const TX_BYTE_KEYS = new Set([
  'prev', 'commit', 'noteCommit', 'rEph', 'rCt', 'admitPub', 'viewTag',
  'excess', 'c0', 'spendTag',
]);

function reviveField(v) {
  if (v == null) return v;
  const b = Buffer.from(asU8(v));
  return b.length ? b : v;
}

function reviveRow(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const row = { ...o };
  for (const k of TX_BYTE_KEYS) {
    if (row[k] != null && !Array.isArray(row[k])) row[k] = reviveField(row[k]);
  }
  if (row.r != null && !Array.isArray(row.r)) row.r = reviveField(row.r);
  return row;
}

/** HTTP JSON posts byte fields as hex. Template/verify need Buffers. */
export function reviveTx(tx) {
  if (!tx || typeof tx !== 'object') return tx;
  const out = { ...tx };
  if (Array.isArray(out.vin)) out.vin = out.vin.map(reviveRow);
  if (Array.isArray(out.vout)) out.vout = out.vout.map(reviveRow);
  if (out.admit_proof && typeof out.admit_proof === 'object') {
    const p = { ...out.admit_proof };
    if (p.c0 != null) p.c0 = reviveField(p.c0);
    if (p.spendTag != null) p.spendTag = reviveField(p.spendTag);
    if (Array.isArray(p.r)) p.r = p.r.map(reviveField);
    out.admit_proof = p;
    if (out.spendTag == null) out.spendTag = p.spendTag;
  }
  if (out.spendTag != null && !Buffer.isBuffer(out.spendTag)) out.spendTag = reviveField(out.spendTag);
  if (out.excess != null) out.excess = reviveField(out.excess);
  if (Array.isArray(out.hashOwed)) {
    out.hashOwed = out.hashOwed.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const next = { ...row };
      if (next.noteCommit != null) next.noteCommit = reviveField(next.noteCommit);
      if (next.dest20 != null) next.dest20 = reviveField(next.dest20);
      if (next.admitBase != null) next.admitBase = reviveField(next.admitBase);
      return next;
    });
  }
  return out;
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
  const rb = Buffer.from(asU8(typeof r === 'bigint' ? scalarBytes(r) : r));
  if (rb.length !== 32) return Buffer.alloc(0);
  return nativeProveRange(Number(v), rb) || Buffer.alloc(0);
}

export function verifyRange(Cbytes, proof) {
  try {
    if (proof && typeof proof === 'object' && !Buffer.isBuffer(proof) && proof.bits) return false;
    const c = Buffer.from(asU8(Cbytes));
    const pr = Buffer.isBuffer(proof) ? proof : Buffer.from(asU8(proof));
    return nativeVerifyRange(c, pr);
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
  const rangeProof = proveRange(v, r);
  const row = {
    kind: kind || 'hash',
    noteCommit: nc,
    commit: value.C,
    valueProof: { R: value.R, z: value.z, v },
    r: scalarBytes(r),
    rangeProof: rangeProof && rangeProof.length ? rangeProof : Buffer.alloc(0),
  };
  if (dest20) {
    const d = Buffer.from(dest20);
    if (d.length === 20) row.dest20 = d;
  }
  return row;
}

export function sealNote(v, { dest20, noteCommit, kind } = {}) {
  const sealed = sealCoinbaseNote(v, { dest20, noteCommit, kind });
  sealed.rangeProof = proveRange(v, scalarFrom(sealed.r));
  return sealed;
}

/** ECDH wrap of Pedersen r to dest admit-base B = x_base·G. compactTx keeps rEph/rCt and drops r. */
export const RWRAP_DST = Buffer.from('shear-r-wrap-v1');

export function wrapBlind(r, admitBase, extra) {
  const e = randomScalar();
  const B = typeof admitBase?.toBytes === 'function' ? admitBase : pointFrom(asU8(admitBase));
  const rEphP = G.multiply(e);
  const shared = B.multiply(e);
  const mask = hashToScalar(RWRAP_DST, pointBytes(shared), extra || Buffer.alloc(0));
  const rs = typeof r === 'bigint' ? r : scalarFrom(r);
  return { rEph: pointBytes(rEphP), rCt: scalarBytes(Fn.add(rs, mask)) };
}

export function unwrapBlind(rEph, rCt, xBase, extra) {
  const x = typeof xBase === 'bigint' ? xBase : scalarFrom(xBase);
  const shared = pointFrom(asU8(rEph)).multiply(x);
  const mask = hashToScalar(RWRAP_DST, pointBytes(shared), extra || Buffer.alloc(0));
  return scalarBytes(Fn.sub(scalarFrom(rCt), mask));
}

/** Attach rEph/rCt so a compacted mining/Flow note is spendable by the dest owner. */
export function wrapNoteBlind(vout, admitBase) {
  if (!vout?.r || !admitBase) return vout;
  if (vout.rEph && vout.rCt) return vout;
  try {
    const extra = concat(asU8(vout.noteCommit), asU8(vout.commit));
    const wrap = wrapBlind(vout.r, admitBase, extra);
    return { ...vout, rEph: wrap.rEph, rCt: wrap.rCt };
  } catch {
    return vout;
  }
}

export function verifySealedNote(vout, v) {
  if (!vout?.commit || !vout.valueProof) return false;
  if (v < 0 || v >= 2 ** NOTE_BITS) return false;
  if (!verifyValue(vout.commit, v, vout.valueProof)) return false;
  if (vout.rangeProof) {
    const pr = Buffer.isBuffer(vout.rangeProof) ? vout.rangeProof : Buffer.from(asU8(vout.rangeProof));
    if (pr.length && !verifyRange(vout.commit, vout.rangeProof)) return false;
  }
  return true;
}

/** Opened non-negative value of one coinbase output. Range proof is required. */
export function openedCoinbaseNanos(vout) {
  if (!vout?.commit || !vout.valueProof || vout.valueProof.v == null) return null;
  const v = typeof vout.valueProof.v === 'bigint' ? Number(vout.valueProof.v) : Number(vout.valueProof.v);
  if (!Number.isInteger(v) || v < 0) return null;
  const pr = vout.rangeProof
    ? (Buffer.isBuffer(vout.rangeProof) ? vout.rangeProof : Buffer.from(asU8(vout.rangeProof)))
    : Buffer.alloc(0);
  if (!pr.length || !verifyRange(vout.commit, pr)) return null;
  if (!verifySealedNote(vout, v)) return null;
  return v;
}

/**
 * Every committing coinbase output opens, and the commitment sum equals that
 * opened total. Levy notes are in the sum. A totals-only mint does not pass.
 */
export function coinbaseVoutsBound(vouts, excess, openedFor = null) {
  const rows = Array.isArray(vouts) ? vouts : [];
  if (!rows.length) {
    // Carry-only coinbase: nothing is minted. Excess must be the zero scalar.
    if (excess != null) {
      let got;
      try { got = Buffer.from(asU8(excess)); } catch { return { ok: false, reason: 'coinbase_output' }; }
      const zero = Buffer.from(asU8(excessOf([])));
      if (!got.equals(zero)) return { ok: false, reason: 'coinbase_output' };
    }
    return { ok: true, opened: 0, levy: 0, rest: 0 };
  }
  let opened = 0;
  let levy = 0;
  for (const o of rows) {
    if (!o?.commit) return { ok: false, reason: 'coinbase_output' };
    let v = null;
    if (typeof openedFor === 'function') {
      const hinted = openedFor(o);
      if (hinted != null && verifySealedNote(o, hinted)) v = hinted;
    }
    if (v == null) v = openedCoinbaseNanos(o);
    if (v == null) return { ok: false, reason: 'coinbase_output' };
    opened += v;
    const kind = String(o.kind || '');
    if (kind === 'finder-fee' || kind === 'reserve-fee') levy += v;
  }
  if (!verifyMintSum(rows, opened, excess)) return { ok: false, reason: 'pot' };
  return { ok: true, opened, levy, rest: opened - levy };
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

export function addExcess(excess, r) {
  if (!excess || r == null) return null;
  return scalarBytes(Fn.add(scalarFrom(excess), scalarFrom(r)));
}

/** Kernel k = Σ r_out − Σ (r_in + t) so sum(C_out) + fee·G = sum(C̃_in) + k·H. */
export function kernelExcess(vouts = [], vins = []) {
  let s = Fn.ZERO;
  for (const o of vouts) {
    if (!o?.r) return null;
    s = Fn.add(s, scalarFrom(o.r));
  }
  for (const v of vins) {
    if (!v?.r) return null;
    s = Fn.sub(s, scalarFrom(v.r));
    if (v?.t) s = Fn.sub(s, scalarFrom(v.t));
  }
  return scalarBytes(s);
}

/** Rerandomize spent C onto vin as C̃. Original C / dest stay off the sealed body. */
export function hideVin(vin, spentVout, tOpt) {
  if (!vin || !spentVout?.commit) return vin;
  const t = tOpt != null ? (typeof tOpt === 'bigint' ? tOpt : scalarFrom(tOpt)) : randomScalar();
  if (Fn.eql(t, Fn.ZERO)) return vin;
  const Ctilde = pointFrom(spentVout.commit).add(H.multiply(t));
  const row = {
    commit: pointBytes(Ctilde),
    t: scalarBytes(t),
  };
  if (spentVout.r) row.r = spentVout.r;
  return row;
}

/** Copy spent vout commit onto vin as a rerandomized C̃. Never sealNote a new C_in. */
export function bindVinToSpent(vin, spentVout) {
  return hideVin(vin, spentVout);
}

export function spentCommitEquals(vin, spentVout) {
  if (!vin?.commit || !spentVout?.commit) return false;
  const a = Buffer.from(asU8(vin.commit));
  const b = Buffer.from(asU8(spentVout.commit));
  return a.length === b.length && a.equals(b);
}

/**
 * Pedersen conservation on rerandomized C̃. Sealed vin must not name the spent note.
 * Identifying prev/index/noteCommit/dest20/address fail. spentOf is ignored.
 */
export function vinIdentifiesSpent(v) {
  if (!v) return false;
  if (v.prev != null && v.prev !== '' && !v.coinbase) return true;
  if (v.index != null && v.index !== '' && !v.coinbase) return true;
  if (v.noteCommit != null) return true;
  if (v.dest20 != null) return true;
  if (v.address != null && v.address !== '') return true;
  return false;
}

/**
 * Every Flow vin is bound to one Admit proof. cTilde must equal that vin's
 * commit, the spend tag must be present, and an extra vin is not a proof.
 * Call this before verifyFlowConservation so an unbound commit cannot enter the sum.
 */
export function flowInputsBound(tx) {
  const vins = (Array.isArray(tx?.vin) ? tx.vin : []).filter((v) => v);
  if (!vins.length || vins.some((v) => v.coinbase)) {
    return { ok: false, reason: 'admit_membership' };
  }
  const proofs = (Array.isArray(tx?.admit_proofs) && tx.admit_proofs.length)
    ? tx.admit_proofs
    : (tx?.admit_proof ? [tx.admit_proof] : []);
  if (proofs.length !== vins.length) return { ok: false, reason: 'admit_membership' };
  for (let i = 0; i < vins.length; i += 1) {
    const proof = proofs[i];
    const tag = proof?.spendTag || (proofs.length === 1 ? tx.spendTag : null);
    if (!tag || proof?.cTilde == null || vins[i]?.commit == null) {
      return { ok: false, reason: 'admit_membership' };
    }
    let posted;
    let want;
    try {
      posted = Buffer.from(asU8(vins[i].commit));
      want = Buffer.from(asU8(proof.cTilde));
    } catch {
      return { ok: false, reason: 'admit_membership' };
    }
    if (posted.length !== want.length || !posted.equals(want)) {
      return { ok: false, reason: 'admit_membership' };
    }
  }
  return { ok: true, proofs, vins };
}

/**
 * sum(C_out) + fee·G = sum(C̃_in) + W·G + excess·H.
 * W is the vault payout. It is 0 for Flow, lock, and vote. A withdraw
 * passes W equal to the opened outputs, so the hidden input must open
 * to the fee. The default keeps every Flow caller unchanged.
 */
export function verifyFlowConservation(tx, _spentOf, vaultPayout = 0) {
  try {
    const vouts = tx?.vout || [];
    const vins = tx?.vin || [];
    if (!vouts.length || !vins.length) return false;
    for (const v of vins) {
      if (v?.coinbase) continue;
      if (vinIdentifiesSpent(v)) return false;
      if (!v?.commit) return false;
    }
    const outC = mintTotal(vouts);
    const inC = mintTotal(vins.map((v) => ({ commit: v.commit })));
    if (!outC || !inC) return false;
    if (!tx.excess) return false;
    const fee = Math.max(0, Math.floor(Number(tx.fee || 0)));
    const payout = Math.max(0, Math.floor(Number(vaultPayout) || 0));
    const lhs = fee ? outC.add(mulG(fee)) : outC;
    let rhs = inC.add(H.multiply(scalarFrom(tx.excess)));
    if (payout) rhs = rhs.add(mulG(payout));
    return lhs.equals(rhs);
  } catch {
    return false;
  }
}

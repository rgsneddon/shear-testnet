/**
 * Pedersen notes on ristretto255. C = v·G + r·H.
 * Range: packed 64-bit OR proofs (RANGE=packed-bit). The wire label is not Bulletproofs+.
 * Coinbase exact-value: Schnorr that C − vG ∈ ⟨H⟩ for v from Tree-A.
 */
import { createHash, hash, randomBytes } from 'node:crypto';
import { sha512 } from '@noble/hashes/sha2.js';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { nativeLoaded, nativeLoadErrorText, noteH, nativeProveRange, nativeVerifyRange } from './native_admit.js';
import { coinbaseOutputCap } from './block_budget.js';

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
  'prev', 'commit', 'noteCommit', 'rEph', 'rCt', 'amtCt', 'admitPub', 'viewTag',
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

export function bitOrProve(B, b, s) {
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

export function bitOrVerify(B, proof) {
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

const RANGE_DST = Buffer.from('shear-bpplus-v2');
const RANGE_BITS = 64;
const RANGE_PROOF_LEN = 1 + 32 + RANGE_BITS * 32 + RANGE_BITS * 192 + 64;

function rangeChal(parts) {
  const wide = sha512(Buffer.concat([RANGE_DST, ...parts]));
  return Fn.create(bytesToNumberLE(wide));
}

function rangeNonce(tag, rBytes, i) {
  const ib = Buffer.alloc(8);
  ib.writeBigUInt64LE(BigInt(i));
  return rangeChal([Buffer.from(tag), rBytes, ib]);
}

function mulP(P, s) {
  return P.multiplyUnsafe(s);
}

function scalarCanon(buf) {
  const b = Buffer.from(buf);
  if (b.length !== 32) return null;
  const n = bytesToNumberLE(b);
  if (!Fn.isValid(n)) return null;
  return n;
}

/** sum_i B_i · 2^i. Horner matches the scalar double-and-add in bpplus.rs. */
function weightedBits(points) {
  let acc = Point.ZERO;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    acc = acc.double().add(points[i]);
  }
  return acc;
}

/**
 * Packed 64-bit OR proof, marker 0x02. Same bytes as
 * crypto/native/admit/src/bpplus.rs. Not constant-time.
 * Consensus verify does not call this unless SHEAR_RANGE_JS=1.
 * proveRange calls it only for { public: true } or that same flag.
 */
export function provePackedRange(v, rBytes) {
  const n = noteU64(v);
  if (n == null || !rBytes || rBytes.length !== 32) return null;
  const rb = Buffer.from(rBytes);
  const r = Fn.create(bytesToNumberLE(rb));
  const c = mulP(G, n).add(mulP(H, r));
  const cB = pointBytes(c);
  const bits = new Array(RANGE_BITS);
  const s = new Array(RANGE_BITS);
  const bPts = new Array(RANGE_BITS);
  const bBytes = new Array(RANGE_BITS);
  let vv = n;
  for (let i = 0; i < RANGE_BITS; i += 1) {
    bits[i] = Number(vv & 1n);
    vv >>= 1n;
    s[i] = rangeNonce('sbit', rb, i);
    const bitG = bits[i] ? G : Point.ZERO;
    bPts[i] = bitG.add(mulP(H, s[i]));
    bBytes[i] = pointBytes(bPts[i]);
  }
  const out = [Buffer.from([2]), cB, ...bBytes];
  const eAll = rangeChal([Buffer.from('bits'), cB, ...bBytes]);
  const eAllB = scalarBytes(eAll);
  let sSum = 0n;
  let two = 1n;
  for (let i = 0; i < RANGE_BITS; i += 1) {
    const on = bits[i] === 1;
    const bi = bPts[i];
    const si = s[i];
    const p1 = bi.subtract(G);
    const fake = on ? bi : p1;
    const eFake = rangeNonce('efake', rb, i);
    const zFake = rangeNonce('zfake', rb, i);
    const rFake = mulP(H, zFake).subtract(mulP(fake, eFake));
    const k = rangeNonce('kbit', rb, i);
    const rReal = mulP(H, k);
    const r0 = on ? rFake : rReal;
    const r1 = on ? rReal : rFake;
    const r0b = pointBytes(r0);
    const r1b = pointBytes(r1);
    const e = rangeChal([Buffer.from('bit'), bBytes[i], r0b, r1b, eAllB]);
    const eReal = Fn.sub(e, eFake);
    const zReal = Fn.add(k, Fn.mul(eReal, si));
    out.push(
      r0b,
      r1b,
      scalarBytes(on ? eFake : eReal),
      scalarBytes(on ? eReal : eFake),
      scalarBytes(on ? zFake : zReal),
      scalarBytes(on ? zReal : zFake),
    );
    sSum = Fn.add(sSum, Fn.mul(two, si));
    two = Fn.add(two, two);
  }
  const rDelta = Fn.sub(r, sSum);
  const p = c.subtract(weightedBits(bPts));
  const k = rangeNonce('cons', rb, 0);
  const rPt = mulP(H, k);
  const rPtB = pointBytes(rPt);
  const e = rangeChal([Buffer.from('cons'), cB, pointBytes(p), rPtB]);
  const z = Fn.add(k, Fn.mul(e, rDelta));
  out.push(rPtB, scalarBytes(z));
  const proof = Buffer.concat(out);
  return proof.length === RANGE_PROOF_LEN ? proof : null;
}

export function verifyPackedRange(cBytes, proof) {
  try {
    const pr = Buffer.isBuffer(proof) ? proof : Buffer.from(asU8(proof));
    if (pr.length !== RANGE_PROOF_LEN || pr[0] !== 2) return false;
    const cWire = Buffer.from(pr.subarray(1, 33));
    const c = Point.fromBytes(cWire);
    const want = Point.fromBytes(Buffer.from(asU8(cBytes)));
    if (!c.equals(want)) return false;
    const bPts = new Array(RANGE_BITS);
    const bBytes = new Array(RANGE_BITS);
    let off = 33;
    for (let i = 0; i < RANGE_BITS; i += 1) {
      const raw = Buffer.from(pr.subarray(off, off + 32));
      bPts[i] = Point.fromBytes(raw);
      bBytes[i] = raw;
      off += 32;
    }
    const eAll = rangeChal([Buffer.from('bits'), cWire, ...bBytes]);
    if (eAll === 0n) return false;
    const eAllB = scalarBytes(eAll);
    for (let i = 0; i < RANGE_BITS; i += 1) {
      const r0b = Buffer.from(pr.subarray(off, off + 32));
      const r1b = Buffer.from(pr.subarray(off + 32, off + 64));
      const r0 = Point.fromBytes(r0b);
      const r1 = Point.fromBytes(r1b);
      const e0 = scalarCanon(pr.subarray(off + 64, off + 96));
      const e1 = scalarCanon(pr.subarray(off + 96, off + 128));
      const z0 = scalarCanon(pr.subarray(off + 128, off + 160));
      const z1 = scalarCanon(pr.subarray(off + 160, off + 192));
      off += 192;
      if (e0 == null || e1 == null || z0 == null || z1 == null) return false;
      const e = rangeChal([Buffer.from('bit'), bBytes[i], r0b, r1b, eAllB]);
      if (e === 0n || Fn.add(e0, e1) !== e) return false;
      const p0 = bPts[i];
      const p1 = p0.subtract(G);
      if (!mulP(H, z0).equals(r0.add(mulP(p0, e0)))) return false;
      if (!mulP(H, z1).equals(r1.add(mulP(p1, e1)))) return false;
    }
    const p = c.subtract(weightedBits(bPts));
    const rPtB = Buffer.from(pr.subarray(off, off + 32));
    const rPt = Point.fromBytes(rPtB);
    const z = scalarCanon(pr.subarray(off + 32, off + 64));
    if (z == null) return false;
    const e = rangeChal([Buffer.from('cons'), cWire, pointBytes(p), rPtB]);
    if (e === 0n) return false;
    return mulP(H, z).equals(rPt.add(mulP(p, e)));
  } catch {
    return false;
  }
}

/** Set to 1 to allow the non-constant-time JavaScript range prover and verifier. */
export const RANGE_JS_ENV = 'SHEAR_RANGE_JS';

export function rangeJsOptIn() {
  return String(process.env[RANGE_JS_ENV] || '').trim() === '1';
}

/** Hidden amounts need the native prover, or SHEAR_RANGE_JS=1. Public coinbase passes { public: true }. */
export function hiddenAmountRangeReady() {
  return nativeLoaded() || rangeJsOptIn();
}

let warnedJsProve = false;
let warnedJsVerify = false;
let warnedHiddenRefuse = false;

function rangeLoadReason() {
  const why = nativeLoadErrorText();
  return why ? ` (${why})` : '';
}

function warnJsProveOnce() {
  if (warnedJsProve) return;
  warnedJsProve = true;
  console.error(
    `SHEAR RANGE WARNING: proving a range in JavaScript because shearadmit.node is not loaded${rangeLoadReason()}. `
    + `This prover is not constant-time. It runs only for { public: true } or ${RANGE_JS_ENV}=1. `
    + `Hidden-amount proving stays refused unless ${RANGE_JS_ENV}=1 is set on purpose.`,
  );
}

function warnJsVerifyOnce() {
  if (warnedJsVerify) return;
  warnedJsVerify = true;
  console.error(
    `SHEAR RANGE WARNING: ${RANGE_JS_ENV}=1 is verifying range proofs in JavaScript${rangeLoadReason()}. `
    + 'Consensus verification fails closed when shearadmit.node is missing and this flag is unset. '
    + 'The JavaScript verifier is not the consensus implementation.',
  );
}

function warnHiddenRefusedOnce(where) {
  if (warnedHiddenRefuse) return;
  warnedHiddenRefuse = true;
  const site = where ? ` (${where})` : '';
  console.error(
    `SHEAR RANGE WARNING: refusing a hidden-amount range proof${site}. shearadmit.node is not loaded${rangeLoadReason()}. `
    + `The JavaScript prover is not constant-time. Set ${RANGE_JS_ENV}=1 only if this process may leak amounts through timing.`,
  );
}

export function proveRange(v, r, opts = {}) {
  const rb = Buffer.from(asU8(typeof r === 'bigint' ? scalarBytes(r) : r));
  if (rb.length !== 32) return Buffer.alloc(0);
  if (nativeLoaded()) {
    const native = nativeProveRange(v, rb);
    return native && native.length ? native : Buffer.alloc(0);
  }
  // Hidden-amount policy is the default. JavaScript proving is the public
  // coinbase exception, or the explicit SHEAR_RANGE_JS=1 opt-in.
  if (opts.public !== true && !rangeJsOptIn()) return Buffer.alloc(0);
  warnJsProveOnce();
  try {
    const js = provePackedRange(v, rb);
    if (js && js.length) return js;
  } catch { /* same empty proof native returns */ }
  return Buffer.alloc(0);
}

export function verifyRange(Cbytes, proof) {
  try {
    if (proof && typeof proof === 'object' && !Buffer.isBuffer(proof) && proof.bits) return false;
    const c = Buffer.from(asU8(Cbytes));
    const pr = Buffer.isBuffer(proof) ? proof : Buffer.from(asU8(proof));
    if (nativeLoaded()) return nativeVerifyRange(c, pr);
    if (rangeJsOptIn()) {
      warnJsVerifyOnce();
      return verifyPackedRange(c, pr);
    }
    return false;
  } catch {
    return false;
  }
}

/** Coinbase / Tree-A: v is public from collated units. Exact-value proof, no painted nanos. */
export function sealCoinbaseNote(v, { dest20, noteCommit, kind, r, skipRange } = {}) {
  const blind = r == null ? randomScalar() : r;
  const value = proveValue(v, blind);
  const nc = noteCommit
    ? Buffer.from(noteCommit)
    : (dest20 ? noteCommitOfDest20(dest20) : Buffer.alloc(32));
  const rangeProof = skipRange ? Buffer.alloc(0) : proveRange(v, blind, { public: true });
  const row = {
    kind: kind || 'hash',
    noteCommit: nc,
    commit: value.C,
    valueProof: { R: value.R, z: value.z, v },
    r: scalarBytes(blind),
    rangeProof: rangeProof && rangeProof.length ? rangeProof : Buffer.alloc(0),
  };
  if (dest20) {
    const d = Buffer.from(dest20);
    if (d.length === 20) row.dest20 = d;
  }
  return row;
}

export function sealNote(v, { dest20, noteCommit, kind } = {}) {
  if (!hiddenAmountRangeReady()) {
    warnHiddenRefusedOnce('sealNote');
    const sealed = sealCoinbaseNote(v, { dest20, noteCommit, kind, skipRange: true });
    sealed.rangeProof = Buffer.alloc(0);
    return sealed;
  }
  const sealed = sealCoinbaseNote(v, { dest20, noteCommit, kind, skipRange: true });
  sealed.rangeProof = proveRange(v, scalarFrom(sealed.r));
  return sealed;
}

/**
 * A hidden output: C, a range proof, and the amount encrypted to the dest.
 * No shear-note-val-v1 proof and no v, so a reader cannot test a guessed amount.
 * r stays local and is dropped by compactTx.
 */
export function sealHiddenNote(v, { dest20, noteCommit, kind, admitBase } = {}) {
  const n = noteU64(v);
  if (n == null) throw new Error('amount');
  const r = randomScalar();
  const nc = noteCommit
    ? Buffer.from(noteCommit)
    : (dest20 ? noteCommitOfDest20(dest20) : Buffer.alloc(32));
  let rangeProof = Buffer.alloc(0);
  if (!hiddenAmountRangeReady()) warnHiddenRefusedOnce('sealHiddenNote');
  else rangeProof = proveRange(n, r);
  let row = {
    kind: kind || 'send',
    noteCommit: nc,
    commit: pointBytes(commit(n, r)),
    r: scalarBytes(r),
    rangeProof: rangeProof && rangeProof.length ? rangeProof : Buffer.alloc(0),
  };
  if (dest20) {
    const d = Buffer.from(dest20);
    if (d.length === 20) row.dest20 = d;
  }
  if (admitBase) row = wrapNoteBlind(row, admitBase, n);
  return row;
}

/** ECDH wrap of Pedersen r to dest admit-base B = x_base·G. compactTx keeps rEph/rCt and drops r. */
export const RWRAP_DST = Buffer.from('shear-r-wrap-v1');
/** amtCt = u64le(v) XOR SHA-512(AMOUNT_CT_DST ‖ e·B ‖ extra)[0..8], under the same e as rCt. */
export const AMOUNT_CT_DST = Buffer.from('shear-amt-v1');
export const AMOUNT_CT_BYTES = 8;

function amountMask(shared, extra) {
  return Buffer.from(sha512(concat(AMOUNT_CT_DST, pointBytes(shared), extra || Buffer.alloc(0)))).subarray(0, AMOUNT_CT_BYTES);
}

function u64leBytes(n) {
  const b = Buffer.alloc(AMOUNT_CT_BYTES);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function xorBytes(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

export function wrapBlind(r, admitBase, extra, v = null) {
  const e = randomScalar();
  const B = typeof admitBase?.toBytes === 'function' ? admitBase : pointFrom(asU8(admitBase));
  const rEphP = G.multiply(e);
  const shared = B.multiply(e);
  const mask = hashToScalar(RWRAP_DST, pointBytes(shared), extra || Buffer.alloc(0));
  const rs = typeof r === 'bigint' ? r : scalarFrom(r);
  const out = { rEph: pointBytes(rEphP), rCt: scalarBytes(Fn.add(rs, mask)) };
  if (v != null) {
    const n = noteU64(v);
    if (n == null) throw new Error('amount');
    out.amtCt = xorBytes(u64leBytes(n), amountMask(shared, extra));
  }
  return out;
}

export function unwrapBlind(rEph, rCt, xBase, extra) {
  const x = typeof xBase === 'bigint' ? xBase : scalarFrom(xBase);
  const shared = pointFrom(asU8(rEph)).multiply(x);
  const mask = hashToScalar(RWRAP_DST, pointBytes(shared), extra || Buffer.alloc(0));
  return scalarBytes(Fn.sub(scalarFrom(rCt), mask));
}

/** Owner-only: v from amtCt. Not checked against C; openNoteAmount does that. */
function unwrapAmount(rEph, amtCt, xBase, extra) {
  const ct = Buffer.from(asU8(amtCt));
  if (ct.length !== AMOUNT_CT_BYTES) return null;
  const x = typeof xBase === 'bigint' ? xBase : scalarFrom(xBase);
  const shared = pointFrom(asU8(rEph)).multiply(x);
  return xorBytes(ct, amountMask(shared, extra)).readBigUInt64LE(0);
}

/**
 * Owner recovery of (v, r) from a sealed output's rEph, rCt, and amtCt.
 * Null unless v·G + r·H equals the output commitment, so a swapped or
 * corrupted ciphertext never yields a wrong amount.
 */
export function openNoteAmount(vout, xBase) {
  try {
    if (!vout?.rEph || !vout?.rCt || !vout?.amtCt || !vout?.commit) return null;
    const extra = concat(asU8(vout.noteCommit), asU8(vout.commit));
    const v = unwrapAmount(vout.rEph, vout.amtCt, xBase, extra);
    if (v == null) return null;
    const r = unwrapBlind(vout.rEph, vout.rCt, xBase, extra);
    if (!commit(v, scalarFrom(r)).equals(pointFrom(vout.commit))) return null;
    return { v, r };
  } catch {
    return null;
  }
}

/**
 * Attach rEph/rCt so a compacted mining/Flow note is spendable by the dest owner.
 * With v, amtCt carries the amount to that owner under the same ephemeral key.
 */
export function wrapNoteBlind(vout, admitBase, v = null) {
  if (!vout?.r || !admitBase) return vout;
  if (vout.rEph && vout.rCt && (v == null || vout.amtCt)) return vout;
  try {
    const extra = concat(asU8(vout.noteCommit), asU8(vout.commit));
    const wrap = wrapBlind(vout.r, admitBase, extra, v);
    const out = { ...vout, rEph: wrap.rEph, rCt: wrap.rCt };
    if (wrap.amtCt) out.amtCt = wrap.amtCt;
    return out;
  } catch {
    return vout;
  }
}

const NOTE_MAX = (1n << BigInt(NOTE_BITS)) - 1n;

/** Canonical integer in 0..2^64-1. A JS number is accepted only while it is exact. */
export function noteU64(v) {
  let n;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) return null;
    n = BigInt(v);
  } else if (typeof v === 'string' && /^[0-9]+$/.test(v) && !/^0[0-9]/.test(v)) {
    try { n = BigInt(v); } catch { return null; }
  } else return null;
  if (n < 0n || n > NOTE_MAX) return null;
  return n;
}

function openedAsCaller(n) {
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n);
  return n;
}

export function verifySealedNote(vout, v) {
  if (!vout?.commit || !vout.valueProof) return false;
  const n = noteU64(v);
  if (n == null) return false;
  if (!verifyValue(vout.commit, n, vout.valueProof)) return false;
  if (vout.rangeProof) {
    const pr = Buffer.isBuffer(vout.rangeProof) ? vout.rangeProof : Buffer.from(asU8(vout.rangeProof));
    if (pr.length && !verifyRange(vout.commit, vout.rangeProof)) return false;
  }
  return true;
}

/** Opened non-negative value of one coinbase output. Range proof is required. */
export function openedCoinbaseNanos(vout) {
  if (!vout?.commit || !vout.valueProof || vout.valueProof.v == null || vout.valueProof.v === '') return null;
  const n = noteU64(vout.valueProof.v);
  if (n == null) return null;
  const pr = vout.rangeProof
    ? (Buffer.isBuffer(vout.rangeProof) ? vout.rangeProof : Buffer.from(asU8(vout.rangeProof)))
    : Buffer.alloc(0);
  if (!pr.length || !verifyRange(vout.commit, pr)) return null;
  if (!verifySealedNote(vout, n)) return null;
  return openedAsCaller(n);
}

/**
 * Every committing coinbase output opens, and the commitment sum equals that
 * opened total. Levy notes are in the sum. A totals-only mint does not pass.
 */
const PAYOUT_RANGE_KINDS = new Set(['pot', 'hash', 'finder-fee', 'reserve-fee', 'pool-fee']);

function rangeProofEmpty(o) {
  if (o?.rangeProof == null) return true;
  try {
    const pr = Buffer.isBuffer(o.rangeProof) ? o.rangeProof : Buffer.from(asU8(o.rangeProof));
    return pr.length === 0;
  } catch {
    return true;
  }
}

export function coinbaseVoutsBound(vouts, excess, openedFor = null, splitPaid = null) {
  const rows = Array.isArray(vouts) ? vouts : [];
  if (splitPaid != null) {
    if (!rows.length) return { ok: false, reason: 'coinbase_output' };
    const paid = noteU64(splitPaid);
    if (paid == null) return { ok: false, reason: 'coinbase_output' };
    for (const o of rows) {
      if (!o?.commit) return { ok: false, reason: 'coinbase_output' };
    }
    if (!verifyMintSum(rows, paid, excess)) return { ok: false, reason: 'pot' };
    return {
      ok: true,
      opened: openedAsCaller(paid),
      levy: 0,
      rest: openedAsCaller(paid),
    };
  }
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
  let opened = 0n;
  let levy = 0n;
  for (const o of rows) {
    if (!o?.commit) return { ok: false, reason: 'coinbase_output' };
    let v = null;
    if (typeof openedFor === 'function') {
      const hinted = openedFor(o);
      if (hinted != null && verifySealedNote(o, hinted)) {
        if (PAYOUT_RANGE_KINDS.has(String(o.kind || '')) && rangeProofEmpty(o)) {
          return { ok: false, reason: 'range_proof' };
        }
        v = noteU64(hinted);
      }
    }
    if (v == null) {
      const one = openedCoinbaseNanos(o);
      v = one == null ? null : noteU64(one);
    }
    if (v == null) return { ok: false, reason: 'coinbase_output' };
    opened += v;
    const kind = String(o.kind || '');
    if (kind === 'finder-fee' || kind === 'reserve-fee') levy += v;
  }
  if (!verifyMintSum(rows, opened, excess)) return { ok: false, reason: 'pot' };
  return { ok: true, opened: openedAsCaller(opened), levy: openedAsCaller(levy), rest: openedAsCaller(opened - levy) };
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

function proofBlobBytes(proof) {
  const raw = proof?.blob ?? proof?.proof;
  if (raw == null || raw === '') return null;
  try {
    const blob = Buffer.from(asU8(raw));
    return blob.length ? blob : null;
  } catch {
    return null;
  }
}

/** Byte 3 (bucket, gated) and byte 0xF1 (FS-1 record). Byte 2 is closed. */
function versionedByte(b) {
  return b === 3 || b === 0xf1;
}

/** A versioned Admit blob carries the spend tag at bytes 1..33. */
function versionedSpendTag(blob) {
  if (!blob || blob.length < 33) return null;
  if (!versionedByte(blob[0])) return null;
  return Buffer.from(blob.subarray(1, 33));
}

function postedSpendTag(tag) {
  if (tag == null || tag === '') return { present: false, tag: null };
  try {
    const buf = Buffer.from(asU8(tag));
    if (buf.length === 32) return { present: true, tag: buf };
  } catch { /* present, but not a tag */ }
  return { present: true, tag: null };
}

/**
 * One proof's spend tag. A version 2 or 3 blob owns the tag. A JSON field
 * that disagrees is admit_tag, and the blob tag is still returned. A proof
 * with no versioned blob keeps a 32-byte field so a shape check can bind.
 */
export function canonicalSpendTag(proof) {
  const fromBytes = versionedSpendTag(proofBlobBytes(proof));
  const field = postedSpendTag(proof?.spendTag);
  if (fromBytes) {
    if (field.present && (!field.tag || !field.tag.equals(fromBytes))) {
      return { ok: false, reason: 'admit_tag', tag: fromBytes };
    }
    return { ok: true, reason: null, tag: fromBytes };
  }
  if (field.tag) return { ok: true, reason: null, tag: field.tag };
  return { ok: false, reason: 'admit_membership', tag: null };
}

/**
 * Identity of one proof. A versioned blob is its bytes. A shape proof is its
 * tag and cTilde. Reference equality is not identity: reviveTx copies admit_proof.
 */
function proofIdentity(proof) {
  const blob = proofBlobBytes(proof);
  if (blob && blob.length >= 33 && versionedByte(blob[0])) {
    return `b:${hash('sha256', blob, 'hex')}`;
  }
  const one = canonicalSpendTag(proof);
  if (!one.tag) return null;
  let ct = '';
  try {
    if (proof?.cTilde != null) ct = Buffer.from(asU8(proof.cTilde)).toString('hex');
  } catch { ct = ''; }
  return `s:${one.tag.toString('hex')}:${ct}`;
}

/** Tag bytes for the bound check. A Buffer tag is not copied. */
function boundProofTag(proof) {
  const raw = proof?.blob ?? proof?.proof;
  if (Buffer.isBuffer(raw) && raw.length >= 33 && versionedByte(raw[0])) {
    const from = raw.subarray(1, 33);
    const field = proof?.spendTag;
    if (field != null && field !== '') {
      let tag = null;
      if (Buffer.isBuffer(field) && field.length === 32) tag = field;
      else tag = postedSpendTag(field).tag;
      if (!tag || !tag.equals(from)) return { ok: false, reason: 'admit_tag' };
    }
    return { ok: true, tag: from };
  }
  const one = canonicalSpendTag(proof);
  if (!one.ok || !one.tag) return { ok: false, reason: one.reason || 'admit_membership' };
  return { ok: true, tag: one.tag };
}

/** Exact blob bytes for a versioned proof. A shape proof keeps tag and cTilde. */
function sameBoundProof(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ba = proofBlobBytes(a);
  const bb = proofBlobBytes(b);
  const aVer = !!(ba && ba.length >= 33 && versionedByte(ba[0]));
  const bVer = !!(bb && bb.length >= 33 && versionedByte(bb[0]));
  if (aVer || bVer) return aVer && bVer && ba.length === bb.length && ba.equals(bb);
  return sameSpendProof(a, b);
}

/** True when both objects are the same proof, including a revived copy. */
export function sameSpendProof(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ia = proofIdentity(a);
  const ib = proofIdentity(b);
  return !!(ia && ib && ia === ib);
}

/**
 * admit_proof, then each admit_proofs entry that is not that same proof.
 * A copy of admit_proofs[0] stored again as admit_proof is one proof.
 * Two list entries with the same tag stay two proofs so the tag check can reject them.
 */
export function txProofs(tx) {
  const out = [];
  const list = Array.isArray(tx?.admit_proofs) ? tx.admit_proofs.filter(Boolean) : [];
  if (tx?.admit_proof && !list.some((proof) => sameSpendProof(proof, tx.admit_proof))) {
    out.push(tx.admit_proof);
  }
  for (const proof of list) out.push(proof);
  return out;
}

let spendTagParses = 0;
const spendTagMemo = new WeakMap();

/** How many times a spend-tag parse ran. A cache hit does not count. */
export function txSpendTagParses() {
  return spendTagParses;
}

export function resetTxSpendTagParses() {
  spendTagParses = 0;
}

/**
 * Proof object identity, not the blob bytes. Replacing a proof or a blob
 * parses again. Editing bytes inside the same blob object does not.
 */
function spendTagStamp(tx) {
  const list = Array.isArray(tx?.admit_proofs) ? tx.admit_proofs : null;
  const top = tx?.admit_proof || null;
  const parts = [top, tx?.spendTag ?? null, list];
  if (top && typeof top === 'object') parts.push(top.blob ?? null, top.proof ?? null, top.spendTag ?? null);
  if (list) {
    for (let i = 0; i < list.length; i += 1) {
      const proof = list[i];
      parts.push(proof || null);
      if (proof && typeof proof === 'object') {
        parts.push(proof.blob ?? null, proof.proof ?? null, proof.spendTag ?? null);
      }
    }
  }
  return parts;
}

function sameSpendTagStamp(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Every proof's spend tag. Tags are the blob bytes when the proof is versioned.
 * A missing proof list is an empty success (coinbase). A field that disagrees
 * with those bytes is admit_tag, and the blob tags are still listed so a stored
 * lie cannot un-spend the note. Duplicate tags in one tx are admit_link_tag.
 * A lone tx.spendTag with no proof is not a nullifier.
 * The same tx object is parsed once until a proof object is replaced.
 */
export function txSpendTags(tx) {
  if (tx && typeof tx === 'object') {
    const stamp = spendTagStamp(tx);
    const hit = spendTagMemo.get(tx);
    if (hit && sameSpendTagStamp(hit.stamp, stamp)) return hit.result;
    spendTagParses += 1;
    const result = parseTxSpendTags(tx);
    spendTagMemo.set(tx, { stamp, result });
    return result;
  }
  spendTagParses += 1;
  return parseTxSpendTags(tx);
}

function parseTxSpendTags(tx) {
  const proofs = txProofs(tx);
  if (!proofs.length) return { ok: true, reason: null, tags: [], proofs };
  const tags = [];
  const seen = new Set();
  let reason = null;
  for (const proof of proofs) {
    const one = canonicalSpendTag(proof);
    if (!one.ok) reason = reason || one.reason || 'admit_membership';
    if (!one.tag) continue;
    const hex = one.tag.toString('hex');
    if (seen.has(hex)) reason = reason || 'admit_link_tag';
    seen.add(hex);
    tags.push(one.tag);
  }
  const top = postedSpendTag(tx?.spendTag);
  if (top.present && tags[0] && (!top.tag || !top.tag.equals(tags[0]))) {
    reason = reason || 'admit_tag';
  }
  if (reason) return { ok: false, reason, tags, proofs };
  return { ok: true, reason: null, tags, proofs };
}

/** Per-tx shape cap. A coinbase stops at the live payee cap, inside the 36,000 weight-unit budget. */
export const MAX_TX_INPUTS = 8;
export const MAX_TX_OUTPUTS = 8;

export function txIsCoinbase(tx) {
  return !!(tx && (tx.coinbase === true || String(tx.kind || '') === 'coinbase'));
}

/**
 * First stateless bound. Over the cap is invalid before any proof parse.
 * Zero inputs are not this reject: a withdraw vin list is empty.
 * proofChecked marks the reject so a peer that sent it is scored.
 */
export function txIoCap(tx) {
  const nIn = Array.isArray(tx?.vin) ? tx.vin.length : 0;
  const nOut = Array.isArray(tx?.vout) ? tx.vout.length : 0;
  if (nIn > MAX_TX_INPUTS) return { ok: false, reason: 'tx_cap', proofChecked: true };
  const outCap = txIsCoinbase(tx) ? coinbaseOutputCap() : MAX_TX_OUTPUTS;
  if (nOut > outCap) return { ok: false, reason: 'tx_cap', proofChecked: true };
  return { ok: true };
}

const BIND_SLOW = { slow: true };

function commitSame(posted, want) {
  let a = posted;
  let b = want;
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    try {
      if (!Buffer.isBuffer(a)) a = Buffer.from(asU8(a));
      if (!Buffer.isBuffer(b)) b = Buffer.from(asU8(b));
    } catch {
      return false;
    }
  }
  return a.length === b.length && a.equals(b);
}

/** Shape proofs and collision storms. One set, so a hostile frame stays linear. */
function bindListedSlow(vins, proofs) {
  const seen = new Set();
  const tagOf = new Array(vins.length);
  for (let i = 0; i < vins.length; i += 1) {
    const proof = proofs[i];
    const parsed = boundProofTag(proof);
    if (!parsed.ok) return { ok: false, reason: parsed.reason || 'admit_membership' };
    const tag = parsed.tag;
    if (!tag || !proof || proof.cTilde == null || !vins[i] || vins[i].commit == null) {
      return { ok: false, reason: 'admit_membership' };
    }
    if (!commitSame(vins[i].commit, proof.cTilde)) return { ok: false, reason: 'admit_membership' };
    const key = tag.toString('latin1');
    if (seen.has(key)) return { ok: false, reason: 'admit_link_tag' };
    seen.add(key);
    tagOf[i] = tag;
  }
  return { ok: true, tagOf };
}

function versionedHead(proof) {
  if (!proof) return false;
  const raw = proof.blob != null ? proof.blob : proof.proof;
  const field = proof.spendTag;
  return Buffer.isBuffer(raw) && raw.length >= 33 && versionedByte(raw[0])
    && Buffer.isBuffer(field) && field.length === 32
    && Buffer.isBuffer(proof.cTilde);
}

/**
 * Versioned buffer proofs only. Shape proofs never enter, so this loop stays
 * monomorphic. A probe chain longer than the load allows restarts through the set.
 */
function bindListedTight(vins, proofs) {
  const n = vins.length;
  if (n > 0x10000) return BIND_SLOW;
  let capN = 2;
  const need = n << 1;
  while (capN < need) capN <<= 1;
  const slot = new Uint32Array(capN);
  const mask = capN - 1;
  const tagOf = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const proof = proofs[i];
    const raw = proof.blob != null ? proof.blob : proof.proof;
    const field = proof.spendTag;
    const commit = vins[i].commit;
    const want = proof.cTilde;
    if (!raw || !versionedByte(raw[0])) return BIND_SLOW;
    if (raw.compare(field, 0, 32, 1, 33) !== 0) return { ok: false, reason: 'admit_tag' };
    if (commit.length !== want.length || !commit.equals(want)) {
      return { ok: false, reason: 'admit_membership' };
    }
    tagOf[i] = field;
    let h = (field.readUInt32BE(0) ^ field.readUInt32BE(8) ^ field.readUInt32BE(16) ^ field.readUInt32BE(24)) & mask;
    let steps = 0;
    while (slot[h] !== 0) {
      if (tagOf[slot[h] - 1].equals(field)) return { ok: false, reason: 'admit_link_tag' };
      h = (h + 1) & mask;
      steps += 1;
      if (steps > 24) return BIND_SLOW;
    }
    slot[h] = i + 1;
  }
  return { ok: true, tagOf };
}

/**
 * Every Flow vin is bound to one Admit proof. cTilde must equal that vin's
 * commit, the spend tag must be present, and an extra vin is not a proof.
 * Call this before verifyFlowConservation so an unbound commit cannot enter the sum.
 * Tag identity is one pass. A long probe chain restarts through a set so a
 * hostile frame stays linear when the 8-input cap is bypassed.
 */
export function flowInputsBound(tx) {
  const rawVins = Array.isArray(tx?.vin) ? tx.vin : [];
  let vins = rawVins;
  let shaped = false;
  for (let i = 0; i < rawVins.length; i += 1) {
    const v = rawVins[i];
    if (!v || v.coinbase) { shaped = true; break; }
  }
  if (shaped) {
    vins = rawVins.filter((x) => x);
    if (!vins.length || vins.some((v) => v.coinbase)) {
      return { ok: false, reason: 'admit_membership' };
    }
  } else if (!vins.length) {
    return { ok: false, reason: 'admit_membership' };
  }
  const listed = tx?.admit_proofs;
  const proofs = (Array.isArray(listed) && listed.length)
    ? listed
    : (tx?.admit_proof ? [tx.admit_proof] : []);
  if (proofs.length !== vins.length) return { ok: false, reason: 'admit_membership' };
  let placed;
  if (versionedHead(proofs[0]) && versionedHead(proofs[proofs.length - 1])) {
    try {
      placed = bindListedTight(vins, proofs);
    } catch {
      placed = BIND_SLOW;
    }
    if (placed === BIND_SLOW || placed.slow) placed = bindListedSlow(vins, proofs);
  } else {
    placed = bindListedSlow(vins, proofs);
  }
  if (!placed.ok) return { ok: false, reason: placed.reason || 'admit_membership' };
  const tagOf = placed.tagOf;
  // The bound list is the only spend. A distinct admit_proof beside it is not
  // a second input. Match it by the 32-byte tag already bound above. A full
  // blob compare runs only on a tag hit, so a hostile extra proof cannot
  // rescan every blob.
  const extra = tx?.admit_proof;
  if (extra && proofs.indexOf(extra) < 0) {
    const extraTag = boundProofTag(extra);
    let found = false;
    if (extraTag.ok && extraTag.tag) {
      for (let i = 0; i < proofs.length; i += 1) {
        const tag = tagOf[i];
        if (!tag || tag.length !== extraTag.tag.length || !tag.equals(extraTag.tag)) continue;
        if (sameBoundProof(proofs[i], extra)) {
          found = true;
          break;
        }
      }
    }
    if (!found) return { ok: false, reason: 'admit_membership' };
  }
  const top = postedSpendTag(tx?.spendTag);
  if (top.present && (!top.tag || !tagOf[0] || !top.tag.equals(tagOf[0]))) {
    return { ok: false, reason: 'admit_tag' };
  }
  return { ok: true, proofs, vins };
}

/**
 * Kinds that do not verify membership cannot carry a proof or a top spend tag.
 * A queued or sealed blob would otherwise enter the spent set with no admit_verify.
 * An empty list and an absent tag are not a carry.
 */
export function unboundMembershipCarry(tx) {
  if (tx?.admit_proof) return { ok: false, reason: 'admit_membership' };
  if (tx?.fs1 != null && tx.fs1 !== '') return { ok: false, reason: 'admit_membership' };
  if (Array.isArray(tx?.admit_proofs) && tx.admit_proofs.length > 0) {
    return { ok: false, reason: 'admit_membership' };
  }
  if (postedSpendTag(tx?.spendTag).present) return { ok: false, reason: 'admit_membership' };
  return { ok: true };
}

/** Positive safe integer. '5.0', a bool, and a negative are not a lock. */
function canonicalLockNanos(v) {
  if (typeof v === 'boolean' || v == null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v <= 0) return null;
    return v;
  }
  if (typeof v === 'bigint') {
    if (v <= 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(v);
  }
  if (typeof v === 'string') {
    if (!/^[1-9][0-9]*$/.test(v)) return null;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || String(n) !== v || n <= 0) return null;
    return n;
  }
  return null;
}

/**
 * Nanos a tx locks into a B leaf. 0 means this tx is not creating a leaf.
 * null means it asks for a leaf and the amount is not a positive safe integer.
 * A b-spend is a draw on a leaf, not a new one.
 */
export function flowBLockNanos(tx) {
  if (!tx || typeof tx !== 'object' || tx.coinbase) return 0;
  if (String(tx.kind || '') === 'b-spend') return 0;
  const ask = !!(tx.bFlag || tx.bExtra || String(tx.kind || '') === 'b-extra');
  if (!ask) return 0;
  const raw = tx.unit != null && tx.unit !== ''
    ? tx.unit
    : (tx.nanos != null && tx.nanos !== '' ? tx.nanos : tx.vout?.[0]?.nanos);
  return canonicalLockNanos(raw);
}

/**
 * sum(C_out) + (fee + B)·G = sum(C̃_in) + W·G + excess·H.
 * W is the vault payout. It is 0 for Flow, lock, and vote. A withdraw
 * passes W equal to the opened receipt, so a hidden change output lets
 * the spent note open to fee + change. B is the leaf lock from flowBLockNanos.
 * It is 0 when the tx is not creating a leaf, so a normal Flow caller is unchanged.
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
    const lock = flowBLockNanos(tx);
    if (lock == null) return false;
    const fee = Math.max(0, Math.floor(Number(tx.fee || 0)));
    const payout = Math.max(0, Math.floor(Number(vaultPayout) || 0));
    const lhsAdd = BigInt(fee) + BigInt(lock);
    const lhs = lhsAdd !== 0n ? outC.add(mulG(lhsAdd)) : outC;
    let rhs = inC.add(H.multiply(scalarFrom(tx.excess)));
    if (payout) rhs = rhs.add(mulG(payout));
    return lhs.equals(rhs);
  } catch {
    return false;
  }
}

/**
 * ADMITv2 native glue. Consensus verify is the native addon, not a JS second verifier.
 * Missing addon → verify returns false (never throws).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));

let native = null;
let nativeLoadError = '';

function noteNativeLoadFailure(reason) {
  native = null;
  nativeLoadError = String(reason || 'unknown');
  console.error(`shearadmit.node failed to load: ${nativeLoadError}`);
}

const admitDisabled = String(process.env.SHEAR_ADMIT_DISABLE || '').trim() === '1';
if (admitDisabled) {
  noteNativeLoadFailure('SHEAR_ADMIT_DISABLE=1');
} else {
  try {
    native = require(path.join(dir, 'native', 'shearadmit.node'));
  } catch (err) {
    const code = err && err.code ? `${err.code}: ` : '';
    const msg = err && err.message ? err.message : String(err);
    noteNativeLoadFailure(`${code}${msg}`);
  }
}

export function nativeLoadErrorText() {
  return nativeLoadError;
}

export function nativeLoaded() {
  return !!native;
}

export function nativeMaxProof() {
  if (!native || typeof native.maxProof !== 'function') return 0;
  try {
    return Number(native.maxProof()) || 0;
  } catch {
    return 0;
  }
}

export function nativeArity() {
  if (!native || typeof native.arity !== 'function') return 0;
  try {
    return Number(native.arity()) || 0;
  } catch {
    return 0;
  }
}

function as32(x) {
  if (x == null) return null;
  const b = Buffer.isBuffer(x) ? x : Buffer.from(x);
  if (b.length !== 32) return null;
  return b;
}

function leafList(bufs) {
  return (bufs || []).map((x) => {
    const b = as32(x);
    if (!b) throw new Error('leaf32');
    return b;
  });
}

export function noteH() {
  if (!native) return null;
  return Buffer.from(native.noteH());
}

export function destLeaf(p) {
  if (!native) return null;
  const b = as32(p);
  if (!b) return null;
  try {
    const o = native.leaf(b);
    return o && o.length === 32 ? Buffer.from(o) : null;
  } catch {
    return null;
  }
}

export function nativeJroot(destLeaves, cLeaves) {
  if (!native) return null;
  try {
    const o = native.jroot(leafList(destLeaves), leafList(cLeaves));
    return o && o.length === 32 ? Buffer.from(o) : null;
  } catch {
    return null;
  }
}

/** Version-3 book. The C root commits the ristretto points, not scalar(compress(C)). */
export function nativeJrootPoint(destLeaves, cLeaves) {
  if (!native || typeof native.jrootPoint !== 'function') return null;
  try {
    const o = native.jrootPoint(leafList(destLeaves), leafList(cLeaves));
    return o && o.length === 32 ? Buffer.from(o) : null;
  } catch {
    return null;
  }
}

/** Extend a JF01 frontier. An empty prev starts at zero leaves. Root matches nativeJroot of the whole set. */
export function nativeFrontierAppend(prev, destLeaves, cLeaves) {
  if (!native || typeof native.frontierAppend !== 'function') return null;
  try {
    const prior = prev && prev.length ? Buffer.from(prev) : Buffer.alloc(0);
    const o = native.frontierAppend(prior, leafList(destLeaves), leafList(cLeaves));
    if (!o || !o.root || o.root.length !== 32 || !o.frontier || !o.frontier.length) return null;
    return { root: Buffer.from(o.root), frontier: Buffer.from(o.frontier) };
  } catch {
    return null;
  }
}

export function nativeProveV3({ x, p, c, t, index, destLeaves, cLeaves, ctx }) {
  if (!native || typeof native.proveV3 !== 'function') return null;
  try {
    const xb = as32(x);
    const pb = as32(p);
    const cb = as32(c);
    const tb = as32(t);
    const context = Buffer.isBuffer(ctx) ? ctx : Buffer.from(ctx || []);
    if (!xb || !pb || !cb || !tb || context.length !== 64) return null;
    const dest = leafList(destLeaves);
    const cs = leafList(cLeaves);
    const got = native.proveV3(xb, pb, cb, tb, index >>> 0, dest, cs, context);
    if (!got || got === false || !got.proof || !got.cTilde) return null;
    return { cTilde: Buffer.from(got.cTilde), proof: Buffer.from(got.proof) };
  } catch {
    return null;
  }
}

export function nativeVerifyV3({ proof, jroot, cTilde, spendTag, ctx }) {
  if (!native || typeof native.verifyV3 !== 'function') return false;
  try {
    const pr = Buffer.isBuffer(proof) ? proof : Buffer.from(proof || []);
    const context = Buffer.from(ctx || []);
    if (context.length !== 64) return false;
    return !!native.verifyV3(pr, as32(jroot), as32(cTilde), as32(spendTag), context);
  } catch {
    return false;
  }
}

/** A safe integer, or the decimal text of any u64. Never Number() on a big digit string. */
export function rangeAmountArg(v) {
  if (typeof v === 'bigint') {
    if (v < 0n || v > 0xffffffffffffffffn) return null;
    return v.toString();
  }
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    return v;
  }
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return v;
  return null;
}

export function nativeProveRange(v, r, hedge = null) {
  if (!native) return null;
  const arg = rangeAmountArg(v);
  if (arg == null) return null;
  try {
    const o = hedge && hedge.length === 32
      ? native.proveRange(arg, as32(r), as32(hedge))
      : native.proveRange(arg, as32(r));
    return o && o.length ? Buffer.from(o) : null;
  } catch {
    return null;
  }
}

export function nativeVerifyRange(c, proof) {
  if (!native) return false;
  try {
    const pr = Buffer.isBuffer(proof) ? proof : (proof ? Buffer.from(proof) : Buffer.alloc(0));
    return !!native.verifyRange(as32(c), pr);
  } catch {
    return false;
  }
}

/** True when the addon carries the FS-1 spend. */
export function fs1NativeLoaded() {
  return !!(native && typeof native.fs1Verify === 'function' && typeof native.fs1TreeNew === 'function');
}

export function fs1BlobCap(n) {
  if (!fs1NativeLoaded()) return 0;
  try {
    return Number(native.fs1BlobCap(n >>> 0)) || 0;
  } catch {
    return 0;
  }
}

export function fs1RecordBytes() {
  if (!fs1NativeLoaded()) return 0;
  return Number(native.fs1RecordBytes()) || 0;
}

/** FS-1 root of a note buffer (64 bytes per note). Null when a note is not a leaf. */
export function fs1RootOf(notes) {
  if (!fs1NativeLoaded()) return null;
  try {
    const o = native.fs1Root(Buffer.from(notes));
    return o && o.length === 32 ? Buffer.from(o) : null;
  } catch {
    return null;
  }
}

/** A native FS-1 tree. The addon frees it with the returned object. */
export function fs1TreeNew() {
  if (!fs1NativeLoaded()) return null;
  try {
    return native.fs1TreeNew();
  } catch {
    return null;
  }
}

export function fs1TreeLen(h) {
  return Number(native.fs1TreeLen(h));
}

export function fs1TreeAppend(h, notes) {
  try {
    return !!native.fs1TreeAppend(h, Buffer.from(notes));
  } catch {
    return false;
  }
}

export function fs1TreeTruncate(h, len) {
  try {
    return !!native.fs1TreeTruncate(h, len);
  } catch {
    return false;
  }
}

export function fs1TreeRoot(h) {
  try {
    const o = native.fs1TreeRoot(h);
    return o && o.length === 32 ? Buffer.from(o) : null;
  } catch {
    return null;
  }
}

/** Prove a spend against a tree handle. `xs` is one 32-byte admit scalar per index. */
export function fs1Prove(h, { indices, xs, digest, anchor, threads = 0 }) {
  if (!fs1NativeLoaded() || !h) return null;
  try {
    const o = native.fs1Prove(h, indices.map(Number), Buffer.concat(xs.map((x) => as32(x))), as32(digest), Number(anchor), threads >>> 0);
    if (!o || o === false) return null;
    return { fs1: Buffer.from(o.fs1), records: Buffer.from(o.records), t: Buffer.from(o.t) };
  } catch {
    return null;
  }
}

/** Bytes of one external-signer request: m(64) index(1) O~ I~ R tag o i ib (32 each). */
export const FS1_SAL_REQUEST_BYTES = 64 + 1 + 7 * 32;
export const FS1_SAL_BYTES = 160;

/**
 * External signer (Ledger) host half, docs/LEDGER-VORTICE.md §5: membership
 * proof without the admit secrets. `tags` are the signer's spend tags.
 * Returns { ctx, requests } (requests hold host blinds, not the owner key).
 */
export function fs1ProveExternal(h, { indices, tags, digest, anchor, threads = 0 }) {
  if (!fs1NativeLoaded() || !h || typeof native.fs1ProveExternal !== 'function') return null;
  try {
    const o = native.fs1ProveExternal(h, indices.map(Number), Buffer.concat(tags.map((t) => as32(t))), as32(digest), Number(anchor), threads >>> 0);
    if (!o || o === false) return null;
    return { ctx: o.ctx, requests: Buffer.from(o.requests) };
  } catch {
    return null;
  }
}

/** Check the signer's SA+L replies and emit { fs1, records, t } as fs1Prove does. Consumes ctx. */
export function fs1ExternalAssemble(ctx, sals) {
  if (!fs1NativeLoaded() || !ctx) return null;
  try {
    const o = native.fs1ExternalAssemble(ctx, Buffer.concat(sals.map((s) => Buffer.from(s))));
    if (!o || o === false) return null;
    return { fs1: Buffer.from(o.fs1), records: Buffer.from(o.records), t: Buffer.from(o.t) };
  } catch {
    return null;
  }
}

/** Reference signer (tests and device vectors only): the spend tag for x. */
export function fs1ExternalTag(x) {
  try {
    const o = native.fs1ExternalTag(as32(x));
    return o && o.length === 32 ? Buffer.from(o) : null;
  } catch {
    return null;
  }
}

/** Reference signer (tests and device vectors only): SA+L for one request. */
export function fs1ExternalSign(request, x) {
  try {
    const o = native.fs1ExternalSign(Buffer.from(request), as32(x));
    return o && o.length === FS1_SAL_BYTES ? Buffer.from(o) : null;
  } catch {
    return null;
  }
}

/** Consensus verify of one FS-1 spend. False when the addon is missing. */
export function fs1Verify({ fs1, records, root, digest, anchor }) {
  if (!fs1NativeLoaded()) return false;
  try {
    return !!native.fs1Verify(Buffer.from(fs1), Buffer.from(records), as32(root), as32(digest), Number(anchor));
  } catch {
    return false;
  }
}

/**
 * Claim spend. The published record tag is one-time. `nullBases` is one
 * 32-byte epoch base per input. `link` is 96 bytes per input.
 */
export function fs1ProveUnlinked(h, { indices, xs, digest, anchor, threads = 0, nullBases }) {
  if (!fs1NativeLoaded() || !h) return null;
  try {
    const bases = Buffer.isBuffer(nullBases) ? nullBases : Buffer.from(nullBases);
    const o = native.fs1ProveUnlinked(
      h,
      indices.map(Number),
      Buffer.concat(xs.map((x) => as32(x))),
      as32(digest),
      Number(anchor),
      threads >>> 0,
      bases,
    );
    if (!o || o === false) return null;
    return {
      fs1: Buffer.from(o.fs1),
      records: Buffer.from(o.records),
      t: Buffer.from(o.t),
      link: Buffer.from(o.link),
    };
  } catch {
    return null;
  }
}

/** Verify a claim spend whose tag is not the stable FS-1 spend tag. */
export function fs1VerifyUnlinked({ fs1, records, link, root, digest, anchor, nullBases }) {
  if (!fs1NativeLoaded()) return false;
  try {
    return !!native.fs1VerifyUnlinked(
      Buffer.from(fs1),
      Buffer.from(records),
      Buffer.from(link),
      as32(root),
      as32(digest),
      Number(anchor),
      Buffer.isBuffer(nullBases) ? nullBases : Buffer.from(nullBases),
    );
  } catch {
    return false;
  }
}

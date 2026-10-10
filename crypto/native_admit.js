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
try {
  native = require(path.join(dir, 'native', 'shearadmit.node'));
} catch {
  native = null;
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

export function nativeProve({ x, p, c, t, index, destLeaves, cLeaves }) {
  if (!native) return null;
  try {
    const xb = as32(x);
    const pb = as32(p);
    const cb = as32(c);
    const tb = as32(t);
    if (!xb || !pb || !cb || !tb) return null;
    const dest = leafList(destLeaves);
    const cs = leafList(cLeaves);
    const got = native.prove(xb, pb, cb, tb, index >>> 0, dest, cs);
    if (!got || got === false || !got.proof || !got.cTilde) return null;
    return { cTilde: Buffer.from(got.cTilde), proof: Buffer.from(got.proof) };
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

export function nativeVerify({ proof, jroot, cTilde, spendTag, destLeaves = [], cLeaves = [] }) {
  if (!native) return false;
  try {
    const pr = Buffer.isBuffer(proof) ? proof : Buffer.from(proof || []);
    return !!native.verify(
      pr,
      as32(jroot),
      as32(cTilde),
      as32(spendTag),
      leafList(destLeaves),
      leafList(cLeaves),
    );
  } catch {
    return false;
  }
}

/** Native prove+jroot-only verify for |J|=n. Returns {proveUs, verifyUs, proofLen} or null. */
export function nativeBench(n) {
  if (!native || typeof native.bench !== 'function') return null;
  try {
    const o = native.bench(n >>> 0);
    if (!o || o === false) return null;
    return {
      proveUs: Number(o.proveUs),
      verifyUs: Number(o.verifyUs),
      proofLen: Number(o.proofLen),
    };
  } catch {
    return null;
  }
}

export function nativeVerifyBatch({ proofs, jroot, cTildes, tags, destLeaves = [], cLeaves = [] }) {
  if (!native) return false;
  try {
    return !!native.verifyBatch(
      (proofs || []).map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))),
      as32(jroot),
      leafList(cTildes),
      leafList(tags),
      leafList(destLeaves),
      leafList(cLeaves),
    );
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

export function nativeProveRange(v, r) {
  if (!native) return null;
  const arg = rangeAmountArg(v);
  if (arg == null) return null;
  try {
    const o = native.proveRange(arg, as32(r));
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

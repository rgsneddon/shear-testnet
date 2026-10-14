/**
 * FS-1 spend (ADMITv3) wire, body digest, and the root a node holds for an anchor.
 *
 * One spend covers every input of a send. `tx.fs1` is the aggregate blob
 * `0xF1 || layers || n || root || FCMP` and `admit_proofs[i].blob` is input
 * i's record `0xF1 || spendTag || C̃ || O~ || I~ || R || SA+L` (321 bytes).
 * The prover and verifier are shear-fs1 (vendored monero-oxide FCMP++, MIT).
 *
 * T-1 and N-1 make the FS-1 leaf set the admit set, so the root at an anchor
 * is the tree over the first `n` admit-set notes that anchor row names.
 */
import { createHash } from 'node:crypto';
import { MAGIC_TESTNET } from './asert.js';
import { asU8, pointBytes } from './note.js';
import { reserveDigestSuffix } from './reserve_vault.js';
import {
  fs1BlobCap,
  fs1NativeLoaded,
  fs1TreeAppend,
  fs1TreeNew,
  fs1TreeRoot,
  fs1TreeTruncate,
  fs1Verify,
} from './native_admit.js';

export const FS1_WIRE = 0xf1;
export const FS1_HEAD_BYTES = 35;
export const FS1_RECORD_BYTES = 321;
export const FS1_DEPTH = 7;
export const FS1_INPUT_MAX = 8;
export const FS1_DIGEST_DST = 'shear-admit-fs1-txd';

function bytesOf(v) {
  if (v == null || v === '' || v === false) return null;
  try {
    const b = Buffer.from(asU8(v));
    return b.length ? b : null;
  } catch {
    return null;
  }
}

function bytes32(v) {
  const b = bytesOf(v);
  return b && b.length === 32 ? b : null;
}

function proofBlob(proof) {
  if (!proof || typeof proof !== 'object') return null;
  return bytesOf(proof.blob != null ? proof.blob : proof.proof);
}

/** First byte of a proof blob is the FS-1 wire byte. Length is checked on verify. */
export function proofIsFs1(proof) {
  const b = proofBlob(proof);
  return !!(b && b[0] === FS1_WIRE);
}

function listedProofs(tx) {
  const out = [];
  if (tx?.admit_proof) out.push(tx.admit_proof);
  if (Array.isArray(tx?.admit_proofs)) for (const p of tx.admit_proofs) if (p) out.push(p);
  return out;
}

/** The tx carries an FS-1 blob or any FS-1 record. */
export function txPresentsFs1(tx) {
  if (tx && tx.fs1 != null && tx.fs1 !== '') return true;
  return listedProofs(tx).some(proofIsFs1);
}

/** Every listed proof is an FS-1 record. */
export function txAllFs1(tx) {
  const proofs = listedProofs(tx);
  return proofs.length > 0 && proofs.every(proofIsFs1);
}

export function fs1BlobOf(tx) {
  return bytesOf(tx?.fs1);
}

/** Exact blob length for `n` inputs. 0 when the addon is missing or `n` is out of range. */
export function fs1BlobLen(n) {
  return fs1BlobCap(n);
}

function lenPref(value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(b.length >>> 0);
  return Buffer.concat([n, b]);
}

function u64le(value) {
  const b = Buffer.alloc(8);
  const n = Number(value);
  b.writeBigUInt64LE(Number.isFinite(n) ? BigInt(Math.max(0, Math.floor(n))) : 0n);
  return b;
}

function rawBytes(v) {
  if (v == null || v === '' || v === true) return Buffer.alloc(0);
  try {
    return Buffer.from(asU8(v));
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * SHA-256 body digest an FS-1 spend binds. The fields are the ones the
 * sealed compact row keeps (chronoflux compactVout), so a relayed copy has
 * the same digest. Per-input tags and C̃ are in the spend transcript, not here.
 * Wallet port: wallet/lib/shear_fs1.dart fs1BodyDigest.
 */
export function txBodyDigestFs1(tx, magic = MAGIC_TESTNET) {
  const kind = String(tx?.kind || '');
  const vins = (Array.isArray(tx?.vin) ? tx.vin : []).filter((v) => v && !v.coinbase);
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const nIn = Buffer.alloc(4);
  nIn.writeUInt32LE(vins.length >>> 0);
  const nOut = Buffer.alloc(4);
  nOut.writeUInt32LE(outs.length >>> 0);
  const parts = [
    Buffer.from(FS1_DIGEST_DST),
    Buffer.from([FS1_WIRE]),
    lenPref(Buffer.from(String(magic || ''))),
    lenPref(Buffer.from(kind)),
    u64le(tx?.anchor ?? 0),
    u64le(tx?.fee || 0),
    nIn,
    nOut,
  ];
  for (const o of outs) {
    const posted = o?.kind == null || o.kind === '' ? '' : String(o.kind);
    const outKind = posted || 'pot';
    const view = rawBytes(o?.viewTag);
    const d20 = rawBytes(o?.dest20);
    parts.push(lenPref(Buffer.from(outKind)));
    parts.push(bytes32(o?.commit) || Buffer.alloc(32));
    parts.push(bytes32(o?.admitPub) || Buffer.alloc(32));
    parts.push(bytes32(o?.noteCommit) || Buffer.alloc(32));
    parts.push(bytes32(o?.rEph) || Buffer.alloc(32));
    parts.push(lenPref(rawBytes(o?.rCt)));
    parts.push(lenPref(rawBytes(o?.amtCt)));
    parts.push(view.length ? view.subarray(0, 1) : Buffer.alloc(1));
    parts.push(createHash('sha256').update(rawBytes(o?.rangeProof)).digest());
    parts.push(lenPref(d20.length >= 20 ? d20.subarray(0, 20) : Buffer.alloc(0)));
  }
  parts.push(lenPref(Buffer.from(String(tx?.portalId || '').toLowerCase())));
  parts.push(lenPref(Buffer.from(String(tx?.programId || ''))));
  parts.push(lenPref(Buffer.from(String(tx?.payoutPortalId || '').toLowerCase())));
  const reserveSuffix = reserveDigestSuffix(tx);
  if (reserveSuffix) parts.push(reserveSuffix);
  return createHash('sha256').update(Buffer.concat(parts)).digest();
}

function pubBuf(p) {
  if (Buffer.isBuffer(p)) return p.length === 32 ? p : null;
  if (p instanceof Uint8Array) return p.length === 32 ? Buffer.from(p) : null;
  try {
    return Buffer.from(pointBytes(p));
  } catch {
    return null;
  }
}

function samePub(a, b) {
  if (a === b) return true;
  if (a && b && typeof a.equals === 'function' && typeof a.toBytes === 'function'
      && typeof b.equals === 'function' && typeof b.toBytes === 'function') {
    try {
      return a.equals(b);
    } catch {
      return false;
    }
  }
  const x = pubBuf(a);
  const y = pubBuf(b);
  return !!(x && y && x.equals(y));
}

function sameCommit(a, b) {
  if (a === b) return true;
  const x = bytes32(a);
  const y = bytes32(b);
  return !!(x && y && x.equals(y));
}

/**
 * One native tree follows the longest admit-set prefix asked for. A request
 * keeps the common prefix, truncates the rest, and appends what it needs.
 * Roots are cached by (n, jroot), so a mempool or block re-check does not
 * touch the tree.
 */
const tree = { handle: null, pubs: [], commits: [] };
const rootCache = new Map();
const ROOT_CACHE_MAX = 512;
let treeAppends = 0;

export function fs1TreeStats() {
  return { len: tree.pubs.length, cached: rootCache.size, appends: treeAppends };
}

/** Test hook: drop the tree and every cached root. */
export function resetFs1Tree() {
  tree.handle = null;
  tree.pubs = [];
  tree.commits = [];
  rootCache.clear();
  verifyCache.clear();
}

function cacheKey(n, jroot) {
  const j = bytes32(jroot);
  return j ? `${n}:${j.toString('hex')}` : null;
}

/**
 * FS-1 root of `live` = { n, jroot, pubs, commits } (noteFromAnchor's row).
 * Null when the addon is missing, the row is short, or a note is not a leaf.
 */
export function fs1RootAt(live) {
  const n = Number(live?.n);
  const pubs = live?.pubs || [];
  const commits = live?.commits || [];
  if (!Number.isSafeInteger(n) || n < 1 || pubs.length < n || commits.length < n) return null;
  const key = cacheKey(n, live?.jroot);
  if (key && rootCache.has(key)) return rootCache.get(key);
  if (!fs1NativeLoaded()) return null;
  if (!tree.handle) {
    tree.handle = fs1TreeNew();
    tree.pubs = [];
    tree.commits = [];
    if (!tree.handle) return null;
  }
  let k = 0;
  const lim = Math.min(tree.pubs.length, n);
  while (k < lim && samePub(tree.pubs[k], pubs[k]) && sameCommit(tree.commits[k], commits[k])) k += 1;
  if (k < tree.pubs.length) {
    if (!fs1TreeTruncate(tree.handle, k)) {
      tree.handle = null;
      return null;
    }
    tree.pubs.length = k;
    tree.commits.length = k;
  }
  if (k < n) {
    const buf = Buffer.alloc((n - k) * 64);
    for (let i = k; i < n; i += 1) {
      const p = pubBuf(pubs[i]);
      const c = bytes32(commits[i]);
      if (!p || !c) return null;
      p.copy(buf, (i - k) * 64);
      c.copy(buf, (i - k) * 64 + 32);
    }
    if (!fs1TreeAppend(tree.handle, buf)) return null;
    treeAppends += 1;
    for (let i = k; i < n; i += 1) {
      tree.pubs.push(pubs[i]);
      tree.commits.push(commits[i]);
    }
  }
  const root = fs1TreeRoot(tree.handle);
  if (!root) return null;
  if (key) {
    if (rootCache.size >= ROOT_CACHE_MAX) rootCache.delete(rootCache.keys().next().value);
    rootCache.set(key, root);
  }
  return root;
}

const verifyCache = new Set();
const VERIFY_CACHE_MAX = 4096;
let verifyCalls = 0;

/** Native verifies run (cache hits do not count). */
export function fs1VerifyCount() {
  return verifyCalls;
}

export function resetFs1VerifyCount() {
  verifyCalls = 0;
}

/**
 * Verify one spend. A result is cached by the hash of every input to the
 * check, so a mempool re-check after a block is not a second proof verify.
 */
export function fs1VerifySpend({ fs1, records, root, digest, anchor }) {
  const key = createHash('sha256')
    .update(fs1)
    .update(records)
    .update(root)
    .update(digest)
    .update(u64le(anchor))
    .digest('hex');
  if (verifyCache.has(key)) return true;
  verifyCalls += 1;
  const ok = fs1Verify({ fs1, records, root, digest, anchor });
  if (ok) {
    if (verifyCache.size >= VERIFY_CACHE_MAX) verifyCache.delete(verifyCache.values().next().value);
    verifyCache.add(key);
  }
  return ok;
}

/** Parse the records of a bound proof list. Null on any malformed record. */
export function fs1Records(proofs) {
  const out = [];
  for (const proof of proofs || []) {
    const b = proofBlob(proof);
    if (!b || b.length !== FS1_RECORD_BYTES || b[0] !== FS1_WIRE) return null;
    out.push({
      blob: b,
      tag: b.subarray(1, 33),
      cTilde: b.subarray(33, 65),
    });
  }
  return out;
}

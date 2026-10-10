/**
 * Dual-tree clearing: continuity_root = H(rootA || rootB).
 * A = one leaf per hasher {dest20, count}. B = opt-in per-hash extras.
 * B spends only after the committing block; proof against that header.
 */
import { sha256 } from './shear_hash.js';
import { merkleRoot, merkleProof, merkleBound } from './merkle.js';
import { packALeafV5, packBLeaf, packDigest } from './pack.js';
import { noteCommitOfDest20, openedCoinbaseNanos, flowBLockNanos, verifyFlowConservation } from './note.js';
import { hash20FromAddress } from './address.js';
import { decodeHeader } from './header.js';
import { SPENDABLE_CONFIRMATIONS } from './asert.js';

export function aLeafBytes(leaf) {
  const noteCommit = leaf.noteCommit && Buffer.from(leaf.noteCommit).length === 32
    ? Buffer.from(leaf.noteCommit)
    : noteCommitOfDest20(Buffer.from(leaf.dest20));
  return packDigest(packALeafV5({ noteCommit, count: leaf.count }));
}

export function bLeafBytes({ dest20, unit, nonce, memoH, tag }) {
  return packDigest(packBLeaf({ dest20, unit, nonce, memoH, tag }));
}

export function dualContinuityRoot(rootA, rootB) {
  return sha256(Buffer.concat([Buffer.from(rootA), Buffer.from(rootB)]));
}

export function buildDualTree({ aLeaves = [], bLeaves = [] } = {}) {
  const aDigests = aLeaves.map((l) => aLeafBytes(l));
  const bDigests = bLeaves.map((l) => bLeafBytes(l));
  const rootA = merkleRoot(aDigests);
  const rootB = merkleRoot(bDigests);
  return {
    rootA,
    rootB,
    continuityRoot: dualContinuityRoot(rootA, rootB),
    aDigests,
    bDigests,
  };
}

export function bLeafId(leaf, height, index) {
  const d = bLeafBytes(leaf);
  return `${Number(height) || 0}:${Number(index) || 0}:${d.toString('hex')}`;
}

/**
 * Spend a B unit after the committing block has consensus depth
 * (SPENDABLE_CONFIRMATIONS). Proof is merkle of the B digest in tree B.
 */
export function spendB({
  leaf,
  proof,
  header,
  rootA,
  rootB,
  height,
  index,
  tipHeight,
  spent,
} = {}) {
  let canon;
  try {
    canon = canonicalLeafFields(leaf, '');
  } catch {
    return { ok: false, reason: 'leaf' };
  }
  if (!canon) return { ok: false, reason: 'leaf' };
  if (!header) return { ok: false, reason: 'no_header' };
  let decoded;
  try {
    decoded = decodeHeader(Buffer.from(header));
  } catch {
    return { ok: false, reason: 'bad_header' };
  }
  let a;
  let b;
  try {
    a = Buffer.from(rootA || Buffer.alloc(32));
    b = Buffer.from(rootB || Buffer.alloc(32));
  } catch {
    return { ok: false, reason: 'leaf' };
  }
  if (!dualContinuityRoot(a, b).equals(decoded.continuityRoot)) {
    return { ok: false, reason: 'continuity' };
  }
  const h = Number(height) || 0;
  const tip = Number(tipHeight) || 0;
  if (!(h >= 1) || tip < h) return { ok: false, reason: 'pre_seal' };
  if (tip - h + 1 < SPENDABLE_CONFIRMATIONS) return { ok: false, reason: 'immature' };
  let digest;
  try {
    digest = bLeafBytes(canon);
  } catch {
    return { ok: false, reason: 'leaf' };
  }
  const pos = merkleBound(digest, proof, b);
  if (pos == null) return { ok: false, reason: 'proof' };
  const claimed = positionIndex(index);
  if (claimed == null || claimed !== pos) return { ok: false, reason: 'proof' };
  let id;
  try {
    id = bLeafId(canon, h, pos);
  } catch {
    return { ok: false, reason: 'leaf' };
  }
  const book = spent instanceof Set ? spent : new Set(spent || []);
  if (book.has(id)) return { ok: false, reason: 'double_open' };
  book.add(id);
  return { ok: true, id, dest20: canon.dest20, unit: canon.unit, spent: book };
}

export function bProof(bLeaves, index) {
  const digests = (bLeaves || []).map((l) => bLeafBytes(l));
  return merkleProof(digests, index);
}

/** The block this node already has at `height`, or null. A tx field is not a block. */
export function chainBlockAt(height, history, prev) {
  const h = Number(height);
  if (!Number.isInteger(h) || h < 1) return null;
  const hit = (b) => !!(b && b.header && Number(b.height) === h);
  if (hit(prev)) return prev;
  if (history && typeof history.length === 'number') {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const b = history[i];
      if (hit(b)) return b;
    }
  }
  return null;
}

function decodeExact(x, n) {
  try {
    if (Buffer.isBuffer(x) || x instanceof Uint8Array) {
      const b = Buffer.from(x);
      return b.length === n ? b : null;
    }
    if (typeof x === 'string') {
      if (x.length !== n * 2 || !/^[0-9a-fA-F]+$/.test(x)) return null;
      return Buffer.from(x, 'hex');
    }
    if (x && typeof x === 'object') {
      if (typeof x.$hex === 'string') return decodeExact(x.$hex, n);
      if (x.type === 'Buffer' && Array.isArray(x.data)) {
        if (x.data.length !== n) return null;
        for (const v of x.data) {
          if (!Number.isInteger(v) || v < 0 || v > 255) return null;
        }
        return Buffer.from(x.data);
      }
      if (Array.isArray(x)) {
        if (x.length !== n) return null;
        for (const v of x) {
          if (!Number.isInteger(v) || v < 0 || v > 255) return null;
        }
        return Buffer.from(x);
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Non-negative safe integer. A missing field is `whenMissing`. '5.0' is not canonical. */
function canonicalU64(v, whenMissing) {
  if (v == null || v === '') return whenMissing;
  if (typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    return v;
  }
  if (typeof v === 'bigint') {
    if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(v);
  }
  if (typeof v === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(v)) return null;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || String(n) !== v) return null;
    return n;
  }
  return null;
}

function canonicalTag(tag, fallback) {
  const s = tag == null || tag === '' ? (fallback == null ? '' : String(fallback)) : String(tag);
  if (s.length > 8) return null;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x7f) return null;
  }
  return s;
}

function canonicalLeafFields(leaf, fallbackTag) {
  if (!leaf || typeof leaf !== 'object') return null;
  const dest20 = decodeExact(leaf.dest20, 20);
  if (!dest20) return null;
  const memoH = leaf.memoH == null || leaf.memoH === ''
    ? Buffer.alloc(32)
    : decodeExact(leaf.memoH, 32);
  if (!memoH) return null;
  const unit = canonicalU64(leaf.unit, 0);
  if (unit == null) return null;
  const nonce = canonicalU64(leaf.nonce, 0);
  if (nonce == null) return null;
  const tag = canonicalTag(leaf.tag, fallbackTag);
  if (tag == null) return null;
  return { dest20, unit, nonce, memoH, tag };
}

/** Missing index is position 0. Any other shape is not a position. */
function positionIndex(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'bigint' && v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
  return null;
}

/** Exact 20-byte dest, 32-byte memo, safe-integer unit and nonce, ASCII tag of at most 8 bytes. */
export function canonicalBLeaf(tx) {
  try {
    if (tx?.leaf && tx.leaf.dest20 != null) return canonicalLeafFields(tx.leaf, '');
    let dest20 = null;
    try {
      const h = hash20FromAddress(tx?.to || tx?.vout?.[0]?.address || '');
      if (h) dest20 = Buffer.from(h);
    } catch { /* no dest */ }
    return canonicalLeafFields({
      dest20,
      unit: tx?.unit != null ? tx.unit : tx?.nanos,
      nonce: tx?.nonce,
      memoH: tx?.memoH,
      tag: tx?.tag == null || tx?.tag === '' ? 'b-spend' : tx.tag,
    }, 'b-spend');
  } catch {
    return null;
  }
}

/**
 * Spend a B leaf against the chain block at commitHeight.
 * commitHeader, commitRootA, and commitRootB on the tx are ignored.
 * Every output opens, and the opened sum is the leaf unit.
 */
export function bindBSpend(tx, { history = null, prev = null, tipHeight = 0, spent = null } = {}) {
  try {
    const leaf = canonicalBLeaf(tx);
    if (!leaf) return { ok: false, reason: 'leaf' };
    const commitH = Number(tx?.commitHeight || 0);
    const block = chainBlockAt(commitH, history, prev);
    if (!block?.header) return { ok: false, reason: 'pre_seal' };
    const outs = Array.isArray(tx?.vout) ? tx.vout : [];
    if (!outs.length) return { ok: false, reason: 'commit_sum' };
    let sum = 0;
    for (const o of outs) {
      const v = openedCoinbaseNanos(o);
      if (!Number.isSafeInteger(v) || v < 0) return { ok: false, reason: 'commit_sum' };
      if (sum > Number.MAX_SAFE_INTEGER - v) return { ok: false, reason: 'commit_sum' };
      sum += v;
    }
    if (sum !== leaf.unit) return { ok: false, reason: 'commit_sum' };
    return spendB({
      leaf,
      proof: tx?.proof || [],
      header: block.header,
      rootA: block.rootA,
      rootB: block.rootB,
      height: commitH,
      index: tx?.index,
      tipHeight,
      spent,
    });
  } catch {
    return { ok: false, reason: 'leaf' };
  }
}

function leafDest20(tx) {
  const owned = decodeExact(tx?.dest20, 20);
  if (owned) return owned;
  try {
    const h = hash20FromAddress(tx?.to || tx?.vout?.[0]?.address || '');
    if (h) return Buffer.from(h);
  } catch { /* no dest */ }
  const fromOut = decodeExact(tx?.vout?.[0]?.dest20, 20);
  return fromOut;
}

/** The leaf a creating tx asks to lock. null when the fields are not canonical. */
export function createLeafFromTx(tx) {
  const lock = flowBLockNanos(tx);
  if (lock == null || lock <= 0) return null;
  const dest20 = leafDest20(tx);
  if (!dest20) return null;
  return canonicalLeafFields({
    dest20,
    unit: lock,
    nonce: tx?.nonce,
    memoH: tx?.memoH,
    tag: tx?.tag == null || tx?.tag === '' ? 'b-extra' : tx.tag,
  }, 'b-extra');
}

/**
 * A tx that asks for a B leaf must lock that unit in the conservation equation
 * and carry a canonical leaf. A tx that is not asking returns null.
 */
export function bLeafAskRejected(tx) {
  const lock = flowBLockNanos(tx);
  if (lock === 0) return null;
  if (lock == null) return { ok: false, reason: 'b_debit' };
  const leaf = createLeafFromTx(tx);
  if (!leaf || leaf.unit !== lock) return { ok: false, reason: 'b_debit' };
  if (!verifyFlowConservation(tx, null, 0)) return { ok: false, reason: 'b_debit' };
  return null;
}

/** Leaves implied by the body. A failed ask is b_debit, not an empty list. */
export function derivedBLeaves(txs) {
  const leaves = [];
  for (const tx of txs || []) {
    if (!tx || tx.coinbase) continue;
    const lock = flowBLockNanos(tx);
    if (lock === 0) continue;
    const bad = bLeafAskRejected(tx);
    if (bad) return bad;
    const leaf = createLeafFromTx(tx);
    if (!leaf) return { ok: false, reason: 'b_debit' };
    leaves.push(leaf);
  }
  return { ok: true, leaves };
}

function leafRecord(leaf) {
  if (!leaf) return null;
  try {
    return canonicalLeafFields(leaf, leaf.tag == null || leaf.tag === '' ? 'b-extra' : '');
  } catch {
    return null;
  }
}

/** Same leaves, same order. A non-canonical published leaf does not match. */
export function sameBLeaves(published, derived) {
  const a = Array.isArray(published) ? published : [];
  const b = Array.isArray(derived) ? derived : [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = leafRecord(a[i]);
    const right = leafRecord(b[i]);
    if (!left || !right) return false;
    if (left.unit !== right.unit || left.nonce !== right.nonce || left.tag !== right.tag) return false;
    if (!left.dest20.equals(right.dest20) || !left.memoH.equals(right.memoH)) return false;
  }
  return true;
}

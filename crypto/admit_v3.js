/**
 * ADMITv3 anchor window (083e V1–V3, 083g) and typed-kind funding (OPEN-5 A).
 * H is the height of the block that includes the spend. Mempool uses tip + 1.
 * A presented anchor that fails the window is rejected. Lock, vote, and
 * withdraw are funded only by a byte-3 input, and a flow spend (send or
 * transfer) that presents a proof is admit_version unless every blob is byte
 * 3 and an anchor is present. Stage 0: a byte-3 bucket proof is
 * send_unavailable on a flow spend and vault_unavailable on a vault kind,
 * before any proof work. No path here calls a membership verifier. A flow
 * spend with no proof is unchanged. Fingerprint tokens stay off.
 */
import { createHash } from 'node:crypto';
import { SPENDABLE_CONFIRMATIONS, MAGIC_TESTNET } from './asert.js';
import { asU8, flowInputsBound } from './note.js';
import { flowNeedsDummy, publicReserveReceipt } from './dummy.js';
import { jrootPoint } from './admit.js';
import { reserveDigestSuffix } from './reserve_vault.js';
import {
  FS1_SEND_REASON,
  FS1_SEND_STATE,
  FS1_VAULT_REASON,
  FS1_VAULT_STATE,
  v3BucketSendRejected,
  v3BucketVaultRejected,
} from './fs1_send_gate.js';

export const ANCHOR_QUANTUM = 8;
export const ANCHOR_WINDOW = 64;

const K = SPENDABLE_CONFIRMATIONS;

export function anchorRejectReason(A, H) {
  if (!Number.isSafeInteger(H) || H < 1) return 'admit_anchor_window';
  if (!Number.isSafeInteger(A) || A < ANCHOR_QUANTUM || A % ANCHOR_QUANTUM !== 0) {
    return 'admit_anchor_quantum';
  }
  const newest = H - K;
  const oldest = newest - ANCHOR_WINDOW;
  if (A < oldest || A > newest) return 'admit_anchor_window';
  return null;
}

/** Newest multiple of Q at least K behind T. Null means WAIT. */
export function walletAnchor(T) {
  if (!Number.isSafeInteger(T) || T - K < ANCHOR_QUANTUM) return null;
  return Math.floor((T - K) / ANCHOR_QUANTUM) * ANCHOR_QUANTUM;
}

/** First inclusion height at which a note minted at h can sit in the wallet anchor. */
export function readyHeight(h) {
  if (!Number.isSafeInteger(h) || h < 1) return null;
  const boundary = Math.ceil(h / ANCHOR_QUANTUM) * ANCHOR_QUANTUM;
  return boundary + K;
}

function presentedAnchors(tx) {
  const values = [];
  if (tx && Object.prototype.hasOwnProperty.call(tx, 'anchor') && tx.anchor != null) {
    values.push(tx.anchor);
  }
  const vins = Array.isArray(tx?.vin) ? tx.vin : [];
  for (const vin of vins) {
    if (vin && Object.prototype.hasOwnProperty.call(vin, 'anchor') && vin.anchor != null) {
      values.push(vin.anchor);
    }
  }
  return values;
}

/**
 * v12 interim: a flow spend that presents proofs must be byte 3 and anchored.
 * Any other byte, a missing blob, a mixed list, or byte 3 with no anchor is
 * admit_version. No proof, and every non-flow kind, stays on the existing path.
 * A byte-3 bucket proof is send_unavailable before that check. Stage 0 does
 * not verify it. This gate does not verify the proof.
 */
export function v12FlowVersionRejected(tx) {
  if (!flowNeedsDummy(tx)) return null;
  const gated = v3BucketSendRejected(tx);
  if (gated) return gated;
  const proofs = proofsOf(tx);
  if (!proofs.length) return null;
  for (const proof of proofs) {
    const raw = proof?.blob || proof?.proof;
    let pr = null;
    try {
      pr = raw ? Buffer.from(asU8(raw)) : null;
    } catch {
      pr = null;
    }
    if (!pr || pr.length < 1 || pr[0] !== 3) return { ok: false, reason: 'admit_version' };
  }
  if (!presentedAnchors(tx).length) return { ok: false, reason: 'admit_version' };
  return null;
}

/** One anchor per tx. Absent means this rule does not apply. */
export function checkAdmitAnchor(tx, H) {
  const values = presentedAnchors(tx);
  if (!values.length) return { ok: true };
  const A = values[0];
  for (const v of values) {
    if (!Object.is(v, A)) return { ok: false, reason: 'admit_anchor_quantum' };
  }
  const reason = anchorRejectReason(A, H);
  if (reason) return { ok: false, reason };
  return { ok: true, anchor: A };
}

const TYPED_ADMIT_KINDS = new Set(['lock', 'vote', 'withdraw']);

export function typedKindNeedsAdmitV3(tx) {
  if (publicReserveReceipt(tx)) return false;
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  return TYPED_ADMIT_KINDS.has(kind);
}

function bytes32(value) {
  try {
    const b = Buffer.from(asU8(value));
    if (b.length === 32) return b;
  } catch { /* not 32 bytes */ }
  return null;
}

const AMT_CT_TAG = Buffer.from([0xa7]);

function lenPref(value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(b.length >>> 0);
  return Buffer.concat([n, b]);
}

function u64le(value) {
  const b = Buffer.alloc(8);
  const n = Number(value);
  const v = Number.isFinite(n) ? BigInt(Math.max(0, Math.floor(n))) : 0n;
  b.writeBigUInt64LE(v);
  return b;
}

function proofsOf(tx) {
  const out = [];
  if (tx?.admit_proof) out.push(tx.admit_proof);
  if (Array.isArray(tx?.admit_proofs)) {
    for (const proof of tx.admit_proofs) {
      if (proof && proof !== tx.admit_proof) out.push(proof);
    }
  }
  return out;
}

/** Bytes of a versioned blob. Null means this object is not a versioned proof. */
function presentedProofBytes(proof) {
  if (!proof || typeof proof !== 'object') return null;
  const raw = proof.blob != null ? proof.blob : proof.proof;
  if (raw == null || raw === false || raw === '') return null;
  try {
    return Buffer.from(asU8(raw));
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * A Flow membership shape binds cTilde and a spend tag and carries no proof
 * bytes. An empty blob, a bad byte, or a mix with a versioned blob is not one.
 */
export function membershipShapeOnly(tx) {
  if (!flowNeedsDummy(tx)) return false;
  const proofs = proofsOf(tx);
  if (!proofs.length) return false;
  for (const proof of proofs) {
    if (presentedProofBytes(proof)) return false;
    if (!proof || proof.cTilde == null) return false;
    if (proof.spendTag == null || proof.spendTag === '') return false;
  }
  return true;
}

/** SHA-256 digest bound into the v3 transcript. Portal id, program, payout portal, and each output dest20 are included so a relay cannot retarget them. The address string is not sealed, so it is not hashed. */
export function txDigestV3(tx, magic = MAGIC_TESTNET) {
  const kind = String(tx?.kind || '');
  const anchor = Number(tx?.anchor ?? 0);
  const fee = Math.max(0, Math.floor(Number(tx?.fee || 0)));
  const maxLevy = tx?.maxLevy == null ? 0 : Math.max(0, Math.floor(Number(tx.maxLevy)));
  const memo = bytes32(tx?.memoH) || Buffer.alloc(32);
  const proofs = proofsOf(tx);
  const vins = (Array.isArray(tx?.vin) ? tx.vin : []).filter((v) => v && !v.coinbase);
  const parts = [
    Buffer.from('shear-admit-v3-txd'),
    Buffer.from([0x03]),
    Buffer.from(String(magic || '')),
    lenPref(Buffer.from(kind)),
    u64le(anchor),
    u64le(fee),
    u64le(maxLevy),
    memo,
  ];
  const nIn = Buffer.alloc(4);
  nIn.writeUInt32LE(vins.length >>> 0);
  parts.push(nIn);
  for (let i = 0; i < vins.length; i += 1) {
    const proof = proofs[i] || {};
    parts.push(bytes32(proof.spendTag) || Buffer.alloc(32));
    parts.push(bytes32(proof.cTilde) || bytes32(vins[i].commit) || Buffer.alloc(32));
  }
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const nOut = Buffer.alloc(4);
  nOut.writeUInt32LE(outs.length >>> 0);
  parts.push(nOut);
  for (const o of outs) {
    const outKind = String(o?.kind || kind);
    const rp = o?.rangeProof && o.rangeProof !== true ? Buffer.from(asU8(o.rangeProof)) : Buffer.alloc(0);
    const view = Buffer.from(asU8(o?.viewTag || []));
    const publicKind = outKind === 'lock' || outKind === 'vote' || outKind === 'withdraw';
    const publicNanos = publicKind
      ? Math.floor(Number(o?.valueProof?.v != null ? o.valueProof.v : (o?.nanos || 0)))
      : 0;
    parts.push(lenPref(Buffer.from(outKind)));
    parts.push(bytes32(o?.commit) || Buffer.alloc(32));
    parts.push(bytes32(o?.admitPub) || Buffer.alloc(32));
    parts.push(bytes32(o?.noteCommit) || Buffer.alloc(32));
    parts.push(bytes32(o?.rEph) || Buffer.alloc(32));
    parts.push(lenPref(Buffer.from(asU8(o?.rCt || []))));
    parts.push(lenPref(Buffer.from(asU8(o?.memoCt || []))));
    parts.push(view.length ? view.subarray(0, 1) : Buffer.alloc(1));
    parts.push(createHash('sha256').update(rp).digest());
    parts.push(u64le(publicNanos));
    // dest20 survives sealing. The address string does not, so it is not in the digest.
    const d20 = Buffer.from(asU8(o?.dest20 || []));
    parts.push(lenPref(d20.length >= 20 ? d20.subarray(0, 20) : Buffer.alloc(0)));
    // A present amtCt is bound so a relay cannot swap it. Absent leaves the digest unchanged.
    if (o?.amtCt != null && o.amtCt !== '') {
      parts.push(AMT_CT_TAG);
      parts.push(lenPref(Buffer.from(asU8(o.amtCt))));
    }
  }
  parts.push(lenPref(Buffer.from(String(tx?.portalId || '').toLowerCase())));
  parts.push(lenPref(Buffer.from(String(tx?.programId || ''))));
  parts.push(lenPref(Buffer.from(String(tx?.payoutPortalId || '').toLowerCase())));
  // Choice and the other sealed reserve fields. Sends omit this suffix.
  const reserveSuffix = reserveDigestSuffix(tx);
  if (reserveSuffix) parts.push(reserveSuffix);
  return createHash('sha256').update(Buffer.concat(parts)).digest();
}

export function admitV3Context({ magic = MAGIC_TESTNET, anchor, root, n, digest }) {
  const mag = Buffer.from(String(magic || ''));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(mag.length >>> 0);
  return createHash('sha512')
    .update(Buffer.from('shear-admit-v3'))
    .update(Buffer.from([0x03]))
    .update(len)
    .update(mag)
    .update(u64le(anchor))
    .update(bytes32(root) || Buffer.alloc(32))
    .update(u64le(n))
    .update(bytes32(digest) || Buffer.alloc(32))
    .digest();
}

export function anchorRootHash(destRoot, cRoot) {
  return createHash('sha512')
    .update(Buffer.from('shear-jroot-v2'))
    .update(bytes32(destRoot) || Buffer.alloc(32))
    .update(bytes32(cRoot) || Buffer.alloc(32))
    .digest()
    .subarray(0, 32);
}

/** Version-3 book. Same truncation as the native point root, different domain. */
export function anchorPointRootHash(destRoot, cRoot) {
  return createHash('sha512')
    .update(Buffer.from('shear-jroot-point-v3'))
    .update(bytes32(destRoot) || Buffer.alloc(32))
    .update(bytes32(cRoot) || Buffer.alloc(32))
    .digest()
    .subarray(0, 32);
}

/** Point-leaf root of a fluxset. `live.jroot` stays the v2 book. */
export function fundingJroot(live) {
  const pubs = live?.pubs || [];
  const commits = live?.commits || [];
  if (!pubs.length || pubs.length !== commits.length) return null;
  const root = jrootPoint({ pubs, commits });
  if (!root || root.length !== 32 || root.equals(Buffer.alloc(32))) return null;
  return root;
}

/** Shape only. A byte-3 bucket proof is vault_unavailable before the shape is read. */
export function typedAdmitStructure(tx) {
  const gated = v3BucketVaultRejected(tx);
  if (gated) return gated;
  if (!typedKindNeedsAdmitV3(tx)) return { ok: true, skip: true };
  if (tx?.noteSpends != null && !(Array.isArray(tx.noteSpends) && tx.noteSpends.length === 0)) {
    return { ok: false, reason: 'admit_version' };
  }
  if (tx?.payer != null && String(tx.payer) !== '') return { ok: false, reason: 'admit_version' };
  if (tx?.from != null && String(tx.from) !== '') return { ok: false, reason: 'admit_version' };
  const vins = (Array.isArray(tx?.vin) ? tx.vin : []).filter((v) => v && !v.coinbase);
  for (const vin of vins) {
    if (vin.address || vin.dest20) return { ok: false, reason: 'admit_version' };
  }
  let anchor = null;
  if (tx && Object.prototype.hasOwnProperty.call(tx, 'anchor') && tx.anchor != null) anchor = tx.anchor;
  for (const vin of (Array.isArray(tx?.vin) ? tx.vin : [])) {
    if (!vin || !Object.prototype.hasOwnProperty.call(vin, 'anchor') || vin.anchor == null) continue;
    if (anchor == null) anchor = vin.anchor;
    else if (!Object.is(anchor, vin.anchor)) return { ok: false, reason: 'admit_anchor_quantum' };
  }
  if (anchor == null) return { ok: false, reason: 'admit_anchor_window' };
  const proofs = proofsOf(tx);
  if (!proofs.length || vins.length !== proofs.length || vins.length < 1) {
    return { ok: false, reason: proofs.length ? 'admit_membership' : 'admit_version' };
  }
  for (let i = 0; i < proofs.length; i += 1) {
    const blob = proofs[i]?.blob || proofs[i]?.proof;
    const pr = blob ? Buffer.from(asU8(blob)) : null;
    if (!pr || pr.length < 33 || pr[0] !== 3) return { ok: false, reason: 'admit_version' };
    const ct = bytes32(proofs[i].cTilde);
    const posted = bytes32(vins[i].commit);
    if (!ct || !posted || !ct.equals(posted)) return { ok: false, reason: 'admit_membership' };
  }
  return { ok: true, anchor, proofs, vins };
}

/**
 * lock, vote, and withdraw are funded only by byte-3 inputs whose anchor is
 * in the window. A cleartext payer or a noteSpends list is a public debit and
 * is rejected. Stage 0 rejects every byte-3 bucket input as vault_unavailable
 * before the anchor book is read, so no vault tx is funded until FS-1.
 */
let anchorFluxRebuildCount = 0;

/** Anchor-book rebuilds from typed funding. Stage 0 does not read the book. */
export function anchorFluxRebuilds() {
  return anchorFluxRebuildCount;
}

export function resetAnchorFluxRebuilds() {
  anchorFluxRebuildCount = 0;
}

/** Calls to a membership verifier from typed funding. No path makes one in Stage 0. */
export function typedProofVerifyCount() {
  return 0;
}

export function resetTypedProofVerifies() {}

/** Calls to a membership verifier from a flow spend. No path makes one in Stage 0. */
export function flowProofVerifyCount() {
  return 0;
}

export function resetFlowProofVerifies() {}

/** True when the tx carries an Admit proof object. An empty list does not. */
export function flowPresentsProof(tx) {
  if (tx?.admit_proof) return true;
  return Array.isArray(tx?.admit_proofs) && tx.admit_proofs.some(Boolean);
}

export function verifyTypedAdmitFunding(tx) {
  const structure = typedAdmitStructure(tx);
  if (!structure.ok || structure.skip) return structure;
  return { ok: false, reason: FS1_VAULT_REASON, state: FS1_VAULT_STATE };
}

/**
 * A flow spend that presents a proof. Stage 0: a byte-3 bucket proof is
 * send_unavailable before the anchor, the inputs, or the book are read. Any
 * other byte is admit_version. No proof is accepted on this path.
 */
export function verifyFlowAdmitV3(tx, { height } = {}) {
  const gated = v3BucketSendRejected(tx);
  if (gated) return gated;
  if (!flowNeedsDummy(tx) || !flowPresentsProof(tx)) return { ok: true, skip: true };
  const anchored = checkAdmitAnchor(tx, Number(height || 0));
  if (!anchored.ok) return anchored;
  const bound = flowInputsBound(tx);
  if (!bound.ok) return bound;
  const proofs = bound.proofs || [];
  if (!proofs.length || proofs.length !== (bound.vins || []).length) {
    return { ok: false, reason: 'admit_membership' };
  }
  if (proofsOf(tx).length !== proofs.length) return { ok: false, reason: 'admit_membership' };
  for (const proof of proofs) {
    const raw = proof?.blob || proof?.proof;
    let pr = null;
    try {
      pr = raw ? Buffer.from(asU8(raw)) : null;
    } catch {
      pr = null;
    }
    if (!pr || pr[0] !== 3) return { ok: false, reason: 'admit_version' };
  }
  return { ok: false, reason: FS1_SEND_REASON, state: FS1_SEND_STATE };
}

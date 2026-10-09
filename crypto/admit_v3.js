/**
 * ADMITv3 anchor window (083e V1–V3, 083g) and typed-kind funding (OPEN-5 A).
 * H is the height of the block that includes the spend. Mempool uses tip + 1.
 * A presented anchor that fails the window is rejected. A tx with no anchor
 * is unchanged, except lock, vote, and withdraw, which require an in-window
 * ADMITv3 input. Fingerprint tokens stay off.
 */
import { createHash } from 'node:crypto';
import { SPENDABLE_CONFIRMATIONS, MAGIC_TESTNET } from './asert.js';
import { asU8 } from './note.js';
import { admitVerifyV3, fluxsetFromBlocks } from './admit.js';

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
  }
  parts.push(lenPref(Buffer.from(String(tx?.portalId || '').toLowerCase())));
  parts.push(lenPref(Buffer.from(String(tx?.programId || ''))));
  parts.push(lenPref(Buffer.from(String(tx?.payoutPortalId || '').toLowerCase())));
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

/** Shape only. The chain and mempool still verify the proof against J at A. */
export function typedAdmitStructure(tx) {
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
 * lock, vote, and withdraw are funded only by ADMITv3 inputs whose anchor is in
 * the window. The branch root at A is recomputed. A cleartext payer or a
 * noteSpends list is a public debit and is rejected.
 */
let anchorFluxRebuildCount = 0;

export function anchorFluxRebuilds() {
  return anchorFluxRebuildCount;
}

export function resetAnchorFluxRebuilds() {
  anchorFluxRebuildCount = 0;
}

export function verifyTypedAdmitFunding(tx, { height, blocks, spentTags, magic = MAGIC_TESTNET, noteAtAnchor = null } = {}) {
  const structure = typedAdmitStructure(tx);
  if (!structure.ok || structure.skip) return structure;
  const window = anchorRejectReason(structure.anchor, height);
  if (window) return { ok: false, reason: window };
  let live = null;
  if (typeof noteAtAnchor === 'function') {
    live = noteAtAnchor(structure.anchor);
    if (!live || !live.jroot) return { ok: false, reason: 'admit_anchor_root' };
  } else {
    anchorFluxRebuildCount += 1;
    const subset = (blocks || []).filter((b) => {
      const h = Number(b?.height || 0);
      return h > 0 && h <= structure.anchor;
    });
    live = fluxsetFromBlocks(subset);
  }
  const stated = Number(live?.n);
  const n = Number.isInteger(stated) && stated >= 1 ? stated : (live?.pubs || []).length;
  if (n < 1 || !live?.jroot) return { ok: false, reason: 'admit_anchor_root' };
  const digest = txDigestV3({ ...tx, anchor: structure.anchor }, magic);
  const ctx = admitV3Context({
    magic,
    anchor: structure.anchor,
    root: live.jroot,
    n,
    digest,
  });
  const tags = [];
  const seen = new Set();
  for (const proof of structure.proofs) {
    const pr = Buffer.from(asU8(proof.blob || proof.proof));
    if (pr.length < 129) return { ok: false, reason: 'admit_membership', proofChecked: true };
    const got = anchorRootHash(pr.subarray(65, 97), pr.subarray(97, 129));
    const want = Buffer.from(asU8(live.jroot));
    if (want.length !== 32 || !Buffer.from(got).equals(want)) {
      return { ok: false, reason: 'admit_anchor_root', proofChecked: true };
    }
    const tag = bytes32(proof.spendTag) || Buffer.from(pr.subarray(1, 33));
    const th = Buffer.from(tag).toString('hex');
    if (!th || seen.has(th)) return { ok: false, reason: 'admit_link_tag', proofChecked: true };
    if (spentTags && typeof spentTags.has === 'function' && spentTags.has(th)) {
      return { ok: false, reason: 'admit_link_tag', proofChecked: true };
    }
    const ok = admitVerifyV3(proof, live, {
      jroot: live.jroot,
      cTilde: proof.cTilde,
      spendTag: tag,
      ctx,
    });
    if (!ok) return { ok: false, reason: 'admit_membership', proofChecked: true };
    seen.add(th);
    tags.push(th);
  }
  return { ok: true, tags, anchor: structure.anchor };
}

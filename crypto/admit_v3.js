/**
 * ADMITv3 anchor window (083e V1–V3, 083g) and typed-kind funding (OPEN-5 A).
 * H is the height of the block that includes the spend. Mempool uses tip + 1.
 * A presented anchor that fails the window is rejected. Lock, vote, and
 * withdraw require an in-window ADMITv3 input. A flow spend (send or transfer)
 * that presents a proof is admit_version unless every blob is byte 3 and an
 * anchor is present. verifyFlowAdmitV3 then checks that proof with
 * admitVerifyV3 against the anchor point root. It does not call the v2
 * verifier. A flow spend with no proof is unchanged. v2 prove and verify stay
 * for direct callers. Fingerprint tokens stay off.
 */
import { createHash } from 'node:crypto';
import { SPENDABLE_CONFIRMATIONS, MAGIC_TESTNET } from './asert.js';
import { asU8, flowInputsBound } from './note.js';
import { flowNeedsDummy, publicReserveReceipt } from './dummy.js';
import { admitVerifyV3, fluxsetFromBlocks, jroot, jrootPoint } from './admit.js';
import { reserveDigestSuffix } from './reserve_vault.js';

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
 * Byte 3 with an anchor returns null. verifyFlowAdmitV3 then runs. This gate
 * does not verify the proof.
 */
export function v12FlowVersionRejected(tx) {
  if (!flowNeedsDummy(tx)) return null;
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
let typedProofVerifies = 0;

export function anchorFluxRebuilds() {
  return anchorFluxRebuildCount;
}

export function resetAnchorFluxRebuilds() {
  anchorFluxRebuildCount = 0;
}

/** How many times typed funding called admitVerifyV3. A cached verdict does not. */
export function typedProofVerifyCount() {
  return typedProofVerifies;
}

export function resetTypedProofVerifies() {
  typedProofVerifies = 0;
}

let flowProofVerifies = 0;

/** How many times a flow spend called admitVerifyV3. A root miss does not. */
export function flowProofVerifyCount() {
  return flowProofVerifies;
}

export function resetFlowProofVerifies() {
  flowProofVerifies = 0;
}

/** True when the tx carries an Admit proof object. An empty list does not. */
export function flowPresentsProof(tx) {
  if (tx?.admit_proof) return true;
  return Array.isArray(tx?.admit_proofs) && tx.admit_proofs.some(Boolean);
}

export function verifyTypedAdmitFunding(tx, { height, blocks, spentTags, magic = MAGIC_TESTNET, noteAtAnchor = null } = {}) {
  const structure = typedAdmitStructure(tx);
  if (!structure.ok || structure.skip) return structure;
  const window = anchorRejectReason(structure.anchor, height);
  if (window) return { ok: false, reason: window };
  let live = null;
  if (typeof noteAtAnchor === 'function') {
    live = noteAtAnchor(structure.anchor);
  } else {
    anchorFluxRebuildCount += 1;
    const subset = (blocks || []).filter((b) => {
      const h = Number(b?.height || 0);
      return h > 0 && h <= structure.anchor;
    });
    live = fluxsetFromBlocks(subset);
  }
  const stated = Number(live?.n);
  const pubs = live?.pubs || [];
  const n = Number.isInteger(stated) && stated >= 1 ? stated : pubs.length;
  const pointRoot = fundingJroot(live);
  const stored = bytes32(live?.jroot);
  const bookPubs = pubs.slice(0, n);
  const bookCommits = (Array.isArray(live?.commits) ? live.commits : []).slice(0, n);
  if (stored && bookPubs.length === n && bookCommits.length === n) {
    const v2 = jroot({ pubs: bookPubs, commits: bookCommits });
    if (!v2 || v2.length !== 32 || !Buffer.from(v2).equals(stored)) {
      return { ok: false, reason: 'admit_anchor_root' };
    }
  }
  if (n < 1 || !pointRoot || (Number.isInteger(stated) && stated >= 1 && stated !== pubs.length)) {
    return { ok: false, reason: 'admit_anchor_root' };
  }
  const digest = txDigestV3({ ...tx, anchor: structure.anchor }, magic);
  const ctx = admitV3Context({
    magic,
    anchor: structure.anchor,
    root: pointRoot,
    n,
    digest,
  });
  const tags = [];
  const seen = new Set();
  for (const proof of structure.proofs) {
    const pr = Buffer.from(asU8(proof.blob || proof.proof));
    if (pr.length < 129) return { ok: false, reason: 'admit_membership', proofChecked: true };
    const got = anchorPointRootHash(pr.subarray(65, 97), pr.subarray(97, 129));
    if (!Buffer.from(got).equals(pointRoot)) {
      return { ok: false, reason: 'admit_anchor_root', proofChecked: true };
    }
    // The tag is the proof bytes. A JSON field that disagrees is not a second tag.
    // This sits after the short-blob return so a 40-byte junk proof stays admit_membership.
    const fromBytes = Buffer.from(pr.subarray(1, 33));
    const field = bytes32(proof.spendTag);
    if (proof.spendTag != null && proof.spendTag !== '' && (!field || !field.equals(fromBytes))) {
      return { ok: false, reason: 'admit_tag', proofChecked: true };
    }
    if (tags.length === 0 && tx?.spendTag != null && tx.spendTag !== '') {
      const top = bytes32(tx.spendTag);
      if (!top || !top.equals(fromBytes)) {
        return { ok: false, reason: 'admit_tag', proofChecked: true };
      }
    }
    const tag = fromBytes;
    const th = Buffer.from(tag).toString('hex');
    if (!th || seen.has(th)) return { ok: false, reason: 'admit_link_tag', proofChecked: true };
    if (spentTags && typeof spentTags.has === 'function' && spentTags.has(th)) {
      return { ok: false, reason: 'admit_link_tag', proofChecked: true };
    }
    typedProofVerifies += 1;
    const ok = admitVerifyV3(proof, live, {
      jroot: pointRoot,
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

function anchorBook(anchor, { blocks, noteAtAnchor, fluxset }) {
  if (typeof noteAtAnchor === 'function') return noteAtAnchor(anchor);
  if (Array.isArray(blocks) && blocks.length) {
    anchorFluxRebuildCount += 1;
    const subset = blocks.filter((b) => {
      const h = Number(b?.height || 0);
      return h > 0 && h <= anchor;
    });
    return fluxsetFromBlocks(subset);
  }
  if (fluxset && !Array.isArray(fluxset)) return fluxset;
  return null;
}

/**
 * A byte-3 flow spend is a v3 membership proof. The anchor window is the same
 * rule as lock, vote, and withdraw. The blob's embedded roots must hash to the
 * point root at that anchor, and admitVerifyV3 is the only verifier. A short
 * blob is admit_membership before the book is read. A root miss does not call
 * the verifier. This does not accept a proof the verifier rejects.
 */
export function verifyFlowAdmitV3(tx, {
  height,
  blocks,
  spentTags,
  magic = MAGIC_TESTNET,
  noteAtAnchor = null,
  fluxset = null,
} = {}) {
  if (!flowNeedsDummy(tx) || !flowPresentsProof(tx)) return { ok: true, skip: true };
  const anchored = checkAdmitAnchor(tx, Number(height || 0));
  if (!anchored.ok) return anchored;
  const bound = flowInputsBound(tx);
  if (!bound.ok) return bound;
  const proofs = bound.proofs || [];
  if (!proofs.length || proofs.length !== (bound.vins || []).length) {
    return { ok: false, reason: 'admit_membership' };
  }
  const listed = proofsOf(tx);
  if (listed.length !== proofs.length) return { ok: false, reason: 'admit_membership' };
  for (const proof of proofs) {
    const raw = proof?.blob || proof?.proof;
    let pr = null;
    try {
      pr = raw ? Buffer.from(asU8(raw)) : null;
    } catch {
      pr = null;
    }
    if (!pr || pr[0] !== 3) return { ok: false, reason: 'admit_version' };
    if (pr.length < 129) return { ok: false, reason: 'admit_membership', proofChecked: true };
  }
  const live = anchorBook(anchored.anchor, { blocks, noteAtAnchor, fluxset });
  const stated = Number(live?.n);
  const pubs = live?.pubs || [];
  const n = Number.isInteger(stated) && stated >= 1 ? stated : pubs.length;
  const pointRoot = fundingJroot(live);
  const stored = bytes32(live?.jroot);
  const bookPubs = pubs.slice(0, n);
  const bookCommits = (Array.isArray(live?.commits) ? live.commits : []).slice(0, n);
  if (stored && bookPubs.length === n && bookCommits.length === n) {
    const v2 = jroot({ pubs: bookPubs, commits: bookCommits });
    if (!v2 || v2.length !== 32 || !Buffer.from(v2).equals(stored)) {
      return { ok: false, reason: 'admit_anchor_root', proofChecked: true };
    }
  }
  if (n < 1 || !pointRoot || (Number.isInteger(stated) && stated >= 1 && stated !== pubs.length)) {
    return { ok: false, reason: 'admit_anchor_root', proofChecked: true };
  }
  const digest = txDigestV3({ ...tx, anchor: anchored.anchor }, magic);
  const ctx = admitV3Context({
    magic,
    anchor: anchored.anchor,
    root: pointRoot,
    n,
    digest,
  });
  const tags = [];
  const seen = new Set();
  for (const proof of proofs) {
    const pr = Buffer.from(asU8(proof.blob || proof.proof));
    const got = anchorPointRootHash(pr.subarray(65, 97), pr.subarray(97, 129));
    if (!Buffer.from(got).equals(pointRoot)) {
      return { ok: false, reason: 'admit_anchor_root', proofChecked: true };
    }
    const fromBytes = Buffer.from(pr.subarray(1, 33));
    const field = bytes32(proof.spendTag);
    if (proof.spendTag != null && proof.spendTag !== '' && (!field || !field.equals(fromBytes))) {
      return { ok: false, reason: 'admit_tag', proofChecked: true };
    }
    if (tags.length === 0 && tx?.spendTag != null && tx.spendTag !== '') {
      const top = bytes32(tx.spendTag);
      if (!top || !top.equals(fromBytes)) return { ok: false, reason: 'admit_tag', proofChecked: true };
    }
    const th = Buffer.from(fromBytes).toString('hex');
    if (!th || seen.has(th)) return { ok: false, reason: 'admit_link_tag', proofChecked: true };
    if (spentTags && typeof spentTags.has === 'function' && spentTags.has(th)) {
      return { ok: false, reason: 'admit_link_tag', proofChecked: true };
    }
    flowProofVerifies += 1;
    const ok = admitVerifyV3(proof, live, {
      jroot: pointRoot,
      cTilde: proof.cTilde,
      spendTag: fromBytes,
      ctx,
    });
    if (!ok) return { ok: false, reason: 'admit_membership', proofChecked: true };
    seen.add(th);
    tags.push(th);
  }
  return { ok: true, tags, anchor: anchored.anchor };
}

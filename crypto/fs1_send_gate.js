/**
 * Stage 0 send gate (Russell R-3).
 *
 * Flow sends (send and transfer) that carry a byte-3 bucket proof are
 * rejected before any membership check. The prover stays in the tree until
 * Stage 7. This module does not add a proof-size cap or a hide bound to
 * consensus constants, and its reason text does not call the bucket proof ADMIT.
 *
 * Named state: sends disabled.
 */
import { flowNeedsDummy } from './dummy.js';
import { asU8 } from './note.js';

export const FS1_SEND_STATE = 'sends disabled';
export const FS1_SEND_ERROR = 'send unavailable until FS-1';
export const FS1_SEND_REASON = 'send_unavailable';

function proofBytes(proof) {
  if (!proof || typeof proof !== 'object') return null;
  const raw = proof.blob != null ? proof.blob : proof.proof;
  if (raw == null || raw === false || raw === '') return null;
  try {
    return Buffer.from(asU8(raw));
  } catch {
    return Buffer.alloc(0);
  }
}

/** True when this object is a version-3 bucket membership proof. */
export function proofIsV3Bucket(proof) {
  if (!proof || typeof proof !== 'object') return false;
  if (proof.v === 3 || proof.v === '3') return true;
  const pr = proofBytes(proof);
  return !!(pr && pr.length >= 1 && pr[0] === 3);
}

function presentedProofs(tx) {
  const out = [];
  if (tx?.admit_proof) out.push(tx.admit_proof);
  if (Array.isArray(tx?.admit_proofs)) {
    for (const proof of tx.admit_proofs) {
      if (proof) out.push(proof);
    }
  }
  return out;
}

/**
 * A flow send or transfer that presents a v3 bucket proof.
 * Null means this rule does not apply. The caller rejects before proof work.
 */
export function v3BucketSendRejected(tx) {
  if (!flowNeedsDummy(tx)) return null;
  for (const proof of presentedProofs(tx)) {
    if (proofIsV3Bucket(proof)) {
      return { ok: false, reason: FS1_SEND_REASON, state: FS1_SEND_STATE };
    }
  }
  return null;
}

/** Any block in the list. Used on load and on the snap fast path. */
export function chainV3BucketSendRejected(blocks) {
  for (const block of blocks || []) {
    for (const tx of block?.txs || []) {
      const hit = v3BucketSendRejected(tx);
      if (hit) return hit;
    }
  }
  return null;
}

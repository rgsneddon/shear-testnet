/**
 * Stage 0 send and vault gate (Russell R-3).
 *
 * Flow sends (send and transfer) and vault kinds (lock, vote, withdraw) that
 * carry a byte-3 bucket proof are rejected before any proof work. No
 * consensus path calls the bucket verifier, so its proof-size cap and its
 * circuit pad are not consensus rules. The prover stays in the tree until
 * Stage 7. The reason text does not call the bucket proof ADMIT.
 *
 * Named states: sends disabled, vaults disabled.
 */
import { flowNeedsDummy } from './dummy.js';
import { asU8 } from './note.js';

export const FS1_SEND_STATE = 'sends disabled';
export const FS1_SEND_ERROR = 'send unavailable until FS-1';
export const FS1_SEND_REASON = 'send_unavailable';
export const FS1_VAULT_STATE = 'vaults disabled';
export const FS1_VAULT_ERROR = 'vault unavailable until FS-1';
export const FS1_VAULT_REASON = 'vault_unavailable';

const VAULT_KINDS = new Set(['lock', 'vote', 'withdraw']);

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

function presentsV3Bucket(tx) {
  return presentedProofs(tx).some(proofIsV3Bucket);
}

/** Lock, vote, or withdraw by the tx kind or the first output kind. */
export function vaultKindOf(tx) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  return VAULT_KINDS.has(kind) ? kind : '';
}

/**
 * A flow send or transfer that presents a v3 bucket proof.
 * Null means this rule does not apply. The caller rejects before proof work.
 */
export function v3BucketSendRejected(tx) {
  if (!flowNeedsDummy(tx)) return null;
  if (!presentsV3Bucket(tx)) return null;
  return { ok: false, reason: FS1_SEND_REASON, state: FS1_SEND_STATE };
}

/** A lock, vote, or withdraw that presents a v3 bucket proof. */
export function v3BucketVaultRejected(tx) {
  if (!vaultKindOf(tx)) return null;
  if (!presentsV3Bucket(tx)) return null;
  return { ok: false, reason: FS1_VAULT_REASON, state: FS1_VAULT_STATE };
}

/** Either gate. Consensus entry points call this before any proof work. */
export function v3BucketProofRejected(tx) {
  return v3BucketSendRejected(tx) || v3BucketVaultRejected(tx);
}

/**
 * A v12 send or transfer with no proof object. Consensus never funds one: a
 * flow spend is only ever funded by a membership proof, and Stage 0 accepts
 * none. The mempool may still hold a painted spend; a block may not carry it.
 */
export function prooflessSendRejected(tx) {
  if (!flowNeedsDummy(tx)) return null;
  if (presentedProofs(tx).length) return null;
  return { ok: false, reason: FS1_SEND_REASON, state: FS1_SEND_STATE };
}

/** Block body rule for Stage 0. */
export function stage0TxRejected(tx) {
  return v3BucketProofRejected(tx) || prooflessSendRejected(tx);
}

/** Any tx in any block. Used on block verify, load, fork replay, and the snap fast path. */
export function chainStage0Rejected(blocks) {
  for (const block of blocks || []) {
    for (const tx of block?.txs || []) {
      const hit = stage0TxRejected(tx);
      if (hit) return hit;
    }
  }
  return null;
}

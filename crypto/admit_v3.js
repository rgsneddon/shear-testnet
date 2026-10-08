/**
 * ADMITv3 anchor window (083e V1–V3, 083g).
 * H is the height of the block that includes the spend. Mempool uses tip + 1.
 * A presented anchor that fails this rule is rejected. A tx with no anchor
 * is unchanged: v2 proofs still verify until the v3 prover is enforced.
 * Fingerprint tokens stay off until that prover and D_v3 exist.
 */
import { SPENDABLE_CONFIRMATIONS } from './asert.js';

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

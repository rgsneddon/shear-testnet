// N-1 (M76-2). From height 0, every output that joins the admit set must be
// a valid FS-1 leaf under the shear-fs1 predicate, including Hp(admitPub).
// A miss is admit_note_point. There is no activation height.
//
// KT-10. A vault withdraw of value 0 is mint_amount. A positive withdraw is
// sealed with a hash-derived non-zero r in reserve_vault.js.

import { fs1LeafFor } from './fs1_leaf.js';
import { outputJoinsAdmitSet } from './admit.js';

export const ADMIT_NOTE_POINT = 'admit_note_point';

/** Null when every joining output is an FS-1 leaf. */
export function admitNotePointRejected(tx) {
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  for (const o of outs) {
    if (!outputJoinsAdmitSet(tx, o)) continue;
    if (!fs1LeafFor(o)) return { ok: false, reason: ADMIT_NOTE_POINT };
  }
  return null;
}

/**
 * A withdraw whose opened value is not a positive integer.
 * The opened value is valueProof.v, then the output nanos, then the tx nanos.
 * AL-1 (T21 public-v) changes that public value field. This reader has to
 * change with it. Leave valueProof.v in place until that lands.
 */
export function zeroWithdrawRejected(tx) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== 'withdraw') return null;
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const rows = outs.filter((o) => String(o?.kind || kind) === 'withdraw');
  const list = rows.length ? rows : outs;
  if (!list.length) {
    return positiveNanos(tx?.nanos) ? null : { ok: false, reason: 'mint_amount' };
  }
  for (const o of list) {
    const raw = o?.valueProof?.v != null ? o.valueProof.v : (o?.nanos != null ? o.nanos : tx?.nanos);
    if (!positiveNanos(raw)) return { ok: false, reason: 'mint_amount' };
  }
  return null;
}

function positiveNanos(raw) {
  if (typeof raw === 'bigint') return raw > 0n;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    try { return BigInt(raw) > 0n; } catch { return false; }
  }
  const n = Math.floor(Number(raw));
  return Number.isInteger(n) && n > 0;
}

/** Leaf rule, then the zero-withdraw ban. */
export function txNoteRuleRejected(tx) {
  return admitNotePointRejected(tx) || zeroWithdrawRejected(tx);
}

/** Every transaction of every block. Height is not an input. */
export function chainNoteRuleRejected(blocks) {
  for (const block of blocks || []) {
    for (const tx of block?.txs || []) {
      const hit = txNoteRuleRejected(tx);
      if (hit) return hit;
    }
  }
  return null;
}

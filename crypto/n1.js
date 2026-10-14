// N-1 (M76-2). From height 0, every output that joins the admit set must be
// a valid FS-1 leaf under the shear-fs1 predicate, including Hp(admitPub).
// A miss is admit_note_point. There is no activation height.
//
// KT-10. A vault withdraw of value 0 is mint_amount. A positive withdraw is
// sealed with a hash-derived non-zero r in reserve_vault.js.

import { isDestAddress, admitBaseFromAddress, hash20FromAddress } from './address.js';
import { attachAdmitPub, outputJoinsAdmitSet } from './admit.js';
import { fs1LeafFor } from './fs1_leaf.js';
import { hashToScalar, noteCommitOfDest20, pointFrom, proveValue, scalarBytes } from './note.js';

export const ADMIT_NOTE_POINT = 'admit_note_point';

const PAYEE_LEAF_DST = 'shear-payee-leaf-v1';
const PAYEE_OK_MAX = 4096;
const payeeOkByDest = new Map();

function rememberPayeeOk(addr, ok) {
  if (payeeOkByDest.has(addr)) payeeOkByDest.delete(addr);
  payeeOkByDest.set(addr, ok);
  if (payeeOkByDest.size > PAYEE_OK_MAX) {
    const oldest = payeeOkByDest.keys().next().value;
    payeeOkByDest.delete(oldest);
  }
  return ok;
}

/**
 * A payout dest can open an FS-1 leaf. Not a consensus check.
 * A non-dest is not a payee. A short dest has no admit base; the template
 * draws a fresh point, which is a leaf, so the pool-fee sink stays allowed.
 * A long dest must decode B, then a deterministic value-proof probe (no
 * range proof) must be a leaf. The answer is cached on the dest string.
 * The leaf itself is cached on the public bytes.
 */
export function payeeFs1Ok(dest) {
  const addr = String(dest || '').trim();
  if (!isDestAddress(addr)) return true;
  const base = admitBaseFromAddress(addr);
  if (!base) return true;
  if (payeeOkByDest.has(addr)) {
    const hit = payeeOkByDest.get(addr);
    payeeOkByDest.delete(addr);
    payeeOkByDest.set(addr, hit);
    return hit;
  }
  try {
    pointFrom(base);
  } catch {
    return rememberPayeeOk(addr, false);
  }
  const d20 = hash20FromAddress(addr);
  if (!d20 || d20.length !== 20) return rememberPayeeOk(addr, false);
  try {
    const r = hashToScalar(Buffer.from(PAYEE_LEAF_DST), Buffer.from(addr, 'utf8'));
    const value = proveValue(1, r);
    const note = attachAdmitPub({
      kind: 'pot',
      noteCommit: noteCommitOfDest20(d20),
      commit: value.C,
      valueProof: { R: value.R, z: value.z, v: 1 },
      r: scalarBytes(r),
    }, { admitBase: base });
    return rememberPayeeOk(addr, !!fs1LeafFor(note));
  } catch {
    return rememberPayeeOk(addr, false);
  }
}

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

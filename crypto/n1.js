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
let payeeProbes = 0;

/** Cold payeeFs1Ok leaf probes. Cache hits and decode refusals do not count. */
export function payeeProbeCount() {
  return payeeProbes;
}

/**
 * True when payeeFs1Ok would run a cold leaf probe for this dest.
 * A non-dest, a short dest, a cached answer, and a decode miss do not.
 */
export function payeeWillProbe(dest) {
  const addr = String(dest || '').trim();
  if (!isDestAddress(addr)) return false;
  if (!admitBaseFromAddress(addr)) return false;
  if (payeeOkByDest.has(addr)) return false;
  return payeeDecodeOk(addr);
}

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
 * Decode only: about 0.1 ms on a cold long dest, no leaf derive.
 * False when B or dest20 does not decode, or when payeeFs1Ok already cached
 * a miss for this dest. True does not mean the dest is a leaf.
 * Stratum runs this before the IP ban and login budget, and payeeFs1Ok after.
 */
export function payeeDecodeOk(dest) {
  const addr = String(dest || '').trim();
  if (!isDestAddress(addr)) return true;
  const base = admitBaseFromAddress(addr);
  if (!base) return true;
  if (payeeOkByDest.get(addr) === false) return false;
  try {
    pointFrom(base);
  } catch {
    return rememberPayeeOk(addr, false);
  }
  const d20 = hash20FromAddress(addr);
  if (!d20 || d20.length !== 20) return rememberPayeeOk(addr, false);
  return true;
}

/**
 * A payout dest can open an FS-1 leaf. Not a consensus check.
 * A non-dest is not a payee. A short dest has no admit base; the template
 * draws a fresh point, which is a leaf, so the pool-fee sink stays allowed.
 * A long dest must decode B, then a deterministic value-proof probe (no
 * range proof) must be a leaf. A cold probe is about 12 ms. The answer is
 * cached on the dest string. The leaf itself is cached on the public bytes.
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
  if (!payeeDecodeOk(addr)) return false;
  const d20 = hash20FromAddress(addr);
  payeeProbes += 1;
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
function withdrawKindRejected(tx) {
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

/**
 * index is the tx's place in the block. Only a body tx (index > 0) flagged
 * coinbase skips this rule, so verify can refuse it as coinbase. txs[0] keeps
 * the rule, including a withdraw-kind row on the real coinbase.
 */
export function zeroWithdrawRejected(tx, index = 0) {
  if (Number(index) > 0 && tx?.coinbase) return null;
  const named = withdrawKindRejected(tx);
  if (named) return named;
  if (Number(index) > 0) return null;
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  for (const o of outs) {
    if (String(o?.kind || '') !== 'withdraw') continue;
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

/** Leaf rule, then the zero-withdraw ban. index is the tx slot in the block. */
export function txNoteRuleRejected(tx, index = 0) {
  return admitNotePointRejected(tx) || zeroWithdrawRejected(tx, index);
}

/** Every transaction of every block. Height is not an input. txs[0] is the coinbase slot. */
export function chainNoteRuleRejected(blocks) {
  for (const block of blocks || []) {
    const txs = block?.txs || [];
    for (let i = 0; i < txs.length; i += 1) {
      const hit = txNoteRuleRejected(txs[i], i);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Genesis block budget (inbox 128, Russell 2026-10-09 09:59 BST).
 * Counts and byte sizes come from the public tx. No proof is opened here.
 * levy.js blockWeight is the fee retarget weight and is a different number.
 */
import { performance } from 'node:perf_hooks';
import { txIsCoinbase } from './note.js';
import { txIsReserveAction } from './reserve_vault.js';

export const W_IN = 40;
export const W_OUT = 23;
export const W_TX = 2;
export const W_ROW_0X23 = 1;
export const W_PAYEE = 35;
export const W_SEAL = 19;
export const MAX_BLOCK_VERIFY_WEIGHT = 36_000;
export const R_SENDS = 16;
export const R_BYTES = 854_592;
export const R_WEIGHT = 2_416;
export const K_VW = 8;
export const R_VW_BYTES = 181_864;
export const R_VW_WEIGHT = 528;
export const C_MAX = 8_388_608;
export const B_MAX = 9_425_064;
export const MAX_BLOCK_RESERVE_TXS = 32;
export const TEMPLATE_BUDGET_MS = 1_000;
/** Notes beside the payee rows in the V-W3 check (D_cap + 3). */
export const COINBASE_EXTRA_NOTES = 3;
/**
 * [EST] bytes of one payout row. Band 17,253–17,528. Re-measure before mainnet.
 * The row shape is not changed here.
 */
export const PAYEE_ROW_BYTES = 17_400;
/** Hex JSON expansion used while the wire is still hex. */
export const FRAME_HEX_EXPANSION = 2;
/**
 * Envelope outside the payee rows, R, and the 0x23 reserve.
 * floor((8,388,608 / 2 − 854,592 − 181,864 − 120,000) / 17,400) − 3 = 171.
 */
export const FALLBACK_ENVELOPE_BYTES = 120_000;
/** Today's 8 MiB hex IPC frame. Not raised in this change. */
export const FALLBACK_IPC_FRAME = 8 * 1024 * 1024;
/** Hex frame floor from r_max 2.097. Today's frames are still below this. */
export const FRAME_MIN = 19_764_360;
export const VW_KIND = 'vault-withdraw-pinned';
export const VW_KIND_CODE = 0x23;

const PAYEE_KINDS = new Set(['pot', 'hash']);

function assertTable() {
  if (R_SENDS * (2 * W_IN + 3 * W_OUT + W_TX) !== R_WEIGHT) {
    throw new Error('block_budget R_WEIGHT');
  }
  if (K_VW * (W_IN + W_OUT + W_ROW_0X23 + W_TX) !== R_VW_WEIGHT) {
    throw new Error('block_budget R_VW_WEIGHT');
  }
  if (C_MAX + R_BYTES + R_VW_BYTES !== B_MAX) {
    throw new Error('block_budget B_MAX');
  }
  const coinbaseRoom = MAX_BLOCK_VERIFY_WEIGHT - R_WEIGHT - R_VW_WEIGHT;
  if (coinbaseRoom !== 33_056) throw new Error('block_budget V-W3');
  for (const cap of [payeeCapNormal(), payeeCapFallback()]) {
    if (W_PAYEE * (cap + COINBASE_EXTRA_NOTES) + R_WEIGHT + R_VW_WEIGHT > MAX_BLOCK_VERIFY_WEIGHT) {
      throw new Error('block_budget payee weight');
    }
  }
}

export function payeeCapNormal(rowBytes = PAYEE_ROW_BYTES) {
  const row = Math.max(1, Math.floor(Number(rowBytes) || 0));
  return Math.floor(C_MAX / row);
}

export function payeeCapFallback({
  frame = FALLBACK_IPC_FRAME,
  expansion = FRAME_HEX_EXPANSION,
  rowBytes = PAYEE_ROW_BYTES,
  envelope = FALLBACK_ENVELOPE_BYTES,
  reserveBytes = R_BYTES,
  vwBytes = R_VW_BYTES,
} = {}) {
  const span = Math.max(1, Math.floor(Number(expansion) || 1));
  const row = Math.max(1, Math.floor(Number(rowBytes) || 1));
  const room = Math.floor(Number(frame) / span)
    - Math.floor(Number(reserveBytes) || 0)
    - Math.floor(Number(vwBytes) || 0)
    - Math.floor(Number(envelope) || 0);
  if (room < 0) return 0;
  return Math.floor(room / row) - COINBASE_EXTRA_NOTES;
}

/** While the relay frame is below FRAME_MIN, the fallback cap is the one a block can travel. */
export function payeeCapLive(frame = FALLBACK_IPC_FRAME) {
  const normal = payeeCapNormal();
  if (Math.floor(Number(frame) || 0) >= FRAME_MIN) return normal;
  return Math.min(normal, payeeCapFallback({ frame }));
}

export function isVwOutput(out) {
  if (!out || typeof out !== 'object') return false;
  if (String(out.kind || '') === VW_KIND) return true;
  const code = Number(out.kindCode);
  return code === VW_KIND_CODE;
}

export function isPayeeOutput(out) {
  return PAYEE_KINDS.has(String(out?.kind || ''));
}

export function countPayees(tx) {
  if (!txIsCoinbase(tx)) return 0;
  let n = 0;
  const outs = Array.isArray(tx.vout) ? tx.vout : [];
  for (let i = 0; i < outs.length; i += 1) {
    if (isPayeeOutput(outs[i])) n += 1;
  }
  return n;
}

export function countVw(tx) {
  if (!txIsCoinbase(tx)) return 0;
  let n = 0;
  const outs = Array.isArray(tx.vout) ? tx.vout : [];
  for (let i = 0; i < outs.length; i += 1) {
    if (isVwOutput(outs[i])) n += 1;
  }
  return n;
}

export function txVerifyWeight(tx) {
  if (!tx || typeof tx !== 'object') return 0;
  if (txIsCoinbase(tx)) {
    let w = 0;
    const outs = Array.isArray(tx.vout) ? tx.vout : [];
    for (let i = 0; i < outs.length; i += 1) {
      w += isVwOutput(outs[i]) ? W_ROW_0X23 : W_PAYEE;
    }
    return w;
  }
  const nIn = Array.isArray(tx.vin) ? tx.vin.length : 0;
  const nOut = Array.isArray(tx.vout) ? tx.vout.length : 0;
  let w = W_TX + W_IN * nIn + W_OUT * nOut;
  if (txIsReserveAction(tx)) w += W_SEAL;
  return w;
}

/** Raw public payload. Proof bytes count as length only. */
export function publicBytes(value) {
  const seen = new Set();
  const stack = [value];
  let n = 0;
  while (stack.length) {
    const cur = stack.pop();
    if (cur == null) continue;
    const t = typeof cur;
    if (t === 'string') {
      n += Buffer.byteLength(cur);
      continue;
    }
    if (t === 'number' || t === 'boolean' || t === 'bigint') continue;
    if (Buffer.isBuffer(cur)) {
      n += cur.length;
      continue;
    }
    if (t !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i += 1) stack.push(cur[i]);
      continue;
    }
    const keys = Object.keys(cur);
    for (let i = 0; i < keys.length; i += 1) stack.push(cur[keys[i]]);
  }
  return n;
}

export function blockVerifyWeight(txs) {
  const list = Array.isArray(txs) ? txs : [];
  let w = 0;
  for (let i = 0; i < list.length; i += 1) w += txVerifyWeight(list[i]);
  return w;
}

export function blockSectionBytes(txs) {
  const list = Array.isArray(txs) ? txs : [];
  let block = 0;
  let coinbase = 0;
  for (let i = 0; i < list.length; i += 1) {
    const tx = list[i];
    const n = publicBytes(tx);
    block += n;
    if (txIsCoinbase(tx)) coinbase += n;
  }
  return { block, coinbase };
}

function reject(reason) {
  return { ok: false, reason, proofChecked: false };
}

export function txBudget(tx) {
  if (!tx || typeof tx !== 'object') return { ok: true };
  if (txIsCoinbase(tx)) {
    if (countPayees(tx) > payeeCapLive()) return reject('payee_cap');
    if (countVw(tx) > K_VW) return reject('k_vw');
    if (publicBytes(tx) > C_MAX) return reject('coinbase_bytes');
  }
  if (publicBytes(tx) > B_MAX) return reject('block_bytes');
  if (txVerifyWeight(tx) > MAX_BLOCK_VERIFY_WEIGHT) return reject('block_weight');
  return { ok: true };
}

export function blockBudget(txs) {
  const list = Array.isArray(txs) ? txs : [];
  let reserve = 0;
  let vw = 0;
  let payees = 0;
  let weight = 0;
  let block = 0;
  let coinbase = 0;
  for (let i = 0; i < list.length; i += 1) {
    const tx = list[i];
    weight += txVerifyWeight(tx);
    const n = publicBytes(tx);
    block += n;
    if (txIsCoinbase(tx)) {
      coinbase += n;
      payees += countPayees(tx);
      vw += countVw(tx);
    } else if (txIsReserveAction(tx)) {
      reserve += 1;
    }
  }
  if (vw > K_VW) return reject('k_vw');
  if (reserve > MAX_BLOCK_RESERVE_TXS) return reject('reserve_txs');
  if (payees > payeeCapLive()) return reject('payee_cap');
  if (coinbase > C_MAX) return reject('coinbase_bytes');
  if (block > B_MAX) return reject('block_bytes');
  if (weight > MAX_BLOCK_VERIFY_WEIGHT) return reject('block_weight');
  return { ok: true, weight, block, coinbase, reserve, payees, vw };
}

/**
 * Body txs that fit this block, highest fee rate first.
 * Reserve rows stop at the count cap and at the wall clock.
 * Callers keep every tx this leaves out.
 */
export function selectBodyIndexes(txs, {
  nowMs = () => performance.now(),
  coinbaseWeight = W_PAYEE * COINBASE_EXTRA_NOTES,
  coinbaseBytes = 0,
} = {}) {
  const list = Array.isArray(txs) ? txs : [];
  const started = nowMs();
  const rows = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const tx = list[i];
    const w = txVerifyWeight(tx);
    const fee = Math.max(0, Math.floor(Number(tx?.fee) || 0));
    rows[i] = {
      i,
      w,
      bytes: publicBytes(tx),
      fee,
      reserve: txIsReserveAction(tx),
    };
  }
  const order = rows.slice().sort((a, b) => {
    const left = a.fee * Math.max(1, b.w);
    const right = b.fee * Math.max(1, a.w);
    // Higher fee per weight first. `left` is larger when `a` pays more.
    if (left !== right) return right - left;
    return a.i - b.i;
  });
  const chosen = [];
  let accW = Math.max(0, Math.floor(Number(coinbaseWeight) || 0));
  let accB = Math.max(0, Math.floor(Number(coinbaseBytes) || 0));
  let accR = 0;
  for (let n = 0; n < order.length; n += 1) {
    const row = order[n];
    if (row.reserve) {
      if (accR >= MAX_BLOCK_RESERVE_TXS) continue;
      if (nowMs() - started >= TEMPLATE_BUDGET_MS) continue;
    }
    if (accW + row.w > MAX_BLOCK_VERIFY_WEIGHT) continue;
    if (accB + row.bytes > B_MAX) continue;
    chosen.push(row.i);
    accW += row.w;
    accB += row.bytes;
    if (row.reserve) accR += 1;
  }
  return chosen;
}

assertTable();

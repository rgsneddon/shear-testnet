/**
 * Lag-1 Flow levy. Header u64 base_fee ASERT from parent weight vs target.
 * levy = base × (vouts + memo_chunks + B-flag).
 * Coinbase and A-leaves: 0. Split half finder, half The Reserve fee bank.
 */
import { createHash } from 'node:crypto';
import { encodeDest } from './address.js';

export const FEE_TAU_MS = 90_000;
export const FEE_TARGET_WEIGHT = 8;
export const FEE_SPLIT_FINDER_BPS = 5000;
export const FEE_SPLIT_RESERVE_BPS = 5000;

export function txWeight({ vouts = 0, memoChunks = 0, bFlag = 0 } = {}) {
  return Math.max(0, Math.floor(Number(vouts) || 0))
    + Math.max(0, Math.floor(Number(memoChunks) || 0))
    + (bFlag ? 1 : 0);
}

export function levyNanos(baseFee, weight) {
  const base = Math.max(0, Math.floor(Number(baseFee) || 0));
  const w = Math.max(0, Math.floor(Number(weight) || 0));
  return base * w;
}

export function splitLevy(levy) {
  const n = Math.max(0, Math.floor(Number(levy) || 0));
  const finder = Math.floor(n * FEE_SPLIT_FINDER_BPS / 10000);
  return { finder, reserve: n - finder };
}

/** Fee ASERT: heavier parent weight raises next base. Not env. */
export function nextBaseFee(parentBase, parentWeight, target = FEE_TARGET_WEIGHT) {
  const prev = Math.max(1, Math.floor(Number(parentBase) || 1));
  let seen = Number(parentWeight);
  if (!Number.isFinite(seen) || seen < 1) seen = 1;
  const t = Math.max(1, Math.floor(Number(target) || FEE_TARGET_WEIGHT));
  const ratio = seen / t;
  const delta = Math.round(Math.log2(Math.max(1 / 4, Math.min(4, ratio))));
  return Math.max(1, prev * (2 ** delta));
}

export function reserveFeeDest() {
  return encodeDest(createHash('sha256').update('shear-reserve-v1-fee').digest().subarray(0, 20));
}

export function blockWeight(txs = [], bLeaves = []) {
  let w = 0;
  for (const tx of txs) {
    if (tx?.coinbase) continue;
    const vouts = Array.isArray(tx.vout) ? tx.vout.length : 1;
    const memo = tx.memoCt || tx.memoH ? 1 : 0;
    const bFlag = tx.bSpend || tx.bFlag ? 1 : 0;
    w += txWeight({ vouts, memoChunks: memo, bFlag });
  }
  w += (Array.isArray(bLeaves) && bLeaves.length) ? 1 : 0;
  return w;
}

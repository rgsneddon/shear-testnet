/**
 * T21 pay law, arbitrary precision.
 * W·v = (R + W·u)·W_i − ρ + W·fin, with 0 ≤ ρ < W.
 * ρ is the canonical remainder. There is no last-payee bump.
 */
import { SCALAR_MAX, W_MAX } from './t21_params.js';

export function t21Big(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) return null;
    return BigInt(v);
  }
  if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) {
    try { return BigInt(v); } catch { return null; }
  }
  return null;
}

/** Public scalars in the law are below 2^64. W is below 2^48. */
export function scalarOk(v) {
  const n = t21Big(v);
  if (n == null || n < 0n || n >= SCALAR_MAX) return null;
  return n;
}

/**
 * One row. Returns { v, rho } or null when the inputs are not a legal row.
 * The reference is integer division. Callers that need a second implementation
 * should divide the same numerator again, not call this function.
 */
export function splitLaw({ R, W, Wi, u = 0n, fin = 0n } = {}) {
  const Rb = t21Big(R);
  const Wb = t21Big(W);
  const Wib = t21Big(Wi);
  const ub = t21Big(u);
  const finb = t21Big(fin);
  if (Rb == null || Wb == null || Wib == null || ub == null || finb == null) return null;
  if (Wb <= 0n || Wb >= W_MAX) return null;
  if (Wib < 0n || Wib > Wb) return null;
  if (Rb < 0n || ub < 0n || finb < 0n) return null;
  if (Rb >= SCALAR_MAX || ub >= SCALAR_MAX || finb >= SCALAR_MAX) return null;
  const num = (Rb + Wb * ub) * Wib + Wb * finb;
  if (num < 0n) return null;
  return { v: num / Wb, rho: num % Wb };
}

/** Sum of per-row remainders, divided by W. Null when the sum is not a multiple of W. */
export function lawDust(rhos, W) {
  const Wb = t21Big(W);
  if (Wb == null || Wb <= 0n) return null;
  let sum = 0n;
  for (const rho of rhos) {
    const r = t21Big(rho);
    if (r == null || r < 0n || r >= Wb) return null;
    sum += r;
  }
  if (sum % Wb !== 0n) return null;
  return sum / Wb;
}

/** Fee is floor(S · b / 10^4) for an integer b in 0..200. */
export function feeOf(S, bps) {
  const s = t21Big(S);
  const b = t21Big(bps);
  if (s == null || b == null || s < 0n || b < 0n || b > 200n) return null;
  return (s * b) / 10000n;
}

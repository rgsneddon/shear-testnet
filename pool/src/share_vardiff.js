/**
 * Per-TCP-session share vardiff. Not consensus.
 * Header bits stay on ASERT 90 s. Share target only throttles submit rate
 * and must never exceed current block bits.
 *
 * Default max is SHA-256 width so a huge CPU farm is throttled instead
 * of flooding. GPU/ASIC still mint nothing.
 */
import { MAX_BITS } from '../../crypto/asert.js';

export const SHARE_VARDIFF_TARGET_MS = 7500;
export const SHARE_VARDIFF_RETARGET_SHARES = 8;
export const SHARE_VARDIFF_RETARGET_MS = 20_000;

export function hashesProvenByShare(shareBits) {
  const b = Math.floor(Number(shareBits) || 0);
  if (b <= 0) return 1;
  const n = Math.min(b, MAX_BITS);
  if (n >= 53) return Number.MAX_SAFE_INTEGER;
  return 2 ** n;
}

/** 1-thread H/s implied by share bits at the vardiff target interval. */
export function expectedOneThreadHs(shareBits, targetMs = SHARE_VARDIFF_TARGET_MS) {
  const hashes = hashesProvenByShare(shareBits);
  const sec = Math.max(0.25, (Number(targetMs) || SHARE_VARDIFF_TARGET_MS) / 1000);
  return hashes / sec;
}

export function clampShareBits(bits, { blockBits, minBits = 1, maxBits = MAX_BITS } = {}) {
  let n = Math.round(Number(bits));
  if (!Number.isFinite(n)) n = Math.max(1, minBits);
  n = Math.max(minBits, Math.min(maxBits, n));
  const cap = Math.floor(Number(blockBits));
  if (Number.isFinite(cap) && cap >= 1) n = Math.min(n, cap);
  return n;
}

/** Faster shares than targetMs → higher share bits (harder). */
export function nextShareBits({
  current,
  actualIntervalMs,
  targetMs = SHARE_VARDIFF_TARGET_MS,
  blockBits,
  minBits = 1,
} = {}) {
  const cur = clampShareBits(current, { blockBits, minBits });
  const target = Math.max(1, Number(targetMs) || SHARE_VARDIFF_TARGET_MS);
  const actual = Math.max(250, Number(actualIntervalMs) || target);
  const ratio = target / actual;
  const delta = Math.round(Math.log2(Math.max(1 / 16, Math.min(16, ratio))));
  return clampShareBits(cur + delta, { blockBits, minBits });
}

export function shouldRetargetShare({ shares, elapsedMs } = {}) {
  const n = Math.max(0, Number(shares) || 0);
  const ms = Math.max(0, Number(elapsedMs) || 0);
  return n >= SHARE_VARDIFF_RETARGET_SHARES || ms >= SHARE_VARDIFF_RETARGET_MS;
}

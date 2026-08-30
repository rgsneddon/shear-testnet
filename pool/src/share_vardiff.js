/**
 * Per-TCP-session share vardiff. Not consensus.
 * Header bits stay on ASERT 90 s. Share target only throttles submit rate
 * and must never exceed current block bits.
 *
 * Target ~2s/share under ShearHash-v2. RandomX-lite verify is on the Node
 * event loop; a 250ms SHA-256 farm target dropped shareBits to 5 and 504'd
 * /api/stats. Share bits may equal the header so a farm is throttled; they
 * still never exceed it. GPU/ASIC still mint nothing.
 */
import { MAX_BITS } from '../../crypto/asert.js';

export const SHARE_VARDIFF_TARGET_MS = 2000;
export const SHARE_VARDIFF_RETARGET_SHARES = 8;
export const SHARE_VARDIFF_RETARGET_MS = 20_000;
/** 0: share bits may equal header bits so a farm can be throttled. */
export const SHARE_BELOW_BLOCK = 0;
/**
 * Opening share target for ShearHash-v2 RandomX-lite (~50 H/s/thread).
 * Bits 18 is SHA-256 farm scale (~hours/share at 50 H/s). Header bits stay ASERT.
 */
export const SHARE_BITS_V2_START = 8;

export function hashesProvenByShare(shareBits) {
  const b = Math.floor(Number(shareBits) || 0);
  if (b <= 0) return 1;
  const n = Math.min(b, MAX_BITS);
  if (n >= 53) return Number.MAX_SAFE_INTEGER;
  return 2 ** n;
}

/** Work credited for one accepted share. Never bitsMet / client padded hashes. */
export function hashesCreditedForShare(job) {
  return hashesProvenByShare(Number(job?.shareBits) || 0);
}

/** 1-thread H/s implied by share bits at the vardiff target interval. */
export function expectedOneThreadHs(shareBits, targetMs = SHARE_VARDIFF_TARGET_MS) {
  const hashes = hashesProvenByShare(shareBits);
  const sec = Math.max(0.001, (Number(targetMs) || SHARE_VARDIFF_TARGET_MS) / 1000);
  return hashes / sec;
}

export function clampShareBits(bits, { blockBits, minBits = 1, maxBits = MAX_BITS } = {}) {
  let n = Math.round(Number(bits));
  if (!Number.isFinite(n)) n = Math.max(1, minBits);
  n = Math.max(minBits, Math.min(maxBits, n));
  const cap = Math.floor(Number(blockBits));
  if (Number.isFinite(cap) && cap >= 1) {
    const easy = Math.max(minBits, cap - SHARE_BELOW_BLOCK);
    n = Math.min(n, easy);
  }
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
  const actual = Math.max(1, Number(actualIntervalMs) || target);
  const ratio = target / actual;
  let delta = Math.round(Math.log2(Math.max(1 / 16, Math.min(16, ratio))));
  if (delta > 1) delta = 1;
  if (delta < -1) delta = -1;
  return clampShareBits(cur + delta, { blockBits, minBits });
}

export function shouldRetargetShare({ shares, elapsedMs } = {}) {
  const n = Math.max(0, Number(shares) || 0);
  const ms = Math.max(0, Number(elapsedMs) || 0);
  return n >= SHARE_VARDIFF_RETARGET_SHARES || ms >= SHARE_VARDIFF_RETARGET_MS;
}

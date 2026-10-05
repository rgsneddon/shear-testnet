/**
 * Per-dest share vardiff. Not consensus.
 * Header bits stay on ASERT. This dial reads accepted-share spacing only.
 * Pool-found tip gaps are a soak observation and are not an input.
 *
 * Target ~2s/share under ShearHash-v3. A step waits for eight shares and
 * 20s, then moves ±1 only when the sample interval is outside 1.4–2.8s.
 * A 4-share / 8s window flipped the dial about twice a minute. RandomX-lite
 * verify is on the Node event loop; a 250ms SHA-256 farm target dropped
 * shareBits to 5 and 504'd /api/stats. Share bits may equal the header so a
 * farm is throttled; they still never exceed it. GPU/ASIC still mint nothing.
 */
import { MAX_BITS, SHARE_FLOOR_BITS } from '../../crypto/asert.js';

export const SHARE_VARDIFF_TARGET_MS = 2000;
/** Both gates. Eight fast shares are not a window by themselves. */
export const SHARE_VARDIFF_RETARGET_SHARES = 8;
/** Do not tighten. The 8s gate thrashed ±1 on mixed workers of one dest. */
export const SHARE_VARDIFF_RETARGET_MS = 20_000;
/** One bit per full window. A farm still climbs; it does not jump. */
export const SHARE_VARDIFF_CLIMB_MAX = 1;
/** Ease per window stays 1 so a 1-thread reconnect is not dumped to the floor. */
export const SHARE_VARDIFF_EASE_MAX = 1;
/**
 * Hold while the sample sits near 2s/share. A step is only for an interval
 * outside this band. Inclusive on both edges.
 */
export const SHARE_VARDIFF_DEADBAND_LOW_MS = 1_400;
export const SHARE_VARDIFF_DEADBAND_HIGH_MS = 2_800;
/** 0: share bits may equal header bits so a farm can be throttled. */
export const SHARE_BELOW_BLOCK = 0;
/**
 * Opening share target for ShearHash-v3 RandomX-lite (~50 H/s/thread).
 * Bits 18 is SHA-256 farm scale (~hours/share at 50 H/s). Header bits stay ASERT.
 */
export const SHARE_BITS_V2_START = 8;

/** Consensus mint floor. Vardiff must not sit below this or accepted HUD shares mint 0. */
export function mintShareMinBits() {
  return Math.max(SHARE_FLOOR_BITS, SHARE_BITS_V2_START);
}

export function hashesProvenByShare(shareBits) {
  const b = Math.floor(Number(shareBits) || 0);
  if (b <= 0) return 1;
  const n = Math.min(b, MAX_BITS);
  if (n >= 53) return Number.MAX_SAFE_INTEGER;
  return 2 ** n;
}

/** Work credited for one accepted share. 2^creditedShareBits, clamped ≥ floor. */
export function hashesCreditedForShare(job) {
  const bits = Math.max(
    SHARE_FLOOR_BITS,
    Number(job?.creditedShareBits ?? job?.shareBits) || 0,
  );
  return hashesProvenByShare(bits);
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
  const rawCap = Number(blockBits);
  const cap = rawCap > 256 ? Math.floor(rawCap / 65536) : Math.floor(rawCap);
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
  if (actual >= SHARE_VARDIFF_DEADBAND_LOW_MS && actual <= SHARE_VARDIFF_DEADBAND_HIGH_MS) {
    return cur;
  }
  const ratio = target / actual;
  let delta = Math.round(Math.log2(Math.max(1 / 16, Math.min(16, ratio))));
  if (delta > SHARE_VARDIFF_CLIMB_MAX) delta = SHARE_VARDIFF_CLIMB_MAX;
  if (delta < -SHARE_VARDIFF_EASE_MAX) delta = -SHARE_VARDIFF_EASE_MAX;
  return clampShareBits(cur + delta, { blockBits, minBits });
}

/**
 * Bits that survive a new template. A find builds the shared job at the
 * opening floor. That placeholder must not replace a dest that has stepped.
 * Saved dest bits win, then the live connection, then the template.
 */
export function carriedShareBits({ saved, conn, template } = {}, { blockBits, minBits = 1 } = {}) {
  const pick = [saved, conn, template]
    .map((v) => Number(v))
    .find((n) => Number.isFinite(n) && n > 0);
  return clampShareBits(pick == null ? minBits : pick, { blockBits, minBits });
}

/**
 * Public shareBits box. Lowest carried dial among connected dests.
 * The shared template is not a candidate: a find stamps it at the floor.
 * A row with no saved bits and no connection bits does not vote.
 * With nobody to show, use the caller's fallback (last job, else the floor).
 */
export function liveShareBits(rows, { blockBits, minBits = 1, fallback } = {}) {
  const dials = [];
  for (const row of rows || []) {
    if (!row || row.fee || row.connected === false) continue;
    const savedN = Number(row.saved);
    const connN = Number(row.conn);
    const saved = Number.isFinite(savedN) && savedN > 0 ? savedN : null;
    const conn = Number.isFinite(connN) && connN > 0 ? connN : null;
    if (saved == null && conn == null) continue;
    dials.push(carriedShareBits({ saved, conn, template: null }, { blockBits, minBits }));
  }
  if (dials.length) return Math.min(...dials);
  const fb = Number(fallback);
  return clampShareBits(Number.isFinite(fb) && fb > 0 ? fb : minBits, { blockBits, minBits });
}

export function shouldRetargetShare({ shares, elapsedMs } = {}) {
  const n = Math.max(0, Number(shares) || 0);
  const ms = Math.max(0, Number(elapsedMs) || 0);
  // The slower gate binds. Eight fast shares are not a window, and one
  // slow share after a long pause is not a sample.
  return n >= SHARE_VARDIFF_RETARGET_SHARES && ms >= SHARE_VARDIFF_RETARGET_MS;
}

/**
 * Fold one accepted share into a dest window. Callers pass every worker of
 * that dest through the same state. A soft worker does not keep its own bit.
 * `stepped` is set only when the bit actually moves.
 */
export function destVardiffOnShare({
  state,
  now,
  blockBits,
  minBits = 1,
  targetMs = SHARE_VARDIFF_TARGET_MS,
} = {}) {
  const curBits = Number(state?.bits);
  const bits = Number.isFinite(curBits) ? curBits : minBits;
  const windowAt = Number(state?.windowAt) > 0 ? Number(state.windowAt) : Number(now);
  const shares = Math.max(0, Number(state?.shares) || 0) + 1;
  const elapsed = Math.max(0, Number(now) - windowAt);
  const lastStepAt = Number(state?.lastStepAt) || 0;
  if (!shouldRetargetShare({ shares, elapsedMs: elapsed })) {
    return {
      shares,
      windowAt,
      bits,
      lastStepAt,
      stepped: false,
    };
  }
  const intervalMs = elapsed / shares;
  const next = nextShareBits({
    current: bits,
    actualIntervalMs: intervalMs,
    targetMs,
    blockBits,
    minBits,
  });
  const reason = next > bits
    ? 'rate_above_target'
    : (next < bits ? 'rate_below_target' : 'in_band');
  return {
    shares: 0,
    windowAt: Number(now),
    bits: next,
    lastStepAt: next !== bits ? Number(now) : lastStepAt,
    stepped: next !== bits,
    from: bits,
    reason,
    sampleShares: shares,
    elapsedMs: elapsed,
    intervalMs,
  };
}

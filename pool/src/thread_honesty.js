/** Honest thread counts on the folded worker row. Not last-write. */

export const THREAD_HONEST = 'honest';
export const THREAD_INFLATE = 'inflate';
export const THREAD_UNDERREPORT = 'underreport';
export const THREAD_UNKNOWN = 'unknown';
export const MIN_ACCEPTS_TO_JUDGE = 3;
export const THREAD_LIE_FACTOR = 3;
export const THREAD_LIE_DELTA = 4;

export function inferThreadCount({ hashrate, oneThreadHs } = {}) {
  const hs = Math.max(0, Number(hashrate) || 0);
  const one = Number(oneThreadHs);
  if (hs <= 0 || !Number.isFinite(one) || one <= 0) return 0;
  return Math.max(1, Math.round(hs / one));
}

function result({ honest, verdict, claimed, inferred, cpuCores, reason }) {
  return { honest, verdict, claimed, inferred, cpuCores, reason };
}

/**
 * Compare folded claimed threads to summed device inventory and proven H/s.
 * Several instances on one worker are allowed: honesty sees the **sum**.
 */
export function assessThreadHonesty({
  claimed,
  cpuCores,
  cpuThreads,
  hashrate,
  accepts,
  oneThreadHs,
  oneThreadMinHs,
} = {}) {
  const claim = Math.max(0, Math.floor(Number(claimed) || 0));
  const cores = Math.max(0, Math.floor(Number(cpuCores) || 0));
  const logical = Math.max(0, Math.floor(Number(cpuThreads) || 0));
  const deviceCap = logical > 0 ? logical : cores;
  const hits = Math.max(0, Math.floor(Number(accepts) || 0));
  const slow = Number(oneThreadMinHs ?? oneThreadHs);
  const inferred = inferThreadCount({ hashrate, oneThreadHs: slow });

  if (claim <= 0) {
    return result({
      honest: false,
      verdict: THREAD_UNDERREPORT,
      claimed: claim,
      inferred,
      cpuCores: cores,
      reason: 'threads_hidden',
    });
  }

  if (hits >= MIN_ACCEPTS_TO_JUDGE && inferred > 0
      && claim >= inferred * THREAD_LIE_FACTOR && claim - inferred >= THREAD_LIE_DELTA) {
    return result({
      honest: false,
      verdict: THREAD_INFLATE,
      claimed: claim,
      inferred,
      cpuCores: cores,
      reason: 'claimed_threads_above_work',
    });
  }

  if (deviceCap > 0 && claim > deviceCap && claim - deviceCap >= THREAD_LIE_DELTA) {
    return result({
      honest: false,
      verdict: THREAD_INFLATE,
      claimed: claim,
      inferred: inferred || deviceCap,
      cpuCores: cores,
      reason: 'claimed_threads_above_cores',
    });
  }

  if (hits < MIN_ACCEPTS_TO_JUDGE || inferred <= 0) {
    return result({
      honest: true,
      verdict: THREAD_UNKNOWN,
      claimed: claim,
      inferred,
      cpuCores: cores,
      reason: 'not_enough_accepts',
    });
  }

  return result({
    honest: true,
    verdict: THREAD_HONEST,
    claimed: claim,
    inferred,
    cpuCores: cores,
    reason: 'matches_accepted_work',
  });
}

export function oneThreadRateBand(rows = [], fallback = 0) {
  const samples = [];
  for (const row of rows || []) {
    const t = Math.max(0, Math.floor(Number(row?.threads ?? row?.cpuThreads ?? row?.claimed) || 0));
    const hs = Number(row?.hashrate) || 0;
    if (t === 1 && hs > 0) samples.push(hs);
  }
  if (!samples.length) {
    const fb = Math.max(0, Number(fallback) || 0);
    return { min: fb, median: fb, max: fb };
  }
  samples.sort((a, b) => a - b);
  return {
    min: samples[0],
    median: samples[Math.floor(samples.length / 2)],
    max: samples[samples.length - 1],
  };
}

export function oneThreadHsFromRows(rows = [], fallback = 0) {
  return oneThreadRateBand(rows, fallback).min;
}

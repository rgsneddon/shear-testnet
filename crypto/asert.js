export const TARGET_BLOCK_INTERVAL_MS = 9_000;
export const MIN_BITS = 1;
/**
 * SHA-256 width. A 32-bit farm lid froze live difficulty under large
 * CPU farms. GPU/ASIC stay refused at the share gate; this only lets
 * ASERT use the whole hash.
 */
export const MAX_BITS = 256;
export const LIVE_MIN_BITS = 14;
export const GENESIS_BITS = 21;
/** Protocol unit is 10⁻¹¹ SHE (11 decimals). Vote steps are integers of this unit. Public amounts show eight fractional digits. */
export const SHE_DECIMALS = 11;
export const SHE_PUBLIC_DIGITS = 8;
export const NANOS_PER_SHE = 100_000_000_000; // 10^11
/** 0.1 SHE pot (10_000_000_000 units). Hash bonus stays 1 unit. */
export const BLOCK_SUBSIDY_NANOS = 10_000_000_000;
/** 0.00000000001 SHE per valid hash = 1 protocol unit. */
export const HASH_BONUS_NANOS = 1;
/** Vote moves the per-hash bonus by one protocol unit (±10⁻¹¹ SHE). The pot does not move. */
export const HASH_BONUS_VOTE_DELTA_NANOS = 1;
export const POOL_FEE_BPS = 100;
export const MAGIC_TESTNET_V1 = 'shear-testnet-v1';
/** Live testnet book. */
export const MAGIC_TESTNET = 'shear-testnet-v1';
export const MAGIC_MAINNET = 'shear-v1';
/** Reserve may mint interest. Join may mint once at genesis into its vault. */
export const RESERVE_PROGRAM = 'shear-reserve-v1';
export const JOIN_PROGRAM = 'shear-join-v1';
export const JOIN_KIND_GENESIS = 'join-genesis';
export const JOIN_WINDOW_DAYS = 99;
export const JOIN_WINDOW_MS = JOIN_WINDOW_DAYS * 86_400_000;
/** Prior-ledger coin uses 11 decimals; Shear uses 11. 1 coin → 1 SHE. */
export const PRIOR_UNITS_PER_COIN = 100_000_000_000;
export const PRIOR_TO_SHEAR_UNITS = NANOS_PER_SHE / PRIOR_UNITS_PER_COIN;
export const PI_SHE_NANOS = 314159265358; // floor(π × 10^11) SHE in protocol units
export const RESERVE_EPOCH_DAYS = 400;
export const RESERVE_JOIN_CUTOFF_DAYS = 99;
export const RESERVE_EPOCH_MS = RESERVE_EPOCH_DAYS * 86_400_000;
export const RESERVE_JOIN_CUTOFF_MS = RESERVE_JOIN_CUTOFF_DAYS * 86_400_000;
export const HASH_BONUS_VOTE_DELTA = HASH_BONUS_VOTE_DELTA_NANOS / NANOS_PER_SHE;

/** Public amount frame: eight fractional digits. Sub-1e-8 dust stays on the sealed book. */
export function formatShe(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0.00000000';
  const trunc = (v < 0 ? Math.ceil(v * 1e8 - 1e-9) : Math.floor(v * 1e8 + 1e-9)) / 1e8;
  if (trunc === 0 && v !== 0) return (v < 0 ? '-' : '') + '0.00000000';
  const s = trunc.toFixed(SHE_PUBLIC_DIGITS);
  if (/^-?\d+\.00000000$/.test(s)) return String(Math.trunc(trunc));
  return s;
}

export function extraMintAllowed(programId, opts = {}) {
  const id = String(programId || '');
  if (id === RESERVE_PROGRAM) return true;
  if (id === JOIN_PROGRAM && String(opts.kind || '') === JOIN_KIND_GENESIS && !opts.funded) {
    return true;
  }
  return false;
}

export function clampBits(bits) {
  const n = Math.floor(Number(bits) || 0);
  if (Number(bits) === Infinity) return MAX_BITS;
  if (!Number.isFinite(n) || n <= 0) return GENESIS_BITS;
  return Math.max(LIVE_MIN_BITS, Math.min(MAX_BITS, n));
}

/**
 * Per-block ASERT toward 9s. Pure function of the header timestamp
 * delta — verifiers must not use wall clock. Same-tick (≤0) is treated
 * as 1ms so it still climbs, but the step is capped at ±2 (not ±8).
 */
export function nextBits(previousBits, intervalMs) {
  const prev = clampBits(previousBits);
  let seen = Number(intervalMs);
  if (!Number.isFinite(seen) || seen < 1) seen = 1;
  const ratio = TARGET_BLOCK_INTERVAL_MS / seen;
  const delta = Math.round(Math.log2(Math.max(1 / 4, Math.min(4, ratio))));
  return clampBits(prev + delta);
}

/** Bits for this block from parent bits and the two header timestamps. */
export function bitsForBlock(parentBits, parentTimestamp, blockTimestamp) {
  return nextBits(parentBits, Number(blockTimestamp) - Number(parentTimestamp));
}

export function blockWork(bits) {
  const n = clampBits(bits);
  return 2 ** n;
}

export const TARGET_BLOCK_INTERVAL_MS = 90_000;
export const MIN_BITS = 1;
export const MAX_BITS = 32;
export const LIVE_MIN_BITS = 14;
export const GENESIS_BITS = 21;
export const NANOS_PER_SHE = 1_000_000_000;
export const BLOCK_SUBSIDY_NANOS = NANOS_PER_SHE;
export const HASH_BONUS_NANOS = 1;
export const POOL_FEE_BPS = 100;
export const MAGIC_TESTNET = 'shear-testnet-v1';
export const MAGIC_MAINNET = 'shear-v1';
/** Only this Vortex program may mint beyond miner pot + hash bonus. */
export const RESERVE_PROGRAM = 'shear-reserve-v1';
export const PI_SHE_NANOS = 3141592654; // π SHE in nanos (floor 3.141592654 SHE)

export function clampBits(bits) {
  const n = Math.floor(Number(bits) || 0);
  if (!Number.isFinite(n) || n <= 0) return GENESIS_BITS;
  return Math.max(LIVE_MIN_BITS, Math.min(MAX_BITS, n));
}

/** Per-block ASERT toward 90s. */
export function nextBits(previousBits, intervalMs) {
  const prev = clampBits(previousBits);
  const seen = Number(intervalMs);
  if (!Number.isFinite(seen) || seen < 250) return prev;
  const ratio = TARGET_BLOCK_INTERVAL_MS / seen;
  const delta = Math.round(Math.log2(Math.max(1 / 256, Math.min(256, ratio))));
  return clampBits(prev + delta);
}

export function blockWork(bits) {
  const n = clampBits(bits);
  return 2 ** n;
}

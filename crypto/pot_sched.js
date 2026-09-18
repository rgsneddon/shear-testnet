/**
 * Epoch-indexed block pot. Testnet 4-day / mainnet 400-day clocks.
 * Votes and the Reserve oracle cannot move this schedule.
 */
export const MS_PER_DAY = 86_400_000;
export const EPOCH_DAYS_TESTNET = 4;
export const EPOCH_DAYS_MAINNET = 400;
export const POT_START_NANOS = 100_000_000_000;
export const POT_STEP_NANOS = 1_000_000_000;
export const POT_FLOOR_NANOS = 20_000_000_000;
export const POT_EPOCHS_TO_FLOOR = 80;
export const MAGIC_MAINNET = 'shear-v1';

export function epochDaysForMagic(magic) {
  return String(magic) === MAGIC_MAINNET ? EPOCH_DAYS_MAINNET : EPOCH_DAYS_TESTNET;
}

/** Mainnet cannot shorten epochs. Magic is the only switch. */
export function epochDays(magic) {
  if (String(magic) === MAGIC_MAINNET) return EPOCH_DAYS_MAINNET;
  return epochDaysForMagic(magic);
}

export function epochMs(magic) {
  return epochDays(magic) * MS_PER_DAY;
}

/** Late-join idle window scales with epoch length (99/400 on mainnet → 1 day on testnet). */
export function joinCutoffDays(magic) {
  const days = epochDays(magic);
  return Math.max(0, Math.round((99 * days) / 400));
}

export function joinCutoffMs(magic) {
  return joinCutoffDays(magic) * MS_PER_DAY;
}

export function vortexEpochIndex({ nowMs, genesisMs, epochDays: days } = {}) {
  const g = Number(genesisMs);
  const t = Number(nowMs);
  const d = Number(days);
  if (!Number.isFinite(g) || !Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return 0;
  if (!(t >= g)) return 0;
  return Math.floor((t - g) / (d * MS_PER_DAY));
}

export function potSubsidyNanos(epoch) {
  const e = Math.max(0, Math.floor(Number(epoch) || 0));
  const raw = POT_START_NANOS - e * POT_STEP_NANOS;
  return raw > POT_FLOOR_NANOS ? raw : POT_FLOOR_NANOS;
}

export function nextPotNanos(epoch) {
  return potSubsidyNanos(Math.floor(Number(epoch) || 0) + 1);
}

export function potSubsidyAt({ nowMs, genesisMs, magic } = {}) {
  const days = epochDays(magic);
  return potSubsidyNanos(vortexEpochIndex({ nowMs, genesisMs, epochDays: days }));
}

export function potSchedPin(days) {
  const d = Number(days);
  return `lin-epoch:start=${POT_START_NANOS}:step=${POT_STEP_NANOS}:floor=${POT_FLOOR_NANOS}:epochDays=${d}`;
}

export function epochView({ nowMs, genesisMs, magic } = {}) {
  const days = epochDays(magic);
  const g = Number(genesisMs) || 0;
  const t = Number(nowMs) || 0;
  const epoch = vortexEpochIndex({ nowMs: t, genesisMs: g, epochDays: days });
  const pot = potSubsidyNanos(epoch);
  const span = days * MS_PER_DAY;
  const elapsed = Math.max(0, t - g);
  const into = span > 0 ? elapsed % span : 0;
  return {
    epoch,
    epochDays: days,
    potNanos: pot,
    nextPotNanos: nextPotNanos(epoch),
    floorNanos: POT_FLOOR_NANOS,
    tailActive: pot <= POT_FLOOR_NANOS,
    remainMs: span > 0 ? span - into : 0,
    genesisMs: g,
  };
}

export function chainGenesisMs(blocks, fallbackHeader, decodeHeader) {
  const first = Array.isArray(blocks) && blocks.length ? blocks[0] : null;
  const raw = first?.header || fallbackHeader;
  if (!raw || typeof decodeHeader !== 'function') return 0;
  try {
    return Number(decodeHeader(Buffer.from(raw)).timestamp) || 0;
  } catch {
    return 0;
  }
}

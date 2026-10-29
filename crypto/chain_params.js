/**
 * Frozen chain parameters for the private shear-dev book.
 *
 * Russell 2026-10-29 16:04 / 16:07: shear-dev gets its own day length and
 * vote constants as a dev-only exception. Only the shear-dev magic reads
 * this row. shear-testnet-v12, shear-v1, shear-regtest and the closed
 * books keep their existing constants in asert.js, pot_sched.js,
 * vault_accrual.js and leaf_vote.js; nothing here is consulted for them.
 *
 * This module reads no environment and no CLI. There is no override.
 * The dev Reserve is contracts/dev/ReserveDev.json (scripts/gen_reserve_dev.mjs).
 * Ported from PR #128 (fc600180) onto the leaf-v2 vault.
 */
import { createHash } from 'node:crypto';

export const MAGIC_DEV = 'shear-dev';

/** Shear EVM chain id of v12 and shear-v1. Unchanged; dev uses its own row id. */
export const PUBLIC_EVM_CHAIN_ID = 2701;

function row(spec) {
  return Object.freeze({
    ...spec,
    defaultSeeds: Object.freeze(spec.defaultSeeds.slice()),
  });
}

const DEV = row({
  magic: MAGIC_DEV,
  targetBlockMs: 9000,
  asertTauMs: 720000,
  hardenMax: 0,
  easeMax: 0,
  emergencyEaseMax: 2,
  emergencyGapFactor: 8,
  asertFastGapMs: 200,
  genesisBits: 12,
  headerAheadMs: 5000,
  mtpWindow: 11,
  mtpFutureMs: 720000,
  dayMs: 72000,
  dayBlocks: 8,
  epochDays: 4,
  epochMs: 288000,
  epochBlocks: 32,
  periodBlocks: 2,
  periodMs: 18000,
  stubBlocks: 1,
  joinCutoffMs: 72000,
  // 32 slots of 9_000 ms is exactly one epoch. An exact fit lands on the
  // next epoch's start, so the gate would never read as closed. One slot
  // is dropped: 31. 16 periods of 18_000 ms is the same exact fit, so
  // withdrawPeriodSlots is 15. These are the enforced counts. Nothing
  // recomputes them at runtime.
  withdrawSlots: 31,
  withdrawSlotMs: 9000,
  withdrawPeriodSlots: 15,
  claimPeriods: 2,
  voteCloseBlock: 24,
  voteEdge: 1,
  voteSep: 1,
  voteGap: 1,
  voteFinality: 2,
  spendableConfirmations: 9,
  policyConfirmations: 12,
  coinbaseMaturity: 9,
  feeTauMs: 9000,
  oracleBlockMs: 9000,
  oracleWindowBlocks: 1,
  oracleMaxAgeMs: 1008000,
  evmChainId: 2799,
  defaultSeeds: [],
  datadirLeaf: 'shear-dev',
  p2pBanMs: 60000,
  rpcPort: 18432,
  poolIpcPort: 31314,
  reserveArtifact: 'ReserveDev.json',
  jobRestampMs: 2000,
  prevJobGraceMs: 1200,
  headerHoldMs: 18000,
  tipStallMs: 90000,
  vardiffTargetMs: 2000,
  vardiffRetargetShares: 8,
  vardiffRetargetMs: 20000,
  vardiffClearEaseMs: 4000,
  vardiffDeadbandMs: 1400,
  payoutSweepMs: 120000,
  payoutSweepFloorMs: 0,
  noValidShareMs: 90000,
  presenceMs: 12000,
  hashrateWindowMs: 180000,
  jobHeaderHistory: 12,
  maxLockLeaves: 16,
  retireDleqs: 64,
  retireRows: 3,
  reserveTxs: 32,
  verifyWeight: 36000,
  claimsPerBlock: 455,
  leafVotes: 64,
  maxLiveVaultLeaves: 4096,
  p2pFrameBytes: 16777216,
});


export const CHAIN_PARAMS = Object.freeze({
  [MAGIC_DEV]: DEV,
});

function unknownMagic() {
  const err = new Error('unknown_magic');
  err.code = 'unknown_magic';
  return err;
}

/** True only for the exact shear-dev magic. */
export function isDevMagic(magic) {
  return magic != null && String(magic) === MAGIC_DEV;
}

/** The dev row for shear-dev, null for every other book. Never throws. */
export function devRow(magic) {
  return isDevMagic(magic) ? DEV : null;
}

/** The row for a table key. A missing or unknown magic throws unknown_magic. */
export function chainParams(magic) {
  const key = magic == null ? '' : String(magic);
  const rowFor = Object.prototype.hasOwnProperty.call(CHAIN_PARAMS, key) ? CHAIN_PARAMS[key] : null;
  if (!rowFor) throw unknownMagic();
  return rowFor;
}

/** EVM chain id a book binds into withdraw, lock and roll signatures. */
export function evmChainIdFor(magic) {
  const dev = devRow(magic);
  return dev ? dev.evmChainId : PUBLIC_EVM_CHAIN_ID;
}

/**
 * Dev withdraw gate on the dev chain clock. elapsedMs is chain time since
 * the chain epoch opened. Both counts are stored, never derived: an exact
 * fit of the epoch is one slot less, so the close sits strictly inside it.
 * 31 slots of 9_000 ms and 15 periods of 18_000 ms on the dev row.
 * Votes are leaf-v2 heights (leaf_vote.js voteParams), not this clock.
 */
export function devWithdrawOpen(elapsedMs, rowIn = DEV) {
  const r = rowIn || DEV;
  const elapsed = Math.max(0, Math.floor(Number(elapsedMs) || 0));
  const periodSpan = Math.max(1, Math.floor(Number(r.periodMs)));
  const periodLimit = Math.max(0, Math.floor(
    r.withdrawPeriodSlots == null ? Number(r.withdrawSlots) : Number(r.withdrawPeriodSlots),
  ));
  if (Math.floor(elapsed / periodSpan) >= periodLimit) return false;
  return withdrawSlotOpen(elapsed, r);
}

/** True while the elapsed time is still inside the row's withdraw slots. */
export function withdrawSlotOpen(elapsedMs, row) {
  const slotMs = Math.max(1, Math.floor(Number(row.withdrawSlotMs) || 1));
  const slots = Math.floor(Number(row.withdrawSlots));
  const slot = Math.floor(Math.max(0, Number(elapsedMs) || 0) / slotMs);
  return slot < slots;
}


/**
 * True when a shear-dev withdraw at clockMs falls outside the dev withdraw
 * slots of its chain epoch. Always false on every other book (v12 and
 * shear-v1 have no slot gate). No chain genesis leaves the gate open.
 */
export function devWithdrawClosed(magic, genesisMs, clockMs) {
  const dev = devRow(magic);
  if (!dev) return false;
  const g = Number(genesisMs) || 0;
  const now = Number(clockMs) || 0;
  if (!(g > 0) || !(now >= g)) return false;
  const elapsed = (now - g) % dev.epochMs;
  return !devWithdrawOpen(elapsed, dev);
}

export function canonicalParamsJson(magic) {
  const spec = chainParams(magic);
  const keys = Object.keys(spec).sort();
  const obj = {};
  for (const key of keys) obj[key] = spec[key];
  return JSON.stringify(obj);
}

export function paramsDigest(magic) {
  return createHash('sha256').update(canonicalParamsJson(magic), 'utf8').digest('hex');
}

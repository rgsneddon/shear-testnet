/**
 * Frozen chain parameters keyed by magic.
 * Three keys: shear-dev, shear-testnet-v12, shear-v1.
 * Each row is its own literal. v12 and mainnet are not derived from shear-dev.
 * This module reads no environment and no CLI. There is no override.
 * P2P and stratum listen ports are process config (SHEAR_P2P_PORT, SHEAR_STRATUM).
 * They are not row fields and they are not in the dev PARAMS digest.
 */
import { createHash } from 'node:crypto';
import { RESERVE_BOOKS, MAGIC_TESTNET_V12, MAGIC_MAINNET } from './reserve_books.js';

export const MAGIC_DEV = 'shear-dev';
export const MAGIC_V12 = MAGIC_TESTNET_V12;
export const MAGIC_V1 = MAGIC_MAINNET;

const V12_SEEDS = Object.freeze([
  'p2p.shear.digital:30303',
  'r2r.shear.digital:30303',
  'b2b.shear.digital:30303',
]);

const MAINNET_SEEDS = Object.freeze([
  'p2p.shear.digital:30303',
  'r2r.shear.digital:30303',
  'b2b.shear.digital:30303',
]);

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
  genesisBits: 17,
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
  withdrawSlots: 64,
  withdrawSlotMs: 9000,
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
  ipcPort: 31313,
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

const V12 = row({
  magic: MAGIC_V12,
  targetBlockMs: 90000,
  asertTauMs: 7200000,
  hardenMax: 0,
  easeMax: 0,
  emergencyEaseMax: 2,
  emergencyGapFactor: 8,
  asertFastGapMs: 2000,
  genesisBits: 17,
  headerAheadMs: 15000,
  mtpWindow: 11,
  mtpFutureMs: 7200000,
  dayMs: 86400000,
  dayBlocks: 960,
  epochDays: 4,
  epochMs: 345600000,
  epochBlocks: 3840,
  periodBlocks: 240,
  periodMs: 21600000,
  stubBlocks: 24,
  joinCutoffMs: 86400000,
  withdrawSlots: 7680,
  withdrawSlotMs: 90000,
  claimPeriods: 2,
  voteCloseBlock: 2880,
  voteEdge: 10,
  voteSep: 30,
  voteGap: 7,
  voteFinality: 100,
  spendableConfirmations: 9,
  policyConfirmations: 12,
  coinbaseMaturity: 9,
  feeTauMs: 90000,
  oracleBlockMs: 90000,
  oracleWindowBlocks: 67,
  oracleMaxAgeMs: 1209600000,
  evmChainId: 2701,
  defaultSeeds: V12_SEEDS,
  datadirLeaf: 'testnet-v11',
  p2pBanMs: 900000,
  rpcPort: 18332,
  ipcPort: 30313,
  reserveArtifact: 'Reserve.json',
  jobRestampMs: 10000,
  prevJobGraceMs: 12000,
  headerHoldMs: 180000,
  tipStallMs: 900000,
  vardiffTargetMs: 2000,
  vardiffRetargetShares: 8,
  vardiffRetargetMs: 20000,
  vardiffClearEaseMs: 4000,
  vardiffDeadbandMs: 1400,
  payoutSweepMs: 3600000,
  payoutSweepFloorMs: 3600000,
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

const MAIN = row({
  magic: MAGIC_V1,
  targetBlockMs: 90000,
  asertTauMs: 7200000,
  hardenMax: 6,
  easeMax: 1,
  emergencyEaseMax: 2,
  emergencyGapFactor: 8,
  asertFastGapMs: 2000,
  genesisBits: 17,
  headerAheadMs: 15000,
  mtpWindow: 11,
  mtpFutureMs: 7200000,
  dayMs: 86400000,
  dayBlocks: 960,
  epochDays: 400,
  epochMs: 34560000000,
  epochBlocks: 384000,
  periodBlocks: 24000,
  periodMs: 2160000000,
  stubBlocks: 960,
  joinCutoffMs: 8553600000,
  withdrawSlots: 7680,
  withdrawSlotMs: 90000,
  claimPeriods: 2,
  voteCloseBlock: 2880,
  voteEdge: 10,
  voteSep: 30,
  voteGap: 7,
  voteFinality: 100,
  spendableConfirmations: 9,
  policyConfirmations: 12,
  coinbaseMaturity: 9,
  feeTauMs: 90000,
  oracleBlockMs: 90000,
  oracleWindowBlocks: 6720,
  oracleMaxAgeMs: 1209600000,
  evmChainId: 2701,
  defaultSeeds: MAINNET_SEEDS,
  datadirLeaf: 'shear-v1',
  p2pBanMs: 900000,
  rpcPort: 18332,
  ipcPort: 30313,
  reserveArtifact: 'Reserve.json',
  jobRestampMs: 10000,
  prevJobGraceMs: 12000,
  headerHoldMs: 180000,
  tipStallMs: 900000,
  vardiffTargetMs: 2000,
  vardiffRetargetShares: 8,
  vardiffRetargetMs: 20000,
  vardiffClearEaseMs: 4000,
  vardiffDeadbandMs: 1400,
  payoutSweepMs: 3600000,
  payoutSweepFloorMs: 3600000,
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
  [MAGIC_V12]: V12,
  [MAGIC_V1]: MAIN,
});

const HISTORICAL = new Set(
  RESERVE_BOOKS.map((b) => b.magic).filter((m) => m !== MAGIC_V12 && m !== MAGIC_V1),
);

export function isTableMagic(magic) {
  return Object.prototype.hasOwnProperty.call(CHAIN_PARAMS, String(magic));
}

export function isHistoricalMagic(magic) {
  return HISTORICAL.has(String(magic));
}

export function chainParams(magic) {
  const rowFor = CHAIN_PARAMS[String(magic)];
  if (!rowFor) {
    const err = new Error('unknown_magic');
    err.code = 'unknown_magic';
    throw err;
  }
  return rowFor;
}

/**
 * Clock for consensus callers that still see historical books and regtest.
 * The three table keys use their own row. Empty, shear-regtest, and closed
 * v1–v11 books use the v12 row explicitly. Anything else throws.
 */
export function clockFor(magic) {
  const key = magic == null ? '' : String(magic);
  if (isTableMagic(key)) return CHAIN_PARAMS[key];
  if (key === '' || key === 'shear-regtest' || isHistoricalMagic(key)) return CHAIN_PARAMS[MAGIC_V12];
  const err = new Error('unknown_magic');
  err.code = 'unknown_magic';
  throw err;
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

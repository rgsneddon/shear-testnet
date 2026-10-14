import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENESIS_BPS,
  ORACLE_MAX_AGE_MS,
  ORACLE_QUORUM,
  RESERVE_ORACLE_ID,
  averagePolicyBps,
  epochRateBps,
  bundledEpochBps,
  bundleObservationRoot,
} from '../../crypto/reserve_oracle.js';
import { encodeObserveRate } from '../../crypto/reserve_evm.js';

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'reserve', 'latest.json');

/** Basket average in whole bps. A wrong version is not an observation. */
export function bpsFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.version && snapshot.version !== RESERVE_ORACLE_ID) return null;
  const components = Array.isArray(snapshot.components) ? snapshot.components : [];
  let annualBps = null;
  if (components.length) annualBps = averagePolicyBps(components);
  else if (Number.isFinite(Number(snapshot.averagePercent))) annualBps = Math.round(Number(snapshot.averagePercent) * 100);
  else if (Number.isFinite(Number(snapshot.averageInteger))) annualBps = Math.round(Number(snapshot.averageInteger) / 10);
  if (!Number.isFinite(annualBps)) return null;
  const observedAtMs = Date.parse(String(snapshot.observedAt || '')) || 0;
  return {
    annualBps: Math.floor(annualBps),
    observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : 0,
    components,
  };
}

export function readOracleSnapshot(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The shipped basket is documentation of the attested integers.
 * `dataDir/oracle-snapshot.json` is not read. It cannot name the next rate.
 */
export function loadOracleSnapshot({ dataDir = '', bundled = BUNDLED } = {}) {
  void dataDir;
  if (bundled && fs.existsSync(bundled)) return readOracleSnapshot(bundled);
  return null;
}

/**
 * Staking oracle view. Mint uses the sealed epochBps.
 * `wouldFreezeBps` is the bundled quorum. There is no per-epoch step.
 * A snapshot argument is not an input to either number.
 */
export function oracleView(vault, snapshot, nowMs = Date.now()) {
  const parsed = bpsFromSnapshot(snapshot);
  const epochBps = Math.floor(Number(vault?.epochBps ?? GENESIS_BPS));
  const annualBps = bundledEpochBps() ?? GENESIS_BPS;
  const observedAtMs = parsed ? parsed.observedAtMs : 0;
  const stale = !(observedAtMs > 0) || (Number(nowMs) - observedAtMs > ORACLE_MAX_AGE_MS);
  const wouldFreezeBps = epochRateBps(epochBps);
  return {
    id: RESERVE_ORACLE_ID,
    annualBps,
    observedAtMs,
    stale,
    epochBps,
    wouldFreezeBps,
    epochIndex: Math.floor(Number(vault?.epochIndex || 0)),
    observationRoot: bundleObservationRoot(),
    sourceCount: ORACLE_QUORUM,
    floorBps: 0,
    mintUses: 'epochBps',
    snapshotIgnored: true,
    displayOnly: true,
    observeCall: Buffer.from(encodeObserveRate(wouldFreezeBps, Math.floor(Number(nowMs) / 1000))).toString('hex'),
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENESIS_BPS,
  ORACLE_MAX_AGE_MS,
  EPOCH_BPS_MAX_STEP,
  RESERVE_ORACLE_ID,
  averagePolicyBps,
  freezeEpochBps,
  observationRoot,
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

/** Operator file wins. Otherwise the basket shipped beside the node. Neither writes the vault. */
export function loadOracleSnapshot({ dataDir = '', bundled = BUNDLED } = {}) {
  const local = dataDir ? path.join(dataDir, 'oracle-snapshot.json') : '';
  if (local && fs.existsSync(local)) {
    const parsed = readOracleSnapshot(local);
    if (bpsFromSnapshot(parsed)) return parsed;
  }
  if (bundled && fs.existsSync(bundled)) return readOracleSnapshot(bundled);
  return null;
}

/**
 * Staking oracle view. Mint uses the sealed epochBps.
 * A fresh basket only names the bps the next freeze may adopt.
 * This does not call observeRate and does not move the vault.
 */
export function oracleView(vault, snapshot, nowMs = Date.now()) {
  const parsed = bpsFromSnapshot(snapshot);
  const epochBps = Math.floor(Number(vault?.epochBps ?? GENESIS_BPS));
  const annualBps = parsed ? parsed.annualBps : GENESIS_BPS;
  const observedAtMs = parsed ? parsed.observedAtMs : 0;
  const stale = !(observedAtMs > 0) || (Number(nowMs) - observedAtMs > ORACLE_MAX_AGE_MS);
  const wouldFreezeBps = freezeEpochBps({
    prevEpochBps: epochBps,
    annualBps,
    observedAtMs,
    nowMs,
    magic: vault?.magic,
  });
  const components = parsed?.components || [];
  return {
    id: RESERVE_ORACLE_ID,
    annualBps,
    observedAtMs,
    stale,
    epochBps,
    wouldFreezeBps,
    epochIndex: Math.floor(Number(vault?.epochIndex || 0)),
    observationRoot: observationRoot(components),
    sourceCount: components.length,
    maxStep: EPOCH_BPS_MAX_STEP,
    mintUses: 'epochBps',
    observeCall: Buffer.from(encodeObserveRate(wouldFreezeBps, Math.floor(Number(nowMs) / 1000))).toString('hex'),
  };
}

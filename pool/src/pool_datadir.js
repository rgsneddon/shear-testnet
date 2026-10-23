/**
 * Pool book folder. Distinct from the node's default so one host can run both.
 * An explicit SHEAR_DATA is shared with the node and still takes the one lock.
 * testnet-v11 is the legacy pool default. A fresh testnet-v12-pool must not
 * invent a payout identity while pool-miner.json or pool-spend.seed is still there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from '../../node/src/node.js';

export const POOL_BOOK_LEAF = 'testnet-v12-pool';
export const LEGACY_POOL_BOOK_LEAF = 'testnet-v11';

function bareEnv(env) {
  const next = { ...env };
  delete next.SHEAR_DATA;
  return next;
}

export function defaultPoolDataDir(opts = {}) {
  return defaultDataDir({ ...opts, leaf: POOL_BOOK_LEAF });
}

export function legacyPoolDataDir(opts = {}) {
  return defaultDataDir({ ...opts, leaf: LEGACY_POOL_BOOK_LEAF });
}

/**
 * The new default folder has neither identity file and the legacy folder has
 * pool-miner.json or pool-spend.seed. Null when the operator set SHEAR_DATA
 * or SHEAR_POOL_MINER, or this dataDir is not the new default. The caller
 * refuses. Nothing is copied.
 */
export function abandonedPoolIdent({
  dataDir,
  minerEnv = '',
  env = process.env,
  homedir,
  platform,
  exists = (p) => fs.existsSync(p),
} = {}) {
  if (String(minerEnv || env.SHEAR_POOL_MINER || '').trim()) return null;
  if (String(env.SHEAR_DATA || '').trim()) return null;
  const place = { env: bareEnv(env), homedir, platform, exists };
  const fresh = defaultPoolDataDir(place);
  if (dataDir && path.resolve(String(dataDir)) !== path.resolve(fresh)) return null;
  const legacy = legacyPoolDataDir(place);
  const freshIdent = path.join(fresh, 'pool-miner.json');
  const freshSeed = path.join(fresh, 'pool-spend.seed');
  const legacyIdent = path.join(legacy, 'pool-miner.json');
  const legacySeed = path.join(legacy, 'pool-spend.seed');
  if (exists(freshIdent) || exists(freshSeed)) return null;
  const legacyMiner = exists(legacyIdent);
  const legacySpend = exists(legacySeed);
  if (!legacyMiner && !legacySpend) return null;
  return {
    fresh, legacy, freshIdent, legacyIdent, legacySeed, legacyMiner, legacySpend,
  };
}

#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPool } from './pool.js';
import { isShearAddress } from '../../crypto/address.js';
import { bootPoolOperator } from './pool_ident.js';
import { createP2p, P2P_PORT, SEED_RETRY_MS } from '../../node/src/p2p.js';
import { MAGIC_TESTNET, GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { SHARE_BITS_V2_START } from './share_vardiff.js';
import { assertHashBackend, hashBackendKind } from '../../crypto/shear_hash.js';
import { watchNodeStatus } from '../../node/src/status.js';

try {
  assertHashBackend();
} catch (e) {
  console.error(JSON.stringify({
    ok: false,
    event: 'shearhash',
    error: String(e?.message || e),
  }));
  process.exit(1);
}

const dataDir = process.env.SHEAR_DATA || path.join(os.homedir(), '.shear', 'testnet-v4');
fs.mkdirSync(dataDir, { recursive: true });
const boot = bootPoolOperator({ dataDir });
const miner = boot.miner
  || (boot.miner && !isShearAddress(boot.miner) ? boot.miner : '');
if (!boot.signed) {
  console.error(JSON.stringify({
    event: 'auto_payout_unsigned',
    reason: 'need_SHEAR_POOL_SPEND_SEED',
  }));
}
const pool = createPool({
  dataDir,
  stratumPort: Number(process.env.SHEAR_STRATUM || 1111),
  httpPort: Number(process.env.SHEAR_HTTP || 8088),
  stratumBind: process.env.SHEAR_STRATUM_BIND || '127.0.0.1',
  requireLoginAuth: String(process.env.SHEAR_STRATUM_AUTH || '') === '1',
  miner,
  operatorSpendKey: boot.operatorSpendKey,
  shareBits: Number(process.env.SHEAR_SHARE_BITS || SHARE_BITS_V2_START),
  bits: Number(process.env.SHEAR_BITS || GENESIS_BITS_PACKED),
});
await pool.listen();
const p2pPort = Number(process.env.SHEAR_P2P_PORT ?? P2P_PORT);
let p2pBound = 0;
let p2pNet = null;
if (p2pPort > 0) {
  const p2p = createP2p({
    store: pool.store,
    port: p2pPort,
    host: process.env.SHEAR_P2P_BIND || '0.0.0.0',
  });
  const bound = await p2p.listen();
  pool.setP2p(p2p);
  p2pNet = p2p;
  p2pBound = bound.port;
  const seeds = (process.env.SHEAR_SEEDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  await p2p.dialSeeds(seeds);
  const seedTimer = setInterval(() => {
    p2p.dialSeeds(seeds);
  }, SEED_RETRY_MS);
  if (typeof seedTimer.unref === 'function') seedTimer.unref();
}
console.log(JSON.stringify({
  ok: true,
  event: 'boot',
  stratum: 1111,
  http: pool.httpServer.address().port,
  p2p: p2pBound,
  miner,
  magic: MAGIC_TESTNET,
  hashBackend: hashBackendKind() || 'missing',
  height: pool.store.tip()?.height || 0,
}));
watchNodeStatus({
  store: pool.store,
  p2p: p2pNet,
  extra: () => ({
    stratum: 1111,
    http: pool.httpServer.address().port,
    p2p: p2pBound,
    miners: pool.miners?.size || 0,
    accepted: Number(pool.stats?.accepted || 0),
    rejected: Number(pool.stats?.rejected || 0),
    hashBackend: hashBackendKind() || 'missing',
  }),
});

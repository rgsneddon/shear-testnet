#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPool } from './pool.js';
import { isShearAddress } from '../../crypto/address.js';
import { destForLogin, payoutDest } from '../../crypto/flow_sheet.js';
import { loadOrCreatePoolIdent } from './pool_ident.js';
import { createP2p, P2P_PORT, SEED_RETRY_MS } from '../../node/src/p2p.js';
import { MAGIC_TESTNET, GENESIS_BITS } from '../../crypto/asert.js';
import { SHARE_BITS_V2_START } from './share_vardiff.js';

const dataDir = process.env.SHEAR_DATA || path.join(os.homedir(), '.shear', 'testnet-v2');
fs.mkdirSync(dataDir, { recursive: true });
const identPath = path.join(dataDir, 'pool-miner.json');
let miner = process.env.SHEAR_POOL_MINER;
if (!miner) {
  const ident = loadOrCreatePoolIdent(identPath);
  miner = ident.miner
    || destForLogin(ident.paymentCode || '', { viewKey: '', height: 1 })
    || (ident.miner && !isShearAddress(ident.miner) ? ident.miner : '');
}
const pool = createPool({
  dataDir,
  stratumPort: Number(process.env.SHEAR_STRATUM || 1111),
  httpPort: Number(process.env.SHEAR_HTTP || 8088),
  miner,
  shareBits: Number(process.env.SHEAR_SHARE_BITS || SHARE_BITS_V2_START),
  bits: Number(process.env.SHEAR_BITS || GENESIS_BITS),
});
await pool.listen();
const p2pPort = Number(process.env.SHEAR_P2P_PORT ?? P2P_PORT);
let p2pBound = 0;
if (p2pPort > 0) {
  const p2p = createP2p({
    store: pool.store,
    port: p2pPort,
    host: process.env.SHEAR_P2P_BIND || '0.0.0.0',
  });
  const bound = await p2p.listen();
  pool.setP2p(p2p);
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
  stratum: 1111,
  http: pool.httpServer.address().port,
  p2p: p2pBound,
  miner,
  magic: MAGIC_TESTNET,
}));

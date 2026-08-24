#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPool } from './pool.js';
import { newIdentity } from '../../crypto/address.js';
import { createP2p, P2P_PORT } from '../../node/src/p2p.js';

const dataDir = process.env.SHEAR_DATA || path.join(os.homedir(), '.shear', 'testnet');
fs.mkdirSync(dataDir, { recursive: true });
const identPath = path.join(dataDir, 'pool-miner.json');
let miner = process.env.SHEAR_POOL_MINER;
if (!miner) {
  if (fs.existsSync(identPath)) {
    miner = JSON.parse(fs.readFileSync(identPath, 'utf8')).address;
  } else {
    const id = newIdentity();
    fs.writeFileSync(identPath, JSON.stringify({ address: id.address, viewKey: id.viewKey }, null, 2));
    miner = id.address;
  }
}
const pool = createPool({
  dataDir,
  stratumPort: Number(process.env.SHEAR_STRATUM || 1111),
  httpPort: Number(process.env.SHEAR_HTTP || 8088),
  miner,
  shareBits: Number(process.env.SHEAR_SHARE_BITS || 12),
  bits: Number(process.env.SHEAR_BITS || 16),
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
  p2pBound = bound.port;
}
console.log(JSON.stringify({
  ok: true,
  stratum: 1111,
  http: pool.httpServer.address().port,
  p2p: p2pBound,
  miner,
  magic: 'shear-testnet-v1',
}));

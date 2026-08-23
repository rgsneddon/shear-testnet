#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPool } from './pool.js';
import { newIdentity } from '../../crypto/address.js';

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
console.log(JSON.stringify({
  ok: true,
  stratum: 1111,
  http: pool.httpServer.address().port,
  miner,
  magic: 'shear-testnet-v1',
}));

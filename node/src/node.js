#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAGIC_TESTNET, GENESIS_BITS } from '../../crypto/asert.js';
import { CLIENT, ALGO, HEADER_LEN } from '../../crypto/shear_hash.js';
import { RESERVE_PROGRAM } from '../../crypto/asert.js';
import { extraMintAllowed } from '../../crypto/mint.js';
import { createStore } from './store.js';
import { createP2p, P2P_PORT } from './p2p.js';

const VERSION = '0.1.0';

export function printConfig() {
  return {
    name: 'shear-node',
    version: VERSION,
    magic: MAGIC_TESTNET,
    client: CLIENT,
    algorithm: ALGO,
    headerBytes: HEADER_LEN,
    genesisBits: GENESIS_BITS,
    p2p: P2P_PORT,
    reserveProgram: RESERVE_PROGRAM,
    extraMintOnlyReserve: extraMintAllowed(RESERVE_PROGRAM),
    mainnet: false,
  };
}

export { createP2p, P2P_PORT, createStore };

export async function startNode({
  dataDir = process.env.SHEAR_DATA || path.join(os.homedir(), '.shear', 'testnet'),
  p2pPort = Number(process.env.SHEAR_P2P_PORT || P2P_PORT),
  p2pBind = process.env.SHEAR_P2P_BIND || '0.0.0.0',
  seeds = (process.env.SHEAR_SEEDS || '').split(',').map((s) => s.trim()).filter(Boolean),
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = createStore(dataDir);
  const p2p = createP2p({ store, port: p2pPort, host: p2pBind, magic: MAGIC_TESTNET });
  const bound = await p2p.listen();
  for (const seed of seeds) {
    const cut = seed.lastIndexOf(':');
    const host = cut > 0 ? seed.slice(0, cut) : seed;
    const port = cut > 0 ? Number(seed.slice(cut + 1)) : P2P_PORT;
    try { await p2p.connect(host, port); } catch { /* seed optional */ }
  }
  return { store, p2p, bound, magic: MAGIC_TESTNET, mainnet: false };
}

async function main() {
  if (process.argv.includes('--print-config')) {
    console.log(JSON.stringify(printConfig()));
    return;
  }
  const started = await startNode();
  const tip = started.store.tip();
  console.log(JSON.stringify({
    ok: true,
    p2p: started.bound.port,
    bind: started.bound.host,
    magic: MAGIC_TESTNET,
    height: tip?.height || 0,
    hash: tip ? Buffer.from(tip.hash).toString('hex') : '',
    mainnet: false,
  }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

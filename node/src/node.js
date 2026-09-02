#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAGIC_TESTNET, GENESIS_BITS, PRODUCT_VERSION } from '../../crypto/asert.js';
import { CLIENT, ALGO, HEADER_LEN } from '../../crypto/shear_hash.js';
import { RESERVE_PROGRAM, RESERVE_EPOCH_DAYS, RESERVE_JOIN_CUTOFF_DAYS } from '../../crypto/asert.js';
import { extraMintAllowed } from '../../crypto/mint.js';
import { emptyVault } from '../../crypto/reserve_vault.js';
import { RESERVE_ORACLE_ID, RESERVE_ORACLE_DEFAULT_BPS } from '../../crypto/reserve_oracle.js';
import { createStore } from './store.js';
import { createP2p, P2P_PORT } from './p2p.js';
import { PHASE_B_GATE } from './chain.js';
import { createRpc, RPC_PORT } from './rpc.js';
import { mintVorticeDeployKey, parseVorticeKey, VORTICE_KEY_PREFIX } from '../../crypto/vortex.js';

const VERSION = PRODUCT_VERSION;

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
    rpc: RPC_PORT,
    phaseBGate: PHASE_B_GATE,
    extraMintThirdPartyCannotPrint: !extraMintAllowed('third-party-vortice'),
    reserveProgram: RESERVE_PROGRAM,
    extraMintOnlyReserve: extraMintAllowed(RESERVE_PROGRAM),
    extraMintJoinGenesis: false,
    reserveEpochDays: RESERVE_EPOCH_DAYS,
    reserveJoinCutoffDays: RESERVE_JOIN_CUTOFF_DAYS,
    reserveOracle: RESERVE_ORACLE_ID,
    reserveOracleDefaultBps: RESERVE_ORACLE_DEFAULT_BPS,
    vorticeKeyPrefix: VORTICE_KEY_PREFIX,
    vorticeCreatorsHostOwnDapps: true,
    extraMintThirdParty: extraMintAllowed('third-party-vortice'),
    mainnet: false,
  };
}

export { createP2p, P2P_PORT, createStore, createRpc, RPC_PORT, mintVorticeDeployKey, parseVorticeKey };

export async function startNode({
  dataDir = process.env.SHEAR_DATA || path.join(os.homedir(), '.shear', 'testnet-v2'),
  p2pPort = Number(process.env.SHEAR_P2P_PORT || P2P_PORT),
  p2pBind = process.env.SHEAR_P2P_BIND || '0.0.0.0',
  rpcPort = Number(process.env.SHEAR_RPC_PORT || RPC_PORT),
  rpcBind = process.env.SHEAR_RPC_BIND || '127.0.0.1',
  seeds = (process.env.SHEAR_SEEDS || '').split(',').map((s) => s.trim()).filter(Boolean),
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = createStore(dataDir);
  store.reserveVault = store.reserveVault || emptyVault();
  const p2p = createP2p({ store, port: p2pPort, host: p2pBind, magic: MAGIC_TESTNET });
  const bound = await p2p.listen();
  const rpc = createRpc({ store, p2p, port: rpcPort, host: rpcBind });
  const rpcBound = await rpc.listen();
  for (const seed of seeds) {
    const cut = seed.lastIndexOf(':');
    const host = cut > 0 ? seed.slice(0, cut) : seed;
    const port = cut > 0 ? Number(seed.slice(cut + 1)) : P2P_PORT;
    for (let i = 0; i < 20; i += 1) {
      try {
        await p2p.connect(host, port);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  return { store, p2p, rpc, bound, rpcBound, magic: MAGIC_TESTNET, mainnet: false, phaseBGate: PHASE_B_GATE };
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
    rpc: started.rpcBound?.port,
    bind: started.bound.host,
    magic: MAGIC_TESTNET,
    phaseBGate: PHASE_B_GATE,
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

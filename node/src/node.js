#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAGIC_TESTNET,
  MAGIC_MAINNET,
  GENESIS_BITS,
  PRODUCT_VERSION,
  HASH_BONUS_NANOS,
  INTEREST_DENOM_DAYS,
  HASH_TX_LIVE,
  GENESIS_MAINNET,
  GENESIS_MAINNET_MS,
  mainnetMayEmit,
  mainnetFingerprint,
  consensusFingerprint,
} from '../../crypto/asert.js';
import { CLIENT, ALGO, HEADER_LEN, assertHashBackend, hashBackendKind } from '../../crypto/shear_hash.js';
import { printHelp, helpTopics } from './help.js';
import { nodeStatus, printNodeStatus, watchNodeStatus } from './status.js';
import { RESERVE_PROGRAM, RESERVE_EPOCH_DAYS, RESERVE_JOIN_CUTOFF_DAYS } from '../../crypto/asert.js';
import { extraMintAllowed } from '../../crypto/mint.js';
import { emptyVault } from '../../crypto/reserve_vault.js';
import { RESERVE_ORACLE_ID, RESERVE_ORACLE_DEFAULT_BPS } from '../../crypto/reserve_oracle.js';
import { createStore } from './store.js';
import { createP2p, P2P_PORT, SEED_RETRY_MS } from './p2p.js';
import { attachSidecarIpc } from './p2p_ipc.js';
import { PHASE_B_GATE } from './chain.js';
import { createRpc, RPC_PORT } from './rpc.js';
import { createSoloStratum, SOLO_STRATUM_PORT, SOLO_STRATUM_BIND } from './solo_stratum.js';
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
    extraMintOnlyReserve: extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }),
    extraMintJoinGenesis: false,
    reserveEpochDays: RESERVE_EPOCH_DAYS,
    reserveJoinCutoffDays: RESERVE_JOIN_CUTOFF_DAYS,
    interestDenomDays: INTEREST_DENOM_DAYS,
    hashBonusNanos: HASH_BONUS_NANOS,
    reserveOracle: RESERVE_ORACLE_ID,
    reserveOracleDefaultBps: RESERVE_ORACLE_DEFAULT_BPS,
    vorticeKeyPrefix: VORTICE_KEY_PREFIX,
    vorticeCreatorsHostOwnDapps: true,
    extraMintThirdParty: extraMintAllowed('third-party-vortice'),
    mainnet: false,
    hashTxLive: HASH_TX_LIVE,
    admit: 'ADMITv2',
    archival: String(process.env.SHEAR_FAST_SYNC || '').trim() !== '1',
    fastSync: String(process.env.SHEAR_FAST_SYNC || '').trim() === '1',
    genesisMainnet: GENESIS_MAINNET,
    mainnetFingerprint: mainnetFingerprint(),
    bookLawFingerprint: consensusFingerprint(),
  };
}

export { createP2p, P2P_PORT, createStore, createRpc, RPC_PORT, mintVorticeDeployKey, parseVorticeKey };

/** ADMITv2 soak tip. Hostnames only — never a raw IP. DNS + static names (not DNS-only). */
export const DEFAULT_SEEDS = [
  'p2p.shear.digital:30303',
  'r2r.shear.digital:30303',
  'b2b.shear.digital:30303',
];

/** Unset SHEAR_SEEDS keeps the hostname defaults. An empty value dials nobody. */
export function resolveSeedList(seeds) {
  if (Array.isArray(seeds)) return seeds.map((s) => String(s).trim()).filter(Boolean);
  if (seeds == null) {
    if (process.env.SHEAR_SEEDS == null) return DEFAULT_SEEDS.slice();
    return String(process.env.SHEAR_SEEDS).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return String(seeds).split(',').map((s) => s.trim()).filter(Boolean);
}

export function isP2pSyncArg(argv = process.argv) {
  const args = argv.slice(2);
  if (args.includes('--mode=p2p-sync')) return true;
  const i = args.indexOf('--mode');
  return i >= 0 && args[i + 1] === 'p2p-sync';
}

export async function startNode({
  dataDir = process.env.SHEAR_DATA || path.join(os.homedir(), '.shear', 'testnet-v4'),
  p2pPort = Number(process.env.SHEAR_P2P_PORT || P2P_PORT),
  p2pBind = process.env.SHEAR_P2P_BIND || '0.0.0.0',
  rpcPort = Number(process.env.SHEAR_RPC_PORT || RPC_PORT),
  rpcBind = process.env.SHEAR_RPC_BIND || '127.0.0.1',
  seeds = undefined,
  fluffDelayMs = null,
  network = process.env.SHEAR_NETWORK || MAGIC_TESTNET,
  fastSync = process.argv.includes('--fast-sync')
    || String(process.env.SHEAR_FAST_SYNC || '').trim() === '1',
  solo = process.argv.includes('--solo')
    || String(process.env.SHEAR_SOLO || '').trim() === '1',
  stratumPort = Number(process.env.SHEAR_STRATUM || process.env.SHEAR_STRATUM_PORT || SOLO_STRATUM_PORT) || SOLO_STRATUM_PORT,
  stratumBind = process.env.SHEAR_STRATUM_BIND || SOLO_STRATUM_BIND,
} = {}) {
  const mainnet = String(network) === MAGIC_MAINNET;
  if (mainnet && !mainnetMayEmit()) {
    return {
      store: null,
      p2p: null,
      rpc: null,
      magic: MAGIC_MAINNET,
      mainnet: true,
      emit: false,
      genesis: GENESIS_MAINNET,
      phaseBGate: PHASE_B_GATE,
      hashTxLive: HASH_TX_LIVE,
    };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const store = createStore(dataDir, { fastSync: !!fastSync });
  store.reserveVault = store.reserveVault || emptyVault();
  const p2p = createP2p({ store, port: p2pPort, host: p2pBind, magic: MAGIC_TESTNET, fluffDelayMs });
  const bound = await p2p.listen();
  const rpc = createRpc({ store, p2p, port: rpcPort, host: rpcBind });
  const rpcBound = await rpc.listen();
  const seedList = resolveSeedList(seeds);
  await p2p.dialSeeds(seedList);
  const seedTimer = setInterval(() => {
    p2p.dialSeeds(seedList);
  }, SEED_RETRY_MS);
  if (typeof seedTimer.unref === 'function') seedTimer.unref();
  let stratum = null;
  let stratumBound = null;
  if (solo) {
    stratum = createSoloStratum({
      store,
      port: stratumPort,
      host: stratumBind,
      peers: () => p2p.peers,
    });
    stratumBound = await stratum.listen();
  }
  const origClose = p2p.close.bind(p2p);
  p2p.close = () => {
    clearInterval(seedTimer);
    try { stratum?.close(); } catch { /* ignore */ }
    origClose();
  };
  return {
    store, p2p, rpc, bound, rpcBound, stratum, stratumBound,
    solo: !!stratum,
    magic: MAGIC_TESTNET,
    mainnet: false,
    emit: true,
    phaseBGate: PHASE_B_GATE,
    hashTxLive: HASH_TX_LIVE,
    archival: !fastSync,
    fastSync: !!fastSync,
  };
}

/** P2P sync sidecar. Owns :30303. No pool HTTP and no stratum. */
export async function startP2pSync(opts = {}) {
  const started = await startNode({ ...opts, solo: false });
  if (!started?.p2p || started.emit === false) return { ...started, mode: 'p2p-sync', ipc: null };
  const ipcSpec = String(opts.ipc || process.env.SHEAR_P2P_IPC || '').trim();
  if (!ipcSpec) return { ...started, mode: 'p2p-sync', ipc: null };
  const ipc = attachSidecarIpc({ store: started.store, p2p: started.p2p, addr: ipcSpec });
  const origClose = started.p2p.close.bind(started.p2p);
  started.p2p.close = () => {
    try { ipc.close(); } catch { /* ignore */ }
    origClose();
  };
  return { ...started, mode: 'p2p-sync', ipc };
}

export { printHelp, helpTopics, nodeStatus, printNodeStatus };

/**
 * Startup decision for the node the GUI wallet starts.
 * An empty datadir, SHEAR_BOOTSTRAP=1, and a bootstrap URL are ignored.
 * This does not pull or apply a snapshot and does not throw bootstrap_missing.
 * The light-seeker that follows the live tip is a separate wallet path.
 */
export function resolveGuiBootstrap({
  argv = [],
  env = {},
  emptyDatadir = false,
  pullLatest = () => {
    throw new Error('bootstrap_pulled');
  },
  applyLatest = () => {
    throw new Error('bootstrap_missing');
  },
} = {}) {
  const args = Array.isArray(argv) ? argv : [];
  const flagged = args.includes('--bootstrap')
    || args.some((a) => String(a).startsWith('--bootstrap='));
  const fromArg = args.find((a) => String(a).startsWith('--bootstrap='));
  const url = String(fromArg || (env && env.SHEAR_BOOTSTRAP_URL) || '')
    .replace(/^--bootstrap=/, '')
    .trim();
  const envOn = String((env && env.SHEAR_BOOTSTRAP) || '').trim() === '1';
  const triggersIgnored = {
    emptyDatadir: emptyDatadir === true,
    env: envOn,
    url: flagged || url.length > 0,
  };
  void pullLatest;
  void applyLatest;
  return { pull: false, apply: false, missing: false, triggersIgnored };
}

function parseHelpTopic(argv) {
  const args = argv.slice(2);
  if (args[0] === 'help') return args[1] || '';
  if (args.includes('--help') || args.includes('-h')) {
    const i = Math.max(args.indexOf('--help'), args.indexOf('-h'));
    const next = args[i + 1];
    if (next && !String(next).startsWith('-')) return next;
    return '';
  }
  return null;
}

async function main() {
  const argv = process.argv;
  const args = argv.slice(2);
  const unknown = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === 'help' || helpTopics().includes(a)) continue;
    if (['--help', '-h', '--print-config', '--fast-sync', '--status', '--solo', '--mode=p2p-sync'].includes(a)) continue;
    if (a === '--mode') {
      const next = args[i + 1];
      if (next === 'p2p-sync') {
        i += 1;
        continue;
      }
    }
    if (a === '--no-bootstrap' || a.startsWith('--bootstrap=')) continue;
    if (a === '--bootstrap') {
      i += 1;
      continue;
    }
    unknown.push(a);
  }
  const topic = parseHelpTopic(argv);
  if (topic !== null) {
    if (topic && !helpTopics().includes(String(topic).toLowerCase())) {
      console.error(`unknown help topic: ${topic}`);
      console.log(printHelp());
      process.exitCode = 2;
      return;
    }
    console.log(printHelp(topic));
    return;
  }
  if (unknown.length) {
    console.error(`unknown flag: ${unknown[0]}`);
    console.log(printHelp());
    process.exitCode = 2;
    return;
  }
  if (argv.includes('--print-config')) {
    console.log(JSON.stringify(printConfig()));
    return;
  }
  if (argv.includes('--status')) {
    const dataDir = process.env.SHEAR_DATA || path.join(os.homedir(), '.shear', 'testnet-v4');
    const store = createStore(dataDir, {
      fastSync: String(process.env.SHEAR_FAST_SYNC || '').trim() === '1',
    });
    printNodeStatus({ store, extra: { hashBackend: hashBackendKind() || 'missing' } });
    return;
  }
  const dataDirForBoot = process.env.SHEAR_DATA || path.join(os.homedir(), '.shear', 'testnet-v4');
  const emptyDatadir = !fs.existsSync(path.join(dataDirForBoot, 'chain.bin'))
    && !fs.existsSync(path.join(dataDirForBoot, 'chain.jsonl'));
  const boot = resolveGuiBootstrap({
    argv,
    env: process.env,
    emptyDatadir,
    pullLatest: () => {
      throw new Error('bootstrap_pulled');
    },
    applyLatest: () => {
      throw new Error('bootstrap_missing');
    },
  });
  if (boot.pull || boot.apply || boot.missing) {
    throw new Error(boot.missing ? 'bootstrap_missing' : 'bootstrap_pulled');
  }
  if (isP2pSyncArg(argv)) {
    const started = await startP2pSync();
    if (started.emit === false) {
      console.log(JSON.stringify({
        ok: true,
        event: 'boot',
        mode: 'p2p-sync',
        magic: started.magic,
        emit: false,
        reason: 'clock_wait',
        genesis: started.genesis,
        hashTxLive: HASH_TX_LIVE,
        admit: 'ADMITv2',
        mainnet: true,
        p2p: 0,
        stratum: null,
        solo: false,
      }));
      return;
    }
    const tip = started.store.tip();
    const live = typeof started.store.fluxset === 'function' ? started.store.fluxset() : null;
    let hashBackend = hashBackendKind() || 'missing';
    try {
      assertHashBackend();
    } catch (e) {
      console.error(JSON.stringify({ event: 'shearhash', ok: false, error: String(e?.message || e) }));
    }
    console.log(JSON.stringify({
      ok: true,
      event: 'boot',
      role: 'sidecar',
      mode: 'p2p-sync',
      p2p: started.bound.port,
      rpc: started.rpcBound?.port,
      ipc: String(process.env.SHEAR_P2P_IPC || ''),
      stratum: null,
      solo: false,
      bind: started.bound.host,
      magic: MAGIC_TESTNET,
      phaseBGate: PHASE_B_GATE,
      height: tip?.height || 0,
      hash: tip ? Buffer.from(tip.hash).toString('hex') : '',
      mainnet: false,
      emit: true,
      hashTxLive: HASH_TX_LIVE,
      admit: 'ADMITv2',
      jroot: live?.jroot ? Buffer.from(live.jroot).toString('hex') : '',
      hashBackend,
    }));
    watchNodeStatus({
      store: started.store,
      p2p: started.p2p,
      extra: () => ({
        mode: 'p2p-sync',
        p2p: started.bound.port,
        rpc: started.rpcBound?.port,
        hashBackend: hashBackendKind() || 'missing',
      }),
    });
    return;
  }
  const started = await startNode();
  if (started.emit === false) {
    console.log(JSON.stringify({
      ok: true,
      magic: started.magic,
      emit: false,
      reason: 'clock_wait',
      genesis: started.genesis,
      hashTxLive: HASH_TX_LIVE,
      admit: 'ADMITv2',
      mainnet: true,
    }));
    return;
  }
  const tip = started.store.tip();
  const live = typeof started.store.fluxset === 'function' ? started.store.fluxset() : null;
  let hashBackend = hashBackendKind() || 'missing';
  try {
    assertHashBackend();
  } catch (e) {
    console.error(JSON.stringify({ event: 'shearhash', ok: false, error: String(e?.message || e) }));
  }
  console.log(JSON.stringify({
    ok: true,
    event: 'boot',
    p2p: started.bound.port,
    rpc: started.rpcBound?.port,
    stratum: started.stratumBound ? `${started.stratumBound.host}:${started.stratumBound.port}` : null,
    solo: !!started.solo,
    bind: started.bound.host,
    magic: MAGIC_TESTNET,
    phaseBGate: PHASE_B_GATE,
    height: tip?.height || 0,
    hash: tip ? Buffer.from(tip.hash).toString('hex') : '',
    mainnet: false,
    emit: true,
    hashTxLive: HASH_TX_LIVE,
    admit: 'ADMITv2',
    jroot: live?.jroot ? Buffer.from(live.jroot).toString('hex') : '',
    hashBackend,
  }));
  watchNodeStatus({
    store: started.store,
    p2p: started.p2p,
    extra: () => ({
      p2p: started.bound.port,
      rpc: started.rpcBound?.port,
      hashBackend: hashBackendKind() || 'missing',
    }),
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPool, stratumDriftShouldRefuse } from './pool.js';
import { isShearAddress } from '../../crypto/address.js';
import { bootPoolOperator } from './pool_ident.js';
import { attachPoolIpc, parseIpcAddr, P2P_IPC_PORT } from '../../node/src/p2p_ipc.js';
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
    event: 'pool_operator_unsigned',
    signed: false,
    reason: 'need_spend_key',
  }));
  console.error(JSON.stringify({
    event: 'auto_payout_unsigned',
    reason: 'need_SHEAR_POOL_SPEND_SEED',
  }));
}
const stratumBind = process.env.SHEAR_STRATUM_BIND || '127.0.0.1';
const requireLoginAuth = String(process.env.SHEAR_STRATUM_AUTH || '') === '1';
if (stratumDriftShouldRefuse({ bind: stratumBind, requireLoginAuth })) {
  console.error(JSON.stringify({
    ok: false,
    event: 'stratum_drift_refuse',
    reason: 'non_loopback_without_auth',
    stratumBind,
    loginAuth: requireLoginAuth ? 'ed25519' : 'dest-only',
  }));
  process.exit(1);
}
const pool = createPool({
  dataDir,
  stratumPort: Number(process.env.SHEAR_STRATUM || 1111),
  httpPort: Number(process.env.SHEAR_HTTP || 8088),
  stratumBind,
  requireLoginAuth,
  miner,
  operatorSpendKey: boot.operatorSpendKey,
  shareBits: Number(process.env.SHEAR_SHARE_BITS || SHARE_BITS_V2_START),
  bits: Number(process.env.SHEAR_BITS || GENESIS_BITS_PACKED),
});
await pool.listen();
// P2P listen, ShearHash, and getblock encode stay in the sidecar process.
const ipcAddr = parseIpcAddr(process.env.SHEAR_P2P_IPC || `127.0.0.1:${P2P_IPC_PORT}`);
let remotePeers = 0;
const ipc = await attachPoolIpc({
  store: pool.store,
  port: ipcAddr.port,
  onPeers(n) { remotePeers = Number(n) || 0; },
  onApplied() {
    try { pool.paintStatsSnap(); } catch { /* stats timer retries */ }
  },
});
const p2pShim = {
  liveOnline: () => remotePeers,
  syncedOnline: () => remotePeers,
  publishWork(rows) { ipc.send({ type: 'ipc_work', magic: MAGIC_TESTNET, rows: rows || [] }); },
};
pool.setP2p(p2pShim);
pool.store.on('tip', () => {
  try { pool.paintStatsSnap(); } catch { /* stats timer retries */ }
});
const httpPort = pool.httpServer.address().port;
const stratumPort = pool.stratum.address().port;
console.log(JSON.stringify({
  ok: true,
  event: 'boot',
  role: 'pool',
  stratum: stratumPort,
  http: httpPort,
  p2p: 0,
  ipc: ipc.port,
  miner,
  magic: MAGIC_TESTNET,
  hashBackend: hashBackendKind() || 'missing',
  height: pool.store.tip()?.height || 0,
  admit: 'ADMITv2',
}));
watchNodeStatus({
  store: pool.store,
  p2p: p2pShim,
  extra: () => ({
    stratum: stratumPort,
    http: httpPort,
    p2p: 0,
    ipc: ipc.port,
    miners: pool.miners?.size || 0,
    accepted: Number(pool.stats?.accepted || 0),
    rejected: Number(pool.stats?.rejected || 0),
    hashBackend: hashBackendKind() || 'missing',
  }),
});

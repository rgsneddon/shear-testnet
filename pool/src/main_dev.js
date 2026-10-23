#!/usr/bin/env node
/**
 * shear-dev pool entry. Backend only: stratum, share accounting, payouts, IPC.
 * There is no dev web UI. This file refuses to start unless the book is shear-dev.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPool, stratumDriftShouldRefuse, configuredFeeIdentity, stratumListenPlan } from './pool.js';
import { isShearAddress } from '../../crypto/address.js';
import { bootPoolOperator } from './pool_ident.js';
import { attachPoolIpc, parseIpcAddr } from '../../node/src/p2p_ipc.js';
import { genesisSeedPacked } from '../../crypto/asert.js';
import { SHARE_BITS_V2_START } from './share_vardiff.js';
import { assertHashBackend, hashBackendKind } from '../../crypto/shear_hash.js';
import { chainParams, MAGIC_DEV } from '../../crypto/chain_params.js';
import { defaultSidecarIpc, DEV_STRATUM_PORT } from '../../node/src/node.js';

export const POOL_EXPECT_MAGIC = MAGIC_DEV;
const DEV_HTTP_PORT = 18188;

function ranAsEntry() {
  const arg = process.argv[1];
  if (!arg) return false;
  return pathToFileURL(path.resolve(arg)).href === import.meta.url;
}

export async function bootDevPool() {
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

  const dataDir = process.env.SHEAR_DATA || path.join(os.homedir(), '.shear', 'shear-dev');
  fs.mkdirSync(dataDir, { recursive: true });
  let boot;
  try {
    boot = bootPoolOperator({ dataDir, requireInsideDatadir: true });
  } catch (e) {
    console.error(JSON.stringify({
      ok: false,
      event: 'spend_seed_outside_datadir',
      reason: String(e?.code || e?.message || e),
    }));
    process.exit(1);
  }
  const miner = boot.miner
    || (boot.miner && !isShearAddress(boot.miner) ? boot.miner : '');
  if (!boot.signed) {
    console.error(JSON.stringify({
      event: 'pool_operator_unsigned',
      signed: false,
      reason: 'need_spend_key',
    }));
  }
  const stratumBind = process.env.SHEAR_STRATUM_BIND || '127.0.0.1';
  const requireLoginAuth = String(process.env.SHEAR_STRATUM_AUTH || '') === '1';
  const feePin = configuredFeeIdentity({ refuseLiveDest: true });
  if (!feePin.ok) {
    console.error(JSON.stringify({
      ok: false,
      event: feePin.reason || 'live_fee_dest',
      reason: feePin.reason,
    }));
    process.exit(1);
  }
  const stratumPlan = stratumListenPlan({
    bind: stratumBind,
    hasTls: !!(process.env.SHEAR_STRATUM_TLS_CERT && process.env.SHEAR_STRATUM_TLS_KEY),
    requireTls: String(process.env.SHEAR_STRATUM_REQUIRE_TLS || '') === '1',
    labCleartext: String(process.env.SHEAR_STRATUM_LAB_CLEARTEXT || '') === '1',
  });
  if (!stratumPlan.ok) {
    console.error(JSON.stringify({ ok: false, event: 'stratum_listen_refuse', reason: stratumPlan.reason }));
    process.exit(1);
  }
  if (stratumDriftShouldRefuse({ bind: stratumBind, requireLoginAuth })) {
    console.error(JSON.stringify({ ok: false, event: 'stratum_drift_refuse', reason: 'non_loopback_without_auth' }));
    process.exit(1);
  }
  const pool = createPool({
    dataDir,
    network: POOL_EXPECT_MAGIC,
    stratumPort: Number(process.env.SHEAR_STRATUM || process.env.SHEAR_STRATUM_PORT || DEV_STRATUM_PORT),
    httpPort: Number(process.env.SHEAR_HTTP || DEV_HTTP_PORT),
    stratumBind,
    requireLoginAuth,
    miner,
    operatorSpendKey: boot.operatorSpendKey,
    shareBits: Number(process.env.SHEAR_SHARE_BITS || SHARE_BITS_V2_START),
    bits: genesisSeedPacked(MAGIC_DEV),
  });
  if (pool.store.magic !== POOL_EXPECT_MAGIC) {
    console.error(JSON.stringify({ ok: false, event: 'pool_magic', magic: pool.store.magic, expect: POOL_EXPECT_MAGIC }));
    process.exit(1);
  }
  await pool.listen();
  const ipcAddr = parseIpcAddr(process.env.SHEAR_P2P_IPC || defaultSidecarIpc(MAGIC_DEV));
  const ipc = await attachPoolIpc({ store: pool.store, port: ipcAddr.port });
  pool.setP2p({
    liveOnline: () => 0,
    syncedOnline: () => 0,
    publishWork(rows) { ipc.send({ type: 'ipc_work', magic: pool.store.magic, rows: rows || [] }); },
  });
  console.log(JSON.stringify({
    ok: true,
    event: 'boot',
    role: 'pool',
    magic: pool.store.magic,
    stratum: pool.stratum.address().port,
    http: pool.httpServer.address().port,
    ipc: ipc.port,
    hashBackend: hashBackendKind() || 'missing',
    height: pool.store.tip()?.height || 0,
  }));
}

if (ranAsEntry()) {
  await bootDevPool();
}

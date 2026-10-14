/**
 * Idempotent shear-testnet-v12 genesis preparation.
 * Build does not cut a host. CoS runs this against an empty datadir root.
 * The local seal is a digest that meets the genesis target. It is not
 * ShearHash(header). Live block 1 is found by a miner after the pool starts.
 *
 *   node scripts/v12-genesis-cut.mjs --root <empty-dir>
 *
 * A second run on the same root checks the sealed book and does not reseal.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash20FromAddress } from '../crypto/address.js';
import {
  ASERT_STEP_ID,
  ASERT_TAU_MS,
  GENESIS_BITS_PACKED,
  HEADER_AHEAD_MS,
  MAGIC_TESTNET,
  MTP_FUTURE_MS,
  POOL_FEE_BPS,
  PRODUCT_VERSION,
  SHEARK_MINER_VERSION,
  TARGET_BLOCK_INTERVAL_MS,
  asertNextBits,
} from '../crypto/asert.js';
import { decodeHeader } from '../crypto/header.js';
import { meetsTarget } from '../crypto/shear_hash.js';
import { openedCoinbaseNanos } from '../crypto/note.js';
import { potSubsidyAt } from '../crypto/pot_sched.js';
import { createStore } from '../node/src/store.js';
import { auditCirculatingSupply } from '../node/src/supply.js';
import { defaultDataDir } from '../node/src/node.js';
import { createPool, THIS_POOL_DIRECT_FEE_DEST } from '../pool/src/pool.js';
import { explorerCirculation } from '../pool/src/wallet_api.js';

const FEE_DEST = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILES = [
  'crypto/asert.js',
  'pool/src/posture.js',
  'pool/src/pool.js',
  'node/src/supply.js',
  'wallet/lib/main.dart',
  'wallet/lib/shear_identity.dart',
  'scripts/v12-genesis-cut.mjs',
];

function fail(message, extra = {}) {
  const line = JSON.stringify({ ok: false, error: message, ...extra });
  console.log(`V12_GENESIS_CUT ${line}`);
  process.exitCode = 2;
}

function argRoot(argv) {
  const args = argv.slice(2);
  if (args.length !== 2 || args[0] !== '--root' || !args[1]) {
    fail('usage: node scripts/v12-genesis-cut.mjs --root <empty-dir>');
    return null;
  }
  return path.resolve(args[1]);
}

function inside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function assertSafeRoot(root) {
  if (inside(root, ROOT)) return 'root is inside the git checkout';
  const live = defaultDataDir();
  if (inside(root, live) || inside(live, root)) return 'root touches the live node datadir';
  const home = os.homedir();
  const banned = [
    path.join(home, '.shear'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Shear') : '',
  ].filter(Boolean);
  for (const dir of banned) {
    if (inside(root, dir) || inside(dir, root)) return `root touches ${dir}`;
  }
  return '';
}

function sha256File(rel) {
  const abs = path.join(ROOT, rel);
  const buf = fs.readFileSync(abs);
  return createHash('sha256').update(buf).digest('hex');
}

function dartConst(rel, name) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const m = text.match(new RegExp(`const ${name} = '([^']*)'`));
  return m ? m[1] : '';
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function gitDirty() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  } catch {
    return true;
  }
}

function targetMeetingDigest() {
  const hash = Buffer.alloc(32);
  hash[31] = 1;
  if (!meetsTarget(hash, GENESIS_BITS_PACKED)) return null;
  return hash;
}

function feeNoteOf(block) {
  const cb = block?.txs?.[0];
  const fees = (cb?.vout || []).filter((o) => o.kind === 'pool-fee');
  if (fees.length !== 1) return { ok: false, reason: 'fee_count' };
  if ((cb.vout || []).some((o) => o.kind === 'pot')) return { ok: false, reason: 'pot_note' };
  const want = hash20FromAddress(FEE_DEST);
  if (!want || !Buffer.from(fees[0].dest20 || []).equals(want)) return { ok: false, reason: 'fee_dest' };
  const opened = openedCoinbaseNanos(fees[0]);
  const carry = Math.floor(Number(cb.carryNanos) || 0);
  if (!Number.isSafeInteger(opened) || opened <= 0) return { ok: false, reason: 'fee_open' };
  let ts = 0;
  try { ts = Number(decodeHeader(Buffer.from(block.header)).timestamp); } catch { ts = 0; }
  const subsidy = potSubsidyAt({ nowMs: ts, genesisMs: ts, magic: MAGIC_TESTNET });
  if (opened + carry !== subsidy) return { ok: false, reason: 'fee_subsidy' };
  if (opened !== Math.floor(subsidy * POOL_FEE_BPS / 10000)) return { ok: false, reason: 'fee_bps' };
  return { ok: true, opened, carry, subsidy };
}

function asertOf(block) {
  let decoded;
  try { decoded = decodeHeader(Buffer.from(block.header)); } catch {
    return { ok: false, reason: 'header' };
  }
  if (Number(decoded.bits) !== GENESIS_BITS_PACKED) return { ok: false, reason: 'bits' };
  const ts = Number(decoded.timestamp);
  const quote = asertNextBits({
    anchorBits: Number(decoded.bits),
    anchorTimeMs: ts,
    anchorHeight: 1,
    blockTimeMs: ts + TARGET_BLOCK_INTERVAL_MS,
    blockHeight: 2,
    parentTimeMs: ts,
  });
  if (!quote.ok || quote.easeBits !== 0) return { ok: false, reason: 'asert' };
  if (ASERT_TAU_MS !== 7_200_000 || ASERT_STEP_ID !== 'aserti3-2d') {
    return { ok: false, reason: 'asert_pin' };
  }
  if (TARGET_BLOCK_INTERVAL_MS !== 90_000) return { ok: false, reason: 'target' };
  return { ok: true, bits: Number(decoded.bits), timestamp: ts, nextPacked: quote.packed, easeBits: quote.easeBits };
}

function hexHash(block) {
  try { return Buffer.from(block.hash).toString('hex'); } catch { return ''; }
}

function writePoolConfig(dir, pins) {
  const body = {
    magic: pins.magic,
    feeDest: pins.feeDest,
    productVersion: pins.productVersion,
    walletVersion: pins.walletVersion,
    walletBookMagic: pins.walletBookMagic,
    shearkMinerVersion: pins.shearkMinerVersion,
    asertStep: ASERT_STEP_ID,
    targetMs: TARGET_BLOCK_INTERVAL_MS,
    tauMs: ASERT_TAU_MS,
    genesisBitsPacked: GENESIS_BITS_PACKED,
    headerAheadMs: HEADER_AHEAD_MS,
    mtpFutureMs: MTP_FUTURE_MS,
    poolFeeBps: POOL_FEE_BPS,
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  const file = path.join(dir, 'pool-v12.json');
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (prev !== text) fs.writeFileSync(file, text);
  return file;
}

async function main() {
  const root = argRoot(process.argv);
  if (!root) return;
  const why = assertSafeRoot(root);
  if (why) {
    fail(why, { root });
    return;
  }
  if (MAGIC_TESTNET !== 'shear-testnet-v12') {
    fail('node magic is not shear-testnet-v12', { magic: MAGIC_TESTNET });
    return;
  }
  if (THIS_POOL_DIRECT_FEE_DEST !== FEE_DEST) {
    fail('pool fee dest drifted', { feeDest: THIS_POOL_DIRECT_FEE_DEST });
    return;
  }
  const pins = {
    magic: MAGIC_TESTNET,
    productVersion: PRODUCT_VERSION,
    walletVersion: dartConst('wallet/lib/main.dart', 'kWalletVersion'),
    walletBookMagic: dartConst('wallet/lib/shear_identity.dart', 'kBookMagic'),
    shearkMinerVersion: SHEARK_MINER_VERSION,
    feeDest: THIS_POOL_DIRECT_FEE_DEST,
  };
  if (pins.walletVersion !== '0.72' || pins.productVersion !== '19.0' || pins.shearkMinerVersion !== '2.9') {
    fail('version pin drifted', { pins });
    return;
  }
  const sha256 = {};
  for (const rel of PIN_FILES) sha256[rel] = sha256File(rel);

  fs.mkdirSync(root, { recursive: true });
  const poolDir = path.join(root, 'pool');
  const explorerDir = path.join(root, 'explorer');
  fs.mkdirSync(poolDir, { recursive: true });
  fs.mkdirSync(explorerDir, { recursive: true });
  const configFile = writePoolConfig(poolDir, pins);

  const pool = createPool({
    dataDir: poolDir,
    stratumPort: 0,
    httpPort: 0,
    stratumBind: '127.0.0.1',
    miner: FEE_DEST,
  });
  let cut = false;
  try {
    const before = pool.store.tip();
    if (before && Number(before.height) > 1) {
      fail('datadir is past genesis', { height: before.height });
      return;
    }
    if (!before) {
      const digest = targetMeetingDigest();
      if (!digest) {
        fail('stand-in digest misses the genesis target');
        return;
      }
      const job = pool.issueJob(undefined, { force: true });
      if (!job?.jobId) {
        fail('no genesis job');
        return;
      }
      const sealed = await pool.store.submitHeader({
        jobId: job.jobId,
        nonce: 0n,
        miner: FEE_DEST,
        powHash: digest.toString('hex'),
      }, { trusted: true });
      if (!sealed?.ok) {
        fail('seal failed', { reason: sealed?.reason || 'seal' });
        return;
      }
      cut = true;
    }
    const tip = pool.store.tip();
    const fee = feeNoteOf(tip);
    if (!fee.ok) {
      fail('block 1 fee note', fee);
      return;
    }
    const asert = asertOf(tip);
    if (!asert.ok) {
      fail('asert', asert);
      return;
    }
    const supply = auditCirculatingSupply(pool.store.blocks, { magic: MAGIC_TESTNET });
    if (supply.status !== 'verified' || supply.differenceNanos !== 0) {
      fail('supply', supply);
      return;
    }
    if (supply.circulatingNanos + supply.carryNanos !== supply.schedulePotNanos) {
      fail('supply identity', supply);
      return;
    }
    const explorer = createStore(explorerDir);
    const wantHex = hexHash(tip);
    const seen = explorer.tip();
    if (!seen) {
      const got = await Promise.resolve(explorer.ingest([tip], {
        trustedPowHash: Buffer.from(tip.hash),
      }));
      if (!got?.ok) {
        fail('explorer ingest', { reason: got?.reason || 'ingest' });
        return;
      }
    }
    const exTip = explorer.tip();
    if (!exTip || hexHash(exTip) !== wantHex || Number(exTip.height) !== Number(tip.height)) {
      fail('explorer tip', { pool: wantHex, explorer: hexHash(exTip), height: exTip?.height });
      return;
    }
    const poolCirc = explorerCirculation(pool.store);
    const exCirc = explorerCirculation(explorer);
    if (poolCirc.supplyStatus !== 'verified' || exCirc.supplyStatus !== 'verified'
      || poolCirc.circulatingNanos !== exCirc.circulatingNanos
      || poolCirc.proofs !== true || exCirc.proofs !== true) {
      fail('explorer supply', { pool: poolCirc.supplyStatus, explorer: exCirc.supplyStatus });
      return;
    }
    const magicOnDisk = fs.readFileSync(path.join(poolDir, 'book.magic'), 'utf8').trim();
    if (magicOnDisk !== MAGIC_TESTNET) {
      fail('book.magic', { magicOnDisk });
      return;
    }
    const report = {
      ok: true,
      cut,
      idempotent: !cut,
      head: gitHead(),
      dirty: gitDirty(),
      root,
      configFile,
      pins,
      sha256,
      genesis: {
        bitsPacked: GENESIS_BITS_PACKED,
        targetMs: TARGET_BLOCK_INTERVAL_MS,
        tauMs: ASERT_TAU_MS,
        step: ASERT_STEP_ID,
        headerAheadMs: HEADER_AHEAD_MS,
        mtpFutureMs: MTP_FUTURE_MS,
        poolFeeBps: POOL_FEE_BPS,
      },
      localSeal: 'target-meeting digest, not ShearHash(header)',
      block1: {
        height: tip.height,
        hash: wantHex,
        feeNanos: fee.opened,
        carryNanos: fee.carry,
        subsidyNanos: fee.subsidy,
        bits: asert.bits,
        timestamp: asert.timestamp,
        nextPacked: asert.nextPacked,
        easeBits: asert.easeBits,
      },
      supply: {
        status: supply.status,
        circulatingNanos: supply.circulatingNanos,
        schedulePotNanos: supply.schedulePotNanos,
        carryNanos: supply.carryNanos,
        differenceNanos: supply.differenceNanos,
        hashNanos: supply.measuredHashNanos,
      },
      explorer: {
        height: exTip.height,
        hash: hexHash(exTip),
        supplyStatus: exCirc.supplyStatus,
        inSync: true,
      },
      walletBookPin: pins.walletBookMagic === pins.magic ? 'match' : 'open',
    };
    console.log(`V12_GENESIS_CUT ${JSON.stringify(report)}`);
  } finally {
    try { pool.close(); } catch { /* already down */ }
  }
}

main().catch((err) => {
  fail(String(err?.message || err));
});

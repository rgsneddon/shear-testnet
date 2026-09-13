/**
 * Latest-only prune bootstrap. Default IBD stays full archival.
 * Applying a bootstrap is opt-in (`--bootstrap`) and does not change consensus:
 * sealed txs stay; share-batch POW may skip only where flowSkipAllowed.
 * The website publishes this single latest pair, never a history of snapshots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MAGIC_TESTNET, SAMPLE_PRUNE_CONFIRMATIONS } from '../../crypto/asert.js';
import { shouldPruneSamples } from '../../crypto/chronoflux.js';
import { writeChainBin, readChainBin } from '../../crypto/chainbin.js';

function hexHash(h) {
  if (h == null || h === '') return '';
  if (Buffer.isBuffer(h) || h instanceof Uint8Array) return Buffer.from(h).toString('hex');
  return String(h);
}

export function bootstrapDir(dataDir) {
  return path.join(dataDir, 'bootstrap');
}

export function latestPaths(dir) {
  const d = path.join(dir, 'bootstrap');
  return {
    dir: d,
    json: path.join(d, 'latest.json'),
    bin: path.join(d, 'latest.bin'),
  };
}

/** First public snapshot at the 1000-conf prune, then every 400 blocks. */
export const BOOTSTRAP_FIRST_HEIGHT = 1000;
export const BOOTSTRAP_EVERY_BLOCKS = 400;
/** @deprecated internal lag; public cadence is FIRST + EVERY */
export const BOOTSTRAP_LAG_BLOCKS = 0;

export function bootstrapCheckpoint(tipH) {
  const tip = Number(tipH || 0);
  if (tip < BOOTSTRAP_FIRST_HEIGHT) return 0;
  return BOOTSTRAP_FIRST_HEIGHT
    + Math.floor((tip - BOOTSTRAP_FIRST_HEIGHT) / BOOTSTRAP_EVERY_BLOCKS) * BOOTSTRAP_EVERY_BLOCKS;
}

export function shouldPublishBootstrap(tipH, lastCheckpoint) {
  const c = bootstrapCheckpoint(tipH);
  return c >= BOOTSTRAP_FIRST_HEIGHT && c > Number(lastCheckpoint || 0);
}

/** Pruned prefix only. Overwrites latest.json + latest.bin. Lagged 5 blocks. */
export function writeLatestBootstrap(dataDir, blocks, {
  magic = MAGIC_TESTNET,
  pruneDepth = SAMPLE_PRUNE_CONFIRMATIONS,
  lag = BOOTSTRAP_LAG_BLOCKS,
} = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const liveTip = Number(list.at(-1)?.height || 0);
  const tipH = liveTip - Math.max(0, Number(lag) || 0);
  if (tipH < pruneDepth + 1) return null;
  const pruned = list.filter((b) => (
    Number(b.height) <= tipH
    && shouldPruneSamples(b.height, tipH, pruneDepth)
    && b.samplesPruned
  ));
  if (!pruned.length) return null;
  const last = pruned[pruned.length - 1];
  const first = pruned[0];
  const paths = latestPaths(dataDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeChainBin(paths.bin, pruned);
  const manifest = {
    latest: true,
    magic,
    pruneDepth,
    height: Number(last.height),
    hash: hexHash(last.hash),
    genesisHash: hexHash(first.hash),
    n: pruned.length,
    checkpoint: bootstrapCheckpoint(liveTip),
    every: BOOTSTRAP_EVERY_BLOCKS,
    createdAt: Date.now(),
  };
  const tmp = `${paths.json}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest)}\n`);
  fs.renameSync(tmp, paths.json);
  return manifest;
}

export function readLatestBootstrap(fromDir) {
  const paths = latestPaths(fromDir);
  if (!fs.existsSync(paths.json) || !fs.existsSync(paths.bin)) {
    throw new Error('bootstrap_missing');
  }
  const manifest = JSON.parse(fs.readFileSync(paths.json, 'utf8'));
  if (manifest.latest !== true) throw new Error('bootstrap_not_latest');
  if (manifest.magic && manifest.magic !== MAGIC_TESTNET) throw new Error('bootstrap_magic');
  const blocks = readChainBin(paths.bin);
  if (!blocks.length) throw new Error('bootstrap_empty');
  if (Number(blocks[0].height) !== 1) throw new Error('bootstrap_not_genesis');
  if (hexHash(blocks[0].hash) !== String(manifest.genesisHash || '')) throw new Error('bootstrap_genesis');
  const last = blocks[blocks.length - 1];
  if (hexHash(last.hash) !== String(manifest.hash || '')) throw new Error('bootstrap_hash');
  if (Number(last.height) !== Number(manifest.height)) throw new Error('bootstrap_height');
  for (const b of blocks) {
    if (!(b.txs || []).length || !((b.txs || [])[0]?.vout || []).length) {
      throw new Error('bootstrap_dropped_txs');
    }
  }
  return { manifest, blocks, paths };
}

/** Empty datadir only. Copies latest.json + latest.bin into SHEAR_DATA and installs chain.bin. */
export function applyLatestBootstrap(dataDir, fromDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const chainBin = path.join(dataDir, 'chain.bin');
  const chainJson = path.join(dataDir, 'chain.jsonl');
  if (fs.existsSync(chainBin) || fs.existsSync(chainJson)) throw new Error('bootstrap_datadir_not_empty');
  const { manifest, blocks } = readLatestBootstrap(fromDir);
  const dest = latestPaths(dataDir);
  fs.mkdirSync(dest.dir, { recursive: true });
  writeChainBin(dest.bin, blocks);
  fs.writeFileSync(dest.json, `${JSON.stringify(manifest)}\n`);
  writeChainBin(chainBin, blocks);
  return manifest;
}

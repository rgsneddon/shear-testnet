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

/** Pruned prefix only. Overwrites latest.json + latest.bin. */
export function writeLatestBootstrap(dataDir, blocks, {
  magic = MAGIC_TESTNET,
  pruneDepth = SAMPLE_PRUNE_CONFIRMATIONS,
} = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const tipH = Number(list.at(-1)?.height || 0);
  const pruned = list.filter((b) => shouldPruneSamples(b.height, tipH, pruneDepth) && b.samplesPruned);
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

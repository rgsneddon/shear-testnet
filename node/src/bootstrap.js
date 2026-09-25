/**
 * Latest-only prune bootstrap. Default IBD stays full archival.
 * Applying a bootstrap is opt-in (`--bootstrap`) and does not change consensus:
 * sealed txs stay; share-batch POW may skip only where flowSkipAllowed.
 * The website publishes this single latest pair, never a history of snapshots.
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { MAGIC_TESTNET, SAMPLE_PRUNE_CONFIRMATIONS } from '../../crypto/asert.js';
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

/** First public snapshot at height 200, then 400, 600, 800, and so on. */
export const BOOTSTRAP_FIRST_HEIGHT = 200;
export const BOOTSTRAP_EVERY_BLOCKS = 200;
/**
 * Reorg / Reserve-seal freeze. Locked law: first at 1000, then every 400.
 * Snapshot publishing uses the 200 ladder above and must not move this floor.
 */
export const CHECKPOINT_FIRST_HEIGHT = 1000;
export const CHECKPOINT_EVERY_BLOCKS = 400;
export const BOOTSTRAP_URL = 'https://boot.shear.digital';
/** @deprecated internal lag; public cadence is FIRST + EVERY */
export const BOOTSTRAP_LAG_BLOCKS = 0;

export function bootstrapCheckpoint(tipH, first = BOOTSTRAP_FIRST_HEIGHT, every = BOOTSTRAP_EVERY_BLOCKS) {
  const tip = Number(tipH || 0);
  const f = Math.max(1, Math.floor(Number(first) || BOOTSTRAP_FIRST_HEIGHT));
  const e = Math.max(1, Math.floor(Number(every) || BOOTSTRAP_EVERY_BLOCKS));
  if (tip < f) return 0;
  return f + Math.floor((tip - f) / e) * e;
}

function hexOf(h) {
  if (h == null || h === '') return '';
  if (Buffer.isBuffer(h) || h instanceof Uint8Array) return Buffer.from(h).toString('hex');
  return String(h);
}

/**
 * Reorg floor: frozen hash at 1000, then every 400 (1400, 1800, …).
 * A heavier fork that replaces that block is refused.
 * Pass opts.first/every only for a store that was opened with an override.
 */
export function reorgBreaksCheckpoint(fromBlocks, toBlocks, opts = {}) {
  const from = Array.isArray(fromBlocks) ? fromBlocks : [];
  const to = Array.isArray(toBlocks) ? toBlocks : [];
  const first = Math.max(1, Math.floor(Number(opts.first ?? CHECKPOINT_FIRST_HEIGHT)));
  const every = Math.max(1, Math.floor(Number(opts.every ?? CHECKPOINT_EVERY_BLOCKS)));
  const tipH = Number(from.at(-1)?.height || 0);
  const cpH = bootstrapCheckpoint(tipH, first, every);
  if (cpH < first) return null;
  const old = from.find((b) => Number(b.height) === cpH);
  if (!old) return null;
  const neu = to.find((b) => Number(b.height) === cpH);
  const want = hexOf(old.hash);
  const got = neu ? hexOf(neu.hash) : '';
  if (want && want !== got) return { height: cpH, hash: want };
  return null;
}

/** DAG note fluxset. Pot rows alone are not this list. Order is height then noteCommit. */
export function dagFluxset(blocks) {
  const notes = [];
  for (const block of blocks || []) {
    for (const row of block.shareBatch || []) {
      const noteCommit = row && row.noteCommit ? String(row.noteCommit) : '';
      if (!noteCommit) continue;
      notes.push({
        height: Number(block.height) || 0,
        noteCommit,
        nonce: String(row.nonce ?? ''),
      });
    }
  }
  notes.sort((a, b) => (
    a.height - b.height
    || (a.noteCommit < b.noteCommit ? -1 : a.noteCommit > b.noteCommit ? 1 : 0)
  ));
  return notes;
}

export function fluxsetRoot(notes) {
  return createHash('sha256').update(JSON.stringify(notes)).digest('hex');
}

export function shouldPublishBootstrap(tipH, lastCheckpoint) {
  const c = bootstrapCheckpoint(tipH);
  return c >= BOOTSTRAP_FIRST_HEIGHT && c > Number(lastCheckpoint || 0);
}

/**
 * Prefix through the current checkpoint (200, 400, 600, …).
 * Overwrites latest.json + latest.bin. Does not wait for sample prune.
 */
export function writeLatestBootstrap(dataDir, blocks, {
  magic = MAGIC_TESTNET,
  lag = BOOTSTRAP_LAG_BLOCKS,
} = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const liveTip = Number(list.at(-1)?.height || 0);
  const tipH = liveTip - Math.max(0, Number(lag) || 0);
  const cp = bootstrapCheckpoint(tipH);
  if (cp < BOOTSTRAP_FIRST_HEIGHT) return null;
  const byH = new Map();
  for (const b of list) {
    const h = Number(b.height);
    if (h >= 1 && h <= cp) byH.set(h, b);
  }
  if (byH.size !== cp) return null;
  const prefix = [];
  for (let h = 1; h <= cp; h += 1) {
    const b = byH.get(h);
    if (!b) return null;
    prefix.push(b);
  }
  const last = prefix[prefix.length - 1];
  const first = prefix[0];
  const flux = dagFluxset(prefix);
  const paths = latestPaths(dataDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeChainBin(paths.bin, prefix);
  const manifest = {
    latest: true,
    magic,
    pruneDepth: SAMPLE_PRUNE_CONFIRMATIONS,
    height: Number(last.height),
    hash: hexHash(last.hash),
    genesisHash: hexHash(first.hash),
    n: prefix.length,
    fluxNotes: flux.length,
    fluxsetRoot: fluxsetRoot(flux),
    dins: 'pot+hash',
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
  const flux = dagFluxset(blocks);
  if (Number(manifest.fluxNotes) !== flux.length) throw new Error('bootstrap_fluxset');
  if (String(manifest.fluxsetRoot || '') !== fluxsetRoot(flux)) throw new Error('bootstrap_fluxset');
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

function localChainTip(dataDir) {
  const chainBin = path.join(dataDir, 'chain.bin');
  if (!fs.existsSync(chainBin)) return { height: 0, genesis: '' };
  const local = readChainBin(chainBin);
  if (!local.length) return { height: 0, genesis: '' };
  return {
    height: Number(local.at(-1).height) || 0,
    genesis: hexHash(local[0].hash),
  };
}

/**
 * Install a newer same-genesis snapshot.
 * Empty dir, or a shorter local chain, jumps to the checkpoint.
 * A local tip already at or past the snapshot is left alone.
 */
export function adoptNewerBootstrap(dataDir, fromDir) {
  const incoming = readLatestBootstrap(fromDir);
  const bootH = Number(incoming.manifest.height);
  const bootGenesis = String(incoming.manifest.genesisHash || '');
  const local = localChainTip(dataDir);
  if (local.height > 0 && local.genesis && bootGenesis && local.genesis !== bootGenesis) {
    return { applied: false, reason: 'genesis', height: local.height };
  }
  if (local.height >= bootH) {
    return { applied: false, reason: 'local_ahead', height: local.height, bootstrap: bootH };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const dest = latestPaths(dataDir);
  fs.mkdirSync(dest.dir, { recursive: true });
  writeChainBin(dest.bin, incoming.blocks);
  fs.writeFileSync(dest.json, `${JSON.stringify(incoming.manifest)}\n`);
  writeChainBin(path.join(dataDir, 'chain.bin'), incoming.blocks);
  for (const name of ['chain.jsonl', 'explorer.jsonl']) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  return { applied: true, height: bootH, magic: incoming.manifest.magic };
}

function getBuf(url, ms = 20000) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('http://') ? http : https;
    const req = lib.get(url, { timeout: ms }, (res) => {
      const code = Number(res.statusCode || 0);
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        resolve(getBuf(res.headers.location, ms));
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error(`bootstrap_http_${code}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('bootstrap_timeout'));
    });
  });
}

/** On first start and on every later start: take the newest snapshot if it is ahead. */
export async function pullLatestBootstrap(dataDir, base = process.env.SHEAR_BOOTSTRAP_URL || BOOTSTRAP_URL) {
  const root = String(base || BOOTSTRAP_URL).replace(/\/$/, '');
  const manifestBuf = await getBuf(`${root}/latest.json`, 15000);
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  if (manifest.latest !== true) throw new Error('bootstrap_not_latest');
  const bootH = Number(manifest.height || 0);
  if (bootH < BOOTSTRAP_FIRST_HEIGHT) return { applied: false, reason: 'short', bootstrap: bootH };
  const local = localChainTip(dataDir);
  if (local.height >= bootH) {
    return { applied: false, reason: 'local_ahead', height: local.height, bootstrap: bootH };
  }
  const bin = await getBuf(`${root}/latest.bin`, 120000);
  const tmp = fs.mkdtempSync(path.join(osTmp(), 'shear-boot-pull-'));
  try {
    const dir = path.join(tmp, 'bootstrap');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'latest.json'), manifestBuf);
    fs.writeFileSync(path.join(dir, 'latest.bin'), bin);
    return adoptNewerBootstrap(dataDir, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function osTmp() {
  return fs.realpathSync(process.env.TEMP || process.env.TMPDIR || '/tmp');
}

/**
 * Refresh the public latest bootstrap from the live book.
 * Reads chain.bin only. Does not rewrite the chain and does not restart the pool.
 * A shorter read never replaces a taller published snapshot.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readChainBin } from '../../crypto/chainbin.js';
import { readLatestBootstrap, writeLatestBootstrap } from './bootstrap.js';

/** Republish the newest snapshot on this cadence. A shorter height is refused. */
export const BOOTSTRAP_PUBLISH_INTERVAL_MS = 6000;

export function bootstrapPublishIntervalMs(env = process.env) {
  const raw = Number(env && env.SHEAR_BOOT_INTERVAL_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.max(BOOTSTRAP_PUBLISH_INTERVAL_MS, raw);
  return BOOTSTRAP_PUBLISH_INTERVAL_MS;
}

function log(obj) {
  console.log(JSON.stringify({ event: 'bootstrap_publish', ...obj }));
}

export function publishOnce({
  dataDir = process.env.SHEAR_DATA || '/var/lib/shear/testnet-v5',
  publishDir = process.env.SHEAR_BOOT_PUBLISH || path.join(dataDir, 'bootstrap'),
} = {}) {
  const chain = path.join(dataDir, 'chain.bin');
  if (!fs.existsSync(chain)) {
    log({ ok: false, reason: 'no_chain', dataDir });
    return { ok: false, reason: 'no_chain' };
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-'));
  try {
    const copy = path.join(scratch, 'chain.bin');
    fs.copyFileSync(chain, copy);
    const blocks = readChainBin(copy);
    const stage = path.join(scratch, 'stage');
    const manifest = writeLatestBootstrap(stage, blocks);
    if (!manifest) {
      const tip = Number(blocks.at(-1)?.height || 0);
      log({ ok: false, reason: 'not_ready', tip });
      return { ok: false, reason: 'not_ready', tip };
    }
    readLatestBootstrap(stage);
    const havePath = path.join(publishDir, 'latest.json');
    let have = 0;
    if (fs.existsSync(havePath)) {
      try {
        have = Number(JSON.parse(fs.readFileSync(havePath, 'utf8')).height) || 0;
      } catch {
        have = 0;
      }
    }
    if (Number(manifest.height) < have) {
      log({ ok: false, reason: 'shorter_than_published', height: manifest.height, have });
      return { ok: false, reason: 'shorter_than_published', height: manifest.height, have };
    }
    fs.mkdirSync(publishDir, { recursive: true });
    const src = path.join(stage, 'bootstrap');
    for (const name of ['latest.bin', 'latest.json']) {
      const to = path.join(publishDir, name);
      const tmp = `${to}.${process.pid}.tmp`;
      fs.copyFileSync(path.join(src, name), tmp);
      fs.renameSync(tmp, to);
    }
    log({
      ok: true,
      height: manifest.height,
      n: manifest.n,
      magic: manifest.magic,
      hash: manifest.hash,
    });
    return { ok: true, manifest };
  } catch (err) {
    const reason = String(err && err.message ? err.message : err);
    log({ ok: false, reason });
    return { ok: false, reason };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  return pathToFileURL(path.resolve(arg)).href === pathToFileURL(fileURLToPath(import.meta.url)).href
    || path.resolve(arg) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  const dataDir = process.env.SHEAR_DATA || '/var/lib/shear/testnet-v5';
  const publishDir = process.env.SHEAR_BOOT_PUBLISH || path.join(dataDir, 'bootstrap');
  const intervalMs = bootstrapPublishIntervalMs(process.env);
  publishOnce({ dataDir, publishDir });
  if (process.argv.includes('--loop') || process.env.SHEAR_BOOT_LOOP === '1') {
    setInterval(() => publishOnce({ dataDir, publishDir }), intervalMs);
  }
}

#!/usr/bin/env node
/**
 * Copy the latest prune snapshot to boot.shear.digital only at
 * height 1000, then every 400 blocks. Does not restart the pool.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readChainBin } from '../../crypto/chainbin.js';
import {
  writeLatestBootstrap,
  latestPaths,
  shouldPublishBootstrap,
  bootstrapCheckpoint,
} from '../src/bootstrap.js';

const data = process.env.SHEAR_DATA || '/var/lib/shear/testnet-v3';
const www = process.env.SHEAR_BOOT_WWW || '/var/www/boot.shear.digital';
const bin = path.join(data, 'chain.bin');
const jsonl = path.join(data, 'chain.jsonl');

function loadBlocks() {
  if (fs.existsSync(bin)) return readChainBin(bin);
  if (!fs.existsSync(jsonl)) return [];
  const out = [];
  for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
    if (line.trim()) {
      try { out.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  }
  return out;
}

const blocks = loadBlocks();
const tip = Number(blocks.at(-1)?.height || 0);
const publicJson = path.join(www, 'latest.json');
let last = 0;
try {
  last = Number(JSON.parse(fs.readFileSync(publicJson, 'utf8')).checkpoint || 0);
} catch { last = 0; }

if (!shouldPublishBootstrap(tip, last)) {
  console.log(JSON.stringify({
    ok: true,
    published: false,
    tip,
    checkpoint: bootstrapCheckpoint(tip),
    last,
  }));
  process.exit(0);
}

const man = writeLatestBootstrap(data, blocks, { lag: 0 });
if (!man) {
  console.log(JSON.stringify({ ok: true, published: false, tip, reason: 'no_pruned_prefix' }));
  process.exit(0);
}
man.checkpoint = bootstrapCheckpoint(tip);
fs.mkdirSync(www, { recursive: true });
const src = latestPaths(data);
fs.copyFileSync(src.json, `${publicJson}.tmp`);
fs.copyFileSync(src.bin, path.join(www, 'latest.bin.tmp'));
fs.writeFileSync(`${publicJson}.tmp`, `${JSON.stringify(man)}\n`);
fs.renameSync(path.join(www, 'latest.bin.tmp'), path.join(www, 'latest.bin'));
fs.renameSync(`${publicJson}.tmp`, publicJson);
console.log(JSON.stringify({ ok: true, published: true, tip, ...man }));

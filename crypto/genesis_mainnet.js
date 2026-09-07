/**
 * Prepared mainnet genesis envelope. Does not start a public book.
 * Timestamp 2026-09-11 20:00:00 UTC. Magic shear-v1. Empty premine.
 */
import { writeFileSync } from 'node:fs';
import { encodeDest } from './address.js';
import { MAGIC_MAINNET } from './asert.js';
import { MAINNET_GENESIS_MS } from './network.js';
import { prepareGenesis } from '../node/src/chain.js';
import { hashHex } from './shear_hash.js';
import { decodeHeader } from './header.js';

const SEED_MINER = encodeDest(Buffer.alloc(20, 0));

export function generateMainnetGenesis({
  miner = SEED_MINER,
  now = MAINNET_GENESIS_MS,
} = {}) {
  const block = prepareGenesis({ miner, now, magic: MAGIC_MAINNET });
  const decoded = decodeHeader(Buffer.from(block.header));
  return {
    magic: block.magic,
    height: block.height,
    timestamp: Number(decoded.timestamp),
    bits: decoded.bits,
    hash: hashHex(block.hash),
    headerHex: Buffer.from(block.header).toString('hex'),
    miner: block.miner,
    premine: [],
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('genesis_mainnet.js');
if (isMain) {
  const rec = generateMainnetGenesis();
  const out = process.argv[2];
  const body = `${JSON.stringify(rec, null, 2)}\n`;
  if (out) writeFileSync(out, body);
  else process.stdout.write(body);
}

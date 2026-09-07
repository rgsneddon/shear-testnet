/**
 * Prepared mainnet genesis envelope. Does not start a public book.
 * Timestamp Friday 11 September 2026 20:00:00 UTC. Magic shear-v1. Empty premine.
 * This goal does not mine genesis POW; hash stays TBD until cutover.
 */
import { writeFileSync } from 'node:fs';
import { MAGIC_MAINNET, GENESIS_BITS } from './asert.js';
import { MAINNET_GENESIS_MS } from './network.js';

export function generateMainnetGenesis({
  now = MAINNET_GENESIS_MS,
} = {}) {
  const timestamp = Number(now);
  return {
    magic: MAGIC_MAINNET,
    height: 1,
    timestamp,
    timestampISO: new Date(timestamp).toISOString(),
    bits: GENESIS_BITS,
    hash: 'TBD',
    headerHex: 'TBD',
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

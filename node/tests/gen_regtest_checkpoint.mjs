// Mine the regtest checkpoint chain and write the kept blocks and the pin
// (support/regtest_checkpoint.js).
//   node node/tests/gen_regtest_checkpoint.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegtestStore } from './regtest_store.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import {
  chainFileText,
  checkpointOf,
  mineCheckpointChain,
  REGTEST_CHECKPOINT_CHAIN_FILE,
  REGTEST_CHECKPOINT_FILE,
} from './support/regtest_checkpoint.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-regtest-checkpoint-'));
try {
  const store = createRegtestStore(dir, { bits: 4 });
  await mineCheckpointChain(store);
  const pin = checkpointOf(store);
  fs.mkdirSync(path.dirname(REGTEST_CHECKPOINT_CHAIN_FILE), { recursive: true });
  fs.writeFileSync(REGTEST_CHECKPOINT_CHAIN_FILE, chainFileText(store));
  fs.writeFileSync(REGTEST_CHECKPOINT_FILE, `${JSON.stringify(pin, null, 2)}\n`);
  process.stdout.write(`wrote ${REGTEST_CHECKPOINT_FILE}: height ${pin.height}, ${pin.hashHex}\n`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

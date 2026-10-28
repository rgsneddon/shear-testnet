/**
 * Windows ShearHash helper. A second isolate inside this process calls
 * shear_hash_set_backend again and drops the live RandomX cache (huge-page
 * fallback makes the flags look new). That access-violates the node
 * (exit 0xC0000005). A child process has its own cache.
 *
 * stdin:  "<id>\t<header hex>"
 * stdout: "<id>\t<hash hex>" or "<id>\tERR\t<message>"
 */
import readline from 'node:readline';
import { hashLaneBackend } from './hash_lane.js';
import { setHashBackend, shearHash, slowVerifyLine } from './shear_hash.js';

const laneBackend = hashLaneBackend();
// R39: log the backend actually in use, not the one asked for. A failed JIT
// leaves the interpreter, and that must never be silent.
let laneActual = 'interpreter';
try { laneActual = String(setHashBackend(laneBackend) || 'interpreter'); } catch { laneActual = 'interpreter'; }
try {
  console.error(JSON.stringify({ event: 'hash_lane', backend: laneActual, requested: laneBackend }));
  if (laneActual === 'interpreter') console.error(slowVerifyLine('hash_lane', laneActual, laneBackend));
} catch { /* ignore */ }

const laneTest = process.env.SHEAR_HASH_LANE_TEST === '1';
if (laneTest && process.env.SHEAR_TEST_CRASH_ON_START === '1') process.exit(1);
const hangPrefix = laneTest ? (process.env.SHEAR_TEST_HANG_HEADER_PREFIX || '') : '';
const delayPrefix = laneTest ? (process.env.SHEAR_TEST_DELAY_HEADER_PREFIX || '') : '';
const delayMs = laneTest ? (Number(process.env.SHEAR_TEST_DELAY_MS) || 0) : 0;

let pipeClosed = false;
function onPipeClosed(err) {
  if (err?.code !== 'EPIPE' || pipeClosed) return;
  pipeClosed = true;
  process.exit(0);
}
process.stdout.on('error', onPipeClosed);
process.stdin.on('error', onPipeClosed);

function writeLine(line) {
  if (pipeClosed || !process.stdout.writable || process.stdout.destroyed) {
    onPipeClosed({ code: 'EPIPE' });
    return;
  }
  process.stdout.write(line);
}

function answer(id, hex) {
  try {
    const raw = Buffer.from(hex, 'hex');
    const hash = shearHash(raw);
    writeLine(`${id}\t${Buffer.from(hash).toString('hex')}\n`);
  } catch (err) {
    const msg = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 180);
    writeLine(`${id}\tERR\t${msg}\n`);
  }
}

// The parent learns this lane's backend from the first line (status: slowVerify).
writeLine(`BACKEND\t${laneActual}\n`);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const tab = line.indexOf('\t');
  if (tab < 1) return;
  const id = line.slice(0, tab);
  const hex = line.slice(tab + 1).trim();
  if (hangPrefix && hex.startsWith(hangPrefix)) return;
  if (delayPrefix && delayMs > 0 && hex.startsWith(delayPrefix)) {
    setTimeout(() => answer(id, hex), delayMs);
    return;
  }
  answer(id, hex);
});

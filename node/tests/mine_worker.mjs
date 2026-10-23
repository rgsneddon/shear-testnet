// Nonce lanes for the reorg harness. One jit lane per core.
// Int32: 0 gen, 1 status, 2 done, 3 ready.
// BigUint64 at byte 16 is the winning nonce.
// Bytes 24..151 are the header. Bytes 152..183 are the digest.
import os from 'node:os';
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { setNonce } from '../../crypto/header.js';
import { meetsTarget, setHashBackend, shearHash } from '../../crypto/shear_hash.js';

const GEN = 0;
const STATUS = 1;
const DONE = 2;
const READY = 3;
export const MINE_STATUS_FOUND = 1;
export const MINE_STATUS_EXHAUSTED = 2;
export const MINE_STATUS_WORKER = 3;

function signalWorkerFault(view) {
  if (Atomics.load(view, STATUS) === 0) {
    Atomics.store(view, STATUS, MINE_STATUS_WORKER);
    Atomics.notify(view, STATUS, 1);
  }
}
const HEADER_AT = 24;
const HASH_AT = 152;
const HEADER_LEN = 128;
const HASH_LEN = 32;

if (parentPort && workerData?.role === 'lane') {
  const sab = workerData.sab;
  const i32 = new Int32Array(sab);
  const nonce64 = new BigUint64Array(sab, 16, 1);
  const bytes = new Uint8Array(sab);
  try { setHashBackend('jit'); } catch { /* interpreter still hashes */ }
  parentPort.on('message', (msg) => {
    if (!msg || msg.type !== 'mine') return;
    try {
    const gen = msg.gen | 0;
    const lanes = msg.lanes | 0;
    const start = BigInt(msg.nonceStart);
    const limit = BigInt(msg.maxTries);
    const bits = msg.bits;
    const base = Buffer.from(msg.header);
    for (let i = 0n; i < limit; i += 1n) {
      if (Atomics.load(i32, GEN) !== gen) return;
      const n = start + i;
      const header = setNonce(base, n);
      const hash = Buffer.from(shearHash(header));
      if (!meetsTarget(hash, bits)) continue;
      if (Atomics.compareExchange(i32, GEN, gen, -gen) !== gen) return;
      nonce64[0] = n;
      bytes.set(header, HEADER_AT);
      bytes.set(hash, HASH_AT);
      Atomics.store(i32, STATUS, MINE_STATUS_FOUND);
      Atomics.notify(i32, STATUS, 1);
      return;
    }
    if (Atomics.load(i32, GEN) !== gen) return;
    const done = Atomics.add(i32, DONE, 1) + 1;
    if (done === lanes) Atomics.compareExchange(i32, STATUS, 0, MINE_STATUS_EXHAUSTED);
    Atomics.notify(i32, STATUS, 1);
    } catch (err) {
      signalWorkerFault(i32);
      throw err;
    }
  });
  Atomics.add(i32, READY, 1);
  Atomics.notify(i32, READY, 1);
}

const sab = new SharedArrayBuffer(256);
const i32 = new Int32Array(sab);
let workers = null;
let laneCount = 0;
let genSeq = 1;

function sliceRange(total, count) {
  const chunk = Math.floor(total / count);
  const extra = total % count;
  const out = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const n = chunk + (i < extra ? 1 : 0);
    out.push({ nonceStart: cursor, maxTries: n });
    cursor += n;
  }
  return out;
}

async function waitUntil(slot, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const seen = Atomics.load(i32, slot);
    if (pred()) return true;
    const res = Atomics.waitAsync(i32, slot, seen, Math.min(left, 1000));
    if (res.async) await res.value;
  }
}

async function startLanes(count) {
  if (workers && laneCount === count) return workers;
  if (workers) await closeMineWorkers();
  const url = new URL('./mine_worker.mjs', import.meta.url);
  Atomics.store(i32, READY, 0);
  Atomics.store(i32, STATUS, 0);
  Atomics.store(i32, DONE, 0);
  Atomics.store(i32, GEN, 0);
  workers = [];
  laneCount = count;
  for (let i = 0; i < count; i += 1) {
    const worker = new Worker(url, { workerData: { role: 'lane', sab } });
    worker.on('error', () => {
      signalWorkerFault(i32);
    });
    workers.push(worker);
  }
  const ready = await waitUntil(READY, () => Atomics.load(i32, READY) >= count, 120_000);
  if (!ready) throw new Error(`mine lanes ready ${Atomics.load(i32, READY)}/${count}`);
  return workers;
}

/**
 * Search at most maxTries nonces across `threads` lanes. First block hit wins.
 * `timeoutMs` bounds the wait. Regtest bits-4 searches finish in well under
 * the default. A bits-17 genesis search is ~2^17 hashes and needs a longer bound.
 */
export async function mineHeaderParallel(header, bits, maxTries = 8_192, threads = os.cpus().length, timeoutMs = 60_000) {
  const count = Math.max(1, Math.floor(Number(threads) || os.cpus().length));
  const pool = await startLanes(count);
  const total = Math.floor(Number(maxTries));
  if (!Number.isInteger(total) || total < 1) throw new Error('maxTries');
  const gen = ++genSeq;
  const parts = sliceRange(total, pool.length);
  Atomics.store(i32, DONE, 0);
  Atomics.store(i32, STATUS, 0);
  Atomics.store(i32, GEN, gen);
  const base = Buffer.from(header);
  for (let i = 0; i < pool.length; i += 1) {
    pool[i].postMessage({
      type: 'mine',
      gen,
      lanes: pool.length,
      bits,
      nonceStart: parts[i].nonceStart,
      maxTries: parts[i].maxTries,
      header: base,
    });
  }
  const waitMs = Math.max(1_000, Math.floor(Number(timeoutMs) || 60_000));
  const finished = await waitUntil(STATUS, () => Atomics.load(i32, STATUS) !== 0, waitMs);
  const status = Atomics.load(i32, STATUS);
  if (status === MINE_STATUS_WORKER) {
    await closeMineWorkers();
    throw new Error('mine_worker');
  }
  if (!finished || status !== MINE_STATUS_FOUND) return null;
  const nonce64 = new BigUint64Array(sab, 16, 1);
  const bytes = new Uint8Array(sab);
  return {
    block: true,
    nonce: nonce64[0],
    header: Buffer.from(bytes.subarray(HEADER_AT, HEADER_AT + HEADER_LEN)),
    hash: Buffer.from(bytes.subarray(HASH_AT, HASH_AT + HASH_LEN)),
  };
}

export async function closeMineWorkers() {
  const pool = workers;
  workers = null;
  laneCount = 0;
  if (!pool) return;
  await Promise.all(pool.map((w) => w.terminate()));
}

export const mineWorkerPath = fileURLToPath(new URL('./mine_worker.mjs', import.meta.url));

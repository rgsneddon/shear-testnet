// Split one mine across the cores on this machine.
// The nonce cap stays the caller's maxTries. Lanes take disjoint slices of that range.
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const GEN = 0;
const STATUS = 1;
const DONE = 2;
const READY = 3;
const HEADER_AT = 24;
const HASH_AT = 152;
const HEADER_LEN = 128;
const HASH_LEN = 32;

const lanes = Math.max(1, os.availableParallelism());
const sab = new SharedArrayBuffer(256);
const i32 = new Int32Array(sab);
let workers = null;
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

function waitUntil(slot, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const seen = Atomics.load(i32, slot);
    if (pred()) return true;
    Atomics.wait(i32, slot, seen, Math.min(left, 1000));
  }
}

function startLanes() {
  if (workers) return workers;
  const url = new URL('./hash_bonus_mine_worker.js', import.meta.url);
  workers = [];
  for (let i = 0; i < lanes; i += 1) {
    const worker = new Worker(url, { workerData: { sab } });
    worker.unref();
    workers.push(worker);
  }
  const ready = waitUntil(READY, () => Atomics.load(i32, READY) >= lanes, 180000);
  if (!ready) throw new Error(`mine lanes ready ${Atomics.load(i32, READY)}/${lanes}`);
  return workers;
}

export function mineLaneCount() {
  return lanes;
}

/** Search at most maxTries nonces. Returns the first block hit in any lane. */
export function mineHeaderParallel(header, bits, maxTries = 3_000_000) {
  const pool = startLanes();
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
  const finished = waitUntil(STATUS, () => Atomics.load(i32, STATUS) !== 0, 7200000);
  if (!finished) throw new Error('mine lanes timed out');
  if (Atomics.load(i32, STATUS) !== 1) return null;
  const nonce64 = new BigUint64Array(sab, 16, 1);
  const bytes = new Uint8Array(sab);
  return {
    block: true,
    nonce: nonce64[0],
    header: Buffer.from(bytes.subarray(HEADER_AT, HEADER_AT + HEADER_LEN)),
    hash: Buffer.from(bytes.subarray(HASH_AT, HASH_AT + HASH_LEN)),
  };
}

export const mineWorkerPath = fileURLToPath(new URL('./hash_bonus_mine_worker.js', import.meta.url));

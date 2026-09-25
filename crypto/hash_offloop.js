/**
 * P2P ShearHash lane. RandomX runs in a worker so the HTTP accept loop
 * can serve /api/stats while a block or share batch is still verifying.
 * Cap is global for this process (one shared node binary, solo and pool).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/** Keep in lockstep with node/src/p2p.js P2P_VERIFY_CAP. */
export const P2P_VERIFY_CAP = 2;

const workerUrl = new URL('./hash_offloop_worker.js', import.meta.url);
const childUrl = fileURLToPath(new URL('./hash_offloop_child.js', import.meta.url));

let worker = null;
let child = null;
let seq = 0;

function winChild() {
  return process.platform === 'win32';
}
const pending = new Map();

let active = 0;
let maxActive = 0;
let queued = 0;
let maxQueued = 0;
let started = 0;
let completed = 0;
let workerActive = 0;
let workerMaxActive = 0;
const waiters = [];

export function p2pHashCap() {
  return P2P_VERIFY_CAP;
}

export function p2pHashStats() {
  return {
    cap: P2P_VERIFY_CAP,
    active,
    maxActive,
    queued,
    maxQueued,
    started,
    completed,
    workerActive,
    workerMaxActive,
  };
}

export function resetP2pHashStats() {
  maxActive = active;
  maxQueued = queued;
  started = 0;
  completed = 0;
  workerMaxActive = workerActive;
}

function touchChild(proc, live) {
  if (!proc) return;
  const fn = live ? 'ref' : 'unref';
  try { proc[fn](); } catch { /* ignore */ }
  try { proc.stdout?.[fn](); } catch { /* ignore */ }
  try { proc.stdin?.[fn](); } catch { /* ignore */ }
}

function failPending(err) {
  worker = null;
  child = null;
  if (!pending.size) return;
  for (const [, job] of pending) job.reject(err);
  pending.clear();
}

function bootChild() {
  if (child) return child;
  const proc = spawn(process.execPath, [childUrl], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const rl = createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    const parts = line.split('\t');
    const id = Number(parts[0]);
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (workerActive > 0) workerActive -= 1;
    if (parts[1] === 'ERR') job.reject(new Error(parts.slice(2).join('\t') || 'hash_failed'));
    else job.resolve(Buffer.from(parts[1], 'hex'));
    if (pending.size === 0) touchChild(proc, false);
  });
  proc.on('error', (err) => failPending(err instanceof Error ? err : new Error(String(err))));
  proc.on('exit', () => failPending(new Error('hash_worker_exit')));
  touchChild(proc, false);
  child = proc;
  return proc;
}

function boot() {
  if (worker) return worker;
  const w = new Worker(workerUrl);
  w.on('message', (msg) => {
    if (msg?.phase === 'start') {
      workerActive += 1;
      if (workerActive > workerMaxActive) workerMaxActive = workerActive;
      return;
    }
    const job = pending.get(msg?.id);
    if (!job) return;
    pending.delete(msg.id);
    if (workerActive > 0) workerActive -= 1;
    if (msg?.ok) job.resolve(Buffer.from(msg.hash));
    else job.reject(new Error(msg?.error || 'hash_failed'));
  });
  w.on('error', (err) => failPending(err instanceof Error ? err : new Error(String(err))));
  w.on('exit', () => failPending(new Error('hash_worker_exit')));
  if (typeof w.unref === 'function') w.unref();
  worker = w;
  return w;
}

function post(header) {
  const id = (seq += 1);
  const headerHex = Buffer.from(header).toString('hex');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      if (winChild()) {
        const proc = bootChild();
        touchChild(proc, true);
        workerActive += 1;
        if (workerActive > workerMaxActive) workerMaxActive = workerActive;
        proc.stdin.write(`${id}\t${headerHex}\n`);
      } else {
        boot().postMessage({ id, headerHex });
      }
    } catch (err) {
      pending.delete(id);
      if (workerActive > 0 && winChild()) workerActive -= 1;
      reject(err);
    }
  });
}

function releaseHashSlot() {
  active -= 1;
  completed += 1;
  const next = waiters.shift();
  if (!next) return;
  queued -= 1;
  next();
}

/**
 * Hash one 128-byte header off the accept thread.
 * At most P2P_VERIFY_CAP of these run at once; the rest wait and still hash.
 */
export function hashHeaderOffLoop(header) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      started += 1;
      if (active > maxActive) maxActive = active;
      setImmediate(() => {
        post(header).then(resolve, reject).finally(releaseHashSlot);
      });
    };
    if (active < P2P_VERIFY_CAP) {
      run();
      return;
    }
    queued += 1;
    if (queued > maxQueued) maxQueued = queued;
    waiters.push(run);
  });
}

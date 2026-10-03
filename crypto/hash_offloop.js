/**
 * P2P ShearHash lane. RandomX runs in child processes so the HTTP accept
 * loop can serve /api/stats while a block or share batch is still verifying.
 * One process-global RandomX cache cannot be shared by two isolates, so
 * each lane is its own process. Cap stays at P2P_VERIFY_CAP.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashLaneBackend } from './hash_lane.js';

/** Keep in lockstep with node/src/p2p.js P2P_VERIFY_CAP. */
export const P2P_VERIFY_CAP = 2;

export { hashLaneBackend };

const childUrl = fileURLToPath(new URL('./hash_offloop_child.js', import.meta.url));

/** @type {import('node:child_process').ChildProcess[]} */
let children = [];
let seq = 0;

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
  const dead = children;
  children = [];
  for (const proc of dead) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  if (!pending.size) return;
  for (const [, job] of pending) job.reject(err);
  pending.clear();
}

function bootChild() {
  const proc = spawn(process.execPath, [childUrl], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  proc._inflight = 0;
  const rl = createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    const parts = line.split('\t');
    const id = Number(parts[0]);
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (proc._inflight > 0) proc._inflight -= 1;
    if (workerActive > 0) workerActive -= 1;
    if (parts[1] === 'ERR') job.reject(new Error(parts.slice(2).join('\t') || 'hash_failed'));
    else job.resolve(Buffer.from(parts[1], 'hex'));
    if (proc._inflight === 0) touchChild(proc, false);
  });
  proc.on('error', (err) => failPending(err instanceof Error ? err : new Error(String(err))));
  proc.on('exit', () => {
    if (!children.includes(proc)) return;
    failPending(new Error('hash_worker_exit'));
  });
  touchChild(proc, false);
  children.push(proc);
  return proc;
}

function pickChild() {
  while (children.length < P2P_VERIFY_CAP) bootChild();
  let best = children[0];
  for (const proc of children) {
    if ((proc._inflight || 0) < (best._inflight || 0)) best = proc;
  }
  return best;
}

function post(header) {
  const id = (seq += 1);
  const headerHex = Buffer.from(header).toString('hex');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    let proc;
    try {
      proc = pickChild();
      proc._inflight = (proc._inflight || 0) + 1;
      touchChild(proc, true);
      workerActive += 1;
      if (workerActive > workerMaxActive) workerMaxActive = workerActive;
      proc.stdin.write(`${id}\t${headerHex}\n`);
    } catch (err) {
      pending.delete(id);
      if (proc && proc._inflight > 0) proc._inflight -= 1;
      if (workerActive > 0) workerActive -= 1;
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

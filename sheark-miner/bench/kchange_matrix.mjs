#!/usr/bin/env node
// PSA k-change AC-UAF, full matrix (the CI test runs a slice of it):
// backend {interpreter, jit, jit-full} x threads {1, 4, 8, nproc} x D's delay
// after C goes live {0, 1, 5, 20, 100 ms, 1x and 2x one hash} x RUNS, plus
// chains of 3/5/10 at those delays. Pass: no crash (the child is watched; a
// signal exit is a crash, never a stall), and D goes live within one prep
// time of D (dLive < 2 * C's prep + 250 ms). Loopback stub pool only.
// Usage: node bench/kchange_matrix.mjs [RUNS=20] [backends=interpreter,jit,jit-full]
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMiningAddress } from '../../crypto/address.js';
import { admitBasePub } from '../../crypto/admit.js';
import { scanPub } from '../../crypto/blunote.js';
import { pointBytes } from '../../crypto/note.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.SHEARK_MINER || path.join(root, 'ShearK-Miner');
const SEED = randomBytes(32);
const MINING = encodeMiningAddress({ B: pointBytes(admitBasePub(SEED)), Y: scanPub(SEED) });
const NPROC = Math.max(1, Math.min(os.availableParallelism ? os.availableParallelism() : os.cpus().length, 16));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUNS = Number(process.argv[2] || 20);
const BACKENDS = (process.argv[3] || 'interpreter,jit,jit-full').split(',');

function hdr(prevByte, merkleByte) {
  const h = Buffer.alloc(128);
  h[0] = 1;
  h.fill(prevByte, 4, 36);
  h.fill(merkleByte, 36, 68);
  return h.toString('hex');
}
const job = (jobId, p, m, bits = 8) => ({ jobId, header: hdr(p, m), shareBits: bits, blockBits: 40, bits });

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(5);
  }
  return pred();
}

// One run: job A, then C (new parent: new key), then `chain` more new-key
// jobs. Each follow-up is sent `delay` ms after the previous job goes live
// ('live' = on the miner's "job X" line), or `delay` ms after it was sent
// ({ after: 'send' }). Returns the timeline (ms from start).
async function run({ backend = 'jit', threads = 4, delay = 'live', after = 'live', chain = 1, bits = 8, busy = false, tail = 2500 }) {
  const t0 = Date.now();
  const T = () => Date.now() - t0;
  const ev = { stats: [], submits: [], jobs: {}, sent: {}, exit: null, out: '', threads, hashrate: 0 };
  let sockRef = null;
  const server = net.createServer((sock) => {
    sockRef = sock;
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.method === 'login') sock.write(`${JSON.stringify({ id: m.id, result: { status: 'OK' }, job: job('A', 0x11, 0x22, bits) })}\n`);
        else if (m.method === 'submit') {
          ev.submits.push([T(), m.params.jobId]);
          sock.write(`${JSON.stringify(busy ? { id: m.id, error: 'busy' } : { id: m.id, result: { status: 'OK' } })}\n`);
        }
      }
    });
  });
  server.on('error', () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const child = spawn(bin, ['--backend', backend, '--pool', `127.0.0.1:${server.address().port}`, '--notls', '--user', 'rig1',
    '--blu', MINING, '--threads', String(threads), '--no-tune'], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Whole lines only, per stream: a chunk can end mid-line.
  const lineReader = () => {
    let part = '';
    return (d) => {
      const s = String(d);
      ev.out += s;
      part += s;
      const lines = part.split('\n');
      part = lines.pop();
      for (const l of lines) onLine(l);
    };
  };
  const onLine = (l) => {
    if (/^hashes=/.test(l)) {
      ev.stats.push(T());
      const hr = /hashrate=([\d.]+) (\w)?R\/s/.exec(l);
      if (hr) ev.hashrate = Number(hr[1]) * ({ k: 1e3, m: 1e6 }[hr[2]] || 1);
    }
    const m = /^job (\S+) /.exec(l);
    if (m && ev.jobs[m[1]] === undefined) ev.jobs[m[1]] = T();
  };
  child.stdout.on('data', lineReader());
  child.stderr.on('data', lineReader());
  const exited = new Promise((r) => child.on('exit', (code, signal) => { ev.exit = { code, signal, at: T() }; r(); }));
  const send = (j) => { ev.sent[j.jobId] = T(); sockRef.write(`${JSON.stringify({ method: 'job', params: j, ...j })}\n`); };
  try {
    await waitFor(() => ev.jobs.A !== undefined || ev.exit, 30_000);
    await sleep(1500);
    const seq = [job('C', 0x44, 0x22, bits)];
    for (let i = 0; i < chain; i++) seq.push(job(`D${i}`, 0x44, 0x30 + i, bits));
    send(seq[0]);
    for (let i = 1; i < seq.length && !ev.exit; i++) {
      const prev = seq[i - 1].jobId;
      if (after === 'live') await waitFor(() => ev.jobs[prev] !== undefined || ev.exit, 20_000);
      if (typeof delay === 'number') await sleep(delay);
      else if (typeof delay === 'function') await sleep(delay(ev));
      send(seq[i]);
    }
    const last = seq[seq.length - 1].jobId;
    await waitFor(() => ev.jobs[last] !== undefined || ev.exit, 20_000);
    await sleep(tail);
  } finally {
    if (!ev.exit) child.kill('SIGTERM');
    await Promise.race([exited, sleep(5000)]);
    server.close();
  }
  ev.killedByUs = ev.exit && ev.exit.signal === 'SIGTERM';
  return ev;
}

// One hash on one thread, from the last stats line before C.
const hashMs = (k) => (ev) => (ev.hashrate > 0 ? Math.round((k * ev.threads * 1000) / ev.hashrate) : 50);

const delays = [['live', 'live'], ['1', 1], ['5', 5], ['20', 20], ['100', 100], ['1xhash', hashMs(1)], ['2xhash', hashMs(2)]];
const threadSet = [...new Set([1, 4, 8, NPROC])];
let crashes = 0;
let slow = 0;
let total = 0;
const rows = [];
async function one(label, opts) {
  const ev = await run({ tail: 400, busy: true, ...opts });
  total += 1;
  const crashed = !(ev.killedByUs || (ev.exit && ev.exit.code === 0 && !ev.exit.signal));
  const last = `D${(opts.chain || 1) - 1}`;
  const prep = ev.jobs.C !== undefined ? ev.jobs.C - ev.sent.C : NaN;
  const dLive = ev.jobs[last] !== undefined ? ev.jobs[last] - ev.sent[last] : NaN;
  const late = !(dLive < 2 * prep + 250);
  if (crashed) crashes += 1;
  else if (late) slow += 1;
  if (crashed || late) console.log(`FAIL ${label}: exit=${JSON.stringify(ev.exit)} prepC=${prep} dLive=${dLive}\n${ev.out.slice(-600)}`);
  return { crashed, late, prep, dLive };
}
for (const backend of BACKENDS) {
  for (const threads of threadSet) {
    for (const [dl, delay] of delays) {
      let c = 0;
      let l = 0;
      let maxD = 0;
      for (let r = 0; r < RUNS; r++) {
        const res = await one(`${backend} x${threads} D@${dl} run ${r}`, { backend, threads, delay, threadsHint: threads });
        c += res.crashed;
        l += res.late;
        if (res.dLive > maxD) maxD = res.dLive;
      }
      const row = `${backend} x${threads} D@${dl}: runs=${RUNS} crashes=${c} late=${l} max_dLive_ms=${maxD}`;
      rows.push(row);
      console.log(row);
    }
  }
}
for (const n of [3, 5, 10]) {
  for (const [dl, delay] of delays) {
    let c = 0;
    let l = 0;
    const runs = Math.max(1, Math.ceil(RUNS / 4));
    for (let r = 0; r < runs; r++) {
      const res = await one(`chain ${n} jit x4 D@${dl} run ${r}`, { backend: 'jit', threads: 4, chain: n, delay });
      c += res.crashed;
      l += res.late;
    }
    const row = `chain ${n} jit x4 D@${dl}: runs=${runs} crashes=${c} late=${l}`;
    rows.push(row);
    console.log(row);
  }
}
console.log(`kchange_matrix total=${total} crashes=${crashes} late=${slow}`);
process.exit(crashes || slow ? 1 : 0);

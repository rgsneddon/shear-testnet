// PSA k-change review (PR146), P1 and P2. Every template change is a RandomX
// key change (the key covers the merkle root). Two bugs on that path:
// - P1, use-after-free: shear_commit_epoch made the live cache/dataset the
//   "stale" pair without draining the workers hashing on it, and the next
//   shear_prepare freed it: SIGSEGV when a new-key job landed within about
//   one hash after a key change went live.
// - P2, join stall: a new key during a running prep made the main thread
//   pthread_join that prep, so the pool socket, acks, submits and stats
//   stopped for the rest of the cache/dataset build.
// These runs watch the child process: a crash is an exit with a signal and
// fails the test; it is never read as a stall or a pass. Loopback stub pool
// and an offline C harness only.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMiningAddress } from '../../crypto/address.js';
import { admitBasePub } from '../../crypto/admit.js';
import { scanPub } from '../../crypto/blunote.js';
import { pointBytes } from '../../crypto/note.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.join(root, '..');
const bin = path.join(root, 'ShearK-Miner');
const linux = process.platform === 'linux';
const SEED = randomBytes(32);
const MINING = encodeMiningAddress({ B: pointBytes(admitBasePub(SEED)), Y: scanPub(SEED) });
const NPROC = Math.max(1, Math.min(os.availableParallelism ? os.availableParallelism() : os.cpus().length, 16));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const ev = { stats: [], submits: [], jobs: {}, sent: {}, exit: null, out: '' };
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
  const onData = (d) => {
    const s = String(d);
    ev.out += s;
    for (const l of s.split('\n')) {
      if (/^hashes=/.test(l)) ev.stats.push(T());
      const m = /^job (\S+) /.exec(l);
      if (m && ev.jobs[m[1]] === undefined) ev.jobs[m[1]] = T();
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
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

function alive(ev, what) {
  assert.ok(ev.killedByUs || (ev.exit && ev.exit.code === 0 && !ev.exit.signal),
    `${what}: the miner died: ${JSON.stringify(ev.exit)}\n${ev.out.slice(-1200)}`);
}

function maxGap(times, from, to) {
  const t = times.filter((x) => x >= from - 1300 && x <= to);
  let g = 0;
  for (let i = 1; i < t.length; i++) g = Math.max(g, t[i] - t[i - 1]);
  return g;
}

describe('PSA k-change P1: no use-after-free when a new key follows a key change', { skip: !linux }, () => {
  // CI-sized slice of AC-UAF; the full matrix is bench/kchange_matrix.mjs.
  const cases = [];
  for (const backend of ['interpreter', 'jit', 'jit-full']) {
    for (const delay of ['live', 1, 5, 20, 100]) cases.push({ backend, threads: 4, delay });
  }
  for (const threads of [1, NPROC]) cases.push({ backend: 'jit', threads, delay: 'live' });
  for (const c of cases) {
    it(`${c.backend} x${c.threads}: D ${c.delay === 'live' ? 'as C goes live' : `${c.delay} ms after C goes live`}`, async () => {
      const ev = await run({ ...c, busy: true });
      alive(ev, JSON.stringify(c));
      assert.ok(ev.jobs.C !== undefined, ev.out.slice(-800));
      assert.ok(ev.jobs.D0 !== undefined, `job D never went live\n${ev.out.slice(-800)}`);
      const prep = ev.jobs.C - ev.sent.C;
      const dLive = ev.jobs.D0 - ev.sent.D0;
      assert.ok(dLive < 2 * prep + 250, `job D live ${dLive} ms after D, C's prep took ${prep} ms`);
    });
  }
  for (const n of [3, 5, 10]) {
    it(`a chain of ${n} back-to-back new-key jobs (jit x4, 0 ms after each goes live, then 5 ms after each is sent)`, async () => {
      for (const opt of [{ delay: 'live', after: 'live' }, { delay: 5, after: 'send' }]) {
        const ev = await run({ backend: 'jit', threads: 4, chain: n, busy: true, ...opt });
        alive(ev, `chain ${n} ${JSON.stringify(opt)}`);
        assert.ok(ev.jobs[`D${n - 1}`] !== undefined, `last job never went live (${JSON.stringify(opt)})\n${ev.out.slice(-800)}`);
      }
    });
  }
});

// The C harness: workers check every digest against the golden corpus while
// the main thread changes key at 0/1/5/20/100 ms and one and two hash
// durations after each commit, with and without a second key mid-prep.
function buildHarness(extra = []) {
  const lib = process.env.SHEAR_RANDOMX_LIB || path.join(repo, 'crypto', 'randomx', 'build', 'librandomx.a');
  assert.equal(fs.existsSync(lib), true, `missing ${lib}: build the miner first`);
  const out = path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), `shear-kchange-${process.pid}`);
  const cxx = (process.env.CXX || 'g++').split(' ');
  const src = path.join(root, 'src');
  const r = spawnSync(cxx[0], [...cxx.slice(1), '-O2', '-pthread', ...extra, '-I', src, '-I', path.join(repo, 'crypto', 'randomx', 'src'),
    '-x', 'c', '-std=c11', path.join(root, 'tests', 'kchange_main.c'), path.join(src, 'shear_hash.c'), path.join(src, 'sha512.c'),
    path.join(src, 'sha256.c'), '-x', 'none', lib, '-o', out], { encoding: 'utf8', timeout: 600_000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return out;
}

describe('PSA k-change: key-change harness (golden digests, no crash, RSS bounded)', { skip: !linux }, () => {
  const golden = path.join(root, 'bench', 'golden_v12.txt');
  let exe;
  const runH = (backend, threads, changes, env = {}) => {
    exe = exe || buildHarness();
    const r = spawnSync(exe, [golden, backend, String(threads), String(changes)], { encoding: 'utf8', timeout: 900_000, env: { ...process.env, ...env } });
    assert.equal(r.signal, null, `harness killed by ${r.signal}\n${r.stdout.slice(-600)}${r.stderr.slice(-600)}`);
    assert.equal(r.status, 0, r.stdout.slice(-600) + r.stderr.slice(-600));
    const m = /kchange .* ok=(\d+) bad=(\d+) refused=(\d+) max_prepare_ms=([\d.]+) max_ready_ms=([\d.]+) rss_base_mb=(-?\d+) rss_max_mb=(\d+) never_ready=0/.exec(r.stdout);
    assert.ok(m, r.stdout);
    return { ok: +m[1], bad: +m[2], max_prepare_ms: +m[4], rss_base: +m[6], rss_max: +m[7], line: m[0] };
  };
  for (const [backend, threads, changes] of [['jit', 4, 70], ['jit', NPROC, 28], ['interpreter', 4, 14], ['jit-full', 4, 14]]) {
    for (const mid of [0, 1]) {
      it(`${backend} x${threads}, ${changes} key changes${mid ? ', a second key mid-prep' : ''}`, () => {
        const h = runH(backend, threads, changes, { KC_MID: String(mid) });
        assert.equal(h.bad, 0, h.line);
        assert.ok(h.ok > 0, h.line);
        // At most the live pair and one prep pair (plus VMs): no growth past the 10th change.
        assert.ok(h.rss_base < 0 || h.rss_max <= h.rss_base + 160, h.line);
      });
    }
  }
  it('cleanup', () => { if (exe) fs.rmSync(exe, { force: true }); });
});

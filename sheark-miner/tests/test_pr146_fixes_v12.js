// PR146 review fixes (ME lane + PSA): fallbacks, memory limits, VM slots,
// share grace, launchers, bench clock, labels. Linux-only process limits
// (ulimit -v) are used to make the 260 MiB dataset unallocatable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
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
const bin = process.platform === 'win32' ? path.join(root, 'ShearK-Miner.exe') : path.join(root, 'ShearK-Miner');
const SELFTEST = 'e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4';
const linux = process.platform === 'linux';
const SEED = randomBytes(32);
const MINING = encodeMiningAddress({ B: pointBytes(admitBasePub(SEED)), Y: scanPub(SEED) });

// bash -c with a kill timer; resolves { status, stdout, stderr }.
function runBash(cmd, ms = 10_000) {
  return new Promise((resolve) => {
    const c = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), ms);
    c.on('close', (status, signal) => { clearTimeout(t); resolve({ status: status ?? signal, stdout, stderr }); });
  });
}

// A loopback stub pool: answers login with `job`, records every line.
async function stubPool(onLine) {
  const lines = [];
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        lines.push(line);
        onLine(JSON.parse(line), sock, lines);
      }
    });
  });
  server.on('error', () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  return { server, lines, port: server.address().port };
}

function sh(cmd, opts = {}) {
  return spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 600_000, ...opts });
}

describe('PR146 P1-1: dataset alloc failure falls back to light JIT', () => {
  it('jit-full under a 360 MB address-space limit selftests on light JIT, not the interpreter', { skip: !linux }, () => {
    const r = sh(`ulimit -v 360000; exec "${bin}" --backend jit-full --selftest`);
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(r.stdout, new RegExp(`selftest ok ${SELFTEST} backend=jit\\b`));
    assert.match(r.stderr, /jit-full unavailable \(dataset alloc failed, \d+ MiB dataset\); using light JIT/);
    assert.doesNotMatch(out, /using interpreter/);
  });
  it('jit-full with room keeps the dataset', { skip: !linux }, () => {
    const r = sh(`exec "${bin}" --backend jit-full --selftest`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`selftest ok ${SELFTEST} backend=jit-full\\b`));
  });
});

// P1-2: the jit-full memory check reads the cgroup limit, not only
// MemAvailable (a 300 MB container on an 8 GB host was OOM-killed).
function rigRun(files) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'shear-memfx-'));
  for (const [p, v] of Object.entries(files)) {
    const full = path.join(tmp, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, v);
  }
  const out = path.join(tmp, 'rig_main');
  const cc = spawnSync('gcc', ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-format-truncation', '-I', path.join(root, 'src'),
    '-o', out, path.join(root, 'tests', 'rig_main.c'), path.join(root, 'src', 'rig.c')], { encoding: 'utf8', timeout: 600_000 });
  assert.equal(cc.status, 0, cc.stderr || cc.stdout);
  const r = spawnSync(out, [tmp], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const o = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return o;
}
const MEMINFO = 'MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\n';
const hasGcc = spawnSync('gcc', ['--version']).status === 0;

describe('PR146 P1-2: memory limit from cgroups', { skip: !linux || !hasGcc }, () => {
  it('cgroup v2 memory.max minus memory.current caps mem_avail', () => {
    const r = rigRun({ 'proc/meminfo': MEMINFO, 'sys/fs/cgroup/cgroup.controllers': 'memory\n',
      'sys/fs/cgroup/memory.max': '314572800\n', 'sys/fs/cgroup/memory.current': '52428800\n' });
    assert.equal(r.mem_avail, String(314572800 - 52428800));
    assert.match(r.mem_limit, /^262144000 \(cgroup v2 memory\.max 314572800, current 52428800/);
  });
  it('cgroup v2 memory.max = max leaves MemAvailable', () => {
    const r = rigRun({ 'proc/meminfo': MEMINFO, 'sys/fs/cgroup/cgroup.controllers': 'memory\n', 'sys/fs/cgroup/memory.max': 'max\n' });
    assert.equal(r.mem_avail, String(8192000 * 1024));
    assert.match(r.mem_limit, /^-1 \(none\)/);
  });
  it('the tightest cgroup v2 limit on the process path wins', () => {
    const r = rigRun({ 'proc/meminfo': MEMINFO, 'proc/self/cgroup': '0::/a/b\n', 'sys/fs/cgroup/cgroup.controllers': 'memory\n',
      'sys/fs/cgroup/a/memory.max': '1073741824\n', 'sys/fs/cgroup/a/memory.current': '0\n',
      'sys/fs/cgroup/a/b/memory.max': '2147483648\n', 'sys/fs/cgroup/a/b/memory.current': '0\n' });
    assert.equal(r.mem_avail, '1073741824');
  });
  it('cgroup v1 memory.limit_in_bytes minus usage caps mem_avail; the unlimited sentinel does not', () => {
    const r = rigRun({ 'proc/meminfo': MEMINFO, 'sys/fs/cgroup/memory/memory.limit_in_bytes': '536870912\n',
      'sys/fs/cgroup/memory/memory.usage_in_bytes': '1048576\n' });
    assert.equal(r.mem_avail, String(536870912 - 1048576));
    assert.match(r.mem_limit, /cgroup v1/);
    const u = rigRun({ 'proc/meminfo': MEMINFO, 'sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n' });
    assert.equal(u.mem_avail, String(8192000 * 1024));
  });
});

describe('PR146 P1-2: an explicit --backend jit-full does not bypass the memory check', { skip: !linux }, () => {
  it('under a 700 MB address-space limit jit-full degrades to jit before allocating', () => {
    const r = sh(`ulimit -v 700000; exec "${bin}" --backend jit-full --print-config`);
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(r.stdout.match(/\{[\s\S]*\}/)[0]);
    assert.equal(cfg.backend, 'jit');
    assert.match(r.stderr, /--backend jit-full needs about [\d.]+ GiB; [\d.]+ GiB usable \(RLIMIT_AS \d+, mapped \d+\); using light jit/);
  });
  it('launchers and the README no longer force --backend jit-full', () => {
    for (const f of ['example.sh', 'example.bat', 'README.md']) {
      assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /--backend jit-full/, f);
    }
  });
});

// P1-3: VM slots. The C harness is built with SHEAR_MAX_VM=8 so slot reuse
// and a full table are exercised with a handful of threads. It links
// crypto/randomx/build/librandomx.a (built by make -C sheark-miner), or
// SHEAR_RANDOMX_LIB; CXX (default g++) links the C++ RandomX objects.
function buildSlots() {
  const lib = process.env.SHEAR_RANDOMX_LIB || path.join(repo, 'crypto', 'randomx', 'build', 'librandomx.a');
  assert.equal(fs.existsSync(lib), true, `missing ${lib}: build the miner first`);
  const out = path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), `shear-vmslots-${process.pid}`);
  const cxx = (process.env.CXX || 'g++').split(' ');
  const src = path.join(root, 'src');
  const r = spawnSync(cxx[0], [...cxx.slice(1), '-O2', '-pthread', '-DSHEAR_MAX_VM=8', '-I', src, '-I', path.join(repo, 'crypto', 'randomx', 'src'),
    '-x', 'c', '-std=c11', path.join(root, 'tests', 'vm_slots_main.c'), path.join(src, 'shear_hash.c'), path.join(src, 'sha512.c'),
    path.join(src, 'sha256.c'), '-x', 'none', lib, '-o', out], { encoding: 'utf8', timeout: 600_000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return out;
}

describe('PR146 P1-3: RandomX VM slots', { skip: !linux }, () => {
  it('exited threads give their VM slot back; a full table refuses instead of sharing a VM', () => {
    const exe = buildSlots();
    for (const backend of ['jit', 'interpreter']) {
      const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 600_000, env: { ...process.env, SHEAR_BACKEND: backend } });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /max_threads=4\n/);
      assert.match(r.stdout, /reuse ok=30 bad=0 refused=0/, backend);
      assert.match(r.stdout, /full ok=8 bad=0 refused=2 checked_refused=2 zero_out=2/, backend);
    }
    fs.rmSync(exe, { force: true });
  });
  it('--threads above the VM table is capped with a log line', () => {
    const r = spawnSync(bin, ['--backend', 'interpreter', '--threads', '5000', '--print-config'], { encoding: 'utf8', timeout: 600_000 });
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(r.stdout.match(/\{[\s\S]*\}/)[0]);
    assert.equal(cfg.threads, 1020);
    assert.match(r.stderr, /--threads 5000 is above the 1020 hashing threads this build supports; using 1020/);
  });
});


// P2: a hash backend that cannot be set up never yields all-zero digests
// (they meet every target) for the miner to submit.
describe('PR146 P2: no zero-hash submits on setup failure', { skip: !linux }, () => {
  it('with no memory for any backend the miner exits non-zero and submits nothing', async () => {
    const header = Buffer.alloc(128);
    header[0] = 1;
    const job = { jobId: 'j1', header: header.toString('hex'), shareBits: 8, blockBits: 32, bits: 8 };
    const pool = await stubPool((msg, sock) => {
      if (msg.method === 'login') sock.write(`${JSON.stringify({ id: msg.id, result: { status: 'OK' }, job })}\n`);
    });
    const r = await runBash(`ulimit -v 120000; exec "${bin}" --backend interpreter --pool 127.0.0.1:${pool.port} --notls --user rig1 --blu ${MINING} --threads 1`);
    pool.server.close();
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /no hash backend/);
    assert.deepEqual(pool.lines.filter((l) => /submit/.test(l)), []);
  });

  it('threads whose VM cannot be created skip work instead of submitting all-zero digests', async () => {
    // Measured at the PR head: 64 interpreter threads under these limits
    // sent 16-25k submits with hash 00..00 in 6 s.
    const header = Buffer.alloc(128);
    header[0] = 1;
    const job = { jobId: 'j1', header: header.toString('hex'), shareBits: 8, blockBits: 32, bits: 8 };
    const pool = await stubPool((msg, sock) => {
      if (msg.method === 'login') sock.write(`${JSON.stringify({ id: msg.id, result: { status: 'OK' }, job })}\n`);
      else if (msg.method === 'submit') sock.write(`${JSON.stringify({ id: msg.id, result: { status: 'OK' } })}\n`);
    });
    const r = await runBash(`ulimit -s 512; ulimit -v 380000; exec "${bin}" --backend interpreter --pool 127.0.0.1:${pool.port} --notls --user rig1 --blu ${MINING} --threads 64`, 6000);
    pool.server.close();
    const zero = pool.lines.filter((l) => /"hash":"0{64}"/.test(l));
    assert.equal(zero.length, 0, `${zero.length} all-zero submits`);
    assert.match(r.stdout + r.stderr, /hash setup failed on this thread[^\n]*; skipping job j1/);
  });
});

// P2 share grace. The pool credits a previous job's share for 12 s
// (PREV_JOB_GRACE_MS) and a share at the previous share target for 12 s
// (noteConnShareBits); a share whose parent block changed is never
// credited. The miner keeps a queued share on exactly those terms.
describe('PR146 P2: queued shares follow the pool grace', () => {
  const keep = (age, sameGen, sameParent, sb, live) => {
    const r = spawnSync(bin, ['--share-keep-vector', String(age), String(sameGen), String(sameParent), String(sb), String(live)], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  it('a share on the live job at the live target is kept at any age', () => {
    for (const age of [0, 1000, 6000, 11500, 12500, 30000]) assert.equal(keep(age, 1, 1, 20, 20), 'keep', `age ${age}`);
  });
  it('a previous job on the same parent: kept below 12 s, dropped after', () => {
    for (const age of [0, 1000, 6000, 11500]) assert.equal(keep(age, 0, 1, 20, 20), 'keep', `age ${age}`);
    for (const age of [12500, 30000]) assert.equal(keep(age, 0, 1, 20, 20), 'drop', `age ${age}`);
  });
  it('a share target step-up: the old target is kept below 12 s, dropped after', () => {
    for (const age of [0, 1000, 6000, 11500]) {
      assert.equal(keep(age, 1, 1, 20, 24), 'keep', `same job age ${age}`);
      assert.equal(keep(age, 0, 1, 20, 24), 'keep', `prev job age ${age}`);
    }
    for (const age of [12500, 30000]) {
      assert.equal(keep(age, 1, 1, 20, 24), 'drop', `same job age ${age}`);
      assert.equal(keep(age, 0, 1, 20, 24), 'drop', `prev job age ${age}`);
    }
  });
  it('a parent change drops the share at any age (share_keep alone; see the previous-parent rule below)', () => {
    for (const age of [0, 1000, 6000, 11500, 12500, 30000]) assert.equal(keep(age, 0, 0, 20, 20), 'drop', `age ${age}`);
  });
});

// PSA r2-3 (ME ruling, option A, miner only): the pool credits a share on its
// one prevJob for PREV_JOB_GRACE_MS (12 s) after the job change, even across a
// parent change (pool/src/pool.js jobWithinGrace, resolveSubmitJob). The
// miner keeps the immediately previous gen (N-1), if it is the pool's prevJob,
// for PREV_PARENT_GRACE_MS (12 s less a 2 s margin) on a monotonic clock from
// the parent change, and drops N-2 and older at once.
describe('PR146 PSA r2-3: previous-parent shares of gen N-1 keep the pool grace', () => {
  const pp = (genBack, isPoolPrev, sinceMs) => {
    const r = spawnSync(bin, ['--prev-parent-vector', String(genBack), String(isPoolPrev), String(sinceMs)], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout.trim();
  };
  it('the margin constant sits 1-2 s inside the pool PREV_JOB_GRACE_MS', () => {
    const pool = fs.readFileSync(path.join(repo, 'pool/src/pool.js'), 'utf8');
    const poolMs = Number(pool.match(/export const PREV_JOB_GRACE_MS = ([\d_]+);/)[1].replace(/_/g, ''));
    assert.equal(poolMs, 12000);
    const src = fs.readFileSync(path.join(root, 'src/sheark_miner.c'), 'utf8');
    const m = src.match(/#define PREV_PARENT_GRACE_MS \(SHARE_GRACE_MS - (\d+)\)/);
    assert.ok(m, 'PREV_PARENT_GRACE_MS (SHARE_GRACE_MS - margin) missing');
    const margin = Number(m[1]);
    assert.ok(margin >= 1000 && margin <= 2000, `margin ${margin}`);
    assert.equal(Number(src.match(/#define SHARE_GRACE_MS (\d+)/)[1]), poolMs);
  });
  it('N-1 on the pool prevJob: kept inside the grace, dropped after it', () => {
    for (const t of [0, 1000, 6000, 9500, 9900]) assert.equal(pp(1, 1, t), 'keep', `since ${t}`);
    for (const t of [10000, 10500, 11500, 12500, 30000]) assert.equal(pp(1, 1, t), 'drop', `since ${t}`);
  });
  it('N-2 and older: dropped at once', () => {
    for (const back of [2, 3, 10]) for (const t of [0, 500, 6000]) assert.equal(pp(back, 1, t), 'drop', `back ${back} since ${t}`);
  });
  it('N-1 that is not the pool prevJob (the pool moved on with no new gen): dropped', () => {
    for (const t of [0, 500, 6000]) assert.equal(pp(1, 0, t), 'drop', `since ${t}`);
  });
});

function hdr(prevByte, merkleByte) {
  const h = Buffer.alloc(128);
  h[0] = 1;
  h.fill(prevByte, 4, 36);
  h.fill(merkleByte, 36, 68);
  return h.toString('hex');
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

function startMiner(port, extra = []) {
  const child = spawn(bin, ['--backend', 'jit', '--pool', `127.0.0.1:${port}`, '--notls', '--user', 'rig1', '--blu', MINING,
    '--threads', '4', '--no-tune', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.out = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.out += d; });
  child.done = new Promise((r) => child.on('close', r));
  return child;
}

describe('PR146 P2: queued shares survive busy back-off and a same-parent job change', { skip: !linux }, () => {
  it('shares of job A queued during busy replies are still sent after job B (same parent) goes live', async () => {
    const A = { jobId: 'A', header: hdr(0x11, 0x22), shareBits: 8, blockBits: 40, bits: 8 };
    const B = { jobId: 'B', header: hdr(0x11, 0x33), shareBits: 8, blockBits: 40, bits: 8 };
    let phase = 'ok';
    let sockRef = null;
    const after = [];
    const pool = await stubPool((msg, sock) => {
      sockRef = sock;
      if (msg.method === 'login') return sock.write(`${JSON.stringify({ id: msg.id, result: { status: 'OK' }, job: A })}\n`);
      if (msg.method !== 'submit') return;
      if (phase === 'busy') return sock.write(`${JSON.stringify({ id: msg.id, error: 'busy' })}\n`);
      if (phase === 'after') after.push(msg.params.jobId);
      sock.write(`${JSON.stringify({ id: msg.id, result: { status: 'OK' } })}\n`);
    });
    const m = startMiner(pool.port);
    try {
      assert.ok(await waitFor(() => pool.lines.some((l) => /"method":"submit"/.test(l)), 20_000), m.out);
      phase = 'busy';
      const seen = pool.lines.length;
      // Let job A shares pile up behind busy replies.
      assert.ok(await waitFor(() => pool.lines.slice(seen).filter((l) => /submit/.test(l)).length >= 3, 15_000), m.out);
      await new Promise((r) => setTimeout(r, 1500));
      sockRef.write(`${JSON.stringify({ method: 'job', params: B, ...B })}\n`);
      assert.ok(await waitFor(() => /job B /.test(m.out), 15_000), m.out);
      phase = 'after';
      await waitFor(() => after.length >= 1 && after.includes('A'), 8000);
    } finally {
      m.kill('SIGTERM');
      await m.done;
      pool.server.close();
    }
    assert.ok(after.includes('A'), `no job A share was sent after job B went live: ${after.join(',')}\n${m.out.slice(-1500)}`);
  });

  // PSA r2-3: A (parent P1) is gen N-1 and the pool's prevJob once C
  // (parent P2) is live. busyFor: ms after C is sent during which the stub
  // keeps answering busy (A's shares stay queued); then it acks. Returns each
  // submit after C was sent, as [jobId, ms since C was sent].
  async function parentChange({ busyFor, then = null, watchMs }) {
    const A = { jobId: 'A', header: hdr(0x11, 0x22), shareBits: 8, blockBits: 40, bits: 8 };
    const C = { jobId: 'C', header: hdr(0x44, 0x22), shareBits: 8, blockBits: 40, bits: 8 };
    let phase = 'ok';
    let sockRef = null;
    let cAt = 0;
    const after = [];
    const pool = await stubPool((msg, sock) => {
      sockRef = sock;
      if (msg.method === 'login') return sock.write(`${JSON.stringify({ id: msg.id, result: { status: 'OK' }, job: A })}\n`);
      if (msg.method !== 'submit') return;
      if (cAt) after.push([msg.params.jobId, Date.now() - cAt]);
      if (phase === 'busy' || (cAt && Date.now() - cAt < busyFor)) return sock.write(`${JSON.stringify({ id: msg.id, error: 'busy' })}\n`);
      sock.write(`${JSON.stringify({ id: msg.id, result: { status: 'OK' } })}\n`);
    });
    const m = startMiner(pool.port);
    try {
      assert.ok(await waitFor(() => pool.lines.some((l) => /"method":"submit"/.test(l)), 20_000), m.out);
      phase = 'busy';
      const seen = pool.lines.length;
      assert.ok(await waitFor(() => pool.lines.slice(seen).filter((l) => /submit/.test(l)).length >= 3, 15_000), m.out);
      await new Promise((r) => setTimeout(r, 1500)); // more A hits pile up
      cAt = Date.now();
      phase = 'timed';
      sockRef.write(`${JSON.stringify({ method: 'job', params: C, ...C })}\n`);
      assert.ok(await waitFor(() => /job C /.test(m.out), 15_000), m.out);
      if (then) await then(sockRef, m, cAt);
      await new Promise((r) => setTimeout(r, watchMs));
    } finally {
      m.kill('SIGTERM');
      await m.done;
      pool.server.close();
    }
    return { after, out: m.out };
  }

  it('a parent change keeps the N-1 (pool prevJob) shares inside the grace and sends them', async () => {
    const { after, out } = await parentChange({ busyFor: 0, watchMs: 3000 });
    const a = after.filter(([j]) => j === 'A');
    assert.ok(a.length >= 1, `no N-1 share sent after the parent change: ${JSON.stringify(after)}\n${out.slice(-1500)}`);
    assert.ok(a.every(([, t]) => t < 10_000), JSON.stringify(a));
    assert.ok(after.some(([j]) => j === 'C'), JSON.stringify(after));
  });

  it('N-1 shares still queued when the grace ends are dropped, never sent after it', async () => {
    // Busy for 11 s after C: A's shares wait behind back-off past 10 s.
    const { after, out } = await parentChange({ busyFor: 11_000, watchMs: 13_000 });
    const a = after.filter(([j]) => j === 'A');
    assert.ok(a.length >= 1, `the N-1 shares were not retried inside the grace: ${JSON.stringify(after)}\n${out.slice(-1500)}`);
    const late = a.filter(([, t]) => t >= 10_300);
    assert.deepEqual(late, [], `N-1 sent after the grace: ${JSON.stringify(late)}`);
    assert.ok(after.some(([j, t]) => j === 'C' && t >= 11_000), `no C share acked after the busy spell: ${JSON.stringify(after)}`);
  });

  it('N-2 shares (two gens back on the old parent) are dropped at once', async () => {
    const D = { jobId: 'D', header: hdr(0x44, 0x55), shareBits: 8, blockBits: 40, bits: 8 };
    let dRel = -1;
    const { after, out } = await parentChange({
      busyFor: 60_000, // every submit is answered busy, so A stays queued until D is live
      watchMs: 0,
      then: async (sock, m, cAt) => {
        // C's epoch settles first; D is still well inside C's N-1 window.
        await new Promise((r) => setTimeout(r, 2000));
        sock.write(`${JSON.stringify({ method: 'job', params: D, ...D })}\n`);
        assert.ok(await waitFor(() => /job D /.test(m.out), 15_000), m.out);
        dRel = Date.now() - cAt;
        await new Promise((r) => setTimeout(r, 4000)); // two full back-offs
      },
    });
    assert.ok(dRel >= 0 && dRel < 10_000, `D went live at ${dRel} ms, outside the N-1 grace\n${out.slice(-1500)}`);
    assert.ok(after.some(([j, t]) => j === 'D' && t > dRel), `no D submit: ${JSON.stringify(after)}\n${out.slice(-1500)}`);
    const n2 = after.filter(([j, t]) => j === 'A' && t > dRel);
    assert.deepEqual(n2, [], `N-2 shares sent after D went live: ${JSON.stringify(after)}`);
  });

  it('up to 4 submits in flight, each ack matched to its submit id', async () => {
    const A = { jobId: 'A', header: hdr(0x11, 0x22), shareBits: 8, blockBits: 40, bits: 8 };
    const held = [];
    let maxOut = 0;
    const ids = new Set();
    let busyOnce = null;
    const resent = [];
    const pool = await stubPool((msg, sock) => {
      if (msg.method === 'login') return sock.write(`${JSON.stringify({ id: msg.id, result: { status: 'OK' }, job: A })}\n`);
      if (msg.method !== 'submit') return;
      assert.ok(!ids.has(msg.id), `submit id ${msg.id} reused while in flight`);
      ids.add(msg.id);
      if (busyOnce && msg.params.nonce === busyOnce) resent.push(msg.id);
      held.push({ msg, sock });
      maxOut = Math.max(maxOut, held.length);
    });
    const m = startMiner(pool.port);
    let okCount = 0;
    try {
      assert.ok(await waitFor(() => held.length >= 4, 30_000), `held ${held.length}\n${m.out.slice(-800)}`);
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(held.length, 4, 'more than 4 in flight');
      // Answer out of order: busy for the oldest, OK for the rest.
      const [first, ...rest] = held.splice(0);
      for (const h of rest.reverse()) {
        ids.delete(h.msg.id);
        okCount++;
        h.sock.write(`${JSON.stringify({ id: h.msg.id, result: { status: 'OK' } })}\n`);
      }
      busyOnce = first.msg.params.nonce;
      ids.delete(first.msg.id);
      first.sock.write(`${JSON.stringify({ id: first.msg.id, error: 'busy' })}\n`);
      assert.ok(await waitFor(() => resent.length >= 1, 8000), 'the busy share was not re-sent');
      assert.ok(await waitFor(() => new RegExp(`accepted=(\\x1b\\[[0-9;]*m)?${okCount}\\b`).test(m.out), 5000), m.out.slice(-800));
    } finally {
      m.kill('SIGTERM');
      await m.done;
      pool.server.close();
    }
    assert.equal(maxOut, 4);
  });
});

// P2: the AFK launcher and both default files run jit-full (the miner's
// memory check now covers an explicit jit-full); --threads only when set.
describe('PR146 P2: AFK launcher defaults', { skip: process.platform === 'win32' }, () => {
  function runAfk(defaults) {
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'shear-afk-'));
    const fake = path.join(tmp, 'ShearK-Miner');
    fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
    const defs = path.join(tmp, 'defaults');
    fs.writeFileSync(defs, defaults);
    const script = fs.readFileSync(path.join(root, 'run-afk.sh'), 'utf8')
      .replace('/etc/default/sheark-v4-afk', defs)
      .replace('/opt/shear-v4/sheark-miner/ShearK-Miner', fake);
    const sp = path.join(tmp, 'run-afk.sh');
    fs.writeFileSync(sp, script, { mode: 0o755 });
    const r = spawnSync('bash', [sp], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter(Boolean);
  }
  const base = 'SHEARK_POOL=stratum+ssl://pool.example:443\nSHEARK_USER=rig1\nSHEARK_BLU=shm1x\n';
  it('the shipped defaults run jit-full', () => {
    for (const f of [path.join(root, 'sheark-v4-afk.default'), path.join(repo, 'scripts', 'packaging', 'sheark-miner.default.example')]) {
      const d = fs.readFileSync(f, 'utf8');
      assert.match(d, /^SHEARK_BACKEND=jit-full$/m, f);
      assert.doesNotMatch(d, /^SHEARK_BACKEND=jit$/m, f);
    }
  });
  it('the packaged launcher (sheark-run) also defaults to jit-full', () => {
    const run = fs.readFileSync(path.join(repo, 'scripts', 'packaging', 'sheark-run'), 'utf8');
    assert.match(run, /--backend "\$\{SHEARK_BACKEND:-jit-full\}"/);
  });
  it('no SHEARK_BACKEND means jit-full; no SHEARK_THREADS lets the miner choose', () => {
    const args = runAfk(base);
    assert.equal(args[args.indexOf('--backend') + 1], 'jit-full');
    assert.equal(args.includes('--threads'), false, args.join(' '));
    assert.ok(args.includes('--require-tls'));
  });
  it('SHEARK_THREADS and SHEARK_BACKEND still override', () => {
    const args = runAfk(`${base}SHEARK_THREADS=3\nSHEARK_BACKEND=jit\n`);
    assert.equal(args[args.indexOf('--backend') + 1], 'jit');
    assert.equal(args[args.indexOf('--threads') + 1], '3');
  });
  it('a bad SHEARK_THREADS is ignored, not passed through', () => {
    for (const t of ['0', 'abc', '-2']) {
      const args = runAfk(`${base}SHEARK_THREADS=${t}\n`);
      assert.equal(args.includes('--threads'), false, `${t}: ${args.join(' ')}`);
    }
  });
});

// P2: --bench timing and the mode labels.
describe('PR146 P2: bench clock and RandomX mode labels', () => {
  it('--bench 2 divides by the measured elapsed time (monotonic, sub-second)', () => {
    const r = spawnSync(bin, ['--backend', 'jit', '--bench', '2'], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const m = r.stdout.match(/bench hashes=(\d+) rate=([\d.]+) R\/s backend=jit elapsed=([\d.]+)s/);
    assert.ok(m, r.stdout);
    const [h, rate, el] = [Number(m[1]), Number(m[2]), Number(m[3])];
    assert.ok(el >= 2 && el < 2.5, `elapsed ${el}`);
    assert.ok(Math.abs(rate - h / el) <= Math.max(1, rate * 0.01), `rate ${rate} vs ${h / el}`);
  });
  it('print-config says rxMode full for jit-full and light otherwise', () => {
    for (const [b, mode] of [['jit-full', 'full'], ['jit', 'light'], ['interpreter', 'light']]) {
      const r = spawnSync(bin, ['--backend', b, '--print-config'], { encoding: 'utf8', timeout: 120_000 });
      assert.equal(r.status, 0, r.stderr);
      const cfg = JSON.parse(r.stdout.match(/\{[\s\S]*\}/)[0]);
      assert.equal(cfg.backend, b);
      assert.equal(cfg.rxMode, mode, b);
    }
  });
  it('the run banner names the RandomX mode in use', { skip: !linux }, async () => {
    const A = { jobId: 'A', header: hdr(0x11, 0x22), shareBits: 40, blockBits: 40, bits: 40 };
    const pool = await stubPool((msg, sock) => {
      if (msg.method === 'login') sock.write(`${JSON.stringify({ id: msg.id, result: { status: 'OK' }, job: A })}\n`);
    });
    const child = spawn(bin, ['--backend', 'jit-full', '--pool', `127.0.0.1:${pool.port}`, '--notls', '--user', 'rig1', '--blu', MINING,
      '--threads', '1', '--no-tune'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const done = new Promise((r) => child.on('close', r));
    await waitFor(() => /ShearK-Miner 2\.9 \(/.test(out), 20_000);
    child.kill('SIGTERM');
    await done;
    pool.server.close();
    assert.match(out, /ShearK-Miner 2\.9 \(ShearHash-v3, RandomX full\)/, out.slice(0, 600));
  });
});

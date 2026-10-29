// PR146 review fixes (ME lane + PSA): fallbacks, memory limits, VM slots,
// share grace, launchers, bench clock, labels. Linux-only process limits
// (ulimit -v) are used to make the 260 MiB dataset unallocatable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.join(root, '..');
const bin = process.platform === 'win32' ? path.join(root, 'ShearK-Miner.exe') : path.join(root, 'ShearK-Miner');
const SELFTEST = 'e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4';
const linux = process.platform === 'linux';

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
      assert.match(r.stdout, /full ok=8 bad=0 refused=2/, backend);
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

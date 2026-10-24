/**
 * Public x86_64 builds pin the ISA baseline, and scripts/isa_scan.py proves it.
 *
 * GitHub's ubuntu-26.04 gcc is configured --with-arch-64=x86-64-v3, so plain
 * -O2 there emits AVX2, and -DARCH=native ties RandomX to the build machine.
 * Either way a pack faults on a CPU without those extensions. Every build of a
 * shipped x86_64 artifact pins -march=x86-64 -mtune=generic; only the
 * runtime-dispatched kernels may use AVX2, and CI scans each artifact.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const BASE = '-march=x86-64 -mtune=generic';

function has(bin) {
  return spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0;
}
const python = ['python3', 'python'].find(has);
const PROBE_SKIP = process.platform === 'linux' && process.arch === 'x64' && has('gcc') && has('objdump') && python
  ? false
  : 'the scanner probes compile x86_64 ELF objects with gcc and read them with objdump (Linux x64, as CI runs)';

function scan(...files) {
  return spawnSync(python, [path.join(root, 'scripts/isa_scan.py'), ...files], { encoding: 'utf8' });
}

function cc(dir, name, src, flags, extra = []) {
  const c = path.join(dir, `${name}.c`);
  fs.writeFileSync(c, src);
  const out = path.join(dir, name.endsWith('.so') ? name : `${name}.o`);
  const r = spawnSync('gcc', [...flags.split(' ').filter(Boolean), '-O3', '-fPIC', ...extra, ...(name.endsWith('.so') ? ['-shared'] : ['-c']), '-o', out, c], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

// A loop gcc vectorises with ymm registers when AVX2 is allowed: no aliasing,
// a fixed trip count, -O3.
const LOOP = 'void add(int *restrict a, const int *restrict b) { for (int i = 0; i < 64; i++) a[i] += b[i] * 3; }\n';

describe('x86_64 ISA baseline', () => {
  it('the scanner passes baseline code and refuses AVX2 outside the dispatch kernels', { skip: PROBE_SKIP }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-'));
    try {
      const base = cc(dir, 'base', LOOP, BASE);
      assert.equal(scan(base).status, 0, scan(base).stderr);
      // What the ubuntu-26.04 runner builds with no -march: refused.
      const v3 = cc(dir, 'v3', LOOP, '-march=x86-64-v3');
      const r = scan(v3);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /v3\.o add: v\S+ .*%ymm/);
      // A dispatch object may hold AVX2.
      const kernel = cc(dir, 'sha256_avx2', LOOP, `${BASE} -mavx2`);
      assert.equal(scan(kernel).status, 0, scan(kernel).stderr);
      // In a linked file only the named dispatch functions may.
      const lib = cc(dir, 'lib.so', [
        '__attribute__((target("avx2"))) void sha256_oneshot_x8_avx2(int *restrict a, const int *restrict b) { for (int i = 0; i < 64; i++) a[i] += b[i] * 3; }',
        LOOP.replace('void add', 'void plain'),
      ].join('\n'), BASE);
      assert.equal(scan(lib).status, 0, scan(lib).stderr);
      const leak = cc(dir, 'leak.so', [
        '__attribute__((target("avx2"))) void helper(int *restrict a, const int *restrict b) { for (int i = 0; i < 64; i++) a[i] += b[i] * 3; }',
      ].join('\n'), BASE);
      const lr = scan(leak);
      assert.equal(lr.status, 1, lr.stdout);
      assert.match(lr.stderr, /leak\.so helper:/);
      // rep bsf for ctz prints as tzcnt and runs on any x86-64: not flagged.
      const ctz = cc(dir, 'ctz', 'int f(unsigned x) { return __builtin_ctz(x); }\n', BASE);
      assert.equal(scan(ctz).status, 0, scan(ctz).stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every RandomX build goes through scripts/randomx_build.sh, which pins the baseline', () => {
    const rx = read('scripts/randomx_build.sh');
    assert.match(rx, /BASE="-march=x86-64 -mtune=generic"/);
    assert.match(rx, /-DARCH="\$ARCH"/);
    assert.match(rx, /ARCH=default/);
    assert.match(rx, /-DCMAKE_C_FLAGS="\$BASE" -DCMAKE_CXX_FLAGS="\$BASE"/);
    const builders = [
      ...fs.readdirSync(path.join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`),
      'sheark-miner/Makefile', 'crypto/native/Makefile', 'wallet/native/build-shear-v3.sh',
      'node/pack/pack_macos.sh', 'scripts/packaging/build-inside.sh',
    ];
    for (const rel of builders) {
      const text = read(rel);
      assert.doesNotMatch(text, /cmake\s+-S\s+\S*randomx/, `${rel} configures RandomX itself`);
      assert.doesNotMatch(text, /-DARCH=native/, `${rel} builds RandomX for the build machine`);
    }
    // The PowerShell wallet build cannot call the bash script; it passes the same flags.
    const ps = read('wallet/native/build-shear-v3.ps1');
    assert.match(ps, /\$Base = @\('-march=x86-64', '-mtune=generic'\)/);
    assert.match(ps, /-DARCH=default -DCMAKE_BUILD_TYPE=Release `\r?\n\s+"-DCMAKE_C_FLAGS=\$\(\$Base -join ' '\)" "-DCMAKE_CXX_FLAGS=\$\(\$Base -join ' '\)"/);
    assert.match(ps, /& \$Gcc @Base /);
    assert.match(ps, /& \$Gxx @Base /);
  });

  it('every C compile and link of a shipped binary carries the baseline', () => {
    for (const rel of ['miner/Makefile', 'sheark-miner/Makefile', 'crypto/native/Makefile']) {
      const mk = read(rel);
      assert.match(mk, /X86_BASELINE := -march=x86-64 -mtune=generic/, rel);
      const rules = mk.split('\n').filter((l) => /^\t\$\((CC|CXX)\) /.test(l));
      assert.ok(rules.length >= 2, rel);
      for (const l of rules) assert.match(l, /^\t\$\((CC|CXX)\) \$\(X86_BASELINE\) \$\(CFLAGS\)/, `${rel}: ${l}`);
    }
    const sh = read('wallet/native/build-shear-v3.sh');
    const lines = sh.split('\n').filter((l) => /^\s*(gcc|g\+\+|c\+\+) /.test(l));
    assert.equal(lines.length, 10);
    for (const l of lines) assert.match(l, /^\s*(gcc|g\+\+|c\+\+) \$BASE /, l);
    assert.match(sh, /x86_64\|amd64\) BASE="-march=x86-64 -mtune=generic"/);
  });

  it('CI scans every packed x86_64 artifact after it is built', () => {
    const wf = (f) => read(`.github/workflows/${f}`);
    const native = 'python3 scripts/isa_scan.py crypto/randomx/build/librandomx.a crypto/native/shearhash.node crypto/native/shearadmit.node';
    for (const f of ['full-suite.yml', 'day-one.yml', 'shear-fs1.yml', 'node-linux.yml', 'node-arch-opensuse.yml']) {
      assert.ok(wf(f).includes(native), f);
    }
    assert.equal(wf('node-v17.yml').split(native).length - 1, 3);
    assert.ok(wf('full-suite.yml').includes('python3 scripts/isa_scan.py miner/src/*.o miner/Shear-Miner sheark-miner/src/*.o sheark-miner/ShearK-Miner crypto/randomx/build/librandomx.a'));
    const packs = wf('sheark-packs.yml');
    assert.equal(packs.split('python3 scripts/isa_scan.py sheark-miner/src/*.o sheark-miner/ShearK-Miner crypto/randomx/build/librandomx.a').length - 1, 2);
    assert.ok(packs.includes('python scripts/isa_scan.py sheark-miner/src/*.o sheark-miner/ShearK-Miner.exe crypto/randomx/build/librandomx.a'));
    assert.ok(wf('wallet-tests.yml').includes('python3 scripts/isa_scan.py wallet/native/libshear_v3.so crypto/randomx/build/librandomx.a crypto/native/admit/target/release/libshear_admit.so'));
    const rel = wf('wallet-release.yml');
    assert.ok(rel.includes('python3 ../scripts/isa_scan.py ../wallet/native/libshear_v3.so ../crypto/randomx/build/librandomx.a ../crypto/native/admit/target/release/libshear_admit.so'));
    assert.ok(rel.includes('python scripts/isa_scan.py wallet/native/shear_v3.dll crypto/randomx/build-win/librandomx.a crypto/native/admit/target/release/shear_admit.dll'));
    assert.match(read('scripts/packaging/build-inside.sh'), /python3 "\$\{SRC\}\/scripts\/isa_scan\.py" "\$\{RX\}\/build\/librandomx\.a"/);
  });

  it('every job that builds and scans on the Linux host runs on ubuntu-24.04, not ubuntu-latest', () => {
    // ubuntu-latest (26.04) sets APT::Architecture-Variants "amd64v3": its static
    // libstdc++ and libgcc carry AVX2 whatever -march the build passes.
    const hostJobs = {
      'full-suite.yml': ['shard'], 'day-one.yml': ['node'], 'shear-fs1.yml': ['node-routes'],
      'sheark-packs.yml': ['linux'], 'wallet-tests.yml': ['spendable'], 'wallet-release.yml': ['linux'],
      'node-linux.yml': ['linux'], 'node-v17.yml': ['linux'],
    };
    for (const [f, jobs] of Object.entries(hostJobs)) {
      const text = read(`.github/workflows/${f}`).replace(/\r\n/g, '\n');
      for (const job of jobs) {
        const start = text.indexOf(`\n  ${job}:\n`);
        assert.ok(start >= 0, `${f} ${job}`);
        const rest = text.slice(start + job.length + 5);
        const body = rest.slice(0, rest.search(/\n  \S/) >= 0 ? rest.search(/\n  \S/) : rest.length);
        assert.match(body, /^    runs-on: ubuntu-24\.04$/m, `${f} ${job}`);
        assert.match(body, /isa_scan\.py/, `${f} ${job} scans`);
      }
    }
  });
});

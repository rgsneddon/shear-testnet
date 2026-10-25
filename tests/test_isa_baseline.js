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
  return spawnSync(bin, ['--version'], { timeout: 600_000, encoding: 'utf8' }).status === 0;
}
const python = ['python3', 'python'].find(has);
const PROBE_SKIP = process.platform === 'linux' && process.arch === 'x64' && has('gcc') && has('objdump') && python
  ? false
  : 'the scanner probes compile x86_64 ELF objects with gcc and read them with objdump (Linux x64, as CI runs)';

function scan(...files) {
  return spawnSync(python, [path.join(root, 'scripts/isa_scan.py'), ...files], { timeout: 600_000, encoding: 'utf8' });
}

function cc(dir, name, src, flags, extra = []) {
  const c = path.join(dir, `${name}.c`);
  fs.writeFileSync(c, src);
  const out = path.join(dir, name.endsWith('.so') ? name : `${name}.o`);
  const r = spawnSync('gcc', [...flags.split(' ').filter(Boolean), '-O3', '-fPIC', ...extra, ...(name.endsWith('.so') ? ['-shared'] : ['-c']), '-o', out, c], { timeout: 600_000, encoding: 'utf8' });
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
      assert.match(r.stderr, /v3\.o add \[avx\]: v\S+ .*%ymm/);
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
      assert.match(lr.stderr, /leak\.so helper \[avx\]:/);
      // rep bsf for ctz prints as tzcnt and runs on any x86-64: not flagged.
      const ctz = cc(dir, 'ctz', 'int f(unsigned x) { return __builtin_ctz(x); }\n', BASE);
      assert.equal(scan(ctz).status, 0, scan(ctz).stderr);
      // x86-64 v2 is above the baseline too: POPCNT in baseline code is refused,
      // and the same code at the baseline calls the libgcc helper instead.
      const POP = 'int g(unsigned x) { return __builtin_popcount(x); }\n';
      const pop = scan(cc(dir, 'pop', POP, `${BASE} -mpopcnt`));
      assert.equal(pop.status, 1, pop.stdout);
      assert.match(pop.stderr, /\[popcnt\]/);
      assert.equal(scan(cc(dir, 'pop_base', POP, BASE)).status, 0);
      // SSE3 is above the baseline in every function, a std one included: the
      // haddpd rustc's Windows default put in gimli's Value::from_u64 is
      // refused under that very name, and its SSE2 form passes.
      const GIMLI = '_RNvMs_NtNtCsjJ0bvPrw9X3_5gimli4read5valueNtB4_5Value8from_u64';
      const sum = (body, target) => [
        '#include <pmmintrin.h>',
        `${target}__m128d f(__m128d a) __asm__("${GIMLI}");`,
        `${target}__m128d f(__m128d a) { return ${body}; }`,
      ].join('\n') + '\n';
      const hadd = scan(cc(dir, 'gimli_sse3.so', sum('_mm_hadd_pd(a, a)', '__attribute__((target("sse3"))) '), BASE));
      assert.equal(hadd.status, 1, hadd.stdout);
      assert.ok(hadd.stderr.includes(`${GIMLI} [sse3]: haddpd`), hadd.stderr);
      const sse2 = cc(dir, 'gimli_sse2.so', sum('_mm_add_pd(a, _mm_unpackhi_pd(a, a))', ''), BASE);
      assert.equal(scan(sse2).status, 0);
      // scripts/scan_shipped_zip.py scans the members of the zip that ships.
      const zipOf = (name, entries) => {
        const z = path.join(dir, name);
        const r = spawnSync(python, ['-I', '-c', [
          'import sys, zipfile',
          'with zipfile.ZipFile(sys.argv[1], "w") as z:',
          '    for a in sys.argv[2:]:',
          '        n, _, p = a.partition("=")',
          '        z.write(p, n)',
        ].join('\n'), z, ...entries], { timeout: 600_000, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return z;
      };
      const shipped = (...args) => spawnSync(python, [path.join(root, 'scripts/scan_shipped_zip.py'), ...args], { timeout: 600_000, encoding: 'utf8' });
      const good = zipOf('good.zip', [`shear_admit.dll=${sse2}`]);
      assert.equal(shipped(good, '--built', `shear_admit.dll=${sse2}`, 'shear_admit.dll').status, 0);
      const bad = shipped(zipOf('bad.zip', [`shear_admit.dll=${path.join(dir, 'gimli_sse3.so')}`]), 'shear_admit.dll');
      assert.equal(bad.status, 1, bad.stdout);
      assert.ok(bad.stderr.includes(`${GIMLI} [sse3]: haddpd`), bad.stderr);
      const absent = shipped(good, 'shear_v3.dll');
      assert.notEqual(absent.status, 0);
      assert.match(absent.stderr, /missing \['shear_v3\.dll'\]/);
      const other = shipped(good, '--built', `shear_admit.dll=${path.join(dir, 'gimli_sse3.so')}`, 'shear_admit.dll');
      assert.notEqual(other.status, 0);
      assert.match(other.stderr, /shear_admit\.dll in the zip is not/);
      // A 16-byte CAS without CMPXCHG16B is a call to a lock-based helper: refused.
      const CAS = '_Bool c(unsigned __int128 *p, unsigned __int128 *e, unsigned __int128 v) { return __atomic_compare_exchange_n(p, e, v, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST); }\n';
      const cas = shipped(zipOf('cas.zip', [`shear_admit.dll=${cc(dir, 'cas.so', CAS, BASE)}`]), 'shear_admit.dll');
      assert.equal(cas.status, 1, cas.stdout);
      assert.match(cas.stderr, /128-bit atomic call\(s\) \['__atomic_compare_exchange_16'\]/);
      // AES-NI is RandomX's hard-AES kernel only: allowed in aes_hash.cpp.o,
      // refused in any other object.
      const AES = '#include <wmmintrin.h>\n__m128i e(__m128i a, __m128i k) { return _mm_aesenc_si128(a, k); }\n';
      assert.equal(scan(cc(dir, 'aes_hash.cpp', AES, `${BASE} -maes`)).status, 0, 'hard-AES object');
      const stray = scan(cc(dir, 'stray_aes', AES, `${BASE} -maes`));
      assert.equal(stray.status, 1, stray.stdout);
      assert.match(stray.stderr, /\[aes\]/);
      // In a linked file the hard-AES instances are RandomX's softAes=false
      // templates (Lb0E), given here the names RandomX's build gives them. The
      // <true> instances are the soft-AES fallback and may not hold AES-NI.
      const aesAs = (names) => '#include <wmmintrin.h>\n' + names.map((name, i) => [
        `__attribute__((target("aes"))) __m128i k${i}(__m128i a, __m128i k) __asm__("${name}");`,
        `__attribute__((target("aes"))) __m128i k${i}(__m128i a, __m128i k) { return _mm_aesenc_si128(a, k); }`,
      ].join('\n')).join('\n') + '\n';
      const hard = scan(cc(dir, 'rx_hard.so', aesAs([
        '_Z11fillAes1Rx4ILb0EEvPvmS0_',
        '_Z18hashAndFillAes1Rx4ILb0EEvPvmS0_S0_',
        '_ZN7randomx6VmBaseINS_18LargePageAllocatorELb0EE8allocateEv',
      ]), BASE));
      assert.equal(hard.status, 0, hard.stderr);
      for (const soft of ['_Z11fillAes1Rx4ILb1EEvPvmS0_', '_ZN7randomx6VmBaseINS_18LargePageAllocatorELb1EE8allocateEv']) {
        const sr = scan(cc(dir, 'rx_soft.so', aesAs([soft]), BASE));
        assert.equal(sr.status, 1, `${soft} ${sr.stdout}`);
        assert.ok(sr.stderr.includes(`${soft} [aes]`), sr.stderr);
      }
      // librandomx.a is scanned per member, and VmBase<..., false> lives in
      // virtual_machine.cpp.o, not aes_hash.cpp.o: the template name holds there.
      const vmHard = scan(cc(dir, 'virtual_machine.cpp', aesAs(['_ZN7randomx6VmBaseINS_16AlignedAllocatorILm64EEELb0EE8allocateEv']), BASE));
      assert.equal(vmHard.status, 0, vmHard.stderr);
      const vmSoft = scan(cc(dir, 'vm_soft.cpp', aesAs(['_ZN7randomx6VmBaseINS_16AlignedAllocatorILm64EEELb1EE8allocateEv']), BASE));
      assert.equal(vmSoft.status, 1, vmSoft.stdout);
      assert.ok(vmSoft.stderr.includes('Lb1EE8allocateEv [aes]'), vmSoft.stderr);
      // A kernel is allowed only its own extension: SHA-NI code may not use AVX2.
      const shaAvx = scan(cc(dir, 'sha256_ni', LOOP, `${BASE} -mavx2`));
      assert.equal(shaAvx.status, 1, shaAvx.stdout);
      assert.match(shaAvx.stderr, /sha256_ni\.o .*\[avx\]/);
      // An AVX2 kernel is entitled to AVX2 only. AVX-512 on ymm registers
      // (EVEX) and BMI2 there are refused: its CPU check tests neither.
      const TERN = '#include <immintrin.h>\n__m256i t(__m256i a, __m256i b, __m256i c) { return _mm256_ternarylogic_epi32(a, b, c, 0x96); }\n';
      const evex = scan(cc(dir, 'sha256_avx2', TERN, `${BASE} -mavx2 -mavx512f -mavx512vl`));
      assert.equal(evex.status, 1, evex.stdout);
      assert.match(evex.stderr, /sha256_avx2\.o t \[avx512\]: vpternlogd/);
      const ROT = 'unsigned r(unsigned x, unsigned n) { return x >> (n & 31); }\n';
      const bmi = scan(cc(dir, 'sha256_avx2', ROT, `${BASE} -mavx2 -mbmi2`));
      assert.equal(bmi.status, 1, bmi.stdout);
      assert.match(bmi.stderr, /sha256_avx2\.o r \[bmi\]: shrx/);
      // libstdc++'s random_device RDRAND/RDSEED sources are picked after a
      // cpuid check, so those three may hold them; RDRAND elsewhere is refused.
      const RD = (names) => names.map((name, i) => [
        `__attribute__((target("rdrnd"))) unsigned d${i}(void) __asm__("${name}");`,
        `__attribute__((target("rdrnd"))) unsigned d${i}(void) { unsigned v = 0; __builtin_ia32_rdrand32_step(&v); return v; }`,
      ].join('\n')).join('\n') + '\n';
      const rdOk = scan(cc(dir, 'rd_ok.so', RD(['_ZNSt12_GLOBAL__N_1L12__x86_rdrandEPv', '_ZNSt12_GLOBAL__N_1L12__x86_rdseedEPv']), BASE));
      assert.equal(rdOk.status, 0, rdOk.stderr);
      // The same three as ubuntu-24.04's gcc mangles them, with no L.
      const rdOkNoL = scan(cc(dir, 'rd_ok_nol.so', RD(['_ZNSt12_GLOBAL__N_112__x86_rdrandEPv', '_ZNSt12_GLOBAL__N_112__x86_rdseedEPv', '_ZNSt12_GLOBAL__N_119__x86_rdseed_rdrandEPv']), BASE));
      assert.equal(rdOkNoL.status, 0, rdOkNoL.stderr);
      // Another anonymous-namespace function with RDRAND is not entitled.
      const rdOther = scan(cc(dir, 'rd_other.so', RD(['_ZNSt12_GLOBAL__N_112__x86_rdbadEPv']), BASE));
      assert.equal(rdOther.status, 1, rdOther.stdout);
      const rdBad = scan(cc(dir, 'rd_bad.so', RD(['entropy_now']), BASE));
      assert.equal(rdBad.status, 1, rdBad.stdout);
      assert.match(rdBad.stderr, /rd_bad\.so entropy_now \[rdrand\]: rdrand/);
      // A compiler clone (.constprop, .isra, .part, .lto_priv, .cold) is the
      // function it was cloned from: entitled when that one is, and only then.
      const AVX2_AS = (names) => names.map((name, i) => [
        `__attribute__((target("avx2"))) void v${i}(int *restrict a, const int *restrict b) __asm__("${name}");`,
        `__attribute__((target("avx2"))) void v${i}(int *restrict a, const int *restrict b) { for (int j = 0; j < 64; j++) a[j] += b[j] * 3; }`,
      ].join('\n')).join('\n') + '\n';
      const clones = scan(cc(dir, 'clones.so', AVX2_AS(['sha256_oneshot_x8_avx2.constprop.0', 'randomx_argon2_fill_segment_avx2.isra.0', 'sha256_compress_x8.part.0.lto_priv.0']), BASE));
      assert.equal(clones.status, 0, clones.stderr);
      const rdClone = scan(cc(dir, 'rd_clone.so', RD(['_ZNSt12_GLOBAL__N_112__x86_rdrandEPv.cold']), BASE));
      assert.equal(rdClone.status, 0, rdClone.stderr);
      const badClone = scan(cc(dir, 'bad_clone.so', AVX2_AS(['helper.constprop.0']), BASE));
      assert.equal(badClone.status, 1, badClone.stdout);
      // Rust's legacy mangling spells the module path as v0 does.
      const rust = scan(cc(dir, 'rust.so', AVX2_AS(['_ZN16curve25519_dalek7backend6vector4avx25field17h0123456789abcdefE', '_RNvNtNtNtCs1_16curve25519_dalek7backend6vector4avx24mulx']), BASE));
      assert.equal(rust.status, 0, rust.stderr);
      const rustOther = scan(cc(dir, 'rust_other.so', AVX2_AS(['_ZN9other_crate4avx24mulx17h0123456789abcdefE']), BASE));
      assert.equal(rustOther.status, 1, rustOther.stdout);
      // AVX-512VL hides behind ymm: vpbroadcastd from a general register is
      // EVEX only, and an AVX2 kernel built with AVX-512VL on emits it.
      const SET1 = '#include <immintrin.h>\n__m256i s(int x) { return _mm256_set1_epi32(x); }\n';
      const bcast = scan(cc(dir, 'argon2_avx2.c', SET1, `${BASE} -mavx2 -mavx512f -mavx512vl`));
      assert.equal(bcast.status, 1, bcast.stdout);
      assert.match(bcast.stderr, /\[avx512\]: vpbroadcastd/);
      assert.equal(scan(cc(dir, 'argon2_avx2.c', SET1, `${BASE} -mavx2`)).status, 0, 'the AVX2 form of the same broadcast');
      // Instructions gcc will not emit on demand, classed straight from the table.
      const table = spawnSync(python, ['-I', '-c', [
        'import importlib.util, json, sys',
        `spec = importlib.util.spec_from_file_location("s", ${JSON.stringify(path.join(root, 'scripts/isa_scan.py'))})`,
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        'print(json.dumps({k: m.extension_of(k) for k in json.loads(sys.argv[1])}))',
      ].join('\n'), JSON.stringify([
        'sahf', 'lahf', 'cmpxchg16b (%rdi)', 'lock cmpxchg16b (%rdi)', 'vzeroupper', 'vldmxcsr (%rsp)',
        'phminposuw %xmm1,%xmm2', 'rex.W pshufb %xmm1,%xmm2', '{vex} vpaddd %xmm1,%xmm2,%xmm3',
        '{evex} vpaddd %xmm1,%xmm2,%xmm3', 'vpaddd %ymm17,%ymm2,%ymm3', 'vprord $7,%xmm1,%xmm2',
        'vfmadd231ps %ymm1,%ymm2,%ymm3', 'vcvtph2ps %xmm1,%ymm2', 'movbe (%rdi),%eax', 'lzcnt %eax,%ebx',
        'extrq $1,$2,%xmm1', 'adcx %eax,%ebx', 'rdrand %eax', 'tzcnt %eax,%ebx', 'pmuludq %xmm1,%xmm2',
        'vpaddd (%rax){1to8},%ymm1,%ymm2', 'vaddps {rn-sae},%ymm1,%ymm2,%ymm3', 'vucomiss {sae},%xmm1,%xmm2',
        'vpbroadcastd %edi,%ymm0', 'vpbroadcastd %xmm1,%ymm0', 'vpandd %ymm1,%ymm2,%ymm3', 'vpxorq %xmm1,%xmm2,%xmm3',
        'vpand %ymm1,%ymm2,%ymm3', 'vcvtps2qq %xmm1,%ymm2', 'vcvttpd2qq %ymm1,%ymm2', 'vcvtqq2pd %ymm1,%ymm2',
        'vrcp14ps %ymm1,%ymm2', 'vrsqrt14pd %xmm1,%xmm2', 'vpermw %ymm1,%ymm2,%ymm3', 'vpermd %ymm1,%ymm2,%ymm3',
        'vdbpsadbw $1,%ymm1,%ymm2,%ymm3', 'vpmultishiftqb %ymm1,%ymm2,%ymm3',
        'vaesenc %ymm1,%ymm2,%ymm3', 'vaesenc %xmm1,%xmm2,%xmm3', 'vpclmulqdq $0,%ymm1,%ymm2,%ymm3',
        'gf2p8mulb %xmm1,%xmm2', 'vgf2p8affineqb $0,%ymm1,%ymm2,%ymm3',
        'haddpd %xmm0,%xmm0', 'movddup %xmm1,%xmm9', 'movsldup %xmm3,%xmm4',
      ])], { timeout: 600_000, encoding: 'utf8' });
      assert.equal(table.status, 0, table.stderr);
      assert.deepEqual(JSON.parse(table.stdout), {
        sahf: 'v2', lahf: 'v2', 'cmpxchg16b (%rdi)': 'v2', 'lock cmpxchg16b (%rdi)': 'v2',
        vzeroupper: 'avx', 'vldmxcsr (%rsp)': 'avx', 'phminposuw %xmm1,%xmm2': 'sse41',
        'rex.W pshufb %xmm1,%xmm2': 'ssse3', '{vex} vpaddd %xmm1,%xmm2,%xmm3': 'avx',
        '{evex} vpaddd %xmm1,%xmm2,%xmm3': 'avx512', 'vpaddd %ymm17,%ymm2,%ymm3': 'avx512',
        'vprord $7,%xmm1,%xmm2': 'avx512', 'vfmadd231ps %ymm1,%ymm2,%ymm3': 'fma',
        'vcvtph2ps %xmm1,%ymm2': 'f16c', 'movbe (%rdi),%eax': 'movbe', 'lzcnt %eax,%ebx': 'bmi',
        'extrq $1,$2,%xmm1': 'sse4a', 'adcx %eax,%ebx': 'adx', 'rdrand %eax': 'rdrand',
        'tzcnt %eax,%ebx': null, 'pmuludq %xmm1,%xmm2': null,
        'vpaddd (%rax){1to8},%ymm1,%ymm2': 'avx512', 'vaddps {rn-sae},%ymm1,%ymm2,%ymm3': 'avx512',
        'vucomiss {sae},%xmm1,%xmm2': 'avx512', 'vpbroadcastd %edi,%ymm0': 'avx512',
        'vpbroadcastd %xmm1,%ymm0': 'avx', 'vpandd %ymm1,%ymm2,%ymm3': 'avx512', 'vpxorq %xmm1,%xmm2,%xmm3': 'avx512',
        'vpand %ymm1,%ymm2,%ymm3': 'avx', 'vcvtps2qq %xmm1,%ymm2': 'avx512', 'vcvttpd2qq %ymm1,%ymm2': 'avx512',
        'vcvtqq2pd %ymm1,%ymm2': 'avx512', 'vrcp14ps %ymm1,%ymm2': 'avx512', 'vrsqrt14pd %xmm1,%xmm2': 'avx512',
        'vpermw %ymm1,%ymm2,%ymm3': 'avx512', 'vpermd %ymm1,%ymm2,%ymm3': 'avx',
        'vdbpsadbw $1,%ymm1,%ymm2,%ymm3': 'avx512', 'vpmultishiftqb %ymm1,%ymm2,%ymm3': 'avx512',
        'vaesenc %ymm1,%ymm2,%ymm3': 'vaes', 'vaesenc %xmm1,%xmm2,%xmm3': 'avx',
        'vpclmulqdq $0,%ymm1,%ymm2,%ymm3': 'vpclmul', 'gf2p8mulb %xmm1,%xmm2': 'gfni',
        'vgf2p8affineqb $0,%ymm1,%ymm2,%ymm3': 'gfni',
        'haddpd %xmm0,%xmm0': 'sse3', 'movddup %xmm1,%xmm9': 'sse3', 'movsldup %xmm3,%xmm4': 'sse3',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Rust for the Windows x86_64 targets turns SSE3 and CMPXCHG16B off, in one place', () => {
    // rustc's Windows targets default to both (Linux stops at SSE2).
    const flag = 'rustflags = ["-C", "target-feature=-sse3,-cmpxchg16b"]';
    const cfg = read('.cargo/config.toml').replace(/\r\n/g, '\n');
    const table = (name) => cfg.split(/\n(?=\[)/).find((t) => t.startsWith(`[${name}]`)) || '';
    for (const t of ['x86_64-pc-windows-gnu', 'x86_64-pc-windows-msvc']) {
      assert.equal(table(`target.${t}`).replace(/\n+$/, ''), `[target.${t}]\n${flag}`, t);
    }
    // Only there: Linux and macOS builds keep their defaults.
    assert.equal(cfg.split('rustflags').length - 1, 2);
    assert.doesNotMatch(cfg, /^\[build\]/m);
    assert.doesNotMatch(read('crypto/native/admit/.cargo/config.toml'), /rustflags|^\[(build|target)/m);
    // std's code is generated again under the flags only with fat LTO.
    assert.match(read('crypto/native/admit/Cargo.toml').replace(/\r\n/g, '\n'), /\[profile\.release\]\nlto = true\n/);
    // RUSTFLAGS in the environment would replace the config's flags.
    const builds = [
      ...fs.readdirSync(path.join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`),
      'crypto/native/Makefile', 'wallet/windows/CMakeLists.txt', 'wallet/native/build-shear-v3.ps1',
    ];
    for (const rel of builds) assert.doesNotMatch(read(rel), /RUSTFLAGS/, rel);
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
      // cmd or PowerShell with mingw32-make has no uname: the CPU still decides.
      assert.match(mk, /\$\(PROCESSOR_ARCHITECTURE\)/, `${rel} falls back to PROCESSOR_ARCHITECTURE`);
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
    const winScan = 'python scripts/isa_scan.py wallet/native/shear_v3.dll crypto/randomx/build-win/librandomx.a crypto/native/admit/target/release/shear_admit.dll crypto/native/shearhash.node crypto/native/shearadmit.node';
    assert.ok(rel.includes(winScan), 'wallet-release windows scans its native libraries');
    assert.ok(wf('wallet-windows.yml').includes(winScan), 'wallet-windows scans its native libraries');
    // And the files inside the shipped zip, after it is packed and before it
    // is attached, proven the same files the vectors run on.
    const zipScan = 'python scripts/scan_shipped_zip.py wallet/dist/shear-wallet-${{ inputs.pin }}-windows.zip --built crypto/native/shearadmit.node=crypto/native/shearadmit.node --built crypto/native/shearhash.node=crypto/native/shearhash.node shear_admit.dll shear_v3.dll crypto/native/shearhash.node crypto/native/shearadmit.node';
    for (const f of ['wallet-release.yml', 'wallet-windows.yml']) {
      const text = wf(f);
      const at = text.indexOf(zipScan);
      assert.ok(at > text.indexOf('python wallet/pack/zip_windows.py'), `${f} scans the shipped zip after packing`);
      assert.ok(at < text.indexOf('gh release upload'), `${f} scans before attaching`);
      const after = text.slice(at);
      assert.ok(after.indexOf('node scripts/shipped_hash_vector.mjs') > 0, `${f} checks the hash vector`);
      assert.ok(after.indexOf('node --test --test-concurrency=1 crypto/range_packed.test.js crypto/fs1_pin.test.js crypto/fs1_fingerprint.test.js') > 0, `${f} runs the admit vectors`);
    }
    const minerZip = 'python scripts/scan_shipped_zip.py "dist/ShearK-Miner-$SHEARK_VER-windows.zip" --built ShearK-Miner.exe=sheark-miner/ShearK-Miner.exe ShearK-Miner.exe';
    assert.ok(packs.indexOf(minerZip) > packs.indexOf('node sheark-miner/tests/pack_windows.js'), 'the miner zip is scanned after packing');
    // The Windows wallet DLLs come from the GNU toolchain, so they keep symbols to scan.
    for (const f of ['wallet-release.yml', 'wallet-windows.yml']) {
      assert.match(wf(f), /rustup override set stable-x86_64-pc-windows-gnu/, f);
      assert.match(wf(f), /npm ci --ignore-scripts/, `${f} builds the node sidecar's node_modules`);
      // shear_v3.dll uses the same UCRT64 gcc as the addons, in its own step,
      // not whatever build-shear-v3.ps1 finds first.
      assert.match(wf(f), /SHEAR_MINGW_GCC = "\$\{\{ steps\.msys2\.outputs\.msys2-location \}\}\\ucrt64\\bin\\gcc\.exe"/, `${f} names the gcc`);
      assert.ok(wf(f).indexOf('-File wallet/native/build-shear-v3.ps1') > 0
        && wf(f).indexOf('-File wallet/native/build-shear-v3.ps1') < wf(f).indexOf('flutter build windows --release'), `${f} builds shear_v3.dll before Flutter`);
    }
    const inside = read('scripts/packaging/build-inside.sh');
    assert.match(inside, /python3 "\$\{SRC\}\/scripts\/isa_scan\.py" "\$\{RX\}\/build\/librandomx\.a"/);
    // The desktop build runs as builder and reconfigures RandomX; root built it.
    const own = inside.indexOf('chown -R builder:builder "${RX}/build"');
    assert.ok(own > 0 && own < inside.indexOf('as-builder flutter build linux'), 'build trees are builder\'s before the desktop build');
    // The desktop build rebuilds libshear_v3.so and the admit cdylib, so what
    // the bundle ships is scanned after it.
    const bundleScan = inside.indexOf('$(find "${BUNDLE_LIB}"');
    assert.ok(bundleScan > inside.indexOf('as-builder flutter build linux'), 'the shipped desktop libraries are scanned after the desktop build');
    assert.match(inside, /test -f "\$\{BUNDLE_LIB\}\/libshear_v3\.so"/);
    // Everything the image compiles for the bundle: the runner and every
    // plugin, both libraries required, only Flutter's own builds left out.
    assert.match(inside, /test -f "\$\{BUNDLE_LIB\}\/libshear_admit\.so"/);
    assert.match(inside, /isa_scan\.py" "\$\{RX\}\/build\/librandomx\.a" "\$\{BUNDLE\}\/shear_wallet"/);
    assert.match(inside, /-name '\*\.so' ! -name 'libflutter_linux_gtk\.so' ! -name 'libapp\.so'/);
    const linuxZip = read('.github/workflows/wallet-linux.yml');
    assert.match(linuxZip, /isa_scan\.py \$B\/shear_wallet \$\(find \$B\/lib -maxdepth 1 -type f -name '\*\.so' ! -name 'libflutter_linux_gtk\.so' ! -name 'libapp\.so'/);
    assert.match(linuxZip, /test -f \$B\/lib\/libshear_admit\.so/);
    // And they are built at the baseline, not the distro compiler's default.
    const cmake = read('wallet/linux/CMakeLists.txt');
    assert.match(cmake, /string\(APPEND CMAKE_C_FLAGS " -march=x86-64 -mtune=generic"\)/);
    assert.match(cmake, /string\(APPEND CMAKE_CXX_FLAGS " -march=x86-64 -mtune=generic"\)/);
    assert.ok(cmake.indexOf('CMAKE_CXX_FLAGS " -march') < cmake.indexOf('add_subdirectory'), 'set before the runner and plugins are added');
  });

  it('every job that builds and scans on the Linux host runs on ubuntu-24.04, not ubuntu-latest', () => {
    // ubuntu-latest (26.04) sets APT::Architecture-Variants "amd64v3": its static
    // libstdc++ and libgcc carry AVX2 whatever -march the build passes.
    const hostJobs = {
      'full-suite.yml': ['shard'], 'day-one.yml': ['node'], 'shear-fs1.yml': ['node-routes'],
      'sheark-packs.yml': ['linux'], 'wallet-tests.yml': ['spendable'], 'wallet-release.yml': ['linux'],
      'node-linux.yml': ['linux'], 'node-v17.yml': ['linux'], 'wallet-linux.yml': ['linux'],
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

// R41: rig detection (sheark-miner/src/rig.c) against fixture trees.
//
// Recorded: sheark-miner/tests/rig_fixtures/* were captured read-only from
// the test hosts by bench/capture_rig.sh (no host name recorded):
//   agentbox-milan-8t      EPYC Milan KVM, 4 cores / 8 threads
//   pool-milan-4t-taskset  EPYC Milan KVM, 2 cores / 4 threads, captured under taskset -c 0-2
//   p2pa-rome-2c, p2pb-rome-2c  EPYC Rome KVM, 2 cores, SMT off
// Constructed (no such device on hand; built here from the documented file
// layouts, and marked as such): Android with and without Termux, a
// Raspberry Pi 4, an ARM (Neoverse) server, ChromeOS Crostini, an x86
// desktop, and a container quota on the recorded agent-box tree.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const fixtures = path.join(here, 'rig_fixtures');
const linux = process.platform === 'linux';
let bin = '';

function compile() {
  const out = path.join(os.tmpdir(), `shear-rig-main-${process.pid}`);
  const cc = spawnSync('gcc', ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-format-truncation', '-I', src, '-o', out,
    path.join(here, 'rig_main.c'), path.join(src, 'rig.c')], { encoding: 'utf8', timeout: 600_000 });
  assert.equal(cc.status, 0, cc.stderr || cc.stdout);
  return out;
}

function run(root, env = {}) {
  const envFile = path.join(os.tmpdir(), `shear-rig-env-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  const r = spawnSync(bin, [root, envFile], { encoding: 'utf8', timeout: 60_000 });
  fs.rmSync(envFile, { force: true });
  assert.equal(r.status, 0, r.stderr);
  const o = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return o;
}

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-rigfx-'));
  for (const [p, v] of Object.entries(files)) {
    const full = path.join(root, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (v === null) fs.mkdirSync(full, { recursive: true });
    else fs.writeFileSync(full, v);
  }
  return root;
}

/* A sysfs topology: cores x threads per core, one L3 shared by all. */
function topo(cores, tpc, l3kb, extra = {}) {
  const f = {};
  const n = cores * tpc;
  f['sys/devices/system/cpu/online'] = `0-${n - 1}\n`;
  for (let cpu = 0; cpu < n; cpu++) {
    const core = cpu % cores;
    const d = `sys/devices/system/cpu/cpu${cpu}`;
    f[`${d}/topology/core_id`] = `${core}\n`;
    f[`${d}/topology/physical_package_id`] = '0\n';
    const sibs = [];
    for (let t = 0; t < tpc; t++) sibs.push(core + t * cores);
    f[`${d}/topology/thread_siblings_list`] = `${sibs.join(',')}\n`;
    f[`${d}/cache/index0/level`] = '1\n';
    f[`${d}/cache/index0/type`] = 'Data\n';
    f[`${d}/cache/index0/size`] = '32K\n';
    f[`${d}/cache/index1/level`] = '1\n';
    f[`${d}/cache/index1/type`] = 'Instruction\n';
    f[`${d}/cache/index1/size`] = '32K\n';
    f[`${d}/cache/index2/level`] = '2\n';
    f[`${d}/cache/index2/type`] = 'Unified\n';
    f[`${d}/cache/index2/size`] = '512K\n';
    if (l3kb) {
      f[`${d}/cache/index3/level`] = '3\n';
      f[`${d}/cache/index3/type`] = 'Unified\n';
      f[`${d}/cache/index3/size`] = `${l3kb}K\n`;
      f[`${d}/cache/index3/shared_cpu_list`] = `0-${n - 1}\n`;
    }
    if (extra.capacity) f[`${d}/cpu_capacity`] = `${extra.capacity(cpu)}\n`;
  }
  f['sys/devices/system/node/node0/cpulist'] = `0-${n - 1}\n`;
  f.affinity = `0-${n - 1}\n`;
  return f;
}

const MEM = 'MemTotal:       16000000 kB\nMemAvailable:   12000000 kB\nHugePages_Total:       0\nHugePages_Free:        0\nHugepagesize:       2048 kB\n';
const ARM_CPUINFO = (part, features, hw = '') => {
  let s = '';
  for (let i = 0; i < 4; i++) s += `processor\t: ${i}\nBogoMIPS\t: 108.00\nFeatures\t: ${features}\nCPU implementer\t: 0x41\nCPU architecture: 8\nCPU variant\t: 0x0\nCPU part\t: ${part}\nCPU revision\t: 3\n\n`;
  return s + hw;
};

describe('rig detection on recorded hosts and constructed devices (R41)', { skip: !linux && 'fixtures are Linux file trees' }, () => {
  before(() => { bin = compile(); });

  it('agent-box (recorded): 8 logical, 4 physical, SMT on, one 32 MiB L3, a VM, 8 threads', () => {
    const r = run(path.join(fixtures, 'agentbox-milan-8t'));
    assert.equal(r.phone, '0');
    assert.equal(r.cpu_vendor, 'AMD');
    assert.equal(r.cpu_model, 'AMD EPYC-Milan Processor');
    assert.equal(r.logical, '8');
    assert.equal(r.allowed, '8');
    assert.equal(r.physical, '4');
    assert.equal(r.smt, 'on');
    assert.equal(r.l3, '32.0 MiB x 1');
    assert.equal(r.numa_nodes, '1');
    assert.equal(r.device_type, 'server/VM');
    assert.match(r.features, /aes/);
    assert.match(r.features, /avx2/);
    assert.doesNotMatch(r.features, /avx512f/);
    assert.equal(r.default_threads, '8');
  });

  it('pool host (recorded under taskset -c 0-2): 4 logical, 3 usable, 2 physical, 3 threads', () => {
    const r = run(path.join(fixtures, 'pool-milan-4t-taskset'));
    assert.equal(r.logical, '4');
    assert.equal(r.allowed, '3');
    assert.equal(r.physical, '2');
    assert.equal(r.smt, 'on');
    assert.match(r.affinity, /^0-2 \(3 CPUs\)/);
    assert.equal(r.default_threads, '3');
  });

  for (const name of ['p2pa-rome-2c', 'p2pb-rome-2c']) {
    it(`${name} (recorded): 2 cores, SMT off, 2 threads`, () => {
      const r = run(path.join(fixtures, name));
      assert.equal(r.cpu_model, 'AMD EPYC-Rome Processor');
      assert.equal(r.logical, '2');
      assert.equal(r.physical, '2');
      assert.equal(r.smt, 'off');
      assert.equal(r.l3, '16.0 MiB x 1');
      assert.equal(r.default_threads, '2');
      assert.equal(r.phone, '0');
    });
  }

  it('a container quota (recorded agent-box tree + cgroup v2 cpu.max 250000/100000) caps threads at 3', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-rigq-'));
    fs.cpSync(path.join(fixtures, 'agentbox-milan-8t'), root, { recursive: true });
    fs.mkdirSync(path.join(root, 'sys/fs/cgroup'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sys/fs/cgroup/cpu.max'), '250000 100000\n');
    fs.writeFileSync(path.join(root, '.dockerenv'), '');
    const r = run(root);
    assert.equal(r.container, 'docker');
    assert.equal(r.device_type, 'container');
    assert.match(r.cgroup_quota, /^2\.50 CPUs/);
    assert.equal(r.default_threads, '3');
    assert.match(r.default_why, /quota/);
  });

  it('unknown values print "unknown", never a guess', () => {
    const r = run(tree({ 'etc/hostname': 'x\n' }));
    assert.equal(r.cpu_model, 'unknown');
    assert.equal(r.physical, '-1');
    assert.equal(r.smt, 'unknown');
    assert.equal(r.l3, 'unknown');
    assert.equal(r.device_type, 'unknown');
    assert.match(r.thermal, /^unavailable/);
  });

  it('Android with Termux (constructed) is a phone', () => {
    const root = tree({
      'proc/cpuinfo': ARM_CPUINFO('0xd41', 'fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics', 'Hardware\t: Qualcomm Technologies, Inc SM8250\n'),
      'proc/sys/kernel/osrelease': '4.19.157-perf-android11\n',
      'system/build.prop': 'ro.product.model=Pixel\n',
      'system/bin/getprop': '',
      'data/data/com.termux/files/usr/bin/sh': '',
    });
    const r = run(root, { PREFIX: '/data/data/com.termux/files/usr', TERMUX_VERSION: '0.118.1', ANDROID_ROOT: '/system', ANDROID_DATA: '/data' });
    assert.equal(r.phone, '1');
    assert.equal(r.device_type, 'phone');
    for (const sig of ['ANDROID_ROOT', 'TERMUX_VERSION', 'Termux path', '/system/build.prop', 'com.termux', 'Android kernel']) {
      assert.match(r.phone_why, new RegExp(sig.replace(/[/.]/g, '\\$&')), r.phone_why);
    }
  });

  it('Android without Termux (constructed): each signal alone is enough', () => {
    assert.equal(run(tree({ 'system/build.prop': '' })).phone, '1');
    assert.equal(run(tree({ x: '' }), { ANDROID_ROOT: '/system' }).phone, '1');
    assert.equal(run(tree({ x: '' }), { ANDROID_DATA: '/data' }).phone, '1');
    assert.equal(run(tree({ 'proc/sys/kernel/osrelease': '5.10.66-android12-9-00001-g1\n' })).phone, '1');
    assert.equal(run(tree({ 'apex/com.android.runtime/x': '' })).phone, '1');
  });

  it('a Raspberry Pi 4 (constructed) is not a phone: ARM, no AES, a board', () => {
    const root = tree({
      ...topo(4, 1, 0),
      'proc/cpuinfo': ARM_CPUINFO('0xd08', 'fp asimd evtstrm crc32 cpuid', 'Hardware\t: BCM2835\nModel\t\t: Raspberry Pi 4 Model B Rev 1.4\n'),
      'proc/device-tree/model': 'Raspberry Pi 4 Model B Rev 1.4\0',
      'proc/sys/kernel/osrelease': '6.1.0-rpi7-rpi-v8\n',
      'proc/meminfo': MEM,
      'etc/os-release': 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n',
    });
    const r = run(root);
    assert.equal(r.phone, '0');
    assert.equal(r.cpu_vendor, 'ARM');
    assert.match(r.features, /neon/);
    assert.doesNotMatch(r.features, /armv8-aes/);
    assert.equal(r.device_type, 'desktop');
    assert.equal(r.default_threads, '4');
  });

  it('an ARM server (constructed, Neoverse N1) is not a phone', () => {
    const root = tree({
      ...topo(8, 1, 32768),
      'proc/cpuinfo': ARM_CPUINFO('0xd0c', 'fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp ssbs'),
      'sys/class/dmi/id/chassis_type': '23\n',
      'sys/class/dmi/id/sys_vendor': 'Ampere(R)\n',
      'proc/sys/kernel/osrelease': '6.8.0-48-generic\n',
    });
    const r = run(root);
    assert.equal(r.phone, '0');
    assert.match(r.features, /armv8-aes/);
    assert.equal(r.device_type, 'server/VM');
  });

  it('ChromeOS Crostini (constructed: an LXC container, no Android files) is not a phone', () => {
    const root = tree({
      ...topo(4, 2, 8192),
      'proc/cpuinfo': 'processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: Intel(R) Core(TM) i5-10210U CPU @ 1.60GHz\ncpu family\t: 6\nmodel\t\t: 142\nstepping\t: 12\nflags\t\t: fpu sse4_1 aes avx avx2 hypervisor\n\n',
      'proc/1/cgroup': '0::/\n',
      'dev/lxd/sock': '',
      'etc/os-release': 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n',
      'proc/sys/kernel/osrelease': '6.6.46-04024-g9e7e147b4d6d\n',
    });
    const r = run(root);
    assert.equal(r.phone, '0');
    assert.equal(r.container, 'lxc');
    assert.equal(r.cpu_vendor, 'Intel');
  });

  it('an x86 desktop (constructed: 6 cores / 12 threads, chassis 3) is a desktop with SMT on', () => {
    const root = tree({
      ...topo(6, 2, 32768),
      'proc/cpuinfo': 'processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD Ryzen 5 5600X 6-Core Processor\ncpu family\t: 25\nmodel\t\t: 33\nstepping\t: 0\nflags\t\t: fpu sse4_1 aes avx avx2 sha_ni\n\n',
      'sys/class/dmi/id/chassis_type': '3\n',
      'sys/class/power_supply/AC/type': 'Mains\n',
      'sys/class/power_supply/AC/online': '1\n',
      'proc/meminfo': MEM,
    });
    const r = run(root);
    assert.equal(r.phone, '0');
    assert.equal(r.device_type, 'desktop');
    assert.equal(r.physical, '6');
    assert.equal(r.logical, '12');
    assert.equal(r.smt, 'on');
    assert.equal(r.cpu_fms, 'family 25 model 33 stepping 0');
    assert.equal(r.virt, 'none');
    assert.equal(r.default_threads, '12');
  });

  it('an affinity mask and an L3 cap both bound the default', () => {
    const root = tree({ ...topo(8, 2, 8192), affinity: '0-3,8-11\n' });
    const r = run(root);
    assert.equal(r.allowed, '8');
    assert.equal(r.default_threads, '4'); // 8 MiB L3 holds 4 scratchpads
    assert.match(r.default_why, /L3/);
  });
});

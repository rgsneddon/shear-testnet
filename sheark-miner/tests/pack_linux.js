#!/usr/bin/env node
// Build the current-version Linux ShearK-Miner zip with pack/zip_unix.py and
// check what it ships. Linux only: on any other OS this fails, it never skips.
// Run by the linux job of .github/workflows/sheark-packs.yml after
// `make -C sheark-miner`. It replaces the old "2.5 linux zip is ELF" case,
// which skipped whenever a stale dist/ zip was absent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  root, dist, version, runPacker, zipEntries, zipText, unzipTo,
  assertLaunchers, assertNotices, SELFTEST,
} from './pack_common.js';

assert.equal(process.platform, 'linux',
  `pack_linux.js builds and checks the Linux zip and must run on Linux, not ${process.platform}`);

const ver = version();
const bin = path.join(root, 'ShearK-Miner');
assert.ok(fs.existsSync(bin), `missing ${bin}; run make -C sheark-miner first`);
assert.equal(fs.readFileSync(bin).subarray(0, 4).toString('hex'), '7f454c46', 'built binary is not ELF');

const zip = path.join(dist, `ShearK-Miner-${ver}-linux.zip`);
fs.rmSync(zip, { force: true });
runPacker('zip_unix.py', ['linux']);
assert.ok(fs.existsSync(zip), `zip_unix.py did not write ${zip}`);

const entries = zipEntries(zip);
const names = [...entries.keys()];
const list = names.join(',');

const exe = entries.get('ShearK-Miner');
assert.ok(exe, `missing ShearK-Miner: ${list}`);
assert.equal(exe.head, '7f454c46', 'ShearK-Miner in the zip is not ELF');
assert.ok(!['cffaedfe', 'cefaedfe', 'feedface', 'feedfacf', 'cafebabe'].includes(exe.head), 'Mach-O in the Linux zip');
assert.equal(exe.mode, 0o755, `ShearK-Miner mode ${exe.mode.toString(8)}`);

const sh = entries.get('example.sh');
assert.ok(sh, `missing example.sh: ${list}`);
assert.equal(sh.mode, 0o755, `example.sh mode ${sh.mode.toString(8)}`);
assert.ok(entries.has('example.bat'), `missing example.bat: ${list}`);

// The bundled OpenSSL and libsodium (R28 share keys), and nothing from the
// GCC runtime (it is linked static).
const libs = names.filter((n) => /^lib(ssl|crypto|sodium)\.so(\.\d+)*$/.test(n));
assert.ok(libs.some((n) => n.startsWith('libssl.so')), `missing libssl.so*: ${list}`);
assert.ok(libs.some((n) => n.startsWith('libcrypto.so')), `missing libcrypto.so*: ${list}`);
assert.ok(libs.some((n) => n.startsWith('libsodium.so')), `missing libsodium.so*: ${list}`);
for (const lib of libs) {
  assert.equal(entries.get(lib).head, '7f454c46', `${lib} is not ELF`);
  assert.equal(entries.get(lib).mode, 0o644, `${lib} mode ${entries.get(lib).mode.toString(8)}`);
}
assert.equal(names.some((n) => /^lib(stdc\+\+|gcc_s)\.so/.test(n)), false, `GCC runtime shipped: ${list}`);
const elfs = names.filter((n) => entries.get(n).head === '7f454c46').sort();
assert.deepEqual(elfs, ['ShearK-Miner', ...libs].sort(), 'only the miner, its OpenSSL and libsodium are binaries');

assertNotices(names);
assert.ok(names.some((n) => n.startsWith('openssl-licenses/')), `missing openssl-licenses/: ${list}`);
assert.match(zipText(zip, 'RUNTIME-VERSIONS.txt'), /OpenSSL/);
const readme = zipText(zip, 'README.txt');
assert.equal(readme.split('\n')[0], `ShearK-Miner ${ver} (linux)`);
assert.match(readme, /stratum\+ssl:\/\/pool\.shear\.digital:443/);
assertLaunchers(zip, ver);

// Unpacked away from the build tree, the loader takes OpenSSL from the zip.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheark-linux-'));
try {
  unzipTo(zip, dir);
  const out = path.join(dir, 'ShearK-Miner');
  fs.chmodSync(out, 0o755);
  for (const f of ['ShearK-Miner', ...libs]) {
    const re = spawnSync('readelf', ['-d', path.join(dir, f)], { timeout: 600_000, encoding: 'utf8' });
    assert.equal(re.status, 0, `readelf ${f}: ${re.stderr}`);
    assert.match(re.stdout, /\((RUNPATH|RPATH)\)\s+Library (runpath|rpath): \[\$ORIGIN\]/, `${f} rpath:\n${re.stdout}`);
  }
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  const ldd = spawnSync('ldd', [out], { timeout: 600_000, encoding: 'utf8', env });
  assert.equal(ldd.status, 0, ldd.stderr);
  for (const want of ['libssl', 'libcrypto', 'libsodium']) {
    const line = ldd.stdout.split('\n').find((l) => l.includes(want));
    assert.ok(line && line.includes(`=> ${dir}/`), `${want} does not resolve inside the zip:\n${ldd.stdout}`);
  }
  for (const backend of ['interpreter', 'jit']) {
    const st = spawnSync(out, ['--backend', backend, '--selftest'], { timeout: 600_000, encoding: 'utf8', cwd: dir, env });
    assert.equal(st.status, 0, st.stdout + st.stderr);
    assert.ok(st.stdout.includes(SELFTEST), st.stdout);
  }
  const cfg = spawnSync(out, ['--backend', 'interpreter', '--print-config'], { timeout: 600_000, encoding: 'utf8', cwd: dir, env });
  assert.equal(cfg.status, 0, cfg.stdout + cfg.stderr);
  const j = JSON.parse(cfg.stdout.replace(/\x1b\[[0-9;]*m/g, '').match(/\{[\s\S]*\}/)[0]);
  assert.equal(j.version, ver);
  assert.equal(j.magic, 'shear-testnet-v12');
  assert.equal(j.tls, true);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`pack_linux ok ${zip} members ${names.length}`);

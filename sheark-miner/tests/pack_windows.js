#!/usr/bin/env node
// Build the current-version Windows ShearK-Miner zip with pack/zip_windows.py
// and check what it ships. Windows only: on any other OS this fails, it never
// skips. Run by the windows job of .github/workflows/sheark-packs.yml (MSYS2
// MINGW64 OpenSSL) after the exe is built. It replaces the test_miner.js case
// "2.9 windows zip bundles the OpenSSL DLLs", which skipped off win32.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  root, dist, version, runPacker, zipEntries, zipText, unzipTo,
  assertLaunchers, assertNotices, SELFTEST,
} from './pack_common.js';

assert.equal(process.platform, 'win32',
  `pack_windows.js builds and checks the Windows zip and must run on Windows, not ${process.platform}`);

const ver = version();
const exePath = path.join(root, 'ShearK-Miner.exe');
assert.ok(fs.existsSync(exePath), `missing ${exePath}; build ShearK-Miner.exe first`);
assert.equal(fs.readFileSync(exePath).subarray(0, 2).toString('hex'), '4d5a', 'built exe is not PE');

const zip = path.join(dist, `ShearK-Miner-${ver}-windows.zip`);
fs.rmSync(zip, { force: true });
runPacker('zip_windows.py');
assert.ok(fs.existsSync(zip), `zip_windows.py did not write ${zip}`);

const entries = zipEntries(zip);
const names = [...entries.keys()];
const list = names.join(',');
// R28: libsodium (the BluNotes one-time share keys) ships beside OpenSSL.
for (const need of ['ShearK-Miner.exe', 'example.bat', 'example.sh', 'libssl-3-x64.dll', 'libcrypto-3-x64.dll', 'libsodium-26.dll']) {
  assert.ok(entries.has(need), `missing ${need}: ${list}`);
}
assert.equal(entries.get('ShearK-Miner.exe').head.slice(0, 4), '4d5a', 'ShearK-Miner.exe in the zip is not PE');
const dlls = names.filter((n) => /\.dll$/i.test(n));
for (const dll of dlls) assert.equal(entries.get(dll).head.slice(0, 4), '4d5a', `${dll} is not PE`);
// The GCC runtime and winpthreads are linked static and never ship.
for (const rt of ['libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll']) {
  assert.equal(names.some((n) => n.toLowerCase() === rt), false, `${rt} shipped: ${list}`);
}
assert.equal(entries.get('example.sh').mode, 0o755, 'example.sh is not 0755 in the zip');
const exeOnly = names.filter((n) => n === 'ShearK-Miner.exe' || n === 'example.bat');
assert.ok(names.length > exeOnly.length, `exe+bat alone is not a ${ver} pack`);

assertNotices(names);
assert.match(zipText(zip, 'RUNTIME-VERSIONS.txt'), /OpenSSL/);
const readme = zipText(zip, 'README.txt');
assert.equal(readme.split(/\r?\n/)[0], `ShearK-Miner ${ver}`);
assert.match(readme, /Keep every DLL in this zip next to ShearK-Miner\.exe/);
assertLaunchers(zip, ver);

// Unpacked away from the build tree, with PATH cut to the Windows system
// directories, the exe starts on the DLLs in the zip alone.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheark-win-'));
try {
  unzipTo(zip, dir);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^path$/i.test(k)) env[k] = v;
  const sysroot = process.env.SystemRoot || 'C:\\Windows';
  env.PATH = `${path.join(sysroot, 'System32')};${sysroot}`;
  const out = path.join(dir, 'ShearK-Miner.exe');
  for (const backend of ['interpreter', 'jit']) {
    const st = spawnSync(out, ['--backend', backend, '--selftest'], { timeout: 600_000, encoding: 'utf8', cwd: dir, env });
    assert.equal(st.status, 0, `selftest ${backend} from the unpacked zip: ${st.error || ''}${st.stdout}${st.stderr}`);
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

console.log(`pack_windows ok ${zip} members ${names.length}`);

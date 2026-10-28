// Helpers for pack_linux.js and pack_windows.js. These scripts are outside the
// test_* glob: each builds a real pack with the repo's packer on its own OS,
// in the sheark-packs workflow, and fails on any other OS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repo = path.join(root, '..');
export const dist = path.join(repo, 'dist');

// The packers name the zip from SHEAR_VERSION, so the checks do too.
export function version() {
  const h = fs.readFileSync(path.join(root, 'src', 'shear_hash.h'), 'utf8');
  const m = h.match(/#define\s+SHEAR_VERSION\s+"([^"]+)"/);
  assert.ok(m, 'SHEAR_VERSION missing from shear_hash.h');
  return m[1];
}

export function python() {
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import zipfile,sys; sys.stdout.write("ok")'], { timeout: 600_000, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.includes('ok')) return c;
  }
  throw new Error('python with zipfile not found');
}

export function runPacker(script, args = []) {
  const r = spawnSync(python(), [path.join(root, 'pack', script), ...args], { timeout: 600_000, encoding: 'utf8', cwd: root });
  assert.equal(r.status, 0, `${script} ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

// name -> { mode (unix permission bits, 0 when unset), head (first 4 bytes hex) }
export function zipEntries(zipPath) {
  const r = spawnSync(python(), ['-I', '-c',
    'import json,sys,zipfile\n'
    + 'z=zipfile.ZipFile(sys.argv[1])\n'
    + 'print(json.dumps({i.filename: {"mode": (i.external_attr >> 16) & 0o777,'
    + ' "head": z.read(i.filename)[:4].hex()} for i in z.infolist() if not i.is_dir()}))',
    zipPath], { timeout: 600_000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return new Map(Object.entries(JSON.parse(r.stdout)));
}

// The member's exact bytes. Text-mode stdout on Windows turns each \n into
// \r\n, which would double a CRLF file's \r and give an LF file a \r.
export function zipText(zipPath, member) {
  const r = spawnSync(python(), ['-I', '-c',
    'import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))',
    zipPath, member], { timeout: 600_000 });
  assert.equal(r.status, 0, String(r.stderr));
  return new TextDecoder('utf-8', { fatal: true }).decode(r.stdout);
}

export function unzipTo(zipPath, dir) {
  const r = spawnSync(python(), ['-I', '-m', 'zipfile', '-e', zipPath, dir], { timeout: 600_000, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The sample launchers every flavor ships, checked inside the zip.
export function assertLaunchers(zipPath, ver) {
  const bat = zipText(zipPath, 'example.bat');
  const sh = zipText(zipPath, 'example.sh');
  assert.match(bat, /\r\n/, 'example.bat is CRLF in the zip');
  assert.doesNotMatch(sh, /\r/, 'example.sh is LF in the zip');
  for (const text of [bat, sh]) {
    assert.match(text, new RegExp(`ShearK-Miner ${esc(ver)} `));
    assert.match(text, /shear-testnet-v12/);
    assert.match(text, /stratum\+ssl:\/\/pool\.shear\.digital:443/);
    assert.match(text, /--user YOUR_SSA1\.worker/);
    assert.match(text, /--backend jit-full/);
    assert.doesNotMatch(text, /--tls-insecure|--tls-pin/);
  }
  assert.match(bat, new RegExp(`ShearK-Miner-${esc(ver)}-windows\\.zip`));
  assert.match(bat, /libssl-3-x64\.dll/);
  assert.match(bat, /libcrypto-3-x64\.dll/);
}

export function assertNotices(names) {
  for (const need of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.txt', 'RUNTIME-VERSIONS.txt']) {
    assert.ok(names.includes(need), `missing ${need}: ${names.join(',')}`);
  }
  assert.ok(names.some((n) => n.startsWith('LICENSES/')), `missing LICENSES/: ${names.join(',')}`);
}

export const SELFTEST = 'selftest ok e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4';

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
    // R28 option 2: a worker name and the mining address; never an ssa1 or --dest.
    // PR146 (2cae391a): no --backend on either line. The miner picks jit-full
    // and drops to light jit, then the interpreter, by itself; the packed exe's
    // mode is checked with assertAutoBackend. The lines are anchored so a flag
    // appended after the address is refused, not ignored.
    assert.match(text, /--pool stratum\+ssl:\/\/pool\.shear\.digital:443 --user (rig1|pc1) --blu YOUR_MINING_ADDRESS\r?$/m);
    // Solo names the mining address with --solo, to the user's own node only.
    assert.match(text, /--pool 127\.0\.0\.1:1111 --user (rig1|pc1) --blu YOUR_MINING_ADDRESS --solo\r?$/m);
    assert.doesNotMatch(text, /YOUR_SSA1|YOUR_SHE1|--dest/);
    assert.doesNotMatch(text, /--backend/, 'launchers leave the backend to auto-select');
    assert.doesNotMatch(text, /--tls-insecure|--tls-pin/);
  }
  assert.match(bat, new RegExp(`ShearK-Miner-${esc(ver)}-windows\\.zip`));
  assert.match(bat, /libssl-3-x64\.dll/);
  assert.match(bat, /libcrypto-3-x64\.dll/);
  assert.match(bat, /libsodium-26\.dll/);
}

export function assertNotices(names) {
  for (const need of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.txt', 'RUNTIME-VERSIONS.txt']) {
    assert.ok(names.includes(need), `missing ${need}: ${names.join(',')}`);
  }
  assert.ok(names.some((n) => n.startsWith('LICENSES/')), `missing LICENSES/: ${names.join(',')}`);
}

// The fallback ladder (shear_hash.c): jit-full, then light jit, then the
// interpreter. rxMode is "full" only for jit-full.
export const LADDER = ['jit-full', 'jit', 'interpreter'];

// --print-config from `exe` with no --backend, so it reports what auto-select
// chose. print-config exits before any connection. ulimitKb (Linux) caps the
// address space to force the light-jit step.
export function printConfig(exe, { cwd, env = process.env, ulimitKb = 0 } = {}) {
  const r = ulimitKb
    ? spawnSync('bash', ['-c', `ulimit -v ${Number(ulimitKb)} && exec "$0" --print-config`, exe], { timeout: 600_000, encoding: 'utf8', cwd, env })
    : spawnSync(exe, ['--print-config'], { timeout: 600_000, encoding: 'utf8', cwd, env });
  assert.equal(r.status, 0, `${exe} --print-config: ${r.error || ''}${r.stdout}${r.stderr}`);
  const m = r.stdout.replace(/\x1b\[[0-9;]*m/g, '').match(/\{[\s\S]*\}/);
  assert.ok(m, `no config JSON:\n${r.stdout}`);
  return JSON.parse(m[0]);
}

// The auto-selected backend is one of `allowed` (each a ladder step), and the
// mode label agrees with it.
export function assertAutoBackend(cfg, allowed = LADDER) {
  assert.ok(LADDER.includes(cfg.backend), `backend ${cfg.backend} is not a ladder step`);
  assert.ok(allowed.includes(cfg.backend), `backend ${cfg.backend}, expected one of ${allowed.join(', ')}`);
  assert.equal(cfg.rxMode, cfg.backend === 'jit-full' ? 'full' : 'light', `rxMode ${cfg.rxMode} for backend ${cfg.backend}`);
}

export const SELFTEST = 'selftest ok e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4';

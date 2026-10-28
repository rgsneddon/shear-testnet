// R41 (Russell 28 Oct): ShearK refuses to mine on phones, with no override.
// The shipped binary is driven through real local signals (the process
// environment Android sets); there is no flag, env var or config that turns
// the check off, and a refused run opens no socket. Fixture-tree cases
// (Termux files, a Pi, an ARM server, Crostini, x86) are in
// test_rig_detect_v12.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..');
const bin = path.join(dir, process.platform === 'win32' ? 'ShearK-Miner.exe' : 'ShearK-Miner');
const EXIT_PHONE = 86;
const MSG = /Mining on phones is not supported: it can overheat the device and damage the battery\./;

function clean(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ['ANDROID_ROOT', 'ANDROID_DATA', 'TERMUX_VERSION']) if (!(k in extra)) delete env[k];
  if (!('PREFIX' in extra) && String(env.PREFIX || '').includes('com.termux')) delete env.PREFIX;
  return env;
}

describe('ShearK refuses phones (R41)', () => {
  it('the exit code is defined once, in rig.h, and documented in the README', () => {
    const h = fs.readFileSync(path.join(dir, 'src', 'rig.h'), 'utf8');
    assert.match(h, /#define SHEARK_EXIT_PHONE 86/);
    const c = fs.readFileSync(path.join(dir, 'src', 'sheark_miner.c'), 'utf8');
    assert.equal((c.match(/return 86\b/g) || []).length, 0, 'use the named constant');
    assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /exit code 86/);
  });

  it('no flag, env var or config turns the check off', () => {
    const c = fs.readFileSync(path.join(dir, 'src', 'rig.c'), 'utf8') + fs.readFileSync(path.join(dir, 'src', 'sheark_miner.c'), 'utf8');
    assert.doesNotMatch(c, /allow[-_]?phone|ALLOW_PHONE|--force-phone|SHEARK_PHONE/i);
  });

  for (const [label, env] of [
    ['ANDROID_ROOT', { ANDROID_ROOT: '/system' }],
    ['ANDROID_DATA', { ANDROID_DATA: '/data' }],
    ['Termux PREFIX', { PREFIX: '/data/data/com.termux/files/usr' }],
    ['TERMUX_VERSION', { TERMUX_VERSION: '0.118.1' }],
  ]) {
    it(`${label}: exits ${EXIT_PHONE} before any hashing, on every mode`, () => {
      assert.equal(fs.existsSync(bin), true, `missing ${bin}`);
      for (const args of [['--selftest'], ['--verify', '00'.repeat(128)], ['--bench', '1'], ['--rig'], ['--help']]) {
        const r = spawnSync(bin, args, { env: clean(env), encoding: 'utf8', timeout: 60_000 });
        assert.equal(r.status, EXIT_PHONE, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, MSG);
        assert.doesNotMatch(r.stdout, /selftest|digest|bench hashes/);
      }
    });
  }

  it('a refused run makes no network connection', async () => {
    const server = net.createServer();
    let conns = 0;
    server.on('connection', (s) => { conns += 1; s.destroy(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const child = spawn(bin, ['--pool', `127.0.0.1:${port}`, '--notls', '--user', 'rig1', '--threads', '1'], {
      env: clean({ ANDROID_ROOT: '/system' }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => child.once('close', r));
    await new Promise((r) => setTimeout(r, 300));
    server.close();
    assert.equal(code, EXIT_PHONE, err);
    assert.equal(conns, 0);
  });

  it('this host (not a phone) still runs', () => {
    const r = spawnSync(bin, ['--backend', 'interpreter', '--selftest'], { env: clean({}), encoding: 'utf8', timeout: 600_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /selftest ok/);
  });
});

describe('no phone miner builds (R41)', () => {
  it('no Android or iOS target in the miner build, packs or their workflows', () => {
    const root = path.join(dir, '..');
    const files = [
      'sheark-miner/Makefile', 'sheark-miner/pack/zip_unix.py', 'sheark-miner/pack/zip_windows.py',
      '.github/workflows/sheark-packs.yml', '.github/workflows/sheark-macos.yml',
    ];
    for (const f of files) {
      const p = path.join(root, f);
      if (!fs.existsSync(p)) continue;
      const t = fs.readFileSync(p, 'utf8');
      assert.doesNotMatch(t, /android|\bios\b|iphone|ipados|aarch64-linux-android|arm64-apple-ios/i, f);
    }
  });
});

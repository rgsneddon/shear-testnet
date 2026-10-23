import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { defaultDataDir } from '../src/node.js';
import { acquireDatadirLock, DATADIR_LOCK_NAME } from '../src/datadir_lock.js';
import { defaultPoolDataDir } from '../../pool/src/pool_datadir.js';

const self = fileURLToPath(import.meta.url);

if (process.argv.includes('--lock-probe')) {
  const dir = process.argv[process.argv.indexOf('--lock-probe') + 1];
  try {
    createStore(dir);
    console.log('acquired');
    process.exit(0);
  } catch (err) {
    console.error(String(err?.message || err));
    process.exit(err?.code === 'datadir_in_use' ? 2 : 1);
  }
}

if (process.argv.includes('--lock-race')) {
  const dir = process.argv[process.argv.indexOf('--lock-race') + 1];
  const go = path.join(dir, 'go');
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(go)) {
    if (Date.now() > deadline) {
      console.error('race start missed');
      process.exit(3);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    acquireDatadirLock(dir);
    console.log('acquired');
    setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    console.error(`${err?.code || ''} ${err?.message || err}`);
    process.exit(err?.code === 'datadir_in_use' ? 2 : 1);
  }
}

function raceStarters(dir) {
  const kids = [0, 1].map(() => spawn(process.execPath, [self, '--lock-race', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  setTimeout(() => {
    try { fs.writeFileSync(path.join(dir, 'go'), '1'); } catch { /* ignore */ }
  }, 1500);
  return Promise.all(kids.map((child) => new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`starter hung\n${stdout}\n${stderr}`));
    }, 20_000);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  })));
}

describe('datadir lock', () => {
  it('refuses a second process and recovers a stale lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-'));
    const stalePid = 2_100_000_000;
    try { process.kill(stalePid, 0); } catch (err) {
      assert.notEqual(err.code, 'EPERM');
    }
    fs.writeFileSync(path.join(dir, DATADIR_LOCK_NAME), `${JSON.stringify({ pid: stalePid })}\n`);
    const opened = createStore(dir);
    assert.equal(typeof opened.tip, 'function');
    const heldInfo = JSON.parse(fs.readFileSync(path.join(dir, DATADIR_LOCK_NAME), 'utf8'));
    assert.equal(heldInfo.pid, process.pid);
    assert.equal(heldInfo.host, os.hostname());
    assert.equal(typeof heldInfo.startedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(heldInfo.startedAt)));
    assert.equal(typeof heldInfo.start, 'string');
    const again = createStore(dir);
    assert.equal(typeof again.tip, 'function');
    const junk = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-junk-'));
    fs.writeFileSync(path.join(junk, DATADIR_LOCK_NAME), 'not-json');
    assert.equal(typeof createStore(junk).tip, 'function');

    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-unreadable-'));
    fs.mkdirSync(path.join(blocked, DATADIR_LOCK_NAME));
    assert.throws(() => acquireDatadirLock(blocked), (err) => {
      assert.equal(err.code, 'datadir_lock_unreadable');
      assert.match(err.message, /datadir\.lock/);
      return true;
    });
    assert.equal(fs.statSync(path.join(blocked, DATADIR_LOCK_NAME)).isDirectory(), true);

    const held = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-held-'));
    const owner = createStore(held);
    assert.equal(typeof owner.tip, 'function');
    const child = spawnSync(process.execPath, [self, '--lock-probe', held], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(child.status, 2, `${child.stdout}\n${child.stderr}`);
    assert.match(`${child.stderr}`, /datadir in use/);
    assert.match(`${child.stderr}`, /pid /);
    assert.match(`${child.stderr}`, /datadir\.lock/);

    const reused = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-reused-'));
    fs.writeFileSync(path.join(reused, DATADIR_LOCK_NAME), `${JSON.stringify({ pid: 1, start: '1' })}\n`);
    assert.throws(() => acquireDatadirLock(reused), /delete /);
    assert.throws(() => acquireDatadirLock(reused), /datadir\.lock/);
  });

  it('two starters cannot both take a stale lock', async () => {
    const stalePid = 2_100_000_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-race-'));
    fs.writeFileSync(path.join(dir, DATADIR_LOCK_NAME), `${JSON.stringify({ pid: stalePid })}\n`);
    const results = await raceStarters(dir);
    const wins = results.filter((r) => r.code === 0 && /acquired/.test(r.stdout));
    const loses = results.filter((r) => r.code === 2);
    assert.equal(wins.length, 1, JSON.stringify(results));
    assert.equal(loses.length, 1, JSON.stringify(results));
    assert.match(loses[0].stderr, /datadir\.lock/);
    assert.match(loses[0].stderr, /datadir_in_use|datadir in use/);
  });

  it('a node and a pool on one host use different default folders', () => {
    const homedir = path.join('/home', 'shear');
    const nodeDir = defaultDataDir({ env: {}, homedir, platform: 'linux' });
    const poolDir = defaultPoolDataDir({ env: {}, homedir, platform: 'linux' });
    assert.notEqual(nodeDir, poolDir);
    assert.match(poolDir, /testnet-v11-pool$/);
    assert.match(nodeDir, /testnet-v11$/);
    const win = {
      env: { APPDATA: path.join('C:\\Users\\x\\AppData\\Roaming') },
      homedir: 'C:\\Users\\x',
      platform: 'win32',
      exists: () => false,
    };
    assert.notEqual(defaultDataDir(win), defaultPoolDataDir(win));
    const shared = defaultPoolDataDir({ env: { SHEAR_DATA: nodeDir }, homedir, platform: 'linux' });
    assert.equal(shared, nodeDir);

    const nodeBook = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-node-book-'));
    const poolBook = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pool-book-'));
    const nodeStore = createStore(nodeBook);
    assert.equal(typeof nodeStore.tip, 'function');
    const poolChild = spawnSync(process.execPath, [self, '--lock-probe', poolBook], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(poolChild.status, 0, `${poolChild.stdout}\n${poolChild.stderr}`);
    assert.match(poolChild.stdout, /acquired/);
    const blocked = spawnSync(process.execPath, [self, '--lock-probe', nodeBook], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(blocked.status, 2, `${blocked.stdout}\n${blocked.stderr}`);
    assert.match(`${blocked.stderr}`, /datadir\.lock/);
  });
});

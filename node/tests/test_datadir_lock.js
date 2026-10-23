import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { defaultDataDir } from '../src/node.js';
import { acquireDatadirLock, DATADIR_CLAIM_NAME, DATADIR_LOCK_NAME } from '../src/datadir_lock.js';
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

function raceStarters(dir, count = 2) {
  const kids = Array.from({ length: count }, () => spawn(process.execPath, [self, '--lock-race', dir], {
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
    const junkPath = path.join(junk, DATADIR_LOCK_NAME);
    fs.writeFileSync(junkPath, 'not-json');
    assert.throws(() => acquireDatadirLock(junk), (err) => {
      assert.equal(err.code, 'datadir_lock_corrupt');
      assert.match(err.message, /datadir\.lock/);
      return true;
    });
    assert.equal(fs.readFileSync(junkPath, 'utf8'), 'not-json');

    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-foreign-'));
    const foreignPath = path.join(foreign, DATADIR_LOCK_NAME);
    fs.writeFileSync(foreignPath, `${JSON.stringify({ pid: stalePid, host: 'other-host', start: '9' })}\n`);
    assert.throws(() => acquireDatadirLock(foreign), (err) => {
      assert.equal(err.code, 'datadir_lock_foreign');
      assert.match(err.message, /other-host/);
      assert.match(err.message, /datadir\.lock/);
      return true;
    });
    assert.equal(JSON.parse(fs.readFileSync(foreignPath, 'utf8')).host, 'other-host');

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
    assert.match(`${child.stderr}`, new RegExp(`pid ${process.pid}`));
    assert.match(`${child.stderr}`, new RegExp(os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(`${child.stderr}`, /delete /);
    assert.match(`${child.stderr}`, /datadir\.lock/);

    const reused = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-reused-'));
    fs.writeFileSync(path.join(reused, DATADIR_LOCK_NAME), `${JSON.stringify({ pid: 1, start: '1' })}\n`);
    assert.throws(() => acquireDatadirLock(reused), /delete /);
    assert.throws(() => acquireDatadirLock(reused), /datadir\.lock/);
  });

  it('three starters cannot all hold one stale lock', async () => {
    const stalePid = 2_100_000_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-race3-'));
    fs.writeFileSync(path.join(dir, DATADIR_LOCK_NAME), `${JSON.stringify({ pid: stalePid, host: os.hostname() })}\n`);
    const results = await raceStarters(dir, 3);
    const wins = results.filter((r) => r.code === 0 && /acquired/.test(r.stdout));
    const loses = results.filter((r) => r.code === 2);
    assert.equal(wins.length, 1, JSON.stringify(results));
    assert.equal(loses.length, 2, JSON.stringify(results));
    assert.match(loses[0].stderr, /datadir\.lock/);
    assert.match(loses[1].stderr, /datadir\.lock/);
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

  it('clears an abandoned claim and fails closed on a live one', () => {
    const stalePid = 2_100_000_000;
    const stat = fs.readFileSync('/proc/1/stat', 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    assert.ok(start);

    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-claim-foreign-'));
    const foreignClaim = path.join(foreign, DATADIR_CLAIM_NAME);
    fs.writeFileSync(foreignClaim, `${JSON.stringify({ pid: stalePid, host: 'other-host', start: '9' })}\n`);
    const foreignHeld = acquireDatadirLock(foreign);
    assert.equal(foreignHeld.pid || JSON.parse(fs.readFileSync(foreignHeld.path, 'utf8')).pid, process.pid);
    assert.equal(fs.existsSync(foreignClaim), false);

    const reused = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-claim-reused-'));
    const reusedClaim = path.join(reused, DATADIR_CLAIM_NAME);
    fs.writeFileSync(reusedClaim, `${JSON.stringify({ pid: 1, host: os.hostname(), start: 'not-the-live-start' })}\n`);
    const reusedHeld = acquireDatadirLock(reused);
    assert.equal(JSON.parse(fs.readFileSync(reusedHeld.path, 'utf8')).pid, process.pid);
    assert.equal(fs.existsSync(reusedClaim), false);

    const live = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-claim-live-'));
    const liveClaim = path.join(live, DATADIR_CLAIM_NAME);
    const body = `${JSON.stringify({ pid: 1, host: os.hostname(), start })}\n`;
    fs.writeFileSync(liveClaim, body);
    assert.throws(() => acquireDatadirLock(live), (err) => {
      assert.equal(err.code, 'datadir_in_use');
      assert.match(err.message, /pid 1/);
      assert.match(err.message, new RegExp(os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(err.message, /datadir\.lock\.claim/);
      assert.match(err.message, /delete /);
      return true;
    });
    assert.equal(fs.readFileSync(liveClaim, 'utf8'), body);
  });

  it('a node and a pool on one host use different default folders', () => {
    const homedir = path.join('/home', 'shear');
    const nodeDir = defaultDataDir({ env: {}, homedir, platform: 'linux' });
    const poolDir = defaultPoolDataDir({ env: {}, homedir, platform: 'linux' });
    assert.notEqual(nodeDir, poolDir);
    assert.match(poolDir, /testnet-v12-pool$/);
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

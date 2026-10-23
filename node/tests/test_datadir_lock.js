import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { DATADIR_LOCK_NAME } from '../src/datadir_lock.js';

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
    const again = createStore(dir);
    assert.equal(typeof again.tip, 'function');
    const junk = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-junk-'));
    fs.writeFileSync(path.join(junk, DATADIR_LOCK_NAME), 'not-json');
    assert.equal(typeof createStore(junk).tip, 'function');

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
  });
});

/**
 * The node datadir on Windows is a user-only DACL. The test directory is a
 * temp folder, never the Roaming Shear book and never shear-data.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDatadir } from '../src/datadir_acl.js';
import { createStore } from '../src/store.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-acl-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

function tempDatadir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-acl-dir-'));
  const roaming = path.join(String(process.env.APPDATA || ''), 'Shear');
  assert.ok(roaming.length > 6);
  assert.equal(dir.toLowerCase().startsWith(roaming.toLowerCase()), false);
  assert.equal(dir.toLowerCase().includes('shear-data'), false);
  return dir;
}

function aceIdentities(icaclsText, dir) {
  const wanted = String(dir).replace(/\//g, '\\').toLowerCase();
  const ids = [];
  for (const line of String(icaclsText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^successfully processed/i.test(trimmed)) continue;
    if (/^processed file:/i.test(trimmed) || /^failed processing/i.test(trimmed)) continue;
    const at = trimmed.lastIndexOf(':(');
    if (at <= 0) continue;
    let head = trimmed.slice(0, at).trim().replace(/\//g, '\\');
    if (head.toLowerCase().startsWith(wanted)) head = head.slice(dir.length).trim();
    if (head) ids.push(head);
  }
  return ids;
}

function sharedIdentity(id) {
  const name = String(id || '').trim();
  return /\\users$/i.test(name)
    || /^users$/i.test(name)
    || /\\everyone$/i.test(name)
    || /^everyone$/i.test(name)
    || /authenticated users$/i.test(name);
}

describe('datadir DACL', () => {
  it('does not pretend to set a DACL off Windows', () => {
    const dir = tempDatadir();
    let called = false;
    const got = ensureDatadir(dir, {
      platform: 'linux',
      execFileSync: () => {
        called = true;
        throw new Error('icacls');
      },
    });
    assert.equal(got.applied, false);
    assert.equal(called, false);
    assert.equal(fs.existsSync(dir), true);
  });

  it('sets a user-only DACL when the node opens a datadir', () => {
    if (process.platform !== 'win32') return;
    const dir = tempDatadir();
    createStore(dir);
    const user = execFileSync('whoami', { encoding: 'utf8', windowsHide: true }).trim();
    const text = execFileSync('icacls', [dir], { encoding: 'utf8', windowsHide: true });
    const ids = aceIdentities(text, dir);
    console.log(`datadir-acl user ${user} aces ${ids.join(' | ')}`);
    assert.deepEqual(ids.map((id) => id.toLowerCase()), [user.toLowerCase()], text);
    for (const id of ids) assert.equal(sharedIdentity(id), false, id);
  });
});

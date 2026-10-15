/**
 * The node datadir is private before the book opens.
 * The test directory is a temp folder, never the Roaming Shear book and
 * never shear-data. Windows ACL behaviour is exercised with a fake
 * whoami/icacls so the suite does not need a Windows host.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAGIC_REGTEST } from '../../crypto/regtest_bits.js';
import {
  ADMINISTRATORS_SID,
  SHEWALL_FILE,
  SYSTEM_SID,
  ensureDatadir,
  system32Exe,
} from '../src/datadir_acl.js';
import { startNode } from '../src/node.js';
import { createStore } from '../src/store.js';
import { createRegtestStore } from './regtest_store.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-acl-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

const USER_SID = 'S-1-5-21-1-2-3-1001';
const LOCAL_NAME = 'DESKTOP-ODTSQ56\\rgsne';
const WIN_ENV = { SystemRoot: 'C:\\Windows' };

function tempDatadir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-acl-dir-'));
  const resolved = path.resolve(dir);
  assert.equal(resolved.startsWith(path.resolve(os.tmpdir())), true);
  assert.equal(resolved.toLowerCase().includes('shear-data'), false);
  const homeBook = path.resolve(os.homedir(), '.shear');
  assert.equal(resolved.toLowerCase().startsWith(homeBook.toLowerCase()), false);
  const app = String(process.env.APPDATA || '').trim();
  if (app) {
    const roaming = path.resolve(app, 'Shear');
    assert.equal(resolved.toLowerCase().startsWith(roaming.toLowerCase()), false);
  }
  return dir;
}

function recordWindows(dir) {
  const calls = [];
  const execFileSync = (file, args) => {
    calls.push({ file: String(file), args: args.slice() });
    if (String(file).endsWith(`${path.win32.sep}whoami.exe`)) {
      return `"${LOCAL_NAME}","${USER_SID}"\r\n`;
    }
    return 'Successfully processed 1 files\r\n';
  };
  const got = ensureDatadir(dir, {
    platform: 'win32',
    env: WIN_ENV,
    execFileSync,
  });
  return { calls, got };
}

function icaclsCalls(calls) {
  return calls.filter((call) => call.file.endsWith(`${path.win32.sep}icacls.exe`));
}

describe('datadir DACL', () => {
  it('does not pretend to set a DACL off Windows', () => {
    const dir = tempDatadir();
    fs.chmodSync(dir, 0o755);
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
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  it('calls whoami and icacls by absolute System32 path', () => {
    const dir = tempDatadir();
    const { calls } = recordWindows(dir);
    const whoami = system32Exe('whoami.exe', WIN_ENV);
    const icacls = system32Exe('icacls.exe', WIN_ENV);
    assert.equal(path.win32.isAbsolute(whoami), true);
    assert.equal(whoami, 'C:\\Windows\\System32\\whoami.exe');
    assert.equal(icacls, 'C:\\Windows\\System32\\icacls.exe');
    assert.equal(calls.some((call) => call.file === whoami), true);
    assert.equal(calls.some((call) => call.file === icacls), true);
    assert.equal(calls.some((call) => call.file === 'whoami' || call.file === 'icacls'), false);
  });

  it('grants access by SID', () => {
    const dir = tempDatadir();
    const { calls } = recordWindows(dir);
    const granted = icaclsCalls(calls)
      .flatMap((call) => call.args)
      .filter((arg) => String(arg).includes(':(OI)(CI)F'));
    assert.deepEqual(granted, [
      `*${USER_SID}:(OI)(CI)F`,
      `*${SYSTEM_SID}:(OI)(CI)F`,
      `*${ADMINISTRATORS_SID}:(OI)(CI)F`,
    ]);
    const flat = calls.flatMap((call) => [call.file, ...call.args]).join('\n');
    assert.equal(flat.includes(LOCAL_NAME), false);
  });

  it('keeps SYSTEM and Administrators and sets the current user as owner', () => {
    const dir = tempDatadir();
    const { calls } = recordWindows(dir);
    const owner = icaclsCalls(calls).find((call) => call.args.includes('/setowner'));
    assert.ok(owner, 'setowner was not called');
    assert.equal(owner.args[0], dir);
    assert.deepEqual(owner.args.slice(1, 3), ['/setowner', `*${USER_SID}`]);
    const grants = icaclsCalls(calls).flatMap((call) => call.args).join('\n');
    assert.equal(grants.includes(`*${SYSTEM_SID}:(OI)(CI)F`), true);
    assert.equal(grants.includes(`*${ADMINISTRATORS_SID}:(OI)(CI)F`), true);
    assert.equal(grants.includes('*S-1-1-0:'), false);
    assert.equal(grants.includes('*S-1-5-11:'), false);
    assert.equal(grants.includes('*S-1-5-32-545:'), false);
  });

  it('re-checks existing files with /T', () => {
    const dir = tempDatadir();
    fs.writeFileSync(path.join(dir, 'chain.bin'), 'already there');
    const { calls } = recordWindows(dir);
    const walked = icaclsCalls(calls).filter((call) => call.args[0] === dir);
    assert.ok(walked.length >= 1);
    for (const call of walked) assert.equal(call.args.includes('/T'), true, call.args.join(' '));
  });

  it('covers shewall.bin', () => {
    const dir = tempDatadir();
    const shewall = path.join(dir, SHEWALL_FILE);
    fs.writeFileSync(shewall, 'sealed');
    fs.chmodSync(shewall, 0o644);
    const { calls } = recordWindows(dir);
    const named = icaclsCalls(calls).filter((call) => call.args[0] === shewall);
    assert.ok(named.some((call) => call.args.includes(`*${USER_SID}:F`)));
    assert.ok(named.some((call) => call.args.includes(`*${SYSTEM_SID}:F`)));
    assert.ok(named.some((call) => call.args.includes(`*${ADMINISTRATORS_SID}:F`)));
    assert.ok(named.some((call) => call.args.includes('/setowner') && call.args.includes(`*${USER_SID}`)));
    if (process.platform !== 'win32') {
      ensureDatadir(dir);
      assert.equal(fs.statSync(shewall).mode & 0o777, 0o600);
    }
  });

  it('does not run icacls again once the datadir is private', () => {
    const dir = tempDatadir();
    fs.writeFileSync(path.join(dir, SHEWALL_FILE), 'sealed');
    const first = recordWindows(dir);
    assert.ok(icaclsCalls(first.calls).length >= 1);
    const second = recordWindows(dir);
    assert.equal(second.got.applied, false);
    assert.equal(icaclsCalls(second.calls).length, 0);
    assert.equal(second.calls.some((call) => call.file.endsWith('whoami.exe')), true);
  });

  it('a chmod failure refuses to start', async () => {
    const dir = tempDatadir();
    fs.chmodSync(dir, 0o755);
    const chmod = mock.method(fs, 'chmodSync', () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    let started = null;
    try {
      await assert.rejects(
        () => startNode({
          dataDir: dir,
          p2pPort: 0,
          rpcPort: 0,
          p2pBind: '127.0.0.1',
          seeds: [],
        }).then((node) => {
          started = node;
          return node;
        }),
        /datadir_acl:chmod/,
      );
    } finally {
      chmod.mock.restore();
      try { started?.p2p?.close(); } catch { /* not started */ }
      try { started?.rpc?.close(); } catch { /* not started */ }
      try { started?.stratum?.close(); } catch { /* not started */ }
    }
    assert.equal(started, null);
    assert.equal(chmod.mock.calls.length >= 1, true);
    assert.equal(fs.existsSync(path.join(dir, 'chain.bin')), false);
    assert.equal(fs.existsSync(path.join(dir, 'book.seal')), false);
  });

  it('refuses shear-regtest before it changes datadir permissions', () => {
    const dir = tempDatadir();
    fs.chmodSync(dir, 0o755);
    assert.throws(() => createStore(dir, { magic: MAGIC_REGTEST }), /regtest_magic/);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
    const opened = createRegtestStore(tempDatadir(), { bits: 4 });
    assert.equal(opened.magic, MAGIC_REGTEST);
  });
});

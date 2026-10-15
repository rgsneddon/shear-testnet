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

function identityRealpath(file) {
  return file;
}

function system32(name) {
  return system32Exe(name, WIN_ENV, identityRealpath);
}

function goodReport(dir, shewallPresent) {
  const dirSddl = `O:${USER_SID}G:SYD:P(A;OICI;FA;;;${USER_SID})(A;CIOI;FA;;;SY)(A;OICI;FA;;;BA)`;
  let text = `PATH=${dir}\nOWNER=${USER_SID}\nPROTECTED=1\nSDDL=${dirSddl}\n`;
  if (shewallPresent) {
    const shewall = path.join(dir, SHEWALL_FILE);
    const fileSddl = `O:${USER_SID}G:SYD:P(A;;FA;;;${USER_SID})(A;;FA;;;SY)(A;;FA;;;BA)`;
    text += `PATH=${shewall}\nOWNER=${USER_SID}\nPROTECTED=1\nSDDL=${fileSddl}\n`;
  }
  return text;
}

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

function recordWindows(dir, { aclScript } = {}) {
  const calls = [];
  let aclReads = 0;
  const execFileSync = (file, args) => {
    calls.push({ file: String(file), args: args.slice() });
    if (String(file).endsWith(`${path.win32.sep}whoami.exe`)) {
      return `"${LOCAL_NAME}","${USER_SID}"\r\n`;
    }
    if (String(file).endsWith(`${path.win32.sep}powershell.exe`)) {
      aclReads += 1;
      if (aclScript) return aclScript(aclReads, dir);
      if (aclReads === 1) {
        return `PATH=${dir}\nOWNER=${ADMINISTRATORS_SID}\nPROTECTED=0\nSDDL=O:BA G:BA D:(A;;FA;;;WD)\n`;
      }
      return goodReport(dir, fs.existsSync(path.join(dir, SHEWALL_FILE)));
    }
    return 'Successfully processed 1 files\r\n';
  };
  const got = ensureDatadir(dir, {
    platform: 'win32',
    env: WIN_ENV,
    execFileSync,
    realpathSync: identityRealpath,
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
    const whoami = system32('whoami.exe');
    const icacls = system32('icacls.exe');
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
    for (const call of walked) {
      assert.equal(call.args.includes('/T'), true, call.args.join(' '));
      assert.equal(call.args.includes('/L'), true, call.args.join(' '));
    }
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

  it('ignores SystemRoot and refuses a System32 path that resolves outside it', () => {
    const spoofed = { SystemRoot: 'C:\\Temp\\fake', SYSTEMROOT: 'C:\\Temp\\fake' };
    assert.equal(system32Exe('whoami.exe', spoofed, identityRealpath), 'C:\\Windows\\System32\\whoami.exe');
    assert.equal(system32Exe('icacls.exe', spoofed, identityRealpath), 'C:\\Windows\\System32\\icacls.exe');
    assert.throws(
      () => system32Exe('whoami.exe', spoofed, () => 'C:\\Temp\\fake\\System32\\whoami.exe'),
      /datadir_acl:system32/,
    );
    const dir = tempDatadir();
    let called = false;
    assert.throws(() => ensureDatadir(dir, {
      platform: 'win32',
      env: spoofed,
      realpathSync: () => 'C:\\Temp\\fake\\System32\\whoami.exe',
      execFileSync: () => {
        called = true;
        return '';
      },
    }), /datadir_acl:system32/);
    assert.equal(called, false);
  });

  it('re-reads the DACL and owner on every open and re-applies a mismatch', () => {
    const dir = tempDatadir();
    fs.writeFileSync(path.join(dir, 'datadir.acl'), `1\n${USER_SID}\nnoshewall\n`);
    const first = recordWindows(dir);
    assert.ok(icaclsCalls(first.calls).length >= 1);
    assert.equal(first.calls.some((call) => call.file.endsWith(`${path.win32.sep}powershell.exe`)), true);

    const second = recordWindows(dir, {
      aclScript: () => goodReport(dir, false),
    });
    assert.equal(second.got.applied, false);
    assert.equal(icaclsCalls(second.calls).length, 0);
    assert.equal(second.calls.some((call) => call.file.endsWith(`${path.win32.sep}powershell.exe`)), true);

    const extra = `PATH=${dir}\nOWNER=${USER_SID}\nPROTECTED=1\nSDDL=O:${USER_SID}D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;${SYSTEM_SID})(A;OICI;FA;;;${ADMINISTRATORS_SID})(A;OICI;FA;;;S-1-1-0)\n`;
    const third = recordWindows(dir, {
      aclScript: (n) => (n === 1 ? extra : goodReport(dir, false)),
    });
    assert.equal(third.got.applied, true);
    assert.ok(icaclsCalls(third.calls).length >= 1);
  });

  it('throws when the read-back DACL has an extra ACE, is unprotected, or has the wrong owner', () => {
    const dir = tempDatadir();
    const mismatch = `PATH=${dir}\nOWNER=${SYSTEM_SID}\nPROTECTED=0\nSDDL=O:SYD:(A;;FA;;;WD)\n`;
    const cases = [
      `PATH=${dir}\nOWNER=${USER_SID}\nPROTECTED=1\nSDDL=O:${USER_SID}D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;${SYSTEM_SID})(A;OICI;FA;;;${ADMINISTRATORS_SID})(A;;FA;;;S-1-1-0)\n`,
      `PATH=${dir}\nOWNER=${USER_SID}\nPROTECTED=0\nSDDL=O:${USER_SID}D:(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;${SYSTEM_SID})(A;OICI;FA;;;${ADMINISTRATORS_SID})\n`,
      `PATH=${dir}\nOWNER=${ADMINISTRATORS_SID}\nPROTECTED=1\nSDDL=O:${ADMINISTRATORS_SID}D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;${SYSTEM_SID})(A;OICI;FA;;;${ADMINISTRATORS_SID})\n`,
    ];
    for (const bad of cases) {
      assert.throws(() => recordWindows(dir, {
        aclScript: (n) => (n === 1 ? mismatch : bad),
      }), /datadir_acl:verify/);
    }
  });

  it('refuses a symlink instead of letting /T follow it', () => {
    const dir = tempDatadir();
    const outside = tempDatadir();
    fs.writeFileSync(path.join(outside, 'secret'), 'no');
    fs.symlinkSync(outside, path.join(dir, 'jump'), 'dir');
    let called = false;
    assert.throws(() => ensureDatadir(dir, {
      platform: 'win32',
      env: WIN_ENV,
      realpathSync: identityRealpath,
      execFileSync: () => {
        called = true;
        return '';
      },
    }), /datadir_acl:link/);
    assert.equal(called, false);

    const parent = tempDatadir();
    const real = path.join(parent, 'real');
    fs.mkdirSync(real);
    const linked = path.join(parent, 'linked');
    fs.symlinkSync(real, linked, 'dir');
    called = false;
    assert.throws(() => ensureDatadir(linked, {
      platform: 'win32',
      env: WIN_ENV,
      realpathSync: identityRealpath,
      execFileSync: () => {
        called = true;
        return '';
      },
    }), /datadir_acl:link/);
    assert.equal(called, false);
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

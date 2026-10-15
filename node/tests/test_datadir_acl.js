/**
 * The node datadir is private before the book opens.
 * The test directory is a temp folder, never the Roaming Shear book and
 * never shear-data. Windows ACL behaviour is exercised with a fake
 * icacls and an injected user SID so the suite does not need a Windows host.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const SYSTEM_DIR = 'D:\\Windows\\System32';
const SYSTEM_ROOT = 'D:\\Windows';
const PLANTED_ENV = {
  SystemRoot: 'C:\\Windows',
  SYSTEMROOT: 'C:\\Windows',
  PSModulePath: 'C:\\evil\\modules;C:\\Users\\rgsne\\Documents\\WindowsPowerShell\\Modules',
  PATH: 'C:\\evil',
};

function identityRealpath(file) {
  const text = String(file);
  assert.equal(text.toLowerCase().startsWith('c:\\windows\\system32'), false, text);
  return text;
}

function system32(name) {
  return system32Exe(name, SYSTEM_DIR, identityRealpath);
}

function goodSecurity(filePath) {
  const fileAce = {
    owner: USER_SID,
    sddl: `O:${USER_SID}G:SYD:P(A;;FA;;;${USER_SID})(A;;FA;;;SY)(A;;FA;;;BA)`,
  };
  const dirAce = {
    owner: USER_SID,
    sddl: `O:${USER_SID}G:SYD:P(A;OICI;FA;;;${USER_SID})(A;CIOI;FA;;;SY)(A;OICI;FA;;;BA)`,
  };
  try {
    return fs.statSync(filePath).isFile() ? fileAce : dirAce;
  } catch {
    return dirAce;
  }
}

function badSecurity() {
  return { owner: ADMINISTRATORS_SID, sddl: 'O:BAD:(A;;FA;;;WD)' };
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

function recordWindows(dir, { securityScript, realpathSync = identityRealpath } = {}) {
  const calls = [];
  let aclReads = 0;
  const seen = new Map();
  const execFileSync = (file, args, opts) => {
    calls.push({ file: String(file), args: args.slice(), env: opts?.env });
    assert.equal(/powershell/i.test(String(file)), false, String(file));
    assert.equal(/whoami/i.test(String(file)), false, String(file));
    assert.deepEqual(opts.env, { SystemRoot: SYSTEM_ROOT });
    return 'Successfully processed 1 files\r\n';
  };
  const readSecurity = (filePath) => {
    aclReads += 1;
    if (securityScript) return securityScript(aclReads, filePath);
    const n = (seen.get(filePath) || 0) + 1;
    seen.set(filePath, n);
    if (n === 1) return badSecurity();
    return goodSecurity(filePath);
  };
  const got = ensureDatadir(dir, {
    platform: 'win32',
    env: PLANTED_ENV,
    execFileSync,
    realpathSync,
    getSystemDirectory: () => SYSTEM_DIR,
    readSystemRoot: () => SYSTEM_ROOT,
    readUserSid: () => USER_SID,
    readSecurity,
  });
  return { calls, got, aclReads };
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

  it('calls icacls by absolute System32 path and does not spawn whoami', () => {
    const dir = tempDatadir();
    const { calls } = recordWindows(dir);
    const icacls = system32('icacls.exe');
    assert.equal(path.win32.isAbsolute(icacls), true);
    assert.equal(icacls, 'D:\\Windows\\System32\\icacls.exe');
    assert.equal(calls.some((call) => call.file === icacls), true);
    assert.equal(calls.some((call) => /whoami/i.test(call.file)), false);
    assert.equal(calls.some((call) => call.file === 'icacls'), false);
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/win32_system.cjs'), 'utf8');
    const acl = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/datadir_acl.js'), 'utf8');
    assert.match(src, /GetTokenInformation/);
    assert.match(src, /OpenProcessToken/);
    assert.doesNotMatch(acl, /whoami/i);
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
    assert.equal(icaclsCalls(calls).length, 1);
    assert.equal(owner.args[0], dir);
    assert.equal(owner.args.includes('/setowner'), true);
    assert.equal(owner.args.includes(`*${USER_SID}`), true);
    assert.equal(owner.args.includes('/T'), true);
    assert.equal(owner.args.includes('/L'), true);
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
    assert.equal(walked.length, 1);
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
    const { calls, aclReads } = recordWindows(dir);
    assert.equal(icaclsCalls(calls).length, 1);
    assert.ok(aclReads >= 2);
    const named = icaclsCalls(calls)[0];
    assert.equal(named.args[0], dir);
    assert.equal(named.args.includes('/T'), true);
    assert.equal(named.args.includes('/L'), true);
    assert.equal(named.args.includes(`*${USER_SID}:(OI)(CI)F`), true);
    assert.equal(named.args.includes(`*${SYSTEM_SID}:(OI)(CI)F`), true);
    assert.equal(named.args.includes(`*${ADMINISTRATORS_SID}:(OI)(CI)F`), true);
    if (process.platform !== 'win32') {
      ensureDatadir(dir);
      assert.equal(fs.statSync(shewall).mode & 0o777, 0o600);
    }
  });

  it('uses GetSystemDirectoryW on D: and ignores a planted C: System32', () => {
    const dir = tempDatadir();
    const planted = [];
    const { calls } = recordWindows(dir, {
      realpathSync: (file) => {
        const text = String(file);
        if (text.toLowerCase().startsWith('c:\\')) planted.push(text);
        return text;
      },
    });
    assert.deepEqual(planted, []);
    assert.equal(calls.some((call) => /whoami/i.test(call.file)), false);
    assert.ok(calls.some((call) => call.file === 'D:\\Windows\\System32\\icacls.exe'));
    assert.equal(calls.some((call) => String(call.file).toLowerCase().startsWith('c:\\')), false);
    assert.throws(
      () => system32Exe('icacls.exe', SYSTEM_DIR, () => 'C:\\Windows\\System32\\icacls.exe'),
      /datadir_acl:system32/,
    );
    let called = false;
    assert.throws(() => ensureDatadir(dir, {
      platform: 'win32',
      env: PLANTED_ENV,
      getSystemDirectory: () => SYSTEM_DIR,
      readSystemRoot: () => 'C:\\Windows',
      readSecurity: () => goodSecurity(dir),
      readUserSid: () => USER_SID,
      realpathSync: identityRealpath,
      execFileSync: () => {
        called = true;
        return '';
      },
    }), /datadir_acl:system32/);
    assert.equal(called, false);
    called = false;
    assert.throws(() => ensureDatadir(dir, {
      platform: 'win32',
      env: PLANTED_ENV,
      getSystemDirectory: () => SYSTEM_DIR,
      readSystemRoot: () => SYSTEM_ROOT,
      readSecurity: () => goodSecurity(dir),
      readUserSid: () => USER_SID,
      realpathSync: (file) => (
        String(file).toLowerCase() === SYSTEM_DIR.toLowerCase()
          ? 'C:\\Windows\\System32'
          : file
      ),
      execFileSync: () => {
        called = true;
        return '';
      },
    }), /datadir_acl:system32/);
    assert.equal(called, false);
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/win32_system.cjs'), 'utf8');
    const acl = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/datadir_acl.js'), 'utf8');
    assert.match(src, /GetSystemDirectoryW/);
    assert.match(src, /RegGetValueW/);
    assert.match(src, /SystemRoot/);
    assert.doesNotMatch(src, /C:\\Windows\\System32/);
    assert.doesNotMatch(acl, /C:\\Windows\\System32/);
  });

  it('re-reads the DACL and owner on every open and re-applies a mismatch', () => {
    const dir = tempDatadir();
    fs.writeFileSync(path.join(dir, 'datadir.acl'), `1\n${USER_SID}\nnoshewall\n`);
    const first = recordWindows(dir);
    assert.ok(icaclsCalls(first.calls).length >= 1);
    assert.ok(first.aclReads >= 1);

    const second = recordWindows(dir, {
      securityScript: (_n, filePath) => goodSecurity(filePath),
    });
    assert.equal(second.got.applied, false);
    assert.equal(icaclsCalls(second.calls).length, 0);
    assert.ok(second.aclReads >= 1);

    const extra = {
      owner: USER_SID,
      sddl: `O:${USER_SID}D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;${SYSTEM_SID})(A;OICI;FA;;;${ADMINISTRATORS_SID})(A;;FA;;;S-1-1-0)`,
    };
    const third = recordWindows(dir, {
      securityScript: (n, filePath) => (n === 1 ? extra : goodSecurity(filePath)),
    });
    assert.equal(third.got.applied, true);
    assert.ok(icaclsCalls(third.calls).length >= 1);
  });

  it('throws when the read-back DACL has an extra ACE, is unprotected, or has the wrong owner', () => {
    const dir = tempDatadir();
    const mismatch = { owner: SYSTEM_SID, sddl: 'O:SYD:(A;;FA;;;WD)' };
    const cases = [
      {
        owner: USER_SID,
        sddl: `O:${USER_SID}D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;${SYSTEM_SID})(A;OICI;FA;;;${ADMINISTRATORS_SID})(A;;FA;;;S-1-1-0)`,
      },
      {
        owner: USER_SID,
        sddl: `O:${USER_SID}D:(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;${SYSTEM_SID})(A;OICI;FA;;;${ADMINISTRATORS_SID})`,
      },
      {
        owner: ADMINISTRATORS_SID,
        sddl: `O:${ADMINISTRATORS_SID}D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;${SYSTEM_SID})(A;OICI;FA;;;${ADMINISTRATORS_SID})`,
      },
    ];
    for (const bad of cases) {
      assert.throws(() => recordWindows(dir, {
        securityScript: (n) => (n === 1 ? mismatch : bad),
      }), /datadir_acl:verify/);
    }
  });

  it('reads the security descriptor without PowerShell or the caller PSModulePath', () => {
    const dir = tempDatadir();
    const { calls, aclReads } = recordWindows(dir);
    assert.ok(aclReads >= 2);
    assert.equal(calls.some((call) => /powershell/i.test(call.file)), false);
    assert.ok(calls.length >= 1);
    for (const call of calls) {
      assert.deepEqual(call.env, { SystemRoot: SYSTEM_ROOT });
      assert.equal(Object.hasOwn(call.env, 'PSModulePath'), false);
      assert.equal(JSON.stringify(call.env).includes('evil'), false);
    }
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/win32_system.cjs'), 'utf8');
    const acl = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/datadir_acl.js'), 'utf8');
    assert.match(src, /GetNamedSecurityInfoW/);
    assert.doesNotMatch(src, /powershell\.exe/i);
    assert.doesNotMatch(acl, /powershell\.exe/i);
    assert.doesNotMatch(acl, /PSModulePath/);
  });

  it('refuses a symlink instead of letting /T follow it', () => {
    const dir = tempDatadir();
    const outside = tempDatadir();
    fs.writeFileSync(path.join(outside, 'secret'), 'no');
    fs.symlinkSync(outside, path.join(dir, 'jump'), 'dir');
    let called = false;
    assert.throws(() => ensureDatadir(dir, {
      platform: 'win32',
      env: PLANTED_ENV,
      getSystemDirectory: () => SYSTEM_DIR,
      readSystemRoot: () => SYSTEM_ROOT,
      readSecurity: () => {
        throw new Error('datadir_acl:link should win');
      },
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
      env: PLANTED_ENV,
      getSystemDirectory: () => SYSTEM_DIR,
      readSystemRoot: () => SYSTEM_ROOT,
      readSecurity: () => {
        throw new Error('datadir_acl:link should win');
      },
      realpathSync: identityRealpath,
      execFileSync: () => {
        called = true;
        return '';
      },
    }), /datadir_acl:link/);
    assert.equal(called, false);
  });

  it('rejects an extra ACE on a child file', () => {
    const dir = tempDatadir();
    const child = path.join(dir, 'chain.bin');
    fs.writeFileSync(child, 'chain');
    const nest = path.join(dir, 'a');
    fs.mkdirSync(nest);
    const deep = path.join(nest, 'deep.bin');
    fs.writeFileSync(deep, 'deep');
    const seen = new Map();
    const reads = [];
    const { calls } = recordWindows(dir, {
      securityScript: (_n, filePath) => {
        reads.push(filePath);
        const count = (seen.get(filePath) || 0) + 1;
        seen.set(filePath, count);
        if (count === 1) return badSecurity();
        return goodSecurity(filePath);
      },
    });
    assert.ok(reads.includes(child));
    assert.ok(reads.includes(deep));
    assert.ok(reads.includes(nest));
    assert.equal(icaclsCalls(calls).length, 1);
    const named = icaclsCalls(calls)[0];
    assert.equal(named.args[0], dir);
    assert.equal(named.args.includes('/T'), true);
    assert.equal(named.args.includes('/L'), true);
    assert.equal(calls.some((call) => call.args[0] === child), false);
    const extra = {
      owner: USER_SID,
      sddl: `O:${USER_SID}D:P(A;;FA;;;${USER_SID})(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-1-0)`,
    };
    const seenAgain = new Map();
    assert.throws(() => recordWindows(dir, {
      securityScript: (_n, filePath) => {
        const count = (seenAgain.get(filePath) || 0) + 1;
        seenAgain.set(filePath, count);
        if (filePath === child && count >= 2) return extra;
        if (count === 1) return badSecurity();
        return goodSecurity(filePath);
      },
    }), /datadir_acl:verify/);
  });

  it('refuses a parent junction and a deep junction before icacls', () => {
    const outside = tempDatadir();
    const grand = tempDatadir();
    const realParent = path.join(grand, 'real-parent');
    fs.mkdirSync(realParent);
    const jumpParent = path.join(grand, 'jump-parent');
    fs.symlinkSync(realParent, jumpParent, 'dir');
    const book = path.join(jumpParent, 'book');
    fs.mkdirSync(book);
    let called = false;
    const windows = {
      platform: 'win32',
      env: PLANTED_ENV,
      getSystemDirectory: () => SYSTEM_DIR,
      readSystemRoot: () => SYSTEM_ROOT,
      readUserSid: () => USER_SID,
      readSecurity: () => {
        throw new Error('datadir_acl:link should win');
      },
      realpathSync: identityRealpath,
      execFileSync: () => {
        called = true;
        return '';
      },
    };
    let refused = null;
    try {
      ensureDatadir(book, windows);
    } catch (err) {
      refused = err;
    }
    assert.ok(refused);
    assert.match(refused.message, /datadir_acl:link/);
    assert.match(refused.message, /--datadir/);
    assert.match(refused.message, /junction/);
    assert.match(refused.message, /SHEAR_DATA/);
    assert.equal(called, false);
    const cli = spawnSync(process.execPath, ['node/src/node.js', '--datadir'], {
      cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '../..'),
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(cli.status, 2);
    assert.match(`${cli.stderr}\n${cli.stdout}`, /--datadir/);

    const dir = tempDatadir();
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'a', 'b', 'jump'), 'dir');
    called = false;
    assert.throws(() => ensureDatadir(dir, windows), /datadir_acl:link/);
    assert.equal(called, false);
  });

  it('a file created after setup triggers zero icacls runs', () => {
    const dir = tempDatadir();
    const setup = recordWindows(dir);
    assert.equal(icaclsCalls(setup.calls).length, 1);
    const created = path.join(dir, 'chain.bin');
    fs.writeFileSync(created, 'later');
    const again = recordWindows(dir, {
      securityScript: (_n, filePath) => {
        if (path.resolve(filePath) === path.resolve(dir)) return goodSecurity(dir);
        const st = fs.statSync(filePath);
        if (st.isDirectory()) {
          return {
            owner: USER_SID,
            sddl: `O:${USER_SID}G:SYD:AI(A;OICIID;FA;;;${USER_SID})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`,
          };
        }
        return {
          owner: USER_SID,
          sddl: `O:${USER_SID}G:SYD:AI(A;ID;FA;;;${USER_SID})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`,
        };
      },
    });
    assert.equal(again.got.applied, false);
    assert.equal(icaclsCalls(again.calls).length, 0);
    assert.ok(again.aclReads >= 2);
  });

  it('refuses a hard link before icacls', () => {
    const dir = tempDatadir();
    const file = path.join(dir, 'chain.bin');
    fs.writeFileSync(file, 'chain');
    fs.linkSync(file, path.join(dir, 'chain-hard.bin'));
    let called = false;
    assert.throws(() => ensureDatadir(dir, {
      platform: 'win32',
      getSystemDirectory: () => SYSTEM_DIR,
      readSystemRoot: () => SYSTEM_ROOT,
      readUserSid: () => USER_SID,
      readSecurity: () => goodSecurity(dir),
      realpathSync: identityRealpath,
      execFileSync: () => {
        called = true;
        return '';
      },
    }), /datadir_acl:link/);
    assert.equal(called, false);
    assert.equal(fs.statSync(file).nlink > 1, true);
  });

  it('fails closed when the datadir walk exceeds its cap', () => {
    const dir = tempDatadir();
    fs.writeFileSync(path.join(dir, 'a.bin'), 'a');
    fs.writeFileSync(path.join(dir, 'b.bin'), 'b');
    fs.writeFileSync(path.join(dir, 'c.bin'), 'c');
    let called = false;
    const windows = {
      platform: 'win32',
      getSystemDirectory: () => SYSTEM_DIR,
      readSystemRoot: () => SYSTEM_ROOT,
      readUserSid: () => USER_SID,
      readSecurity: () => goodSecurity(dir),
      realpathSync: identityRealpath,
      execFileSync: () => {
        called = true;
        return '';
      },
    };
    assert.throws(() => ensureDatadir(dir, { ...windows, maxEntries: 2 }), /datadir_acl:walk/);
    assert.equal(called, false);
    const deep = path.join(dir, 'd1', 'd2', 'd3');
    fs.mkdirSync(deep, { recursive: true });
    called = false;
    assert.throws(() => ensureDatadir(dir, { ...windows, maxDepth: 2 }), /datadir_acl:walk/);
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

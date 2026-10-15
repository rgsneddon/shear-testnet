/**
 * Private node datadir. Lockdown runs when the directory is created or when
 * its permissions are wrong. A later open of an already-private directory
 * does not call icacls again.
 *
 * Windows grants three trustees, by SID, never by a localized account name:
 *   - the current user (whoami /user)
 *   - SYSTEM (S-1-5-18)
 *   - BUILTIN\Administrators (S-1-5-32-544)
 * SYSTEM and Administrators keep access so a service restart and an elevated
 * repair can still read the book. Everyone, Users, and Authenticated Users
 * are not granted: /inheritance:r drops inherited ACEs. The owner is the
 * current user's SID.
 *
 * whoami.exe and icacls.exe are absolute System32 paths. A bare name would
 * run a binary planted in the working directory.
 *
 * /T reapplies that DACL to files already in the directory. shewall.bin is
 * also named explicitly, so a wallet file that is already there is covered
 * even when it does not inherit.
 *
 * Other platforms: the directory is mode 0700 and shewall.bin, when present,
 * is mode 0600. mkdir's mode is masked by umask, so a wide directory is
 * chmod'd. A chmod failure throws datadir_acl:chmod and the caller must not
 * start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync as execFileSyncDefault } from 'node:child_process';

export const SYSTEM_SID = 'S-1-5-18';
export const ADMINISTRATORS_SID = 'S-1-5-32-544';
export const SHEWALL_FILE = 'shewall.bin';
export const DATADIR_MODE = 0o700;
export const SHEWALL_MODE = 0o600;

const STAMP = 'datadir.acl';
const STAMP_VERSION = '1';

export function system32Exe(name, env = process.env) {
  const root = String(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows');
  return path.win32.join(root, 'System32', name);
}

function fail(code, cause) {
  const error = new Error(code);
  if (cause) error.cause = cause;
  return error;
}

function posixMode(statSync, target) {
  return statSync(target).mode & 0o777;
}

function tighten(target, mode, statSync, chmodSync) {
  if (posixMode(statSync, target) === mode) return false;
  try {
    chmodSync(target, mode);
  } catch (err) {
    throw fail('datadir_acl:chmod', err);
  }
  if (posixMode(statSync, target) !== mode) throw fail('datadir_acl:chmod');
  return true;
}

function ensurePosix(dir, { existsSync, statSync, chmodSync }) {
  const tightened = tighten(dir, DATADIR_MODE, statSync, chmodSync);
  const shewall = path.join(dir, SHEWALL_FILE);
  let shewallTightened = false;
  if (existsSync(shewall)) {
    shewallTightened = tighten(shewall, SHEWALL_MODE, statSync, chmodSync);
  }
  return {
    applied: false,
    tightened: tightened || shewallTightened,
    mode: DATADIR_MODE,
  };
}

function userSid(execFileSync, env) {
  const whoami = system32Exe('whoami.exe', env);
  let out;
  try {
    out = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (err) {
    throw fail('datadir_acl:whoami', err);
  }
  const match = String(out || '').match(/S-1-\d+(?:-\d+)+/);
  if (!match) throw fail('datadir_acl:whoami');
  return match[0];
}

function runIcacls(execFileSync, env, args) {
  const icacls = system32Exe('icacls.exe', env);
  try {
    execFileSync(icacls, args, { encoding: 'utf8', windowsHide: true });
  } catch (err) {
    throw fail('datadir_acl:icacls', err);
  }
}

function readStamp(dir, readFileSync) {
  try {
    const text = readFileSync(path.join(dir, STAMP), 'utf8');
    const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines[0] !== STAMP_VERSION) return null;
    if (!/^S-1-\d+(?:-\d+)+$/.test(lines[1] || '')) return null;
    return { sid: lines[1], shewall: lines[2] === 'shewall' };
  } catch {
    return null;
  }
}

function applyWindows(dir, sid, shewallPresent, execFileSync, env) {
  const user = `*${sid}:(OI)(CI)F`;
  const system = `*${SYSTEM_SID}:(OI)(CI)F`;
  const admins = `*${ADMINISTRATORS_SID}:(OI)(CI)F`;
  // /T re-checks files already in the directory. Inherited ACEs are removed.
  runIcacls(execFileSync, env, [
    dir, '/inheritance:r', '/grant:r', user, system, admins, '/T',
  ]);
  runIcacls(execFileSync, env, [dir, '/setowner', `*${sid}`, '/T']);
  if (!shewallPresent) return;
  const shewall = path.join(dir, SHEWALL_FILE);
  const fileGrant = (trustee) => `*${trustee}:F`;
  runIcacls(execFileSync, env, [
    shewall,
    '/inheritance:r',
    '/grant:r',
    fileGrant(sid),
    fileGrant(SYSTEM_SID),
    fileGrant(ADMINISTRATORS_SID),
  ]);
  runIcacls(execFileSync, env, [shewall, '/setowner', `*${sid}`]);
}

function ensureWindows(dir, existed, {
  execFileSync,
  env,
  existsSync,
  readFileSync,
  writeFileSync,
}) {
  const sid = userSid(execFileSync, env);
  const shewall = path.join(dir, SHEWALL_FILE);
  const shewallPresent = existsSync(shewall);
  const stamp = existed ? readStamp(dir, readFileSync) : null;
  const stampCoversShewall = !shewallPresent || stamp?.shewall === true;
  if (existed && stamp && stamp.sid === sid && stampCoversShewall) {
    return { applied: false, sid, shewall: shewallPresent };
  }
  applyWindows(dir, sid, shewallPresent, execFileSync, env);
  writeFileSync(
    path.join(dir, STAMP),
    `${STAMP_VERSION}\n${sid}\n${shewallPresent ? 'shewall' : 'noshewall'}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return { applied: true, sid, shewall: shewallPresent };
}

export function ensureDatadir(dir, {
  platform = process.platform,
  execFileSync = execFileSyncDefault,
  env = process.env,
  mkdirSync = fs.mkdirSync,
  statSync = fs.statSync,
  chmodSync = fs.chmodSync,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
} = {}) {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: DATADIR_MODE });
  if (platform !== 'win32') {
    return ensurePosix(dir, { existsSync, statSync, chmodSync });
  }
  return ensureWindows(dir, existed, {
    execFileSync, env, existsSync, readFileSync, writeFileSync,
  });
}

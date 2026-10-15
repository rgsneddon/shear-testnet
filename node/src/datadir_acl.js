/**
 * Private node datadir.
 *
 * Windows grants three trustees, by SID, never by a localized account name:
 *   - the current user (whoami /user)
 *   - SYSTEM (S-1-5-18)
 *   - BUILTIN\Administrators (S-1-5-32-544)
 * SYSTEM and Administrators keep access so a service restart and an elevated
 * repair can still read the book. Everyone, Users, and Authenticated Users
 * are not granted. /inheritance:r drops inherited ACEs and protects the DACL.
 * The owner is the current user's SID.
 *
 * whoami.exe and icacls.exe are resolved under the directory returned by
 * GetSystemDirectoryW. That directory must be HKLM SystemRoot\System32.
 * The process environment is not a source for either value, and it is not
 * passed to the child. A mismatch, or a real path that leaves that directory,
 * fails closed.
 *
 * Every open re-reads the DACL and owner. A datadir.acl stamp is not trusted.
 * A mismatch is rewritten. After a write, the DACL and owner are read back
 * and a mismatch, an extra ACE, an unprotected DACL, or the wrong owner throws.
 *
 * /T walks files already in the directory. /L tells icacls not to follow a
 * link. A symlink or junction inside the datadir, including the datadir
 * itself, refuses startup before icacls runs. shewall.bin is also named
 * explicitly, so a wallet file that is already there is covered even when it
 * does not inherit.
 *
 * Other platforms: the directory is mode 0700 and shewall.bin, when present,
 * is mode 0600. mkdir's mode is masked by umask, so a wide directory is
 * chmod'd. A chmod failure throws datadir_acl:chmod and the caller must not
 * start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync as execFileSyncDefault } from 'node:child_process';

const require = createRequire(import.meta.url);

export const SYSTEM_SID = 'S-1-5-18';
export const ADMINISTRATORS_SID = 'S-1-5-32-544';
export const SHEWALL_FILE = 'shewall.bin';
export const DATADIR_MODE = 0o700;
export const SHEWALL_MODE = 0o600;
// Two-letter SDDL aliases that the security descriptor may use instead of a SID.
const SDDL_ALIAS = {
  AN: 'S-1-5-7',
  AO: 'S-1-5-32-548',
  AU: 'S-1-5-11',
  BA: 'S-1-5-32-544',
  BG: 'S-1-5-32-546',
  BO: 'S-1-5-32-551',
  BU: 'S-1-5-32-545',
  CG: 'S-1-3-1',
  CO: 'S-1-3-0',
  IU: 'S-1-5-4',
  LS: 'S-1-5-19',
  NS: 'S-1-5-20',
  NU: 'S-1-5-2',
  OW: 'S-1-3-4',
  PO: 'S-1-5-32-550',
  PU: 'S-1-5-32-547',
  RC: 'S-1-5-12',
  RD: 'S-1-5-32-555',
  RE: 'S-1-5-32-552',
  SY: 'S-1-5-18',
  WD: 'S-1-1-0',
};

function fail(code, cause) {
  const error = new Error(code);
  if (cause) error.cause = cause;
  return error;
}

function stripWinLong(value) {
  return String(value).replace(/^\\\\\?\\/, '');
}

function cleanWinDir(value) {
  const text = path.win32.normalize(stripWinLong(value)).replace(/[\\/]+$/, '');
  if (!text || text.startsWith('\\\\') || !path.win32.isAbsolute(text)) throw fail('datadir_acl:system32');
  return text;
}

function isUnder(parent, candidate) {
  const root = cleanWinDir(parent).toLowerCase();
  const full = cleanWinDir(candidate).toLowerCase();
  return full === root || full.startsWith(`${root}\\`);
}

function win32Api() {
  if (process.platform !== 'win32') throw fail('datadir_acl:system32');
  return require('./win32_system.cjs');
}

export function resolveSystem32({ getSystemDirectory, readSystemRoot, realpathSync }) {
  let apiDir;
  let regRoot;
  try {
    apiDir = cleanWinDir(getSystemDirectory());
    regRoot = cleanWinDir(readSystemRoot());
  } catch (err) {
    if (err?.message === 'datadir_acl:system32') throw err;
    throw fail('datadir_acl:system32', err);
  }
  const expected = cleanWinDir(path.win32.join(regRoot, 'System32'));
  if (apiDir.toLowerCase() !== expected.toLowerCase()) throw fail('datadir_acl:system32');
  let realApi;
  let realExpected;
  try {
    realApi = cleanWinDir(realpathSync(apiDir));
    realExpected = cleanWinDir(realpathSync(expected));
  } catch (err) {
    if (err?.message === 'datadir_acl:system32') throw err;
    throw fail('datadir_acl:system32', err);
  }
  if (realApi.toLowerCase() !== apiDir.toLowerCase()) throw fail('datadir_acl:system32');
  if (realExpected.toLowerCase() !== expected.toLowerCase()) throw fail('datadir_acl:system32');
  return { systemDir: realApi, systemRoot: regRoot };
}

export function system32Exe(name, systemDir, realpathSync = fs.realpathSync) {
  if (typeof name !== 'string' || name.length === 0 || path.win32.isAbsolute(name)) {
    throw fail('datadir_acl:system32');
  }
  const unresolved = path.win32.normalize(path.win32.join(systemDir, name));
  if (!isUnder(systemDir, unresolved)) throw fail('datadir_acl:system32');
  let real;
  try {
    real = cleanWinDir(realpathSync(unresolved));
  } catch (err) {
    if (err?.message === 'datadir_acl:system32') throw err;
    throw fail('datadir_acl:system32', err);
  }
  if (!isUnder(systemDir, real)) throw fail('datadir_acl:system32');
  return real;
}

function childEnv(systemRoot) {
  return { SystemRoot: systemRoot };
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

function userSid(execFileSync, systemDir, systemRoot, realpathSync) {
  const whoami = system32Exe('whoami.exe', systemDir, realpathSync);
  let out;
  try {
    out = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      env: childEnv(systemRoot),
    });
  } catch (err) {
    throw fail('datadir_acl:whoami', err);
  }
  const match = String(out || '').match(/S-1-\d+(?:-\d+)+/);
  if (!match) throw fail('datadir_acl:whoami');
  return match[0];
}

function runIcacls(execFileSync, systemDir, systemRoot, realpathSync, args) {
  const icacls = system32Exe('icacls.exe', systemDir, realpathSync);
  try {
    execFileSync(icacls, args, {
      encoding: 'utf8',
      windowsHide: true,
      env: childEnv(systemRoot),
    });
  } catch (err) {
    throw fail('datadir_acl:icacls', err);
  }
}

function normalizeSid(token) {
  const text = String(token || '').trim();
  if (/^S-1-\d+(?:-\d+)+$/i.test(text)) return text.toUpperCase();
  const alias = SDDL_ALIAS[text.toUpperCase()];
  return alias || text.toUpperCase();
}

function aceFlagList(text) {
  const flags = String(text || '');
  if (flags.length % 2 !== 0) throw fail('datadir_acl:verify');
  const out = [];
  for (let i = 0; i < flags.length; i += 2) out.push(flags.slice(i, i + 2).toUpperCase());
  out.sort();
  return out;
}

function parseAce(raw) {
  const body = String(raw || '').replace(/^\(/, '').replace(/\)$/, '');
  const parts = body.split(';');
  if (parts.length < 6) throw fail('datadir_acl:verify');
  return {
    type: parts[0].toUpperCase(),
    flags: aceFlagList(parts[1]),
    rights: parts[2].toUpperCase(),
    sid: normalizeSid(parts[5]),
  };
}

function daclOf(sddl) {
  const text = String(sddl || '');
  const at = text.indexOf('D:');
  if (at < 0) throw fail('datadir_acl:verify');
  let i = at + 2;
  let flags = '';
  while (i < text.length && text[i] !== '(') {
    if (text[i] === 'S' && text.slice(i, i + 2) === 'S:') break;
    flags += text[i];
    i += 1;
  }
  const aces = [];
  while (i < text.length && text[i] === '(') {
    const end = text.indexOf(')', i);
    if (end < 0) throw fail('datadir_acl:verify');
    aces.push(parseAce(text.slice(i, end + 1)));
    i = end + 1;
  }
  return { protected: flags.toUpperCase().includes('P'), aces };
}

function expectedAces(kind, sid) {
  const flags = kind === 'dir' ? ['CI', 'OI'] : [];
  return [sid, SYSTEM_SID, ADMINISTRATORS_SID].map((trustee) => ({
    type: 'A',
    flags,
    rights: 'FA',
    sid: normalizeSid(trustee),
  })).sort((a, b) => a.sid.localeCompare(b.sid));
}

function sameAces(got, want) {
  if (got.length !== want.length) return false;
  const left = got.map((ace) => JSON.stringify(ace)).sort();
  const right = want.map((ace) => JSON.stringify(ace)).sort();
  return left.every((row, i) => row === right[i]);
}

function aclMatches(report, targets, sid) {
  if (!report || report.length !== targets.length) return false;
  for (const target of targets) {
    const row = report.find((item) => item.path === target.path);
    if (!row) return false;
    if (row.owner !== normalizeSid(sid)) return false;
    let dacl;
    try {
      dacl = daclOf(row.sddl);
    } catch {
      return false;
    }
    if (ownerFromSddl(row.sddl) !== normalizeSid(sid)) return false;
    if (!dacl.protected) return false;
    if (!sameAces(dacl.aces, expectedAces(target.kind, sid))) return false;
  }
  return true;
}

function ownerFromSddl(sddl) {
  const text = String(sddl || '').trim();
  if (!/^O:/i.test(text)) return '';
  const rest = text.slice(2);
  const end = rest.search(/G:|D:|S:/);
  return normalizeSid(end < 0 ? rest : rest.slice(0, end));
}

function readOne(readSecurity, target) {
  let got;
  try {
    got = readSecurity(target.path);
  } catch (err) {
    if (err?.message === 'datadir_acl:acl' || err?.message === 'datadir_acl:verify') throw err;
    throw fail('datadir_acl:acl', err);
  }
  if (!got || typeof got.sddl !== 'string' || !got.owner) throw fail('datadir_acl:acl');
  return {
    path: target.path,
    owner: normalizeSid(got.owner),
    sddl: got.sddl.trim(),
  };
}

function applyWindows(dir, sid, targets, execFileSync, systemDir, systemRoot, realpathSync) {
  const user = `*${sid}:(OI)(CI)F`;
  const system = `*${SYSTEM_SID}:(OI)(CI)F`;
  const admins = `*${ADMINISTRATORS_SID}:(OI)(CI)F`;
  // /L does not follow a link. /T re-checks files already in the directory.
  runIcacls(execFileSync, systemDir, systemRoot, realpathSync, [
    dir, '/inheritance:r', '/grant:r', user, system, admins, '/T', '/L',
  ]);
  runIcacls(execFileSync, systemDir, systemRoot, realpathSync, [dir, '/setowner', `*${sid}`, '/T', '/L']);
  const shewall = targets.find((target) => target.kind === 'file');
  if (!shewall) return;
  const fileGrant = (trustee) => `*${trustee}:F`;
  runIcacls(execFileSync, systemDir, systemRoot, realpathSync, [
    shewall.path,
    '/inheritance:r',
    '/grant:r',
    fileGrant(sid),
    fileGrant(SYSTEM_SID),
    fileGrant(ADMINISTRATORS_SID),
    '/L',
  ]);
  runIcacls(execFileSync, systemDir, systemRoot, realpathSync, [shewall.path, '/setowner', `*${sid}`, '/L']);
}

function assertNoLinks(root, lstatSync, readdirSync) {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (err) {
    throw fail('datadir_acl:link', err);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw fail('datadir_acl:link');
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let names;
    try {
      names = readdirSync(current);
    } catch (err) {
      throw fail('datadir_acl:link', err);
    }
    for (const name of names) {
      const child = path.join(current, name);
      let st;
      try {
        st = lstatSync(child);
      } catch (err) {
        throw fail('datadir_acl:link', err);
      }
      if (st.isSymbolicLink()) throw fail('datadir_acl:link');
      if (st.isDirectory()) stack.push(child);
    }
  }
}

function ensureWindows(dir, {
  execFileSync,
  existsSync,
  realpathSync,
  lstatSync,
  readdirSync,
  getSystemDirectory,
  readSystemRoot,
  readSecurity,
}) {
  assertNoLinks(dir, lstatSync, readdirSync);
  const { systemDir, systemRoot } = resolveSystem32({ getSystemDirectory, readSystemRoot, realpathSync });
  const sid = userSid(execFileSync, systemDir, systemRoot, realpathSync);
  const targets = [{ path: dir, kind: 'dir' }];
  const shewall = path.join(dir, SHEWALL_FILE);
  if (existsSync(shewall)) targets.push({ path: shewall, kind: 'file' });
  let current = null;
  try {
    current = targets.map((target) => readOne(readSecurity, target));
  } catch (err) {
    if (err?.message !== 'datadir_acl:acl') throw err;
  }
  if (current && aclMatches(current, targets, sid)) {
    return { applied: false, sid, shewall: targets.length > 1 };
  }
  applyWindows(dir, sid, targets, execFileSync, systemDir, systemRoot, realpathSync);
  const after = targets.map((target) => readOne(readSecurity, target));
  if (!aclMatches(after, targets, sid)) throw fail('datadir_acl:verify');
  return { applied: true, sid, shewall: targets.length > 1 };
}

export function ensureDatadir(dir, {
  platform = process.platform,
  execFileSync = execFileSyncDefault,
  mkdirSync = fs.mkdirSync,
  statSync = fs.statSync,
  chmodSync = fs.chmodSync,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  lstatSync = fs.lstatSync,
  readdirSync = fs.readdirSync,
  getSystemDirectory,
  readSystemRoot,
  readSecurity,
} = {}) {
  mkdirSync(dir, { recursive: true, mode: DATADIR_MODE });
  if (platform !== 'win32') {
    return ensurePosix(dir, { existsSync, statSync, chmodSync });
  }
  return ensureWindows(dir, {
    execFileSync, existsSync, realpathSync, lstatSync, readdirSync,
    getSystemDirectory: getSystemDirectory || (() => win32Api().getSystemDirectory()),
    readSystemRoot: readSystemRoot || (() => win32Api().readSystemRoot()),
    readSecurity: readSecurity || ((file) => win32Api().readSecurity(file)),
  });
}

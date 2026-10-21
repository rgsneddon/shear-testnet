/**
 * Private node datadir.
 *
 * Windows grants three trustees, by SID, never by a localized account name:
 *   - the current user (TokenUser from GetTokenInformation)
 *   - SYSTEM (S-1-5-18)
 *   - BUILTIN\Administrators (S-1-5-32-544)
 * SYSTEM and Administrators keep access so a service restart and an elevated
 * repair can still read the book. Everyone, Users, and Authenticated Users
 * are not granted. /inheritance:r drops inherited ACEs and protects the DACL.
 * The owner is the current user's SID.
 *
 * icacls.exe is resolved under the directory returned by GetSystemDirectoryW.
 * That directory must be HKLM SystemRoot\System32. The process environment is
 * not a source for either value, and it is not passed to the child. A
 * mismatch, or a real path that leaves that directory, fails closed.
 *
 * Every open re-reads the DACL and owner. A datadir.acl stamp is not trusted.
 * The folder DACL is protected. A child may instead carry the inherited form
 * of that same DACL. An extra explicit ACE, an unprotected folder, or the
 * wrong owner is a mismatch. One icacls /T /L call rewrites a mismatch, then
 * the DACL is read back.
 *
 * The walk is capped and fails closed. /L tells icacls not to follow a link.
 * A symlink or junction (the datadir, a parent, or a nested link) refuses
 * startup before icacls. A file with more than one name (a hard link) does too.
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
// A chain datadir is shallow. Past this, fail closed instead of walking forever.
const MAX_WALK_ENTRIES = 65536;
const MAX_WALK_DEPTH = 16;
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

function failJunction(cause) {
  return fail('datadir_acl:link: refusing a junction or symlink. Start with --datadir (or SHEAR_DATA) pointed at a real directory that is not a junction.', cause);
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

function currentUserSid(readUserSid) {
  let sid;
  try {
    sid = readUserSid();
  } catch (err) {
    if (err?.message === 'datadir_acl:token') throw err;
    throw fail('datadir_acl:token', err);
  }
  if (!/^S-1-\d+(?:-\d+)+$/i.test(String(sid || ''))) throw fail('datadir_acl:token');
  return normalizeSid(sid);
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

function sameFlags(got, want) {
  if (got.length !== want.length) return false;
  const right = want.slice().sort();
  return got.every((flag, i) => flag === right[i]);
}

function isExactTrustSet(aces, sid) {
  const want = [sid, SYSTEM_SID, ADMINISTRATORS_SID]
    .map((trustee) => `A|FA|${normalizeSid(trustee)}`)
    .sort();
  if (aces.length !== want.length) return false;
  const got = aces.map((ace) => `${ace.type}|${ace.rights}|${ace.sid}`).sort();
  return got.every((row, i) => row === want[i]);
}

function ownerOk(row, sid) {
  return row.owner === normalizeSid(sid) && ownerFromSddl(row.sddl) === normalizeSid(sid);
}

function rootMatches(row, sid) {
  if (!row || !ownerOk(row, sid)) return false;
  let dacl;
  try {
    dacl = daclOf(row.sddl);
  } catch {
    return false;
  }
  if (!dacl.protected || !isExactTrustSet(dacl.aces, sid)) return false;
  return dacl.aces.every((ace) => sameFlags(ace.flags, ['CI', 'OI']));
}

function childMatches(row, sid, kind) {
  if (!row || !ownerOk(row, sid)) return false;
  let dacl;
  try {
    dacl = daclOf(row.sddl);
  } catch {
    return false;
  }
  // Inherited ACEs are the folder DACL propagated (ID). An explicit ACE is
  // accepted only when it is that same set and nothing more.
  if (!isExactTrustSet(dacl.aces, sid)) return false;
  const inherited = kind === 'dir' ? ['CI', 'ID', 'OI'] : ['ID'];
  const explicit = kind === 'dir' ? ['CI', 'OI'] : [];
  return dacl.aces.every((ace) => (
    sameFlags(ace.flags, inherited)
    || sameFlags(ace.flags, explicit)
    || (kind === 'file' && sameFlags(ace.flags, ['CI', 'OI']))
  ));
}

function aclMatches(report, targets, sid) {
  if (!report || report.length !== targets.length || !targets.length) return false;
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const row = report.find((item) => item.path === target.path);
    if (!row) return false;
    const ok = i === 0 ? rootMatches(row, sid) : childMatches(row, sid, target.kind);
    if (!ok) return false;
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

function applyWindows(dir, sid, execFileSync, systemDir, systemRoot, realpathSync) {
  const user = `*${sid}:(OI)(CI)F`;
  const system = `*${SYSTEM_SID}:(OI)(CI)F`;
  const admins = `*${ADMINISTRATORS_SID}:(OI)(CI)F`;
  // icacls rejects /setowner in the same invocation as /grant (error 87).
  // /L does not follow a link. /T rewrites the files already there.
  runIcacls(execFileSync, systemDir, systemRoot, realpathSync, [
    dir, '/inheritance:r', '/grant:r', user, system, admins, '/T', '/L',
  ]);
  runIcacls(execFileSync, systemDir, systemRoot, realpathSync, [
    dir, '/setowner', `*${sid}`, '/T', '/L',
  ]);
}

function assertNoAncestorLinks(dir, lstatSync) {
  let current = path.resolve(dir);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return;
    let st;
    try {
      st = lstatSync(parent);
    } catch (err) {
      throw failJunction(err);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw failJunction();
    current = parent;
  }
}

function assertNoLinks(root, lstatSync, readdirSync, limits) {
  assertNoAncestorLinks(root, lstatSync);
  const maxEntries = limits.maxEntries;
  const maxDepth = limits.maxDepth;
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (err) {
    throw failJunction();
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw failJunction();
  let seen = 1;
  if (seen > maxEntries) throw fail('datadir_acl:walk');
  const targets = [{ path: root, kind: 'dir' }];
  const stack = [{ path: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    let names;
    try {
      names = readdirSync(current.path);
    } catch (err) {
      throw failJunction();
    }
    for (const name of names) {
      const child = path.join(current.path, name);
      const depth = current.depth + 1;
      if (depth > maxDepth) throw fail('datadir_acl:walk');
      seen += 1;
      if (seen > maxEntries) throw fail('datadir_acl:walk');
      let st;
      try {
        st = lstatSync(child);
      } catch (err) {
        throw failJunction();
      }
      if (st.isSymbolicLink()) throw failJunction();
      if (st.isDirectory()) {
        targets.push({ path: child, kind: 'dir' });
        stack.push({ path: child, depth });
      } else if (st.isFile()) {
        if (Number(st.nlink) > 1) throw fail('datadir_acl:link');
        targets.push({ path: child, kind: 'file' });
      } else {
        throw failJunction();
      }
    }
  }
  return targets;
}

function ensureWindows(dir, {
  execFileSync,
  realpathSync,
  lstatSync,
  readdirSync,
  getSystemDirectory,
  readSystemRoot,
  readSecurity,
  readUserSid,
  maxEntries,
  maxDepth,
}) {
  const targets = assertNoLinks(dir, lstatSync, readdirSync, { maxEntries, maxDepth });
  const { systemDir, systemRoot } = resolveSystem32({ getSystemDirectory, readSystemRoot, realpathSync });
  const sid = currentUserSid(readUserSid);
  const shewall = targets.some((target) => target.path === path.join(dir, SHEWALL_FILE));
  let current = null;
  try {
    current = targets.map((target) => readOne(readSecurity, target));
  } catch (err) {
    if (err?.message !== 'datadir_acl:acl') throw err;
  }
  if (current && aclMatches(current, targets, sid)) {
    return { applied: false, sid, shewall };
  }
  applyWindows(dir, sid, execFileSync, systemDir, systemRoot, realpathSync);
  const after = targets.map((target) => readOne(readSecurity, target));
  if (!aclMatches(after, targets, sid)) throw fail('datadir_acl:verify');
  return { applied: true, sid, shewall };
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
  readUserSid,
  maxEntries = MAX_WALK_ENTRIES,
  maxDepth = MAX_WALK_DEPTH,
} = {}) {
  mkdirSync(dir, { recursive: true, mode: DATADIR_MODE });
  if (platform !== 'win32') {
    return ensurePosix(dir, { existsSync, statSync, chmodSync });
  }
  return ensureWindows(dir, {
    execFileSync, realpathSync, lstatSync, readdirSync,
    getSystemDirectory: getSystemDirectory || (() => win32Api().getSystemDirectory()),
    readSystemRoot: readSystemRoot || (() => win32Api().readSystemRoot()),
    readSecurity: readSecurity || ((file) => win32Api().readSecurity(file)),
    readUserSid: readUserSid || (() => win32Api().readUserSid()),
    maxEntries, maxDepth,
  });
}

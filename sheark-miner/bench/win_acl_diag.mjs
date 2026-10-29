#!/usr/bin/env node
// R41 Windows diagnostic, and since PR146 (PSA P2-3) a CI gate: the node
// store's datadir ACL check (node/src/datadir_acl.js) on fresh directories
// under os.tmpdir(), the user profile and RUNNER_TEMP. For each it prints
// the user SID, the security descriptor and icacls's view, and checks:
//   1. ensureDatadir accepts the fresh directory (a refusal fails),
//   2. a second call finds it already correct (applied false),
//   3. Windows only (PSA r2-2): for each stray ACE in the spread, granted on
//      the directory and on shewall.bin inside it, ensureDatadir repairs it
//      (applied true, the trustee in `removed`) and a further call finds it
//      correct (applied false). A refusal there fails: the stray ACE must be
//      removed, not left for an operator. The spread is Everyone:(R),
//      Users:(RX), Authenticated Users:(M) and a second local user:(F).
// At least one directory must be checked; none is a failure, not a pass.
// SHEAR_ACL_DIAG_BASES (path-delimited) replaces the base list, for tests.
// Any failure exits 1 (".github/workflows/datadir-acl-windows.yml" runs it
// with no fallback). Local only; nothing is sent anywhere.
// Usage: node win_acl_diag.mjs [REPO_ROOT]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, '..', '..'));
const { ensureDatadir } = await import(pathToFileURL(path.join(root, 'node/src/datadir_acl.js')).href);
const win = process.platform === 'win32';
const failures = [];

function icacls(dir) {
  try { return execFileSync('icacls', [dir], { encoding: 'utf8' }); } catch (e) { return String(e.stdout || e.message); }
}

function why(e) {
  return `${e.message}${e.cause ? ` (cause: ${e.cause.message || e.cause})` : ''}`;
}

function check(dir, label, fn) {
  try {
    const out = fn();
    console.log(`${label}: ok ${JSON.stringify(out)}`);
    return out;
  } catch (e) {
    console.log(`refused: ${why(e)}`);
    failures.push(`${dir} ${label}: ${why(e)}`);
    return null;
  }
}

const bases = process.env.SHEAR_ACL_DIAG_BASES
  ? process.env.SHEAR_ACL_DIAG_BASES.split(path.delimiter).filter(Boolean)
  : [os.tmpdir(), os.homedir(), process.env.RUNNER_TEMP || ''].filter(Boolean);

// The second local user for the :(F) case. Created on the runner only, and
// deleted at the end.
const OTHER = `shearacl${randomBytes(3).toString('hex')}`;
let otherMade = false;
function makeOther() {
  if (otherMade) return true;
  try {
    execFileSync('net', ['user', OTHER, `Aa1!${randomBytes(12).toString('base64url')}`, '/add'], { encoding: 'utf8' });
    otherMade = true;
  } catch (e) {
    failures.push(`could not create the second local user for the :(F) case: ${e.message}`);
  }
  return otherMade;
}

const SPREAD = [
  ['Everyone:(R)', () => '*S-1-1-0:(R)'],
  ['Users:(RX)', () => '*S-1-5-32-545:(RX)'],
  ['Authenticated Users:(M)', () => '*S-1-5-11:(M)'],
  ['a second local user:(F)', () => (makeOther() ? `${OTHER}:(F)` : null)],
];

function repairCase(base, label, grantOf, onFile) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(base, 'shear-acl-'));
  } catch (e) {
    failures.push(`${base} ${label}: cannot create a directory (${e.message})`);
    return;
  }
  const where = onFile ? 'shewall.bin' : 'the dir';
  try {
    if (!check(dir, `${label} on ${where}: fresh`, () => ensureDatadir(dir))) return;
    const file = path.join(dir, 'shewall.bin');
    fs.writeFileSync(file, 'diag');
    if (!check(dir, `${label} on ${where}: with shewall.bin`, () => ensureDatadir(dir))) return;
    const grant = grantOf();
    if (!grant) return;
    execFileSync('icacls', [onFile ? file : dir, '/grant', grant], { encoding: 'utf8' });
    const fixed = check(dir, `after ${label} was granted on ${where}`, () => ensureDatadir(dir));
    if (fixed && fixed.applied !== true) failures.push(`${dir} accepted ${label} on ${where} (applied ${fixed.applied})`);
    if (fixed && !(Array.isArray(fixed.removed) && fixed.removed.length)) failures.push(`${dir} ${label} on ${where}: repair removed no trustee`);
    const settled = check(dir, `after the ${label} repair`, () => ensureDatadir(dir));
    if (settled && settled.applied !== false) failures.push(`${dir} ${label} repair did not settle (applied ${settled.applied})`);
  } catch (e) {
    failures.push(`${dir} ${label} on ${where}: ${e.message}`);
  } finally {
    if (failures.some((f) => f.startsWith(dir))) console.log(icacls(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let checked = 0;
for (const base of [...new Set(bases)]) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(base, 'shear-acl-'));
  } catch (e) {
    console.log(`== ${base}: cannot create a directory here (${e.message}); skipped`);
    continue;
  }
  console.log(`== ${dir}`);
  checked += 1;
  const first = check(dir, 'fresh', () => ensureDatadir(dir));
  if (first) {
    const again = check(dir, 'second call', () => ensureDatadir(dir));
    if (again && again.applied !== false) failures.push(`${dir} second call rewrote a correct ACL (applied ${again.applied})`);
  }
  if (win) {
    console.log(icacls(dir));
    try {
      console.log(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Acl '${dir}').Sddl; (Get-Acl '${dir}').Owner`], { encoding: 'utf8' }));
    } catch (e) { console.log(String(e.message)); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (win) {
    for (const [label, grantOf] of SPREAD) {
      for (const onFile of [false, true]) repairCase(base, label, grantOf, onFile);
    }
  }
}
if (otherMade) {
  try { execFileSync('net', ['user', OTHER, '/delete'], { encoding: 'utf8' }); } catch (e) { console.log(`net user /delete: ${e.message}`); }
}
if (checked === 0) failures.push('no directory was checked (every base refused mkdtemp)');
if (win) {
  try { console.log(execFileSync('whoami', ['/user', '/groups', '/fo', 'list'], { encoding: 'utf8' }).split('\n').filter((l) => /SID|Group Name|User Name/.test(l)).slice(0, 40).join('\n')); } catch (e) { console.log(String(e.message)); }
}
if (failures.length) {
  console.log(`ACL check FAILED (${failures.length}):\n${failures.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('ACL check ok');

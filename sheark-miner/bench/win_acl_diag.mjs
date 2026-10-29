#!/usr/bin/env node
// R41 Windows diagnostic, and since PR146 (PSA P2-3) a CI gate: the node
// store's datadir ACL check (node/src/datadir_acl.js) on fresh directories
// under os.tmpdir(), the user profile and RUNNER_TEMP. For each it prints
// the user SID, the security descriptor and icacls's view, and checks:
//   1. ensureDatadir accepts the fresh directory (a refusal fails),
//   2. a second call finds it already correct (applied false),
//   3. Windows only: after icacls grants Everyone read, ensureDatadir
//      repairs it (applied true) and a further call finds it correct.
// Any failure exits 1 (".github/workflows/datadir-acl-windows.yml" runs it
// with no fallback). Local only; nothing is sent anywhere.
// Usage: node win_acl_diag.mjs [REPO_ROOT]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

for (const base of [...new Set([os.tmpdir(), os.homedir(), process.env.RUNNER_TEMP || ''].filter(Boolean))]) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(base, 'shear-acl-'));
  } catch (e) {
    console.log(`== ${base}: cannot create a directory here (${e.message}); skipped`);
    continue;
  }
  console.log(`== ${dir}`);
  const first = check(dir, 'fresh', () => ensureDatadir(dir));
  if (first) {
    const again = check(dir, 'second call', () => ensureDatadir(dir));
    if (again && again.applied !== false) failures.push(`${dir} second call rewrote a correct ACL (applied ${again.applied})`);
    if (win) {
      try {
        execFileSync('icacls', [dir, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8' });
        const fixed = check(dir, 'after Everyone:(R) was granted', () => ensureDatadir(dir));
        if (fixed && fixed.applied !== true) failures.push(`${dir} accepted a directory Everyone can read (applied ${fixed.applied})`);
        const settled = check(dir, 'after the repair', () => ensureDatadir(dir));
        if (settled && settled.applied !== false) failures.push(`${dir} repair did not settle (applied ${settled.applied})`);
      } catch (e) {
        failures.push(`${dir} icacls /grant failed: ${e.message}`);
      }
    }
  }
  if (win) {
    console.log(icacls(dir));
    try {
      console.log(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Acl '${dir}').Sddl; (Get-Acl '${dir}').Owner`], { encoding: 'utf8' }));
    } catch (e) { console.log(String(e.message)); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
if (win) {
  try { console.log(execFileSync('whoami', ['/user', '/groups', '/fo', 'list'], { encoding: 'utf8' }).split('\n').filter((l) => /SID|Group Name|User Name/.test(l)).slice(0, 40).join('\n')); } catch (e) { console.log(String(e.message)); }
}
if (failures.length) {
  console.log(`ACL check FAILED (${failures.length}):\n${failures.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('ACL check ok');

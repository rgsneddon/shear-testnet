#!/usr/bin/env node
// R41 Windows diagnostic: why the node store's datadir ACL check
// (node/src/datadir_acl.js, datadir_acl:verify) refuses a directory on a CI
// runner. It runs ensureDatadir on fresh directories (under os.tmpdir() and
// under the user profile) and prints the user SID, each security descriptor
// it reads, and icacls's view. Local only; nothing is sent anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, '..', '..'));
const { ensureDatadir } = await import(pathToFileURL(path.join(root, 'node/src/datadir_acl.js')).href);

function icacls(dir) {
  try { return execFileSync('icacls', [dir], { encoding: 'utf8' }); } catch (e) { return String(e.stdout || e.message); }
}

for (const base of [os.tmpdir(), os.homedir(), process.env.RUNNER_TEMP || ''].filter(Boolean)) {
  const dir = fs.mkdtempSync(path.join(base, 'shear-acl-'));
  console.log(`== ${dir}`);
  try {
    const out = ensureDatadir(dir);
    console.log(`ok ${JSON.stringify(out)}`);
  } catch (e) {
    console.log(`refused: ${e.message}${e.cause ? ` (cause: ${e.cause.message || e.cause})` : ''}`);
  }
  console.log(icacls(dir));
  try {
    console.log(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Acl '${dir}').Sddl; (Get-Acl '${dir}').Owner`], { encoding: 'utf8' }));
  } catch (e) { console.log(String(e.message)); }
  fs.rmSync(dir, { recursive: true, force: true });
}
try { console.log(execFileSync('whoami', ['/user', '/groups', '/fo', 'list'], { encoding: 'utf8' }).split('\n').filter((l) => /SID|Group Name|User Name/.test(l)).slice(0, 40).join('\n')); } catch (e) { console.log(String(e.message)); }

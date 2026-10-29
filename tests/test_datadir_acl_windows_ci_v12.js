// PR146 (PSA P2-3): the node datadir ACL check runs on a real Windows runner
// on every push and pull request that touches it, and a refusal fails the
// job. Before, sheark-packs ran bench/win_acl_diag.mjs only on manual runs,
// behind `|| echo "acl diag failed"`, and the script never exited non-zero.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wfPath = path.join(root, '.github/workflows/datadir-acl-windows.yml');
const diag = path.join(root, 'sheark-miner/bench/win_acl_diag.mjs');

function fakeRoot(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-aclroot-'));
  fs.mkdirSync(path.join(dir, 'node/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node/src/datadir_acl.js'), body);
  return dir;
}

describe('datadir ACL on Windows CI', () => {
  it('a Windows job runs the ACL check on push and pull_request, with no || fallback', () => {
    const wf = fs.readFileSync(wfPath, 'utf8');
    assert.match(wf, /^ {2}push:/m);
    assert.match(wf, /^ {2}pull_request:/m);
    assert.match(wf, /runs-on: windows-latest/);
    assert.match(wf, /- 'node\/src\/datadir_acl\.js'/);
    assert.match(wf, /- '\.github\/workflows\/datadir-acl-windows\.yml'/);
    const run = wf.split('\n').filter((l) => /^\s+run: .*win_acl_diag\.mjs/.test(l));
    assert.equal(run.length, 1, run.join('\n'));
    assert.match(run[0], /^\s+run: node sheark-miner\/bench\/win_acl_diag\.mjs\s*$/);
    assert.doesNotMatch(wf, /\|\|/);
    assert.doesNotMatch(wf, /continue-on-error/);
  });
  it('sheark-packs no longer swallows a failed ACL diagnostic', () => {
    const wf = fs.readFileSync(path.join(root, '.github/workflows/sheark-packs.yml'), 'utf8');
    assert.doesNotMatch(wf, /win_acl_diag\.mjs \|\|/);
  });
  it('the diagnostic exits non-zero when ensureDatadir refuses', () => {
    const r = fakeRoot("export function ensureDatadir() { throw new Error('datadir_acl:verify'); }\n");
    const out = spawnSync(process.execPath, [diag, r], { encoding: 'utf8', timeout: 60_000 });
    fs.rmSync(r, { recursive: true, force: true });
    assert.notEqual(out.status, 0, out.stdout);
    assert.match(out.stdout, /refused: datadir_acl:verify/);
    assert.match(out.stdout + out.stderr, /ACL check FAILED/);
  });
  it('the diagnostic exits 0 when every directory is accepted', () => {
    const r = fakeRoot("export function ensureDatadir() { return { applied: false }; }\n");
    const out = spawnSync(process.execPath, [diag, r], { encoding: 'utf8', timeout: 60_000 });
    fs.rmSync(r, { recursive: true, force: true });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /ACL check ok/);
  });
  it('on this host the real datadir_acl.js accepts a fresh directory', () => {
    const out = spawnSync(process.execPath, [diag], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(out.status, 0, out.stdout + out.stderr);
  });
});

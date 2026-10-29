import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const mainSrc = path.join(here, 'zero_digest_alloc_main.c');

describe('ShearHash allocation failure is not a zero digest', () => {
  it('returns -1 when cache or VM allocation fails and does not yield zeros', () => {
    const out = path.join(os.tmpdir(), 'shear-zero-digest-alloc-v12.exe');
    const cc = spawnSync('gcc', [
      '-O2',
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-pthread',
      '-DSHEAR_MAX_VM=8',
      '-DSHEAR_ALLOC_FAIL_TEST',
      `-I${path.join(repo, 'sheark-miner', 'src')}`,
      `-I${path.join(repo, 'crypto', 'randomx', 'src')}`,
      '-o',
      out,
      mainSrc,
      path.join(repo, 'sheark-miner', 'src', 'shear_hash.c'),
      path.join(repo, 'sheark-miner', 'src', 'sha256.c'),
      path.join(repo, 'sheark-miner', 'src', 'sha512.c'),
    ], { timeout: 600_000, encoding: 'utf8' });
    assert.equal(cc.status, 0, `gcc zero-digest harness failed: ${cc.stderr || cc.stdout || cc.error}`);
    const got = spawnSync(out, [], { timeout: 600_000, encoding: 'utf8' });
    assert.equal(got.status, 0, got.stderr || got.stdout || String(got.error));
    assert.match(got.stdout, /max_vm=8/);
    assert.match(got.stdout, /cache rc=-1/);
    assert.match(got.stdout, /vm rc=-1/);
    assert.match(got.stdout, /allocation-failure-not-zero/);
  });
});

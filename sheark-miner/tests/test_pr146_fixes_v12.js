// PR146 review fixes (ME lane + PSA): fallbacks, memory limits, VM slots,
// share grace, launchers, bench clock, labels. Linux-only process limits
// (ulimit -v) are used to make the 260 MiB dataset unallocatable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.join(root, '..');
const bin = process.platform === 'win32' ? path.join(root, 'ShearK-Miner.exe') : path.join(root, 'ShearK-Miner');
const SELFTEST = 'e9e9dee13e2240383e0bdfb65ae962f52d9962a2e3bebd7623d418464ceb8cd4';
const linux = process.platform === 'linux';

function sh(cmd, opts = {}) {
  return spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 600_000, ...opts });
}

describe('PR146 P1-1: dataset alloc failure falls back to light JIT', () => {
  it('jit-full under a 360 MB address-space limit selftests on light JIT, not the interpreter', { skip: !linux }, () => {
    const r = sh(`ulimit -v 360000; exec "${bin}" --backend jit-full --selftest`);
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(r.stdout, new RegExp(`selftest ok ${SELFTEST} backend=jit\\b`));
    assert.match(r.stderr, /jit-full unavailable \(dataset alloc failed, \d+ MiB dataset\); using light JIT/);
    assert.doesNotMatch(out, /using interpreter/);
  });
  it('jit-full with room keeps the dataset', { skip: !linux }, () => {
    const r = sh(`exec "${bin}" --backend jit-full --selftest`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`selftest ok ${SELFTEST} backend=jit-full\\b`));
  });
});

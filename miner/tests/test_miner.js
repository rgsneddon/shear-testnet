import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'shear-miner');

describe('feeless C miner', () => {
  it('selftest and print-config are ShearHash with no fee login', () => {
    assert.equal(fs.existsSync(bin), true);
    const st = spawnSync(bin, ['--selftest'], { encoding: 'utf8' });
    assert.equal(st.status, 0, st.stderr + st.stdout);
    assert.match(st.stdout, /selftest ok/);
    assert.match(st.stdout, /client=ShearHash/);
    assert.match(st.stdout, /algorithm=ShearHash/);
    assert.match(st.stdout, /feeless=true/);
    assert.match(st.stdout, /dualLogin=false/);
    assert.doesNotMatch(st.stdout, /feeLogin=shear/);
    const cfg = spawnSync(bin, ['--print-config'], { encoding: 'utf8' });
    assert.equal(cfg.status, 0, cfg.stderr);
    const j = JSON.parse(cfg.stdout);
    assert.equal(j.client, 'ShearHash');
    assert.equal(j.algorithm, 'ShearHash');
    assert.equal(j.feeless, true);
    assert.equal(j.dualLogin, false);
    assert.equal(j.feeLogin, null);
    assert.equal(j.headerBytes, 120);
  });
});

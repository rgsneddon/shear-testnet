import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.platform === 'win32'
  ? path.join(root, 'shear-miner.exe')
  : path.join(root, 'shear-miner');

describe('C miner', () => {
  it('selftest and print-config are ShearHash', () => {
    assert.equal(fs.existsSync(bin), true, `missing miner binary at ${bin}`);
    const st = spawnSync(bin, ['--selftest'], { encoding: 'utf8' });
    assert.equal(st.status, 0, st.stderr + st.stdout);
    assert.match(st.stdout, /selftest ok/);
    assert.match(st.stdout, /client=ShearHash/);
    assert.match(st.stdout, /algorithm=ShearHash/);
    const cfg = spawnSync(bin, ['--print-config'], { encoding: 'utf8' });
    assert.equal(cfg.status, 0, cfg.stderr);
    const j = JSON.parse(cfg.stdout);
    assert.equal(j.client, 'ShearHash');
    assert.equal(j.algorithm, 'ShearHash');
    assert.equal(j.version, '0.1.0');
    assert.equal(j.pool, 'pool.shear.digital:1111');
    assert.equal(j.magic, 'shear-testnet-v1');
    assert.equal(j.headerBytes, 120);
  });
});

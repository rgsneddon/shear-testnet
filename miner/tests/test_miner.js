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
    assert.equal(j.version, '0.1.2');
    assert.equal(j.pool, 'pool.shear.digital:1111');
    assert.equal(j.magic, 'shear-testnet-v1');
    assert.equal(j.headerBytes, 120);
    const src = fs.readFileSync(path.join(root, 'src/shear_miner.c'), 'utf8');
    assert.equal(/MAX_THREADS/.test(src), false);
    assert.equal(/g_threads > MAX_THREADS/.test(src), false);
  });

  it('admits --user shp1 dests and refuses she1 and shear1', () => {
    const usage = spawnSync(bin, [], { encoding: 'utf8' });
    assert.match(usage.stderr + usage.stdout, /shp1/);
    assert.equal(/--user she1/.test(usage.stderr + usage.stdout), false);
    const refuse = spawnSync(bin, ['--pool', '127.0.0.1:1', '--user', 'shear1abc.worker'], {
      encoding: 'utf8',
    });
    assert.equal(refuse.status, 2);
    assert.match(refuse.stderr + refuse.stdout, /shp1/);
    const she = spawnSync(bin, ['--pool', '127.0.0.1:1', '--user', 'she1test.worker'], {
      encoding: 'utf8',
    });
    assert.equal(she.status, 2);
    const shp = spawnSync(bin, ['--pool', '127.0.0.1:1', '--user', 'shp1test.worker'], {
      encoding: 'utf8',
    });
    assert.equal(shp.status, 3);
    assert.match(shp.stderr + shp.stdout, /connect failed/);
  });
});

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
    assert.match(
      st.stdout,
      /selftest ok 6e95b9033c5d044d08bbf854fb2e5343ca3103b96ae37bde101258d43cfacc63/,
    );
    assert.match(st.stdout, /client=ShearHash/);
    assert.match(st.stdout, /algorithm=ShearHash/);
    assert.match(st.stdout, /x8-independent ok/);
    assert.equal(st.stdout.includes('1.0.6-max-autotune'), false);
    const cfg = spawnSync(bin, ['--print-config'], { encoding: 'utf8' });
    assert.equal(cfg.status, 0, cfg.stderr);
    const j = JSON.parse(cfg.stdout);
    assert.equal(j.client, 'ShearHash');
    assert.equal(j.algorithm, 'ShearHash');
    assert.equal(j.version, '0.1.3');
    assert.equal(j.pool, 'pool.shear.digital:1111');
    assert.equal(j.magic, 'shear-testnet-v1');
    assert.equal(j.headerBytes, 120);
    const src = fs.readFileSync(path.join(root, 'src/shear_miner.c'), 'utf8');
    assert.equal(/MAX_THREADS/.test(src), false);
    assert.equal(/g_threads > MAX_THREADS/.test(src), false);
    const thr = spawnSync(bin, ['--threads', '300', '--print-config'], { encoding: 'utf8' });
    assert.equal(thr.status, 0, thr.stderr);
    const jt = JSON.parse(thr.stdout);
    assert.equal(jt.threads, 300);
    const hashSrc = fs.readFileSync(path.join(root, 'src/shear_hash.c'), 'utf8');
    const minerSrc = fs.readFileSync(path.join(root, 'src/shear_miner.c'), 'utf8');
    assert.match(hashSrc, /shear_hash_x8/);
    assert.match(minerSrc, /1 hash = 1 tx/);
    assert.match(minerSrc, /Never fold the batch/);
    assert.equal(/FEE_ADDR/.test(minerSrc + hashSrc), false);
    assert.equal(/dual-login/.test(minerSrc + hashSrc), false);
    assert.equal(/g_fee_login/.test(minerSrc), false);
    const bench = spawnSync(bin, ['--bench', '1'], { encoding: 'utf8', timeout: 8000 });
    assert.equal(bench.status, 0, bench.stderr + bench.stdout);
    assert.match(bench.stdout, /backend=scalar-x8/);
    assert.match(bench.stdout, /hashes=/);
  });

  it('admits --user she1 and shp1, refuses rest-frame shear1', () => {
    const usage = spawnSync(bin, [], { encoding: 'utf8' });
    assert.match(usage.stderr + usage.stdout, /shp1/);
    assert.match(usage.stderr + usage.stdout, /she1/);
    const refuse = spawnSync(bin, ['--pool', '127.0.0.1:1', '--user', 'shear1abc.worker'], {
      encoding: 'utf8',
    });
    assert.equal(refuse.status, 2);
    assert.match(refuse.stderr + refuse.stdout, /not shear1/);
    const she = spawnSync(bin, ['--pool', '127.0.0.1:1', '--user', 'she1test.worker'], {
      encoding: 'utf8',
      timeout: 2500,
    });
    assert.match(she.stderr + she.stdout, /connect failed/);
    const shp = spawnSync(bin, ['--pool', '127.0.0.1:1', '--user', 'shp1test.worker'], {
      encoding: 'utf8',
      timeout: 2500,
    });
    assert.match(shp.stderr + shp.stdout, /connect failed/);
  });
});

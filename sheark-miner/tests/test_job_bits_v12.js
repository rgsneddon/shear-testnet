import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'job_bits_main.c');

describe('ShearK job widths', () => {
  it('takes share and block width from the job and invents neither', () => {
    const miner = fs.readFileSync(path.join(here, '..', 'src', 'sheark_miner.c'), 'utf8');
    const apply = miner.slice(miner.indexOf('static void apply_job'), miner.indexOf('static void install_live_job_locked'));
    assert.match(apply, /shear_job_widths\(/);
    assert.equal(apply.includes('sb > 0 ? sb : 8'), false);
    assert.equal(apply.includes('bits > 0 ? bits : 16'), false);
    const out = path.join(os.tmpdir(), 'shear-job-bits-v12.exe');
    const cc = spawnSync('gcc', ['-O2', '-std=c11', '-Wall', '-Wextra', '-o', out, src], { encoding: 'utf8' });
    assert.equal(cc.status, 0, cc.stderr || cc.stdout);
    const run = spawnSync(out, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /job widths ok/);
  });
});

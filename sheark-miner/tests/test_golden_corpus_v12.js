// R41: ShearK-Miner optimisation must be byte-identical. The corpus in
// sheark-miner/bench/golden_v12.txt (64 headers, 8 RandomX keys) was written
// by the R28 base miner's interpreter (13fb9376) with every key checked
// against node:crypto SHA-512 (bench/gen_golden.mjs). Every backend of the
// built miner must give the same digest and key. When bench/rxbench is built,
// the whole corpus also runs through the workers' pipelined
// hash_first/hash_next path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const miner = path.join(dir, `ShearK-Miner${exe}`);
const rxbench = path.join(dir, 'bench', `rxbench${exe}`);
const corpus = path.join(dir, 'bench', 'golden_v12.txt');

const rows = fs.readFileSync(corpus, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/));

function jsKey(h) {
  return createHash('sha512').update('ShearHash-v3/key').update(h.subarray(4, 36)).update(h.subarray(68, 100))
    .update(h.subarray(36, 68)).update(h.subarray(108, 112)).digest().subarray(0, 32).toString('hex');
}

describe('ShearK-Miner golden corpus (R41)', { timeout: 1_800_000 }, () => {
  it('the corpus is 64 rows over 8 RandomX keys', () => {
    assert.equal(rows.length, 64);
    const keys = new Set(rows.map(([h]) => jsKey(Buffer.from(h, 'hex'))));
    assert.equal(keys.size, 8);
  });

  for (const backend of ['interpreter', 'jit', 'jit-full']) {
    it(`--verify matches the corpus on ${backend}`, () => {
      assert.equal(fs.existsSync(miner), true, `missing ${miner}`);
      for (let i = 0; i < rows.length; i += 8) {
        const [hex, want] = rows[i + (i / 8) % 8];
        const run = spawnSync(miner, ['--backend', backend, '--verify', hex], { encoding: 'utf8', timeout: 600_000 });
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, new RegExp(`digest ${want}`), `row ${i}: ${run.stdout}`);
        assert.match(run.stdout, new RegExp(`k ${jsKey(Buffer.from(hex, 'hex'))}`));
      }
    });
  }

  it('rxbench --golden passes every row on the plain and pipelined paths', (t) => {
    if (!fs.existsSync(rxbench)) {
      t.skip('bench/rxbench not built (sheark-miner/bench/build_tree.sh)');
      return;
    }
    for (const backend of ['interpreter', 'jit', 'jit-full']) {
      const run = spawnSync(rxbench, ['--backend', backend, '--golden', corpus, '--threads', '0'], { encoding: 'utf8', timeout: 900_000 });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /golden n=64 pipelined=56 bad=0 .* ok/);
      assert.match(run.stdout, /hardaes=(0|1)/);
    }
  });

  // R41: hardware AES is used only when the CPU has it. The soft-AES build
  // (bench/build_tree.sh) stands in for a CPU without AES-NI or ARMv8 AES.
  it('the soft-AES path gives the same digests (hardaes=0)', (t) => {
    const soft = path.join(dir, 'bench', `rxbench-softaes${exe}`);
    if (!fs.existsSync(soft)) {
      t.skip('bench/rxbench-softaes not built (sheark-miner/bench/build_tree.sh)');
      return;
    }
    for (const backend of ['jit', 'jit-full']) {
      const run = spawnSync(soft, ['--backend', backend, '--golden', corpus, '--threads', '0'], { encoding: 'utf8', timeout: 900_000 });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /hardaes=0/);
      assert.match(run.stdout, /golden n=64 pipelined=56 bad=0 .* ok/);
    }
  });
});

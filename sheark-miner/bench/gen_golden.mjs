#!/usr/bin/env node
// R41: write the golden ShearHash-v3 corpus from a reference ShearK-Miner.
//   node gen_golden.mjs --miner PATH [--out golden_v12.txt]
// 8 key groups x 8 nonces, deterministic from a fixed seed. Each group shares
// the RandomX key (header bytes 4..100 and 108..112) so the corpus also drives
// the pipelined hash_first/hash_next path. The reference digest is the
// interpreter's; the key is checked against node:crypto SHA-512.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const miner = arg('miner');
const out = arg('out', 'golden_v12.txt');
let state = createHash('sha512').update('ShearK R41 golden corpus v12').digest();
const next = (n) => {
  const parts = [];
  let have = 0;
  while (have < n) {
    state = createHash('sha512').update(state).digest();
    parts.push(state);
    have += state.length;
  }
  return Buffer.concat(parts).subarray(0, n);
};
const lines = [];
for (let g = 0; g < 8; g += 1) {
  const base = next(128);
  base[0] = 1;
  for (let k = 0; k < 8; k += 1) {
    const h = Buffer.from(base);
    next(16).copy(h, 100, 0, 8); // timestamp bytes: outside the key
    next(8).copy(h, 112); // nonce
    const run = spawnSync(miner, ['--backend', 'interpreter', '--verify', h.toString('hex')], { encoding: 'utf8', timeout: 600_000 });
    const d = /digest ([0-9a-f]{64})/.exec(run.stdout || '');
    const kk = /k ([0-9a-f]{64})/.exec(run.stdout || '');
    if (run.status !== 0 || !d || !kk) throw new Error(`verify failed: ${run.stderr}`);
    const js = createHash('sha512').update('ShearHash-v3/key').update(h.subarray(4, 36)).update(h.subarray(68, 100))
      .update(h.subarray(36, 68)).update(h.subarray(108, 112)).digest().subarray(0, 32).toString('hex');
    if (js !== kk[1]) throw new Error(`key mismatch ${js} ${kk[1]}`);
    lines.push(`${h.toString('hex')} ${d[1]}`);
  }
}
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} lines to ${out}`);

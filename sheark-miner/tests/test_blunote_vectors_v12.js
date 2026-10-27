// R28: the rig's one-time keys and nonce binding (sheark-miner/src/blunote.c,
// libsodium ristretto255) match crypto/blunote.js byte for byte, so a share
// a real miner submits binds the key the node checks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointBytes, randomScalar, scalarBytes } from '../../crypto/note.js';
import { admitBasePub } from '../../crypto/admit.js';
import { bindValue, oneTimeKey, scanPub } from '../../crypto/blunote.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');

function compile() {
  const out = path.join(os.tmpdir(), `shear-blunote-vector-${process.pid}`);
  const cc = spawnSync('gcc', [
    '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-o', out,
    path.join(here, 'blunote_vector_main.c'),
    path.join(src, 'blunote.c'), path.join(src, 'sha256.c'),
    '-lsodium',
  ], { timeout: 600_000, encoding: 'utf8' });
  assert.equal(cc.status, 0, cc.stderr || cc.stdout);
  return out;
}

describe('BluNotes rig keys (C) match the node (JS)', () => {
  it('derives the same R, P, tag and binding for 32 random vectors', () => {
    const bin = compile();
    for (let i = 0; i < 32; i += 1) {
      const seed = randomBytes(32);
      const B = pointBytes(admitBasePub(seed));
      const Y = scanPub(seed);
      const r = randomScalar();
      const header = randomBytes(128);
      const js = oneTimeKey({ B, Y }, r);
      const run = spawnSync(bin, [
        Buffer.concat([B, Y]).toString('hex'),
        scalarBytes(r).toString('hex'),
        header.toString('hex'),
      ], { timeout: 60_000, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const [R, P, tag, bind] = run.stdout.trim().split(' ');
      assert.equal(R, js.R.toString('hex'));
      assert.equal(P, js.P.toString('hex'));
      assert.equal(Number(tag), js.tag);
      assert.equal(BigInt(bind), BigInt(bindValue(header, js.R, js.P)));
    }
  });

  it('refuses an address that is not two points', () => {
    const bin = compile();
    const bad = spawnSync(bin, ['ff'.repeat(64), '01'.padEnd(64, '0'), '00'.repeat(128)], { timeout: 60_000, encoding: 'utf8' });
    assert.equal(bad.status, 2);
  });
});

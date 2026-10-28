// R40: the miner's and node's SHA-512 (sheark-miner/src/sha512.c, which
// derives the RandomX key) is FIPS 180-4 SHA-512. Its K[53] was mistyped
// (0x4ed8aa4ae256485b for 0x4ed8aa4ae3418acb), so "abc" hashed to 2a0fbfd8…
// and every RandomX key differed from any standard SHA-512. Fixed with the
// v12/mainnet genesis (Russell 28 Oct, ruling 1).
//
// 1. The FIPS 180-4 example vectors, plus every padding boundary, against
//    node:crypto (OpenSSL).
// 2. shear_key, the RandomX key, from the C node addon and from ShearK-Miner
//    --verify, equals an independent JS derivation with node:crypto SHA-512.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HEADER_LEN, V3_SELFTEST_K, hashHex, shearKey, setHashBackend } from '../../crypto/shear_hash.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const miner = path.join(here, '..', process.platform === 'win32' ? 'ShearK-Miner.exe' : 'ShearK-Miner');

// FIPS 180-4 (NIST CSRC example values) SHA-512 vectors.
const FIPS = [
  ['', 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e'],
  ['abc', 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '204a8fc6dda82f0a0ced7beb8e08a41657c16ef468b228a8279be331a703c33596fd15c13b1b07f9aa1d3bea57789ca031ad85c7a71dd70354ec631238ca3445'],
  ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu', '8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909'],
];
const MILLION_A = 'e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b';

function compile() {
  const out = path.join(os.tmpdir(), `shear-sha512-fips-${process.pid}`);
  const cc = spawnSync('gcc', [
    '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-o', out,
    path.join(here, 'sha512_main.c'), path.join(src, 'sha512.c'),
  ], { timeout: 600_000, encoding: 'utf8' });
  assert.equal(cc.status, 0, cc.stderr || cc.stdout);
  return out;
}

function cHash(bin, args) {
  const run = spawnSync(bin, args, { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** shear_key (sheark-miner/src/shear_hash.c) with a standard SHA-512. */
function jsShearKey(header) {
  return createHash('sha512')
    .update('ShearHash-v3/key')
    .update(header.subarray(4, 36))
    .update(header.subarray(68, 100))
    .update(header.subarray(36, 68))
    .update(header.subarray(108, 112))
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

describe('R40: SHA-512 is FIPS 180-4', () => {
  it('matches the FIPS 180-4 example vectors and node:crypto at every padding boundary', () => {
    const bin = compile();
    try {
      for (const [msg, want] of FIPS) {
        assert.equal(createHash('sha512').update(msg).digest('hex'), want, 'vector table');
        assert.equal(cHash(bin, [Buffer.from(msg).toString('hex')]), want, JSON.stringify(msg));
      }
      assert.equal(cHash(bin, ['--a', '1000000']), MILLION_A);
      // Padding: one block, the length field's edge (111/112), and two blocks.
      for (const n of [1, 55, 56, 63, 64, 100, 111, 112, 113, 127, 128, 129, 239, 240, 255, 256, 1000]) {
        const m = randomBytes(n);
        assert.equal(cHash(bin, [m.toString('hex')]), createHash('sha512').update(m).digest('hex'), `len ${n}`);
      }
      // The mistyped constant gave this for "abc"; it must never come back.
      assert.notEqual(cHash(bin, ['616263']).slice(0, 8), '2a0fbfd8');
    } finally {
      fs.rmSync(bin, { force: true });
    }
  });

  it('shear_key from the C addon and ShearK-Miner equals a node:crypto derivation', () => {
    setHashBackend('interpreter');
    const selftest = Buffer.alloc(HEADER_LEN);
    selftest[0] = 1;
    assert.equal(jsShearKey(selftest), V3_SELFTEST_K);
    assert.equal(hashHex(shearKey(selftest)), V3_SELFTEST_K);
    assert.equal(fs.existsSync(miner), true, `missing ShearK-Miner at ${miner}: build it with make -C sheark-miner`);
    const headers = [selftest];
    for (let i = 0; i < 32; i += 1) headers.push(randomBytes(HEADER_LEN));
    for (const [i, h] of headers.entries()) {
      const js = jsShearKey(h);
      assert.equal(hashHex(shearKey(h)), js, `addon ${i}`);
      // The miner's own key, as it prints it for --verify.
      if (i < 4) {
        const got = spawnSync(miner, ['--backend', 'interpreter', '--verify', h.toString('hex')], { encoding: 'utf8', timeout: 600_000 });
        assert.equal(got.status, 0, got.stderr);
        assert.equal(/k ([0-9a-f]{64})/.exec(got.stdout)?.[1], js, `miner ${i}`);
      }
    }
  });
});

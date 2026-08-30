import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shearHash,
  shearHashV1,
  shearKey,
  hashHex,
  HEADER_LEN,
  PERSONAL,
  V1_SELFTEST,
  V2_SELFTEST,
  V2_SELFTEST_K,
  setHashBackend,
} from './shear_hash.js';
import { encodeHeader } from './header.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const miner = path.join(root, 'sheark-miner', 'ShearK-Miner');

function selftestHeader() {
  const h = Buffer.alloc(HEADER_LEN);
  h[0] = 1;
  return h;
}

function minerVerify(header, backend = 'interpreter') {
  const got = spawnSync(miner, ['--backend', backend, '--verify', header.toString('hex')], {
    encoding: 'utf8',
  });
  assert.equal(got.status, 0, got.stderr + got.stdout);
  const d = /digest ([0-9a-f]{64})/.exec(got.stdout);
  const k = /k ([0-9a-f]{64})/.exec(got.stdout);
  assert.ok(d && k, got.stdout);
  return { digest: d[1], k: k[1] };
}

describe('ShearHash-v2', () => {
  it('selftest header matches C interpreter vector and not v1', () => {
    const header = selftestHeader();
    setHashBackend('interpreter');
    assert.equal(PERSONAL, 'ShearHash-v2');
    assert.equal(hashHex(shearHash(header)), V2_SELFTEST);
    assert.equal(hashHex(shearKey(header)), V2_SELFTEST_K);
    assert.equal(hashHex(shearHashV1(header)), V1_SELFTEST);
    assert.notEqual(V2_SELFTEST, V1_SELFTEST);
    const c = minerVerify(header, 'interpreter');
    assert.equal(c.digest, V2_SELFTEST);
    assert.equal(c.k, V2_SELFTEST_K);
  });

  it('light JIT matches light interpreter on the selftest header', () => {
    const header = selftestHeader();
    const interp = minerVerify(header, 'interpreter');
    const jit = minerVerify(header, 'jit');
    assert.equal(interp.digest, jit.digest);
    assert.equal(interp.k, jit.k);
  });

  it('C vs node: 20 fixed headers share digest and K', () => {
    setHashBackend('interpreter');
    const cases = [];
    const z32 = Buffer.alloc(32);
    const ones = Buffer.alloc(32, 0xff);
    for (const bits of [14, 32]) {
      for (const nonce of [0n, (1n << 64n) - 1n]) {
        for (const continuity of [z32, ones]) {
          cases.push(encodeHeader({
            version: 1,
            prevBlockHash: z32,
            merkleRoot: Buffer.alloc(32, 2),
            continuityRoot: continuity,
            timestamp: 1_700_000_000_000n,
            bits,
            nonce,
            baseFee: 1n,
          }));
        }
      }
    }
    while (cases.length < 20) {
      const n = BigInt(cases.length);
      cases.push(encodeHeader({
        version: 1,
        prevBlockHash: Buffer.alloc(32, cases.length),
        merkleRoot: Buffer.alloc(32, 3),
        continuityRoot: Buffer.alloc(32, 4),
        timestamp: 1_700_000_000_000n + n,
        bits: 14,
        nonce: n,
        baseFee: 1n,
      }));
    }
    assert.equal(cases.length, 20);
    for (const header of cases) {
      const js = hashHex(shearHash(header));
      const kjs = hashHex(shearKey(header));
      const c = minerVerify(header, 'interpreter');
      assert.equal(js, c.digest);
      assert.equal(kjs, c.k);
    }
  });

  it('K changes when continuity_root changes; nonce-only keeps K', () => {
    setHashBackend('interpreter');
    const a = encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32, 1),
      continuityRoot: Buffer.alloc(32),
      timestamp: 1n,
      bits: 14,
      nonce: 0n,
    });
    const b = Buffer.from(a);
    b[112] = 1;
    const c = Buffer.from(a);
    c[68] = 1;
    const ka = hashHex(shearKey(a));
    const kb = hashHex(shearKey(b));
    const kc = hashHex(shearKey(c));
    assert.equal(ka, kb);
    assert.notEqual(hashHex(shearHash(a)), hashHex(shearHash(b)));
    assert.notEqual(ka, kc);
    assert.notEqual(hashHex(shearHash(a)), hashHex(shearHash(c)));
  });
});

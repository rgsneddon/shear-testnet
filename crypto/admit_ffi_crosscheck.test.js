/**
 * Old path: node crypto/wallet_native_prove.mjs (range oracle, stdin JSON).
 * New path: dlopen libshear_admit.so and call shear_range_prove, the same
 * C ABI as wallet/lib/shear_admit_ffi.dart. Fixed vectors must match.
 * prove_spend stays fail-closed until FS-1. This test does not re-enable it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commit, pointBytes, scalarBytes, scalarFrom } from './note.js';
import { nativeLoaded, nativeVerifyRange } from './native_admit.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mjs = path.join(root, 'crypto/wallet_native_prove.mjs');
const so = path.join(root, 'crypto/native/admit/target/release/libshear_admit.so');
const harnessSrc = path.join(root, 'crypto/native/prove_ffi_harness.c');
const harness = path.join(root, 'crypto/native/prove_ffi_harness');

function hex(b) {
  return Buffer.from(b).toString('hex');
}

function canon(byte) {
  const b = Buffer.alloc(32);
  b[0] = byte;
  return scalarBytes(scalarFrom(b));
}

function ensureBuilt() {
  assert.equal(nativeLoaded(), true, 'shearadmit.node must be built (npm run build:admit)');
  assert.equal(fs.existsSync(so), true, `missing ${so}`);
  const cc = spawnSync('cc', ['-O2', '-o', harness, harnessSrc, '-ldl'], { encoding: 'utf8' });
  assert.equal(cc.status, 0, cc.stderr || cc.stdout);
}

function runOld(req) {
  const r = spawnSync(process.execPath, [mjs], {
    input: JSON.stringify(req),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `old path failed ${r.status}\n${r.stderr}\n${r.stdout}`);
  const got = JSON.parse(r.stdout);
  assert.equal(got.ok, true);
  assert.equal(got.v, 2);
  return got;
}

function runNew(v, rHex) {
  const r = spawnSync(harness, [so, 'range', String(v), rHex], { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffi path failed ${r.status}\n${r.stderr}\n${r.stdout}`);
  const line = r.stdout.trim();
  assert.equal(line.startsWith('proof '), true, line);
  return line.slice('proof '.length);
}

describe('in-process range FFI matches the node range oracle', () => {
  it('wallet range path does not spawn node or write temp secrets', () => {
    const dart = fs.readFileSync(path.join(root, 'wallet/lib/shear_native_prove.dart'), 'utf8');
    const ffi = fs.readFileSync(path.join(root, 'wallet/lib/shear_admit_ffi.dart'), 'utf8');
    const sodium = fs.readFileSync(path.join(root, 'wallet/lib/shear_sodium.dart'), 'utf8');
    const helper = fs.readFileSync(mjs, 'utf8');
    assert.doesNotMatch(dart, /Process\.runSync/);
    assert.doesNotMatch(dart, /wallet_native_prove/);
    assert.doesNotMatch(dart, /systemTemp/);
    assert.match(dart, /zeroize/);
    assert.match(dart, /nativeVerifyRanges/);
    assert.match(ffi, /shear_range_prove/);
    assert.match(ffi, /shear_range_verify/);
    assert.match(ffi, /zeroize/);
    assert.doesNotMatch(ffi, /shear_admit_prove/);
    assert.doesNotMatch(ffi, /writeAsString|systemTemp/);
    assert.match(helper, /send unavailable until FS-1/);
    assert.doesNotMatch(helper, /admitProve/);
    assert.match(sodium, /libsodium\.so/);
    assert.match(sodium, /DynamicLibrary\.process/);
  });

  it('prove_spend stays fail-closed until FS-1', () => {
    const r = spawnSync(process.execPath, [mjs], {
      input: JSON.stringify({ op: 'prove_spend' }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 4, r.stdout);
    assert.match(r.stdout, /send unavailable until FS-1/);
  });

  it('range proofs match on fixed (v, r)', () => {
    ensureBuilt();
    const vectors = [0, 1, 42, (2 ** 32) + 9, '9223372036854775817', '18446744073709551615'];
    for (const v of vectors) {
      const r = canon(0x30 + (Number(BigInt(v)) & 0xff));
      const old = runOld({ op: 'prove_range', v, r: hex(r) });
      const neu = runNew(v, hex(r));
      assert.equal(neu, old.proof, `range v=${v}`);
      assert.equal(old.proof.slice(0, 2), '02');
      const C = pointBytes(commit(v, scalarFrom(r)));
      assert.equal(nativeVerifyRange(C, Buffer.from(old.proof, 'hex')), true, `verify v=${v}`);
    }
  });
});

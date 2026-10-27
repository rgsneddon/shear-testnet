/**
 * Old path: node crypto/wallet_native_prove.mjs (range oracle, stdin JSON).
 * New path: dlopen libshear_admit.so and call shear_range_prove, the same
 * C ABI as wallet/lib/shear_admit_ffi.dart. Production hedges are CSPRNG.
 * The same hedge must match across the packed prover and the native addon.
 * prove_spend stays fail-closed until FS-1. This test does not re-enable it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commit, pointBytes, provePackedRange, scalarBytes, scalarFrom } from './note.js';
import { nativeLoaded, nativeProveRange, nativeVerifyRange } from './native_admit.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mjs = path.join(root, 'crypto/wallet_native_prove.mjs');
const so = path.join(root, 'crypto/native/admit/target/debug/libshear_admit.so');
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
  // The wallet cdylib (no admit-v3) is a debug build that no CI step makes.
  // Build it here, as admit_wallet_symbols.test.js does, so this file does not
  // depend on which test ran first in its shard.
  const cargo = spawnSync(
    'cargo',
    ['build', '--lib', '--manifest-path', path.join(root, 'crypto/native/admit/Cargo.toml')],
    { timeout: 600_000, encoding: 'utf8' },
  );
  assert.equal(cargo.status, 0, cargo.stderr || cargo.stdout);
  assert.equal(fs.existsSync(so), true, `missing ${so}`);
  const cc = spawnSync('cc', ['-O2', '-o', harness, harnessSrc, '-ldl'], { timeout: 600_000, encoding: 'utf8' });
  assert.equal(cc.status, 0, cc.stderr || cc.stdout);
}

function runOld(req) {
  const r = spawnSync(process.execPath, [mjs], { timeout: 600_000,
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
  const r = spawnSync(harness, [so, 'range', String(v), rHex], { timeout: 600_000, encoding: 'utf8' });
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
    assert.match(dart, /requireRangeOffUi/);
    assert.doesNotMatch(dart, /Uint8List\.fromList/);
    assert.match(ffi, /shear_range_prove/);
    assert.match(ffi, /shear_range_verify/);
    assert.match(ffi, /zeroize/);
    assert.match(ffi, /rangeCap/);
    assert.match(ffi, /admitPinFailure/);
    assert.match(ffi, /!kDebugMode/);
    assert.doesNotMatch(ffi, /kReleaseMode/);
    assert.doesNotMatch(ffi, /shear_admit_prove/);
    assert.doesNotMatch(ffi, /writeAsString|systemTemp/);
    assert.match(helper, /send unavailable until FS-1/);
    assert.doesNotMatch(helper, /admitProve/);
    assert.match(sodium, /libsodium\.so/);
    assert.match(sodium, /DynamicLibrary\.process/);
  });

  it('prove_spend stays fail-closed until FS-1', () => {
    const r = spawnSync(process.execPath, [mjs], { timeout: 600_000,
      input: JSON.stringify({ op: 'prove_spend' }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 4, r.stdout);
    assert.match(r.stdout, /send unavailable until FS-1/);
  });

  function bitR0(proof, bit) {
    const off = 1 + 32 + 64 * 32 + bit * 192;
    return Buffer.from(proof.subarray(off, off + 32)).toString('hex');
  }

  it('the same hedge matches and two proofs on one blind do not reuse nonces', () => {
    ensureBuilt();
    const r = canon(0x37);
    const hedge = Buffer.alloc(32, 9);
    const js0 = provePackedRange(0, r, hedge);
    const js1 = provePackedRange(1, r, hedge);
    const native0 = nativeProveRange(0, r, hedge);
    const native1 = nativeProveRange(1, r, hedge);
    assert.ok(js0 && native0 && js1 && native1);
    assert.equal(native0.toString('hex'), js0.toString('hex'), 'hedged parity at v=0');
    assert.equal(native1.toString('hex'), js1.toString('hex'), 'hedged parity at v=1');
    assert.notEqual(bitR0(js0, 0), bitR0(js1, 0));
    assert.notEqual(bitR0(js0, 3), bitR0(js1, 3));
    const c0 = pointBytes(commit(0, scalarFrom(r)));
    const c1 = pointBytes(commit(1, scalarFrom(r)));
    assert.equal(nativeVerifyRange(c0, js0), true);
    assert.equal(nativeVerifyRange(c1, js1), true);
    const fresh = nativeProveRange(0, r);
    const other = nativeProveRange(0, r);
    assert.ok(fresh && other);
    assert.notEqual(fresh.toString('hex'), other.toString('hex'));
    assert.notEqual(bitR0(fresh, 0), bitR0(other, 0));
    assert.equal(nativeVerifyRange(c0, fresh), true);
    assert.equal(nativeVerifyRange(c0, other), true);
    const ffi = runNew(0, hex(r));
    assert.equal(ffi.slice(0, 2), '02');
    assert.equal(nativeVerifyRange(c0, Buffer.from(ffi, 'hex')), true);
    const oracle = runOld({ op: 'prove_range', v: 0, r: hex(r) });
    assert.equal(oracle.proof.slice(0, 2), '02');
    assert.notEqual(oracle.proof, hex(fresh));
    assert.equal(nativeVerifyRange(c0, Buffer.from(oracle.proof, 'hex')), true);
  });
});

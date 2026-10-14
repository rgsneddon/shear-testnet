/**
 * Native T21 prover (shear-fs1 t21_prove) against the JS prover. Needs a
 * pinned binary (SHEAR_T21_PROVE_BIN, SHEAR_T21_PROVE_SHA256); CI sets
 * SHEAR_T21_PROVE_REQUIRE=1 so a missing binary fails instead of skipping.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { G, H, pointBytes } from './note.js';
import { buildT21Coinbase, t21ShareNc, verifyT21Coinbase } from './t21.js';
import { publicVoucher, voucherAt, voucherKeysOk } from './t21_voucher.js';
import { W_HASH_MAX } from './t21_params.js';
import { t21ProveBinSha256, t21ProverEngine, t21ProverInfo } from './t21_native.js';

const info = t21ProverInfo();
if (process.env.SHEAR_T21_PROVE_REQUIRE === '1' && !info.native) throw new Error(`t21_prove required: ${info.reason}`);
const skip = info.native ? false : `no pinned t21_prove (${info.reason})`;

const magic = 'shear-testnet-v12';
const prevHash = Buffer.alloc(32, 1);

function vouchers(n, base) {
  const out = [];
  for (let k = 0; out.length < n; k += 1) {
    const v = voucherAt(Buffer.alloc(32, base + out.length), k);
    if (voucherKeysOk(publicVoucher(v))) out.push(v);
  }
  return out;
}

const [va, vb, vc, vfee] = vouchers(4, 0x21);
// Fixed betas, so both builds see the same share secrets.
function fixedShare(v, w, k) {
  const beta = BigInt(1000 + k) * 7919n;
  return { w: BigInt(w), E: pointBytes(G.multiply(v.lambda).add(H.multiply(beta))), ell: v.lambda, beta };
}

function spec(over = {}) {
  return {
    S: 50_000_000_000n,
    cin: 9n,
    bps: 100,
    u: 3n,
    height: 21,
    magic,
    prevHash,
    seed: Buffer.alloc(32, 0x5e),
    dummySecret: Buffer.alloc(32, 9),
    fee: { voucher: publicVoucher(vfee) },
    payees: [
      { voucher: publicVoucher(va), shares: [fixedShare(va, 70_000, 1), fixedShare(va, 1_234, 2)], fin: 5_000n },
      { voucher: publicVoucher(vb), shares: [fixedShare(vb, 90_001, 3)] },
      { voucher: publicVoucher(vc), shares: [fixedShare(vc, 3, 4)] },
    ],
    ...over,
  };
}

function expectFor(tx) {
  return {
    S: BigInt(tx.t21.S),
    cin: BigInt(tx.t21.cin),
    u: BigInt(tx.t21.u),
    height: tx.t21.height,
    magic,
    prevHash,
    shares: tx.t21.shares.map((s) => ({ nc: t21ShareNc(magic, s.E), units: BigInt(s.w) })),
    prevEs: new Set(),
    vaults: [],
    hashBudget: BigInt(tx.t21.u) * W_HASH_MAX,
  };
}

function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) {
    old[k] = process.env[k];
    if (env[k] == null) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(old)) {
      if (old[k] == null) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

function fakeBin(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't21-prove-'));
  const bin = path.join(dir, 't21_prove');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, sha256: t21ProveBinSha256(bin) };
}

describe('native T21 prover', { skip }, () => {
  let js = null;

  it('builds the same coinbase bytes as the JS prover (fee row, finder row, dummy row)', () => {
    js = buildT21Coinbase(spec({ prover: 'js' }));
    const native = buildT21Coinbase(spec({ prover: 'native' }));
    assert.equal(native.tx.vout.length, 5);
    assert.deepEqual(native.tx, js.tx);
    assert.deepEqual(native.secrets, js.secrets);
    const ok = verifyT21Coinbase({ tx: native.tx, expect: expectFor(native.tx) });
    assert.equal(ok.ok, true, ok.reason);
  });

  it('evicts a payee whose row is never a leaf, as the JS prover does', () => {
    const s = spec({ prover: 'native' });
    s.payees[1] = { ...s.payees[1], forceNonLeaf: true };
    const built = buildT21Coinbase(s);
    assert.deepEqual(built.deferred.map((d) => d.reason), ['admit_note_point']);
    assert.equal(Buffer.from(built.deferred[0].voucher.B).equals(Buffer.from(publicVoucher(vb).B)), true);
    const ok = verifyT21Coinbase({ tx: built.tx, expect: expectFor(built.tx) });
    assert.equal(ok.ok, true, ok.reason);
  });

  it('refuses a pinned binary whose hash does not match, and is off when unpinned', () => {
    assert.throws(() => t21ProverEngine({ sha256: '00'.repeat(32) }), /t21_prove_bin_hash/);
    assert.equal(t21ProverEngine({ sha256: '' }), null);
    assert.equal(t21ProverInfo({ sha256: '' }).native, false);
  });

  it('a broken tool fails a native-only build and falls back to JS otherwise', () => {
    const broken = fakeBin('#!/bin/sh\necho "row 0 junk"\necho ok\n');
    withEnv({ SHEAR_T21_PROVE_BIN: broken.bin, SHEAR_T21_PROVE_SHA256: broken.sha256 }, () => {
      assert.throws(() => buildT21Coinbase(spec({ prover: 'native' })), (err) => err.engine === true);
      const fallback = buildT21Coinbase(spec());
      assert.deepEqual(fallback.tx, js.tx);
    });
  });

  it('a tool that refuses the request is an error, not a fallback', () => {
    const refusing = fakeBin('#!/bin/sh\ncat >/dev/null\necho "error gen_h -"\n');
    withEnv({ SHEAR_T21_PROVE_BIN: refusing.bin, SHEAR_T21_PROVE_SHA256: refusing.sha256 }, () => {
      assert.throws(() => buildT21Coinbase(spec()), /t21_native_gen_h/);
    });
  });
});

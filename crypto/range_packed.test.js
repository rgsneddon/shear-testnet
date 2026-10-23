import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { sha512 } from '@noble/hashes/sha2.js';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import {
  G,
  H,
  pointBytes,
  provePackedRange,
  proveRange,
  randomScalar,
  scalarBytes,
  verifyPackedRange,
  verifyRange,
} from './note.js';
import { nativeLoaded, nativeProveRange, nativeVerifyRange, noteH } from './native_admit.js';

const NOTE_H = 'feea2914bda937d74acc1efa93bf1094f65ae709628a7aad9d1b913b6c80c301';
const FS1_SPEND_DIGEST = '4aab173c8065e7e5cff88945399b98cbbb51f647297231d09cb069c82f965288eaaf3ecb9ea88ae4e3de1dde2623710fe5e4f4353c529ef613fac9ff8b0699e6';

const U64_MAX = (1n << 64n) - 1n;
const L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;

function commitReduced(v, rBytes) {
  const r = RistrettoPoint.Fn.create(bytesToNumberLE(rBytes));
  return pointBytes(G.multiplyUnsafe(v).add(H.multiplyUnsafe(r)));
}

function addL(bytes) {
  const limb = [
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9,
    0xde, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x10,
  ];
  const out = Buffer.from(bytes);
  let carry = 0;
  for (let i = 0; i < 32; i += 1) {
    const sum = out[i] + limb[i] + carry;
    out[i] = sum & 0xff;
    carry = sum >> 8;
  }
  assert.equal(carry, 0);
  return out;
}

const FIXED_HEDGE = Buffer.alloc(32, 9);

function assertNativeBytes(v, r, label) {
  const js = provePackedRange(v, r, FIXED_HEDGE);
  assert.ok(js && js.length === 14433 && js[0] === 2, `js ${label}`);
  const native = nativeProveRange(typeof v === 'bigint' ? v.toString() : v, r, FIXED_HEDGE);
  assert.ok(native, `native ${label}`);
  assert.equal(Buffer.from(native).equals(js), true, `bytes ${label}`);
  const c = commitReduced(v, r);
  assert.equal(nativeVerifyRange(c, js), true, `native open ${label}`);
  assert.equal(verifyRange(c, js), true, `verifyRange ${label}`);
  return js;
}

describe('packed range proof matches bpplus.rs', () => {
  it('requires the native module and the pinned note H', () => {
    assert.equal(nativeLoaded(), true, 'shearadmit.node must be loaded; the byte comparison does not skip');
    const wide = sha512(Buffer.concat([
      Buffer.from('shear-bpplus-v2'),
      Buffer.from('shear-note-H-v1'),
    ]));
    const js = Buffer.from(RistrettoPoint.hashToCurve(wide).toBytes());
    assert.equal(js.toString('hex'), NOTE_H);
    assert.equal(js.equals(Buffer.from(noteH())), true);
    assert.equal(Buffer.from(H.toBytes()).toString('hex'), NOTE_H);
    const doc = readFileSync(new URL('../docs/RANGE-H-AND-FS1-PIN.md', import.meta.url), 'utf8');
    assert.equal(doc.includes(NOTE_H), true);
    assert.equal(doc.includes(FS1_SPEND_DIGEST), true);
    const vector = readFileSync(new URL('./native/vendor/monero-oxide-77788c3/shear-fs1/vectors/generators.txt', import.meta.url), 'utf8');
    const digestLine = vector.split('\n').find((line) => line.startsWith('digest'));
    assert.equal(digestLine.split('\t')[1], FS1_SPEND_DIGEST);
    const spec = readFileSync(new URL('../specs/100c.md', import.meta.url), 'utf8');
    assert.equal(spec.includes(FS1_SPEND_DIGEST), true);
  });

  it('agrees with the native prover on wire bytes', () => {
    assert.equal(nativeLoaded(), true, 'shearadmit.node must be loaded; the byte comparison does not skip');
    const amounts = [0n, 1n, 255n, (1n << 32n) + 9n, 100_000_000_000n, 1n << 63n, U64_MAX];
    const blinds = [
      scalarBytes(randomScalar()),
      Buffer.alloc(32, 7),
      Buffer.from(L.toString(16).padStart(64, '0'), 'hex').reverse(),
    ];
    for (const r of blinds) {
      for (const v of amounts) {
        const js = assertNativeBytes(v, r, String(v));
        const c = commitReduced(v, r);
        assert.equal(verifyPackedRange(c, js), true, `js open ${v}`);
        const neighbor = v === U64_MAX ? v - 1n : v + 1n;
        assert.equal(verifyPackedRange(commitReduced(neighbor, r), js), false);
      }
    }
    const r = scalarBytes(randomScalar());
    assert.equal(proveRange(256, r).length, 14433);
    assert.equal(provePackedRange((U64_MAX + 1n).toString(), r), null);
    assert.equal(proveRange('-1', r).length, 0);
  });

  it('matches native bytes for random amounts and blinds', () => {
    assert.equal(nativeLoaded(), true, 'shearadmit.node must be loaded; the byte comparison does not skip');
    for (let i = 0; i < 8; i += 1) {
      const v = bytesToNumberLE(randomBytes(8));
      const r = randomBytes(32);
      assertNativeBytes(v, r, `random ${i}`);
    }
  });

  it('production proofs of the same input differ', () => {
    assert.equal(nativeLoaded(), true, 'shearadmit.node must be loaded; the byte comparison does not skip');
    const r = scalarBytes(randomScalar());
    const first = proveRange(7, r);
    const second = proveRange(7, r);
    assert.equal(first.length, 14433);
    assert.equal(second.length, 14433);
    assert.equal(Buffer.from(first).equals(second), false);
    const nativeA = nativeProveRange(7, r);
    const nativeB = nativeProveRange(7, r);
    assert.ok(nativeA && nativeB);
    assert.equal(Buffer.from(nativeA).equals(Buffer.from(nativeB)), false);
    assert.equal(Buffer.from(nativeA).equals(provePackedRange(7, r, FIXED_HEDGE)), false);
  });

  it('rejects a short, trailing, or non-canonical proof', () => {
    const r = Buffer.alloc(32, 9);
    const v = 4n;
    const proof = provePackedRange(v, r);
    const c = commitReduced(v, r);
    assert.equal(verifyPackedRange(c, Buffer.alloc(0)), false);
    assert.equal(verifyPackedRange(c, proof.subarray(0, proof.length - 1)), false);
    const trail = Buffer.concat([proof, Buffer.from([0])]);
    assert.equal(verifyPackedRange(c, trail), false);
    const flipped = Buffer.from(proof);
    flipped[0] = 1;
    assert.equal(verifyPackedRange(c, flipped), false);
    const zAt = proof.length - 32;
    const lifted = Buffer.from(proof);
    lifted.set(addL(proof.subarray(zAt)), zAt);
    assert.equal(verifyPackedRange(c, lifted), false, 'non-canonical z');
    assert.equal(nativeLoaded(), true, 'shearadmit.node must be loaded; the byte comparison does not skip');
    assert.equal(nativeVerifyRange(c, lifted), false);
  });
});

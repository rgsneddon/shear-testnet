import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

describe('packed range proof matches bpplus.rs', () => {
  it('uses the consensus note generator', () => {
    const wide = sha512(Buffer.concat([
      Buffer.from('shear-bpplus-v2'),
      Buffer.from('shear-note-H-v1'),
    ]));
    const js = Buffer.from(RistrettoPoint.hashToCurve(wide).toBytes());
    if (nativeLoaded()) assert.equal(js.equals(Buffer.from(noteH())), true);
    assert.equal(js.length, 32);
  });

  it('agrees with the native prover on wire bytes', () => {
    const amounts = [0n, 1n, 255n, (1n << 32n) + 9n, 100_000_000_000n, 1n << 63n, U64_MAX];
    const blinds = [
      scalarBytes(randomScalar()),
      Buffer.alloc(32, 7),
      Buffer.from(L.toString(16).padStart(64, '0'), 'hex').reverse(),
    ];
    for (const r of blinds) {
      for (const v of amounts) {
        const js = provePackedRange(v, r);
        assert.ok(js && js.length === 14433 && js[0] === 2, `js ${v}`);
        const c = commitReduced(v, r);
        assert.equal(verifyPackedRange(c, js), true, `js open ${v}`);
        const neighbor = v === U64_MAX ? v - 1n : v + 1n;
        assert.equal(verifyPackedRange(commitReduced(neighbor, r), js), false);
        if (!nativeLoaded()) continue;
        const native = nativeProveRange(typeof v === 'bigint' ? v.toString() : v, r);
        assert.ok(native, `native ${v}`);
        assert.equal(Buffer.from(native).equals(js), true, `bytes ${v}`);
        assert.equal(nativeVerifyRange(c, js), true, `native open ${v}`);
        assert.equal(verifyRange(c, js), true);
      }
    }
    const r = scalarBytes(randomScalar());
    assert.equal(proveRange(256, r).length, 14433);
    assert.equal(provePackedRange((U64_MAX + 1n).toString(), r), null);
    assert.equal(proveRange('-1', r).length, 0);
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
    if (nativeLoaded()) assert.equal(nativeVerifyRange(c, lifted), false);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { G, H, randomScalar } from './note.js';
import { bpProve, bpSize, bpVerify } from './t21_bp.js';

const Point = RistrettoPoint;

function commitAll(values, blinds) {
  return values.map((v, i) => {
    const g = v === 0n ? Point.ZERO : G.multiply(v);
    return blinds[i] === 0n ? g : g.add(H.multiply(blinds[i]));
  });
}

describe('t21 aggregated range proof', () => {
  const n = 16;
  const values = [0n, 1n, 65535n, 1234n, 7n, 0n, 42n, 65000n];
  const blinds = values.map((_, i) => (i === 5 ? 0n : randomScalar()));
  const seed = Buffer.from('bp-test');
  const proof = bpProve(values, blinds, n, seed);
  const V = commitAll(values, blinds);

  it('verifies, including a zero pad with a zero blind', () => {
    assert.equal(bpVerify(V, proof, n, seed), true);
  });

  it('has the published size', () => {
    assert.equal(bpSize(8, 16), (4 + 2 * 7) * 32 + 5 * 32);
    assert.equal(bpSize(32, 16), 864);
  });

  it('fails on another seed, a swapped commitment, or a tampered scalar', () => {
    assert.equal(bpVerify(V, proof, n, Buffer.from('other')), false);
    const swapped = V.slice();
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    assert.equal(bpVerify(swapped, proof, n, seed), false);
    const bad = { ...proof, a: Buffer.from(proof.a).fill(1, 0, 1) };
    assert.equal(bpVerify(V, bad, n, seed), false);
  });

  it('refuses a non-canonical scalar (a + L)', () => {
    let a = 0n;
    const ab = Buffer.from(proof.a);
    for (let i = 31; i >= 0; i -= 1) a = (a << 8n) | BigInt(ab[i]);
    const big = a + Point.Fn.ORDER;
    if (big >= 1n << 256n) return;
    const out = Buffer.alloc(32);
    let x = big;
    for (let i = 0; i < 32; i += 1) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    assert.equal(bpVerify(V, { ...proof, a: out }, n, seed), false);
  });

  it('does not prove a value at 2^16', () => {
    const vals = values.slice();
    vals[3] = 1n << 16n;
    let ok;
    try {
      ok = bpVerify(commitAll(vals, blinds), bpProve(vals, blinds, n, seed), n, seed);
    } catch {
      ok = false;
    }
    assert.equal(ok, false);
  });
});

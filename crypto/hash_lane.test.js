import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashLaneBackend } from './hash_lane.js';
import { hashHeaderOffLoop, p2pHashCap, P2P_VERIFY_CAP } from './hash_offloop.js';
import { shearHash } from './shear_hash.js';

describe('hash lane', { timeout: 60_000 }, () => {
  it('defaults to jit light unless SHEAR_HASH_BACKEND is set', () => {
    assert.equal(hashLaneBackend({}), 'jit');
    assert.equal(hashLaneBackend({ SHEAR_HASH_BACKEND: '' }), 'jit');
    assert.equal(hashLaneBackend({ SHEAR_HASH_BACKEND: 'interpreter' }), 'interpreter');
    assert.notEqual(hashLaneBackend({}), 'jit-full');
  });

  it('two lanes return the header each was given', async () => {
    const h1 = Buffer.alloc(128, 3);
    const h2 = Buffer.alloc(128, 4);
    h2[112] = 9;
    const [a, b] = await Promise.all([hashHeaderOffLoop(h1), hashHeaderOffLoop(h2)]);
    assert.equal(Buffer.from(a).equals(shearHash(h1)), true);
    assert.equal(Buffer.from(b).equals(shearHash(h2)), true);
    assert.equal(p2pHashCap(), P2P_VERIFY_CAP);
    assert.equal(P2P_VERIFY_CAP, 2);
  });
});

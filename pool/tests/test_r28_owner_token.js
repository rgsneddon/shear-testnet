// P3: the owner token compare must be constant-time. A plain === on the
// bearer token leaks the matching prefix through timing. Cite FROZEN-v2
// dc1e64a173886f9c156c3c105250e84db3261b5b7a30848b4d6089750b35682f.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ownerTokenEquals } from '../src/pool.js';

describe('owner token compare', () => {
  it('matches the whole token and rejects a different length or a one-byte change', () => {
    const token = 'ab'.repeat(16);
    assert.equal(ownerTokenEquals(token, token), true);
    assert.equal(ownerTokenEquals(token, 'cd'.repeat(16)), false);
    assert.equal(ownerTokenEquals(token, `${token.slice(0, 31)}e`), false);
    assert.equal(ownerTokenEquals(token, token.slice(1)), false);
    assert.equal(ownerTokenEquals(token, ''), false);
    assert.equal(ownerTokenEquals('', token), false);
  });
});

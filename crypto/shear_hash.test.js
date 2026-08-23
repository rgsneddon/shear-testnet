import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shearHash, hashHex, HEADER_LEN } from './shear_hash.js';

describe('ShearHash vector', () => {
  it('matches the C miner selftest header', () => {
    const header = Buffer.alloc(HEADER_LEN);
    header[0] = 1;
    assert.equal(
      hashHex(shearHash(header)),
      '6e95b9033c5d044d08bbf854fb2e5343ca3103b96ae37bde101258d43cfacc63',
    );
  });
});

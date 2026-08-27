import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shearHash, hashHex, HEADER_LEN } from './shear_hash.js';

describe('ShearHash vector', () => {
  it('matches the C miner selftest header', () => {
    const header = Buffer.alloc(HEADER_LEN);
    header[0] = 1;
    assert.equal(
      hashHex(shearHash(header)),
      '5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066',
    );
  });
});

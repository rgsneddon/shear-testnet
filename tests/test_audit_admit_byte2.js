import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selfCheck } from '../scripts/audit_admit_byte2.js';

describe('admit byte-2 genesis audit', () => {
  it('counts sealed admit blobs and ignores a range proof that starts with byte 2', () => {
    const got = selfCheck();
    assert.deepEqual(got.failures, []);
    assert.equal(got.ok, true);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreShare } from '../src/pool.js';
import { encodeHeader } from '../../crypto/header.js';
import { shearHash, shearHashV1, hashHex, V1_SELFTEST, V2_SELFTEST, HEADER_LEN } from '../../crypto/shear_hash.js';
import { EMPTY_ROOT } from '../../crypto/merkle.js';

const z32 = Buffer.alloc(32);

describe('pool ShearHash-v2 share gate', () => {
  it('accepts a v2 digest that meets shareBits and rejects a pretender nonce', () => {
    const header = encodeHeader({
      prevBlockHash: z32,
      merkleRoot: EMPTY_ROOT,
      continuityRoot: EMPTY_ROOT,
      timestamp: 1n,
      bits: 32,
      nonce: 0n,
    });
    const job = {
      jobId: 'v2-1',
      height: 1,
      version: 1,
      header: header.toString('hex'),
      shareBits: 1,
      blockBits: 32,
      bits: 32,
      nonce: '0',
      timestamp: '1',
      baseFee: '1',
      prevBlockHash: z32.toString('hex'),
      merkleRoot: EMPTY_ROOT.toString('hex'),
      continuityRoot: EMPTY_ROOT.toString('hex'),
    };
    let hit = null;
    for (let n = 0n; n < 4096n; n += 1n) {
      const s = scoreShare({ job, nonce: n });
      if (s.ok) {
        hit = s;
        break;
      }
    }
    assert.ok(hit, 'expected a shareBits=1 v2 hit');
    assert.equal(hit.hash.length, 64);
    assert.notEqual(hit.hash, V1_SELFTEST);

    const miss = scoreShare({ job: { ...job, shareBits: 32 }, nonce: 0n });
    assert.equal(miss.ok, false);
    assert.equal(miss.reason, 'low_diff');
  });

  it('v1 selftest header is not a v2 digest', () => {
    const header = Buffer.alloc(HEADER_LEN);
    header[0] = 1;
    assert.equal(hashHex(shearHashV1(header)), V1_SELFTEST);
    assert.equal(hashHex(shearHash(header)), V2_SELFTEST);
    assert.notEqual(V1_SELFTEST, V2_SELFTEST);
  });
});

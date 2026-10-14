import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUED_HEADER_CAP } from '../../crypto/share_batch.js';
import { collectIssuedHeaders } from '../src/pool.js';

function hdr(n) {
  const buf = Buffer.alloc(128, 0);
  buf.writeUInt32BE(n >>> 0, 120);
  return buf.toString('hex');
}

describe('issued headers keep the live round', () => {
  it('pins the live job and takes newer headers before older ones', () => {
    const jobs = new Map();
    const count = ISSUED_HEADER_CAP + 10;
    for (let i = 0; i < count; i += 1) {
      const header = hdr(i + 1);
      jobs.set(`j${i}`, { job: { jobId: `j${i}`, header } });
    }
    const newest = hdr(count);
    const oldest = hdr(1);
    const liveHeader = hdr(900_000);
    const prior = hdr(900_001);
    const live = { jobId: 'live', header: liveHeader, headerHistory: [prior] };
    const got = collectIssuedHeaders(jobs, [oldest], live);
    assert.equal(got.length, ISSUED_HEADER_CAP);
    assert.equal(got[0], liveHeader);
    assert.equal(got[1], prior);
    assert.equal(got.includes(newest), true);
    assert.equal(got.includes(oldest), false);

    const ordered = collectIssuedHeaders([
      { header: oldest },
      { header: newest },
    ]);
    assert.deepEqual(ordered, [newest, oldest]);
  });
});

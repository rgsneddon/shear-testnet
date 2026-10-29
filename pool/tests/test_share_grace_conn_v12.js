// R41: a per-connection share-target change (per-dest vardiff, or a
// broadcast carrying a dest's dial) keeps honouring the old byte for 12 s,
// as a job-level change already did. Before the fix the old byte had no
// grace at all, so the share in flight at each vardiff step was rejected as
// share_target (1-4% of shares in the R41 loopback runs, every step).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeHeader, setNonce } from '../../crypto/header.js';
import { GENESIS_BITS_PACKED, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import { nonceWithShareTarget } from '../../crypto/share_batch.js';
import { judgeShare, noteConnShareBits, PREV_JOB_GRACE_MS } from '../src/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const A = SHARE_FLOOR_BITS + 2;

/** A digest with exactly `bits` leading zero bits: meets A, misses A+1. */
function digestAt(bits) {
  const h = Buffer.alloc(32, 0xff);
  for (let i = 0; i < bits; i += 1) h[i >> 3] &= ~(0x80 >> (i & 7));
  return h;
}

function setup() {
  const parent = encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: 1_700_000_000_000,
    bits: GENESIS_BITS_PACKED,
  });
  const header = setNonce(parent, nonceWithShareTarget(7n, A));
  // No job-level change: the template stays at A+1 throughout.
  const job = { shareBits: A + 1, shareBitsPrev: 0, shareBitsAt: 0, shareBitsHist: [], header, blockBits: 255 };
  return { header, job, hash: digestAt(A) };
}

describe('pool: a per-connection share-target step keeps a 12 s grace (R41)', () => {
  it('the digest meets the old byte and misses the new one', () => {
    const { hash } = setup();
    assert.equal(meetsTarget(hash, A), true);
    assert.equal(meetsTarget(hash, A + 1), false);
  });

  it('a share hashed at the old byte, landing just after a vardiff step, is credited', () => {
    const { header, job, hash } = setup();
    const conn = { shareBits: A };
    noteConnShareBits(conn, A + 1);
    assert.equal(conn.shareBits, A + 1);
    const got = judgeShare({ job, header, hash, dest: '', shareBits: conn.shareBits, connHist: conn.shareBitsHist });
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.creditedShareBits, A);
  });

  it('without the connection history (the old behaviour) the same share is share_target', () => {
    const { header, job, hash } = setup();
    const got = judgeShare({ job, header, hash, dest: '', shareBits: A + 1 });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'share_target');
  });

  it('the grace ends after 12 s, and an unrelated byte never gets it', () => {
    const { header, job, hash } = setup();
    const conn = { shareBits: A };
    noteConnShareBits(conn, A + 1, Date.now() - PREV_JOB_GRACE_MS - 1);
    assert.equal(judgeShare({ job, header, hash, dest: '', shareBits: A + 1, connHist: conn.shareBitsHist }).reason, 'share_target');
    const other = { shareBits: A - 1 };
    noteConnShareBits(other, A + 1);
    assert.equal(judgeShare({ job, header, hash, dest: '', shareBits: A + 1, connHist: other.shareBitsHist }).reason, 'share_target');
  });

  it('every connection target change in the pool goes through noteConnShareBits', () => {
    const src = fs.readFileSync(path.join(here, '..', 'src', 'pool.js'), 'utf8');
    assert.equal(/\bc\.shareBits\s*=(?!=)/.test(src), false, 'set c.shareBits only via noteConnShareBits');
    assert.match(src, /connHist: conn\?\.shareBitsHist/);
  });
});

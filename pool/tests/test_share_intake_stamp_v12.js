/**
 * An accepted share is stored with the header that was hashed.
 * A row that names no header is not accepted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { clearLiveSharePow, nonceWithShareTarget } from '../../crypto/share_batch.js';
import { bindAcceptedShare } from '../src/pool.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function parentHeader(tag) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32, tag & 0xff),
    merkleRoot: Buffer.alloc(32, (tag + 3) & 0xff),
    continuityRoot: Buffer.alloc(32, (tag + 7) & 0xff),
    timestamp: 1_700_000_000_000 + tag,
    bits: 1114112,
  });
}

describe('accepted shares are stamped on intake', () => {
  it('stamps verifiedHeader on every accepted row and drops a row with no header', () => {
    clearLiveSharePow();
    const dest = minerDest();
    const other = minerDest();
    const open = [];
    const headers = [parentHeader(1), parentHeader(2), parentHeader(3)];
    const lows = [1n, 9n, 44n];
    for (let i = 0; i < headers.length; i += 1) {
      const nonce = nonceWithShareTarget(lows[i], SHARE_FLOOR_BITS);
      const rec = {
        dest: i === 1 ? other : dest,
        nonce,
        hash: `${i + 1}`.repeat(64).slice(0, 64),
        lz: SHARE_FLOOR_BITS,
        shareBits: SHARE_FLOOR_BITS,
      };
      if (i === 0) rec.verifiedHeader = headers[i];
      else rec.header = headers[i];
      const got = bindAcceptedShare(open, rec);
      assert.equal(got.ok, true, got.reason || `row ${i}`);
    }
    assert.equal(open.length, headers.length);
    for (let i = 0; i < open.length; i += 1) {
      assert.ok(open[i].verifiedHeader, `row ${i} has no verifiedHeader`);
      const raw = Buffer.isBuffer(open[i].verifiedHeader)
        ? open[i].verifiedHeader
        : Buffer.from(String(open[i].verifiedHeader), 'hex');
      assert.ok(raw.equals(headers[i]), `row ${i} header`);
    }
    const bare = bindAcceptedShare(open, {
      dest,
      nonce: nonceWithShareTarget(90n, SHARE_FLOOR_BITS),
      hash: 'ab'.repeat(32),
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
    });
    assert.equal(bare.ok, false);
    assert.equal(bare.reason, 'share_pow');
    assert.equal(open.length, headers.length);
  });
});

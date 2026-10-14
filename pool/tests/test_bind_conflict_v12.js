import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { newIdentity } from '../../crypto/address.js';
import { SHARE_FLOOR_BITS, shareCreditMaxBits } from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import {
  clearLiveSharePow,
  nonceWithShareTarget,
} from '../../crypto/share_batch.js';
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

function row(dest, header, nonce, bits) {
  const hash = createHash('sha256').update(String(dest)).update(String(nonce)).digest('hex');
  return {
    dest,
    nonce,
    hash,
    lz: bits & 0xff,
    shareBits: bits,
    verifiedHeader: header.toString('hex'),
  };
}

describe('a nonce bound to one dest is not accepted for another', () => {
  it('rejects every later dest on that header and nonce and leaves the first row', () => {
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 4, shareCreditMaxBits()];
    const destCounts = [2, 5, 8];
    const lows = [1n, 17n, (1n << 40n) + 9n];
    for (const bits of widths) {
      for (const nDest of destCounts) {
        for (const low of lows) {
          clearLiveSharePow();
          const nonce = nonceWithShareTarget(low, bits);
          const header = parentHeader(bits * 100 + nDest);
          const other = parentHeader(bits * 100 + nDest + 50);
          const dests = Array.from({ length: nDest }, () => minerDest());
          const open = [];
          const first = bindAcceptedShare(open, row(dests[0], header, nonce, bits));
          assert.equal(first.ok, true, first.reason);
          assert.equal(open.length, 1);
          let rejected = 0;
          for (let i = 1; i < dests.length; i += 1) {
            const before = open.length;
            const got = bindAcceptedShare(open, row(dests[i], header, nonce, bits));
            assert.equal(got.ok, false);
            assert.equal(got.reason, 'share_pow');
            assert.equal(open.length, before);
            rejected += 1;
          }
          assert.equal(rejected, nDest - 1);
          assert.equal(open.length, 1);
          assert.equal(open[0].dest, dests[0]);
          const again = bindAcceptedShare(open, row(dests[0], header, nonce, bits));
          assert.equal(again.ok, false);
          assert.equal(again.reason, 'duplicate_share');
          assert.equal(open.length, 1);
          const elsewhere = bindAcceptedShare(open, row(dests[1], other, nonce, bits));
          assert.equal(elsewhere.ok, true, elsewhere.reason);
          assert.equal(open.length, 2);
          assert.equal(open[0].dest, dests[0]);
          assert.equal(open[1].dest, dests[1]);
        }
      }
    }
  });
});

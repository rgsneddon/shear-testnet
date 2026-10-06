import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader, setNonce } from '../../crypto/header.js';
import { GENESIS_BITS_PACKED, SHARE_FLOOR_BITS, shareCreditMaxBits } from '../../crypto/asert.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  destBoundShareHash,
  nonceWithShareTarget,
  noteCommitOfShare,
} from '../../crypto/share_batch.js';
import { judgeShare } from '../src/pool.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function rxForBits(noteCommit, meet, miss) {
  for (let i = 0; i < 250_000; i += 1) {
    const rx = Buffer.alloc(32);
    rx.writeUInt32LE(i, 0);
    rx.writeUInt32LE((i * 3) >>> 0, 8);
    const bound = destBoundShareHash(rx, noteCommit);
    if (meetsTarget(bound, meet) && !meetsTarget(bound, miss)) return rx;
  }
  return null;
}

describe('pool share credit follows the nonce byte', () => {
  it('does not pay a higher target the same digest also meets', () => {
    const dest = minerDest();
    const nc = noteCommitOfShare({ dest });
    const bits = SHARE_FLOOR_BITS;
    const higher = bits + 4;
    const rx = rxForBits(nc, bits, higher);
    assert.ok(rx, 'digest meets the job byte and misses the higher target');
    const parent = encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: 1_700_000_000_000,
      bits: GENESIS_BITS_PACKED,
    });
    const nonce = nonceWithShareTarget(11n, bits);
    const header = setNonce(parent, nonce);
    const job = {
      shareBits: bits,
      shareBitsPrev: higher,
      shareBitsAt: Date.now(),
      header,
      blockBits: 4,
    };
    const credited = judgeShare({ job, header, hash: rx, dest, shareBits: bits });
    assert.equal(credited.ok, true, credited.reason);
    assert.equal(credited.creditedShareBits, bits);
    const foreign = judgeShare({
      job: { ...job, shareBits: higher, shareBitsPrev: 0, shareBitsHist: [] },
      header,
      hash: rx,
      dest,
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.reason, 'share_target');
    const oldHeader = setNonce(parent, 11n);
    const old = judgeShare({ job, header: oldHeader, hash: rx, dest });
    assert.equal(old.reason, 'share_target');
    const maxB = shareCreditMaxBits();
    const highNonce = nonceWithShareTarget(11n, maxB + 1);
    const highHeader = setNonce(parent, highNonce);
    const illegal = judgeShare({
      job: { ...job, shareBits: maxB + 1 },
      header: highHeader,
      hash: rx,
      dest,
    });
    assert.equal(illegal.reason, 'share_target');
    const graceNonce = nonceWithShareTarget(11n, higher);
    const graceHeader = setNonce(parent, graceNonce);
    const graceRx = rxForBits(nc, higher, higher + 1);
    assert.ok(graceRx);
    const grace = judgeShare({
      job: { ...job, shareBits: bits, shareBitsPrev: higher, shareBitsAt: Date.now() },
      header: graceHeader,
      hash: graceRx,
      dest,
    });
    assert.equal(grace.ok, true, grace.reason);
    assert.equal(grace.creditedShareBits, higher);
  });
});

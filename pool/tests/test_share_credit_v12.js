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

  it('submits every block-quality hash and withholds credit for an illegal or stale byte', () => {
    const dest = minerDest();
    const maxB = shareCreditMaxBits();
    const bytes = [0, SHARE_FLOOR_BITS - 1, SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 4, maxB, maxB + 1, 255];
    const parentBits = GENESIS_BITS_PACKED;
    const blockHash = Buffer.alloc(32);
    const shareOnly = Buffer.alloc(32, 0xff);
    const now = Date.now();
    for (const byte of bytes) {
      const nonce = nonceWithShareTarget(41n, byte);
      const header = setNonce(encodeHeader({
        prevBlockHash: Buffer.alloc(32, 1),
        merkleRoot: Buffer.alloc(32, 2),
        continuityRoot: Buffer.alloc(32, 3),
        timestamp: 1_700_000_000_000,
        bits: parentBits,
      }), nonce);
      const jobs = [
        { name: 'current', shareBits: byte, shareBitsPrev: 0, shareBitsAt: 0, shareBitsHist: [] },
        { name: 'grace', shareBits: SHARE_FLOOR_BITS, shareBitsPrev: byte, shareBitsAt: now, shareBitsHist: [] },
        { name: 'stale', shareBits: SHARE_FLOOR_BITS, shareBitsPrev: byte, shareBitsAt: now - 13_000, shareBitsHist: [{ bits: byte, at: now - 13_000 }] },
        { name: 'other', shareBits: byte === SHARE_FLOOR_BITS ? byte + 1 : SHARE_FLOOR_BITS, shareBitsPrev: 0, shareBitsAt: 0, shareBitsHist: [] },
      ];
      for (const jobBits of jobs) {
        for (const hash of [blockHash, shareOnly]) {
          const job = { ...jobBits, header, blockBits: parentBits };
          const got = judgeShare({ job, header, hash, dest });
          const legal = byte >= SHARE_FLOOR_BITS && byte <= maxB;
          const authorized = legal && (
            jobBits.shareBits === byte
            || (jobBits.name === 'grace' && jobBits.shareBitsPrev === byte)
          );
          if (hash === blockHash) {
            assert.equal(got.ok, true, `${byte}/${jobBits.name}`);
            assert.equal(got.block, true, `${byte}/${jobBits.name}`);
            if (!authorized) assert.equal(got.creditedShareBits, 0, `${byte}/${jobBits.name}`);
            else assert.ok(got.creditedShareBits === 0 || got.creditedShareBits === byte, `${byte}/${jobBits.name} ${got.creditedShareBits}`);
          } else if (!authorized) {
            assert.equal(got.ok, false, `${byte}/${jobBits.name} share`);
            assert.equal(got.reason, 'share_target', `${byte}/${jobBits.name}`);
          } else {
            assert.equal(got.ok, false, `${byte}/${jobBits.name} low`);
            assert.equal(got.reason, 'low_diff', `${byte}/${jobBits.name}`);
            assert.equal(got.block, undefined);
          }
        }
      }
    }
  });
});

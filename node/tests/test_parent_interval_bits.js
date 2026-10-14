import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import {
  asertNextBits,
  GENESIS_BITS_PACKED,
  TARGET_BLOCK_INTERVAL_MS,
} from '../../crypto/asert.js';
import {
  retarget,
  retargetQuote,
  verifyBlock,
  buildTemplate,
  GENESIS_PREV,
} from '../src/chain.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

function hdr(timestamp, bits, height) {
  return {
    height,
    header: encodeHeader({
      prevBlockHash: Buffer.alloc(32, 1),
      merkleRoot: Buffer.alloc(32, 2),
      continuityRoot: Buffer.alloc(32, 3),
      timestamp,
      bits,
    }),
  };
}

describe('zero parent gap quotes genesis-anchored aserti3-2d', () => {
  it('retarget and verifyBlock use the anchored quote, not a caller target', () => {
    const parentBits = GENESIS_BITS_PACKED;
    const parentTs = 5_000_000;
    const chain = [
      hdr(parentTs, parentBits, 1),
      hdr(parentTs, parentBits, 2),
    ];
    const onTime = asertNextBits({
      anchorBits: parentBits,
      anchorTimeMs: parentTs,
      anchorHeight: 1,
      blockTimeMs: parentTs + TARGET_BLOCK_INTERVAL_MS,
      blockHeight: 3,
      parentTimeMs: parentTs,
    });
    const zero = asertNextBits({
      anchorBits: parentBits,
      anchorTimeMs: parentTs,
      anchorHeight: 1,
      blockTimeMs: parentTs,
      blockHeight: 3,
      parentTimeMs: parentTs,
    });
    const early = asertNextBits({
      anchorBits: parentBits,
      anchorTimeMs: parentTs,
      anchorHeight: 1,
      blockTimeMs: parentTs - 50,
      blockHeight: 3,
      parentTimeMs: parentTs,
    });
    assert.equal(onTime.ok, true);
    assert.equal(zero.ok, true);
    assert.equal(early.ok, true);
    assert.equal(retarget(chain), onTime.packed);
    assert.equal(retargetQuote(chain).packed, onTime.packed);
    assert.equal(retarget(chain, parentTs), zero.packed);
    assert.equal(retargetQuote(chain, parentTs).packed, zero.packed);
    assert.equal(retarget(chain, parentTs - 50), early.packed);
    assert.ok(zero.packed > parentBits);
    assert.ok(early.packed > zero.packed);

    const id = newIdentity();
    const miner = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const genesisTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner,
      bits: parentBits,
      now: parentTs,
    });
    const genesis = {
      header: genesisTpl.header,
      txs: genesisTpl.txs,
      samples: genesisTpl.samples,
      miner,
      height: 1,
      hash: Buffer.alloc(32, 9),
    };
    const g = verifyBlock(genesis, null, { trustedPowHash: Buffer.alloc(32, 0), skipSharePow: true });
    assert.equal(g.ok, true, g.reason);

    function childAt(stamp, bits) {
      const tpl = buildTemplate({
        prev: genesis.hash,
        prevHeader: genesis.header,
        prevBlock: { ...genesis, weight: 1 },
        height: 2,
        miner,
        bits,
        now: stamp,
      });
      return verifyBlock({
        header: tpl.header,
        txs: tpl.txs,
        samples: tpl.samples,
        miner,
        height: 2,
      }, genesis, { trustedPowHash: Buffer.alloc(32, 0), skipSharePow: true });
    }

    const sameQuote = asertNextBits({
      anchorBits: Number(decodeHeader(Buffer.from(genesis.header)).bits),
      anchorTimeMs: parentTs,
      anchorHeight: 1,
      blockTimeMs: parentTs,
      blockHeight: 2,
      parentTimeMs: parentTs,
    });
    const stuck = childAt(parentTs, sameQuote.packed);
    assert.equal(stuck.reason, 'timestamp');

    const fastStamp = parentTs + 1;
    const fastQuote = asertNextBits({
      anchorBits: parentBits,
      anchorTimeMs: parentTs,
      anchorHeight: 1,
      blockTimeMs: fastStamp,
      blockHeight: 2,
      parentTimeMs: parentTs,
    });
    const halfStamp = parentTs + 45_000;
    const halfQuote = asertNextBits({
      anchorBits: parentBits,
      anchorTimeMs: parentTs,
      anchorHeight: 1,
      blockTimeMs: halfStamp,
      blockHeight: 2,
      parentTimeMs: parentTs,
    });
    assert.equal(fastQuote.ok, true);
    assert.equal(halfQuote.ok, true);
    assert.ok(fastQuote.packed > parentBits);
    assert.ok(halfQuote.packed > parentBits);
    assert.ok(fastQuote.packed > halfQuote.packed);
    assert.equal(fastQuote.easeBits, 0);
    assert.equal(halfQuote.easeBits, 0);

    const fast = childAt(fastStamp, fastQuote.packed);
    assert.notEqual(fast.reason, 'bits', fast.reason);
    const fastCaller = childAt(fastStamp, parentBits);
    assert.equal(fastCaller.reason, 'bits');
    const half = childAt(halfStamp, halfQuote.packed);
    assert.notEqual(half.reason, 'bits', half.reason);
    const halfWrong = childAt(halfStamp, fastQuote.packed);
    assert.equal(halfWrong.reason, 'bits');
  });
});

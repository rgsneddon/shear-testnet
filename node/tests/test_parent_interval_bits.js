import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHeader } from '../../crypto/header.js';
import {
  nextBits,
  bitsForBlock,
  GENESIS_BITS_PACKED,
  TARGET_BLOCK_INTERVAL_MS,
  ASERT_HARDEN_MAX,
  unpackBits,
} from '../../crypto/asert.js';
import {
  retarget,
  verifyBlock,
  buildTemplate,
  GENESIS_PREV,
} from '../src/chain.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

function hdr(timestamp, bits) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32, 1),
    merkleRoot: Buffer.alloc(32, 2),
    continuityRoot: Buffer.alloc(32, 3),
    timestamp,
    bits,
  });
}

function trust(block) {
  const pow = Buffer.alloc(32, 0);
  return { trustedPowHash: pow, skipSharePow: true, ...block };
}

describe('non-positive parent gap uses one packed step', () => {
  it('template, bitsForBlock, and verify agree on a non-positive gap', () => {
    const parentBits = GENESIS_BITS_PACKED;
    const parentTs = 5_000_000;
    const chain = [
      { header: hdr(parentTs, parentBits) },
      { header: hdr(parentTs, parentBits) },
    ];
    const packed = nextBits(parentBits, 0);
    assert.equal(packed, nextBits(parentBits, -1));
    assert.equal(packed, nextBits(parentBits, TARGET_BLOCK_INTERVAL_MS));
    assert.equal(retarget(chain), packed);
    assert.equal(bitsForBlock(parentBits, parentTs, parentTs), packed);
    assert.equal(bitsForBlock(parentBits, parentTs, parentTs - 50), packed);

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
      hash: Buffer.alloc(32, 9),
    };
    const g = verifyBlock(genesis, null, { trustedPowHash: Buffer.alloc(32, 0), skipSharePow: true });
    assert.equal(g.ok, true, g.reason);

    const childNow = parentTs;
    const childTpl = buildTemplate({
      prev: genesis.hash,
      prevHeader: genesis.header,
      prevBlock: { ...genesis, weight: 1 },
      height: 2,
      miner,
      bits: packed,
      now: childNow,
    });
    const child = {
      header: childTpl.header,
      txs: childTpl.txs,
      samples: childTpl.samples,
      miner,
      height: 2,
    };
    const noSub = verifyBlock(child, genesis, { trustedPowHash: Buffer.alloc(32, 0), skipSharePow: true });
    assert.notEqual(noSub.reason, 'bits', noSub.reason);

    const subTpl = buildTemplate({
      prev: genesis.hash,
      prevHeader: genesis.header,
      prevBlock: { ...genesis, weight: 1 },
      height: 2,
      miner,
      bits: packed,
      now: parentTs + 45_000,
    });
    const sub = verifyBlock({
      header: subTpl.header,
      txs: subTpl.txs,
      samples: subTpl.samples,
      miner,
      height: 2,
    }, genesis, { trustedPowHash: Buffer.alloc(32, 0), skipSharePow: true, parentIntervalMs: -1 });
    assert.notEqual(sub.reason, 'bits', sub.reason);

    const fast = unpackBits(nextBits(parentBits, 1));
    const at45 = unpackBits(nextBits(parentBits, 45_000));
    const base = unpackBits(parentBits);
    assert.ok(fast > base);
    assert.ok(at45 > base);
    assert.ok(fast - base <= ASERT_HARDEN_MAX);
    assert.ok(at45 - base < fast - base);
    assert.equal(nextBits(parentBits, 90_000), parentBits);
    void trust;
  });
});

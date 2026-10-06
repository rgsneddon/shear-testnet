import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { decodeHeader } from '../../crypto/header.js';
import { retarget, retargetQuote } from '../src/chain.js';
import { encodeDest } from '../../crypto/address.js';
import {
  asertNextBits,
  TARGET_BLOCK_INTERVAL_MS,
  GENESIS_BITS_PACKED,
} from '../../crypto/asert.js';

function dest(byte) {
  return encodeDest(Buffer.alloc(20, byte));
}

function powHex(n) {
  return `${'00'.repeat(31)}${n.toString(16).padStart(2, '0')}`;
}

function quoteFor(store, stamp) {
  const chain = store.blocks;
  const genesis = decodeHeader(Buffer.from(chain[0].header));
  const parent = decodeHeader(Buffer.from(chain[chain.length - 1].header));
  return asertNextBits({
    anchorBits: Number(genesis.bits),
    anchorTimeMs: Number(genesis.timestamp),
    anchorHeight: Number(chain[0].height || 1),
    blockTimeMs: stamp,
    blockHeight: Number(chain[chain.length - 1].height || chain.length) + 1,
    parentTimeMs: Number(parent.timestamp),
  });
}

describe('template and pool job bits', () => {
  it('follows genesis-anchored aserti3-2d, not a caller target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-job-bits-'));
    const store = createStore(dir);
    const miner = dest(4);
    const t0 = 1_700_000_000_000;
    const callerBits = 1;

    const genesis = store.template({ miner, bits: callerBits, shareBits: 8, now: t0 });
    assert.equal(retarget([], t0), GENESIS_BITS_PACKED);
    assert.equal(genesis.job.blockBits, GENESIS_BITS_PACKED);
    assert.equal(genesis.job.bits, GENESIS_BITS_PACKED);
    assert.equal(decodeHeader(Buffer.from(genesis.tpl.header)).bits, GENESIS_BITS_PACKED);
    assert.notEqual(genesis.job.blockBits, callerBits);
    const g = store.submitHeader({
      jobId: genesis.job.jobId, nonce: 0n, miner, powHash: powHex(0),
    }, { trusted: true });
    assert.equal(g.ok, true, g.reason);

    const shortStamp = t0 + 2_000;
    const short = store.template({ miner, bits: callerBits, shareBits: 8, now: shortStamp });
    const shortQuote = quoteFor(store, shortStamp);
    assert.equal(shortQuote.ok, true);
    assert.equal(retarget(store.blocks, shortStamp), shortQuote.packed);
    assert.equal(retargetQuote(store.blocks, shortStamp).packed, shortQuote.packed);
    assert.ok(shortQuote.packed > GENESIS_BITS_PACKED);
    assert.equal(short.job.blockBits, shortQuote.packed);
    assert.equal(short.job.bits, shortQuote.packed);
    assert.equal(decodeHeader(Buffer.from(short.tpl.header)).bits, shortQuote.packed);
    assert.notEqual(short.job.blockBits, callerBits);
    const c = store.submitHeader({
      jobId: short.job.jobId, nonce: 0n, miner, powHash: powHex(1),
    }, { trusted: true });
    assert.equal(c.ok, true, c.reason);
    assert.equal(decodeHeader(Buffer.from(store.tip().header)).bits, shortQuote.packed);

    let now = shortStamp;
    for (let i = 0; i < 6; i += 1) {
      now += 2_000;
      const stepQuote = quoteFor(store, now);
      const step = store.template({ miner, bits: callerBits, shareBits: 8, now });
      assert.equal(step.job.blockBits, stepQuote.packed);
      assert.equal(step.job.bits, retarget(store.blocks, now));
      assert.notEqual(step.job.blockBits, callerBits);
      const got = store.submitHeader({
        jobId: step.job.jobId, nonce: 0n, miner, powHash: powHex(i + 2),
      }, { trusted: true });
      assert.equal(got.ok, true, `${got.reason || ''} at gap ${i}`);
    }
    const afterStamp = now + 2_000;
    const afterQuote = quoteFor(store, afterStamp);
    const after = store.template({ miner, bits: callerBits, shareBits: 8, now: afterStamp });
    assert.equal(after.job.blockBits, afterQuote.packed);
    assert.equal(after.job.bits, retarget(store.blocks, afterStamp));
    assert.equal(decodeHeader(Buffer.from(after.tpl.header)).bits, afterQuote.packed);
    assert.ok(afterQuote.packed > shortQuote.packed);
    assert.notEqual(afterQuote.packed, callerBits);

    const lateStamp = afterStamp + (20 * TARGET_BLOCK_INTERVAL_MS);
    const lateQuote = quoteFor(store, lateStamp);
    const late = store.template({ miner, bits: GENESIS_BITS_PACKED + 50_000, shareBits: 8, now: lateStamp });
    assert.equal(lateQuote.ok, true);
    assert.ok(lateQuote.easeBits > 0);
    assert.ok(lateQuote.eased < lateQuote.packed);
    assert.equal(late.job.blockBits, lateQuote.packed);
    assert.equal(late.job.bits, retarget(store.blocks, lateStamp));
    assert.notEqual(late.job.blockBits, lateQuote.eased);
    assert.ok(lateQuote.packed < GENESIS_BITS_PACKED);
    assert.notEqual(late.job.blockBits, GENESIS_BITS_PACKED + 50_000);
    console.log(`JOB_BITS genesis=${GENESIS_BITS_PACKED} short=${shortQuote.packed} fastChain=${afterQuote.packed} latePacked=${lateQuote.packed} lateEased=${lateQuote.eased}`);
  });
});

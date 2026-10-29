// R28 privacy (Russell 28 Oct, option 2 approved): no public-chain field names
// a miner. As first built, R28 still published the block finder's login dest
// in block.miner (template, sealed block, compact block, p2p wire) and every
// pool miner's address and work in block.samples. Both are refused now
// (blunote_miner, blunote_samples), and neither field is ever carried on the
// wire or in a compact block, so a relay cannot inject one to get a valid
// block refused.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENESIS_BITS_PACKED, POOL_FEE_BPS } from '../../crypto/asert.js';
import { compactChainBlock } from '../../crypto/chronoflux.js';
import { oneTimeKey } from '../../crypto/blunote.js';
import { GENESIS_PREV, buildTemplate, verifyBlock } from '../src/chain.js';
import { encodeWireBlock, decodeWireBlock } from '../src/p2p.js';
import { createStore } from '../src/store.js';
import { bluWallet } from './support/blunote_mine.js';

const MINER = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const T0 = 1_700_000_000_000;

function feeKey() {
  const k = oneTimeKey(bluWallet());
  return { R: k.R, P: k.P, viewTag: k.tag };
}

function powTag(n) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(n, 28);
  return h;
}

function asBlock(tpl, extra = {}) {
  return {
    header: tpl.header, txs: tpl.txs, samples: tpl.samples || [], shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves, bLeaves: tpl.bLeaves, rootA: tpl.rootA, rootB: tpl.rootB, weight: tpl.weight,
    height: tpl.height, ...extra,
  };
}

describe('R28: no public-chain field names a miner', () => {
  it('a pool login dest never reaches the template, the sealed block, the wire or a compact block', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-r28-nominer-'));
    try {
      const store = createStore(dir);
      const { job, tpl } = store.template({ miner: MINER, now: T0, feeKey: feeKey(), feeBps: POOL_FEE_BPS });
      assert.ok(!tpl.miner, `the template names ${tpl.miner}`);
      // The pool's own seal path, with the login dest it used to copy in.
      const got = await Promise.resolve(store.submitHeader({ jobId: job.jobId, nonce: '0', miner: MINER, powHash: powTag(1).toString('hex') }, { trusted: true }));
      assert.equal(got.ok, true, got.reason);
      const tip = store.tip();
      assert.ok(!tip.miner, `the sealed block names ${tip.miner}`);
      const wire = encodeWireBlock(tip);
      assert.equal(Object.prototype.hasOwnProperty.call(wire, 'miner'), false, 'the wire carries miner');
      assert.equal(Object.prototype.hasOwnProperty.call(wire, 'samples'), false, 'the wire carries samples');
      // A relay that adds them gets nothing through: decode never reads them.
      const injected = decodeWireBlock({ ...wire, miner: MINER, samples: [{ miner: MINER, count: 3 }] });
      assert.equal(injected.miner, undefined);
      assert.deepEqual(injected.samples || [], []);
      const compact = compactChainBlock(tip);
      assert.equal(Object.prototype.hasOwnProperty.call(compact, 'miner'), false, 'the compact block carries miner');
      assert.deepEqual(compact.samples || [], []);
      if (typeof store.close === 'function') store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a block that names a miner, or carries samples, is refused', () => {
    const tpl = buildTemplate({
      prev: GENESIS_PREV, height: 1, miner: MINER, bits: GENESIS_BITS_PACKED, now: T0,
      samples: [{ miner: MINER, count: 3 }], feeKey: feeKey(), feeBps: 100,
    });
    assert.deepEqual(tpl.samples || [], [], 'the template seats no samples');
    const honest = verifyBlock(asBlock(tpl), null, { trustedPowHash: powTag(2), nowMs: T0 });
    assert.equal(honest.ok, true, honest.reason);
    const named = verifyBlock(asBlock(tpl, { miner: MINER }), null, { trustedPowHash: powTag(2), nowMs: T0 });
    assert.equal(named.ok, false);
    assert.equal(named.reason, 'blunote_miner');
    for (const row of [{ miner: MINER, count: 3 }, { address: MINER, count: 1 }, { dest: MINER, count: 1 }, { count: 2 }]) {
      const sampled = verifyBlock(asBlock(tpl, { samples: [row] }), null, { trustedPowHash: powTag(2), nowMs: T0 });
      assert.equal(sampled.ok, false, JSON.stringify(row));
      assert.equal(sampled.reason, 'blunote_samples');
    }
  });
});

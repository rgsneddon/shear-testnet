// R28 option (b), for Russell's solo-payout ruling: an empty-batch block may
// pay its whole pot (and finder levy) to the coinbase's one-time key, as a
// solo miner is paid today, and carry nothing. A block with shares cannot.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { POOL_FEE_BPS } from '../../crypto/asert.js';
import { decodeRecord, oneTimeKey, recogniseOneTime } from '../../crypto/blunote.js';
import { blunotePlan, blunoteSettle } from '../src/blunote_payout.js';
import { createStore } from '../src/store.js';
import { bluWallet } from './support/blunote_mine.js';

const MINER = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const T0 = 1_700_000_000_000;

function asBlock(tpl) {
  return {
    header: tpl.header, txs: tpl.txs, shareBatch: tpl.shareBatch || [], aLeaves: tpl.aLeaves, bLeaves: tpl.bLeaves, rootA: tpl.rootA, rootB: tpl.rootB, weight: tpl.weight,
  };
}

describe('R28 option (b): an empty round may pay its pot to the coinbase key', () => {
  it('the plan pays pot plus finder levy to the key and carries nothing; it needs a key and an empty batch', () => {
    const w = bluWallet();
    const k = oneTimeKey(w);
    const feeKey = { R: k.R, P: k.P, viewTag: k.tag };
    const plan = blunotePlan({ shareCount: 0, potPayable: 16_000n, feeNanos: 160n, feeKey, finderLevy: 900n, potToFee: true });
    assert.equal(plan.feeV, 16_900n);
    assert.equal(plan.carryOut, 0n);
    assert.throws(() => blunotePlan({ shareCount: 0, potPayable: 1n, potToFee: true }));
    const row = { shareR: k.R, shareP: k.P, viewTag: 0, units: 256, weight: 256n, shareBits: 8 };
    assert.throws(() => blunoteSettle({ shares: [row], powHash: randomBytes(32), potPayable: 1_000n, feeKey, unitNanos: 1n, potToFee: true }));
  });

  it('a solo template takes the pot to its miner\'s key, and only that miner finds it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-r28-solob-'));
    try {
      const store = createStore(dir);
      const solo = bluWallet();
      const k = oneTimeKey(solo);
      const { tpl } = store.template({ miner: MINER, now: T0, feeKey: { R: k.R, P: k.P, viewTag: k.tag }, feeBps: POOL_FEE_BPS, potToFee: true });
      assert.equal(tpl.txs[0].blunote.potToFee, 1);
      assert.equal(Number(tpl.txs[0].carryNanos || 0), 0);
      const tag = Buffer.alloc(32);
      tag.writeUInt32LE(1, 4);
      const got = await Promise.resolve(store.append(asBlock(tpl), { trustedPowHash: tag }));
      assert.equal(got.ok, true, got.reason);
      const rec = decodeRecord(Buffer.from(store.tip().blunoteRecord, 'hex'));
      assert.ok(rec.feeV > 0n, 'the pot went to the key');
      assert.ok(recogniseOneTime({ y: solo.y, B: solo.B }, rec.feeR, rec.feeP) != null);
      const stranger = bluWallet();
      assert.equal(recogniseOneTime({ y: stranger.y, B: stranger.B }, rec.feeR, rec.feeP), null);
      if (typeof store.close === 'function') store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

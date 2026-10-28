// R28 BluNotes through the real pool: real one-time-key shares enter by the
// pool's own intake (binding checked on the hashed header), the next
// template seats them with a fresh pool fee key, and once sealed the block
// pays the miner's winners and the pool's fee note, each found only by its
// owner's scan key. The pool never sees a payout address for the miner.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { decodeRecord, recogniseOneTime, scanPub, scanScalar } from '../../crypto/blunote.js';
import { createPool, bluSubmitKey } from '../src/pool.js';
import { bluWallet, mineBluShares, ownBluNotes } from '../../node/tests/support/blunote_mine.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

let powTag = 9000;
function nextPow() {
  powTag += 1;
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag, 4);
  return h.toString('hex');
}

async function sealJob(pool, job, miner) {
  const got = await pool.sealFoundShare({ jobId: job.jobId, nonce: 0n, miner, powHash: nextPow() });
  assert.equal(got.ok, true, got.reason || 'seal');
  return got;
}

describe('R28 BluNotes through the pool', () => {
  it('refuses a submit without a valid one-time key', () => {
    assert.equal(bluSubmitKey({}), null);
    assert.equal(bluSubmitKey({ shareR: '11'.repeat(32), shareP: 'ff'.repeat(32), viewTag: 0 }), null);
    const w = bluWallet();
    const ok = bluSubmitKey({ shareR: '11'.repeat(32), shareP: w.B.toString('hex'), viewTag: 7 });
    assert.ok(ok && ok.tag === 7);
  });

  it('seats real shares, pays the miner by draw and the pool fee to its own key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-r28-pool-'));
    const fee = newIdentity();
    const feeScan = { y: scanScalar(fee.spendSeed), Y: scanPub(fee.spendSeed) };
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: fee.address,
      feeScanPub: feeScan.Y.toString('hex'),
    });
    try {
      const genesis = pool.issueJob(undefined, { force: true });
      assert.ok(genesis?.jobId);
      await sealJob(pool, genesis, fee.address);
      const live = pool.issueJob(undefined, { force: true });
      assert.ok(live?.jobId);
      const liveHeader = Buffer.from(live.header, 'hex');
      const miner = bluWallet();
      const shares = mineBluShares(miner, liveHeader, 3);
      for (const s of shares) {
        const opened = pool.creditAcceptedShare({
          shareR: s.shareR,
          shareP: s.shareP,
          viewTag: s.viewTag,
          nonce: s.nonce,
          lz: s.lz,
          shareBits: s.shareBits,
          jobId: String(live.jobId),
          verifiedHeader: liveHeader.toString('hex'),
        });
        assert.equal(opened.ok, true, opened.reason);
      }
      await sealJob(pool, live, fee.address);
      pool.rollOpenRound();
      const published = pool.issueJob(undefined, { force: true });
      const tpl = pool.store.jobs.get(String(published.jobId)).tpl;
      assert.equal((tpl.shareBatch || []).length, 3, 'the template seats the shares');
      assert.ok(tpl.txs[0].blunote?.feeP, 'the template names a pool fee key');
      await sealJob(pool, published, fee.address);
      const tip = pool.store.tip();
      const rec = decodeRecord(Buffer.from(tip.blunoteRecord, 'hex'));
      assert.equal(rec.n, 3);
      // The miner finds its winners; the pool finds its fee note; neither finds the other's.
      const mine = ownBluNotes(miner, tip.blunoteRecord).filter((n) => n.kind === 'blunote');
      assert.ok(mine.length >= 1);
      assert.equal(mine.reduce((a, n) => a + n.v, 0n) > 0n, true);
      const feeDelta = recogniseOneTime({ y: feeScan.y, B: Buffer.from(fee.admitBase) }, rec.feeR, rec.feeP);
      assert.ok(feeDelta != null, 'the pool finds its fee note');
      assert.ok(rec.feeV > 0n);
      assert.equal(recogniseOneTime({ y: miner.y, B: miner.B }, rec.feeR, rec.feeP), null);
      // No miner address appears anywhere in the sealed block.
      const json = JSON.stringify(tip, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      assert.equal(json.includes(miner.B.toString('hex')), false);
    } finally {
      try { pool.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

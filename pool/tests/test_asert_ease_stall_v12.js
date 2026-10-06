import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, headerFromHex } from '../../crypto/header.js';
import {
  ASERT_EMERGENCY_EASE_MAX,
  ASERT_EMERGENCY_GAP_FACTOR,
  TARGET_BLOCK_INTERVAL_MS,
  asertNextBits,
  bitsAcceptAsert,
} from '../../crypto/asert.js';
import { retargetQuote } from '../../node/src/chain.js';
import { createPool, JOB_RESTAMP_MS, TIP_STALL_MS } from '../src/pool.js';

const T = TARGET_BLOCK_INTERVAL_MS;
const TRIGGER = ASERT_EMERGENCY_GAP_FACTOR * T;

describe('v12 stall timer opens the 8·T emergency ease', () => {
  it('a stall with no new tx and no new miners eases within the spec window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ease-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const logged = [];
    const origErr = console.error;
    console.error = (...args) => {
      logged.push(args.map(String).join(' '));
    };
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
    });
    try {
      const genesisNow = Date.now();
      const seeded = pool.store.template({ miner: dest, now: genesisNow });
      const pow = Buffer.alloc(32);
      pow[4] = 3;
      const sealed = await pool.store.submitHeader({
        jobId: seeded.job.jobId,
        nonce: 0n,
        miner: dest,
        powHash: pow.toString('hex'),
      }, { trusted: true });
      assert.equal(sealed.ok, true, sealed.reason || 'genesis');
      const opened = pool.issueJob();
      assert.ok(opened?.header, 'job');
      const jobId = String(opened.jobId);
      const parent = decodeHeader(Buffer.from(pool.store.tip().header));
      const parentTs = Number(parent.timestamp);
      const mempoolBefore = (pool.store.mempool || []).length;
      assert.equal(pool.miners.size, 0);
      const gaps = [TRIGGER, TRIGGER + 60_000, 2 * TRIGGER, 4 * TRIGGER];
      let prevWall = 0;
      for (const gap of gaps) {
        const wall = parentTs + gap;
        assert.ok(wall >= prevWall + JOB_RESTAMP_MS, String(gap));
        prevWall = wall;
        const quote = retargetQuote(pool.store.blocks, wall);
        assert.equal(quote.ok, true, String(gap));
        assert.ok(quote.easeBits <= ASERT_EMERGENCY_EASE_MAX, String(gap));
        const job = pool.restampTick(wall);
        assert.equal(String(job.jobId), jobId, String(gap));
        assert.equal(pool.miners.size, 0, String(gap));
        assert.equal((pool.store.mempool || []).length, mempoolBefore, String(gap));
        const decoded = decodeHeader(headerFromHex(job.header));
        const userTxs = (pool.store.jobs.get(jobId)?.tpl?.txs || []).slice(1).length;
        assert.equal(userTxs, 0, String(gap));
        if (gap <= TRIGGER) {
          assert.equal(quote.easeBits, 0, String(gap));
          assert.equal(Number(decoded.bits), quote.packed, String(gap));
          assert.equal(bitsAcceptAsert(Number(decoded.bits), quote), true);
          continue;
        }
        assert.ok(quote.easeBits > 0, String(gap));
        assert.equal(Number(decoded.timestamp), wall, String(gap));
        assert.ok(Number(decoded.timestamp) - parentTs > TRIGGER, String(gap));
        assert.equal(Number(decoded.bits), quote.eased, String(gap));
        assert.ok(quote.eased <= quote.packed, String(gap));
        assert.equal(bitsAcceptAsert(Number(decoded.bits), quote), true, String(gap));
        if (gap >= 2 * TRIGGER) assert.ok(quote.eased < quote.packed, String(gap));
        const child = asertNextBits({
          anchorBits: Number(parent.bits),
          anchorTimeMs: parentTs,
          anchorHeight: 1,
          blockTimeMs: wall + T,
          blockHeight: 2,
          parentTimeMs: wall,
        });
        assert.equal(child.ok, true, String(gap));
        assert.equal(child.easeBits, 0, `sticky ${gap}`);
        const kept = pool.watchTipStall(wall + JOB_RESTAMP_MS, {
          now: wall + JOB_RESTAMP_MS,
          heightSinceMs: wall - TIP_STALL_MS - 1,
          bits: 20,
          lastFoundAt: wall,
          hashrate: 4000,
          miners: 4,
          shares: 0,
        });
        assert.equal(kept.reissued, false, String(gap));
        const still = decodeHeader(headerFromHex(pool.issueJob().header));
        assert.equal(Number(still.bits), quote.eased, String(gap));
        assert.equal(String(pool.issueJob().jobId), jobId, String(gap));
      }
      assert.equal(logged.some((line) => line.includes('tip_stall_restamp')), false);
    } finally {
      console.error = origErr;
      pool.close();
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { LIVE_MIN_BITS } from '../../crypto/asert.js';
import { createPool, tipStallDecision, TIP_STALL_MS } from '../src/pool.js';

describe('tip stall and floor dwell restamp without a bounce', () => {
  it('the shipped predicate pages on a flat tip or a floor dwell and never restarts', () => {
    assert.equal(TIP_STALL_MS, 15 * 60 * 1000);
    const now = 1_000_000_000;
    const flat = tipStallDecision({
      now,
      heightSinceMs: now - TIP_STALL_MS - 1,
      bits: 15,
      lastFoundAt: now,
      hashrate: 3200,
      miners: 2,
      shares: 0,
    });
    assert.equal(flat.restamp, true);
    assert.equal(flat.alert, true);
    assert.equal(flat.restart, false);
    assert.equal(flat.reason, 'tip_stall');
    const floor = tipStallDecision({
      now,
      heightSinceMs: now,
      bits: LIVE_MIN_BITS,
      lastFoundAt: now - TIP_STALL_MS - 1,
      hashrate: 0,
      miners: 0,
      shares: 40,
    });
    assert.equal(floor.restamp, true);
    assert.equal(floor.restart, false);
    assert.equal(floor.reason, 'floor_dwell');
    const quiet = tipStallDecision({
      now,
      heightSinceMs: now - TIP_STALL_MS - 1,
      bits: LIVE_MIN_BITS,
      lastFoundAt: now - TIP_STALL_MS - 1,
      hashrate: 0,
      miners: 0,
      shares: 0,
    });
    assert.equal(quiet.restamp, false);
    assert.equal(quiet.restart, false);
  });

  it('watchTipStall reissues the live job from the sealed tip and does not bounce', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('function watchTipStall'), src.indexOf('function resetOpenRound'));
    assert.match(body, /issueJob\(shareBits, \{ force: true \}\)/);
    assert.match(body, /tip_stall_restamp/);
    assert.equal(/\.restart\(/.test(body), false);
    assert.equal(/process\.exit/.test(body), false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stall-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    let bounced = 0;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      onRestart() { bounced += 1; },
      onRestartHasher() { bounced += 1; },
    });
    try {
      const now = Date.now();
      const stall = pool.watchTipStall(now, {
        now,
        heightSinceMs: now - TIP_STALL_MS - 5_000,
        bits: 12,
        lastFoundAt: now,
        hashrate: 1500,
        miners: 2,
        shares: 9,
      });
      assert.equal(stall.restamp, true);
      assert.equal(stall.restart, false);
      assert.equal(stall.reason, 'tip_stall');
      assert.equal(stall.restamped, true);
      assert.ok(stall.jobId);
      const floor = pool.watchTipStall(now, {
        now,
        heightSinceMs: now,
        bits: LIVE_MIN_BITS,
        lastFoundAt: now - TIP_STALL_MS - 5_000,
        hashrate: 800,
        miners: 1,
        shares: 3,
      });
      assert.equal(floor.reason, 'floor_dwell');
      assert.equal(floor.restart, false);
      assert.equal(floor.restamped, true);
      const stats = pool.publicStats();
      assert.equal(stats.alerts.tipStall, true);
      assert.equal(stats.alerts.tipStallReason, 'floor_dwell');
      assert.match(stats.blockBitsLabel, /blockBits/);
      assert.match(stats.shareBitsLabel, /not a retarget/i);
      assert.equal(bounced, 0);
    } finally {
      pool.close();
    }
  });
});

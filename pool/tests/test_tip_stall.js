import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader, headerFromHex } from '../../crypto/header.js';
import { LIVE_MIN_BITS } from '../../crypto/asert.js';
import { retarget } from '../../node/src/chain.js';
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
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    const pred = src.slice(src.indexOf('export function tipStallDecision'), src.indexOf('export const ALERT_CONCENTRATION'));
    assert.equal(/mempool/.test(pred), false);
  });

  it('watchTipStall reissues the live job from the sealed tip and does not bounce', () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('function watchTipStall'), src.indexOf('function resetOpenRound'));
    assert.match(body, /issueJob\(shareBits, \{ force: true \}\)/);
    assert.equal(/tip_stall_restamp/.test(body), false);
    assert.equal(/systemctl/.test(body), false);
    assert.equal(/\.restart\(/.test(body), false);
    assert.equal(/process\.exit/.test(body), false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stall-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    let bounced = 0;
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
      assert.equal(stats.alerts.tipStallJobId, floor.jobId);
      assert.equal(stats.alerts.tipStallReissued, false);
      const keptHeader = pool.issueJob().header;
      const again = pool.watchTipStall(now + 10_000, {
        now: now + 10_000,
        heightSinceMs: now - TIP_STALL_MS - 5_000,
        bits: 12,
        lastFoundAt: now,
        hashrate: 1500,
        miners: 2,
        shares: 9,
      });
      assert.equal(again.restart, false);
      assert.equal(again.restamped, true);
      assert.equal(again.reissued, false);
      assert.equal(again.seal, 'ok');
      assert.equal(again.jobId, floor.jobId);
      assert.equal(pool.issueJob().header, keptHeader);
      assert.match(stats.blockBitsLabel, /blockBits/);
      assert.match(stats.shareBitsLabel, /not a retarget/i);
      assert.equal(bounced, 0);
      assert.equal(logged.some((line) => line.includes('tip_stall_restamp')), false);
    } finally {
      console.error = origErr;
      pool.close();
    }
  });

  it('a bits undercut is rewritten to consensus next-work, not an easier target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stall-bits-'));
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
      const now = Date.now();
      const first = pool.watchTipStall(now, {
        now,
        heightSinceMs: now - TIP_STALL_MS - 5_000,
        bits: 20,
        lastFoundAt: now,
        hashrate: 4000,
        miners: 3,
        shares: 0,
      });
      assert.equal(first.restamped, true);
      assert.equal(first.seal, 'ok');
      const want = retarget(pool.store.blocks);
      const job = pool.issueJob();
      const decoded = decodeHeader(headerFromHex(job.header));
      assert.equal(Number(decoded.bits), Number(want));
      const under = encodeHeader({
        version: decoded.version,
        prevBlockHash: decoded.prevBlockHash,
        merkleRoot: decoded.merkleRoot,
        continuityRoot: decoded.continuityRoot,
        timestamp: decoded.timestamp,
        bits: Number(want) - 1,
        nonce: 0n,
        baseFee: decoded.baseFee,
      });
      job.header = under.toString('hex');
      job.bits = Number(want) - 1;
      job.blockBits = Number(want) - 1;
      const rec = pool.store.jobs.get(String(job.jobId));
      if (rec) {
        rec.job = job;
        if (rec.tpl) rec.tpl.header = under;
      }
      const seen = decodeHeader(headerFromHex(pool.issueJob().header));
      assert.equal(Number(seen.bits), Number(want) - 1, 'undercut must sit on the live header');
      const fixed = pool.watchTipStall(now + 1_000, {
        now: now + 1_000,
        heightSinceMs: now - TIP_STALL_MS - 5_000,
        bits: 20,
        lastFoundAt: now,
        hashrate: 4000,
        miners: 3,
        shares: 0,
      });
      assert.equal(fixed.restart, false);
      assert.equal(fixed.reissued, true);
      assert.equal(fixed.restamped, true);
      assert.equal(fixed.seal, 'ok');
      assert.notEqual(fixed.jobId, first.jobId);
      const sealed = decodeHeader(headerFromHex(pool.issueJob().header));
      assert.equal(Number(sealed.bits), Number(want));
      assert.notEqual(Number(sealed.bits), Number(want) - 1);
      assert.equal(logged.some((line) => line.includes('tip_stall_restamp')), false);
    } finally {
      console.error = origErr;
      pool.close();
    }
  });
});

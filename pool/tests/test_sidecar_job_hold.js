import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPool } from '../src/pool.js';

describe('job hold while the sidecar tip is ahead', () => {
  it('does not issue a new job on the pool-local parent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-job-hold-'));
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
    });
    const logs = [];
    const orig = console.error;
    console.error = (...args) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      const first = pool.issueJob(undefined, { force: true });
      assert.ok(first?.jobId);
      assert.equal(pool.jobHoldReason(), '');
      const local = Number(pool.store.tip()?.height || 0);
      pool.noteSidecarTip({ height: local + 15, hash: 'ab'.repeat(32) });
      assert.equal(pool.jobHoldReason(), 'sidecar_ahead');
      const held = pool.issueJob(undefined, { force: true });
      assert.equal(held.jobId, first.jobId);
      assert.equal(held.header, first.header);
      const now = Date.now();
      const stall = pool.watchTipStall(now, {
        now,
        heightSinceMs: now,
        bits: 20,
        lastFoundAt: now,
        hashrate: 0,
        miners: 0,
        shares: 0,
      });
      assert.equal(stall.restart, false);
      assert.equal(stall.seal, 'sidecar_ahead');
      assert.equal(stall.reissued, false);
      assert.ok(logs.some((line) => line.includes('"event":"job_hold"') && line.includes('"reason":"sidecar_ahead"')));
      pool.noteSidecarTip({ height: local, hash: '00'.repeat(32) });
      assert.equal(pool.jobHoldReason(), '');
      const resumed = pool.issueJob(undefined, { force: true });
      assert.ok(resumed?.jobId);
      assert.notEqual(resumed.jobId, first.jobId);
    } finally {
      console.error = orig;
      pool.close();
    }
  });
});

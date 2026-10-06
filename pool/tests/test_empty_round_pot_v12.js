import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPool, potRoundShares, configuredFeeIdentity } from '../src/pool.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function destsOf(vouts) {
  return (vouts || []).filter((o) => o?.dest20).map((o) => Buffer.from(o.dest20));
}

function hasDest(vouts, dest) {
  const want = hash20FromAddress(dest);
  return destsOf(vouts).some((d) => d.equals(want));
}

describe('v12 empty round does not pay a miner by map order', () => {
  it('holds the pot at the fee dest for any connected-miner count', async () => {
    const src = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\[\s*\{\s*miner:\s*hasherPay,\s*count:\s*1\s*\}\s*\]/);
    const feeTo = configuredFeeIdentity().feeDest;
    assert.equal(configuredFeeIdentity().ok, true);
    const held = potRoundShares({ lag1Shares: [], potRows: [], feeTo, wantPot: 1 });
    assert.deepEqual(held, [{ address: feeTo, nanos: 1, kind: 'pot' }]);
    const none = potRoundShares({ lag1Shares: [], potRows: [], feeTo: '', wantPot: 5 });
    assert.deepEqual(none, []);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-empty-pot-'));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: feeTo });
    try {
      const genesisNow = Date.now();
      const seeded = pool.store.template({ miner: feeTo, now: genesisNow });
      const pow = Buffer.alloc(32);
      pow[4] = 3;
      const sealed = await pool.store.submitHeader({
        jobId: seeded.job.jobId,
        nonce: 0n,
        miner: feeTo,
        powHash: pow.toString('hex'),
      }, { trusted: true });
      assert.equal(sealed.ok, true, sealed.reason || 'genesis');

      for (const n of [0, 1, 4, 17]) {
        pool.miners.clear();
        const connected = [];
        for (let i = 0; i < n; i += 1) {
          const dest = minerDest();
          connected.push(dest);
          pool.miners.set(`idle-${n}-${i}`, {
            login: dest,
            workerKey: dest,
            payoutDest: dest,
            roundHashes: 0,
            hashes: 0,
            accepted: 0,
            connections: [],
          });
        }
        const job = pool.issueJob(undefined, { force: true });
        assert.ok(job?.jobId, `job for ${n}`);
        const vout = pool.store.jobs.get(String(job.jobId))?.tpl?.txs?.[0]?.vout || [];
        assert.ok(vout.length > 0, `coinbase for ${n}`);
        assert.equal(hasDest(vout, feeTo), true, `fee hold for ${n}`);
        for (const dest of connected) {
          assert.equal(hasDest(vout, dest), false, `map miner paid at count ${n}`);
        }
        assert.equal((pool.store.jobs.get(String(job.jobId))?.tpl?.shareBatch || []).length, 0);
      }

      pool.miners.clear();
      const idleFirst = minerDest();
      const workedA = minerDest();
      const idleMid = minerDest();
      const workedB = minerDest();
      const rows = [
        [idleFirst, 0],
        [workedA, 1],
        [idleMid, 0],
        [workedB, 9],
      ];
      for (let i = 0; i < rows.length; i += 1) {
        const [dest, hashes] = rows[i];
        pool.miners.set(`mix-${i}`, {
          login: dest,
          workerKey: dest,
          payoutDest: dest,
          roundHashes: hashes,
          hashes,
          accepted: hashes,
          connections: [],
        });
      }
      const mixed = pool.issueJob(undefined, { force: true });
      assert.ok(mixed?.jobId, 'mixed job');
      const mixedVout = pool.store.jobs.get(String(mixed.jobId))?.tpl?.txs?.[0]?.vout || [];
      assert.equal(hasDest(mixedVout, idleFirst), false);
      assert.equal(hasDest(mixedVout, idleMid), false);
      assert.equal(hasDest(mixedVout, workedA), true);
      assert.equal(hasDest(mixedVout, workedB), true);
      assert.equal(hasDest(mixedVout, feeTo), true);
    } finally {
      pool.close();
    }
  });
});

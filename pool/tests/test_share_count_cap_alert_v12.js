import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_SHARES_PER_BLOCK, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  eligibleShareCount,
  shareCountCapBinds,
  splitDeferWindow,
  shareHeaderSlot,
} from '../../crypto/share_batch.js';
import { createPool, statsAlerts, THIS_POOL_DIRECT_FEE_DEST } from '../src/pool.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function destsOf(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(minerDest());
  return out;
}

function headerFill(byte) {
  return Buffer.alloc(128, byte & 0xff);
}

function row(header, dest, nonce) {
  return {
    verifiedHeader: header,
    nonce: BigInt(nonce),
    dest,
    shareBits: SHARE_FLOOR_BITS,
  };
}

function plant(list, header, n, dests, nonceBase) {
  list.length = 0;
  const base = BigInt(nonceBase);
  for (let i = 0; i < n; i += 1) {
    list.push(row(header, dests[i % dests.length], base + BigInt(i)));
  }
}

function countsAround(cap) {
  const limit = Math.max(0, Math.floor(Number(cap) || 0));
  const raw = [0, 1, limit - 1, limit, limit + 1];
  const out = [];
  for (const n of raw) {
    if (n >= 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function assertNamesNobody(alerts, secrets) {
  const blob = JSON.stringify(alerts);
  for (const secret of secrets) {
    assert.equal(blob.includes(String(secret)), false);
  }
  assert.equal(typeof alerts.shareCountCap, 'boolean');
  assert.equal(alerts.dest, undefined);
  assert.equal(alerts.worker, undefined);
  assert.equal(alerts.login, undefined);
  assert.equal(alerts.feeDest, undefined);
}

describe('share-count cap alert', () => {
  it('binds only above the cap, for any count, and matches the defer window', () => {
    const caps = [0, 1, 8, MAX_SHARES_PER_BLOCK];
    const minerCounts = [1, 3, 17];
    for (const cap of caps) {
      for (const miners of minerCounts) {
        const dests = destsOf(miners);
        const parent = headerFill(11 + cap + miners);
        const prior = headerFill(21 + cap + miners);
        const other = headerFill(31 + cap + miners);
        const restamp = Buffer.from(parent);
        restamp[40] ^= 0x5a;
        for (const n of countsAround(cap)) {
          const shares = [];
          for (let i = 0; i < n; i += 1) {
            const onPrior = i % 5 === 0;
            const header = onPrior ? prior : parent;
            shares.push(row(header, dests[i % dests.length], i + 1));
          }
          const staleN = n === 0 ? 0 : Math.max(1, Math.floor(n / 3));
          for (let i = 0; i < staleN; i += 1) {
            shares.push(row(other, dests[i % dests.length], 1_000_000 + i));
          }
          shares.push(row(restamp, dests[0], 9_000_000 + n));
          const issued = [restamp];
          const eligible = eligibleShareCount(shares, parent, prior, issued);
          const blind = eligibleShareCount(shares, parent, prior, []);
          const split = splitDeferWindow(shares, parent, prior, cap, issued);
          const windowN = split.seal.length + split.carry.length + split.owe.length;
          assert.equal(eligible, windowN);
          assert.equal(split.stale.length + eligible, shares.length);
          assert.equal(blind + 1, eligible);
          assert.equal(shareCountCapBinds(eligible, cap), eligible > cap);
          const alerts = statsAlerts({
            topDestSharePct: 0,
            shareBlockRatio: 0,
            eligibleShares: eligible,
            shareCountCap: cap,
          });
          assert.equal(alerts.shareCountCap, eligible > cap);
          assertNamesNobody(alerts, [...dests, THIS_POOL_DIRECT_FEE_DEST, 'worker', 'login']);
        }
      }
    }
    assert.equal(statsAlerts({ topDestSharePct: 0, shareBlockRatio: 0 }).shareCountCap, false);
    assert.equal(shareCountCapBinds(0, 0), false);
    assert.equal(shareCountCapBinds(1, 0), true);
    assert.equal(shareCountCapBinds(-4, 8), false);
    assert.equal(shareCountCapBinds(8, 8), false);
    assert.equal(shareCountCapBinds(9, 8), true);
  });

  it('public stats alert on the live job, including an empty chain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-count-cap-'));
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: THIS_POOL_DIRECT_FEE_DEST,
    });
    const dests = destsOf(17);
    const cap = MAX_SHARES_PER_BLOCK;
    try {
      const quiet = pool.publicStats();
      assert.equal(quiet.alerts.shareCountCap, false);
      assertNamesNobody(quiet.alerts, [...dests, quiet.feeDest]);

      const genesis = pool.issueJob(undefined, { force: true });
      assert.ok(genesis?.header);
      const jobHeader = String(genesis.header).toLowerCase();
      const stale = Buffer.from(jobHeader, 'hex');
      stale[0] ^= 0xff;
      const staleHeader = stale.toString('hex');

      const expectAlert = (want) => {
        const pub = pool.publicStats();
        assert.equal(pub.alerts.shareCountCap, want);
        assertNamesNobody(pub.alerts, [...dests, pub.feeDest, jobHeader]);
        return pub;
      };

      plant(pool.openShares, jobHeader, 0, dests, 1);
      expectAlert(false);
      for (const n of [1, cap - 1, cap]) {
        plant(pool.openShares, jobHeader, n, dests, 1);
        expectAlert(false);
      }
      plant(pool.openShares, jobHeader, cap + 1, dests, 1);
      expectAlert(true);
      plant(pool.openShares, jobHeader, cap, dests, 1);
      expectAlert(false);

      plant(pool.openShares, jobHeader, cap, dests, 1);
      plant(pool.deferredShares, staleHeader, cap + 1, dests, 5_000_000);
      expectAlert(false);
      plant(pool.deferredShares, jobHeader, 1, dests, 8_000_000);
      expectAlert(true);
      pool.deferredShares.length = 0;
      expectAlert(false);

      plant(pool.openShares, staleHeader, cap + 1, dests, 1);
      expectAlert(false);
      plant(pool.lag1Shares, jobHeader, cap + 1, dests, 1);
      plant(pool.openShares, jobHeader, cap, dests, 20_000_000);
      expectAlert(false);
      pool.lag1Shares.length = 0;
      pool.openShares.length = 0;

      const pow = Buffer.alloc(32);
      pow.writeUInt32LE(1, 4);
      const sealed = await pool.sealFoundShare({
        jobId: genesis.jobId,
        nonce: 0n,
        miner: THIS_POOL_DIRECT_FEE_DEST,
        powHash: pow.toString('hex'),
      });
      assert.equal(sealed.ok, true, sealed.reason || 'seal');
      const tip = pool.store.tip();
      assert.ok(tip?.header);
      const tipHeader = Buffer.from(tip.header).toString('hex').toLowerCase();
      const child = pool.issueJob(undefined, { force: true });
      assert.ok(child?.header);
      const childHeader = String(child.header).toLowerCase();
      assert.equal(shareHeaderSlot(childHeader, tipHeader), null);

      plant(pool.openShares, childHeader, cap, dests, 1);
      plant(pool.deferredShares, tipHeader, 0, dests, 30_000_000);
      expectAlert(false);
      plant(pool.openShares, childHeader, cap - 1, dests, 1);
      plant(pool.deferredShares, tipHeader, 2, dests, 30_000_000);
      expectAlert(true);
      plant(pool.openShares, childHeader, 0, dests, 1);
      plant(pool.deferredShares, tipHeader, cap, dests, 30_000_000);
      expectAlert(false);
      plant(pool.deferredShares, tipHeader, cap + 1, dests, 30_000_000);
      expectAlert(true);
      plant(pool.openShares, staleHeader, cap + 1, dests, 1);
      plant(pool.deferredShares, staleHeader, cap + 1, dests, 40_000_000);
      expectAlert(false);
      plant(pool.lag1Shares, childHeader, cap + 1, dests, 50_000_000);
      expectAlert(false);
    } finally {
      try { pool.close(); } catch { /* ignore */ }
    }
  });
});

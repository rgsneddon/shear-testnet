import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { nonceWithShareTarget, unitsForShare } from '../../crypto/share_batch.js';
import { createPool } from '../src/pool.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

let powTag = 4000;
function nextPow() {
  powTag += 1;
  return easyPow(powTag).toString('hex');
}

function poolAt(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-escape-${tag}-`));
  return createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
}

function watchFinder(pool, login) {
  pool.miners.set(login, {
    login,
    workerKey: login,
    payoutDest: login,
    connections: [],
    accepted: 1,
  });
}

function nonceSet(shares) {
  return new Set((shares || []).map((s) => String(s.nonce)));
}

function countNonce(shares, nonce) {
  let n = 0;
  for (const s of shares || []) if (String(s.nonce) === String(nonce)) n += 1;
  return n;
}

async function holdRound(pool, rows) {
  const genesis = pool.issueJob(undefined, { force: true });
  assert.ok(genesis?.jobId);
  const header = Buffer.from(genesis.header, 'hex');
  const nonces = [];
  for (const row of rows) {
    const nonce = nonceWithShareTarget(BigInt(row.low), row.bits);
    const got = pool.creditAcceptedShare({
      dest: row.dest,
      nonce,
      lz: row.bits,
      shareBits: row.bits,
      creditedShareBits: row.bits,
      verifiedHeader: header,
      hash: '11',
    });
    assert.equal(got.ok, true, got.reason);
    nonces.push(String(nonce));
  }
  const sealed = await pool.sealFoundShare({
    jobId: genesis.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(sealed.ok, true, sealed.reason);
  pool.rollOpenRound();
  const published = pool.issueJob(undefined, { force: true });
  assert.ok(published?.jobId);
  const batch = pool.store.jobs.get(String(published.jobId))?.tpl?.shareBatch || [];
  assert.equal(batch.length, rows.length);
  return { nonces, header };
}

function corruptJob(pool, offset) {
  const rec = pool.store.jobs.get(String(pool.lastJob.jobId));
  const hdr = Buffer.from(rec.tpl.header);
  hdr[offset] ^= 0xff;
  rec.tpl.header = hdr;
}

async function failOnce(pool, mode, miner) {
  if (mode === 'merkle') corruptJob(pool, 36);
  if (mode === 'prev') corruptJob(pool, 4);
  const pow = mode === 'pow' ? Buffer.alloc(32, 0xff).toString('hex') : nextPow();
  return pool.sealFoundShare({
    jobId: pool.lastJob.jobId,
    nonce: 0n,
    miner,
    powHash: pow,
  });
}

describe('v12 seal escape does not ban a finder', () => {
  it('keeps honest shares, bans nobody, and quarantines only a duplicate row', { timeout: 300_000 }, async () => {
    const pools = [];
    try {
      const modes = [
        { mode: 'pow', finders: 2, fails: 2, shares: 1 },
        { mode: 'merkle', finders: 1, fails: 2, shares: 3 },
        { mode: 'prev', finders: 3, fails: 2, shares: 3 },
        { mode: 'pow', finders: 1, fails: 7, shares: 2 },
      ];
      for (const spec of modes) {
        const pool = poolAt(`${spec.mode}-${spec.finders}-${spec.fails}`);
        pools.push(pool);
        const rows = [];
        for (let i = 0; i < spec.shares; i += 1) {
          rows.push({
            dest: minerDest(),
            low: 20 + i + spec.fails,
            bits: i % 2 === 0 ? SHARE_FLOOR_BITS : SHARE_FLOOR_BITS + 1,
          });
        }
        const held = await holdRound(pool, rows);
        const finders = [];
        for (let i = 0; i < spec.finders; i += 1) {
          const login = minerDest();
          watchFinder(pool, login);
          finders.push(login);
        }
        // Two workers on one payout dest. The ban key is the worker login.
        const sharedPay = minerDest();
        const workerA = `${sharedPay}.a`;
        const workerB = `${sharedPay}.b`;
        watchFinder(pool, workerA);
        watchFinder(pool, workerB);
        pool.miners.get(workerA).payoutDest = sharedPay;
        pool.miners.get(workerB).payoutDest = sharedPay;
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        const beforeBans = pool.adminOps.health().bans;
        for (let i = 0; i < spec.fails; i += 1) {
          const who = i % 2 === 0 ? workerA : (finders[i % finders.length] || workerB);
          const got = await failOnce(pool, spec.mode, who);
          assert.equal(got.ok, false, spec.mode);
        }
        assert.equal(pool.adminOps.health().bans, beforeBans, `${spec.mode} bans`);
        for (const login of [workerA, workerB, ...finders]) {
          assert.equal(pool.miners.has(login), true, login);
        }
        assert.equal(Number(pool.stats.lostWorkHashes) || 0, beforeLost, spec.mode);
        const still = nonceSet([
          ...pool.lag1Shares,
          ...pool.openShares,
          ...pool.deferredShares,
        ]);
        for (const n of held.nonces) assert.equal(still.has(n), true, spec.mode);
        const live = pool.lastJob || pool.issueJob(undefined, { force: true });
        assert.ok(live?.jobId, `${spec.mode} live job`);
        const paid = await pool.sealFoundShare({
          jobId: live.jobId,
          nonce: 0n,
          miner: finders[0] || workerA,
          powHash: nextPow(),
        });
        assert.equal(paid.ok, true, paid.reason || spec.mode);
        let sealed = nonceSet(pool.store.tip().shareBatch);
        if (held.nonces.some((n) => !sealed.has(n))) {
          pool.rollOpenRound();
          const job = pool.issueJob(undefined, { force: true });
          assert.ok(job?.jobId, `${spec.mode} pay job`);
          const again = await pool.sealFoundShare({
            jobId: job.jobId,
            nonce: 0n,
            miner: finders[0] || workerA,
            powHash: nextPow(),
          });
          assert.equal(again.ok, true, again.reason || spec.mode);
          sealed = nonceSet(pool.store.tip().shareBatch);
        }
        for (const n of held.nonces) assert.equal(sealed.has(n), true, spec.mode);
        assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0, spec.mode);
        assert.equal(pool.adminOps.health().bans, beforeBans);
      }

      for (const width of [1, 3]) {
        const pool = poolAt(`dup-${width}`);
        pools.push(pool);
        const rows = [];
        for (let i = 0; i < width; i += 1) {
          rows.push({
            dest: minerDest(),
            low: 80 + i + width,
            bits: SHARE_FLOOR_BITS + (i % 3),
          });
        }
        const held = await holdRound(pool, rows);
        const finder = minerDest();
        watchFinder(pool, finder);
        const twinNonce = held.nonces[held.nonces.length - 1];
        const twin = pool.lag1Shares.find((s) => String(s.nonce) === twinNonce);
        assert.ok(twin);
        pool.lag1Shares.push({ ...twin });
        const rebuilt = pool.issueJob(undefined, { force: true });
        assert.ok(rebuilt?.jobId);
        assert.equal(countNonce(pool.lag1Shares, twinNonce), 2);
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        const beforeBans = pool.adminOps.health().bans;
        const unit = unitsForShare(SHARE_FLOOR_BITS + ((width - 1) % 3));
        for (let i = 0; i < 2; i += 1) {
          const got = await pool.sealFoundShare({
            jobId: pool.lastJob.jobId,
            nonce: 0n,
            miner: finder,
            powHash: nextPow(),
          });
          assert.equal(got.ok, false, got.reason || 'dup');
        }
        assert.equal(pool.adminOps.health().bans, beforeBans);
        assert.equal(pool.miners.has(finder), true);
        assert.equal(countNonce(pool.lag1Shares, twinNonce), 1, `width ${width}`);
        for (const n of held.nonces) assert.equal(nonceSet(pool.lag1Shares).has(n), true);
        const lost = (Number(pool.stats.lostWorkHashes) || 0) - beforeLost;
        assert.equal(lost, unit, `width ${width} lost`);
        const paid = await pool.sealFoundShare({
          jobId: pool.lastJob.jobId,
          nonce: 0n,
          miner: finder,
          powHash: nextPow(),
        });
        assert.equal(paid.ok, true, `${paid.reason || 'no-reason'} job=${pool.lastJob?.jobId || ''} lag=${pool.lag1Shares.length} dup ${width}`);
        const sealed = pool.store.tip().shareBatch || [];
        assert.equal(countNonce(sealed, twinNonce), 1);
        for (const n of held.nonces) assert.equal(nonceSet(sealed).has(n), true);
        assert.equal(pool.adminOps.health().bans, beforeBans);
      }
    } finally {
      for (const pool of pools) {
        try { await pool.close(); } catch { /* closed */ }
      }
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setHashBackend, shearHash, meetsTarget } from '../../crypto/shear_hash.js';
import { setNonce } from '../../crypto/header.js';
import { MAX_SHARES_PER_BLOCK, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  clearLiveSharePow,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
  destBoundShareHash,
} from '../../crypto/share_batch.js';
import {
  createPool,
  SEAL_ESCAPE_AFTER,
  HEADER_HOLD_MAX_FAULTS,
  HEADER_HOLD_DEADLINE_MS,
  headerHoldExpired,
  transientHeaderFault,
} from '../src/pool.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const PERSISTENT = ['pow', 'merkle', 'prev', 'timestamp', 'bits', 'base_fee', 'version'];
const TRANSIENT = ['worker', 'stale_job', 'timeout'];

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let powTag = 12000;
function nextPow() {
  powTag += 1;
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag, 4);
  return h.toString('hex');
}

function poolAt(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-hold-${tag}-`));
  return createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
}

function rowsOf(count, dests, lowBase) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      dest: dests[i % dests.length],
      low: lowBase + i + 1,
      bits: SHARE_FLOOR_BITS + (i % 3),
    });
  }
  return rows;
}

function carried(pool) {
  return pool.lag1Shares.length + pool.openShares.length + pool.deferredShares.length;
}

function liveNonces(pool) {
  const out = new Set();
  for (const s of [...pool.lag1Shares, ...pool.openShares, ...pool.deferredShares]) {
    out.add(String(s?.nonce));
  }
  return out;
}

async function plant(pool, rows) {
  const genesis = pool.issueJob(undefined, { force: true });
  assert.ok(genesis?.jobId, 'genesis job');
  const header = Buffer.from(genesis.header, 'hex');
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const nonce = nonceWithShareTarget(BigInt(row.low), row.bits);
    const share = {
      dest: row.dest,
      nonce,
      lz: row.bits,
      shareBits: row.bits,
      creditedShareBits: row.bits,
      verifiedHeader: header,
      hash: '11',
    };
    assert.equal(rememberLiveSharePow(header, nonce, {
      noteCommit: noteCommitOfShare(share),
      shareBits: row.bits,
      lz: row.bits,
    }), true);
    const got = pool.creditAcceptedShare(share);
    assert.equal(got.ok, true, got.reason || 'credit');
    if ((i + 1) % 2048 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const sealed = await pool.sealFoundShare({
    jobId: genesis.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(sealed.ok, true, sealed.reason || 'plant');
  pool.rollOpenRound();
  const published = pool.issueJob(undefined, { force: true });
  assert.ok(published?.jobId, 'published');
  assert.equal(pool.lag1Shares.length, rows.length);
  return { shares: pool.lag1Shares.slice(), height: Number(pool.store.tip().height) };
}

function arm(pool, mode, persistent) {
  const realSubmit = pool.store.submitHeader.bind(pool.store);
  const state = { armed: true };
  pool.store.submitHeader = (req, opts) => {
    const rec = pool.store.jobs.get(String(req.jobId));
    const n = (rec?.tpl?.shareBatch || []).length;
    if (!state.armed) return realSubmit(req, opts);
    if (!persistent) return { ok: false, reason: mode };
    if (n > 0) return { ok: false, reason: mode };
    const got = realSubmit(req, opts);
    if (got?.ok && n === 0) state.armed = false;
    return got;
  };
  return state;
}

async function failOnce(pool, mode) {
  const job = pool.lastJob || pool.issueJob(undefined, { force: true });
  assert.ok(job?.jobId, `${mode} job before fault`);
  const got = await pool.sealFoundShare({
    jobId: job.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(got.ok, false, `${mode} fault`);
  assert.equal(got.reason, mode, mode);
  const next = pool.issueJob(undefined, { force: true });
  assert.ok(next?.jobId, `${mode} live job after fault`);
  return next;
}

describe('v12 header hold never stalls the sole producer', () => {
  it('a hold expires by fault count or by two block intervals', () => {
    assert.equal(transientHeaderFault('worker'), true);
    assert.equal(transientHeaderFault('stale_job'), true);
    assert.equal(transientHeaderFault('worker_timeout'), true);
    assert.equal(transientHeaderFault('pow'), false);
    assert.equal(transientHeaderFault('merkle'), false);
    const fresh = { rebuilt: true, faults: 0, at: 1_000 };
    assert.equal(headerHoldExpired(fresh, 1_000 + HEADER_HOLD_DEADLINE_MS - 1), false);
    assert.equal(headerHoldExpired(fresh, 1_000 + HEADER_HOLD_DEADLINE_MS), true);
    assert.equal(headerHoldExpired({ rebuilt: true, faults: HEADER_HOLD_MAX_FAULTS, at: 1_000 }, 1_001), true);
    assert.equal(headerHoldExpired({ rebuilt: true, faults: HEADER_HOLD_MAX_FAULTS - 1, at: 1_000 }, 1_001), false);
    assert.equal(headerHoldExpired({ rebuilt: false, faults: 0, at: 1_000 }, 1_000 + HEADER_HOLD_DEADLINE_MS), true);
    assert.equal(headerHoldExpired({ rebuilt: false, faults: HEADER_HOLD_MAX_FAULTS, at: 1_000 }, 1_001), false);
    assert.equal(headerHoldExpired(null, 1), false);
  });

  it('a deadline with no further fault still publishes a job and keeps the shares', { timeout: 120_000 }, async () => {
    const pool = poolAt('clock');
    const realNow = Date.now;
    try {
      const planted = await plant(pool, rowsOf(3, [minerDest(), minerDest()], 900));
      const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
      arm(pool, 'pow', true);
      await failOnce(pool, 'pow');
      await failOnce(pool, 'pow');
      assert.equal(pool.lag1Shares.length, planted.shares.length);
      Date.now = () => realNow() + HEADER_HOLD_DEADLINE_MS + 1;
      const job = pool.issueJob(undefined, { force: true });
      assert.ok(job?.jobId, 'job after deadline');
      assert.equal(pool.lag1Shares.length, 0);
      assert.equal(pool.deferredShares.length, planted.shares.length);
      assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0);
      assert.equal(Number(pool.store.tip().height), planted.height);
    } finally {
      Date.now = realNow;
      try { await pool.close(); } catch { /* closed */ }
    }
  });

  it('persistent header faults still seal, and transients do not latch', { timeout: 300_000 }, async () => {
    const pools = [];
    try {
      const spreads = [
        { count: 1, dests: 1, low: 100 },
        { count: 4, dests: 3, low: 400 },
      ];
      const cap = SEAL_ESCAPE_AFTER + HEADER_HOLD_MAX_FAULTS + 4;
      for (const spec of spreads) {
        const dests = Array.from({ length: spec.dests }, () => minerDest());
        for (const mode of PERSISTENT) {
          const pool = poolAt(`${mode}-${spec.count}`);
          pools.push(pool);
          const planted = await plant(pool, rowsOf(spec.count, dests, spec.low));
          const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
          arm(pool, mode, true);
          await failOnce(pool, mode);
          assert.equal(pool.lag1Shares.length, planted.shares.length, `${mode} after one`);
          assert.equal(pool.deferredShares.length, 0, `${mode} deferred after one`);
          assert.equal(Number(pool.store.tip().height), planted.height, `${mode} height after one`);
          await failOnce(pool, mode);
          assert.equal(pool.lag1Shares.length, planted.shares.length, `${mode} after two`);
          assert.equal(pool.deferredShares.length, 0, `${mode} deferred after two`);
          let sealed = null;
          for (let i = 0; i < cap; i += 1) {
            const job = pool.lastJob || pool.issueJob(undefined, { force: true });
            assert.ok(job?.jobId, `${mode} attempt ${i}`);
            const got = await pool.sealFoundShare({
              jobId: job.jobId,
              nonce: 0n,
              miner: FEE,
              powHash: nextPow(),
            });
            if (got.ok) {
              sealed = got;
              break;
            }
          }
          assert.ok(sealed?.ok, `${mode} sole producer did not seal within ${cap}`);
          assert.equal(Number(pool.store.tip().height), planted.height + 1, mode);
          assert.equal((pool.store.tip().shareBatch || []).length, 0, `${mode} fallback batch`);
          assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0, `${mode} lost`);
          const still = liveNonces(pool);
          for (const s of planted.shares) {
            assert.equal(still.has(String(s.nonce)), true, `${mode} dropped ${s.nonce}`);
          }
          pool.rollOpenRound();
          const pay = pool.issueJob(undefined, { force: true });
          assert.ok(pay?.jobId, `${mode} pay job`);
          assert.equal(pool.lag1Shares.length, planted.shares.length, `${mode} carried`);
          const paid = await pool.sealFoundShare({
            jobId: pay.jobId,
            nonce: 0n,
            miner: FEE,
            powHash: nextPow(),
          });
          assert.equal(paid.ok, true, paid.reason || mode);
          const batch = new Set((pool.store.tip().shareBatch || []).map((s) => String(s.nonce)));
          for (const s of planted.shares) {
            assert.equal(batch.has(String(s.nonce)), true, `${mode} unpaid ${s.nonce}`);
          }
          assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0, `${mode} lost after pay`);
        }
        for (const mode of TRANSIENT) {
          const pool = poolAt(`tmp-${mode}-${spec.count}`);
          pools.push(pool);
          const planted = await plant(pool, rowsOf(spec.count, dests, spec.low + 50));
          const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
          const state = arm(pool, mode, false);
          for (let i = 0; i < cap; i += 1) {
            await failOnce(pool, mode);
            assert.equal(pool.deferredShares.length, 0, `${mode} latched into deferred`);
            assert.equal(pool.lag1Shares.length, planted.shares.length, `${mode} lag1`);
            assert.equal(Number(pool.store.tip().height), planted.height, `${mode} height`);
          }
          state.armed = false;
          const job = pool.issueJob(undefined, { force: true });
          assert.ok(job?.jobId, `${mode} seal job`);
          const paid = await pool.sealFoundShare({
            jobId: job.jobId,
            nonce: 0n,
            miner: FEE,
            powHash: nextPow(),
          });
          assert.equal(paid.ok, true, paid.reason || mode);
          assert.equal(Number(pool.store.tip().height), planted.height + 1, mode);
          const batch = new Set((pool.store.tip().shareBatch || []).map((s) => String(s.nonce)));
          for (const s of planted.shares) {
            assert.equal(batch.has(String(s.nonce)), true, `${mode} unpaid ${s.nonce}`);
          }
          assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0, `${mode} lost`);
        }
      }
    } finally {
      for (const pool of pools) {
        try { await pool.close(); } catch { /* closed */ }
      }
    }
  });

  async function payReleased(pool, planted, beforeLost, label) {
    let sealed = null;
    const cap = SEAL_ESCAPE_AFTER + HEADER_HOLD_MAX_FAULTS + 4;
    for (let i = 0; i < cap; i += 1) {
      const job = pool.lastJob || pool.issueJob(undefined, { force: true });
      assert.ok(job?.jobId, `${label} attempt ${i}`);
      const got = await pool.sealFoundShare({
        jobId: job.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: nextPow(),
      });
      if (got.ok) {
        sealed = got;
        break;
      }
    }
    assert.ok(sealed?.ok, `${label} sole producer did not seal within ${cap}`);
    assert.equal((pool.store.tip().shareBatch || []).length, 0, `${label} fallback batch`);
    const still = liveNonces(pool);
    for (const s of planted.shares) {
      assert.equal(still.has(String(s.nonce)), true, `${label} dropped ${s.nonce}`);
    }
    pool.rollOpenRound();
    const pay = pool.issueJob(undefined, { force: true });
    assert.ok(pay?.jobId, `${label} pay job`);
    const paid = await pool.sealFoundShare({
      jobId: pay.jobId,
      nonce: 0n,
      miner: FEE,
      powHash: nextPow(),
    });
    assert.equal(paid.ok, true, paid.reason || label);
    const batch = new Set((pool.store.tip().shareBatch || []).map((s) => String(s.nonce)));
    for (const s of planted.shares) {
      assert.equal(batch.has(String(s.nonce)), true, `${label} unpaid ${s.nonce}`);
    }
    assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0, `${label} lost`);
  }

  it('a recurring transient cannot refresh the first-fault deadline', { timeout: 180_000 }, async () => {
    const pools = [];
    const realNow = Date.now;
    try {
      const widths = [1, 4];
      for (const count of widths) {
        const destCount = count === 1 ? 1 : 3;
        const dests = Array.from({ length: destCount }, () => minerDest());
        const modes = count > 4 ? ['worker'] : TRANSIENT;
        for (const mode of modes) {
          const pool = poolAt(`bound-${mode}-${count}`);
          pools.push(pool);
          const planted = await plant(pool, rowsOf(count, dests, 3000 + count));
          const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
          let now = realNow() + 10_000;
          Date.now = () => now;
          arm(pool, mode, true);
          await failOnce(pool, mode);
          await failOnce(pool, mode);
          for (let step = 0; step < 2; step += 1) {
            now += Math.floor(HEADER_HOLD_DEADLINE_MS / 3);
            await failOnce(pool, mode);
            await failOnce(pool, mode);
          }
          assert.equal(pool.deferredShares.length, 0, `${mode} released early`);
          assert.equal(pool.lag1Shares.length, planted.shares.length, `${mode} lag1`);
          now += Math.floor(HEADER_HOLD_DEADLINE_MS / 3);
          const job = pool.issueJob(undefined, { force: true });
          assert.ok(job?.jobId, `${mode} job at the deadline`);
          assert.equal(pool.deferredShares.length, planted.shares.length, `${mode} deadline`);
          assert.equal(pool.lag1Shares.length, 0, `${mode} still held`);
          await payReleased(pool, planted, beforeLost, `${mode}-${count}`);
        }
      }
    } finally {
      Date.now = realNow;
      for (const pool of pools) {
        try { await pool.close(); } catch { /* closed */ }
      }
    }
  });

  it('a near-cap round still expires on the first-fault deadline', { timeout: 600_000 }, async () => {
    const pools = [];
    const realNow = Date.now;
    const count = MAX_SHARES_PER_BLOCK - 1;
    try {
      const dests = Array.from({ length: 3 }, () => minerDest());
      const pool = poolAt(`bound-worker-${count}`);
      pools.push(pool);
      const planted = await plant(pool, rowsOf(count, dests, 3000 + count));
      const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
      let now = realNow() + 10_000;
      Date.now = () => now;
      arm(pool, 'worker', true);
      await failOnce(pool, 'worker');
      await failOnce(pool, 'worker');
      for (let step = 0; step < 2; step += 1) {
        now += Math.floor(HEADER_HOLD_DEADLINE_MS / 3);
        await failOnce(pool, 'worker');
        await failOnce(pool, 'worker');
      }
      assert.equal(pool.deferredShares.length, 0, 'released early');
      assert.equal(pool.lag1Shares.length, planted.shares.length, 'lag1');
      now += Math.floor(HEADER_HOLD_DEADLINE_MS / 3);
      const job = pool.issueJob(undefined, { force: true });
      assert.ok(job?.jobId, 'job at the deadline');
      assert.equal(pool.deferredShares.length, planted.shares.length, 'deadline');
      assert.equal(pool.lag1Shares.length, 0, 'still held');
      await payReleased(pool, planted, beforeLost, `worker-${count}`);
    } finally {
      Date.now = realNow;
      for (const pool of pools) {
        try { await pool.close(); } catch { /* closed */ }
      }
    }
  });

  it('alternating reasons and an interleaved transient cannot refresh the hold', { timeout: 180_000 }, async () => {
    const pools = [];
    try {
      const spreads = [
        { count: 1, dests: 1, modes: ['pow', 'merkle', 'prev', 'bits'] },
        { count: 4, dests: 3, modes: ['worker', 'pow', 'stale_job', 'merkle', 'timeout', 'prev'] },
      ];
      for (const spec of spreads) {
        const pool = poolAt(`alt-${spec.count}`);
        pools.push(pool);
        const dests = Array.from({ length: spec.dests }, () => minerDest());
        const planted = await plant(pool, rowsOf(spec.count, dests, 5000 + spec.count));
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        let n = 0;
        let armed = true;
        const realSubmit = pool.store.submitHeader.bind(pool.store);
        pool.store.submitHeader = (req, opts) => {
          const rec = pool.store.jobs.get(String(req.jobId));
          const width = (rec?.tpl?.shareBatch || []).length;
          if (!armed || width === 0) {
            const got = realSubmit(req, opts);
            if (got?.ok && width === 0) armed = false;
            return got;
          }
          const mode = spec.modes[n % spec.modes.length];
          n += 1;
          return { ok: false, reason: mode };
        };
        await payReleased(pool, planted, beforeLost, `alt-${spec.count}`);
      }
    } finally {
      for (const pool of pools) {
        try { await pool.close(); } catch { /* closed */ }
      }
    }
  });

  it('a cold re-proof whose republish throws still broadcasts a job', { timeout: 120_000 }, async () => {
    const pool = poolAt('throw-worker');
    try {
      const planted = await plant(pool, rowsOf(1, [minerDest()], 9000));
      const share = planted.shares[0];
      const tip = Buffer.from(pool.store.tip().header);
      const bits = SHARE_FLOOR_BITS;
      const nc = noteCommitOfShare(share);
      let meeting = null;
      for (let i = 1; i <= 16384; i += 1) {
        const candidate = nonceWithShareTarget(BigInt(i), bits);
        const bound = destBoundShareHash(shearHash(setNonce(tip, candidate)), nc);
        if (meetsTarget(bound, bits)) {
          meeting = candidate;
          break;
        }
        if (i % 64 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(meeting != null, 'a floor-width share meets');
      share.nonce = meeting;
      share.lz = bits;
      share.shareBits = bits;
      share.creditedShareBits = bits;
      const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
      clearLiveSharePow();
      let thrown = false;
      const realTemplate = pool.store.template.bind(pool.store);
      pool.store.template = (req) => {
        if (!thrown) {
          thrown = true;
          throw new Error('reproof worker');
        }
        return realTemplate(req);
      };
      const immediate = pool.issueJob(undefined, { force: true });
      assert.equal(immediate, null);
      const job = await pool.whenShareProofs();
      assert.ok(job?.jobId, 'catch left no job');
      assert.equal(pool.lag1Shares.length, planted.shares.length);
      assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0);
    } finally {
      try { await pool.close(); } catch { /* closed */ }
    }
  });
});

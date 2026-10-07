import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { MAX_SHARES_PER_BLOCK, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  nonceWithShareTarget,
  unitsForShare,
  clearLiveSharePow,
  liveSharePowMetrics,
  sortShares,
  noteCommitOfShare,
  rememberLiveSharePow,
} from '../../crypto/share_batch.js';
import { createPool, SEAL_ESCAPE_AFTER, SEAL_ESCAPE_PROBE_CAP } from '../src/pool.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let powTag = 8000;
function nextPow() {
  powTag += 1;
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag, 4);
  return h.toString('hex');
}

function poolAt(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-honest-${tag}-`));
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

async function plant(pool, rows) {
  const genesis = pool.issueJob(undefined, { force: true });
  assert.ok(genesis?.jobId);
  const header = Buffer.from(genesis.header, 'hex');
  const made = [];
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
    assert.equal(got.ok, true, got.reason || 'credit');
    made.push({ nonce: String(nonce), bad: !!row.bad, bits: row.bits });
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
  assert.ok(published?.jobId);
  assert.equal(pool.lag1Shares.length, rows.length);
  return { header, shares: pool.lag1Shares.slice(), made };
}

function rowsOf(count, dests, lowBase, order) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      dest: dests[i % dests.length],
      low: lowBase + i + 1,
      bits: SHARE_FLOOR_BITS + (i % 3),
      bad: false,
    });
  }
  const idx = order || rows.map((_, i) => i);
  return idx.map((i) => rows[i]);
}

describe('v12 seal escape keeps honest work', () => {
  it('drops only positive evidence and defers the rest, at any width', { timeout: 300_000 }, async () => {
    const pools = [];
    try {
      const finder = minerDest();
      // Aggregate bound: a batch longer than 2 fails, every shorter batch passes.
      // Shuffled arrival order must defer the same canonical suffix and lose nothing.
      const dests = [minerDest(), minerDest(), minerDest()];
      const orders = [
        [0, 1, 2, 3, 4, 5],
        [5, 4, 3, 2, 1, 0],
        [2, 0, 5, 1, 4, 3],
      ];
      const deferredSets = [];
      const keptSets = [];
      const pinFloors = [];
      for (const order of orders) {
        const pool = poolAt(`agg-${order[0]}`);
        pools.push(pool);
        watchFinder(pool, finder);
        const planted = await plant(pool, rowsOf(6, dests, 1000, order));
        const pins = [];
        const realProbe = pool.store.probeBlock.bind(pool.store);
        pool.store.probeBlock = (block) => {
          pins.push(liveSharePowMetrics().pins);
          const n = (block?.shareBatch || []).length;
          if (n > 2) return { ok: false, reason: 'append' };
          return realProbe(block);
        };
        let submits = 0;
        const realSubmit = pool.store.submitHeader.bind(pool.store);
        pool.store.submitHeader = (req, opts) => {
          submits += 1;
          const rec = pool.store.jobs.get(String(req.jobId));
          const n = (rec?.tpl?.shareBatch || []).length;
          if (submits <= SEAL_ESCAPE_AFTER || n > 2) return { ok: false, reason: 'append' };
          return realSubmit(req, opts);
        };
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        const beforeBans = pool.adminOps.health().bans;
        let pulses = 0;
        const arm = () => {
          pulses += 1;
          if (pulses < 40) setImmediate(arm);
        };
        setImmediate(arm);
        const seen = [];
        const prevProbe = pool.store.probeBlock;
        pool.store.probeBlock = (block) => {
          seen.push(pulses);
          return prevProbe(block);
        };
        for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
          const got = await pool.sealFoundShare({
            jobId: pool.lastJob.jobId,
            nonce: 0n,
            miner: finder,
            powHash: nextPow(),
          });
          assert.equal(got.ok, false);
        }
        const lost = (Number(pool.stats.lostWorkHashes) || 0) - beforeLost;
        assert.equal(lost, 0, 'aggregate lost');
        assert.equal(pool.adminOps.health().bans, beforeBans);
        assert.equal(pool.lag1Shares.length + pool.deferredShares.length, planted.shares.length);
        assert.ok(pool.deferredShares.length > 0);
        assert.ok(pool.lag1Shares.length > 0);
        assert.ok(pool.lag1Shares.length <= 2);
        deferredSets.push([...nonceSet(pool.deferredShares)].sort());
        keptSets.push([...nonceSet(pool.lag1Shares)].sort());
        const canonical = sortShares(planted.shares).map((s) => String(s.nonce));
        assert.deepEqual(pool.deferredShares.map((s) => String(s.nonce)), canonical.slice(pool.lag1Shares.length));
        pinFloors.push(Math.min(...pins));
        assert.ok(seen.length >= 2 && seen[seen.length - 1] > seen[0], 'escape yielded');
        assert.ok((Number(pool.stats.sealEscapeProbes) || 0) <= SEAL_ESCAPE_PROBE_CAP * (orders.indexOf(order) + 1));
        const paid = await pool.sealFoundShare({
          jobId: pool.lastJob.jobId,
          nonce: 0n,
          miner: finder,
          powHash: nextPow(),
        });
        assert.equal(paid.ok, true, paid.reason || 'aggregate seal');
        assert.equal(pool.adminOps.health().bans, beforeBans);
      }
      assert.deepEqual(deferredSets[1], deferredSets[0]);
      assert.deepEqual(deferredSets[2], deferredSets[0]);
      assert.deepEqual(keptSets[1], keptSets[0]);
      assert.deepEqual(keptSets[2], keptSets[0]);
      for (const floor of pinFloors) assert.ok(floor >= 6, `pins ${floor}`);

      // A row that fails alone is lost. Rows that seal stay. Arrival order does not matter.
      for (const badAt of [0, 2, 4]) {
        for (const flip of [false, true]) {
          const pool = poolAt(`one-${badAt}-${flip}`);
          pools.push(pool);
          watchFinder(pool, finder);
          const spec = rowsOf(5, dests, 3000 + badAt * 20 + (flip ? 7 : 0));
          spec[badAt].bad = true;
          const order = flip ? spec.slice().reverse() : spec;
          const planted = await plant(pool, order);
          const bad = planted.made.find((r) => r.bad);
          const badNonce = bad.nonce;
          const badUnit = unitsForShare(bad.bits);
          pool.store.probeBlock = (block) => {
            const batch = block?.shareBatch || [];
            if (!batch.length) return { ok: true };
            if (batch.some((s) => String(s.nonce) === badNonce)) return { ok: false, reason: 'append' };
            return { ok: true };
          };
          let submits = 0;
          const realSubmit = pool.store.submitHeader.bind(pool.store);
          pool.store.submitHeader = (req, opts) => {
            submits += 1;
            if (submits <= SEAL_ESCAPE_AFTER) return { ok: false, reason: 'append' };
            return realSubmit(req, opts);
          };
          const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
          const beforeBans = pool.adminOps.health().bans;
          for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
            await pool.sealFoundShare({
              jobId: pool.lastJob.jobId, nonce: 0n, miner: finder, powHash: nextPow(),
            });
          }
          const lost = (Number(pool.stats.lostWorkHashes) || 0) - beforeLost;
          assert.equal(lost, badUnit, `badAt ${badAt}`);
          assert.equal(pool.adminOps.health().bans, beforeBans);
          assert.equal(nonceSet(pool.lag1Shares).has(badNonce), false);
          assert.equal(pool.lag1Shares.length + pool.deferredShares.length, planted.shares.length - 1);
          const paid = await pool.sealFoundShare({
            jobId: pool.lastJob.jobId, nonce: 0n, miner: finder, powHash: nextPow(),
          });
          assert.equal(paid.ok, true, paid.reason || `badAt ${badAt}`);
          const sealed = nonceSet(pool.store.tip().shareBatch);
          assert.equal(sealed.has(badNonce), false);
          for (const s of planted.shares) {
            if (String(s.nonce) === badNonce) continue;
            assert.equal(sealed.has(String(s.nonce)) || nonceSet(pool.lag1Shares).has(String(s.nonce)), true);
          }
        }
      }

      // Every non-empty batch fails the same way. That is a template fault, not a bad row.
      {
        const pool = poolAt('presence');
        pools.push(pool);
        watchFinder(pool, finder);
        const planted = await plant(pool, rowsOf(4, dests, 5000));
        pool.store.probeBlock = (block) => {
          const n = (block?.shareBatch || []).length;
          if (n === 0) return { ok: true };
          return { ok: false, reason: 'append' };
        };
        const realSubmit = pool.store.submitHeader.bind(pool.store);
        let submits = 0;
        pool.store.submitHeader = (req, opts) => {
          submits += 1;
          if (submits <= SEAL_ESCAPE_AFTER) return { ok: false, reason: 'append' };
          return realSubmit(req, opts);
        };
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
          await pool.sealFoundShare({
            jobId: pool.lastJob.jobId, nonce: 0n, miner: finder, powHash: nextPow(),
          });
        }
        assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0);
        assert.equal(pool.lag1Shares.length, planted.shares.length);
        assert.equal(pool.deferredShares.length, 0);
      }

      // No verdict: null template, pending probe, cold proof, sidecar ahead. Nothing is lost.
      {
        const pool = poolAt('null-job');
        pools.push(pool);
        watchFinder(pool, finder);
        const planted = await plant(pool, rowsOf(3, dests, 6000));
        pool.store.template = () => { throw new Error('gate'); };
        pool.store.probeBlock = () => ({ ok: false, reason: 'append' });
        pool.store.submitHeader = () => ({ ok: false, reason: 'append' });
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        const beforeBans = pool.adminOps.health().bans;
        for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
          await pool.sealFoundShare({
            jobId: pool.lastJob.jobId, nonce: 0n, miner: finder, powHash: nextPow(),
          });
        }
        assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0, 'null job');
        assert.equal(pool.adminOps.health().bans, beforeBans);
        assert.equal(pool.lag1Shares.length, planted.shares.length);
      }
      {
        const pool = poolAt('pending');
        pools.push(pool);
        watchFinder(pool, finder);
        const planted = await plant(pool, rowsOf(3, dests, 7000));
        pool.store.probeBlock = () => Promise.resolve({ ok: false, reason: 'append' });
        pool.store.submitHeader = () => ({ ok: false, reason: 'append' });
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
          await pool.sealFoundShare({
            jobId: pool.lastJob.jobId, nonce: 0n, miner: finder, powHash: nextPow(),
          });
        }
        assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0, 'pending');
        assert.equal(pool.lag1Shares.length, planted.shares.length);
      }
      {
        const pool = poolAt('cold');
        pools.push(pool);
        watchFinder(pool, finder);
        const planted = await plant(pool, rowsOf(2, dests, 8000));
        let submits = 0;
        pool.store.submitHeader = () => {
          submits += 1;
          if (submits === SEAL_ESCAPE_AFTER) clearLiveSharePow();
          return { ok: false, reason: 'append' };
        };
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
          await pool.sealFoundShare({
            jobId: pool.lastJob.jobId, nonce: 0n, miner: finder, powHash: nextPow(),
          });
        }
        assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0, 'cold');
        assert.equal(pool.lag1Shares.length, planted.shares.length);
      }
      {
        const pool = poolAt('sidecar');
        pools.push(pool);
        watchFinder(pool, finder);
        const planted = await plant(pool, rowsOf(3, dests, 9000));
        const local = Number(pool.store.tip()?.height || 0);
        pool.noteSidecarTip({ height: local + 4, hash: 'cd'.repeat(32) });
        pool.store.probeBlock = () => ({ ok: false, reason: 'append' });
        pool.store.submitHeader = () => ({ ok: false, reason: 'append' });
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
          await pool.sealFoundShare({
            jobId: pool.lastJob.jobId, nonce: 0n, miner: finder, powHash: nextPow(),
          });
        }
        assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0, 'sidecar');
        assert.equal(pool.lag1Shares.length, planted.shares.length);
      }

      // One row that fails alone is positive evidence.
      {
        const pool = poolAt('solo');
        pools.push(pool);
        watchFinder(pool, finder);
        const planted = await plant(pool, rowsOf(1, dests, 10000));
        const unit = unitsForShare(SHARE_FLOOR_BITS);
        pool.store.probeBlock = (block) => {
          const n = (block?.shareBatch || []).length;
          if (n === 0) return { ok: true };
          return { ok: false, reason: 'append' };
        };
        pool.store.submitHeader = () => ({ ok: false, reason: 'append' });
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
          await pool.sealFoundShare({
            jobId: pool.lastJob.jobId, nonce: 0n, miner: finder, powHash: nextPow(),
          });
        }
        assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, unit, 'solo');
        assert.equal(pool.lag1Shares.length, 0);
        assert.equal(planted.shares.length, 1);
      }

      // Header faults keep every share. The pool still has a job to seal.
      for (const mode of ['pow', 'merkle', 'prev', 'bits', 'worker', 'stale_job']) {
        const pool = poolAt(`hdr-${mode}`);
        pools.push(pool);
        watchFinder(pool, finder);
        const planted = await plant(pool, rowsOf(3, dests, 11000 + mode.length));
        const realSubmit = pool.store.submitHeader.bind(pool.store);
        pool.store.submitHeader = (req, opts) => {
          if (mode === 'worker') return { ok: false, reason: 'worker' };
          if (mode === 'stale_job') return { ok: false, reason: 'stale_job' };
          if (mode === 'pow') return { ok: false, reason: 'pow' };
          return realSubmit(req, opts);
        };
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        const beforeBans = pool.adminOps.health().bans;
        const fails = SEAL_ESCAPE_AFTER + 3;
        const corrupted = new Set();
        for (let i = 0; i < fails; i += 1) {
          if (mode === 'merkle' || mode === 'prev' || mode === 'bits') {
            const id = String(pool.lastJob?.jobId || '');
            const rec = pool.store.jobs.get(id);
            if (rec?.tpl?.header && id && !corrupted.has(id)) {
              const hdr = Buffer.from(rec.tpl.header);
              const offset = mode === 'merkle' ? 36 : mode === 'prev' ? 4 : 108;
              hdr[offset] ^= 0xff;
              rec.tpl.header = hdr;
              corrupted.add(id);
            }
          }
          const job = pool.lastJob || pool.issueJob(undefined, { force: true });
          assert.ok(job?.jobId, `${mode} live job ${i}`);
          await pool.sealFoundShare({
            jobId: job.jobId, nonce: 0n, miner: finder, powHash: nextPow(),
          });
        }
        const live = pool.issueJob(undefined, { force: true });
        assert.ok(live?.jobId, `${mode} job after faults`);
        assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0, mode);
        assert.equal(pool.adminOps.health().bans, beforeBans, mode);
        const kept = pool.lag1Shares.length + pool.openShares.length + pool.deferredShares.length;
        assert.equal(kept, planted.shares.length, mode);
        for (const login of [finder]) assert.equal(pool.miners.has(login), true);
      }

      // Full share cap. The escape bisects. It does not probe once per row.
      {
        const pool = poolAt('cap');
        pools.push(pool);
        const dest = minerDest();
        const genesis = pool.issueJob(undefined, { force: true });
        const sealed = await pool.sealFoundShare({
          jobId: genesis.jobId, nonce: 0n, miner: FEE, powHash: nextPow(),
        });
        assert.equal(sealed.ok, true, sealed.reason || 'cap plant');
        const parent = pool.store.tip().header;
        // The open-round duplicate scan is quadratic. This case is the escape
        // width, so the rows go straight onto the live lag-1 batch with proofs.
        for (let i = 0; i < MAX_SHARES_PER_BLOCK; i += 1) {
          const nonce = nonceWithShareTarget(BigInt(i + 1), SHARE_FLOOR_BITS);
          const share = {
            dest,
            nonce,
            lz: SHARE_FLOOR_BITS,
            shareBits: SHARE_FLOOR_BITS,
            creditedShareBits: SHARE_FLOOR_BITS,
            verifiedHeader: parent,
            hash: '11',
          };
          const remembered = rememberLiveSharePow(parent, nonce, {
            noteCommit: noteCommitOfShare(share),
            shareBits: SHARE_FLOOR_BITS,
            lz: SHARE_FLOOR_BITS,
          });
          assert.equal(remembered, true);
          pool.lag1Shares.push(share);
        }
        assert.equal(pool.lag1Shares.length, MAX_SHARES_PER_BLOCK);
        const limit = 128;
        let seq = 0;
        pool.store.template = (opts) => {
          const batch = opts?.shareBatch || [];
          seq += 1;
          const job = {
            jobId: `cap-${batch.length}-${seq}`,
            height: Number(pool.store.tip()?.height || 0) + 1,
            version: 1,
            prevBlockHash: '00'.repeat(32),
            merkleRoot: '11'.repeat(32),
            continuityRoot: '22'.repeat(32),
            timestamp: 1,
            bits: 1,
            shareBits: SHARE_FLOOR_BITS,
            blockBits: 1,
            header: genesis.header,
            nonce: '0',
            baseFee: 1,
          };
          const tpl = { header: Buffer.from(genesis.header, 'hex'), shareBatch: batch, txs: [] };
          pool.store.jobs.set(String(job.jobId), { job, tpl });
          return { job, tpl };
        };
        pool.store.probeBlock = (block) => {
          const n = (block?.shareBatch || []).length;
          if (n > limit) return { ok: false, reason: 'append' };
          return { ok: true };
        };
        pool.store.submitHeader = () => ({ ok: false, reason: 'append' });
        const published = pool.issueJob(undefined, { force: true });
        assert.ok(published?.jobId);
        const before = Number(pool.stats.sealEscapeProbes) || 0;
        const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
        for (let i = 0; i < SEAL_ESCAPE_AFTER; i += 1) {
          await pool.sealFoundShare({
            jobId: pool.lastJob.jobId, nonce: 0n, miner: FEE, powHash: nextPow(),
          });
        }
        const used = (Number(pool.stats.sealEscapeProbes) || 0) - before;
        assert.ok(used > 0 && used <= SEAL_ESCAPE_PROBE_CAP, `cap probes ${used}`);
        assert.ok(used < MAX_SHARES_PER_BLOCK / 2, `not a linear scan ${used}`);
        assert.equal((Number(pool.stats.lostWorkHashes) || 0) - beforeLost, 0);
        assert.equal(pool.lag1Shares.length + pool.deferredShares.length, MAX_SHARES_PER_BLOCK);
        assert.ok(pool.lag1Shares.length > 0 && pool.lag1Shares.length <= limit);
        const stall = Number(pool.stats.sealEscapeStallMs);
        assert.ok(Number.isFinite(stall) && stall >= 0 && stall < 10000, `stall ${stall}`);
      }
    } finally {
      for (const pool of pools) {
        try { await pool.close(); } catch { /* closed */ }
      }
    }
  });
});

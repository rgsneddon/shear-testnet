import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshStealthDest, newIdentity } from '../../crypto/address.js';
import { decodeHeader, encodeHeader, headerFromHex } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { epochMs } from '../../crypto/pot_sched.js';
import { txIsReserveAction } from '../../crypto/reserve_vault.js';
import { digestTx } from '../../node/src/chain.js';
import { createPool } from '../src/pool.js';

const KINDS = ['lock', 'vote', 'withdraw'];
const LEADS_MS = [1, 5_000, 3_600_000];
const AMOUNTS = [1, 1_000_000_000, 50_000_000_000];
const CHOICES = ['increase', 'decrease', 'hold'];

function reserveRow(kind, nanos, choice) {
  return {
    id: `restamp-${kind}-${nanos}-${choice || 'none'}`,
    kind,
    choice: kind === 'vote' ? choice : '',
    nanos,
    vout: [{ kind, nanos }],
  };
}

function rewind(pool, job, stamp) {
  const before = decodeHeader(headerFromHex(job.header));
  const header = encodeHeader({
    version: before.version,
    prevBlockHash: before.prevBlockHash,
    merkleRoot: before.merkleRoot,
    continuityRoot: before.continuityRoot,
    timestamp: BigInt(stamp),
    bits: before.bits,
    nonce: 0n,
    baseFee: before.baseFee,
  });
  job.header = header.toString('hex');
  job.timestamp = String(stamp);
  const rec = pool.store.jobs.get(String(job.jobId));
  if (rec) {
    rec.tpl = { ...rec.tpl, header };
    rec.job = job;
  }
  return before.merkleRoot;
}

function plant(pool, job, tx) {
  const rec = pool.store.jobs.get(String(job.jobId));
  assert.ok(rec?.tpl?.txs, 'live job body');
  rec.tpl.txs.push(tx);
  assert.equal(txIsReserveAction(tx), true, tx.kind);
}

function liveBody(pool, job) {
  return pool.store.jobs.get(String(job.jobId))?.tpl;
}

describe('a restamp that crosses the epoch or holds a reserve row rebuilds', () => {
  it('drops the reserve row and probes the rebuilt body', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-restamp-epoch-'));
    const dest = freshStealthDest(newIdentity()).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: dest,
      shareBits: 8,
      bits: 16,
    });
    try {
      const opened = pool.issueJob();
      assert.ok(opened?.header);
      const span = epochMs(pool.store.reserveVault.magic);
      assert.ok(span > LEADS_MS[LEADS_MS.length - 1]);

      const parked = Date.now();
      const parkedMerkle = rewind(pool, pool.lastJob, parked - 60_000);
      const held = pool.restampJob(parked);
      assert.equal(held.jobId, opened.jobId);
      const heldHdr = decodeHeader(headerFromHex(held.header));
      assert.ok(heldHdr.merkleRoot.equals(parkedMerkle));
      assert.ok(Number(heldHdr.timestamp) > parked - 60_000);

      for (let i = 0; i < KINDS.length; i += 1) {
        for (let j = 0; j < LEADS_MS.length; j += 1) {
          const kind = KINDS[(i + j) % KINDS.length];
          const lead = LEADS_MS[j];
          const nanos = AMOUNTS[(i + j) % AMOUNTS.length];
          const choice = CHOICES[(i + j) % CHOICES.length];
          for (const mode of ['straddle', 'interior']) {
            const now = Date.now();
            const old = now - lead;
            const end = mode === 'straddle'
              ? old + Math.max(1, Math.floor(lead / 2))
              : now + span;
            pool.store.reserveVault.epochStartMs = end - span;
            pool.store.reserveVault.bonusEnacted = false;
            const job = pool.lastJob;
            rewind(pool, job, old);
            const tx = reserveRow(kind, nanos, choice);
            plant(pool, job, tx);
            const next = pool.restampJob(now);
            assert.notEqual(next.jobId, job.jobId, `${mode} ${kind} ${lead}`);
            const tpl = liveBody(pool, next);
            assert.ok(tpl?.header);
            const after = decodeHeader(headerFromHex(next.header));
            assert.ok(after.merkleRoot.equals(merkleRoot((tpl.txs || []).map(digestTx))), `${mode} ${kind} ${lead}`);
            assert.equal((tpl.txs || []).some((row) => txIsReserveAction(row)), false, `${mode} ${kind} ${lead}`);
            assert.equal((tpl.txs || []).some((row) => row?.id === tx.id), false);
            const probed = await Promise.resolve(pool.store.probeBlock({
              header: tpl.header,
              txs: tpl.txs,
              samples: tpl.samples,
              shareBatch: tpl.shareBatch || [],
              miner: tpl.miner,
              poolDest: tpl.poolDest || '',
              aLeaves: tpl.aLeaves,
              bLeaves: tpl.bLeaves,
              rootA: tpl.rootA,
              rootB: tpl.rootB,
              height: tpl.height,
            }));
            assert.equal(probed.ok, true, `${mode} ${kind} ${lead} ${probed.reason}`);
          }
        }
      }

      for (let j = 0; j < LEADS_MS.length; j += 1) {
        const lead = LEADS_MS[j];
        const now = Date.now();
        const old = now - lead;
        const end = old + Math.max(1, Math.floor(lead / 2));
        pool.store.reserveVault.epochStartMs = end - span;
        pool.store.reserveVault.bonusEnacted = false;
        const job = pool.lastJob;
        rewind(pool, job, old);
        assert.equal((liveBody(pool, job)?.txs || []).some((row) => txIsReserveAction(row)), false, `straddle-empty ${lead}`);
        const next = pool.restampJob(now);
        assert.notEqual(next.jobId, job.jobId, `straddle-empty ${lead}`);
        const tpl = liveBody(pool, next);
        assert.ok(tpl?.header);
        const after = decodeHeader(headerFromHex(next.header));
        assert.ok(after.merkleRoot.equals(merkleRoot((tpl.txs || []).map(digestTx))), `straddle-empty ${lead}`);
        assert.equal((tpl.txs || []).some((row) => txIsReserveAction(row)), false, `straddle-empty ${lead}`);
        const probed = await Promise.resolve(pool.store.probeBlock({
          header: tpl.header,
          txs: tpl.txs,
          samples: tpl.samples,
          shareBatch: tpl.shareBatch || [],
          miner: tpl.miner,
          poolDest: tpl.poolDest || '',
          aLeaves: tpl.aLeaves,
          bLeaves: tpl.bLeaves,
          rootA: tpl.rootA,
          rootB: tpl.rootB,
          height: tpl.height,
        }));
        assert.equal(probed.ok, true, `straddle-empty ${lead} ${probed.reason}`);
      }

      const bareNow = Date.now();
      pool.store.reserveVault.epochStartMs = bareNow + span;
      const bareJob = pool.lastJob;
      const bareMerkle = rewind(pool, bareJob, bareNow - LEADS_MS[1]);
      const bare = pool.restampJob(bareNow);
      assert.equal(bare.jobId, bareJob.jobId);
      assert.ok(decodeHeader(headerFromHex(bare.header)).merkleRoot.equals(bareMerkle));
      const bareTpl = liveBody(pool, bare);
      const bareProbe = await Promise.resolve(pool.store.probeBlock({
        header: bareTpl.header,
        txs: bareTpl.txs,
        samples: bareTpl.samples,
        shareBatch: bareTpl.shareBatch || [],
        miner: bareTpl.miner,
        poolDest: bareTpl.poolDest || '',
        aLeaves: bareTpl.aLeaves,
        bLeaves: bareTpl.bLeaves,
        rootA: bareTpl.rootA,
        rootB: bareTpl.rootB,
        height: bareTpl.height,
      }));
      assert.equal(bareProbe.ok, true, bareProbe.reason);
    } finally {
      pool.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

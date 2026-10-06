import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeHeader } from '../../crypto/header.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import {
  GENESIS_BITS_PACKED,
  SHARE_FLOOR_BITS,
  shareCreditMaxBits,
  MAX_SHARES_PER_BLOCK,
} from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
  reproveSharesOffLoop,
  unitsForShare,
} from '../../crypto/share_batch.js';
import { createPool } from '../src/pool.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function parentHeader() {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: 1_700_000_000_000,
    bits: GENESIS_BITS_PACKED,
  });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

let powTag = 1000;
function nextPow() {
  powTag += 1;
  return easyPow(powTag).toString('hex');
}

function poolAt(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-carry-${tag}-`));
  return createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
}

function shuffle(rows) {
  const out = rows.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 17 + 3) % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function owedSnap(store) {
  const tip = store.tip();
  const tx = tip?.txs?.[0] || {};
  return {
    height: Number(tip?.height || 0),
    hash: tip?.hash ? Buffer.from(tip.hash).toString('hex') : '',
    owed: JSON.stringify(tx.hashOwed || null),
    rest: JSON.stringify(tx.hashOwedRest || null),
  };
}

function feeSnap(block) {
  const tx = block?.txs?.[0] || {};
  const fee = (tx.vout || []).find((v) => v && v.kind === 'pool-fee');
  return {
    fee: fee?.valueProof?.v ?? null,
    carry: tx.carryNanos ?? null,
  };
}

function nonceSet(shares) {
  return new Set((shares || []).map((s) => String(s.nonce)));
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

async function failOnce(pool, mode) {
  if (mode === 'merkle') corruptJob(pool, 36);
  if (mode === 'prev') corruptJob(pool, 4);
  const pow = mode === 'pow' ? Buffer.alloc(32, 0xff).toString('hex') : nextPow();
  return pool.sealFoundShare({
    jobId: pool.lastJob.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: pow,
  });
}

async function carryThenPay(pool, rows, { fails, mode }) {
  const beforeLost = Number(pool.stats.lostWorkHashes) || 0;
  const { nonces } = await holdRound(pool, rows);
  const snap = owedSnap(pool.store);
  for (let i = 0; i < fails; i += 1) {
    const got = await failOnce(pool, mode);
    assert.equal(got.ok, false, mode);
    if (mode === 'pow') assert.equal(got.reason, 'pow');
    if (mode === 'merkle') assert.equal(got.reason, 'merkle');
    if (mode === 'prev') assert.equal(got.reason, 'prev');
    const still = nonceSet(pool.lag1Shares);
    for (const n of nonces) assert.equal(still.has(n), true, `${mode} drop ${n}`);
    const mid = owedSnap(pool.store);
    assert.equal(mid.height, snap.height);
    assert.equal(mid.hash, snap.hash);
    assert.equal(mid.owed, snap.owed);
    assert.equal(mid.rest, snap.rest);
  }
  assert.equal(Number(pool.stats.lostWorkHashes) || 0, beforeLost);
  const carried = pool.lastJob;
  assert.ok(carried?.jobId);
  const paid = await pool.sealFoundShare({
    jobId: carried.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(paid.ok, true, paid.reason);
  const tip = pool.store.tip();
  const sealed = nonceSet(tip.shareBatch);
  for (const n of nonces) assert.equal(sealed.has(n), true);
  assert.equal(Number(pool.stats.lostWorkHashes) || 0, beforeLost);
  return { nonces, tip, snap };
}

describe('v12 pool seal carries proven lag-1 shares', () => {
  it('keeps every unfailed dest across seal misses, widths, and batch sizes', { timeout: 180_000 }, async () => {
    const maxB = shareCreditMaxBits();
    const illegal = {
      dest: minerDest(),
      nonce: 3n,
      lz: 0,
      shareBits: SHARE_FLOOR_BITS,
      creditedShareBits: SHARE_FLOOR_BITS,
    };
    const missedParent = await reproveSharesOffLoop(null, [illegal]);
    assert.equal(missedParent.reason, 'parent_header');
    assert.equal(missedParent.failed.length, 0);
    const missedByte = await reproveSharesOffLoop(parentHeader(), [illegal]);
    assert.equal(missedByte.reason, 'share_pow');
    assert.equal(missedByte.failed.length, 1);

    const pools = [];
    try {
      const one = poolAt('one');
      pools.push(one);
      const dest = minerDest();
      const clean = poolAt('clean');
      pools.push(clean);
      const paid = await carryThenPay(one, [{ dest, low: 11, bits: SHARE_FLOOR_BITS }], { fails: 2, mode: 'pow' });
      assert.equal(one.adminOps.health().bans, 0);
      const { nonces: cleanNonces } = await holdRound(clean, [{ dest: minerDest(), low: 11, bits: SHARE_FLOOR_BITS }]);
      const cleanPaid = await clean.sealFoundShare({
        jobId: clean.lastJob.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: nextPow(),
      });
      assert.equal(cleanPaid.ok, true, cleanPaid.reason);
      assert.equal(nonceSet(clean.store.tip().shareBatch).has(cleanNonces[0]), true);
      assert.deepEqual(feeSnap(paid.tip), feeSnap(clean.store.tip()));

      const mixedBits = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, SHARE_FLOOR_BITS + 4, maxB];
      const mixed = shuffle(mixedBits.map((bits, i) => ({
        dest: minerDest(),
        low: 100 + i,
        bits,
      })));
      const mixPool = poolAt('mix');
      pools.push(mixPool);
      const mix = await carryThenPay(mixPool, mixed, { fails: 3, mode: 'pow' });
      const leaves = new Map((mix.tip.aLeaves || []).map((l) => [Buffer.from(l.noteCommit).toString('hex'), Number(l.count)]));
      let unitSum = 0;
      for (const row of mixed) unitSum += unitsForShare(row.bits);
      let leafSum = 0;
      for (const n of leaves.values()) leafSum += n;
      assert.equal(leaves.size, mixed.length);
      assert.ok(leafSum > 0);
      assert.ok(leafSum <= unitSum);
      for (const n of leaves.values()) assert.ok(n > 0);

      const many = [];
      for (let i = 0; i < 17; i += 1) {
        many.push({
          dest: minerDest(),
          low: 200 + i,
          bits: i % 2 === 0 ? SHARE_FLOOR_BITS : SHARE_FLOOR_BITS + 4,
        });
      }
      const manyPool = poolAt('many');
      pools.push(manyPool);
      await carryThenPay(manyPool, shuffle(many), { fails: 7, mode: 'pow' });

      const merklePool = poolAt('merkle');
      pools.push(merklePool);
      await carryThenPay(merklePool, shuffle([
        { dest: minerDest(), low: 301, bits: SHARE_FLOOR_BITS },
        { dest: minerDest(), low: 302, bits: SHARE_FLOOR_BITS + 4 },
        { dest: minerDest(), low: 303, bits: maxB },
      ]), { fails: 2, mode: 'merkle' });

      const prevPool = poolAt('prev');
      pools.push(prevPool);
      await carryThenPay(prevPool, shuffle([
        { dest: minerDest(), low: 401, bits: SHARE_FLOOR_BITS },
        { dest: minerDest(), low: 402, bits: SHARE_FLOOR_BITS + 1 },
      ]), { fails: 2, mode: 'prev' });

      const grief = poolAt('grief');
      pools.push(grief);
      const honestA = minerDest();
      const honestB = minerDest();
      const honestRows = [
        { dest: honestA, low: 501, bits: SHARE_FLOOR_BITS },
        { dest: honestB, low: 502, bits: SHARE_FLOOR_BITS + 4 },
      ];
      const { nonces: honestNonces, header } = await holdRound(grief, honestRows);
      const claimed = SHARE_FLOOR_BITS + 1;
      const coldBits = SHARE_FLOOR_BITS + 2;
      const illegalShare = {
        dest: minerDest(),
        nonce: 7n,
        lz: 0,
        shareBits: claimed,
        creditedShareBits: claimed,
        verifiedHeader: header,
        hash: '33',
      };
      const coldShare = {
        dest: minerDest(),
        nonce: nonceWithShareTarget(503n, coldBits),
        lz: coldBits,
        shareBits: coldBits,
        creditedShareBits: coldBits,
        verifiedHeader: header,
        hash: '34',
      };
      grief.lag1Shares.push(illegalShare, coldShare);
      const live = grief.store.jobs.get(String(grief.lastJob.jobId));
      live.tpl.shareBatch = live.tpl.shareBatch.concat([illegalShare, coldShare]);
      const griefSnap = owedSnap(grief.store);
      const dropped = await grief.sealFoundShare({
        jobId: grief.lastJob.jobId,
        nonce: 0n,
        miner: 'grief-miner',
        powHash: nextPow(),
      });
      assert.equal(dropped.ok, false);
      assert.equal(dropped.reason, 'share_pow');
      const remain = nonceSet(grief.lag1Shares);
      for (const n of honestNonces) assert.equal(remain.has(n), true);
      assert.equal(remain.has(String(illegalShare.nonce)), false);
      assert.equal(remain.has(String(coldShare.nonce)), false);
      const wantLost = unitsForShare(claimed) + unitsForShare(coldBits);
      assert.equal(Number(grief.stats.lostWorkHashes) || 0, wantLost);
      assert.equal(owedSnap(grief.store).hash, griefSnap.hash);
      const lostAfterDrop = Number(grief.stats.lostWorkHashes) || 0;
      for (let i = 0; i < 2; i += 1) {
        const again = await failOnce(grief, 'pow');
        assert.equal(again.ok, false);
        assert.equal(again.reason, 'pow');
      }
      assert.equal(Number(grief.stats.lostWorkHashes) || 0, lostAfterDrop);
      for (const n of honestNonces) assert.equal(nonceSet(grief.lag1Shares).has(n), true);
      const griefPaid = await grief.sealFoundShare({
        jobId: grief.lastJob.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: nextPow(),
      });
      assert.equal(griefPaid.ok, true, griefPaid.reason);
      const griefSealed = nonceSet(grief.store.tip().shareBatch);
      for (const n of honestNonces) assert.equal(griefSealed.has(n), true);
      assert.equal(griefSealed.has(String(coldShare.nonce)), false);
      assert.equal(Number(grief.stats.lostWorkHashes) || 0, wantLost);

      const capN = MAX_SHARES_PER_BLOCK;
      const cap = poolAt('cap');
      pools.push(cap);
      const capJob = cap.issueJob(undefined, { force: true });
      const capHeader = Buffer.from(capJob.header, 'hex');
      const capDests = [minerDest(), minerDest(), minerDest()];
      const capNonces = [];
      const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 4, maxB];
      for (let i = 0; i < capN; i += 1) {
        const bits = widths[i % widths.length];
        const nonce = nonceWithShareTarget(BigInt(i + 1), bits);
        const dest = capDests[i % capDests.length];
        const rec = {
          dest,
          nonce,
          lz: bits,
          shareBits: bits,
          creditedShareBits: bits,
          verifiedHeader: capHeader,
          hash: '55',
        };
        // The accept path pins every open share. Doing that once per row at
        // the block cap is quadratic, so the first rows go through
        // creditAcceptedShare and the rest are remembered into the same array.
        if (i < 3) {
          assert.equal(cap.creditAcceptedShare(rec).ok, true);
        } else {
          assert.equal(rememberLiveSharePow(capHeader, nonce, {
            noteCommit: noteCommitOfShare(rec),
            shareBits: bits,
            lz: bits,
          }), true);
          cap.openShares.push(rec);
        }
        capNonces.push(String(nonce));
      }
      const capSealed = await cap.sealFoundShare({
        jobId: capJob.jobId,
        nonce: 0n,
        miner: FEE,
        powHash: nextPow(),
      });
      assert.equal(capSealed.ok, true, capSealed.reason);
      cap.rollOpenRound();
      const capPublished = cap.issueJob(undefined, { force: true });
      assert.ok(capPublished?.jobId);
      assert.equal((cap.store.jobs.get(String(capPublished.jobId)).tpl.shareBatch || []).length, capN);
      const capSnap = owedSnap(cap.store);
      for (let i = 0; i < 2; i += 1) {
        const got = await failOnce(cap, 'pow');
        assert.equal(got.ok, false);
        assert.equal(got.reason, 'pow');
        assert.equal(cap.lag1Shares.length, capN);
      }
      assert.equal(Number(cap.stats.lostWorkHashes) || 0, 0);
      assert.equal(owedSnap(cap.store).hash, capSnap.hash);
      assert.equal(owedSnap(cap.store).owed, capSnap.owed);
      const capStill = nonceSet(cap.lag1Shares);
      assert.equal(capStill.has(capNonces[0]), true);
      assert.equal(capStill.has(capNonces[capN - 1]), true);
      assert.equal(capStill.size, capN);
    } finally {
      for (const pool of pools) {
        try { pool.close(); } catch { /* ignore */ }
      }
    }
  });
});

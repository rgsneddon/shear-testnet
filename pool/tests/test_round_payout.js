import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { BLOCK_SUBSIDY_NANOS, POOL_FEE_BPS, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { nonceWithShareTarget, selectBlockShares, unitsForShare, shareWorkBits } from '../../crypto/share_batch.js';
import { createPool, splitPot, provenLag1Shares } from '../src/pool.js';
import { potSharesFromBatch } from '../../node/src/chain.js';

function freshDest() {
  return freshStealthDest(newIdentity()).dest;
}

function nanosOf(rows, dest) {
  let n = 0;
  for (const row of rows || []) {
    if ((row.address || row.miner) === dest && row.kind !== 'pool-fee') n += row.nanos;
  }
  return n;
}

function sumNanos(rows) {
  return (rows || []).reduce((a, row) => a + row.nanos, 0);
}

/** Share rows in dest order. The nonce high byte is the credited width. */
function shareBatch(dests, spec) {
  const rows = [];
  let low = 1n;
  dests.forEach((dest, i) => {
    const bits = spec[i].bits;
    for (let k = 0; k < spec[i].n; k += 1) {
      rows.push({
        dest,
        nonce: nonceWithShareTarget(low, bits),
        lz: bits,
        shareBits: bits,
        creditedShareBits: bits,
      });
      low += 1n;
    }
  });
  return rows;
}

describe('round payouts', () => {
  it('splits any subsidy and carry by share work, in any order', () => {
    const subsidies = [10_000, 100_000_003, BLOCK_SUBSIDY_NANOS];
    const carries = [0, 1, 50_000];
    const mixes = [
      [{ bits: SHARE_FLOOR_BITS, n: 1 }],
      [{ bits: SHARE_FLOOR_BITS, n: 1 }, { bits: SHARE_FLOOR_BITS + 4, n: 1 }],
      [{ bits: SHARE_FLOOR_BITS, n: 2 }, { bits: SHARE_FLOOR_BITS, n: 2 }, { bits: SHARE_FLOOR_BITS + 3, n: 2 }],
      [
        { bits: SHARE_FLOOR_BITS, n: 1 },
        { bits: SHARE_FLOOR_BITS + 1, n: 1 },
        { bits: SHARE_FLOOR_BITS + 5, n: 1 },
        { bits: SHARE_FLOOR_BITS, n: 4 },
      ],
      [
        { bits: SHARE_FLOOR_BITS + 2, n: 3 },
        { bits: SHARE_FLOOR_BITS, n: 3 },
        { bits: SHARE_FLOOR_BITS + 2, n: 1 },
        { bits: SHARE_FLOOR_BITS + 6, n: 1 },
        { bits: SHARE_FLOOR_BITS + 1, n: 5 },
      ],
    ];
    const feeTo = freshDest();
    for (const subsidy of subsidies) {
      const fee = Math.floor(subsidy * POOL_FEE_BPS / 10000);
      for (const carry of carries) {
        for (const spec of mixes) {
          const dests = spec.map(() => freshDest());
          const batch = shareBatch(dests, spec);
          const flipped = shareBatch([...dests].reverse(), [...spec].reverse()).reverse();
          const forward = potSharesFromBatch(batch, feeTo, subsidy, carry);
          const backward = potSharesFromBatch(flipped, feeTo, subsidy, carry);
          assert.equal(sumNanos(forward), subsidy + carry, `batch sum ${subsidy} ${carry} ${spec.length}`);
          assert.equal(sumNanos(backward), sumNanos(forward));
          const feePaid = forward.filter((row) => row.kind === 'pool-fee').reduce((a, row) => a + row.nanos, 0);
          assert.equal(feePaid, fee);
          for (const dest of dests) {
            assert.equal(nanosOf(forward, dest), nanosOf(backward, dest));
          }
          const workRows = spec.map((row, i) => ({
            miner: dests[i],
            count: row.n * unitsForShare(row.bits),
          }));
          const countRows = spec.map((row, i) => ({ miner: dests[i], count: row.n }));
          const byWork = splitPot(workRows, feeTo, subsidy, feeTo, carry);
          const byCount = splitPot(countRows, feeTo, subsidy, feeTo, carry);
          const shuffled = splitPot([...workRows].reverse(), feeTo, subsidy, feeTo, carry);
          assert.equal(sumNanos(byWork), subsidy + carry);
          assert.equal(sumNanos(shuffled), sumNanos(byWork));
          for (const dest of dests) assert.equal(nanosOf(byWork, dest), nanosOf(shuffled, dest));
          const unequal = spec.length > 1 && spec.some((row) => row.bits !== spec[0].bits)
            && spec.every((row) => row.n === spec[0].n);
          if (unequal) {
            const workSet = new Set(spec.map((row) => unitsForShare(row.bits)));
            if (workSet.size > 1) {
              const countsSame = dests.every((dest) => nanosOf(byCount, dest) === nanosOf(byCount, dests[0])
                || Math.abs(nanosOf(byCount, dest) - nanosOf(byCount, dests[0])) <= spec.length);
              assert.equal(countsSame, true);
              let sawGap = false;
              for (let i = 0; i < dests.length; i += 1) {
                for (let j = i + 1; j < dests.length; j += 1) {
                  if (spec[i].bits === spec[j].bits) continue;
                  if (nanosOf(byWork, dests[i]) !== nanosOf(byWork, dests[j])) sawGap = true;
                }
              }
              assert.equal(sawGap, true, `work split must move with bits at subsidy ${subsidy}`);
            }
          }
        }
      }
    }
    const low = freshDest();
    const high = freshDest();
    const lowBits = SHARE_FLOOR_BITS;
    const highBits = SHARE_FLOOR_BITS + 4;
    assert.ok(unitsForShare(highBits) > unitsForShare(lowBits) * 8);
    const wide = [
      { miner: low, count: unitsForShare(lowBits) },
      { miner: high, count: unitsForShare(highBits) },
    ];
    const paid = splitPot(wide, feeTo, BLOCK_SUBSIDY_NANOS, feeTo, BLOCK_SUBSIDY_NANOS);
    const bare = splitPot(wide, feeTo, BLOCK_SUBSIDY_NANOS, feeTo, 0);
    assert.ok(nanosOf(paid, high) > nanosOf(paid, low) * 4);
    assert.notEqual(nanosOf(paid, high), nanosOf(bare, high) + BLOCK_SUBSIDY_NANOS);
    assert.notEqual(nanosOf(paid, low), nanosOf(bare, low) + BLOCK_SUBSIDY_NANOS);
    assert.equal(unitsForShare(), 2 ** SHARE_FLOOR_BITS);
    assert.equal(unitsForShare(SHARE_FLOOR_BITS), unitsForShare());
    assert.equal(shareWorkBits({}), SHARE_FLOOR_BITS);
    assert.equal(shareWorkBits({ shareBits: SHARE_FLOOR_BITS + 4 }), SHARE_FLOOR_BITS + 4);
  });

  it('provenLag1Shares drops a parent-header miss so the next job stays sealable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lag1-'));
    const alice = newIdentity();
    const destA = freshStealthDest(alice).dest;
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner: destA,
      shareBits: SHARE_FLOOR_BITS,
      bits: 12,
    });
    const job = pool.issueJob();
    const parent = Buffer.from(job.header, 'hex');
    const bad = { dest: destA, nonce: 0n, lz: 8 };
    const kept = provenLag1Shares(parent, [bad]);
    assert.equal(kept.length, 0);

    const sealed = Buffer.from(job.header, 'hex');
    const restamp = Buffer.from(job.header, 'hex');
    restamp.writeBigUInt64LE(restamp.readBigUInt64LE(100) + 10_000n, 100);
    const aliceNonce = nonceWithShareTarget(11n, SHARE_FLOOR_BITS);
    const bobNonce = nonceWithShareTarget(12n, SHARE_FLOOR_BITS);
    const staleNonce = nonceWithShareTarget(13n, SHARE_FLOOR_BITS);
    const aliceShare = {
      dest: destA,
      nonce: aliceNonce,
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
      verifiedHeader: sealed.toString('hex'),
    };
    const bob = newIdentity();
    const destB = freshStealthDest(bob).dest;
    const bobShare = {
      dest: destB,
      nonce: bobNonce,
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
      verifiedHeader: sealed.toString('hex'),
    };
    const stale = {
      dest: destB,
      nonce: staleNonce,
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
      verifiedHeader: restamp.toString('hex'),
    };
    const mixed = provenLag1Shares(sealed, [aliceShare, bobShare, stale]);
    assert.equal(mixed.length, 2);
    assert.equal(mixed.some((s) => s.dest === destA), true);
    assert.equal(mixed.some((s) => s.dest === destB && s.nonce === bobNonce), true);
    assert.equal(mixed.some((s) => s.nonce === staleNonce), false);
    const selected = selectBlockShares(mixed);
    assert.ok(selected.length > 0);
    assert.ok(selected.every((s) => s.verifiedHeader));
    const again = provenLag1Shares(sealed, selected);
    assert.equal(again.length, selected.length);
    pool.close();
  });
});

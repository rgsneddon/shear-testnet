import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash20FromAddress, newIdentity } from '../../crypto/address.js';
import {
  BLOCK_SUBSIDY_NANOS,
  MAX_SHARES_PER_BLOCK,
  SHARE_FLOOR_BITS,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import {
  bindShareProofSlots,
  canonicalIssuedJobKeys,
  clearLiveSharePow,
  nonceWithShareTarget,
  rememberLiveSharePow,
  resetSharePowCounters,
  selectBlockShares,
  sharePowCounters,
  splitDeferWindow,
  unitsForShare,
  verifyShareBatch,
} from '../../crypto/share_batch.js';
import { digestTx } from '../src/chain.js';
import {
  JOB_HEADER_HISTORY,
  candidateShareHeaders,
  createPool,
  provenLag1Shares,
  splitPot,
} from '../../pool/src/pool.js';

const MINER_COUNTS = [1, 2, 4];
const RESTAMP_COUNTS = [1, 2, 3, JOB_HEADER_HISTORY + 1];
const DELTAS = [1n, 10_000n, 90_000n];
const BASE_STAMP = 1_700_000_000_000n;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function widths() {
  const top = shareCreditMaxBits();
  assert.ok(top > SHARE_FLOOR_BITS);
  return [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, top];
}

function roundHeader({ merkle, timestamp, bits, prev, continuity, baseFee }) {
  return encodeHeader({
    version: 1,
    prevBlockHash: prev,
    merkleRoot: merkle,
    continuityRoot: continuity,
    timestamp,
    bits,
    nonce: 0n,
    baseFee,
  });
}

function makeShare(dest, header, low, bits) {
  return {
    dest,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    noteCommit: noteCommitOfDest20(hash20FromAddress(dest)),
    verifiedHeader: Buffer.from(header),
  };
}

describe('restamp credit keeps issued headers only', () => {
  it('keeps every issued restamp and rejects an unissued header', () => {
    const band = widths();
    const feeTo = minerDest();
    const prev = Buffer.alloc(32, 9);
    const continuity = Buffer.alloc(32, 8);
    const baseFee = 3n;
    let low = 1n;
    let digestChecked = false;
    for (const miners of MINER_COUNTS) {
      for (const count of RESTAMP_COUNTS) {
        for (const delta of DELTAS) {
          const merkle = Buffer.alloc(32, 1 + (Number(delta) % 200));
          const parent = roundHeader({
            merkle,
            timestamp: BASE_STAMP,
            bits: 17,
            prev,
            continuity,
            baseFee,
          });
          const restamps = [];
          for (let i = 0; i < count; i += 1) {
            restamps.push(roundHeader({
              merkle,
              timestamp: BASE_STAMP + delta * BigInt(i + 1),
              bits: 17 + (i % 3),
              prev,
              continuity,
              baseFee,
            }));
          }
          const issued = [parent, ...restamps];
          const dests = Array.from({ length: miners }, () => minerDest());
          const shares = dests.map((dest, i) => {
            const row = makeShare(dest, restamps[i % restamps.length], low, band[i % band.length]);
            low += 1n;
            return row;
          });
          const kept = provenLag1Shares(parent, shares, null, null, issued);
          assert.equal(kept.length, shares.length, `miners ${miners} restamps ${count}`);
          const window = splitDeferWindow(shares, parent, null, MAX_SHARES_PER_BLOCK, issued);
          assert.equal(window.stale.length, 0, `miners ${miners} restamps ${count}`);
          assert.equal(window.seal.length, shares.length, `miners ${miners} restamps ${count}`);
          assert.equal(window.carry.length, 0);
          assert.equal(window.owe.length, 0);
          const bound = bindShareProofSlots(shares.map((s) => ({ ...s })), parent, null, {
            issuedJobKeys: issued,
          });
          assert.equal(bound.unslotted.length, 0, `miners ${miners} restamps ${count}`);
          assert.ok(bound.slotted.every((s) => s.proofSlot === 0 && s.kinHeader === true));
          const selected = selectBlockShares(window.seal);
          assert.equal(selected.length, shares.length);
          let units = 0;
          for (const row of selected) units += unitsForShare(row.shareBits);
          assert.ok(units > 0);
          const paid = splitPot(
            selected.map((row) => ({ miner: row.dest, count: unitsForShare(row.shareBits) })),
            feeTo,
            BLOCK_SUBSIDY_NANOS,
            feeTo,
            0,
          );
          for (const dest of dests) {
            const pot = paid.find((row) => row.address === dest && row.kind === 'pot');
            assert.ok(pot && pot.nanos > 0, `miners ${miners} restamps ${count}`);
          }
          const unseen = roundHeader({
            merkle,
            timestamp: BASE_STAMP + delta * BigInt(count + 3),
            bits: 17,
            prev,
            continuity,
            baseFee,
          });
          const unseenShare = makeShare(dests[0], unseen, low, band[0]);
          low += 1n;
          assert.equal(provenLag1Shares(parent, [unseenShare], null, null, issued).length, 0);
          const junk = Buffer.from(restamps[0]);
          junk[40] ^= 0x01;
          const junkShare = makeShare(dests[0], junk, low, band[0]);
          low += 1n;
          assert.equal(provenLag1Shares(parent, [junkShare], null, null, issued).length, 0);
          const deniedSlot = bindShareProofSlots([{ ...junkShare }], parent, null, { issuedJobKeys: issued });
          assert.equal(deniedSlot.unslotted.length, 1);
          clearLiveSharePow();
          resetSharePowCounters();
          const denied = verifyShareBatch({
            parentHeader: parent,
            shares: [{ ...junkShare, proofSlot: 0 }],
            issuedJobKeys: issued,
          });
          assert.equal(denied.ok, false);
          assert.equal(denied.reason, 'share_slot');
          assert.equal(sharePowCounters().sync, 0);
          const remembered = rememberLiveSharePow(shares[0].verifiedHeader, shares[0].nonce, {
            noteCommit: shares[0].noteCommit,
            shareBits: shares[0].shareBits,
            lz: shares[0].lz,
          });
          assert.equal(remembered, true);
          const verdict = verifyShareBatch({
            parentHeader: parent,
            shares: [{ ...shares[0], proofSlot: 0 }],
            issuedJobKeys: canonicalIssuedJobKeys(issued),
          });
          assert.equal(verdict.ok, true, verdict.reason || `miners ${miners} restamps ${count}`);
          assert.equal(sharePowCounters().sync, 0);
          assert.ok(verdict.shares[0].units > 0);
          if (!digestChecked) {
            digestChecked = true;
            const ids = canonicalIssuedJobKeys(issued);
            assert.ok(ids.length >= 2);
            const coinbase = {
              coinbase: true,
              height: 2,
              vin: [{ coinbase: true, height: 2 }],
              vout: [],
              issuedJobKeys: ids,
            };
            const boundDigest = digestTx(coinbase);
            const bare = digestTx({ ...coinbase, issuedJobKeys: undefined });
            assert.notEqual(boundDigest.toString('hex'), bare.toString('hex'));
            const messy = digestTx({ ...coinbase, issuedJobKeys: [...ids].reverse() });
            assert.notEqual(messy.toString('hex'), boundDigest.toString('hex'));
            const wire = compactTx(coinbase);
            assert.deepEqual(wire.issuedJobKeys, ids);
            assert.ok(digestTx(wire).equals(boundDigest));
          }
        }
      }
    }
    assert.equal(digestChecked, true);
  });

  it('keeps an open-round share across a restamp the pool recorded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-restamp-'));
    const miner = minerDest();
    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner,
      shareBits: SHARE_FLOOR_BITS,
      bits: 12,
    });
    try {
      const job = pool.issueJob();
      assert.ok(job?.header, 'job');
      const dest = minerDest();
      const nonce = nonceWithShareTarget(21n, SHARE_FLOOR_BITS);
      const opened = pool.creditAcceptedShare({
        fp: 'restamp-live',
        dest,
        nonce,
        lz: SHARE_FLOOR_BITS,
        shareBits: SHARE_FLOOR_BITS,
        verifiedHeader: job.header,
        noteCommit: noteCommitOfDest20(hash20FromAddress(dest)),
      });
      assert.equal(opened.ok, true, opened.reason || 'credit');
      const before = String(job.header);
      const stamped = pool.restampJob(Date.now() + 120_000);
      assert.ok(stamped?.header, 'restamp');
      assert.notEqual(String(stamped.header), before);
      assert.equal(pool.openShares.length, 1);
      assert.equal(String(pool.openShares[0].verifiedHeader), before);
      const issued = candidateShareHeaders(pool.lastJob);
      assert.ok(issued.includes(before));
      assert.ok(issued.includes(String(stamped.header)));
      const kept = provenLag1Shares(stamped.header, pool.openShares, null, null, issued);
      assert.equal(kept.length, 1);
      assert.ok(unitsForShare(kept[0].shareBits) > 0);
      const flipped = Buffer.from(String(stamped.header), 'hex');
      flipped[40] ^= 0x01;
      const alien = {
        ...pool.openShares[0],
        verifiedHeader: flipped.toString('hex'),
        nonce: nonceWithShareTarget(22n, SHARE_FLOOR_BITS),
      };
      assert.equal(provenLag1Shares(stamped.header, [alien], null, null, issued).length, 0);
      const window = splitDeferWindow(
        pool.openShares,
        Buffer.from(String(stamped.header), 'hex'),
        null,
        MAX_SHARES_PER_BLOCK,
        issued,
      );
      assert.equal(window.seal.length, 1);
      assert.equal(window.stale.length, 0);
    } finally {
      pool.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

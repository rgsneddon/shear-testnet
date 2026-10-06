import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader, setNonce } from '../../crypto/header.js';
import { GENESIS_BITS_PACKED, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  clearLiveSharePow,
  destBoundShareHash,
  noteCommitOfShare,
  rememberLiveSharePow,
  selectBlockShares,
  shareWorkBits,
  stashSharePow,
  unitsForShare,
  verifyShareBatch,
} from '../../crypto/share_batch.js';
import { potSharesFromBatch } from '../src/chain.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function rxForBits(noteCommit, meet, miss) {
  for (let i = 0; i < 250_000; i += 1) {
    const rx = Buffer.alloc(32);
    rx.writeUInt32LE(i, 0);
    rx.writeUInt32LE((i * 17) >>> 0, 4);
    const bound = destBoundShareHash(rx, noteCommit);
    if (meetsTarget(bound, meet) && !meetsTarget(bound, miss)) return rx;
  }
  return null;
}

function rxThatMisses(noteCommit, bits) {
  for (let i = 0; i < 10_000; i += 1) {
    const rx = Buffer.alloc(32);
    rx.writeUInt32LE(i + 1, 8);
    if (!meetsTarget(destBoundShareHash(rx, noteCommit), bits)) return rx;
  }
  return null;
}

describe('v12 share cache binds dest and bits', () => {
  it('a cached nonce cannot be stolen or inflated on any credit path', () => {
    clearLiveSharePow();
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, SHARE_FLOOR_BITS + 3];
    const victims = widths.map(() => minerDest());
    const attackers = widths.map(() => minerDest());
    const parent = encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: 1_700_000_000_000,
      bits: GENESIS_BITS_PACKED,
    });
    const proven = widths.map((bits, i) => {
      const share = { dest: victims[i], nonce: BigInt(i + 1), lz: 0 };
      const nc = noteCommitOfShare(share);
      const rx = rxForBits(nc, bits, bits + 1);
      assert.ok(rx, `bound hash at width ${bits}`);
      const jobHeader = i % 2 === 0 ? parent : setNonce(parent, share.nonce);
      assert.equal(rememberLiveSharePow(jobHeader, share.nonce, {
        noteCommit: nc,
        shareBits: bits,
        lz: bits,
      }), true);
      return { dest: victims[i], bits, share, nc, rx, header: setNonce(parent, share.nonce) };
    });
    assert.equal(rememberLiveSharePow(parent, 99n, { lz: 0, shareBits: widths[0] }), false);
    assert.equal(rememberLiveSharePow(parent, proven[0].share.nonce, {
      noteCommit: noteCommitOfShare({ dest: attackers[0] }),
      shareBits: proven[0].bits,
      lz: 0,
    }), false);
    assert.equal(rememberLiveSharePow(parent, proven[0].share.nonce, {
      noteCommit: proven[0].nc,
      shareBits: 52,
      lz: 0,
    }), false);

    const honestRows = () => proven.map((row) => ({ ...row.share, shareBits: row.bits }));
    const expectUnits = proven.reduce((n, row) => n + unitsForShare(row.bits), 0);

    for (const skipPow of [false, true]) {
      const ok = verifyShareBatch({ parentHeader: parent, shares: honestRows(), skipPow });
      assert.equal(ok.ok, true, `${skipPow} ${ok.reason}`);
      assert.equal(ok.units, expectUnits);
      for (const row of proven) {
        for (const attacker of attackers) {
          for (const claim of [row.bits, row.bits + 1, 52]) {
            const stolen = verifyShareBatch({
              parentHeader: parent,
              shares: [{ dest: attacker, nonce: row.share.nonce, lz: claim, shareBits: claim }],
              skipPow,
            });
            assert.equal(stolen.ok, false, `steal ${row.bits} ${claim} skip=${skipPow}`);
            assert.equal(stolen.reason, 'share_pow');
          }
        }
        for (const claim of [row.bits + 1, 52]) {
          const inflated = verifyShareBatch({
            parentHeader: parent,
            shares: [{ ...row.share, shareBits: claim }],
            skipPow,
          });
          assert.equal(inflated.ok, false);
          assert.equal(inflated.reason, 'share_pow');
        }
      }
      const again = verifyShareBatch({ parentHeader: parent, shares: honestRows(), skipPow });
      assert.equal(again.ok, true, again.reason);
      assert.equal(again.units, expectUnits);
    }

    const empty = verifyShareBatch({ parentHeader: parent, shares: [], skipPow: true });
    assert.equal(empty.ok, true);
    assert.equal(empty.units, 0);
    assert.equal(empty.aLeaves.length, 0);

    clearLiveSharePow();
    for (const row of proven) {
      if (row.bits <= SHARE_FLOOR_BITS) continue;
      const miss = rxThatMisses(row.nc, SHARE_FLOOR_BITS);
      assert.ok(miss);
      stashSharePow(row.header, miss);
    }
    const cold = verifyShareBatch({ parentHeader: parent, shares: honestRows(), skipPow: true });
    assert.equal(cold.ok, false);
    assert.equal(cold.reason, 'share_pow');
    const floorRow = proven.find((row) => row.bits === SHARE_FLOOR_BITS);
    const floorOnly = verifyShareBatch({
      parentHeader: parent,
      shares: [{ ...floorRow.share, shareBits: floorRow.bits }],
      skipPow: true,
    });
    assert.equal(floorOnly.ok, true, floorOnly.reason);
    assert.equal(floorOnly.units, unitsForShare(SHARE_FLOOR_BITS));
    for (const row of proven) {
      const miss = rxThatMisses(row.nc, SHARE_FLOOR_BITS);
      assert.ok(miss);
      stashSharePow(row.header, miss);
      const missed = verifyShareBatch({
        parentHeader: parent,
        shares: [{ ...row.share, shareBits: row.bits }],
      });
      assert.equal(missed.ok, false);
      assert.equal(missed.reason, 'share_pow');
      stashSharePow(row.header, row.rx);
      const peer = verifyShareBatch({
        parentHeader: parent,
        shares: [{ ...row.share, shareBits: row.bits }],
      });
      assert.equal(peer.ok, true, peer.reason);
      assert.equal(peer.units, unitsForShare(row.bits));
      const disk = JSON.parse(JSON.stringify({
        dest: row.dest,
        nonce: row.share.nonce.toString(),
        lz: 0,
        shareBits: row.bits,
        noteCommit: row.nc.toString('hex'),
      }));
      stashSharePow(row.header, row.rx);
      const replay = verifyShareBatch({ parentHeader: parent, shares: [disk] });
      assert.equal(replay.ok, true, replay.reason);
      assert.equal(replay.units, unitsForShare(row.bits));
      stashSharePow(row.header, row.rx);
      const mutated = verifyShareBatch({
        parentHeader: parent,
        shares: [{ ...disk, shareBits: row.bits + 1 }],
      });
      assert.equal(mutated.ok, false);
      assert.equal(mutated.reason, 'share_pow');
      const attackerNc = noteCommitOfShare({ dest: attackers[0] });
      const stolenMiss = rxThatMisses(attackerNc, SHARE_FLOOR_BITS);
      assert.ok(stolenMiss);
      stashSharePow(row.header, stolenMiss);
      const moved = verifyShareBatch({
        parentHeader: parent,
        shares: [{ dest: attackers[0], nonce: row.share.nonce, lz: 0, shareBits: row.bits }],
      });
      assert.equal(moved.ok, false);
      assert.equal(moved.reason, 'share_pow');
    }

    clearLiveSharePow();
    for (const row of proven) {
      assert.equal(rememberLiveSharePow(parent, row.share.nonce, {
        noteCommit: row.nc,
        shareBits: row.bits,
        lz: row.bits,
      }), true);
    }
    const open = [];
    for (const row of proven) {
      const verifiedHeader = row.header.toString('hex');
      open.push({
        dest: row.dest,
        nonce: row.share.nonce,
        lz: 0,
        shareBits: row.bits,
        verifiedHeader,
      });
      open.push({
        dest: attackers[0],
        nonce: row.share.nonce,
        lz: 0,
        shareBits: 52,
        verifiedHeader,
      });
    }
    const kept = selectBlockShares(open);
    const clamped = selectBlockShares([{
      dest: proven[2].dest,
      nonce: proven[2].share.nonce,
      lz: 0,
      shareBits: 52,
      verifiedHeader: proven[2].header.toString('hex'),
    }]);
    assert.equal(clamped.length, 1);
    assert.equal(shareWorkBits(clamped[0]), proven[2].bits);
    assert.equal(kept.length, proven.length);
    for (const row of kept) {
      const src = proven.find((p) => p.dest === row.dest);
      assert.ok(src);
      assert.equal(shareWorkBits(row), src.bits);
    }
    assert.equal(selectBlockShares([{
      dest: attackers[0],
      nonce: proven[0].share.nonce,
      shareBits: 52,
      verifiedHeader: proven[0].header.toString('hex'),
    }]).length, 0);
    const subsidies = [10_000, 100_000_003];
    const carries = [0, 17];
    for (const subsidy of subsidies) {
      for (const carry of carries) {
        const pays = potSharesFromBatch(kept, null, subsidy, carry);
        assert.equal(pays.reduce((a, p) => a + p.nanos, 0), subsidy + carry);
        for (const attacker of attackers) {
          assert.equal(pays.some((p) => p.address === attacker), false);
        }
        const low = pays.find((p) => p.address === victims[0])?.nanos || 0;
        const high = pays.find((p) => p.address === victims[2])?.nanos || 0;
        assert.ok(high > low, `${subsidy} ${carry} ${high} vs ${low}`);
      }
    }
    clearLiveSharePow();
  });
});

/**
 * 018f residuals for the 018e Share Commitment seal.
 * Timely times, invalidate-omit, CapUnits_prod from Prod, and a carry
 * the next producer pays as hash-bonus credit. shareBatch pay is not zeroed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHeader } from '../../crypto/header.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import {
  MAX_HASH_UNITS_PER_BLOCK,
  SHARE_FLOOR_BITS,
  consensusFingerprint,
} from '../../crypto/asert.js';
import { nonceWithShareTarget } from '../../crypto/share_batch.js';
import { packEpochBlock, unpackEpochBlock } from '../../crypto/chainbin.js';
import {
  CapUnits_prod,
  Prod,
  Timely,
  freshCreditsFromShares,
  mergeCreditRows,
  packShareCommitCarryBytes,
  shareCommitAccount,
  shareCommitOfBlock,
  shareCommitRoot,
  unpackShareCommitCarryBytes,
} from '../../crypto/hash_owed.js';

const FLOOR = SHARE_FLOOR_BITS;
const UNIT = 1n << BigInt(FLOOR);

function share(i, bits, commitMs) {
  const dest20 = Buffer.alloc(20);
  dest20.writeUInt32BE((i + 1) >>> 0, 0);
  dest20[19] = i & 0xff;
  return {
    dest20,
    noteCommit: noteCommitOfDest20(dest20),
    nonce: nonceWithShareTarget(BigInt(i + 1), bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    commitMs,
  };
}

function header(timestamp) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp,
    bits: 1,
    nonce: 0n,
  });
}

describe('018f share commitment residuals', () => {
  it('Timely is the open parent time through this block time', () => {
    assert.equal(Timely(101, 100, 200), true);
    assert.equal(Timely(200, 100, 200), true);
    assert.equal(Timely(100, 100, 200), false);
    assert.equal(Timely(201, 100, 200), false);
    assert.equal(Timely(null, 100, 200), false);
    assert.equal(Timely(150, null, 200), false);
    assert.equal(Timely(150n, 100n, 200n), true);
  });

  it('Prod sums 2^b and CapUnits_prod caps that sum', () => {
    const one = share(1, FLOOR, 150);
    const two = share(2, FLOOR, 160);
    assert.equal(Prod([one]), UNIT);
    assert.equal(Prod([one, two]), UNIT * 2n);
    const illegal = share(3, 1, 150);
    illegal.nonce = nonceWithShareTarget(3n, 1);
    illegal.creditedShareBits = 1;
    illegal.shareBits = 1;
    assert.equal(Prod([illegal]), null);
    assert.equal(CapUnits_prod(0n), 0n);
    assert.equal(CapUnits_prod(100n), 100n);
    assert.equal(CapUnits_prod(BigInt(MAX_HASH_UNITS_PER_BLOCK) + 1n), BigInt(MAX_HASH_UNITS_PER_BLOCK));
    assert.equal(CapUnits_prod(null), null);
  });

  it('omitting a timely share under the cap is share_commit', () => {
    const older = share(1, FLOOR, 150);
    const newer = share(2, FLOOR, 160);
    const omitted = shareCommitAccount({
      commits: [newer, older],
      included: [newer],
      parentMs: 100,
      blockMs: 200,
    });
    assert.equal(omitted.ok, false);
    assert.equal(omitted.bad, false);
    assert.equal(omitted.reason, 'share_commit');
    assert.equal(omitted.prod, UNIT * 2n);
    assert.equal(omitted.cap, UNIT * 2n);
    const kept = shareCommitAccount({
      commits: [newer, older],
      included: [older, newer],
      parentMs: 100,
      blockMs: 200,
    });
    assert.equal(kept.ok, true, kept.reason);
    assert.equal(kept.carry.length, 0);
    assert.equal(kept.fresh.length, 0);
    assert.equal(kept.mandatory.length, 2);
  });

  it('an untimely share may be omitted', () => {
    const late = share(4, FLOOR, 500);
    const early = share(5, FLOOR, 50);
    const account = shareCommitAccount({
      commits: [late, early],
      included: [],
      parentMs: 100,
      blockMs: 200,
    });
    assert.equal(account.ok, true, account.reason);
    assert.equal(account.mandatory.length, 0);
    assert.equal(account.carry.length, 0);
    assert.equal(account.prod, 0n);
  });

  it('pays a parent carry on the next producer and does not zero shareBatch pay', () => {
    const older = share(1, FLOOR, 150);
    const newer = share(2, FLOOR, 160);
    const first = shareCommitAccount({
      commits: [newer, older],
      included: [older],
      parentMs: 100,
      blockMs: 200,
      maxUnits: UNIT,
    });
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.cap, UNIT);
    assert.equal(first.mandatory.length, 1);
    assert.equal(first.carry.length, 1);
    assert.equal(first.fresh.length, 0);
    const local = share(3, FLOOR, 250);
    const next = shareCommitAccount({
      carryIn: first.carry,
      commits: [local],
      included: [local],
      parentMs: 200,
      blockMs: 300,
      maxUnits: UNIT * 2n,
    });
    assert.equal(next.ok, true, next.reason);
    assert.equal(next.fresh.length, 1);
    assert.equal(next.fresh[0].nanos, UNIT);
    assert.ok(next.fresh[0].noteCommit.equals(newer.noteCommit));
    const localCredit = freshCreditsFromShares([local]);
    assert.equal(localCredit.length, 1);
    assert.equal(localCredit[0].nanos, UNIT);
    const merged = mergeCreditRows(localCredit, next.fresh);
    assert.equal(merged.length, 2);
    const localRow = merged.find((row) => row.noteCommit.equals(local.noteCommit));
    const foreignRow = merged.find((row) => row.noteCommit.equals(newer.noteCommit));
    assert.equal(localRow.nanos, UNIT);
    assert.equal(foreignRow.nanos, UNIT);
    assert.ok(localRow.nanos > 0n);
    assert.ok(foreignRow.nanos > 0n);
  });

  it('a block that drops the carry pay or the parent root is share_commit', () => {
    const owed = share(7, FLOOR, 150);
    const root = shareCommitRoot([owed]);
    assert.ok(root && root.length === 32);
    const parent = {
      header: header(200n),
      shareCommitCarry: [owed],
      txs: [{ coinbase: true, shareCommitRoot: root }],
    };
    const child = {
      header: header(300n),
      shareBatch: [],
      shareCommits: [],
      txs: [{ coinbase: true }],
    };
    const dropped = shareCommitOfBlock(child, parent, { parentMs: 200n, blockMs: 300n });
    assert.equal(dropped.ok, false);
    assert.equal(dropped.reason, 'share_commit');
    const account = shareCommitAccount({
      carryIn: [owed],
      included: [],
      parentMs: 200n,
      blockMs: 300n,
    });
    assert.equal(account.ok, true, account.reason);
    assert.equal(account.fresh[0].nanos, UNIT);
    child.shareCommitPay = account.fresh;
    const paid = shareCommitOfBlock(child, parent, { parentMs: 200n, blockMs: 300n });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.fresh[0].nanos, UNIT);
    parent.txs[0].shareCommitRoot = Buffer.alloc(32);
    const lied = shareCommitOfBlock(child, parent, { parentMs: 200n, blockMs: 300n });
    assert.equal(lied.ok, false);
    assert.equal(lied.reason, 'share_commit');
  });

  it('round-trips the carry on the epoch trailer', () => {
    const owed = share(8, FLOOR, 150);
    const packed = packShareCommitCarryBytes([owed]);
    const back = unpackShareCommitCarryBytes(packed);
    assert.equal(back.length, 1);
    assert.ok(Buffer.from(back[0].noteCommit).equals(owed.noteCommit));
    assert.equal(back[0].nonce, owed.nonce);
    const block = {
      header: header(200n),
      hash: Buffer.alloc(32),
      height: 2,
      rootA: Buffer.alloc(32),
      rootB: Buffer.alloc(32),
      aLeaves: [],
      bLeaves: [],
      txs: [],
      shareBatch: [],
      shareCommitCarry: [owed],
    };
    const loaded = unpackEpochBlock(packEpochBlock(block));
    assert.equal(loaded.shareCommitCarry.length, 1);
    assert.ok(Buffer.from(loaded.shareCommitCarry[0].noteCommit).equals(owed.noteCommit));
    assert.equal(BigInt(loaded.shareCommitCarry[0].commitMs), 150n);
  });

  it('seals SHARE_COMMIT=timely-omit-v1 in the fingerprint', () => {
    assert.match(consensusFingerprint(), /SHARE_COMMIT=timely-omit-v1/);
  });
});

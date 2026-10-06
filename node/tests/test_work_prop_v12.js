import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader, setNonce } from '../../crypto/header.js';
import {
  BLOCK_SUBSIDY_NANOS,
  GENESIS_BITS_PACKED,
  HASH_BONUS_NANOS,
  POOL_FEE_BPS,
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  asertNextBits,
  hashBonusUnitNanos,
} from '../../crypto/asert.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  destBoundShareHash,
  noteCommitOfShare,
  selectBlockShares,
  shareWorkBits,
  stashSharePow,
  unitsForShare,
  verifyShareBatch,
} from '../../crypto/share_batch.js';
import { packShareBatchBytes, unpackShareBatchBytes } from '../../crypto/pack.js';
import { potSubsidyNanos } from '../../crypto/pot_sched.js';
import {
  GENESIS_PREV,
  buildTemplate,
  potSharesFromBatch,
  verifyBlock,
} from '../src/chain.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { sealCoinbaseNote, addExcess } from '../../crypto/note.js';
import { coinbaseTx } from '../src/chain.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function rxForBits(noteCommit, meet, miss) {
  for (let i = 0; i < 250_000; i += 1) {
    const rx = Buffer.alloc(32);
    rx.writeUInt32LE(i, 0);
    rx.writeUInt32LE(i >>> 0, 4);
    const bound = destBoundShareHash(rx, noteCommit);
    if (meetsTarget(bound, meet) && !meetsTarget(bound, miss)) return rx;
  }
  return null;
}

describe('v12 PROP pays share work', () => {
  it('equal share counts at unequal difficulties do not pay the same', () => {
    const feeTo = minerDest();
    const low = minerDest();
    const high = minerDest();
    const lowBits = SHARE_FLOOR_BITS;
    const highBits = SHARE_FLOOR_BITS + 4;
    const batch = [
      { dest: low, nonce: 1n, lz: lowBits, shareBits: lowBits },
      { dest: high, nonce: 2n, lz: highBits, shareBits: highBits },
    ];
    const stripped = batch.map((row) => ({ dest: row.dest, nonce: row.nonce, lz: SHARE_FLOOR_BITS }));
    const subsidies = [10_000, 100_000_003, BLOCK_SUBSIDY_NANOS];
    const carries = [0, 17, 50_000];
    for (const subsidy of subsidies) {
      for (const carry of carries) {
        const work = potSharesFromBatch(batch, feeTo, subsidy, carry);
        const counts = potSharesFromBatch(stripped, feeTo, subsidy, carry);
        const lowPay = work.find((row) => row.address === low)?.nanos || 0;
        const highPay = work.find((row) => row.address === high)?.nanos || 0;
        const lowCount = counts.find((row) => row.address === low)?.nanos || 0;
        const highCount = counts.find((row) => row.address === high)?.nanos || 0;
        assert.ok(highPay > lowPay * 4, `work ${subsidy} ${carry} ${highPay} vs ${lowPay}`);
        assert.ok(Math.abs(lowCount - highCount) <= 1, `count split ${lowCount} ${highCount}`);
        assert.notEqual(highPay, highCount);
        const sum = work.reduce((a, row) => a + row.nanos, 0);
        assert.equal(sum, subsidy + carry);
        const fee = work.filter((row) => row.kind === 'pool-fee').reduce((a, row) => a + row.nanos, 0);
        assert.equal(fee, Math.floor(subsidy * POOL_FEE_BPS / 10000));
      }
    }
    const packed = unpackShareBatchBytes(packShareBatchBytes(batch));
    assert.equal(packed.length, 2);
    assert.equal(shareWorkBits(packed[0]), lowBits);
    assert.equal(shareWorkBits(packed[1]), highBits);
    const floorOnly = unpackShareBatchBytes(packShareBatchBytes(stripped));
    assert.equal(floorOnly[0].shareBits, undefined);
    assert.equal(unitsForShare(shareWorkBits(floorOnly[0])), unitsForShare());

    const heavy = { dest: high, nonce: 9n, lz: 8, shareBits: 30 };
    const kept = selectBlockShares([heavy, stripped[0]]);
    assert.equal(kept.length, 1);
    assert.equal(shareWorkBits(kept[0]), SHARE_FLOOR_BITS);
    assert.equal(selectBlockShares([heavy]).length, 0);
  });

  it('rejects credited bits the dest-bound hash does not meet', () => {
    const dest = minerDest();
    const share = { dest, nonce: 3n, lz: 0 };
    const nc = noteCommitOfShare(share);
    const meet = SHARE_FLOOR_BITS + 2;
    const miss = meet + 4;
    const rx = rxForBits(nc, meet, miss);
    assert.ok(rx, 'sha256 search finds a bound hash at the claimed width');
    const parent = encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: 1_700_000_000_000,
      bits: GENESIS_BITS_PACKED,
    });
    const header = setNonce(parent, share.nonce);
    stashSharePow(header, rx);
    const ok = verifyShareBatch({
      parentHeader: parent,
      shares: [{ ...share, shareBits: meet }],
    });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.units, unitsForShare(meet));
    assert.equal(ok.aLeaves[0].count, unitsForShare(meet));
    stashSharePow(header, rx);
    const denied = verifyShareBatch({
      parentHeader: parent,
      shares: [{ ...share, shareBits: miss }],
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'share_pow');
    stashSharePow(header, rx);
    const floor = verifyShareBatch({
      parentHeader: parent,
      shares: [share],
    });
    assert.equal(floor.ok, true, floor.reason);
    assert.equal(floor.units, unitsForShare());
  });

  it('consensus seals a work split and rejects the same counts', () => {
    const feeTo = minerDest();
    const low = minerDest();
    const high = minerDest();
    const now = 1_700_000_000_000;
    const subsidy = potSubsidyNanos(0);
    const fee = Math.floor(subsidy * POOL_FEE_BPS / 10000);
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: feeTo,
      bits: GENESIS_BITS_PACKED,
      now,
      potShares: [{ address: feeTo, nanos: fee, kind: 'pool-fee' }],
      poolDest: feeTo,
    });
    const parent = {
      header: parentTpl.header,
      txs: parentTpl.txs,
      samples: parentTpl.samples,
      shareBatch: [],
      miner: feeTo,
      poolDest: feeTo,
      aLeaves: parentTpl.aLeaves,
      bLeaves: parentTpl.bLeaves,
      weight: parentTpl.weight,
      height: 1,
    };
    const sealed = verifyBlock(parent, null, { trustedPowHash: Buffer.alloc(32), nowMs: now + 1_000 });
    assert.equal(sealed.ok, true, sealed.reason);
    const carry = subsidy - fee;
    const lowBits = SHARE_FLOOR_BITS;
    const highBits = SHARE_FLOOR_BITS + 3;
    const counts = [1, 4, 2];
    const bits = [lowBits, highBits, lowBits + 1];
    const miners = [low, high, minerDest()];
    const batch = [];
    let nonce = 1n;
    miners.forEach((dest, i) => {
      for (let n = 0; n < counts[i]; n += 1) {
        batch.push({
          dest,
          dest20: hash20FromAddress(dest),
          nonce,
          lz: bits[i],
          shareBits: bits[i],
        });
        nonce += 1n;
      }
    });
    const childNow = now + TARGET_BLOCK_INTERVAL_MS;
    const quote = asertNextBits({
      anchorBits: GENESIS_BITS_PACKED,
      anchorTimeMs: now,
      anchorHeight: 1,
      blockTimeMs: childNow,
      blockHeight: 2,
      parentTimeMs: now,
    });
    assert.equal(quote.ok, true);
    assert.equal(quote.easeBits, 0);
    const workPays = potSharesFromBatch(batch, feeTo, subsidy, carry);
    const countBatch = batch.map((row) => ({ ...row, shareBits: SHARE_FLOOR_BITS }));
    const countPays = potSharesFromBatch(countBatch, feeTo, subsidy, carry);
    assert.notEqual(
      workPays.find((row) => row.address === high)?.nanos,
      countPays.find((row) => row.address === high)?.nanos,
    );
    function check(potShares, shareBatch) {
      const tpl = buildTemplate({
        prev: sealed.hash,
        prevHeader: parent.header,
        prevBlock: parent,
        height: 2,
        miner: low,
        bits: quote.packed,
        now: childNow,
        potShares,
        shareBatch,
        poolDest: feeTo,
      });
      return verifyBlock({
        header: tpl.header,
        txs: tpl.txs,
        samples: tpl.samples,
        shareBatch: tpl.shareBatch || [],
        miner: low,
        poolDest: feeTo,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        weight: tpl.weight,
        height: 2,
      }, {
        ...parent,
        hash: sealed.hash,
      }, {
        trustedPowHash: Buffer.from('0000000000000000000000000000000000000000000000000000000000000002', 'hex'),
        skipSharePow: true,
        nowMs: childNow + 1_000,
        genesisMs: now,
        poolDest: feeTo,
      });
    }
    const ok = check(workPays, batch);
    assert.equal(ok.ok, true, ok.reason);
    const denied = check(countPays, batch);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'pot_prop');

    const unit = hashBonusUnitNanos(HASH_BONUS_NANOS);
    let workUnits = 0;
    for (const row of batch) workUnits += unitsForShare(row.shareBits);
    const hashNanos = workUnits * unit;
    const tx = coinbaseTx({
      height: 2,
      miner: low,
      potShares: workPays,
      potNanos: subsidy,
      carryNanos: 0,
    });
    const sealedHash = sealCoinbaseNote(hashNanos, {
      dest20: hash20FromAddress(low),
      kind: 'hash',
    });
    tx.vout.push(sealedHash);
    tx.excess = addExcess(tx.excess, sealedHash.r);
    const supply = auditCirculatingSupply([
      parent,
      {
        header: encodeHeader({
          prevBlockHash: sealed.hash,
          merkleRoot: Buffer.alloc(32),
          continuityRoot: Buffer.alloc(32),
          timestamp: childNow,
          bits: quote.packed,
        }),
        txs: [tx],
        shareBatch: batch,
      },
    ]);
    assert.equal(supply.status, 'verified', supply.reason || supply.status);
    assert.equal(supply.measuredHashNanos, hashNanos);
  });
});

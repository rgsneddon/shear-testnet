import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { MAGIC_TESTNET,
  HASH_BONUS_NANOS,
  MAX_HASH_UNITS_PER_BLOCK,
  SHARE_FLOOR_BITS,
  hashBonusUnitNanos,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { buildDualTree } from '../../crypto/clearing.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyNanos } from '../../crypto/pot_sched.js';
import {
  noteCommitOfShare,
  nonceWithShareTarget,
  retainedUnitsByCommit,
  unitsForShare,
  verifyShareBatch,
} from '../../crypto/share_batch.js';
import { coinbaseTx, shareCreditBound } from '../src/chain.js';
import { auditCirculatingSupply } from '../src/supply.js';

const GENESIS = 1_700_000_000_000;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function row(dest, low, bits) {
  const share = {
    nonce: nonceWithShareTarget(BigInt(low), bits),
    lz: bits,
    shareBits: bits,
    proofSlot: 0,
  };
  if (dest) share.dest = dest;
  return share;
}

function splitRows(rows) {
  let unbound = 0;
  const bound = [];
  for (const share of rows) {
    const units = unitsForShare(share.shareBits);
    if (share.dest) bound.push(share);
    else unbound += units;
  }
  return { unbound, bound };
}

function leafSum(leaves) {
  return (leaves || []).reduce((n, leaf) => n + Number(leaf.count), 0);
}

function wantMap(bound, room) {
  return retainedUnitsByCommit(bound, room);
}

function sumMap(map) {
  let n = 0;
  for (const u of map.values()) n += u;
  return n;
}

function leavesFrom(map) {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([hex, count]) => ({ noteCommit: Buffer.from(hex, 'hex'), count }));
}

function creditBlock(rows, leaves) {
  const aLeaves = leaves.map((leaf) => ({
    noteCommit: Buffer.from(leaf.noteCommit),
    count: leaf.count,
  }));
  const dual = buildDualTree({ aLeaves, bLeaves: [] });
  return {
    hash: Buffer.alloc(32, 9),
    header: encodeHeader({
      prevBlockHash: Buffer.alloc(32, 1),
      merkleRoot: Buffer.alloc(32, 2),
      continuityRoot: dual.continuityRoot,
      timestamp: GENESIS,
      bits: 16,
    }),
    shareBatch: rows,
    aLeaves,
    bLeaves: [],
  };
}

describe('one retained-units result for any unbound occupancy', () => {
  const maxB = shareCreditMaxBits();
  const mid = SHARE_FLOOR_BITS + 4;
  const high = maxB - 1;
  assert.ok(high > SHARE_FLOOR_BITS);
  assert.ok(unitsForShare(maxB) === MAX_HASH_UNITS_PER_BLOCK);

  const shapes = [];
  let low = 1;
  function take(bits, dest) {
    const share = row(dest, low, bits);
    low += 1;
    return share;
  }
  for (const destCount of [1, 3, 7]) {
    for (const unboundCount of [0, 1, 4]) {
      const dests = Array.from({ length: destCount }, () => minerDest());
      const rows = [];
      for (let i = 0; i < unboundCount; i += 1) {
        rows.push(take(i % 2 === 0 ? SHARE_FLOOR_BITS : mid, ''));
      }
      dests.forEach((dest, i) => {
        const bits = [SHARE_FLOOR_BITS, mid, high][i % 3];
        rows.push(take(bits, dest));
      });
      shapes.push({ label: `dests ${destCount} unbound ${unboundCount}`, rows });
    }
  }
  {
    const dests = [minerDest(), minerDest(), minerDest()];
    const rows = [take(high, '')];
    for (const dest of dests) rows.push(take(high - 1, dest));
    shapes.push({ label: 'bound work above the room', rows });
  }
  {
    const dest = minerDest();
    shapes.push({
      label: 'unbound fills the cap',
      rows: [take(maxB, ''), take(SHARE_FLOOR_BITS, dest)],
    });
  }
  {
    const dest = minerDest();
    shapes.push({
      label: 'unbound above the cap',
      rows: [take(maxB, ''), take(SHARE_FLOOR_BITS, ''), take(SHARE_FLOOR_BITS, dest)],
    });
  }
  {
    const dest = minerDest();
    shapes.push({
      label: 'two widths on one noteCommit',
      rows: [take(mid, ''), take(SHARE_FLOOR_BITS, dest), take(mid, dest)],
    });
  }

  it('units, leaves, and byDest are the room left after unbound rows', () => {
    const parentHeader = encodeHeader({
      prevBlockHash: Buffer.alloc(32, 4),
      merkleRoot: Buffer.alloc(32, 5),
      continuityRoot: Buffer.alloc(32, 6),
      timestamp: GENESIS,
      bits: 16,
    });
    for (const shape of shapes) {
      const { unbound, bound } = splitRows(shape.rows);
      const got = verifyShareBatch({
        parentHeader,
        shares: shape.rows,
        trustWork: true,
      });
      if (unbound > MAX_HASH_UNITS_PER_BLOCK) {
        assert.equal(got.ok, false, shape.label);
        assert.equal(got.reason, 'hash_units', shape.label);
        continue;
      }
      assert.equal(got.ok, true, `${shape.label} ${got.reason}`);
      const room = MAX_HASH_UNITS_PER_BLOCK - unbound;
      const want = wantMap(bound, room);
      const units = sumMap(want);
      assert.equal(got.units, units, shape.label);
      assert.equal(leafSum(got.aLeaves), units, shape.label);
      assert.equal(got.aLeaves.length, want.size, shape.label);
      for (const leaf of got.aLeaves) {
        const hex = Buffer.from(leaf.noteCommit).toString('hex');
        assert.equal(leaf.count, want.get(hex), shape.label);
      }
      const byHex = new Map();
      for (const share of bound) {
        const hex = noteCommitOfShare(share).toString('hex');
        byHex.set(share.dest, hex);
      }
      let destUnits = 0;
      for (const [dest, unitsForDest] of got.byDest) {
        destUnits += unitsForDest;
        const hex = byHex.get(dest);
        assert.equal(unitsForDest, want.get(hex) || 0, `${shape.label} ${dest}`);
      }
      assert.equal(destUnits, units, shape.label);
      const boundBlock = creditBlock(shape.rows, leavesFrom(want));
      const accepted = shareCreditBound(boundBlock);
      assert.equal(accepted.ok, true, `${shape.label} ${accepted.reason}`);
      const full = wantMap(bound, MAX_HASH_UNITS_PER_BLOCK);
      if (sumMap(full) !== units || full.size !== want.size) {
        const inflated = shareCreditBound(creditBlock(shape.rows, leavesFrom(full)));
        assert.equal(inflated.ok, false, shape.label);
        assert.equal(inflated.reason, 'share_credit_bind', shape.label);
      }
    }
  });

  it('the supply audit permits the same units', () => {
    const miner = minerDest();
    const pot = potSubsidyNanos(0);
    const unit = hashBonusUnitNanos(HASH_BONUS_NANOS);
    const under = [
      row('', 1, SHARE_FLOOR_BITS),
      row(minerDest(), 2, SHARE_FLOOR_BITS),
      row(minerDest(), 3, mid),
    ];
    const { unbound, bound } = splitRows(under);
    assert.ok(unbound > 0);
    assert.ok(unbound + sumMap(wantMap(bound, MAX_HASH_UNITS_PER_BLOCK)) <= MAX_HASH_UNITS_PER_BLOCK);
    const want = wantMap(bound, MAX_HASH_UNITS_PER_BLOCK - unbound);
    const units = sumMap(want);
    const tx = coinbaseTx({
      height: 1,
      miner,
      potNanos: pot,
      potShares: [{ address: miner, nanos: pot, kind: 'pot' }],
      shareBatch: under,
    });
    const block = {
      header: encodeHeader({
        prevBlockHash: Buffer.alloc(32, 1),
        merkleRoot: Buffer.alloc(32, 2),
        continuityRoot: Buffer.alloc(32, 3),
        timestamp: GENESIS,
        bits: 16,
      }),
      txs: [tx],
      shareBatch: under,
      aLeaves: leavesFrom(want),
    };
    const report = auditCirculatingSupply([block], { magic: MAGIC_TESTNET });
    assert.equal(report.status, 'verified', report.reason);
    assert.equal(report.measuredPotNanos, pot);
    assert.equal(report.measuredHashNanos, units * unit);
    assert.equal(report.circulatingNanos, pot + units * unit);

    const crowded = [row('', 11, high), row(minerDest(), 12, high), row(minerDest(), 13, high)];
    const crowdSplit = splitRows(crowded);
    assert.ok(crowdSplit.unbound < MAX_HASH_UNITS_PER_BLOCK);
    const room = MAX_HASH_UNITS_PER_BLOCK - crowdSplit.unbound;
    const scaled = wantMap(crowdSplit.bound, room);
    const wide = wantMap(crowdSplit.bound, MAX_HASH_UNITS_PER_BLOCK);
    assert.notEqual(sumMap(wide), sumMap(scaled));
    const crowdTx = coinbaseTx({
      height: 1,
      miner,
      potNanos: pot,
      potShares: [{ address: miner, nanos: pot, kind: 'pot' }],
      shareBatch: crowded,
    });
    const inflated = auditCirculatingSupply([{
      header: block.header,
      txs: [crowdTx],
      shareBatch: crowded,
      aLeaves: leavesFrom(wide),
    }], { magic: MAGIC_TESTNET });
    assert.equal(inflated.status, 'mismatch');
    assert.equal(inflated.reason, 'hash_bonus');
  });
});

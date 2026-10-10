import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { noteCommitOfDest20, excessOf } from '../../crypto/note.js';
import { compactTx, } from '../../crypto/chronoflux.js';
import { reviveTx } from '../../crypto/note.js';
import {
  GENESIS_BITS_PACKED,
  HASH_BONUS_NANOS,
  HASH_OWED_MAX_ENTRIES,
  MAX_HASH_UNITS_PER_BLOCK,
  POOL_FEE_BPS,
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  asertNextBits,
  hashOwedDustNanos,
  potSubsidyNanos,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import {
  clearLiveSharePow,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
  retainedUnitsByCommit,
  unitsForShare,
} from '../../crypto/share_batch.js';
import {
  freshCreditsFromShares,
  hashDustFromTx,
  hashOwedFromTx,
  hashOwedRoot,
  hashOverflowFromTx,
  proRataNanos,
  settleHashOwed,
  writeHashLedger,
} from '../../crypto/hash_owed.js';
import { auditCirculatingSupply } from '../src/supply.js';
import {
  GENESIS_PREV,
  buildTemplate,
  digestTx,
  potSharesFromBatch,
  verifyBlock,
} from '../src/chain.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function destRow(i, nanos, sinceHeight = 1) {
  const dest20 = Buffer.alloc(20);
  dest20.writeUInt32BE((i + 1) >>> 0, 0);
  dest20[19] = i & 0xff;
  return {
    noteCommit: noteCommitOfDest20(dest20),
    dest20,
    nanos: BigInt(nanos),
    sinceHeight,
    admitBase: null,
  };
}

function sumNanos(rows) {
  return (rows || []).reduce((n, row) => n + BigInt(row.nanos), 0n);
}

function allOwed(settled) {
  return [...(settled.owed || []), ...(settled.owedRest || [])];
}

function conserved(settled, input) {
  assert.equal(settled.dust, 0n);
  assert.equal(settled.overflow, 0n);
  const out = settled.minted + sumNanos(allOwed(settled));
  assert.equal(out, input);
}

function assertPerNote(settled, rows) {
  const want = new Map();
  for (const row of rows) {
    const hex = row.noteCommit.toString('hex');
    want.set(hex, (want.get(hex) || 0n) + row.nanos);
  }
  const got = new Map();
  for (const row of [...(settled.pay || []), ...allOwed(settled)]) {
    const hex = row.noteCommit.toString('hex');
    got.set(hex, (got.get(hex) || 0n) + row.nanos);
  }
  assert.equal(got.size, want.size);
  for (const [hex, nanos] of want) assert.equal(got.get(hex), nanos, hex);
}

function shareAt(dest, low, bits, header) {
  const row = {
    dest,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
  };
  if (header) row.verifiedHeader = header;
  return row;
}

describe('v12 hash-bonus owed ledger', () => {
  it('conserves every nano for any budget, dust, cap, and row count', () => {
    const dusts = [1n, 7n, 256n, 1000n];
    const caps = [0, 1, 4, 8];
    const counts = [1, 3, 8];
    const budgets = [0n, 1n, 10n, 256n, 10000n, (1n << 20n)];
    for (const dust of dusts) {
      for (const cap of caps) {
        for (const n of counts) {
          for (const budget of budgets) {
            const fresh = [];
            for (let i = 0; i < n; i += 1) {
              const span = [dust - 1n, dust, dust + 3n, (1n << 12n) + BigInt(i)];
              fresh.push(destRow(i, span[i % span.length] < 1n ? 1n : span[i % span.length], 5));
            }
            const orders = [fresh, [...fresh].reverse(), [...fresh].sort((a, b) => (a.sinceHeight - b.sinceHeight) || Buffer.compare(b.noteCommit, a.noteCommit))];
            const first = settleHashOwed({
              fresh: orders[0],
              budget,
              dust,
              maxEntries: cap,
              height: 5,
            });
            assert.equal(first.ok, true, first.reason);
            const input = sumNanos(fresh);
            conserved(first, input);
            assertPerNote(first, fresh);
            assert.ok(first.owed.length <= cap);
            if (first.owedRest.length) assert.equal(first.owed.length, cap);
            for (const row of allOwed(first)) assert.ok(row.nanos > 0n);
            for (const order of orders.slice(1)) {
              const other = settleHashOwed({ fresh: order, budget, dust, maxEntries: cap, height: 5 });
              assert.equal(other.ok, true);
              conserved(other, input);
              assertPerNote(other, order);
              assert.equal(other.minted, first.minted);
              assert.equal(allOwed(other).length, allOwed(first).length);
              for (let i = 0; i < allOwed(first).length; i += 1) {
                assert.equal(allOwed(other)[i].nanos, allOwed(first)[i].nanos);
                assert.equal(allOwed(other)[i].noteCommit.equals(allOwed(first)[i].noteCommit), true);
              }
            }
          }
        }
      }
    }
  });

  it('keeps a sub-dust balance on its note until the floor, then pays that note', () => {
    const dust = hashOwedDustNanos();
    assert.equal(dust, 256n);
    assert.equal(HASH_OWED_MAX_ENTRIES, 65536);
    const below = destRow(1, dust - 1n, 2);
    const at = destRow(2, dust, 2);
    const above = destRow(3, dust + 1n, 1);
    const settled = settleHashOwed({
      owedIn: [above, below, at],
      budget: 0n,
      dust,
      maxEntries: 8,
      height: 4,
    });
    assert.equal(settled.ok, true, settled.reason);
    assert.equal(settled.dust, 0n);
    assert.equal(settled.overflow, 0n);
    assert.equal(allOwed(settled).length, 3);
    assert.equal(settled.owed[0].nanos, dust + 1n);
    assert.equal(settled.owed[0].sinceHeight, 1);
    const heldBelow = allOwed(settled).find((row) => row.noteCommit.equals(below.noteCommit));
    assert.equal(heldBelow.nanos, dust - 1n);
    assert.equal(heldBelow.sinceHeight, 2);
    assert.equal(settled.minted, 0n);
    conserved(settled, (dust - 1n) + dust + (dust + 1n));
    const swept = settleHashOwed({
      owedIn: allOwed(settled),
      budget: dust + (dust + 1n),
      dust,
      height: 5,
    });
    assert.equal(swept.minted, dust + (dust + 1n));
    assert.equal(allOwed(swept).length, 1);
    assert.equal(allOwed(swept)[0].noteCommit.equals(below.noteCommit), true);
    assert.equal(allOwed(swept)[0].nanos, dust - 1n);
    assert.equal(swept.dust, 0n);
    conserved(swept, (dust - 1n) + dust + (dust + 1n));
    const grown = settleHashOwed({
      owedIn: allOwed(swept),
      fresh: [destRow(1, dust - 1n, 6)],
      budget: 0n,
      dust,
      height: 6,
    });
    assert.equal(allOwed(grown).length, 1);
    assert.equal(allOwed(grown)[0].nanos, (dust - 1n) * 2n);
    assert.equal(allOwed(grown)[0].noteCommit.equals(below.noteCommit), true);
    assert.ok(allOwed(grown)[0].nanos >= dust);
    const paid = settleHashOwed({
      owedIn: allOwed(grown),
      budget: (dust - 1n) * 2n,
      dust,
      height: 7,
    });
    assert.equal(paid.minted, (dust - 1n) * 2n);
    assert.equal(paid.pay[0].noteCommit.equals(below.noteCommit), true);
    assert.equal(allOwed(paid).length, 0);
    assert.equal(paid.dust, 0n);
    assert.equal(paid.overflow, 0n);
  });

  it('pays parent sub-dust from spare budget and keeps payable rows in the inline window', () => {
    const floors = [2n, 7n, 256n];
    const counts = [1, 3, 17];
    for (const dust of floors) {
      for (const n of counts) {
        const span = dust - 1n;
        const lows = [];
        for (let i = 0; i < n; i += 1) {
          const nanos = 1n + BigInt(i % Number(span));
          lows.push(destRow(i, nanos, i + 1));
        }
        const input = sumNanos(lows);
        for (const owedIn of [lows, [...lows].reverse()]) {
          const none = settleHashOwed({ owedIn, budget: 0n, dust, height: 3 });
          assert.equal(none.minted, 0n);
          assert.equal(allOwed(none).length, n);
          conserved(none, input);
          const paidAll = settleHashOwed({ owedIn, budget: input, dust, height: 4 });
          assert.equal(paidAll.minted, input);
          assert.equal(allOwed(paidAll).length, 0);
          for (const row of lows) {
            const got = paidAll.pay.find((p) => p.noteCommit.equals(row.noteCommit));
            assert.equal(got.nanos, row.nanos);
          }
          conserved(paidAll, input);
        }
        const payable = destRow(100, dust, 80);
        const mixed = settleHashOwed({
          owedIn: [payable, ...lows],
          budget: dust,
          dust,
          maxEntries: 1,
          height: 5,
        });
        assert.equal(mixed.pay.length, 1);
        assert.equal(mixed.pay[0].noteCommit.equals(payable.noteCommit), true);
        assert.equal(mixed.pay[0].nanos, dust);
        assert.equal(sumNanos(allOwed(mixed)), input);
        assert.equal(mixed.owed.length, 1);
        assert.equal(mixed.owedRest.length, n - 1);
        assert.ok(mixed.owed[0].nanos < dust);
        conserved(mixed, input + dust);
      }
    }

    const dust = 256n;
    const oldLow = destRow(1, dust - 1n, 1);
    const youngPay = destRow(2, dust, 9);
    const packed = settleHashOwed({
      owedIn: [youngPay, oldLow],
      budget: 0n,
      dust,
      maxEntries: 1,
      height: 10,
    });
    assert.equal(packed.owed.length, 1);
    assert.equal(packed.owed[0].noteCommit.equals(youngPay.noteCommit), true);
    assert.equal(packed.owedRest[0].noteCommit.equals(oldLow.noteCommit), true);
    assert.equal(packed.minted, 0n);
    conserved(packed, (dust - 1n) + dust);

    for (const bite of [1n, 2n, dust - 1n]) {
      const row = destRow(7, dust - 1n, 3);
      const one = settleHashOwed({ owedIn: [row], budget: bite, dust, height: 11 });
      assert.equal(one.minted, bite);
      assert.equal(one.pay[0].noteCommit.equals(row.noteCommit), true);
      assert.equal(sumNanos(allOwed(one)), (dust - 1n) - bite);
      conserved(one, dust - 1n);
    }

    const older = destRow(3, 40n, 1);
    const younger = destRow(4, 50n, 2);
    const slice = settleHashOwed({
      owedIn: [younger, older],
      budget: 30n,
      dust,
      height: 12,
    });
    assert.equal(slice.pay.length, 1);
    assert.equal(slice.pay[0].noteCommit.equals(older.noteCommit), true);
    assert.equal(slice.pay[0].nanos, 30n);
    assert.equal(allOwed(slice).find((row) => row.noteCommit.equals(older.noteCommit)).nanos, 10n);
    assert.equal(allOwed(slice).find((row) => row.noteCommit.equals(younger.noteCommit)).nanos, 50n);
    conserved(slice, 90n);

    const parent = destRow(8, 10n, 1);
    const fresh = destRow(8, 10n, 20);
    const same = settleHashOwed({
      owedIn: [parent],
      fresh: [fresh],
      budget: 1000n,
      dust,
      height: 20,
    });
    assert.equal(same.minted, 10n);
    assert.equal(allOwed(same).length, 1);
    assert.equal(allOwed(same)[0].nanos, 10n);
    assert.equal(allOwed(same)[0].noteCommit.equals(parent.noteCommit), true);
    conserved(same, 20n);
  });

  it('keeps rows past the inline cap on their noteCommit and a later block pays them', () => {
    const dust = 10n;
    const rows = [];
    for (let i = 0; i < 10; i += 1) rows.push(destRow(i, 100n + BigInt(i), i + 1));
    const settled = settleHashOwed({
      owedIn: rows,
      budget: 0n,
      dust,
      maxEntries: 4,
      height: 20,
    });
    assert.equal(settled.ok, true, settled.reason);
    assert.equal(settled.owed.length, 4);
    assert.equal(settled.owedRest.length, 6);
    assert.equal(settled.minted, 0n);
    assert.equal(settled.overflow, 0n);
    assert.equal(settled.dust, 0n);
    for (const dropped of rows.slice(4)) {
      assert.equal(settled.owed.some((row) => row.noteCommit.equals(dropped.noteCommit)), false);
      assert.equal(settled.owedRest.some((row) => row.noteCommit.equals(dropped.noteCommit) && row.nanos === dropped.nanos), true);
    }
    conserved(settled, sumNanos(rows));
    const tx = { coinbase: true };
    writeHashLedger(tx, settled);
    assert.equal(tx.hashDustNanos, undefined);
    assert.equal(tx.hashOwedOverflowNanos, undefined);
    assert.equal(hashOwedFromTx(tx).length, rows.length);
    tx.hashDustNanos = 1;
    assert.equal(hashOwedFromTx(tx), null);
    delete tx.hashDustNanos;
    tx.hashOwedOverflowNanos = 1;
    assert.equal(hashOwedFromTx(tx), null);
    delete tx.hashOwedOverflowNanos;
    const oldest = settled.owed[0];
    const later = settleHashOwed({
      owedIn: hashOwedFromTx(tx),
      budget: oldest.nanos,
      dust,
      maxEntries: 4,
      height: 21,
    });
    assert.equal(later.pay.length, 1);
    assert.equal(later.pay[0].noteCommit.equals(oldest.noteCommit), true);
    assert.equal(later.pay[0].nanos, oldest.nanos);
    assert.equal(allOwed(later).length, rows.length - 1);
    assert.equal(later.overflow, 0n);
    conserved(later, sumNanos(rows));
    const finish = settleHashOwed({
      owedIn: allOwed(later),
      budget: sumNanos(allOwed(later)),
      dust,
      maxEntries: 4,
      height: 22,
    });
    assert.equal(finish.minted, sumNanos(allOwed(later)));
    assert.equal(allOwed(finish).length, 0);
    assert.equal(finish.dust, 0n);
    assert.equal(finish.overflow, 0n);
  });

  it('attributes every nano around the inline cap, in any order', () => {
    const dust = 10n;
    const budgets = [0n, 1n, dust, dust * 3n, 100000n];
    for (const cap of [1, 4, 8]) {
      for (const n of [Math.max(1, cap - 1), cap, cap + 1]) {
        for (const budget of budgets) {
          const fresh = [];
          for (let i = 0; i < n; i += 1) fresh.push(destRow(i + 20, dust + BigInt(i), 2));
          const orders = [fresh, [...fresh].reverse()];
          const first = settleHashOwed({ fresh, budget, dust, maxEntries: cap, height: 2 });
          conserved(first, sumNanos(fresh));
          assertPerNote(first, fresh);
          assert.ok(first.owed.length <= cap);
          if (first.owedRest.length) assert.equal(first.owed.length, cap);
          for (const order of orders.slice(1)) {
            const other = settleHashOwed({ fresh: order, budget, dust, maxEntries: cap, height: 2 });
            conserved(other, sumNanos(fresh));
            assertPerNote(other, order);
            assert.equal(other.minted, first.minted);
            assert.equal(allOwed(other).length, allOwed(first).length);
          }
        }
      }
    }
  });

  it('same-height sybil rows cannot orphan an older note', () => {
    const dust = 10n;
    const honest = destRow(0, 500n, 1);
    const sybil = [];
    for (let i = 1; i <= 8; i += 1) sybil.push(destRow(i, 100n, 5));
    const orders = [
      [honest, ...sybil],
      [...sybil].reverse().concat(honest),
    ];
    for (const owedIn of orders) {
      const settled = settleHashOwed({
        owedIn,
        budget: 500n,
        dust,
        maxEntries: 3,
        height: 6,
      });
      assert.equal(settled.ok, true, settled.reason);
      assert.equal(settled.pay.some((row) => row.noteCommit.equals(honest.noteCommit) && row.nanos === 500n), true);
      for (const row of sybil) {
        const held = allOwed(settled).find((item) => item.noteCommit.equals(row.noteCommit));
        assert.ok(held);
        assert.equal(held.nanos, row.nanos);
      }
      assert.equal(settled.dust, 0n);
      assert.equal(settled.overflow, 0n);
      conserved(settled, 500n + sumNanos(sybil));
      assert.ok(settled.owedRest.length > 0);
      assert.equal(settled.owed.length, 3);
    }
  });

  it('splits a binding backlog on the drain floor and spills an unused half', () => {
    const dust = 1n;
    const older = destRow(1, 50n, 1);
    const newer = destRow(2, 80n, 4);
    const fresh = destRow(3, 40n, 9);
    const parentDebt = 50n + 80n;
    const freshDebt = 40n;
    const budgets = [1n, 2n, 50n, 51n, 100n, 130n, 170n, 1000n, (1n << 53n) + 100n];
    const orders = [[older, newer], [newer, older]];
    for (const budget of budgets) {
      const parentSlice = budget / 2n;
      const freshSlice = budget - parentSlice;
      let first = null;
      for (const owedIn of orders) {
        const settled = settleHashOwed({
          owedIn,
          fresh: [fresh],
          budget,
          dust,
          maxEntries: 8,
          height: 9,
        });
        assert.equal(settled.ok, true, settled.reason);
        conserved(settled, parentDebt + freshDebt);
        const parentPaid = settled.pay
          .filter((row) => !row.noteCommit.equals(fresh.noteCommit))
          .reduce((n, row) => n + row.nanos, 0n);
        const freshPaid = settled.pay
          .filter((row) => row.noteCommit.equals(fresh.noteCommit))
          .reduce((n, row) => n + row.nanos, 0n);
        assert.ok(parentPaid + freshPaid <= budget);
        assert.equal(parentPaid + freshPaid, settled.minted);
        if (parentDebt >= parentSlice && freshDebt >= freshSlice) {
          assert.equal(parentPaid, parentSlice);
          assert.equal(freshPaid, freshSlice);
          assert.ok(freshPaid > 0n || freshSlice === 0n);
        }
        if (parentDebt <= parentSlice) {
          assert.equal(parentPaid, parentDebt);
          const room = freshSlice + (parentSlice - parentDebt);
          assert.equal(freshPaid, freshDebt < room ? freshDebt : room);
        }
        if (freshDebt < freshSlice && parentDebt > parentSlice) {
          const spill = freshSlice - freshDebt;
          const room = parentDebt - parentSlice;
          assert.equal(parentPaid, parentSlice + (spill < room ? spill : room));
          assert.equal(freshPaid, freshDebt);
        }
        const olderPay = settled.pay.find((row) => row.noteCommit.equals(older.noteCommit));
        const newerPay = settled.pay.find((row) => row.noteCommit.equals(newer.noteCommit));
        const olderGot = olderPay ? olderPay.nanos : 0n;
        const newerGot = newerPay ? newerPay.nanos : 0n;
        if (olderGot < 50n) assert.equal(newerGot, 0n);
        if (first) {
          assert.equal(parentPaid, first.parentPaid);
          assert.equal(freshPaid, first.freshPaid);
        } else first = { parentPaid, freshPaid };
      }
    }
    const starved = settleHashOwed({
      owedIn: [older],
      fresh: [],
      budget: 50n,
      dust,
      height: 9,
    });
    assert.equal(starved.pay[0].nanos, 50n);
  });

  it('keeps a shortfall above 2^53 exact', () => {
    const huge = (1n << 53n) + 100n;
    const row = destRow(4, huge, 3);
    const held = settleHashOwed({
      owedIn: [row],
      budget: 0n,
      dust: 1n,
      maxEntries: 4,
      height: 4,
    });
    assert.equal(held.owed[0].nanos, huge);
    const paid = settleHashOwed({
      fresh: [row],
      budget: huge,
      dust: 1n,
      height: 4,
    });
    assert.equal(paid.pay[0].nanos, huge);
    assert.equal(paid.minted, huge);
    assert.notEqual(Number(huge), huge);
  });

  it('pays the retained pro-rata under an empty ledger and records the rest', () => {
    const caps = [1000, 50000, 2 ** 20, MAX_HASH_UNITS_PER_BLOCK];
    const counts = [1, 3, 8];
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 4, shareCreditMaxBits()];
    for (const cap of caps) {
      for (const n of counts) {
        const dests = Array.from({ length: n }, () => minerDest());
        const shares = dests.map((dest, i) => shareAt(dest, BigInt(i + 1), widths[i % widths.length]));
        const retained = retainedUnitsByCommit(shares, cap);
        const fresh = freshCreditsFromShares(shares);
        const settled = settleHashOwed({
          fresh,
          budget: BigInt(cap) * BigInt(HASH_BONUS_NANOS),
          height: 2,
        });
        assert.equal(settled.ok, true, settled.reason);
        const dust = hashOwedDustNanos();
        const budget = BigInt(cap) * BigInt(HASH_BONUS_NANOS);
        const ratio = proRataNanos(fresh, budget);
        for (const row of fresh) {
          const hex = row.noteCommit.toString('hex');
          const pay = settled.pay.find((p) => p.noteCommit.equals(row.noteCommit));
          const got = pay ? pay.nanos : 0n;
          const slice = ratio.get(hex) || 0n;
          if (slice >= dust) assert.equal(got, slice);
          else assert.equal(got, 0n);
          if (sumNanos(fresh) <= budget) assert.equal(got, row.nanos);
          if (cap === MAX_HASH_UNITS_PER_BLOCK) {
            const retainedNanos = BigInt(retained.get(hex) || 0) * BigInt(HASH_BONUS_NANOS);
            if (retainedNanos >= dust) {
              assert.equal(got, retainedNanos);
            } else {
              assert.equal(got, 0n);
              const owed = settled.owed.find((item) => item.noteCommit.equals(row.noteCommit));
              if (row.nanos >= dust) assert.equal(owed.nanos, row.nanos);
            }
          }
        }
        assert.ok(settled.minted <= budget);
        if (sumNanos(fresh) <= budget) {
          assert.equal(settled.owed.length, 0);
          assert.equal(settled.minted, sumNanos(fresh));
        } else {
          assert.equal(sumNanos(allOwed(settled)), sumNanos(fresh) - settled.minted);
        }
        conserved(settled, sumNanos(fresh));
        const flipped = settleHashOwed({
          fresh: [...fresh].reverse(),
          budget: BigInt(cap),
          height: 2,
        });
        assert.equal(flipped.minted, settled.minted);
        assert.equal(flipped.owed.length, settled.owed.length);
      }
    }
    const a = minerDest();
    const b = minerDest();
    const heavy = [shareAt(a, 1n, shareCreditMaxBits()), shareAt(b, 2n, shareCreditMaxBits())];
    const over = settleHashOwed({ fresh: freshCreditsFromShares(heavy), height: 3 });
    assert.equal(over.minted, BigInt(MAX_HASH_UNITS_PER_BLOCK));
    assert.equal(over.owed.length, 2);
    for (const row of over.owed) assert.equal(row.nanos, BigInt(MAX_HASH_UNITS_PER_BLOCK) / 2n);
    assert.equal(over.dust, 0n);
    assert.equal(over.overflow, 0n);
  });

  it('any later producer pays a sealed shortfall once, and a skip is rejected', () => {
    const feeTo = minerDest();
    const a = minerDest();
    const b = minerDest();
    const c = minerDest();
    const solo = minerDest();
    const now = 1_700_000_000_000;
    const subsidy = potSubsidyNanos(0);
    const fee = Math.floor(subsidy * POOL_FEE_BPS / 10000);
    const genesis = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: feeTo,
      bits: GENESIS_BITS_PACKED,
      now,
      potShares: [{ address: feeTo, nanos: fee, kind: 'pool-fee' }],
      poolDest: feeTo,
    });
    const genesisBlock = {
      header: genesis.header,
      txs: genesis.txs,
      shareBatch: [],
      miner: feeTo,
      poolDest: feeTo,
      aLeaves: genesis.aLeaves,
      bLeaves: genesis.bLeaves,
      weight: genesis.weight,
      height: 1,
    };
    const sealedG = verifyBlock(genesisBlock, null, {
      trustedPowHash: Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
      nowMs: now + 1_000,
    });
    assert.equal(sealedG.ok, true, sealedG.reason);
    genesisBlock.hash = sealedG.hash;
    assert.equal(hashOwedFromTx(genesisBlock.txs[0]).length, 0);

    const bits = shareCreditMaxBits();
    const batch = [shareAt(a, 4n, bits, genesis.header), shareAt(b, 5n, bits, genesis.header)];
    clearLiveSharePow();
    for (const row of batch) {
      assert.equal(rememberLiveSharePow(genesis.header, row.nonce, {
        noteCommit: noteCommitOfShare(row),
        shareBits: row.shareBits,
        lz: row.lz,
      }), true);
    }
    const childNow = now + TARGET_BLOCK_INTERVAL_MS;
    const quote = asertNextBits({
      anchorBits: GENESIS_BITS_PACKED,
      anchorTimeMs: now,
      anchorHeight: 1,
      blockTimeMs: childNow,
      blockHeight: 2,
      parentTimeMs: now,
    });
    assert.equal(quote.ok, true, quote.reason);
    const carry = subsidy - fee;
    function sealChild(shareBatch, miner, prevBlock, prevHash, prevHeader, height, when, potShares, parents) {
      clearLiveSharePow();
      for (const row of shareBatch) {
        assert.equal(rememberLiveSharePow(prevHeader, row.nonce, {
          noteCommit: noteCommitOfShare(row),
          shareBits: row.shareBits,
          lz: row.lz,
        }), true);
      }
      const q = asertNextBits({
        anchorBits: GENESIS_BITS_PACKED,
        anchorTimeMs: now,
        anchorHeight: 1,
        blockTimeMs: when,
        blockHeight: height,
        parentTimeMs: Number(decodeHeader(Buffer.from(prevHeader)).timestamp),
      });
      assert.equal(q.ok, true, q.reason);
      const tpl = buildTemplate({
        prev: prevHash,
        prevHeader,
        prevBlock,
        height,
        miner,
        bits: q.packed,
        now: when,
        potShares,
        shareBatch,
        poolDest: feeTo,
      });
      const block = {
        header: tpl.header,
        txs: tpl.txs,
        shareBatch: tpl.shareBatch || [],
        miner,
        poolDest: feeTo,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        weight: tpl.weight,
        height,
      };
      const tag = Buffer.alloc(32);
      tag[31] = height;
      const verdict = verifyBlock(block, { ...prevBlock, hash: prevHash, header: prevHeader }, {
        trustedPowHash: tag,
        skipSharePow: true,
        nowMs: when + 1_000,
        genesisMs: now,
        poolDest: feeTo,
        ...(Array.isArray(parents) ? { supplyParents: parents } : {}),
      });
      return { block, verdict, tpl };
    }

    const pays = potSharesFromBatch(batch, feeTo, subsidy, carry);
    const firstOrder = sealChild(batch, a, { ...genesisBlock, hash: sealedG.hash }, sealedG.hash, genesis.header, 2, childNow, pays);
    assert.equal(firstOrder.verdict.ok, true, firstOrder.verdict.reason);
    const flipped = sealChild([...batch].reverse(), a, { ...genesisBlock, hash: sealedG.hash }, sealedG.hash, genesis.header, 2, childNow, potSharesFromBatch([...batch].reverse(), feeTo, subsidy, carry));
    assert.equal(flipped.verdict.ok, true, flipped.verdict.reason);
    const owedA = hashOwedFromTx(firstOrder.block.txs[0]);
    const owedB = hashOwedFromTx(flipped.block.txs[0]);
    assert.equal(owedA.length, 2);
    assert.equal(owedB.length, 2);
    for (const row of owedA) {
      const twin = owedB.find((other) => other.noteCommit.equals(row.noteCommit));
      assert.ok(twin);
      assert.equal(twin.nanos, row.nanos);
      assert.equal(row.nanos, BigInt(MAX_HASH_UNITS_PER_BLOCK) / 2n);
    }
    const full = 2n * BigInt(MAX_HASH_UNITS_PER_BLOCK);
    const minted2 = (firstOrder.block.txs[0].vout || [])
      .filter((o) => o.kind === 'hash')
      .reduce((n, o) => n + BigInt(o.valueProof.v), 0n);
    assert.equal(minted2 + sumNanos(owedA), full);
    assert.equal(hashDustFromTx(firstOrder.block.txs[0]), 0n);
    assert.equal(hashOverflowFromTx(firstOrder.block.txs[0]), 0n);

    const parent2 = { ...firstOrder.block, hash: firstOrder.verdict.hash };
    const third = shareAt(c, 9n, SHARE_FLOOR_BITS, firstOrder.block.header);
    const when3 = childNow + TARGET_BLOCK_INTERVAL_MS;
    const pays3 = potSharesFromBatch([third], feeTo, subsidy, 0);
    const poolB = sealChild([third], c, parent2, firstOrder.verdict.hash, firstOrder.block.header, 3, when3, pays3, [genesisBlock, parent2]);
    assert.equal(poolB.verdict.ok, true, poolB.verdict.reason);
    const floorUnits = BigInt(unitsForShare(SHARE_FLOOR_BITS));
    const byCommit = [...owedA].sort((a, b) => Buffer.compare(a.noteCommit, b.noteCommit));
    const owed3 = hashOwedFromTx(poolB.block.txs[0]);
    assert.equal(owed3.length, 1);
    assert.equal(owed3[0].nanos, floorUnits);
    assert.equal(owed3[0].noteCommit.equals(byCommit[1].noteCommit), true);
    const paidDown = (poolB.block.txs[0].vout || []).filter((o) => o.kind === 'hash');
    const freshPay = paidDown.find((o) => noteCommitOfShare(third).equals(Buffer.from(o.noteCommit)));
    assert.ok(freshPay);
    assert.equal(BigInt(freshPay.valueProof.v), floorUnits);
    const parentPays = paidDown.filter((o) => !noteCommitOfShare(third).equals(Buffer.from(o.noteCommit)));
    assert.equal(parentPays.length, 2);
    const parentAmounts = parentPays.map((o) => BigInt(o.valueProof.v)).sort((a, b) => (a < b ? -1 : 1));
    assert.equal(parentAmounts[0], (BigInt(MAX_HASH_UNITS_PER_BLOCK) / 2n) - floorUnits);
    assert.equal(parentAmounts[1], BigInt(MAX_HASH_UNITS_PER_BLOCK) / 2n);

    const parent3 = { ...poolB.block, hash: poolB.verdict.hash };
    const when4 = when3 + TARGET_BLOCK_INTERVAL_MS;
    const soloPays = potSharesFromBatch([], feeTo, subsidy, 0);
    const soloBlock = sealChild([], solo, parent3, poolB.verdict.hash, poolB.block.header, 4, when4, [{ address: solo, nanos: subsidy, kind: 'pot' }], [genesisBlock, parent2, parent3]);
    void soloPays;
    assert.equal(soloBlock.verdict.ok, true, soloBlock.verdict.reason);
    assert.equal(hashOwedFromTx(soloBlock.block.txs[0]).length, 0);
    const soloHash = (soloBlock.block.txs[0].vout || []).filter((o) => o.kind === 'hash');
    assert.equal(soloHash.length, 1);
    assert.equal(BigInt(soloHash[0].valueProof.v), floorUnits);
    assert.equal(Buffer.from(soloHash[0].noteCommit).equals(byCommit[1].noteCommit), true);
    assert.equal(Buffer.from(soloHash[0].noteCommit).equals(noteCommitOfShare(third)), false);

    const chain = [genesisBlock, parent2, parent3, { ...soloBlock.block, hash: soloBlock.verdict.hash }];
    for (let n = 1; n <= chain.length; n += 1) {
      const supply = auditCirculatingSupply(chain.slice(0, n));
      assert.equal(supply.status, 'verified', `${supply.reason} at ${n}`);
    }
    const mid = auditCirculatingSupply(chain.slice(0, 2));
    assert.equal(mid.status, 'verified', mid.reason);
    assert.equal(mid.hashOwedNanos, MAX_HASH_UNITS_PER_BLOCK);
    assert.equal(mid.hashDustNanos, 0);
    assert.equal(mid.hashOwedOverflowNanos, 0);
    assert.equal(mid.circulatingNanos, mid.measuredPotNanos + mid.measuredHashNanos);
    assert.ok(mid.hashOwedNanos > 0);
    const tipSupply = auditCirculatingSupply(chain);
    assert.equal(tipSupply.hashOwedNanos, 0);
    assert.equal(tipSupply.hashDustNanos, 0);
    assert.equal(tipSupply.hashOwedOverflowNanos, 0);
    assert.equal(tipSupply.circulatingNanos, tipSupply.measuredPotNanos + tipSupply.measuredHashNanos);

    function reseal(tplBlock, txs) {
      const decoded = decodeHeader(Buffer.from(tplBlock.header));
      return {
        ...tplBlock,
        txs,
        header: encodeHeader({
          version: decoded.version,
          prevBlockHash: decoded.prevBlockHash,
          merkleRoot: merkleRoot(txs.map(digestTx)),
          continuityRoot: decoded.continuityRoot,
          timestamp: decoded.timestamp,
          bits: decoded.bits,
          nonce: decoded.nonce,
          baseFee: decoded.baseFee,
        }),
      };
    }
    function reseed(header, shares) {
      for (const row of shares) {
        assert.equal(rememberLiveSharePow(header, row.nonce, {
          noteCommit: noteCommitOfShare(row),
          shareBits: row.shareBits,
          lz: row.lz,
        }), true);
      }
    }
    const skippedTx = {
      ...poolB.block.txs[0],
      vout: poolB.block.txs[0].vout.filter((o) => o.kind !== 'hash'),
    };
    skippedTx.excess = excessOf(skippedTx.vout);
    delete skippedTx.hashOwed;
    const skipped = reseal(poolB.block, [skippedTx, ...poolB.block.txs.slice(1)]);
    reseed(firstOrder.block.header, [third]);
    const skipVerdict = verifyBlock(skipped, { ...parent2, hash: firstOrder.verdict.hash, header: firstOrder.block.header }, {
      trustedPowHash: Buffer.from('0000000000000000000000000000000000000000000000000000000000000003', 'hex'),
      skipSharePow: true,
      nowMs: when3 + 1_000,
      genesisMs: now,
      poolDest: feeTo,
    });
    assert.equal(skipVerdict.ok, false);
    assert.equal(skipVerdict.reason, 'hash_owed');

    const one = poolB.block.txs[0].vout.filter((o) => o.kind === 'hash').slice(0, 1);
    const rest = poolB.block.txs[0].vout.filter((o) => o.kind !== 'hash');
    const underTx = { ...poolB.block.txs[0], vout: rest.concat(one) };
    underTx.excess = excessOf(underTx.vout);
    const under = reseal(poolB.block, [underTx, ...poolB.block.txs.slice(1)]);
    const underVerdict = verifyBlock(under, { ...parent2, hash: firstOrder.verdict.hash, header: firstOrder.block.header }, {
      trustedPowHash: Buffer.from('0000000000000000000000000000000000000000000000000000000000000004', 'hex'),
      skipSharePow: true,
      nowMs: when3 + 1_000,
      genesisMs: now,
      poolDest: feeTo,
    });
    assert.equal(underVerdict.ok, false);
    assert.equal(underVerdict.reason, 'hash_owed');

    const swapped = hashOwedFromTx(firstOrder.block.txs[0]);
    const disorder = {
      ...firstOrder.block.txs[0],
      hashOwed: [swapped[1], swapped[0]].map((row) => ({
        noteCommit: row.noteCommit,
        dest20: row.dest20,
        nanos: Number(row.nanos),
        sinceHeight: row.sinceHeight,
      })),
    };
    const messy = reseal(firstOrder.block, [disorder, ...firstOrder.block.txs.slice(1)]);
    reseed(genesis.header, batch);
    const messyVerdict = verifyBlock(messy, { ...genesisBlock, hash: sealedG.hash, header: genesis.header }, {
      trustedPowHash: Buffer.from('0000000000000000000000000000000000000000000000000000000000000002', 'hex'),
      skipSharePow: true,
      nowMs: childNow + 1_000,
      genesisMs: now,
      poolDest: feeTo,
    });
    assert.equal(messyVerdict.ok, false);
    assert.equal(messyVerdict.reason, 'hash_owed');

    const otherSolo = minerDest();
    const fork = sealChild([], otherSolo, parent2, firstOrder.verdict.hash, firstOrder.block.header, 3, when3, [{ address: otherSolo, nanos: subsidy, kind: 'pot' }], [genesisBlock, parent2]);
    assert.equal(fork.verdict.ok, true, fork.reason || fork.verdict.reason);
    assert.equal(hashOwedFromTx(fork.block.txs[0]).length, 0);
    const forkHash = (fork.block.txs[0].vout || []).filter((o) => o.kind === 'hash');
    assert.equal(forkHash.length, 2);
    for (const note of forkHash) assert.equal(BigInt(note.valueProof.v), BigInt(MAX_HASH_UNITS_PER_BLOCK) / 2n);
    const again = sealChild([], minerDest(), { ...fork.block, hash: fork.verdict.hash }, fork.verdict.hash, fork.block.header, 4, when4, [{ address: minerDest(), nanos: subsidy, kind: 'pot' }], [genesisBlock, parent2, { ...fork.block, hash: fork.verdict.hash }]);
    assert.equal(again.verdict.ok, true, again.verdict.reason);
    assert.equal((again.block.txs[0].vout || []).some((o) => o.kind === 'hash'), false);

    const packed = reviveTx(compactTx(firstOrder.block.txs[0]));
    assert.equal(packed.hashOwed, undefined);
    assert.equal(packed.hashOwedRest, undefined);
    assert.equal(packed.hashOwedLocal, undefined);
    assert.equal(hashOwedFromTx(packed), null);
    assert.equal(hashOwedRoot(owedA).equals(Buffer.from(packed.hashOwedRoot)), true);
    assert.equal(digestTx(packed).equals(digestTx(firstOrder.block.txs[0])), true);
    const stripped = { ...packed };
    delete stripped.hashOwedRoot;
    assert.equal(digestTx(stripped).equals(digestTx(packed)), false);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyNanos, MS_PER_DAY, EPOCH_DAYS_TESTNET } from '../../crypto/pot_sched.js';
import {
  HASH_BONUS_NANOS,
  SHARE_FLOOR_BITS,
  hashBonusUnitNanos,
  MAX_SHARES_PER_BLOCK,
} from '../../crypto/asert.js';
import { unitsForShare, shareWorkBits } from '../../crypto/share_batch.js';
import { sealCoinbaseNote, addExcess, excessOf } from '../../crypto/note.js';
import { coinbaseTx } from '../src/chain.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { networkSupply, explorerCirculation } from '../../pool/src/wallet_api.js';

const GENESIS = 1_700_000_000_000;
const EPOCH_MS = EPOCH_DAYS_TESTNET * MS_PER_DAY;

function bonusUnit() {
  return unitsForShare() * hashBonusUnitNanos(HASH_BONUS_NANOS);
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function header(ts) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: ts,
    bits: 16,
  });
}

function potBlock(ts, miner, notes, carryNanos = 0, extra = {}) {
  const potNotes = notes.filter((n) => n.kind !== 'finder-fee' && n.kind !== 'reserve-fee' && n.kind !== 'hash');
  const shares = potNotes.map((n) => ({
    address: n.address || miner,
    nanos: n.nanos,
    kind: n.kind || 'pot',
  }));
  const tx = coinbaseTx({
    height: 1,
    miner,
    potShares: shares,
    potNanos: shares.reduce((a, s) => a + s.nanos, 0),
    carryNanos,
  });
  const rest = notes.filter((n) => n.kind === 'finder-fee' || n.kind === 'reserve-fee' || n.kind === 'hash');
  for (const n of rest) {
    const sealed = sealCoinbaseNote(n.nanos, {
      dest20: hash20FromAddress(n.address || miner),
      kind: n.kind,
    });
    tx.vout.push(sealed);
    tx.excess = addExcess(tx.excess, sealed.r);
  }
  if (!tx.vout.length) tx.excess = excessOf([]);
  const txs = [tx];
  if (extra.fee != null) txs.push({ fee: extra.fee });
  return {
    header: header(ts),
    txs,
    shareBatch: extra.shareBatch || [],
  };
}

function splitSum(total, n) {
  const count = Math.max(1, Math.floor(n));
  const base = Math.floor(total / count);
  const parts = Array.from({ length: count }, () => base);
  let rem = total - base * count;
  for (let i = 0; rem > 0; i += 1, rem -= 1) parts[i % count] += 1;
  return parts;
}

function shareRows(groups) {
  const rows = [];
  let nonce = 1n;
  for (const group of groups) {
    for (let i = 0; i < group.count; i += 1) {
      rows.push({ dest: group.dest, nonce, lz: 8 });
      nonce += 1n;
    }
  }
  return rows;
}

describe('v12 circulating supply is the public mint', () => {
  it('does not open notes or echo a measured hash onto both sides', () => {
    const src = fs.readFileSync(new URL('../src/supply.js', import.meta.url), 'utf8');
    assert.equal(src.includes('openedCoinbaseNanos'), false);
    assert.equal(src.includes('coinbaseVoutsBound'), false);
    assert.equal(src.includes('valueProof'), false);
  });

  it('verifies any pot partition and mismatches any other amount', () => {
    const miner = minerDest();
    const epochs = [0, 1, 7, 80, 120];
    const genesisBlock = () => potBlock(GENESIS, miner, [{ nanos: potSubsidyNanos(0), kind: 'pot' }]);
    for (const epoch of epochs) {
      const permitted = potSubsidyNanos(epoch);
      const ts = GENESIS + epoch * EPOCH_MS;
      const parts = splitSum(permitted, 3 + (epoch % 4));
      assert.equal(parts.reduce((a, n) => a + n, 0), permitted);
      const prefix = epoch === 0 ? [] : [genesisBlock()];
      const prefixPot = epoch === 0 ? 0 : potSubsidyNanos(0);
      const paid = auditCirculatingSupply(prefix.concat([
        potBlock(ts, miner, parts.map((nanos) => ({ nanos, kind: 'pot' }))),
      ]));
      assert.equal(paid.status, 'verified', `epoch ${epoch}`);
      assert.equal(paid.circulatingNanos, prefixPot + permitted);
      assert.equal(paid.schedulePotNanos, prefixPot + permitted);
      assert.equal(paid.differenceNanos, 0);
      assert.equal(paid.measuredLevyNanos, 0);
      assert.equal(paid.measuredHashNanos, 0);

      const held = auditCirculatingSupply(prefix.concat([
        potBlock(ts, miner, [{ nanos: 1, kind: 'pot' }], permitted - 1),
      ]));
      assert.equal(held.status, 'verified', `carry epoch ${epoch}`);
      assert.equal(held.circulatingNanos, prefixPot + 1);
      assert.equal(held.carryNanos, permitted - 1);
      assert.equal(held.schedulePotNanos, prefixPot + permitted);
      assert.equal(held.differenceNanos, 0);
      assert.equal(held.circulatingNanos + held.carryNanos, held.schedulePotNanos);

      const levyParts = [1 + (epoch % 5), 17 + epoch, 100 + epoch * 3];
      const levySum = levyParts.reduce((a, n) => a + n, 0);
      const recycled = auditCirculatingSupply(prefix.concat([
        potBlock(ts, miner, [
          { nanos: permitted, kind: 'pot' },
          { nanos: levyParts[0], kind: 'finder-fee' },
          { nanos: levyParts[1], kind: 'reserve-fee' },
          { nanos: levyParts[2], kind: 'finder-fee' },
        ], 0, { fee: levySum }),
      ]));
      assert.equal(recycled.status, 'verified', `levy epoch ${epoch}`);
      assert.equal(recycled.circulatingNanos, prefixPot + permitted);
      assert.equal(recycled.measuredLevyNanos, levySum);
      assert.notEqual(recycled.circulatingNanos, prefixPot + permitted + levySum);

      const unpaidLevy = auditCirculatingSupply(prefix.concat([
        potBlock(ts, miner, [
          { nanos: permitted, kind: 'pot' },
          { nanos: levySum, kind: 'finder-fee' },
        ]),
      ]));
      assert.equal(unpaidLevy.status, 'mismatch', `unfunded levy epoch ${epoch}`);
      assert.equal(unpaidLevy.circulatingNanos, prefixPot);
      assert.notEqual(unpaidLevy.circulatingNanos, prefixPot + permitted + levySum);

      for (const wrong of [permitted + 1 + epoch, Math.max(1, permitted - 1 - epoch)]) {
        if (wrong === permitted) continue;
        const miss = auditCirculatingSupply(prefix.concat([
          potBlock(ts, miner, [{ nanos: wrong, kind: 'pot' }]),
        ]));
        assert.equal(miss.status, 'mismatch', `amount ${wrong} epoch ${epoch}`);
        assert.equal(miss.circulatingNanos, prefixPot);
        assert.equal(miss.measuredPotNanos, prefixPot);
        assert.notEqual(miss.circulatingNanos, prefixPot + wrong);
        assert.equal(miss.schedulePotNanos, prefixPot + permitted);
        assert.notEqual(miss.circulatingNanos, miss.schedulePotNanos);
        assert.notEqual(miss.differenceNanos, 0);
      }
    }

    const chain = epochs.map((epoch) => potBlock(
      GENESIS + epoch * EPOCH_MS,
      miner,
      [{ nanos: potSubsidyNanos(epoch), kind: 'pot' }],
    ));
    const sum = epochs.reduce((a, epoch) => a + potSubsidyNanos(epoch), 0);
    const all = auditCirculatingSupply(chain);
    assert.equal(all.status, 'verified');
    assert.equal(all.circulatingNanos, sum);
    assert.equal(all.schedulePotNanos, sum);
    assert.equal(all.differenceNanos, 0);

    const store = { blocks: chain, tip: () => chain[chain.length - 1], reserveVault: {} };
    const published = networkSupply(store);
    assert.equal(published.supplyStatus, 'verified');
    assert.equal(published.circulatingNanos, sum);
    assert.equal(published.potNanos, sum);
    assert.equal(published.hashNanos, 0);
    assert.equal(published.schedulePotNanos, sum);
    assert.equal(published.differenceNanos, 0);
    const circ = explorerCirculation(store);
    assert.equal(circ.supplyStatus, 'verified');
    assert.equal(circ.proofs, true);
    assert.equal(circ.circulatingNanos, published.circulatingNanos);

    const inflated = chain.slice();
    inflated[2] = potBlock(
      GENESIS + epochs[2] * EPOCH_MS,
      miner,
      [{ nanos: potSubsidyNanos(epochs[2]) + 1, kind: 'pot' }],
    );
    const drift = networkSupply({ blocks: inflated, tip: () => inflated.at(-1), reserveVault: {} });
    assert.equal(drift.supplyStatus, 'mismatch');
    assert.notEqual(drift.circulatingNanos, drift.schedulePotNanos);
    assert.equal(explorerCirculation({
      blocks: inflated, tip: () => inflated.at(-1), reserveVault: {},
    }).proofs, false);

    const stripped = potBlock(GENESIS, miner, [{ nanos: potSubsidyNanos(0), kind: 'pot' }]);
    stripped.txs[0].vout[0] = { ...stripped.txs[0].vout[0], rangeProof: Buffer.alloc(0) };
    const unbound = auditCirculatingSupply([stripped]);
    assert.equal(unbound.status, 'mismatch');
    assert.equal(unbound.circulatingNanos, 0);
    assert.equal(unbound.schedulePotNanos, potSubsidyNanos(0));
    assert.notEqual(unbound.circulatingNanos, unbound.schedulePotNanos);

    const poolPage = fs.readFileSync(new URL('../../pool/public/explorer.html', import.meta.url), 'utf8');
    const apexPage = fs.readFileSync(new URL('../../explorer/explorer.html', import.meta.url), 'utf8');
    for (const page of [poolPage, apexPage]) {
      assert.match(page, /supplyStatus === 'verified' \? 'verified' : 'mismatch'/);
    }
  });

  it('credits the consensus hash bonus and rejects an oversized hash note', () => {
    const unit = bonusUnit();
    assert.ok(unit > 1);
    const subsidy = potSubsidyNanos(0);
    const shareCounts = [1, 4, 15];
    const deltas = [1, unit, unit * 3 + 1];
    for (const count of shareCounts) {
      const miners = Array.from({ length: Math.min(count, 3) }, () => minerDest());
      const groups = miners.map((dest, i) => ({
        dest,
        count: Math.floor(count / miners.length) + (i < (count % miners.length) ? 1 : 0),
      })).filter((g) => g.count > 0);
      const shareBatch = shareRows(groups);
      assert.equal(shareBatch.length, count);
      const potParts = splitSum(subsidy, groups.length);
      const notes = [];
      groups.forEach((g, i) => {
        notes.push({ address: g.dest, nanos: potParts[i], kind: 'pot' });
        notes.push({ address: g.dest, nanos: g.count * unit, kind: 'hash' });
      });
      const forward = potBlock(GENESIS, miners[0], notes, 0, { shareBatch });
      const reversed = potBlock(GENESIS, miners[0], notes.slice().reverse(), 0, { shareBatch });
      const paid = auditCirculatingSupply([forward]);
      const flipped = auditCirculatingSupply([reversed]);
      assert.equal(paid.status, 'verified', `shares ${count}`);
      assert.equal(paid.measuredHashNanos, count * unit);
      assert.equal(paid.measuredPotNanos, subsidy);
      assert.equal(paid.circulatingNanos, subsidy + count * unit);
      assert.equal(paid.schedulePotNanos, subsidy);
      assert.equal(paid.differenceNanos, 0);
      assert.notEqual(paid.circulatingNanos, paid.schedulePotNanos);
      assert.equal(flipped.status, paid.status);
      assert.equal(flipped.circulatingNanos, paid.circulatingNanos);
      assert.equal(flipped.measuredHashNanos, paid.measuredHashNanos);
      assert.equal(flipped.measuredPotNanos, paid.measuredPotNanos);

      for (const delta of deltas) {
        const inflatedNotes = notes.map((n) => ({ ...n }));
        const hashAt = inflatedNotes.findIndex((n) => n.kind === 'hash');
        inflatedNotes[hashAt] = { ...inflatedNotes[hashAt], nanos: inflatedNotes[hashAt].nanos + delta };
        const bad = auditCirculatingSupply([
          potBlock(GENESIS, miners[0], inflatedNotes, 0, { shareBatch }),
        ]);
        assert.equal(bad.status, 'mismatch', `shares ${count} delta ${delta}`);
        assert.equal(bad.measuredHashNanos, 0);
        assert.notEqual(bad.measuredHashNanos, count * unit + delta);
        assert.notEqual(bad.circulatingNanos, subsidy + count * unit + delta);
        assert.equal(bad.schedulePotNanos, subsidy);
        assert.notEqual(bad.differenceNanos, 0);
        assert.notEqual(bad.circulatingNanos, bad.schedulePotNanos + count * unit + delta);
      }
    }

    const miner = minerDest();
    const floor = potBlock(GENESIS, miner, [
      { nanos: subsidy, kind: 'pot' },
      { nanos: unit, kind: 'hash' },
    ]);
    const floored = auditCirculatingSupply([floor]);
    assert.equal(floored.status, 'verified');
    assert.equal(floored.measuredHashNanos, unit);
    assert.equal(floored.circulatingNanos, subsidy + unit);

    for (const delta of deltas) {
      const over = auditCirculatingSupply([potBlock(GENESIS, miner, [
        { nanos: subsidy, kind: 'pot' },
        { nanos: unit + delta, kind: 'hash' },
      ])]);
      assert.equal(over.status, 'mismatch', `finder floor + ${delta}`);
      assert.equal(over.measuredHashNanos, 0);
      assert.notEqual(over.circulatingNanos, subsidy + unit + delta);
    }

    const splitFloor = auditCirculatingSupply([potBlock(GENESIS, miner, [
      { nanos: subsidy, kind: 'pot' },
      { nanos: unit - 1, kind: 'hash' },
      { nanos: 1, kind: 'hash' },
    ])]);
    assert.equal(splitFloor.status, 'mismatch');
    assert.equal(splitFloor.measuredHashNanos, 0);

    const dup = shareRows([{ dest: miner, count: 2 }]);
    dup[1].nonce = dup[0].nonce;
    const duplicated = auditCirculatingSupply([potBlock(GENESIS, miner, [
      { nanos: subsidy, kind: 'pot' },
      { nanos: unit * 2, kind: 'hash' },
    ], 0, { shareBatch: dup })]);
    assert.equal(duplicated.status, 'mismatch');
    assert.equal(duplicated.measuredHashNanos, 0);

    const overCap = Array.from({ length: MAX_SHARES_PER_BLOCK + 1 }, (_, i) => ({
      dest: miner,
      nonce: BigInt(i + 1),
      lz: 8,
    }));
    const capped = auditCirculatingSupply([potBlock(
      GENESIS,
      miner,
      [{ nanos: subsidy, kind: 'pot' }],
      0,
      { shareBatch: overCap },
    )]);
    assert.equal(capped.status, 'mismatch');
    assert.equal(capped.measuredHashNanos, 0);
    assert.notEqual(capped.circulatingNanos, subsidy + overCap.length * unit);

    const bitSpread = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, SHARE_FLOOR_BITS + 4, SHARE_FLOOR_BITS + 8];
    for (const bits of bitSpread) {
      const hasher = minerDest();
      const work = unitsForShare(bits) * hashBonusUnitNanos(HASH_BONUS_NANOS);
      assert.equal(shareWorkBits({ shareBits: bits }), bits);
      const shareBatch = [{ dest: hasher, nonce: 1n, lz: bits, shareBits: bits }];
      const paidBits = auditCirculatingSupply([potBlock(GENESIS, hasher, [
        { nanos: subsidy, kind: 'pot' },
        { nanos: work, kind: 'hash' },
      ], 0, { shareBatch })]);
      assert.equal(paidBits.status, 'verified', `bits ${bits}`);
      assert.equal(paidBits.measuredHashNanos, work);
      assert.equal(paidBits.circulatingNanos, subsidy + work);
      if (bits === SHARE_FLOOR_BITS) continue;
      const short = auditCirculatingSupply([potBlock(GENESIS, hasher, [
        { nanos: subsidy, kind: 'pot' },
        { nanos: unit, kind: 'hash' },
      ], 0, { shareBatch })]);
      assert.equal(short.status, 'mismatch', `floor hash at bits ${bits}`);
      assert.equal(short.measuredHashNanos, 0);
      assert.notEqual(short.circulatingNanos, subsidy + work);
    }
  });

  it('holds empty-round streaks and pays them without minting the carry twice', () => {
    const subsidy = potSubsidyNanos(0);
    const fees = [0, 1, Math.floor(subsidy / 7), subsidy - 1];
    const streaks = [1, 3, 6];
    const miner = minerDest();
    const others = [minerDest(), minerDest(), minerDest()];
    for (const streak of streaks) {
      for (const fee of fees) {
        let carry = 0;
        const blocks = [];
        for (let i = 0; i < streak; i += 1) {
          const ts = GENESIS + i * 90_000;
          const carryOut = subsidy + carry - fee;
          const notes = fee === 0 ? [] : [{ nanos: fee, kind: 'pool-fee', address: miner }];
          blocks.push(potBlock(ts, miner, notes, carryOut));
          carry = carryOut;
        }
        const open = auditCirculatingSupply(blocks);
        assert.equal(open.status, 'verified', `open streak ${streak} fee ${fee}`);
        assert.equal(open.measuredHashNanos, 0);
        assert.equal(open.carryNanos, carry);
        assert.equal(open.circulatingNanos + open.carryNanos, open.schedulePotNanos);
        assert.equal(open.schedulePotNanos, streak * subsidy);
        assert.equal(open.circulatingNanos, streak * fee);
        assert.notEqual(open.circulatingNanos, open.schedulePotNanos);

        const payers = others.slice(0, 1 + (streak % others.length));
        const payable = subsidy + carry;
        const potParts = splitSum(payable, payers.length);
        const payoutNotes = payers.map((address, i) => ({
          address, nanos: potParts[i], kind: 'pot',
        }));
        const paidBlocks = blocks.concat([
          potBlock(GENESIS + streak * 90_000, payers[0], payoutNotes, 0),
        ]);
        const paid = auditCirculatingSupply(paidBlocks);
        const shuffled = auditCirculatingSupply(blocks.concat([
          potBlock(GENESIS + streak * 90_000, payers[0], payoutNotes.slice().reverse(), 0),
        ]));
        assert.equal(paid.status, 'verified', `paid streak ${streak} fee ${fee}`);
        assert.equal(paid.carryNanos, 0);
        assert.equal(paid.measuredHashNanos, 0);
        assert.equal(paid.schedulePotNanos, (streak + 1) * subsidy);
        assert.equal(paid.circulatingNanos, paid.schedulePotNanos);
        assert.equal(paid.measuredPotNanos, paid.schedulePotNanos);
        assert.equal(paid.differenceNanos, 0);
        assert.equal(shuffled.circulatingNanos, paid.circulatingNanos);
        assert.equal(shuffled.measuredPotNanos, paid.measuredPotNanos);
        assert.equal(shuffled.status, 'verified');

        const skim = auditCirculatingSupply(blocks.concat([
          potBlock(GENESIS + streak * 90_000, payers[0], [
            { nanos: payable + 1 + fee, kind: 'pot' },
          ], 0),
        ]));
        assert.equal(skim.status, 'mismatch', `skim streak ${streak} fee ${fee}`);
        assert.notEqual(skim.circulatingNanos, (streak + 1) * subsidy + 1 + fee);
        assert.equal(skim.schedulePotNanos, (streak + 1) * subsidy);
        assert.notEqual(skim.differenceNanos, 0);
      }
    }
  });
});

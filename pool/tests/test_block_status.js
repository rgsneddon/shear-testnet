import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BLOCK_SUBSIDY_NANOS, NANOS_PER_SHE, HASH_BONUS_NANOS, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { explorerRecentTxs, confirmedBlockTxs, networkSupply, hashBonusEmittedOfBlock } from '../src/wallet_api.js';
import { unitsForShare } from '../../crypto/share_batch.js';
import { encodeHeader } from '../../crypto/header.js';
import { emptyVault } from '../../crypto/reserve_vault.js';

function loadBlockStatus(rel) {
  const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const fn = src.match(/function blockStatus\(t, tip, need\) \{[\s\S]*?\n    \}/);
  assert.ok(fn, `blockStatus missing in ${rel}`);
  return new Function(`${fn[0]}; return blockStatus;`)();
}

describe('mined-block pending uses consensus 6, not pool_merchant 30', () => {
  for (const rel of ['../public/index.html', '../public/explorer.html']) {
    it(`${rel} confirms height 1 at tip 6; 30-conf band is not the mined gate`, () => {
      const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
      assert.match(src, /spendableConfirmations/);
      assert.doesNotMatch(src, /confirmedNeed/);
      assert.doesNotMatch(src, /pool_merchant/);
      const blockStatus = loadBlockStatus(rel);
      assert.equal(blockStatus({ height: 1 }, 6, 6), 'confirmed');
      assert.equal(blockStatus({ height: 1 }, 5, 6), 'pending');
      assert.equal(blockStatus({ height: 1 }, 1, 6), 'pending');
      assert.equal(blockStatus({ height: 1 }, 6, 30), 'pending');
      assert.equal(blockStatus({ height: 5 }, 10, 6), 'confirmed');
    });
  }

  it('dashboard and explorer paint mined status from tip vs 6, not API status', () => {
    for (const rel of ['../public/index.html', '../public/explorer.html']) {
      const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
      assert.match(src, /Number\(t\.height\) >= 1/);
      assert.match(src, /blockStatus\(t,/);
      assert.equal(src.includes('t.status || blockStatus'), false);
    }
  });

  it('wallet Continuum settle is already spendableConfirmations 6', () => {
    const src = fs.readFileSync(new URL('../../wallet/lib/shear_ledger.dart', import.meta.url), 'utf8');
    assert.match(src, /static const spendableConfirmations = 9/);
    assert.match(src, /confirmationsOf\(row\.height, tip\) >= spendableConfirmations/);
    assert.match(src, /confirmationsOf\(h, tip\) >= spendableConfirmations/);
  });

  it('explorerRecentTxs marks a tip-height coinbase pending until 9 confirms', () => {
    const dest = 'ssa1qfywwp7jll5p0ys54azypr7u9p2g0r45k59xxxr';
    function block(height, n) {
      return {
        height,
        hash: Buffer.alloc(32, height),
        miner: dest,
        header: Buffer.alloc(128),
        txs: [{
          coinbase: true,
          height,
          vout: [{ address: dest, nanos: BLOCK_SUBSIDY_NANOS, kind: 'pot' }],
        }],
      };
    }
    const blocks = [block(1, 1), block(2, 2), block(3, 3)];
    const store = {
      blocks,
      tip: () => blocks[blocks.length - 1],
    };
    const rows = explorerRecentTxs(store, 10);
    const byH = Object.fromEntries(rows.filter((t) => t.kind === 'block').map((t) => [t.height, t]));
    assert.equal(byH[3].pending, true);
    assert.equal(byH[3].status, 'pending');
    assert.equal(byH[3].confirmations, 1);
    assert.equal(byH[1].pending, true);
    assert.equal(byH[1].confirmations, 3);
    const need = SPENDABLE_CONFIRMATIONS;
    assert.ok(need > 1);
    const short = [];
    for (let h = 1; h <= need - 1; h += 1) short.push(block(h, h));
    const early = confirmedBlockTxs({ blocks: short, tip: () => short[short.length - 1] }, 10);
    const early1 = early.find((t) => t.height === 1);
    const earlyTip = early.find((t) => t.height === need - 1);
    assert.equal(early1.status, 'pending');
    assert.equal(early1.pending, true);
    assert.equal(early1.confirmations, need - 1);
    assert.equal(earlyTip.status, 'pending');
    assert.equal(earlyTip.confirmations, 1);
    const deep = short.concat([block(need, need)]);
    const later = confirmedBlockTxs({ blocks: deep, tip: () => deep[deep.length - 1] }, 10);
    const h1 = later.find((t) => t.height === 1);
    const tip = later.find((t) => t.height === need);
    assert.equal(h1.status, 'confirmed');
    assert.equal(h1.pending, false);
    assert.equal(h1.confirmations, need);
    assert.equal(tip.status, 'pending');
    assert.equal(tip.pending, true);
    assert.equal(tip.confirmations, 1);
  });

  it('explorer recent Infinity returns every sealed block', () => {
    function block(height) {
      return {
        height,
        hash: Buffer.alloc(32, height),
        header: Buffer.alloc(128),
        txs: [{ coinbase: true, height, vout: [{ kind: 'pot', nanos: 1 }] }],
      };
    }
    const blocks = [];
    for (let h = 1; h <= 40; h += 1) blocks.push(block(h));
    const store = { blocks, tip: () => blocks[blocks.length - 1], mempool: [] };
    const all = explorerRecentTxs(store, Infinity).filter((t) => t.kind === 'block');
    assert.equal(all.length, 40);
    assert.equal(all[0].height, 40);
    assert.equal(all[39].height, 1);
    for (let i = 1; i < all.length; i += 1) {
      assert.ok(all[i - 1].height > all[i].height, 'newest height first');
    }
    const capped = explorerRecentTxs(store, 30).filter((t) => t.kind === 'block');
    assert.equal(capped.length, 30);
  });

  it('networkSupply does not echo the pot schedule when coinbase commitments do not open', () => {
    const hdr = (ms) => encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: BigInt(ms),
      bits: 16,
    });
    const blocks = [];
    for (let h = 1; h <= 3; h += 1) {
      blocks.push({
        height: h,
        header: hdr(1_700_000_000_000 + h * 90_000),
        txs: [{ coinbase: true, vout: [{ kind: 'pot', noteCommit: Buffer.alloc(32), nanos: 0 }] }],
      });
    }
    const store = { blocks, tip: () => blocks[2], reserveVault: emptyVault() };
    const supply = networkSupply(store);
    assert.equal(supply.supplyStatus, 'mismatch');
    assert.equal(supply.potNanos, 0);
    assert.notEqual(supply.circulatingNanos, 3 * NANOS_PER_SHE);
    assert.equal(supply.schedulePotNanos, 3 * NANOS_PER_SHE);
    assert.notEqual(supply.differenceNanos, 0);
    assert.equal(supply.hashNanos, 0);
    assert.equal(supply.vaultNanos, 0);
  });

  it('networkSupply does not treat a Tree-A count or a zero hash vout as minted bonus', () => {
    const hdr = (ms) => encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: BigInt(ms),
      bits: 16,
    });
    const units = 768;
    const blocks = [{
      height: 1,
      header: hdr(1_700_000_000_000),
      aLeaves: [{ noteCommit: Buffer.alloc(32, 1), count: units }],
      shareBatch: [],
      txs: [{ coinbase: true, vout: [{ kind: 'pot', nanos: 0 }, { kind: 'hash', nanos: 0 }] }],
    }, {
      height: 2,
      header: hdr(1_700_000_090_000),
      aLeaves: [],
      shareBatch: [
        { noteCommit: Buffer.alloc(32, 2).toString('hex'), nonce: '1', lz: 8 },
        { noteCommit: Buffer.alloc(32, 3).toString('hex'), nonce: '2', lz: 8 },
      ],
      txs: [{ coinbase: true, vout: [{ kind: 'pot', nanos: 0 }] }],
    }];
    const store = { blocks, tip: () => blocks[1], reserveVault: emptyVault() };
    const fromLeaves = hashBonusEmittedOfBlock(blocks[0], HASH_BONUS_NANOS);
    assert.equal(fromLeaves, 0);
    const fromShares = hashBonusEmittedOfBlock(blocks[1], HASH_BONUS_NANOS);
    assert.equal(fromShares, 0);
    const minted = hashBonusEmittedOfBlock({
      height: 3,
      aLeaves: [{ noteCommit: Buffer.alloc(32, 1), count: units }],
      shareBatch: blocks[1].shareBatch,
      txs: [{ coinbase: true, vout: [{ kind: 'hash', nanos: units, valueProof: { v: 17 } }] }],
    }, HASH_BONUS_NANOS);
    assert.equal(minted, 17);
    const supply = networkSupply(store);
    assert.equal(supply.supplyStatus, 'mismatch');
    assert.equal(supply.potNanos, 0);
    assert.equal(supply.hashNanos, 0);
    assert.equal(supply.hashOwedNanos, 0);
    assert.notEqual(supply.hashNanos, units * HASH_BONUS_NANOS);
    assert.equal(supply.schedulePotNanos, 2 * NANOS_PER_SHE);
    assert.notEqual(supply.circulatingNanos, supply.schedulePotNanos + units * HASH_BONUS_NANOS);
  });

  it('empty-aLeaves + empty-shareBatch + one confidential-0 hash vout returns 256', () => {
    const block = {
      height: 8,
      aLeaves: [],
      shareBatch: [],
      txs: [{
        coinbase: true,
        vout: [
          { kind: 'pot', nanos: 0 },
          { kind: 'hash', nanos: 0, commit: Buffer.alloc(32, 9), noteCommit: Buffer.alloc(32, 3) },
        ],
      }],
    };
    const got = hashBonusEmittedOfBlock(block, HASH_BONUS_NANOS);
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.equal(unitsForShare(), 256);
    assert.equal(got, 256);
    assert.equal(got, unitsForShare() * HASH_BONUS_NANOS);
  });

  it('networkSupply ignores painted pot nanos, vault mint bank, pull credit, and open-round counts', () => {
    const hdr = (ms) => encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: BigInt(ms),
      bits: 16,
    });
    const pot = 1_000_000_000_00;
    const extra = 777;
    const burned = 40;
    const pullCredit = 1_000_000_000;
    const openRound = 4096;
    const staked = 50_000;
    const block = {
      height: 9,
      header: hdr(1_700_000_000_000),
      aLeaves: [],
      shareBatch: [],
      txs: [{
        coinbase: true,
        vout: [
          { kind: 'pot', nanos: pot },
          { kind: 'hash', nanos: 0, commit: Buffer.alloc(32, 4), noteCommit: Buffer.alloc(32, 5) },
        ],
      }],
    };
    const vault = emptyVault();
    vault.mintBankNanos = BigInt(extra);
    vault.totalLockedNanos = BigInt(staked);
    vault.portals.stake = { staked: BigInt(staked), idle: 0n, claimableRewards: 0n };
    const store = {
      blocks: [block],
      tip: () => block,
      reserveVault: vault,
      pullBook: { hashCreditsNanos: pullCredit },
      openRoundHashes: openRound,
      networkRoundHashes: openRound,
      explorer: [
        { kind: 'burn', nanos: burned },
        { kind: 'hash', nanos: pullCredit },
      ],
    };
    const supply = networkSupply(store);
    assert.equal(supply.supplyStatus, 'mismatch');
    assert.equal(supply.potNanos, 0);
    assert.equal(supply.hashNanos, 0);
    assert.equal(supply.extraMintNanos, 0);
    assert.equal(supply.burnedNanos, 0);
    assert.notEqual(supply.circulatingNanos, pot);
    assert.notEqual(supply.circulatingNanos, pot + 256 + extra - burned);
    assert.equal(supply.lockedNanos, staked);
    assert.notEqual(supply.circulatingNanos, pullCredit);
    assert.notEqual(supply.circulatingNanos, openRound);
    assert.notEqual(supply.circulatingNanos, staked);
  });
});

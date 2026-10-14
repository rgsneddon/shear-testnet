/**
 * HASH_OWED_RECOVER_V1. Prune may drop shareBatch. It must not drop the
 * per-block credit record the owed map is replayed from. Template, boot,
 * and reorg use the maintained map. Accepted-unit stamps are checked.
 * The hash-bonus unit is the one that was live at that height.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  GENESIS_BITS_PACKED,
  HASH_BONUS_NANOS,
  HASH_OWED_MAX_ENTRIES,
  MAX_SHARES_PER_BLOCK,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  SAMPLE_PRUNE_CONFIRMATIONS,
  SHARE_FLOOR_BITS,
  hashOwedDustNanos,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { compactTx, pruneSamples, shouldPruneSamples } from '../../crypto/chronoflux.js';
import {
  clearLiveSharePow,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
} from '../../crypto/share_batch.js';
import {
  creditsEqual,
  freshForBlock,
  hashOwedFromTx,
  hashOwedRoot,
  replayHashOwed,
} from '../../crypto/hash_owed.js';
import {
  VOTE_DECREASE,
  VOTE_INCREASE,
  bonusUnitsBefore,
  lockTx,
  voteTx,
} from '../../crypto/reserve_vault.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { GENESIS_PREV, buildTemplate, digestTx, shouldAdopt, verifyBlock } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { auditCirculatingSupply } from '../src/supply.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function withMerkle(header, txs) {
  const next = Buffer.from(header);
  merkleRoot(txs.map(digestTx)).copy(next, 36);
  return next;
}

function shareAt(dest, low, bits) {
  return {
    dest,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
  };
}

function destAt(n) {
  const raw = Buffer.alloc(20);
  raw.writeUInt32BE(n >>> 0, 16);
  return encodeDest(raw);
}

function pinShares(header, rows) {
  for (const row of rows) {
    assert.equal(rememberLiveSharePow(header, row.nonce, {
      noteCommit: noteCommitOfShare(row),
      shareBits: row.shareBits,
      lz: row.lz,
    }), true, 'share pin');
  }
}

function appendTpl(store, dest, tag, when, shares) {
  const tip = store.tip();
  if (shares?.length && tip?.header) pinShares(tip.header, shares);
  const { tpl } = store.template({
    miner: dest,
    now: when,
    shareBatch: shares || [],
  });
  return store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hashCredits: tpl.hashCredits,
  }, { trustedPowHash: easyPow(tag), skipSharePow: true });
}

describe('HASH_OWED_RECOVER_V1', () => {
  it('prune keeps credits, and template, restart, and reorg stay live', () => {
    clearLiveSharePow();
    const dest = minerDest();
    const other = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-owed-recover-'));
    const store = createStore(dir, { pruneAfter: 1 });
    const t0 = 1_700_000_000_000;
    const g = appendTpl(store, dest, 11, t0, []);
    assert.equal(g.ok, true, g.reason);
    const bits = shareCreditMaxBits();
    const wide = [0, 1].map((i) => shareAt(i === 0 ? dest : other, 40n + BigInt(i), bits));
    const credited = appendTpl(store, dest, 12, t0 + 90_000, wide);
    assert.equal(credited.ok, true, credited.reason);
    const owedBefore = replayHashOwed(store.blocks.map((b) => ({
      ...b,
      shareBatch: (b.shareBatch || []).slice(),
      hashCredits: b.hashCredits,
    })));
    assert.equal(owedBefore.ok, true, owedBefore.reason);
    assert.ok(owedBefore.rows.length > 0);
    const creditSnap = {
      ...store.blocks[1],
      shareBatch: (store.blocks[1].shareBatch || []).slice(),
      hashCredits: store.blocks[1].hashCredits,
    };
    const next = appendTpl(store, dest, 13, t0 + 180_000, []);
    assert.equal(next.ok, true, next.reason);
    const buried = store.blocks.find((b) => Number(b.height) === 2);
    // pruneAfter cannot open burial before SAMPLE_PRUNE_CONFIRMATIONS.
    assert.notEqual(buried.samplesPruned, true);
    assert.ok((buried.shareBatch || []).length > 0);
    assert.ok((buried.hashCredits || []).length > 0);
    const replayed = replayHashOwed(store.blocks);
    const fromShares = replayHashOwed([store.blocks[0], creditSnap, store.blocks[2]]);
    assert.equal(replayed.ok, true, replayed.reason);
    assert.equal(fromShares.ok, true, fromShares.reason);
    assert.equal(hashOwedRoot(replayed.rows).equals(hashOwedRoot(fromShares.rows)), true);
    const job = store.template({ miner: dest, now: t0 + 270_000 });
    const packedJob = compactTx(job.tpl.txs[0]);
    assert.ok(packedJob.hashOwedRoot);
    assert.equal(packedJob.hashOwedLocal, undefined);
    assert.equal(packedJob.hashCredits, undefined);
    const again = createStore(dir, { pruneAfter: 1 });
    assert.equal(again.blocks.length, store.blocks.length);
    const reloaded = again.blocks.find((b) => Number(b.height) === 2);
    assert.equal(reloaded.samplesPruned, false);
    assert.ok((reloaded.shareBatch || []).length > 0);
    assert.ok((reloaded.hashCredits || []).length > 0);
    const job2 = again.template({ miner: dest, now: t0 + 270_000 });
    assert.ok(job2.tpl);
    const fastDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-owed-fast-'));
    const fast = createStore(fastDir, { pruneAfter: 1, fastSync: true });
    const fg = appendTpl(fast, dest, 21, t0, []);
    assert.equal(fg.ok, true, fg.reason);
    const fc = appendTpl(fast, dest, 22, t0 + 90_000, wide.map((s, i) => shareAt(s.dest, 80n + BigInt(i), bits)));
    assert.equal(fc.ok, true, fc.reason);
    assert.ok((fast.blocks[1].shareBatch || []).length > 0);
    const bounced = createStore(fastDir, { pruneAfter: 1, fastSync: true });
    assert.equal(bounced.blocks.length, 2);
    assert.equal(bounced.blocks[1].samplesPruned, false);
    assert.ok((bounced.blocks[1].shareBatch || []).length > 0);
    assert.ok(Array.isArray(bounced.blocks[1].hashCredits));
    assert.ok(bounced.template({ miner: dest, now: t0 + 180_000 }).tpl);
    const buriedSupply = auditCirculatingSupply(store.blocks);
    assert.equal(buriedSupply.status, 'verified', buriedSupply.reason);
    const fork = [];
    let prev = store.blocks[0];
    let now = t0 + 90_000;
    let owedIn = [];
    let acceptedIn = [];
    for (let i = 0; i < store.blocks.length; i += 1) {
      const prefix = store.blocks.slice(0, 1).concat(fork);
      const tpl = buildTemplate({
        prev: prev.hash,
        prevHeader: prev.header,
        prevBlock: prev,
        height: Number(prev.height) + 1,
        miner: dest,
        now,
        bits: GENESIS_BITS_PACKED,
        parentBlocks: prefix,
        hashOwedIn: owedIn,
        hashAcceptedSeries: acceptedIn,
      });
      owedIn = hashOwedFromTx(tpl.txs[0]) || [];
      acceptedIn = acceptedIn.concat([BigInt(tpl.txs[0].hashAcceptedUnits || 0)]);
      const pow = easyPow(300 + i);
      const block = {
        header: tpl.header,
        txs: tpl.txs,
        shareBatch: tpl.shareBatch || [],
        hashCredits: tpl.hashCredits,
        miner: dest,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
        hash: pow,
        height: Number(prev.height) + 1,
        weight: tpl.weight,
        bSpendIds: [],
      };
      fork.push(block);
      prev = block;
      now += 90_000;
    }
    const candidate = store.blocks.slice(0, 1).concat(fork);
    assert.equal(shouldAdopt(store.blocks, candidate), true);
    const adopted = store.ingest(fork, { trustBlockHash: true, skipSharePow: true });
    assert.equal(adopted.ok, true, adopted.reason);
    assert.equal(store.tip().height, candidate.length);
    const supply = auditCirculatingSupply(store.blocks);
    assert.equal(supply.status, 'verified', supply.reason);
  });

  it('crosses the real prune depth for an empty prefix and a sub-dust row', () => {
    const dest = minerDest();
    const dust = hashOwedDustNanos();
    const pair = [
      shareAt(destAt(1), 10n, shareCreditMaxBits()),
      shareAt(destAt(2), 11n, SHARE_FLOOR_BITS + 1),
    ];
    const tip = SAMPLE_PRUNE_CONFIRMATIONS * 2;
    const chain = [];
    const genesisOnly = [];
    let prevHash = GENESIS_PREV;
    let prevHeader = null;
    let owedIn = [];
    let accepted = [];
    let now = 1_700_000_000_000;
    for (let h = 1; h <= tip; h += 1) {
      const tpl = buildTemplate({
        prev: prevHash,
        prevHeader,
        prevBlock: chain[chain.length - 1] || null,
        height: h,
        miner: dest,
        now,
        bits: GENESIS_BITS_PACKED,
        shareBatch: h === 2 ? pair : [],
        hashOwedIn: owedIn,
        hashAcceptedSeries: accepted,
        parentBlocks: genesisOnly,
        parentFluxset: [],
      });
      const block = {
        header: tpl.header,
        txs: tpl.txs,
        shareBatch: tpl.shareBatch || [],
        hashCredits: tpl.hashCredits,
        miner: dest,
        height: h,
        hash: easyPow(1000 + h),
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
      };
      if (h === 1) genesisOnly.push(block);
      chain.push(block);
      prevHash = block.hash;
      prevHeader = tpl.header;
      owedIn = hashOwedFromTx(tpl.txs[0]) || [];
      accepted = accepted.concat([BigInt(tpl.txs[0].hashAcceptedUnits || 0)]);
      now += 90_000;
    }
    const subDust = chain.length >= 2 ? hashOwedFromTx(chain[1].txs[0]) || [] : [];
    assert.ok(subDust.some((row) => row.nanos > 0n && row.nanos < dust));
    const margins = [0, 1, 2, SAMPLE_PRUNE_CONFIRMATIONS];
    for (const extra of margins) {
      const at = SAMPLE_PRUNE_CONFIRMATIONS + extra;
      const kept = chain.slice(0, at);
      const pruned = kept.map((b) => (
        shouldPruneSamples(b.height, at, SAMPLE_PRUNE_CONFIRMATIONS) ? pruneSamples(b) : b
      ));
      const buried = shouldPruneSamples(2, at, SAMPLE_PRUNE_CONFIRMATIONS);
      assert.equal((pruned[1].shareBatch || []).length === 0, buried);
      if (buried) assert.ok((pruned[1].hashCredits || []).length > 0);
      const fromCredits = replayHashOwed(pruned);
      const fromShares = replayHashOwed(kept);
      assert.equal(fromCredits.ok, true, fromCredits.reason);
      assert.equal(fromShares.ok, true, fromShares.reason);
      assert.equal(hashOwedRoot(fromCredits.rows).equals(hashOwedRoot(fromShares.rows)), true);
      const prefix = pruned.filter((b) => Number(b.height) < 2);
      const early = replayHashOwed(prefix);
      assert.equal(early.ok, true, early.reason);
      assert.equal(early.rows.length, 0);
    }
  });

  it('keeps owed maps from one row through the share cap', () => {
    const dest = minerDest();
    const maxB = shareCreditMaxBits();
    const floor = SHARE_FLOOR_BITS;
    const cap = MAX_SHARES_PER_BLOCK;
    // One max-width share is paid in full. Floor-width shares beside it stay
    // whole once their pro-rata falls under the dust floor, which is the
    // share-cap backlog. A second block would pay that backlog; this case
    // checks the map that block sealed.
    const cases = [
      {
        want: 1,
        shares: [shareAt(destAt(1), 1n, floor), shareAt(destAt(2), 2n, maxB)],
      },
      {
        want: 3,
        shares: [0, 1, 2].map((i) => shareAt(destAt(10 + i), BigInt(10 + i), maxB)),
      },
      {
        want: cap - 1,
        shares: [shareAt(destAt(1), 1n, maxB)].concat(
          Array.from({ length: cap - 2 }, (_, i) => shareAt(destAt(i + 2), BigInt(i + 2), floor)),
        ),
      },
      {
        want: cap,
        shares: [shareAt(destAt(1), 1n, maxB)].concat(
          Array.from({ length: cap - 1 }, (_, i) => shareAt(destAt(i + 2), BigInt(i + 2), floor)),
        ),
      },
    ];
    for (const item of cases) {
      assert.ok(item.shares.length <= cap);
      const tpl = buildTemplate({
        prev: GENESIS_PREV,
        height: 1,
        miner: dest,
        now: 1_700_000_000_000,
        bits: GENESIS_BITS_PACKED,
        shareBatch: item.shares,
        potShares: [{ address: dest, nanos: 1, kind: 'pot' }],
        hashOwedIn: [],
        hashAcceptedSeries: [],
        parentBlocks: [],
        parentFluxset: [],
      });
      const block = {
        header: tpl.header,
        txs: tpl.txs,
        shareBatch: tpl.shareBatch || [],
        hashCredits: tpl.hashCredits,
        miner: dest,
        height: 1,
        hash: easyPow(5000 + item.want),
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
      };
      const owed = hashOwedFromTx(tpl.txs[0]) || [];
      assert.equal(owed.length, item.want);
      const pruned = pruneSamples(block);
      assert.equal((pruned.shareBatch || []).length, 0);
      assert.equal((pruned.hashCredits || []).length > 0, item.want > 0);
      assert.equal(replayHashOwed([pruned]).ok, false);
      const fromShares = replayHashOwed([block]);
      assert.equal(fromShares.ok, true, fromShares.reason);
      assert.equal(fromShares.rows.length, item.want);
      const buriedFresh = freshForBlock(pruned, HASH_BONUS_NANOS, Number(pruned.height) + SAMPLE_PRUNE_CONFIRMATIONS);
      const liveFresh = freshForBlock(block, HASH_BONUS_NANOS, Number(block.height));
      assert.equal(buriedFresh.ok, true, buriedFresh.reason);
      assert.equal(liveFresh.ok, true, liveFresh.reason);
      assert.equal(creditsEqual(buriedFresh.fresh, block.hashCredits), true);
      assert.equal(creditsEqual(buriedFresh.fresh, liveFresh.fresh), true);
    }
    assert.equal(HASH_OWED_MAX_ENTRIES, cap);
  });

  it('uses the per-height unit, including a later decrease', () => {
    const who = minerDest();
    const other = minerDest();
    const t0 = 1_700_000_000_000;
    const epoch = RESERVE_EPOCH_MS;
    const times = [t0, t0 + epoch, t0 + epoch + 90_000, t0 + epoch + 90_000 + epoch, t0 + (2 * epoch) + 180_000];
    // A second portal has to join after the increase is enacted. Another
    // lock from the same portal does not open the next epoch.
    const extras = [
      [
        lockTx({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'lock-pi' }),
        voteTx({ from: who, dest: who, choice: VOTE_INCREASE, id: 'vote-up' }),
      ],
      [],
      [
        lockTx({ from: other, to: other, nanos: PI_SHE_NANOS, id: 'lock-roll' }),
        voteTx({ from: other, dest: other, choice: VOTE_DECREASE, id: 'vote-down' }),
      ],
      [],
      [],
    ];
    const expectUnits = [1, 1, 2, 2, 1];
    const chain = [];
    let prevHash = GENESIS_PREV;
    let prevHeader = null;
    let owedIn = [];
    let accepted = [];
    for (let i = 0; i < times.length; i += 1) {
      const tpl = buildTemplate({
        prev: prevHash,
        prevHeader,
        prevBlock: chain[chain.length - 1] || null,
        height: i + 1,
        miner: who,
        now: times[i],
        bits: GENESIS_BITS_PACKED,
        shareBatch: i === 2 ? [shareAt(destAt(9), 90n, SHARE_FLOOR_BITS)] : [],
        txs: extras[i],
        hashOwedIn: owedIn,
        hashAcceptedSeries: accepted,
        parentBlocks: chain.slice(0, 1),
        parentFluxset: [],
        hashBonusNanos: expectUnits[i],
      });
      chain.push({
        header: tpl.header,
        txs: tpl.txs,
        shareBatch: tpl.shareBatch || [],
        hashCredits: tpl.hashCredits,
        height: i + 1,
        hash: easyPow(7000 + i),
      });
      prevHash = chain[chain.length - 1].hash;
      prevHeader = tpl.header;
      owedIn = hashOwedFromTx(tpl.txs[0]) || [];
      accepted = accepted.concat([BigInt(tpl.txs[0].hashAcceptedUnits || 0)]);
    }
    const units = bonusUnitsBefore(chain);
    assert.deepEqual(units, [1, 1, 2, 2, 1]);
    const stamped = chain.map((b) => Number(b.txs[0].hashBonusUnit));
    assert.deepEqual(stamped, units);
    const withSeries = replayHashOwed(chain, { units });
    assert.equal(withSeries.ok, true, withSeries.reason);
    const tipOnly = replayHashOwed(chain, { unit: units[units.length - 1] });
    assert.equal(tipOnly.ok, false);
    const constantHigh = replayHashOwed(chain, { unit: 2 });
    assert.equal(constantHigh.ok, false);
  });

  it('rejects a forged accepted-unit stamp and keeps template time flat', () => {
    clearLiveSharePow();
    const dest = minerDest();
    const now = 1_700_000_000_000;
    const genesis = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now,
    });
    const block = {
      header: genesis.header,
      txs: genesis.txs.map((tx) => ({ ...tx })),
      shareBatch: [],
      hashCredits: genesis.hashCredits || [],
      miner: dest,
      height: 1,
      aLeaves: genesis.aLeaves,
      bLeaves: genesis.bLeaves,
    };
    const honest = verifyBlock(block, null, {
      trustedPowHash: easyPow(7),
      nowMs: now + 1000,
    });
    assert.equal(honest.ok, true, honest.reason);
    const forgedTxs = block.txs.map((tx, i) => (i === 0 ? { ...tx, hashAcceptedUnits: '999999' } : tx));
    const forged = {
      ...block,
      header: withMerkle(block.header, forgedTxs),
      txs: forgedTxs,
    };
    const lied = verifyBlock(forged, null, {
      trustedPowHash: easyPow(7),
      nowMs: now + 1000,
    });
    assert.equal(lied.ok, false);
    assert.equal(lied.reason, 'hash_owed');
    const missingTxs = block.txs.map((tx, i) => {
      if (i !== 0) return tx;
      const copy = { ...tx };
      delete copy.hashAcceptedUnits;
      return copy;
    });
    const missing = {
      ...block,
      header: withMerkle(block.header, missingTxs),
      txs: missingTxs,
    };
    const bare = verifyBlock(missing, null, {
      trustedPowHash: easyPow(7),
      nowMs: now + 1000,
    });
    assert.equal(bare.ok, false);
    assert.equal(bare.reason, 'hash_owed');
    const rows = hashOwedFromTx(block.txs[0]) || [];
    const poison = Array.from({ length: 4000 }, () => ({ shareBatch: [], txs: [{}] }));
    const tSmall = Date.now();
    const small = buildTemplate({
      prev: honest.hash,
      prevHeader: genesis.header,
      prevBlock: block,
      height: 2,
      miner: dest,
      now: now + 90_000,
      bits: GENESIS_BITS_PACKED,
      hashOwedIn: rows,
      hashAcceptedSeries: [0n],
      parentBlocks: poison.slice(0, 1),
    });
    const smallMs = Date.now() - tSmall;
    const tBig = Date.now();
    const big = buildTemplate({
      prev: honest.hash,
      prevHeader: genesis.header,
      prevBlock: block,
      height: 2,
      miner: dest,
      now: now + 90_000,
      bits: GENESIS_BITS_PACKED,
      hashOwedIn: rows,
      hashAcceptedSeries: [0n],
      parentBlocks: poison,
    });
    const bigMs = Date.now() - tBig;
    assert.equal(small.txs[0].height, 2);
    assert.equal(big.txs[0].height, 2);
    assert.ok(bigMs < smallMs * 8 + 250, `template grew with chain length ${smallMs}ms vs ${bigMs}ms`);
    void HASH_BONUS_NANOS;
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fluxsetFromBlocks } from '../../crypto/admit.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  GENESIS_BITS_PACKED,
  HASH_BONUS_NANOS,
  POOL_FEE_BPS,
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  asertNextBits,
  hashOwedDustNanos,
  potSubsidyNanos,
} from '../../crypto/asert.js';
import { packEpochBlock, unpackEpochBlock } from '../../crypto/chainbin.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import {
  clearLiveSharePow,
  nonceWithShareTarget,
  noteCommitOfShare,
  partitionSpillRows,
  rememberLiveSharePow,
  shareWorkKey,
  unitsForShare,
} from '../../crypto/share_batch.js';
import {
  freshCreditsFromShares,
  hashOwedFromTx,
  hashOwedRoot,
  replayHashOwed,
  settleHashOwed,
  spillForBlock,
} from '../../crypto/hash_owed.js';
import {
  GENESIS_PREV,
  buildTemplate,
  potSharesFromBatch,
  verifyBlock,
} from '../src/chain.js';
import { createStore } from '../src/store.js';
import { encodeWireBlock, decodeWireBlock } from '../src/p2p.js';
import { createPool } from '../../pool/src/pool.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const WIDTHS = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, SHARE_FLOOR_BITS + 4];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(rows, rng) {
  const out = rows.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function destsOf(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(minerDest());
  return out;
}

function shareOf(dest, header, low, bits) {
  const nonce = nonceWithShareTarget(BigInt(low), bits);
  const share = {
    dest,
    nonce,
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    verifiedHeader: header,
    hash: '11',
  };
  share.noteCommit = Buffer.from(noteCommitOfShare(share));
  return share;
}

function pinShare(share) {
  const ok = rememberLiveSharePow(share.verifiedHeader, share.nonce, {
    noteCommit: share.noteCommit,
    shareBits: share.shareBits,
    lz: share.lz,
  });
  assert.equal(ok, true);
  return share;
}

function workKey(share) {
  return shareWorkKey(share.verifiedHeader, share.nonce);
}

// An exact slot does not carry the header. Slot 1 is the prior header.
function packedWorkKey(share, parentHeader, priorHeader) {
  if (share?.verifiedHeader) return workKey(share);
  const slot = share?.proofSlot === 1 || share?.proofSlot === '1' ? 1 : 0;
  const hdr = slot === 1 ? priorHeader : parentHeader;
  return shareWorkKey(hdr, share?.nonce);
}

function unitSum(shares) {
  let n = 0n;
  for (const s of shares || []) n += BigInt(unitsForShare(s.shareBits));
  return n;
}

function nanosOf(rows) {
  return (rows || []).reduce((n, row) => n + BigInt(row.nanos), 0n);
}

function hashMinted(block) {
  return (block?.txs?.[0]?.vout || [])
    .filter((o) => o.kind === 'hash')
    .reduce((n, o) => n + BigInt(o.valueProof.v), 0n);
}

function destRow(i, nanos, sinceHeight) {
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

let powTag = 8000;
function nextPow() {
  powTag += 1;
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag, 4);
  return h.toString('hex');
}

function poolAt(tag, shareCap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-spill-${tag}-`));
  const pool = createPool({
    dataDir: dir,
    stratumPort: 0,
    httpPort: 0,
    miner: FEE,
    shareCap,
  });
  return { pool, dir };
}

async function sealJob(pool, job) {
  const got = await pool.sealFoundShare({
    jobId: job.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: nextPow(),
  });
  assert.equal(got.ok, true, got.reason || 'seal');
  return got;
}

function owedUnits(pool) {
  let n = 0n;
  for (const row of pool.windowOwedRows()) n += BigInt(row.units);
  return n;
}

describe('v12 hash spill witness', () => {
  it('keeps one witness batch and leaves the rest unpaid', () => {
    const caps = [1, 4, 8];
    const factors = [
      (cap) => cap + 1,
      (cap) => cap * 2,
      (cap) => cap * 4,
    ];
    const destCounts = [1, 3, 17];
    let seed = 17;
    for (const cap of caps) {
      for (const destN of destCounts) {
        for (const factor of factors) {
          const n = factor(cap);
          const dests = destsOf(destN);
          const header = Buffer.alloc(128, (seed % 200) + 1);
          const rows = [];
          for (let i = 0; i < n; i += 1) {
            const bits = WIDTHS[i % WIDTHS.length];
            rows.push(shareOf(dests[i % dests.length], header, seed * 1000 + i + 1, bits));
          }
          const rng = mulberry32(seed);
          seed += 1;
          const a = partitionSpillRows(shuffle(rows, rng), { cap });
          const b = partitionSpillRows(shuffle(rows, rng), { cap });
          assert.equal(a.witness.length, Math.min(cap, n));
          assert.equal(a.rest.length, n - a.witness.length);
          assert.equal(unitSum(a.witness) + unitSum(a.rest), unitSum(rows));
          const keysA = new Set(a.witness.map(workKey));
          const keysB = new Set(b.witness.map(workKey));
          assert.equal(keysA.size, a.witness.length);
          for (const key of keysA) assert.equal(keysB.has(key), true);
          const pending = Math.min(cap, 1);
          const crowded = partitionSpillRows(rows, { pending, cap });
          assert.equal(crowded.witness.length, Math.max(0, Math.min(n, cap - pending)));
          assert.equal(crowded.witness.length + crowded.rest.length, n);
        }
      }
    }
    const header = Buffer.alloc(128, 9);
    const dest = minerDest();
    const rows = [];
    for (let i = 0; i < 5; i += 1) rows.push(shareOf(dest, header, i + 1, SHARE_FLOOR_BITS));
    const full = partitionSpillRows(rows, { pending: 4, cap: 4 });
    assert.equal(full.witness.length, 0);
    assert.equal(full.rest.length, rows.length);
  });

  it('pays a sealed spill once and does not let a 1-nano row jump a floor parent', () => {
    const floor = hashOwedDustNanos();
    const parent = destRow(0, floor, 1);
    const dust = destRow(1, 1n, 2);
    const first = settleHashOwed({
      owedIn: [parent],
      fresh: [],
      spill: [dust],
      height: 3,
      budget: floor * 4n,
    });
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.minted, floor);
    assert.equal(nanosOf(first.pay), floor);
    const carried = [...first.owed, ...first.owedRest];
    assert.equal(nanosOf(carried), 1n);
    assert.equal(first.minted + nanosOf(carried), floor + 1n);
    const nextParent = destRow(2, floor, 3);
    const second = settleHashOwed({
      owedIn: [...carried, nextParent],
      fresh: [],
      height: 4,
      budget: floor,
    });
    assert.equal(second.ok, true, second.reason);
    assert.equal(second.minted, floor);
    assert.equal(nanosOf(second.pay), floor);
    assert.equal(second.pay[0].nanos, floor);
    assert.equal(nanosOf([...second.owed, ...second.owedRest]), 1n);
    const blob = { units: '1', rows: [{ noteCommit: dust.noteCommit.toString('hex'), units: '1' }] };
    const fromBlob = spillForBlock({ hashSpill: [], windowOwed: blob });
    assert.equal(fromBlob.ok, true);
    assert.equal(fromBlob.fresh.length, 0);
  });

  it('seals expiring overflow as hashSpill across dest, load, and replay', () => {
    const feeTo = FEE;
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
      hashSpill: [],
      poolDest: feeTo,
      aLeaves: genesis.aLeaves,
      bLeaves: genesis.bLeaves,
      rootA: genesis.rootA,
      rootB: genesis.rootB,
      weight: genesis.weight,
      height: 1,
    };
    const sealedG = verifyBlock(genesisBlock, null, {
      trustedPowHash: Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
      nowMs: now + 1_000,
      genesisMs: now,
    });
    assert.equal(sealedG.ok, true, sealedG.reason);
    genesisBlock.hash = sealedG.hash;

    function sealChild(shareBatch, hashSpill, prevBlock, prevHash, prevHeader, height, when, potShares, parents, grandparent) {
      clearLiveSharePow();
      for (const row of shareBatch || []) {
        assert.equal(rememberLiveSharePow(row.verifiedHeader || prevHeader, row.nonce, {
          noteCommit: noteCommitOfShare(row),
          shareBits: row.shareBits,
          lz: row.lz,
        }), true);
      }
      for (const row of hashSpill || []) {
        assert.equal(rememberLiveSharePow(row.verifiedHeader, row.nonce, {
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
      const parentFlux = fluxsetFromBlocks(Array.isArray(parents) ? parents : []);
      const tpl = buildTemplate({
        prev: prevHash,
        prevHeader,
        prevBlock,
        height,
        miner: feeTo,
        bits: q.packed,
        now: when,
        potShares,
        shareBatch,
        hashSpill,
        poolDest: feeTo,
        parentBlocks: parents,
        parentFluxset: parentFlux,
      });
      const plain = settleHashOwed({
        fresh: freshCreditsFromShares(tpl.shareBatch || []),
        height,
      });
      const withSpill = settleHashOwed({
        fresh: freshCreditsFromShares(tpl.shareBatch || []),
        spill: freshCreditsFromShares(tpl.hashSpill || []),
        height,
      });
      assert.equal(plain.ok, true, plain.reason);
      assert.equal(withSpill.ok, true, withSpill.reason);
      assert.equal(withSpill.minted, plain.minted);
      const block = {
        header: tpl.header,
        txs: tpl.txs,
        shareBatch: tpl.shareBatch || [],
        hashSpill: tpl.hashSpill || [],
        poolDest: feeTo,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
        weight: tpl.weight,
        height,
      };
      const tag = Buffer.alloc(32);
      tag.writeUInt32LE(height, 4);
      const verdict = verifyBlock(block, { ...prevBlock, hash: prevHash, header: prevHeader }, {
        trustedPowHash: tag,
        skipSharePow: true,
        nowMs: when + 1_000,
        genesisMs: now,
        poolDest: feeTo,
        grandparentHeader: grandparent || null,
        supplyParents: parents,
        parentFluxset: parentFlux,
      });
      return { block, verdict, tpl, plain, withSpill };
    }

    const destCounts = [1, 3, 17];
    const loads = [
      (seat) => seat + 1,
      (seat) => seat * 2,
      (seat) => seat * 4,
    ];
    let low = 1;
    for (const destN of destCounts) {
      for (const loadOf of loads) {
        const dests = destsOf(destN);
        const seat = destN === 17 ? 2 : 1;
        const spillN = loadOf(seat);
        const freshN = Math.min(seat, destN);
        const carryN = seat;
        const parentShare = shareOf(dests[0], genesis.header, low, SHARE_FLOOR_BITS);
        low += 1;
        const when2 = now + TARGET_BLOCK_INTERVAL_MS;
        const pays2 = potSharesFromBatch([parentShare], feeTo, subsidy, subsidy - fee);
        const height2 = sealChild(
          [parentShare],
          [],
          { ...genesisBlock, hash: sealedG.hash },
          sealedG.hash,
          genesis.header,
          2,
          when2,
          pays2,
          [genesisBlock],
          null,
        );
        assert.equal(height2.verdict.ok, true, height2.verdict.reason);
        const parent2 = { ...height2.block, hash: height2.verdict.hash };
        const fresh = [];
        const spill = [];
        const carry = [];
        for (let i = 0; i < freshN; i += 1) {
          const bits = WIDTHS[i % WIDTHS.length];
          fresh.push(shareOf(dests[i % dests.length], parent2.header, low, bits));
          low += 1;
        }
        for (let i = 0; i < spillN; i += 1) {
          const bits = WIDTHS[(i + 1) % WIDTHS.length];
          spill.push(shareOf(dests[i % dests.length], genesis.header, low, bits));
          low += 1;
        }
        for (let i = 0; i < carryN; i += 1) {
          const bits = WIDTHS[(i + 2) % WIDTHS.length];
          carry.push(shareOf(dests[i % dests.length], parent2.header, low, bits));
          low += 1;
        }
        const rng = mulberry32(low);
        const ordered = shuffle(spill, rng);
        const when3 = when2 + TARGET_BLOCK_INTERVAL_MS;
        const pays3 = potSharesFromBatch(fresh, feeTo, subsidy, 0);
        const parents = [genesisBlock, parent2];
        const sealed = sealChild(
          fresh,
          ordered,
          parent2,
          height2.verdict.hash,
          parent2.header,
          3,
          when3,
          pays3,
          parents,
          genesis.header,
        );
        assert.equal(sealed.verdict.ok, true, sealed.verdict.reason);
        const flipped = sealChild(
          fresh,
          shuffle(spill, rng),
          parent2,
          height2.verdict.hash,
          parent2.header,
          3,
          when3,
          pays3,
          parents,
          genesis.header,
        );
        assert.equal(flipped.verdict.ok, true, flipped.verdict.reason);
        const owedA = hashOwedFromTx(sealed.block.txs[0]);
        const owedB = hashOwedFromTx(flipped.block.txs[0]);
        assert.ok(owedA);
        assert.ok(owedB);
        assert.equal(hashOwedRoot(owedA).equals(hashOwedRoot(owedB)), true);
        assert.equal(nanosOf(owedA), unitSum(spill));
        assert.equal(hashMinted(sealed.block), unitSum(fresh) * BigInt(HASH_BONUS_NANOS));
        assert.equal(sealed.withSpill.minted, sealed.plain.minted);
        const spillKeys = new Set((sealed.block.hashSpill || []).map(workKey));
        for (const row of carry) assert.equal(spillKeys.has(workKey(row)), false);
        for (const row of fresh) assert.equal(spillKeys.has(workKey(row)), false);
        const side = { ...sealed.block, windowOwed: { units: unitSum(spill).toString() } };
        assert.equal(nanosOf(spillForBlock(side).fresh), unitSum(spill));
        assert.equal(spillForBlock({ ...sealed.block, hashSpill: [], windowOwed: side.windowOwed }).fresh.length, 0);
        sealed.block.hash = sealed.verdict.hash;
        const wire = decodeWireBlock(encodeWireBlock(sealed.block));
        assert.equal(wire.hashSpill.length, sealed.block.hashSpill.length);
        assert.equal(packedWorkKey(wire.hashSpill[0], parent2.header, genesis.header), workKey(sealed.block.hashSpill[0]));
        const disk = unpackEpochBlock(packEpochBlock(sealed.block));
        assert.equal(disk.hashSpill.length, sealed.block.hashSpill.length);
        assert.equal(packedWorkKey(disk.hashSpill[0], parent2.header, genesis.header), workKey(sealed.block.hashSpill[0]));
        const bare = sealChild(
          fresh,
          [],
          parent2,
          height2.verdict.hash,
          parent2.header,
          3,
          when3,
          pays3,
          parents,
          genesis.header,
        );
        assert.equal(bare.verdict.ok, true, bare.verdict.reason);
        const bareOwed = hashOwedFromTx(bare.block.txs[0]) || [];
        assert.equal(nanosOf(bareOwed), 0n);
        const when4 = when3 + TARGET_BLOCK_INTERVAL_MS;
        const pays4 = [{ address: feeTo, nanos: fee, kind: 'pool-fee' }];
        const payer = sealChild(
          [],
          [],
          sealed.block,
          sealed.verdict.hash,
          sealed.block.header,
          4,
          when4,
          pays4,
          [genesisBlock, parent2, sealed.block],
          parent2.header,
        );
        assert.equal(payer.verdict.ok, true, payer.verdict.reason);
        const paidRows = hashOwedFromTx(payer.block.txs[0]) || [];
        assert.equal(nanosOf(paidRows), 0n);
        assert.equal(hashMinted(payer.block), unitSum(spill));
        payer.block.hash = payer.verdict.hash;
        const again = replayHashOwed([genesisBlock, parent2, sealed.block, payer.block]);
        assert.equal(again.ok, true, again.reason);
        assert.equal(nanosOf(again.rows), 0n);
        const once = replayHashOwed([genesisBlock, parent2, sealed.block]);
        assert.equal(once.ok, true, once.reason);
        assert.equal(nanosOf(once.rows), unitSum(spill));
        const orphan = replayHashOwed([genesisBlock, parent2, { ...bare.block, hash: bare.verdict.hash }]);
        assert.equal(orphan.ok, true, orphan.reason);
        assert.equal(nanosOf(orphan.rows), 0n);
        const repeatParents = [genesisBlock, parent2, sealed.block, payer.block];
        const repeat = sealChild(
          [],
          spill,
          payer.block,
          payer.verdict.hash,
          payer.block.header,
          5,
          when4 + TARGET_BLOCK_INTERVAL_MS,
          pays4,
          repeatParents,
          sealed.block.header,
        );
        assert.equal((repeat.block.hashSpill || []).length, 0);
        assert.equal(repeat.verdict.ok, true, repeat.verdict.reason);
        const againTag = Buffer.alloc(32);
        againTag.writeUInt32LE(5, 4);
        const forged = verifyBlock({
          ...repeat.block,
          hashSpill: spill,
        }, { ...payer.block, hash: payer.verdict.hash }, {
          trustedPowHash: againTag,
          skipSharePow: true,
          nowMs: when4 + TARGET_BLOCK_INTERVAL_MS + 1_000,
          genesisMs: now,
          poolDest: feeTo,
          grandparentHeader: sealed.block.header,
          supplyParents: repeatParents,
          parentFluxset: fluxsetFromBlocks(repeatParents),
        });
        assert.equal(forged.ok, false);
        assert.equal(forged.reason, 'hash_spill');
      }
    }
  });

  it('queues a small seat overflow on the pool template and pays it once', async () => {
    const caps = [1, 4, 8];
    const destForCap = { 1: 1, 4: 3, 8: 17 };
    const factors = [
      (cap) => cap + 1,
      (cap) => cap * 2,
      (cap) => cap * 4,
    ];
    const opened = [];
    try {
      let n = 0;
      for (const cap of caps) {
        for (const factor of factors) {
          n += 1;
          const expiringN = factor(cap);
          const freshN = cap;
          const under = poolAt(`c${cap}-n${expiringN}`, cap);
          opened.push(under);
          const genesis = under.pool.issueJob(undefined, { force: true });
          assert.ok(genesis?.jobId);
          await sealJob(under.pool, genesis);
          const held = Buffer.from(under.pool.store.tip().header);
          const live = under.pool.issueJob(undefined, { force: true });
          assert.ok(live?.jobId);
          const liveHeader = Buffer.from(live.header, 'hex');
          const dests = destsOf(destForCap[cap]);
          const expiring = [];
          const fresh = [];
          const rng = mulberry32(1000 + n);
          for (let i = 0; i < expiringN; i += 1) {
            const bits = WIDTHS[i % WIDTHS.length];
            expiring.push(pinShare(shareOf(dests[i % dests.length], held, n * 100000 + i + 1, bits)));
          }
          for (let i = 0; i < freshN; i += 1) {
            const bits = WIDTHS[(i + 1) % WIDTHS.length];
            fresh.push(pinShare(shareOf(dests[i % dests.length], liveHeader, n * 100000 + expiringN + i + 1, bits)));
          }
          const plantedExp = shuffle(expiring, rng);
          const plantedFresh = shuffle(fresh, rng);
          for (const row of plantedExp) under.pool.deferredShares.push(row);
          for (const row of plantedFresh) under.pool.openShares.push(row);
          await sealJob(under.pool, live);
          under.pool.rollOpenRound();
          const published = under.pool.issueJob(undefined, { force: true });
          assert.ok(published?.jobId);
          const tpl = under.pool.store.jobs.get(String(published.jobId)).tpl;
          assert.equal((tpl.shareBatch || []).length, cap);
          const spill = tpl.hashSpill || [];
          assert.equal(spill.length, expiringN - cap);
          assert.equal(unitSum(spill), unitSum(plantedExp) - unitSum(tpl.shareBatch.filter((s) => Buffer.from(s.verifiedHeader).equals(held))));
          const spillKeys = new Set(spill.map(workKey));
          for (const row of plantedFresh) assert.equal(spillKeys.has(workKey(row)), false);
          assert.equal(Number(under.pool.stats.lostWorkHashes) || 0, 0);
          assert.equal(owedUnits(under.pool), unitSum(spill));
          const payThis = factor(cap) === cap * 4;
          if (!payThis) continue;
          await sealJob(under.pool, published);
          assert.equal(owedUnits(under.pool), 0n);
          assert.equal(Number(under.pool.stats.lostWorkHashes) || 0, 0);
          const tip = under.pool.store.tip();
          assert.equal((tip.hashSpill || []).length, spill.length);
          const beforePay = replayHashOwed(under.pool.store.blocks);
          assert.equal(beforePay.ok, true, beforePay.reason);
          assert.equal(nanosOf(beforePay.rows), unitSum(spill));
          const carryLeft = under.pool.openShares.slice();
          for (const row of carryLeft) assert.equal(spillKeys.has(workKey(row)), false);
          const payer = under.pool.issueJob(undefined, { force: true });
          assert.ok(payer?.jobId);
          await sealJob(under.pool, payer);
          const afterPay = replayHashOwed(under.pool.store.blocks);
          assert.equal(afterPay.ok, true, afterPay.reason);
          assert.equal(nanosOf(afterPay.rows), 0n);
          assert.equal(hashMinted(under.pool.store.tip()), unitSum(spill));
          const wire = decodeWireBlock(encodeWireBlock(tip));
          assert.equal(wire.hashSpill.length, tip.hashSpill.length);
          const disk = unpackEpochBlock(packEpochBlock(tip));
          assert.equal(disk.hashSpill.length, tip.hashSpill.length);
          const dir = under.dir;
          under.pool.close();
          const reloaded = createStore(dir);
          const loaded = reloaded.blocks[reloaded.blocks.length - 2];
          assert.equal((loaded.hashSpill || []).length, spill.length);
          const replayed = replayHashOwed(reloaded.blocks);
          assert.equal(replayed.ok, true, replayed.reason);
          assert.equal(nanosOf(replayed.rows), 0n);
        }
      }
    } finally {
      for (const row of opened) {
        try { row.pool.close(); } catch { /* ignore */ }
      }
    }
  });
});

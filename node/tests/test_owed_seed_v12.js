/**
 * After a snap load, a fork replays owed from the checkpoint at or below
 * the anchor. It does not replay from genesis. Header rules run first.
 * Lengths 1000 and 2880 are not built here. The projection is printed
 * from the lengths this process actually ran.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { MAX_SHARES_PER_BLOCK, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  clearLiveSharePow,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
} from '../../crypto/share_batch.js';
import { decodeBookSnap, writeBookSnap } from '../src/book_snap.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import { createStore, OWED_CHECKPOINT_SPACING } from '../src/store.js';
import { buildTemplate, retarget, shouldAdopt } from '../src/chain.js';
import { auditCirculatingSupply } from '../src/supply.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-owed-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function freshStore(tag) {
  return createStore(fs.mkdtempSync(path.join(os.tmpdir(), tag)), { pruneAfter: 1_000_000 });
}

function sealNext(store, dest, pow, shares = null) {
  const tip = store.tip();
  const now = tip
    ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000
    : 1_700_000_000_000;
  const parent = tip?.header || null;
  const batch = shares || [];
  if (batch.length && parent) {
    for (const share of batch) {
      rememberLiveSharePow(parent, share.nonce, {
        noteCommit: noteCommitOfShare(share),
        shareBits: share.shareBits,
        lz: share.lz,
      });
    }
  }
  const { tpl } = store.template({
    miner: dest,
    now,
    shareBatch: batch,
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
  }, { trustedPowHash: pow, skipSharePow: true });
}

function powTag(n) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((n >>> 0) || 1, 4);
  return h;
}

function grow(store, dest, n, tagBase) {
  for (let i = 0; i < n; i += 1) {
    const got = sealNext(store, dest, powTag(tagBase + i + 1));
    if (!got.ok) return got;
  }
  return { ok: true, height: store.tip().height };
}

function shareRow(dest, low, header, bits = SHARE_FLOOR_BITS) {
  return {
    dest,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    verifiedHeader: header,
  };
}

function reload(dir, opts = {}) {
  const t0 = performance.now();
  const store = createStore(dir, { pruneAfter: 1_000_000, ...opts });
  return { store, ms: performance.now() - t0 };
}

function gapAdvances(length) {
  const anchor = length - 2;
  let best = -1;
  for (let at = 0; at <= anchor; at += 1) {
    const keep = at === 0 || at === length - 1 || ((at + 1) % OWED_CHECKPOINT_SPACING) === 0;
    if (keep && at >= best) best = at;
  }
  return anchor - best;
}

function assertCheckpoints(store) {
  const cps = store.owedView().checkpoints;
  assert.ok(cps.length >= 1);
  assert.equal(cps[0].at, 0);
  assert.equal(cps[cps.length - 1].at, store.blocks.length - 1);
  assert.equal(cps[cps.length - 1].seriesEnd, store.blocks.length);
  let prev = -1;
  for (const c of cps) {
    assert.ok(c.at > prev);
    assert.ok(c.at - prev <= OWED_CHECKPOINT_SPACING, `gap ${c.at - prev}`);
    prev = c.at;
  }
  assert.equal(store.owedView().series.length, store.blocks.length);
}

function canon(view) {
  return JSON.stringify({
    rows: view.rows.map((r) => ({
      nc: Buffer.from(r.noteCommit).toString('hex'),
      d: Buffer.from(r.dest20).toString('hex'),
      b: Buffer.from(r.admitBase).toString('hex'),
      n: String(r.nanos),
      s: r.sinceHeight,
    })).sort((a, b) => (a.nc + a.s).localeCompare(b.nc + b.s)),
    series: view.series.map(String),
  });
}

function supplyStatus(store) {
  const got = auditCirculatingSupply(store.blocks);
  assert.equal(got.status, 'verified', got.reason || 'supply');
  return String(got.circulatingNanos);
}

function fullParity(dir, live) {
  const want = canon(live.owedView());
  const wantSupply = supplyStatus(live);
  fs.rmSync(path.join(dir, 'book.snap'));
  const full = createStore(dir);
  assert.equal(full.loadMode, 'full');
  assert.equal(full.owedSeedStats().forkGenesis, 0);
  assert.equal(canon(full.owedView()), want);
  assert.equal(supplyStatus(full), wantSupply);
}

async function timed(fn) {
  let maxLag = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const slip = now - last - 40;
    if (slip > maxLag) maxLag = slip;
    last = now;
  }, 40);
  const t0 = performance.now();
  let result;
  try {
    result = await Promise.resolve(fn());
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 50));
    clearInterval(timer);
  }
  return { result, wall: performance.now() - t0, maxLag };
}

function forkBlock(store, dest, parentIndex, pow, shares = []) {
  const prefix = store.blocks.slice(0, parentIndex + 1);
  const prev = prefix[prefix.length - 1];
  const now = Number(decodeHeader(Buffer.from(prev.header)).timestamp) + 90_000;
  const bits = retarget(prefix, now);
  if (shares.length) {
    for (const share of shares) {
      rememberLiveSharePow(prev.header, share.nonce, {
        noteCommit: noteCommitOfShare(share),
        shareBits: share.shareBits,
        lz: share.lz,
      });
    }
  }
  const tpl = buildTemplate({
    prev: prev.hash,
    prevHeader: prev.header,
    prevBlock: prev,
    height: Number(prev.height) + 1,
    miner: dest,
    now,
    bits,
    shareBatch: shares,
    parentBlocks: prefix,
  });
  const headerBits = decodeHeader(Buffer.from(tpl.header)).bits;
  assert.equal(meetsTarget(pow, headerBits), true);
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    hash: pow,
    height: Number(prev.height) + 1,
    weight: tpl.weight,
    bSpendIds: [],
    bits: headerBits,
  };
}

function greaterHash(tipHash, bits) {
  const h = Buffer.from(tipHash);
  for (let i = h.length - 1; i >= 0; i -= 1) {
    if (h[i] >= 255) continue;
    h[i] += 1;
    if (meetsTarget(h, bits) && h.toString('hex') > Buffer.from(tipHash).toString('hex')) return h;
    h[i] -= 1;
  }
  throw new Error('no greater meeting hash');
}

function heavier(store, dest, parentIndex, count, tagBase) {
  const out = [];
  let prevIndex = parentIndex;
  let prevBlocks = store.blocks.slice(0, parentIndex + 1);
  let prev = prevBlocks[prevBlocks.length - 1];
  let now = Number(decodeHeader(Buffer.from(prev.header)).timestamp) + 90_000;
  for (let i = 0; i < count; i += 1) {
    const bits = retarget(prevBlocks, now);
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height) + 1,
      miner: dest,
      now,
      bits,
      parentBlocks: prevBlocks,
    });
    const pow = powTag(tagBase + i + 1);
    assert.equal(meetsTarget(pow, decodeHeader(Buffer.from(tpl.header)).bits), true);
    const block = {
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
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
    out.push(block);
    prev = block;
    prevBlocks = prevBlocks.concat([block]);
    prevIndex += 1;
    now += 90_000;
    void prevIndex;
  }
  return out;
}

describe('v12 snap fork owed seed', () => {
  it('a snapped prefix does not replay owed from genesis', { timeout: 300_000 }, async () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /function snapsFromReplay/);
    assert.doesNotMatch(src, /function seriesOfSnap/);
    const suffix = src.split('function verifySuffix(')[1].split('function verifySuffixBody')[0];
    assert.match(suffix, /gateForkHeaders/);
    assert.doesNotMatch(suffix, /seedHistory/);
    const body = src.split('function verifySuffixBody')[1].split('function stageOrAdopt')[0];
    assert.match(body, /seedHistory/);
    assert.doesNotMatch(body, /replayHashOwed/);
    assert.doesNotMatch(body, /bonusUnitsBefore/);
    const seed = src.split('function seedHistory(')[1].split('function snapsCoverTip')[0];
    assert.doesNotMatch(seed, /replayHashOwed/);

    const lengths = [20, 48, 96];
    const measured = [];
    for (const n of lengths) {
      const dest = minerDest();
      const built = freshStore(`shear-owed-len-${n}-`);
      const grew = grow(built, dest, n, 10_000 + n * 100);
      assert.equal(grew.ok, true, grew.reason);
      const { store, ms: loadMs } = reload(built.dir);
      assert.equal(store.loadMode, 'snap');
      assert.equal(store.owedSeedStats().forkGenesis, 0);
      assert.equal(store.owedSeedStats().loadBlocks, 0);
      assertCheckpoints(store);
      const before = store.owedSeedStats();
      const parent = store.blocks.length - 2;
      const tipHash = Buffer.from(store.tip().hash);
      const probe = forkBlock(store, dest, parent, Buffer.alloc(32));
      const losePow = greaterHash(tipHash, probe.bits);
      const first = await timed(() => store.ingest([forkBlock(store, dest, parent, losePow)], { trustBlockHash: true }));
      assert.equal(first.result.ok, false);
      assert.equal(first.result.reason, 'side_hold');
      const after = store.owedSeedStats();
      assert.equal(after.forkGenesis, 0);
      assert.equal(after.forkAdvances - before.forkAdvances, gapAdvances(n));
      assert.ok(after.forkAdvances - before.forkAdvances <= OWED_CHECKPOINT_SPACING);
      assert.equal(after.suffixAdvances - before.suffixAdvances, 1);
      const secondPow = greaterHash(losePow, probe.bits);
      const second = await timed(() => store.ingest([forkBlock(store, dest, parent, secondPow)], { trustBlockHash: true }));
      assert.equal(second.result.reason, 'side_hold');
      const cached = store.owedSeedStats();
      assert.equal(cached.forkAdvances, after.forkAdvances);
      assert.ok(cached.cached > after.cached);
      assert.equal(cached.forkGenesis, 0);
      const owedAfterLose = canon(store.owedView());
      measured.push({
        n,
        loadMs,
        loseWall: first.wall,
        loseLag: first.maxLag,
        secondWall: second.wall,
        secondLag: second.maxLag,
        advances: after.forkAdvances - before.forkAdvances,
      });
      assert.equal(canon(store.owedView()), owedAfterLose);

      const win = await timed(() => store.ingest(
        [forkBlock(store, dest, parent, Buffer.alloc(32))],
        { trustBlockHash: true },
      ));
      assert.equal(win.result.ok, true, win.result.reason);
      assert.equal(store.owedSeedStats().forkGenesis, 0);
      const candidate = store.blocks;
      assert.equal(shouldAdopt(candidate, candidate), false);
      fullParity(store.dir, store);
      console.log(JSON.stringify({ event: 'owed_seed_length', n, ...measured[measured.length - 1], winWall: win.wall, winLag: win.maxLag }));
    }
    const walls = measured.map((row) => row.loseWall);
    const maxWall = Math.max(...walls);
    const minWall = Math.min(...walls);
    assert.ok(maxWall < 5_000, `losing side wall ${maxWall}`);
    assert.ok(maxWall < minWall * 4 + 250, `wall grew with height ${minWall} -> ${maxWall}`);
    for (const row of measured) {
      assert.ok(row.loseLag < 5_000, `lag ${row.loseLag} at ${row.n}`);
      assert.ok(row.advances <= OWED_CHECKPOINT_SPACING);
      if (row.n > OWED_CHECKPOINT_SPACING * 2) {
        assert.ok(row.advances < row.n / 2, `advances ${row.advances} tracked length ${row.n}`);
      }
    }
    console.log(JSON.stringify({
      event: 'owed_seed_projection',
      built: lengths,
      notBuilt: [1000, 2000, 2880],
      maxLoseWallMs: maxWall,
      projectedLoseWallMs: { 1000: maxWall, 2000: maxWall, 2880: maxWall },
      reason: 'gap is one checkpoint spacing, so the measured ceiling is the projection',
    }));

    const deep = freshStore('shear-owed-deep-');
    const deepDest = minerDest();
    assert.equal(grow(deep, deepDest, 40, 50_000).ok, true);
    const snapped = reload(deep.dir).store;
    const prior = snapped.owedSeedStats();
    const badParent = 2;
    const bad = forkBlock(snapped, deepDest, badParent, powTag(9));
    bad.hash = Buffer.alloc(32, 0xff);
    const rejected = await timed(() => snapped.ingest([bad], { trustedPowHash: Buffer.alloc(32, 0xff) }));
    assert.equal(rejected.result.ok, false);
    assert.equal(rejected.result.reason, 'pow');
    const later = snapped.owedSeedStats();
    assert.equal(later.forkAdvances, prior.forkAdvances);
    assert.equal(later.suffixAdvances, prior.suffixAdvances);
    assert.equal(later.forkGenesis, 0);
    assert.equal(later.loadBlocks, prior.loadBlocks);
    assert.ok(rejected.wall < 2_000, `bad header wall ${rejected.wall}`);
    console.log(JSON.stringify({ event: 'owed_seed_bad_pow', wall: rejected.wall, lag: rejected.maxLag }));

    const haltDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-owed-halt-'));
    const haltBuilt = createStore(haltDir, { pruneAfter: 1_000_000, reorgHaltDepth: 8 });
    const haltDest = minerDest();
    assert.equal(grow(haltBuilt, haltDest, 24, 70_000).ok, true);
    const halt = reload(haltDir, { reorgHaltDepth: 8 }).store;
    assert.equal(halt.reorgHaltDepth, 8);
    const shallowParent = halt.blocks.length - 1 - 7;
    const shallow = heavier(halt, haltDest, shallowParent, 8, 80_000);
    const shallowGot = await Promise.resolve(halt.ingest(shallow, { trustBlockHash: true }));
    assert.equal(shallowGot.ok, true, shallowGot.reason);
    assert.equal(halt.owedSeedStats().forkGenesis, 0);
    fullParity(halt.dir, halt);

    const halt2 = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-owed-halt2-')), {
      pruneAfter: 1_000_000,
      reorgHaltDepth: 8,
    });
    assert.equal(grow(halt2, haltDest, 24, 90_000).ok, true);
    const halted = reload(halt2.dir, { reorgHaltDepth: 8 }).store;
    const beforeHalt = halted.owedSeedStats();
    const deepParent = halted.blocks.length - 1 - 8;
    const deepFork = heavier(halted, haltDest, deepParent, 9, 100_000);
    const haltedGot = await Promise.resolve(halted.ingest(deepFork, { trustBlockHash: true }));
    assert.equal(haltedGot.ok, false);
    assert.equal(haltedGot.reason, 'reorg_halt');
    const haltStats = halted.owedSeedStats();
    assert.equal(haltStats.forkGenesis, 0);
    assert.ok(haltStats.forkAdvances - beforeHalt.forkAdvances <= OWED_CHECKPOINT_SPACING);
    assert.ok(haltStats.forkAdvances - beforeHalt.forkAdvances < halted.blocks.length);

    const legacyBuilt = freshStore('shear-owed-legacy-');
    const legacyDest = minerDest();
    assert.equal(grow(legacyBuilt, legacyDest, 16, 110_000).ok, true);
    const snapPath = path.join(legacyBuilt.dir, 'book.snap');
    const key = bookSealKeyFor(legacyBuilt.dir);
    const decoded = decodeBookSnap(fs.readFileSync(snapPath), key);
    assert.ok(Array.isArray(decoded.owedCheckpoints) && decoded.owedCheckpoints.length > 1);
    delete decoded.owedCheckpoints;
    writeBookSnap(snapPath, key, decoded);
    const legacy = reload(legacyBuilt.dir);
    assert.equal(legacy.store.loadMode, 'snap');
    assert.equal(legacy.store.owedSeedStats().forkGenesis, 0);
    assert.equal(legacy.store.owedSeedStats().loadBlocks, 16);
    assertCheckpoints(legacy.store);
    const legBefore = legacy.store.owedSeedStats();
    const legParent = legacy.store.blocks.length - 2;
    const legTip = Buffer.from(legacy.store.tip().hash);
    const legProbe = forkBlock(legacy.store, legacyDest, legParent, Buffer.alloc(32));
    const legLose = greaterHash(legTip, legProbe.bits);
    const legGot = await Promise.resolve(legacy.store.ingest(
      [forkBlock(legacy.store, legacyDest, legParent, legLose)],
      { trustBlockHash: true },
    ));
    assert.equal(legGot.reason, 'side_hold');
    assert.equal(legacy.store.owedSeedStats().forkGenesis, 0);
    assert.ok(legacy.store.owedSeedStats().forkAdvances - legBefore.forkAdvances <= OWED_CHECKPOINT_SPACING);
    const again = reload(legacyBuilt.dir);
    assert.equal(again.store.loadMode, 'snap');
    assert.equal(again.store.owedSeedStats().loadBlocks, 0);
    assert.equal(again.store.owedSeedStats().forkGenesis, 0);
  });

  it('share width and dest count do not replay the snapped prefix', { timeout: 600_000 }, async () => {
    const shapes = [
      { shares: 1, dests: 1 },
      { shares: 5, dests: 3 },
      { shares: MAX_SHARES_PER_BLOCK - 1, dests: 17 },
    ];
    for (const shape of shapes) {
      clearLiveSharePow();
      const dests = Array.from({ length: shape.dests }, () => minerDest());
      const built = freshStore(`shear-owed-share-${shape.shares}-`);
      const grew = grow(built, dests[0], 36, 200_000 + shape.shares);
      assert.equal(grew.ok, true, grew.reason);
      const parentHeader = Buffer.from(built.tip().header);
      const batch = [];
      for (let i = 0; i < shape.shares; i += 1) {
        batch.push(shareRow(dests[i % dests.length], BigInt(i + 1), parentHeader));
      }
      const sealed = sealNext(built, dests[0], powTag(300_000 + shape.shares), batch);
      assert.equal(sealed.ok, true, sealed.reason);
      assert.ok(built.tip().shareBatch.length >= Math.min(shape.shares, 1));
      assert.ok(built.tip().shareBatch.length > shape.shares / 2);
      const store = reload(built.dir).store;
      assert.equal(store.loadMode, 'snap');
      const before = store.owedSeedStats();
      const parent = store.blocks.length - 2;
      const tipHash = Buffer.from(store.tip().hash);
      const probe = forkBlock(store, dests[0], parent, Buffer.alloc(32));
      const losePow = greaterHash(tipHash, probe.bits);
      const t0 = performance.now();
      const got = await Promise.resolve(store.ingest(
        [forkBlock(store, dests[0], parent, losePow)],
        { trustBlockHash: true },
      ));
      const wall = performance.now() - t0;
      assert.equal(got.reason, 'side_hold');
      const stats = store.owedSeedStats();
      assert.equal(stats.forkGenesis, 0);
      assert.equal(stats.forkAdvances - before.forkAdvances, gapAdvances(store.blocks.length));
      assert.ok(stats.forkAdvances - before.forkAdvances <= OWED_CHECKPOINT_SPACING);
      console.log(JSON.stringify({
        event: 'owed_seed_shares',
        shares: shape.shares,
        dests: shape.dests,
        sealed: store.blocks[store.blocks.length - 1].shareBatch.length,
        advances: stats.forkAdvances - before.forkAdvances,
        wall,
      }));
    }
  });
});

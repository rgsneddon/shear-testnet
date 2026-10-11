import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newIdentity } from '../../crypto/address.js';
import { GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  GENESIS_PREV,
  buildTemplate,
  finderAimSeals,
  resetFinderAimSeals,
  templateForFinder,
} from '../../node/src/chain.js';
import { JOB_STORE_CAP, rememberStoredJob } from '../../node/src/job_cap.js';
import {
  filterOpenShares,
  openShareRescans,
  rememberOpenShare,
  resetOpenShareRescans,
} from '../src/pool.js';
import {
  EXPLORER_RANGE_CAP,
  EXPLORER_RECENT_CAP,
  explorerRecentTxs,
  explorerWalkStats,
  findSealedBlock,
  resetExplorerWalkStats,
  searchExplorerTxs,
} from '../src/wallet_api.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function block(height) {
  const hash = Buffer.alloc(32);
  hash.writeUInt32BE(height, 0);
  if (height === 1) {
    hash[0] = 0xab;
    hash[1] = 0xcd;
  }
  return {
    height,
    hash,
    header: Buffer.alloc(128),
    txs: [{ coinbase: true, height, vout: [{ kind: 'pot', nanos: 1 }] }],
  };
}

function book(height) {
  const blocks = [];
  for (let h = 1; h <= height; h += 1) blocks.push(block(h));
  return { blocks, tip: () => blocks[blocks.length - 1], mempool: [] };
}

function hexOf(b) {
  return b.hash.toString('hex');
}

describe('inbox 012 bounds', () => {
  it('keeps explorer, jobs, open shares, and finder seals bounded for any height', () => {
    const api = fs.readFileSync(new URL('../src/wallet_api.js', import.meta.url), 'utf8');
    const poolSrc = fs.readFileSync(new URL('../src/pool.js', import.meta.url), 'utf8');
    const storeSrc = fs.readFileSync(new URL('../../node/src/store.js', import.meta.url), 'utf8');
    assert.match(api, /explorerRecentTxs\(store, EXPLORER_RECENT_CAP\)/);
    assert.doesNotMatch(api, /explorerRecentTxs\(store, Infinity\)/);
    assert.doesNotMatch(api, /confirmedBlockTxs\(store, Infinity\)/);
    assert.doesNotMatch(poolSrc, /openShares = openShares\.filter/);
    assert.match(poolSrc, /filterOpenShares\(openShares/);
    assert.match(poolSrc, /rememberStoredJob\(store\.jobs/);
    assert.match(storeSrc, /rememberStoredJob\(jobs, jobId/);

    const heights = [EXPLORER_RECENT_CAP * 4, EXPLORER_RECENT_CAP * 8];
    const stores = heights.map((h) => book(h));
    for (const store of stores) {
      assert.equal(findSealedBlock(store, '1')?.height, 1);
      assert.equal(hexOf(findSealedBlock(store, hexOf(store.blocks[0]))), hexOf(store.blocks[0]));
    }

    for (const store of stores) {
      resetExplorerWalkStats();
      const miss = 'f'.repeat(64);
      assert.equal(findSealedBlock(store, miss), null);
      assert.equal(findSealedBlock(store, String(store.blocks.length))?.height, store.blocks.length);
      assert.equal(explorerWalkStats().visits, 0);
      assert.equal(explorerWalkStats().syncs, 0);
    }

    const widths = [1, 7, 64];
    const rangeChains = [128, EXPLORER_RECENT_CAP * 4].map((h) => book(h));
    for (const width of widths) {
      const seen = [];
      for (const store of rangeChains) {
        resetExplorerWalkStats();
        const lo = 10;
        const hi = lo + width - 1;
        const rows = searchExplorerTxs(store, { from: lo, to: hi });
        assert.equal(rows.length, width);
        assert.equal(rows[0].height, hi);
        assert.equal(rows[rows.length - 1].height, lo);
        assert.equal(explorerWalkStats().visits, width);
        seen.push(explorerWalkStats().visits);
      }
      assert.equal(seen[0], seen[1]);
    }

    const wide = [];
    for (const store of stores) {
      resetExplorerWalkStats();
      const rows = searchExplorerTxs(store, { from: 1, to: 1_000_000_000 });
      assert.ok(rows.length <= Math.min(EXPLORER_RANGE_CAP, store.blocks.length));
      assert.equal(explorerWalkStats().visits, EXPLORER_RANGE_CAP);
      wide.push(explorerWalkStats().visits);
    }
    assert.equal(wide[0], wide[1]);

    for (const store of stores) {
      resetExplorerWalkStats();
      assert.equal(findSealedBlock(store, 'abcd'), null);
      assert.equal(explorerWalkStats().visits, EXPLORER_RECENT_CAP);
      assert.ok(EXPLORER_RECENT_CAP < store.blocks.length);
      resetExplorerWalkStats();
      const old = findSealedBlock(store, hexOf(store.blocks[0]));
      assert.equal(old?.height, 1);
      assert.equal(explorerWalkStats().visits, 0);
    }

    const recentVisits = [];
    for (const store of stores) {
      resetExplorerWalkStats();
      const rows = explorerRecentTxs(store, EXPLORER_RECENT_CAP).filter((t) => t.kind === 'block');
      assert.equal(rows.length, EXPLORER_RECENT_CAP);
      assert.equal(rows[0].height, store.blocks.length);
      const visits = explorerWalkStats().visits;
      assert.ok(visits > 0);
      assert.ok(visits < store.blocks.length);
      recentVisits.push(visits);
    }
    assert.equal(recentVisits[0], recentVisits[1]);

    const forty = book(40);
    const all = explorerRecentTxs(forty, Infinity).filter((t) => t.kind === 'block');
    assert.equal(all.length, 40);
    assert.equal(all[0].height, 40);
    assert.equal(all[39].height, 1);
    const capped = explorerRecentTxs(forty, 30).filter((t) => t.kind === 'block');
    assert.equal(capped.length, 30);

    for (const cap of [2, 8, 64, JOB_STORE_CAP]) {
      const jobs = new Map();
      const n = cap * 2;
      for (let i = 0; i < n; i += 1) rememberStoredJob(jobs, `job-${i}`, { i }, { cap });
      assert.equal(jobs.size, cap);
      assert.equal(jobs.has('job-0'), false);
      assert.equal(jobs.has(`job-${n - 1}`), true);
      assert.equal(jobs.has(`job-${n - cap}`), true);
      const pinned = new Map();
      rememberStoredJob(pinned, 'keep', { pinned: true }, { cap, pin: ['keep'] });
      for (let i = 0; i < cap + 5; i += 1) {
        rememberStoredJob(pinned, `new-${i}`, { i }, { cap, pin: ['keep'] });
      }
      assert.equal(pinned.size, cap);
      assert.equal(pinned.has('keep'), true);
      assert.equal(pinned.has(`new-${cap + 4}`), true);
    }

    for (const n of [1, 8, 64, 256]) {
      resetOpenShareRescans();
      const list = [];
      for (let i = 0; i < n; i += 1) {
        const opened = rememberOpenShare(list, { fp: `fp-${n}-${i}`, nonce: String(i), hash: 'aa' });
        assert.equal(opened.ok, true);
      }
      assert.equal(list.length, n);
      assert.equal(openShareRescans(), 1);
      const half = filterOpenShares(list, (s) => Number(s.nonce) % 2 === 0);
      const before = openShareRescans();
      assert.equal(rememberOpenShare(half, { fp: `fp-${n}-more`, nonce: 'more', hash: 'aa' }).ok, true);
      assert.equal(openShareRescans(), before);
      const raw = half.filter(() => true);
      assert.equal(rememberOpenShare(raw, { fp: `fp-${n}-raw`, nonce: 'raw', hash: 'aa' }).ok, true);
      assert.equal(openShareRescans(), before + 1);
    }

    const shared = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: minerDest(),
      finderDest: '',
      poolDest: '',
      feeDest: '',
      txs: [{ id: 'fee-bounds', kind: 'send', fee: 1000 }],
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
    });
    assert.ok(shared?.levyBind?.finderNanos > 0);
    for (const count of [1, 3, 8]) {
      const dests = Array.from({ length: count }, () => minerDest());
      resetFinderAimSeals();
      for (const dest of dests) assert.ok(templateForFinder(shared, dest));
      assert.equal(finderAimSeals(), count);
      const mid = finderAimSeals();
      for (const dest of dests) assert.ok(templateForFinder(shared, dest));
      assert.equal(finderAimSeals(), mid);
    }
    const dest = minerDest();
    resetFinderAimSeals();
    assert.ok(templateForFinder(shared, dest));
    assert.equal(finderAimSeals(), 1);
    const hdr = Buffer.from(shared.header);
    hdr[36] ^= 0x5a;
    assert.ok(templateForFinder({ ...shared, header: hdr }, dest));
    assert.equal(finderAimSeals(), 2);
    const bumped = {
      ...shared,
      levyBind: { ...shared.levyBind, finderNanos: shared.levyBind.finderNanos + 1000 },
    };
    assert.ok(templateForFinder(bumped, dest));
    assert.equal(finderAimSeals(), 3);
  });
});

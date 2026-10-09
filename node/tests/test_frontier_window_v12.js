/**
 * N-24: Admit frontiers stay for the reorg window plus sparse checkpoints.
 * A taller chain does not keep one frontier per height. A snap reload and a
 * heavier branch still reach the same root, including when the ancestor is
 * outside the window and the blob has to be replayed from the checkpoint.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { fluxsetFromBlocks, appendFluxBlock, takeFrontierStats } from '../../crypto/admit.js';
import { ANCHOR_WINDOW } from '../../crypto/admit_v3.js';
import { readBookSnap } from '../src/book_snap.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import {
  createStore,
  OWED_CHECKPOINT_SPACING,
  keepsFrontier,
  frontierWindow,
} from '../src/store.js';
import { buildTemplate, retarget, shouldAdopt } from '../src/chain.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const STEP = 90_000;
const FRONTIER_MAX = 16 * 1024;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function sealNext(store, dest, tag) {
  const tip = store.tip();
  const now = tip ? headerTime(tip) + STEP : T0;
  const { tpl } = store.template({ miner: dest, now });
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
  }, { trustedPowHash: easyPow(tag), skipSharePow: true });
}

function grow(store, dest, n, tagBase) {
  for (let i = 0; i < n; i += 1) {
    const got = sealNext(store, dest, tagBase + i + 1);
    if (!got.ok) return got;
    const h = store.tip().height;
    if (h % OWED_CHECKPOINT_SPACING === 0) process.stderr.write(`frontier-window ${h}\n`);
  }
  return { ok: true, height: store.tip().height };
}

function keptCount(tip, halt) {
  let n = 0;
  for (let h = 1; h <= tip; h += 1) {
    if (keepsFrontier(h, tip, halt)) n += 1;
  }
  return n;
}

function outsideKept(tip, halt) {
  const span = frontierWindow(halt);
  let n = 0;
  for (let h = 1; h <= tip - span; h += 1) {
    if (keepsFrontier(h, tip, halt)) n += 1;
  }
  return n;
}

function heavierFork(blocks, dest, parentIndex, count, tagBase) {
  const prefix = blocks.slice(0, parentIndex + 1);
  const out = [];
  let prev = prefix[prefix.length - 1];
  let now = headerTime(prev) + STEP;
  let flux = fluxsetFromBlocks(prefix);
  for (let i = 0; i < count; i += 1) {
    const chain = prefix.concat(out);
    const bits = retarget(chain, now);
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height) + 1,
      miner: dest,
      now,
      bits,
      parentBlocks: chain,
      parentFluxset: flux,
    });
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
      hash: easyPow(tagBase + i),
      height: Number(prev.height) + 1,
      weight: tpl.weight,
      bSpendIds: [],
    };
    out.push(block);
    appendFluxBlock(flux, block);
    prev = block;
    now += STEP;
  }
  return out;
}

function assertFrontierSet(view, halt) {
  const tip = view.tip;
  const want = keptCount(tip, halt);
  assert.equal(view.withFrontier, want, `frontiers ${view.withFrontier} want ${want} at ${tip}`);
  assert.ok(view.withFrontier < tip);
  assert.ok(view.maxBlob > 0 && view.maxBlob <= FRONTIER_MAX);
  assert.ok(view.blobBytes > 0 && view.blobBytes <= view.withFrontier * 2 * FRONTIER_MAX);
  assert.equal(view.heights.length, want);
  for (const h of view.heights) assert.equal(keepsFrontier(h, tip, halt), true);
}

describe('v12 frontier retention', () => {
  it('keeps the reorg window plus sparse checkpoints for any tip and any halt', () => {
    const spacing = OWED_CHECKPOINT_SPACING;
    const halts = [0, 1, spacing, ANCHOR_WINDOW, ANCHOR_WINDOW + spacing];
    for (const halt of halts) {
      const span = frontierWindow(halt);
      assert.equal(span, Math.max(ANCHOR_WINDOW, halt) + spacing);
      const tips = [1, 2, span, span + 1, span + spacing, span + spacing * 3 + 5];
      for (const tip of tips) {
        let kept = 0;
        for (let h = 1; h <= tip; h += 1) {
          const keep = keepsFrontier(h, tip, halt);
          if (h === 1 || h === tip || tip - h < span || (h % spacing === 0)) {
            assert.equal(keep, true, `halt ${halt} tip ${tip} h ${h}`);
          } else {
            assert.equal(keep, false, `halt ${halt} tip ${tip} h ${h}`);
          }
          if (keep) kept += 1;
        }
        const outside = Math.max(0, tip - span);
        let droppable = 0;
        for (let h = 2; h <= outside; h += 1) {
          if (h !== tip && h % spacing !== 0) droppable += 1;
        }
        if (droppable > 0) {
          assert.ok(kept <= tip - droppable, `halt ${halt} tip ${tip} kept ${kept}`);
        }
        assert.ok(kept <= span + Math.floor(tip / spacing) + 1, `halt ${halt} tip ${tip} kept ${kept}`);
      }
    }
  });

  it('stored frontiers stay with the window, and a checkpoint replay still adopts', { timeout: 420_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fr-window-'));
    const store = createStore(dir, { pruneAfter: 1_000_000 });
    const dest = minerDest();
    const halt = store.reorgHaltDepth;
    const span = frontierWindow(halt);
    const spacing = OWED_CHECKPOINT_SPACING;
    const shortH = span + spacing;
    const tallH = span + spacing * 2;
    const builtShort = grow(store, dest, shortH, 3000);
    assert.equal(builtShort.ok, true, builtShort.reason);
    assert.equal(store.tip().height, shortH);
    const shortView = store.anchorView();
    assert.equal(shortView.roots, shortH);
    assertFrontierSet(shortView, halt);
    const builtTall = grow(store, dest, tallH - shortH, 8000);
    assert.equal(builtTall.ok, true, builtTall.reason);
    assert.equal(store.tip().height, tallH);
    const tallView = store.anchorView();
    assert.equal(tallView.roots, tallH);
    assertFrontierSet(tallView, halt);
    const grown = tallH - shortH;
    const extra = tallView.withFrontier - shortView.withFrontier;
    assert.equal(extra, outsideKept(tallH, halt) - outsideKept(shortH, halt));
    assert.ok(extra < grown, `kept grew by ${extra} across ${grown} heights`);
    const snap = readBookSnap(path.join(dir, 'book.snap'), bookSealKeyFor(dir), {});
    assert.ok(snap && Array.isArray(snap.anchorWindow));
    assert.equal(snap.anchorWindow.length, tallView.withFrontier);
    for (const row of snap.anchorWindow) {
      assert.equal(keepsFrontier(row.height, tallH, halt), true);
      assert.ok(row.frontier?.length > 0 && row.frontier.length <= FRONTIER_MAX);
      assert.ok(row.zeroFrontier?.length > 0 && row.zeroFrontier.length <= FRONTIER_MAX);
    }
    const liveRoot = Buffer.from(store.jroot());
    const loaded = createStore(dir, { pruneAfter: 1_000_000 });
    assert.equal(loaded.loadMode, 'snap');
    assert.ok(Buffer.from(loaded.jroot()).equals(liveRoot));
    const loadedView = loaded.anchorView();
    assert.equal(loadedView.tip, tallH);
    assert.equal(loadedView.withFrontier, tallView.withFrontier);
    assert.equal(loadedView.roots, tallView.withFrontier);
    assert.ok(loadedView.blobBytes <= loadedView.withFrontier * 2 * FRONTIER_MAX);

    const near = loaded.blocks.length - 2;
    assert.equal(keepsFrontier(near + 1, loaded.blocks.length, halt), true);
    const nearFork = heavierFork(loaded.blocks, dest, near, 2, 40_000);
    const nearCandidate = loaded.blocks.slice(0, near + 1).concat(nearFork);
    assert.equal(shouldAdopt(loaded.blocks, nearCandidate), true);
    takeFrontierStats();
    const nearAdopt = await Promise.resolve(loaded.ingest(nearFork, { trustBlockHash: true }));
    const nearStats = takeFrontierStats();
    assert.equal(nearAdopt.ok, true, nearAdopt.reason);
    assert.equal(nearStats.fullRoots, 0);
    assertFrontierSet(loaded.anchorView(), halt);

    const tipNow = loaded.blocks.length;
    let buried = -1;
    for (let h = tipNow - span; h >= 2; h -= 1) {
      if (!keepsFrontier(h, tipNow, halt)) {
        buried = h - 1;
        break;
      }
    }
    assert.ok(buried >= 1);
    assert.equal(keepsFrontier(buried + 1, tipNow, halt), false);
    const replaced = tipNow - (buried + 1);
    assert.ok(replaced > spacing);
    process.stderr.write(`frontier-window replay parent ${buried + 1} suffix ${replaced + 1}\n`);
    const deepFork = heavierFork(loaded.blocks, dest, buried, replaced + 1, 70_000);
    const deepCandidate = loaded.blocks.slice(0, buried + 1).concat(deepFork);
    assert.equal(shouldAdopt(loaded.blocks, deepCandidate), true);
    takeFrontierStats();
    const t0 = performance.now();
    const deepAdopt = await Promise.resolve(loaded.ingest(deepFork, { trustBlockHash: true }));
    const wall = performance.now() - t0;
    const deepStats = takeFrontierStats();
    process.stderr.write(`frontier-window adopt ${wall.toFixed(1)} ms fullRoots ${deepStats.fullRoots}\n`);
    assert.equal(deepAdopt.ok, true, deepAdopt.reason);
    assert.equal(deepStats.fullRoots, 0);
    assertFrontierSet(loaded.anchorView(), halt);
    const again = fluxsetFromBlocks(loaded.blocks);
    assert.ok(Buffer.from(loaded.jroot()).equals(Buffer.from(again.jroot)));
    assert.equal(loaded.fluxset().pubs.length, again.pubs.length);
  });
});

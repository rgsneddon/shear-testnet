/**
 * PSA-c2a-1 and the depth-1000 un-bury.
 * forkBurial, seedHistory, and the adopt walk use the tip of the chain
 * being validated. They do not take max(local tip, fork length).
 * A reorg that lifts a pruned block above that depth puts the share batch back.
 * Commit and verify use that same tip. A peer tipHeight does not bury.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import {
  ASERT_EMERGENCY_GAP_FACTOR,
  SAMPLE_PRUNE_CONFIRMATIONS,
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
} from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
  clearLiveSharePow,
} from '../../crypto/share_batch.js';
import { shouldPruneSamples } from '../../crypto/chronoflux.js';
import { createStore } from '../src/store.js';
import { buildTemplate, chainWorkOf, retarget, retargetQuote, verifyBlock } from '../src/chain.js';
import { foldSupply } from '../src/supply.js';

const PRUNE = SAMPLE_PRUNE_CONFIRMATIONS;
const STEP = TARGET_BLOCK_INTERVAL_MS;
const T0 = 1_700_000_000_000;
const LATE = ASERT_EMERGENCY_GAP_FACTOR * STEP * 4;

let powTag = 1;
function easyPow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag >>> 0, 4);
  powTag += 1;
  return h;
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function shareAt(dest, low) {
  return {
    dest,
    nonce: nonceWithShareTarget(low, SHARE_FLOOR_BITS),
    lz: SHARE_FLOOR_BITS,
    shareBits: SHARE_FLOOR_BITS,
    creditedShareBits: SHARE_FLOOR_BITS,
  };
}

function sealNext(store, dest, share = null) {
  const tip = store.tip();
  const now = tip ? headerTime(tip) + STEP : T0;
  if (share && tip?.header) {
    share.verifiedHeader = tip.header;
    rememberLiveSharePow(tip.header, share.nonce, {
      noteCommit: noteCommitOfShare(share),
      shareBits: share.shareBits,
      lz: share.lz,
    });
  }
  const { tpl } = store.template({
    miner: dest,
    now,
    shareBits: SHARE_FLOOR_BITS,
    shareBatch: share ? [share] : [],
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
  }, { trustedPowHash: easyPow(), skipSharePow: true });
}

function sealLate(store, dest) {
  const tip = store.tip();
  const now = headerTime(tip) + LATE;
  const quote = retargetQuote(store.blocks, now);
  assert.equal(quote.ok, true, quote.reason);
  assert.ok(quote.easeBits > 0, 'late tail did not ease');
  const tpl = buildTemplate({
    prev: tip.hash,
    prevHeader: tip.header,
    prevBlock: tip,
    height: tip.height + 1,
    miner: dest,
    now,
    bits: quote.eased,
    parentBlocks: store.blocks,
    parentFluxset: store.fluxset(),
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
  }, { trustedPowHash: easyPow(), skipSharePow: true });
}

function forkOne(store, dest, parentIndex, { late = false } = {}) {
  const prefix = store.blocks.slice(0, parentIndex + 1);
  const prev = prefix[prefix.length - 1];
  const now = headerTime(prev) + (late ? LATE : STEP);
  const quote = retargetQuote(prefix, now);
  assert.equal(quote.ok, true, quote.reason);
  const bits = late ? quote.eased : retarget(prefix, now);
  const tpl = buildTemplate({
    prev: prev.hash,
    prevHeader: prev.header,
    prevBlock: prev,
    height: Number(prev.height) + 1,
    miner: dest,
    now,
    bits,
    parentBlocks: prefix,
  });
  const pow = easyPow();
  assert.equal(meetsTarget(pow, decodeHeader(Buffer.from(tpl.header)).bits), true);
  return {
    block: {
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
    },
    prefix,
  };
}

function ingest(store, block) {
  return store.ingest([block], {
    trustBlockHash: true,
    skipSharePow: true,
    nowMs: Date.now(),
  });
}

function parentView(block) {
  return {
    hash: block.hash,
    header: block.header,
    height: block.height,
    rootA: block.rootA,
    rootB: block.rootB,
    txs: block.txs,
    bLeaves: block.bLeaves,
    weight: block.weight,
    shareBatch: block.shareBatch,
  };
}

describe('v12 burial tip', () => {
  it('names one burial tip for the chain being validated', () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const forkAt = src.indexOf('function forkBurial');
    const supplyAt = src.indexOf('function supplyCarriedTo');
    assert.ok(forkAt > 0 && supplyAt > forkAt);
    const forkSrc = src.slice(forkAt, supplyAt);
    assert.match(forkSrc, /fork\.length/);
    assert.doesNotMatch(forkSrc, /Math\.max/);
    assert.doesNotMatch(src, /Math\.max\(storeTip/);
    assert.doesNotMatch(src, /Math\.max\(oldTip/);
    const body = src.split('function verifySuffixBody')[1].split('function stageOrAdopt')[0];
    assert.match(body, /seedHistory\(rows, tipAt, candidateTip\)/);
    assert.doesNotMatch(body, /prefixTip/);
    const adopt = src.split('function finishAdopt')[1].split('function ingestInner')[0];
    assert.match(adopt, /supplyCarriedTo\(lca - 1, suffixBurial\)/);
    assert.match(adopt, /tipHeight: suffixBurial/);
    assert.doesNotMatch(adopt, /prefixBurial/);
    assert.match(src, /function liftPrunedBlock/);
    assert.match(src, /function rememberPrunedBody/);
    assert.match(src, /noteUnprunedBody\(i, packEpochBlock\(lifted\)\)/);
    assert.match(src, /noteReplacedBlock\(i\)/);
  });

  it('un-buries a pruned block under the candidate tip', { timeout: 900_000 }, async () => {
    clearLiveSharePow();
    const dest = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-unbury-'));
    const store = createStore(dir);
    const creditHeight = 2;
    let shareCount = 0;
    for (let n = 0; n < PRUNE; n += 1) {
      const height = (store.tip()?.height || 0) + 1;
      const share = height === creditHeight ? shareAt(dest, 11n) : null;
      const got = sealNext(store, dest, share);
      assert.equal(got.ok, true, `${got.reason} at ${height}`);
      if (share) shareCount = store.tip().shareBatch.length;
      if (height % 200 === 0) process.stderr.write(`unbury-grow ${height}\n`);
    }
    assert.equal(store.tip().height, PRUNE);
    assert.ok(shareCount > 0, 'credited block kept its batch');
    const late1 = sealLate(store, dest);
    assert.equal(late1.ok, true, late1.reason || 'late 1');
    const late2 = sealLate(store, dest);
    assert.equal(late2.ok, true, late2.reason || 'late 2');
    assert.equal(store.tip().height, PRUNE + 2);

    const credited = store.blocks[creditHeight - 1];
    assert.equal(credited.height, creditHeight);
    assert.equal(shouldPruneSamples(creditHeight, store.tip().height), true);
    assert.equal(credited.samplesPruned, true);
    assert.equal((credited.shareBatch || []).length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'burial-hold')), true);

    const genesisMs = headerTime(store.blocks[0]);
    const shallow = verifyBlock(credited, parentView(store.blocks[0]), {
      burialTip: creditHeight + PRUNE - 1,
      trustedPowHash: credited.hash,
      skipSharePow: true,
      genesisMs,
      nowMs: Date.now(),
    });
    assert.equal(shallow.ok, false);
    assert.equal(shallow.reason, 'samples_pruned', shallow.reason);
    const peer = verifyBlock(credited, parentView(store.blocks[0]), {
      tipHeight: creditHeight + PRUNE + 40,
      trustedPowHash: credited.hash,
      skipSharePow: true,
      genesisMs,
      nowMs: Date.now(),
    });
    assert.equal(peer.ok, false);
    assert.equal(peer.reason, 'samples_pruned', peer.reason);
    const shortFold = foldSupply(store.blocks.slice(0, creditHeight), {
      tipHeight: creditHeight + PRUNE - 1,
      genesisMs,
    });
    assert.equal(shortFold.ok, false);
    assert.equal(shortFold.reason, 'hash_owed', shortFold.reason);

    const lowParent = 19;
    assert.equal(store.blocks[lowParent].height, 20);
    const easy = forkOne(store, dest, lowParent, { late: true });
    const easyChain = easy.prefix.concat([easy.block]);
    assert.ok(chainWorkOf(easyChain) < chainWorkOf(store.blocks), 'easy fork must lose on work');
    const held = await Promise.resolve(ingest(store, easy.block));
    assert.equal(held.ok, false);
    assert.equal(held.reason, 'side_hold', held.reason || 'easy fork');
    assert.equal(store.tip().height, PRUNE + 2);
    assert.equal(store.blocks[creditHeight - 1].samplesPruned, true, 'a losing fork does not lift the canonical block');

    const disk = createStore(dir);
    // Height PRUNE+2 is not a BOOK_SNAP_EVERY boundary, and a prune does not
    // write a tip snap. Reload replays the suffix after the last snap.
    assert.equal(disk.loadMode, 'suffix', disk.loadMode);
    assert.equal(disk.blocks[creditHeight - 1].samplesPruned, true);
    const diskEasy = forkOne(disk, dest, lowParent, { late: true });
    const fromDisk = await Promise.resolve(ingest(disk, diskEasy.block));
    assert.equal(fromDisk.ok, false);
    assert.equal(fromDisk.reason, 'side_hold', fromDisk.reason || 'hold file');
    assert.equal(disk.tip().height, PRUNE + 2);
    assert.equal(disk.blocks[creditHeight - 1].samplesPruned, true, 'a reloaded hold does not lift until the tip does');

    // No held body: the proven burial still answers, as on a fast-sync node.
    const holdDir = path.join(dir, 'burial-hold');
    fs.renameSync(holdDir, `${holdDir}.off`);
    const bare = createStore(dir);
    assert.equal(bare.blocks[creditHeight - 1].samplesPruned, true);
    assert.equal(bare.burialView().held, 0);
    assert.ok(bare.provenBurialTip(bare.blocks[creditHeight - 1]) >= creditHeight + PRUNE);
    const bareFork = forkOne(bare, dest, lowParent, { late: true });
    const bareHeld = await Promise.resolve(ingest(bare, bareFork.block));
    assert.equal(bareHeld.ok, false);
    assert.equal(bareHeld.reason, 'side_hold', bareHeld.reason || 'missing body');
    assert.equal(bare.tip().height, PRUNE + 2);
    fs.rmSync(holdDir, { recursive: true, force: true });
    fs.renameSync(`${holdDir}.off`, holdDir);

    const parentIndex = PRUNE - 1;
    assert.equal(disk.blocks[parentIndex].height, PRUNE);
    const hard = forkOne(disk, dest, parentIndex, { late: false });
    const hardChain = hard.prefix.concat([hard.block]);
    assert.ok(chainWorkOf(hardChain) > chainWorkOf(disk.blocks), 'hard fork must win on work');
    const adopted = await Promise.resolve(ingest(disk, hard.block));
    assert.equal(adopted.ok, true, adopted.reason || 'adopt');
    assert.equal(disk.tip().height, PRUNE + 1);
    const lifted = disk.blocks[creditHeight - 1];
    assert.equal(lifted.height, creditHeight);
    assert.equal(shouldPruneSamples(creditHeight, disk.tip().height), false);
    assert.notEqual(lifted.samplesPruned, true);
    assert.equal(lifted.shareBatch.length, shareCount);
    const folded = foldSupply(disk.blocks, { tipHeight: disk.tip().height, genesisMs });
    assert.equal(folded.ok, true, folded.reason || 'fold');

    const reloaded = createStore(dir);
    const again = reloaded.blocks[creditHeight - 1];
    assert.notEqual(again.samplesPruned, true, 'reload keeps the lifted batch');
    assert.equal(again.shareBatch.length, shareCount);
    const refolded = foldSupply(reloaded.blocks, {
      tipHeight: reloaded.tip().height,
      genesisMs: headerTime(reloaded.blocks[0]),
    });
    assert.equal(refolded.ok, true, refolded.reason || 'reload fold');
  });
});

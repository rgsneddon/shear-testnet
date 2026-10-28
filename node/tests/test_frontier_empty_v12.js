/**
 * An empty block does not move the frontier. The same root must come back
 * after a reorg, a full restart, and a snapshot load, including a run of
 * empty ancestors around the notes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { GENESIS_BITS_PACKED, TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { fluxsetFromBlocks } from '../../crypto/admit.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import { GENESIS_PREV, buildTemplate } from '../src/chain.js';
import { createStore } from '../src/store.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-frontier-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

function minerDest(tag) {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: tag });
}

function tagHash(n) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(n >>> 0, 4);
  if (!meetsTarget(h, GENESIS_BITS_PACKED)) throw new Error(`tag ${n} misses genesis`);
  return h;
}

function fromTpl(tpl, dest, height, hash) {
  return {
    header: Buffer.from(tpl.header),
    hash,
    height,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    hashCredits: tpl.hashCredits,
    hashSpill: tpl.hashSpill || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

function hex(buf) {
  return Buffer.from(buf).toString('hex');
}

function withEmptyRuns(blocks, run = 32) {
  const empty = { shareBatch: [], txs: [{}] };
  const mixed = [];
  const pad = Array.from({ length: run }, () => empty);
  mixed.push(...pad);
  for (const block of blocks) {
    mixed.push(block, ...pad);
  }
  return mixed;
}

function assertSameFrontier(label, blocks) {
  const notes = fluxsetFromBlocks(blocks);
  const mixed = fluxsetFromBlocks(withEmptyRuns(blocks));
  assert.equal(hex(notes.jroot), hex(mixed.jroot), `${label} jroot`);
  assert.equal(hex(notes.frontier), hex(mixed.frontier), `${label} frontier`);
  assert.equal(hex(notes.zeroRoot), hex(mixed.zeroRoot), `${label} zeroRoot`);
  assert.equal(notes.pubs.length, mixed.pubs.length, `${label} pubs`);
  assert.ok(notes.pubs.length > 0, `${label} notes`);
}

function assertStoreMatches(label, store) {
  const rebuilt = fluxsetFromBlocks(store.blocks);
  const through = store.fluxThrough(store.blocks.length - 1);
  assert.ok(through, `${label} flux`);
  assert.equal(hex(store.jroot()), hex(rebuilt.jroot), `${label} live jroot`);
  assert.equal(hex(through.jroot), hex(rebuilt.jroot), `${label} through jroot`);
  assert.equal(hex(through.frontier), hex(rebuilt.frontier), `${label} through frontier`);
  assert.equal(hex(through.zeroRoot), hex(rebuilt.zeroRoot), `${label} through zero`);
  assertSameFrontier(label, store.blocks);
}

describe('empty-block frontier parity', () => {
  it('keeps one root across empty runs, reorg, restart, and snapshot load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-frontier-empty-'));
    const mainMiner = minerDest(1);
    const forkMiner = minerDest(2);
    const t0 = 1_700_000_000_000;
    const store = createStore(dir);
    const mainTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: mainMiner,
      bits: GENESIS_BITS_PACKED,
      now: t0,
      txs: [],
    });
    const main = fromTpl(mainTpl, mainMiner, 1, tagHash(1));
    const seeded = store.append(main, { trustedPowHash: main.hash, skipSharePow: true });
    assert.equal(seeded.ok, true, seeded.reason || 'main');
    assertStoreMatches('seed', store);

    const fork1Tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: forkMiner,
      bits: GENESIS_BITS_PACKED,
      now: t0,
      txs: [],
    });
    const fork1 = fromTpl(fork1Tpl, forkMiner, 1, tagHash(2));
    const fork2Tpl = buildTemplate({
      prev: fork1.hash,
      prevHeader: fork1.header,
      prevBlock: fork1,
      parentBlocks: [fork1],
      height: 2,
      miner: forkMiner,
      bits: GENESIS_BITS_PACKED,
      now: t0 + TARGET_BLOCK_INTERVAL_MS,
      txs: [],
    });
    const fork2 = fromTpl(fork2Tpl, forkMiner, 2, tagHash(3));
    const adopted = store.ingest([fork1, fork2], { trustBlockHash: true, skipSharePow: true });
    assert.equal(adopted.ok, true, adopted.reason || 'reorg');
    assert.equal(store.tip().height, 2);
    assert.equal(hex(store.tip().hash), hex(fork2.hash));
    assertStoreMatches('reorg', store);

    fs.rmSync(path.join(dir, 'book.snap'), { force: true });
    const restarted = createStore(dir);
    assert.equal(restarted.loadMode, 'full', restarted.loadMode);
    assert.equal(restarted.tip().height, 2);
    assert.equal(hex(restarted.jroot()), hex(store.jroot()));
    assertStoreMatches('restart', restarted);

    restarted.flushBookSnap();
    const snapped = createStore(dir);
    assert.equal(snapped.loadMode, 'snap', snapped.loadMode);
    assert.equal(snapped.tip().height, 2);
    assert.equal(hex(snapped.jroot()), hex(store.jroot()));
    assertStoreMatches('snap', snapped);
  });
});

/**
 * An append whose verify settles later (off the loop, or with EVM calls)
 * re-checks the tip before it stores: if an ingest or adopt moved the tip
 * meanwhile, the block is not stored on top of another chain and comes back
 * prev, which is retryable (lane CA9, 83ea4352, pre-existing).
 *
 * The window is a worker-thread race in production. The first case places
 * the competing ingest inside it on demand, through the store's beforeStore
 * test hook (an awaited step between verify and store, node:test and the
 * regtest book only). The second runs the ingest at several points around an
 * unhooked append and asserts the invariant every time: each stored block's
 * parent is the block below it.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { decodeWireBlock, encodeWireBlock, jsonWire } from '../src/p2p.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

after(() => closeMineWorkers());

const T0 = 1_700_000_000_000;
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));
const relayed = (b) => decodeWireBlock(JSON.parse(jsonWire(encodeWireBlock(b))));

async function mineOn(store, miner, step) {
  const parent = store.tip();
  const now = parent ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + step : T0;
  const { tpl } = store.template({ miner, bits: regtestBitsOverride(MAGIC_REGTEST), shareBits: 4, now });
  const found = await mineHeaderParallel(tpl.header, tpl.bits, 8_192, 1);
  assert.ok(found && found.block, 'need pow');
  const got = await Promise.resolve(store.append({
    header: found.header, txs: tpl.txs, shareBatch: tpl.shareBatch || [], aLeaves: tpl.aLeaves, bLeaves: tpl.bLeaves, rootA: tpl.rootA, rootB: tpl.rootB, weight: tpl.weight,
  }));
  assert.equal(got.ok, true, got.reason);
  return store.tip();
}

function linked(store) {
  for (let i = 1; i < store.blocks.length; i += 1) {
    const prev = Buffer.from(decodeHeader(Buffer.from(store.blocks[i].header)).prevBlockHash);
    if (!prev.equals(Buffer.from(store.blocks[i - 1].hash))) return false;
  }
  return true;
}

describe('an append re-checks the tip before it stores', () => {
  it("a heavier fork adopted between an append's verify and its store leaves that block unstored, as prev", async () => {
    const miner = freshStealthDest(newIdentity()).dest;
    const a = createRegtestStore(tmp('shear-tiphook-a-'), { bits: 4 });
    const g1 = await mineOn(a, miner, 0);
    const a2 = await mineOn(a, miner, 90_000);
    const b = createRegtestStore(tmp('shear-tiphook-b-'), { bits: 4 });
    assert.equal((await Promise.resolve(b.ingest([relayed(g1)]))).ok, true);
    const b2 = await mineOn(b, miner, 30_000);
    const b3 = await mineOn(b, miner, 30_000);
    const v = createRegtestStore(tmp('shear-tiphook-v-'), { bits: 4 });
    assert.equal((await Promise.resolve(v.ingest([relayed(g1)]))).ok, true);
    let moved = null;
    const appended = await Promise.resolve(v.append(relayed(a2), {
      beforeStore: async () => {
        // a2 verified against g1; now the heavier branch takes the tip.
        moved = await Promise.resolve(v.ingest([relayed(b2), relayed(b3)]));
      },
    }));
    assert.equal(moved?.ok, true, `the fork ${moved?.reason}`);
    assert.equal(appended.ok, false);
    assert.equal(appended.reason, 'prev');
    assert.equal(v.tip().height, 3);
    assert.ok(Buffer.from(v.tip().hash).equals(Buffer.from(b3.hash)));
    assert.ok(linked(v), 'every block sits on the block below it');
    assert.equal(v.blocks.some((blk) => Buffer.from(blk.hash).equals(Buffer.from(a2.hash))), false, 'a2 is not stored');
  });

  it('a heavier fork ingested while an append verifies never leaves a block on the wrong parent', async () => {
    const miner = freshStealthDest(newIdentity()).dest;
    // One shared first block, then a one-block branch A and a two-block branch B.
    const a = createRegtestStore(tmp('shear-tipmove-a-'), { bits: 4 });
    const g1 = await mineOn(a, miner, 0);
    const a2 = await mineOn(a, miner, 90_000);
    const b = createRegtestStore(tmp('shear-tipmove-b-'), { bits: 4 });
    assert.equal((await Promise.resolve(b.ingest([relayed(g1)]))).ok, true);
    const b2 = await mineOn(b, miner, 30_000);
    const b3 = await mineOn(b, miner, 30_000);
    for (const ticks of [0, 1, 2, 4, 8, 16]) {
      const v = createRegtestStore(tmp(`shear-tipmove-v${ticks}-`), { bits: 4 });
      assert.equal((await Promise.resolve(v.ingest([relayed(g1)]))).ok, true);
      const pending = Promise.resolve(v.append(relayed(a2), { offLoopPow: true }));
      for (let i = 0; i < ticks; i += 1) await new Promise((r) => setImmediate(r));
      const fork = await Promise.resolve(v.ingest([relayed(b2), relayed(b3)]));
      const appended = await pending;
      assert.ok(linked(v), `ticks ${ticks}: every block sits on the block below it`);
      if (fork.ok) {
        // B won: A's block is not on top of it, whatever order they settled in.
        assert.equal(v.tip().height, 3, `ticks ${ticks}`);
        assert.ok(Buffer.from(v.tip().hash).equals(Buffer.from(b3.hash)), `ticks ${ticks}: B is the tip`);
        if (!appended.ok) assert.equal(appended.reason, 'prev', `ticks ${ticks}: ${appended.reason}`);
      }
    }
  });
});

/**
 * PR 130 burial claim on PR 116's fork loops.
 * A side fork reaches stageOrAdopt, then gateForkHeaders, then
 * verifySuffixBody. The burial row at a height keeps the hash its run was
 * proved for. A block that claims that hash but computes another is pow,
 * on the synchronous gate loop and on the off-loop resume loop. Nothing is
 * buried, staged, or reorged. The same fork with an honest claim adopts, so
 * the refusal comes from the claim and not from anything else.
 *
 * The burial row is passed in as provenBurialAt. No peer path can set it;
 * ensurePrunedBurial builds it from an offered header run. That end to end
 * case is test_feed_fault "a pruned fork cannot borrow a burial".
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

const threads = Math.max(1, Math.min(4, os.cpus().length));
// Four-bit regtest work is about 16 hashes.
const MAX_TRIES = 8_192;
const STEP = 90_000;
const T0 = 1_700_000_000_000;
const CASE_MS = 300_000;

after(() => closeMineWorkers());

function regtestStore(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-fork-claim-${tag}-`));
  return createRegtestStore(dir, { bits: 4 });
}

async function mineOne(store, dest, now) {
  const parent = store.tip();
  const stamp = now ?? (parent ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + STEP : T0);
  const want = regtestBitsOverride(MAGIC_REGTEST);
  const { tpl } = store.template({ miner: dest, bits: want, shareBits: 4, now: stamp });
  const found = await mineHeaderParallel(tpl.header, tpl.bits, MAX_TRIES, threads);
  assert.ok(found && found.block, 'need pow');
  const got = await Promise.resolve(store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }));
  assert.equal(got.ok, true, got.reason);
  return got;
}

function hex(h) {
  return Buffer.from(h).toString('hex');
}

function snapshot(store) {
  return {
    height: Number(store.tip().height),
    tip: hex(store.tip().hash),
    blocks: store.blocks.length,
    side: store.sideTipHash(),
    burial: JSON.stringify(store.burialView()),
  };
}

describe('v12 fork loops keep the burial claim', () => {
  it('a claimed hash that is not the computed hash is pow on both gate loops, and an honest claim adopts', { timeout: CASE_MS }, async () => {
    const localDest = encodeDest(Buffer.alloc(20, 7));
    const peerDest = encodeDest(Buffer.alloc(20, 8));
    const local = regtestStore('local');
    await mineOne(local, localDest);
    const genesis = local.blocks[0];
    const genesisMs = Number(decodeHeader(Buffer.from(genesis.header)).timestamp);
    await mineOne(local, localDest, genesisMs + STEP);

    // The peer shares genesis and mines a heavier branch of three blocks.
    // The second fork block (height 3) carries the claim.
    const peer = regtestStore('peer');
    const joined = await Promise.resolve(peer.ingest([genesis]));
    assert.equal(joined.ok, true, joined.reason);
    for (let i = 0; i < 3; i += 1) await mineOne(peer, peerDest, genesisMs + STEP * (i + 1) + 1_000);
    const fork = peer.blocks.slice(1).map((b) => ({ ...b }));
    assert.equal(fork.length, 3);
    const claimed = randomBytes(32);
    assert.ok(fork.every((b) => !Buffer.from(b.hash).equals(claimed)));

    const before = snapshot(local);
    let reorgs = 0;
    local.on('reorg', () => { reorgs += 1; });

    // Fork index 0 is height 2. With offLoopPow the first header is the
    // resume start, and later headers run in the resume loop. Without it
    // every header runs in the synchronous loop.
    const cases = [];
    for (const at of [0, 1]) {
      const h = at + 2;
      const row = { [h]: { top: h + 1_000, claimed } };
      cases.push({ name: `sync gate loop, claim at ${at}`, at, opts: { provenBurialAt: row } });
      cases.push({
        name: at === 0 ? 'off-loop resume start, claim at 0' : 'off-loop resume loop, claim at 1',
        at,
        opts: { provenBurialAt: row, offLoopPow: true },
      });
    }
    for (const { name, at, opts } of cases) {
      const lied = fork.map((b, i) => (i === at ? { ...b, hash: claimed } : { ...b }));
      const got = await Promise.resolve(local.ingest(lied, opts));
      assert.equal(got.ok, false, `${name}: refused`);
      assert.equal(got.reason, 'pow', `${name}: ${got.reason}`);
      assert.equal(got.at, at, `${name}: the header gate refused block ${at}`);
      assert.deepEqual(snapshot(local), before, `${name}: nothing buried, staged, or moved`);
      assert.equal(reorgs, 0, `${name}: no reorg`);
    }

    // Control: the same branch, with the row proved for the real hash, adopts.
    const honest = { 3: { top: 1_003, claimed: Buffer.from(fork[1].hash) } };
    const adopted = await Promise.resolve(local.ingest(fork.map((b) => ({ ...b })), {
      provenBurialAt: honest,
      offLoopPow: true,
    }));
    assert.equal(adopted.ok, true, adopted.reason);
    assert.equal(hex(local.tip().hash), hex(peer.tip().hash));

    // An empty book adopts the whole chain through verifyFork, whose header
    // gate is the same gateForkHeaders loop.
    const fresh = regtestStore('fresh');
    const whole = peer.blocks.map((b) => ({ ...b }));
    for (const offLoopPow of [false, true]) {
      const lied = whole.map((b, i) => (i === 2 ? { ...b, hash: claimed } : { ...b }));
      const got = await Promise.resolve(fresh.ingest(lied, {
        provenBurialAt: { 3: { top: 1_003, claimed } },
        offLoopPow,
      }));
      assert.equal(got.ok, false, `adopt offLoopPow=${offLoopPow}: refused`);
      assert.equal(got.reason, 'pow', `adopt offLoopPow=${offLoopPow}: ${got.reason}`);
      assert.equal(got.at, 2, `adopt offLoopPow=${offLoopPow}: the header gate refused block 2`);
      assert.equal(fresh.tip(), null, `adopt offLoopPow=${offLoopPow}: the book stays empty`);
      assert.equal(JSON.stringify(fresh.burialView()), JSON.stringify(regtestStore('empty').burialView()));
    }
  });
});

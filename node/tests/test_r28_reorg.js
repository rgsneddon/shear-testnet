// R28: a reorg across a draw. Chain A pays wallet A in block 2; a heavier
// fork from the same genesis pays wallet B in its block 2. Adopting the fork
// removes A's paid notes from the admit set and adds B's, and a restart
// keeps that. Every block and share is real ShearHash-v3 work.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { decodeHeader } from '../../crypto/header.js';
import { newIdentity, encodeDest } from '../../crypto/address.js';
import { admitPubIndex } from '../../crypto/admit.js';
import { bluWallet, mineBluShares, ownBluNotes } from './support/blunote_mine.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const regtestBits = () => regtestBitsOverride(MAGIC_REGTEST);

function lastStamp(store) {
  const tip = store.tip();
  return tip ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) : T0;
}

async function mine(store, miner, shareBatch = [], stepMs = 90_000) {
  const now = Math.max(T0, lastStamp(store) + stepMs);
  const { tpl } = store.template({ miner, bits: regtestBits(), now, shareBatch });
  const found = await mineHeaderParallel(tpl.header, tpl.bits, 8_192, 1);
  assert.ok(found && found.block, 'regtest pow');
  const got = await Promise.resolve(store.append({
    header: found.header,
    height: tpl.height,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }));
  assert.equal(got.ok, true, `append ${got.reason || ''}`);
  return store.tip();
}

function hostDest() {
  const id = newIdentity();
  return encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
}

describe('R28 reorg across a draw', { concurrency: false }, () => {
  const dirs = [];
  after(() => {
    closeMineWorkers();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a heavier fork replaces the paid notes in the admit set, and a restart keeps it', async () => {
    const dirL = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-r28-reorg-l-'));
    const dirF = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-r28-reorg-f-'));
    dirs.push(dirL, dirF);
    const host = hostDest();
    const local = createRegtestStore(dirL, { bits: 4 });
    const g = await mine(local, host);
    // Chain A: block 2 pays wallet A.
    const A = bluWallet();
    const a2 = await mine(local, host, mineBluShares(A, g.header, 2));
    const paidA = ownBluNotes(A, a2.blunoteRecord);
    assert.ok(paidA.length >= 1);
    let known = admitPubIndex(local.fluxset());
    for (const n of paidA) assert.ok(known.has(n.admitPub.toString('hex')), 'A paid before the reorg');
    // The fork: the same genesis, then block 2 pays wallet B, then one more block.
    const fork = createRegtestStore(dirF, { bits: 4 });
    const took = await Promise.resolve(fork.ingest([g]));
    assert.equal(took.ok, true, took.reason);
    const B = bluWallet();
    const f2 = await mine(fork, host, mineBluShares(B, g.header, 2), 91_000);
    await mine(fork, host);
    const paidB = ownBluNotes(B, f2.blunoteRecord);
    assert.ok(paidB.length >= 1);
    // Adopt the heavier fork.
    const got = await Promise.resolve(local.ingest(fork.blocks));
    assert.equal(got.ok, true, got.reason);
    assert.equal(Buffer.from(local.tip().hash).equals(Buffer.from(fork.tip().hash)), true);
    known = admitPubIndex(local.fluxset());
    for (const n of paidA) assert.equal(known.has(n.admitPub.toString('hex')), false, 'A note survived the reorg');
    for (const n of paidB) assert.ok(known.has(n.admitPub.toString('hex')), 'B note missing after the reorg');
    assert.equal(local.blocks[1].blunoteRecord, f2.blunoteRecord, 'the adopted block keeps its record');
    if (typeof local.close === 'function') local.close();
    // A restart reads the adopted chain and the same admit set.
    const again = createRegtestStore(dirL, { bits: 4 });
    const knownAgain = admitPubIndex(again.fluxset());
    for (const n of paidA) assert.equal(knownAgain.has(n.admitPub.toString('hex')), false);
    for (const n of paidB) assert.ok(knownAgain.has(n.admitPub.toString('hex')));
    if (typeof again.close === 'function') again.close();
    if (typeof fork.close === 'function') fork.close();
  });
});

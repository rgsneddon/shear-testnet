// A relay can stall IBD by forging the record of a buried pruned block.
// The forged copy must be refused before it is stored (peerOnly
// blunote_prev, field childProof). The honest copy and its child then
// append, and sync reaches the tip. On this tree the forged copy is stored
// and the honest child stalls. Honest record, and one ingest of the pruned
// parent with its child, stay accepted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { decodeRecord, encodeRecord } from '../../crypto/blunote.js';
import { pruneSamples } from '../../crypto/chronoflux.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { SAMPLE_PRUNE_CONFIRMATIONS } from '../../crypto/asert.js';
import { encodeWireBlock, decodeWireBlock, jsonWire } from '../src/p2p.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

try { setHashBackend('jit'); } catch { /* interpreter */ }
after(() => closeMineWorkers());

const T0 = 1_700_000_000_000;
const STEP = 90_000;
const dirs = [];

function keep(dir) {
  dirs.push(dir);
  return dir;
}

function roundTrip(block) {
  return decodeWireBlock(JSON.parse(jsonWire(encodeWireBlock(block))));
}

function msOf(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

async function grow(store, dest, n) {
  const bits = regtestBitsOverride(MAGIC_REGTEST);
  const copies = [];
  for (let i = 0; i < n; i += 1) {
    const tip = store.tip();
    const now = tip ? msOf(tip) + STEP : T0;
    const { tpl } = store.template({ miner: dest, bits, now });
    const found = await mineHeaderParallel(tpl.header, tpl.bits, 8_192, 1);
    const got = await Promise.resolve(store.append({
      header: found.header,
      hash: found.hash,
      height: tpl.height,
      txs: tpl.txs,
      shareBatch: tpl.shareBatch || [],
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }));
    assert.equal(got.ok, true, got.reason);
    copies.push(roundTrip(store.tip()));
  }
  return copies;
}

function headerOffer(block) {
  return { header: block.header, hash: block.hash };
}

function servedPruned(store, block) {
  const pruned = block?.samplesPruned === true ? block : pruneSamples(block);
  const served = store.servableBlock(pruned);
  assert.equal(served?.samplesPruned, true, 'pruned serve');
  return roundTrip(served);
}

function refusalOf(got) {
  return {
    ok: got?.ok === true,
    reason: got?.reason || null,
    peerOnly: got?.peerOnly === true,
    field: got?.field || null,
  };
}

async function syncRest(store, chain, from) {
  for (let i = from; i < chain.length; i += 1) {
    const got = await Promise.resolve(store.append(roundTrip(chain[i])));
    if (!got.ok) return { ok: false, reason: got.reason, at: i };
  }
  return { ok: true, height: Number(store.tip()?.height) };
}

// A batch is buried by its own length, not by headers offered beside it.
// Height 2 is buried only when that length reaches SAMPLE_PRUNE_CONFIRMATIONS
// above it. The fork is the pruned parent, its child, and the real blocks
// through that tip: one ingest, and the child is in it.
function buriedFork(chain, honest) {
  const fork = [honest];
  const end = SAMPLE_PRUNE_CONFIRMATIONS + 1;
  for (let i = 2; i <= end; i += 1) fork.push(roundTrip(chain[i]));
  return fork;
}

const ready = (async () => {
  const id = newIdentity();
  const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
  const dirA = keep(fs.mkdtempSync(path.join(os.tmpdir(), 'pruned-record-a-')));
  const a = createRegtestStore(dirA, { bits: 4, fastSync: true });
  const N = SAMPLE_PRUNE_CONFIRMATIONS + 4;
  const t0 = Date.now();
  const chain = await grow(a, dest, N);
  const tipHeight = Number(a.tip().height);
  console.log('PRUNED_RECORD grown', N, 'tip', tipHeight, 'ms', Date.now() - t0);
  assert.equal(chain.length, N);
  assert.equal(a.blocks[1].samplesPruned, true, 'height 2 is buried');
  const honest = servedPruned(a, a.blocks[1]);
  console.log('PRUNED_RECORD childProof', honest.childProof ? 'present' : 'absent');
  const rec = decodeRecord(Buffer.from(String(honest.blunoteRecord), 'hex'));
  assert.ok(rec, 'height 2 record decodes');
  const forgeries = {
    W: encodeRecord({ ...rec, W: rec.W + (1n << 40n) }).toString('hex'),
    T: encodeRecord({ ...rec, T: rec.T + 1000n }).toString('hex'),
    batchRoot: encodeRecord({ ...rec, batchRoot: Buffer.alloc(32, 9) }).toString('hex'),
  };
  return { chain, tipHeight, honest, forgeries };
})();

function offerFrom(store, blocks) {
  return store.offerHeaders(blocks.map(headerOffer), { peer: 'pruned-record', tier: 'local' });
}

async function fresh(label, ctx) {
  const dir = keep(fs.mkdtempSync(path.join(os.tmpdir(), `pruned-record-${label}-`)));
  const store = createRegtestStore(dir, { bits: 4, fastSync: false });
  const genesis = await Promise.resolve(store.ingest([roundTrip(ctx.chain[0])]));
  assert.equal(genesis.ok, true, `${label} genesis ${genesis.reason}`);
  const offered = offerFrom(store, ctx.chain.slice(1));
  assert.ok(offered.accepted >= SAMPLE_PRUNE_CONFIRMATIONS, `${label} headers ${offered.accepted}`);
  return store;
}

test('honest pruned record and its child are accepted', async () => {
  const ctx = await ready;
  const store = await fresh('honest', ctx);
  const got = await Promise.resolve(store.append(ctx.honest));
  const child = got.ok ? await Promise.resolve(store.append(roundTrip(ctx.chain[2]))) : null;
  const row = {
    pruned: got.ok ? 'ACCEPTED' : got.reason,
    child: child ? (child.ok ? 'ACCEPTED' : child.reason) : null,
    tipHeight: Number(store.tip()?.height),
  };
  console.log(`PRUNED_RECORD honest ${JSON.stringify(row)}`);
  assert.equal(row.pruned, 'ACCEPTED', 'honest pruned record');
  assert.equal(row.child, 'ACCEPTED', 'honest child');
});

test('pruned parent and its child in one ingest are accepted', async () => {
  const ctx = await ready;
  const store = await fresh('batch', ctx);
  const fork = buriedFork(ctx.chain, ctx.honest);
  const got = await Promise.resolve(store.ingest(fork));
  const tipHeight = Number(store.tip()?.height);
  console.log(`PRUNED_RECORD batch ${JSON.stringify({
    ok: got.ok === true,
    reason: got.ok ? null : got.reason,
    fork: fork.length,
    tipHeight,
    parentPruned: store.blocks[1]?.samplesPruned === true,
    childHeight: Number(store.blocks[2]?.height) || 0,
  })}`);
  assert.equal(got.ok, true, `batch ${got.reason}`);
  assert.equal(tipHeight, 1 + fork.length, 'batch tip');
  assert.equal(store.blocks[1].samplesPruned, true, 'batch kept the pruned parent');
  assert.equal(Number(store.blocks[2].height), 3, 'batch kept the child');
});

async function forgedCase(label, ctx) {
  const store = await fresh(label, ctx);
  const forged = { ...ctx.honest, blunoteRecord: ctx.forgeries[label] };
  const got = await Promise.resolve(store.append(forged));
  const row = { forged: refusalOf(got) };
  if (got.ok) {
    const child = await Promise.resolve(store.append(roundTrip(ctx.chain[2])));
    row.honestChild = child.ok ? 'ACCEPTED' : child.reason;
    row.tipHeight = Number(store.tip()?.height);
    row.stalled = child.ok !== true;
  } else {
    const again = await Promise.resolve(store.append(ctx.honest));
    row.honest = again.ok ? 'ACCEPTED' : again.reason;
    if (again.ok) {
      const child = await Promise.resolve(store.append(roundTrip(ctx.chain[2])));
      row.child = child.ok ? 'ACCEPTED' : child.reason;
      if (child.ok) {
        const rest = await syncRest(store, ctx.chain, 3);
        row.sync = rest.ok ? 'tip' : rest.reason;
        row.tipHeight = Number(store.tip()?.height);
      }
    }
  }
  console.log(`PRUNED_RECORD ${label} ${JSON.stringify(row)}`);
  assert.equal(
    row.forged.ok,
    false,
    `${label} forged copy stored; child ${row.honestChild} tip ${row.tipHeight} stalled ${row.stalled}`,
  );
  assert.equal(row.forged.reason, 'blunote_prev', label);
  assert.equal(row.forged.peerOnly, true, label);
  assert.equal(row.forged.field, 'childProof', label);
  assert.equal(row.honest, 'ACCEPTED', `${label} honest copy`);
  assert.equal(row.child, 'ACCEPTED', `${label} child`);
  assert.equal(row.sync, 'tip', `${label} sync`);
  assert.equal(row.tipHeight, ctx.tipHeight, `${label} tip`);
}

test('forged W is refused before it is stored', async () => {
  await forgedCase('W', await ready);
});

test('forged T is refused before it is stored', async () => {
  await forgedCase('T', await ready);
});

test('forged batchRoot is refused before it is stored', async () => {
  await forgedCase('batchRoot', await ready);
});

// A multi-block fork whose last block is pruned has no child in the batch.
// Burial is the offered header run, not the batch length. A forged record
// is refused before anything is stored.
test('a fork batch whose last block is pruned is refused', async () => {
  const ctx = await ready;
  const dir = keep(fs.mkdtempSync(path.join(os.tmpdir(), 'pruned-record-fork-')));
  const store = createRegtestStore(dir, { bits: 4, fastSync: false });
  const offered = offerFrom(store, ctx.chain);
  assert.ok(offered.accepted >= SAMPLE_PRUNE_CONFIRMATIONS, `fork headers ${offered.accepted}`);
  const forged = { ...ctx.honest, blunoteRecord: ctx.forgeries.W };
  const got = await Promise.resolve(store.ingest([roundTrip(ctx.chain[0]), forged]));
  const row = {
    ...refusalOf(got),
    tipHeight: store.tip() ? Number(store.tip().height) : 0,
  };
  console.log(`PRUNED_RECORD forkTail ${JSON.stringify(row)}`);
  assert.equal(row.ok, false, `fork tail ${row.reason}`);
  assert.equal(row.reason, 'blunote_prev', 'fork tail');
  assert.equal(row.peerOnly, true, 'fork tail');
  assert.equal(row.field, 'childProof', 'fork tail');
  assert.equal(row.tipHeight, 0, 'fork tail stored nothing');
});

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

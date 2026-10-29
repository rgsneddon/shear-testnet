// A relay can stall IBD by forging the record of a buried pruned block.
// The forged copy must be refused before it is stored (peerOnly
// blunote_prev, field childProof). The honest copy and its child then
// append, and sync reaches the tip. On 377788c4 the forged copy is stored
// and the honest child stalls; this file is that failure, committed first.
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

function isChildProofRefusal(got) {
  return got?.ok === false
    && got.reason === 'blunote_prev'
    && got.peerOnly === true
    && got.field === 'childProof';
}

async function syncRest(store, chain, from) {
  for (let i = from; i < chain.length; i += 1) {
    const got = await Promise.resolve(store.append(roundTrip(chain[i])));
    if (!got.ok) return { ok: false, reason: got.reason, at: i };
  }
  return { ok: true, height: Number(store.tip()?.height) };
}

test('forged pruned record is refused before it is stored', async () => {
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

  const offerFrom = (store, blocks) => store.offerHeaders(blocks.map(headerOffer), { peer: 'pruned-record', tier: 'local' });

  async function fresh(label) {
    const dir = keep(fs.mkdtempSync(path.join(os.tmpdir(), `pruned-record-${label}-`)));
    const store = createRegtestStore(dir, { bits: 4, fastSync: false });
    const genesis = await Promise.resolve(store.ingest([roundTrip(chain[0])]));
    assert.equal(genesis.ok, true, `${label} genesis ${genesis.reason}`);
    const offered = offerFrom(store, chain.slice(1));
    assert.ok(offered.accepted >= SAMPLE_PRUNE_CONFIRMATIONS, `${label} headers ${offered.accepted}`);
    return store;
  }

  const out = {};

  {
    const store = await fresh('honest');
    const got = await Promise.resolve(store.append(honest));
    const child = got.ok ? await Promise.resolve(store.append(roundTrip(chain[2]))) : null;
    out.honest = {
      pruned: got.ok ? 'ACCEPTED' : got.reason,
      child: child ? (child.ok ? 'ACCEPTED' : child.reason) : null,
      tipHeight: Number(store.tip()?.height),
    };
  }

  {
    const store = await fresh('batch');
    const got = await Promise.resolve(store.ingest([honest, roundTrip(chain[2])]));
    out.batch = {
      ok: got.ok === true,
      reason: got.ok ? null : got.reason,
      tipHeight: Number(store.tip()?.height),
    };
  }

  for (const [label, forgedHex] of Object.entries(forgeries)) {
    const store = await fresh(label);
    const forged = { ...honest, blunoteRecord: forgedHex };
    const got = await Promise.resolve(store.append(forged));
    const row = { forged: refusalOf(got) };
    if (got.ok) {
      const child = await Promise.resolve(store.append(roundTrip(chain[2])));
      row.honestChild = child.ok ? 'ACCEPTED' : child.reason;
      row.tipHeight = Number(store.tip()?.height);
      row.stalled = child.ok !== true;
    } else {
      const again = await Promise.resolve(store.append(honest));
      row.honest = again.ok ? 'ACCEPTED' : again.reason;
      if (again.ok) {
        const child = await Promise.resolve(store.append(roundTrip(chain[2])));
        row.child = child.ok ? 'ACCEPTED' : child.reason;
        if (child.ok) {
          const rest = await syncRest(store, chain, 3);
          row.sync = rest.ok ? 'tip' : rest.reason;
          row.tipHeight = Number(store.tip()?.height);
        }
      }
    }
    out[label] = row;
  }

  {
    const dir = keep(fs.mkdtempSync(path.join(os.tmpdir(), 'pruned-record-fork-')));
    const store = createRegtestStore(dir, { bits: 4, fastSync: false });
    const offered = offerFrom(store, chain);
    assert.ok(offered.accepted >= SAMPLE_PRUNE_CONFIRMATIONS, `fork headers ${offered.accepted}`);
    const forged = { ...honest, blunoteRecord: forgeries.W };
    const got = await Promise.resolve(store.ingest([roundTrip(chain[0]), forged]));
    out.forkTail = {
      ...refusalOf(got),
      tipHeight: store.tip() ? Number(store.tip().height) : 0,
    };
  }

  console.log(`PRUNED_RECORD ${JSON.stringify(out)}`);

  assert.equal(out.honest.pruned, 'ACCEPTED', 'honest pruned record');
  assert.equal(out.honest.child, 'ACCEPTED', 'honest child');
  assert.equal(out.batch.ok, true, `batch ${out.batch.reason}`);

  for (const label of ['W', 'T', 'batchRoot']) {
    const row = out[label];
    assert.equal(row.forged.ok, false, `${label} forged copy stored`);
    assert.equal(row.forged.reason, 'blunote_prev', label);
    assert.equal(row.forged.peerOnly, true, label);
    assert.equal(row.forged.field, 'childProof', label);
    assert.equal(row.honest, 'ACCEPTED', `${label} honest copy`);
    assert.equal(row.child, 'ACCEPTED', `${label} child`);
    assert.equal(row.sync, 'tip', `${label} sync`);
    assert.equal(row.tipHeight, tipHeight, `${label} tip`);
  }

  assert.equal(out.forkTail.ok, false, 'fork tail stored a pruned record');
  assert.equal(out.forkTail.reason, 'blunote_prev', 'fork tail');
  assert.equal(out.forkTail.peerOnly, true, 'fork tail');
  assert.equal(out.forkTail.field, 'childProof', 'fork tail');
  assert.equal(out.forkTail.tipHeight, 0, 'fork tail stored nothing');
});

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

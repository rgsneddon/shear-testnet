/**
 * Live-tip soak helpers: hit RPC, then drive shipped reorg / Reserve / vort1
 * paths via the same createStore the node uses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createStore } from './src/store.js';
import { mineTemplate, shouldAdopt, verifyBlock, buildTemplate, GENESIS_PREV } from './src/chain.js';
import { decodeHeader } from '../crypto/header.js';
import { setHashBackend } from '../crypto/shear_hash.js';
try { setHashBackend('jit'); } catch { /* interpreter */ }
import { GENESIS_BITS_PACKED, bitsForBlock, SPENDABLE_CONFIRMATIONS, PI_SHE_NANOS, MAGIC_TESTNET } from '../crypto/asert.js';
import { newIdentity, destOpeningFromView, freshStealthDest, encodeDest, ed25519SeedOf } from '../crypto/address.js';
import { vaultDest } from '../crypto/flow_sheet.js';
import { lockTx, voteTx, VOTE_INCREASE } from '../crypto/reserve_vault.js';
import { bindWeightFee } from '../crypto/levy.js';
import { signSpendTx } from '../crypto/spend.js';
import { levyNanos } from '../crypto/levy.js';
import { gateVorticeRegister, vorticeRegisterTx } from '../crypto/vortex.js';

const rpc = (process.env.SHEAR_RPC || 'http://127.0.0.1:18332').replace(/\/$/, '');
const step = process.argv[2] || 'all';

async function getJson(p) {
  const res = await fetch(`${rpc}${p}`);
  return res.json();
}

function mineOne(store, dest, _bits, now) {
  const parent = store.tip();
  const stamp = now != null
    ? now
    : (parent ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000 : Date.now());
  let packed = GENESIS_BITS_PACKED;
  if (parent) {
    const ph = decodeHeader(Buffer.from(parent.header));
    packed = bitsForBlock(ph.bits, ph.timestamp, stamp);
  }
  const share = Math.max(4, Math.floor(Number(packed) / 65536));
  const t0 = Date.now();
  const { tpl } = store.template({ miner: dest, bits: packed, shareBits: share, now: stamp });
  // shareBits 32: only packed header bits count as a block. Equal integer
  // share==block bits used to return the first 12-lz as block:false.
  console.error(JSON.stringify({
    event: 'soak_tpl',
    ms: Date.now() - t0,
    packed,
    tplBits: tpl.bits,
    headerLen: Buffer.from(tpl.header).length,
    share,
  }));
  const t1 = Date.now();
  const found = mineTemplate(tpl, { maxTries: 8_000_000, shareBits: 32 });
  console.error(JSON.stringify({
    event: 'soak_mined',
    ms: Date.now() - t1,
    block: !!(found && found.block),
    nonce: found?.nonce != null ? String(found.nonce) : null,
  }));
  assert.ok(found && found.block, 'pow');
  return store.append({
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
  });
}

async function live() {
  const stats = await getJson('/stats');
  const fp = await getJson('/fingerprint');
  const jr = await getJson('/jroot');
  assert.equal(stats.magic, MAGIC_TESTNET);
  assert.equal(stats.admit, 'ADMITv2');
  assert.match(String(fp.fingerprint || ''), /ADMIT=ADMITv2/);
  assert.match(String(fp.fingerprint || ''), /RANGE=bpplus/);
  assert.match(String(fp.fingerprint || ''), /LEVY=weight/);
  assert.match(String(fp.fingerprint || ''), /SHARE_BIND=rx\+noteCommit/);
  console.log(JSON.stringify({ step: 'live', stats, jroot: jr.jroot, fingerprint: fp.fingerprint }));
  return stats;
}

async function reorgN() {
  const dest = encodeDest(Buffer.alloc(20, 9));
  const local = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-soak-reorg-a-')));
  assert.equal((await mineOne(local, dest)).ok, true);
  const events = [];
  local.on('reorg', (e) => events.push(e));
  const n = Math.max(2, SPENDABLE_CONFIRMATIONS);
  for (let i = 0; i < n; i += 1) assert.equal((await mineOne(local, dest)).ok, true);
  const heavier = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-soak-reorg-b-')));
  const need = local.tip().height + 1;
  for (let i = 0; i < need; i += 1) assert.equal((await mineOne(heavier, dest)).ok, true);
  assert.equal(shouldAdopt(local.blocks, heavier.blocks), true);
  const got = await local.ingest(heavier.blocks);
  assert.equal(got.ok, true, got.reason);
  assert.equal(got.reorg, true);
  assert.equal(local.tip().height, need);
  assert.ok(events.length >= 1);
  assert.ok(events[0].depth >= 1);
  console.log(JSON.stringify({
    step: 'reorg',
    n: need,
    depth: events[0].depth,
    height: local.tip().height,
    ok: true,
  }));
}

async function reserveLockVote() {
  const alice = newIdentity();
  const pay = freshStealthDest(alice.paymentCode);
  const dest = pay.dest;
  const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
  const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
  const box = { dest, key: { type: 'ed25519-stealth', seed: ed25519SeedOf(alice.privateKey), shared: pay.shared } };
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-soak-reserve-')));
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 4 + SPENDABLE_CONFIRMATIONS; i += 1) {
    await mineOne(store, dest, undefined, t0 + i * 90_000);
  }
  const lock = lockTx({ from: dest, to: vault, nanos: PI_SHE_NANOS, id: 'soak-lock' });
  lock.open = open;
  bindWeightFee(lock);
  lock.maxLevy = lock.fee;
  signSpendTx(lock, box.key);
  const q = store.queueTx(lock);
  assert.equal(q.ok, true, q.reason);
  await mineOne(store, dest, undefined, t0 + (4 + SPENDABLE_CONFIRMATIONS) * 90_000);
  assert.ok(Number(store.reserveVault.totalLockedNanos) >= PI_SHE_NANOS);
  const vt = voteTx({ from: dest, dest: vault, choice: VOTE_INCREASE, id: 'soak-vote' });
  vt.open = open;
  vt.portalOpen = open;
  bindWeightFee(vt);
  vt.maxLevy = vt.fee;
  vt.payer = dest;
  signSpendTx(vt, box.key);
  const qv = store.queueTx(vt);
  assert.equal(qv.ok, true, qv.reason);
  await mineOne(store, dest, undefined, t0 + (5 + SPENDABLE_CONFIRMATIONS) * 90_000);
  assert.equal(store.reserveVault.votes.increase, 1);
  console.log(JSON.stringify({
    step: 'reserve',
    locked: String(store.reserveVault.totalLockedNanos),
    votesIncrease: store.reserveVault.votes.increase,
    ok: true,
  }));
}

async function vort1() {
  const dest = encodeDest(Buffer.alloc(20, 7));
  const L = levyNanos(0);
  const bad = vorticeRegisterTx({ from: dest, bytesHash: 'ab'.repeat(32), vort1: 'vort1.bad', ticker: 'SHE', fee: L });
  assert.equal(gateVorticeRegister(bad).ok, false);
  const okTx = vorticeRegisterTx({ from: dest, bytesHash: 'cd'.repeat(32), vort1: 'vort1.ok-dapp', ticker: 'ABC', fee: L });
  assert.equal(gateVorticeRegister(okTx).ok, true);
  const failTpl = buildTemplate({ prev: GENESIS_PREV, height: 1, miner: dest, bits: GENESIS_BITS_PACKED, now: Date.now(), txs: [bad] });
  const failFound = mineTemplate(failTpl, { maxTries: 3_000_000, shareBits: 12 });
  const failOk = verifyBlock({ header: failFound.header, txs: failTpl.txs, samples: failTpl.samples, height: 1 }, null);
  assert.equal(failOk.ok, false);
  const goodTpl = buildTemplate({ prev: GENESIS_PREV, height: 1, miner: dest, bits: GENESIS_BITS_PACKED, now: Date.now(), txs: [okTx] });
  const goodFound = mineTemplate(goodTpl, { maxTries: 3_000_000, shareBits: 12 });
  const goodOk = verifyBlock({ header: goodFound.header, txs: goodTpl.txs, samples: goodTpl.samples, height: 1 }, null);
  assert.equal(goodOk.ok, true, goodOk.reason);
  console.log(JSON.stringify({ step: 'vort1', reject: failOk.reason, accept: true, ok: true }));
}

const run = {
  live,
  reorg: reorgN,
  reserve: reserveLockVote,
  vort1,
};

if (step === 'all') {
  await live();
  await reorgN();
  await reserveLockVote();
  await vort1();
} else if (run[step]) {
  await run[step]();
} else {
  console.error('usage: soak_vps.js [live|reorg|reserve|vort1|all]');
  process.exit(2);
}

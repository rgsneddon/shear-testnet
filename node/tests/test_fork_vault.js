import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  PI_SHE_NANOS,
  SPENDABLE_CONFIRMATIONS,
} from '../../crypto/asert.js';
import { lockTx, portalIdFromDest, cloneVault, emptyVault, applyReserveBlock } from '../../crypto/reserve_vault.js';
import { vaultDest } from '../../crypto/flow_sheet.js';
import { newIdentity, destOpeningFromView, freshStealthDest, ed25519SeedOf } from '../../crypto/address.js';
import { signSpendTx } from '../../crypto/spend.js';
import { bindWeightFee } from '../../crypto/levy.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
try { setHashBackend('jit'); } catch { /* interpreter */ }

function spendBox(id) {
  const pay = freshStealthDest(id);
  return {
    dest: pay.dest,
    key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared },
  };
}

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[1] = powTag & 0x0f;
  h[2] = (powTag >> 4) & 0xff;
  h[3] = (powTag >> 12) & 0xff;
  powTag += 1;
  return h;
}

async function mineOne(store, dest, { now } = {}) {
  const parent = store.tip();
  const stamp = now != null
    ? now
    : (parent
      ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
      : Date.now());
  const { tpl } = store.template({ miner: dest, shareBits: 4, now: stamp });
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
  }, { trustedPowHash: easyPowHash(), skipSharePow: true });
}

function vaultSnap(v) {
  return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
}

describe('fork trial vault (VS-R1)', () => {
  it('verifyFork clones empty vault at fork root and applyReserveBlock on the trial, not tip saveReserve', () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    assert.match(src, /function trialVaultAtForkRoot\(/);
    assert.match(src, /function trialVaultForFork\(/);
    assert.match(src, /cloneVault\(emptyVault\(\)\)/);
    assert.match(src, /applyReserveBlock\(\{ state: trialVault, block: lean/);
    assert.match(src, /verifyOneForkBlock\(fork, i, accepted, trialSpent, null, trialVault\)/);
    assert.equal(/applyReserveBlock\(\{\s*state:\s*reserveVault/.test(src.split('function verifyFork')[1]?.split('function adopt')[0] || ''), false);
    assert.equal(/saveReserve\(\)/.test(src.split('function verifyFork')[1]?.split('function adopt')[0] || ''), false);
  });

  it('append lock still credits the tip vault', { timeout: 600_000 }, async () => {
    const alice = newIdentity();
    const box = spendBox(alice);
    const continuum = box.dest;
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-vault-append-')));
    const t0 = 1_700_000_000_000;
    const fund = 4 + SPENDABLE_CONFIRMATIONS;
    for (let i = 0; i < fund; i += 1) {
      const got = await Promise.resolve(mineOne(store, continuum, { now: t0 + i * 90_000 }));
      assert.equal(got.ok, true, got.reason);
    }
    assert.equal(Number(store.reserveVault.totalLockedNanos), 0);
    const lock = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-tip' });
    lock.open = open;
    bindWeightFee(lock);
    lock.maxLevy = lock.fee;
    signSpendTx(lock, box.key);
    const queued = store.queueTx(lock);
    assert.equal(queued.ok, true, queued.reason);
    const sealed = await Promise.resolve(mineOne(store, continuum, { now: t0 + fund * 90_000 }));
    assert.equal(sealed.ok, true, sealed.reason);
    assert.equal(Number(store.reserveVault.totalLockedNanos), PI_SHE_NANOS);
    assert.equal(Number(store.reserveVault.portals[portalIdFromDest(vault)].staked), PI_SHE_NANOS);
  });

  it('a lock on a lighter fork is applied only on the trial; tip vault stays empty', { timeout: 600_000 }, async () => {
    const alice = newIdentity();
    const box = spendBox(alice);
    const continuum = box.dest;
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    const t0 = 1_700_100_000_000;
    const local = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-vault-local-')));
    const peer = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-vault-peer-')));
    const fund = 4 + SPENDABLE_CONFIRMATIONS;
    for (let i = 0; i < fund; i += 1) {
      assert.equal((await Promise.resolve(mineOne(peer, continuum, { now: t0 + i * 90_000 }))).ok, true);
    }
    const lock = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-fork' });
    lock.open = open;
    bindWeightFee(lock);
    lock.maxLevy = lock.fee;
    signSpendTx(lock, box.key);
    const queued = peer.queueTx(lock);
    assert.equal(queued.ok, true, queued.reason);
    assert.equal((await Promise.resolve(mineOne(peer, continuum, { now: t0 + fund * 90_000 }))).ok, true);
    assert.equal(Number(peer.reserveVault.totalLockedNanos), PI_SHE_NANOS);

    for (let i = 0; i < fund + 2; i += 1) {
      assert.equal((await Promise.resolve(mineOne(local, continuum, { now: t0 + i * 90_000 }))).ok, true);
    }
    const before = vaultSnap(local.reserveVault);
    assert.equal(Number(local.reserveVault.totalLockedNanos), 0);
    const trial = cloneVault(emptyVault());
    if (peer.reserveVault?.oracle) trial.oracle = JSON.parse(JSON.stringify(peer.reserveVault.oracle));
    for (const b of peer.blocks) {
      applyReserveBlock({
        state: trial,
        block: b,
        nowMs: Number(decodeHeader(Buffer.from(b.header)).timestamp),
      });
    }
    assert.equal(Number(trial.totalLockedNanos), PI_SHE_NANOS);
    const got = await Promise.resolve(local.ingest(peer.blocks));
    assert.equal(got.ok, false);
    assert.equal(Number(local.reserveVault.totalLockedNanos), 0);
    assert.equal(local.reserveVault.portals[portalIdFromDest(vault)], undefined);
    assert.equal(vaultSnap(local.reserveVault), before);
    assert.equal(Number(peer.reserveVault.totalLockedNanos), PI_SHE_NANOS);
  });

  it('refused invalid fork does not mutate a tip vault that already locked', { timeout: 600_000 }, async () => {
    const alice = newIdentity();
    const box = spendBox(alice);
    const continuum = box.dest;
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    const t0 = 1_700_200_000_000;
    const local = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-vault-locked-')));
    const fund = 4 + SPENDABLE_CONFIRMATIONS;
    for (let i = 0; i < fund; i += 1) {
      assert.equal((await Promise.resolve(mineOne(local, continuum, { now: t0 + i * 90_000 }))).ok, true);
    }
    const lock = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-keep' });
    lock.open = open;
    bindWeightFee(lock);
    lock.maxLevy = lock.fee;
    signSpendTx(lock, box.key);
    assert.equal(local.queueTx(lock).ok, true);
    assert.equal((await Promise.resolve(mineOne(local, continuum, { now: t0 + fund * 90_000 }))).ok, true);
    assert.equal(Number(local.reserveVault.totalLockedNanos), PI_SHE_NANOS);
    const before = vaultSnap(local.reserveVault);

    const fork = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fork-vault-bad-')));
    assert.equal((await Promise.resolve(mineOne(fork, continuum, { now: t0 }))).ok, true);
    assert.equal((await Promise.resolve(mineOne(fork, continuum, { now: t0 + 90_000 }))).ok, true);
    const last = fork.blocks[1];
    const poisoned = fork.blocks.map((b, i) => (i !== 1 ? b : {
      ...b,
      txs: [{
        ...last.txs[0],
        vout: (last.txs[0].vout || []).map((o) => ({ ...o, address: alice.address })),
      }],
    }));
    const refused = await Promise.resolve(local.ingest(poisoned));
    assert.equal(refused.ok, false);
    assert.equal(Number(local.reserveVault.totalLockedNanos), PI_SHE_NANOS);
    assert.equal(vaultSnap(local.reserveVault), before);
  });
});

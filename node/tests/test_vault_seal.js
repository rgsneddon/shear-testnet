import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { decodeHeader } from '../../crypto/header.js';
import { PI_SHE_NANOS, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { reorgBreaksCheckpoint } from '../src/bootstrap.js';
import { reorgBreaksVaultSeal, chainHasSealAncestry } from '../../crypto/vault_seal.js';
import { lockTx, portalIdFromDest } from '../../crypto/reserve_vault.js';
import { vaultDest } from '../../crypto/flow_sheet.js';
import { newIdentity, destOpeningFromView, freshStealthDest, ed25519SeedOf } from '../../crypto/address.js';
import { signSpendTx } from '../../crypto/spend.js';
import { bindWeightFee } from '../../crypto/levy.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { BOOTSTRAP_FIRST_HEIGHT, BOOTSTRAP_EVERY_BLOCKS } from '../src/bootstrap.js';
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

describe('store.js vault-seal control flow', () => {
  it('adopt refuses a seal-breaking fork before replayVault; that fork gets no vault', () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    assert.match(src, /function trialVaultForFork\(/);
    assert.match(src, /function trialVaultAtForkRoot\(/);
    const forkFn = src.split('function trialVaultForFork')[1]?.split('function verifyOneForkBlock')[0] || '';
    assert.match(forkFn, /noVault: true/);
    assert.doesNotMatch(forkFn, /emptyVault\(/);
    assert.doesNotMatch(forkFn, /blankFork = true/);
    assert.match(src, /cloneVault\(emptyVault\(\)\)/);
    assert.match(src, /reorgBreaksVaultSeal\(/);
    assert.match(src, /reason: 'reorg_vault_seal'/);
    const adopt = src.split('function finishAdopt')[1]?.split('function ingest')[0] || '';
    assert.match(adopt, /reorg_vault_seal/);
    const replayIdx = adopt.indexOf('replayVault()');
    const sealIdx = adopt.indexOf('reorg_vault_seal');
    assert.ok(sealIdx >= 0 && replayIdx > sealIdx, 'reorg_vault_seal must run before replayVault');
    assert.match(src, /if \(vaultSeal && blocks\.length && !chainHasSealAncestry\(blocks, vaultSeal\)\)/);
    const dart = fs.readFileSync(new URL('../../wallet/lib/main.dart', import.meta.url), 'utf8');
    assert.match(dart, /continuum-vault-seal-banner/);
    const ledger = fs.readFileSync(new URL('../../wallet/lib/shear_ledger.dart', import.meta.url), 'utf8');
    assert.match(ledger, /vault_seal_banner/);
    assert.match(ledger, /blank_fork/);
  });
});

describe('checkpoint-bound Reserve on the store', () => {
  it('tip below the freeze has no seal and an empty banner', () => {
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-seal-low-')));
    const p = store.getpolicy();
    assert.equal(p.vault_seal_ancestry, true);
    assert.equal(p.vault_seal_banner, '');
    assert.equal(p.blank_fork, false);
    assert.equal(p.vault_seal_height, 0);
    assert.equal(store.vaultSeal(), null);
    assert.equal(BOOTSTRAP_FIRST_HEIGHT, 1000);
    assert.equal(BOOTSTRAP_EVERY_BLOCKS, 400);
  });

  it('shallow reorg above the seal keeps portals; pre-seal heavier fork is refused and the pot stays', { timeout: 600_000 }, async () => {
    const alice = newIdentity();
    const box = spendBox(alice);
    const continuum = box.dest;
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    const t0 = 1_700_300_000_000;
    const firstCheckpoint = 12;
    const local = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-seal-local-')), {
      firstCheckpoint,
      checkpointEvery: 400,
    });
    const fund = 4 + SPENDABLE_CONFIRMATIONS;
    for (let i = 0; i < fund; i += 1) {
      const got = await Promise.resolve(mineOne(local, continuum, { now: t0 + i * 90_000 }));
      assert.equal(got.ok, true, got.reason);
    }
    const lock = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-seal' });
    lock.open = open;
    bindWeightFee(lock);
    lock.maxLevy = lock.fee;
    signSpendTx(lock, box.key);
    assert.equal(local.queueTx(lock).ok, true, 'lock must queue');
    while (local.tip().height < firstCheckpoint + 2) {
      const h = local.tip().height;
      const got = await Promise.resolve(mineOne(local, continuum, { now: t0 + h * 90_000 }));
      assert.equal(got.ok, true, got.reason);
    }
    assert.ok(local.tip().height > firstCheckpoint);
    assert.equal(Number(local.reserveVault.totalLockedNanos), PI_SHE_NANOS);
    const seal = local.vaultSeal();
    assert.equal(seal.height, firstCheckpoint);
    assert.equal(local.getpolicy().vault_seal_ancestry, true);
    assert.equal(local.getpolicy().vault_seal_banner, '');
    assert.equal(local.getpolicy().blank_fork, false);
    assert.equal(chainHasSealAncestry(local.blocks, seal), true);

    const from = local.blocks;
    const shallow = from.map((b) => (
      Number(b.height) > firstCheckpoint ? { ...b, hash: Buffer.alloc(32, 9) } : b
    ));
    assert.equal(reorgBreaksVaultSeal(from, shallow, seal), null);
    assert.equal(reorgBreaksCheckpoint(from, shallow, { first: firstCheckpoint, every: 400 }), null);
    assert.equal(chainHasSealAncestry(shallow, seal), true);

    const deep = from.map((b) => (
      Number(b.height) >= firstCheckpoint - 1 ? { ...b, hash: Buffer.alloc(32, 11) } : b
    ));
    const hit = reorgBreaksVaultSeal(from, deep, seal);
    assert.equal(hit.reason, 'reorg_vault_seal');
    assert.equal(hit.height, firstCheckpoint);
    const cp = reorgBreaksCheckpoint(from, deep, { first: firstCheckpoint, every: 400 });
    assert.equal(cp.height, firstCheckpoint);

    const before = vaultSnap(local.reserveVault);
    const attacker = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-seal-atk-')), {
      firstCheckpoint,
      checkpointEvery: 400,
    });
    const need = local.tip().height + 3;
    for (let i = 0; i < need; i += 1) {
      const got = await Promise.resolve(mineOne(attacker, continuum, { now: t0 + 9_000_000 + i * 90_000 }));
      assert.equal(got.ok, true, got.reason);
    }
    assert.equal(reorgBreaksVaultSeal(from, attacker.blocks, seal).reason, 'reorg_vault_seal');
    const refused = await Promise.resolve(local.ingest(attacker.blocks));
    assert.equal(refused.ok, false);
    assert.equal(Number(local.reserveVault.totalLockedNanos), PI_SHE_NANOS);
    assert.equal(vaultSnap(local.reserveVault), before);
    assert.equal(Number(local.reserveVault.portals[portalIdFromDest(vault)].staked), PI_SHE_NANOS);
  });

  it('boot replayVault keeps the sealed pot when ancestry holds', { timeout: 600_000 }, async () => {
    const alice = newIdentity();
    const box = spendBox(alice);
    const continuum = box.dest;
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    const t0 = 1_700_400_000_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-seal-boot-'));
    const firstCheckpoint = 12;
    const store = createStore(dir, { firstCheckpoint, checkpointEvery: 400 });
    const fund = 4 + SPENDABLE_CONFIRMATIONS;
    for (let i = 0; i < fund; i += 1) {
      assert.equal((await Promise.resolve(mineOne(store, continuum, { now: t0 + i * 90_000 }))).ok, true);
    }
    const lock = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-boot' });
    lock.open = open;
    bindWeightFee(lock);
    lock.maxLevy = lock.fee;
    signSpendTx(lock, box.key);
    assert.equal(store.queueTx(lock).ok, true);
    while (store.tip().height < firstCheckpoint) {
      const h = store.tip().height;
      assert.equal((await Promise.resolve(mineOne(store, continuum, { now: t0 + h * 90_000 }))).ok, true);
    }
    assert.equal(Number(store.reserveVault.totalLockedNanos), PI_SHE_NANOS);
    const again = createStore(dir, { firstCheckpoint, checkpointEvery: 400 });
    assert.equal(Number(again.reserveVault.totalLockedNanos), PI_SHE_NANOS);
    assert.equal(again.vaultSeal().height, firstCheckpoint);
    assert.equal(again.getpolicy().vault_seal_ancestry, true);
  });
});

/**
 * The vault-seal control flow in store.js, and the policy a fresh store reports
 * below the first checkpoint. The reorg and boot-replay cases stay in
 * test_vault_seal.js, which waits for PR 2's regtest vault reorg.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { CHECKPOINT_FIRST_HEIGHT, CHECKPOINT_EVERY_BLOCKS } from '../src/bootstrap.js';

describe('store.js vault-seal control flow', () => {
  it('adopt refuses a seal-breaking fork before replayVault; that fork gets no vault', () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    assert.match(src, /function trialVaultForFork\(/);
    assert.match(src, /function trialVaultAtForkRoot\(/);
    const forkFn = src.split('function trialVaultForFork')[1]?.split('function verifyOneForkBlock')[0] || '';
    assert.match(forkFn, /noVault: true/);
    assert.doesNotMatch(forkFn, /emptyVault\(/);
    assert.doesNotMatch(forkFn, /blankFork = true/);
    // d0de60e2 seeds every trial from bookVault(): emptyVault() plus the book
    // magic. The fork root still starts empty, never from the tip reserveVault.
    const bookFn = src.split('function bookVault()')[1]?.split('function unitsOnBook')[0] || '';
    assert.match(bookFn, /const vault = emptyVault\(\);/);
    assert.match(bookFn, /vault\.magic = bookMagic;/);
    const rootFn = src.split('function trialVaultAtForkRoot')[1]?.split('function trialVaultForFork')[0] || '';
    assert.match(rootFn, /cloneVault\(bookVault\(\)\)/);
    assert.doesNotMatch(rootFn, /cloneVault\(reserveVault\)/);
    assert.match(src, /reorgBreaksVaultSeal\(/);
    assert.match(src, /reason: 'reorg_vault_seal'/);
    const adopt = src.split('function finishAdopt')[1]?.split('function ingest')[0] || '';
    assert.match(adopt, /reorg_vault_seal/);
    // 45ef3301 then 6ac0b45a replaced the adopt replayVault() with a vault
    // staged from the LCA. The seal refusal still runs before any vault work.
    const sealIdx = adopt.indexOf('reorg_vault_seal');
    const parentIdx = adopt.indexOf('vaultParent(');
    const stageIdx = adopt.indexOf('stageAdoptVault(');
    assert.equal(adopt.includes('replayVault()'), false);
    assert.ok(sealIdx >= 0 && parentIdx > sealIdx && stageIdx > sealIdx, 'reorg_vault_seal must run before the vault is staged');
    assert.match(src, /if \(vaultSeal && blocks\.length && !chainHasSealAncestry\(blocks, vaultSeal\)\)/);
    const dart = fs.readFileSync(new URL('../../wallet/lib/main.dart', import.meta.url), 'utf8');
    assert.match(dart, /continuum-vault-seal-banner/);
    const ledger = fs.readFileSync(new URL('../../wallet/lib/shear_ledger.dart', import.meta.url), 'utf8');
    assert.match(ledger, /vault_seal_banner/);
    assert.match(ledger, /blank_fork/);
  });
});

describe('checkpoint-bound Reserve on a fresh store', () => {
  it('tip below the freeze has no seal and an empty banner', () => {
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-seal-low-')));
    const p = store.getpolicy();
    assert.equal(p.vault_seal_ancestry, true);
    assert.equal(p.vault_seal_banner, '');
    assert.equal(p.blank_fork, false);
    assert.equal(p.vault_seal_height, 0);
    assert.equal(store.vaultSeal(), null);
    assert.equal(CHECKPOINT_FIRST_HEIGHT, 1000);
    assert.equal(CHECKPOINT_EVERY_BLOCKS, 400);
  });

});

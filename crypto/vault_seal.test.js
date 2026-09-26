import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVault, cloneVault, deposit, verifyReservePayout, withdraw, applyReserveBlock, publicVaultView, withdrawTx } from './reserve_vault.js';
import { PI_SHE_NANOS } from './asert.js';
import { newIdentity } from './address.js';
import { vaultDest } from './flow_sheet.js';
import {
  vaultCommitment,
  makeVaultSeal,
  chainHasSealAncestry,
  reorgBreaksVaultSeal,
  vaultSealBanner,
} from './vault_seal.js';
import { BOOTSTRAP_FIRST_HEIGHT, BOOTSTRAP_EVERY_BLOCKS, bootstrapCheckpoint, reorgBreaksCheckpoint } from '../node/src/bootstrap.js';

function destOf(id) {
  return vaultDest(id.address, { viewKey: id.viewKey });
}

function chain(n, hashByte = 1, genesisByte = 7) {
  return Array.from({ length: n }, (_, i) => ({
    height: i + 1,
    hash: Buffer.alloc(32, i === 0 ? genesisByte : (hashByte + i) % 255 || 1),
  }));
}

describe('vault seal commitment', () => {
  it('is stable for empty vaults and changes when the pot moves', () => {
    const a = vaultCommitment(emptyVault());
    const b = vaultCommitment(cloneVault(emptyVault()));
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
    const id = newIdentity();
    const dest = destOf(id);
    const st = emptyVault();
    const t0 = 1_700_000_000_000;
    assert.equal(deposit({ state: st, dest, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    const c = vaultCommitment(st);
    assert.notEqual(c, a);
    const again = vaultCommitment(cloneVault(st));
    assert.equal(again, c);
  });

  it('binds height, checkpoint hash, commitment, and optional genesis', () => {
    const commit = vaultCommitment(emptyVault());
    const hash = Buffer.alloc(32, 9);
    const genesis = Buffer.alloc(32, 3);
    const s = makeVaultSeal({ height: 1000, hash, commitment: commit, genesisHash: genesis });
    assert.equal(s.height, 1000);
    assert.equal(s.hash, hash.toString('hex'));
    assert.equal(s.commitment, commit);
    assert.equal(s.genesisHash, genesis.toString('hex'));
    assert.match(s.id, /^[0-9a-f]{64}$/);
    const other = makeVaultSeal({ height: 1000, hash: Buffer.alloc(32, 8), commitment: commit, genesisHash: genesis });
    assert.notEqual(other.id, s.id);
  });
});

describe('seal ancestry and adopt guard', () => {
  it('tip below 1000 has no seal; ancestry is vacuously true', () => {
    assert.equal(bootstrapCheckpoint(999), 0);
    assert.equal(bootstrapCheckpoint(1000), 1000);
    assert.equal(bootstrapCheckpoint(1399), 1000);
    assert.equal(bootstrapCheckpoint(1400), 1400);
    assert.equal(BOOTSTRAP_FIRST_HEIGHT, 1000);
    assert.equal(BOOTSTRAP_EVERY_BLOCKS, 400);
    assert.equal(chainHasSealAncestry(chain(999), null), true);
    assert.equal(reorgBreaksVaultSeal(chain(999), chain(1000, 2), null), null);
    assert.equal(vaultSealBanner({ seal: null, ancestry: true, tipHeight: 999 }), '');
    assert.equal(vaultSealBanner({ seal: null, ancestry: false, tipHeight: 999, first: 1000 }), '');
  });

  it('shallow reorg above the seal keeps ancestry; pre-seal diverge breaks it', () => {
    const from = chain(1008);
    const seal = makeVaultSeal({
      height: 1000,
      hash: from[999].hash,
      commitment: vaultCommitment(emptyVault()),
      genesisHash: from[0].hash,
    });
    assert.equal(chainHasSealAncestry(from, seal), true);
    const shallow = from.map((b) => (b.height >= 1005 ? { ...b, hash: Buffer.alloc(32, 9) } : b));
    assert.equal(chainHasSealAncestry(shallow, seal), true);
    assert.equal(reorgBreaksVaultSeal(from, shallow, seal), null);
    assert.equal(reorgBreaksCheckpoint(from, shallow), null);

    const deep = from.map((b) => (b.height >= 999 ? { ...b, hash: Buffer.alloc(32, 11) } : b));
    assert.equal(chainHasSealAncestry(deep, seal), false);
    const hit = reorgBreaksVaultSeal(from, deep, seal);
    assert.equal(hit.reason, 'reorg_vault_seal');
    assert.equal(hit.height, 1000);
    assert.equal(hit.hash, Buffer.from(from[999].hash).toString('hex'));
    const cp = reorgBreaksCheckpoint(from, deep);
    assert.equal(cp.height, 1000);
  });

  it('heavier seal-breaking fork is refused; the from-chain pot is not the to-chain problem', () => {
    const from = chain(1400);
    const seal = makeVaultSeal({
      height: 1400,
      hash: from[1399].hash,
      commitment: 'abc',
      genesisHash: from[0].hash,
    });
    const heavier = chain(1405, 4);
    heavier[0] = { ...from[0] };
    const broken = reorgBreaksVaultSeal(from, heavier, seal);
    assert.equal(broken.reason, 'reorg_vault_seal');
    assert.equal(chainHasSealAncestry(from, seal), true);
    assert.equal(chainHasSealAncestry(heavier, seal), false);
  });

  it('optional vault-genesis: a different genesis fails ancestry', () => {
    const from = chain(1000, 1, 7);
    const seal = makeVaultSeal({
      height: 1000,
      hash: from[999].hash,
      commitment: 'x',
      genesisHash: from[0].hash,
    });
    const otherGenesis = chain(1000, 1, 8);
    otherGenesis[999] = { height: 1000, hash: from[999].hash };
    assert.equal(chainHasSealAncestry(from, seal), true);
    assert.equal(chainHasSealAncestry(otherGenesis, seal), false);
  });
});

describe('fork has no vault', () => {
  it('a fork does not mint a vault and the master pot stays', () => {
    const id = newIdentity();
    const dest = destOf(id);
    const live = emptyVault();
    const t0 = 1_700_000_000_000;
    assert.equal(deposit({ state: live, dest, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    const tx = withdrawTx({ from: dest, to: dest, nanos: PI_SHE_NANOS, id: 'w1' });
    tx.nowMs = t0 + 500 * 86_400_000;
    const pay = verifyReservePayout(null, tx);
    assert.equal(pay.ok, false);
    assert.equal(pay.reason, 'no_vault');
    const w = withdraw({ state: null, dest, nowMs: tx.nowMs });
    assert.equal(w.ok, false);
    assert.equal(w.reason, 'no_vault');
    const applied = applyReserveBlock({
      state: null,
      block: { txs: [tx] },
      nowMs: tx.nowMs,
    });
    assert.deepEqual(applied, []);
    assert.equal(Number(live.totalLockedNanos), PI_SHE_NANOS);
    const view = publicVaultView(live, t0);
    assert.equal(view.blankFork, false);
    assert.equal(Number(view.totalLockedNanos), PI_SHE_NANOS);
  });

  it('banner is empty until the first freeze; then says the fork has no vault', () => {
    const seal = makeVaultSeal({ height: 1000, hash: Buffer.alloc(32, 1), commitment: 'c' });
    assert.equal(vaultSealBanner({ seal, ancestry: true, tipHeight: 1200 }), '');
    const line = vaultSealBanner({ seal, ancestry: false, tipHeight: 1200 });
    assert.match(line, /height 1000/);
    assert.match(line, /no Reserve vault/);
    assert.doesNotMatch(line, /blank/i);
    assert.equal(vaultSealBanner({ seal, ancestry: false, tipHeight: 0 }), '');
  });
});

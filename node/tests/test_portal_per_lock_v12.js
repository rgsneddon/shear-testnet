/**
 * One portal per lock. r = H(tag, seed, lockIndex) and each lock pays a
 * fresh dest20. Consensus refuses a second credit of that portal id.
 * Pinned at 71f2e3ef: two lockTx calls from one seed shared one portal id
 * and one address dest20, and a second deposit was accepted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519PrivateFromSeed, ed25519RawPub, hash20FromAddress, newIdentity, spendDestOf } from '../../crypto/address.js';
import { RESERVE_EPOCH_MS } from '../../crypto/asert.js';
import {
  deposit,
  emptyVault,
  lockTx,
  portalDest20FromSeed,
  portalIdFromDest,
  portalIdFromDest20,
  portalsFromSeed,
  signWithdrawReward,
  withdrawRewardRejected,
  withdrawTx,
} from '../../crypto/reserve_vault.js';
import { reserveAuth, signSpendTx } from '../../crypto/spend.js';

function destOf(id) {
  return spendDestOf(id.spendPub);
}

function hex20(raw) {
  return Buffer.from(raw).subarray(0, 20).toString('hex');
}

describe('one portal per lock', () => {
  it('two locks from one seed are two portals and two dest20s', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const seed = alice.spendSeed;
    const vault = destOf(bob);
    const payer = destOf(alice);
    const rows = portalsFromSeed(seed, 2);
    const ownerKey = ed25519PrivateFromSeed(rows[0].spendSeed);
    const ownerPub = ed25519RawPub(ownerKey).toString('hex');
    const first = lockTx({ from: payer, to: vault, nanos: 1000, id: 'lock-0', spendSeed: seed, lockIndex: 0, ownerPub });
    const secondPub = ed25519RawPub(ed25519PrivateFromSeed(rows[1].spendSeed)).toString('hex');
    const second = lockTx({ from: payer, to: vault, nanos: 1000, id: 'lock-1', spendSeed: seed, lockIndex: 1, ownerPub: secondPub });
    assert.equal(first.portalId.length, 64);
    assert.notEqual(first.portalId, second.portalId);
    assert.notEqual(hex20(first.vout[0].dest20), hex20(second.vout[0].dest20));
    const identity = hash20FromAddress(vault).toString('hex');
    assert.notEqual(hex20(first.vout[0].dest20), identity);
    assert.notEqual(hex20(second.vout[0].dest20), identity);
    assert.notEqual(first.portalId, portalIdFromDest(vault));
    assert.equal(hex20(first.vout[0].dest20), portalDest20FromSeed(seed, 0).toString('hex'));
    assert.equal(hex20(second.vout[0].dest20), portalDest20FromSeed(seed, 1).toString('hex'));
    assert.equal(first.portalId, portalIdFromDest20(first.vout[0].dest20));
    assert.equal(second.portalId, portalIdFromDest20(second.vout[0].dest20));

    const found = portalsFromSeed(seed, 2);
    assert.equal(found.length, 2);
    assert.equal(found[0].portalId, first.portalId);
    assert.equal(found[1].portalId, second.portalId);
    assert.equal(found[0].dest20.toString('hex'), hex20(first.vout[0].dest20));
    assert.equal(found[1].dest20.toString('hex'), hex20(second.vout[0].dest20));
    const again = portalsFromSeed(seed, 2);
    assert.equal(again[0].portalId, found[0].portalId);
    assert.equal(again[1].portalId, found[1].portalId);

    // The spend sig binds the lockAuth key. The identity `from` is a different dest.
    first.from = spendDestOf(ed25519RawPub(ownerKey));
    first.vin = [{ dest20: Buffer.from(rows[0].dest20) }];
    signSpendTx(first, ownerKey);
    const auth = reserveAuth(first, emptyVault());
    assert.equal(auth.ok, true, auth.reason);
  });

  it('consensus refuses a duplicate portal id and a wrong-key withdraw', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const seed = alice.spendSeed;
    const vault = destOf(bob);
    const payer = destOf(alice);
    const ownerPub = Buffer.from(ed25519RawPub(alice.privateKey)).toString('hex');
    const first = lockTx({ from: payer, to: vault, nanos: 1000, id: 'dup-0', spendSeed: seed, lockIndex: 0 });
    const second = lockTx({ from: payer, to: vault, nanos: 1000, id: 'dup-1', spendSeed: seed, lockIndex: 1 });
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    const opened = deposit({
      state, portalId: first.portalId, dest: vault, nanos: 1000, nowMs: t0, ownerPub,
    });
    assert.equal(opened.ok, true, opened.reason);
    const dup = deposit({
      state, portalId: first.portalId, dest: vault, nanos: 1000, nowMs: t0 + 1, ownerPub,
    });
    assert.equal(dup.ok, false, 'duplicate portal was accepted');
    assert.equal(dup.reason, 'portal_exists');
    const other = deposit({
      state, portalId: second.portalId, dest: vault, nanos: 1000, nowMs: t0 + 2, ownerPub,
    });
    assert.equal(other.ok, true, other.reason);

    const later = t0 + RESERVE_EPOCH_MS + 1;
    const bad = withdrawTx({
      from: vault, to: payer, nanos: 1000, id: 'wd-wrong-key', portalId: first.portalId, spendSeed: seed,
    });
    signWithdrawReward(bad, bob.privateKey, {
      portalId: first.portalId, nanos: 1000, dest: payer, state, nowMs: later,
    });
    bad.ownerPub = ownerPub;
    const refused = withdrawRewardRejected(state, bad, later);
    assert.ok(refused, 'wrong-key withdraw was accepted');
    assert.equal(refused.reason, 'unsigned');
  });
});

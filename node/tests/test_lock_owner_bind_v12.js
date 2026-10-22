/**
 * A later lock signed by a different key, carrying the recorded ownerPub,
 * is unsigned. A fresh lock requires ownerPub == spendPub.
 * Pinned at 71f2e3ef: reserveAuth accepted the copied ownerPub.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { destCommitFromSpendPub, newIdentity, spendDestOf } from '../../crypto/address.js';
import { RESERVE_PROGRAM } from '../../crypto/asert.js';
import { emptyVault, portalIdFromDest } from '../../crypto/reserve_vault.js';
import { reserveAuth, signSpendTx } from '../../crypto/spend.js';
import { bootReserveEvm, callReserve, encodeDeposit, encodePinClock } from '../../crypto/reserve_evm.js';

function who() {
  const id = newIdentity();
  const pub = Buffer.from(id.spendPub).toString('hex');
  return { id, pub, dest: spendDestOf(id.spendPub) };
}

function signedLock(signer, portalId, ownerPub) {
  const d20 = destCommitFromSpendPub(signer.id.spendPub);
  const tx = {
    id: `lock-${portalId.slice(0, 8)}-${ownerPub.slice(0, 6)}`,
    kind: 'lock',
    programId: RESERVE_PROGRAM,
    portalId,
    ownerPub,
    from: signer.dest,
    vin: [{ dest20: Buffer.from(d20), address: signer.dest }],
    vout: [{ kind: 'lock', dest20: Buffer.from(d20) }],
  };
  signSpendTx(tx, signer.id.privateKey);
  return tx;
}

describe('later lock owner binding', () => {
  it('a later lock signed by another key with a copied ownerPub is unsigned', () => {
    const owner = who();
    const stranger = who();
    const portalId = portalIdFromDest(owner.dest);
    const state = emptyVault();
    state.portals[portalId] = { ownerPub: owner.pub };
    const spoof = signedLock(stranger, portalId, owner.pub);
    assert.equal(spoof.spendPub, stranger.pub);
    assert.equal(spoof.ownerPub, owner.pub);
    assert.notEqual(spoof.spendPub, spoof.ownerPub);
    const got = reserveAuth(spoof, state);
    assert.equal(got.ok, false, 'copied ownerPub was accepted');
    assert.equal(got.reason, 'unsigned');
    const honest = signedLock(owner, portalId, owner.pub);
    assert.equal(reserveAuth(honest, state).ok, true, reserveAuth(honest, state).reason);
  });

  it('a fresh lock requires ownerPub == spendPub', () => {
    const owner = who();
    const stranger = who();
    const portalId = portalIdFromDest(stranger.dest);
    const state = emptyVault();
    const spoof = signedLock(stranger, portalId, owner.pub);
    const got = reserveAuth(spoof, state);
    assert.equal(got.ok, false, 'fresh lock took a foreign ownerPub');
    assert.equal(got.reason, 'unsigned');
    const honest = signedLock(stranger, portalId, stranger.pub);
    assert.equal(reserveAuth(honest, state).ok, true, reserveAuth(honest, state).reason);
  });

  it('the EVM refuses a later lock signed by another key', async () => {
    const owner = who();
    const stranger = who();
    const session = await bootReserveEvm();
    const t0 = 1_700_000_000_000;
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    const id = Buffer.alloc(32, 4);
    const first = await callReserve(session, encodeDeposit(id, Buffer.alloc(32, 9), t0, { key: owner.id.privateKey }, false));
    assert.equal(first.ok, true, first.reason);
    const copied = await callReserve(session, encodeDeposit(id, Buffer.alloc(32, 8), t0 + 1, { key: stranger.id.privateKey }, false));
    assert.equal(copied.ok, false, 'EVM accepted a later lock from another key');
    assert.equal(copied.reason, 'unsigned');
    const again = await callReserve(session, encodeDeposit(id, Buffer.alloc(32, 7), t0 + 2, { key: owner.id.privateKey }, false));
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'portal_exists');
  });
});

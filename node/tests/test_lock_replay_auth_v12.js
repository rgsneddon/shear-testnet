/**
 * A compact FS-1 lock has no spendPub. Replay still binds the owner through
 * lockAuth. A copied ownerPub does not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { destCommitFromSpendPub, newIdentity } from '../../crypto/address.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { portalIdFromDest20 } from '../../crypto/reserve_vault.js';
import { reserveAuth, signSpendTx } from '../../crypto/spend.js';
import { RESERVE_PROGRAM } from '../../crypto/asert.js';

describe('compact FS-1 lock replay', { timeout: 20000 }, () => {
  it('a compact lock with no spendPub still authorises the owner', () => {
    const who = newIdentity();
    const ownerPub = Buffer.from(who.spendPub).toString('hex');
    const note = Buffer.alloc(64, 7);
    const commit = Buffer.from(note.subarray(32, 64));
    const d20 = destCommitFromSpendPub(who.spendPub);
    const portalId = portalIdFromDest20(d20);
    const tx = {
      id: 'replay-lock',
      kind: 'lock',
      programId: RESERVE_PROGRAM,
      portalId,
      ownerPub,
      vaultLockNote: note,
      fs1: Buffer.from([0xf1, 0x01]),
      vin: [{ commit: Buffer.alloc(32, 1) }],
      vout: [{
        kind: 'lock',
        commit,
        dest20: Buffer.from(d20),
        portalId,
      }],
      admit_proofs: [{
        blob: Buffer.from([0xf1]),
        cTilde: Buffer.alloc(32, 2),
        spendTag: Buffer.alloc(32, 3),
      }],
    };
    signSpendTx(tx, who.privateKey);
    delete tx.spendPub;
    delete tx.sig;
    delete tx.signature;
    assert.equal(tx.spendPub, undefined, 'replay spendPub');
    assert.equal(tx.sig, undefined, 'replay sig');
    assert.equal(tx.signature, undefined, 'replay signature');
    const sealed = compactTx(tx);
    assert.equal(sealed.spendPub, undefined);
    assert.ok(sealed.lockAuth);
    const again = reserveAuth(sealed);
    assert.equal(again.ok, true, again.reason || 'compact replay');
    const copied = compactTx({ ...tx, ownerPub: '11'.repeat(32) });
    delete copied.spendPub;
    const spoof = reserveAuth(copied);
    assert.equal(spoof.ok, false);
    assert.equal(spoof.reason, 'unsigned');
  });
});

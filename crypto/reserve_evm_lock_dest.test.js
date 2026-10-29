/**
 * A Reserve lock with no dest is refused, on the direct EVM path and on the
 * block path. Every lock the block path accepts still reaches the EVM.
 *
 * executeReserveTx used to return ok for a lock it could not key. The block
 * path never let one through: reserveAuth needs freshLockBound for a fresh
 * portal, which needs the lock output's dest20, and a lock on a portal that
 * already has an owner is portal_exists. So refusing it does not change which
 * blocks are valid.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PI_SHE_NANOS, RESERVE_PROGRAM } from './asert.js';
import { destCommitFromSpendPub, newIdentity } from './address.js';
import { commit, pointBytes, proveRange, randomScalar } from './note.js';
import { reserveAuth } from './spend.js';
import { emptyVault, portalIdFromDest20 } from './reserve_vault.js';
import {
  attachLockAuth,
  bootReserveEvm,
  callReserve,
  encodePinClock,
  executeBlockEvm,
  executeReserveTx,
} from './reserve_evm.js';

const NOW = 1_700_000_000_000;

function lockBody(extra = {}) {
  const blind = randomScalar();
  return {
    kind: 'lock',
    programId: RESERVE_PROGRAM,
    nanos: PI_SHE_NANOS,
    piProof: proveRange(0n, blind),
    vout: [{ kind: 'lock', commit: pointBytes(commit(BigInt(PI_SHE_NANOS), blind)) }],
    ...extra,
  };
}

/** A compact FS-1 lock on a fresh portal, as the wallet sends it. */
function boundLock() {
  const who = newIdentity();
  const d20 = Buffer.from(destCommitFromSpendPub(who.spendPub));
  const tx = lockBody({ fs1: Buffer.from([0xf1, 7, 1]), portalId: portalIdFromDest20(d20) });
  tx.vout[0].dest20 = d20;
  attachLockAuth(tx, who.privateKey, 'shear-testnet-v12');
  assert.ok(tx.lockAuth, 'lockAuth');
  tx.ownerPub = Buffer.from(tx.lockAuth).subarray(0, 32).toString('hex');
  return tx;
}

async function session() {
  const s = await bootReserveEvm({ network: 'shear-testnet-v12' });
  assert.equal((await callReserve(s, encodePinClock(NOW))).ok, true);
  return s;
}

describe('a Reserve lock with no dest fails closed', () => {
  it('the EVM refuses it directly and inside a block', async () => {
    const tx = lockBody();
    const direct = await executeReserveTx(await session(), tx, NOW);
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, 'lock_dest');
    const block = await executeBlockEvm(await session(), [{ coinbase: true, vout: [] }, tx], NOW, NOW);
    assert.equal(block.ok, false);
    assert.equal(block.reason, 'lock_dest');
  });

  it('the block path refuses it before the EVM, with or without an FS-1 blob', () => {
    for (const extra of [{}, { fs1: Buffer.from([0xf1, 7, 1]) }]) {
      const tx = lockBody(extra);
      const auth = reserveAuth(tx, emptyVault(), new Map());
      assert.equal(auth.ok, false, JSON.stringify(Object.keys(extra)));
      assert.equal(auth.reason, 'unsigned');
    }
  });

  it('a lock the block path accepts is keyed and runs on the EVM', async () => {
    const tx = boundLock();
    const auth = reserveAuth(tx, emptyVault(), new Map());
    assert.equal(auth.ok, true, auth.reason);
    const ran = await executeReserveTx(await session(), tx, NOW);
    assert.notEqual(ran.reason, 'lock_dest');
    assert.equal(ran.ok, true, ran.reason);
    // The same lock with its dest20 stripped loses both.
    const bare = boundLock();
    delete bare.vout[0].dest20;
    assert.equal(reserveAuth(bare, emptyVault(), new Map()).ok, false);
    assert.equal((await executeReserveTx(await session(), bare, NOW)).reason, 'lock_dest');
  });
});

/**
 * Review pass: a fee note is not a reward claim, a vote does not carry its
 * funding, an unindexed matured commitment is not a receipt, and a snapshot
 * that lost the lock index rebuilds it from the notes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS } from './asert.js';
import { encodeDest, destCommitFromSpendPub, newIdentity } from './address.js';
import { pickOwnedFeeNotes } from './leaf_vote.js';
import { admitMempool, emptyMempool } from './mempool.js';
import { randomScalar } from './note.js';
import {
  applyLeafVote,
  deposit,
  emptyVault,
  lockTx,
  portalIdFromDest,
  trialReserveApply,
  withdraw,
} from './reserve_vault.js';
import { vaultLockNote } from './vault_reward_fs1.js';

const T0 = 1_700_000_000_000;

function owner() {
  const id = newIdentity();
  const dest = encodeDest(destCommitFromSpendPub(id.spendPub), id.admitBase);
  return { id, dest, pub: Buffer.from(id.spendPub).toString('hex') };
}

describe('vault review pass', () => {
  it('skips reward-claim notes and lock notes when it picks a fee', () => {
    const send = '11'.repeat(32);
    const notes = [
      { commit: 'aa'.repeat(32), kind: 'reward-claim', parentTx: 'claim' },
      { commit: 'bb'.repeat(32), kind: 'lock', parentTx: 'lock' },
      { commit: send, kind: 'send', parentTx: 'pay' },
    ];
    assert.deepEqual(pickOwnedFeeNotes(notes, 1, () => 0), [send]);
    assert.equal(pickOwnedFeeNotes([
      { commit: 'aa'.repeat(32), kind: 'reward-claim' },
      { commit: 'bb'.repeat(32), kind: 'lock' },
    ], 1, () => 0), null);
  });

  it('refuses a leaf vote that carries the fee note or its parent', () => {
    const leaked = ['feeInput', 'parentTx', 'parent'];
    for (const key of leaked) {
      const tx = {
        kind: 'leaf-vote',
        id: `leak-${key}`,
        fee: 1,
        voteProof: Buffer.alloc(8, 1),
        [key]: key === 'feeInput' ? 'ab'.repeat(32) : 'parent-tx',
      };
      const pooled = admitMempool(emptyMempool(), tx, { height: 20, reserveState: emptyVault() });
      assert.equal(pooled.ok, false, key);
      assert.equal(pooled.reason, 'vote_leak', key);
      const applied = applyLeafVote(emptyVault(), tx, 20);
      assert.equal(applied.ok, false, key);
      assert.equal(applied.reason, 'vote_leak', key);
    }
  });

  it('refuses an unindexed matured commitment', () => {
    const who = owner();
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const opened = deposit({
      state,
      dest: who.dest,
      nanos: PI_SHE_NANOS,
      nowMs: T0,
      ownerPub: who.pub,
    });
    assert.equal(opened.ok, true, opened.reason);
    const portal = state.portals[portalIdFromDest(who.dest)];
    assert.ok(portal.tranches.length === 1);
    const commit = portal.tranches[0].commit;
    assert.equal(state.vaultLockIndex?.[commit], undefined);
    const paid = withdraw({
      state,
      dest: who.dest,
      portalId: portal.id,
      nowMs: T0 + RESERVE_EPOCH_MS,
      payout: who.dest,
    });
    assert.equal(paid.ok, false);
    assert.equal(paid.reason, 'stake_reward');
  });

  it('rebuilds the lock index from lock notes when a trial rolls back', () => {
    const who = owner();
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const leaf = vaultLockNote(PI_SHE_NANOS, randomScalar(), randomScalar(), 16);
    assert.ok(leaf);
    const noteHex = Buffer.from(leaf.note).toString('hex');
    const commitHex = Buffer.from(leaf.note).subarray(32, 64).toString('hex');
    state.vaultLockNotes = [noteHex];
    state.vaultLockIndex = Object.create(null);
    const tx = lockTx({ to: who.dest, nanos: 1, id: 'index-miss', ownerPub: who.pub });
    const got = trialReserveApply({
      state,
      txs: [tx],
      nowMs: T0,
      inPlace: true,
      height: 2,
      genesisMs: T0,
    });
    assert.equal(got.ok, false);
    assert.equal(state.vaultLockIndex[commitHex], noteHex);
  });
});

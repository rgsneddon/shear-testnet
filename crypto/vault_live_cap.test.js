/**
 * Vault Y row (b): the live-leaf cap and FS-1 proofs at the cap's depth.
 *
 * Real π leaves (vaultLockNote), the real FS-1 vault tree, and a real leaf
 * vote proved over every one of them. Today's cap is MAX_LIVE_VAULT_LEAVES:
 * one holder can fill it, and then a second holder's leaf is refused. That
 * is the row (b) finding, pinned here so the Stage 2 change (no stock cap)
 * has to flip it on purpose.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC_TESTNET, MAX_LIVE_VAULT_LEAVES, PI_SHE_NANOS } from './asert.js';
import { appendVaultLockNote, commitVaultLockRoot, emptyVault, EMPTY_VAULT_ROOT } from './reserve_vault.js';
import { proveLeafVote, verifyLeafVote, vaultLockNote } from './vault_reward_fs1.js';
import { proposalId } from './leaf_vote.js';
import { fs1NativeLoaded } from './native_admit.js';

const UNLOCK = 32;

/** n real π leaves of one holder: scalars and blinds from one seed. */
function holderLeaves(n, seed) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const scalar = BigInt(seed) * 1_000_003n + BigInt(i) + 7n;
    const blind = BigInt(seed) * 7_000_001n + BigInt(i) + 11n;
    const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, UNLOCK);
    assert.ok(leaf, `leaf ${i}`);
    rows.push({ leaf, lock: { amount: PI_SHE_NANOS, scalar, blind, unlockEpoch: UNLOCK } });
  }
  return rows;
}

describe('vault live-leaf cap and proofs at depth', { concurrency: false, timeout: 900_000 }, () => {
  if (!fs1NativeLoaded()) {
    it('needs the native FS-1 addon', () => assert.fail('shear_admit FS-1 addon is not loaded'));
    return;
  }
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  const whale = holderLeaves(MAX_LIVE_VAULT_LEAVES, 1);

  it(`one holder fills the cap: ${MAX_LIVE_VAULT_LEAVES} leaves append, each moving the root`, () => {
    assert.equal(state.vaultLockRoot, EMPTY_VAULT_ROOT);
    let prev = state.vaultLockRoot;
    for (const [i, row] of whale.entries()) {
      const root = appendVaultLockNote(state, row.leaf.note, { bornEpoch: 1, unlockEpoch: UNLOCK, lockHeight: 100 + i });
      assert.ok(root, `append ${i}`);
      assert.notEqual(root, prev, `root moves at ${i}`);
      prev = root;
    }
    assert.equal(state.vaultLockNotes.length, MAX_LIVE_VAULT_LEAVES);
  });

  it('at the cap, a second holder\'s real π leaf is refused (today\'s cap; Stage 2 removes it)', () => {
    const [other] = holderLeaves(1, 2);
    const before = state.vaultLockRoot;
    assert.equal(appendVaultLockNote(state, other.leaf.note, { bornEpoch: 1, unlockEpoch: UNLOCK }), null);
    assert.equal(state.vaultLockRoot, before, 'root unchanged');
    assert.equal(state.vaultLockNotes.length, MAX_LIVE_VAULT_LEAVES, 'no slot taken');
  });

  it('a rebuild from the notes gives the same root as the incremental appends', () => {
    const live = state.vaultLockRoot;
    state.vaultLockDirty = true;
    assert.equal(commitVaultLockRoot(state), live);
  });

  it(`a real leaf vote proves at depth ${MAX_LIVE_VAULT_LEAVES} against the vault root, and a wrong root refuses it`, () => {
    const epoch = 3;
    const pid = proposalId(epoch, 'hb');
    const which = MAX_LIVE_VAULT_LEAVES - 1;
    const proved = proveLeafVote({
      locks: whale.map((row) => row.lock),
      which,
      epoch,
      choice: 1,
      seq: 1,
      proposalId: pid,
      dest20: Buffer.alloc(20, 5),
    });
    assert.ok(proved, 'vote proof');
    assert.equal(proved.rootHex, state.vaultLockRoot, 'the prover rebuilt the chain root');
    const ok = verifyLeafVote({ blob: proved.blob, root: Buffer.from(state.vaultLockRoot, 'hex'), epoch, choice: 1, seq: 1, proposalId: pid });
    assert.equal(ok.ok, true, ok.reason);
    // The root of the first cap−1 leaves: the same proof does not verify there.
    const shorter = emptyVault();
    shorter.magic = MAGIC_TESTNET;
    for (const row of whale.slice(0, -1)) assert.ok(appendVaultLockNote(shorter, row.leaf.note, { bornEpoch: 1, unlockEpoch: UNLOCK }));
    const bad = verifyLeafVote({ blob: proved.blob, root: Buffer.from(shorter.vaultLockRoot, 'hex'), epoch, choice: 1, seq: 1, proposalId: pid });
    assert.equal(bad.ok, false, 'refused against a root without the leaf');
  });
});

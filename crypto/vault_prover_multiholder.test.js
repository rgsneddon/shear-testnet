/**
 * Regression (fails today): with two holders on one vault, holder A's vote
 * and claim proofs must verify against the chain's vault root.
 *
 * proveLeafVote and proveVaultReward build the FS-1 tree from the caller's
 * own locks only (vault_reward_fs1.js:1175, :1507), so with a second holder
 * the proof's root is A's private subset, not the chain root. The Dart
 * provers do the same (wallet/lib/shear_vault_reward.dart:338, :625); not
 * covered here, noted for Grok.
 *
 * Real π leaves on a real vault state (appendVaultLockNote). A regtest
 * chain-level version waits on PR 2: a regtest lock block fails `supply`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS } from './asert.js';
import { appendVaultLockNote, emptyVault } from './reserve_vault.js';
import { proveLeafVote, proveVaultReward, verifyLeafVote, vaultLockNote } from './vault_reward_fs1.js';
import { proposalId } from './leaf_vote.js';
import { fs1NativeLoaded } from './native_admit.js';

const UNLOCK = 32;

function holder(seed, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const scalar = BigInt(seed) * 1_000_003n + BigInt(i) + 7n;
    const blind = BigInt(seed) * 7_000_001n + BigInt(i) + 11n;
    out.push({ leaf: vaultLockNote(PI_SHE_NANOS, scalar, blind, UNLOCK), lock: { amount: PI_SHE_NANOS, scalar, blind, unlockEpoch: UNLOCK } });
  }
  return out;
}

describe('provers with more than one holder', { concurrency: false }, () => {
  if (!fs1NativeLoaded()) {
    it('needs the native FS-1 addon', () => assert.fail('shear_admit FS-1 addon is not loaded'));
    return;
  }
  const A = holder(1, 2);
  const B = holder(2, 2);
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  // Chain order interleaves the holders: A0, B0, A1, B1.
  for (const row of [A[0], B[0], A[1], B[1]]) {
    assert.ok(appendVaultLockNote(state, row.leaf.note, { bornEpoch: 1, unlockEpoch: UNLOCK }));
  }
  const chainRoot = state.vaultLockRoot;

  it("wallet A's vote proof verifies against the chain root", () => {
    const pid = proposalId(3, 'hb');
    const proved = proveLeafVote({
      locks: A.map((r) => r.lock), which: 0, epoch: 3, choice: 1, seq: 1, proposalId: pid, dest20: Buffer.alloc(20, 5),
    });
    assert.ok(proved, 'vote proof');
    const got = verifyLeafVote({ blob: proved.blob, root: Buffer.from(chainRoot, 'hex'), epoch: 3, choice: 1, seq: 1, proposalId: pid });
    assert.equal(got.ok, true, `vote proof root ${proved.rootHex} is not the chain root ${chainRoot}`);
  });

  it("wallet A's claim proof is over the chain root", () => {
    const proved = proveVaultReward({
      locks: A.map((r) => r.lock), which: 0, rootEpoch: 1, earnEpoch: 1, bps: GENESIS_BPS, dest20: Buffer.alloc(20, 6),
    });
    assert.ok(proved, 'claim proof');
    assert.equal(proved.rootHex, chainRoot, 'claim proof root is the chain root');
  });
});

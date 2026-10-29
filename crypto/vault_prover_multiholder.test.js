/**
 * Two holders on one vault. A's vote and claim proofs must verify against
 * the chain vault root from appendVaultLockNote, not against A's own locks.
 *
 * The caller passes the node's live notes (one list) and that chain root.
 * which:0 is A's first leaf, index 0 in the full list A0, B0, A1, B1.
 * A root that is not the builder's root is refused.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS } from './asert.js';
import { appendVaultLockNote, emptyVault, vaultLockCensus } from './reserve_vault.js';
import { proveLeafVote, proveVaultReward, verifyLeafVote, vaultLockNote } from './vault_reward_fs1.js';
import { proposalId } from './leaf_vote.js';
import { fs1NativeLoaded } from './native_admit.js';
import { vaultLockTreeFromNotes } from './vault_lock_tree.js';

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

function wrongRoot(hex) {
  const last = hex.slice(-1);
  const flip = last === '0' ? '1' : '0';
  return hex.slice(0, -1) + flip;
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
  const census = vaultLockCensus(state);
  const liveNotes = census.notes;
  const chainRoot = census.root;
  const built = vaultLockTreeFromNotes(liveNotes);
  console.log(`builder root ${built && built.rootHex}`);
  console.log(`node vaultLockRoot ${chainRoot}`);
  assert.equal(built && built.rootHex, chainRoot, 'builder root is the chain root');
  assert.equal(liveNotes.length, 4);
  assert.equal(Object.hasOwn(census, 'spendable'), false);

  it("wallet A's vote proof verifies against the chain root", () => {
    const pid = proposalId(3, 'hb');
    const proved = proveLeafVote({
      locks: A.map((r) => r.lock),
      which: 0,
      notes: liveNotes,
      chainRoot,
      epoch: 3,
      choice: 1,
      seq: 1,
      proposalId: pid,
      dest20: Buffer.alloc(20, 5),
    });
    assert.ok(proved, 'vote proof');
    console.log(`vote root ${proved.rootHex}`);
    const got = verifyLeafVote({ blob: proved.blob, root: Buffer.from(chainRoot, 'hex'), epoch: 3, choice: 1, seq: 1, proposalId: pid });
    assert.equal(got.ok, true, `vote proof root ${proved.rootHex} is not the chain root ${chainRoot}`);
  });

  it("wallet A's claim proof is over the chain root", () => {
    const proved = proveVaultReward({
      locks: A.map((r) => r.lock),
      which: 0,
      notes: liveNotes,
      chainRoot,
      rootEpoch: 1,
      earnEpoch: 1,
      bps: GENESIS_BPS,
      dest20: Buffer.alloc(20, 6),
    });
    assert.ok(proved, 'claim proof');
    console.log(`claim root ${proved.rootHex}`);
    assert.equal(proved.rootHex, chainRoot, 'claim proof root is the chain root');
  });

  it('refuses a proof whose root is not the chain root', () => {
    const pid = proposalId(3, 'hb');
    const bad = wrongRoot(chainRoot);
    const vote = proveLeafVote({
      locks: A.map((r) => r.lock),
      which: 0,
      notes: liveNotes,
      chainRoot: bad,
      epoch: 3,
      choice: 1,
      seq: 1,
      proposalId: pid,
      dest20: Buffer.alloc(20, 5),
    });
    assert.equal(vote, null);
    const claim = proveVaultReward({
      locks: A.map((r) => r.lock),
      which: 0,
      notes: liveNotes,
      chainRoot: bad,
      rootEpoch: 1,
      earnEpoch: 1,
      bps: GENESIS_BPS,
      dest20: Buffer.alloc(20, 6),
    });
    assert.equal(claim, null);
  });
});

/**
 * Lock conservation in walkWithdrawInterest.
 *
 * The note book is openedLockNanos - openedWithdrawNanos. A withdraw may not
 * release more principal than the book holds before it: a global backstop on
 * top of the per-leaf π opening in openIndexedLeaves. (The end-of-block
 * "book below zero" check is a backstop for an already-negative book and is
 * not reached from a sound one: every case below is refused by the
 * per-withdraw check first.) The old check, startNote + locksIn === noteBook() +
 * principalOut, held for every withdraw: withdraw() adds the released π to
 * openedWithdrawNanos, so noteBook() fell by exactly what principalOut rose
 * by (B + 0 === (B - π) + π for any book B, including 0). Each refusal below
 * returned ok on that code.
 *
 * Locks are real π vault-lock notes with their equality proof (which is what
 * books openedLockNanos). The refusal cases set the book by hand to model a
 * short book; a stripped fundProof, the real way a book fell short, is now
 * refused at the lock (test_lock_fundproof_v12). Withdraws open them with a principal proof and
 * a retire proof signed by the portal owner, as in test_supply_walk_heights_v12.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyAt, MS_PER_DAY, EPOCH_DAYS_TESTNET } from '../../crypto/pot_sched.js';
import { PI_SHE_NANOS, MAGIC_TESTNET } from '../../crypto/asert.js';
import { sealCoinbaseNote, excessOf, randomScalar } from '../../crypto/note.js';
import {
  attachLockEquality,
  blockPermittedInterest,
  blockWithdrawInterest,
  chainPeriodIndex,
  cloneVault,
  consensusUnlockPeriod,
  leafEpochsToBurn,
  leafStubNanos,
  lockUnlockOf,
  lockWitnessOf,
  portalIdFromDest,
  provePrincipalOpen,
  reserveAction,
  rewardCommitment,
  signWithdrawReward,
  withdrawSignedDest,
} from '../../crypto/reserve_vault.js';
import { lockTx, ownerFor, withdrawTx } from '../../crypto/owned_portal.js';
import { txDigestV3 } from '../../crypto/admit_v3.js';
import { proveLeafRetire, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { coinbaseTx } from '../src/chain.js';
import { foldSupply, vaultAfterBlock } from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const EPOCH_MS = EPOCH_DAYS_TESTNET * MS_PER_DAY;
const DRAW = GENESIS + EPOCH_MS + 1;
const PI = BigInt(PI_SHE_NANOS);

function freshDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function header(ts) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: ts,
    bits: 16,
  });
}

function potAt(ts) {
  return potSubsidyAt({ nowMs: ts, genesisMs: GENESIS, magic: MAGIC_TESTNET });
}

function potBlock(ts, miner, more, height) {
  const nanos = potAt(ts);
  const tx = coinbaseTx({
    height: 1,
    miner,
    potShares: [{ address: miner, nanos, kind: 'pot' }],
    potNanos: nanos,
    carryNanos: 0,
    shareBatch: [],
  });
  tx.vout = (tx.vout || []).filter((o) => String(o?.kind || '') !== 'hash');
  tx.excess = excessOf(tx.vout);
  return { height, header: header(ts), txs: [tx, ...(more || [])], shareBatch: [] };
}

/** A π vault lock note. attachLockEquality is what books openedLockNanos. */
function lockOf(miner, portal, id) {
  const tx = lockTx({ from: miner, to: portal, nanos: PI_SHE_NANOS, id });
  const sealed = sealCoinbaseNote(PI_SHE_NANOS, { dest20: Buffer.alloc(20, 0x91), kind: 'pot' });
  const prev = tx.vin && tx.vin[0] ? tx.vin[0] : {};
  tx.vin = [{ ...prev, commit: sealed.commit, valueProof: sealed.valueProof, rangeProof: sealed.rangeProof }];
  const held = lockWitnessOf(tx);
  const stamp = lockUnlockOf({ genesisMs: GENESIS, magic: MAGIC_TESTNET }, GENESIS);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const scalar = randomScalar();
  const leaf = vaultLockNote(held.amount, scalar, held.blind, unlock);
  assert.ok(leaf, `${id} π leaf`);
  tx.vaultLockNote = leaf.note;
  if (!attachLockEquality(tx)) throw new Error(`lock equality ${id}`);
  return { tx, portal, leaf: { note: leaf.note, commit: leaf.note.subarray(32, 64), scalar, blind: held.blind, unlock } };
}

/** π plus the arrival stub, opened and retired against `vault`, signed by the owner. */
function drawOf(vault, lock, miner, id) {
  const stub = leafStubNanos(vault, [lock.leaf.commit.toString('hex')]);
  const tx = withdrawTx({ from: lock.portal, to: miner, nanos: PI_SHE_NANOS + Number(stub), id });
  const portalId = portalIdFromDest(lock.portal);
  const proof = provePrincipalOpen(lock.leaf.commit, PI_SHE_NANOS, lock.leaf.blind, tx, portalId, vault.magic, lock.leaf.unlock);
  assert.ok(proof, `${id} principal proof`);
  tx.principalProof = proof;
  const period = chainPeriodIndex(vault, DRAW);
  const retire = proveLeafRetire({
    scalar: lock.leaf.scalar,
    epochs: leafEpochsToBurn(vault, lock.leaf.note.toString('hex'), period),
    leaf: lock.leaf.note,
    txBind: txDigestV3(tx, vault.magic),
    unlockEpoch: period,
    magic: vault.magic,
  });
  if (retire) tx.retireProof = retire.proof;
  signWithdrawReward(tx, ownerFor(lock.portal).key, {
    portalId,
    nanos: PI_SHE_NANOS,
    dest: withdrawSignedDest(tx, reserveAction(tx)),
    state: vault,
    nowMs: DRAW,
  });
  return { tx, stub };
}

/** Lock block at height 1 with `count` portals, the parent vault, and the draw block at height 2. */
function lockedChain(count, tag) {
  const miner = freshDest();
  const locks = Array.from({ length: count }, (_, i) => lockOf(miner, freshDest(), `${tag}-lock-${i}`));
  const first = potBlock(GENESIS, miner, locks.map((row) => row.tx), 1);
  const parent = vaultAfterBlock(null, first, [], { requireStakeReward: true, magic: MAGIC_TESTNET });
  assert.equal(parent.ok, true, `${tag} lock replay`);
  const draws = locks.map((lock, i) => drawOf(parent.vault, lock, miner, `${tag}-draw-${i}`));
  const second = potBlock(DRAW, miner, draws.map((row) => row.tx), 2);
  const plan = rewardCommitment(parent.vault, DRAW);
  if (plan.rows.length) second.txs[0].rewardRoot = plan.root;
  const stubs = draws.reduce((n, row) => n + row.stub, 0n);
  return { chain: [first, second], vault: parent.vault, stubs };
}

function bookOf(vault) {
  return BigInt(vault.openedLockNanos || 0) - BigInt(vault.openedWithdrawNanos || 0);
}

function withBook(vault, openedLockNanos) {
  const short = cloneVault(vault);
  short.openedLockNanos = openedLockNanos;
  return short;
}

describe('walkWithdrawInterest conserves the note book', () => {
  it('a balanced lock-then-withdraw passes the walk and the fold', () => {
    const { chain, vault, stubs } = lockedChain(1, 'one');
    // The equality-proven lock booked π.
    assert.equal(bookOf(vault), PI);
    const minted = blockWithdrawInterest(vault, chain[1], DRAW);
    assert.equal(minted.ok, true, minted.reason);
    assert.equal(minted.nanos, stubs);
    const allowed = blockPermittedInterest(vault, chain[1], DRAW);
    assert.equal(allowed.ok, true, allowed.reason);
    assert.equal(allowed.nanos, stubs);
    const folded = foldSupply(chain, { genesisMs: GENESIS, magic: MAGIC_TESTNET });
    assert.equal(folded.ok, true, folded.reason);
    assert.equal(folded.state.mintedInterest, stubs);
  });

  it('refuses a withdraw that releases more principal than the note book holds', () => {
    const { chain, vault } = lockedChain(1, 'short');
    for (const book of [0n, PI - 1n]) {
      const short = withBook(vault, book);
      assert.ok(bookOf(short) < PI, `book ${book}`);
      // The old identity accepted this: B + 0 === (B - π) + π.
      const minted = blockWithdrawInterest(short, chain[1], DRAW);
      assert.equal(minted.ok, false, `book ${book}`);
      assert.equal(minted.reason, 'supply', `book ${book}`);
      const allowed = blockPermittedInterest(short, chain[1], DRAW);
      assert.equal(allowed.ok, false, `book ${book} permitted`);
      assert.equal(allowed.reason, 'supply', `book ${book} permitted`);
    }
    // A book of exactly π is enough.
    const exact = blockWithdrawInterest(withBook(vault, PI), chain[1], DRAW);
    assert.equal(exact.ok, true, exact.reason);
  });

  it('refuses two withdraws in one block whose sum exceeds the book', () => {
    // Two portals, so neither withdraw is a double_mint of the other.
    const { chain, vault, stubs } = lockedChain(2, 'pair');
    assert.equal(chain[1].txs.length, 3);
    assert.equal(bookOf(vault), 2n * PI);
    const full = blockWithdrawInterest(vault, chain[1], DRAW);
    assert.equal(full.ok, true, full.reason);
    assert.equal(full.nanos, stubs);
    // Each withdraw alone fits 2π-1. Both do not: the second sees π-1.
    // The old identity accepted this too.
    const short = withBook(vault, 2n * PI - 1n);
    const pair = blockWithdrawInterest(short, chain[1], DRAW);
    assert.equal(pair.ok, false);
    assert.equal(pair.reason, 'supply');
    const one = { ...chain[1], txs: chain[1].txs.slice(0, 2) };
    const single = blockWithdrawInterest(short, one, DRAW);
    assert.equal(single.ok, true, single.reason);
  });
});

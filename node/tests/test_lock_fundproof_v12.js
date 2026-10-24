/**
 * A note lock must prove π for every leaf, or it is refused.
 *
 * A lock's principal enters the note book (openedLockNanos) only through each
 * lock output's fundProof, the π equality proof, and txDigestV3 does not bind
 * fundProof. So anyone relaying or mining an honest lock could strip it: the
 * leaf was still indexed, but its π was never booked, and the owner's later
 * withdraw failed the note book (walkWithdrawInterest, supplyStep), leaving a
 * matured lock with no exit. applyReserveBlock (block verify's trial, block
 * apply and replay, mempool admit) and the EVM now refuse a note lock whose
 * leaves do not all prove π, before anything is indexed.
 *
 * Store-level p2p and RPC refusals of a stripped real wallet lock are in
 * test_dart_withdraw_queue_v12.js.
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
  blockWithdrawInterest,
  chainPeriodIndex,
  consensusUnlockPeriod,
  emptyVault,
  leafEpochsToBurn,
  leafStubNanos,
  lockNotePrincipal,
  lockUnlockOf,
  lockWitnessOf,
  portalIdFromDest,
  provePrincipalOpen,
  reserveAction,
  rewardCommitment,
  signWithdrawReward,
  trialReserveApply,
  withdrawSignedDest,
} from '../../crypto/reserve_vault.js';
import { bootReserveEvm, callReserve, encodePinClock, executeReserveTx } from '../../crypto/reserve_evm.js';
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

function potBlock(ts, miner, more, height) {
  const nanos = potSubsidyAt({ nowMs: ts, genesisMs: GENESIS, magic: MAGIC_TESTNET });
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

/** An honest π vault lock note with its equality proof, as the wallet sends it. */
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

function drawOf(vault, lock, miner, id) {
  const stub = leafStubNanos(vault, [lock.leaf.commit.toString('hex')]);
  const tx = withdrawTx({ from: lock.portal, to: miner, nanos: PI_SHE_NANOS + Number(stub), id });
  const portalId = portalIdFromDest(lock.portal);
  tx.principalProof = provePrincipalOpen(lock.leaf.commit, PI_SHE_NANOS, lock.leaf.blind, tx, portalId, vault.magic, lock.leaf.unlock);
  assert.ok(tx.principalProof, `${id} principal proof`);
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

/** What a relayer or miner can do to a lock in transit: no field it binds changes. */
function stripped(tx) {
  const copy = { ...tx, vout: tx.vout.map((row) => ({ ...row })) };
  for (const row of copy.vout) if (String(row?.kind || '') === 'lock') delete row.fundProof;
  return copy;
}

/** Block verify's own vault check (chain.js verifyBlockConsensus). */
function verifyVault(block, state = emptyVault()) {
  return trialReserveApply({ state, block, nowMs: GENESIS, height: block.height, genesisMs: GENESIS });
}

describe('a note lock proves π for every leaf, or it is refused', () => {
  it('an honest lock is booked, and its withdraw passes end to end', () => {
    const miner = freshDest();
    const lock = lockOf(miner, freshDest(), 'honest');
    assert.equal(lockNotePrincipal(lock.tx, MAGIC_TESTNET), PI);
    const first = potBlock(GENESIS, miner, [lock.tx], 1);
    assert.equal(verifyVault(first).ok, true, 'block verify');
    const parent = vaultAfterBlock(null, first, [], { requireStakeReward: true, magic: MAGIC_TESTNET });
    assert.equal(parent.ok, true, parent.reason);
    assert.equal(BigInt(parent.vault.openedLockNanos || 0), PI, 'π booked');
    const draw = drawOf(parent.vault, lock, miner, 'honest-draw');
    const second = potBlock(DRAW, miner, [draw.tx], 2);
    const plan = rewardCommitment(parent.vault, DRAW);
    if (plan.rows.length) second.txs[0].rewardRoot = plan.root;
    const walked = blockWithdrawInterest(parent.vault, second, DRAW);
    assert.equal(walked.ok, true, walked.reason);
    assert.equal(walked.nanos, draw.stub);
    const folded = foldSupply([first, second], { genesisMs: GENESIS, magic: MAGIC_TESTNET });
    assert.equal(folded.ok, true, folded.reason);
  });

  it('refuses a lock whose fundProof was stripped or swapped, in block verify and replay, with nothing indexed', () => {
    const miner = freshDest();
    const one = lockOf(miner, freshDest(), 'victim');
    const other = lockOf(miner, freshDest(), 'other');
    const swapped = stripped(one.tx);
    for (const row of swapped.vout) if (String(row?.kind || '') === 'lock') row.fundProof = other.tx.vout.find((o) => o.kind === 'lock').fundProof;
    for (const [name, tx] of [['stripped', stripped(one.tx)], ['swapped', swapped]]) {
      // The leaf and every bound byte are unchanged; only the π proof is gone.
      assert.equal(txDigestV3(tx, MAGIC_TESTNET).equals(txDigestV3(one.tx, MAGIC_TESTNET)), true, `${name} digest`);
      assert.equal(lockNotePrincipal(tx, MAGIC_TESTNET), 0n, name);
      const block = potBlock(GENESIS, miner, [tx], 1);
      const verdict = verifyVault(block);
      assert.equal(verdict.ok, false, `${name} block verify`);
      assert.equal(verdict.reason, 'stake_reward', `${name} block verify ${verdict.reason}`);
      const replay = vaultAfterBlock(null, block, [], { requireStakeReward: true, magic: MAGIC_TESTNET });
      assert.equal(replay.ok, false, `${name} replay`);
      // Applied in place, the refused lock leaves no leaf and books nothing.
      const state = emptyVault();
      const inPlace = trialReserveApply({ state, block, nowMs: GENESIS, height: 1, genesisMs: GENESIS, inPlace: true });
      assert.equal(inPlace.ok, false, `${name} in place`);
      assert.equal((state.vaultLockNotes || []).length, 0, `${name} nothing indexed`);
      assert.equal(BigInt(state.openedLockNanos || 0), 0n, `${name} nothing booked`);
    }
    // The honest lock beside it still verifies.
    assert.equal(verifyVault(potBlock(GENESIS, miner, [one.tx], 1)).ok, true);
  });

  it('the EVM refuses a stripped lock the same way, and lets the honest lock past that rule', async () => {
    const miner = freshDest();
    const lock = lockOf(miner, freshDest(), 'evm');
    const evm = await bootReserveEvm();
    assert.equal((await callReserve(evm, encodePinClock(GENESIS))).ok, true);
    const ctx = { blockHeight: 1, magic: MAGIC_TESTNET, genesisMs: GENESIS };
    const bad = await executeReserveTx(evm, stripped(lock.tx), GENESIS, ctx);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'stake_reward', bad.reason);
    const good = await executeReserveTx(evm, lock.tx, GENESIS, ctx);
    assert.notEqual(good.reason, 'stake_reward', `honest lock: ${good.reason}`);
  });
});

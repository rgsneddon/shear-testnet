/**
 * Time-locked principal is the lock note. A withdraw must not pay that
 * principal again. Consensus currently does.
 *
 * withdraw() (reserve_vault.js, the release around the redeemedNanos
 * update) does not look at noteIsPrincipal. At epoch end, before any
 * reward root, it pays principal + interest, sets redeemedNanos to the
 * principal, and drops the tranche. The lock note is still an admit leaf
 * and lockNoteSpendRejected does not refuse a spend of it.
 *
 * Covered lock nanos then equal redeemed nanos, so the hold cancels and
 * both notes stay in the spendable sum. blockWithdrawInterest counts only
 * the interest, so the supply counter does not inflate.
 *
 * The reported probe (lock 1π at genesis+1000ms) is that withdraw():
 * principal 314159265358, interest 8922097319, redeemedNanos = principal.
 * verifyBlock's boundReserveWithdraw rejects that partial receipt with
 * mint_amount. A lock at the epoch open makes the pro-rata equal the
 * full-epoch cap, and boundReserveWithdraw, verifyReservePayout, withdraw(),
 * and the supply interest check all accept. That path is the failing
 * invariant below.
 *
 * NEEDS RUSSELL SIGN-OFF. The refusal is proposed in
 * crypto/timelock_withdraw_note_principal.proposal.diff and is not applied.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, spendDestOf, admitBaseFromAddress, hash20FromAddress } from '../../crypto/address.js';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS } from '../../crypto/asert.js';
import { attachAdmitPub, outputJoinsAdmitSet } from '../../crypto/admit.js';
import { fs1LeafFor } from '../../crypto/fs1_leaf.js';
import { encodeHeader } from '../../crypto/header.js';
import { excessOf } from '../../crypto/note.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { boundReserveWithdraw } from '../../crypto/spend.js';
import {
  applyReserveBlock,
  blockPermittedInterest,
  blockWithdrawInterest,
  emptyVault,
  lockNoteSpendRejected,
  lockTx,
  lockUnlockOf,
  portalPrincipalNanos,
  previewWithdraw,
  supplyIdentity,
  verifyReservePayout,
  withdrawTx,
} from '../../crypto/reserve_vault.js';
import { coinbaseTx } from '../src/chain.js';
import { createNoteLedger } from '../src/note_ledger.js';
import { foldSupply } from '../src/supply.js';

const T0 = 1_700_000_000_000;
const DRAW = T0 + RESERVE_EPOCH_MS;
const PROBE_LOCK_AT = T0 + 1_000;
const PROBE_INTEREST = 8_922_097_319;

function destOf() {
  return spendDestOf(newIdentity().spendPub);
}

function freshVault() {
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  state.genesisMs = T0;
  return state;
}

function timeLock(dest, when, id) {
  const stamp = lockUnlockOf({ genesisMs: T0, magic: MAGIC_TESTNET }, when);
  return lockTx({
    from: dest,
    to: dest,
    nanos: PI_SHE_NANOS,
    id,
    timeLock: true,
    lockEpoch: stamp.epoch,
    unlockAtMs: stamp.unlockAtMs,
  });
}

function admitWithdraw(dest, nanos, id) {
  const tx = withdrawTx({ from: dest, to: dest, nanos, id });
  tx.vout = [attachAdmitPub(tx.vout[0], { admitBase: admitBaseFromAddress(dest) })];
  return tx;
}

function applyLock(state, tx, when) {
  return applyReserveBlock({
    state,
    block: { height: 1, txs: [tx] },
    nowMs: when,
    genesisMs: T0,
  });
}

function applyDraw(state, tx) {
  return applyReserveBlock({
    state,
    block: { height: 2, txs: [{ coinbase: true, vout: [] }, tx] },
    nowMs: DRAW,
    genesisMs: T0,
  });
}

function withdrawRow(applied) {
  return (applied || []).find((row) => row && row.action === 'withdraw') || null;
}

function admitFace(tx) {
  let n = 0;
  for (const o of tx?.vout || []) {
    if (!outputJoinsAdmitSet(tx, o) || !fs1LeafFor(o)) continue;
    n += Number(o.valueProof?.v || 0);
  }
  return n;
}

/** The node spendable formula in store.destSpendableNanos. */
function nodeSpendable(book, vault, addr, tipH) {
  const clock = { need: 1, tipMs: DRAW, genesisMs: T0, magic: MAGIC_TESTNET };
  const opened = book.spendable(addr, tipH, clock);
  const principal = Math.max(0, Math.floor(Number(portalPrincipalNanos(vault, addr)) || 0));
  const covered = Math.max(0, Math.floor(Number(book.coveredLockNanos(addr, tipH, clock)) || 0));
  const held = Math.max(0, principal - covered);
  return {
    opened,
    principal,
    covered,
    held,
    spendable: Math.max(0, opened - held),
  };
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
  return potSubsidyAt({ nowMs: ts, genesisMs: T0, magic: MAGIC_TESTNET });
}

function supplyBlock(ts, miner, extra) {
  const pot = potAt(ts);
  const cb = coinbaseTx({
    height: 1,
    miner,
    potShares: [{ address: miner, nanos: pot, kind: 'pot' }],
    potNanos: pot,
    carryNanos: 0,
    shareBatch: [],
  });
  cb.vout = (cb.vout || []).filter((o) => String(o?.kind || '') !== 'hash');
  cb.excess = excessOf(cb.vout);
  return {
    header: header(ts),
    txs: [cb, ...(extra || [])],
    shareBatch: [],
  };
}

describe('time-locked withdraw supply', () => {
  it('mints the interest and does not mint the principal a second time', () => {
    const dest = destOf();
    const state = freshVault();
    const lock = timeLock(dest, PROBE_LOCK_AT, 'probe-lock');
    const locked = applyLock(state, lock, PROBE_LOCK_AT);
    assert.equal(locked.ok, true, locked.reason);
    const preview = previewWithdraw(state, dest, DRAW);
    assert.equal(preview.principal, PI_SHE_NANOS);
    assert.equal(preview.interest, PROBE_INTEREST);
    const draw = admitWithdraw(dest, preview.payout, 'probe-withdraw');
    const pre = freshVault();
    assert.equal(applyLock(pre, lock, PROBE_LOCK_AT).ok, true);
    const paid = applyDraw(state, draw);
    const row = withdrawRow(paid);
    assert.equal(row && row.ok, true, row && row.reason);
    assert.equal(row.principal, PI_SHE_NANOS);
    assert.equal(row.interest, PROBE_INTEREST);
    assert.equal(row.payout, PI_SHE_NANOS + PROBE_INTEREST);
    const portal = state.portals[Object.keys(state.portals)[0]];
    assert.equal(Number(portal.redeemedNanos), PI_SHE_NANOS);
    assert.equal(Number(portal.staked) + Number(portal.idle), 0);
    assert.equal(portal.tranches.length, 0);
    const identity = supplyIdentity(state);
    assert.equal(identity.ok, true, identity.reason);
    assert.equal(identity.mintedReward, PROBE_INTEREST);
    assert.equal(identity.permittedReward, PROBE_INTEREST);
    const interest = blockWithdrawInterest(pre, supplyBlock(DRAW, dest, [draw]), DRAW);
    const permitted = blockPermittedInterest(pre, supplyBlock(DRAW, dest, [draw]), DRAW);
    assert.equal(interest.ok, true, interest.reason);
    assert.equal(permitted.ok, true, permitted.reason);
    assert.equal(interest.nanos, BigInt(PROBE_INTEREST));
    assert.equal(permitted.nanos, BigInt(PROBE_INTEREST));
    // Accidental, not a time-lock refusal. The receipt opens to the
    // pro-rata interest, and this gate demands the full-epoch cap.
    assert.equal(boundReserveWithdraw(draw, pre, new Set()).reason, 'mint_amount');

    const openDest = destOf();
    const open = freshVault();
    const openLock = timeLock(openDest, T0, 'open-lock');
    assert.equal(applyLock(open, openLock, T0).ok, true);
    const openPreview = previewWithdraw(open, openDest, DRAW);
    assert.equal(openPreview.interest, interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    const openDraw = admitWithdraw(openDest, openPreview.payout, 'open-withdraw');
    const chain = [
      supplyBlock(T0, openDest, [openLock]),
      supplyBlock(DRAW, openDest, [openDraw]),
    ];
    const folded = foldSupply(chain, { genesisMs: T0, magic: MAGIC_TESTNET });
    assert.equal(folded.ok, true, folded.reason);
    assert.equal(folded.state.mintedInterest, BigInt(openPreview.interest));
    assert.equal(folded.state.permittedInterest, BigInt(openPreview.interest));
    const pots = BigInt(potAt(T0) + potAt(DRAW));
    assert.equal(folded.state.mintedPot, pots);
    assert.equal(folded.state.mintedPot + folded.state.mintedHash + folded.state.mintedInterest, pots + BigInt(openPreview.interest));
  });

  it('does not leave the unlocked note spendable after the withdraw', () => {
    const dest = destOf();
    const state = freshVault();
    const lock = timeLock(dest, T0, 'spend-lock');
    assert.equal(applyLock(state, lock, T0).ok, true);
    assert.equal(outputJoinsAdmitSet(lock, lock.vout[0]), true);
    assert.ok(fs1LeafFor(lock.vout[0]));
    const preview = previewWithdraw(state, dest, DRAW);
    const pre = freshVault();
    assert.equal(applyLock(pre, lock, T0).ok, true);
    const draw = admitWithdraw(dest, preview.payout, 'spend-withdraw');
    assert.equal(verifyReservePayout(pre, draw, DRAW).ok, true);
    assert.equal(boundReserveWithdraw(draw, pre, new Set()).ok, true);
    const paid = applyDraw(state, draw);
    const row = withdrawRow(paid);
    assert.equal(row && row.ok, true, row && row.reason);
    assert.equal(row.principal, PI_SHE_NANOS);
    assert.equal(row.interest, preview.interest);
    assert.equal(outputJoinsAdmitSet(draw, draw.vout[0]), true);
    assert.ok(fs1LeafFor(draw.vout[0]));

    const spend = { vin: [{ commit: lock.vout[0].commit }] };
    assert.equal(lockNoteSpendRejected(state, spend, DRAW), null);
    const book = createNoteLedger();
    book.sync([
      { height: 1, hash: Buffer.alloc(32, 1), txs: [lock] },
      { height: 2, hash: Buffer.alloc(32, 2), txs: [draw] },
      {
        height: 3,
        hash: Buffer.alloc(32, 3),
        txs: [{ id: 'spend-unlocked-note', kind: 'send', vin: [{ commit: lock.vout[0].commit }], vout: [] }],
      },
    ]);
    const got = nodeSpendable(book, state, dest, 3);
    const face = admitFace(lock) + admitFace(draw);
    assert.equal(got.held, 0);
    assert.equal(got.covered, PI_SHE_NANOS);
    assert.equal(got.principal, PI_SHE_NANOS);
    assert.equal(
      face,
      preview.payout,
      `admit face ${face} wallet spendable ${got.spendable} payout ${preview.payout} `
      + `covered ${got.covered} redeemed ${got.principal}`,
    );
    assert.equal(got.spendable, preview.payout);
  });
});

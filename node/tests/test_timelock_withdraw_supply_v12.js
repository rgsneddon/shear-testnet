/**
 * Time-locked principal is the lock note. withdraw() must not pay it again.
 *
 * Vault Security default, applied here: refuse only noteIsPrincipal.
 * A legacy tranche in the same portal still withdraws. A plain receipt
 * still withdraws. Attack Cartographer's stricter rule (no principal in
 * withdraw at all) is crypto/timelock_withdraw_refuse_all_principal.proposal.diff
 * and is not applied.
 *
 * lockNoteSpendRejected only gates a spend before unlock. The bug was
 * withdraw() re-paying principal the note already carries. After the
 * refusal, auto-credit releases the note and spendable value is that
 * note alone.
 *
 * NEEDS RUSSELL SIGN-OFF. Consensus rule. Do not merge on this draft.
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, spendDestOf, admitBaseFromAddress } from '../../crypto/address.js';
import {
  GENESIS_BPS,
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_NOTE_LAW,
  consensusFingerprint,
} from '../../crypto/asert.js';
import { attachAdmitPub, outputJoinsAdmitSet } from '../../crypto/admit.js';
import { fs1LeafFor } from '../../crypto/fs1_leaf.js';
import { encodeHeader } from '../../crypto/header.js';
import { excessOf } from '../../crypto/note.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import {
  applyReserveBlock,
  blockPermittedInterest,
  blockWithdrawInterest,
  emptyVault,
  lockNoteSpendRejected,
  lockTx,
  lockUnlockOf,
  portalIdFromDest,
  portalPrincipalNanos,
  previewWithdraw,
  rewardCommitment,
  supplyIdentity,
  trialReserveApply,
  verifyReservePayout,
  withdraw,
  withdrawTx,
} from '../../crypto/reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  decodePublicView,
  encodeCommitRewards,
  encodePublicView,
  executeBlockEvm,
} from '../../crypto/reserve_evm.js';
import { V12_GENESIS_BLOCK_HASH, chainLoadSealHash, coinbaseTx } from '../src/chain.js';
import { createNoteLedger } from '../src/note_ledger.js';
import { foldSupply } from '../src/supply.js';
import { boundReserveWithdraw, verifyFundedBody } from '../../crypto/spend.js';

const T0 = 1_700_000_000_000;
const DRAW = T0 + RESERVE_EPOCH_MS;

function destOf() {
  return spendDestOf(newIdentity().spendPub);
}

function freshVault() {
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  state.genesisMs = T0;
  return state;
}

function timeLock(dest, when, id, nanos = PI_SHE_NANOS) {
  const stamp = lockUnlockOf({ genesisMs: T0, magic: MAGIC_TESTNET }, when);
  return lockTx({
    from: dest,
    to: dest,
    nanos,
    id,
    timeLock: true,
    lockEpoch: stamp.epoch,
    unlockAtMs: stamp.unlockAtMs,
  });
}

function plainLock(dest, when, id, nanos = PI_SHE_NANOS) {
  return lockTx({ from: dest, to: dest, nanos, id });
}

function admitWithdraw(dest, nanos, id) {
  const tx = withdrawTx({ from: dest, to: dest, nanos, id });
  tx.vout = [attachAdmitPub(tx.vout[0], { admitBase: admitBaseFromAddress(dest) })];
  return tx;
}

function applyLock(state, tx, when, height = 1) {
  return applyReserveBlock({
    state,
    block: { height, txs: [tx] },
    nowMs: when,
    genesisMs: T0,
  });
}

function withdrawRow(applied) {
  return (applied || []).find((row) => row && row.action === 'withdraw') || null;
}

function nodeSpendable(book, vault, addr, tipH) {
  const clock = { need: 1, tipMs: DRAW, genesisMs: T0, magic: MAGIC_TESTNET };
  const opened = book.spendable(addr, tipH, clock);
  const principal = Math.max(0, Math.floor(Number(portalPrincipalNanos(vault, addr)) || 0));
  const covered = Math.max(0, Math.floor(Number(book.coveredLockNanos(addr, tipH, clock)) || 0));
  const held = Math.max(0, principal - covered);
  return { opened, principal, covered, held, spendable: Math.max(0, opened - held) };
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
  it('refuses the note and leaves spendable equal to that note', () => {
    const dest = destOf();
    const state = freshVault();
    const lock = timeLock(dest, T0, 'spend-lock');
    assert.equal(applyLock(state, lock, T0).ok, true);
    assert.equal(outputJoinsAdmitSet(lock, lock.vout[0]), true);
    assert.ok(fs1LeafFor(lock.vout[0]));
    const preview = previewWithdraw(state, dest, DRAW);
    assert.equal(preview.principal, 0);
    assert.equal(preview.notePrincipal, PI_SHE_NANOS);
    assert.equal(preview.reason, 'note_principal');
    assert.equal(preview.payout, 0);
    const face = preview.notePrincipal + preview.interest;
    const draw = admitWithdraw(dest, face, 'spend-withdraw');
    assert.equal(verifyReservePayout(state, draw, DRAW).reason, 'note_principal');
    assert.equal(withdraw({ state, dest, nowMs: DRAW }).reason, 'note_principal');
    assert.equal(Number(state.portals[portalIdFromDest(dest)].staked), PI_SHE_NANOS);

    const plan = rewardCommitment(state, DRAW);
    const credited = applyReserveBlock({
      state,
      block: { height: 2, txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] },
      nowMs: DRAW,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(credited.ok, true, credited.reason);
    const portal = state.portals[portalIdFromDest(dest)];
    assert.equal(Number(portal.redeemedNanos), PI_SHE_NANOS);
    assert.equal(Number(portal.staked) + Number(portal.idle), 0);
    assert.equal(lockNoteSpendRejected(state, { vin: [{ commit: lock.vout[0].commit }] }, DRAW), null);
    const identity = supplyIdentity(state);
    assert.equal(identity.ok, true, identity.reason);
    assert.equal(identity.mintedReward, 0);

    const book = createNoteLedger();
    book.sync([
      { height: 1, hash: Buffer.alloc(32, 1), txs: [lock] },
      { height: 2, hash: Buffer.alloc(32, 2), txs: [] },
    ]);
    const got = nodeSpendable(book, state, dest, 2);
    assert.equal(got.spendable, PI_SHE_NANOS);
    assert.equal(got.opened, PI_SHE_NANOS);
    assert.equal(got.covered, PI_SHE_NANOS);
    assert.equal(got.held, 0);
  });

  it('still withdraws a plain receipt, and refuses a note-only fold', () => {
    const plainDest = destOf();
    const plain = freshVault();
    const plainTx = plainLock(plainDest, T0, 'plain-lock');
    assert.equal(applyLock(plain, plainTx, T0).ok, true);
    const plainPreview = previewWithdraw(plain, plainDest, DRAW);
    assert.equal(plainPreview.principal, PI_SHE_NANOS);
    assert.equal(plainPreview.notePrincipal, 0);
    assert.equal(plainPreview.interest, interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    const plainDraw = admitWithdraw(plainDest, plainPreview.payout, 'plain-withdraw');
    assert.equal(verifyReservePayout(plain, plainDraw, DRAW).ok, true);
    const paid = applyReserveBlock({
      state: plain,
      block: { height: 2, txs: [{ coinbase: true, vout: [] }, plainDraw] },
      nowMs: DRAW,
      genesisMs: T0,
    });
    const row = withdrawRow(paid);
    assert.equal(row && row.ok, true, row && row.reason);
    assert.equal(row.principal, PI_SHE_NANOS);
    assert.equal(row.interest, plainPreview.interest);
    const prior = freshVault();
    assert.equal(applyLock(prior, plainTx, T0).ok, true);
    const interest = blockWithdrawInterest(prior, supplyBlock(DRAW, plainDest, [plainDraw]), DRAW);
    const permittedPlain = blockPermittedInterest(prior, supplyBlock(DRAW, plainDest, [plainDraw]), DRAW);
    assert.equal(interest.ok, true, interest.reason);
    assert.equal(permittedPlain.ok, true, permittedPlain.reason);
    assert.equal(interest.nanos, BigInt(plainPreview.interest));

    const noteDest = destOf();
    const note = freshVault();
    const noteTx = timeLock(noteDest, T0, 'fold-note');
    assert.equal(applyLock(note, noteTx, T0).ok, true);
    const notePreview = previewWithdraw(note, noteDest, DRAW);
    const noteDraw = admitWithdraw(noteDest, notePreview.notePrincipal + notePreview.interest, 'fold-withdraw');
    const chain = [
      supplyBlock(T0, noteDest, [noteTx]),
      supplyBlock(DRAW, noteDest, [noteDraw]),
    ];
    const folded = foldSupply(chain, { genesisMs: T0, magic: MAGIC_TESTNET });
    assert.equal(folded.ok, false);
    const permitted = blockPermittedInterest(note, supplyBlock(DRAW, noteDest, [noteDraw]), DRAW);
    assert.equal(permitted.ok, false);
  });

  it('pays only the legacy tranche when the portal also holds a time-locked note', () => {
    const dest = destOf();
    const state = freshVault();
    const legacy = plainLock(dest, T0, 'mixed-legacy', PI_SHE_NANOS);
    const note = timeLock(dest, T0, 'mixed-note', PI_SHE_NANOS);
    assert.equal(applyLock(state, legacy, T0).ok, true);
    assert.equal(applyLock(state, note, T0, 2).ok, true);
    const portal = state.portals[portalIdFromDest(dest)];
    assert.equal(portal.tranches.length, 2);
    assert.equal(portal.tranches[1].noteIsPrincipal, true);
    const preview = previewWithdraw(state, dest, DRAW);
    assert.equal(preview.principal, PI_SHE_NANOS);
    assert.equal(preview.notePrincipal, PI_SHE_NANOS);
    // Full-epoch remain makes the two partials equal interest on all staked.
    // The receipt opens to legacy principal only, so the exact check must use
    // withdrawablePrincipal. All locked principal would refuse this seal.
    const cap = PI_SHE_NANOS + interestNanos(PI_SHE_NANOS * 2, GENESIS_BPS);
    assert.equal(preview.payout, cap);
    const draw = withdrawTx({ from: dest, to: dest, nanos: preview.payout, id: 'mixed-bound' });
    const bound = boundReserveWithdraw(draw, state, new Set(), DRAW);
    assert.equal(bound.ok, true, bound.reason);
    assert.equal(bound.principal, PI_SHE_NANOS);
    const paid = withdraw({ state, dest, nowMs: DRAW });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS);
    assert.equal(Number(portal.redeemedNanos), PI_SHE_NANOS);
    assert.equal(portal.tranches.length, 1);
    assert.equal(portal.tranches[0].noteIsPrincipal, true);
    assert.equal(Number(portal.tranches[0].amount), PI_SHE_NANOS);
    const again = withdraw({ state, dest, nowMs: DRAW });
    assert.equal(again.reason, 'note_principal');
  });

  it('keeps an open top-up when the earlier legacy tranche withdraws', () => {
    const dest = destOf();
    const state = freshVault();
    const first = plainLock(dest, T0, 'top-legacy');
    assert.equal(applyLock(state, first, T0).ok, true);
    const later = DRAW + 1_000;
    const top = timeLock(dest, later, 'top-note');
    const topped = applyLock(state, top, later, 2);
    assert.equal(topped.ok, true, topped.reason);
    const portal = state.portals[portalIdFromDest(dest)];
    assert.equal(portal.tranches.length, 2);
    assert.equal(portal.tranches[1].noteIsPrincipal, true);
    const paid = withdraw({ state, dest, nowMs: later });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS);
    assert.equal(portal.tranches.length, 1);
    assert.equal(portal.tranches[0].noteIsPrincipal, true);
    assert.equal(Number(portal.tranches[0].amount), PI_SHE_NANOS);
    assert.equal(Number(portal.staked) + Number(portal.idle), PI_SHE_NANOS);
  });

  it('does not let a withdraw skip another portal’s auto-credit', () => {
    const noteDest = destOf();
    const legacyDest = destOf();
    const state = freshVault();
    state.epochBps = 0;
    state.pendingRates[0] = 0;
    const note = timeLock(noteDest, T0, 'grief-note');
    const legacy = plainLock(legacyDest, T0, 'grief-legacy');
    assert.equal(applyLock(state, note, T0).ok, true);
    assert.equal(applyLock(state, legacy, T0, 2).ok, true);
    assert.equal(rewardCommitment(state, DRAW).rows.length, 0);
    const pull = withdrawTx({ from: legacyDest, to: legacyDest, nanos: PI_SHE_NANOS, id: 'grief-withdraw' });
    const grief = trialReserveApply({
      state,
      block: { height: 3, txs: [{ coinbase: true, vout: [] }, pull] },
      nowMs: DRAW,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(grief.ok, true, grief.reason);
    const next = grief.state;
    const notePortal = next.portals[portalIdFromDest(noteDest)];
    const legacyPortal = next.portals[portalIdFromDest(legacyDest)];
    assert.equal(Number(notePortal.redeemedNanos), PI_SHE_NANOS);
    assert.equal(notePortal.tranches.length, 0);
    assert.equal(Number(legacyPortal.staked) + Number(legacyPortal.idle), 0);
    assert.equal(Number(state.totalLockedNanos), PI_SHE_NANOS * 2);

    const onlyNote = freshVault();
    onlyNote.epochBps = 0;
    onlyNote.pendingRates[0] = 0;
    assert.equal(applyLock(onlyNote, timeLock(noteDest, T0, 'grief-only'), T0).ok, true);
    const skipped = trialReserveApply({
      state: onlyNote,
      block: {
        height: 3,
        txs: [
          { coinbase: true, vout: [] },
          withdrawTx({ from: noteDest, to: noteDest, nanos: PI_SHE_NANOS, id: 'grief-self' }),
        ],
      },
      nowMs: DRAW,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(skipped.ok, false);
    assert.equal(Number(onlyNote.totalLockedNanos), PI_SHE_NANOS);
    const released = applyReserveBlock({
      state: onlyNote,
      block: { height: 4, txs: [{ coinbase: true, vout: [] }] },
      nowMs: DRAW,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(released.ok, true, released.reason);
    assert.equal(Number(onlyNote.portals[portalIdFromDest(noteDest)].redeemedNanos), PI_SHE_NANOS);
  });

  it('names the rule in the consensus fingerprint that the load seal hashes', () => {
    const fp = consensusFingerprint(MAGIC_TESTNET);
    assert.match(fp, new RegExp(`RESERVE_NOTE=${RESERVE_NOTE_LAW}`));
    assert.equal(RESERVE_NOTE_LAW, 'note-principal-refused');
    const chainSrc = readFileSync(new URL('../src/chain.js', import.meta.url), 'utf8');
    assert.match(chainSrc, /consensusFingerprint\(magic\)/);
    const seal = chainLoadSealHash(Buffer.alloc(32, 9), MAGIC_TESTNET);
    assert.equal(typeof seal.update, 'function');
    const other = consensusFingerprint(MAGIC_TESTNET).replace(
      `RESERVE_NOTE=${RESERVE_NOTE_LAW}`,
      'RESERVE_NOTE=all-principal-refused',
    );
    assert.notEqual(other, fp);
  });

  it('the EVM tranche carries the note flag and withdraw does not pay it', async () => {
    const sol = readFileSync(new URL('../../contracts/Reserve.sol', import.meta.url), 'utf8');
    assert.match(sol, /struct Tranche \{[\s\S]*bool notePrincipal;/);
    const dest = destOf();
    const session = await bootReserveEvm();
    const lock = timeLock(dest, T0, 'evm-note');
    const locked = await executeBlockEvm(session, [{ coinbase: true, vout: [] }, lock], T0, T0);
    assert.equal(locked.ok, true, locked.reason);
    const open = decodePublicView(
      (await callReserve(session, encodePublicView(T0 + 1_000), { staticCall: true })).returnValue,
    );
    assert.equal(open.totalLockedNanos, PI_SHE_NANOS);
    const refused = await executeBlockEvm(session, [
      { coinbase: true, vout: [] },
      withdrawTx({ from: dest, to: dest, nanos: PI_SHE_NANOS, id: 'evm-withdraw' }),
    ], DRAW, T0);
    assert.equal(refused.ok, false);
    const still = decodePublicView(
      (await callReserve(session, encodePublicView(DRAW), { staticCall: true })).returnValue,
    );
    assert.equal(still.totalLockedNanos, PI_SHE_NANOS);
    const committed = await callReserve(session, encodeCommitRewards(DRAW));
    assert.equal(committed.ok, true, committed.reason);
    const released = decodePublicView(
      (await callReserve(session, encodePublicView(DRAW), { staticCall: true })).returnValue,
    );
    assert.equal(released.totalLockedNanos, 0);
  });

  it('rejects a withdraw when the header clock is missing', () => {
    const dest = destOf();
    const state = freshVault();
    assert.equal(applyLock(state, plainLock(dest, T0, 'clock-legacy'), T0).ok, true);
    assert.equal(applyLock(state, timeLock(dest, T0, 'clock-note'), T0, 2).ok, true);
    // Both principals, and no interest. The old missing-clock fallback pays
    // every locked nanos, so this seal would be accepted. A full-epoch
    // allCap is larger than that fallback and would still be refused.
    const loose = withdrawTx({ from: dest, to: dest, nanos: PI_SHE_NANOS * 2, id: 'no-clock' });
    for (const clock of [undefined, null, 0, Number.NaN]) {
      const got = boundReserveWithdraw(loose, state, new Set(), clock);
      assert.equal(got.ok, false, String(clock));
      assert.equal(got.reason, 'insufficient', String(clock));
    }
    const funded = verifyFundedBody([loose], () => 0, { reserveState: state });
    assert.equal(funded.reason, 'insufficient');
    const withClock = boundReserveWithdraw(loose, state, new Set(), DRAW);
    assert.equal(withClock.ok, false);
    assert.equal(withClock.reason, 'insufficient');
  });

  it('accepts the pro-rata legacy and mixed withdraw and refuses one nano either side', () => {
    const offsets = [
      ['half', Math.floor(RESERVE_EPOCH_MS / 2)],
      ['third', Math.floor(RESERVE_EPOCH_MS / 3)],
      ['last-minute', RESERVE_EPOCH_MS - 60_000],
    ];
    for (const [label, offset] of offsets) {
      for (const mixed of [false, true]) {
        const dest = destOf();
        const state = freshVault();
        const when = T0 + offset;
        const name = `${label}-${mixed ? 'mixed' : 'legacy'}`;
        assert.equal(applyLock(state, plainLock(dest, when, `${name}-legacy`), when).ok, true, name);
        if (mixed) {
          assert.equal(applyLock(state, timeLock(dest, when, `${name}-note`), when, 2).ok, true, name);
        }
        const preview = previewWithdraw(state, dest, DRAW);
        assert.equal(preview.principal, PI_SHE_NANOS, name);
        assert.equal(preview.notePrincipal, mixed ? PI_SHE_NANOS : 0, name);
        const full = interestNanos(mixed ? PI_SHE_NANOS * 2 : PI_SHE_NANOS, GENESIS_BPS);
        assert.ok(preview.interest < full, `${name} interest ${preview.interest} full ${full}`);
        assert.equal(preview.payout, preview.principal + preview.interest, name);
        const exact = withdrawTx({ from: dest, to: dest, nanos: preview.payout, id: `${name}-exact` });
        const bound = boundReserveWithdraw(exact, state, new Set(), DRAW);
        assert.equal(bound.ok, true, `${name} ${bound.reason}`);
        assert.equal(bound.principal, PI_SHE_NANOS, name);
        assert.equal(bound.cap, preview.payout, name);
        for (const delta of [-1, 1]) {
          const off = withdrawTx({
            from: dest,
            to: dest,
            nanos: preview.payout + delta,
            id: `${name}-${delta}`,
          });
          const refused = boundReserveWithdraw(off, state, new Set(), DRAW);
          assert.equal(refused.ok, false, `${name} ${delta}`);
        }
        const paid = withdraw({ state, dest, nowMs: DRAW });
        assert.equal(paid.ok, true, `${name} ${paid.reason}`);
        assert.equal(paid.principal, PI_SHE_NANOS, name);
        assert.equal(paid.interest, preview.interest, name);
        assert.equal(paid.payout, preview.payout, name);
      }
    }
  });

  it('a tranche-less legacy balance is one credit due at its lock-epoch end', () => {
    // v12 genesis has no portals. A live lock always records a tranche.
    assert.equal(V12_GENESIS_BLOCK_HASH, '');
    assert.equal(Object.keys(emptyVault().portals).length, 0);
    const recorded = freshVault();
    const recordedDest = destOf();
    assert.equal(applyLock(recorded, plainLock(recordedDest, T0, 'lump-recorded'), T0).ok, true);
    assert.equal(recorded.portals[portalIdFromDest(recordedDest)].tranches.length, 1);

    function lump() {
      const dest = destOf();
      const state = freshVault();
      state.epochStartMs = T0;
      state.currentEpoch = 0;
      const id = portalIdFromDest(dest);
      state.portals[id] = {
        id,
        dest,
        staked: BigInt(PI_SHE_NANOS),
        idle: 0n,
        joined: true,
        vote: null,
        voteEpoch: 0,
      };
      state.totalLockedNanos = BigInt(PI_SHE_NANOS);
      return { dest, state, id };
    }

    const mid = T0 + Math.floor(RESERVE_EPOCH_MS / 2);
    const early = lump();
    assert.equal(withdraw({ state: early.state, dest: early.dest, nowMs: mid }).reason, 'epoch_open');
    const earlyTx = withdrawTx({ from: early.dest, to: early.dest, nanos: PI_SHE_NANOS, id: 'lump-mid' });
    const earlyBound = boundReserveWithdraw(earlyTx, early.state, new Set(), mid);
    assert.equal(earlyBound.ok, false);
    assert.equal(earlyBound.reason, 'insufficient');
    assert.equal(supplyIdentity(early.state).ok, true);
    assert.equal(Number(early.state.totalLockedNanos), PI_SHE_NANOS);

    for (const [label, when] of [['at', DRAW], ['after', DRAW + 1]]) {
      const { dest, state } = lump();
      const preview = previewWithdraw(state, dest, when);
      assert.equal(preview.principal, PI_SHE_NANOS, label);
      assert.equal(preview.interest, 0, label);
      assert.equal(preview.payout, PI_SHE_NANOS, label);
      const exact = withdrawTx({ from: dest, to: dest, nanos: preview.payout, id: `lump-${label}` });
      const bound = boundReserveWithdraw(exact, state, new Set(), when);
      assert.equal(bound.ok, true, `${label} ${bound.reason}`);
      assert.equal(bound.cap, preview.payout, label);
      const over = boundReserveWithdraw(
        withdrawTx({ from: dest, to: dest, nanos: preview.payout + 1, id: `lump-${label}-over` }),
        state,
        new Set(),
        when,
      );
      assert.equal(over.ok, false, label);
      assert.equal(over.reason, 'insufficient', label);
      const paid = withdraw({ state, dest, nowMs: when });
      assert.equal(paid.ok, true, `${label} ${paid.reason}`);
      assert.equal(paid.principal, PI_SHE_NANOS, label);
      assert.equal(paid.interest, 0, label);
      assert.equal(paid.payout, PI_SHE_NANOS, label);
      const identity = supplyIdentity(state);
      assert.equal(identity.ok, true, `${label} ${identity.reason}`);
      assert.equal(identity.mintedReward, 0, label);
      assert.equal(Number(state.totalLockedNanos), 0, label);
    }

    const later = lump();
    later.state.bonusEnacted = true;
    const nextMid = DRAW + Math.floor(RESERVE_EPOCH_MS / 2);
    const rolled = applyReserveBlock({
      state: later.state,
      block: { height: 2, txs: [] },
      nowMs: nextMid,
      genesisMs: T0,
    });
    assert.equal(rolled.some((row) => row && row.ok === false), false, JSON.stringify(rolled));
    assert.equal(later.state.currentEpoch, 1);
    assert.equal(later.state.portals[later.id].lockEpoch, 0);
    const still = previewWithdraw(later.state, later.dest, nextMid);
    assert.equal(still.principal, PI_SHE_NANOS);
    assert.equal(still.payout, PI_SHE_NANOS);
    const paidLater = withdraw({ state: later.state, dest: later.dest, nowMs: nextMid });
    assert.equal(paidLater.ok, true, paidLater.reason);
    assert.equal(paidLater.principal, PI_SHE_NANOS);
    assert.equal(paidLater.interest, 0);
    assert.equal(paidLater.payout, PI_SHE_NANOS);
    const laterIdentity = supplyIdentity(later.state);
    assert.equal(laterIdentity.ok, true, laterIdentity.reason);
    assert.equal(laterIdentity.mintedReward, 0);
  });
});

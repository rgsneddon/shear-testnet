/**
 * A lock is a commitment tranche. The amount is not on the tranche, the
 * action, or totalLocked until an epoch aggregate is opened. Public interest
 * rows stay empty; the ZK claim is the payment. The commitment stays until
 * withdraw, and that withdraw's public principal is 0.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash20FromAddress, newIdentity, spendDestOf } from './address.js';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, RESERVE_PROGRAM, SPENDABLE_CONFIRMATIONS, extraMintAllowed } from './asert.js';
import { encodeHeader } from './header.js';
import { outputJoinsAdmitSet } from './admit.js';
import { compactTx } from './chronoflux.js';
import { fs1LeafFor } from './fs1_leaf.js';
import { selectBodyIndexes, txVerifyWeight } from './block_budget.js';
import { FEE_SPLIT_FINDER_BPS, LEVY_CAP_NANOS, levyNanos, levyNeed, levyTaxed, splitLevy } from './levy.js';
import { admitMempool, emptyMempool } from './mempool.js';
import { EMPTY_ROOT, merkleRoot } from './merkle.js';
import {
  KIND_REWARD_CLAIM,
  applyReserveBlock,
  coinbaseRewardRoot,
  consensusUnlockPeriod,
  emptyVault,
  lockStampRejected,
  attachLockEquality,
  lockWitnessOf,
  lockNoteSpendRejected,
  packRewardAuth,
  portalEpochInterest,
  portalIdFromDest,
  portalPrincipalNanos,
  rewardClaimProof,
  rewardClaimTx,
  rewardCommitment,
  rewardOwnerCommit,
  txIsReserveAction,
  stakeRewardSupply,
  signWithdrawReward,
  trialReserveApply,
  voteTx,
  VOTE_HOLD,
  withdraw,
  withdrawMintId,
  withdrawTx,
} from './reserve_vault.js';
import { handleWalletApi } from '../pool/src/wallet_api.js';
import {
  bootReserveEvm,
  callReserve,
  decodeBytes32,
  decodePublicView,
  decodeWithdraw,
  encodeClaim,
  encodeCommitRewards,
  encodePinClock,
  encodePublicView,
  executeBlockEvm,
} from './reserve_evm.js';
import { deposit, encodeDeposit, encodeWithdraw, lockTx } from './owned_portal.js';
import { randomScalar, sealCoinbaseNote } from './note.js';
import { vaultLockNote } from './vault_reward_fs1.js';
import { createNoteLedger } from '../node/src/note_ledger.js';
import { createStore } from '../node/src/store.js';

const T0 = 1_700_000_000_000;

function who() {
  return spendDestOf(newIdentity().spendPub);
}

function vault() {
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  state.genesisMs = T0;
  return state;
}

/** A π lock is a leaf. A smaller amount has no leaf and consensus refuses it. */
function attachPiNote(tx) {
  const held = lockWitnessOf(tx);
  if (!held) return tx;
  const leaf = vaultLockNote(held.amount, randomScalar(), held.blind, consensusUnlockPeriod(0));
  if (leaf) {
    tx.vaultLockNote = leaf.note;
    // The π proof a wallet attaches with the note. A note with no proof is
    // the stripped lock applyReserveBlock refuses (2461ec67).
    if (!attachLockEquality(tx)) throw new Error(`π proof ${tx.id}`);
  }
  return tx;
}

function lockNote(dest, nanos, id) {
  return attachPiNote(lockTx({
    from: dest,
    to: dest,
    nanos,
    id,
    timeLock: true,
    lockEpoch: 0,
    unlockAtMs: T0 + RESERVE_EPOCH_MS,
  }));
}

describe('time-locked lock notes', () => {
  it('indexes a lock and spends it only after the epoch ends', () => {
    const dest = who();
    const tx = lockNote(dest, 1000, 'lock-note');
    const out = tx.vout[0];
    assert.equal(outputJoinsAdmitSet(tx, out), false);
    assert.equal(out.admitPub, undefined);
    assert.ok(!fs1LeafFor(out));
    const book = createNoteLedger();
    book.sync([{ height: 1, hash: Buffer.alloc(32, 1), txs: [tx] }]);
    const before = book.spendable(dest, 1, { need: 1, tipMs: T0 + 1, genesisMs: T0 });
    const after = book.spendable(dest, 1, {
      need: 1,
      tipMs: T0 + RESERVE_EPOCH_MS,
      genesisMs: T0,
    });
    assert.equal(out.valueProof, undefined);
    assert.equal(out.nanos, undefined);
    assert.ok(out.commit);
    assert.ok(out.rangeProof);
    assert.equal(before, 0);
    assert.equal(after, 0);
  });

  it('a Vault lock stays unspendable after unlock and a hard lock opens', () => {
    const dest = who();
    const d20 = hash20FromAddress(dest);
    const opened = 1_000_000;
    const plain = sealCoinbaseNote(opened, { dest20: d20, kind: 'lock', skipRange: true });
    plain.unlockAtMs = T0 + RESERVE_EPOCH_MS;
    const vault = sealCoinbaseNote(opened, { dest20: d20, kind: 'lock', skipRange: true });
    vault.unlockAtMs = T0 + RESERVE_EPOCH_MS;
    vault.portalId = 'ab'.repeat(32);
    vault.lockIndex = 3;
    const clock = { need: 1, genesisMs: T0 };
    const book = createNoteLedger();
    book.sync([{ height: 1, hash: Buffer.alloc(32, 9), txs: [{ kind: 'lock', vout: [plain, vault] }] }]);
    assert.equal(book.spendable(dest, 1, { ...clock, tipMs: T0 + 1 }), 0);
    assert.equal(book.spendable(dest, 1, { ...clock, tipMs: T0 + RESERVE_EPOCH_MS }), opened);
    assert.equal(book.unlockedLockNanos(dest, 1, { ...clock, tipMs: T0 + RESERVE_EPOCH_MS }), opened);
    const onlyVault = createNoteLedger();
    onlyVault.sync([{ height: 1, hash: Buffer.alloc(32, 10), txs: [{ kind: 'lock', vout: [vault] }] }]);
    const after = { ...clock, tipMs: T0 + RESERVE_EPOCH_MS };
    assert.equal(onlyVault.spendable(dest, 1, after), 0);
    assert.equal(onlyVault.unlockedLockNanos(dest, 1, after), 0);
    assert.equal(onlyVault.coveredLockNanos(dest, 1, after), 0);
    assert.equal(onlyVault.coveredLockNanos(dest, 1, { ...clock, tipMs: T0 + 1 }), 0);
    const tipMs = T0 + RESERVE_EPOCH_MS;
    const pot = sealCoinbaseNote(opened, { dest20: d20, kind: 'pot', skipRange: true });
    const z = Buffer.alloc(32);
    const header = encodeHeader({
      prevBlockHash: z,
      merkleRoot: z,
      continuityRoot: z,
      timestamp: tipMs,
      bits: 1,
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-autocredit-'));
    try {
      const store = createStore(dir, { diskJournal: false });
      store.reserveVault.genesisMs = T0;
      const pid = portalIdFromDest(dest);
      store.reserveVault.portals[pid] = {
        id: pid,
        staked: 0n,
        idle: 0n,
        redeemedNanos: 0n,
      };
      store.blocks.push({
        height: 1,
        hash: Buffer.alloc(32, 11),
        header,
        txs: [{ kind: 'send', vout: [pot, vault] }],
      });
      for (let h = 2; h <= SPENDABLE_CONFIRMATIONS; h += 1) {
        store.blocks.push({
          height: h,
          hash: Buffer.alloc(32, h),
          header,
          txs: [],
        });
      }
      assert.equal(store.spendableNanos(dest), opened);
      store.reserveVault.portals[pid].staked = BigInt(opened);
      assert.equal(store.spendableNanos(dest), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(book.coveredLockNanos(dest, 1, { ...clock, tipMs: T0 + RESERVE_EPOCH_MS }), opened);
  });

  it('keeps two top-ups as two notes that unlock together', () => {
    const dest = who();
    const first = lockNote(dest, 400, 'top-a');
    const second = lockNote(dest, 600, 'top-b');
    assert.equal(first.vout[0].unlockAtMs, second.vout[0].unlockAtMs);
    assert.notEqual(first.vout[0].commit.toString('hex'), second.vout[0].commit.toString('hex'));
    const book = createNoteLedger();
    book.sync([{ height: 1, hash: Buffer.alloc(32, 2), txs: [first, second] }]);
    const held = book.spendable(dest, 1, { need: 1, tipMs: T0 + 1, genesisMs: T0 });
    const free = book.spendable(dest, 1, {
      need: 1,
      tipMs: T0 + RESERVE_EPOCH_MS,
      genesisMs: T0,
    });
    assert.equal(held, 0);
    assert.equal(free, 0);
  });

  it('rejects a spend of the lock note before unlock', () => {
    const dest = who();
    const state = vault();
    const tx = lockNote(dest, PI_SHE_NANOS, 'lock-spend');
    const applied = applyReserveBlock({
      state,
      block: { height: 1, txs: [tx] },
      nowMs: T0 + 1_000,
      genesisMs: T0,
    });
    assert.equal(applied.ok, true, applied.reason);
    const spend = { vin: [{ commit: tx.vout[0].commit }] };
    assert.equal(lockNoteSpendRejected(state, spend, T0 + 2_000), null);
    assert.equal(lockNoteSpendRejected(state, spend, T0 + RESERVE_EPOCH_MS), null);
    assert.equal(state.portals[portalIdFromDest(dest)].tranches[0].noteCommit, undefined);
  });

  it('keeps the unlock on the sealed lock and refuses a different one', () => {
    const dest = who();
    const tx = lockNote(dest, 1000, 'lock-wire');
    const wire = compactTx(tx);
    assert.equal(wire.vout[0].unlockAtMs, T0 + RESERVE_EPOCH_MS);
    assert.equal(wire.vout[0].lockEpoch, 0);
    assert.equal(wire.vout[0].admitPub, undefined);
    assert.equal(wire.vout[0].r, undefined);
    const plain = compactTx(lockTx({ from: dest, to: dest, nanos: 1000, id: 'plain-lock' }));
    assert.equal(plain.vout[0].unlockAtMs, undefined);
    assert.equal(plain.vout[0].lockEpoch, undefined);
    const state = vault();
    const bad = lockTx({
      from: dest,
      to: dest,
      nanos: 1000,
      id: 'early-lock',
      timeLock: true,
      lockEpoch: 0,
      unlockAtMs: T0 + 1,
    });
    assert.equal(lockStampRejected(state, bad, T0 + 1_000).reason, 'lock_unlock');
    const refused = applyReserveBlock({
      state,
      block: { height: 1, txs: [bad] },
      nowMs: T0 + 1_000,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');
    assert.equal(Number(state.totalLockedNanos), 0);
    const book = createNoteLedger();
    book.sync([{ height: 1, hash: Buffer.alloc(32, 7), txs: [wire] }]);
    assert.equal(wire.vout[0].valueProof, undefined);
    assert.ok(wire.vout[0].rangeProof);
    assert.equal(book.spendable(dest, 1, { need: 1, tipMs: T0 + 1, genesisMs: T0 }), 0);
    assert.equal(book.spendable(dest, 1, {
      need: 1,
      tipMs: T0 + RESERVE_EPOCH_MS,
      genesisMs: T0,
    }), 0);
  });

  it('keeps principal in the vault after the epoch, and the lock is not a note', () => {
    const payer = who();
    const dest = who();
    const state = vault();
    const tx = lockTx({
      from: payer,
      to: dest,
      nanos: PI_SHE_NANOS,
      id: 'principal-note',
      timeLock: true,
      lockEpoch: 0,
      unlockAtMs: T0 + RESERVE_EPOCH_MS,
    });
    attachPiNote(tx);
    const locked = applyReserveBlock({
      state,
      block: { height: 1, txs: [tx] },
      nowMs: T0 + 1_000,
      genesisMs: T0,
    });
    assert.equal(locked.ok, true, locked.reason);
    const portal = state.portals[Object.keys(state.portals)[0]];
    assert.notEqual(portal.tranches[0].noteIsPrincipal, true);
    assert.equal(portal.tranches[0].noteCommit, undefined);
    assert.equal(portal.tranches[0].amount, undefined);
    assert.equal(String(portal.tranches[0].commit).length, 64);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 0);
    assert.equal(portalEpochInterest(state, portal, draw), 0);
    const credited = applyReserveBlock({
      state,
      block: { height: 2, txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] },
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(credited.ok, true, credited.reason);
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal(portalPrincipalNanos(state, payer), 0);
    assert.equal(portalPrincipalNanos(state, dest), 0);
    const book = createNoteLedger();
    book.sync([{ height: 1, hash: Buffer.alloc(32, 8), txs: [compactTx(tx)] }]);
    const clock = { need: 1, tipMs: draw, genesisMs: T0 };
    const opened = book.spendable(dest, 1, clock);
    const released = book.unlockedLockNanos(dest, 1, clock);
    const principal = portalPrincipalNanos(state, dest);
    assert.equal(opened, 0);
    assert.equal(released, 0);
    assert.equal(principal, 0);
    assert.equal(Math.max(0, opened - Math.max(0, principal - released)), 0);
    const payerOpened = book.spendable(payer, 1, clock);
    const payerReleased = book.unlockedLockNanos(payer, 1, clock);
    const payerPrincipal = portalPrincipalNanos(state, payer);
    assert.equal(Math.max(0, payerOpened - Math.max(0, payerPrincipal - payerReleased)), 0);
  });
});

function holder() {
  const id = newIdentity();
  return {
    dest: spendDestOf(id.spendPub),
    pub: Buffer.from(id.spendPub).toString('hex'),
    key: id.privateKey,
  };
}

function lockPortal(state, dest, when = T0 + 1_000, ownerPub = null) {
  return deposit({
    state,
    dest,
    nanos: PI_SHE_NANOS,
    nowMs: when,
    payout: dest,
    ownerPub: ownerPub || undefined,
  });
}

function commitBlock(plan) {
  return { height: 2, txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] };
}

describe('aggregated reward root', () => {
  it('publishes an empty interest root; the qualify bit and the cutoff stay', () => {
    const dest = who();
    const state = vault();
    assert.equal(lockPortal(state, dest).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const portal = state.portals[portalIdFromDest(dest)];
    const tranche = portal.tranches[0];
    assert.equal(tranche.amount, undefined);
    assert.equal(String(tranche.commit).length, 64);
    assert.equal(portal.qualified, true);
    assert.ok(tranche.remainMs > RESERVE_EPOCH_MS / 4);
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 0);
    assert.equal(plan.root, Buffer.from(EMPTY_ROOT).toString('hex'));
    assert.equal(portalEpochInterest(state, portal, draw), 0);
    assert.equal(Number(state.totalLockedNanos), 0);
    const below = vault();
    const dust = who();
    assert.equal(deposit({
      state: below, dest: dust, nanos: 1, nowMs: T0 + 1_000, payout: dust,
    }).ok, true);
    assert.equal(below.portals[portalIdFromDest(dust)].qualified, undefined);
    assert.equal(rewardCommitment(below, draw).rows.length, 0);
    const late = vault();
    const lateDest = who();
    assert.equal(lockPortal(late, lateDest, T0 + RESERVE_EPOCH_MS - 1_000).ok, true);
    const lateTranche = late.portals[portalIdFromDest(lateDest)].tranches[0];
    assert.equal(lateTranche.remainMs, 1000);
    assert.ok(lateTranche.remainMs < RESERVE_EPOCH_MS / 4);
    assert.equal(rewardCommitment(late, draw).rows.length, 0);
    const many = vault();
    for (let i = 0; i < 9; i += 1) assert.equal(lockPortal(many, who()).ok, true);
    const wide = rewardCommitment(many, draw);
    assert.equal(wide.rows.length, 0);
    assert.equal(wide.root, Buffer.from(merkleRoot([])).toString('hex'));
    assert.equal(Number(many.lockCommitCount[0]), 9);
    const committed = applyReserveBlock({
      state: many,
      block: commitBlock(wide),
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(Number(many.mintBankNanos), 0);
    assert.equal(Number(many.totalLockedNanos), 0);
    const rowNote = { coinbase: true, vout: [{ kind: 'stake-reward' }], rewardRoot: wide.root };
    const refused = applyReserveBlock({
      state: vault(),
      block: { height: 2, txs: [rowNote] },
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(refused.reason, 'stake_reward');
  });

  it('refuses every plaintext claim and withdraws hidden principal as 0', () => {
    const alice = holder();
    const lockDest = alice.dest;
    const payDest = who();
    const state = vault();
    assert.equal(lockPortal(state, lockDest, T0 + 1_000, alice.pub).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 0);
    assert.notEqual(payDest, lockDest);
    const committed = applyReserveBlock({
      state,
      block: commitBlock(plan),
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(Number(state.mintBankNanos), 0);
    const nullifier = withdrawMintId(portalIdFromDest(lockDest), 0);
    const claim = rewardClaimTx({
      to: payDest,
      nanos: 1,
      nullifier,
      proof: [],
      id: 'claim-once',
      ownerKey: alice.key,
    });
    assert.equal(claim.kind, KIND_REWARD_CLAIM);
    assert.equal(claim.portalId, undefined);
    assert.equal(claim.vout[0].portalId, undefined);
    assert.equal(claim.nullifier, nullifier);
    assert.ok(fs1LeafFor(claim.vout[0]));
    assert.equal(outputJoinsAdmitSet(claim, claim.vout[0]), true);
    assert.equal(levyTaxed(claim), true);
    assert.equal(claim.fee, levyNanos(0, { tx: { ...claim, fee: undefined } }));
    const later = draw + 3 * RESERVE_EPOCH_MS;
    const paid = applyReserveBlock({
      state,
      block: { height: 9, txs: [{ coinbase: true, vout: [] }, claim] },
      nowMs: later,
      genesisMs: T0,
    });
    assert.equal(paid.ok, false);
    assert.equal(paid.reason, 'claim_unavailable');
    assert.equal(Number(state.mintBankNanos), 0);
    assert.equal(Number(state.totalLockedNanos), 0);
    const supply = stakeRewardSupply(state, { txs: [{ coinbase: true, vout: [] }, claim] }, later);
    assert.equal(supply.ok, false);
    assert.equal(supply.reason, 'supply');
    const fresh = vault();
    assert.equal(lockPortal(fresh, lockDest, T0 + 1_000, alice.pub).ok, true);
    const other = who();
    assert.equal(lockPortal(fresh, other).ok, true);
    const both = rewardCommitment(fresh, draw);
    assert.equal(both.rows.length, 0);
    assert.equal(Number(fresh.lockCommitCount[0]), 2);
    assert.equal(applyReserveBlock({
      state: fresh,
      block: commitBlock(both),
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    }).ok, true);
    const claimOne = rewardClaimTx({
      to: payDest,
      nanos: 1,
      nullifier,
      proof: [],
      id: 'claim-one',
      ownerKey: alice.key,
    });
    const block = { height: 4, txs: [{ coinbase: true, vout: [] }, claimOne] };
    const claimedOnce = applyReserveBlock({
      state: fresh,
      block,
      nowMs: later,
      genesisMs: T0,
    });
    assert.equal(claimedOnce.ok, false);
    assert.equal(claimedOnce.reason, 'claim_unavailable');
    const summed = stakeRewardSupply(fresh, block, later);
    assert.equal(summed.ok, false);
    assert.equal(summed.reason, 'supply');
    const supplyState = vault();
    const bob = holder();
    assert.equal(lockPortal(supplyState, lockDest, T0 + 1_000, alice.pub).ok, true);
    assert.equal(lockPortal(supplyState, bob.dest, T0 + 1_000, bob.pub).ok, true);
    const open = rewardCommitment(supplyState, draw);
    assert.equal(open.rows.length, 0);
    const supplyBlock = {
      height: 4,
      txs: [
        { coinbase: true, vout: [], rewardRoot: open.root },
        rewardClaimTx({
          to: payDest,
          nanos: 1,
          nullifier,
          proof: [],
          id: 'claim-supply',
          ownerKey: alice.key,
        }),
      ],
    };
    const got = stakeRewardSupply(supplyState, supplyBlock, draw);
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'supply');
    assert.equal(got.minted, 0n);
    assert.equal(got.claimed, 0n);
    const spent = applyReserveBlock({
      state: supplyState,
      block: supplyBlock,
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
    assert.equal(spent.ok, false);
    assert.equal(spent.reason, 'claim_unavailable');
    const second = rewardClaimTx({
      to: payDest,
      nanos: 1,
      nullifier,
      proof: [],
      id: 'claim-again',
      ownerKey: alice.key,
    });
    const doubled = applyReserveBlock({
      state: supplyState,
      block: { height: 5, txs: [{ coinbase: true, vout: [] }, second] },
      nowMs: later,
      genesisMs: T0,
    });
    assert.equal(doubled.ok, false);
    assert.equal(doubled.reason, 'claim_unavailable');
    assert.equal(Number(supplyState.totalLockedNanos), 0);
    // A matured hidden commitment with no lock-note index is not a receipt.
    // It does not pay principal 0, and it does not mint.
    const principal = withdraw({ state: supplyState, dest: lockDest, nowMs: later });
    assert.equal(principal.ok, false);
    assert.equal(principal.reason, 'stake_reward');
    assert.equal((supplyState.pendingWithdraw || []).length, 0);
    assert.equal(Number(supplyState.totalLockedNanos), 0);
    assert.equal(Number(supplyState.mintBankNanos), 0);
  });

  it('undoes the root and its claim when the block is rejected', () => {
    const dest = who();
    const state = vault();
    assert.equal(lockPortal(state, dest).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 0);
    const claim = rewardClaimTx({
      to: who(),
      nanos: 1,
      nullifier: withdrawMintId(portalIdFromDest(dest), 0),
      proof: [],
      id: 'claim-undo',
    });
    const beforeLocked = Number(state.totalLockedNanos);
    const trial = trialReserveApply({
      state,
      block: {
        height: 2,
        txs: [
          { coinbase: true, vout: [], rewardRoot: plan.root },
          claim,
          voteTx({ from: dest, dest, choice: VOTE_HOLD, id: 'late-vote' }),
        ],
      },
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
      inPlace: true,
    });
    assert.equal(trial.ok, false);
    assert.equal(Number(state.totalLockedNanos), beforeLocked);
    assert.equal(Number(state.mintBankNanos), 0);
    assert.equal(state.rewardRoots[String(plan.index)], undefined);
    // The rejected trial left the lock in place. That lock is still an
    // unindexed hidden commitment, so it is not a withdraw receipt.
    const left = withdraw({ state, dest, nowMs: draw });
    assert.equal(left.ok, false);
    assert.equal(left.reason, 'stake_reward');
    assert.equal(Number(state.mintBankNanos), 0);
  });

  it('matches the EVM root, refuses every claim, and pays principal only', async () => {
    const alice = holder();
    const dest = alice.dest;
    const state = vault();
    const when = T0 + 1_000;
    assert.equal(lockPortal(state, dest, when, alice.pub).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 0);
    const commit = Buffer.from(state.portals[portalIdFromDest(dest)].tranches[0].commit, 'hex');
    const session = await bootReserveEvm({ network: 'shear-testnet-v12' });
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, commit, when, { key: alice.key, magic: 'shear-testnet-v12' }))).ok, true);
    const committed = await callReserve(session, encodeCommitRewards(draw, plan.root));
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(decodeBytes32(committed.returnValue), plan.root);
    const nullifier = withdrawMintId(portalIdFromDest(dest), 0);
    const signed = rewardClaimTx({
      to: who(),
      nanos: 1,
      nullifier,
      proof: [],
      ownerKey: alice.key,
      id: 'evm-once',
    });
    const auth = packRewardAuth({ ownerPub: alice.pub, sig: signed.sig, dest: signed.to });
    const claimed = await callReserve(session, encodeClaim(nullifier, 0, new Uint8Array(), plan.index, auth));
    assert.equal(claimed.ok, false);
    assert.equal(claimed.reason, 'claim_unavailable');
    const again = await callReserve(session, encodeClaim(nullifier, 0, new Uint8Array(), plan.index, auth));
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'claim_unavailable');
    const held = decodePublicView(
      (await callReserve(session, encodePublicView(draw), { staticCall: true })).returnValue,
    );
    assert.equal(held.totalLockedNanos, 0);
    const drawTx = withdrawTx({ from: dest, to: dest, nanos: 0, id: 'evm-principal' });
    signWithdrawReward(drawTx, alice.key, {
      portalId: portalIdFromDest(dest),
      nanos: 0,
      dest,
      state,
      nowMs: draw,
    });
    const drawAuth = packRewardAuth({ ownerPub: alice.pub, sig: drawTx.rewardSig, dest });
    const drawn = await callReserve(session, encodeWithdraw(dest, draw, drawAuth));
    assert.equal(drawn.ok, false);
    assert.equal(drawn.reason, 'unsigned');
  });

  it('orders mempool claims by fee rate and pays the whole fee to miners', () => {
    const state = vault();
    const lockDest = who();
    const other = who();
    assert.equal(lockPortal(state, lockDest).ok, true);
    assert.equal(lockPortal(state, other).ok, true);
    const draw = T0 + RESERVE_EPOCH_MS + 1;
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 0);
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal(applyReserveBlock({
      state,
      block: commitBlock(plan),
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    }).ok, true);
    const pay = who();
    const low = rewardClaimTx({
      to: pay,
      nanos: 1,
      nullifier: '11'.repeat(32),
      proof: [],
      id: 'claim-low',
      fee: 1_000,
    });
    const high = rewardClaimTx({
      to: who(),
      nanos: 1,
      nullifier: '22'.repeat(32),
      proof: [],
      id: 'claim-high',
      fee: 8_000,
    });
    assert.equal(low.fee, 1_000);
    assert.equal(high.fee, 8_000);
    assert.equal(txIsReserveAction(low), false);
    assert.equal(levyTaxed(low), true);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'reward-claim' }), true);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'claim' }), false);
    const floor = rewardClaimTx({
      to: pay,
      nanos: 1,
      nullifier: '11'.repeat(32),
      proof: [],
      id: 'claim-floor',
    });
    assert.ok(floor.fee >= levyNanos(0, { tx: { ...floor, fee: undefined } }));
    assert.equal(floor.fee, levyNanos(0, { tx: floor }));
    assert.ok(low.fee >= levyNeed(low));
    assert.ok(low.fee <= LEVY_CAP_NANOS);
    assert.ok(high.fee > low.fee);

    const book = emptyMempool();
    const admittedLow = admitMempool(book, low);
    const admittedHigh = admitMempool(book, high);
    assert.equal(admittedLow.ok, true, admittedLow.reason);
    assert.equal(admittedHigh.ok, true, admittedHigh.reason);
    const picks = selectBodyIndexes(book.txs);
    assert.equal(book.txs[picks[0]].id, 'claim-high');
    assert.equal(book.txs[picks[1]].id, 'claim-low');

    const heavy = {
      ...high,
      id: 'claim-heavy',
      fee: 1_500,
      vout: [high.vout[0], { ...high.vout[0] }],
    };
    const light = { ...low, id: 'claim-light', fee: 1_000 };
    assert.ok(txVerifyWeight(heavy) > txVerifyWeight(light));
    assert.ok(heavy.fee > light.fee);
    assert.ok(light.fee * txVerifyWeight(heavy) > heavy.fee * txVerifyWeight(light));
    assert.deepEqual(selectBodyIndexes([heavy, light]), [1, 0]);

    const crowd = [];
    for (let i = 0; i < 33; i += 1) {
      const lock = lockTx({ from: who(), to: who(), nanos: 1, id: `busy-lock-${i}` });
      lock.fee = 50_000;
      crowd.push(lock);
    }
    crowd.push(low);
    const busy = selectBodyIndexes(crowd);
    const busyLocks = busy.filter((i) => crowd[i].kind === 'lock');
    assert.equal(busyLocks.length, 32);
    assert.ok(busy.some((i) => crowd[i].id === 'claim-low'));

    assert.equal(FEE_SPLIT_FINDER_BPS, 10_000);
    assert.deepEqual(splitLevy(low.fee + high.fee), {
      finder: low.fee + high.fee,
      reserve: 0,
    });

    const posted = [];
    const body = {
      kind: 'reward-claim',
      programId: 'shear-reserve-v1',
      to: pay,
      nanos: 1,
      nullifier: '11'.repeat(32),
      proof: low.proof,
      vout: low.vout,
      id: 'claim-post',
      fee: 8_000,
    };
    const accepted = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', body, {
      queueSend: (tx) => {
        posted.push(tx);
        return tx;
      },
    });
    assert.equal(accepted.status, 200, accepted.json && accepted.json.reason);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].fee, 8_000);
    assert.equal(posted[0].kind, 'reward-claim');
    const short = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', {
      ...body,
      fee: 1,
      id: 'claim-short',
    }, { queueSend: (tx) => tx });
    assert.equal(short.status, 400);
    assert.equal(short.json.reason, 'levy');
    const bare = { ...body, id: 'claim-bare' };
    delete bare.fee;
    const noFee = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', bare, {
      queueSend: (tx) => tx,
    });
    assert.equal(noFee.status, 400);
    assert.equal(noFee.json.reason, 'bad_send');
  });
});

describe('empty reward epochs leave principal in the vault', () => {
  const draw = T0 + RESERVE_EPOCH_MS + 1;
  const emptyRoot = Buffer.from(EMPTY_ROOT).toString('hex');

  function timeLock(state, dest, nanos, when, id) {
    const tx = lockTx({
      from: dest,
      to: dest,
      nanos,
      id,
      timeLock: true,
      lockEpoch: 0,
      unlockAtMs: T0 + RESERVE_EPOCH_MS,
    });
    attachPiNote(tx);
    const applied = applyReserveBlock({
      state,
      block: { height: 1, txs: [tx] },
      nowMs: when,
      genesisMs: T0,
    });
    return { tx, applied };
  }

  function settle(state, root) {
    const cb = { coinbase: true, vout: [] };
    if (root != null) cb.rewardRoot = root;
    return applyReserveBlock({
      state,
      block: { height: 2, txs: [cb] },
      nowMs: draw,
      genesisMs: T0,
      requireStakeReward: true,
    });
  }

  function stillLocked(state, dest) {
    const portal = state.portals[portalIdFromDest(dest)];
    assert.equal(portal.tranches.length, 1);
    assert.equal(portal.tranches[0].amount, undefined);
    assert.equal(String(portal.tranches[0].commit).length, 64);
    assert.equal(Number(portal.staked) + Number(portal.idle), 0);
    assert.equal(Number(portal.redeemedNanos || 0), 0);
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal((state.pendingWithdraw || []).length, 0);
  }

  it('an epoch with no earning portals leaves principal in the vault', () => {
    const dest = who();
    const state = vault();
    state.epochBps = 0;
    state.pendingRates[0] = 0;
    const { tx, applied } = timeLock(state, dest, PI_SHE_NANOS, T0 + 1_000, 'zero-rate');
    assert.equal(applied.ok, true, applied.reason);
    assert.equal(rewardCommitment(state, draw).rows.length, 0);
    assert.equal(coinbaseRewardRoot(state, draw), '');
    assert.equal(lockNoteSpendRejected(state, { vin: [{ commit: tx.vout[0].commit }] }, T0 + 2_000), null);
    const settled = settle(state);
    assert.equal(settled.ok, true, settled.reason);
    stillLocked(state, dest);
    assert.equal(lockNoteSpendRejected(state, { vin: [{ commit: tx.vout[0].commit }] }, draw), null);
    assert.equal(coinbaseRewardRoot(state, draw), '');
    assert.equal(Number(state.mintBankNanos), 0);

    const earning = vault();
    assert.equal(lockPortal(earning, who()).ok, true);
    const missing = settle(earning);
    assert.equal(missing.ok, true, missing.reason);
    assert.equal(rewardCommitment(earning, draw).rows.length, 0);
    assert.equal(Number(earning.totalLockedNanos), 0);
    assert.equal(earning.portals[Object.keys(earning.portals)[0]].qualified, true);
  });

  it('an empty-root epoch leaves principal in the vault', async () => {
    const dest = who();
    const state = vault();
    const { applied } = timeLock(state, dest, 1, T0 + 1_000, 'empty-root');
    assert.equal(applied.ok, false);
    assert.equal(applied.reason, 'stake_reward');
    assert.equal(state.portals[portalIdFromDest(dest)], undefined);
    assert.equal(Number(state.totalLockedNanos), 0);
    const plan = rewardCommitment(state, draw);
    assert.equal(plan.rows.length, 0);
    assert.equal(plan.root, emptyRoot);
    const settled = settle(state, emptyRoot);
    assert.equal(settled.ok, true, settled.reason);
    assert.equal(state.rewardRoots[String(plan.index)], undefined);

    const session = await bootReserveEvm({ network: 'shear-testnet-v12' });
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, Buffer.alloc(32, 3), T0 + 1_000))).ok, true);
    const committed = await callReserve(session, encodeCommitRewards(draw));
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(decodeBytes32(committed.returnValue), emptyRoot);
    const view = decodePublicView(
      (await callReserve(session, encodePublicView(draw), { staticCall: true })).returnValue,
    );
    assert.equal(view.totalLockedNanos, 0);

    const again = await bootReserveEvm({ network: 'shear-testnet-v12' });
    assert.equal((await callReserve(again, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(again, encodeDeposit(dest, Buffer.alloc(32, 3), T0 + 1_000))).ok, true);
    const ran = await executeBlockEvm(again, [{
      coinbase: true,
      vout: [],
      rewardRoot: emptyRoot,
    }], draw, T0);
    assert.equal(ran.ok, true, ran.reason);
    const ranView = decodePublicView(
      (await callReserve(again, encodePublicView(draw), { staticCall: true })).returnValue,
    );
    assert.equal(ranView.totalLockedNanos, 0);
  });

  it('post-cutoff and below-pi locks stay in the vault until withdraw', async () => {
    const lateWhen = T0 + RESERVE_EPOCH_MS - 1_000;
    const lateDest = who();
    const late = vault();
    const lateLock = timeLock(late, lateDest, PI_SHE_NANOS, lateWhen, 'post-cutoff');
    assert.equal(lateLock.applied.ok, true, lateLock.applied.reason);
    assert.equal(rewardCommitment(late, draw).rows.length, 0);
    assert.equal(settle(late).ok, true);
    stillLocked(late, lateDest);
    assert.equal(lockNoteSpendRejected(late, { vin: [{ commit: lateLock.tx.vout[0].commit }] }, draw), null);

    const smallDest = who();
    const small = vault();
    const smallLock = timeLock(small, smallDest, 1, T0 + 1_000, 'below-pi');
    assert.equal(smallLock.applied.ok, false);
    assert.equal(smallLock.applied.reason, 'stake_reward');
    assert.equal(small.portals[portalIdFromDest(smallDest)], undefined);
    assert.equal(Number(small.totalLockedNanos), 0);
    assert.equal(rewardCommitment(small, draw).rows.length, 0);

    const book = createNoteLedger();
    const wire = compactTx(smallLock.tx);
    book.sync([
      { height: 1, hash: Buffer.alloc(32, 4), txs: [wire] },
      {
        height: 2,
        hash: Buffer.alloc(32, 5),
        txs: [{ vin: [{ noteCommit: wire.vout[0].noteCommit }], vout: [] }],
      },
    ]);
    const clock = { need: 1, tipMs: draw, genesisMs: T0 };
    assert.equal(book.unlockedLockNanos(smallDest, 2, clock), 0);
    assert.equal(book.coveredLockNanos(smallDest, 2, clock), 0);
    const inbound = 500;
    const principal = portalPrincipalNanos(small, smallDest);
    assert.equal(principal, 0);
    assert.equal(
      Math.max(0, inbound - Math.max(0, principal - book.coveredLockNanos(smallDest, 2, clock))),
      inbound,
    );

    const session = await bootReserveEvm({ network: 'shear-testnet-v12' });
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(lateDest, Buffer.alloc(32, 9), lateWhen))).ok, true);
    const lateCommit = await callReserve(session, encodeCommitRewards(draw));
    assert.equal(lateCommit.ok, true, lateCommit.reason);
    assert.equal(decodeBytes32(lateCommit.returnValue), emptyRoot);
    const lateView = decodePublicView(
      (await callReserve(session, encodePublicView(draw), { staticCall: true })).returnValue,
    );
    assert.equal(lateView.totalLockedNanos, 0);
  });
});

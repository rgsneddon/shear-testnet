/**
 * Privacy, cartographer, and Vault Security checks on the hidden vault claim.
 * A lone claim is not opened. Two claims open their sum. Remain is a
 * commitment. The nullifier is not a function of the public spend tag.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { newIdentity, hash20FromAddress } from './address.js';
import { vaultDest } from './flow_sheet.js';
import {
  commit,
  hashToScalar,
  H,
  pointBytes,
  pointFrom,
  proveRange,
  proveValue,
  randomScalar,
  scalarBytes,
} from './note.js';
import { typedCommitSum } from './spend.js';
import {
  appendVaultLockNote,
  applyReserveBlock,
  deposit,
  emptyVault,
  lockFundContext,
  lockFundingRejected,
  lockTx,
  portalIdFromDest,
  rewardClaimTx,
  rewardOwnerCommit,
  rollRewardRejected,
  rollTx,
  signRollReward,
  signWithdrawReward,
  withdrawMintId,
  withdrawTx,
  VAULT_MINT_DELAY_BLOCKS,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  encodeChargeEpoch,
  encodeCommitRewards,
  encodeCommitVaultRoot,
  encodeDeposit,
  encodePinClock,
  encodeSetEpochDue,
} from './reserve_evm.js';
import {
  proveEpochMint,
  proveVaultReward,
  stableSpendTag,
  tagDerivedNullifier,
  vaultLockNote,
  vaultRewardNanos,
} from './vault_reward_fs1.js';

const T0 = 1_700_000_000_000;
const span = RESERVE_EPOCH_MS;
const HEIGHT = VAULT_FS1_ACTIVATION_HEIGHT;
const Fn = RistrettoPoint.Fn;

function dest20() {
  const id = newIdentity();
  const dest = vaultDest(id.address, { viewKey: id.viewKey });
  return { id, dest, d20: Buffer.from(hash20FromAddress(dest)) };
}

function recordTag(blob) {
  const fs1 = blob.readUInt32LE(1);
  return blob.subarray(5 + fs1 + 1, 5 + fs1 + 33);
}

function fundProof(lockCommit, outCommit, s, tx, height, magic) {
  const P = pointFrom(lockCommit).subtract(pointFrom(outCommit));
  const k = randomScalar();
  const R = H.multiply(k);
  const extra = lockFundContext(tx, height, magic);
  const e = hashToScalar(pointBytes(P), pointBytes(R), extra);
  const z = Fn.add(k, Fn.mul(e, s));
  return { R: pointBytes(R), z: scalarBytes(z) };
}

function proveLock(amount, remain, epoch = 0) {
  const who = dest20();
  const proved = proveVaultReward({
    locks: [{ amount, index: 0 }],
    which: 0,
    rootEpoch: epoch,
    earnEpoch: epoch,
    bps: GENESIS_BPS,
    remainMs: remain,
    span,
    dest20: who.d20,
  });
  assert.ok(proved, 'proof');
    assert.equal(proved.blob[0], 0xa6);
  return { who, proved };
}

describe('hidden vault claims', () => {
  it('hides remain, rejects the tag-derived nullifier, and opens only a batch of two', () => {
    const who = dest20();
    const first = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, index: 0 }, { amount: PI_SHE_NANOS + 1, index: 1 }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: 86_400_000,
      span,
      dest20: who.d20,
    });
    const second = proveVaultReward({
      locks: first.locks.map((lock) => ({ amount: lock.amount, scalar: lock.scalar, blind: lock.blind })),
      which: 1,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: 3_600_000,
      span,
      dest20: who.d20,
    });
    const a = { who, proved: first };
    const b = { who, proved: second };
    assert.equal(a.proved.rootHex, b.proved.rootHex);
    const tagA = a.proved.blob.subarray(
      5 + a.proved.blob.readUInt32LE(1) + 1,
      5 + a.proved.blob.readUInt32LE(1) + 33,
    );
    const derived = tagDerivedNullifier(tagA, 0);
    assert.ok(derived);
    assert.notEqual(derived.toString('hex'), a.proved.nullifier);
    assert.notEqual(a.proved.remainCommit, b.proved.remainCommit);

    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    for (const [i, row] of [a, b].entries()) {
      const lock = row.proved.locks[i];
      const note = vaultLockNote(lock.amount, lock.scalar, lock.blind).note;
      assert.ok(appendVaultLockNote(state, note, { earnEpoch: 0, remainCommit: row.proved.remainCommit }));
    }
    assert.equal(state.vaultLockRoot, a.proved.rootHex);
    assert.equal(Object.keys(state.vaultRemainCommits['0']).length, 2);
    state.epochRewardDue = { 0: String(a.proved.nanos + b.proved.nanos) };
    const root = state.vaultLockRoot;
    const claimOf = (row) => rewardClaimTx({
      to: row.who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        rootEpoch: 0,
        earnEpoch: 0,
        note: row.proved.note,
      },
    });
    const one = applyReserveBlock({
      state,
      block: {
        height: HEIGHT,
        txs: [{ coinbase: true, vout: [], vaultLockRoot: root }, claimOf(a)],
      },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(one.ok, true, one.reason);
    assert.equal(state.mintBankNanos, 0n);
    assert.equal(state.pendingReward, undefined);
    assert.notEqual(Number(state.mintBankNanos), a.proved.nanos);

    const two = applyReserveBlock({
      state,
      block: {
        height: HEIGHT,
        txs: [{ coinbase: true, vout: [], vaultLockRoot: root }, claimOf(b)],
      },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(two.ok, true, two.reason);
    assert.equal(state.mintBankNanos, 0n);
    assert.notEqual(state.mintBankNanos, BigInt(a.proved.nanos));
    assert.equal(state.pendingReward, undefined);

    const again = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [], vaultLockRoot: root }, claimOf(a)] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double_mint');
  });

  it('a later epoch uses the public span and a forged remainder commitment is refused', () => {
    const row = proveLock(PI_SHE_NANOS, span, 1);
    assert.equal(row.proved.full, true);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const note = vaultLockNote(row.proved.locks[0].amount, row.proved.locks[0].scalar, row.proved.locks[0].blind).note;
    appendVaultLockNote(state, note, { earnEpoch: 1, remainCommit: row.proved.remainCommit });
    state.vaultLockRoots = { 1: state.vaultLockRoot };
    state.epochStartRoots = { 1: state.vaultLockRoot };
    const tx = rewardClaimTx({
      to: row.who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        rootEpoch: 1,
        earnEpoch: 1,
        note: row.proved.note,
      },
    });
    tx.full = true;
    const paid = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, tx] },
      nowMs: T0 + span * 2,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);

    const bad = proveLock(PI_SHE_NANOS, 86_400_000, 0);
    const other = emptyVault();
    other.genesisMs = T0;
    other.magic = MAGIC_TESTNET;
    const badNote = vaultLockNote(bad.proved.locks[0].amount, bad.proved.locks[0].scalar, bad.proved.locks[0].blind).note;
    appendVaultLockNote(other, badNote, { earnEpoch: 0, remainCommit: '11'.repeat(32) });
    other.vaultLockRoots = { 0: other.vaultLockRoot };
    const forged = rewardClaimTx({
      to: bad.who.dest,
      vault: {
        blob: bad.proved.blob,
        nullifier: bad.proved.nullifier,
        rootEpoch: 0,
        earnEpoch: 0,
        note: bad.proved.note,
      },
    });
    const refused = applyReserveBlock({
      state: other,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [], vaultLockRoot: other.vaultLockRoot }, forged] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');
  });

  it('the lock commitment opens to the funded amount and the integer stays off the action', () => {
    const who = dest20();
    const rIn = randomScalar();
    const funded = pointBytes(commit(PI_SHE_NANOS, rIn));
    const range = proveRange(PI_SHE_NANOS, rIn);
    const note = vaultLockNote(PI_SHE_NANOS, 3n, rIn).note;
    const tx = {
      kind: 'lock',
      nanos: 0,
      vaultLockNote: note,
      vin: [{ commit: funded, rangeProof: range }],
      vout: [{ kind: 'lock', commit: funded, rangeProof: range }],
    };
    const ctx = { height: HEIGHT, magic: MAGIC_TESTNET };
    assert.equal(lockFundingRejected(tx, ctx), null);
    assert.equal(tx.nanos, 0);
    assert.equal(tx.vout[0].valueProof, undefined);

    const mismatch = Buffer.concat([note.subarray(0, 32), Buffer.alloc(32, 9)]);
    assert.equal(lockFundingRejected({
      ...tx,
      vaultLockNote: mismatch,
    }, ctx).reason, 'stake_reward');
    assert.equal(lockFundingRejected({ ...tx, nanos: 1 }, ctx).reason, 'stake_reward');
    assert.equal(lockFundingRejected({
      ...tx,
      vout: [{ kind: 'lock', valueProof: { v: 1 } }],
    }, ctx).reason, 'stake_reward');

    const rLock = randomScalar();
    const locked = pointBytes(commit(PI_SHE_NANOS, rLock));
    const blinded = vaultLockNote(PI_SHE_NANOS, 3n, rLock).note;
    const sameValue = {
      id: 'reblind',
      kind: 'lock',
      nanos: 0,
      vaultLockNote: blinded,
      vout: [{ kind: 'lock', commit: funded, rangeProof: range }],
    };
    sameValue.vout[0].fundProof = fundProof(locked, funded, Fn.sub(rLock, rIn), sameValue, HEIGHT, MAGIC_TESTNET);
    assert.equal(lockFundingRejected(sameValue, ctx), null);
    sameValue.vout[0].fundProof = fundProof(locked, funded, randomScalar(), sameValue, HEIGHT, MAGIC_TESTNET);
    assert.equal(lockFundingRejected(sameValue, ctx).reason, 'stake_reward');
    const otherHeight = fundProof(locked, funded, Fn.sub(rLock, rIn), sameValue, HEIGHT + 1, MAGIC_TESTNET);
    sameValue.vout[0].fundProof = otherHeight;
    assert.equal(lockFundingRejected(sameValue, ctx).reason, 'stake_reward');

    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const action = lockTx({
      from: who.dest,
      to: who.dest,
      nanos: PI_SHE_NANOS,
      blind: rIn,
      ownerPub: who.id.spendPub.toString('hex'),
      id: 'funded-lock',
    });
    action.vaultLockNote = note;
    action.vin = [{ commit: funded, rangeProof: range, address: who.dest }];
    const applied = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, action] },
      nowMs: T0,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(applied.ok, true, applied.reason);
    const portal = state.portals[portalIdFromDest(who.dest)];
    const tranche = portal.tranches[portal.tranches.length - 1];
    assert.equal(tranche.amount, undefined);
    assert.equal(action.nanos, 0);
    assert.equal(Number(state.totalLockedNanos), 0);
    const opening = proveValue(PI_SHE_NANOS, rIn);
    const opened = applyReserveBlock({
      state,
      block: {
        height: HEIGHT,
        txs: [{
          coinbase: true,
          vout: [],
          epochLockEpoch: 0,
          epochLockTotal: PI_SHE_NANOS,
          epochLockProof: opening,
          epochLockRange: proveRange(PI_SHE_NANOS, rIn),
        }],
      },
      nowMs: T0,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(opened.ok, false);
    assert.equal(opened.reason, 'stake_reward');
    assert.equal(Number(state.totalLockedNanos), 0);
    const due = vaultRewardNanos(PI_SHE_NANOS, GENESIS_BPS, tranche.remainMs, span);
    assert.ok(due);
    assert.ok(due.nanos < PI_SHE_NANOS);
  });

  it('rejects a 1-nano lock whose leaf commits to 2^53 when another input pays the change', () => {
    const rIn0 = randomScalar();
    const rIn1 = randomScalar();
    const rLock = randomScalar();
    const rChange = randomScalar();
    const rLeaf = randomScalar();
    const huge = 2n ** 53n;
    const one = 1n;
    const in0 = pointBytes(commit(huge, rIn0));
    const in1 = pointBytes(commit(one, rIn1));
    const locked = pointBytes(commit(one, rLock));
    const change = pointBytes(commit(huge, rChange));
    const leaf = vaultLockNote(huge, 9n, rLeaf).note;
    const opened = proveValue(one, rLock);
    const tx = {
      id: 'two-in-change',
      kind: 'lock',
      nanos: 0,
      vaultLockNote: leaf,
      excess: scalarBytes(Fn.sub(Fn.add(rLock, rChange), Fn.add(rIn0, rIn1))),
      vin: [
        {
          commit: in0,
          rangeProof: proveRange(huge, rIn0),
          fundProof: fundProof(pointBytes(commit(huge, rLeaf)), in0, Fn.sub(rLeaf, rIn0), { id: 'two-in-change' }, HEIGHT, MAGIC_TESTNET),
        },
        { commit: in1 },
      ],
      vout: [
        {
          kind: 'lock',
          commit: locked,
          rangeProof: proveRange(one, rLock),
          valueProof: { v: 1, R: opened.R, z: opened.z },
        },
        { kind: 'change', commit: change, rangeProof: proveRange(huge, rChange) },
      ],
    };
    const ctx = { height: HEIGHT, magic: MAGIC_TESTNET };
    assert.equal(lockFundingRejected(tx, ctx).reason, 'stake_reward');
    assert.equal(typedCommitSum(tx, ctx).reason, 'commit_sum');
  });

  it('two claims of one lock publish different tags, and neither is the spend tag', () => {
    const who = dest20();
    const scalar = randomScalar();
    const blind = randomScalar();
    const locks = [{ amount: PI_SHE_NANOS, scalar, blind }];
    const first = proveVaultReward({
      locks,
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: 3_600_000,
      span,
      dest20: who.d20,
    });
    const second = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, scalar: first.locks[0].scalar, blind: first.locks[0].blind }],
      which: 0,
      rootEpoch: 1,
      earnEpoch: 1,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: who.d20,
    });
    assert.ok(first && second);
    const tagA = recordTag(first.blob);
    const tagB = recordTag(second.blob);
    const stable = stableSpendTag(first.locks[0].scalar);
    assert.equal(tagA.equals(tagB), false);
    assert.equal(tagA.equals(stable), false);
    assert.equal(tagB.equals(stable), false);
    assert.equal(first.blob.includes(stable), false);
    assert.equal(second.blob.includes(stable), false);
    assert.notEqual(first.nullifier, second.nullifier);
  });

  it('mints a lone claim at the epoch deadline and refuses a block that omits it', () => {
    const row = proveLock(PI_SHE_NANOS, 3_600_000, 0);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const note = vaultLockNote(row.proved.locks[0].amount, row.proved.locks[0].scalar, row.proved.locks[0].blind).note;
    appendVaultLockNote(state, note, { earnEpoch: 0, remainCommit: row.proved.remainCommit });
    state.epochRewardDue = { 0: String(row.proved.nanos) };
    const claim = rewardClaimTx({
      to: row.who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        rootEpoch: 0,
        earnEpoch: 0,
        note: row.proved.note,
      },
    });
    const early = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [], vaultLockRoot: state.vaultLockRoot }, claim] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(early.ok, true, early.reason);
    assert.equal(state.pendingReward, undefined);
    assert.equal(state.mintBankNanos, 0n);
    assert.notEqual(Number(state.mintBankNanos), row.proved.nanos);
    const before = HEIGHT + VAULT_MINT_DELAY_BLOCKS - 1;
    const waiting = applyReserveBlock({
      state,
      block: { height: before, txs: [{ coinbase: true, vout: [] }] },
      nowMs: T0 + span,
      height: before,
      genesisMs: T0,
    });
    assert.equal(waiting.ok, true, waiting.reason);
    assert.equal(state.mintBankNanos, 0n);
    const dueAt = HEIGHT + VAULT_MINT_DELAY_BLOCKS;
    const trial = emptyVault();
    Object.assign(trial, state);
    trial.portals = state.portals;
    trial.mintedIds = { ...state.mintedIds };
    trial.epochRewardDue = { ...state.epochRewardDue };
    trial.vaultLockRoots = { ...state.vaultLockRoots };
    trial.epochClosedAtHeight = { ...state.epochClosedAtHeight };
    const omitted = applyReserveBlock({
      state: trial,
      block: { height: dueAt, txs: [{ coinbase: true, vout: [] }] },
      nowMs: T0 + span,
      height: dueAt,
      genesisMs: T0,
    });
    assert.equal(omitted.ok, true, omitted.reason);
    assert.equal(trial.mintBankNanos, 0n);
    const opened = proveEpochMint(row.proved.nanos, row.proved.rewardBlind);
    const paid = applyReserveBlock({
      state,
      block: {
        height: dueAt,
        txs: [{
          coinbase: true,
          vout: [],
          epochMint: opened.nanos,
          epochMintEpoch: 0,
          epochMintProof: opened.proof,
          epochMintRange: opened.range,
        }],
      },
      nowMs: T0 + span,
      height: dueAt,
      genesisMs: T0,
    });
    assert.equal(paid.ok, false);
    assert.equal(paid.reason, 'stake_reward');
    assert.equal(state.mintBankNanos, 0n);
    assert.notEqual(opened.nanos, 0);
  });

  it('keeps distinct remain commitments and still pays a later epoch', () => {
    const who = dest20();
    const remains = [1_000, 50_000, span];
    const base = proveVaultReward({
      locks: remains.map((unused, index) => ({ amount: PI_SHE_NANOS + index, index })),
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: remains[0],
      span,
      dest20: who.d20,
    });
    assert.ok(base);
    const proofs = [base];
    for (let i = 1; i < remains.length; i += 1) {
      proofs.push(proveVaultReward({
        locks: base.locks.map((lock) => ({ amount: lock.amount, scalar: lock.scalar, blind: lock.blind })),
        which: i,
        rootEpoch: 0,
        earnEpoch: 0,
        bps: GENESIS_BPS,
        remainMs: remains[i],
        span,
        dest20: who.d20,
      }));
    }
    assert.equal(new Set(proofs.map((row) => row.remainCommit)).size, 3);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    for (let i = 0; i < proofs.length; i += 1) {
      const lock = proofs[0].locks[i];
      const note = vaultLockNote(lock.amount, lock.scalar, lock.blind).note;
      assert.ok(appendVaultLockNote(state, note, { earnEpoch: 0, remainCommit: proofs[i].remainCommit }));
    }
    state.epochRewardDue = { 0: String(proofs.reduce((sum, row) => sum + row.nanos, 0)), 1: String(proofs[0].nanos) };
    state.epochStartRoots = { 0: state.vaultLockRoot };
    const root = state.vaultLockRoot;
    assert.equal(proofs.every((row) => row.rootHex === root), true);
    const claims = proofs.map((row) => {
      const tx = rewardClaimTx({
        to: who.dest,
        vault: { blob: row.blob, nullifier: row.nullifier, rootEpoch: 0, earnEpoch: 0, note: row.note },
      });
      if (row.full) tx.full = true;
      return tx;
    });
    let rewardBlind = proofs[0].rewardBlind;
    let rewardNanos = proofs[0].nanos;
    for (let i = 1; i < proofs.length; i += 1) {
      rewardBlind = Fn.add(rewardBlind, proofs[i].rewardBlind);
      rewardNanos += proofs[i].nanos;
    }
    const paid = applyReserveBlock({
      state,
      block: {
        height: HEIGHT,
        txs: [{
          coinbase: true,
          vout: [],
          vaultLockRoot: root,
        }, ...claims],
      },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(state.pendingReward, undefined);
    assert.equal(Number(state.mintBankNanos), 0);
    assert.notEqual(rewardNanos, 0);

    const forged = emptyVault();
    forged.genesisMs = T0;
    forged.magic = MAGIC_TESTNET;
    for (let i = 0; i < proofs.length; i += 1) {
      const lock = proofs[0].locks[i];
      const note = vaultLockNote(lock.amount, lock.scalar, lock.blind).note;
      const remain = i === 0 ? '33'.repeat(32) : proofs[i].remainCommit;
      assert.ok(appendVaultLockNote(forged, note, { earnEpoch: 0, remainCommit: remain }));
    }
    forged.vaultLockRoots = { 0: forged.vaultLockRoot };
    const refused = applyReserveBlock({
      state: forged,
      block: {
        height: HEIGHT,
        txs: [{
          coinbase: true,
          vout: [],
          vaultLockRoot: forged.vaultLockRoot,
        }, rewardClaimTx({
          to: who.dest,
          vault: {
            blob: proofs[0].blob,
            nullifier: proofs[0].nullifier,
            rootEpoch: 0,
            earnEpoch: 0,
            note: proofs[0].note,
          },
        })],
      },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');

    const later = proveVaultReward({
      locks: [{ amount: proofs[0].locks[0].amount, scalar: proofs[0].locks[0].scalar, blind: proofs[0].locks[0].blind }],
      which: 0,
      rootEpoch: 1,
      earnEpoch: 1,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: who.d20,
    });
    assert.equal(later.full, true);
    const next = emptyVault();
    next.genesisMs = T0;
    next.magic = MAGIC_TESTNET;
    const laterNote = vaultLockNote(later.locks[0].amount, later.locks[0].scalar, later.locks[0].blind).note;
    appendVaultLockNote(next, laterNote, { earnEpoch: 1, remainCommit: '44'.repeat(32) });
    next.vaultLockRoots = { 1: next.vaultLockRoot };
    next.epochStartRoots = { 1: next.vaultLockRoot };
    next.epochRewardDue = { 1: String(later.nanos) };
    const claim = rewardClaimTx({
      to: who.dest,
      vault: { blob: later.blob, nullifier: later.nullifier, rootEpoch: 1, earnEpoch: 1, note: later.note },
    });
    claim.full = true;
    const paidLater = applyReserveBlock({
      state: next,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, claim] },
      nowMs: T0 + span * 2,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(paidLater.ok, true, paidLater.reason);
  });

  it('spends a claim, a roll, and an interest withdraw from one nullifier set', () => {
    const who = dest20();
    const row = proveLock(PI_SHE_NANOS, span, 0);
    const ownerPub = who.id.spendPub.toString('hex');
    const fresh = () => {
      const state = emptyVault();
      state.genesisMs = T0;
      state.magic = MAGIC_TESTNET;
      assert.equal(deposit({
        state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub,
      }).ok, true);
      const note = vaultLockNote(row.proved.locks[0].amount, row.proved.locks[0].scalar, row.proved.locks[0].blind).note;
      appendVaultLockNote(state, note, { earnEpoch: 0, remainCommit: row.proved.remainCommit });
      state.vaultLockRoots = { 0: state.vaultLockRoot };
      state.epochStartRoots = { 0: state.vaultLockRoot };
      state.epochRewardDue = { 0: String(row.proved.nanos) };
      return state;
    };
    const claim = () => {
      const tx = rewardClaimTx({
        to: who.dest,
        vault: {
          blob: row.proved.blob,
          nullifier: row.proved.nullifier,
          rootEpoch: 0,
          earnEpoch: 0,
          note: row.proved.note,
        },
      });
      tx.full = true;
      return tx;
    };
    const take = (state) => {
      const tx = withdrawTx({ from: who.dest, to: who.dest, nanos: 0, id: `wd-${state.vaultLockRoot.slice(0, 8)}` });
      tx.vaultProof = row.proved.blob;
      tx.nullifier = row.proved.nullifier;
      tx.rootEpoch = 0;
      tx.earnEpoch = 0;
      tx.full = true;
      signWithdrawReward(tx, who.id.privateKey, {
        portalId: portalIdFromDest(who.dest),
        nanos: 0,
        dest: who.dest,
        state,
        nowMs: T0 + span,
      });
      return tx;
    };
    const roll = () => {
      const tx = rollTx({ from: who.dest, id: 'roll-spent' });
      tx.rootEpoch = 0;
      tx.earnEpoch = 0;
      signRollReward(tx, who.id.privateKey, { portalId: tx.portalId, epoch: 0 });
      return tx;
    };
    const run = (state, tx) => applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [], vaultLockRoot: state.vaultLockRoots['0'] }, tx] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });

    const claimed = fresh();
    assert.equal(run(claimed, claim()).ok, true);
    assert.equal(claimed.mintedIds[row.proved.nullifier], true);
    const claimThenWithdraw = run(claimed, take(claimed));
    assert.equal(claimThenWithdraw.ok, false);
    assert.equal(claimThenWithdraw.reason, 'double_mint');

    const withdrawn = fresh();
    const did = run(withdrawn, take(withdrawn));
    assert.equal(did.ok, true, did.reason);
    assert.equal(withdrawn.mintedIds[row.proved.nullifier], true);
    assert.equal(withdrawn.pendingReward, undefined);
    assert.equal(typeof withdrawn.epochMintSum['0'], 'string');
    const withdrawThenClaim = run(withdrawn, claim());
    assert.equal(withdrawThenClaim.ok, false);
    assert.equal(withdrawThenClaim.reason, 'double_mint');

    const rolled = fresh();
    const didRoll = run(rolled, roll());
    assert.equal(didRoll.ok, true, didRoll.reason);
    assert.equal(rolled.mintedIds[row.proved.nullifier], undefined);
    const rollThenClaim = run(rolled, claim());
    assert.equal(rollThenClaim.ok, true, rollThenClaim.reason);
    assert.equal(rolled.mintedIds[row.proved.nullifier], true);
  });

  it('a claim and an interest withdraw in one epoch use different ids', () => {
    const who = dest20();
    const row = proveLock(PI_SHE_NANOS, 3_600_000, 0);
    const ownerPub = who.id.spendPub.toString('hex');
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({
      state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub,
    }).ok, true);
    const note = vaultLockNote(row.proved.locks[0].amount, row.proved.locks[0].scalar, row.proved.locks[0].blind).note;
    appendVaultLockNote(state, note, { earnEpoch: 0, remainCommit: row.proved.remainCommit });
    state.vaultLockRoots = { 0: state.vaultLockRoot };
    state.epochRewardDue = { 0: String(row.proved.nanos) };
    const portal = portalIdFromDest(who.dest);
    const interestId = withdrawMintId(portal, 1);
    assert.notEqual(interestId, row.proved.nullifier);
    const claim = rewardClaimTx({
      to: who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        rootEpoch: 0,
        earnEpoch: 0,
        note: row.proved.note,
      },
    });
    const draw = withdrawTx({ from: who.dest, to: who.dest, nanos: 0, id: 'wd-interest' });
    signWithdrawReward(draw, who.id.privateKey, {
      portalId: portal,
      nanos: 0,
      dest: who.dest,
      state,
      nowMs: T0 + span,
    });
    const both = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [], vaultLockRoot: state.vaultLockRoot }, claim, draw] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(both.ok, true, both.reason);
    assert.equal(state.mintedIds[row.proved.nullifier], true);
    assert.equal(state.mintedIds[interestId], true);
    assert.equal(draw.vaultProof, undefined);
    const again = withdrawTx({ from: who.dest, to: who.dest, nanos: 0, id: 'wd-interest-2' });
    signWithdrawReward(again, who.id.privateKey, {
      portalId: portal,
      nanos: 0,
      dest: who.dest,
      state,
      nowMs: T0 + span,
    });
    const second = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, again] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'double_mint');
  });

  it('a roll needs the owner and does not carry the claim nullifier', () => {
    const who = dest20();
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    deposit({
      state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub: who.id.spendPub.toString('hex'),
    });
    const stranger = newIdentity();
    const roll = rollTx({ from: who.dest });
    roll.spendPub = stranger.spendPub.toString('hex');
    roll.rewardSig = 'ab'.repeat(64);
    assert.equal(rollRewardRejected(state, roll, T0 + span, HEIGHT).reason, 'unsigned');
    signRollReward(roll, who.id.privateKey, { portalId: portalIdFromDest(who.dest), epoch: 0 });
    assert.equal(rollRewardRejected(state, roll, T0 + span, HEIGHT), null);
    roll.nullifier = 'ab'.repeat(32);
    assert.equal(rollRewardRejected(state, roll, T0 + span, HEIGHT).reason, 'stake_reward');
  });

  it('the EVM root matches, a zero root is refused, and the cap is charged', async () => {
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    const who = dest20();
    const owner = rewardOwnerCommit(who.id.spendPub.toString('hex'));
    assert.equal((await callReserve(session, encodeDeposit(who.dest, Buffer.alloc(32, 7), T0, owner, true))).ok, true);
    const root = 'ab'.repeat(32);
    const zero = await callReserve(session, encodeCommitVaultRoot(0, '00'.repeat(32)));
    assert.equal(zero.ok, false);
    const stored = await callReserve(session, encodeCommitVaultRoot(0, root));
    assert.equal(stored.ok, true, stored.reason);
    assert.equal((await callReserve(session, encodeSetEpochDue(0, 100))).ok, true);
    assert.equal((await callReserve(session, encodeChargeEpoch(0, 40))).ok, true);
    const over = await callReserve(session, encodeChargeEpoch(0, 61));
    assert.equal(over.ok, false);
    const empty = await callReserve(session, encodeCommitRewards(T0 + span, '00'.repeat(32)));
    const nonempty = await callReserve(session, encodeCommitRewards(T0 + span, root));
    assert.equal(nonempty.ok, true, nonempty.reason);
    assert.ok(nonempty.gasUsed > 20000n, `non-empty commitRewards gas ${nonempty.gasUsed}`);
    assert.ok(empty.gasUsed > 0n, `empty commitRewards gas ${empty.gasUsed}`);
  });
});

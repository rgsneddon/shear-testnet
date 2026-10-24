/**
 * Privacy, cartographer, and Vault Security checks on the hidden vault claim.
 * A lone claim is not opened. Two claims open their sum. Remain is a
 * commitment. The nullifier is not a function of the public spend tag.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, RESERVE_PROGRAM, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { destCommitFromSpendPub, newIdentity, hash20FromAddress } from './address.js';
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
import { txDigestV3 } from './admit_v3.js';
import {
  appendVaultLockNote,
  applyReserveBlock,
  chainPeriodIndex,
  consensusRemainMs,
  deposit,
  emptyVault,
  consensusUnlockPeriod,
  leafEpochsToBurn,
  leafStubNanos,
  lockFundingRejected,
  lockUnlockContext,
  lockUnlockOf,
  lockTx,
  proveRemainOpen,
  verifyRemainOpen,
  portalIdFromDest,
  portalIdFromDest20,
  provePrincipalOpen,
  rewardClaimTx,
  rewardOwnerCommit,
  rollRewardRejected,
  rollTx,
  signRollReward,
  signWithdrawReward,
  withdrawMintId,
  withdrawSignedDest,
  withdrawTx,
  VAULT_MINT_DELAY_BLOCKS,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  encodeCommitRewards,
  encodeCommitVaultRoot,
  encodeDeposit,
  encodePinClock,
  attachLockAuth,
  executeBlockEvm,
} from './reserve_evm.js';
import {
  epochCapBlind,
  proveLeafRetire,
  proveLockCap,
  proveVaultReward,
  stableSpendTag,
  tagDerivedNullifier,
  subtractUnlock,
  vaultLockNote,
  vaultRewardNanos,
  VAULT_PROOF_VER,
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

function fundProof(lockCommit, outCommit, s, tx, height, magic, unlock) {
  const P = subtractUnlock(pointFrom(lockCommit).subtract(pointFrom(outCommit)), unlock);
  const k = randomScalar();
  const R = H.multiply(k);
  const extra = lockUnlockContext(tx, height, magic, unlock) || Buffer.alloc(0);
  const e = hashToScalar(pointBytes(P), pointBytes(R), extra);
  const z = Fn.add(k, Fn.mul(e, s));
  return { R: pointBytes(R), z: scalarBytes(z), height };
}

/**
 * Claim membership is one reward leaf. The withdraw leaf is a second,
 * indexed π note. Epoch-start stays the claim root. The live root, which
 * the coinbase publishes, is both notes.
 */
function plantClaimBook(who, row, ownerPub) {
  const state = emptyVault();
  state.genesisMs = T0;
  state.magic = MAGIC_TESTNET;
  const claimNote = vaultLockNote(
    row.proved.locks[0].amount,
    row.proved.locks[0].scalar,
    row.proved.locks[0].blind,
  ).note;
  assert.ok(appendVaultLockNote(state, claimNote));
  state.epochStartRoots = { 0: state.vaultLockRoot };
  state.epochRewardDue = { 0: String(row.proved.nanos) };
  const stamp = lockUnlockOf(state, T0);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const blind = randomScalar();
  const scalar = randomScalar();
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
  assert.ok(leaf);
  const got = deposit({
    state,
    dest: who.dest,
    nanos: PI_SHE_NANOS,
    nowMs: T0,
    ownerPub,
    commit: leaf.commit,
    rangeProof: proveRange(BigInt(PI_SHE_NANOS), blind),
    unlock,
    rangeCommit: pointBytes(subtractUnlock(pointFrom(leaf.commit), unlock)),
    piProof: proveRange(0n, blind),
  });
  assert.equal(got.ok, true, got.reason);
  assert.ok(appendVaultLockNote(state, leaf.note, {
    earnEpoch: Math.floor(Number(stamp.epoch) || 0),
    bornEpoch: chainPeriodIndex(state, T0),
    unlockEpoch: unlock,
    lockHeight: 1,
  }));
  state.vaultLockRoots = { 0: state.vaultLockRoot };
  return { state, planted: { leaf, unlock } };
}

/** Indexed π withdraw. The owner signs π. The receipt is π plus the arrival stub. */
function indexedWithdrawTx(state, planted, who, extra = {}) {
  const stub = leafStubNanos(state, [planted.leaf.commit.toString('hex')]);
  const nanos = PI_SHE_NANOS + Number(stub);
  const tx = withdrawTx({
    from: who.dest,
    to: who.dest,
    nanos,
    id: extra.id,
  });
  if (extra.carry) {
    tx.vout.push({ ...extra.carry.note, kind: 'reward-claim', address: who.dest });
    tx.vaultProof = extra.carry.blob;
    tx.nullifier = extra.carry.nullifier;
    tx.rootEpoch = 0;
    tx.earnEpoch = 0;
    tx.full = true;
  }
  const portal = portalIdFromDest(who.dest);
  const proof = provePrincipalOpen(
    planted.leaf.commit, PI_SHE_NANOS, planted.leaf.blind, tx, portal, MAGIC_TESTNET, planted.leaf.unlock,
  );
  assert.ok(proof, extra.id || 'principal');
  tx.principalProof = proof;
  const nowMs = T0 + span;
  const retire = proveLeafRetire({
    scalar: planted.leaf.scalar,
    epochs: leafEpochsToBurn(state, planted.leaf.note.toString('hex'), chainPeriodIndex(state, nowMs)),
    leaf: planted.leaf.note,
    txBind: txDigestV3(tx, MAGIC_TESTNET),
    unlockEpoch: chainPeriodIndex(state, nowMs),
    magic: MAGIC_TESTNET,
  });
  assert.ok(retire?.proof, extra.id || 'retire');
  tx.retireProof = retire.proof;
  signWithdrawReward(tx, who.id.privateKey, {
    portalId: portal,
    nanos: PI_SHE_NANOS,
    dest: withdrawSignedDest(tx),
    state,
    nowMs,
  });
  return { tx, stub: Number(stub) };
}

function proveLock(amount, epoch = 0) {
  const who = dest20();
  const proved = proveVaultReward({
    locks: [{ amount, index: 0 }],
    which: 0,
    rootEpoch: epoch,
    earnEpoch: epoch,
    bps: GENESIS_BPS,
    remainMs: span,
    span,
    dest20: who.d20,
  });
  assert.ok(proved, 'proof');
  assert.equal(proved.blob[0], VAULT_PROOF_VER);
  assert.equal(proved.blob.includes(proved.locks[0].commit), false);
  return { who, proved };
}

function claimFields(blob) {
  const fs1 = blob.readUInt32LE(1);
  const record = 5 + fs1;
  const rewardAt = record + 321 + 4 + 8 + 8;
  const after = rewardAt + 8 + 8;
  const word = (i) => blob.subarray(after + i * 32, after + (i + 1) * 32);
  return {
    tag: blob.subarray(record + 1, record + 33),
    member: blob.subarray(record + 33, record + 65),
    reward: blob.readBigUInt64LE(rewardAt),
    covered: blob.readBigUInt64LE(rewardAt + 8),
    nullP: word(1),
    // Gap tail ends the blob: gapC, A1, A2, zGap, zR, zS. The header no longer repeats A1/zGap.
    A1: blob.subarray(blob.length - 32 * 5, blob.length - 32 * 4),
    zGap: blob.subarray(blob.length - 32 * 3, blob.length - 32 * 2),
    noteR: word(3),
  };
}

describe('hidden vault claims', () => {
  it('hides the leaf, rejects the tag-derived nullifier, and mints each public reward', () => {
    const who = dest20();
    assert.equal(proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS + 1, index: 0 }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: who.d20,
    }), null);
    const first = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, index: 0 }, { amount: PI_SHE_NANOS, index: 1 }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: who.d20,
    });
    const second = proveVaultReward({
      locks: first.locks.map((lock) => ({ amount: lock.amount, scalar: lock.scalar, blind: lock.blind })),
      which: 1,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
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
    assert.notEqual(claimFields(a.proved.blob).noteR.toString('hex'), claimFields(b.proved.blob).noteR.toString('hex'));
    assert.equal(a.proved.blob.includes(a.proved.locks[0].commit), false);

    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    for (const [i, row] of [a, b].entries()) {
      const lock = row.proved.locks[i];
      const note = vaultLockNote(lock.amount, lock.scalar, lock.blind).note;
      assert.ok(appendVaultLockNote(state, note));
    }
    assert.equal(state.vaultLockRoot, a.proved.rootHex);
    assert.equal(state.vaultRemainLeaf, undefined);
    state.epochStartRoots = { 0: state.vaultLockRoot };
    state.epochRewardDue = { 0: String(a.proved.nanos + b.proved.nanos) };
    const root = state.vaultLockRoot;
    const claimOf = (row) => rewardClaimTx({
      to: row.who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        nanos: row.proved.nanos,
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
    assert.equal(state.mintBankNanos, BigInt(a.proved.nanos));
    assert.equal(state.pendingReward, undefined);
    assert.equal(state.epochMintNanos['0'], BigInt(a.proved.nanos));

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
    assert.equal(state.mintBankNanos, BigInt(a.proved.nanos) + BigInt(b.proved.nanos));
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

  it('a later epoch uses the public span and a reward that is not the product is refused', () => {
    const row = proveLock(PI_SHE_NANOS, 1);
    assert.equal(row.proved.full, true);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const note = vaultLockNote(row.proved.locks[0].amount, row.proved.locks[0].scalar, row.proved.locks[0].blind).note;
    appendVaultLockNote(state, note);
    state.vaultLockRoots = { 1: state.vaultLockRoot };
    state.epochStartRoots = { 1: state.vaultLockRoot };
    const tx = rewardClaimTx({
      to: row.who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        nanos: row.proved.nanos,
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
    assert.equal(state.mintBankNanos, BigInt(row.proved.nanos));

    const bad = proveLock(PI_SHE_NANOS, 0);
    const other = emptyVault();
    other.genesisMs = T0;
    other.magic = MAGIC_TESTNET;
    const badNote = vaultLockNote(bad.proved.locks[0].amount, bad.proved.locks[0].scalar, bad.proved.locks[0].blind).note;
    appendVaultLockNote(other, badNote, { earnEpoch: 0, remainCommit: '11'.repeat(32) });
    other.epochStartRoots = { 0: other.vaultLockRoot };
    const forgedBlob = Buffer.from(bad.proved.blob);
    const atReward = 5 + forgedBlob.readUInt32LE(1) + 321 + 4 + 8 + 8;
    forgedBlob.writeBigUInt64LE(forgedBlob.readBigUInt64LE(atReward) + 1n, atReward);
    const forged = rewardClaimTx({
      to: bad.who.dest,
      vault: {
        blob: forgedBlob,
        nullifier: bad.proved.nullifier,
        nanos: Number(forgedBlob.readBigUInt64LE(atReward)),
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
    assert.equal(vaultLockNote(PI_SHE_NANOS + 1, 3n, rIn), null);
    assert.equal(vaultLockNote(1n, 3n, rIn), null);
    const funded = pointBytes(commit(PI_SHE_NANOS, rIn));
    const range = proveRange(PI_SHE_NANOS, rIn);
    const unlock = consensusUnlockPeriod(0);
    const note = vaultLockNote(PI_SHE_NANOS, 3n, rIn, unlock).note;
    const tx = {
      kind: 'lock',
      nanos: 0,
      vaultLockNote: note,
      vin: [{ commit: funded, rangeProof: range }],
      vout: [{ kind: 'lock', commit: funded, rangeProof: range }],
    };
    const ctx = { height: HEIGHT, magic: MAGIC_TESTNET, unlock };
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
    const blindedNote = vaultLockNote(PI_SHE_NANOS, 3n, rLock, unlock);
    const locked = blindedNote.commit;
    const blinded = blindedNote.note;
    const sameValue = {
      id: 'reblind',
      kind: 'lock',
      nanos: 0,
      vaultLockNote: blinded,
      vout: [{ kind: 'lock', commit: funded, rangeProof: range }],
    };
    sameValue.vout[0].fundProof = fundProof(locked, funded, Fn.sub(rLock, rIn), sameValue, HEIGHT, MAGIC_TESTNET, unlock);
    assert.equal(lockFundingRejected(sameValue, ctx), null);
    sameValue.vout[0].fundProof = fundProof(locked, funded, randomScalar(), sameValue, HEIGHT, MAGIC_TESTNET, unlock);
    assert.equal(lockFundingRejected(sameValue, ctx).reason, 'stake_reward');
    const bound = fundProof(locked, funded, Fn.sub(rLock, rIn), sameValue, HEIGHT, MAGIC_TESTNET, unlock);
    sameValue.vout[0].fundProof = bound;
    assert.equal(lockFundingRejected(sameValue, ctx), null);
    assert.equal(lockFundingRejected(sameValue, { height: HEIGHT + 1, magic: MAGIC_TESTNET, unlock }), null);
    assert.equal(lockFundingRejected({ ...sameValue, id: 'renamed-id' }, ctx), null);
    assert.equal(lockFundingRejected({ ...sameValue, portalId: 'ab'.repeat(32) }, ctx).reason, 'stake_reward');

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
    assert.equal(vaultLockNote(huge, 9n, rLeaf), null);
    assert.equal(vaultLockNote(one, 9n, rLeaf), null);
    const leaf = Buffer.concat([Buffer.alloc(32, 3), pointBytes(commit(huge, rLeaf))]);
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
      remainMs: span,
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
    const lockPoint = first.locks[0].commit;
    assert.equal(first.blob.includes(lockPoint), false);
    assert.equal(second.blob.includes(lockPoint), false);
    const left = claimFields(first.blob);
    const right = claimFields(second.blob);
    assert.equal(left.reward, right.reward);
    assert.notEqual(left.member.toString('hex'), right.member.toString('hex'));
    assert.notEqual(left.nullP.toString('hex'), right.nullP.toString('hex'));
    assert.notEqual(left.A1.toString('hex'), right.A1.toString('hex'));
    assert.notEqual(left.zGap.toString('hex'), right.zGap.toString('hex'));
    assert.notEqual(left.noteR.toString('hex'), right.noteR.toString('hex'));
    const det = proveLockCap(PI_SHE_NANOS, first.locks[0].blind, GENESIS_BPS);
    assert.ok(det);
    assert.equal(first.blob.includes(det.commit), false);
    assert.equal(second.blob.includes(det.commit), false);
  });

  it('mints a lone claim at the epoch deadline and refuses a block that omits it', () => {
    const row = proveLock(PI_SHE_NANOS, 0);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const note = vaultLockNote(row.proved.locks[0].amount, row.proved.locks[0].scalar, row.proved.locks[0].blind).note;
    appendVaultLockNote(state, note);
    state.epochStartRoots = { 0: state.vaultLockRoot };
    state.epochRewardDue = { 0: String(row.proved.nanos) };
    const claim = rewardClaimTx({
      to: row.who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        nanos: row.proved.nanos,
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
    assert.equal(state.mintBankNanos, BigInt(row.proved.nanos));
    const before = HEIGHT + VAULT_MINT_DELAY_BLOCKS - 1;
    const waiting = applyReserveBlock({
      state,
      block: { height: before, txs: [{ coinbase: true, vout: [] }] },
      nowMs: T0 + span,
      height: before,
      genesisMs: T0,
    });
    assert.equal(waiting.ok, true, waiting.reason);
    assert.equal(state.mintBankNanos, BigInt(row.proved.nanos));
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
    assert.equal(trial.mintBankNanos, BigInt(row.proved.nanos));
    const paid = applyReserveBlock({
      state,
      block: {
        height: dueAt,
        txs: [{
          coinbase: true,
          vout: [],
          epochMint: row.proved.nanos,
          epochMintEpoch: 0,
        }],
      },
      nowMs: T0 + span,
      height: dueAt,
      genesisMs: T0,
    });
    assert.equal(paid.ok, false);
    assert.equal(paid.reason, 'stake_reward');
    assert.equal(state.mintBankNanos, BigInt(row.proved.nanos));
  });

  it('pays every member of the set and refuses a published reward that is not the proof', () => {
    const who = dest20();
    const count = 3;
    assert.equal(proveVaultReward({
      locks: [0, 1, 2].map((index) => ({ amount: PI_SHE_NANOS + index, index })),
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: who.d20,
    }), null);
    const base = proveVaultReward({
      locks: [0, 1, 2].map((index) => ({ amount: PI_SHE_NANOS, index })),
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: span,
      span,
      dest20: who.d20,
    });
    assert.ok(base);
    const proofs = [base];
    for (let i = 1; i < count; i += 1) {
      proofs.push(proveVaultReward({
        locks: base.locks.map((lock) => ({ amount: lock.amount, scalar: lock.scalar, blind: lock.blind })),
        which: i,
        rootEpoch: 0,
        earnEpoch: 0,
        bps: GENESIS_BPS,
        remainMs: span,
        span,
        dest20: who.d20,
      }));
    }
    assert.equal(new Set(proofs.map((row) => claimFields(row.blob).noteR.toString('hex'))).size, 3);
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    for (let i = 0; i < proofs.length; i += 1) {
      const lock = proofs[0].locks[i];
      const note = vaultLockNote(lock.amount, lock.scalar, lock.blind).note;
      assert.ok(appendVaultLockNote(state, note));
    }
    const rewardNanos = proofs.reduce((sum, row) => sum + row.nanos, 0);
    state.epochRewardDue = { 0: String(rewardNanos), 1: String(proofs[0].nanos) };
    state.epochStartRoots = { 0: state.vaultLockRoot };
    const root = state.vaultLockRoot;
    assert.equal(proofs.every((row) => row.rootHex === root), true);
    const claims = proofs.map((row) => rewardClaimTx({
      to: who.dest,
      vault: { blob: row.blob, nullifier: row.nullifier, nanos: row.nanos, rootEpoch: 0, earnEpoch: 0, note: row.note },
    }));
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
    assert.equal(Number(state.mintBankNanos), rewardNanos);

    const forged = emptyVault();
    forged.genesisMs = T0;
    forged.magic = MAGIC_TESTNET;
    for (let i = 0; i < proofs.length; i += 1) {
      const lock = proofs[0].locks[i];
      const note = vaultLockNote(lock.amount, lock.scalar, lock.blind).note;
      assert.ok(appendVaultLockNote(forged, note, { earnEpoch: 0, remainCommit: '33'.repeat(32) }));
    }
    forged.epochStartRoots = { 0: forged.vaultLockRoot };
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
          nanos: proofs[0].nanos + 1,
          vault: {
            blob: proofs[0].blob,
            nullifier: proofs[0].nullifier,
            nanos: proofs[0].nanos + 1,
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
      vault: {
        blob: later.blob,
        nullifier: later.nullifier,
        nanos: later.nanos,
        rootEpoch: 1,
        earnEpoch: 1,
        note: later.note,
      },
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
    assert.equal(next.mintBankNanos, BigInt(later.nanos));
  });

  it('spends a claim once, refuses a withdraw that carries the claim, and leaves a roll unmarked', () => {
    const who = dest20();
    const row = proveLock(PI_SHE_NANOS, 0);
    const ownerPub = who.id.spendPub.toString('hex');
    const fresh = () => plantClaimBook(who, row, ownerPub);
    const claim = () => {
      const tx = rewardClaimTx({
        to: who.dest,
        vault: {
          blob: row.proved.blob,
          nullifier: row.proved.nullifier,
          nanos: row.proved.nanos,
          rootEpoch: 0,
          earnEpoch: 0,
          note: row.proved.note,
        },
      });
      tx.full = true;
      return tx;
    };
    const take = (book, id) => indexedWithdrawTx(book.state, book.planted, who, {
      id,
      carry: row.proved,
    });
    const roll = (state) => {
      const tx = rollTx({ from: who.dest, id: 'roll-spent' });
      tx.rootEpoch = 0;
      tx.earnEpoch = 0;
      signRollReward(tx, who.id.privateKey, { portalId: tx.portalId, epoch: 0, state });
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
    assert.equal(run(claimed.state, claim()).ok, true);
    assert.equal(claimed.state.mintedIds[row.proved.nullifier], true);
    // The indexed withdraw is accepted. The carried nullifier was already minted.
    const claimThenWithdraw = run(claimed.state, take(claimed, `wd-${claimed.state.vaultLockRoot.slice(0, 8)}`).tx);
    assert.equal(claimThenWithdraw.ok, false);
    assert.equal(claimThenWithdraw.reason, 'double_mint');

    const refusedBook = fresh();
    const refusedWithdraw = run(refusedBook.state, take(refusedBook, 'wd-carry').tx);
    assert.equal(refusedWithdraw.ok, false);
    // The body still has from and to, so the carried claim is not a claim.
    assert.equal(refusedWithdraw.reason, 'stake_reward');

    const withdrawn = fresh();
    const plain = indexedWithdrawTx(withdrawn.state, withdrawn.planted, who, { id: 'wd-plain' });
    const did = run(withdrawn.state, plain.tx);
    assert.equal(did.ok, true, did.reason);
    assert.equal(withdrawn.state.mintedIds[row.proved.nullifier], undefined);
    // The indexed withdraw mints the arrival stub. An unindexed tranche mints nothing and is refused.
    assert.equal(withdrawn.state.mintBankNanos, BigInt(plain.stub));
    // The retire rebuilds the live root. The next coinbase publishes that root.
    withdrawn.state.vaultLockRoots['0'] = withdrawn.state.vaultLockRoot;
    const withdrawThenClaim = run(withdrawn.state, claim());
    assert.equal(withdrawThenClaim.ok, true, withdrawThenClaim.reason);
    assert.equal(withdrawn.state.mintedIds[row.proved.nullifier], true);

    const rolled = fresh();
    const didRoll = run(rolled.state, roll(rolled.state));
    assert.equal(didRoll.ok, true, didRoll.reason);
    assert.equal(rolled.state.mintedIds[row.proved.nullifier], undefined);
    const rollThenClaim = run(rolled.state, claim());
    assert.equal(rollThenClaim.ok, true, rollThenClaim.reason);
    assert.equal(rolled.state.mintedIds[row.proved.nullifier], true);
  });

  it('a claim and an interest withdraw in one epoch use different ids', () => {
    const who = dest20();
    const row = proveLock(PI_SHE_NANOS, 0);
    const ownerPub = who.id.spendPub.toString('hex');
    const { state, planted } = plantClaimBook(who, row, ownerPub);
    const portal = portalIdFromDest(who.dest);
    const interestId = withdrawMintId(portal, 1);
    assert.notEqual(interestId, row.proved.nullifier);
    const claim = rewardClaimTx({
      to: who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        nanos: row.proved.nanos,
        rootEpoch: 0,
        earnEpoch: 0,
        note: row.proved.note,
      },
    });
    const draw = indexedWithdrawTx(state, planted, who, { id: 'wd-interest' });
    const both = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [], vaultLockRoot: state.vaultLockRoot }, claim, draw.tx] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(both.ok, true, both.reason);
    assert.equal(state.mintedIds[row.proved.nullifier], true);
    assert.equal(state.mintedIds[interestId], true);
    assert.equal(draw.tx.vaultProof, undefined);
    const again = withdrawTx({ from: who.dest, to: who.dest, nanos: 0, id: 'wd-interest-2' });
    signWithdrawReward(again, who.id.privateKey, {
      portalId: portal,
      nanos: 0,
      dest: withdrawSignedDest(again),
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
    signRollReward(roll, who.id.privateKey, { portalId: portalIdFromDest(who.dest), epoch: 0, state });
    assert.equal(rollRewardRejected(state, roll, T0 + span, HEIGHT), null);
    roll.nullifier = 'ab'.repeat(32);
    assert.equal(rollRewardRejected(state, roll, T0 + span, HEIGHT).reason, 'stake_reward');
  });

  it('the EVM root matches, a zero root is refused, and the cap is charged', async () => {
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    const who = dest20();
    assert.equal((await callReserve(session, encodeDeposit(who.dest, Buffer.alloc(32, 7), T0, { key: who.id.privateKey }, true))).ok, true);
    const root = 'ab'.repeat(32);
    const zero = await callReserve(session, encodeCommitVaultRoot(0, '00'.repeat(32)));
    assert.equal(zero.ok, false);
    const stored = await callReserve(session, encodeCommitVaultRoot(0, root));
    assert.equal(stored.ok, true, stored.reason);
    const empty = await callReserve(session, encodeCommitRewards(T0 + span, '00'.repeat(32)));
    const nonempty = await callReserve(session, encodeCommitRewards(T0 + span, root));
    assert.equal(nonempty.ok, true, nonempty.reason);
    assert.ok(nonempty.gasUsed > 20000n, `non-empty commitRewards gas ${nonempty.gasUsed}`);
    assert.ok(empty.gasUsed > 0n, `empty commitRewards gas ${empty.gasUsed}`);
  });

  it('a remain commitment opens to the consensus remainder and not the full span', () => {
    const who = dest20();
    const now = T0 + 3_600_000;
    const r = randomScalar();
    assert.equal(vaultLockNote(PI_SHE_NANOS + 1, 3n, r), null);
    const note = vaultLockNote(PI_SHE_NANOS, 3n, r, consensusUnlockPeriod(0)).note;
    const build = () => {
      const action = lockTx({
        from: who.dest,
        to: who.dest,
        nanos: PI_SHE_NANOS,
        blind: r,
        ownerPub: who.id.spendPub.toString('hex'),
        id: 'remain-lock',
      });
      action.vaultLockNote = note;
      return action;
    };
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const remain = consensusRemainMs(state, now);
    assert.ok(remain > 0);
    assert.ok(remain < span);
    const spanTx = build();
    const spanOpen = proveRemainOpen(span, randomScalar(), spanTx, MAGIC_TESTNET);
    assert.ok(spanOpen);
    spanTx.remainCommit = spanOpen.commit.toString('hex');
    spanTx.remainProof = spanOpen;
    const tooWide = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, spanTx] },
      nowMs: now,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(tooWide.ok, false);
    assert.equal(tooWide.reason, 'stake_reward');

    const openTx = build();
    const open = proveRemainOpen(remain, randomScalar(), openTx, MAGIC_TESTNET);
    assert.ok(open);
    openTx.remainCommit = open.commit.toString('hex');
    openTx.remainProof = open;
    const fresh = emptyVault();
    fresh.genesisMs = T0;
    fresh.magic = MAGIC_TESTNET;
    const paid = applyReserveBlock({
      state: fresh,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, openTx] },
      nowMs: now,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);
    const renamed = { ...openTx, id: 'other-remain-id' };
    assert.equal(verifyRemainOpen(renamed.remainCommit, remain, renamed.remainProof, renamed, MAGIC_TESTNET), true);
    const retarget = { ...openTx, portalId: 'cd'.repeat(32) };
    assert.equal(verifyRemainOpen(retarget.remainCommit, remain, retarget.remainProof, retarget, MAGIC_TESTNET), false);
  });

  it('does not consult a lock cap, and refuses a reward that is not the product', () => {
    const row = proveLock(PI_SHE_NANOS, 0);
    const lock = row.proved.locks[0];
    const cap = proveLockCap(lock.amount, lock.blind, GENESIS_BPS);
    assert.ok(cap);
    assert.equal(row.proved.blob.includes(cap.commit), false);
    const prep = () => {
      const state = emptyVault();
      state.genesisMs = T0;
      state.magic = MAGIC_TESTNET;
      const note = vaultLockNote(lock.amount, lock.scalar, lock.blind).note;
      assert.ok(appendVaultLockNote(state, note));
      state.vaultLockRoots = { 0: state.vaultLockRoot };
      state.epochStartRoots = { 0: state.vaultLockRoot };
      state.vaultLockCap = { [lock.commit.toString('hex')]: cap.commit.toString('hex') };
      state.epochCapSum = { 0: cap.commit.toString('hex') };
      return state;
    };
    const claim = rewardClaimTx({
      to: row.who.dest,
      vault: {
        blob: row.proved.blob,
        nullifier: row.proved.nullifier,
        nanos: row.proved.nanos,
        rootEpoch: 0,
        earnEpoch: 0,
        note: row.proved.note,
      },
    });
    claim.full = true;
    const state = prep();
    const before = state.epochCapSum['0'];
    const paid = applyReserveBlock({
      state,
      block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, claim] },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(state.epochCapSum['0'], before);
    assert.equal(state.mintBankNanos, BigInt(row.proved.nanos));
    assert.equal(state.epochMintSum, undefined);

    const over = prep();
    over.vaultLockCap[lock.commit.toString('hex')] = pointBytes(commit(1n, epochCapBlind(lock.blind, GENESIS_BPS))).toString('hex');
    const wrong = Buffer.from(row.proved.blob);
    const atReward = 5 + wrong.readUInt32LE(1) + 321 + 4 + 8 + 8;
    wrong.writeBigUInt64LE(wrong.readBigUInt64LE(atReward) + 1n, atReward);
    const refused = applyReserveBlock({
      state: over,
      block: {
        height: HEIGHT,
        txs: [{
          coinbase: true,
          vout: [],
        }, {
          ...claim,
          id: 'bad-product',
          nanos: Number(wrong.readBigUInt64LE(atReward)),
          vaultProof: wrong,
        }],
      },
      nowMs: T0 + span,
      height: HEIGHT,
      genesisMs: T0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'stake_reward');
  });

  it('the EVM deposit checks the consensus unlock itself', async () => {
    const rIn = randomScalar();
    const funded = pointBytes(commit(PI_SHE_NANOS, rIn));
    const range = proveRange(PI_SHE_NANOS, rIn);
    assert.ok(range, 'range');
    const unlock = consensusUnlockPeriod(0);
    const note = vaultLockNote(PI_SHE_NANOS, 3n, rIn, unlock).note;
    const who = dest20();
    // The EVM keys a lock by its vout dest20 (cb733226). The dest20 is the
    // lockAuth key's commit and the portal id is H(tag, dest20).
    const lockD20 = destCommitFromSpendPub(who.id.spendPub);
    const tx = {
      id: 'evm-unlock',
      kind: 'lock',
      programId: RESERVE_PROGRAM,
      nanos: 0,
      portalId: portalIdFromDest20(lockD20),
      ownerPub: who.id.spendPub.toString('hex'),
      vaultLockNote: note,
      vout: [{ kind: 'lock', commit: funded, rangeProof: range, dest20: lockD20 }],
    };
    const session = await bootReserveEvm();
    attachLockAuth(tx, who.id.privateKey);
    assert.ok(tx.lockAuth, 'lockAuth');
    const good = await executeBlockEvm(
      session,
      [{ coinbase: true, vout: [] }, tx],
      T0,
      T0,
      undefined,
      undefined,
      { height: HEIGHT, magic: MAGIC_TESTNET },
    );
    assert.equal(good.ok, true, good.reason);
    const badNote = Buffer.concat([note.subarray(0, 32), Buffer.alloc(32, 9)]);
    const badTx = { ...tx, id: 'evm-unlock-bad', vaultLockNote: badNote };
    delete badTx.lockAuth;
    attachLockAuth(badTx, who.id.privateKey);
    assert.ok(badTx.lockAuth, 'bad lockAuth');
    // A second lock on the session that already took the good one is
    // portal_exists. The unlock check is the first lock of a fresh book.
    const badBook = await bootReserveEvm();
    const bad = await executeBlockEvm(
      badBook,
      [{ coinbase: true, vout: [] }, badTx],
      T0,
      T0,
      undefined,
      undefined,
      { height: HEIGHT, magic: MAGIC_TESTNET },
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'stake_reward');
  });
});

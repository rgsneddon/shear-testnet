/**
 * An FS-1 withdraw carries no spend identity. The node authorises it by the
 * SAL and the portal owner's rewardSig, so the node, not the pool, refuses a
 * withdraw whose rewardSig is missing, damaged, or made by another owner.
 * withdrawRewardRejected is the check block verify runs, and trialReserveApply
 * is the reserve apply that mempool admit and queueTx run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PI_SHE_NANOS, RESERVE_EPOCH_MS, MAGIC_TESTNET } from '../../crypto/asert.js';
import { encodeDest, hash20FromAddress, newIdentity, ed25519RawPub } from '../../crypto/address.js';
import { pointBytes, pointFrom, proveRange, randomScalar, sealCoinbaseNote } from '../../crypto/note.js';
import { proveLeafRetire, subtractUnlock, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { txDigestV3 } from '../../crypto/admit_v3.js';
import {
  appendVaultLockNote,
  chainPeriodIndex,
  cloneVault,
  consensusUnlockPeriod,
  emptyVault,
  leafEpochsToBurn,
  leafStubNanos,
  lockUnlockOf,
  portalIdFromDest,
  provePrincipalOpen,
  signWithdrawReward,
  trialReserveApply,
  withdrawRewardRejected,
  withdrawTx,
} from '../../crypto/reserve_vault.js';
import { deposit, ownerFor } from '../../crypto/owned_portal.js';

const T0 = 1_700_000_000_000;
const END = T0 + RESERVE_EPOCH_MS;

/** One indexed π leaf owned by `ownerPub`, as a real lock lands. */
function indexPiLock(state, dest, nowMs, ownerPub) {
  const magic = state.magic || MAGIC_TESTNET;
  const stamp = lockUnlockOf({ genesisMs: state.genesisMs, magic }, nowMs);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const scalar = randomScalar();
  const blind = randomScalar();
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
  assert.ok(leaf, 'leaf');
  const got = deposit({
    state,
    dest,
    nanos: PI_SHE_NANOS,
    nowMs,
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
    bornEpoch: chainPeriodIndex(state, nowMs),
    unlockEpoch: unlock,
    lockHeight: 1,
  }), 'indexed');
  return leaf;
}

/** The compact FS-1 withdraw body: dest20 payout, retire and principal proofs. */
function drawBody(state, dest, leaf, id) {
  const stub = leafStubNanos(state, [leaf.commit.toString('hex')]);
  const nanos = PI_SHE_NANOS + Number(stub);
  const tx = withdrawTx({ nanos, id, portalId: portalIdFromDest(dest) });
  delete tx.from;
  delete tx.to;
  delete tx.payer;
  delete tx.payoutPortalId;
  const d20 = Buffer.from(hash20FromAddress(dest));
  tx.dest20 = d20;
  const note = sealCoinbaseNote(nanos, { dest20: d20, kind: 'withdraw' });
  if (note.valueProof && typeof note.valueProof === 'object') note.valueProof = { ...note.valueProof, v: nanos };
  tx.vout = [note];
  const magic = state.magic || MAGIC_TESTNET;
  tx.principalProof = provePrincipalOpen(leaf.commit, PI_SHE_NANOS, leaf.blind, tx, portalIdFromDest(dest), magic, leaf.unlock);
  assert.ok(tx.principalProof, 'principal');
  const period = chainPeriodIndex(state, END);
  const retire = proveLeafRetire({
    scalar: leaf.scalar,
    epochs: leafEpochsToBurn(state, leaf.note.toString('hex'), period),
    leaf: leaf.note,
    txBind: txDigestV3(tx, magic),
    unlockEpoch: period,
    magic,
  });
  assert.ok(retire?.proof, 'retire');
  tx.retireProof = retire.proof;
  return { tx, d20 };
}

function sign(tx, key, dest, d20, state) {
  signWithdrawReward(tx, key, {
    portalId: portalIdFromDest(dest),
    nanos: PI_SHE_NANOS,
    dest: d20.toString('hex'),
    state,
    nowMs: END,
  });
  return tx;
}

function applied(state, tx) {
  return trialReserveApply({ state: cloneVault(state), txs: [structuredClone(tx)], nowMs: END, inPlace: false });
}

describe('the node refuses an FS-1 withdraw without the owner rewardSig', () => {
  const dest = encodeDest(Buffer.alloc(20, 0x5a));
  const owner = ownerFor(dest);
  const state = emptyVault();
  state.genesisMs = T0;
  const leaf = indexPiLock(state, dest, T0, owner.pub);

  it('accepts the owner-signed withdraw', () => {
    const { tx, d20 } = drawBody(state, dest, leaf, 'wd-owner');
    sign(tx, owner.key, dest, d20, state);
    assert.equal(tx.spendPub, undefined);
    assert.equal(withdrawRewardRejected(state, tx, END), null);
    const got = applied(state, tx);
    assert.equal(got.ok, true, got.reason);
  });

  it('refuses a missing rewardSig', () => {
    const { tx, d20 } = drawBody(state, dest, leaf, 'wd-bare');
    sign(tx, owner.key, dest, d20, state);
    delete tx.rewardSig;
    assert.equal(withdrawRewardRejected(state, tx, END)?.reason, 'unsigned');
    const got = applied(state, tx);
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'unsigned');
  });

  it('refuses a damaged rewardSig', () => {
    const { tx, d20 } = drawBody(state, dest, leaf, 'wd-bent');
    sign(tx, owner.key, dest, d20, state);
    const bent = Buffer.from(tx.rewardSig);
    bent[7] ^= 1;
    tx.rewardSig = typeof tx.rewardSig === 'string' ? bent.toString('hex') : bent;
    assert.equal(withdrawRewardRejected(state, tx, END)?.reason, 'unsigned');
    const got = applied(state, tx);
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'unsigned');
  });

  it('refuses a rewardSig from another owner, under either owner key', () => {
    const stranger = ownerFor(encodeDest(Buffer.alloc(20, 0x6b)));
    assert.notEqual(stranger.pub, owner.pub);
    // The stranger signs and presents their own key.
    const own = drawBody(state, dest, leaf, 'wd-forged-own');
    sign(own.tx, stranger.key, dest, own.d20, state);
    assert.equal(own.tx.ownerPub, stranger.pub);
    assert.equal(withdrawRewardRejected(state, own.tx, END)?.reason, 'unsigned');
    assert.equal(applied(state, own.tx).reason, 'unsigned');
    // The stranger signs but presents the real owner's key.
    const claimed = drawBody(state, dest, leaf, 'wd-forged-claim');
    sign(claimed.tx, stranger.key, dest, claimed.d20, state);
    claimed.tx.ownerPub = owner.pub;
    assert.equal(withdrawRewardRejected(state, claimed.tx, END)?.reason, 'unsigned');
    assert.equal(applied(state, claimed.tx).reason, 'unsigned');
    // A key that owns no portal at all.
    const loose = newIdentity();
    const bare = drawBody(state, dest, leaf, 'wd-forged-loose');
    sign(bare.tx, loose.privateKey, dest, bare.d20, state);
    assert.equal(bare.tx.ownerPub, Buffer.from(ed25519RawPub(loose.privateKey)).toString('hex'));
    assert.equal(withdrawRewardRejected(state, bare.tx, END)?.reason, 'unsigned');
    assert.equal(applied(state, bare.tx).reason, 'unsigned');
  });
});

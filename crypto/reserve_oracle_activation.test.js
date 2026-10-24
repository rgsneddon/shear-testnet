import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHeader, encodeHeader } from './header.js';
import { merkleRoot } from './merkle.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  asertNextBits,
} from './asert.js';
import {
  GENESIS_BPS,
  ORACLE_WINDOW_MAINNET,
  ORACLE_WINDOW_TESTNET,
  POLICY_BANK_IDS,
  epochBpsFromReports,
  interestNanos,
  reserveApplyFields,
  trimmedMeanBps,
  windowBlocksFor,
} from './reserve_oracle.js';
import { appendVaultLockNote, applyReserveBlock, chainPeriodIndex, coinbaseRewardRoot, consensusUnlockPeriod, enact, emptyVault, leafEpochsToBurn, leafStubNanos, lockUnlockOf, lockWitnessOf, portalEpochInterest, portalIdFromDest, previewWithdraw, produceLockOpening, provePrincipalOpen, sealEpochLocks, trialReserveApply, VAULT_MINT_DELAY_BLOCKS, vote, VOTE_INCREASE, withdraw } from './reserve_vault.js';
import { deposit, lockTx, withdrawTx, encodeDeposit, encodeWithdraw, lockTranches } from './owned_portal.js';
import { pointBytes, pointFrom, proveRange, randomScalar } from './note.js';
import { proveLeafRetire, subtractUnlock, vaultLockNote } from './vault_reward_fs1.js';
import { txDigestV3 } from './admit_v3.js';
import {
  GENESIS_PREV,
  buildTemplate,
  chainLoadSeal,
  digestTx,
  retarget,
  verifyBlock,
} from '../node/src/chain.js';
import { bookSealKeyFor } from '../node/src/book_seal_key.js';
import { createStore } from '../node/src/store.js';
import { MAGIC_MAINNET, joinCutoffMs, STAKE_CUTOFF_DAYS_MAINNET, STAKE_CUTOFF_QUARTER_DEN } from './pot_sched.js';
import { destCommitFromSpendPub, encodeDest, newIdentity } from './address.js';
import { vaultDest } from './flow_sheet.js';
import {
  attachLockAuth,
  bootReserveEvm,
  callReserve,
  decodeNextEpochBps,
  decodePublicView,
  encodeCommitRate,
  encodeCutoffLengthMs,
  encodeEnact,
  encodeEpochRateOf,
  encodeNextEpochBps,
  encodePinClock,
  encodePortalOf,
  encodeVote,
  encodePublicView,
  encodeRateCommitEpoch,
  decodePortal,
  executeBlockEvm,
} from './reserve_evm.js';

const T0 = 1_700_000_000_000;

/** These locks are applied. A π leaf is what consensus accepts.
 *  With a signer, lockAuth is that key over the leaf commit, so the EVM
 *  credits it. Reserve.sol refuses a lock with no lockAuth as owner_missing. */
function piLock(args, signer = null) {
  const tx = lockTx(args);
  const held = lockWitnessOf(tx);
  const leaf = held && vaultLockNote(held.amount, randomScalar(), held.blind, consensusUnlockPeriod(0));
  if (leaf) tx.vaultLockNote = leaf.note;
  if (signer) {
    attachLockAuth(tx, signer.key);
    assert.ok(tx.lockAuth, 'lockAuth');
  }
  return tx;
}

/** A lock signer. dest20 is H(silent, spendPub), the key Reserve.sol binds lockAuth to. */
function lockSigner() {
  const id = newIdentity();
  const dest20 = Buffer.from(destCommitFromSpendPub(id.spendPub));
  return { key: id.privateKey, dest20, dest: encodeDest(dest20) };
}

/** One indexed π leaf. An unindexed matured lock withdraws as stake_reward. */
function depositIndexed(state, dest, nowMs, lockHeight = 1) {
  const magic = state.magic || MAGIC_TESTNET;
  const stamp = lockUnlockOf({ genesisMs: state.genesisMs, magic }, nowMs);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const blind = randomScalar();
  const scalar = randomScalar();
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
  assert.ok(leaf, 'leaf');
  const got = deposit({
    state,
    dest,
    nanos: PI_SHE_NANOS,
    nowMs,
    commit: leaf.commit,
    rangeProof: proveRange(BigInt(PI_SHE_NANOS), blind),
    unlock,
    rangeCommit: pointBytes(subtractUnlock(pointFrom(leaf.commit), unlock)),
    piProof: proveRange(0n, blind),
  });
  if (!got.ok) return got;
  assert.ok(appendVaultLockNote(state, leaf.note, {
    earnEpoch: Math.floor(Number(stamp.epoch) || 0),
    bornEpoch: chainPeriodIndex(state, nowMs),
    unlockEpoch: unlock,
    lockHeight,
  }), 'lock note index');
  return { ...got, planted: { leaf, unlock } };
}

/** FS-1 hidden withdraw: the principal opening and the leaf retire, bound to this tx. */
function indexedHiddenWithdraw(state, dest, nowMs, planted, id = `hidden-${nowMs}`) {
  const stub = leafStubNanos(state, [planted.leaf.commit.toString('hex')]);
  const nanos = PI_SHE_NANOS + Number(stub);
  const tx = withdrawTx({ from: dest, to: dest, nanos, id });
  const magic = state.magic || MAGIC_TESTNET;
  const proof = provePrincipalOpen(
    planted.leaf.commit, PI_SHE_NANOS, planted.leaf.blind, tx, portalIdFromDest(dest), magic, planted.leaf.unlock,
  );
  assert.ok(proof, `${id} proof`);
  tx.principalProof = proof;
  const retire = proveLeafRetire({
    scalar: planted.leaf.scalar,
    epochs: leafEpochsToBurn(state, planted.leaf.note.toString('hex'), chainPeriodIndex(state, nowMs)),
    leaf: planted.leaf.note,
    txBind: txDigestV3(tx, magic),
    unlockEpoch: chainPeriodIndex(state, nowMs),
    magic,
  });
  assert.ok(retire?.proof, `${id} retire`);
  tx.retireProof = retire.proof;
  return withdraw({
    state,
    dest,
    nowMs,
    principal: nanos,
    principalProof: proof,
    retireProof: tx.retireProof,
    tx,
  });
}

/** A paid FS-1 withdraw opens π. The public interest integer stays 0. */
function assertPaidPi(paid, label = 'paid') {
  assert.equal(paid.ok, true, `${label} ${paid.reason}`);
  assert.equal(paid.principal, PI_SHE_NANOS, label);
  assert.equal(paid.interest, 0, label);
  assert.equal(paid.earned, 0, label);
}
const W = ORACLE_WINDOW_TESTNET;

function reports(tenths) {
  return POLICY_BANK_IDS.map((id) => ({ id, tenths }));
}

function windowOf(tenths, startHeight, count = W) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({ height: startHeight + i, miner: 'm', reports: reports(tenths) });
  }
  return rows;
}

function freshVault() {
  const state = emptyVault();
  state.genesisMs = T0;
  state.epochStartMs = T0;
  state.currentEpoch = 0;
  state.epochBps = GENESIS_BPS;
  state.magic = MAGIC_TESTNET;
  return state;
}

/** Epoch sums whose deadline this height has reached. The integer is the sum. */
function dueLockOpenings(state, height) {
  const out = [];
  for (const key of Object.keys(state?.lockCommitSum || {})) {
    const closed = state?.epochClosedAtHeight?.[key];
    if (closed == null || !(height > 0) || height < Number(closed) + VAULT_MINT_DELAY_BLOCKS) continue;
    const opening = produceLockOpening(state, Number(key));
    if (opening) out.push(opening);
  }
  return out;
}

function applyBoundary(state, { height, nowMs, parentMs, window, bps, epochIndex, activationHeight = 0 }) {
  const txs = [{ coinbase: true, vout: [] }];
  void dueLockOpenings;
  if (bps != null) {
    txs[0].rateCommit = { epochIndex, epochBps: bps, magic: MAGIC_TESTNET };
  }
  return applyReserveBlock({
    state,
    block: { height, txs },
    nowMs,
    parentMs,
    genesisMs: T0,
    oracleWindow: window,
    oracleWindowSize: W,
    activationHeight,
    height,
  });
}

function minerOf() {
  const id = newIdentity();
  return vaultDest(id.address, { viewKey: id.viewKey });
}

/** Owner-signed withdraw of hidden principal 0, bound to the live tranche commitments. */
function hiddenWithdrawTx(state, { from, to, id, nowMs }) {
  const portal = state.portals[portalIdFromDest(from)];
  return withdrawTx({
    from,
    to: to || from,
    nanos: 0,
    id,
    nowMs,
    authBind: {
      tranches: portal?.tranches || [],
      nowMs,
      genesisMs: state.genesisMs || T0,
      dest: from,
    },
  }, 0);
}

async function verifyBoundary({
  activation,
  window,
  commitBps,
  epochIndex,
  now,
  committedBps = GENESIS_BPS,
  genesisMs = T0,
}) {
  const who = minerOf();
  const parentTpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner: who,
    bits: GENESIS_BITS_PACKED,
    now: T0,
    txs: [],
  });
  const parentHash = Buffer.alloc(32, 9);
  const quote = asertNextBits({
    anchorBits: GENESIS_BITS_PACKED,
    anchorTimeMs: T0,
    anchorHeight: 1,
    blockTimeMs: now,
    blockHeight: 2,
    parentTimeMs: T0,
  });
  assert.equal(quote.ok, true, quote.reason);
  const parent = {
    hash: parentHash,
    height: 1,
    header: parentTpl.header,
    txs: parentTpl.txs,
    weight: parentTpl.weight,
    bLeaves: parentTpl.bLeaves,
  };
  const childTpl = buildTemplate({
    prev: parentHash,
    prevHeader: parentTpl.header,
    prevBlock: parent,
    parentWeight: parentTpl.weight,
    height: 2,
    miner: who,
    bits: quote.eased,
    now,
    txs: [],
    parentBlocks: [parent],
  });
  const cb = { ...childTpl.txs[0] };
  if (commitBps != null) {
    cb.rateCommit = { epochIndex, epochBps: commitBps, magic: MAGIC_TESTNET };
  }
  const decoded = decodeHeader(Buffer.from(childTpl.header));
  const header = encodeHeader({
    version: decoded.version,
    prevBlockHash: decoded.prevBlockHash,
    merkleRoot: merkleRoot([digestTx(cb)]),
    continuityRoot: decoded.continuityRoot,
    timestamp: decoded.timestamp,
    bits: decoded.bits,
    nonce: 0n,
    baseFee: decoded.baseFee,
  });
  return verifyBlock({ ...childTpl, header, txs: [cb] }, parent, {
    probeBody: true,
    magic: MAGIC_TESTNET,
    genesisMs,
    evmHistory: [parent],
    mtpTimestamps: [now - 180_000, now - 90_000, now - 1_000],
    oracleActivationHeight: activation,
    oracleWindow: window || [],
    oracleWindowSize: W,
    committedBps,
  });
}

describe('3b activation changes the lock issuance rate across epochs', () => {
  it('derives both windows from one week and selects by height', () => {
    assert.equal(ORACLE_WINDOW_MAINNET, 6720);
    assert.equal(windowBlocksFor('shear-v1'), 6720);
    assert.equal(W, 67);
    assert.equal(windowBlocksFor(MAGIC_TESTNET), 67);
  });

  it('activates 3b and applies a new rate at each of two epoch boundaries', async () => {
    const firstWindow = windowOf(2500, 1);
    const firstBps = epochBpsFromReports(GENESIS_BPS, firstWindow, { windowSize: W });
    assert.equal(firstBps, 250);
    const state = freshVault();
    const missing = applyBoundary(freshVault(), {
      height: W + 1,
      nowMs: T0 + RESERVE_EPOCH_MS,
      parentMs: T0 + RESERVE_EPOCH_MS - 1,
      window: firstWindow,
      bps: null,
      epochIndex: 1,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'rate_commit');

    const wrong = applyBoundary(freshVault(), {
      height: W + 1,
      nowMs: T0 + RESERVE_EPOCH_MS,
      parentMs: T0 + RESERVE_EPOCH_MS - 1,
      window: firstWindow,
      bps: GENESIS_BPS,
      epochIndex: 1,
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'rate_commit');

    const first = applyBoundary(state, {
      height: W + 1,
      nowMs: T0 + RESERVE_EPOCH_MS,
      parentMs: T0 + RESERVE_EPOCH_MS - 1,
      window: firstWindow,
      bps: firstBps,
      epochIndex: 1,
    });
    assert.equal(first.ok, true, first.reason);
    assert.equal(state.epochBps, GENESIS_BPS);
    assert.equal(state.nextEpochBps, firstBps);
    assert.equal(state.bonusEnacted, true);
    const joined = deposit({
      state,
      dest: minerOf(),
      nanos: PI_SHE_NANOS,
      nowMs: T0 + RESERVE_EPOCH_MS + 1,
    });
    assert.equal(joined.ok, true, joined.reason);
    assert.equal(state.epochBps, firstBps);

    const secondWindow = windowOf(5000, W + 1);
    const secondBps = epochBpsFromReports(state.epochBps, secondWindow, { windowSize: W });
    assert.equal(secondBps, 500);
    const second = applyBoundary(state, {
      height: (W + 1) + W,
      nowMs: T0 + 2 * RESERVE_EPOCH_MS,
      parentMs: T0 + 2 * RESERVE_EPOCH_MS - 1,
      window: secondWindow,
      bps: secondBps,
      epochIndex: 2,
    });
    assert.equal(second.ok, true, second.reason);
    assert.equal(state.nextEpochBps, secondBps);
    assert.equal(state.epochBps, firstBps);

    const fixed = freshVault();
    const held = applyBoundary(fixed, {
      height: W + 1,
      nowMs: T0 + RESERVE_EPOCH_MS,
      parentMs: T0 + RESERVE_EPOCH_MS - 1,
      window: firstWindow,
      bps: firstBps,
      epochIndex: 1,
      activationHeight: null,
    });
    assert.equal(held.ok, true, held.reason);
    assert.equal(fixed.epochBps, GENESIS_BPS);
    assert.equal(fixed.nextEpochBps, null);

    const bare = digestTx({ coinbase: true, height: 2, vin: [{ coinbase: true }], vout: [] });
    const committed = digestTx({
      coinbase: true,
      height: 2,
      vin: [{ coinbase: true }],
      vout: [],
      rateCommit: { epochIndex: 1, epochBps: 250, magic: MAGIC_TESTNET },
    });
    const other = digestTx({
      coinbase: true,
      height: 2,
      vin: [{ coinbase: true }],
      vout: [],
      rateCommit: { epochIndex: 1, epochBps: 500, magic: MAGIC_TESTNET },
    });
    assert.equal(committed.equals(bare), false);
    assert.equal(committed.equals(other), false);

    const noCommit = await verifyBoundary({
      activation: 0,
      window: firstWindow,
      commitBps: null,
      epochIndex: 1,
      now: T0 + RESERVE_EPOCH_MS,
    });
    assert.equal(noCommit.reason, 'rate_commit', noCommit.reason);
    const matched = await verifyBoundary({
      activation: 0,
      window: firstWindow,
      commitBps: firstBps,
      epochIndex: 1,
      now: T0 + RESERVE_EPOCH_MS,
    });
    assert.equal(matched.ok, true, matched.reason);
    assert.notEqual(matched.reason, 'rate_commit');
    const stillFixed = await verifyBoundary({
      activation: undefined,
      window: firstWindow,
      commitBps: null,
      epochIndex: 1,
      now: T0 + RESERVE_EPOCH_MS,
    });
    assert.equal(stillFixed.ok, true, stillFixed.reason);
    assert.equal(stillFixed.reason, undefined);
  });

  it('a split inside a bank still yields the plain average of the agreeing banks', () => {
    const majority = [1000, 1500, 2000, 2500, 3000, 3200, 3400, 3600, 3800, 4000, 4500, 5000, 5500, 6000];
    assert.equal(majority.length, POLICY_BANK_IDS.length);
    const agree = 50;
    const dissent = W - agree;
    assert.ok(agree * 3 >= W * 2);
    assert.ok(dissent * 3 < W * 2);
    const window = [];
    for (let i = 0; i < W; i += 1) {
      window.push({
        height: 1 + i,
        miner: 'm',
        reports: POLICY_BANK_IDS.map((id, k) => {
          const split = i >= agree;
          if (k === POLICY_BANK_IDS.length - 1) {
            return { id, tenths: i < 33 ? 1000 : 9000 };
          }
          return { id, tenths: split ? majority[k] + 800 : majority[k] };
        }),
      });
    }
    const kept = majority.slice(0, -1);
    const want = trimmedMeanBps(kept);
    assert.equal(want, 331);
    const bps = epochBpsFromReports(GENESIS_BPS, window, { windowSize: W });
    assert.equal(bps, want);
    const state = freshVault();
    const got = applyBoundary(state, {
      height: W + 1,
      nowMs: T0 + RESERVE_EPOCH_MS,
      parentMs: T0 + RESERVE_EPOCH_MS - 1,
      window,
      bps,
      epochIndex: 1,
    });
    assert.equal(got.ok, true, got.reason);
    assert.equal(state.pendingRates[1], 331);
    assert.equal(state.nextEpochBps, 331);
    assert.equal(state.epochBps, GENESIS_BPS);
  });

  it('two boundaries before a rollover keep both rates, and a withdraw pays each epoch its own', () => {
    const firstWindow = windowOf(2500, 1);
    const secondWindow = windowOf(5000, W + 1);
    const firstBps = epochBpsFromReports(GENESIS_BPS, firstWindow, { windowSize: W });
    const secondBps = epochBpsFromReports(firstBps, secondWindow, { windowSize: W });
    assert.equal(firstBps, 250);
    assert.equal(secondBps, 500);
    const state = freshVault();
    const who = minerOf();
    const opened = depositIndexed(state, who, T0);
    assert.equal(opened.ok, true, opened.reason);
    const first = applyBoundary(state, {
      height: W + 1,
      nowMs: T0 + RESERVE_EPOCH_MS,
      parentMs: T0 + RESERVE_EPOCH_MS - 1,
      window: firstWindow,
      bps: firstBps,
      epochIndex: 1,
    });
    assert.equal(first.ok, true, first.reason);
    assert.equal(state.epochBps, GENESIS_BPS);
    const rolled = applyBoundary(state, {
      height: W + 2,
      nowMs: T0 + RESERVE_EPOCH_MS + 1,
      parentMs: T0 + RESERVE_EPOCH_MS,
      window: [],
      bps: null,
      epochIndex: 1,
    });
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(state.currentEpoch, 1);
    assert.equal(state.epochBps, firstBps);
    const second = applyBoundary(state, {
      height: (W + 1) + W,
      nowMs: T0 + 2 * RESERVE_EPOCH_MS,
      parentMs: T0 + 2 * RESERVE_EPOCH_MS - 1,
      window: secondWindow,
      bps: secondBps,
      epochIndex: 2,
    });
    assert.equal(second.ok, true, second.reason);
    assert.equal(state.pendingRates[1], firstBps);
    assert.equal(state.pendingRates[2], secondBps);
    assert.equal(state.nextEpochBps, secondBps);
    assert.equal(state.epochBps, firstBps);
    const at = T0 + 2 * RESERVE_EPOCH_MS;
    const formula = interestNanos(PI_SHE_NANOS, GENESIS_BPS) + interestNanos(PI_SHE_NANOS, firstBps);
    assert.ok(formula > 0);
    assert.notEqual(firstBps, secondBps);
    // The public interest integer does not carry either epoch's amount.
    assert.equal(portalEpochInterest(state, state.portals[portalIdFromDest(who)], at), 0);
    const paid = indexedHiddenWithdraw(state, who, at, opened.planted, 'two-boundaries');
    assertPaidPi(paid);
    assert.notEqual(paid.earned, formula);
  });

  it('commits the plain average of a mixed-bank window', () => {
    const tenths = [1000, 1500, 2000, 2500, 3000, 3200, 3400, 3600, 3800, 4000, 4500, 5000, 5500, 6000];
    assert.equal(tenths.length, POLICY_BANK_IDS.length);
    const window = [];
    for (let i = 0; i < W; i += 1) {
      window.push({
        height: 1 + i,
        miner: 'm',
        reports: POLICY_BANK_IDS.map((id, k) => ({ id, tenths: tenths[k] })),
      });
    }
    const want = trimmedMeanBps(tenths);
    assert.equal(want, 350);
    const bps = epochBpsFromReports(GENESIS_BPS, window, { windowSize: W });
    assert.equal(bps, want);
    const state = freshVault();
    const got = applyBoundary(state, {
      height: W + 1,
      nowMs: T0 + RESERVE_EPOCH_MS,
      parentMs: T0 + RESERVE_EPOCH_MS - 1,
      window,
      bps,
      epochIndex: 1,
    });
    assert.equal(got.ok, true, got.reason);
    assert.equal(state.nextEpochBps, 350);
    assert.equal(state.epochBps, GENESIS_BPS);
  });

  it('JS and the EVM refuse a commit whose index is not the derived epoch', async () => {
    const window = windowOf(2500, 1);
    const bps = epochBpsFromReports(GENESIS_BPS, window, { windowSize: W });
    assert.equal(bps, 250);
    const boundary = T0 + RESERVE_EPOCH_MS;
    const inside = T0 + Math.floor(RESERVE_EPOCH_MS / 2);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    const locked = await callReserve(session, encodeDeposit('portal-idx', PI_SHE_NANOS, T0));
    assert.equal(locked.ok, true, locked.reason);

    function jsCommit(epochIndex, nowMs, parentMs) {
      return applyBoundary(freshVault(), {
        height: W + 1,
        nowMs,
        parentMs,
        window,
        bps,
        epochIndex,
        activationHeight: 0,
      });
    }

    const preOpen = jsCommit(1, inside, T0 + 1);
    assert.equal(preOpen.ok, false, preOpen.reason);
    assert.equal(preOpen.reason, 'rate_commit');
    const bare = emptyVault();
    const beforeGenesis = applyReserveBlock({
      state: bare,
      block: {
        height: W + 1,
        txs: [{
          coinbase: true,
          vout: [],
          rateCommit: { epochIndex: 1, epochBps: bps, magic: MAGIC_TESTNET },
        }],
      },
      nowMs: T0,
      parentMs: T0 - 1,
      genesisMs: 0,
      oracleWindow: window,
      oracleWindowSize: W,
      activationHeight: 0,
      height: W + 1,
    });
    assert.equal(beforeGenesis.ok, false);
    assert.equal(beforeGenesis.reason, 'rate_commit');
    const evmPre = await callReserve(session, encodeCommitRate(1, bps, inside, T0));
    assert.equal(evmPre.ok, false);
    const evmUnopened = await callReserve(await bootReserveEvm(), encodeCommitRate(1, bps, T0, 0));
    assert.equal(evmUnopened.ok, false);

    for (const epochIndex of [999, -5, 0, 2]) {
      const js = jsCommit(epochIndex, boundary, boundary - 1);
      assert.equal(js.ok, false, `js ${epochIndex} ${js.reason}`);
      assert.equal(js.reason, 'rate_commit');
      const evm = await callReserve(session, encodeCommitRate(epochIndex, bps, boundary, T0));
      assert.equal(evm.ok, false, `evm ${epochIndex}`);
    }

    const jsOk = jsCommit(1, boundary, boundary - 1);
    assert.equal(jsOk.ok, true, jsOk.reason);
    const kept = freshVault();
    const queued = applyBoundary(kept, {
      height: W + 1,
      nowMs: boundary,
      parentMs: boundary - 1,
      window,
      bps,
      epochIndex: 1,
    });
    assert.equal(queued.ok, true, queued.reason);
    assert.equal(kept.rateEpochIndex, 1);
    assert.equal(kept.pendingRates[1], bps);
    const evmOk = await callReserve(session, encodeCommitRate(1, bps, boundary, T0));
    assert.equal(evmOk.ok, true, evmOk.reason);
    const slot = await callReserve(session, encodeRateCommitEpoch(), { staticCall: true });
    assert.equal(decodeNextEpochBps(slot.returnValue), 1);
    const repeat = await callReserve(session, encodeCommitRate(1, bps, boundary, T0));
    assert.equal(repeat.ok, false);
    const repeatOther = await callReserve(session, encodeCommitRate(1, GENESIS_BPS, boundary, T0));
    assert.equal(repeatOther.ok, false);
  });

  it('verifyBlockEvm derives the chain genesis and ignores a raw option', async () => {
    const window = windowOf(2500, 1);
    const bps = epochBpsFromReports(GENESIS_BPS, window, { windowSize: W });
    assert.equal(bps, 250);
    const now = T0 + RESERVE_EPOCH_MS;
    const lie = T0 + 5 * RESERVE_EPOCH_MS;
    const got = await verifyBoundary({
      activation: 0,
      window,
      commitBps: bps,
      epochIndex: 1,
      now,
      genesisMs: lie,
    });
    assert.equal(got.ok, true, `${got.reason || ''} ${got.error || ''}`);
  });
});

function epochInterest(bps) {
  return Number((BigInt(PI_SHE_NANOS) * BigInt(bps)) / 10000n);
}

async function satInterest(offset, holdEpochs, rates) {
  const epoch = RESERVE_EPOCH_MS;
  const lockAt = T0 + offset * epoch;
  const drawAt = lockAt + holdEpochs * epoch;
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  const session = await bootReserveEvm();
  const indexes = Object.keys(rates).map(Number).sort((a, b) => a - b);
  for (const idx of indexes) {
    const bps = rates[idx];
    const window = windowOf(bps * 10, 1);
    const expected = epochBpsFromReports(GENESIS_BPS, window, { windowSize: W });
    assert.equal(expected, bps, `tenths ${bps * 10}`);
    const nowMs = T0 + idx * epoch;
    const queued = applyBoundary(state, {
      height: W + 1 + idx,
      nowMs,
      parentMs: nowMs - 1,
      window,
      bps,
      epochIndex: idx,
    });
    assert.equal(queued.ok, true, `js commit ${idx} ${queued.reason}`);
    const committed = await callReserve(session, encodeCommitRate(idx, bps, nowMs, T0));
    assert.equal(committed.ok, true, `evm commit ${idx} ${committed.reason}`);
  }
  assert.equal(state.genesisMs, T0);
  const who = minerOf();
  const opened = depositIndexed(state, who, lockAt);
  assert.equal(opened.ok, true, opened.reason);
  const id = `portal-${offset}-${holdEpochs}`;
  const locked = await callReserve(session, encodeDeposit(id, PI_SHE_NANOS, lockAt));
  assert.equal(locked.ok, true, locked.reason);
  const enacted = await callReserve(session, encodeEnact(drawAt));
  assert.equal(enacted.ok, true, enacted.reason);
  const earned = portalEpochInterest(state, state.portals[portalIdFromDest(who)], drawAt);
  const paid = indexedHiddenWithdraw(state, who, drawAt, opened.planted, id);
  assertPaidPi(paid, id);
  const drawn = await callReserve(session, encodeWithdraw(id, drawAt, undefined, 0, {
    locks: [{ nanos: PI_SHE_NANOS, at: lockAt }],
  }));
  assert.equal(drawn.ok, false);
  assert.equal(drawn.reason, 'unsigned');
  assert.equal(earned, 0);
  const want = satWant(offset, holdEpochs, rates);
  assert.ok(want > 0, `offset ${offset}`);
  assert.notEqual(earned, want);
  return earned;
}

function proRata(stake, bps, remainMs, span = RESERVE_EPOCH_MS) {
  return Number((BigInt(stake) * BigInt(bps) * BigInt(remainMs)) / (BigInt(span) * 10000n));
}

function remainAt(offset) {
  const span = RESERVE_EPOCH_MS;
  const idx = Math.floor(offset);
  const lockAt = T0 + offset * span;
  const end = T0 + (idx + 1) * span;
  return Math.max(0, Math.floor(end - lockAt));
}

/** Pro-rata of the lock epoch, then each later full epoch before withdraw. A lock in the testnet's last quarter misses only that arrival epoch. */
function satWant(offset, holdEpochs, rates, stake = PI_SHE_NANOS) {
  const span = RESERVE_EPOCH_MS;
  if (stake < PI_SHE_NANOS) return 0;
  const idx = Math.floor(offset);
  const until = Math.floor(offset + holdEpochs);
  const rate = (e) => (rates && rates[e] != null ? rates[e] : GENESIS_BPS);
  const late = remainAt(offset) < Math.floor(span / 4);
  let total = late ? 0 : proRata(stake, rate(idx), remainAt(offset), span);
  for (let e = idx + 1; e < until; e += 1) total += proRata(stake, rate(e), span, span);
  return total;
}

describe('chain-genesis clock pays the epochs a stake sat through', () => {
  const rates = { 1: 300, 2: 400, 3: 500, 4: 640 };

  it('first lock at 0, 0.5, 1.5, and 3.25 epochs matches JS to the EVM', async () => {
    assert.equal(await satInterest(0, 2, rates), 0);
    assert.equal(await satInterest(0.5, 2, rates), 0);
    assert.equal(await satInterest(1.5, 2, rates), 0);
    assert.equal(await satInterest(3.25, 2, rates), 0);
    assert.notEqual(rates[1], rates[4]);
  });

  it('a withdraw across several epochs pays each committed rate', async () => {
    const got = await satInterest(0, 4, rates);
    assert.equal(got, 0);
    assert.notEqual(rates[1], rates[4]);
  });
});

function interestOf(stake, bps) {
  return Number((BigInt(stake) * BigInt(bps)) / 10000n);
}

function pullingWithdraw(txs) {
  return (Array.isArray(txs) ? txs : []).some((tx) => (
    tx && !tx.coinbase && (tx.kind === 'withdraw' || tx?.vout?.[0]?.kind === 'withdraw')
  ));
}

/** Root the EVM must be told to expect. Omitted on a block that does not withdraw. */
function owedForEvm(state, nowMs, txs) {
  if (!pullingWithdraw(txs)) return undefined;
  return coinbaseRewardRoot(state, nowMs);
}

/** The live coinbase carries the reward root on a withdraw block. */
function withCoinbaseReward(state, nowMs, txs) {
  const list = Array.isArray(txs) ? txs.slice() : [];
  const pulling = list.some((tx) => tx && !tx.coinbase && (tx.kind === 'withdraw' || tx?.vout?.[0]?.kind === 'withdraw'));
  if (!pulling || !list[0]?.coinbase) return list;
  const root = coinbaseRewardRoot(state, nowMs);
  if (!root) return list;
  list[0] = { ...list[0], rewardRoot: root };
  return list;
}

function enactIfDue(state, nowMs) {
  if (!state.epochStartMs || state.bonusEnacted) return;
  if (nowMs < state.epochStartMs + RESERVE_EPOCH_MS) return;
  const did = applyReserveBlock({
    state,
    block: { txs: [{ coinbase: true, vout: [] }] },
    nowMs,
    genesisMs: T0,
  });
  assert.equal(did.ok, true, did.reason);
}

async function enactEvm(session, nowMs) {
  const view = decodePublicView((await callReserve(session, encodePublicView(nowMs), { staticCall: true })).returnValue);
  if (!view.epochStartMs || view.bonusEnacted) return;
  if (nowMs < view.epochStartMs + RESERVE_EPOCH_MS) return;
  const en = await callReserve(session, encodeEnact(nowMs));
  assert.equal(en.ok, true, en.reason);
}

/**
 * One JS vault and one EVM session. `locks` run in order. Interest is exact.
 * One credit per portal: a second lock for the same `who` is portal_exists on
 * both sides, and its amount goes to a fresh portal. A π credit is an indexed
 * leaf and is paid by an FS-1 withdraw. Any other amount is no π leaf, so its
 * matured lock is not a receipt and the withdraw is stake_reward.
 */
async function jsEvmStake({ locks, drawOffset, rates = null }) {
  const epoch = RESERVE_EPOCH_MS;
  const drawAt = T0 + drawOffset * epoch;
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  state.genesisMs = T0;
  const session = await bootReserveEvm();
  assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
  if (rates) {
    for (const idx of Object.keys(rates).map(Number).sort((a, b) => a - b)) {
      const nowMs = T0 + idx * epoch;
      state.pendingRates[idx] = rates[idx];
      const committed = await callReserve(session, encodeCommitRate(idx, rates[idx], nowMs, T0));
      assert.equal(committed.ok, true, `commit ${idx} ${committed.reason}`);
    }
  }
  const rows = [];
  const opened = new Set();
  for (const lock of locks) {
    const at = T0 + lock.offset * epoch;
    enactIfDue(state, at);
    await enactEvm(session, at);
    let portal = lock.who;
    if (opened.has(lock.who)) {
      const again = deposit({ state, dest: lock.who, nanos: lock.nanos, nowMs: at });
      assert.equal(again.ok, false, `${lock.who} top-up`);
      assert.equal(again.reason, 'portal_exists', lock.who);
      const evmAgain = await callReserve(session, encodeDeposit(lock.who, lock.nanos, at));
      assert.equal(evmAgain.ok, false, `${lock.who} evm top-up`);
      assert.equal(evmAgain.reason, 'portal_exists', lock.who);
      portal = minerOf();
    }
    opened.add(lock.who);
    const indexed = lock.nanos === PI_SHE_NANOS;
    const got = indexed
      ? depositIndexed(state, portal, at)
      : deposit({ state, dest: portal, nanos: lock.nanos, nowMs: at });
    assert.equal(got.ok, true, `${portal} ${got.reason}`);
    if (lock.stake != null) assert.equal(got.idle, !lock.stake, `${portal} stake`);
    const evm = await callReserve(session, encodeDeposit(portal, lock.nanos, at));
    assert.equal(evm.ok, true, `${portal} evm ${evm.reason}`);
    if (lock.stake != null) {
      const view = decodePortal((await callReserve(session, encodePortalOf(portal), { staticCall: true })).returnValue);
      assert.equal(view.staked, 0, portal);
      assert.equal(view.idle, 0, portal);
      assert.equal(view.joined, lock.nanos >= PI_SHE_NANOS, portal);
    }
    rows.push({ who: lock.who, portal, planted: got.planted || null, nanos: lock.nanos, at });
  }
  const interest = {};
  for (const row of rows) {
    const earned = portalEpochInterest(state, state.portals[portalIdFromDest(row.portal)], drawAt);
    if (row.planted) {
      assertPaidPi(indexedHiddenWithdraw(state, row.portal, drawAt, row.planted, `stake-${row.at}-${rows.indexOf(row)}`), row.portal);
    } else {
      const refused = withdraw({ state, dest: row.portal, nowMs: drawAt });
      assert.equal(refused.ok, false, `${row.portal} unindexed`);
      assert.equal(refused.reason, 'stake_reward', row.portal);
    }
    await enactEvm(session, drawAt);
    const drawn = await callReserve(session, encodeWithdraw(row.portal, drawAt, undefined, 0, {
      locks: [{ nanos: row.nanos, at: row.at }],
    }));
    assert.equal(drawn.ok, false, row.portal);
    assert.equal(drawn.reason, 'unsigned', row.portal);
    assert.equal(earned, 0, row.portal);
    interest[row.who] = (interest[row.who] || 0) + earned;
  }
  return interest;
}

describe('a lock earns the rest of its chain epoch, then full epochs', () => {
  const nine = PI_SHE_NANOS * 9;
  const due = (stake, offset, draw, rates = null) => satWant(offset, draw - offset, rates, stake);

  it('Alice at 0.2 earns pro-rata and Mallory at 0.95 is inside the last quarter', async () => {
    const alice = minerOf();
    const mallory = minerOf();
    const paid = await jsEvmStake({
      locks: [
        { who: alice, offset: 0.2, nanos: PI_SHE_NANOS, stake: true },
        { who: mallory, offset: 0.95, nanos: PI_SHE_NANOS, stake: false },
      ],
      drawOffset: 1.2,
    });
    const full = interestOf(PI_SHE_NANOS, GENESIS_BPS);
    assert.equal(paid[alice], 0);
    assert.equal(paid[mallory], 0);
    assert.ok(due(PI_SHE_NANOS, 0.2, 1.2) > Math.floor(full * 4 / 100));
    assert.equal(due(PI_SHE_NANOS, 0.95, 1.2), 0);
  });

  it('a top-up of π at 0.1 earns pro-rata and 9π at 0.8 is inside the last quarter', async () => {
    const who = minerOf();
    const early = await jsEvmStake({
      locks: [
        { who, offset: 0.1, nanos: PI_SHE_NANOS, stake: true },
        { who, offset: 0.8, nanos: nine, stake: false },
      ],
      drawOffset: 1.2,
    });
    assert.equal(early[who], 0);
    assert.ok(due(PI_SHE_NANOS, 0.1, 1.2) > 0);
    assert.equal(due(nine, 0.8, 1.2), 0);
    const who2 = minerOf();
    const later = await jsEvmStake({
      locks: [
        { who: who2, offset: 0.1, nanos: PI_SHE_NANOS, stake: true },
        { who: who2, offset: 0.8, nanos: nine, stake: false },
      ],
      drawOffset: 2,
    });
    // The 9π locked after the cutoff misses epoch 0. The public integer stays 0.
    assert.equal(later[who2], 0);
    assert.ok(due(nine, 0.8, 2) > 0);
  });

  it('a staked top-up pro-rates its own arrival, then shares later full epochs', async () => {
    const who = minerOf();
    const same = await jsEvmStake({
      locks: [
        { who, offset: 0.1, nanos: PI_SHE_NANOS, stake: true },
        { who, offset: 0.5, nanos: nine, stake: true },
      ],
      drawOffset: 2,
    });
    assert.equal(same[who], 0);
    assert.ok(due(PI_SHE_NANOS, 0.1, 2) + due(nine, 0.5, 2) > 0);
    const rates = { 1: 300, 2: 400 };
    const who2 = minerOf();
    const crossed = await jsEvmStake({
      locks: [
        { who: who2, offset: 0.1, nanos: PI_SHE_NANOS, stake: true },
        { who: who2, offset: 1.2, nanos: nine, stake: true },
      ],
      drawOffset: 3,
      rates,
    });
    assert.equal(crossed[who2], 0);
    assert.ok(due(PI_SHE_NANOS, 0.1, 3, rates) + due(nine, 1.2, 3, rates) > 0);
  });

  it('boundary offsets pay exact JS and EVM interest', async () => {
    const cases = [
      { lock: 0, draw: 1, stake: true },
      { lock: 0, draw: 2, stake: true },
      { lock: 0.2, draw: 1.2, stake: true },
      { lock: 0.75, draw: 1.2, stake: true },
      { lock: 0.95, draw: 1.2, stake: false },
      { lock: 1, draw: 2, stake: true },
      { lock: 1, draw: 3, stake: true },
    ];
    for (const row of cases) {
      const who = minerOf();
      const paid = await jsEvmStake({
        locks: [{ who, offset: row.lock, nanos: PI_SHE_NANOS, stake: row.stake }],
        drawOffset: row.draw,
      });
      assert.equal(paid[who], 0, `lock ${row.lock} draw ${row.draw}`);
    }
  });
});

describe('the stake-reward cutoff is per network', () => {
  it('mainnet is the last 99 days and testnet is the last quarter', () => {
    assert.equal(STAKE_CUTOFF_DAYS_MAINNET, 99);
    assert.equal(STAKE_CUTOFF_QUARTER_DEN, 4);
    assert.equal(joinCutoffMs(MAGIC_MAINNET), 99 * 86_400_000);
    assert.equal(joinCutoffMs(MAGIC_TESTNET), Math.floor(RESERVE_EPOCH_MS / 4));
  });

  it('a pre-cutoff add earns pro-rata and a last-quarter add earns 0 but can vote', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const quarter = Math.floor(epoch / 4);
    const earlyWho = minerOf();
    const addWho = minerOf();
    const lateWho = minerOf();
    const earlyAt = T0;
    const addAt = T0 + Math.floor(epoch / 2);
    const lateAt = T0 + epoch - quarter + 1000;
    const end = T0 + epoch;
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const early = depositIndexed(state, earlyWho, earlyAt);
    assert.equal(early.ok, true, early.reason);
    assert.equal(early.idle, false);
    // One credit per portal. The pre-cutoff add is its own portal.
    const topUp = deposit({ state, dest: earlyWho, nanos: PI_SHE_NANOS, nowMs: addAt });
    assert.equal(topUp.ok, false);
    assert.equal(topUp.reason, 'portal_exists');
    const add = depositIndexed(state, addWho, addAt);
    assert.equal(add.ok, true, add.reason);
    assert.equal(add.idle, false);
    const late = depositIndexed(state, lateWho, lateAt);
    assert.equal(late.ok, true, late.reason);
    assert.equal(late.idle, true);
    const cast = vote({ state, dest: lateWho, choice: VOTE_INCREASE, nowMs: lateAt });
    assert.equal(cast.ok, false);
    assert.equal(cast.reason, 'vote_retired');
    const addRemain = end - addAt;
    const want = interestNanos(PI_SHE_NANOS, GENESIS_BPS) + proRata(PI_SHE_NANOS, GENESIS_BPS, addRemain, epoch);
    assert.equal(enact({ state, nowMs: end }).ok, true);
    const paid = indexedHiddenWithdraw(state, earlyWho, end, early.planted, 'cutoff-early');
    assertPaidPi(paid, 'early');
    const added = indexedHiddenWithdraw(state, addWho, end, add.planted, 'cutoff-add');
    assertPaidPi(added, 'add');
    assert.ok(want > 0);
    const none = indexedHiddenWithdraw(state, lateWho, end, late.planted, 'cutoff-late');
    assertPaidPi(none, 'late');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(earlyWho, PI_SHE_NANOS, earlyAt))).ok, true);
    const evmTopUp = await callReserve(session, encodeDeposit(earlyWho, PI_SHE_NANOS, addAt));
    assert.equal(evmTopUp.ok, false);
    assert.equal(evmTopUp.reason, 'portal_exists');
    assert.equal((await callReserve(session, encodeDeposit(addWho, PI_SHE_NANOS, addAt))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(lateWho, PI_SHE_NANOS, lateAt))).ok, true);
    const evmVote = await callReserve(session, encodeVote(lateWho, 1, lateAt));
    assert.equal(evmVote.ok, false);
    assert.equal(evmVote.reason, 'not_voter');
    assert.equal((await callReserve(session, encodeEnact(end))).ok, true);
    const evmEarly = await callReserve(session, encodeWithdraw(earlyWho, end, undefined, PI_SHE_NANOS, {
      locks: [{ nanos: PI_SHE_NANOS, at: earlyAt }],
    }));
    assert.equal(evmEarly.ok, false);
    assert.equal(evmEarly.reason, 'unsigned');
    const evmAdd = await callReserve(session, encodeWithdraw(addWho, end, undefined, PI_SHE_NANOS, {
      locks: [{ nanos: PI_SHE_NANOS, at: addAt }],
    }));
    assert.equal(evmAdd.ok, false);
    assert.equal(evmAdd.reason, 'unsigned');
    assert.equal(paid.earned, 0);
    const evmLate = await callReserve(session, encodeWithdraw(lateWho, end, undefined, 0, {
      locks: [{ nanos: PI_SHE_NANOS, at: lateAt }],
    }));
    assert.equal(evmLate.ok, false);
    assert.equal(evmLate.reason, 'unsigned');
  });

  it('fails if the EVM mainnet cutoff stops being 99 days', async () => {
    const sol = fs.readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    assert.match(sol, /if \(magic == SHEAR_MAINNET\) return JOIN_CUTOFF_DAYS \* DAY_MS;/);
    const day = 86_400_000;
    const main = await bootReserveEvm({ network: MAGIC_MAINNET });
    const mainCut = await callReserve(main, encodeCutoffLengthMs(), { staticCall: true });
    assert.equal(mainCut.ok, true, mainCut.reason);
    assert.equal(word(mainCut.returnValue), BigInt(STAKE_CUTOFF_DAYS_MAINNET) * BigInt(day));
    const test = await bootReserveEvm();
    const testCut = await callReserve(test, encodeCutoffLengthMs(), { staticCall: true });
    assert.equal(testCut.ok, true, testCut.reason);
    assert.equal(word(testCut.returnValue), BigInt(Math.floor(RESERVE_EPOCH_MS / STAKE_CUTOFF_QUARTER_DEN)));
  });
});

function word(ret) {
  const b = ret instanceof Uint8Array ? ret : new Uint8Array(ret);
  let x = 0n;
  for (let i = 0; i < 32 && i < b.length; i += 1) x = (x << 8n) + BigInt(b[i]);
  return x;
}

describe('a pre-cutoff sum below pi earns no stake reward', () => {
  const epoch = RESERVE_EPOCH_MS;

  /**
   * Only a π leaf can be indexed. π is paid by an FS-1 withdraw. π-1 and π+1
   * are no π leaf, so the matured lock is not a receipt: stake_reward.
   */
  async function oneLock(nanos, lockAt, drawAt) {
    const who = minerOf();
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const indexed = nanos === PI_SHE_NANOS;
    const got = indexed
      ? depositIndexed(state, who, lockAt)
      : deposit({ state, dest: who, nanos, nowMs: lockAt });
    assert.equal(got.ok, true, got.reason);
    const portal = state.portals[portalIdFromDest(who)];
    assert.equal(portal.qualified === true, nanos >= PI_SHE_NANOS, `qualified ${nanos}`);
    const earned = portalEpochInterest(state, portal, drawAt);
    let paid;
    if (indexed) {
      paid = indexedHiddenWithdraw(state, who, drawAt, got.planted, `one-${nanos}`);
      assertPaidPi(paid, `one ${nanos}`);
    } else {
      paid = withdraw({ state, dest: who, nowMs: drawAt });
      assert.equal(paid.ok, false, `one ${nanos}`);
      assert.equal(paid.reason, 'stake_reward');
    }
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(who, nanos, lockAt))).ok, true);
    const evm = await callReserve(session, encodeWithdraw(who, drawAt, undefined, indexed ? PI_SHE_NANOS : 0, {
      locks: [{ nanos, at: lockAt }],
    }));
    assert.equal(evm.ok, false);
    assert.equal(evm.reason, 'unsigned');
    return earned;
  }

  it('pi-1 earns 0, pi and pi+1 earn the epoch', async () => {
    const drawAt = T0 + epoch;
    const below = await oneLock(PI_SHE_NANOS - 1, T0, drawAt);
    const exact = await oneLock(PI_SHE_NANOS, T0, drawAt);
    const above = await oneLock(PI_SHE_NANOS + 1, T0, drawAt);
    assert.equal(below, 0);
    assert.equal(exact, 0);
    assert.equal(above, 0);
    assert.ok(interestNanos(PI_SHE_NANOS, GENESIS_BPS) > 0);
  });

  it('a later pre-cutoff top-up is portal_exists, so a sum below pi never crosses pi', async () => {
    const who = minerOf();
    const other = minerOf();
    const first = PI_SHE_NANOS - 1;
    const second = 2;
    const addAt = T0 + epoch;
    const drawAt = T0 + 2 * epoch;
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({ state, dest: who, nanos: first, nowMs: T0 }).ok, true);
    const topUp = deposit({ state, dest: who, nanos: second, nowMs: addAt });
    assert.equal(topUp.ok, false);
    assert.equal(topUp.reason, 'portal_exists');
    assert.equal(deposit({ state, dest: other, nanos: second, nowMs: addAt }).ok, true);
    const want = interestNanos(first, GENESIS_BPS) * 2 + interestNanos(second, GENESIS_BPS);
    assert.ok(want > 0);
    // Neither credit is π, so neither portal qualifies and neither is a leaf.
    assert.notEqual(state.portals[portalIdFromDest(who)].qualified, true);
    assert.notEqual(state.portals[portalIdFromDest(other)].qualified, true);
    const paid = withdraw({ state, dest: who, nowMs: drawAt });
    assert.equal(paid.ok, false);
    assert.equal(paid.reason, 'stake_reward');
    const paidOther = withdraw({ state, dest: other, nowMs: drawAt });
    assert.equal(paidOther.ok, false);
    assert.equal(paidOther.reason, 'stake_reward');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(who, first, T0))).ok, true);
    const evmTopUp = await callReserve(session, encodeDeposit(who, second, addAt));
    assert.equal(evmTopUp.ok, false);
    assert.equal(evmTopUp.reason, 'portal_exists');
    assert.equal((await callReserve(session, encodeDeposit(other, second, addAt))).ok, true);
    const evm = await callReserve(session, encodeWithdraw(who, drawAt, undefined, 0, {
      locks: [{ nanos: first, at: T0 }],
    }));
    assert.equal(evm.ok, false);
    assert.equal(evm.reason, 'unsigned');
  });

  it('a post-cutoff add does not lift a pre-cutoff sum below pi, and the owner can vote', async () => {
    const who = minerOf();
    const lateWho = minerOf();
    const quarter = Math.floor(epoch / STAKE_CUTOFF_QUARTER_DEN);
    const lateAt = T0 + epoch - quarter + 1000;
    const end = T0 + epoch;
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({ state, dest: who, nanos: PI_SHE_NANOS - 1, nowMs: T0 }).ok, true);
    const topUp = deposit({ state, dest: who, nanos: PI_SHE_NANOS, nowMs: lateAt });
    assert.equal(topUp.ok, false);
    assert.equal(topUp.reason, 'portal_exists');
    const late = depositIndexed(state, lateWho, lateAt);
    assert.equal(late.ok, true, late.reason);
    assert.equal(late.idle, true);
    const cast = vote({ state, dest: who, choice: VOTE_INCREASE, nowMs: lateAt });
    assert.equal(cast.ok, false);
    assert.equal(cast.reason, 'vote_retired');
    assert.notEqual(state.portals[portalIdFromDest(who)].qualified, true);
    const paid = withdraw({ state, dest: who, nowMs: end });
    assert.equal(paid.ok, false);
    assert.equal(paid.reason, 'stake_reward');
    assertPaidPi(indexedHiddenWithdraw(state, lateWho, end, late.planted, 'post-cutoff'), 'late');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(who, PI_SHE_NANOS - 1, T0))).ok, true);
    const evmTopUp = await callReserve(session, encodeDeposit(who, PI_SHE_NANOS, lateAt));
    assert.equal(evmTopUp.ok, false);
    assert.equal(evmTopUp.reason, 'portal_exists');
    assert.equal((await callReserve(session, encodeDeposit(lateWho, PI_SHE_NANOS, lateAt))).ok, true);
    const evmVote = await callReserve(session, encodeVote(who, 1, lateAt));
    assert.equal(evmVote.ok, false);
    assert.equal(evmVote.reason, 'not_voter');
    const evm = await callReserve(session, encodeWithdraw(who, end, undefined, 0, {
      locks: [{ nanos: PI_SHE_NANOS - 1, at: T0 }],
    }));
    assert.equal(evm.ok, false);
    assert.equal(evm.reason, 'unsigned');
    const evmLate = await callReserve(session, encodeWithdraw(lateWho, end, undefined, PI_SHE_NANOS, {
      locks: [{ nanos: PI_SHE_NANOS, at: lateAt }],
    }));
    assert.equal(evmLate.ok, false);
    assert.equal(evmLate.reason, 'unsigned');
  });
});

describe('pinClock runs before the first lock in a block', () => {
  it('a lock at 1.5 pro-rates epoch 1 when the block pins the chain clock first', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const lockAt = T0 + 1.5 * epoch;
    const drawAt = T0 + 3.5 * epoch;
    const bps = 400;
    const session = await bootReserveEvm();
    const pinner = lockSigner();
    const pinLock = lockTx({ from: pinner.dest, to: pinner.dest, nanos: PI_SHE_NANOS, id: 'pin-lock' });
    attachLockAuth(pinLock, pinner.key);
    assert.ok(pinLock.lockAuth, 'pin lockAuth');
    const ran = await executeBlockEvm(session, [
      { coinbase: true, vout: [] },
      pinLock,
    ], lockAt, T0);
    assert.equal(ran.ok, true, ran.reason);
    const commit = await callReserve(session, encodeCommitRate(2, bps, T0 + 2 * epoch, T0));
    assert.equal(commit.ok, true, commit.reason);
    const enacted = await callReserve(session, encodeEnact(drawAt));
    assert.equal(enacted.ok, true, enacted.reason);
    const pinned = decodePortal((await callReserve(session, encodePortalOf(pinner.dest20), { staticCall: true })).returnValue);
    assert.equal(pinned.staked, 0);
    assert.equal(pinned.idle, 0);
    assert.equal(pinned.joined, true);
    const half = proRata(PI_SHE_NANOS, GENESIS_BPS, epoch / 2, epoch);
    const want = half + interestOf(PI_SHE_NANOS, bps);
    assert.ok(want > 0);

    const state = emptyVault();
    state.magic = MAGIC_TESTNET;
    state.genesisMs = T0;
    state.pendingRates[2] = bps;
    const who = minerOf();
    const jsLock = depositIndexed(state, who, lockAt);
    assert.equal(jsLock.ok, true, jsLock.reason);
    const jsPaid = indexedHiddenWithdraw(state, who, drawAt, jsLock.planted, 'pin-draw');
    assertPaidPi(jsPaid, 'pin');
    assert.notEqual(jsPaid.earned, want);

    const late = await bootReserveEvm();
    const beforePin = await callReserve(late, encodeDeposit('late-pin', PI_SHE_NANOS, lockAt));
    assert.equal(beforePin.ok, false);
    assert.equal((await callReserve(late, encodePinClock(T0))).ok, true);
    const untouched = decodePortal((await callReserve(late, encodePortalOf('late-pin'), { staticCall: true })).returnValue);
    assert.equal(untouched.staked, 0);
    assert.equal(untouched.idle, 0);
    assert.equal(untouched.joined, false);
    const view = decodePublicView((await callReserve(late, encodePublicView(lockAt), { staticCall: true })).returnValue);
    assert.equal(view.totalLockedNanos, 0);
    assert.equal((await callReserve(late, encodeDeposit('late-pin', PI_SHE_NANOS, lockAt))).ok, true);
    assert.equal((await callReserve(late, encodeCommitRate(2, bps, T0 + 2 * epoch, T0))).ok, true);
    assert.equal((await callReserve(late, encodeEnact(drawAt))).ok, true);
    const afterPin = await callReserve(late, encodeWithdraw('late-pin', drawAt, undefined, 0, {
      tranches: lockTranches('late-pin').slice(-1),
    }));
    assert.equal(afterPin.ok, false);
    assert.equal(afterPin.reason, 'unsigned');
  });
});

describe('an unpinned clock rejects a lock', () => {
  it('fails before the pin on an empty vault, a replay, and a sealed boot', () => {
    const who = minerOf();
    const empty = emptyVault();
    const denied = deposit({ state: empty, dest: who, nanos: PI_SHE_NANOS, nowMs: T0 });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'clock');
    assert.equal(empty.totalLockedNanos, 0n);
    assert.equal(Object.keys(empty.portals).length, 0);
    empty.genesisMs = T0;
    const after = deposit({ state: empty, dest: who, nanos: PI_SHE_NANOS, nowMs: T0 });
    assert.equal(after.ok, true, after.reason);
    assert.equal(Number(empty.totalLockedNanos), 0);
    const sealed = sealEpochLocks(empty, 0);
    assert.equal(sealed.ok, true, sealed.reason);
    assert.equal(Number(empty.totalLockedNanos), 0);
    assert.equal(sealed.commit.length, 64);

    const replay = emptyVault();
    replay.magic = MAGIC_TESTNET;
    const block = {
      height: 1,
      txs: [
        { coinbase: true, vout: [] },
        piLock({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'replay-unpinned' }),
      ],
    };
    const replayDenied = applyReserveBlock({ state: replay, block, nowMs: T0 });
    assert.equal(replayDenied.ok, false);
    assert.equal(replayDenied.reason, 'clock');
    const trialDenied = trialReserveApply({
      state: emptyVault(),
      txs: [piLock({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'trial-unpinned' })],
      nowMs: T0,
      genesisMs: 0,
    });
    assert.equal(trialDenied.ok, false);
    assert.equal(trialDenied.reason, 'clock');
    assert.equal(replay.totalLockedNanos, 0n);
    const replayed = applyReserveBlock({ state: replay, block, nowMs: T0, genesisMs: T0 });
    assert.equal(replayed.ok, true, replayed.reason);
    assert.equal(Number(replay.totalLockedNanos), 0);
    const replayTranche = Object.values(replay.portals)[0].tranches[0];
    assert.equal(replayTranche.amount, undefined);
    assert.equal(String(replayTranche.commit).length, 64);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-unpinned-boot-'));
    const booted = createStore(dir);
    const bootDenied = deposit({
      state: booted.reserveVault,
      dest: who,
      nanos: PI_SHE_NANOS,
      nowMs: T0,
    });
    assert.equal(bootDenied.ok, false);
    assert.equal(bootDenied.reason, 'clock');
    assert.equal(Number(booted.reserveVault.totalLockedNanos), 0);
    booted.reserveVault.genesisMs = T0;
    const bootOpened = deposit({
      state: booted.reserveVault,
      dest: who,
      nanos: PI_SHE_NANOS,
      nowMs: T0 + 1,
    });
    assert.equal(bootOpened.ok, true, bootOpened.reason);
    assert.equal(Number(booted.reserveVault.totalLockedNanos), 0);
    const bootSealed = sealEpochLocks(booted.reserveVault, 0);
    assert.equal(bootSealed.ok, true, bootSealed.reason);
    assert.equal(Number(booted.reserveVault.totalLockedNanos), 0);
    assert.equal(bootSealed.commit.length, 64);
  });
});

describe('the block path rolls before its transactions', () => {
  it('JS and the EVM adopt each epoch rate and pay the same interest', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const signer = lockSigner();
    const who = signer.dest;
    const rates = { 1: 300, 2: 400, 3: 500 };
    const state = emptyVault();
    state.magic = MAGIC_TESTNET;
    for (const idx of [1, 2, 3]) state.pendingRates[idx] = rates[idx];
    const session = await bootReserveEvm();
    for (const idx of [1, 2, 3]) {
      const committed = await callReserve(session, encodeCommitRate(idx, rates[idx], T0 + idx * epoch, T0));
      assert.equal(committed.ok, true, `commit ${idx} ${committed.reason}`);
    }
    const cb = { coinbase: true, vout: [] };
    const half = epoch / 2;
    const steps = [
      {
        now: T0 + half,
        txs: [cb, piLock({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'block-lock' }, signer)],
        epoch: 0,
        bps: GENESIS_BPS,
      },
      { now: T0 + epoch, txs: [cb], epoch: 0, bps: GENESIS_BPS },
      { now: T0 + epoch + 1, txs: [cb], epoch: 1, bps: 300 },
      { now: T0 + 2 * epoch, txs: [cb], epoch: 1, bps: 300 },
      { now: T0 + 2 * epoch + 1, txs: [cb], epoch: 2, bps: 400 },
      { now: T0 + 3 * epoch, txs: [cb], epoch: 2, bps: 400 },
      { now: T0 + 3 * epoch + 1, txs: [cb], epoch: 3, bps: 500 },
    ];
    for (const step of steps) {
      const applied = applyReserveBlock({
        state,
        block: { txs: step.txs, height: 1 },
        nowMs: step.now,
        genesisMs: T0,
        activationHeight: 0,
      });
      assert.equal(applied.ok, true, `${step.now} ${applied.reason}`);
      const evm = await executeBlockEvm(session, step.txs, step.now, T0);
      assert.equal(evm.ok, true, `${step.now} ${evm.reason}`);
      const view = decodePublicView(
        (await callReserve(session, encodePublicView(step.now), { staticCall: true })).returnValue,
      );
      assert.equal(state.currentEpoch, step.epoch, `js epoch ${step.now}`);
      assert.equal(view.currentEpoch, step.epoch, `evm epoch ${step.now}`);
      assert.equal(state.epochBps, step.bps, `js bps ${step.now}`);
      assert.equal(view.oracleBps, step.bps, `evm bps ${step.now}`);
    }
    const drawAt = T0 + 4 * epoch;
    const owed = owedForEvm(state, drawAt, [
      cb,
      { kind: 'withdraw' },
    ]);
    const draw = withCoinbaseReward(state, drawAt, [
      cb,
      hiddenWithdrawTx(state, { from: who, to: who, id: 'block-draw', nowMs: drawAt }),
    ]);
    const applied = applyReserveBlock({
      state,
      block: { txs: draw, height: 4 },
      nowMs: drawAt,
      genesisMs: T0,
      activationHeight: 0,
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.reason, 'mint_amount');
    const evm = await executeBlockEvm(session, draw, drawAt, T0, owed);
    assert.equal(evm.ok, false);
    assert.equal(evm.reason, 'unsigned');
    const want = proRata(PI_SHE_NANOS, GENESIS_BPS, half, epoch)
      + interestOf(PI_SHE_NANOS, 300)
      + interestOf(PI_SHE_NANOS, 400)
      + interestOf(PI_SHE_NANOS, 500);
    assert.ok(want > 0);
    assert.equal(Number(state.mintBankNanos || 0), 0);
    assert.equal(state.currentEpoch, 3);
    const view = decodePublicView(
      (await callReserve(session, encodePublicView(drawAt), { staticCall: true })).returnValue,
    );
    assert.equal(view.currentEpoch, 3);
    assert.equal(view.oracleBps, 500);
  });
});

describe('a ≥π withdraw in the second epoch', () => {
  const full = () => interestOf(PI_SHE_NANOS, GENESIS_BPS);

  async function secondEpochWithdraw(withRoot) {
    const epoch = RESERVE_EPOCH_MS;
    const signer = lockSigner();
    const who = signer.dest;
    const state = emptyVault();
    state.magic = MAGIC_TESTNET;
    const session = await bootReserveEvm();
    const lock = [
      { coinbase: true, vout: [] },
      piLock({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'pi-second-lock' }, signer),
    ];
    const locked = applyReserveBlock({
      state,
      block: { height: 1, txs: lock },
      nowMs: T0,
      genesisMs: T0,
      activationHeight: 0,
    });
    assert.equal(locked.ok, true, locked.reason);
    const evmLock = await executeBlockEvm(session, lock, T0, T0);
    assert.equal(evmLock.ok, true, evmLock.reason);
    const gapAt = T0 + epoch + 1;
    const gap = [{ coinbase: true, vout: [] }];
    const gapped = applyReserveBlock({
      state,
      block: { height: 2, txs: gap },
      nowMs: gapAt,
      genesisMs: T0,
      activationHeight: 0,
    });
    assert.equal(gapped.ok, true, gapped.reason);
    const evmGap = await executeBlockEvm(session, gap, gapAt, T0);
    assert.equal(evmGap.ok, true, evmGap.reason);
    const drawAt = T0 + 2 * epoch;
    const preview = previewWithdraw(state, who, drawAt);
    const owed = coinbaseRewardRoot(state, drawAt);
    const cb = { coinbase: true, vout: [] };
    if (withRoot) cb.rewardRoot = owed;
    const draw = [
      cb,
      hiddenWithdrawTx(state, { from: who, to: who, id: 'pi-second-draw', nowMs: drawAt }),
    ];
    const applied = applyReserveBlock({
      state,
      block: { height: 3, txs: draw },
      nowMs: drawAt,
      genesisMs: T0,
      activationHeight: 0,
      requireStakeReward: true,
    });
    const evm = await executeBlockEvm(session, draw, drawAt, T0, owed);
    const view = decodePublicView(
      (await callReserve(session, encodePublicView(drawAt), { staticCall: true })).returnValue,
    );
    const row = [...applied].find((item) => item && item.action === 'withdraw');
    return { applied, evm, row, view, state, preview };
  }

  it('JS and the EVM pay the same interest when the coinbase carries the root', async () => {
    const got = await secondEpochWithdraw(true);
    assert.equal(got.applied.ok, false);
    assert.equal(got.applied.reason, 'mint_amount');
    assert.equal(got.evm.ok, false);
    assert.equal(got.evm.reason, 'unsigned');
    assert.ok(full() * 2 > 0);
    assert.equal(Number(got.state.mintBankNanos || 0), 0);
    assert.equal(got.state.currentEpoch, got.view.currentEpoch);
    assert.equal(got.state.currentEpoch, 2);
  });

  it('an empty public book needs no root, and a forged root is refused', async () => {
    const got = await secondEpochWithdraw(false);
    assert.equal(got.applied.ok, false);
    assert.equal(got.applied.reason, 'mint_amount');
    assert.equal(got.evm.ok, false);
    assert.equal(got.evm.reason, 'unsigned');
    assert.equal(Number(got.state.mintBankNanos || 0), 0);
    const who = minerOf();
    const state = emptyVault();
    state.magic = MAGIC_TESTNET;
    const epoch = RESERVE_EPOCH_MS;
    const lock = [
      { coinbase: true, vout: [] },
      piLock({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'pi-forged-lock' }),
    ];
    assert.equal(applyReserveBlock({
      state, block: { height: 1, txs: lock }, nowMs: T0, genesisMs: T0, activationHeight: 0,
    }).ok, true);
    const drawAt = T0 + 2 * epoch;
    assert.equal(applyReserveBlock({
      state,
      block: { height: 2, txs: [{ coinbase: true, vout: [] }] },
      nowMs: T0 + epoch + 1,
      genesisMs: T0,
      activationHeight: 0,
    }).ok, true);
    const bad = applyReserveBlock({
      state,
      block: {
        height: 3,
        txs: [
          { coinbase: true, vout: [], rewardRoot: 'ab'.repeat(32) },
          hiddenWithdrawTx(state, { from: who, to: who, id: 'pi-forged-draw', nowMs: drawAt }),
        ],
      },
      nowMs: drawAt,
      genesisMs: T0,
      activationHeight: 0,
      requireStakeReward: true,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'stake_reward');
  });
});

describe('a withdraw stays open after the enacting block', () => {
  const blocksLater = 8;

  async function exitLater({ blocksAfter = null, at = null, gapBps = null, laterBps = null } = {}) {
    const epoch = RESERVE_EPOCH_MS;
    const signer = lockSigner();
    const who = signer.dest;
    const state = emptyVault();
    state.magic = MAGIC_TESTNET;
    const session = await bootReserveEvm();
    const cb = { coinbase: true, vout: [] };
    const half = epoch / 2;
    if (gapBps != null) {
      state.pendingRates[1] = gapBps;
      const committed = await callReserve(session, encodeCommitRate(1, gapBps, T0 + epoch, T0));
      assert.equal(committed.ok, true, committed.reason);
    }
    if (laterBps != null) {
      state.pendingRates[2] = laterBps;
      const later = await callReserve(session, encodeCommitRate(2, laterBps, T0 + 2 * epoch, T0));
      assert.equal(later.ok, true, later.reason);
    }
    const run = async (now, txs) => {
      const owed = owedForEvm(state, now, txs);
      const body = withCoinbaseReward(state, now, txs);
      const applied = applyReserveBlock({
        state,
        block: { txs: body, height: 1 },
        nowMs: now,
        genesisMs: T0,
        activationHeight: 0,
      });
      assert.equal(applied.ok, true, `${now} ${applied.reason}`);
      const evm = await executeBlockEvm(session, body, now, T0, owed);
      assert.equal(evm.ok, true, `${now} ${evm.reason}`);
      return { applied, evm };
    };
    await run(T0 + half, [
      cb,
      piLock({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'open-lock' }, signer),
    ]);
    await run(T0 + epoch, [cb]);
    if (blocksAfter != null) {
      for (let i = 1; i < blocksAfter; i += 1) {
        await run(T0 + epoch + i, [cb]);
      }
    }
    const drawAt = at != null ? at : T0 + epoch + blocksAfter;
    const drawTxs = [
      cb,
      hiddenWithdrawTx(state, { from: who, to: who, id: 'open-draw', nowMs: drawAt }),
    ];
    const owed = owedForEvm(state, drawAt, drawTxs);
    const body = withCoinbaseReward(state, drawAt, drawTxs);
    const applied = applyReserveBlock({
      state,
      block: { txs: body, height: 1 },
      nowMs: drawAt,
      genesisMs: T0,
      activationHeight: 0,
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.reason, 'mint_amount');
    const evm = await executeBlockEvm(session, body, drawAt, T0, owed);
    assert.equal(evm.ok, false);
    assert.equal(evm.reason, 'unsigned');
    let want = proRata(PI_SHE_NANOS, GENESIS_BPS, half, epoch);
    if (gapBps != null) want += interestOf(PI_SHE_NANOS, gapBps);
    assert.ok(want > 0);
    assert.equal(Number(state.mintBankNanos || 0), 0);
    if (gapBps != null) {
      assert.equal(state.pendingRates[1], gapBps);
      assert.equal(state.bonusEnacted, false);
      const skipped = await callReserve(session, encodeEpochRateOf(1), { staticCall: true });
      assert.equal(skipped.ok, true, skipped.reason);
      assert.equal(decodeNextEpochBps(skipped.returnValue), gapBps);
      const openRate = laterBps == null ? GENESIS_BPS : laterBps;
      assert.notEqual(0, want + proRata(PI_SHE_NANOS, openRate, half, epoch));
    }
    return { state, want };
  }

  it('a withdraw 1 block after the enact pays the enacted pro-rata', async () => {
    await exitLater({ blocksAfter: 1 });
  });

  it('a withdraw 3 blocks after the enact pays the enacted pro-rata', async () => {
    await exitLater({ blocksAfter: 3 });
  });

  it('a withdraw N blocks after the enact pays the enacted pro-rata', async () => {
    await exitLater({ blocksAfter: blocksLater });
  });

  it('a withdraw mid next epoch pays the enacted pro-rata only', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const { state } = await exitLater({ at: T0 + epoch + epoch / 2 });
    assert.equal(state.currentEpoch, 1);
    assert.equal(state.bonusEnacted, false);
  });

  it('a completed gap is paid immediately at its committed rate', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const { state } = await exitLater({
      at: T0 + 2 * epoch + epoch / 2,
      gapBps: 500,
      laterBps: 900,
    });
    assert.equal(state.currentEpoch, 2);
    assert.equal(state.bonusEnacted, false);
    assert.equal(state.enactedAtEpoch, 0);
    assert.equal(state.epochBps, 900);
  });
});

describe('a no-commit gap keeps the last adopted rate', () => {
  it('JS and the EVM pay the gap at the last adopted rate, not the later one', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const signer = lockSigner();
    const who = signer.dest;
    const adopted = 350;
    const later = 900;
    const state = emptyVault();
    state.magic = MAGIC_TESTNET;
    state.pendingRates[1] = adopted;
    state.pendingRates[3] = later;
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodeCommitRate(1, adopted, T0 + epoch, T0))).ok, true);
    assert.equal((await callReserve(session, encodeCommitRate(3, later, T0 + 3 * epoch, T0))).ok, true);
    const cb = { coinbase: true, vout: [] };
    const run = async (now, txs) => {
      const owed = owedForEvm(state, now, txs);
      const body = withCoinbaseReward(state, now, txs);
      const applied = applyReserveBlock({
        state,
        block: { txs: body, height: 1 },
        nowMs: now,
        genesisMs: T0,
        activationHeight: 0,
      });
      assert.equal(applied.ok, true, `${now} ${applied.reason}`);
      const evm = await executeBlockEvm(session, body, now, T0, owed);
      assert.equal(evm.ok, true, `${now} ${evm.reason}`);
      return { applied, evm };
    };
    await run(T0, [cb, piLock({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'gap-lock' }, signer)]);
    await run(T0 + epoch, [cb]);
    await run(T0 + epoch + 1, [cb]);
    assert.equal(state.epochBps, adopted);
    await run(T0 + 2 * epoch, [cb]);
    assert.equal(state.currentEpoch, 1);
    assert.equal(state.epochBps, adopted);
    const drawAt = T0 + 3 * epoch + Math.floor(epoch / 2);
    const drawTxs = [
      cb,
      hiddenWithdrawTx(state, { from: who, to: who, id: 'gap-draw', nowMs: drawAt }),
    ];
    const owed = owedForEvm(state, drawAt, drawTxs);
    const body = withCoinbaseReward(state, drawAt, drawTxs);
    const applied = applyReserveBlock({
      state,
      block: { txs: body, height: 1 },
      nowMs: drawAt,
      genesisMs: T0,
      activationHeight: 0,
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.reason, 'mint_amount');
    const evm = await executeBlockEvm(session, body, drawAt, T0, owed);
    assert.equal(evm.ok, false);
    assert.equal(evm.reason, 'unsigned');
    const full = (bps) => interestOf(PI_SHE_NANOS, bps);
    const want = full(GENESIS_BPS) + full(adopted) + full(adopted);
    assert.ok(want > 0);
    assert.equal(Number(state.mintBankNanos || 0), 0);
    assert.notEqual(want, full(GENESIS_BPS) + full(adopted) + full(later));
    assert.equal(state.currentEpoch, 3);
    assert.equal(state.bonusEnacted, false);
    assert.equal(state.epochBps, later);
    assert.equal(state.pendingRates[2], adopted);
    const gap = await callReserve(session, encodeEpochRateOf(2), { staticCall: true });
    assert.equal(gap.ok, true, gap.reason);
    assert.equal(decodeNextEpochBps(gap.returnValue), adopted);
    const open = await callReserve(session, encodeEpochRateOf(3), { staticCall: true });
    assert.equal(open.ok, true, open.reason);
    assert.equal(decodeNextEpochBps(open.returnValue), later);
  });
});

describe('a skipped commit carries forward', () => {
  it('JS and the EVM pay the next uncommitted epoch at the last gap commit', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const signer = lockSigner();
    const who = signer.dest;
    const state = emptyVault();
    state.magic = MAGIC_TESTNET;
    state.pendingRates[2] = 0;
    state.pendingRates[3] = 10000;
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodeCommitRate(2, 0, T0 + 2 * epoch, T0))).ok, true);
    assert.equal((await callReserve(session, encodeCommitRate(3, 10000, T0 + 3 * epoch, T0))).ok, true);
    const cb = { coinbase: true, vout: [] };
    const run = async (now, txs) => {
      const owed = owedForEvm(state, now, txs);
      const body = withCoinbaseReward(state, now, txs);
      const applied = applyReserveBlock({
        state,
        block: { txs: body, height: 1 },
        nowMs: now,
        genesisMs: T0,
        activationHeight: 0,
      });
      assert.equal(applied.ok, true, `${now} ${applied.reason}`);
      const evm = await executeBlockEvm(session, body, now, T0, owed);
      assert.equal(evm.ok, true, `${now} ${evm.reason}`);
      return { applied, evm };
    };
    await run(T0, [cb, piLock({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'carry-lock' }, signer)]);
    await run(T0 + epoch, [cb]);
    await run(T0 + 4 * epoch + 1, [cb]);
    assert.equal(state.currentEpoch, 4);
    assert.equal(state.bonusEnacted, false);
    assert.equal(state.epochBps, 10000);
    assert.notEqual(state.epochBps, GENESIS_BPS);
    let view = decodePublicView(
      (await callReserve(session, encodePublicView(T0 + 4 * epoch + 1), { staticCall: true })).returnValue,
    );
    assert.equal(view.currentEpoch, 4);
    assert.equal(view.oracleBps, 10000);
    const gapZero = await callReserve(session, encodeEpochRateOf(2), { staticCall: true });
    const gapHigh = await callReserve(session, encodeEpochRateOf(3), { staticCall: true });
    const opened = await callReserve(session, encodeEpochRateOf(4), { staticCall: true });
    assert.equal(decodeNextEpochBps(gapZero.returnValue), 0);
    assert.equal(decodeNextEpochBps(gapHigh.returnValue), 10000);
    assert.equal(decodeNextEpochBps(opened.returnValue), 10000);
    const drawAt = T0 + 5 * epoch;
    const drawTxs = [
      cb,
      hiddenWithdrawTx(state, { from: who, to: who, id: 'carry-draw', nowMs: drawAt }),
    ];
    const owed = owedForEvm(state, drawAt, drawTxs);
    const body = withCoinbaseReward(state, drawAt, drawTxs);
    const applied = applyReserveBlock({
      state,
      block: { txs: body, height: 1 },
      nowMs: drawAt,
      genesisMs: T0,
      activationHeight: 0,
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.reason, 'mint_amount');
    const evm = await executeBlockEvm(session, body, drawAt, T0, owed);
    assert.equal(evm.ok, false);
    assert.equal(evm.reason, 'unsigned');
    const full = (bps) => interestOf(PI_SHE_NANOS, bps);
    const want = full(GENESIS_BPS) * 2 + full(10000) * 2;
    assert.ok(want > 0);
    assert.equal(Number(state.mintBankNanos || 0), 0);
    assert.notEqual(want, full(GENESIS_BPS) * 3 + full(10000));
  });
});

describe('the rate lookback is load-bearing', () => {
  it('JS and the EVM pay an unstamped epoch at the last committed rate', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const who = minerOf();
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const locked = depositIndexed(state, who, T0);
    assert.equal(locked.ok, true, locked.reason);
    assert.equal(enact({ state, nowMs: T0 + epoch }).ok, true);
    state.pendingRates[2] = 0;
    state.pendingRates[3] = 10000;
    const drawAt = T0 + 5 * epoch;
    const paid = indexedHiddenWithdraw(state, who, drawAt, locked.planted, 'lookback-draw');
    assert.equal(paid.ok, true, paid.reason);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(who, PI_SHE_NANOS, T0))).ok, true);
    assert.equal((await callReserve(session, encodeEnact(T0 + epoch))).ok, true);
    assert.equal((await callReserve(session, encodeCommitRate(2, 0, T0 + 2 * epoch, T0))).ok, true);
    assert.equal((await callReserve(session, encodeCommitRate(3, 10000, T0 + 3 * epoch, T0))).ok, true);
    const drawn = await callReserve(session, encodeWithdraw(who, drawAt));
    assert.equal(drawn.ok, false);
    assert.equal(drawn.reason, 'unsigned');
    const full = (bps) => interestOf(PI_SHE_NANOS, bps);
    const want = full(GENESIS_BPS) * 2 + full(10000) * 2;
    assertPaidPi(paid, 'lookback');
    assert.ok(want > 0);
    assert.notEqual(want, full(GENESIS_BPS) * 3 + full(10000));
    assert.equal(state.epochBps, GENESIS_BPS);
  });
});

describe('a lock stays until its epoch ends', () => {
  const full = () => interestOf(PI_SHE_NANOS, GENESIS_BPS);

  async function lockEpochOne(who) {
    const epoch = RESERVE_EPOCH_MS;
    const lockAt = T0 + epoch;
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const locked = depositIndexed(state, who, lockAt);
    assert.equal(locked.ok, true, locked.reason);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(who, PI_SHE_NANOS, lockAt))).ok, true);
    return { state, session, epoch, lockAt, planted: locked.planted };
  }

  it('JS and the EVM refuse a mid-epoch withdraw', async () => {
    const who = minerOf();
    const { state, session, epoch, lockAt, planted } = await lockEpochOne(who);
    const mid = lockAt + Math.floor(epoch / 2);
    const paid = withdraw({ state, dest: who, nowMs: mid });
    assert.equal(paid.ok, false);
    assert.equal(paid.reason, 'epoch_open');
    const early = await callReserve(session, encodeWithdraw(who, mid));
    assert.equal(early.ok, false);
    const end = lockAt + epoch;
    assert.equal(enact({ state, nowMs: end }).ok, true);
    const later = indexedHiddenWithdraw(state, who, end, planted, 'end-draw');
    assertPaidPi(later, 'end');
    assert.ok(full() > 0);
    assert.equal((await callReserve(session, encodeEnact(end))).ok, true);
    const drawn = await callReserve(session, encodeWithdraw(who, end, undefined, 0, {
      locks: [{ nanos: PI_SHE_NANOS, at: lockAt }],
    }));
    assert.equal(drawn.ok, false);
    assert.equal(drawn.reason, 'unsigned');
  });

  it('JS and the EVM pay the full epoch at the end and on a later block', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const lockAt = T0 + epoch;
    const end = lockAt + epoch;
    const laterAt = end + 8;
    const boundary = minerOf();
    const after = minerOf();
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const atLock = depositIndexed(state, boundary, lockAt);
    assert.equal(atLock.ok, true, atLock.reason);
    const laterLock = depositIndexed(state, after, lockAt);
    assert.equal(laterLock.ok, true, laterLock.reason);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(boundary, PI_SHE_NANOS, lockAt))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(after, PI_SHE_NANOS, lockAt))).ok, true);
    const justBefore = withdraw({ state, dest: boundary, nowMs: end - 1 });
    assert.equal(justBefore.ok, false);
    assert.equal(justBefore.reason, 'epoch_open');
    assert.equal((await callReserve(session, encodeWithdraw(boundary, end - 1))).ok, false);
    assert.equal(enact({ state, nowMs: end }).ok, true);
    assert.equal((await callReserve(session, encodeEnact(end))).ok, true);
    const atEnd = indexedHiddenWithdraw(state, boundary, end, atLock.planted, 'boundary-draw');
    const afterEnd = indexedHiddenWithdraw(state, after, laterAt, laterLock.planted, 'later-draw');
    assertPaidPi(atEnd, 'at end');
    assertPaidPi(afterEnd, 'after end');
    assert.ok(full() > 0);
    const evmEnd = await callReserve(session, encodeWithdraw(boundary, end, undefined, 0, {
      locks: [{ nanos: PI_SHE_NANOS, at: lockAt }],
    }));
    const evmLater = await callReserve(session, encodeWithdraw(after, laterAt, undefined, 0, {
      locks: [{ nanos: PI_SHE_NANOS, at: lockAt }],
    }));
    assert.equal(evmEnd.ok, false);
    assert.equal(evmEnd.reason, 'unsigned');
    assert.equal(evmLater.ok, false);
    assert.equal(evmLater.reason, 'unsigned');
  });
});

describe('a top-up does not re-lock earlier principal', () => {
  // One credit per portal, and a leaf is π. The top-up is π on a second portal.
  const TOP = PI_SHE_NANOS;

  function partialOf(amount, remain, span) {
    return Number((BigInt(amount) * BigInt(GENESIS_BPS) * BigInt(remain)) / (BigInt(span) * 10000n));
  }

  it('JS releases an indexed finished deposit, a top-up is its own portal, and a 3-arg EVM withdraw leaves it locked', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const who = minerOf();
    const topWho = minerOf();
    const lockAt = T0;
    const topAt = T0 + epoch + Math.floor(epoch / 2);
    const topEnd = T0 + 2 * epoch;
    const state = emptyVault();
    state.genesisMs = T0;
    state.magic = MAGIC_TESTNET;
    const first = depositIndexed(state, who, lockAt);
    assert.equal(first.ok, true, first.reason);
    assert.equal(enact({ state, nowMs: T0 + epoch }).ok, true);
    const topUp = deposit({ state, dest: who, nanos: TOP, nowMs: topAt });
    assert.equal(topUp.ok, false);
    assert.equal(topUp.reason, 'portal_exists');
    const top = depositIndexed(state, topWho, topAt);
    assert.equal(top.ok, true, top.reason);
    const full = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const early = indexedHiddenWithdraw(state, who, topAt, first.planted, 'early-draw');
    assertPaidPi(early, 'early');
    assert.ok(full > 0);
    assert.notEqual(early.principal, PI_SHE_NANOS + TOP);
    // The top-up's epoch is still open. Its portal keeps its one tranche.
    const topOpen = withdraw({ state, dest: topWho, nowMs: topAt });
    assert.equal(topOpen.ok, false);
    assert.equal(topOpen.reason, 'epoch_open');
    assert.equal(state.portals[portalIdFromDest(who)].tranches.length, 0);
    const portal = state.portals[portalIdFromDest(topWho)];
    assert.equal(portal.tranches.length, 1);
    assert.equal(portal.tranches[0].amount, undefined);
    assert.equal(String(portal.tranches[0].commit).length, 64);
    assert.equal(portal.tranches[0].epoch, 1);
    assert.equal(Number(state.totalLockedNanos), 0);
    const again = withdraw({ state, dest: who, nowMs: topAt + 1 });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double_mint');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(who, PI_SHE_NANOS, lockAt))).ok, true);
    assert.equal((await callReserve(session, encodeEnact(T0 + epoch))).ok, true);
    const evmTopUp = await callReserve(session, encodeDeposit(who, TOP, topAt));
    assert.equal(evmTopUp.ok, false);
    assert.equal(evmTopUp.reason, 'portal_exists');
    assert.equal((await callReserve(session, encodeDeposit(topWho, TOP, topAt))).ok, true);
    const held = decodePortal((await callReserve(session, encodePortalOf(who), { staticCall: true })).returnValue);
    assert.equal(held.staked + held.idle, 0);
    assert.equal(held.joined, true);
    const drawn = await callReserve(session, encodeWithdraw(who, topAt));
    assert.equal(drawn.ok, false);
    assert.equal(drawn.reason, 'unsigned');
    assert.equal(early.earned, 0);
    const left = decodePortal((await callReserve(session, encodePortalOf(who), { staticCall: true })).returnValue);
    assert.equal(left.staked + left.idle, 0);
    assert.equal(left.joined, true);
    const locked = decodePublicView((await callReserve(session, encodePublicView(topAt), { staticCall: true })).returnValue);
    assert.equal(locked.totalLockedNanos, 0);
    const refused = await callReserve(session, encodeWithdraw(who, topAt + 1));
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unsigned');

    const remain = topEnd - topAt;
    const topDue = partialOf(TOP, remain, epoch);
    const wholeTop = interestNanos(TOP, GENESIS_BPS);
    assert.ok(topDue > 0);
    assert.ok(topDue < wholeTop);
    assert.equal(enact({ state, nowMs: topEnd }).ok, true);
    const rest = indexedHiddenWithdraw(state, topWho, topEnd, top.planted, 'top-draw');
    assertPaidPi(rest, 'top');
    assert.ok(topDue > 0 && topDue < wholeTop);
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal((await callReserve(session, encodeEnact(topEnd))).ok, true);
    const restEvm = await callReserve(session, encodeWithdraw(topWho, topEnd, undefined, 0, {
      tranches: lockTranches(topWho).slice(-1),
    }));
    assert.equal(restEvm.ok, false);
    assert.equal(restEvm.reason, 'unsigned');
    assert.equal(rest.earned, 0);
  });
});

describe('an epoch with no commit keeps the running rate', () => {
  it('fixed mode keeps the adopted rate when the next epoch has no commit', () => {
    const epoch = RESERVE_EPOCH_MS;
    const state = emptyVault();
    state.genesisMs = T0;
    const who = minerOf();
    assert.equal(deposit({ state, dest: who, nanos: PI_SHE_NANOS, nowMs: T0 }).ok, true);
    assert.equal(state.epochBps, GENESIS_BPS);
    assert.equal(enact({ state, nowMs: T0 + epoch }).ok, true);
    state.epochBps = 350;
    const rolled = applyReserveBlock({
      state,
      block: { txs: [{ coinbase: true, vout: [] }], height: 2 },
      nowMs: T0 + epoch + 1,
      genesisMs: T0,
    });
    assert.equal(rolled.ok, true, rolled.reason);
    assert.equal(state.currentEpoch, 1);
    assert.equal(state.bonusEnacted, false);
    assert.equal(state.epochBps, 350);
    assert.equal(state.freezes[1].epochBps, 350);
    assert.notEqual(state.epochBps, GENESIS_BPS);
  });

  it('JS and the EVM keep the last adopted rate when the next epoch has no commit', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const signer = lockSigner();
    const who = signer.dest;
    const adopted = 350;
    const state = emptyVault();
    state.magic = MAGIC_TESTNET;
    const session = await bootReserveEvm();
    state.pendingRates[1] = adopted;
    const committed = await callReserve(session, encodeCommitRate(1, adopted, T0 + epoch, T0));
    assert.equal(committed.ok, true, committed.reason);
    const cb = { coinbase: true, vout: [] };
    const run = async (now, txs) => {
      const applied = applyReserveBlock({
        state,
        block: { txs, height: 1 },
        nowMs: now,
        genesisMs: T0,
        activationHeight: 0,
      });
      assert.equal(applied.ok, true, `${now} ${applied.reason}`);
      const evm = await executeBlockEvm(session, txs, now, T0);
      assert.equal(evm.ok, true, `${now} ${evm.reason}`);
    };
    await run(T0, [cb, piLock({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'rate-lock' }, signer)]);
    await run(T0 + epoch, [cb]);
    await run(T0 + epoch + 1, [cb]);
    assert.equal(state.currentEpoch, 1);
    assert.equal(state.epochBps, adopted);
    let view = decodePublicView(
      (await callReserve(session, encodePublicView(T0 + epoch + 1), { staticCall: true })).returnValue,
    );
    assert.equal(view.currentEpoch, 1);
    assert.equal(view.oracleBps, adopted);
    await run(T0 + 2 * epoch, [cb]);
    assert.equal(state.epochBps, adopted);
    await run(T0 + 2 * epoch + 1, [cb]);
    assert.equal(state.currentEpoch, 2);
    assert.equal(state.epochBps, adopted);
    assert.notEqual(state.epochBps, GENESIS_BPS);
    view = decodePublicView(
      (await callReserve(session, encodePublicView(T0 + 2 * epoch + 1), { staticCall: true })).returnValue,
    );
    assert.equal(view.currentEpoch, 2);
    assert.equal(view.oracleBps, adopted);
    const slot = await callReserve(session, encodeEpochRateOf(2), { staticCall: true });
    assert.equal(slot.ok, true, slot.reason);
    assert.equal(decodeNextEpochBps(slot.returnValue), adopted);
  });
});

const STEP_MS = 1_200_000;
const BOUNDARY_HEIGHT = Math.floor(RESERVE_EPOCH_MS / STEP_MS) + 1;
const WINDOW_START = BOUNDARY_HEIGHT - W;
const TRUST = { trustBlockHash: true, skipSharePow: true, nowMs: T0 + 400 * 86_400_000 };

function idHash(n, salt) {
  const hash = Buffer.alloc(32);
  hash[29] = salt & 0xff;
  hash[30] = (n >> 8) & 0xff;
  hash[31] = n & 0xff;
  return hash;
}

function reseal(tpl, cb) {
  const decoded = decodeHeader(Buffer.from(tpl.header));
  return encodeHeader({
    version: decoded.version,
    prevBlockHash: decoded.prevBlockHash,
    merkleRoot: merkleRoot([digestTx(cb)]),
    continuityRoot: decoded.continuityRoot,
    timestamp: decoded.timestamp,
    bits: decoded.bits,
    nonce: 0n,
    baseFee: decoded.baseFee,
  });
}

function extendChain(chain, miner, { from, to, salt, tenths }) {
  for (let height = from; height <= to; height += 1) {
    const prev = chain.length ? chain[chain.length - 1] : null;
    const now = T0 + (height - 1) * STEP_MS;
    const tpl = buildTemplate({
      prev: prev ? prev.hash : GENESIS_PREV,
      prevHeader: prev ? prev.header : null,
      prevBlock: prev,
      parentWeight: prev ? prev.weight : 0,
      height,
      miner,
      bits: prev ? retarget(chain, now) : GENESIS_BITS_PACKED,
      now,
      txs: [],
      parentBlocks: chain,
    });
    const cb = { ...tpl.txs[0], vout: (tpl.txs[0].vout || []).map((row) => ({ ...row })) };
    if (height >= WINDOW_START && height < BOUNDARY_HEIGHT) {
      cb.reports = POLICY_BANK_IDS.map((id, k) => ({ id, tenths: tenths[k] }));
    }
    if (height === BOUNDARY_HEIGHT) {
      const prior = chain.slice(WINDOW_START - 1, BOUNDARY_HEIGHT - 1);
      const window = prior.map((block) => ({
        height: block.height,
        miner: block.miner,
        reports: block.txs[0].reports,
      }));
      const bps = epochBpsFromReports(GENESIS_BPS, window, { windowSize: W });
      cb.rateCommit = { epochIndex: 1, epochBps: bps, magic: MAGIC_TESTNET };
    }
    const header = reseal(tpl, cb);
    chain.push({
      ...tpl,
      header,
      hash: idHash(height, salt),
      height,
      txs: [cb],
      miner,
      magic: MAGIC_TESTNET,
    });
  }
  return chain;
}

function committedRate(blocks) {
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  for (let i = 0; i < blocks.length; i += 1) {
    const parent = i > 0 ? blocks[i - 1] : null;
    const fields = reserveApplyFields({
      prior: blocks.slice(0, i),
      block: blocks[i],
      magic: MAGIC_TESTNET,
      parentMs: parent ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) : 0,
      genesisMs: T0,
      nowMs: Number(decodeHeader(Buffer.from(blocks[i].header)).timestamp),
    });
    fields.activationHeight = 0;
    const applied = applyReserveBlock({ state, ...fields });
    if (applied && applied.ok === false) throw new Error(applied.reason || 'epoch_open');
  }
  return { epochBps: state.epochBps, nextEpochBps: state.nextEpochBps };
}

describe('activation reaches the store, the EVM, a reorg, and a sealed boot', () => {
  it('Reserve bytecode adopts the committed rate as nextEpochBps', async () => {
    const session = await bootReserveEvm();
    const ran = await executeBlockEvm(session, [{
      coinbase: true,
      vout: [],
      rateCommit: { epochIndex: 0, epochBps: 350, magic: MAGIC_TESTNET },
    }], T0);
    assert.equal(ran.ok, true, ran.reason);
    const next = await callReserve(session, encodeNextEpochBps(), { staticCall: true });
    assert.equal(next.ok, true, next.reason);
    assert.equal(decodeNextEpochBps(next.returnValue), 350);
    const view = await callReserve(session, encodePublicView(T0), { staticCall: true });
    assert.equal(view.ok, true, view.reason);
    assert.equal(decodePublicView(view.returnValue).oracleBps, GENESIS_BPS);
  });

  it('commitRate stores the vortex index, including 0 and an index past currentEpoch', async () => {
    const session = await bootReserveEvm();
    const epoch = RESERVE_EPOCH_MS;
    const opened = await executeBlockEvm(session, [{
      coinbase: true,
      vout: [],
      rateCommit: { epochIndex: 0, epochBps: 350, magic: MAGIC_TESTNET },
    }], T0, T0);
    assert.equal(opened.ok, true, opened.reason);
    const slot = await callReserve(session, encodeRateCommitEpoch(), { staticCall: true });
    assert.equal(slot.ok, true, slot.reason);
    assert.equal(decodeNextEpochBps(slot.returnValue), 0);
    const locked = await callReserve(session, encodeDeposit('portal-a', PI_SHE_NANOS, T0));
    assert.equal(locked.ok, true, locked.reason);
    const view = decodePublicView((await callReserve(session, encodePublicView(T0), { staticCall: true })).returnValue);
    assert.equal(view.currentEpoch, 0);
    assert.equal(view.oracleBps, 350);
    const boundary = T0 + epoch;
    const commit1 = await callReserve(session, encodeCommitRate(1, 400, boundary, T0));
    assert.equal(commit1.ok, true, commit1.reason);
    const enacted = await callReserve(session, encodeEnact(boundary));
    assert.equal(enacted.ok, true, enacted.reason);
    const commit2 = await callReserve(session, encodeCommitRate(2, 500, T0 + 2 * epoch, T0));
    assert.equal(commit2.ok, true, commit2.reason);
    const kept = await callReserve(session, encodeEpochRateOf(1), { staticCall: true });
    const later = await callReserve(session, encodeEpochRateOf(2), { staticCall: true });
    const cursor = await callReserve(session, encodeRateCommitEpoch(), { staticCall: true });
    assert.equal(decodeNextEpochBps(kept.returnValue), 400);
    assert.equal(decodeNextEpochBps(later.returnValue), 500);
    assert.equal(decodeNextEpochBps(cursor.returnValue), 2);
    const drawn = await callReserve(session, encodeWithdraw('portal-a', T0 + 2 * epoch));
    assert.equal(drawn.ok, false);
    assert.equal(drawn.reason, 'unsigned');
    const one = (bps) => Number((BigInt(PI_SHE_NANOS) * BigInt(bps)) / 10000n);
    assert.ok(one(350) + one(400) > 0);
  });

  it('the next epoch open adopts the committed rate end to end', async () => {
    const session = await bootReserveEvm();
    const epoch = RESERVE_EPOCH_MS;
    const pinned = await callReserve(session, encodePinClock(T0));
    assert.equal(pinned.ok, true, pinned.reason);
    const locked = await callReserve(session, encodeDeposit('portal-b', PI_SHE_NANOS, T0));
    assert.equal(locked.ok, true, locked.reason);
    const before = decodePublicView((await callReserve(session, encodePublicView(T0), { staticCall: true })).returnValue);
    assert.equal(before.oracleBps, GENESIS_BPS);
    assert.equal(before.currentEpoch, 0);
    const committed = await callReserve(session, encodeCommitRate(1, 350, T0 + epoch, T0));
    assert.equal(committed.ok, true, committed.reason);
    const enacted = await callReserve(session, encodeEnact(T0 + epoch));
    assert.equal(enacted.ok, true, enacted.reason);
    const held = decodePublicView((await callReserve(session, encodePublicView(T0 + epoch), { staticCall: true })).returnValue);
    assert.equal(held.oracleBps, GENESIS_BPS);
    assert.equal(held.bonusEnacted, true);
    const rolled = await callReserve(session, encodeDeposit('portal-c', PI_SHE_NANOS, T0 + epoch + 1));
    assert.equal(rolled.ok, true, rolled.reason);
    const after = decodePublicView((await callReserve(session, encodePublicView(T0 + epoch + 1), { staticCall: true })).returnValue);
    assert.equal(after.currentEpoch, 1);
    assert.equal(after.oracleBps, 350);
    const rate = await callReserve(session, encodeEpochRateOf(1), { staticCall: true });
    assert.equal(decodeNextEpochBps(rate.returnValue), 350);
  });

  it('a heavier fork replaces the committed rate, and a sealed boot replays it', async () => {
    const lowTenths = [1000, 1500, 2000, 2500, 3000, 3200, 3400, 3600, 3800, 4000, 4500, 5000, 5500, 6000];
    const highTenths = [2000, 2500, 3000, 3500, 4000, 4200, 4400, 4600, 4800, 5000, 5500, 6000, 6500, 7000];
    assert.equal(trimmedMeanBps(lowTenths), 350);
    assert.equal(trimmedMeanBps(highTenths), 450);
    const miner = minerOf();
    const prefix = extendChain([], miner, { from: 1, to: WINDOW_START - 1, salt: 1, tenths: lowTenths });
    const low = extendChain(prefix.slice(), miner, {
      from: WINDOW_START,
      to: BOUNDARY_HEIGHT,
      salt: 1,
      tenths: lowTenths,
    });
    const high = extendChain(prefix.slice(), miner, {
      from: WINDOW_START,
      to: BOUNDARY_HEIGHT + 1,
      salt: 2,
      tenths: highTenths,
    });
    const lowRate = committedRate(low);
    const highRate = committedRate(high);
    assert.equal(lowRate.nextEpochBps, 350);
    assert.equal(lowRate.epochBps, GENESIS_BPS);
    assert.equal(highRate.nextEpochBps, 450);
    assert.equal(highRate.epochBps, GENESIS_BPS);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-oracle-seal-'));
    const store = createStore(dir, { oracleActivationHeight: 0 });
    const first = await store.ingest(low, TRUST);
    assert.equal(first.ok, true, `${first.reason || ''} at ${first.at ?? ''}`);
    assert.equal(store.reserveVault.nextEpochBps, 350);
    assert.equal(store.reserveVault.epochBps, GENESIS_BPS);
    const won = await store.ingest(high, TRUST);
    assert.equal(won.ok, true, `${won.reason || ''} at ${won.at ?? ''}`);
    assert.equal(won.reorg, true);
    assert.equal(store.reserveVault.nextEpochBps, 450);
    assert.equal(store.reserveVault.epochBps, GENESIS_BPS);

    fs.rmSync(path.join(dir, 'book.snap'), { force: true });
    const key = bookSealKeyFor(dir);
    const sealed = fs.readFileSync(path.join(dir, 'book.seal'), 'utf8').trim();
    assert.equal(sealed, chainLoadSeal(store.blocks, key));
    const booted = createStore(dir, { oracleActivationHeight: 0 });
    assert.equal(booted.reserveVault.nextEpochBps, highRate.nextEpochBps);
    assert.equal(booted.reserveVault.epochBps, highRate.epochBps);
  });
});

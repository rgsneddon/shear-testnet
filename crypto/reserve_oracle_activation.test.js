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
import { applyReserveBlock, deposit, enact, emptyVault, lockTx, previewWithdraw, withdraw, withdrawTx } from './reserve_vault.js';
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
import { newIdentity } from './address.js';
import { vaultDest } from './flow_sheet.js';
import {
  bootReserveEvm,
  callReserve,
  decodeNextEpochBps,
  decodePublicView,
  decodeWithdraw,
  encodeCommitRate,
  encodeDeposit,
  encodeEnact,
  encodeEpochRateOf,
  encodeNextEpochBps,
  encodePinClock,
  encodePortalOf,
  encodePublicView,
  encodeRateCommitEpoch,
  encodeWithdraw,
  decodePortal,
  executeBlockEvm,
} from './reserve_evm.js';

const T0 = 1_700_000_000_000;
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

function applyBoundary(state, { height, nowMs, parentMs, window, bps, epochIndex, activationHeight = 0 }) {
  const txs = [{ coinbase: true, vout: [] }];
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

  it('a split inside a bank still yields the trimmed mean of the agreeing banks', () => {
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
    assert.equal(want, 333);
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
    assert.equal(state.pendingRates[1], 333);
    assert.equal(state.nextEpochBps, 333);
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
    const opened = deposit({ state, dest: who, nanos: PI_SHE_NANOS, nowMs: T0 });
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
    const due = interestNanos(PI_SHE_NANOS, GENESIS_BPS) + interestNanos(PI_SHE_NANOS, firstBps);
    assert.equal(previewWithdraw(state, who, at).interest, due);
    const paid = withdraw({ state, dest: who, nowMs: at });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.interest, due);
    assert.notEqual(paid.interest, interestNanos(PI_SHE_NANOS, secondBps) * 2);
    assert.notEqual(paid.interest, interestNanos(PI_SHE_NANOS, GENESIS_BPS));
  });

  it('commits the trimmed mean of a mixed-bank window', () => {
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
  const opened = deposit({ state, dest: who, nanos: PI_SHE_NANOS, nowMs: lockAt });
  assert.equal(opened.ok, true, opened.reason);
  const paid = withdraw({ state, dest: who, nowMs: drawAt });
  assert.equal(paid.ok, true, paid.reason);
  const id = `portal-${offset}-${holdEpochs}`;
  const locked = await callReserve(session, encodeDeposit(id, PI_SHE_NANOS, lockAt));
  assert.equal(locked.ok, true, locked.reason);
  const enacted = await callReserve(session, encodeEnact(drawAt));
  assert.equal(enacted.ok, true, enacted.reason);
  const drawn = await callReserve(session, encodeWithdraw(id, drawAt));
  assert.equal(drawn.ok, true, drawn.reason);
  const evmPaid = decodeWithdraw(drawn.returnValue);
  assert.equal(evmPaid.principal, PI_SHE_NANOS);
  assert.equal(evmPaid.interest, paid.interest);
  const want = satWant(offset, holdEpochs, rates);
  assert.equal(paid.interest, want, `offset ${offset}`);
  return paid.interest;
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

/** Pro-rata of the lock epoch, then each later full epoch before withdraw. */
function satWant(offset, holdEpochs, rates, stake = PI_SHE_NANOS) {
  const span = RESERVE_EPOCH_MS;
  const idx = Math.floor(offset);
  const until = Math.floor(offset + holdEpochs);
  const rate = (e) => (rates && rates[e] != null ? rates[e] : GENESIS_BPS);
  let total = proRata(stake, rate(idx), remainAt(offset), span);
  for (let e = idx + 1; e < until; e += 1) total += proRata(stake, rate(e), span, span);
  return total;
}

describe('chain-genesis clock pays the epochs a stake sat through', () => {
  const rates = { 1: 300, 2: 400, 3: 500, 4: 640 };

  it('first lock at 0, 0.5, 1.5, and 3.25 epochs matches JS to the EVM', async () => {
    const at0 = await satInterest(0, 2, rates);
    const atHalf = await satInterest(0.5, 2, rates);
    const at15 = await satInterest(1.5, 2, rates);
    const at325 = await satInterest(3.25, 2, rates);
    assert.equal(at0, epochInterest(GENESIS_BPS) + epochInterest(300));
    assert.equal(atHalf, proRata(PI_SHE_NANOS, GENESIS_BPS, remainAt(0.5)) + epochInterest(300));
    // Lock at 1.5 keeps half of epoch 1 (300) and the whole of epoch 2 (400).
    assert.equal(at15, proRata(PI_SHE_NANOS, 300, remainAt(1.5)) + epochInterest(400));
    assert.notEqual(at15, epochInterest(300) + epochInterest(400));
    assert.equal(at325, proRata(PI_SHE_NANOS, 500, remainAt(3.25)) + epochInterest(640));
  });

  it('a withdraw across several epochs pays each committed rate', async () => {
    const got = await satInterest(0, 4, rates);
    const want = epochInterest(GENESIS_BPS) + epochInterest(300) + epochInterest(400) + epochInterest(500);
    assert.equal(got, want);
    assert.notEqual(got, epochInterest(500) * 4);
  });
});

function interestOf(stake, bps) {
  return Number((BigInt(stake) * BigInt(bps)) / 10000n);
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

/** One JS vault and one EVM session. `locks` run in order. Interest is exact. */
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
  for (const lock of locks) {
    const at = T0 + lock.offset * epoch;
    enactIfDue(state, at);
    const got = deposit({ state, dest: lock.who, nanos: lock.nanos, nowMs: at });
    assert.equal(got.ok, true, `${lock.who} ${got.reason}`);
    if (lock.stake != null) assert.equal(got.idle, !lock.stake, `${lock.who} stake`);
    await enactEvm(session, at);
    const evm = await callReserve(session, encodeDeposit(lock.who, lock.nanos, at));
    assert.equal(evm.ok, true, `${lock.who} evm ${evm.reason}`);
    if (lock.stake != null) {
      const portal = decodePortal((await callReserve(session, encodePortalOf(lock.who), { staticCall: true })).returnValue);
      const addedIdle = lock.stake ? 0 : lock.nanos;
      assert.equal(portal.idle, (rows.find((r) => r.who === lock.who)?.idle || 0) + addedIdle);
    }
    rows.push({ who: lock.who, idle: lock.stake ? 0 : lock.nanos });
  }
  const interest = {};
  for (const lock of locks) {
    if (interest[lock.who] != null) continue;
    const paid = withdraw({ state, dest: lock.who, nowMs: drawAt });
    assert.equal(paid.ok, true, `${lock.who} ${paid.reason}`);
    await enactEvm(session, drawAt);
    const drawn = await callReserve(session, encodeWithdraw(lock.who, drawAt));
    assert.equal(drawn.ok, true, `${lock.who} evm ${drawn.reason}`);
    const evmPaid = decodeWithdraw(drawn.returnValue);
    assert.equal(evmPaid.interest, paid.interest, lock.who);
    interest[lock.who] = paid.interest;
  }
  return interest;
}

describe('a lock earns the rest of its chain epoch, then full epochs', () => {
  const nine = PI_SHE_NANOS * 9;
  const due = (stake, offset, draw, rates = null) => satWant(offset, draw - offset, rates, stake);

  it('Alice at 0.2 and Mallory at 0.95 withdraw at 1.2, and Mallory earns about 5%', async () => {
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
    assert.equal(paid[alice], due(PI_SHE_NANOS, 0.2, 1.2));
    assert.equal(paid[mallory], due(PI_SHE_NANOS, 0.95, 1.2));
    assert.ok(paid[mallory] > Math.floor(full * 4 / 100));
    assert.ok(paid[mallory] < Math.ceil(full * 6 / 100));
  });

  it('a top-up of π at 0.1 then 9π at 0.8 pro-rates each credit', async () => {
    const who = minerOf();
    const early = await jsEvmStake({
      locks: [
        { who, offset: 0.1, nanos: PI_SHE_NANOS, stake: true },
        { who, offset: 0.8, nanos: nine, stake: false },
      ],
      drawOffset: 1.2,
    });
    assert.equal(early[who], due(PI_SHE_NANOS, 0.1, 1.2) + due(nine, 0.8, 1.2));
    const who2 = minerOf();
    const later = await jsEvmStake({
      locks: [
        { who: who2, offset: 0.1, nanos: PI_SHE_NANOS, stake: true },
        { who: who2, offset: 0.8, nanos: nine, stake: false },
      ],
      drawOffset: 2,
    });
    assert.equal(later[who2], due(PI_SHE_NANOS, 0.1, 2) + due(nine, 0.8, 2));
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
    assert.equal(same[who], due(PI_SHE_NANOS, 0.1, 2) + due(nine, 0.5, 2));
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
    assert.equal(crossed[who2], due(PI_SHE_NANOS, 0.1, 3, rates) + due(nine, 1.2, 3, rates));
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
      assert.equal(paid[who], due(PI_SHE_NANOS, row.lock, row.draw), `lock ${row.lock} draw ${row.draw}`);
    }
  });
});

describe('pinClock runs before the first lock in a block', () => {
  it('a lock at 1.5 pro-rates epoch 1 when the block pins the chain clock first', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const lockAt = T0 + 1.5 * epoch;
    const drawAt = T0 + 3.5 * epoch;
    const bps = 400;
    const session = await bootReserveEvm();
    const ran = await executeBlockEvm(session, [
      { coinbase: true, vout: [] },
      lockTx({ from: 'pin-first', to: 'pin-first', nanos: PI_SHE_NANOS, id: 'pin-lock' }),
    ], lockAt, T0);
    assert.equal(ran.ok, true, ran.reason);
    const commit = await callReserve(session, encodeCommitRate(2, bps, T0 + 2 * epoch, T0));
    assert.equal(commit.ok, true, commit.reason);
    const enacted = await callReserve(session, encodeEnact(drawAt));
    assert.equal(enacted.ok, true, enacted.reason);
    const drawn = await callReserve(session, encodeWithdraw('pin-first', drawAt));
    assert.equal(drawn.ok, true, drawn.reason);
    const paid = decodeWithdraw(drawn.returnValue);
    const half = proRata(PI_SHE_NANOS, GENESIS_BPS, epoch / 2, epoch);
    assert.equal(paid.interest, half + interestOf(PI_SHE_NANOS, bps));

    const state = emptyVault();
    state.magic = MAGIC_TESTNET;
    state.genesisMs = T0;
    state.pendingRates[2] = bps;
    const who = minerOf();
    assert.equal(deposit({ state, dest: who, nanos: PI_SHE_NANOS, nowMs: lockAt }).ok, true);
    const jsPaid = withdraw({ state, dest: who, nowMs: drawAt });
    assert.equal(jsPaid.ok, true, jsPaid.reason);
    assert.equal(jsPaid.interest, paid.interest);

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
    const afterPin = await callReserve(late, encodeWithdraw('late-pin', drawAt));
    assert.equal(afterPin.ok, true, afterPin.reason);
    assert.equal(decodeWithdraw(afterPin.returnValue).interest, paid.interest);
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
    assert.equal(Number(empty.totalLockedNanos), PI_SHE_NANOS);

    const replay = emptyVault();
    replay.magic = MAGIC_TESTNET;
    const block = {
      height: 1,
      txs: [
        { coinbase: true, vout: [] },
        lockTx({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'replay-unpinned' }),
      ],
    };
    const replayDenied = applyReserveBlock({ state: replay, block, nowMs: T0 });
    assert.equal(replayDenied.ok, false);
    assert.equal(replayDenied.reason, 'clock');
    assert.equal(replay.totalLockedNanos, 0n);
    const replayed = applyReserveBlock({ state: replay, block, nowMs: T0, genesisMs: T0 });
    assert.equal(replayed.ok, true, replayed.reason);
    assert.equal(Number(replay.totalLockedNanos), PI_SHE_NANOS);

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
    assert.equal(Number(booted.reserveVault.totalLockedNanos), PI_SHE_NANOS);
  });
});

describe('the block path rolls before its transactions', () => {
  it('JS and the EVM adopt each epoch rate and pay the same interest', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const who = minerOf();
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
        txs: [cb, lockTx({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'block-lock' })],
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
    const draw = [
      cb,
      withdrawTx({ from: who, to: who, nanos: 1, id: 'block-draw' }),
    ];
    const applied = applyReserveBlock({
      state,
      block: { txs: draw, height: 8 },
      nowMs: drawAt,
      genesisMs: T0,
      activationHeight: 0,
    });
    assert.equal(applied.ok, true, applied.reason);
    const row = [...applied].find((item) => item && item.action === 'withdraw');
    assert.equal(row && row.ok, true, row && row.reason);
    const evm = await executeBlockEvm(session, draw, drawAt, T0);
    assert.equal(evm.ok, true, evm.reason);
    const want = proRata(PI_SHE_NANOS, GENESIS_BPS, half, epoch)
      + interestOf(PI_SHE_NANOS, 300)
      + interestOf(PI_SHE_NANOS, 400)
      + interestOf(PI_SHE_NANOS, 500);
    assert.equal(row.interest, want);
    assert.equal(evm.withdrawInterest, want);
    assert.equal(state.currentEpoch, 3);
    const view = decodePublicView(
      (await callReserve(session, encodePublicView(drawAt), { staticCall: true })).returnValue,
    );
    assert.equal(view.currentEpoch, 3);
    assert.equal(view.oracleBps, 500);
  });
});

describe('a withdraw stays open after the enacting block', () => {
  const blocksLater = 8;

  async function exitLater({ blocksAfter = null, at = null, gapBps = null } = {}) {
    const epoch = RESERVE_EPOCH_MS;
    const who = minerOf();
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
      return { applied, evm };
    };
    await run(T0 + half, [
      cb,
      lockTx({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'open-lock' }),
    ]);
    await run(T0 + epoch, [cb]);
    if (blocksAfter != null) {
      for (let i = 1; i < blocksAfter; i += 1) {
        await run(T0 + epoch + i, [cb]);
      }
    }
    const drawAt = at != null ? at : T0 + epoch + blocksAfter;
    const { applied, evm } = await run(drawAt, [
      cb,
      withdrawTx({ from: who, to: who, nanos: 1, id: 'open-draw' }),
    ]);
    const row = [...applied].find((item) => item && item.action === 'withdraw');
    assert.equal(row && row.ok, true, row && row.reason);
    const want = proRata(PI_SHE_NANOS, GENESIS_BPS, half, epoch);
    assert.equal(row.interest, want);
    assert.equal(evm.withdrawInterest, want);
    if (gapBps != null) {
      assert.equal(state.pendingRates[1], gapBps);
      const skipped = await callReserve(session, encodeEpochRateOf(1), { staticCall: true });
      assert.equal(skipped.ok, true, skipped.reason);
      assert.equal(decodeNextEpochBps(skipped.returnValue), gapBps);
      assert.notEqual(row.interest, want + interestOf(PI_SHE_NANOS, gapBps));
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

  it('a withdraw succeeds when an epoch had no block, and that epoch is not paid', async () => {
    const epoch = RESERVE_EPOCH_MS;
    const { state } = await exitLater({
      at: T0 + 2 * epoch + epoch / 2,
      gapBps: 500,
    });
    assert.equal(state.currentEpoch, 2);
    assert.equal(state.bonusEnacted, false);
    assert.equal(state.enactedAtEpoch, 0);
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
    const who = minerOf();
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
    await run(T0, [cb, lockTx({ from: who, to: who, nanos: PI_SHE_NANOS, id: 'rate-lock' })]);
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
    assert.equal(drawn.ok, true, drawn.reason);
    const paid = decodeWithdraw(drawn.returnValue);
    const one = (bps) => Number((BigInt(PI_SHE_NANOS) * BigInt(bps)) / 10000n);
    assert.equal(paid.principal, PI_SHE_NANOS);
    assert.equal(paid.interest, one(350) + one(400));
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

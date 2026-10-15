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
import { applyReserveBlock, deposit, emptyVault, previewWithdraw, withdraw } from './reserve_vault.js';
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
  encodePublicView,
  encodeRateCommitEpoch,
  encodeWithdraw,
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
  state.currentEpoch = 1;
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

async function verifyBoundary({ activation, window, commitBps, epochIndex, now, committedBps = GENESIS_BPS }) {
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
    genesisMs: T0,
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
    assert.equal(state.epochBps, GENESIS_BPS);
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
    }], T0);
    assert.equal(opened.ok, true, opened.reason);
    const slot = await callReserve(session, encodeRateCommitEpoch(), { staticCall: true });
    assert.equal(slot.ok, true, slot.reason);
    assert.equal(decodeNextEpochBps(slot.returnValue), 0);
    const locked = await callReserve(session, encodeDeposit('portal-a', PI_SHE_NANOS, T0));
    assert.equal(locked.ok, true, locked.reason);
    const view = decodePublicView((await callReserve(session, encodePublicView(T0), { staticCall: true })).returnValue);
    assert.equal(view.currentEpoch, 1);
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
    const locked = await callReserve(session, encodeDeposit('portal-b', PI_SHE_NANOS, T0));
    assert.equal(locked.ok, true, locked.reason);
    const before = decodePublicView((await callReserve(session, encodePublicView(T0), { staticCall: true })).returnValue);
    assert.equal(before.oracleBps, GENESIS_BPS);
    assert.equal(before.currentEpoch, 1);
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
    assert.equal(after.currentEpoch, 2);
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

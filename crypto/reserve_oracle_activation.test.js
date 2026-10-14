import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHeader, encodeHeader } from './header.js';
import { merkleRoot } from './merkle.js';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  RESERVE_EPOCH_MS,
  asertNextBits,
} from './asert.js';
import {
  GENESIS_BPS,
  ORACLE_WINDOW_MAINNET,
  ORACLE_WINDOW_TESTNET,
  POLICY_BANK_IDS,
  epochBpsFromReports,
  windowBlocksFor,
} from './reserve_oracle.js';
import { applyReserveBlock, emptyVault } from './reserve_vault.js';
import { GENESIS_PREV, buildTemplate, digestTx, verifyBlock } from '../node/src/chain.js';
import { newIdentity } from './address.js';
import { vaultDest } from './flow_sheet.js';

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
    assert.equal(state.epochBps, 250);
    assert.equal(state.nextEpochBps, 250);

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
    assert.equal(state.epochBps, 500);
    assert.notEqual(state.epochBps, GENESIS_BPS);

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
    assert.notEqual(matched.reason, 'rate_commit', matched.reason);
    const stillFixed = await verifyBoundary({
      activation: undefined,
      window: firstWindow,
      commitBps: null,
      epochIndex: 1,
      now: T0 + RESERVE_EPOCH_MS,
    });
    assert.notEqual(stillFixed.reason, 'rate_commit', stillFixed.reason);
  });
});

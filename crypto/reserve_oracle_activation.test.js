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
  reserveApplyFields,
  trimmedMeanBps,
  windowBlocksFor,
} from './reserve_oracle.js';
import { applyReserveBlock, deposit, emptyVault } from './reserve_vault.js';
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
  encodeNextEpochBps,
  encodePublicView,
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
    assert.notEqual(stillFixed.reason, 'rate_commit', stillFixed.reason);
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

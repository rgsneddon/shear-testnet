/**
 * Guard for Russell's 2026-10-29 16:07 GMT ruling A: shear-dev gets its own
 * day length and vote constants as a dev-only exception. Nothing moves for
 * shear-testnet-v12, shear-v1, shear-regtest or the closed books.
 *
 * Fails on b3efdc26 only because voteParams, vaultCalendarDayBlocks,
 * genesisSeedPacked and MAGIC_DEV do not exist yet. Every public value
 * asserted below is the b3efdc26 value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  MAGIC_DEV, MAGIC_TESTNET, MAGIC_MAINNET, TARGET_BLOCK_INTERVAL_MS, MTP_FUTURE_MS, HEADER_AHEAD_MS,
  ASERT_HALFLIFE_MS, GENESIS_BITS_PACKED, consensusFingerprint, mainnetFingerprint, genesisSeedPacked,
} from './asert.js';
import { epochDays, epochMs, joinCutoffMs, joinCutoffDays } from './pot_sched.js';
import {
  VAULT_DAY_BLOCKS, vaultDayBlocks, vaultEpochBlocks, vaultPeriodBlocks, vaultCalendarDayBlocks,
} from './vault_accrual.js';
import {
  VOTE_FINALITY_BLOCKS, VOTE_GAP_BLOCKS, VOTE_EDGE_BLOCKS, VOTE_MIN_SEPARATION,
  voteParams, voteCloseDay, voteCloseHeight,
} from './leaf_vote.js';
import { windowBlocksFor } from './reserve_oracle.js';
import { withdrawChainId } from './reserve_vault.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');

const PUBLIC = {
  [MAGIC_TESTNET]: {
    epochDays: 4, epochMs: 345_600_000, joinCutoffMs: 86_400_000, joinCutoffDays: 1,
    stub: 24, epochBlocks: 3840, periodBlocks: 240, closeDay: 3, closeHeight: 2880, oracle: 67,
  },
  [MAGIC_MAINNET]: {
    epochDays: 400, epochMs: 34_560_000_000, joinCutoffMs: 8_553_600_000, joinCutoffDays: 99,
    stub: 960, epochBlocks: 384_000, periodBlocks: 24_000, closeDay: 301, closeHeight: 288_960, oracle: 6720,
  },
};
const V12_ROW_BOOKS = ['shear-regtest', 'shear-testnet-v11', 'shear-testnet-v2'];

test('the public day length and vote constants are unchanged', () => {
  assert.equal(VAULT_DAY_BLOCKS, 960);
  assert.equal(VOTE_FINALITY_BLOCKS, 100);
  assert.equal(VOTE_GAP_BLOCKS, 7);
  assert.equal(VOTE_EDGE_BLOCKS, 10);
  assert.equal(VOTE_MIN_SEPARATION, 30);
  assert.equal(TARGET_BLOCK_INTERVAL_MS, 90_000);
  assert.equal(MTP_FUTURE_MS, 7_200_000);
  assert.equal(HEADER_AHEAD_MS, 15_000);
  assert.equal(ASERT_HALFLIFE_MS, 7_200_000);
  const want = { finality: 100, gap: 7, edge: 10, separation: 30, dayBlocks: 960 };
  for (const m of [MAGIC_TESTNET, MAGIC_MAINNET, ...V12_ROW_BOOKS, undefined]) {
    assert.deepEqual(voteParams(m), want, String(m));
    assert.equal(vaultCalendarDayBlocks(m), 960, String(m));
    assert.equal(withdrawChainId(m), 2701n, String(m));
  }
});

test('v12 and shear-v1 epoch, period, accrual, vote and oracle widths are unchanged', () => {
  for (const [m, w] of Object.entries(PUBLIC)) {
    assert.equal(epochDays(m), w.epochDays, m);
    assert.equal(epochMs(m), w.epochMs, m);
    assert.equal(joinCutoffMs(m), w.joinCutoffMs, m);
    assert.equal(joinCutoffDays(m), w.joinCutoffDays, m);
    assert.equal(vaultDayBlocks(m), w.stub, m);
    assert.equal(vaultEpochBlocks(m), w.epochBlocks, m);
    assert.equal(vaultPeriodBlocks(m), w.periodBlocks, m);
    assert.equal(voteCloseDay(m), w.closeDay, m);
    assert.equal(voteCloseHeight(0, m), w.closeHeight, m);
    assert.equal(windowBlocksFor(m), w.oracle, m);
  }
  for (const m of V12_ROW_BOOKS) {
    const w = PUBLIC[MAGIC_TESTNET];
    assert.equal(epochMs(m), w.epochMs, m);
    assert.equal(vaultEpochBlocks(m), w.epochBlocks, m);
    assert.equal(voteCloseHeight(0, m), w.closeHeight, m);
  }
});

test('only shear-dev differs', () => {
  assert.notEqual(epochMs(MAGIC_DEV), epochMs(MAGIC_TESTNET));
  assert.notEqual(vaultEpochBlocks(MAGIC_DEV), vaultEpochBlocks(MAGIC_TESTNET));
  assert.notEqual(vaultCalendarDayBlocks(MAGIC_DEV), VAULT_DAY_BLOCKS);
  assert.notDeepEqual(voteParams(MAGIC_DEV), voteParams(MAGIC_TESTNET));
  assert.notEqual(withdrawChainId(MAGIC_DEV), 2701n);
  assert.notEqual(genesisSeedPacked(MAGIC_DEV), GENESIS_BITS_PACKED);
});

test('the public pins do not move', () => {
  assert.equal(sha(consensusFingerprint(MAGIC_TESTNET)), 'cc9a56995d07165e5d0b4a959ff89063b3fc2b52a4d527903f2a779b2d647274');
  assert.equal(sha(consensusFingerprint(MAGIC_MAINNET)), 'bebbf8518846efb0c208cec5df83a3534a0c7fdb364eb36d505e60414484d7a5');
  assert.equal(sha(mainnetFingerprint()), 'ddb6fd35434da12de187caa139bc7ae5edef3c1e869c965db846c922112443a1');
  const json = fs.readFileSync(path.join(here, '..', 'contracts', 'Reserve.json'));
  assert.equal(sha(json), '33f0a68c26d42e4fc8924b4740e36cd7f0ece4ce88a241fe048c3c51aee1a8ab');
  const code = Buffer.from(JSON.parse(json).deployedBytecode.replace(/^0x/, ''), 'hex');
  assert.equal(code.length, 24198);
  assert.equal(sha(code), '1f381ff790f4c1e10074612010390980d486b7948e6ef24228d9bf85ce6259cd');
  assert.equal(genesisSeedPacked(MAGIC_TESTNET), GENESIS_BITS_PACKED);
  assert.equal(genesisSeedPacked(MAGIC_MAINNET), GENESIS_BITS_PACKED);
});

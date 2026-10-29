/**
 * shear-dev book (re-cut of PR #128 onto the leaf-v2 vault).
 * Russell 2026-10-29 16:04 GMT: re-cut #128 on a new draft PR.
 * Russell 2026-10-29 16:07 GMT, ruling A: shear-dev gets its own day length
 * and vote constants as a dev-only exception.
 *
 * Fails on b3efdc26: crypto/chain_params.js does not exist, asert.js has no
 * MAGIC_DEV or genesisSeedPacked, and every clock below reads the v12 row
 * (a 4-day epoch of 960-block days) for an unknown magic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MAGIC_DEV, devRow, chainParams, paramsDigest, evmChainIdFor, devWithdrawOpen, withdrawSlotOpen,
} from './chain_params.js';
import {
  MAGIC_DEV as ASERT_MAGIC_DEV, MAGIC_TESTNET, MAGIC_MAINNET, GENESIS_BITS_PACKED, BITS_FP_SCALE,
  consensusFingerprint, genesisSeedPacked, asertNextBits, templateStampMs, consensusLaw,
} from './asert.js';
import { epochDays, epochMs, joinCutoffMs, joinCutoffDays, vortexEpochIndex, epochView } from './pot_sched.js';
import {
  vaultDayBlocks, vaultEpochBlocks, vaultPeriodBlocks, vaultCalendarDayBlocks, vaultAccrualNanos,
} from './vault_accrual.js';
import { voteParams, voteCloseDay, voteCloseHeight, voteWindowOpen, voteTallyReady } from './leaf_vote.js';
import { windowBlocksFor } from './reserve_oracle.js';
import { reservePinOk, bootReserveEvm } from './reserve_evm.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

test('MAGIC_DEV is exactly shear-dev and only that magic has a row', () => {
  assert.equal(MAGIC_DEV, 'shear-dev');
  assert.equal(ASERT_MAGIC_DEV, 'shear-dev');
  const row = devRow(MAGIC_DEV);
  assert.ok(row);
  assert.equal(chainParams(MAGIC_DEV), row);
  for (const other of [MAGIC_TESTNET, MAGIC_MAINNET, 'shear-regtest', 'shear-testnet-v11', 'SHEAR-DEV', ' shear-dev', '', null, undefined]) {
    assert.equal(devRow(other), null, String(other));
  }
  for (const bad of ['nope', '', null, undefined, MAGIC_TESTNET, MAGIC_MAINNET]) {
    assert.throws(() => chainParams(bad), (e) => e.code === 'unknown_magic', String(bad));
  }
  assert.ok(Object.isFrozen(row));
});

test('dev row: 9 s blocks, 8-block days, 32-block / 288 s epoch, chain id 2799', () => {
  const r = devRow(MAGIC_DEV);
  assert.equal(r.targetBlockMs, 9000);
  assert.equal(r.dayMs, 72000);
  assert.equal(r.dayBlocks, 8);
  assert.equal(r.epochDays, 4);
  assert.equal(r.epochMs, 288000);
  assert.equal(r.epochBlocks, 32);
  assert.equal(r.periodBlocks, 2);
  assert.equal(r.stubBlocks, 1);
  assert.equal(r.joinCutoffMs, 72000);
  assert.equal(r.voteCloseBlock, 24);
  assert.equal(r.voteFinality, 2);
  assert.equal(r.voteGap, 1);
  assert.equal(r.voteEdge, 1);
  assert.equal(r.voteSep, 1);
  assert.equal(r.withdrawSlots, 31);
  assert.equal(r.withdrawSlotMs, 9000);
  assert.equal(r.withdrawPeriodSlots, 15);
  assert.equal(r.genesisBits, 12);
  assert.equal(r.evmChainId, 2799);
  assert.equal(evmChainIdFor(MAGIC_DEV), 2799);
  assert.equal(r.epochBlocks * r.targetBlockMs, r.epochMs);
  assert.equal(r.dayBlocks * r.targetBlockMs, r.dayMs);
  assert.match(paramsDigest(MAGIC_DEV), /^[0-9a-f]{64}$/);
});

test('dev clock: pot_sched reads the dev row', () => {
  assert.equal(epochDays(MAGIC_DEV), 4);
  assert.equal(epochMs(MAGIC_DEV), 288000);
  assert.equal(joinCutoffMs(MAGIC_DEV), 72000);
  assert.equal(joinCutoffDays(MAGIC_DEV), 1);
  assert.equal(vortexEpochIndex({ nowMs: 1000 + 288000 * 3 + 5, genesisMs: 1000, epochDays: 4, epochMs: 288000 }), 3);
  const view = epochView({ nowMs: 1000 + 288000 + 9000, genesisMs: 1000, magic: MAGIC_DEV });
  assert.equal(view.epoch, 1);
});

test('dev vault: own day length, epoch and period widths, accrual over 32 blocks', () => {
  assert.equal(vaultCalendarDayBlocks(MAGIC_DEV), 8);
  assert.equal(vaultDayBlocks(MAGIC_DEV), 1);
  assert.equal(vaultEpochBlocks(MAGIC_DEV), 32);
  assert.equal(vaultPeriodBlocks(MAGIC_DEV), 2);
  const pi = 3_141_592_653n;
  const full = vaultAccrualNanos(pi, 281, vaultEpochBlocks(MAGIC_DEV), vaultEpochBlocks(MAGIC_DEV));
  assert.equal(full.nanos, (pi * 281n) / 10000n);
  const period = vaultAccrualNanos(pi, 281, vaultPeriodBlocks(MAGIC_DEV), vaultEpochBlocks(MAGIC_DEV));
  assert.equal(period.nanos, (pi * 281n * 2n) / (32n * 10000n));
});

test('dev votes: close at open+24, finality 2, gap/edge/separation 1', () => {
  assert.deepEqual(voteParams(MAGIC_DEV), { finality: 2, gap: 1, edge: 1, separation: 1, dayBlocks: 8 });
  assert.equal(voteCloseDay(MAGIC_DEV), 3);
  assert.equal(voteCloseHeight(100, MAGIC_DEV), 124);
  assert.equal(voteWindowOpen(100, 124, MAGIC_DEV), true);
  assert.equal(voteWindowOpen(100, 125, MAGIC_DEV), false);
  assert.equal(voteTallyReady(100, 125, MAGIC_DEV), false);
  assert.equal(voteTallyReady(100, 126, MAGIC_DEV), true);
});

test('dev withdraw gate: 31 slots and 15 periods, closed in the last period', () => {
  const r = devRow(MAGIC_DEV);
  assert.equal(devWithdrawOpen(0, r), true);
  assert.equal(devWithdrawOpen(269_999, r), true);
  assert.equal(devWithdrawOpen(270_000, r), false);
  assert.equal(withdrawSlotOpen(278_999, r), true);
  assert.equal(withdrawSlotOpen(279_000, r), false);
  assert.equal(devWithdrawOpen(287_999, r), false);
});

test('dev consensus: own genesis seed, fingerprint and ASERT target', () => {
  assert.equal(genesisSeedPacked(MAGIC_DEV), (12 * BITS_FP_SCALE) >>> 0);
  assert.equal(genesisSeedPacked(MAGIC_TESTNET), GENESIS_BITS_PACKED);
  assert.equal(genesisSeedPacked(MAGIC_MAINNET), GENESIS_BITS_PACKED);
  const fp = consensusFingerprint(MAGIC_DEV);
  assert.ok(fp.includes('NETWORK=shear-dev'));
  assert.ok(fp.includes(`PARAMS=${paramsDigest(MAGIC_DEV)}`));
  assert.ok(fp.includes('ASERT_TAU_MS=720000'));
  assert.ok(!fp.includes('HISTORICAL_TIP='));
  assert.notEqual(sha(fp), sha(consensusFingerprint(MAGIC_TESTNET)));
  assert.notEqual(sha(fp), sha(consensusFingerprint(MAGIC_MAINNET)));
  assert.equal(consensusLaw(MAGIC_DEV).bookLawFingerprint, fp);
  // On schedule at 9 s the dev anchor holds; the same spacing is 10x fast on v12.
  const anchor = { anchorBits: genesisSeedPacked(MAGIC_DEV), anchorTimeMs: 1_000_000, anchorHeight: 1 };
  const dev = asertNextBits({ ...anchor, blockTimeMs: 1_000_000 + 10 * 9000, blockHeight: 11, magic: MAGIC_DEV });
  assert.equal(dev.ok, true);
  assert.equal(dev.packed, anchor.anchorBits);
  const v12 = asertNextBits({ ...anchor, blockTimeMs: 1_000_000 + 10 * 9000, blockHeight: 11 });
  assert.ok(v12.packed > anchor.anchorBits);
  // MTP cap is the dev row's 720 s, not v12's 2 h.
  assert.equal(templateStampMs(1000, 10_000_000, null, 1000, MAGIC_DEV), 1000 + 720000);
  assert.equal(templateStampMs(1000, 10_000_000, null, 1000), 1000 + 2 * 3600_000);
});

test('dev oracle window and dev Reserve pin', async () => {
  assert.equal(windowBlocksFor(MAGIC_DEV), 1);
  assert.equal(reservePinOk(MAGIC_DEV), true);
  const s = await bootReserveEvm({ network: MAGIC_DEV });
  assert.equal(Number(s.common.chainId()), 2799);
  assert.equal(s.epochMs, 288000);
});

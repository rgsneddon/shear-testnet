import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySignals,
  emptyPolicyState,
  getpolicy,
  operationalBands,
  poolMerchantNeed,
  recordReorg,
  D_MAX_FREEZE,
  D_MAX_RISK,
  FREEZE_CLEAR_BLOCKS,
  H_RATIO_RECOVER_BLOCKS,
  REORG_WINDOW_MS,
  SIDE_LEAD_FREEZE_MS,
} from '../../crypto/confirm_policy.js';
import { PAYOUT_SWEEP_MS } from '../src/pool.js';
import { seedWatchState, stepPayoutWatch, readingFromPublished } from '../src/payout_conf_watch.js';

describe('pool payout confirmations', () => {
  it('waits 12 on a calm chain and keeps the hourly sweep', () => {
    const p = getpolicy(emptyPolicyState());
    assert.equal(p.operational.pool_merchant, 12);
    assert.equal(poolMerchantNeed(p), 12);
    assert.equal(p.freeze_banner, '');
    assert.ok(PAYOUT_SWEEP_MS >= 60 * 60 * 1000);
  });

  it('h_ratio below one half elevates to 60 and names that reason', () => {
    const s = applySignals(emptyPolicyState(), { nowMs: 1, h_ratio: 0.49, side_lead: 0 });
    const p = getpolicy(s);
    assert.equal(s.freezeReason, 'h_ratio');
    assert.equal(operationalBands(s).pool_merchant, 60);
    assert.equal(poolMerchantNeed(p), 60);
    assert.equal(p.freeze_banner, 'Credits frozen (h_ratio): confirmations elevated to 60.');
    assert.equal(p.operational.peer_small_flow, 24);
    assert.equal(p.operational.consensus_spendable, 9);
  });

  it('h_ratio stays at 60 until the shipped 20-block recovery, then returns to 12', () => {
    let s = applySignals(emptyPolicyState(), { nowMs: 1, h_ratio: 0.2, side_lead: 0 });
    assert.equal(poolMerchantNeed(getpolicy(s)), 60);
    s = applySignals(s, { nowMs: 2, h_ratio: 1, side_lead: 0 });
    assert.equal(s.hRatioLow, true);
    assert.equal(poolMerchantNeed(getpolicy(s)), 60);
    for (let i = 0; i < FREEZE_CLEAR_BLOCKS - 1; i += 1) {
      s = applySignals(s, { nowMs: 10 + i, h_ratio: 1, side_lead: 0, newBlock: true });
      assert.equal(poolMerchantNeed(getpolicy(s)), 60);
    }
    s = applySignals(s, { nowMs: 100, h_ratio: 1, side_lead: 0, newBlock: true });
    assert.equal(FREEZE_CLEAR_BLOCKS, 20);
    assert.equal(H_RATIO_RECOVER_BLOCKS, 20);
    assert.equal(s.frozen, false);
    assert.equal(s.hRatioLow, false);
    assert.equal(poolMerchantNeed(getpolicy(s)), 12);
    assert.equal(getpolicy(s).freeze_banner, '');
  });

  it('a depth-1 reorg during h_ratio recovery keeps payout at 60 until the quiet clear', () => {
    let s = applySignals(emptyPolicyState(), { nowMs: 1, h_ratio: 0.2, side_lead: 0 });
    s = applySignals(s, { nowMs: 2, h_ratio: 1, side_lead: 0 });
    for (let i = 0; i < H_RATIO_RECOVER_BLOCKS - 5; i += 1) {
      s = applySignals(s, { nowMs: 10 + i, h_ratio: 1, side_lead: 0, newBlock: true });
    }
    assert.equal(s.hRatioRecoverBlocks, 15);
    assert.equal(s.quietBlocks, 15);
    assert.equal(poolMerchantNeed(getpolicy(s)), 60);

    s = recordReorg(s, { depth: 1, atMs: 100 });
    s = applySignals(s, { nowMs: 100, h_ratio: 1, side_lead: 0 });
    assert.equal(s.d_max, 1);
    assert.equal(s.quietBlocks, 0);
    assert.equal(s.hRatioRecoverBlocks, 15);
    assert.equal(s.freezeReason, 'h_ratio');

    for (let i = 0; i < 5; i += 1) {
      s = applySignals(s, { nowMs: 200 + i, h_ratio: 1, side_lead: 0, newBlock: true });
      const p = getpolicy(s);
      assert.equal(poolMerchantNeed(p), 60);
      assert.equal(p.freeze_banner, 'Credits frozen (h_ratio): confirmations elevated to 60.');
    }
    assert.equal(s.hRatioLow, false);
    assert.equal(s.d_max, 1);
    assert.equal(s.frozen, true);
    assert.equal(getpolicy(s).operational.peer_small_flow, 12);
    assert.equal(getpolicy(s).operational.consensus_spendable, 9);

    const later = 100 + REORG_WINDOW_MS + 1;
    s = applySignals(s, { nowMs: later, h_ratio: 1, side_lead: 0 });
    assert.equal(s.d_max, 0);
    assert.equal(s.frozen, true);
    assert.equal(poolMerchantNeed(getpolicy(s)), 60);
    for (let i = 0; i < FREEZE_CLEAR_BLOCKS - 1; i += 1) {
      s = applySignals(s, { nowMs: later + 10 + i, h_ratio: 1, side_lead: 0, newBlock: true });
      assert.equal(poolMerchantNeed(getpolicy(s)), 60);
      assert.equal(getpolicy(s).freeze_banner, 'Credits frozen (h_ratio): confirmations elevated to 60.');
    }
    s = applySignals(s, { nowMs: later + 100, h_ratio: 1, side_lead: 0, newBlock: true });
    assert.equal(s.frozen, false);
    assert.equal(s.d_max, 0);
    assert.equal(poolMerchantNeed(getpolicy(s)), 12);
    assert.equal(getpolicy(s).freeze_banner, '');
  });

  it('a held side lead after h_ratio recovery stays at 60 until the quiet clear', () => {
    let s = applySignals(emptyPolicyState(), { nowMs: 1, h_ratio: 0.2, side_lead: 0 });
    assert.equal(s.freezeReason, 'h_ratio');
    const t0 = 1_000;
    for (let i = 0; i < H_RATIO_RECOVER_BLOCKS; i += 1) {
      s = applySignals(s, { nowMs: t0 + i, h_ratio: 1, side_lead: 3, newBlock: true });
    }
    assert.equal(s.hRatioLow, false);
    assert.equal(s.quietBlocks, 0);
    assert.equal(s.frozen, true);
    s = applySignals(s, { nowMs: t0 + SIDE_LEAD_FREEZE_MS + 1, h_ratio: 1, side_lead: 3 });
    assert.equal(s.freezeReason, 'side_lead');
    assert.equal(s.quietBlocks, 0);
    assert.equal(poolMerchantNeed(getpolicy(s)), 60);
    assert.equal(getpolicy(s).freeze_banner, 'Credits frozen (side_lead): confirmations elevated to 60.');
    const row = readingFromPublished(getpolicy(s), 60);
    assert.equal(row.depth, 60);
    assert.equal(row.agree, true);

    s = applySignals(s, { nowMs: t0 + SIDE_LEAD_FREEZE_MS + 2, h_ratio: 1, side_lead: 0 });
    assert.equal(s.frozen, true);
    assert.equal(poolMerchantNeed(getpolicy(s)), 60);
    for (let i = 0; i < FREEZE_CLEAR_BLOCKS - 1; i += 1) {
      s = applySignals(s, { nowMs: t0 + SIDE_LEAD_FREEZE_MS + 10 + i, h_ratio: 1, side_lead: 0, newBlock: true });
      assert.equal(poolMerchantNeed(getpolicy(s)), 60);
      assert.match(getpolicy(s).freeze_banner, /elevated to 60/);
    }
    s = applySignals(s, { nowMs: t0 + SIDE_LEAD_FREEZE_MS + 100, h_ratio: 1, side_lead: 0, newBlock: true });
    assert.equal(s.frozen, false);
    assert.equal(poolMerchantNeed(getpolicy(s)), 12);
    assert.equal(getpolicy(s).freeze_banner, '');
  });

  it('a depth-10 reorg on the h_ratio recovery block stays at 60 until the quiet clear', () => {
    let s = applySignals(emptyPolicyState(), { nowMs: 1, h_ratio: 0.2, side_lead: 0 });
    s = applySignals(s, { nowMs: 2, h_ratio: 1, side_lead: 0 });
    for (let i = 0; i < H_RATIO_RECOVER_BLOCKS - 1; i += 1) {
      s = applySignals(s, { nowMs: 10 + i, h_ratio: 1, side_lead: 0, newBlock: true });
    }
    assert.equal(s.hRatioRecoverBlocks, 19);
    assert.equal(s.hRatioLow, true);
    const at = 10_000;
    s = recordReorg(s, { depth: D_MAX_FREEZE, atMs: at });
    s = applySignals(s, { nowMs: at, h_ratio: 1, side_lead: 0, newBlock: true });
    assert.equal(s.hRatioLow, false);
    assert.equal(s.d_max, D_MAX_FREEZE);
    assert.equal(s.freezeReason, 'd_max');
    assert.equal(s.quietBlocks, 0);
    assert.equal(poolMerchantNeed(getpolicy(s)), 60);
    assert.equal(getpolicy(s).freeze_banner, 'Credits frozen (d_max): confirmations elevated to 60.');

    const later = at + REORG_WINDOW_MS + 1;
    s = applySignals(s, { nowMs: later, h_ratio: 1, side_lead: 0 });
    assert.equal(s.d_max, 0);
    assert.equal(s.frozen, true);
    assert.equal(poolMerchantNeed(getpolicy(s)), 60);
    for (let i = 0; i < FREEZE_CLEAR_BLOCKS - 1; i += 1) {
      s = applySignals(s, { nowMs: later + 10 + i, h_ratio: 1, side_lead: 0, newBlock: true });
      assert.equal(poolMerchantNeed(getpolicy(s)), 60);
      assert.match(getpolicy(s).freeze_banner, /elevated to 60/);
    }
    s = applySignals(s, { nowMs: later + 100, h_ratio: 1, side_lead: 0, newBlock: true });
    assert.equal(s.frozen, false);
    assert.equal(s.d_max, 0);
    assert.equal(poolMerchantNeed(getpolicy(s)), 12);
    assert.equal(getpolicy(s).freeze_banner, '');
  });

  it('a deep reorg or a held side lead does not by itself jump the payout depth to 60', () => {
    let reorg = recordReorg(emptyPolicyState(), { depth: D_MAX_FREEZE, atMs: 5 });
    reorg = applySignals(reorg, { nowMs: 5, h_ratio: 1, side_lead: 0 });
    assert.equal(reorg.freezeReason, 'd_max');
    assert.equal(operationalBands(reorg).pool_merchant, 30);
    assert.notEqual(poolMerchantNeed(getpolicy(reorg)), 60);
    assert.match(getpolicy(reorg).freeze_banner, /d_max/);
    assert.doesNotMatch(getpolicy(reorg).freeze_banner, /elevated to 60/);

    const risk = applySignals(
      recordReorg(emptyPolicyState(), { depth: D_MAX_RISK, atMs: 1 }),
      { nowMs: 1, h_ratio: 1, side_lead: 0 },
    );
    assert.equal(risk.frozen, false);
    assert.equal(operationalBands(risk).pool_merchant, 30);

    let side = applySignals(emptyPolicyState(), { nowMs: 0, h_ratio: 1, side_lead: 4 });
    side = applySignals(side, { nowMs: SIDE_LEAD_FREEZE_MS + 1, h_ratio: 1, side_lead: 4 });
    assert.equal(side.freezeReason, 'side_lead');
    assert.equal(operationalBands(side).pool_merchant, 12);
    assert.notEqual(poolMerchantNeed(getpolicy(side)), 60);
  });

  it('the watcher step uses the same depth as the policy, including a still-low ratio', () => {
    const calm = stepPayoutWatch(emptyPolicyState(), { nowMs: 1, h_ratio: 1, side_lead: 0 });
    assert.equal(calm.depth, 12);
    assert.equal(calm.freeze_banner, '');
    const low = stepPayoutWatch(emptyPolicyState(), { nowMs: 1, h_ratio: 0.39, side_lead: 0 });
    assert.equal(low.depth, 60);
    assert.equal(low.freeze_banner, 'Credits frozen (h_ratio): confirmations elevated to 60.');
    const seeded = seedWatchState({
      h_ratio: 1,
      d_max: 0,
      side_lead: 0,
      frozen: true,
      freeze_reason: 'h_ratio',
      quiet_blocks: 4,
      h_ratio_low: true,
    });
    const held = stepPayoutWatch(seeded, { nowMs: 2, h_ratio: 1, side_lead: 0, newBlock: false });
    assert.equal(held.depth, 60);
    const row = readingFromPublished({
      h_ratio: 0.4,
      d_max: 0,
      side_lead: 0,
      frozen: true,
      freeze_reason: 'h_ratio',
    }, 60);
    assert.equal(row.depth, 60);
    assert.equal(row.agree, true);
    assert.equal(row.freeze_reason, 'h_ratio');
  });
});

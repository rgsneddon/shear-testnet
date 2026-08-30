import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { consensusFingerprint, SPENDABLE_CONFIRMATIONS, MIN_CONFIRMS_POLICY } from './asert.js';
import {
  POLICY_BANDS,
  CONSENSUS_MIN,
  emptyPolicyState,
  recordReorg,
  applySignals,
  getpolicy,
  operationalBands,
  hashRatioFromHours,
  D_MAX_FREEZE,
  FREEZE_CLEAR_BLOCKS,
} from './confirm_policy.js';

describe('confirm policy is not consensus', () => {
  it('keeps 6 in the fingerprint and 30 / 12 out of it', () => {
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
    assert.equal(MIN_CONFIRMS_POLICY, 12);
    assert.equal(CONSENSUS_MIN, 6);
    assert.equal(POLICY_BANDS.pool_merchant, 30);
    assert.equal(POLICY_BANDS.join_mark_paid, 200);
    const fp = consensusFingerprint();
    assert.match(fp, /:6:1:HASH_FN=ShearHash-v2/);
    assert.equal(fp.includes(':12:'), false);
    assert.equal(fp.includes(':30:'), false);
    assert.equal(fp.includes(':200:'), false);
  });
});

describe('getpolicy object', () => {
  it('returns consensus_min 6, merchant_default 12, bands, frozen, d_max, h_ratio', () => {
    const p = getpolicy(emptyPolicyState());
    assert.equal(p.consensus_min, 6);
    assert.equal(p.merchant_default, 12);
    assert.equal(p.bands.ui_seen, 1);
    assert.equal(p.bands.consensus_spendable, 6);
    assert.equal(p.bands.peer_small_flow, 12);
    assert.equal(p.bands.pool_merchant, 30);
    assert.equal(p.bands.otc_large, 120);
    assert.equal(p.bands.join_mark_paid, 200);
    assert.equal(p.frozen, false);
    assert.equal(p.d_max, 0);
    assert.equal(p.h_ratio, 1);
    assert.equal(p.operational.pool_merchant, 30);
    assert.equal(p.operational.consensus_spendable, 6);
  });
});

describe('dynamic raise and freeze', () => {
  it('d_max >= 3 raises operational N to at least 30 and paints reorg risk; 6 does not move', () => {
    let s = recordReorg(emptyPolicyState(), { depth: 4, atMs: 1_000 });
    s = applySignals(s, { nowMs: 1_000, h_ratio: 1, side_lead: 0 });
    assert.equal(s.d_max, 4);
    assert.equal(s.reorg_risk, true);
    assert.equal(s.frozen, false);
    const op = operationalBands(s);
    assert.equal(op.pool_merchant, 30);
    assert.equal(op.peer_small_flow, 30);
    assert.equal(op.consensus_spendable, 6);
    assert.equal(op.ui_seen, 1);
  });

  it('d_max >= 10 freezes credits', () => {
    let s = recordReorg(emptyPolicyState(), { depth: D_MAX_FREEZE, atMs: 5_000 });
    s = applySignals(s, { nowMs: 5_000, h_ratio: 1, side_lead: 0 });
    assert.equal(s.frozen, true);
    assert.equal(s.freezeReason, 'd_max');
    assert.equal(getpolicy(s).frozen, true);
  });

  it('side_lead > 0 for more than 2 block times freezes', () => {
    let s = applySignals(emptyPolicyState(), { nowMs: 0, h_ratio: 1, side_lead: 10 });
    assert.equal(s.frozen, false);
    s = applySignals(s, { nowMs: 180_000, h_ratio: 1, side_lead: 10 });
    assert.equal(s.frozen, false);
    s = applySignals(s, { nowMs: 180_001, h_ratio: 1, side_lead: 10 });
    assert.equal(s.frozen, true);
    assert.equal(s.freezeReason, 'side_lead');
  });

  it('h_ratio < 0.5 doubles policy N and freezes; 6 stays 6', () => {
    let s = applySignals(emptyPolicyState(), { nowMs: 1, h_ratio: 0.4, side_lead: 0 });
    assert.equal(s.frozen, true);
    assert.equal(s.freezeReason, 'h_ratio');
    const op = operationalBands(s);
    assert.equal(op.pool_merchant, 60);
    assert.equal(op.join_mark_paid, 400);
    assert.equal(op.consensus_spendable, 6);
  });

  it('freeze clears after 20 consecutive quiet blocks with d_max 0 and side_lead <= 0', () => {
    let s = recordReorg(emptyPolicyState(), { depth: 12, atMs: 1 });
    s = applySignals(s, { nowMs: 1, h_ratio: 1, side_lead: 0 });
    assert.equal(s.frozen, true);
    const later = 7 * 3_600_000;
    s = applySignals(s, { nowMs: later, h_ratio: 1, side_lead: 0 });
    assert.equal(s.d_max, 0);
    for (let i = 0; i < FREEZE_CLEAR_BLOCKS; i += 1) {
      s = applySignals(s, { nowMs: later + i, h_ratio: 1, side_lead: 0, newBlock: true });
    }
    assert.equal(s.frozen, false);
    assert.equal(getpolicy(s).frozen, false);
  });

  it('4-block side branch does not meet pool_merchant 30', () => {
    const need = operationalBands(emptyPolicyState()).pool_merchant;
    assert.equal(need, 30);
    assert.equal(4 >= need, false);
  });
});

describe('h_ratio from hourly work', () => {
  it('returns 1 on thin data', () => {
    assert.equal(hashRatioFromHours([]), 1);
    assert.equal(hashRatioFromHours([9]), 1);
  });

  it('is last hour over the median of prior hours', () => {
    const hrs = [10, 10, 10, 10, 5];
    assert.equal(hashRatioFromHours(hrs), 0.5);
  });
});

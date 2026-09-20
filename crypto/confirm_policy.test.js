import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { consensusFingerprint, SPENDABLE_CONFIRMATIONS, MIN_CONFIRMS_POLICY, TARGET_BLOCK_INTERVAL_MS } from './asert.js';
import {
  POLICY_BANDS,
  CONSENSUS_MIN,
  emptyPolicyState,
  recordReorg,
  applySignals,
  getpolicy,
  operationalBands,
  hashRatioFromHours,
  hourlyWorkBuckets,
  freezeBannerLine,
  D_MAX_FREEZE,
  FREEZE_CLEAR_BLOCKS,
  H_RATIO_FREEZE,
  SIDE_LEAD_FREEZE_MS,
  HOURLY_BUCKETS,
  HOUR_MS,
} from './confirm_policy.js';

describe('confirm policy is not consensus', () => {
  it('keeps 6 in the fingerprint and 30 / 12 out of it', () => {
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
    assert.equal(MIN_CONFIRMS_POLICY, 12);
    assert.equal(CONSENSUS_MIN, 6);
    assert.equal(POLICY_BANDS.pool_merchant, 30);
    assert.equal(POLICY_BANDS.join_mark_paid, undefined);
    const fp = consensusFingerprint();
    assert.match(fp, /:6:1:1000:/);
    assert.match(fp, /HASH_FN=ShearHash-v3/);
    assert.match(fp, /:4:12:1:/); // LIVE_MIN_BITS, GENESIS_BITS — policy 12 is not this pin
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
    assert.equal(p.bands.join_mark_paid, undefined);
    assert.equal(p.frozen, false);
    assert.equal(p.d_max, 0);
    assert.equal(p.h_ratio, 1);
    assert.equal(p.freeze_reason, '');
    assert.equal(p.freeze_banner, '');
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
    assert.equal(op.join_mark_paid, undefined);
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

function hourBlocks(nowMs, hoursAgo, work, n = 40) {
  const startAgo = hoursAgo * HOUR_MS;
  const blocks = [];
  for (let i = 0; i < n; i += 1) {
    const ago = startAgo + HOUR_MS - 1 - i * TARGET_BLOCK_INTERVAL_MS;
    blocks.push({ timestamp: nowMs - ago, work });
  }
  return blocks;
}

function policyFromHeaders(blocks, nowMs, extra = {}) {
  const hrs = hourlyWorkBuckets(blocks, nowMs);
  const h_ratio = hashRatioFromHours(hrs);
  return applySignals(emptyPolicyState(), {
    nowMs,
    h_ratio,
    side_lead: extra.side_lead ?? 0,
    newBlock: extra.newBlock ?? false,
  });
}

describe('intended freeze policy from header work', () => {
  const nowMs = 20 * HOUR_MS;

  it('healthy multi-miner / steady hourly work stays unfrozen at baseline 30', () => {
    const blocks = [
      ...hourBlocks(nowMs, 3, 100),
      ...hourBlocks(nowMs, 2, 100),
      ...hourBlocks(nowMs, 1, 100),
      ...hourBlocks(nowMs, 0, 100),
    ];
    const hrs = hourlyWorkBuckets(blocks, nowMs);
    assert.equal(hrs.length, HOURLY_BUCKETS);
    const ratio = hashRatioFromHours(hrs);
    assert.ok(ratio >= H_RATIO_FREEZE, `steady h_ratio ${ratio}`);
    assert.ok(Math.abs(ratio - 1) < 0.05, `steady h_ratio near 1, got ${ratio}`);
    const s = applySignals(emptyPolicyState(), { nowMs, h_ratio: ratio, side_lead: 0 });
    assert.equal(s.frozen, false);
    assert.equal(s.freezeReason, '');
    assert.equal(s.reorg_risk, false);
    const p = getpolicy(s);
    assert.equal(p.frozen, false);
    assert.equal(p.operational.pool_merchant, 30);
    assert.equal(p.operational.consensus_spendable, 6);
    assert.equal(p.freeze_banner, '');
    assert.equal(CONSENSUS_MIN, 6);
  });

  it('steady single miner at 90s with h_ratio≈1 stays unfrozen', () => {
    const blocks = [
      ...hourBlocks(nowMs, 2, 12),
      ...hourBlocks(nowMs, 1, 12),
      ...hourBlocks(nowMs, 0, 12),
    ];
    const s = policyFromHeaders(blocks, nowMs);
    const ratio = hashRatioFromHours(hourlyWorkBuckets(blocks, nowMs));
    assert.ok(ratio >= H_RATIO_FREEZE, `single-miner h_ratio ${ratio}`);
    assert.equal(s.frozen, false);
    assert.equal(operationalBands(s).pool_merchant, 30);
    assert.equal(operationalBands(s).consensus_spendable, 6);
  });

  it('farm-then-drop to ~0.39 freezes on h_ratio even when 90s tip advances and reorg_risk=false', () => {
    const blocks = [
      ...hourBlocks(nowMs, 3, 100),
      ...hourBlocks(nowMs, 2, 100),
      ...hourBlocks(nowMs, 1, 100),
      ...hourBlocks(nowMs, 0, 39),
    ];
    const hrs = hourlyWorkBuckets(blocks, nowMs);
    const ratio = hashRatioFromHours(hrs);
    assert.ok(ratio < H_RATIO_FREEZE, `drop h_ratio ${ratio}`);
    assert.ok(Math.abs(ratio - 0.39) < 0.02, `expected ~0.39, got ${ratio}`);
    const s = applySignals(emptyPolicyState(), { nowMs, h_ratio: ratio, side_lead: 0 });
    assert.equal(s.reorg_risk, false);
    assert.equal(s.d_max, 0);
    assert.equal(s.frozen, true);
    assert.equal(s.freezeReason, 'h_ratio');
    const p = getpolicy(s);
    assert.equal(p.frozen, true);
    assert.equal(p.freeze_reason, 'h_ratio');
    assert.equal(p.operational.pool_merchant, 60);
    assert.equal(p.operational.peer_small_flow, 24);
    assert.equal(p.operational.consensus_spendable, 6);
    assert.equal(p.bands.pool_merchant, 30);
    assert.match(p.freeze_banner, /h_ratio/);
    assert.match(p.freeze_banner, /60/);
    assert.equal(
      p.freeze_banner,
      'Credits frozen (h_ratio): confirmations elevated to 60.',
    );
  });

  it('24-bucket zero-pad does not freeze on an empty or single populated hour', () => {
    assert.equal(hashRatioFromHours(hourlyWorkBuckets([], nowMs)), 1);
    const young = hourBlocks(nowMs, 0, 100);
    const hrs = hourlyWorkBuckets(young, nowMs);
    assert.equal(hrs.length, HOURLY_BUCKETS);
    assert.equal(hrs.filter((n) => n > 0).length, 1);
    assert.equal(hashRatioFromHours(hrs), 1);
    const s = policyFromHeaders(young, nowMs);
    assert.equal(s.frozen, false);
    assert.equal(operationalBands(s).pool_merchant, 30);
  });

  it('d_max >= 10 still freezes fail-closed', () => {
    let s = recordReorg(emptyPolicyState(), { depth: D_MAX_FREEZE, atMs: nowMs });
    s = applySignals(s, { nowMs, h_ratio: 1, side_lead: 0 });
    assert.equal(s.frozen, true);
    assert.equal(s.freezeReason, 'd_max');
    assert.equal(getpolicy(s).operational.consensus_spendable, 6);
  });

  it('side_lead > 0 held longer than 2 block times still freezes fail-closed', () => {
    assert.equal(SIDE_LEAD_FREEZE_MS, 2 * TARGET_BLOCK_INTERVAL_MS);
    let s = applySignals(emptyPolicyState(), { nowMs: 0, h_ratio: 1, side_lead: 10 });
    assert.equal(s.frozen, false);
    s = applySignals(s, { nowMs: SIDE_LEAD_FREEZE_MS, h_ratio: 1, side_lead: 10 });
    assert.equal(s.frozen, false);
    s = applySignals(s, { nowMs: SIDE_LEAD_FREEZE_MS + 1, h_ratio: 1, side_lead: 10 });
    assert.equal(s.frozen, true);
    assert.equal(s.freezeReason, 'side_lead');
  });

  it('negative side_lead (active tip ahead) does not freeze', () => {
    const s = applySignals(emptyPolicyState(), {
      nowMs: SIDE_LEAD_FREEZE_MS + 1,
      h_ratio: 1,
      side_lead: -37_808_167,
    });
    assert.equal(s.frozen, false);
    assert.equal(s.side_lead, -37_808_167);
  });
});

describe('freeze banner line', () => {
  it('is empty when unfrozen and names the reason plus elevated confirms when frozen', () => {
    assert.equal(freezeBannerLine({ frozen: false, freeze_reason: 'h_ratio' }), '');
    assert.equal(
      freezeBannerLine({
        frozen: true,
        freeze_reason: 'h_ratio',
        operational: { pool_merchant: 60 },
      }),
      'Credits frozen (h_ratio): confirmations elevated to 60.',
    );
    const src = fs.readFileSync(new URL('../node/src/store.js', import.meta.url), 'utf8');
    assert.match(src, /hourlyWorkBuckets/);
    assert.match(src, /hashRatioFromHours\(hourlyWork\(/);
    assert.doesNotMatch(src, /Array\(24\)\.fill\(0\)/);
  });
});

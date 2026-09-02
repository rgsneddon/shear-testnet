/**
 * Confirm policy. Not consensus. Not in consensusFingerprint().
 * 6-conf floor never moves. Freeze is policy.
 */
import { SPENDABLE_CONFIRMATIONS, MIN_CONFIRMS_POLICY, TARGET_BLOCK_INTERVAL_MS } from './asert.js';

export const CONSENSUS_MIN = SPENDABLE_CONFIRMATIONS;
export const MERCHANT_DEFAULT = MIN_CONFIRMS_POLICY;
export const POLICY_BANDS = Object.freeze({
  ui_seen: 1,
  consensus_spendable: CONSENSUS_MIN,
  peer_small_flow: MERCHANT_DEFAULT,
  pool_merchant: 30,
  otc_large: 120,
});

export const REORG_WINDOW_MS = 6 * 3_600_000;
export const SIDE_LEAD_FREEZE_MS = 2 * TARGET_BLOCK_INTERVAL_MS;
export const FREEZE_CLEAR_BLOCKS = 20;
export const H_RATIO_RECOVER_BLOCKS = 20;
export const D_MAX_RISK = 3;
export const D_MAX_FREEZE = 10;
export const H_RATIO_FREEZE = 0.5;

const FLOOR_BANDS = new Set(['ui_seen', 'consensus_spendable']);

export function emptyPolicyState() {
  return {
    reorgLog: [],
    d_max: 0,
    h_ratio: 1,
    side_lead: 0,
    sideLeadSinceMs: null,
    frozen: false,
    freezeReason: '',
    quietBlocks: 0,
    hRatioLow: false,
    hRatioRecoverBlocks: 0,
    reorg_risk: false,
  };
}

export function recomputeWindow(state, nowMs) {
  const cutoff = Number(nowMs) - REORG_WINDOW_MS;
  const log = (state.reorgLog || []).filter((r) => Number(r.atMs) >= cutoff);
  const d_max = log.reduce((m, r) => Math.max(m, Number(r.depth) || 0), 0);
  return { ...state, reorgLog: log, d_max };
}

export function recordReorg(state, { depth, atMs }) {
  const log = [...(state.reorgLog || []), { depth: Math.max(0, Number(depth) || 0), atMs: Number(atMs) || 0 }];
  return recomputeWindow({ ...state, reorgLog: log, quietBlocks: 0 }, atMs);
}

function freezeReasonOf(s, sideLeadHeld) {
  if (s.d_max >= D_MAX_FREEZE) return 'd_max';
  if (sideLeadHeld) return 'side_lead';
  if (s.h_ratio < H_RATIO_FREEZE) return 'h_ratio';
  return s.freezeReason || '';
}

export function applySignals(state, {
  nowMs = Date.now(),
  h_ratio,
  side_lead,
  newBlock = false,
} = {}) {
  let s = recomputeWindow({ ...state, reorgLog: [...(state.reorgLog || [])] }, nowMs);
  if (Number.isFinite(Number(h_ratio)) && Number(h_ratio) > 0) s.h_ratio = Number(h_ratio);
  else if (h_ratio === 0) s.h_ratio = 0;
  s.side_lead = Number(side_lead) || 0;

  if (s.side_lead > 0) {
    if (s.sideLeadSinceMs == null) s.sideLeadSinceMs = nowMs;
  } else {
    s.sideLeadSinceMs = null;
  }
  const sideLeadHeld = s.side_lead > 0
    && s.sideLeadSinceMs != null
    && (nowMs - s.sideLeadSinceMs) > SIDE_LEAD_FREEZE_MS;

  s.reorg_risk = s.d_max >= D_MAX_RISK;

  if (s.h_ratio < H_RATIO_FREEZE) {
    s.hRatioLow = true;
    s.hRatioRecoverBlocks = 0;
  } else if (s.hRatioLow && newBlock) {
    s.hRatioRecoverBlocks += 1;
    if (s.hRatioRecoverBlocks >= H_RATIO_RECOVER_BLOCKS) {
      s.hRatioLow = false;
      s.hRatioRecoverBlocks = 0;
    }
  }

  const wantFreeze = s.d_max >= D_MAX_FREEZE || sideLeadHeld || s.h_ratio < H_RATIO_FREEZE;
  if (wantFreeze) {
    s.frozen = true;
    s.freezeReason = freezeReasonOf(s, sideLeadHeld);
    s.quietBlocks = 0;
  } else if (s.frozen && newBlock) {
    if (s.d_max === 0 && s.side_lead <= 0) {
      s.quietBlocks += 1;
      if (s.quietBlocks >= FREEZE_CLEAR_BLOCKS) {
        s.frozen = false;
        s.freezeReason = '';
        s.quietBlocks = 0;
      }
    } else {
      s.quietBlocks = 0;
    }
  } else if (!s.frozen && newBlock && s.d_max === 0 && s.side_lead <= 0) {
    s.quietBlocks += 1;
  }

  return s;
}

export function operationalBands(state) {
  const raise = !!(state?.reorg_risk || (state?.d_max || 0) >= D_MAX_RISK);
  const twice = !!(state?.hRatioLow || (state?.h_ratio ?? 1) < H_RATIO_FREEZE);
  const out = {};
  for (const [k, v] of Object.entries(POLICY_BANDS)) {
    if (FLOOR_BANDS.has(k)) {
      out[k] = v;
      continue;
    }
    let n = v;
    if (raise) n = Math.max(n, 30);
    if (twice) n *= 2;
    out[k] = n;
  }
  return out;
}

export function bandNeed(name, state) {
  const op = operationalBands(state || emptyPolicyState());
  if (name in op) return op[name];
  return CONSENSUS_MIN;
}

/** Coinbase / hash-bonus maturity: never shallower than 6. */
export function coinbaseNeed(deskNeed, state) {
  const desk = Math.max(CONSENSUS_MIN, Math.floor(Number(deskNeed) || CONSENSUS_MIN));
  const op = bandNeed('pool_merchant', state);
  return Math.max(CONSENSUS_MIN, desk, state?.frozen ? op : desk);
}

export function getpolicy(state) {
  const s = state || emptyPolicyState();
  const operational = operationalBands(s);
  return {
    consensus_min: CONSENSUS_MIN,
    merchant_default: MERCHANT_DEFAULT,
    bands: { ...POLICY_BANDS },
    frozen: !!s.frozen,
    freeze_reason: s.freezeReason || '',
    d_max: s.d_max || 0,
    h_ratio: Number.isFinite(Number(s.h_ratio)) ? Number(s.h_ratio) : 1,
    side_lead: s.side_lead || 0,
    reorg_risk: !!s.reorg_risk,
    quiet_blocks: s.quietBlocks || 0,
    operational,
  };
}

/**
 * Work in [now - window, now] over sealed headers.
 * Thin window (no blocks) → 0.
 */
export function workInWindow(blocks, nowMs, windowMs, workOf) {
  const list = Array.isArray(blocks) ? blocks : [];
  const start = Number(nowMs) - Number(windowMs);
  let sum = 0;
  for (const b of list) {
    const ts = Number(typeof workOf === 'function' && workOf.length > 1 ? 0 : 0);
    void ts;
    const at = Number(b?.atMs ?? b?.timestamp ?? 0);
    if (at >= start && at <= nowMs) sum += Number(typeof workOf === 'function' ? workOf(b) : (b.work || 0));
  }
  return sum;
}

/** 1h work / median of 24 hourly buckets. Empty → 1 (do not freeze on thin data). */
export function hashRatioFromHours(hourlyWork) {
  const hrs = Array.isArray(hourlyWork) ? hourlyWork.map((n) => Number(n) || 0) : [];
  if (hrs.length < 2) return 1;
  const last = hrs[hrs.length - 1];
  const prior = hrs.slice(0, -1).filter((n) => n > 0);
  if (!prior.length || !(last >= 0)) return 1;
  const sorted = prior.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  if (!(med > 0)) return 1;
  return last / med;
}

export function medianHourlyWork(hourlyWork) {
  const hrs = (hourlyWork || []).map((n) => Number(n) || 0).filter((n) => n > 0);
  if (!hrs.length) return 0;
  const sorted = hrs.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

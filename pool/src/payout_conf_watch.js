/**
 * Watch live pool policy and report the payout confirmation depth.
 * The depth comes from confirm_policy.js. This file does not keep a second clear rule.
 */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applySignals,
  emptyPolicyState,
  getpolicy,
  poolMerchantNeed,
} from '../../crypto/confirm_policy.js';
import { HTTP_BODY_MAX, parseBoundedJson } from '../../crypto/json_bounds.js';

export function seedWatchState(published = {}) {
  const s = emptyPolicyState();
  const h = Number(published.h_ratio);
  s.h_ratio = Number.isFinite(h) ? h : 1;
  s.d_max = Math.max(0, Number(published.d_max) || 0);
  s.side_lead = Number(published.side_lead) || 0;
  s.reorg_risk = !!published.reorg_risk || s.d_max >= 3;
  s.frozen = !!published.frozen;
  s.freezeReason = String(published.freeze_reason || published.freezeReason || '');
  s.quietBlocks = Math.max(0, Math.floor(Number(published.quiet_blocks ?? published.quietBlocks) || 0));
  s.hRatioRecoverBlocks = 0;
  s.hRatioLow = false;
  s.hRatioPayoutHeld = false;
  if (s.freezeReason === 'h_ratio') {
    s.frozen = false;
    s.freezeReason = '';
    s.quietBlocks = 0;
  }
  return s;
}

/** One step of the shipped state machine. Pass newBlock only when the tip advanced. */
export function stepPayoutWatch(prev, signals = {}) {
  const next = applySignals(prev || emptyPolicyState(), signals);
  const policy = getpolicy(next);
  return {
    state: next,
    depth: poolMerchantNeed(policy),
    frozen: policy.frozen,
    freeze_reason: policy.freeze_reason,
    freeze_banner: policy.freeze_banner,
    h_ratio: policy.h_ratio,
    d_max: policy.d_max,
    side_lead: policy.side_lead,
    quiet_blocks: policy.quiet_blocks,
    h_ratio_low: !!next.hRatioLow,
  };
}

export function readingFromPublished(published = {}, poolConfirmedNeed) {
  const seeded = stepPayoutWatch(seedWatchState(published), {
    nowMs: Date.now(),
    h_ratio: published.h_ratio,
    side_lead: published.side_lead,
    newBlock: false,
  });
  const live = Number(poolConfirmedNeed);
  return {
    at: new Date().toISOString(),
    depth: seeded.depth,
    pool_confirmed_need: Number.isFinite(live) ? live : null,
    agree: Number.isFinite(live) ? seeded.depth === live : null,
    frozen: seeded.frozen,
    freeze_reason: seeded.freeze_reason,
    freeze_banner: seeded.freeze_banner,
    h_ratio: seeded.h_ratio,
    d_max: seeded.d_max,
    side_lead: seeded.side_lead,
    quiet_blocks: seeded.quiet_blocks,
    h_ratio_low: seeded.h_ratio_low,
  };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      let got = 0;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      res.on('data', (c) => {
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
        got += buf.length;
        if (got > HTTP_BODY_MAX) {
          const err = new Error('body_cap');
          err.code = 'body_cap';
          try { res.destroy(); } catch { /* ignore */ }
          finish(reject, err);
          return;
        }
        chunks.push(buf);
      });
      res.on('end', () => {
        try { finish(resolve, parseBoundedJson(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (e) { finish(reject, e); }
      });
    });
    req.on('error', (err) => reject(err));
  });
}

export async function watchOnce(statsUrl = process.env.SHEAR_WATCH_STATS || 'http://127.0.0.1:8088/api/stats') {
  const stats = await getJson(statsUrl);
  const policy = stats.policy || {};
  return readingFromPublished(policy, stats.confirmedNeed);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  watchOnce().then((row) => {
    console.log(JSON.stringify(row));
    if (row.agree === false) process.exit(2);
  }).catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
    process.exit(1);
  });
}

/**
 * Off-chain pool pot credits. 0.99 of each found pot sits on the pool dest;
 * hashers pull confirmed nanos to ssa1. she1 never stored in the book.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BLOCK_SUBSIDY_NANOS, POOL_FEE_BPS, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { isSpendableHeight } from '../../crypto/chronoflux.js';

export const PULL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function potCreditNanos() {
  const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
  return BLOCK_SUBSIDY_NANOS - fee;
}

export function createPullBook(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'pull-book.json');
  const destByTag = new Map();
  let state = { credits: [], pulled: [], lastPullMs: {} };
  let loaded = false;
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = {
        credits: Array.isArray(raw?.credits) ? raw.credits.map((c) => ({
          tag: c.tag,
          nanos: c.nanos,
          height: c.height,
          ms: c.ms,
        })) : [],
        pulled: Array.isArray(raw?.pulled) ? raw.pulled.map((p) => ({
          tag: p.tag,
          nanos: p.nanos,
          height: p.height,
          ms: p.ms,
        })) : [],
        lastPullMs: raw?.lastPullMs && typeof raw.lastPullMs === 'object' ? raw.lastPullMs : {},
      };
      loaded = true;
    } catch {
      state = { credits: [], pulled: [], lastPullMs: {} };
    }
  }

  function save() {
    const disk = {
      credits: state.credits.map((c) => ({
        tag: c.tag,
        nanos: c.nanos,
        height: c.height,
        ms: c.ms,
      })),
      pulled: state.pulled.map((p) => ({
        tag: p.tag,
        nanos: p.nanos,
        height: p.height,
        ms: p.ms,
      })),
      lastPullMs: state.lastPullMs,
    };
    fs.writeFileSync(file, `${JSON.stringify(disk)}\n`, { mode: 0o600 });
  }

  function creditRound(rows, { height, nanos = potCreditNanos(), now = Date.now() } = {}) {
    const list = (rows || []).filter((r) => r && r.tag && r.dest && (Number(r.count) || 0) > 0);
    const total = list.reduce((a, r) => a + (Number(r.count) || 0), 0);
    const pot = Math.max(0, Math.floor(Number(nanos) || 0));
    if (!total || !pot || !(height >= 1)) return { ok: false, reason: 'empty' };
    let left = pot;
    for (let i = 0; i < list.length; i += 1) {
      const share = i === list.length - 1
        ? left
        : Math.floor(pot * (Number(list[i].count) || 0) / total);
      left -= share;
      if (share <= 0) continue;
      const tag = String(list[i].tag).toLowerCase();
      destByTag.set(tag, list[i].dest);
      state.credits.push({
        tag,
        nanos: share,
        height,
        ms: now,
      });
    }
    save();
    return { ok: true };
  }

  function view(tag, { tipHeight = 0, need = SPENDABLE_CONFIRMATIONS } = {}) {
    const key = String(tag || '').trim().toLowerCase();
    let confirmed = 0;
    let unconfirmed = 0;
    for (const c of state.credits) {
      if (c.tag !== key) continue;
      const n = Math.floor(Number(c.nanos) || 0);
      if (isSpendableHeight(c.height, tipHeight, need)) confirmed += n;
      else unconfirmed += n;
    }
    let pulled = 0;
    for (const p of state.pulled) {
      if (p.tag !== key) continue;
      pulled += Math.floor(Number(p.nanos) || 0);
    }
    let conf = confirmed - pulled;
    if (conf < 0) {
      unconfirmed = Math.max(0, unconfirmed + conf);
      conf = 0;
    }
    const lastPullMs = Number(state.lastPullMs[key] || 0);
    return {
      pendingNanos: conf + unconfirmed,
      confirmedNanos: conf,
      unconfirmedNanos: unconfirmed,
      lastPullMs,
      nextPullMs: lastPullMs ? lastPullMs + PULL_COOLDOWN_MS : 0,
    };
  }

  function takeConfirmed(tag, { tipHeight = 0, need = SPENDABLE_CONFIRMATIONS, now = Date.now(), amountNanos = null } = {}) {
    const key = String(tag || '').trim().toLowerCase();
    const v = view(key, { tipHeight, need });
    if (v.lastPullMs && now < v.nextPullMs) {
      return { ok: false, reason: 'cooldown', nextPullMs: v.nextPullMs };
    }
    if (!(v.confirmedNanos > 0)) return { ok: false, reason: 'none_confirmed' };
    const want = amountNanos == null
      ? v.confirmedNanos
      : Math.floor(Number(amountNanos) || 0);
    if (!(want > 0)) return { ok: false, reason: 'none_confirmed' };
    if (want > v.confirmedNanos) return { ok: false, reason: 'over_unpaid' };
    state.pulled.push({ tag: key, nanos: want, height: tipHeight, ms: now });
    state.lastPullMs[key] = now;
    save();
    return { ok: true, nanos: want, dest: destOf(key) };
  }

  function destOf(tag) {
    const key = String(tag || '').trim().toLowerCase();
    return destByTag.get(key) || '';
  }

  if (loaded) save();
  return { creditRound, view, takeConfirmed, destOf };
}

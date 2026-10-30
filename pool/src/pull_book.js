/**
 * The miner pull book. It credits nothing on any book: miners are paid from
 * the coinbase (R14a), so no pot share or hash bonus is held here and no
 * payout is ever due. What remains is the empty ledger the miner pages read
 * (tags, dests, found counts) and the finder record. she1 never stored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BLOCK_SUBSIDY_NANOS, POOL_FEE_BPS, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { hash20FromAddress, encodeDest } from '../../crypto/address.js';
import { payeeFs1Ok } from '../../crypto/n1.js';
import { asU8 } from '../../crypto/note.js';
import {
  AUTO_PAYOUT_MIN_NANOS,
  isMinerSsa1,
  potCreditAfterFeeNanos,
  redactSsa1,
} from './auto_payout.js';

/** No pull is ever due; the miner pages still read the cooldown field. */
export const PULL_COOLDOWN_MS = 0;
export { AUTO_PAYOUT_MIN_NANOS, redactSsa1 };

export function potCreditNanos(potNanos = BLOCK_SUBSIDY_NANOS) {
  return potCreditAfterFeeNanos(potNanos);
}

/** 1% (this pool) of the gross pot share implied by a net pot credit. Hash bonus is not fee'd. */
export function attributedPoolFeeNanos(potShareNanos) {
  const net = Math.max(0, Math.floor(Number(potShareNanos) || 0));
  if (!net) return 0;
  const restBps = 10000 - POOL_FEE_BPS;
  if (restBps <= 0) return 0;
  const gross = Math.floor((net * 10000) / restBps);
  return Math.max(0, gross - net);
}

function dest20Hex(dest) {
  try {
    const h = hash20FromAddress(dest);
    return h ? Buffer.from(h).toString('hex') : '';
  } catch {
    return '';
  }
}

function destFrom20(hex) {
  try {
    const b = Buffer.from(asU8(hex));
    if (b.length === 20) return encodeDest(b);
  } catch { /* ignore */ }
  return '';
}

export function createPullBook(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'pull-book.json');
  const destByTag = new Map();
  let state = { credits: [], pulled: [], lastPullMs: {}, found: {}, finders: {} };
  let loaded = false;
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const found = {};
      if (raw?.found && typeof raw.found === 'object') {
        for (const [k, v] of Object.entries(raw.found)) {
          const n = Math.floor(Number(v) || 0);
          if (k && n > 0) found[String(k).toLowerCase()] = n;
        }
      }
      const finders = {};
      if (raw?.finders && typeof raw.finders === 'object') {
        for (const [k, v] of Object.entries(raw.finders)) {
          const h = Math.floor(Number(k) || 0);
          if (!(h >= 1) || !v) continue;
          const tag = String(v.tag || '').trim().toLowerCase();
          const worker = String(v.worker || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
          if (!/^m[0-9a-f]{8}$/.test(tag)) continue;
          finders[String(h)] = { tag, worker: worker || 'worker' };
        }
      }
      state = {
        credits: Array.isArray(raw?.credits) ? raw.credits.map((c) => ({
          tag: c.tag,
          nanos: c.nanos,
          height: c.height,
          ms: c.ms,
          kind: c.kind === 'hash' ? 'hash' : 'pot',
          dest20: c.dest20 || '',
        })) : [],
        pulled: Array.isArray(raw?.pulled) ? raw.pulled.map((p) => ({
          tag: p.tag,
          nanos: p.nanos,
          height: p.height,
          ms: p.ms,
          dest20: p.dest20 || '',
        })) : [],
        lastPullMs: raw?.lastPullMs && typeof raw.lastPullMs === 'object' ? raw.lastPullMs : {},
        found,
        finders,
      };
      loaded = true;
      if (raw?.dests && typeof raw.dests === 'object') {
        for (const [k, v] of Object.entries(raw.dests)) {
          if (!k) continue;
          if (isMinerSsa1(v)) destByTag.set(String(k).toLowerCase(), String(v).trim().split('.')[0]);
          else {
            const d = destFrom20(v);
            if (d) destByTag.set(String(k).toLowerCase(), d);
          }
        }
      }
      for (const c of state.credits) {
        if (c.tag && c.dest20 && !destByTag.get(c.tag)) destByTag.set(c.tag, destFrom20(c.dest20));
      }
    } catch {
      state = { credits: [], pulled: [], lastPullMs: {}, found: {}, finders: {} };
    }
  }

  function uniquePotHeights() {
    const s = new Set();
    for (const c of state.credits) {
      if (c.kind === 'hash') continue;
      const h = Number(c.height) || 0;
      if (h >= 1) s.add(h);
    }
    return s;
  }

  function sealsLifetime() {
    return uniquePotHeights().size;
  }

  function save() {
    const disk = {
      credits: state.credits.map((c) => ({
        tag: c.tag,
        nanos: c.nanos,
        height: c.height,
        ms: c.ms,
        kind: c.kind === 'hash' ? 'hash' : 'pot',
        dest20: c.dest20 || '',
      })),
      pulled: state.pulled.map((p) => ({
        tag: p.tag,
        nanos: p.nanos,
        height: p.height,
        ms: p.ms,
        dest20: p.dest20 || '',
      })),
      lastPullMs: state.lastPullMs,
      found: state.found,
      finders: state.finders || {},
      dests: Object.fromEntries([...destByTag].map(([k, v]) => [k, dest20Hex(v)])),
      sealsLifetime: sealsLifetime(),
    };
    fs.writeFileSync(file, `${JSON.stringify(disk)}\n`, { mode: 0o600 });
  }

  function rememberDest(tag, dest) {
    if (!tag || !isMinerSsa1(dest)) return '';
    destByTag.set(String(tag).toLowerCase(), String(dest).trim().split('.')[0]);
    return dest20Hex(dest);
  }

  /** Record payout dest on login so miner pages show ssa1**** before the next found block. */
  function bindDest(tag, dest) {
    const raw = String(dest || '').trim().split('.')[0];
    if (raw && !payeeFs1Ok(raw)) return false;
    const d20 = rememberDest(tag, dest);
    if (d20) save();
    return !!d20;
  }

  /** Nothing is credited on any book: miners are paid from the coinbase. */
  function creditRound() {
    return { ok: false, reason: 'custodial_pull' };
  }

  /** Every figure is 0: the book holds no miner money on any book. */
  function view(tag, { need = SPENDABLE_CONFIRMATIONS } = {}) {
    const key = String(tag || '').trim().toLowerCase();
    const dest = destOf(key);
    return {
      pendingNanos: 0,
      confirmedNanos: 0,
      unconfirmedNanos: 0,
      confirmedPotNanos: 0,
      confirmedHashNanos: 0,
      hashPaidNanos: 0,
      sentNanos: 0,
      lastPullMs: 0,
      nextPullMs: 0,
      dest,
      destRedacted: redactSsa1(dest),
      autoPayoutMinNanos: 0,
      foundBlocks: 0,
      oldestUnconfirmedHeight: 0,
      confirmRemain: 0,
      confirmNeed: Math.max(1, Number(need) || 1),
    };
  }

  function takeConfirmed(tag, {
    tipHeight = 0,
    need = SPENDABLE_CONFIRMATIONS,
    now = Date.now(),
    amountNanos = null,
    skipCooldown = false,
  } = {}) {
    const key = String(tag || '').trim().toLowerCase();
    const v = view(key, { tipHeight, need });
    if (!skipCooldown && v.lastPullMs && now < v.nextPullMs) {
      return { ok: false, reason: 'cooldown', nextPullMs: v.nextPullMs };
    }
    if (!(v.confirmedNanos > 0)) return { ok: false, reason: 'none_confirmed' };
    const want = amountNanos == null
      ? v.confirmedNanos
      : Math.floor(Number(amountNanos) || 0);
    if (!(want > 0)) return { ok: false, reason: 'none_confirmed' };
    if (want > v.confirmedNanos) return { ok: false, reason: 'over_unpaid' };
    const dest = destOf(key);
    state.pulled.push({
      tag: key,
      nanos: want,
      height: tipHeight,
      ms: now,
      dest20: dest ? dest20Hex(dest) : '',
    });
    state.lastPullMs[key] = now;
    save();
    return { ok: true, nanos: want, dest };
  }

  function destOf(tag) {
    const key = String(tag || '').trim().toLowerCase();
    if (destByTag.has(key) && destByTag.get(key)) return destByTag.get(key);
    for (let i = state.credits.length - 1; i >= 0; i -= 1) {
      const c = state.credits[i];
      if (c.tag === key && c.dest20) {
        const d = destFrom20(c.dest20);
        if (d) {
          destByTag.set(key, d);
          return d;
        }
      }
    }
    return '';
  }

  function tags() {
    const s = new Set();
    for (const c of state.credits) if (c.tag) s.add(c.tag);
    for (const p of state.pulled) if (p.tag) s.add(p.tag);
    for (const k of Object.keys(state.found || {})) if (k) s.add(k);
    return [...s];
  }

  /** Dest-scoped pull-book view: sum every miner tag bound to this ssa1. */
  function viewByDest(dest, opts = {}) {
    const want = String(dest || '').trim();
    const matching = want ? tags().filter((t) => destOf(t) === want) : [];
    if (!matching.length) {
      return {
        pendingNanos: 0,
        confirmedNanos: 0,
        unconfirmedNanos: 0,
        confirmedPotNanos: 0,
        confirmedHashNanos: 0,
        hashPaidNanos: 0,
        sentNanos: 0,
        dest: want,
        destRedacted: want ? redactSsa1(want) : '',
      };
    }
    const acc = {
      pendingNanos: 0,
      confirmedNanos: 0,
      unconfirmedNanos: 0,
      confirmedPotNanos: 0,
      confirmedHashNanos: 0,
      hashPaidNanos: 0,
      sentNanos: 0,
      dest: want,
      destRedacted: redactSsa1(want),
    };
    for (const tag of matching) {
      const v = view(tag, opts);
      acc.pendingNanos += v.pendingNanos;
      acc.confirmedNanos += v.confirmedNanos;
      acc.unconfirmedNanos += v.unconfirmedNanos;
      acc.confirmedPotNanos += v.confirmedPotNanos;
      acc.confirmedHashNanos += v.confirmedHashNanos;
      acc.hashPaidNanos += v.hashPaidNanos;
      acc.sentNanos += v.sentNanos;
    }
    return acc;
  }

  function hasTag(tag) {
    const key = String(tag || '').trim().toLowerCase();
    if (!key) return false;
    if (Number(state.found[key]) > 0) return true;
    if (state.lastPullMs[key]) return true;
    for (const c of state.credits) if (c.tag === key) return true;
    for (const p of state.pulled) if (p.tag === key) return true;
    return false;
  }

  function reconcile({ potAfterFeeNanos = potCreditNanos() } = {}) {
    const net = Math.max(0, Math.floor(Number(potAfterFeeNanos) || 0));
    let potCredits = 0;
    let hashCredits = 0;
    const byH = new Map();
    for (const c of state.credits) {
      const n = Math.floor(Number(c.nanos) || 0);
      if (c.kind === 'hash') {
        hashCredits += n;
        continue;
      }
      potCredits += n;
      const h = Number(c.height) || 0;
      if (h >= 1) byH.set(h, (byH.get(h) || 0) + n);
    }
    let attributedFee = 0;
    for (const n of byH.values()) attributedFee += attributedPoolFeeNanos(n);
    const seals = byH.size;
    const expectedNet = seals * net;
    const drift = potCredits - expectedNet;
    return {
      sealsLifetime: seals,
      potCreditsNanos: potCredits,
      hashCreditsNanos: hashCredits,
      attributedFeeNanos: attributedFee,
      expectedNetPotNanos: expectedNet,
      driftNanos: drift,
      ok: Math.abs(drift) <= seals,
    };
  }

  /** No credit rows on any book. */
  function ledger() {
    return [];
  }

  function unpaidPotNanos({ tipHeight = 0, need = SPENDABLE_CONFIRMATIONS } = {}) {
    let n = 0;
    for (const tag of tags()) {
      n += view(tag, { tipHeight, need }).pendingNanos;
    }
    return n;
  }

  if (loaded) save();
  function finderOf(height) {
    const h = Math.floor(Number(height) || 0);
    if (!(h >= 1) || !state.finders) return null;
    const row = state.finders[String(h)];
    if (!row || !row.tag) return null;
    return { tag: String(row.tag), worker: String(row.worker || 'worker') };
  }

  return {
    creditRound, view, viewByDest, takeConfirmed, destOf, bindDest, tags, hasTag, unpaidPotNanos,
    ledger, sealsLifetime, reconcile, finderOf,
  };
}

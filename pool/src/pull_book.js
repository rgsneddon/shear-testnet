/**
 * Off-chain pool credits. 0.99 of each found pot (1% fee already stripped)
 * plus 100% of hash-bonus units sit here until auto-payout at π SHE.
 * Hash bonus never takes the 1% pool fee. she1 never stored in the book.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BLOCK_SUBSIDY_NANOS, POOL_FEE_BPS, SPENDABLE_CONFIRMATIONS, HASH_BONUS_NANOS } from '../../crypto/asert.js';
import { isSpendableHeight } from '../../crypto/chronoflux.js';
import { hash20FromAddress, encodeDest } from '../../crypto/address.js';
import { asU8 } from '../../crypto/note.js';
import {
  AUTO_PAYOUT_MIN_NANOS,
  isMinerSsa1,
  shouldAutoPayout,
  potCreditAfterFeeNanos,
  redactSsa1,
} from './auto_payout.js';

/** Auto-payout is π-sum, not a clock. Zero: a dest can be paid again as soon as it re-accumulates π. */
export const PULL_COOLDOWN_MS = 0;
export { AUTO_PAYOUT_MIN_NANOS, redactSsa1 };

export function potCreditNanos(potNanos = BLOCK_SUBSIDY_NANOS) {
  return potCreditAfterFeeNanos(potNanos);
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
      };
      loaded = true;
      for (const c of state.credits) {
        if (c.tag && c.dest20) destByTag.set(c.tag, destFrom20(c.dest20));
      }
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
    };
    fs.writeFileSync(file, `${JSON.stringify(disk)}\n`, { mode: 0o600 });
  }

  function rememberDest(tag, dest) {
    if (!tag || !isMinerSsa1(dest)) return '';
    destByTag.set(tag, dest);
    return dest20Hex(dest);
  }

  function creditRound(rows, {
    height,
    nanos = potCreditNanos(),
    hashByDest = null,
    hashUnit = HASH_BONUS_NANOS,
    now = Date.now(),
  } = {}) {
    const list = (rows || []).filter((r) => r && r.tag && r.dest && (Number(r.count) || 0) > 0);
    const total = list.reduce((a, r) => a + (Number(r.count) || 0), 0);
    const pot = Math.max(0, Math.floor(Number(nanos) || 0));
    if (!(height >= 1)) return { ok: false, reason: 'empty' };
    if (!total && !(hashByDest && hashByDest.size)) return { ok: false, reason: 'empty' };
    let left = pot;
    if (total && pot) {
      for (let i = 0; i < list.length; i += 1) {
        const share = i === list.length - 1
          ? left
          : Math.floor(pot * (Number(list[i].count) || 0) / total);
        left -= share;
        if (share <= 0) continue;
        const tag = String(list[i].tag).toLowerCase();
        const d20 = rememberDest(tag, list[i].dest);
        state.credits.push({
          tag,
          nanos: share,
          height,
          ms: now,
          kind: 'pot',
          dest20: d20,
        });
      }
    }
    if (hashByDest && typeof hashByDest.forEach === 'function') {
      const byTag = new Map();
      for (const row of list) {
        const dest = String(row.dest || '');
        const tag = String(row.tag).toLowerCase();
        const n = Math.floor(Number(hashByDest.get(dest) || hashByDest.get(tag) || 0));
        if (n > 0) byTag.set(tag, (byTag.get(tag) || 0) + n);
      }
      if (!byTag.size) {
        for (const [key, n] of hashByDest) {
          const nanosH = Math.floor(Number(n) || 0);
          if (nanosH <= 0) continue;
          const match = list.find((r) => r.dest === key || r.tag === key);
          const tag = String(match?.tag || key).toLowerCase();
          byTag.set(tag, (byTag.get(tag) || 0) + nanosH);
          if (match?.dest) rememberDest(tag, match.dest);
        }
      }
      for (const [tag, nanosH] of byTag) {
        if (nanosH <= 0) continue;
        const dest = destOf(tag);
        const d20 = dest ? dest20Hex(dest) : '';
        state.credits.push({
          tag,
          nanos: nanosH,
          height,
          ms: now,
          kind: 'hash',
          dest20: d20,
        });
      }
    }
    void hashUnit;
    save();
    return { ok: true };
  }

  function view(tag, { tipHeight = 0, need = SPENDABLE_CONFIRMATIONS } = {}) {
    const key = String(tag || '').trim().toLowerCase();
    let confirmed = 0;
    let unconfirmed = 0;
    let confirmedPot = 0;
    let confirmedHash = 0;
    for (const c of state.credits) {
      if (c.tag !== key) continue;
      const n = Math.floor(Number(c.nanos) || 0);
      if (isSpendableHeight(c.height, tipHeight, need)) {
        confirmed += n;
        if (c.kind === 'hash') confirmedHash += n;
        else confirmedPot += n;
      } else unconfirmed += n;
    }
    let pulled = 0;
    let sentConfirmed = 0;
    for (const p of state.pulled) {
      if (p.tag !== key) continue;
      const n = Math.floor(Number(p.nanos) || 0);
      pulled += n;
      if (isSpendableHeight(p.height, tipHeight, need)) sentConfirmed += n;
    }
    let conf = confirmed - pulled;
    if (conf < 0) {
      unconfirmed = Math.max(0, unconfirmed + conf);
      conf = 0;
    }
    const lastPullMs = Number(state.lastPullMs[key] || 0);
    const dest = destOf(key);
    return {
      pendingNanos: conf + unconfirmed,
      confirmedNanos: conf,
      unconfirmedNanos: unconfirmed,
      confirmedPotNanos: Math.max(0, confirmedPot),
      confirmedHashNanos: Math.max(0, confirmedHash),
      sentNanos: sentConfirmed,
      lastPullMs,
      nextPullMs: lastPullMs ? lastPullMs + PULL_COOLDOWN_MS : 0,
      dest,
      destRedacted: redactSsa1(dest),
      autoPayoutMinNanos: AUTO_PAYOUT_MIN_NANOS,
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
    for (const c of state.credits) s.add(c.tag);
    return [...s];
  }

  function dueAuto({ tipHeight = 0, need = SPENDABLE_CONFIRMATIONS } = {}) {
    const out = [];
    for (const tag of tags()) {
      const dest = destOf(tag);
      const v = view(tag, { tipHeight, need });
      const gate = shouldAutoPayout({ confirmedNanos: v.confirmedNanos, dest });
      if (gate.ok) out.push({ tag, dest: gate.dest, nanos: gate.nanos });
    }
    return out;
  }

  function sweepAuto(opts = {}) {
    const due = dueAuto(opts);
    const out = [];
    for (const row of due) {
      const taken = takeConfirmed(row.tag, {
        tipHeight: opts.tipHeight,
        need: opts.need,
        now: opts.now,
        amountNanos: row.nanos,
        skipCooldown: true,
      });
      if (taken.ok) out.push({ tag: row.tag, dest: row.dest, nanos: taken.nanos });
    }
    return out;
  }

  if (loaded) save();
  return { creditRound, view, takeConfirmed, destOf, tags, dueAuto, sweepAuto };
}

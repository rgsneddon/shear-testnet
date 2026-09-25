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
  let state = { credits: [], pulled: [], lastPullMs: {}, found: {} };
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
      state = { credits: [], pulled: [], lastPullMs: {}, found: {} };
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
    const d20 = rememberDest(tag, dest);
    if (d20) save();
    return !!d20;
  }

  function creditRound(rows, {
    height,
    nanos = potCreditNanos(),
    hashByDest = null,
    hashUnit = HASH_BONUS_NANOS,
    now = Date.now(),
    finderTag = '',
  } = {}) {
    const list = (rows || []).filter((r) => r && r.tag && (Number(r.count) || 0) > 0);
    const total = list.reduce((a, r) => a + (Number(r.count) || 0), 0);
    const pot = Math.max(0, Math.floor(Number(nanos) || 0));
    if (!(height >= 1)) return { ok: false, reason: 'empty' };
    if (!total && !(hashByDest && hashByDest.size)) return { ok: false, reason: 'empty' };
    const finder = String(finderTag || '').trim().toLowerCase();
    if (finder) state.found[finder] = (Math.floor(Number(state.found[finder]) || 0) + 1);
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
    let unconfirmedPot = 0;
    let confirmedPot = 0;
    let hashPaid = 0;
    for (const c of state.credits) {
      if (c.tag !== key) continue;
      const n = Math.floor(Number(c.nanos) || 0);
      if (c.kind === 'hash') {
        hashPaid += n;
        continue;
      }
      if (isSpendableHeight(c.height, tipHeight, need)) confirmedPot += n;
      else unconfirmedPot += n;
    }
    let pulled = 0;
    for (const p of state.pulled) {
      if (p.tag !== key) continue;
      pulled += Math.floor(Number(p.nanos) || 0);
    }
    let conf = confirmedPot - pulled;
    if (conf < 0) {
      unconfirmedPot = Math.max(0, unconfirmedPot + conf);
      conf = 0;
    }
    const lastPullMs = Number(state.lastPullMs[key] || 0);
    const dest = destOf(key);
    let oldestUnconfirmedHeight = 0;
    for (const c of state.credits) {
      if (c.tag !== key) continue;
      const h = Number(c.height) || 0;
      if (!(h >= 1)) continue;
      if (c.kind === 'hash') continue;
      if (isSpendableHeight(h, tipHeight, need)) continue;
      if (!oldestUnconfirmedHeight || h < oldestUnconfirmedHeight) oldestUnconfirmedHeight = h;
    }
    const confirmRemain = oldestUnconfirmedHeight
      ? Math.max(0, oldestUnconfirmedHeight + Math.max(1, Number(need) || 1) - 1 - tipHeight)
      : 0;
    return {
      pendingNanos: conf + unconfirmedPot,
      confirmedNanos: conf,
      unconfirmedNanos: unconfirmedPot,
      confirmedPotNanos: Math.max(0, confirmedPot),
      confirmedHashNanos: Math.max(0, hashPaid),
      hashPaidNanos: Math.max(0, hashPaid),
      sentNanos: pulled + hashPaid,
      lastPullMs,
      nextPullMs: lastPullMs ? lastPullMs + PULL_COOLDOWN_MS : 0,
      dest,
      destRedacted: redactSsa1(dest),
      autoPayoutMinNanos: AUTO_PAYOUT_MIN_NANOS,
      foundBlocks: Math.floor(Number(state.found[key]) || 0),
      oldestUnconfirmedHeight,
      confirmRemain,
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
    const unpaid = v.pendingNanos;
    if (!(unpaid > 0)) return { ok: false, reason: 'none_confirmed' };
    const want = amountNanos == null
      ? unpaid
      : Math.floor(Number(amountNanos) || 0);
    if (!(want > 0)) return { ok: false, reason: 'none_confirmed' };
    if (want > unpaid) return { ok: false, reason: 'over_unpaid' };
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

  function ledger(tag) {
    const key = String(tag || '').trim().toLowerCase();
    const byH = new Map();
    for (const c of state.credits) {
      if (c.tag !== key) continue;
      const h = Number(c.height) || 0;
      if (!(h >= 1)) continue;
      if (!byH.has(h)) byH.set(h, { height: h, potNanos: 0, hashNanos: 0 });
      const row = byH.get(h);
      const n = Math.floor(Number(c.nanos) || 0);
      if (c.kind === 'hash') row.hashNanos += n;
      else row.potNanos += n;
    }
    return [...byH.values()]
      .sort((a, b) => b.height - a.height)
      .map((r) => {
        const fee = attributedPoolFeeNanos(r.potNanos);
        return {
          height: r.height,
          blockRwdNanos: r.potNanos,
          hashBonusNanos: r.hashNanos,
          poolFeeNanos: fee,
          totalNanos: r.potNanos + r.hashNanos,
        };
      });
  }

  function dueAuto({ tipHeight = 0, need = SPENDABLE_CONFIRMATIONS } = {}) {
    const out = [];
    for (const tag of tags()) {
      const dest = destOf(tag);
      const v = view(tag, { tipHeight, need });
      // One π lot when the unpaid pot has reached π. The 4s sweep pays that
      // lot, then waits until newly mined credit reaches π again.
      const owed = v.pendingNanos;
      const gate = shouldAutoPayout({ confirmedNanos: owed, dest });
      if (gate.ok) out.push({ tag, dest: gate.dest, nanos: AUTO_PAYOUT_MIN_NANOS });
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
  return {
    creditRound, view, viewByDest, takeConfirmed, destOf, bindDest, tags, hasTag, dueAuto, sweepAuto, ledger,
    sealsLifetime, reconcile,
  };
}

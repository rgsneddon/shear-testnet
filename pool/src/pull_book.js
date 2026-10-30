/**
 * The miner pull book. It credits nothing on any book: miners are paid from
 * the coinbase (R14a), so no pot share or hash bonus is held here and no
 * payout is ever due. What remains is the tag record the miner pages read:
 * the payout dest a miner bound at login and the found counts an older book
 * wrote. Credits, pulled rows and the pull clock of the custodial book are
 * not loaded from disk and not written back. she1 never stored.
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
  let state = { found: {} };
  let loaded = false;
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Only the tag record is read. Credits, pulled rows, the pull clock and
      // the finder rows of the custodial book are left on the floor.
      const found = {};
      if (raw?.found && typeof raw.found === 'object') {
        for (const [k, v] of Object.entries(raw.found)) {
          const n = Math.floor(Number(v) || 0);
          if (k && n > 0) found[String(k).toLowerCase()] = n;
        }
      }
      state = { found };
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
    } catch {
      state = { found: {} };
    }
  }

  function save() {
    const disk = {
      found: state.found,
      dests: Object.fromEntries([...destByTag].map(([k, v]) => [k, dest20Hex(v)])),
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
      oldestUnconfirmedHeight: 0,
      confirmRemain: 0,
      confirmNeed: Math.max(1, Number(need) || 1),
    };
  }

  function destOf(tag) {
    const key = String(tag || '').trim().toLowerCase();
    if (destByTag.has(key) && destByTag.get(key)) return destByTag.get(key);
    return '';
  }

  function tags() {
    const s = new Set();
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

  /** A tag with a found count: the one record an older book may still carry. */
  function hasTag(tag) {
    const key = String(tag || '').trim().toLowerCase();
    if (!key) return false;
    return Number(state.found[key]) > 0;
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

  return {
    creditRound, view, viewByDest, destOf, bindDest, tags, hasTag, unpaidPotNanos, ledger,
  };
}

/**
 * cb-v3 carry book (MF-1). A share's PoW binds one header: the block built on
 * that header pays it at proof slot 0, and the next block may pay it at slot 1.
 * There is no third chance.
 *
 * The book keeps, per header (keyed by its block hash), the labelled shares the
 * templates offered on it. The carry for a template on tip T is
 * round[parent(T)] minus what T paid, by work key and by label (a label T paid
 * is spent: its E may not repeat in the next coinbase). That is recomputed
 * from whichever tip wins, so a reorg to a sibling puts the shares the
 * orphan paid back into the carry, and the file brings it back after a restart.
 *
 * What cannot carry: a share already at slot 1 that the next block does not
 * pay (expired), a share mined on an orphaned header, and a share that arrives
 * for a label its block already paid. Holding any of those past one block is
 * escrow, which is a policy ruling and not built here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodeHeader } from '../../crypto/header.js';
import {
  T21_SHARE_MAX_BITS, creditBitsForShare, noteCommitOfShare, shareWorkKey, unitsForShare,
} from '../../crypto/share_batch.js';
import { isT21Coinbase, t21ShareNc } from '../../crypto/t21.js';
import { asU8 } from '../../crypto/note.js';

const SLOT_FIELDS = new Set(['proofSlot', 'kinHeader', 'deferReason', '_src']);

function hex(b) {
  return Buffer.from(asU8(b)).toString('hex');
}

function parentHashOf(block) {
  try {
    return hex(decodeHeader(Buffer.from(asU8(block.header))).prevBlockHash);
  } catch {
    return '';
  }
}

function workKeyOf(share) {
  return shareWorkKey(share?.verifiedHeader, share?.nonce) || '';
}

function unitsOf(share) {
  const c = creditBitsForShare(share, undefined, { strict: false, maxBits: T21_SHARE_MAX_BITS });
  return c.ok ? BigInt(unitsForShare(c.bits)) : 0n;
}

/** The share as it was mined: slot claims from an earlier template are dropped. */
function bare(share) {
  const out = {};
  for (const [k, v] of Object.entries(share || {})) if (!SLOT_FIELDS.has(k)) out[k] = v;
  return out;
}

function encode(v) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $b: hex(v) };
  if (typeof v === 'bigint') return { $n: v.toString() };
  return v;
}

function decode(v) {
  if (v && typeof v === 'object' && typeof v.$b === 'string') return Buffer.from(v.$b, 'hex');
  if (v && typeof v === 'object' && typeof v.$n === 'string') return BigInt(v.$n);
  return v;
}

/** Work keys and paid labels of one block. */
function paidBy(block, magic) {
  const works = new Set();
  for (const s of block?.shareBatch || []) {
    const k = workKeyOf(s);
    if (k) works.add(k);
  }
  const labels = new Set();
  const cb = block?.txs?.[0];
  if (isT21Coinbase(cb)) {
    for (const s of cb.t21?.shares || []) labels.add(t21ShareNc(magic, s.E).toString('hex'));
  }
  return { works, labels };
}

function unpaid(shares, paid) {
  return shares.filter((s) => !paid.works.has(workKeyOf(s)) && !paid.labels.has(hex(noteCommitOfShare(s))));
}

export function t21CarryBook({ file = null, keepHeights = 6 } = {}) {
  const rounds = new Map();
  const seenTips = new Set();
  const stats = { expiredShares: 0, expiredUnits: 0n, emptyHeld: 0, carriedShares: 0 };

  function save() {
    if (!file) return;
    const out = {
      v: 1,
      stats: { ...stats, expiredUnits: stats.expiredUnits.toString() },
      rounds: [...rounds.entries()].map(([hash, r]) => ({
        hash,
        height: r.height,
        shares: [...r.shares.values()].map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, encode(v)]))),
      })),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function load() {
    if (!file || !fs.existsSync(file)) return;
    let got;
    try {
      got = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (got?.v !== 1 || !Array.isArray(got.rounds)) return;
    for (const r of got.rounds) {
      const shares = new Map();
      for (const raw of r.shares || []) {
        const s = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decode(v)]));
        const k = workKeyOf(s);
        if (k) shares.set(k, s);
      }
      rounds.set(String(r.hash), { height: Number(r.height) || 0, shares });
    }
    if (got.stats) {
      stats.expiredShares = Number(got.stats.expiredShares) || 0;
      stats.expiredUnits = BigInt(got.stats.expiredUnits || 0);
      stats.emptyHeld = Number(got.stats.emptyHeld) || 0;
      stats.carriedShares = Number(got.stats.carriedShares) || 0;
    }
  }

  function roundShares(hash) {
    const r = rounds.get(hash);
    return r ? [...r.shares.values()] : [];
  }

  /** Shares offered on `onBlock`'s header (proof slot 0 for its child). Merged across templates. */
  function noteRound(onBlock, shares) {
    if (!onBlock?.hash) return;
    const hash = hex(onBlock.hash);
    let r = rounds.get(hash);
    if (!r) {
      r = { height: Number(onBlock.height) || 0, shares: new Map() };
      rounds.set(hash, r);
    }
    let added = false;
    for (const s of shares || []) {
      const k = workKeyOf(s);
      if (!k || r.shares.has(k)) continue;
      r.shares.set(k, bare(s));
      added = true;
    }
    const floor = (Number(onBlock.height) || 0) - keepHeights;
    for (const [h, row] of rounds) if (row.height < floor) rounds.delete(h);
    if (added) save();
  }

  /** Slot-1 carry for a template on `tip`: the shares offered on tip's parent that tip did not pay. */
  function carryFor(tip, magic) {
    if (!tip?.header) return [];
    return unpaid(roundShares(parentHashOf(tip)), paidBy(tip, magic)).map(bare);
  }

  /**
   * Once per tip: the carry `tip` was offered (round[grandparent] − parent's
   * payments) that it did not pay has expired. MF-4: `tip` paid no share while
   * the book held carry or fresh shares for it.
   */
  function settleTip(tip, parent, magic) {
    if (!tip?.hash || !parent?.header) return { expired: [], emptyHeld: false };
    const key = hex(tip.hash);
    const offered = unpaid(roundShares(parentHashOf(parent)), paidBy(parent, magic));
    const expired = unpaid(offered, paidBy(tip, magic));
    const held = offered.length + roundShares(hex(parent.hash)).length;
    const cb = tip.txs?.[0];
    const emptyHeld = isT21Coinbase(cb) && !(cb.t21?.shares || []).length && held > 0;
    if (seenTips.has(key)) return { expired, emptyHeld };
    seenTips.add(key);
    if (seenTips.size > 4096) seenTips.delete(seenTips.values().next().value);
    stats.carriedShares += offered.length - expired.length;
    if (expired.length) {
      stats.expiredShares += expired.length;
      for (const s of expired) stats.expiredUnits += unitsOf(s);
      console.error(JSON.stringify({ event: 't21_share_expired', alert: true, tip: key, shares: expired.length }));
    }
    if (emptyHeld) {
      stats.emptyHeld += 1;
      console.error(JSON.stringify({ event: 't21_empty_batch_held', alert: true, tip: key, held }));
    }
    if (expired.length || emptyHeld) save();
    return { expired, emptyHeld };
  }

  load();
  return {
    noteRound,
    carryFor,
    settleTip,
    stats: () => ({ ...stats, rounds: rounds.size }),
    roundSize: (hash) => roundShares(hex(hash)).length,
  };
}

/** Carry first, then fresh; one copy per work key. */
export function withCarry(carried, fresh) {
  const seen = new Set();
  const out = [];
  for (const s of [...(carried || []), ...(fresh || [])]) {
    const k = workKeyOf(s);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(s);
  }
  return out;
}

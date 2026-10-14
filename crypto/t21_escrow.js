/**
 * Payee-cap escrow. Carry exists only for payees that do not fit the block.
 * A row is sealed at defer time from that round's own pot:
 *   pot = floor(R · w / W_all), hash = u · w, v = pot + hash.
 * W_all is every payee in the round, paid and escrowed. TTL returns v to the
 * pot. The hash cap is not a deferral: W >= 2^48 is refused.
 */
import { lawDust, splitLaw } from './t21_law.js';
import { T21_OWED_GLOBAL, T21_OWED_MAX, T21_OWED_TTL, T21_SETTLE_WINDOW, W_MAX } from './t21_params.js';

export function weightPay(R, W, w, u) {
  const law = splitLaw({ R, W, Wi: w, u, fin: 0n });
  if (!law) return null;
  const hash = u * w;
  const pot = law.v - hash;
  if (pot < 0n) return null;
  return { pot, hash, v: law.v, rho: law.rho };
}

/** Price every positive weight on one denominator. `weights` is paid then escrow. */
export function priceWeights(R, u, weights) {
  let W = 0n;
  for (const w of weights) {
    if (w <= 0n) return null;
    W += w;
  }
  if (W <= 0n || W >= W_MAX) return null;
  const rows = [];
  for (const w of weights) {
    const row = weightPay(R, W, w, u);
    if (!row) return null;
    rows.push(row);
  }
  const dust = lawDust(rows.map((r) => r.rho), W);
  if (dust == null) return null;
  return { W, rows, dust };
}

/**
 * owedIn rows carry `id`, `pot`, `hash`, `since`. `paid` is a set of ids.
 * Fresh rows are appended in order. `folds` add shares to an existing row:
 * `{id, addPot, addHash, shares}`. A hidden row has Cpot/Chash instead of
 * pot/hash; a fold then carries the new commitments. The row keeps `since`.
 * Expired value is `back`, not a payment to the producer. Hidden rows do not
 * add their amount into `back` (that total is opened once per block).
 */
export function composeOwed({
  owedIn = [], paid = new Set(), fresh = [], folds = [], height, ttl = T21_OWED_TTL,
} = {}) {
  const h = BigInt(height);
  const owed = [];
  let backPot = 0n;
  let backHash = 0n;
  let hiddenBack = false;
  const settled = new Set(paid);
  const foldById = new Map();
  for (const f of folds) {
    const id = String(f.id);
    if (!id || foldById.has(id)) return { ok: false, reason: 'owed_list' };
    foldById.set(id, f);
  }
  for (const o of owedIn) {
    const id = String(o.id);
    if (h - BigInt(o.since) > BigInt(ttl)) {
      if (foldById.has(id)) return { ok: false, reason: 'owed_list' };
      if (o.Cpot || o.Chash || o.pot == null || o.pot === '') hiddenBack = true;
      else {
        backPot += BigInt(o.pot);
        backHash += BigInt(o.hash);
      }
      continue;
    }
    if (settled.has(o.id)) {
      if (foldById.has(id)) return { ok: false, reason: 'owed_list' };
      settled.delete(o.id);
      continue;
    }
    const fold = foldById.get(id);
    if (!fold) {
      owed.push(o);
      continue;
    }
    foldById.delete(id);
    if (o.Cpot || o.Chash) {
      if (!fold.Cpot || !fold.Chash) return { ok: false, reason: 'owed_list' };
      foldById.delete(id);
      owed.push({
        ...o,
        Cpot: fold.Cpot,
        Chash: fold.Chash,
        potBp: fold.potBp,
        hashBp: fold.hashBp,
      });
      continue;
    }
    const addPot = BigInt(fold.addPot);
    const addHash = BigInt(fold.addHash);
    if (addPot < 0n || addHash < 0n) return { ok: false, reason: 'owed_list' };
    const prior = Array.isArray(o.shares) ? o.shares : null;
    const frozen = prior ? prior.map((s) => (
      s.pot0 != null && s.pot0 !== '' ? s : { ...s, pot0: String(BigInt(o.pot)), hash0: String(BigInt(o.hash)) }
    )) : null;
    const added = Array.isArray(fold.shares) ? fold.shares : [];
    const next = {
      ...o,
      pot: BigInt(o.pot) + addPot,
      hash: BigInt(o.hash) + addHash,
    };
    if (frozen) next.shares = frozen.concat(added);
    owed.push(next);
  }
  if (settled.size || foldById.size) return { ok: false, reason: 'owed_list' };
  for (const row of fresh) owed.push(row);
  return { ok: true, owed, backPot, backHash, back: backPot + backHash, hiddenBack };
}

/**
 * Per-producer quota, more than eight producer seats, or the whole list past
 * the global cap. Eight seats are the global list: a ninth key cannot open
 * another quota and fill it.
 */
export function owedCapExceeded(rows, byOf, { max = T21_OWED_MAX, globalMax = T21_OWED_GLOBAL } = {}) {
  const list = rows || [];
  if (list.length > globalMax) return true;
  const seats = new Set();
  for (const row of list) seats.add(byOf(row));
  if (seats.size > globalMax / max) return true;
  return quotaExceeded(list, byOf, max);
}

/**
 * A row is due when it is still payable and inside the settle window of TTL.
 * Age is height − since. Expiry is the next height, so age == TTL is still due.
 */
export function rowDue(since, height, { ttl = T21_OWED_TTL, window = T21_SETTLE_WINDOW } = {}) {
  const age = BigInt(height) - BigInt(since);
  return age >= BigInt(ttl - window) && age <= BigInt(ttl);
}

/**
 * Settlement duty. Due rows are oldest first. A block settles a prefix of
 * them, at least min(due, fit) of them. Settle rows sit outside the payee
 * cap, so the same block still admits fresh payees. A younger row is not
 * settled while an older due row is still open. fit is how many full rows
 * the frame can carry (the payee cap).
 */
export function settleDuty({
  owedIn = [], paid = new Set(), height,
  window = T21_SETTLE_WINDOW, ttl = T21_OWED_TTL, fit,
} = {}) {
  const h = BigInt(height);
  const openAt = BigInt(ttl - window);
  const limit = BigInt(ttl);
  const due = owedIn.filter((o) => {
    const age = h - BigInt(o.since);
    return age >= openAt && age <= limit;
  }).sort((a, b) => (Number(a.since) - Number(b.since)) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  const dueIds = new Set(due.map((o) => o.id));
  let prefix = 0;
  for (const o of due) {
    if (!paid.has(o.id)) break;
    prefix += 1;
  }
  for (const id of paid) {
    if (!dueIds.has(id) && prefix < due.length) return { ok: false, reason: 'owed_due', due: due.length, settled: prefix };
  }
  const room = Math.max(0, Math.floor(Number(fit == null ? due.length : fit)));
  const need = Math.min(due.length, room);
  if (prefix < need) return { ok: false, reason: 'owed_due', due: due.length, settled: prefix };
  return { ok: true, due: due.length, settled: prefix };
}

/** True when some producer key has more than `max` rows. */
export function quotaExceeded(rows, byOf, max = T21_OWED_MAX) {
  const n = new Map();
  for (const row of rows) {
    const k = byOf(row);
    const c = (n.get(k) || 0) + 1;
    if (c > max) return true;
    n.set(k, c);
  }
  return false;
}

/**
 * Supply move for one cb-v3 block. `potMinted` is permitted + carryIn − dust,
 * the pot that left the schedule before escrow is locked. Hash that expires
 * leaves the accepted-hash total because it is now pot carry, not unpaid hash.
 */
export function escrowBooks(prev, move) {
  const escrowPot = move.escrowPot || 0n;
  const escrowHashIn = move.escrowHash || 0n;
  const settlePot = move.settlePot || 0n;
  const settleHash = move.settleHash || 0n;
  const backPot = move.backPot || 0n;
  const backHash = move.backHash || 0n;
  const hashPaid = move.hashPaid || 0n;
  const hashAll = move.hashAll || 0n;
  const dust = move.dust || 0n;
  const potMinted = move.potMinted;
  return {
    mintedPot: prev.mintedPot + potMinted - escrowPot + settlePot,
    mintedHash: prev.mintedHash + hashPaid + settleHash,
    escrow: prev.escrow + escrowPot + escrowHashIn - settlePot - settleHash - backPot - backHash,
    escrowHash: prev.escrowHash + escrowHashIn - settleHash - backHash,
    acceptedHash: prev.acceptedHash + hashAll - backHash,
    permittedHashAll: prev.permittedHashAll + hashAll,
    carry: dust + backPot + backHash,
  };
}

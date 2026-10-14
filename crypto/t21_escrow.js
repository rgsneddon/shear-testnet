/**
 * Payee-cap escrow. Carry exists only for payees that do not fit the block.
 * A row is sealed at defer time from that round's own pot:
 *   pot = floor(R · w / W_all), hash = u · w, v = pot + hash.
 * W_all is every payee in the round, paid and escrowed. TTL returns v to the
 * pot. The hash cap is not a deferral: W >= 2^48 is refused.
 */
import { lawDust, splitLaw } from './t21_law.js';
import { T21_OWED_MAX, T21_OWED_TTL, W_MAX } from './t21_params.js';

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
 * Fresh rows are appended in order. Expired value is `back`, not a payment
 * to the producer.
 */
export function composeOwed({ owedIn = [], paid = new Set(), fresh = [], height, ttl = T21_OWED_TTL } = {}) {
  const h = BigInt(height);
  const owed = [];
  let backPot = 0n;
  let backHash = 0n;
  const settled = new Set(paid);
  for (const o of owedIn) {
    if (h - BigInt(o.since) > BigInt(ttl)) {
      backPot += BigInt(o.pot);
      backHash += BigInt(o.hash);
      continue;
    }
    if (settled.has(o.id)) {
      settled.delete(o.id);
      continue;
    }
    owed.push(o);
  }
  if (settled.size) return { ok: false, reason: 'owed_list' };
  for (const row of fresh) owed.push(row);
  return { ok: true, owed, backPot, backHash, back: backPot + backHash };
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

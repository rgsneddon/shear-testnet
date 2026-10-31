/**
 * Miner payout helpers. Miners are paid from the coinbase (R14a): each
 * sealed block carries their pot and hash-bonus notes. The pool holds no
 * miner money, builds no payout and runs no sweep, on any book.
 *
 * TODO (Russell): the pool fee address. The 1% pool fee is a coinbase note
 * to the pinned fee dest (posture.js configuredFeeIdentity); where that
 * balance is spent from is not decided here. Nothing is invented: no env
 * var, no default dest, no sweep.
 */
import { PI_SHE_NANOS, POOL_FEE_BPS, hashBonusUnitNanos } from '../../crypto/asert.js';
import { isDestAddress } from '../../crypto/address.js';
import { containsShe1 } from '../../crypto/levy.js';

/** The π SHE figure the miner pages and the 410 withdraw answer still name. No payout is built from it. */
export const AUTO_PAYOUT_MIN_NANOS = PI_SHE_NANOS;

export function isMinerSsa1(dest) {
  const d = String(dest || '').trim().split('.')[0];
  if (!d.startsWith('ssa1')) return false;
  if (containsShe1(d)) return false;
  return isDestAddress(d);
}

/** ssa1******** plus last 4 of the dest so miner pages stay distinct. */
export function redactSsa1(dest) {
  const d = String(dest || '').trim().split('.')[0];
  if (!isMinerSsa1(d)) return 'ssa1********';
  const tail = d.length >= 8 ? d.slice(-4) : '';
  return `ssa1********${tail}`;
}

/** 1% of the block pot only. Hash bonus is not an input. */
export function potCreditAfterFeeNanos(potNanos) {
  const pot = Math.max(0, Math.floor(Number(potNanos) || 0));
  const fee = Math.floor(pot * POOL_FEE_BPS / 10000);
  return pot - fee;
}

/** Hash-bonus credit. No pool fee. A voted unit of 0 pays nothing (bonus off); a malformed unit clamps to the floor of 1 (hashBonusUnitNanos). */
export function hashCreditNanos(units, unit) {
  const u = Math.max(0, Math.floor(Number(units) || 0));
  return u * hashBonusUnitNanos(unit);
}

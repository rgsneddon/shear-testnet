/**
 * Operator balance view. No HTTP route, cookie, or admin page.
 * Spendable is the pinned fee dest. Locked reserve is not part of it.
 */
import { isDestAddress, payoutDest } from '../../crypto/address.js';
import { configuredFeeIdentity } from './posture.js';
import { NANOS_PER_SHE, formatShe } from '../../crypto/asert.js';
import { reconstructOwner } from './wallet_api.js';

/** Operator Continuum dests: custody pot dest plus the 1% fee dest. */
export function adminWalletDests(poolDest) {
  const out = [];
  const pay = payoutDest(poolDest) || (isDestAddress(poolDest) ? String(poolDest).trim() : '');
  if (pay && isDestAddress(pay)) out.push(pay);
  const pinned = configuredFeeIdentity();
  const fee = pinned.ok ? pinned.feeDest : '';
  if (fee && isDestAddress(fee) && fee !== pay) out.push(fee);
  if (!out.length && fee) out.push(fee);
  return out;
}

export function minerReservedNanos(pullBook) {
  if (!pullBook || typeof pullBook.tags !== 'function' || typeof pullBook.view !== 'function') return 0;
  let n = 0;
  for (const tag of pullBook.tags()) {
    const v = pullBook.view(tag);
    n += Math.max(0, Math.floor(Number(v?.pendingNanos) || 0));
  }
  return n;
}

export function adminWalletBalance(store, poolDest, pullBook) {
  const pinned = configuredFeeIdentity();
  const fee = pinned.ok ? pinned.feeDest : '';
  const pay = payoutDest(poolDest) || (isDestAddress(poolDest) ? String(poolDest).trim() : '');
  const feeN = fee ? reconstructOwner(store, fee).spendableNanos : 0;
  const custodyN = pay && pay !== fee ? reconstructOwner(store, pay).spendableNanos : 0;
  const reserved = minerReservedNanos(pullBook);
  const adminN = Math.max(0, feeN);
  return {
    dests: adminWalletDests(poolDest),
    spendableNanos: adminN,
    spendable: adminN / NANOS_PER_SHE,
    display: formatShe(adminN / NANOS_PER_SHE),
    minerReservedNanos: reserved,
    minerReserved: reserved / NANOS_PER_SHE,
    minerReservedDisplay: formatShe(reserved / NANOS_PER_SHE),
    custodySpendableNanos: Math.max(0, custodyN),
    custodyDisplay: formatShe(Math.max(0, custodyN) / NANOS_PER_SHE),
    feeSpendableNanos: adminN,
  };
}

export function adminSpendFrom() {
  const pinned = configuredFeeIdentity();
  if (!pinned.ok) {
    const err = new Error('fee_dest_mismatch');
    err.reason = 'fee_dest_mismatch';
    throw err;
  }
  return pinned.feeDest;
}

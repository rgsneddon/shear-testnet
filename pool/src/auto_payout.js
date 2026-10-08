/**
 * Custodial miner payouts. Confirmed pot-share (after 100 bps) plus
 * fee-free hash bonus accumulate until π SHE, then the pool sends the
 * whole unpaid sum to the miner ssa1 dest and pays the levy itself.
 *
 * No miner signature. The send is from the pool dest (operator key on
 * the box). Logging in as `ssa1.worker` is the standing payout instruction.
 * A one-time wallet sign would only restate that dest; it is not required.
 */
import { PI_SHE_NANOS, POOL_FEE_BPS, NANOS_PER_SHE, hashBonusUnitNanos } from '../../crypto/asert.js';
import { isDestAddress } from '../../crypto/address.js';
import { containsShe1, custodialPullAllowed, poolWithdrawTx } from '../../crypto/levy.js';

export { custodialPullAllowed };
import { signSpendTx } from '../../crypto/spend.js';

export const AUTO_PAYOUT_MIN_NANOS = PI_SHE_NANOS;
/** Pool fee dest keeps this much spendable for miner-payout levies. Surplus sweeps to SHEAR_POOL_FEE_PAYOUT_DEST. */
export const POOL_FEE_RESERVE_SHE = 10;
export const POOL_FEE_RESERVE_NANOS = 10 * NANOS_PER_SHE;
export const POOL_FEE_PAYOUT_DEST_ENV = 'SHEAR_POOL_FEE_PAYOUT_DEST';

export function poolFeePayoutDest(env = process.env) {
  const d = String(env?.[POOL_FEE_PAYOUT_DEST_ENV] || '').trim().split('.')[0];
  if (!isMinerSsa1(d)) return '';
  return d;
}

/** Spendable on the pool dest minus unpaid miner PROP minus the 10 SHE levy reserve. */
export function poolFeeSweepNanos({
  spendableNanos = 0,
  unpaidMinerPotNanos = 0,
  reserveNanos = POOL_FEE_RESERVE_NANOS,
} = {}) {
  const have = Math.max(0, Math.floor(Number(spendableNanos) || 0));
  const owed = Math.max(0, Math.floor(Number(unpaidMinerPotNanos) || 0));
  const keep = Math.max(0, Math.floor(Number(reserveNanos) || 0));
  const surplus = have - owed - keep;
  if (!(surplus > 0)) {
    return { ok: false, reason: 'reserve', nanos: 0, have, owed, keep };
  }
  return { ok: true, nanos: surplus, have, owed, keep };
}

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

/** Hash-bonus credit. No pool fee. Unit is clamped ≥ 1. */
export function hashCreditNanos(units, unit) {
  const u = Math.max(0, Math.floor(Number(units) || 0));
  return u * hashBonusUnitNanos(unit);
}

export function shouldAutoPayout({ confirmedNanos, dest } = {}) {
  if (!isMinerSsa1(dest)) return { ok: false, reason: 'need_ssa1' };
  const n = Math.floor(Number(confirmedNanos) || 0);
  if (n < AUTO_PAYOUT_MIN_NANOS) {
    return {
      ok: false,
      reason: 'below_min',
      have: n,
      need: AUTO_PAYOUT_MIN_NANOS,
    };
  }
  return { ok: true, nanos: n, dest: String(dest).trim().split('.')[0] };
}

/**
 * Miner receives `nanos` in full. `fee` is extra, sponsored by the pool dest.
 */
export function buildAutoPayoutTx({ from, to, nanos, fee = 0, id, spendKey } = {}) {
  if (!custodialPullAllowed()) return { ok: false, reason: 'custodial_pull' };
  const gate = shouldAutoPayout({ confirmedNanos: nanos, dest: to });
  if (!gate.ok) return gate;
  if (!isDestAddress(from) || containsShe1(from)) return { ok: false, reason: 'bad_pool_dest' };
  if (!spendKey) return { ok: false, reason: 'need_spend_key' };
  const L = Math.max(0, Math.floor(Number(fee) || 0));
  const tx = poolWithdrawTx({
    from,
    to: gate.dest,
    nanos: gate.nanos,
    fee: L,
    id: id || `auto-payout-${Date.now()}`,
  });
  tx.poolPaysFee = true;
  tx.sponsor = from;
  signSpendTx(tx, spendKey);
  if (containsShe1(tx)) return { ok: false, reason: 'she1_on_chain' };
  return { ok: true, tx, dest: gate.dest, nanos: gate.nanos, fee: L };
}

/** Operator surplus above the 10 SHE reserve. Dest comes from SHEAR_POOL_FEE_PAYOUT_DEST. */
export function buildPoolFeeSweepTx({ from, to, nanos, fee = 0, id, spendKey } = {}) {
  if (!custodialPullAllowed()) return { ok: false, reason: 'custodial_pull' };
  if (!isDestAddress(from) || containsShe1(from)) return { ok: false, reason: 'bad_pool_dest' };
  if (!isMinerSsa1(to) || String(to).trim().split('.')[0] === String(from).trim().split('.')[0]) {
    return { ok: false, reason: 'bad_fee_dest' };
  }
  if (!spendKey) return { ok: false, reason: 'need_spend_key' };
  const n = Math.max(0, Math.floor(Number(nanos) || 0));
  if (!(n > 0)) return { ok: false, reason: 'none' };
  const L = Math.max(0, Math.floor(Number(fee) || 0));
  const tx = poolWithdrawTx({
    from,
    to: String(to).trim().split('.')[0],
    nanos: n,
    fee: L,
    id: id || `pool-fee-sweep-${Date.now()}`,
  });
  tx.poolPaysFee = true;
  tx.sponsor = from;
  signSpendTx(tx, spendKey);
  if (containsShe1(tx)) return { ok: false, reason: 'she1_on_chain' };
  return { ok: true, tx, dest: tx.to, nanos: n, fee: L };
}

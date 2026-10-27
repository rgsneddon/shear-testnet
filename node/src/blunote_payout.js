/**
 * BluNotes (R28) block payout. Pure: every node computes the same result
 * from public data, so the payout needs no coinbase rows to check.
 *
 * Per block, with proven share rows (weight 2^b, one-time key P):
 *   fee      = the pool-fee piece of this subsidy, paid to the pool's own
 *              one-time key when the coinbase names one, else 0;
 *   finder   = the finder half of this block's tx levy;
 *   hash     = min(sum of units x unit, budget)  (D2: scaled in the block);
 *   T        = potPayable - fee + finder + hash, split into k equal pieces;
 *   winners  = k draws by weight, seeded by the block's own PoW hash;
 *   carryOut = the remainder of T.
 * An empty batch draws nothing and mints no floor note (R34): the pot
 * carries, minus the fee. Its finder levy never enters the carry: it is
 * paid with the pool-fee note, or, with no fee key, with the reserve levy
 * note (reserveExtra). So the carry is always pot money.
 * Conservation: minted + carryOut + reserveExtra = potPayable + finder + hash.
 */
import { createHash } from 'node:crypto';
import { BLUNOTE_WINNERS, blunoteNote, drawPieces, drawWinners } from '../../crypto/blunote.js';

const SEED_DST = Buffer.from('shear-blunote-seed-v1');

export function drawSeed(powHash) {
  const h = Buffer.from(powHash || []);
  if (h.length !== 32) throw new Error('powHash must be 32 bytes');
  return createHash('sha256').update(SEED_DST).update(h).digest();
}

function nat(v, what) {
  const n = BigInt(v);
  if (n < 0n) throw new Error(`${what} must be >= 0`);
  return n;
}

/** Hash bonus of a batch: units x unit, capped by the budget (D2). */
export function blunoteHashNanos(shares, unitNanos, budgetNanos = null) {
  let units = 0n;
  for (const r of shares || []) units += BigInt(r.units ?? (1n << BigInt(Math.floor(Number(r.shareBits ?? 0)))));
  let hash = units * nat(unitNanos, 'unitNanos');
  if (budgetNanos != null) {
    const cap = nat(budgetNanos, 'budgetNanos');
    if (hash > cap) hash = cap;
  }
  return hash;
}

/**
 * The parts of a block's payout that are fixed before its PoW: the fee note
 * value, the reserve extra, T, and the carry. The template and verify share it.
 */
export function blunotePlan({ shareCount, potPayable, feeNanos = 0n, feeKey = null, finderLevy = 0n, hashNanos = 0n, k = BLUNOTE_WINNERS }) {
  const pot = nat(potPayable, 'potPayable');
  const finder = nat(finderLevy, 'finderLevy');
  const fee = feeKey ? nat(feeNanos, 'feeNanos') : 0n;
  if (fee > pot) throw new Error('fee above the pot');
  if (!shareCount) {
    return {
      feeV: feeKey ? fee + finder : 0n,
      reserveExtra: feeKey ? 0n : finder,
      T: 0n,
      piece: 0n,
      carryOut: pot - fee,
    };
  }
  const T = pot - fee + finder + BigInt(hashNanos);
  const { piece, carry } = drawPieces(T, k);
  return { feeV: fee, reserveExtra: 0n, T, piece, carryOut: carry };
}

/**
 * @param {object} a
 * @param {Array} a.shares proven rows from verifyBluShareBatch, in batch order
 * @param {Buffer} a.powHash the block's PoW hash
 * @param {bigint|number} a.potPayable subsidy plus the parent's carry
 * @param {bigint|number} a.feeNanos pool fee for this block (0 when no fee key)
 * @param {object|null} a.feeKey { R, P, viewTag } of the pool's fee key, or null
 * @param {bigint|number} a.finderLevy the finder half of this block's tx levy
 * @param {bigint|number} a.unitNanos hash-bonus nanos per unit
 * @param {bigint|number|null} a.budgetNanos hash budget for this block; null is no cap
 * @param {number} a.k winners per block
 */
export function blunoteSettle({
  shares = [],
  powHash,
  potPayable,
  feeNanos = 0n,
  feeKey = null,
  finderLevy = 0n,
  unitNanos,
  budgetNanos = null,
  k = BLUNOTE_WINNERS,
}) {
  const rows = Array.isArray(shares) ? shares : [];
  const hash = rows.length ? blunoteHashNanos(rows, unitNanos, budgetNanos) : 0n;
  const plan = blunotePlan({ shareCount: rows.length, potPayable, feeNanos, feeKey, finderLevy, hashNanos: hash, k });
  const notes = [];
  if (plan.feeV > 0n) {
    const n = blunoteNote(feeKey.P, plan.feeV);
    // The coinbase rule already refused a fee key that is not a point.
    if (!n) throw new Error('blunote_fee_key');
    notes.push({ ...n, R: Buffer.from(feeKey.R), viewTag: Number(feeKey.viewTag || 0) & 0xff, kind: 'pool-fee' });
  }
  const out = [];
  let paid = 0n;
  if (rows.length) {
    const winners = drawWinners(drawSeed(powHash), rows.map((r) => BigInt(r.weight)), k);
    for (const w of winners) {
      const row = rows[w.index];
      const v = plan.piece * BigInt(w.m);
      if (v === 0n) continue;
      const n = blunoteNote(row.shareP, v);
      // verifyBluShareBatch refused any P that is not a point.
      if (!n) throw new Error('blunote_share_key');
      paid += v;
      const note = { ...n, R: Buffer.from(row.shareR), viewTag: Number(row.viewTag || 0) & 0xff, kind: 'blunote', index: w.index, m: w.m };
      notes.push(note);
      out.push(note);
    }
  }
  const minted = plan.feeV + paid;
  const pot = BigInt(potPayable);
  if (minted + plan.carryOut + plan.reserveExtra !== pot + BigInt(finderLevy) + hash) throw new Error('blunote conservation');
  return {
    notes,
    winners: out,
    piece: plan.piece,
    hashNanos: hash,
    T: plan.T,
    minted,
    carryOut: plan.carryOut,
    reserveExtra: plan.reserveExtra,
    feeV: plan.feeV,
  };
}

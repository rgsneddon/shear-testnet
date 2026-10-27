/**
 * BluNotes (R28) block payout. Pure: every node computes the same result
 * from public data, so the payout needs no coinbase rows to check.
 *
 * Per block, with proven share rows (weight 2^b, one-time key P):
 *   fee      = the pool-fee piece of this subsidy, paid to the pool's own
 *              one-time key when the coinbase names one, else 0;
 *   hash     = min(sum of units x unit, budget)  (D2: scaled in the block);
 *   T        = potPayable - fee + hash, split into k equal pieces;
 *   winners  = k draws by weight, seeded by the block's own PoW hash;
 *   carryOut = the remainder of T, plus any piece whose P is not a point.
 * An empty batch draws nothing and mints no floor note (R34): the pot
 * carries, minus the fee. Conservation: minted + carryOut = potPayable + hash.
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

/**
 * @param {object} a
 * @param {Array} a.shares proven rows from verifyBluShareBatch, in batch order
 * @param {Buffer} a.powHash the block's PoW hash
 * @param {bigint|number} a.potPayable subsidy plus the parent's carry
 * @param {bigint|number} a.feeNanos pool fee for this block (0 when no fee key)
 * @param {object|null} a.feeKey { R, P, viewTag } of the pool's fee key, or null
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
  unitNanos,
  budgetNanos = null,
  k = BLUNOTE_WINNERS,
}) {
  const pot = nat(potPayable, 'potPayable');
  let fee = feeKey ? nat(feeNanos, 'feeNanos') : 0n;
  if (fee > pot) throw new Error('fee above the pot');
  const notes = [];
  if (fee > 0n) {
    const n = blunoteNote(feeKey.P, fee);
    // A fee key that is not a point forfeits the fee to the miners' pot.
    if (n) notes.push({ ...n, R: Buffer.from(feeKey.R), viewTag: Number(feeKey.viewTag || 0) & 0xff, kind: 'pool-fee' });
    else fee = 0n;
  }
  const rows = Array.isArray(shares) ? shares : [];
  if (!rows.length) {
    return {
      notes,
      winners: [],
      piece: 0n,
      hashNanos: 0n,
      T: 0n,
      minted: fee,
      carryOut: pot - fee,
    };
  }
  const unit = nat(unitNanos, 'unitNanos');
  let units = 0n;
  for (const r of rows) units += BigInt(r.units);
  let hash = units * unit;
  if (budgetNanos != null) {
    const cap = nat(budgetNanos, 'budgetNanos');
    if (hash > cap) hash = cap;
  }
  const T = pot - fee + hash;
  const { piece, carry } = drawPieces(T, k);
  const winners = drawWinners(drawSeed(powHash), rows.map((r) => BigInt(r.weight)), k);
  let paid = 0n;
  let lost = 0n;
  const out = [];
  for (const w of winners) {
    const row = rows[w.index];
    const v = piece * BigInt(w.m);
    if (v === 0n) continue;
    const n = blunoteNote(row.shareP, v);
    if (!n) { lost += v; continue; }
    paid += v;
    const note = { ...n, R: Buffer.from(row.shareR), viewTag: Number(row.viewTag || 0) & 0xff, kind: 'blunote', index: w.index, m: w.m };
    notes.push(note);
    out.push(note);
  }
  const minted = fee + paid;
  const carryOut = carry + lost;
  if (minted + carryOut !== pot + hash) throw new Error('blunote conservation');
  return { notes, winners: out, piece, hashNanos: hash, T, minted, carryOut };
}

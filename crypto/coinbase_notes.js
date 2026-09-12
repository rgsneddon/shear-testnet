/**
 * Recover dest + nanos for confidential coinbase vouts from shareBatch + proofs.
 * Public dest20+nanos stay off the sealed vout; Tree-A units still imply values.
 */
import { BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS, POOL_FEE_BPS } from './asert.js';
import { isDestAddress, hash20FromAddress } from './address.js';
import { collateShareUnits } from './share_batch.js';
import { noteCommitOfDest20, verifySealedNote } from './note.js';

export function expectedCoinbasePays(shareBatch, {
  miner,
  poolDest,
  hashBonusNanos = HASH_BONUS_NANOS,
} = {}) {
  const batch = Array.isArray(shareBatch) ? shareBatch : [];
  const units = collateShareUnits(batch);
  const out = [];
  for (const [dest, u] of units) {
    const nanos = u * hashBonusNanos;
    if (nanos > 0) out.push({ address: dest, nanos, kind: 'hash' });
  }
  const pool = poolDest && isDestAddress(poolDest) ? poolDest : '';
  const fee = pool ? Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000) : 0;
  const rest = BLOCK_SUBSIDY_NANOS - fee;
  const total = [...units.values()].reduce((a, n) => a + n, 0);
  if (!total) {
    if (miner && isDestAddress(miner)) {
      out.push({ address: miner, nanos: BLOCK_SUBSIDY_NANOS, kind: 'pot' });
    }
    return out;
  }
  let paid = 0;
  const dests = [...units.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 0; i < dests.length; i += 1) {
    const [addr, n] = dests[i];
    const nanos = i === dests.length - 1 ? rest - paid : Math.floor(rest * n / total);
    paid += nanos;
    if (nanos > 0) out.push({ address: addr, nanos, kind: 'pot' });
  }
  if (pool && fee > 0) out.push({ address: pool, nanos: fee, kind: 'pot' });
  return out;
}

export function matchSealedCoinbaseVout(o, pays) {
  if (!o) return { address: '', nanos: 0, kind: 'pot' };
  const kind = o.kind || 'pot';
  if (!o.commit) {
    return { address: o.address || '', nanos: Math.floor(Number(o.nanos || 0)), kind };
  }
  const nc = Buffer.from(o.noteCommit || []);
  for (const p of pays || []) {
    if ((p.kind || 'pot') !== kind) continue;
    const d20 = hash20FromAddress(p.address);
    if (!d20 || nc.length !== 32) continue;
    if (!nc.equals(noteCommitOfDest20(d20))) continue;
    if (verifySealedNote(o, p.nanos)) return { address: p.address, nanos: p.nanos, kind };
  }
  return { address: '', nanos: 0, kind };
}

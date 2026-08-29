/**
 * Policy mempool: ssa1 user txs and B-spends only.
 * Paid ≥ current base; bounded; requote/drop after retarget.
 * Shares are not in the mempool.
 */
import { isDestAddress, isShearAddress, bech32Hrp } from './address.js';
import { levyNanos, txWeight, nextBaseFee } from './levy.js';

export const MEMPOOL_MAX = 4096;
export const MEMPOOL_KIND_SEND = 'send';
export const MEMPOOL_KIND_B_SPEND = 'b-spend';

export function emptyMempool() {
  return { txs: [], baseFee: 1, max: MEMPOOL_MAX };
}

export function admitMempool(pool, tx, { baseFee } = {}) {
  const book = pool || emptyMempool();
  const base = Math.max(1, Math.floor(Number(baseFee != null ? baseFee : book.baseFee) || 1));
  if (!tx || tx.share || tx.kind === 'share') return { ok: false, reason: 'share_not_mempool' };
  const kind = String(tx.kind || MEMPOOL_KIND_SEND);
  // claim: vault dest → Continuum dest (Join share). Not extra-mint.
  if (kind !== MEMPOOL_KIND_SEND && kind !== MEMPOOL_KIND_B_SPEND && kind !== 'claim') {
    return { ok: false, reason: 'kind' };
  }
  const dests = [];
  if (tx.to) dests.push(tx.to);
  for (const o of tx.vout || []) {
    if (o?.address) dests.push(o.address);
  }
  for (const d of dests) {
    if (isShearAddress(d)) return { ok: false, reason: 'shear1' };
    if (!isDestAddress(d) || bech32Hrp(d) !== 'ssa') return { ok: false, reason: 'dest' };
  }
  const vouts = Math.max(1, (tx.vout || []).length || (tx.to ? 1 : 0));
  const memo = tx.memoCt || tx.memoH ? 1 : 0;
  const bFlag = kind === MEMPOOL_KIND_B_SPEND || tx.bFlag ? 1 : 0;
  const need = levyNanos(base, txWeight({ vouts, memoChunks: memo, bFlag }));
  const paid = Math.floor(Number(tx.fee || tx.paid || 0));
  if (paid < need) return { ok: false, reason: 'levy', need, paid };
  if ((book.txs || []).length >= (book.max || MEMPOOL_MAX)) return { ok: false, reason: 'full' };
  book.txs.push({ ...tx, fee: paid, kind });
  return { ok: true, tx: book.txs[book.txs.length - 1] };
}

/** After header retarget, drop or mark requote if paid < new base levy. */
export function retargetMempool(pool, nextBase) {
  const book = pool || emptyMempool();
  const base = Math.max(1, Math.floor(Number(nextBase) || 1));
  book.baseFee = base;
  const keep = [];
  const dropped = [];
  for (const tx of book.txs || []) {
    const vouts = Math.max(1, (tx.vout || []).length || (tx.to ? 1 : 0));
    const memo = tx.memoCt || tx.memoH ? 1 : 0;
    const bFlag = tx.kind === MEMPOOL_KIND_B_SPEND || tx.bFlag ? 1 : 0;
    const need = levyNanos(base, txWeight({ vouts, memoChunks: memo, bFlag }));
    if (Math.floor(Number(tx.fee || 0)) < need) {
      dropped.push({ ...tx, requote: need });
    } else {
      keep.push(tx);
    }
  }
  book.txs = keep;
  return { ok: true, dropped, nextBaseFee: nextBaseFee(base, keep.length || 1) };
}

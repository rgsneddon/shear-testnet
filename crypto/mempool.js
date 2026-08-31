/**
 * Policy mempool: ssa1 user txs and B-spends only.
 * Paid ≥ current base; bounded; requote/drop after retarget.
 * Shares are not in the mempool.
 */
import { isDestAddress, isShearAddress, bech32Hrp } from './address.js';
import { levyNanos, levyTaxed, txAmountNanos, nextBaseFee, mempoolDepthBytes, containsShe1 } from './levy.js';

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
  const allowed = new Set([
    MEMPOOL_KIND_SEND,
    MEMPOOL_KIND_B_SPEND,
    'claim',
    'evm-value',
    'pool-withdraw',
    'vortice-register',
  ]);
  if (!allowed.has(kind)) {
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
  if (containsShe1(tx)) return { ok: false, reason: 'she1_on_chain' };
  const depth = mempoolDepthBytes(book.txs);
  const need = levyTaxed({ ...tx, kind }) ? levyNanos(txAmountNanos(tx), { depth }) : 0;
  const paid = Math.floor(Number(tx.fee || tx.paid || 0));
  if (paid < need) return { ok: false, reason: 'levy', need, paid };
  if (levyTaxed({ ...tx, kind }) && tx.maxLevy != null && need > Number(tx.maxLevy)) {
    return { ok: false, reason: 'max_levy', need };
  }
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
    const need = levyTaxed(tx) ? levyNanos(txAmountNanos(tx), { depth: mempoolDepthBytes(keep) }) : 0;
    if (Math.floor(Number(tx.fee || 0)) < need) {
      dropped.push({ ...tx, requote: need });
    } else {
      keep.push(tx);
    }
  }
  book.txs = keep;
  return { ok: true, dropped, nextBaseFee: nextBaseFee(base, keep.length || 1) };
}

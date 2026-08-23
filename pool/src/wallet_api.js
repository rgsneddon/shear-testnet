import { isShearAddress } from '../../crypto/address.js';
import { HASH_BONUS_NANOS, NANOS_PER_SHE, BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { sealedExplorerRows } from '../../crypto/chronoflux.js';

export function nanosToShe(n) {
  return Number(n || 0) / NANOS_PER_SHE;
}

function rowsToHistory(rows, address) {
  const addr = String(address || '').trim();
  let spendableNanos = 0;
  const txs = [];
  for (const r of rows) {
    if (r.to !== addr && r.from !== addr) continue;
    const nanos = Number(r.nanos || 0);
    if (r.from === addr && r.to !== addr) spendableNanos -= nanos;
    else if (r.to === addr) spendableNanos += nanos;
    txs.push({
      id: r.id,
      kind: r.from === addr && r.to !== addr ? (r.kind === 'transfer' ? 'send' : r.kind) : (r.kind === 'transfer' ? 'receive' : r.kind),
      from: r.from,
      to: r.to,
      amount: nanosToShe(nanos),
      height: r.height,
      confirmed: r.confirmed !== false,
    });
  }
  if (spendableNanos < 0) spendableNanos = 0;
  return { spendableNanos, spendable: nanosToShe(spendableNanos), txs };
}

/** History from sealed txs only — never from pruned hash samples. */
export function reconstructOwner(store, address) {
  const addr = String(address || '').trim();
  if (typeof store?.historyFor === 'function') {
    return rowsToHistory(store.historyFor(addr), addr);
  }
  const rows = [];
  for (const b of store.blocks || []) rows.push(...sealedExplorerRows(b));
  return rowsToHistory(rows, addr);
}

export function pendingFor(miners, address) {
  const addr = String(address || '').trim();
  const m = miners?.get?.(addr);
  const hashes = Number(m?.roundHashes || 0);
  return { shares: hashes, amount: nanosToShe(hashes * HASH_BONUS_NANOS) };
}

export function handleWalletApi(url, method, body, { store, miners, queueSend }) {
  const path = url.pathname;
  const verb = String(method || 'GET').toUpperCase();
  if (path === '/api/wallet/balance' && verb === 'GET') {
    const address = url.searchParams.get('address') || '';
    if (!isShearAddress(address)) {
      return { status: 400, json: { ok: false, reason: 'bad_address' } };
    }
    const rec = reconstructOwner(store, address);
    const pending = pendingFor(miners, address);
    return {
      status: 200,
      json: {
        ok: true,
        coin: 'SHE',
        address,
        balance: rec.spendable,
        pending: pending.amount,
        reconstructed: rec.spendable,
      },
    };
  }
  if ((path === '/api/wallet/history' || path === '/api/explorer/history') && verb === 'GET') {
    const address = url.searchParams.get('address') || '';
    const rec = reconstructOwner(store, address);
    return { status: 200, json: { ok: true, coin: 'SHE', address, txs: rec.txs } };
  }
  if (path === '/api/wallet/send' && verb === 'POST') {
    const from = String(body.from || '');
    const to = String(body.to || '');
    const amount = Number(body.amount);
    if (!isShearAddress(from) || !isShearAddress(to) || !(amount > 0)) {
      return { status: 400, json: { ok: false, reason: 'bad_send' } };
    }
    const rec = reconstructOwner(store, from);
    const nanos = Math.round(amount * NANOS_PER_SHE);
    if (rec.spendableNanos < nanos) {
      return { status: 400, json: { ok: false, reason: 'insufficient' } };
    }
    const tx = queueSend({ from, to, nanos, amount });
    return {
      status: 200,
      json: {
        ok: true,
        tx: { id: tx.id, from, to, amount, kind: 'send', confirmed: false },
        fromBalance: nanosToShe(rec.spendableNanos - nanos),
      },
    };
  }
  return null;
}

export { BLOCK_SUBSIDY_NANOS };

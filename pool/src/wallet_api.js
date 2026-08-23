import { isShearAddress } from '../../crypto/address.js';
import { HASH_BONUS_NANOS, NANOS_PER_SHE, BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { sealedExplorerRows } from '../../crypto/chronoflux.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { lag1Continuity } from '../../node/src/chain.js';

export function nanosToShe(n) {
  return Number(n || 0) / NANOS_PER_SHE;
}

function rowsToHistory(rows, addresses) {
  const set = new Set((Array.isArray(addresses) ? addresses : [addresses]).map((a) => String(a || '').trim()));
  let spendableNanos = 0;
  const txs = [];
  for (const r of rows) {
    if (!set.has(r.to) && !set.has(r.from)) continue;
    const nanos = Number(r.nanos || 0);
    if (set.has(r.from) && !set.has(r.to)) spendableNanos -= nanos;
    else if (set.has(r.to)) spendableNanos += nanos;
    txs.push({
      id: r.id,
      kind: set.has(r.from) && !set.has(r.to) ? (r.kind === 'transfer' ? 'send' : r.kind) : (r.kind === 'transfer' ? 'receive' : r.kind),
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

function destSetFor(store, address) {
  const addr = String(address || '').trim();
  const dests = new Set([addr]);
  const blocks = store.blocks || [];
  for (let i = 0; i < blocks.length; i += 1) {
    const prev = i ? blocks[i - 1] : null;
    dests.add(destForLogin(addr, {
      continuityRoot: lag1Continuity(prev?.header),
      height: blocks[i].height,
    }));
  }
  return dests;
}

/** History from sealed txs only — never from pruned hash samples. Dest vouts included. */
export function reconstructOwner(store, address, { viewKey } = {}) {
  const addr = String(address || '').trim();
  const dests = destSetFor(store, addr);
  const rows = [];
  if (typeof store?.historyFor === 'function') {
    for (const d of dests) rows.push(...store.historyFor(d));
  } else {
    for (const b of store.blocks || []) rows.push(...sealedExplorerRows(b));
  }
  return rowsToHistory(rows, [...dests]);
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
    const viewKey = url.searchParams.get('viewKey') || '';
    if (path === '/api/explorer/history' && !viewKey) {
      return { status: 200, json: { ok: true, coin: 'SHE', address, txs: [], amountsOnly: true } };
    }
    const rec = reconstructOwner(store, address, { viewKey });
    return { status: 200, json: { ok: true, coin: 'SHE', address, txs: rec.txs, amountsOnly: true } };
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

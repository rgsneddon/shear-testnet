import { isDestAddress } from '../../crypto/address.js';
import { HASH_BONUS_NANOS, NANOS_PER_SHE, BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { sealedExplorerRows } from '../../crypto/chronoflux.js';
import { explorerRowPublic } from '../../crypto/flow_sheet.js';

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
    const pub = explorerRowPublic({
      ...r,
      memo: !!(r.memoCt || r.memo),
    });
    txs.push({
      id: r.id,
      kind: set.has(r.from) && !set.has(r.to) ? (r.kind === 'transfer' ? 'send' : r.kind) : (r.kind === 'transfer' ? 'receive' : r.kind),
      from: r.from,
      to: r.to,
      amount: nanosToShe(nanos),
      height: r.height,
      confirmed: r.confirmed !== false,
      memo: pub.memo === true,
      memoCt: r.memoCt || undefined,
    });
  }
  if (spendableNanos < 0) spendableNanos = 0;
  return { spendableNanos, spendable: nanosToShe(spendableNanos), txs };
}

export function reconstructOwner(store, address) {
  const addr = String(address || '').trim();
  const dests = [addr];
  const rows = [];
  if (typeof store?.historyFor === 'function') {
    rows.push(...store.historyFor(addr));
  } else {
    for (const b of store.blocks || []) rows.push(...sealedExplorerRows(b));
  }
  return rowsToHistory(rows, dests);
}

export function pendingFor(miners, address) {
  const addr = String(address || '').trim();
  const m = miners?.get?.(addr);
  const hashes = Number(m?.roundHashes || 0);
  return { shares: hashes, amount: nanosToShe(hashes * HASH_BONUS_NANOS) };
}

function isPublicParty(a) {
  const s = String(a || '');
  if (s === 'coinbase') return true;
  return isDestAddress(s);
}

export function publicExplorerTxs(store) {
  const rows = [];
  for (const b of store.blocks || []) rows.push(...sealedExplorerRows(b));
  return rows
    .filter((r) => isPublicParty(r.to) && isPublicParty(r.from))
    .map((r) => explorerRowPublic({
      id: r.id,
      kind: r.kind,
      from: r.from,
      to: r.to,
      amount: nanosToShe(r.nanos),
      height: r.height,
      confirmed: r.confirmed !== false,
      memo: !!(r.memoCt || r.memo),
      memoCt: r.memoCt,
    }));
}

export function searchExplorerTxs(store, q = {}) {
  let txs = publicExplorerTxs(store);
  const id = String(q.id || '').trim();
  const height = q.height != null && String(q.height).trim() !== '' ? Number(q.height) : NaN;
  const from = q.from != null && String(q.from).trim() !== '' ? Number(q.from) : NaN;
  const to = q.to != null && String(q.to).trim() !== '' ? Number(q.to) : NaN;
  if (id) {
    txs = txs.filter((t) => String(t.id) === id || String(t.id).includes(id));
  } else if (Number.isFinite(height)) {
    txs = txs.filter((t) => Number(t.height) === height);
  } else if (Number.isFinite(from) || Number.isFinite(to)) {
    const lo = Number.isFinite(from) ? from : -Infinity;
    const hi = Number.isFinite(to) ? to : Infinity;
    txs = txs.filter((t) => Number(t.height) >= lo && Number(t.height) <= hi);
  }
  return txs;
}

export function explorerCirculation(store) {
  const txs = publicExplorerTxs(store);
  const bal = new Map();
  let emitted = 0;
  for (const t of txs) {
    const amt = Number(t.amount) || 0;
    if (t.from === 'coinbase') {
      emitted += amt;
      if (isDestAddress(t.to)) bal.set(t.to, (bal.get(t.to) || 0) + amt);
    } else {
      if (isDestAddress(t.from)) bal.set(t.from, (bal.get(t.from) || 0) - amt);
      if (isDestAddress(t.to)) bal.set(t.to, (bal.get(t.to) || 0) + amt);
    }
  }
  for (const [k, v] of [...bal.entries()]) {
    if (!(v > 0) || !isDestAddress(k)) bal.delete(k);
  }
  const circulating = [...bal.values()].reduce((a, b) => a + b, 0);
  const holders = [...bal.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, amount], i) => ({
      rank: i + 1,
      tag,
      amount,
      share: circulating ? amount / circulating : 0,
    }));
  return {
    circulating,
    emitted,
    holderCount: bal.size,
    holders,
  };
}

export function handleWalletApi(url, method, body, { store, miners, queueSend }) {
  const path = url.pathname;
  const verb = String(method || 'GET').toUpperCase();
  if (path === '/api/wallet/balance' && verb === 'GET') {
    const address = url.searchParams.get('address') || '';
    if (!isDestAddress(address)) {
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
        height: store.tip?.()?.height || 0,
      },
    };
  }
  if (path === '/api/wallet/register' && verb === 'POST') {
    return { status: 404, json: { ok: false, reason: 'register_disabled' } };
  }
  if (path === '/api/explorer/history' && verb === 'GET') {
    const txs = publicExplorerTxs(store);
    return { status: 200, json: { ok: true, txs, amountsOnly: true } };
  }
  if (path === '/api/explorer/search' && verb === 'GET') {
    const txs = searchExplorerTxs(store, {
      height: url.searchParams.get('height') || url.searchParams.get('block'),
      id: url.searchParams.get('id'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
    return { status: 200, json: { ok: true, txs, amountsOnly: true } };
  }
  if (path === '/api/explorer/circulation' && verb === 'GET') {
    const circ = explorerCirculation(store);
    return { status: 200, json: { ok: true, coin: 'SHE', ...circ } };
  }
  if (path === '/api/wallet/history' && verb === 'GET') {
    const address = url.searchParams.get('address') || '';
    if (!isDestAddress(address)) {
      return { status: 400, json: { ok: false, reason: 'bad_address' } };
    }
    const rec = reconstructOwner(store, address);
    return { status: 200, json: { ok: true, coin: 'SHE', address, txs: rec.txs, amountsOnly: true } };
  }
  if (path === '/api/wallet/send' && verb === 'POST') {
    const from = String(body.from || '');
    const to = String(body.to || '');
    const amount = Number(body.amount);
    if (!isDestAddress(from) || !isDestAddress(to) || !(amount > 0)) {
      return { status: 400, json: { ok: false, reason: 'bad_send' } };
    }
    const rec = reconstructOwner(store, from);
    const nanos = Math.round(amount * NANOS_PER_SHE);
    if (rec.spendableNanos < nanos) {
      return { status: 400, json: { ok: false, reason: 'insufficient' } };
    }
    const memoCt = body.memoCt || null;
    const tx = queueSend({ from, to, nanos, amount, memoCt });
    return {
      status: 200,
      json: {
        ok: true,
        tx: { id: tx.id, from, to, amount, kind: 'send', confirmed: false, memo: !!memoCt },
        fromBalance: nanosToShe(rec.spendableNanos - nanos),
      },
    };
  }
  return null;
}

export { BLOCK_SUBSIDY_NANOS };

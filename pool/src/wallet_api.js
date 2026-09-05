import { createHash } from 'node:crypto';
import { isDestAddress, isPaymentCode, isShearAddress, payoutDest } from '../../crypto/address.js';
import {
  HASH_BONUS_NANOS,
  NANOS_PER_SHE,
  BLOCK_SUBSIDY_NANOS,
  TARGET_BLOCK_INTERVAL_MS,
  SPENDABLE_CONFIRMATIONS,
  MIN_CONFIRMS_POLICY,
  RESERVE_PROGRAM,
  extraMintAllowed,
} from '../../crypto/asert.js';
import { portalRewards, publicVaultView, lockTx } from '../../crypto/reserve_vault.js';
import {
  levyNanos,
  levyTaxed,
  txWeight,
  mempoolPressure,
  mempoolDepthBytes,
  poolPayoutDest,
  poolWithdrawTx,
  verifyPoolWithdrawOffchain,
  containsShe1,
} from '../../crypto/levy.js';
import { flowSendNeedsOpen, verifyDestOpening, fundedDebit, openingForSpentDest } from '../../crypto/spend.js';
import { isPinnedProgram, listPublicVortices } from '../../crypto/vortex.js';
import { sealedExplorerRows, collateSamples, isSpendableHeight, flowConfirmations } from '../../crypto/chronoflux.js';
import { explorerRowPublic, FLOW_PERSONAL, CLOSURE_PERSONAL } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { roundActualHashes } from './hash_credit.js';

export function nanosToShe(n) {
  return Number(n || 0) / NANOS_PER_SHE;
}

function publicTxView(t) {
  return {
    id: t.id,
    kind: t.kind,
    amount: t.amount,
    height: t.height,
    confirmed: t.confirmed !== false,
    memo: t.memo === true,
  };
}

/**
 * 1HASH=1TX: fold hash txs into the blockfound they settled on.
 * Shearview lists blockfound. Resistance CLI shows hash threads.
 * Public rows never carry dests.
 */
export function rollupDestTxs(txs, { revealDest = true } = {}) {
  const rest = [];
  const blocks = new Map();
  const unit = HASH_BONUS_NANOS / NANOS_PER_SHE;
  for (const t of txs || []) {
    const kind = String(t.kind || '');
    if (
      kind === 'hash' ||
      kind === 'coinbase' ||
      kind === 'pot' ||
      kind === 'mine' ||
      kind === 'blockfound'
    ) {
      const dest = String(t.to || '');
      const height = Number(t.height) || 0;
      const key = `${dest}|${height}`;
      const prev = blocks.get(key) || { dest, height, pot: 0, hash: 0, threads: 0 };
      const amt = Number(t.amount) || 0;
      if (kind === 'hash') {
        prev.hash += amt;
        const th = Number(t.threads);
        prev.threads += Number.isFinite(th) && th > 0
          ? th
          : (unit > 0 ? Math.round(amt / unit) : 0);
      } else if (kind === 'mine' || kind === 'blockfound') {
        prev.pot += amt - (Number(t.hashAmount) || 0);
        prev.hash += Number(t.hashAmount) || 0;
        prev.threads += Number(t.threads) || Number(t.rounds) || 0;
        if (kind === 'mine' && !t.hashAmount) prev.pot += 0;
      } else {
        prev.pot += amt;
      }
      blocks.set(key, prev);
      continue;
    }
    rest.push(t);
  }
  for (const b of blocks.values()) {
    rest.push({
      id: revealDest && b.dest ? `blockfound:${b.height}:${b.dest}` : `blockfound:${b.height}`,
      kind: 'blockfound',
      from: revealDest ? 'coinbase' : undefined,
      to: revealDest ? b.dest : undefined,
      amount: b.pot + b.hash,
      hashAmount: b.hash,
      threads: b.threads,
      height: b.height,
      confirmed: true,
      memo: false,
    });
  }
  return rest;
}

function rowsToHistory(rows, addresses, tipHeight = 0) {
  const set = new Set((Array.isArray(addresses) ? addresses : [addresses]).map((a) => String(a || '').trim()));
  let spendableNanos = 0;
  const txs = [];
  const tip = Number(tipHeight) || 0;
  for (const r of rows) {
    if (!set.has(r.to) && !set.has(r.from)) continue;
    const nanos = Number(r.nanos || 0);
    const mature = isSpendableHeight(r.height, tip);
    if (mature) {
      if (set.has(r.from) && !set.has(r.to)) spendableNanos -= nanos;
      else if (set.has(r.to)) spendableNanos += nanos;
    }
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
      confirmed: mature,
      confirmations: flowConfirmations(r.height, tip),
      spendableAfter: SPENDABLE_CONFIRMATIONS,
      memo: pub.memo === true,
      memoCt: r.memoCt || undefined,
    });
  }
  if (spendableNanos < 0) spendableNanos = 0;
  return { spendableNanos, spendable: nanosToShe(spendableNanos), txs };
}

export function ownerDests(address) {
  const addr = String(address || '').trim();
  const out = new Set();
  if (addr) out.add(addr);
  const paid = payoutDest(addr);
  if (paid) out.add(paid);
  return [...out];
}

export function reconstructOwner(store, address) {
  const dests = ownerDests(address);
  const rows = [];
  const seen = new Set();
  const push = (r) => {
    const id = `${r.id}:${r.to}:${r.from}:${r.height}`;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push(r);
  };
  if (typeof store?.historyFor === 'function') {
    for (const d of dests) {
      for (const r of store.historyFor(d) || []) push(r);
    }
  } else {
    for (const b of store.blocks || []) {
      for (const r of sealedExplorerRows(b)) push(r);
    }
  }
  const tipH = Number(store?.tip?.()?.height || (store.blocks || []).at(-1)?.height || 0);
  const rec = rowsToHistory(rows, dests, tipH);
  let nanos = rec.spendableNanos;
  const destSet = new Set(dests);
  for (const tx of store?.mempool || []) {
    const d = fundedDebit(tx);
    if (d && destSet.has(d.from)) nanos -= d.nanos;
  }
  if (nanos < 0) nanos = 0;
  return { ...rec, spendableNanos: nanos, spendable: nanosToShe(nanos) };
}

export function pendingFor(miners, address) {
  const dests = new Set(ownerDests(address));
  let hashes = 0;
  const book = miners && typeof miners.values === 'function' ? [...miners.values()] : [];
  for (const m of book) {
    const login = String(m?.login || m?.workerKey || '');
    const dest = payoutDest(login);
    if (dests.has(login) || (dest && dests.has(dest)) || dests.has(login.split('.')[0])) {
      hashes += roundActualHashes(m);
    }
  }
  return { shares: hashes, amount: nanosToShe(hashes * HASH_BONUS_NANOS) };
}

/** Unconfirmed mempool pays to this dest. Hash bonus stays in [pendingFor]. */
export function mempoolIncoming(store, address) {
  const dests = new Set(ownerDests(address));
  const rows = [];
  for (const m of store?.mempool || []) {
    const to = String(m?.to || '');
    const paid = payoutDest(to) || to;
    if (!dests.has(to) && !dests.has(paid)) continue;
    const amount = Number(m.amount) > 0 ? Number(m.amount) : nanosToShe(m.nanos);
    if (!(amount > 0)) continue;
    const from = String(m.from || '');
    rows.push({
      id: String(m.id || ''),
      from: payoutDest(from) || from,
      to: paid,
      amount,
      kind: 'receive',
      confirmed: false,
    });
  }
  return rows.filter((r) => r.id);
}

function isPublicParty(a) {
  const s = String(a || '');
  if (s === 'coinbase') return true;
  return isDestAddress(s);
}

function blockAtMs(block) {
  try {
    return Number(decodeHeader(Buffer.from(block.header)).timestamp) || 0;
  } catch {
    return 0;
  }
}

/** One row per confirmed block. Sum of sealed coinbase (pot + hash bonus). No in-round hashes. */
function confirmedBlockRow(b) {
  const rows = sealedExplorerRows(b);
  const nanos = rows.reduce((a, r) => a + Number(r.nanos || 0), 0);
  const hid = Buffer.isBuffer(b?.hash)
    ? b.hash.toString('hex')
    : String(b?.hash || b?.height || '');
  const rawTo = String(b?.miner || rows.find((r) => r.to)?.to || '');
  const dest = isShearAddress(rawTo) ? '' : (payoutDest(rawTo) || (isDestAddress(rawTo) ? rawTo : ''));
  return {
    id: hid,
    kind: 'block',
    from: 'coinbase',
    to: dest,
    amount: nanosToShe(nanos),
    asset: 'SHE',
    height: Number(b?.height || 0),
    at: blockAtMs(b),
  };
}

export function confirmedBlockTxs(store, limit = 30) {
  const list = Array.isArray(store?.blocks) ? store.blocks : [];
  const unlimited = limit === Infinity;
  const n = unlimited ? list.length : Math.max(1, Math.min(10000, Math.floor(Number(limit) || 30)));
  const out = [];
  for (let i = list.length - 1; i >= 0 && out.length < n; i -= 1) {
    out.push(confirmedBlockRow(list[i]));
  }
  return out;
}

export function publicExplorerTxs(store) {
  return confirmedBlockTxs(store, 30);
}

/** Last N confirmed blocks only. No hash-bonus rows and no pot-split lines. */
export function poolRecentBlockTxs(store, limit = 30) {
  return confirmedBlockTxs(store, limit);
}

function publicDest(a) {
  const s = String(a || '');
  if (s === 'coinbase') return 'coinbase';
  if (isShearAddress(s)) return '';
  return payoutDest(s) || (isDestAddress(s) ? s : '');
}

function hex32(buf) {
  try {
    return Buffer.from(buf).toString('hex');
  } catch {
    return '';
  }
}

export function findSealedBlock(store, q) {
  const id = String(q || '').trim();
  const list = Array.isArray(store?.blocks) ? store.blocks : [];
  if (!id) return null;
  if (/^\d+$/.test(id)) {
    const h = Number(id);
    return list.find((b) => Number(b.height) === h) || null;
  }
  const want = id.toLowerCase();
  for (const b of list) {
    const hid = Buffer.isBuffer(b.hash) ? b.hash.toString('hex') : String(b.hash || '');
    if (hid.toLowerCase() === want || hid.toLowerCase().startsWith(want)) return b;
  }
  return null;
}

/** Public CTF CLI for one confirmed block. No rest-frame, silent ID, view-key, or memo body. */
export function publicBlockDetail(store, id) {
  const b = findSealedBlock(store, id);
  if (!b) return null;
  const row = confirmedBlockRow(b);
  let hdr = null;
  try { hdr = decodeHeader(Buffer.from(b.header)); } catch { hdr = null; }
  const header = hdr ? {
    version: hdr.version,
    prevBlockHash: hex32(hdr.prevBlockHash),
    merkleRoot: hex32(hdr.merkleRoot),
    continuityRoot: hex32(hdr.continuityRoot),
    timestamp: Number(hdr.timestamp),
    bits: hdr.bits,
    nonce: String(hdr.nonce),
  } : null;
  const outputs = sealedExplorerRows(b).map((r) => ({
    kind: r.kind || 'block',
    from: r.from === 'coinbase' ? 'coinbase' : publicDest(r.from),
    to: publicDest(r.to),
    amount: nanosToShe(r.nanos),
    memo: r.memo === true,
  }));
  const pruned = !!b.samplesPruned;
  const samples = pruned ? [] : collateSamples(b.samples || []).map((s) => ({
    dest: publicDest(s.miner),
    count: Number(s.count) || 0,
  })).filter((s) => s.dest && s.count > 0);
  const lines = [];
  lines.push(`======== SHEAR CTF  tx=${row.id}  ========`);
  lines.push(`kind        ${row.kind}`);
  lines.push(`amount      ${row.amount} SHE`);
  lines.push(`asset       ${row.asset}`);
  lines.push(`height      ${row.height}`);
  lines.push(`from        ${row.from}`);
  lines.push(`to          ${row.to || '(none)'}`);
  lines.push(`time        ${row.at}`);
  lines.push('-- header --');
  if (header) {
    lines.push(`version     ${header.version}`);
    lines.push(`prev        ${header.prevBlockHash}`);
    lines.push(`merkle      ${header.merkleRoot}`);
    lines.push(`continuity  ${header.continuityRoot}`);
    lines.push(`bits        ${header.bits}`);
    lines.push(`nonce       ${header.nonce}`);
  } else {
    lines.push('header      (undecodable)');
  }
  lines.push('-- sealed outputs --');
  if (!outputs.length) lines.push('(none)');
  for (const o of outputs) {
    lines.push(`  ${o.kind.padEnd(10)} ${o.from} -> ${o.to || '(none)'}  ${o.amount} SHE  memo=${o.memo ? 'yes' : 'no'}`);
  }
  lines.push('-- flow samples --');
  if (pruned) lines.push('samples     pruned (counts sealed in continuity root)');
  else if (!samples.length) lines.push('samples     (none)');
  else for (const s of samples) lines.push(`  dest ${s.dest}  count ${s.count}`);
  lines.push('-- CTF domains (public constants) --');
  lines.push(`flow        ${FLOW_PERSONAL}`);
  lines.push(`closure     ${CLOSURE_PERSONAL}`);
  lines.push('-- privacy audit --');
  lines.push('rest-frame  ABSENT');
  lines.push('silent-id   ABSENT');
  lines.push('view-key    ABSENT');
  lines.push('memo-plain  ABSENT');
  lines.push('memo-ct     ABSENT');
  lines.push('closure-G   ABSENT');
  lines.push('conclusion  public explorer shows dest/amount/header only; identity stays in the wallet.');
  lines.push('========');
  return {
    tx: row,
    header,
    outputs,
    samples,
    samplesPruned: pruned,
    cli: lines.join('\n'),
  };
}

export function searchExplorerTxs(store, q = {}) {
  const id = String(q.id || '').trim();
  const height = q.height != null && String(q.height).trim() !== '' ? Number(q.height) : NaN;
  const from = q.from != null && String(q.from).trim() !== '' ? Number(q.from) : NaN;
  const to = q.to != null && String(q.to).trim() !== '' ? Number(q.to) : NaN;
  if (!id && !Number.isFinite(height) && !Number.isFinite(from) && !Number.isFinite(to)) {
    return confirmedBlockTxs(store, 30);
  }
  let txs = confirmedBlockTxs(store, Infinity);
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

/** All SHE in existence: block pots + hash bonuses + extra mints − burns. Staked coin stays in. */
export function networkSupply(store) {
  let potNanos = 0;
  let hashNanos = 0;
  let extraMintNanos = 0;
  let burnedNanos = 0;
  for (const b of store?.blocks || []) {
    const txs = Array.isArray(b?.txs) ? b.txs : [];
    const cb = txs[0];
    if (cb?.coinbase && Array.isArray(cb.vout)) {
      for (const o of cb.vout) {
        const n = Math.max(0, Math.floor(Number(o.nanos || 0)));
        if (!n) continue;
        const kind = String(o.kind || '');
        if (kind === 'hash') hashNanos += n;
        else if (kind === 'finder-fee' || kind === 'reserve-fee') continue;
        else potNanos += n;
      }
    }
    for (const tx of txs) {
      if (tx?.coinbase) continue;
      const n = Math.max(0, Math.floor(Number(tx.nanos || tx.vout?.[0]?.nanos || 0)));
      if (!n) continue;
      if (tx.mint === true) extraMintNanos += n;
      const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
      if (kind === 'burn') burnedNanos += n;
    }
  }
  const circulatingNanos = potNanos + hashNanos + extraMintNanos - burnedNanos;
  return {
    circulatingNanos: circulatingNanos > 0 ? circulatingNanos : 0,
    potNanos,
    hashNanos,
    extraMintNanos,
    burnedNanos,
    lockedNanos: Math.max(0, Math.floor(Number(store?.reserveVault?.totalLockedNanos || 0))),
  };
}

export function explorerCirculation(store) {
  const rows = [];
  for (const b of store.blocks || []) rows.push(...sealedExplorerRows(b));
  const bal = new Map();
  let emitted = 0;
  for (const r of rows) {
    if (!isPublicParty(r.to) || !isPublicParty(r.from)) continue;
    const amt = nanosToShe(r.nanos);
    if (r.from === 'coinbase') {
      emitted += amt;
      if (isDestAddress(r.to)) bal.set(r.to, (bal.get(r.to) || 0) + amt);
    } else {
      if (isDestAddress(r.from)) bal.set(r.from, (bal.get(r.from) || 0) - amt);
      if (isDestAddress(r.to)) bal.set(r.to, (bal.get(r.to) || 0) + amt);
    }
  }
  for (const [k, v] of [...bal.entries()]) {
    if (!(v > 0) || !isDestAddress(k)) bal.delete(k);
  }
  const circulating = [...bal.values()].reduce((a, b) => a + b, 0);
  const holders = [...bal.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([, amount], i) => ({
      rank: i + 1,
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

function memoTxWeight(m) {
  const vouts = Math.max(1, (m?.vout || []).length || (m?.to ? 1 : 0));
  const memo = m?.memoCt || m?.memoH ? 1 : 0;
  const bFlag = m?.kind === 'b-spend' || m?.bFlag ? 1 : 0;
  return txWeight({ vouts, memoChunks: memo, bFlag });
}

function publicHashTag(login) {
  const dest = String(login || '').trim().split('.')[0];
  return `she1${createHash('sha256').update('shear-miner-tag-v1').update(dest).digest('hex').slice(0, 8)}`;
}

export function openRoundHashRows(miners, hashBonusNanos) {
  const book = miners && typeof miners.values === 'function'
    ? [...miners.values()]
    : (Array.isArray(miners) ? miners : []);
  const unit = Number(hashBonusNanos || HASH_BONUS_NANOS) / NANOS_PER_SHE;
  const rows = [];
  for (const m of book) {
    const login = String(m?.login || m?.workerKey || '');
    if (/\.fee$/i.test(login)) continue;
    const count = roundActualHashes(m);
    if (count < 1) continue;
    const tag = publicHashTag(login);
    rows.push({
      id: `hash-${tag}`,
      kind: 'hash',
      count,
      weight: count,
      fee: 0,
      amount: count * unit,
      included: true,
      priority: 800 + count,
      prime: false,
      tag,
    });
  }
  return rows.sort((a, b) => b.count - a.count);
}

export function mempoolLattice(store, limitOrOpts = 24) {
  const opts = limitOrOpts && typeof limitOrOpts === 'object' ? limitOrOpts : { limit: limitOrOpts };
  const list = Array.isArray(store?.blocks) ? store.blocks : [];
  const tipB = (typeof store?.tip === 'function' ? store.tip() : null) || list[list.length - 1] || null;
  let decoded = {};
  try {
    if (tipB?.header) decoded = decodeHeader(Buffer.from(tipB.header));
  } catch { decoded = {}; }
  const tip = {
    height: Number(tipB?.height || 0),
    hash: hex32(tipB?.hash),
    timestamp: Number(decoded.timestamp || 0),
    baseFee: Number(decoded.baseFee || 1),
  };
  const lastJob = opts.lastJob || null;
  const rec = lastJob?.jobId && store?.jobs && typeof store.jobs.get === 'function'
    ? store.jobs.get(String(lastJob.jobId))
    : null;
  const tplTxs = rec?.tpl?.txs || [];
  const includedIds = new Set(
    tplTxs.filter((t) => t && !t.coinbase).map((t) => String(t.id || '')).filter(Boolean),
  );
  const pending = (store?.mempool || []).map((m) => {
    const weight = memoTxWeight(m);
    const fee = Number(m.fee || 0);
    const included = includedIds.size ? includedIds.has(String(m.id || '')) : true;
    const mass = weight * (1 + Math.log1p(Math.max(0, fee)));
    return {
      id: String(m.id || ''),
      kind: m.kind || 'send',
      fee,
      weight,
      amount: Number(m.amount) > 0 ? Number(m.amount) : nanosToShe(m.nanos),
      to: publicDest(m.to),
      prime: m.kind === 'b-spend' || m.kind === 'send' || m.kind === 'claim',
      included,
      priority: (included ? 400 : 0) + mass,
    };
  }).filter((t) => t.id).sort((a, b) => b.priority - a.priority);
  const unit = Number(opts.hashBonusNanos ?? HASH_BONUS_NANOS) / NANOS_PER_SHE;
  const byTag = new Map();
  for (const r of openRoundHashRows(opts.miners, opts.hashBonusNanos ?? HASH_BONUS_NANOS)) {
    byTag.set(r.tag, r);
  }
  const netRows = typeof store.openRoundRows === 'function' ? store.openRoundRows() : [];
  for (const r of netRows) {
    const tag = String(r.tag || '').toLowerCase();
    if (!/^she1[0-9a-f]{8}$/.test(tag)) continue;
    const count = Math.floor(Number(r.count) || 0);
    if (count < 1) continue;
    const prev = byTag.get(tag);
    if (!prev || count > prev.count) {
      byTag.set(tag, {
        id: `hash-${tag}`,
        kind: 'hash',
        count,
        weight: count,
        fee: 0,
        amount: count * unit,
        included: true,
        priority: 800 + count,
        prime: false,
        tag,
        source: r.source || 'peer',
      });
    }
  }
  const hashRows = [...byTag.values()].sort((a, b) => b.count - a.count);
  const hashes = hashRows.reduce((a, r) => a + (Number(r.count) || 0), 0);
  const pendingBlock = {
    height: Number(lastJob?.height || (tip.height + 1)),
    jobId: String(lastJob?.jobId || ''),
    bits: Number(lastJob?.bits || lastJob?.blockBits || 0),
    hashes,
    weight: hashes + pending.reduce((a, t) => a + (Number(t.weight) || 0), 0),
    fee: pending.reduce((a, t) => a + (Number(t.fee) || 0), 0),
    txs: hashRows,
  };
  const n = Math.max(1, Math.min(48, Math.floor(Number(opts.limit) || 24)));
  const generations = [];
  for (let i = list.length - 1; i >= 0 && generations.length < n; i -= 1) {
    const b = list[i];
    const rows = sealedExplorerRows(b) || [];
    generations.push({
      height: Number(b.height || 0),
      hash: hex32(b.hash),
      confirmations: flowConfirmations(b.height, tip.height),
      spendable: isSpendableHeight(b.height, tip.height),
      txs: rows.map((r) => ({
        id: String(r.id || ''),
        kind: r.kind || 'vout',
        amount: nanosToShe(r.nanos),
        to: publicDest(r.to),
        prime: r.kind === 'transfer' || r.kind === 'b-spend' || r.kind === 'coinbase',
      })),
    });
  }
  return {
    ok: true,
    live: true,
    spendableConfirmations: SPENDABLE_CONFIRMATIONS,
    minConfirmsPolicy: MIN_CONFIRMS_POLICY,
    policy: typeof store?.getpolicy === 'function' ? store.getpolicy() : undefined,
    tip,
    pending,
    pendingBlock,
    targetBlockIntervalMs: TARGET_BLOCK_INTERVAL_MS,
    scope: 'network',
    nodesOnline: Number(opts.nodesOnline) || 0,
    generations,
  };
}

export function handleWalletApi(url, method, body, { store, miners, queueSend, lastJob, poolDest, pendingPulls, completeMinerPull, nodesOnline, poolOpen, poolIdentity } = {}) {
  const path = url.pathname;
  const verb = String(method || 'GET').toUpperCase();
  if ((path === '/api/mempoolPressure' || path === '/api/mempoolpressure') && verb === 'GET') {
    return { status: 200, json: mempoolPressure(store?.mempool || []) };
  }
  if ((path === '/api/mempool' || path === '/api/explorer/mempool') && verb === 'GET') {
    return {
      status: 200,
      json: mempoolLattice(store, {
        miners,
        lastJob,
        nodesOnline,
        hashBonusNanos: store?.reserveVault?.liveHashBonusNanos || HASH_BONUS_NANOS,
      }),
    };
  }
  if (path === '/api/wallet/balance' && verb === 'GET') {
    const address = url.searchParams.get('address') || '';
    if (!isDestAddress(address) && !isPaymentCode(address)) {
      return { status: 400, json: { ok: false, reason: 'bad_address' } };
    }
    const rec = reconstructOwner(store, address);
    const pending = pendingFor(miners, address);
    const incoming = mempoolIncoming(store, address);
    return {
      status: 200,
      json: {
        ok: true,
        coin: 'SHE',
        address,
        balance: rec.spendable,
        pending: pending.amount,
        incoming,
        reconstructed: rec.spendable,
        height: store.tip?.()?.height || 0,
      },
    };
  }
  if (path === '/api/wallet/register' && verb === 'POST') {
    return { status: 404, json: { ok: false, reason: 'register_disabled' } };
  }
  if ((path === '/api/explorer/tx' || path.startsWith('/api/explorer/tx/')) && verb === 'GET') {
    const id = url.searchParams.get('id')
      || decodeURIComponent(path.slice('/api/explorer/tx/'.length).split('/')[0] || '');
    const got = publicBlockDetail(store, id);
    if (!got) return { status: 404, json: { ok: false, reason: 'unknown_tx' } };
    return { status: 200, json: { ok: true, asset: 'SHE', ...got } };
  }
  if (path === '/api/explorer/history' && verb === 'GET') {
    const txs = confirmedBlockTxs(store, 30);
    return { status: 200, json: { ok: true, txs, asset: 'SHE' } };
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
  if ((path === '/api/pool/recent-txs' || path === '/api/explorer/recent') && verb === 'GET') {
    const txs = poolRecentBlockTxs(store, 30);
    return { status: 200, json: { ok: true, txs, asset: 'SHE' } };
  }
  if (path === '/api/wallet/history' && verb === 'GET') {
    const address = url.searchParams.get('address') || '';
    if (!isDestAddress(address) && !isPaymentCode(address)) {
      return { status: 400, json: { ok: false, reason: 'bad_address' } };
    }
    const rec = reconstructOwner(store, address);
    // she1 is offered publicly — amounts only. Full from/to stays on a dest
    // the receiving wallet derived locally and never published.
    const owner = isDestAddress(address);
    const rolled = rollupDestTxs(rec.txs, { revealDest: owner });
    const txs = owner ? rolled : rolled.map(publicTxView);
    return {
      status: 200,
      json: { ok: true, coin: 'SHE', txs, amountsOnly: !owner, rolled: true },
    };
  }
  if (path === '/api/vortex/mint' && verb === 'POST') {
    if (typeof store?.mintVorticeDeployKey !== 'function') {
      return { status: 503, json: { ok: false, reason: 'no_vortice' } };
    }
    const got = store.mintVorticeDeployKey({
      programId: body.programId,
      name: body.name,
      origin: body.origin,
      source: body.source,
    });
    const status = got.ok ? 200 : 400;
    return { status, json: got };
  }
  if ((path === '/api/vortex/lookup' && verb === 'POST') || (path === '/api/vortex/lookup' && verb === 'GET')) {
    const key = verb === 'GET' ? (url.searchParams.get('key') || '') : String(body.key || '');
    if (typeof store?.lookupVorticeKey !== 'function') {
      return { status: 503, json: { ok: false, reason: 'no_vortice' } };
    }
    return { status: 200, json: store.lookupVorticeKey(key) };
  }
  if (path === '/api/wallet/send' && verb === 'POST') {
    const from = payoutDest(String(body.from || '')) || '';
    const to = payoutDest(String(body.to || '')) || '';
    const amount = Number(body.amount);
    if (!isDestAddress(from) || !isDestAddress(to) || !(amount > 0)) {
      return { status: 400, json: { ok: false, reason: 'bad_send' } };
    }
    const poolPay = payoutDest(String(poolDest || '')) || '';
    if (poolPay && from === poolPay) {
      return { status: 403, json: { ok: false, reason: 'pool_dest' } };
    }
    const rec = reconstructOwner(store, from);
    const nanos = Math.round(amount * NANOS_PER_SHE);
    if (rec.spendableNanos < nanos) {
      return { status: 400, json: { ok: false, reason: 'insufficient' } };
    }
    const memoCt = body.memoCt || null;
    const kindIn = String(body.kind || 'send');
    const programIn = String(body.programId || '');
    const isLock = kindIn === 'lock' && programIn === RESERVE_PROGRAM;
    if (kindIn !== 'send' && !isLock) {
      return { status: 400, json: { ok: false, reason: 'bad_kind' } };
    }
    const kind = isLock ? 'lock' : 'send';
    const programId = isLock ? RESERVE_PROGRAM : '';
    const taxed = levyTaxed({ kind, programId });
    const depth = mempoolDepthBytes(store?.mempool || []);
    const fee = taxed ? levyNanos(nanos, { depth }) : 0;
    if (rec.spendableNanos < nanos + fee) {
      return { status: 400, json: { ok: false, reason: 'insufficient' } };
    }
    const draft = isLock
      ? { ...lockTx({ from, to, nanos, id: `lock-${Date.now()}` }), fee, memoCt, open: body.open, amount }
      : {
        kind, from, to, nanos, amount, fee, maxLevy: fee, memoCt, open: body.open,
        vin: [{ address: from }],
        vout: [{ address: to, nanos, kind }],
      };
    if (flowSendNeedsOpen(draft) && !verifyDestOpening(from, body.open)) {
      return { status: 403, json: { ok: false, reason: 'unsigned' } };
    }
    const tx = queueSend(draft);
    if (tx && typeof tx === 'object' && tx.ok === false) {
      return { status: 400, json: { ok: false, reason: tx.reason || 'queue_failed' } };
    }
    return {
      status: 200,
      json: {
        ok: true,
        tx: { id: tx.id, from, to, amount, kind, programId: programId || undefined, confirmed: false, memo: !!memoCt },
        fromBalance: nanosToShe(rec.spendableNanos - nanos - fee),
      },
    };
  }
  if (path === '/api/vault/reserve' && verb === 'GET') {
    const dest = url.searchParams.get('dest') || '';
    if (!isDestAddress(dest)) return { status: 400, json: { ok: false, reason: 'bad_dest' } };
    const vault = store?.reserveVault;
    if (!vault) return { status: 503, json: { ok: false, reason: 'no_vault' } };
    const now = Date.now();
    return {
      status: 200,
      json: {
        ok: true,
        public: false,
        programId: RESERVE_PROGRAM,
        extraMint: extraMintAllowed(RESERVE_PROGRAM),
        ...publicVaultView(vault, now),
        ...portalRewards(vault, dest, now),
      },
    };
  }
  if (path === '/api/vault/join' && verb === 'GET') {
    return { status: 404, json: { ok: false, reason: 'not_found', public: false } };
  }
  if (path === '/api/join/claim' && verb === 'POST') {
    return { status: 404, json: { ok: false, reason: 'not_found', public: false } };
  }
  if ((path === '/api/pool/pullPending' || path === '/api/pool/pullpending') && verb === 'GET') {
    const login = String(url.searchParams.get('login') || url.searchParams.get('she1') || '').trim().split('.')[0];
    if (!login.startsWith('she1')) {
      return { status: 400, json: { ok: false, reason: 'need_she1', public: false } };
    }
    const rec = pendingPulls && typeof pendingPulls.get === 'function'
      ? pendingPulls.get(login.toLowerCase())
      : null;
    return {
      status: 200,
      json: {
        ok: true,
        public: false,
        pending: rec || null,
        chainId: 2701,
      },
    };
  }
  if (path === '/api/pool/withdraw' && verb === 'POST') {
    const login = body.login || body.she1;
    const rawDest = String(body.dest || body.to || '').trim();
    const nanos = body.nanos != null ? body.nanos : Math.round(Number(body.amount || 0) * NANOS_PER_SHE);
    const sig = body.sig || body.signature;
    const dests = [...new Set([rawDest, payoutDest(rawDest) || ''].filter(Boolean))];
    let off = { ok: false, reason: 'unsigned' };
    for (const dest of dests) {
      off = verifyPoolWithdrawOffchain({ login, dest, nanos, sig });
      if (off.ok) break;
    }
    if (!off.ok) return { status: 400, json: { ...off, public: false } };
    const from = payoutDest(String(poolDest || '')) || poolPayoutDest();
    if (!isDestAddress(from)) return { status: 503, json: { ok: false, reason: 'no_pool_dest' } };
    const rec = reconstructOwner(store, from);
    const fee = levyNanos(off.nanos, { depth: mempoolDepthBytes(store?.mempool || []) });
    if (rec.spendableNanos < off.nanos + fee) {
      return { status: 400, json: { ok: false, reason: 'insufficient' } };
    }
    const pending = pendingPulls && typeof pendingPulls.get === 'function'
      ? pendingPulls.get(String(off.login || '').toLowerCase())
      : null;
    let tx;
    if (pending && pending.kind === 'admin-spendable') {
      const open = openingForSpentDest(poolIdentity, from) || String(poolOpen || '');
      const draft = {
        kind: 'send',
        from,
        to: off.dest,
        nanos: off.nanos,
        amount: off.nanos / NANOS_PER_SHE,
        fee,
        maxLevy: fee,
        open,
        vin: [{ address: from }],
        vout: [{ address: off.dest, nanos: off.nanos, kind: 'send' }],
      };
      if (flowSendNeedsOpen(draft) && !verifyDestOpening(from, open)) {
        return { status: 400, json: { ok: false, reason: 'unsigned', public: false } };
      }
      tx = draft;
    } else {
      tx = poolWithdrawTx({ from, to: off.dest, nanos: off.nanos, fee });
    }
    if (containsShe1(tx)) return { status: 400, json: { ok: false, reason: 'she1_on_chain' } };
    let queued = { ok: true, tx };
    if (typeof queueSend === 'function') queued = queueSend(tx);
    if (queued && typeof queued === 'object' && queued.ok === false) {
      return { status: 400, json: { ok: false, reason: queued.reason || 'queue_failed' } };
    }
    if (pending && pending.kind === 'admin-spendable') {
      // miner_coins stay in the pull book; this send is operator spendable only.
      if (pendingPulls && typeof pendingPulls.delete === 'function') {
        pendingPulls.delete(String(off.login || '').toLowerCase());
      }
    } else if (typeof completeMinerPull === 'function') {
      try { completeMinerPull(off.login, off.dest, off.nanos); } catch { /* pull book is optional */ }
    }
    const kind = pending && pending.kind === 'admin-spendable' ? 'send' : 'pool-withdraw';
    return {
      status: 200,
      json: {
        ok: true,
        tx: { id: (queued && queued.id) || tx.id, to: off.dest, nanos: off.nanos, kind },
      },
    };
  }
  if (path === '/api/vortex/list' && verb === 'GET') {
    const issued = store?.vortice?.issued || store?.listPublicVortices?.() || [];
    const list = Array.isArray(issued) ? issued : listPublicVortices(issued);
    return {
      status: 200,
      json: {
        ok: true,
        vortices: list.filter((v) => v && !isPinnedProgram(v.id)),
      },
    };
  }
  return null;
}

export { BLOCK_SUBSIDY_NANOS };

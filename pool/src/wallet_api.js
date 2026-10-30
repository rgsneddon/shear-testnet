import { Worker } from 'node:worker_threads';
import { isDestAddress, isPaymentCode, isShearAddress, payoutDest, isFullPaymentCode, checkAddressField, hash20FromAddress } from '../../crypto/address.js';
import { walletSubmitLog, newConnId, lineJoinsIpToIdentity } from '../../crypto/privacy_net.js';
import { heldBodyKey } from '../../crypto/mempool.js';
import {
  HASH_BONUS_NANOS,
  hashBonusUnitNanos,
  NANOS_PER_SHE,
  BLOCK_SUBSIDY_NANOS,
  TARGET_BLOCK_INTERVAL_MS,
  SPENDABLE_CONFIRMATIONS,
  MIN_CONFIRMS_POLICY,
  RESERVE_PROGRAM,
  extraMintAllowed,
  MAGIC_TESTNET,
} from '../../crypto/asert.js';
import { portalRewards, publicVaultView, publicTrancheRows, publicTrancheBook, voteTx, buildFundedWithdraw, postedPayoutDest20, withdrawNonceBytes, portalPrincipalNanos, vortexSums, withdrawLeakRejected } from '../../crypto/reserve_vault.js';
import {
  levyNanos,
  levyNeed,
  bindWeightFee,
  LEVY_CAP_NANOS,
  levyTaxed,
  txWeight,
  mempoolPressure,
  mempoolDepthBytes,
  poolPayoutDest,
  poolWithdrawTx,
  custodialPullAllowed,
  verifyPoolWithdrawOffchain,
  containsShe1,
} from '../../crypto/levy.js';
import { flowSendNeedsOpen, verifySpendSig, fundedDebit, openingForSpentDest, verifyReservePortalOpen, reserveNeedsPortalOpen, reconcileSpendable, mempoolDebitNanos } from '../../crypto/spend.js';
import { dummyCount, attachDummyOuts } from '../../crypto/dummy.js';
import { isPinnedProgram, listPublicVortices } from '../../crypto/vortex.js';
import { sealedExplorerRows, collateSamples, isSpendableHeight, flowConfirmations, valueOpenRejected, outputMayCarryValueOpen } from '../../crypto/chronoflux.js';
import { noteCommitSpendableNanos } from '../../crypto/coinbase_notes.js';
import { unitsForShare } from '../../crypto/share_batch.js';
import { noteCommitOfDest20, asU8, hiddenAmountRangeReady, verifySealedNote } from '../../crypto/note.js';
import { emptySupplyState, supplyReport } from '../../node/src/supply.js';
import { explorerRowPublic, FLOW_PERSONAL, CLOSURE_PERSONAL } from '../../crypto/flow_sheet.js';
import { ownerPubFromOpening } from '../../crypto/eip712.js';
import { decodeHeader } from '../../crypto/header.js';
import { roundActualHashes } from './hash_credit.js';
import { withdrawNonces, withdrawDigests } from './withdraw_state.js';
import { v3BucketSendRejected } from '../../crypto/fs1_send_gate.js';
import { fs1AnchorRows } from '../../crypto/admit_v3.js';

export function nanosToShe(n) {
  return Number(n || 0) / NANOS_PER_SHE;
}

/** Public recent window. Not a chain-height tuning. Headers already stop at 2000. */
export const EXPLORER_RECENT_CAP = 256;
export const EXPLORER_RANGE_CAP = 2000;

let explorerVisits = 0;
let explorerSyncs = 0;

export function resetExplorerWalkStats() {
  explorerVisits = 0;
  explorerSyncs = 0;
}

export function explorerWalkStats() {
  return { visits: explorerVisits, syncs: explorerSyncs };
}

const explorerBooks = new WeakMap();

function blockHashHex(b) {
  if (!b) return '';
  try {
    if (Buffer.isBuffer(b.hash)) return b.hash.toString('hex').toLowerCase();
  } catch { /* string hash */ }
  return String(b.hash || '').toLowerCase();
}

/** Index one blocks array. A replaced suffix rolls back by object identity. */
function syncExplorerBook(list) {
  if (!Array.isArray(list)) return null;
  let idx = explorerBooks.get(list);
  if (!idx) {
    idx = { idents: [], byHeight: new Map(), byHash: new Map() };
    explorerBooks.set(list, idx);
  }
  const idents = idx.idents;
  while (idents.length > 0 && list[idents.length - 1] !== idents[idents.length - 1].block) {
    const gone = idents.pop();
    if (idx.byHeight.get(gone.height) === gone.block) idx.byHeight.delete(gone.height);
    if (gone.hash && idx.byHash.get(gone.hash) === gone.block) idx.byHash.delete(gone.hash);
  }
  while (idents.length < list.length) {
    const block = list[idents.length];
    const height = Number(block?.height);
    const hash = blockHashHex(block);
    idents.push({ height, hash, block });
    if (Number.isFinite(height)) idx.byHeight.set(height, block);
    if (hash) idx.byHash.set(hash, block);
    explorerSyncs += 1;
  }
  return idx;
}

function publicTxView(t) {
  return {
    id: t.id,
    kind: t.kind,
    amount: t.amount,
    from: t.from,
    to: t.to,
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
    });
  }
  if (spendableNanos < 0) spendableNanos = 0;
  return { spendableNanos, spendable: nanosToShe(spendableNanos), txs };
}

/** Height-indexed when blocks[i].height === i+1 (the live book). A hole uses the book index, not a scan. */
export function headerBlockAt(store, height) {
  const h = Math.floor(Number(height) || 0);
  if (h < 1) return null;
  const list = store?.blocks || [];
  const i = h - 1;
  if (i >= 0 && i < list.length && Number(list[i].height) === h) return list[i];
  const idx = syncExplorerBook(list);
  return idx?.byHeight.get(h) || null;
}

export function ownerDests(address) {
  const addr = String(address || '').trim();
  const out = new Set();
  if (isDestAddress(addr)) out.add(addr);
  return [...out];
}

export function reconstructOwner(store, address) {
  const dests = ownerDests(address);
  const destSet = new Set(dests);
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
      for (const r of sealedExplorerRows(b)) {
        if (!r.to && r.noteCommit) {
          for (const d of dests) {
            const h = hash20FromAddress(d);
            if (h && Buffer.from(r.noteCommit).equals(noteCommitOfDest20(h))) {
              r.to = d;
              break;
            }
          }
        }
        push(r);
      }
    }
  }
  const tipH = Number(store?.tip?.()?.height || (store.blocks || []).at(-1)?.height || 0);
  const rec = rowsToHistory(rows, dests, tipH);
  const mempool = store?.mempool || [];
  const bonus = hashBonusUnitNanos(store?.reserveVault?.liveHashBonusNanos);
  // One ledger. The live store already subtracted vault principal.
  // A fixture with no index still opens notes, then subtracts principal once.
  const liveSpendable = typeof store?.spendableNanos === 'function';
  let nanos = 0;
  for (const d of dests) {
    if (liveSpendable) {
      nanos += Math.max(0, Math.floor(Number(store.spendableNanos(d)) || 0));
    } else {
      const noteNanos = noteCommitSpendableNanos(store.blocks || [], d, tipH, {
        hashBonusNanos: bonus,
        coinbaseOnly: false,
      });
      const opened = reconcileSpendable([], d, tipH, noteNanos);
      const locked = Math.max(0, Math.floor(Number(portalPrincipalNanos(store?.reserveVault, d)) || 0));
      nanos += Math.max(0, opened - locked);
    }
    nanos -= mempoolDebitNanos(mempool, d);
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

/** One row per sealed block. Pending until consensus_spendable (9), not ui_seen. */
function confirmedBlockRow(b, tipH) {
  const hid = Buffer.isBuffer(b?.hash)
    ? b.hash.toString('hex')
    : String(b?.hash || b?.height || '');
  const height = Number(b?.height || 0);
  const confs = flowConfirmations(height, tipH);
  const pending = !isSpendableHeight(height, tipH, SPENDABLE_CONFIRMATIONS);
  return {
    id: hid,
    kind: 'block',
    from: 'coinbase',
    to: '',
    amountHidden: true,
    asset: 'SHE',
    height,
    confirmations: confs,
    pending,
    status: pending ? 'pending' : 'confirmed',
    at: blockAtMs(b),
  };
}

export function confirmedBlockTxs(store, limit = 30) {
  const list = Array.isArray(store?.blocks) ? store.blocks : [];
  const unlimited = limit === Infinity;
  const n = unlimited ? list.length : Math.max(1, Math.min(10000, Math.floor(Number(limit) || 30)));
  const tipH = Number(
    (typeof store?.tip === 'function' ? store.tip()?.height : 0)
    || list[list.length - 1]?.height
    || 0,
  );
  const out = [];
  for (let i = list.length - 1; i >= 0 && out.length < n; i -= 1) {
    out.push(confirmedBlockRow(list[i], tipH));
  }
  return out;
}

function publicPaintDest(a) {
  const s = String(a || '');
  if (!s || /^shear1/i.test(s) || /^she1/i.test(s)) return '';
  if (s === 'coinbase') return 'coinbase';
  return isDestAddress(s) ? s : '';
}

/** Mempool Reserve lock/vote for explorer. Dest ssa1, amount, kind, (pending). No she1. */
export function mempoolReservePaint(store) {
  const rows = [];
  for (const m of store?.mempool || []) {
    const kind = String(m.kind || m.vout?.[0]?.kind || '');
    if (kind !== 'lock' && kind !== 'vote' && kind !== 'leaf-vote') continue;
    const to = publicPaintDest(m.to || m.vout?.[0]?.address || '');
    const from = publicPaintDest(m.from || m.vin?.[0]?.address || '');
    const nanos = Math.floor(Number(m.nanos || m.vout?.[0]?.nanos || 0));
    if (/she1|shear1/i.test(`${to}${from}${kind}`)) continue;
    rows.push({
      id: String(m.id || ''),
      kind,
      from,
      to,
      amount: nanosToShe(nanos),
      nanos,
      height: 0,
      confirmations: 0,
      pending: true,
      status: 'pending',
    });
  }
  return rows.filter((r) => r.id);
}

export function sealedReservePaint(store, limit = Infinity) {
  const list = Array.isArray(store?.blocks) ? store.blocks : [];
  const tipH = Number((typeof store?.tip === 'function' ? store.tip()?.height : 0) || list[list.length - 1]?.height || 0);
  const rows = [];
  const finite = limit !== Infinity;
  const cap = finite ? Math.max(1, Math.min(10000, Math.floor(Number(limit) || 30))) : Infinity;
  const sealed = Array.isArray(store?.explorer) && store.explorer.length
    ? store.explorer
    : null;
  if (sealed) {
    const src = finite ? sealed.slice(Math.max(0, sealed.length - cap)) : sealed;
    for (const r of src) {
      if (finite) explorerVisits += 1;
      const kind = String(r.kind || '');
      if (kind !== 'lock' && kind !== 'vote') continue;
      const to = publicPaintDest(r.to);
      const from = publicPaintDest(r.from);
      if (/she1|shear1/i.test(`${to}${from}`)) continue;
      const height = Number(r.height || 0);
      const confs = flowConfirmations(height, tipH);
      const pending = confs < SPENDABLE_CONFIRMATIONS;
      rows.push({
        id: String(r.id || ''),
        kind,
        from,
        to,
        amount: nanosToShe(r.nanos),
        nanos: Number(r.nanos || 0),
        height,
        confirmations: confs,
        pending,
        status: pending ? 'pending' : 'confirmed',
        at: r.at || 0,
      });
    }
    return rows;
  }
  const src = finite ? list.slice(Math.max(0, list.length - cap)) : list;
  for (const b of src) {
    if (finite) explorerVisits += 1;
    for (const r of sealedExplorerRows(b) || []) {
      const kind = String(r.kind || '');
      if (kind !== 'lock' && kind !== 'vote') continue;
      const to = publicPaintDest(r.to);
      const from = publicPaintDest(r.from);
      if (/she1|shear1/i.test(`${to}${from}`)) continue;
      const confs = flowConfirmations(b.height, tipH);
      const pending = confs < SPENDABLE_CONFIRMATIONS;
      rows.push({
        id: String(r.id || ''),
        kind,
        from,
        to,
        amount: nanosToShe(r.nanos),
        nanos: Number(r.nanos || 0),
        height: Number(b.height || 0),
        confirmations: confs,
        pending,
        status: pending ? 'pending' : 'confirmed',
        at: blockAtMs(b),
      });
    }
  }
  return rows;
}

/** Public explorer/stats row: kind + dest + amount + status. No she1, memo-plain, IP. */
export function publicSurfaceRow(t) {
  const kind = String(t?.kind || 'send');
  const pending = t?.pending === true || t?.status === 'pending' || t?.status === '(pending)';
  const row = {
    id: String(t?.id || ''),
    kind,
    from: String(t?.from || '') === 'coinbase' ? 'coinbase' : '',
    to: '',
    amountHidden: true,
    proofOk: !pending,
    height: Number(t?.height || 0),
    confirmations: Number(t?.confirmations || 0),
    pending,
    status: pending ? 'pending' : String(t?.status || 'confirmed'),
  };
  if (t?.confirmations != null) row.confirmations = Number(t.confirmations) || 0;
  if (t?.at != null) row.at = t.at;
  return row;
}

export function publicPayloadLeaksIdentity(obj) {
  const s = JSON.stringify(obj ?? '');
  if (/memoPlain|memo-plain/i.test(s) && !/ABSENT/.test(s)) return true;
  if (/"ip"\s*:|remoteAddress|peerIp/i.test(s)) return true;
  if (/\.worker\b/i.test(s)) return true;
  return /(?:^|[^a-z])she1|shear1/i.test(s.replace(/ssa1/gi, ''));
}

export function isExplorerPendingRow(t) {
  if (!t) return false;
  if (t.pending === true) return true;
  const st = String(t.status || '');
  if (st === 'pending' || st === '(pending)') return true;
  const kind = String(t.kind || '');
  return Number(t.height) === 0 && (kind === 'lock' || kind === 'vote');
}

/** Pending lock/vote stay first. Sealed rows by height desc. Never drop mempool behind a slice. */
export function orderExplorerRecent(txs, limit = 30) {
  const list = Array.isArray(txs) ? txs.slice() : [];
  const pending = [];
  const sealed = [];
  for (const t of list) {
    if (isExplorerPendingRow(t)) pending.push(t);
    else sealed.push(t);
  }
  sealed.sort((a, b) => Number(b.height) - Number(a.height));
  const merged = pending.concat(sealed);
  if (limit === Infinity) return merged;
  const n = Math.max(1, Math.min(10000, Math.floor(Number(limit) || 30)));
  return merged.slice(0, n);
}

function examinedBlocks(store, limit) {
  const list = Array.isArray(store?.blocks) ? store.blocks : [];
  if (limit === Infinity) return list.length;
  const n = Math.max(1, Math.min(10000, Math.floor(Number(limit) || 30)));
  return Math.min(list.length, n);
}

/** Explorer recent: mempool lock/vote first, then sealed reserve rows + blocks. Hash-open-round omitted. */
export function explorerRecentTxs(store, limit = 30) {
  const pending = mempoolReservePaint(store);
  const blockLimit = limit === Infinity ? Infinity : Math.max(Number(limit) || 30, 30);
  const sealed = sealedReservePaint(store, blockLimit).slice().reverse();
  const blocks = confirmedBlockTxs(store, blockLimit);
  if (limit !== Infinity) explorerVisits += examinedBlocks(store, blockLimit);
  const seen = new Set();
  const out = [];
  for (const t of [...pending, ...sealed, ...blocks]) {
    const id = String(t.id || '');
    if (!id || seen.has(id)) continue;
    if (/she1|shear1/i.test(String(t.to || ''))) continue;
    if (t.from !== 'coinbase' && /she1|shear1/i.test(String(t.from || ''))) continue;
    seen.add(id);
    out.push(publicSurfaceRow(t));
  }
  return orderExplorerRecent(out, limit);
}

/** Last N confirmed blocks only. No hash-bonus rows and no pot-split lines. */
export function poolRecentBlockTxs(store, limit = 30) {
  return confirmedBlockTxs(store, limit);
}

function publicDest(a) {
  const s = String(a || '');
  if (s === 'coinbase') return 'coinbase';
  if (isShearAddress(s)) return '';
  return isDestAddress(s) ? s : '';
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
  const idx = syncExplorerBook(list);
  const want = id.toLowerCase();
  // A 64-digit hash is still a hash. Number("...0002") is 2, so height must
  // not win on a full block id.
  if (want.length === 64 && /^[0-9a-f]+$/.test(want)) return idx?.byHash.get(want) || null;
  if (/^\d+$/.test(id)) return idx?.byHeight.get(Number(id)) || null;
  const n = Math.min(list.length, EXPLORER_RECENT_CAP);
  const start = list.length - n;
  for (let i = list.length - 1; i >= start; i -= 1) {
    explorerVisits += 1;
    const hid = blockHashHex(list[i]);
    if (hid === want || hid.startsWith(want)) return list[i];
  }
  return null;
}

/** Public tx detail for one confirmed block. No rest-frame, silent ID, view-key, or memo body. */
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
  const outputs = sealedExplorerRows(b).map((r) => {
    const kind = r.kind || 'block';
    return {
      kind,
      from: r.from === 'coinbase' ? 'coinbase' : '',
      to: '',
      amountHidden: true,
      memo: r.memo === true,
    };
  });
  const pruned = !!b.samplesPruned;
  const samples = pruned ? [] : collateSamples(b.samples || []).map((s) => ({
    count: Number(s.count) || 0,
  })).filter((s) => s.count > 0);
  const lines = [];
  lines.push(`======== SHEAR CTF  tx=${row.id}  ========`);
  lines.push(`kind        ${row.kind}`);
  lines.push('amount      hidden');
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
    lines.push(`  ${o.kind.padEnd(10)} ${o.from || '(none)'}  hidden  memo=${o.memo ? 'yes' : 'no'}`);
  }
  lines.push('-- flow samples --');
  if (pruned) lines.push('samples     pruned (counts sealed in continuity root)');
  else if (!samples.length) lines.push('samples     (none)');
  else for (const s of samples) lines.push(`  count ${s.count}`);
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
  lines.push('conclusion  public explorer shows kind/header only; dests and amounts stay in the wallet.');
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

function tipHeightOf(store) {
  const list = Array.isArray(store?.blocks) ? store.blocks : [];
  return Number(
    (typeof store?.tip === 'function' ? store.tip()?.height : 0)
    || list[list.length - 1]?.height
    || 0,
  );
}

export function searchExplorerTxs(store, q = {}) {
  const id = String(q.id || '').trim();
  const height = q.height != null && String(q.height).trim() !== '' ? Number(q.height) : NaN;
  const from = q.from != null && String(q.from).trim() !== '' ? Number(q.from) : NaN;
  const to = q.to != null && String(q.to).trim() !== '' ? Number(q.to) : NaN;
  if (!id && !Number.isFinite(height) && !Number.isFinite(from) && !Number.isFinite(to)) {
    return confirmedBlockTxs(store, 30);
  }
  const list = Array.isArray(store?.blocks) ? store.blocks : [];
  const tipH = tipHeightOf(store);
  const rowOf = (b) => confirmedBlockRow(b, tipH);
  if (id) {
    if (/^\d+$/.test(id) || (id.length === 64 && /^[0-9a-fA-F]+$/.test(id))) {
      const hit = findSealedBlock(store, id);
      return hit ? [rowOf(hit)] : [];
    }
    const n = Math.min(list.length, EXPLORER_RECENT_CAP);
    const start = list.length - n;
    const out = [];
    for (let i = list.length - 1; i >= start; i -= 1) {
      explorerVisits += 1;
      const row = rowOf(list[i]);
      if (String(row.id) === id || String(row.id).includes(id)) out.push(row);
    }
    return out;
  }
  if (Number.isFinite(height)) {
    const hit = findSealedBlock(store, String(Math.floor(height)));
    return hit ? [rowOf(hit)] : [];
  }
  let lo = Number.isFinite(from) ? Math.floor(from) : null;
  let hi = Number.isFinite(to) ? Math.floor(to) : null;
  if (lo == null) lo = hi;
  if (hi == null) hi = lo;
  if (hi < lo) {
    const swap = lo;
    lo = hi;
    hi = swap;
  }
  if (hi - lo + 1 > EXPLORER_RANGE_CAP) hi = lo + EXPLORER_RANGE_CAP - 1;
  const out = [];
  for (let h = hi; h >= lo; h -= 1) {
    explorerVisits += 1;
    const b = headerBlockAt(store, h);
    if (b) out.push(rowOf(b));
  }
  return out;
}

function confidentialZeroNanos(o) {
  if (!o || o.commit == null || o.commit === false || o.commit === '') return false;
  return Math.floor(Number(o.nanos) || 0) === 0;
}

/**
 * Hash-bonus nanos consensus minted in one sealed coinbase.
 * Tree-A counts, share units, and owed rows are not a mint.
 * One confidential hash vout with plaintext nanos 0 is the finder floor.
 */
export function hashBonusEmittedOfBlock(block, unit = HASH_BONUS_NANOS) {
  const u = hashBonusUnitNanos(unit);
  const cb = Array.isArray(block?.txs) ? block.txs[0] : null;
  if (!cb || cb.coinbase !== true || !Array.isArray(cb.vout)) return 0;
  let minted = 0;
  let hashVouts = 0;
  let confidentialFloor = false;
  for (const o of cb.vout) {
    if (String(o?.kind || '') !== 'hash') continue;
    hashVouts += 1;
    const raw = o?.valueProof && o.valueProof.v != null && o.valueProof.v !== '' && o.valueProof.v !== false
      ? o.valueProof.v
      : null;
    if (raw != null) {
      let n = null;
      if (typeof raw === 'bigint') n = raw;
      else if (typeof raw === 'number' && Number.isSafeInteger(raw)) n = BigInt(raw);
      else if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
        try { n = BigInt(raw); } catch { n = null; }
      }
      if (n == null || n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
      // Never an unchecked amount: v counts only when it opens the commitment.
      if (o.commit && !verifySealedNote(o, Number(n))) return 0;
      minted += Number(n);
    } else if (confidentialZeroNanos(o)) {
      confidentialFloor = true;
    }
  }
  if (minted === 0 && hashVouts === 1 && confidentialFloor) return unitsForShare() * u;
  return minted;
}

/** All SHE in existence: the consensus supply, not a fresh proof walk. Staked coin stays out of the sum. */
let supplyWorker = null;
let supplyJobSeq = 0;
const supplyWaiters = new Map();
/** One book does not reuse another book's verdict, even when the tip hash collides. */
const supplyCache = new WeakMap();
const supplyJobs = new WeakMap();

function cachedSupply(store, key) {
  if (!store || typeof store !== 'object') return null;
  const hit = supplyCache.get(store);
  if (!hit || hit.key !== key || !hit.val || hit.val.supplyStatus === 'pending') return null;
  return hit.val;
}

function rememberSupply(store, key, packed) {
  if (!store || typeof store !== 'object') return;
  if (supplyCacheKey(store) !== key) return;
  supplyCache.set(store, { key, val: packed });
}

function forgetSupplyJob(store, key) {
  if (!store || typeof store !== 'object') return;
  const job = supplyJobs.get(store);
  if (job && job.key === key) supplyJobs.delete(store);
}

/** O(1). Same height with a different tip hash is a different book. */
export function supplyCacheKey(store) {
  let height = 0;
  let hash = '';
  try {
    const tip = typeof store?.tip === 'function' ? store.tip() : null;
    if (tip) {
      const n = Number(tip.height);
      if (Number.isInteger(n) && n >= 0) height = n;
      const raw = tip.hash;
      hash = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw || '');
    }
  } catch { /* a raw list has no tip method */ }
  if (!hash) {
    const blocks = Array.isArray(store?.blocks) ? store.blocks : [];
    const last = blocks.length ? blocks[blocks.length - 1] : null;
    const n = Number(last?.height);
    height = Number.isInteger(n) && n >= 0 ? n : blocks.length;
    const raw = last?.hash;
    hash = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw || '');
  }
  return `${height}:${hash}`;
}

export function supplyStatusWord(status) {
  if (status === 'verified' || status === 'pending' || status === 'unverifiable') return status;
  return 'mismatch';
}

function supplyTipHeight(store) {
  try {
    const height = Number(store?.tip?.()?.height);
    if (Number.isInteger(height) && height >= 0) return height;
  } catch { /* raw lists */ }
  const blocks = store?.blocks;
  return Array.isArray(blocks) ? blocks.length : 0;
}

function nonNegCount(value) {
  const n = Math.floor(Number(value) || 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Vault figures for the tip supply report. A public receipt cannot be
 * appended, so locked principal on this vault is the note-backed debit.
 * Accrued interest is the mint bank plus claimable leaves.
 */
function explorerVaultOpts(store) {
  const view = publicVaultView(store?.reserveVault || {}, Date.now());
  const principal = nonNegCount(view.totalLockedNanos);
  const accrued = nonNegCount(view.reserveClaimableNanos);
  return {
    vaultPrincipalNanos: principal,
    vaultAccruedNanos: accrued,
    noteBackedPrincipalNanos: principal,
  };
}

function packSupply(audit, store) {
  const vault = publicVaultView(store?.reserveVault || {}, Date.now());
  const word = supplyStatusWord(audit?.status);
  const settled = word === 'verified' || word === 'mismatch';
  return {
    circulatingNanos: settled ? audit.circulatingNanos : null,
    potNanos: settled ? audit.measuredPotNanos : null,
    hashNanos: settled ? audit.measuredHashNanos : null,
    hashOwedNanos: settled ? audit.hashOwedNanos : null,
    levyNanos: settled ? audit.measuredLevyNanos : null,
    extraMintNanos: settled ? audit.extraMintNanos : null,
    burnedNanos: settled ? audit.burnedNanos : null,
    schedulePotNanos: settled ? audit.schedulePotNanos : null,
    carryNanos: settled ? audit.carryNanos : null,
    differenceNanos: settled ? audit.differenceNanos : null,
    vaultPrincipalNanos: settled ? nonNegCount(audit.vaultPrincipalNanos) : null,
    vaultAccruedNanos: settled ? nonNegCount(audit.vaultAccruedNanos) : null,
    noteBackedPrincipalNanos: settled ? nonNegCount(audit.noteBackedPrincipalNanos) : null,
    mintedInterestNanos: settled ? nonNegCount(audit.mintedInterestNanos) : null,
    supplyStatus: word,
    supplyReason: audit?.reason || '',
    asOfHeight: supplyTipHeight(store),
    lockedNanos: Math.max(0, Math.floor(Number(vault.totalLockedNanos) || 0)),
    accruingNanos: Math.max(0, Math.floor(Number(vault.accruingNanos) || 0)),
    vaultNanos: Math.max(0, Math.floor(Number(vault.vaultNanos) || 0)),
    reserveClaimableNanos: Math.max(0, Math.floor(Number(vault.reserveClaimableNanos) || 0)),
    reserveMintedNanos: settled ? Math.max(0, Math.floor(Number(audit.extraMintNanos) || 0)) : null,
  };
}

function pendingSupply(store) {
  return packSupply({ status: 'pending', reason: 'pending' }, store);
}

function holdSupplyWorker() {
  if (!supplyWorker) return;
  if (supplyWaiters.size) supplyWorker.ref();
  else supplyWorker.unref();
}

function failSupplyWaiters(err) {
  for (const [id, waiter] of supplyWaiters) {
    supplyWaiters.delete(id);
    waiter.reject(err);
  }
  holdSupplyWorker();
}

function ensureSupplyWorker() {
  if (supplyWorker) return supplyWorker;
  supplyWorker = new Worker(new URL('../../node/src/supply_audit_worker.js', import.meta.url));
  supplyWorker.on('message', (msg) => {
    const waiter = supplyWaiters.get(msg?.id);
    if (!waiter) return;
    supplyWaiters.delete(msg.id);
    holdSupplyWorker();
    if (msg.error) waiter.reject(new Error(msg.error));
    else waiter.resolve(msg.audit);
  });
  supplyWorker.on('error', (err) => {
    const failed = supplyWorker;
    supplyWorker = null;
    failSupplyWaiters(err);
    try { failed.terminate(); } catch { /* already gone */ }
  });
  supplyWorker.on('exit', (code) => {
    if (supplyWorker) supplyWorker = null;
    if (code) failSupplyWaiters(new Error(`audit_worker_${code}`));
    holdSupplyWorker();
  });
  holdSupplyWorker();
  return supplyWorker;
}

function runSupplyAudit(store, key) {
  const blocks = Array.isArray(store?.blocks) ? store.blocks : [];
  const id = supplyJobSeq + 1;
  supplyJobSeq = id;
  const promise = new Promise((resolve, reject) => {
    supplyWaiters.set(id, { key, resolve, reject });
  });
  const worker = ensureSupplyWorker();
  holdSupplyWorker();
  let index = 0;
  const pump = () => {
    const waiter = supplyWaiters.get(id);
    if (!waiter || waiter.key !== key) return;
    try {
      if (index === 0) worker.postMessage({ id, type: 'start', length: blocks.length });
      if (index >= blocks.length) {
        worker.postMessage({ id, type: 'end' });
        return;
      }
      worker.postMessage({ id, type: 'block', index, block: blocks[index] });
      index += 1;
      setImmediate(pump);
    } catch (err) {
      const failed = supplyWaiters.get(id);
      supplyWaiters.delete(id);
      holdSupplyWorker();
      if (failed) failed.reject(err);
    }
  };
  setImmediate(pump);
  return promise.then((audit) => {
    forgetSupplyJob(store, key);
    const packed = packSupply(audit, store);
    rememberSupply(store, key, packed);
    return packed;
  }, () => {
    forgetSupplyJob(store, key);
    const packed = packSupply({ status: 'unverifiable', reason: 'audit_worker' }, store);
    rememberSupply(store, key, packed);
    return packed;
  });
}

export function networkSupply(store) {
  const consensus = typeof store?.supplyState === 'function' ? store.supplyState() : null;
  const vaultOpts = explorerVaultOpts(store);
  if (consensus) return packSupply(supplyReport(consensus, vaultOpts), store);
  const blocks = Array.isArray(store?.blocks) ? store.blocks : [];
  if (!blocks.length) return packSupply(supplyReport(emptySupplyState(0), vaultOpts), store);
  const key = supplyCacheKey(store);
  const hit = cachedSupply(store, key);
  if (hit) return hit;
  let job = supplyJobs.get(store);
  if (!job || job.key !== key) {
    job = { key, promise: runSupplyAudit(store, key) };
    supplyJobs.set(store, job);
  }
  return pendingSupply(store);
}

/** The publish verdict once the off-loop audit has finished. Consensus state resolves now. */
export function networkSupplySettled(store) {
  const now = networkSupply(store);
  if (now.supplyStatus !== 'pending') return Promise.resolve(now);
  const job = store && typeof store === 'object' ? supplyJobs.get(store) : null;
  if (job && job.key === supplyCacheKey(store)) return job.promise;
  return Promise.resolve(now);
}

export function explorerCirculation(store) {
  const supply = networkSupply(store);
  const word = supplyStatusWord(supply.supplyStatus);
  const settled = word === 'verified' || word === 'mismatch';
  let noteCount = 0;
  for (const b of store.blocks || []) {
    for (const tx of b.txs || []) {
      for (const o of tx.vout || []) {
        if (o?.commit || o?.noteCommit || o?.valueProof) noteCount += 1;
      }
    }
  }
  return {
    proofs: word === 'verified',
    supplyStatus: word,
    differenceNanos: settled ? Number(supply.differenceNanos) || 0 : null,
    schedulePotNanos: settled ? Number(supply.schedulePotNanos) || 0 : null,
    amountHidden: false,
    noteCount,
    circulatingNanos: settled ? supply.circulatingNanos : null,
    circulating: settled ? nanosToShe(supply.circulatingNanos) : null,
    emitted: settled ? nanosToShe(supply.potNanos + supply.hashNanos + supply.extraMintNanos) : null,
    hashOwedNanos: settled ? Number(supply.hashOwedNanos) || 0 : null,
    reserveMintedNanos: settled ? Math.max(0, Math.floor(Number(supply.extraMintNanos) || 0)) : null,
    vaultPrincipalNanos: settled ? nonNegCount(supply.vaultPrincipalNanos) : null,
    vaultAccruedNanos: settled ? nonNegCount(supply.vaultAccruedNanos) : null,
    noteBackedPrincipalNanos: settled ? nonNegCount(supply.noteBackedPrincipalNanos) : null,
    mintedInterestNanos: settled ? nonNegCount(supply.mintedInterestNanos) : null,
    reserveVaultNanos: supply.vaultNanos || supply.lockedNanos || 0,
    accruingNanos: supply.accruingNanos || 0,
    holderCount: 0,
    holders: [],
  };
}

function memoTxWeight(m) {
  const vouts = Math.max(1, (m?.vout || []).length || (m?.to ? 1 : 0));
  const memo = m?.memoCt || m?.memoH ? 1 : 0;
  const bFlag = m?.kind === 'b-spend' || m?.bFlag ? 1 : 0;
  return txWeight({ vouts, memoChunks: memo, bFlag });
}

/** Open-round work is not a mint. Per-miner hash rows are not painted. */
export function openRoundHashRows(miners, hashBonusNanos) {
  // R28 S1. A per-miner hash row is a tag plus a count. The lattice does not
  // mint one. Callers that used to paint these rows get an empty list.
  void miners;
  void hashBonusNanos;
  return [];
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
  // Rows match by body key (a network view row carries it), not by the id a
  // sender picks: a reused id neither hides a pending tx nor marks it included.
  const keyOf = (m) => (/^[0-9a-f]{64}$/.test(String(m?.key || '')) ? String(m.key) : heldBodyKey(m));
  const includedKeys = new Set(
    tplTxs.filter((t) => t && !t.coinbase).map(keyOf).filter(Boolean),
  );
  const jobUser = [];
  for (const t of tplTxs) {
    if (!t || t.coinbase) continue;
    const id = String(t.id || '');
    if (!id) continue;
    const weight = Number(t.weight) > 0 ? Number(t.weight) : memoTxWeight(t);
    jobUser.push({
      key: keyOf(t),
      id,
      kind: t.kind || 'send',
      fee: Number(t.fee || 0),
      weight,
    });
  }
  const rawPending = Array.isArray(opts.networkPending)
    ? opts.networkPending
    : (store?.mempool || []);
  const seenPending = new Set();
  const pending = rawPending.map((m) => {
    const weight = Number(m.weight) > 0 ? Number(m.weight) : memoTxWeight(m);
    const fee = Number(m.fee || 0);
    const key = keyOf(m);
    if (m?.id && key) seenPending.add(key);
    const included = includedKeys.size ? includedKeys.has(key) : true;
    const mass = weight * (1 + Math.log1p(Math.max(0, fee)));
    return {
      id: String(m.id || ''),
      kind: m.kind || 'send',
      fee,
      weight,
      prime: m.kind === 'b-spend' || m.kind === 'send' || m.kind === 'claim',
      included,
      priority: (included ? 400 : 0) + mass,
    };
  }).filter((t) => t.id);
  for (const row of jobUser) {
    if (row.key && seenPending.has(row.key)) continue;
    const mass = row.weight * (1 + Math.log1p(Math.max(0, row.fee)));
    pending.push({
      id: row.id,
      kind: row.kind,
      fee: row.fee,
      weight: row.weight,
      prime: row.kind === 'b-spend' || row.kind === 'send' || row.kind === 'claim',
      included: true,
      priority: 400 + mass,
    });
    if (row.key) seenPending.add(row.key);
  }
  pending.sort((a, b) => b.priority - a.priority);
  const hashRows = [];
  const hashes = 0;
  const pendingBlock = {
    height: Number(lastJob?.height || (tip.height + 1)),
    jobId: String(lastJob?.jobId || ''),
    bits: Number(lastJob?.bits || lastJob?.blockBits || 0),
    hashes,
    weight: hashes + pending.reduce((a, t) => a + (Number(t.weight) || 0), 0),
    fee: pending.reduce((a, t) => a + (Number(t.fee) || 0), 0),
    txs: hashRows.concat(jobUser.map((row) => ({
      id: row.id,
      kind: row.kind,
      fee: row.fee,
      weight: row.weight,
      included: true,
    }))),
  };
  const n = Math.max(1, Math.min(48, Math.floor(Number(opts.limit) || 24)));
  const generations = [];
  for (let i = list.length - 1; i >= 0 && generations.length < n; i -= 1) {
    const b = list[i];
    const rows = sealedExplorerRows(b) || [];
    const confs = flowConfirmations(b.height, tip.height);
    const spendable = isSpendableHeight(b.height, tip.height);
    generations.push({
      height: Number(b.height || 0),
      hash: hex32(b.hash),
      confirmations: confs,
      spendable,
      confirming: confs >= 1 && !spendable,
      txs: rows.map((r, i) => ({
        id: String(r.id || `${b.height}-${i}`),
        kind: r.kind || 'vout',
        prime: r.kind === 'transfer' || r.kind === 'b-spend' || r.kind === 'coinbase' || r.kind === 'hash',
        confirming: confs >= 1 && !spendable,
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

/** Chain notes plus owed-toward-π. The painted Continuum figure, in nanos. */
export function paintedSpendableNanos(store, pullBook, address, chainNanos) {
  const chain = Math.max(0, Number(chainNanos) || 0);
  let tipHeight = 0;
  try {
    const tip = typeof store?.tip === 'function' ? store.tip() : null;
    tipHeight = Number(tip?.height || 0) || 0;
  } catch {
    tipHeight = 0;
  }
  const owedShe = Number(owedPiFromPullBook(pullBook, address, { tipHeight, need: 30 }).owedPi) || 0;
  const owed = Math.round(owedShe * NANOS_PER_SHE);
  return chain + (Number.isFinite(owed) && owed > 0 ? owed : 0);
}

/** Dest-scoped owed-π / confirming pot from the pull-book (credits still below π). */
export function owedPiFromPullBook(pullBook, address, { tipHeight = 0, need = 30 } = {}) {
  if (!custodialPullAllowed()) return { owedPi: 0, confirmingPot: 0 };
  if (!pullBook || typeof pullBook.viewByDest !== 'function' || !isDestAddress(address)) {
    return { owedPi: 0, confirmingPot: 0 };
  }
  const v = pullBook.viewByDest(address, { tipHeight, need });
  const she = nanosToShe(v.pendingNanos);
  return { owedPi: she, confirmingPot: she };
}

/** A local opening on a hidden output is not relayed. Public reserve kinds keep v. */
function stripHiddenValueOpen(kind, vout) {
  if (!Array.isArray(vout)) return vout;
  const tx = { kind: kind || '' };
  return vout.map((o) => {
    if (!o || typeof o !== 'object') return o;
    if (!Object.prototype.hasOwnProperty.call(o, 'valueProof')) return o;
    if (outputMayCarryValueOpen(tx, o)) return o;
    const next = { ...o };
    delete next.valueProof;
    return next;
  });
}

/**
 * AL-5. Address-keyed routes that answered with per-note amounts. A wallet
 * recovers its own amounts from amtCt over the public block sync.
 */
export const AMOUNT_ROUTES = new Set(['/api/wallet/notes', '/api/wallet/balance', '/api/wallet/history']);

/** AL-3. A send request is the sealed tx only. None of these may be present, even empty. */
export const SEND_HINT_KEYS = Object.freeze([
  'amount', 'nanos', 'from', 'to', 'change', 'changeNanos', 'paintedOwedNanos', 'open', 'destOpen',
]);

/**
 * The wallet built every output. The server reads no amount, address, change,
 * or opening, and queues the posted body. The FS-1 gate still answers first.
 */
function sealedSendOnly(body, { queueSend }) {
  const gate = v3BucketSendRejected({ ...body, kind: 'send' });
  if (gate) return { status: 400, json: { ok: false, reason: gate.reason, state: gate.state } };
  for (const k of SEND_HINT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined) {
      return { status: 400, json: { ok: false, reason: 'send_hint', field: k } };
    }
  }
  const proofs = Array.isArray(body.admit_proofs) ? body.admit_proofs.filter(Boolean) : [];
  const sealed = !!(body.admit_proof || proofs.length)
    && Array.isArray(body.vin) && body.vin.length > 0
    && Array.isArray(body.vout) && body.vout.length > 0;
  if (!sealed) return { status: 400, json: { ok: false, reason: 'bad_send' } };
  if (!(body.sig || body.signature) || !body.spendPub) {
    return { status: 403, json: { ok: false, reason: 'unsigned' } };
  }
  const fee = parseIntegerNanos(body.fee);
  if (fee == null) return { status: 400, json: { ok: false, reason: 'bad_send' } };
  const draft = {
    kind: 'send',
    fee: wireNanos(fee),
    maxLevy: body.maxLevy != null ? body.maxLevy : wireNanos(fee),
    vin: body.vin,
    vout: body.vout,
    sig: body.sig || body.signature,
    spendPub: body.spendPub,
    ...(body.memoCt ? { memoCt: body.memoCt } : {}),
    ...(body.excess ? { excess: body.excess } : {}),
    ...(body.admit_proof ? { admit_proof: body.admit_proof } : {}),
    ...(body.spendTag != null ? { spendTag: body.spendTag } : {}),
    ...(proofs.length ? { admit_proofs: proofs } : {}),
    ...(body.fs1 != null && body.fs1 !== '' ? { fs1: body.fs1 } : {}),
    ...(Number.isSafeInteger(body.anchor) && body.anchor > 0 ? { anchor: body.anchor } : {}),
  };
  const open = valueOpenRejected(draft);
  if (open) return { status: 400, json: { ok: false, reason: open.reason } };
  if (dummyCount(draft) < 1) return { status: 400, json: { ok: false, reason: 'dummy_outs' } };
  const need = levyNeed(draft);
  if (!(Number(fee) >= need) || Number(fee) > LEVY_CAP_NANOS) {
    return { status: 400, json: { ok: false, reason: 'levy' } };
  }
  const tx = typeof queueSend === 'function' ? queueSend(draft, { paintedOwedNanos: 0 }) : null;
  if (!tx || (typeof tx === 'object' && tx.ok === false)) {
    return { status: 400, json: { ok: false, reason: tx?.reason || 'queue_failed' } };
  }
  const submitLine = walletSubmitLog({ connId: newConnId(), ok: true });
  if (lineJoinsIpToIdentity(submitLine)) return { status: 500, json: { ok: false, reason: 'log' } };
  return {
    status: 200,
    json: { ok: true, tx: { id: tx.id, kind: 'send', confirmed: false, memo: !!body.memoCt }, log: submitLine },
  };
}

/**
 * The pool is not an authority for a wallet tx. Queue the posted object
 * itself. Do not copy fields, drop fields, or stamp a pool decision onto it.
 * The node accepts or rejects that same body.
 */
function relayPostedTx(body, queueSend) {
  const tx = typeof queueSend === 'function' ? queueSend(body, { paintedOwedNanos: 0 }) : null;
  if (!tx || (typeof tx === 'object' && tx.ok === false)) {
    return { status: 400, json: { ok: false, reason: tx?.reason || 'queue_failed' } };
  }
  const submitLine = walletSubmitLog({ connId: newConnId(), ok: true });
  if (lineJoinsIpToIdentity(submitLine)) return { status: 500, json: { ok: false, reason: 'log' } };
  return {
    status: 200,
    json: {
      ok: true,
      tx: { id: tx.id, kind: body.kind, confirmed: false, memo: !!body.memoCt },
      log: submitLine,
    },
  };
}

/** 20-byte lock dest on the tx or on its lock output. Recognition only. The body is not rewritten. */
function postedLockDest20(body) {
  const top = postedPayoutDest20(body?.dest20);
  if (top) return top;
  const rows = Array.isArray(body?.vout) ? body.vout : [];
  for (const row of rows) {
    if (!row || String(row.kind || '') !== 'lock') continue;
    const one = postedPayoutDest20(row.dest20);
    if (one) return one;
  }
  return null;
}

/**
 * A reward claim is a user tx. The posted fee is the same bid a sealed send
 * carries: required, at least the weight levy, and at most the levy cap.
 * The mempool orders it by fee rate. The whole fee is paid to miners.
 */
function queuedRewardClaim(body, { queueSend }) {
  if (String(body.programId || '') !== RESERVE_PROGRAM) {
    return { status: 400, json: { ok: false, reason: 'bad_kind' } };
  }
  const to = String(body.to || '').trim();
  if (!isDestAddress(to)) return { status: 400, json: { ok: false, reason: 'bad_send' } };
  const nanos = parseIntegerNanos(body.nanos);
  if (nanos == null || nanos <= 0n) return { status: 400, json: { ok: false, reason: 'bad_send' } };
  const nullifier = String(body.nullifier || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(nullifier)) return { status: 400, json: { ok: false, reason: 'bad_send' } };
  if (!Array.isArray(body.proof)) return { status: 400, json: { ok: false, reason: 'bad_send' } };
  const vout = Array.isArray(body.vout) ? body.vout.filter((o) => o && typeof o === 'object') : [];
  if (!vout.length || String(vout[0].kind || '') !== 'reward-claim') {
    return { status: 400, json: { ok: false, reason: 'bad_send' } };
  }
  const fee = parseIntegerNanos(body.fee);
  if (fee == null) return { status: 400, json: { ok: false, reason: 'bad_send' } };
  const draft = {
    id: typeof body.id === 'string' && body.id ? body.id : `claim-${Date.now()}`,
    programId: RESERVE_PROGRAM,
    mint: true,
    kind: 'reward-claim',
    to,
    nanos: wireNanos(nanos),
    nullifier,
    proof: body.proof,
    fee: wireNanos(fee),
    vin: [],
    vout,
  };
  const need = levyNeed(draft);
  const paid = Number(draft.fee);
  if (!(paid >= need) || paid > LEVY_CAP_NANOS) {
    return { status: 400, json: { ok: false, reason: 'levy' } };
  }
  const tx = typeof queueSend === 'function' ? queueSend(draft, { paintedOwedNanos: 0 }) : null;
  if (!tx || (typeof tx === 'object' && tx.ok === false)) {
    return { status: 400, json: { ok: false, reason: tx?.reason || 'queue_failed' } };
  }
  const submitLine = walletSubmitLog({ connId: newConnId(), ok: true });
  if (lineJoinsIpToIdentity(submitLine)) return { status: 500, json: { ok: false, reason: 'log' } };
  return {
    status: 200,
    json: { ok: true, tx: { id: tx.id, kind: 'reward-claim', fee: draft.fee, confirmed: false }, log: submitLine },
  };
}

/** The client attached a spend body. A from/to/amount quote is not one. */
function clientPostedSpendBody(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.admit_proof) return true;
  if (Array.isArray(body.admit_proofs) && body.admit_proofs.length > 0) return true;
  return Array.isArray(body.vin) && body.vin.length > 0
    && Array.isArray(body.vout) && body.vout.length > 0;
}

function clientHasSpendSig(body) {
  return !!(body && (body.sig || body.signature) && body.spendPub);
}

/** FS-1 blob. The first byte is 0xF1. Hex or raw bytes. */
function postedFs1(body) {
  const raw = body?.fs1;
  if (raw == null || raw === '') return false;
  try {
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
      return raw.length > 0 && raw[0] === 0xf1;
    }
    const hex = String(raw).replace(/^0x/i, '');
    return /^f1[0-9a-f]*$/i.test(hex) && hex.length >= 2;
  } catch {
    return false;
  }
}

/** A 64-byte Ed25519 signature, hex or raw bytes. */
function postedSig64(raw) {
  if (raw == null || raw === '') return false;
  try {
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return raw.length === 64;
    return /^[0-9a-f]{128}$/i.test(String(raw).replace(/^0x/i, ''));
  } catch {
    return false;
  }
}

const SHE_SCALE = 100_000_000_000n;
const MAX_SAFE_NANOS = 9007199254740991n;

function wireNanos(n) {
  return n <= MAX_SAFE_NANOS ? Number(n) : n.toString();
}

/** Decimal integer nanos. A JS number is accepted only while it is still exact. */
export function parseIntegerNanos(raw) {
  if (typeof raw === 'bigint') return raw >= 0n ? raw : null;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) return null;
    return BigInt(raw);
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!/^\d+$/.test(s)) return null;
    return BigInt(s);
  }
  return null;
}

/**
 * SHE as a decimal string, or a JS number only when nanos stay inside 2^53.
 * A number past that is refused. It is not rounded into a nearby integer.
 */
export function parseSheToNanos(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    const legacy = Math.round(raw * Number(SHE_SCALE));
    if (!Number.isSafeInteger(legacy) || legacy < 0) return null;
    return BigInt(legacy);
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 11 && /[^0]/.test(frac.slice(11))) return null;
  const frac11 = frac.slice(0, 11).padEnd(11, '0');
  return BigInt(whole) * SHE_SCALE + BigInt(frac11 || '0');
}

export function parseSendNanos(body) {
  if (body && body.nanos != null && body.nanos !== '') {
    const n = parseIntegerNanos(body.nanos);
    if (n == null) return { ok: false };
    return { ok: true, nanos: n };
  }
  if (body && body.amount != null && body.amount !== '') {
    const n = parseSheToNanos(body.amount);
    if (n == null) return { ok: false };
    return { ok: true, nanos: n };
  }
  return { ok: true, nanos: null };
}

export function handleWalletApi(url, method, body, { store, miners, queueSend, lastJob, poolDest, pendingPulls, completeMinerPull, nodesOnline, networkPending, networkRounds, poolOpen, poolIdentity, pullBook } = {}) {
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
        networkPending,
        networkRounds,
        hashBonusNanos: hashBonusUnitNanos(store?.reserveVault?.liveHashBonusNanos),
      }),
    };
  }
  if ((path === '/api/wallet/fluxset' || path === '/api/wallet/jroot') && verb === 'GET') {
    const live = typeof store?.fluxset === 'function'
      ? store.fluxset()
      : { pubs: [], spendTags: new Set(), jroot: Buffer.alloc(32) };
    const root = Buffer.from(live.jroot || store?.jroot?.() || Buffer.alloc(32));
    if (path === '/api/wallet/jroot') {
      return { status: 200, json: { ok: true, jroot: root.toString('hex') } };
    }
    const pubs = [];
    const commits = [];
    const srcPubs = live.pubs || [];
    const srcCommits = live.commits || [];
    if (srcPubs.length === srcCommits.length) {
      for (let i = 0; i < srcPubs.length; i += 1) {
        let p = '';
        let c = '';
        try {
          p = Buffer.from(typeof srcPubs[i]?.toBytes === 'function' ? srcPubs[i].toBytes() : srcPubs[i]).toString('hex');
        } catch { p = ''; }
        try {
          c = Buffer.from(srcCommits[i]).toString('hex');
        } catch { c = ''; }
        if (p.length !== 64 || c.length !== 64) continue;
        pubs.push(p);
        commits.push(c);
      }
    }
    const spendTags = [...(live.spendTags || [])];
    // J is the pair (admit pub, note commit) in one order. A count with no
    // commit column cannot be proved.
    const tipHeight = Number((typeof store?.tip === 'function' ? store.tip()?.height : 0) || 0);
    const whole = pubs.length === srcPubs.length;
    const anchors = whole && typeof store?.anchorNote === 'function' ? fs1AnchorRows(tipHeight, store.anchorNote) : [];
    return {
      status: 200,
      json: {
        ok: true,
        jroot: root.toString('hex'),
        noteCount: pubs.length,
        spendTagCount: spendTags.length,
        height: tipHeight,
        anchors,
        pubs,
        commits,
      },
    };
  }
  if (AMOUNT_ROUTES.has(path)) {
    return { status: 404, json: { ok: false, reason: 'route' } };
  }
  if (path === '/api/wallet/register' && verb === 'POST') {
    return { status: 404, json: { ok: false, reason: 'register_disabled' } };
  }
  if (path === '/api/explorer/header' && verb === 'GET') {
    const height = Math.floor(Number(url.searchParams.get('height') || 0));
    const b = headerBlockAt(store, height);
    if (!b) return { status: 404, json: { ok: false, reason: 'unknown_height' } };
    const raw = Buffer.isBuffer(b.header) ? b.header : Buffer.from(b.header || []);
    return {
      status: 200,
      json: {
        ok: true,
        height,
        header: raw.toString('hex'),
        continuity: raw.length >= 100 ? raw.subarray(68, 100).toString('hex') : '',
      },
    };
  }
  if (path === '/api/explorer/headers' && verb === 'GET') {
    const from = Math.max(1, Math.floor(Number(url.searchParams.get('from') || 1)));
    const toRaw = Math.floor(Number(url.searchParams.get('to') || from));
    const to = Math.min(Math.max(from, toRaw), from + 1999);
    const headers = [];
    for (let h = from; h <= to; h += 1) {
      const b = headerBlockAt(store, h);
      if (!b) continue;
      const raw = Buffer.isBuffer(b.header) ? b.header : Buffer.from(b.header || []);
      headers.push({ height: h, header: raw.toString('hex') });
    }
    return { status: 200, json: { ok: true, from, to, headers } };
  }
  if ((path === '/api/explorer/tx' || path.startsWith('/api/explorer/tx/')) && verb === 'GET') {
    const id = url.searchParams.get('id')
      || decodeURIComponent(path.slice('/api/explorer/tx/'.length).split('/')[0] || '');
    const got = publicBlockDetail(store, id);
    if (!got) return { status: 404, json: { ok: false, reason: 'unknown_tx' } };
    return { status: 200, json: { ok: true, asset: 'SHE', ...got } };
  }
  if (path === '/api/explorer/history' && (verb === 'GET' || verb === 'POST')) {
    const txs = confirmedBlockTxs(store, 30).map((t) => explorerRowPublic({
      ...t,
      kind: t.kind || 'block',
      memo: false,
    }));
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
  if (path === '/api/explorer/recent' && verb === 'GET') {
    const txs = explorerRecentTxs(store, EXPLORER_RECENT_CAP);
    return { status: 200, json: { ok: true, txs, asset: 'SHE' } };
  }
  if (path === '/api/pool/recent-txs' && verb === 'GET') {
    const txs = explorerRecentTxs(store, 30);
    return { status: 200, json: { ok: true, txs, asset: 'SHE' } };
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
    if (body.viewKey || body.V || body.view || body.restFrame || body.rest || body.paymentCode) {
      return { status: 400, json: { ok: false, reason: 'rest_frame' } };
    }
    if (isShearAddress(body.from) || isShearAddress(body.to)) {
      return { status: 400, json: { ok: false, reason: 'rest_frame' } };
    }
    if (body.lockedLeaves != null || body.planDir != null) {
      return { status: 400, json: { ok: false, reason: 'vote_plan_local' } };
    }
    if (String(body.kind || 'send') === 'send') {
      return sealedSendOnly(body, { queueSend });
    }
    if (String(body.kind || '') === 'reward-claim') {
      return queuedRewardClaim(body, { queueSend });
    }
    const from = isDestAddress(String(body.from || '')) ? String(body.from).trim() : '';
    const rawTo = String(body.to || '').trim();
    let to = '';
    let ephPub = body.ephPub || null;
    if (isDestAddress(rawTo)) {
      to = rawTo;
    } else if (isFullPaymentCode(rawTo) || isPaymentCode(rawTo)) {
      return { status: 400, json: { ok: false, reason: 'need_dest' } };
    }
    const parsed = parseSendNanos(body);
    if (!parsed.ok) return { status: 400, json: { ok: false, reason: 'bad_send' } };
    const kindIn = String(body.kind || 'send');
    const programIn = String(body.programId || '');
    const isLock = kindIn === 'lock' && programIn === RESERVE_PROGRAM;
    if (isLock && String(body.to || '').trim() !== '') {
      return { status: 400, json: { ok: false, reason: 'vote_leak' } };
    }
    const portalHex = String(body.portalId || '').replace(/^0x/i, '').toLowerCase();
    const hiddenLock = isLock
      && String(body.from || '').trim() === ''
      && String(body.to || '').trim() === ''
      && /^[0-9a-f]{64}$/.test(portalHex)
      && !!postedLockDest20(body)
      && postedFs1(body)
      && Array.isArray(body.vout) && body.vout.some((o) => o && o.commit);
    if (isLock && body.payoutPortalId != null && String(body.payoutPortalId) !== '') {
      return { status: 400, json: { ok: false, reason: 'vote_leak' } };
    }
    // A hidden lock is the wallet's signed tx. Relay it unchanged.
    if (hiddenLock) return relayPostedTx(body, queueSend);
    // Every other lock is refused here. The node accepts only the compact FS-1
    // lock (no from, to or address), so the pool never builds one itself.
    if (isLock) {
      const lockOuts = (Array.isArray(body.vout) ? body.vout : []).filter((row) => row && String(row.kind || '') === 'lock');
      if (lockOuts.length > 1) return { status: 400, json: { ok: false, reason: 'portal_exists' } };
      return { status: 400, json: { ok: false, reason: 'bad_send' } };
    }
    const isVote = kindIn === 'vote' && programIn === RESERVE_PROGRAM;
    const isWithdraw = kindIn === 'withdraw' && programIn === RESERVE_PROGRAM;
    const multiProofsEarly = Array.isArray(body.admit_proofs) && body.admit_proofs.length > 1;
    const sealedSendEarly = kindIn === 'send'
      && (body.admit_proof || multiProofsEarly)
      && Array.isArray(body.vin) && body.vin.length
      && Array.isArray(body.vout) && body.vout.length
      && (body.sig || body.signature)
      && body.spendPub;
    const fundedWithdraw = isWithdraw
      && body.fs1
      && Array.isArray(body.vin) && body.vin.length > 0
      && (body.retireProof || (Array.isArray(body.retireProofs) && body.retireProofs.length))
      && (body.principalProof || (Array.isArray(body.principalProofs) && body.principalProofs.length));
    // An FS-1 withdraw carries no identity spendPub or spend sig (consensus
    // refuses one as vote_leak). Its signature is the portal owner's rewardSig
    // over ownerPub, and the node checks it with the SAL when it queues the tx.
    const fs1Withdraw = fundedWithdraw
      && postedFs1(body)
      && (body.spendPub == null || body.spendPub === '')
      && !body.sig && !body.signature
      && postedSig64(body.rewardSig)
      && /^[0-9a-f]{64}$/.test(String(body.ownerPub || '').replace(/^0x/i, '').toLowerCase());
    // A proved withdraw with a one-time dest20 has no address on the wire.
    const hiddenWithdraw = fundedWithdraw && !isDestAddress(to) && !!postedPayoutDest20(body.dest20);
    if ((!sealedSendEarly && !fundedWithdraw && !isDestAddress(from)) || (!isDestAddress(to) && !hiddenWithdraw)) {
      return { status: 400, json: { ok: false, reason: 'bad_send' } };
    }
    const nanosBi = isVote ? 0n : parsed.nanos;
    if ((nanosBi == null || nanosBi <= 0n) && !isVote && !sealedSendEarly) {
      return { status: 400, json: { ok: false, reason: 'bad_send' } };
    }
    if (kindIn !== 'send' && !isVote && !isWithdraw) {
      return { status: 400, json: { ok: false, reason: 'bad_kind' } };
    }
    const poolPay = isDestAddress(String(poolDest || '')) ? String(poolDest) : '';
    if (poolPay && from === poolPay) {
      return { status: 403, json: { ok: false, reason: 'pool_dest' } };
    }
    const rec = ((sealedSendEarly || fundedWithdraw) && !isDestAddress(from))
      ? { spendableNanos: 0 }
      : reconstructOwner(store, from);
    const nanos = nanosBi == null ? 0 : wireNanos(nanosBi);
    const amount = typeof nanos === 'number' ? nanos / NANOS_PER_SHE : nanos;
    const chainNanos = rec.spendableNanos;
    const multiProofs = Array.isArray(body.admit_proofs) && body.admit_proofs.length > 1;
    const sealedSend = kindIn === 'send'
      && (body.admit_proof || multiProofs)
      && Array.isArray(body.vin) && body.vin.length
      && Array.isArray(body.vout) && body.vout.length
      && (body.sig || body.signature)
      && body.spendPub;
    // A posted body with no signature is unsigned, including when the book is short.
    if (clientPostedSpendBody(body) && !clientHasSpendSig(body) && !fs1Withdraw && (kindIn === 'send' || isVote || isWithdraw)) {
      return { status: 403, json: { ok: false, reason: 'unsigned' } };
    }
    if (!isVote && !isWithdraw && !sealedSend && chainNanos < nanos) {
      return { status: 400, json: { ok: false, reason: 'insufficient' } };
    }
    // A withdraw is relayed as posted, so its outputs are not stripped: the
    // node's own rule below (valueOpenRejected) refuses an opened hidden value
    // and lets an empty valueProof through, as the node does.
    if (Array.isArray(body.vout) && !isWithdraw) {
      body.vout = stripHiddenValueOpen(kindIn, body.vout);
    }
    const postedOpen = valueOpenRejected({ kind: kindIn, vout: body.vout });
    if (postedOpen) return { status: 400, json: { ok: false, reason: 'value_open' } };
    const memoCt = body.memoCt || null;
    const kind = isVote ? 'vote' : isWithdraw ? 'withdraw' : 'send';
    const programId = (isVote || isWithdraw) ? RESERVE_PROGRAM : '';
    const taxed = levyTaxed({ kind, programId });
    const postedFee = (body.fee == null || body.fee === '') ? null : parseIntegerNanos(body.fee);
    if ((body.fee != null && body.fee !== '') && postedFee == null) {
      return { status: 400, json: { ok: false, reason: 'bad_send' } };
    }
    let fee = postedFee != null
      ? wireNanos(postedFee)
      : (taxed ? levyNanos(0) : 0);
    if (!isVote && !isWithdraw && !sealedSend && chainNanos < nanos + fee) {
      return { status: 400, json: { ok: false, reason: 'insufficient' } };
    }
    const rawChange = String(body.change || '').trim();
    const changeDest = !isVote && !isWithdraw
      ? (isDestAddress(rawChange) ? rawChange : '')
      : '';
    if (changeDest && changeDest === from) {
      return { status: 400, json: { ok: false, reason: 'same_dest' } };
    }
    const leftover = rec.spendableNanos - nanos - fee;
    const vout = [{ address: to, nanos, kind }];
    if (kind === 'send' && changeDest && leftover > 0) {
      vout.push({ address: changeDest, nanos: leftover, kind: 'send' });
    }
    const postedVout = Array.isArray(body.vout) ? body.vout.filter((o) => o && o.commit) : [];
    if (postedVout.length) {
      vout.length = 0;
      for (const o of postedVout) vout.push(o);
    }
    const parked = kind === 'send' && changeDest && leftover > 0;
    let withdrawNonce;
    if (isWithdraw && body.withdrawNonce != null && body.withdrawNonce !== '') {
      try {
        withdrawNonce = withdrawNonceBytes(body.withdrawNonce);
      } catch {
        return { status: 400, json: { ok: false, reason: 'kt10_nonce' } };
      }
    }
    const draft = isVote
        ? {
          ...voteTx({ from, dest: to, choice: body.choice, id: `vote-${Date.now()}` }),
          fee,
          maxLevy: fee,
          sig: body.sig || body.signature,
          spendPub: body.spendPub,
          payer: from,
          ...(postedVout.length ? { vout: postedVout } : {}),
        }
        : isWithdraw
        ? buildFundedWithdraw({
          nanos,
          id: typeof body.id === 'string' && body.id ? body.id : `withdraw-${Date.now()}`,
          withdrawNonce,
          portalId: body.portalId,
          vin: body.vin,
          vout: postedVout.length ? postedVout : body.vout,
          fs1: body.fs1,
          anchor: body.anchor,
          excess: body.excess,
          fee,
          admit_proof: body.admit_proof,
          admit_proofs: body.admit_proofs,
          retireProof: body.retireProof,
          retireProofs: body.retireProofs,
          principalProof: body.principalProof,
          principalProofs: body.principalProofs,
          sig: body.sig || body.signature,
          spendPub: body.spendPub,
          rewardSig: body.rewardSig,
          ownerPub: body.ownerPub,
          dest20: body.dest20,
        })
        : {
          kind, from, to, nanos, amount, fee, maxLevy: fee, memoCt, sig: body.sig || body.signature, spendPub: body.spendPub, ephPub,
          vin: Array.isArray(body.vin) && body.vin.length ? body.vin : [{ address: from }],
          vout,
          ...(body.excess ? { excess: body.excess } : {}),
          ...(body.admit_proof ? { admit_proof: body.admit_proof, spendTag: body.spendTag || body.admit_proof.spendTag } : {}),
          ...(multiProofs ? { admit_proofs: body.admit_proofs } : {}),
          ...(parked ? { change: changeDest, changeNanos: leftover } : {}),
        };
    if (isVote && draft) {
      const carriedPortal = String(body.portalId || '').replace(/^0x/i, '').toLowerCase();
      const carriedPayout = String(body.payoutPortalId || '').replace(/^0x/i, '').toLowerCase();
      if (/^[0-9a-f]{64}$/.test(carriedPortal)) {
        draft.portalId = carriedPortal;
        if (!postedVout.length && Array.isArray(draft.vout)) {
          for (const row of draft.vout) {
            if (row && row.kind === 'vote') row.portalId = carriedPortal;
          }
        }
      }
      if (/^[0-9a-f]{64}$/.test(carriedPayout)) draft.payoutPortalId = carriedPayout;
    }
    if (isWithdraw && !draft) {
      return { status: 400, json: { ok: false, reason: 'withdraw_funding' } };
    }
    // Same leak rule the node applies. Do not relay a withdraw it will refuse.
    const wdLeak = isWithdraw ? withdrawLeakRejected(draft) : null;
    if (wdLeak) return { status: 400, json: { ok: false, reason: wdLeak.reason } };
    // The FS-1 withdraw is relayed as posted, like the hidden lock: the draft
    // above is only the shape check. The pool does not stamp an id or a fee,
    // or drop a field, since the proofs and the rewardSig are bound to them.
    // The node verifies the rewardSig and everything else.
    if (isWithdraw) {
      const postedLeak = withdrawLeakRejected(body);
      if (postedLeak) return { status: 400, json: { ok: false, reason: postedLeak.reason } };
      // A withdraw signs its id (reserveDigestSuffix). queueSend gives a body
      // with no id a fresh one, which would change a signed field, so a
      // withdraw posted with no id is refused here, plainly.
      if (body.id == null || String(body.id) === '') {
        return { status: 400, json: { ok: false, reason: 'withdraw_id' } };
      }
      const paid = postedFee == null ? NaN : Number(postedFee);
      if (!(paid >= levyNeed(body)) || paid > LEVY_CAP_NANOS) {
        return { status: 400, json: { ok: false, reason: 'levy' } };
      }
      return relayPostedTx(body, queueSend);
    }
    if (taxed && postedFee == null) bindWeightFee(draft);
    if (taxed) {
      const need = levyNeed(draft);
      const paid = Number(draft.fee);
      if (!(paid >= need) || paid > LEVY_CAP_NANOS) {
        return { status: 400, json: { ok: false, reason: 'levy' } };
      }
      fee = draft.fee;
    }
    if (kind === 'send' && dummyCount(draft) < 1) {
      return { status: 400, json: { ok: false, reason: 'dummy_outs' } };
    }
    if (kind === 'send' && multiProofs) {
      const need = levyNeed(draft);
      if (!(fee >= need) || fee > LEVY_CAP_NANOS) {
        return { status: 400, json: { ok: false, reason: 'levy' } };
      }
    }
    if (kind === 'send' && !draft.admit_proof && !multiProofs) {
      const chainCovers = chainNanos >= nanos + fee;
      if (!(chainCovers && verifySpendSig(draft))) {
        return { status: 400, json: { ok: false, reason: 'admit_membership' } };
      }
    }
    if (flowSendNeedsOpen(draft) && !verifySpendSig(draft)) {
      return { status: 403, json: { ok: false, reason: 'unsigned' } };
    }
    if (reserveNeedsPortalOpen(draft) && !verifyReservePortalOpen(draft)) {
      return { status: 403, json: { ok: false, reason: 'unsigned' } };
    }
    const tx = queueSend(draft, { paintedOwedNanos: 0 });
    if (tx && typeof tx === 'object' && tx.ok === false) {
      return { status: 400, json: { ok: false, reason: tx.reason || 'queue_failed' } };
    }
    const submitLine = walletSubmitLog({ connId: newConnId(), ok: true });
    if (lineJoinsIpToIdentity(submitLine)) {
      return { status: 500, json: { ok: false, reason: 'log' } };
    }
    return {
      status: 200,
      json: {
        ok: true,
        tx: {
          id: tx.id, from, to, amount, kind, programId: programId || undefined, confirmed: false, memo: !!memoCt,
          ...(parked ? { change: changeDest } : {}),
        },
        fromBalance: parked ? 0 : nanosToShe(Math.max(0, rec.spendableNanos - nanos - fee)),
        ...(parked ? { changeBalance: nanosToShe(leftover) } : {}),
        log: submitLine,
      },
    };
  }
  if (path === '/api/vault/reserve' && verb === 'GET') {
    if (url.searchParams.get('view') === 'tranches') {
      const vault = store?.reserveVault;
      if (!vault) return { status: 503, json: { ok: false, reason: 'no_vault' } };
      return { status: 200, json: { ok: true, tranches: publicTrancheBook(vault) } };
    }
    const portalQ = String(url.searchParams.get('portal') || '').replace(/^0x/i, '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(portalQ)) {
      const vault = store?.reserveVault;
      if (!vault) return { status: 503, json: { ok: false, reason: 'no_vault' } };
      return {
        status: 200,
        json: {
          ok: true,
          portalId: portalQ,
          tranches: publicTrancheRows(vault.portals?.[portalQ] || null),
        },
      };
    }
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
        extraMint: extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }),
        ...publicVaultView(vault, now),
        ...portalRewards(vault, dest, now),
        sums: vortexSums(vault, dest, url.searchParams.get('flow') || 0),
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
    const tag = String(url.searchParams.get('tag') || '').trim().toLowerCase();
    let rec = null;
    if (pendingPulls && typeof pendingPulls.get === 'function') {
      if (/^m[0-9a-f]{8}$/.test(tag)) rec = pendingPulls.get(`tag:${tag}`) || null;
      else if (login.startsWith('she1')) rec = pendingPulls.get(login.toLowerCase()) || null;
    }
    if (!rec && !login.startsWith('she1') && !/^m[0-9a-f]{8}$/.test(tag)) {
      return { status: 400, json: { ok: false, reason: 'need_she1', public: false } };
    }
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
    return {
      status: 410,
      json: {
        ok: false,
        reason: 'auto_payout',
        deprecated: true,
        public: false,
        dest: 'ssa1',
      },
    };
  }
  if (false && path === '/api/pool/withdraw' && verb === 'POST') {
    const login = body.login || body.she1;
    const rawDest = String(body.dest || body.to || '').trim();
    const nanos = body.nanos != null ? body.nanos : Math.round(Number(body.amount || 0) * NANOS_PER_SHE);
    const sig = body.sig || body.signature;
    const dests = [...new Set([rawDest, payoutDest(rawDest) || ''].filter(Boolean))];
    let off = { ok: false, reason: 'unsigned' };
    for (const dest of dests) {
      off = verifyPoolWithdrawOffchain({
        login,
        dest,
        nanos,
        sig,
        minerShe1: login,
        payoutSsa1: dest,
        height: body.height,
        nonce: body.nonce,
        deadline: body.deadline,
        nonceStore: withdrawNonces,
        seenDigests: withdrawDigests,
        open: body.open,
        spendSig: body.spendSig,
        ownerPub: ownerPubFromOpening(body.open),
        requireOwner: true,
      });
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
      if (!hiddenAmountRangeReady()) {
        return { status: 503, json: { ok: false, reason: 'range_native_required', public: false } };
      }
      const open = openingForSpentDest(poolIdentity, from) || String(poolOpen || '');
      const draft = attachDummyOuts({
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
      });
      if (flowSendNeedsOpen(draft) && !verifySpendSig(draft)) {
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

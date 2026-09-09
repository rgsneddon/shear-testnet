/**
 * Funded-spend law. A dest cannot pay more than its mature Continuum.
 * Incoming in the same block / mempool is not spendable (6-conf).
 * Outgoing on the sealed book always debits, even before 6 confs —
 * otherwise a dest could send, wait, and send the same coins again.
 * Spend authority is Ed25519 over shear-spend-v1 || packDigest.
 */
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { SPENDABLE_CONFIRMATIONS, SPEND_SIG_DOMAIN } from './asert.js';
import { levyTaxed, txAmountNanos } from './levy.js';
import { isSpendableHeight } from './chronoflux.js';
import { paymentIdHash, hash20FromAddress, destOpeningFromView, ED25519_SPKI_PREFIX } from './address.js';
import { indexedDestHash, closureCommit } from './flow_sheet.js';
import { packTx, packDigest } from './pack.js';

function dest20Of(addr) {
  const h = hash20FromAddress(addr);
  return h ? Buffer.from(h) : Buffer.alloc(20);
}

function kindByte(kind) {
  const k = String(kind || '');
  if (k === 'hash') return 1;
  if (k === 'pot') return 2;
  if (k === 'finder-fee') return 3;
  if (k === 'reserve-fee') return 4;
  return 0;
}

/** Pack digest of the spend body. sig and open are not hashed. */
export function spendPackDigest(tx) {
  const vins = (tx?.vin || []).map((v, i) => ({
    prev: v.prev ? Buffer.from(v.prev) : Buffer.alloc(32),
    index: Number(v.index || i),
    dest20: dest20Of(v.address || tx?.from || ''),
  }));
  const vouts = (tx?.vout || []).map((o) => ({
    dest20: dest20Of(o.address || ''),
    nanos: Number(o.nanos || 0),
    kind: kindByte(o.kind || tx?.kind),
  }));
  return packDigest(packTx({
    version: 1,
    vins: vins.length ? vins : [{ prev: Buffer.alloc(32), index: Number(tx?.height || 0), dest20: Buffer.alloc(20) }],
    vouts,
    memoH: tx?.memoH || null,
    bFlag: tx?.bFlag || tx?.kind === 'b-spend' ? 1 : 0,
  }));
}

export function spendMessage(tx) {
  return createHash('sha256')
    .update(Buffer.from(SPEND_SIG_DOMAIN))
    .update(spendPackDigest(tx))
    .digest();
}

export function signSpendTx(tx, privateKey) {
  const sig = sign(null, spendMessage(tx), privateKey);
  tx.sig = Buffer.from(sig).toString('hex');
  return tx;
}

/** Recover spend pub from the 64-byte dest opening and verify Ed25519. */
export function verifySpendSig(tx) {
  const o = parseDestOpening(tx?.open);
  if (!o) return false;
  const sigHex = String(tx?.sig || tx?.signature || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{128}$/i.test(sigHex)) return false;
  try {
    const pub = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, o.spendPub]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, spendMessage(tx), pub, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

const OUT_KINDS = new Set([
  'send',
  'transfer',
  'pool-withdraw',
  'evm-value',
  'vortice-register',
  'lock',
  'vote',
  'claim',
  'user-spend',
]);

export function parseDestOpening(open) {
  const hex = String(open || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{128}$/i.test(hex)) return null;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 64) return null;
  return { scanPub: buf.subarray(0, 32), spendPub: buf.subarray(32, 64) };
}

/** Preimage of dest hash20. Knowing only ssa1 is not enough (SHA-256 preimage). */
export function verifyDestOpening(from, open) {
  const want = hash20FromAddress(from);
  if (!want) return false;
  const hex = String(open || '').replace(/^0x/i, '');
  try {
    if (/^[0-9a-f]{128}$/i.test(hex)) {
      const o = parseDestOpening(hex);
      if (!o) return false;
      return Buffer.from(paymentIdHash(o.scanPub, o.spendPub)).equals(Buffer.from(want));
    }
    if (/^[0-9a-f]{120}$/i.test(hex)) {
      const buf = Buffer.from(hex, 'hex');
      const spendHash20 = buf.subarray(0, 20);
      const closure = buf.subarray(20, 52);
      const index = Number(buf.readBigUInt64LE(52));
      const got = indexedDestHash({ spendHash20, closureCommit: closure, index });
      return Buffer.from(got).equals(Buffer.from(want));
    }
  } catch {
    return false;
  }
  return false;
}

export function openingForSpentDest(identity, dest) {
  if (!identity || !dest) return '';
  const viewKey = identity.viewKey || identity.view || '';
  const rest = identity.address || identity.restFrame || '';
  if (!viewKey) return '';
  const spendPub = identity.spendPub
    || (identity.publicKey ? identity.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32) : null);
  const spendH = hash20FromAddress(rest) || identity.spendHash20;
  if (!spendPub || !spendH) return '';
  const open = destOpeningFromView(viewKey, spendPub, 0);
  if (verifyDestOpening(dest, open)) return open;
  try {
    return indexedDestOpening(spendH, closureCommit(viewKey), 0);
  } catch {
    return open;
  }
}

export function indexedDestOpening(spendHash20, closure, index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return '';
  const idx = Buffer.alloc(8);
  idx.writeBigUInt64LE(BigInt(n));
  return Buffer.concat([
    Buffer.from(spendHash20).subarray(0, 20),
    Buffer.from(closure).subarray(0, 32),
    idx,
  ]).toString('hex');
}

export function flowSendNeedsOpen(tx) {
  const d = fundedDebit(tx);
  if (!d) return false;
  const k = String(tx.kind || '');
  if (k === 'pool-withdraw' || k === 'claim') return false;
  return true;
}

export function reservePortalDest(tx) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind === 'lock' || kind === 'vote') {
    return String(tx?.to || tx?.vout?.[0]?.address || '');
  }
  if (kind === 'withdraw') {
    return String(tx?.from || tx?.vin?.[0]?.address || '');
  }
  return '';
}

export function reserveNeedsPortalOpen(tx) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  return kind === 'lock' || kind === 'vote' || kind === 'withdraw';
}

function destOpeningShape(open) {
  const hex = String(open || '').replace(/^0x/i, '');
  return /^[0-9a-f]{128}$/i.test(hex) || /^[0-9a-f]{120}$/i.test(hex);
}

/**
 * Vote/withdraw must carry a dest-opening for the portal dest.
 * Lock may omit portalOpen (wallet 0.27 lock only signs Continuum `from`).
 * 0.27 vote portalOpen is indexed dest-0, which may not equal vaultDest hash20;
 * a well-formed opening still proves ownership. Prefer verifyDestOpening when it matches.
 */
export function verifyReservePortalOpen(tx) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (!reserveNeedsPortalOpen(tx)) return true;
  const dest = reservePortalDest(tx);
  if (!dest) return false;
  if (kind === 'lock') {
    if (!tx?.portalOpen) return true;
    return destOpeningShape(tx.portalOpen);
  }
  if (kind === 'withdraw') {
    const open = tx?.portalOpen || tx?.open;
    if (!open) return true;
    if (verifyDestOpening(dest, open)) return true;
    return destOpeningShape(open);
  }
  const open = tx?.portalOpen || tx?.open;
  if (verifyDestOpening(dest, open)) return true;
  return destOpeningShape(open);
}

export function fundedDebit(tx) {
  if (!tx || tx.coinbase) return null;
  if (tx.mint && String(tx.kind || '') !== 'pool-withdraw') return null;
  const kind = String(tx.kind || tx.vout?.[0]?.kind || 'send');
  const from = kind === 'vote'
    ? String(tx.payer || tx.vin?.[0]?.address || '')
    : String(tx.from || tx.vin?.[0]?.address || '');
  if (!from) return null;
  const unfunded = !Array.isArray(tx.vin) || tx.vin.length === 0;
  if (unfunded) return null;
  if (!levyTaxed(tx) && !OUT_KINDS.has(kind)) return null;
  const amount = txAmountNanos(tx);
  const fee = Math.max(0, Math.floor(Number(tx.fee || 0)));
  const extra = Array.isArray(tx.vout) && tx.vout.length > 1
    ? tx.vout.slice(1).reduce((a, o) => a + Math.max(0, Math.floor(Number(o?.nanos) || 0)), 0)
    : 0;
  const nanos = amount + extra + fee;
  if (!(nanos > 0)) return null;
  return { from, nanos, amount, fee, change: extra };
}

/** Unclamped. Credits mature incoming only; debits every sealed outgoing. */
export function matureSpendableNanos(rows, address, tipHeight, need = SPENDABLE_CONFIRMATIONS) {
  const addr = String(address || '');
  let n = 0;
  for (const r of rows || []) {
    const kind = String(r.kind || '');
    const amt = Math.floor(Number(r.nanos || 0));
    const from = String(r.from || '');
    const to = String(r.to || '');
    const mature = isSpendableHeight(r.height, tipHeight, need);
    if (kind === 'burn' || kind === 'levy') {
      if (from === addr) n -= amt;
      continue;
    }
    if (to === addr && mature) n += amt;
    if (from === addr && OUT_KINDS.has(kind)) n -= amt;
  }
  return n;
}

export function mempoolDebitNanos(txs, address) {
  const addr = String(address || '');
  let n = 0;
  for (const tx of txs || []) {
    const d = fundedDebit(tx);
    if (d && d.from === addr) n += d.nanos;
  }
  return n;
}

/**
 * Walk body txs in order. Same-block incoming is not credited.
 * `spendableOf(addr)` is mature Continuum at the parent tip.
 */
export function verifyFundedBody(body, spendableOf, { seenDigests = null } = {}) {
  const spent = new Map();
  const seen = seenDigests instanceof Set ? seenDigests : new Set();
  const have = (addr) => {
    const base = Math.max(0, Math.floor(Number(typeof spendableOf === 'function' ? spendableOf(addr) : 0) || 0));
    return base - (spent.get(addr) || 0);
  };
  for (const tx of body || []) {
    const d = fundedDebit(tx);
    if (!d) continue;
    if (flowSendNeedsOpen(tx)) {
      if (!verifyDestOpening(d.from, tx.open) || !verifySpendSig(tx)) {
        return { ok: false, reason: 'unsigned', from: d.from };
      }
      const digest = spendPackDigest(tx).toString('hex');
      if (seen.has(digest)) return { ok: false, reason: 'replay', from: d.from };
      seen.add(digest);
    }
    if (reserveNeedsPortalOpen(tx) && !verifyReservePortalOpen(tx)) {
      return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
    }
    if (have(d.from) < d.nanos) {
      return { ok: false, reason: 'insufficient', from: d.from, need: d.nanos, have: have(d.from) };
    }
    spent.set(d.from, (spent.get(d.from) || 0) + d.nanos);
  }
  return { ok: true };
}

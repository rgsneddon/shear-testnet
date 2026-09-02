/**
 * Funded-spend law. A dest cannot pay more than its mature Continuum.
 * Incoming in the same block / mempool is not spendable (6-conf).
 * Outgoing on the sealed book always debits, even before 6 confs —
 * otherwise a dest could send, wait, and send the same coins again.
 */
import { SPENDABLE_CONFIRMATIONS } from './asert.js';
import { levyTaxed, txAmountNanos } from './levy.js';
import { isSpendableHeight } from './chronoflux.js';
import { paymentIdHash, hash20FromAddress } from './address.js';
import { indexedDestHash } from './flow_sheet.js';

const OUT_KINDS = new Set([
  'send',
  'transfer',
  'pool-withdraw',
  'evm-value',
  'vortice-register',
  'lock',
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

export function fundedDebit(tx) {
  if (!tx || tx.coinbase) return null;
  if (tx.mint && String(tx.kind || '') !== 'pool-withdraw') return null;
  const kind = String(tx.kind || tx.vout?.[0]?.kind || 'send');
  const from = String(tx.from || tx.vin?.[0]?.address || '');
  if (!from) return null;
  const unfunded = !Array.isArray(tx.vin) || tx.vin.length === 0;
  if (unfunded) return null;
  if (!levyTaxed(tx) && !OUT_KINDS.has(kind)) return null;
  const amount = txAmountNanos(tx);
  const fee = Math.max(0, Math.floor(Number(tx.fee || 0)));
  const nanos = amount + fee;
  if (!(nanos > 0)) return null;
  return { from, nanos, amount, fee };
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
export function verifyFundedBody(body, spendableOf) {
  const spent = new Map();
  const have = (addr) => {
    const base = Math.max(0, Math.floor(Number(typeof spendableOf === 'function' ? spendableOf(addr) : 0) || 0));
    return base - (spent.get(addr) || 0);
  };
  for (const tx of body || []) {
    const d = fundedDebit(tx);
    if (!d) continue;
    if (flowSendNeedsOpen(tx) && !verifyDestOpening(d.from, tx.open)) {
      return { ok: false, reason: 'unsigned', from: d.from };
    }
    if (have(d.from) < d.nanos) {
      return { ok: false, reason: 'insufficient', from: d.from, need: d.nanos, have: have(d.from) };
    }
    spent.set(d.from, (spent.get(d.from) || 0) + d.nanos);
  }
  return { ok: true };
}

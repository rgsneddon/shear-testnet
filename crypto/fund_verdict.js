/**
 * Node-local funding verdicts. The key is every funding byte of the tx
 * plus the tip, the anchor, and the anchor root. It is not the merkle
 * digest. A row is stored only after the tx is accepted. A hit does not
 * carry tags for another body: the caller checks the tx's own spend tags.
 * A tx field or RPC option cannot set a row.
 */
import { createHash } from 'node:crypto';
import { asU8, txProofs, txSpendTags } from './note.js';

const fundVerdicts = new Map();
const FUND_VERDICT_MAX = 8192;

function bytesOf(value) {
  if (value == null || value === '') return Buffer.alloc(0);
  try {
    const b = Buffer.from(asU8(value));
    return Buffer.isBuffer(b) ? b : Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}

function frame(parts, buf) {
  const b = buf && buf.length ? buf : Buffer.alloc(0);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  parts.push(len, b);
}

function frameStr(parts, text) {
  frame(parts, Buffer.from(String(text ?? ''), 'utf8'));
}

function tipBytes(tip) {
  const raw = tip && typeof tip === 'object' && Object.prototype.hasOwnProperty.call(tip, 'hash')
    ? tip.hash
    : tip;
  if (typeof raw === 'string' && /^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b = bytesOf(raw);
  if (b.length === 32) return b;
  return Buffer.alloc(32);
}

/** Bytes that fund a reserve tx, including every proof. The merkle digest is not this. */
export function fundingWitness(tx) {
  const parts = [];
  frameStr(parts, tx?.id);
  frameStr(parts, tx?.kind);
  frameStr(parts, tx?.portalId);
  frameStr(parts, tx?.payoutPortalId);
  frameStr(parts, tx?.programId);
  frameStr(parts, tx?.choice);
  frameStr(parts, Math.floor(Number(tx?.fee || tx?.paid || 0)));
  frameStr(parts, tx?.anchor ?? '');
  frame(parts, bytesOf(tx?.excess));
  frame(parts, bytesOf(tx?.memoH));
  frameStr(parts, (tx?.bFlag || tx?.kind === 'b-spend') ? 1 : 0);
  const vins = Array.isArray(tx?.vin) ? tx.vin : [];
  frameStr(parts, vins.length);
  for (const v of vins) {
    frame(parts, bytesOf(v?.commit));
    frame(parts, bytesOf(v?.cTilde));
    frame(parts, bytesOf(v?.prev));
    frame(parts, bytesOf(v?.noteCommit));
    frameStr(parts, v?.index ?? '');
  }
  const vouts = Array.isArray(tx?.vout) ? tx.vout : [];
  frameStr(parts, vouts.length);
  for (const o of vouts) {
    frame(parts, bytesOf(o?.commit));
    frame(parts, bytesOf(o?.rangeProof));
    frame(parts, bytesOf(o?.dest20));
    frameStr(parts, o?.kind || '');
    frameStr(parts, o?.nanos ?? '');
    frameStr(parts, o?.address || '');
  }
  const proofs = txProofs(tx);
  frameStr(parts, proofs.length);
  for (const proof of proofs) {
    frame(parts, bytesOf(proof?.blob ?? proof?.proof));
    frame(parts, bytesOf(proof?.cTilde));
    frame(parts, bytesOf(proof?.spendTag));
  }
  return createHash('sha256').update(Buffer.concat(parts)).digest();
}

function fundKey(tx, tip, anchor, rootHex) {
  const root = /^[0-9a-fA-F]{64}$/.test(String(rootHex || ''))
    ? Buffer.from(String(rootHex), 'hex')
    : Buffer.alloc(32);
  return createHash('sha256')
    .update(Buffer.from('fund-verdict-v1'))
    .update(tipBytes(tip))
    .update(Buffer.from(String(anchor)))
    .update(root)
    .update(fundingWitness(tx))
    .digest('hex');
}

export function rememberFundVerdict(tx, tip, anchor, rootHex, tags) {
  if (!tx || typeof tx !== 'object') return false;
  if (!Number.isInteger(anchor)) return false;
  if (typeof rootHex !== 'string' || rootHex.length !== 64) return false;
  if (!Array.isArray(tags) || tags.length < 1) return false;
  const own = txSpendTags(tx).tags.map((tag) => tag.toString('hex'));
  if (own.length !== tags.length) return false;
  const want = new Set(tags.map((tag) => String(tag)));
  if (own.some((tag) => !want.has(tag))) return false;
  const key = fundKey(tx, tip, anchor, rootHex);
  if (fundVerdicts.size >= FUND_VERDICT_MAX && !fundVerdicts.has(key)) {
    const first = fundVerdicts.keys().next().value;
    if (first !== undefined) fundVerdicts.delete(first);
  }
  fundVerdicts.set(key, own);
  return true;
}

export function readFundVerdict(tx, tip, anchor, rootHex) {
  if (!tx || typeof tx !== 'object') return null;
  if (!Number.isInteger(anchor)) return null;
  if (typeof rootHex !== 'string' || rootHex.length !== 64) return null;
  const tags = fundVerdicts.get(fundKey(tx, tip, anchor, rootHex));
  if (!tags) return null;
  return {
    ok: true,
    tags: tags.slice(),
    anchor: Number(anchor),
    root: String(rootHex),
  };
}

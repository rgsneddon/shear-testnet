/**
 * Funded-spend law. v12 value comes from a balanced ADMITv3 input.
 * An address balance is not value, and spendableOf is not consulted.
 * Spend authority is Ed25519 over shear-spend-v1 || packDigest.
 */
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { SPENDABLE_CONFIRMATIONS, SPEND_SIG_DOMAIN, RESERVE_PROGRAM } from './asert.js';
import { levyTaxed, txAmountNanos } from './levy.js';
import { isSpendableHeight, valueOpenRejected } from './chronoflux.js';
import { paymentIdHash, hash20FromAddress, destOpeningFromView, ED25519_SPKI_PREFIX, ed25519RawPub, destMatchesSpendPub, dest20MatchesSpendPub, encodeDest, isStealthKey, stealthSign, stealthSpendPubFrom, ed25519PrivateFromSeed } from './address.js';
import { indexedDestHash, closureCommit } from './flow_sheet.js';
import { packTx, packDigest } from './pack.js';
import { claimedVoutNanos, flowNeedsDummy } from './dummy.js';
import { asU8, verifyFlowConservation, verifySealedNote } from './note.js';
import { interestNanos } from './reserve_oracle.js';
import { portalIdFromDest, withdrawMintId, reserveDigestSuffix } from './reserve_vault.js';
import { typedAdmitStructure } from './admit_v3.js';

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
  if (k === 'dummy') return 5;
  return 0;
}

function dest20Field(x) {
  try {
    const b = Buffer.from(asU8(x));
    if (b.length >= 20) return Buffer.from(b.subarray(0, 20));
  } catch { /* ignore */ }
  return Buffer.alloc(20);
}

function lenPref(buf) {
  const body = Buffer.from(buf || []);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(body.length >>> 0);
  return Buffer.concat([n, body]);
}

function canonicalFee(tx) {
  const n = Math.floor(Number(tx?.fee || 0));
  const v = Number.isSafeInteger(n) && n > 0 ? n : 0;
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(v));
  return out;
}

function proofBlob(proof) {
  if (!proof) return Buffer.alloc(0);
  const raw = proof.blob || proof.proof || (Buffer.isBuffer(proof) ? proof : null);
  if (raw == null) return Buffer.alloc(0);
  try {
    return Buffer.from(asU8(raw));
  } catch {
    return Buffer.alloc(0);
  }
}

/** Pack digest of the spend body. sig and open are not hashed. */
export function spendPackDigest(tx) {
  const vins = (tx?.vin || []).map((v, i) => {
    const nc = asU8(v.noteCommit);
    const prev = asU8(v.prev);
    return {
      prev: prev.length === 32 ? Buffer.from(prev) : Buffer.alloc(32),
      index: Number(v.index || i),
      dest20: nc.length === 32 ? Buffer.from(nc.subarray(0, 20)) : dest20Field(v.dest20),
    };
  });
  const vouts = (tx?.vout || []).map((o) => {
    const nc = asU8(o.noteCommit);
    const k = String(o.kind || tx?.kind || '');
    const publicNanos = k === 'lock' || k === 'vote' || k === 'withdraw' || k === 'vortice-register' || k === 'pool-withdraw';
    let d20 = nc.length === 32 ? Buffer.from(nc.subarray(0, 20)) : dest20Of(o.address || '');
    if ((!d20 || d20.every((b) => b === 0)) && o.dest20) d20 = dest20Field(o.dest20);
    const claimed = o.valueProof?.v != null ? Number(o.valueProof.v) : Number(o.nanos || 0);
    return {
      dest20: d20,
      nanos: o.commit && !publicNanos ? 0 : claimed,
      kind: kindByte(o.kind || tx?.kind),
    };
  });
  const packed = packDigest(packTx({
    version: 1,
    vins: vins.length ? vins : [{ prev: Buffer.alloc(32), index: Number(tx?.height || 0), dest20: Buffer.alloc(20) }],
    vouts,
    memoH: tx?.memoH || null,
    bFlag: tx?.bFlag || tx?.kind === 'b-spend' ? 1 : 0,
  }));
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== 'lock' && kind !== 'vote' && kind !== 'withdraw') return packed;
  // Portal, fee, and the admit blob are signed. A stolen sig cannot be
  // retargeted, repriced, or pointed at a different proof. Flow sends stay
  // on the packed body alone.
  const h = createHash('sha256')
    .update(packed)
    .update(Buffer.from(String(tx?.portalId || '').toLowerCase()))
    .update(Buffer.from(String(tx?.payoutPortalId || '').toLowerCase()))
    .update(canonicalFee(tx));
  const proofs = [];
  if (tx?.admit_proof) proofs.push(tx.admit_proof);
  if (Array.isArray(tx?.admit_proofs)) proofs.push(...tx.admit_proofs);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(proofs.length >>> 0);
  h.update(count);
  for (const proof of proofs) h.update(lenPref(proofBlob(proof)));
  const reserveSuffix = reserveDigestSuffix(tx);
  if (reserveSuffix) h.update(reserveSuffix);
  return h.digest();
}

export function spendMessage(tx) {
  return createHash('sha256')
    .update(Buffer.from(SPEND_SIG_DOMAIN))
    .update(spendPackDigest(tx))
    .digest();
}

export function spendPubFromTx(tx) {
  const hex = String(tx?.spendPub || '').replace(/^0x/i, '');
  if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  return null;
}

/** compactTx-stripped spend: no spendPub/from, commit-only vin. Sealed verify must not demand openings the wire dropped. */
export function sealedCompactSpend(tx) {
  if (!tx || tx.coinbase) return false;
  if (spendPubFromTx(tx)) return false;
  if (String(tx.from || tx.vin?.[0]?.address || '')) return false;
  const vin = Array.isArray(tx.vin) ? tx.vin[0] : null;
  if (!vin || vin.coinbase) return false;
  return !!(vin.commit || vin.pseudo || vin.cTilde);
}

export function signSpendTx(tx, privateKey) {
  const msg = spendMessage(tx);
  if (isStealthKey(privateKey)) {
    const longPub = ed25519RawPub(ed25519PrivateFromSeed(privateKey.seed));
    tx.spendPub = stealthSpendPubFrom(longPub, privateKey.shared).toString('hex');
    tx.sig = stealthSign(privateKey.seed, privateKey.shared, msg).toString('hex');
    return tx;
  }
  tx.spendPub = ed25519RawPub(privateKey).toString('hex');
  const sig = sign(null, msg, privateKey);
  tx.sig = Buffer.from(sig).toString('hex');
  return tx;
}

/** Spend authority is Ed25519 over shear-spend-v1 || packDigest. spendPub must commit to dest20. */
export function verifySpendSig(tx) {
  const pubRaw = spendPubFromTx(tx);
  if (!pubRaw) return false;
  const from = String(tx?.from || tx?.vin?.[0]?.address || '');
  if (from && !destMatchesSpendPub(from, pubRaw)) return false;
  const sigHex = String(tx?.sig || tx?.signature || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{128}$/i.test(sigHex)) return false;
  try {
    const pub = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pubRaw]),
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
      // she1 fingerprint dests: SHA256(shear-she1-v2 || scan || spend)[0:20]
      if (Buffer.from(paymentIdHash(o.scanPub, o.spendPub)).equals(Buffer.from(want))) return true;
      // Mining mailbox homeDest is destCommit(spendPub), not the she1 fingerprint.
      if (dest20MatchesSpendPub(want, o.spendPub)) return true;
      return false;
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
  const k = String(tx.kind || tx.vout?.[0]?.kind || '');
  if (k === 'pool-withdraw' || k === 'claim') return false;
  if (k === 'lock' || k === 'vote' || k === 'withdraw') return false;
  return true;
}

function vinCarriesNote(tx) {
  if (!Array.isArray(tx?.vin)) return false;
  for (const v of tx.vin) {
    if (!v || typeof v !== 'object') continue;
    if (v.commit || v.noteCommit) return true;
    if (v.prev == null) continue;
    try {
      const p = Buffer.from(asU8(v.prev));
      if (p.length > 0 && p.some((b) => b !== 0)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Signed painted spend: sealed outs, no note vin, no admit proof.
 * A note spend carries a vin commit or an admit proof and is not this.
 */
export function paintedSpendSig(tx) {
  if (!tx || tx.coinbase || tx.admit_proof || tx.spendTag) return false;
  if (vinCarriesNote(tx)) return false;
  if (!verifySpendSig(tx)) return false;
  const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
  if (kind !== 'send' && kind !== 'lock' && kind !== 'withdraw') return false;
  const outs = Array.isArray(tx.vout) ? tx.vout : [];
  if (!outs.length) return false;
  let money = 0;
  let dummies = 0;
  for (const o of outs) {
    const k = String(o?.kind || '');
    if (k === 'dummy') {
      dummies += 1;
      if (!o?.commit) return false;
      continue;
    }
    if (!o?.commit) return false;
    money += 1;
  }
  if (money < 1) return false;
  if (kind === 'send' && dummies < 1) return false;
  return true;
}

/** Operator dest20 on sealed vin (or fat from/address). */
export function poolWithdrawOperatorDest20(tx) {
  const v = tx?.vin?.[0];
  if (v?.dest20) {
    try {
      const b = Buffer.from(asU8(v.dest20));
      if (b.length >= 20) return Buffer.from(b.subarray(0, 20));
    } catch { /* fall through */ }
  }
  const from = String(tx?.from || v?.address || '');
  const h = hash20FromAddress(from);
  return h ? Buffer.from(h) : null;
}

/** Operator Flow spend sig bound to the pool dest20. Fail-closed unsigned. */
export function verifyPoolWithdrawBound(tx) {
  const k = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (k !== 'pool-withdraw') return { ok: true };
  if (sealedCompactSpend(tx)) return { ok: true };
  const pubRaw = spendPubFromTx(tx);
  if (!pubRaw) return { ok: false, reason: 'unsigned' };
  const d20 = poolWithdrawOperatorDest20(tx);
  if (!d20 || !dest20MatchesSpendPub(d20, pubRaw)) return { ok: false, reason: 'unsigned' };
  if (!verifySpendSig(tx)) return { ok: false, reason: 'unsigned' };
  return { ok: true };
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
 * Vote/lock/withdraw authority is the owner signature. A range proof is not
 * an authorization, and a missing spendPub is not an authorization.
 */
export function verifyReservePortalOpen(tx) {
  if (!reserveNeedsPortalOpen(tx)) return true;
  if (!spendPubFromTx(tx)) return false;
  return verifySpendSig(tx);
}

function v3CommitCovers(tx, vin) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== 'lock' && kind !== 'vote' && kind !== 'withdraw') return false;
  let posted = null;
  try {
    const b = Buffer.from(asU8(vin?.commit));
    if (b.length === 32) posted = b;
  } catch { posted = null; }
  if (!posted) return false;
  const proofs = [];
  if (tx?.admit_proof) proofs.push(tx.admit_proof);
  if (Array.isArray(tx?.admit_proofs)) proofs.push(...tx.admit_proofs);
  for (const proof of proofs) {
    const blob = proof?.blob || proof?.proof;
    if (!blob) continue;
    const pr = Buffer.from(asU8(blob));
    if (!pr.length || pr[0] !== 3) continue;
    try {
      const ct = Buffer.from(asU8(proof.cTilde));
      if (ct.length === 32 && ct.equals(posted)) return true;
    } catch { /* next proof */ }
  }
  return false;
}

/** Body kinds that may move value. Anything else is an address-funded mint. */
export const V12_VALUE_KINDS = new Set([
  'send',
  'transfer',
  'lock',
  'vote',
  'withdraw',
  'b-spend',
]);

/**
 * The top-level kind. A missing kind, or a first output whose kind differs,
 * is empty so a vout label cannot impersonate a balance rule.
 */
export function txKind(tx) {
  if (!tx || tx.coinbase) return '';
  const top = tx.kind == null ? '' : String(tx.kind);
  if (!top) return '';
  const raw = tx.vout?.[0]?.kind;
  if (raw != null && String(raw) !== '' && String(raw) !== top) return '';
  return top;
}

/** claim, evm-value, pool-withdraw, vortice-register, user-spend, and unknown kinds. */
export function v12KindRejected(tx) {
  if (!tx || tx.coinbase) return null;
  const kind = txKind(tx);
  if (!kind || !V12_VALUE_KINDS.has(kind)) return { ok: false, reason: 'kind' };
  return null;
}

const HIDDEN_OPEN_TOPS = new Set(['send', 'transfer', 'change', 'dummy']);

/**
 * Value opening to reject before an unbound carry.
 * Send and transfer stay `value_open` even when the output label disagrees.
 * A missing or non-matching public kind stays unset so the caller can
 * return `kind` after the carry check.
 */
export function openingBeforeCarry(tx) {
  const open = valueOpenRejected(tx);
  if (!open) return null;
  const top = tx && !tx.coinbase && tx.kind != null && String(tx.kind) !== '' ? String(tx.kind) : '';
  if (HIDDEN_OPEN_TOPS.has(top)) return open;
  if (!v12KindRejected(tx)) return open;
  return null;
}

/** The vault clock is the block header. A typed tx cannot carry its own nowMs. */
export function typedClockRejected(tx) {
  if (!tx || tx.coinbase) return null;
  const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
  if (kind !== 'lock' && kind !== 'vote' && kind !== 'withdraw') return null;
  if (tx.nowMs == null) return null;
  return { ok: false, reason: 'now_ms' };
}

/** vin.commit on a non-Flow kind has no membership proof. A v3 input may carry C̃. */
export function typedCommitRejected(tx) {
  if (!tx || tx.coinbase || flowNeedsDummy(tx)) return null;
  const vins = Array.isArray(tx.vin) ? tx.vin : [];
  for (const v of vins) {
    if (!v || v.coinbase) continue;
    if (v.commit || v.cTilde || v.pseudo || v.noteCommit || v.prev) {
      if (v3CommitCovers(tx, v) && !v.cTilde && !v.pseudo && !v.noteCommit && !v.prev) continue;
      return { ok: false, reason: 'admit_membership' };
    }
  }
  return null;
}

/**
 * Lock, vote, and withdraw spend a hidden note.
 * sum(C_out) + fee·G = sum(C̃) + W·G + excess·H. The excess scalar is the
 * only opening material that survives compactTx. The vault receipt opens.
 * A change output stays hidden: range-proved, in the commitment sum, and
 * not opened, so a compact body that dropped its value still balances.
 * W is 0 for lock and vote. For withdraw, W is the opened receipt. The
 * spent note opens to the fee plus the hidden change. A fee that is not
 * that remainder is commit_sum. The receipt does not have to equal the fee.
 */
export function typedCommitSum(tx) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== 'lock' && kind !== 'vote' && kind !== 'withdraw') return { ok: true, skip: true };
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  if (!outs.length) return { ok: false, reason: 'commit_sum' };
  let payout = 0;
  let opened = 0;
  for (const o of outs) {
    const outKind = String(o?.kind || kind);
    if (outKind !== kind) {
      if (!o?.commit || !o?.rangeProof || o.rangeProof === true) {
        return { ok: false, reason: 'commit_sum' };
      }
      continue;
    }
    const raw = o?.valueProof?.v;
    const v = typeof raw === 'bigint' ? Number(raw) : Math.floor(Number(raw));
    if (!o?.commit || !o?.valueProof || !Number.isInteger(v) || v < 0) {
      return { ok: false, reason: 'commit_sum' };
    }
    if (!verifySealedNote(o, v)) return { ok: false, reason: 'commit_sum' };
    opened += 1;
    if (kind === 'withdraw') {
      if (payout > Number.MAX_SAFE_INTEGER - v) return { ok: false, reason: 'commit_sum' };
      payout += v;
    }
  }
  if (opened < 1) return { ok: false, reason: 'commit_sum' };
  const vaultPayout = kind === 'withdraw' ? payout : 0;
  if (!verifyFlowConservation(tx, null, vaultPayout)) return { ok: false, reason: 'commit_sum' };
  return { ok: true };
}

/** Portal-epoch id for a withdraw. Empty when this tx is not a withdraw. */
export function reserveWithdrawMintId(tx, reserveState = null) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== 'withdraw') return '';
  const ref = reservePortalRef(tx);
  if (!ref.ok || !ref.id) return '';
  return withdrawMintId(ref.id, reserveState?.currentEpoch || 0);
}

function reserveKindOf(tx) {
  return String(tx?.kind || tx?.vout?.[0]?.kind || '');
}

/** Portal named by the tx. A from-dest that disagrees with portalId is a retarget. */
export function reservePortalRef(tx) {
  const from = String(tx?.from || tx?.vin?.[0]?.address || '');
  const fromId = from ? portalIdFromDest(from) : '';
  const pid = String(tx?.portalId || tx?.vout?.[0]?.portalId || '').toLowerCase();
  if (pid && fromId && pid !== fromId) return { ok: false, reason: 'payout_mismatch' };
  return { ok: true, id: fromId || pid, from };
}

function voutDest20(o) {
  if (!o) return null;
  try {
    if (o.dest20) {
      const b = Buffer.from(asU8(o.dest20));
      if (b.length >= 20) return Buffer.from(b.subarray(0, 20));
    }
  } catch { /* fall through */ }
  const h = hash20FromAddress(o.address || '');
  return h ? Buffer.from(h) : null;
}

/**
 * Owner key recorded on the portal, plus any earlier lock in this body.
 * `seenOwners` is a Map of portal id → spendPub hex for the block being checked.
 */
export function reserveAuth(tx, reserveState = null, seenOwners = null) {
  if (!reserveNeedsPortalOpen(tx)) return { ok: true };
  if (!verifyReservePortalOpen(tx)) {
    return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
  }
  const ref = reservePortalRef(tx);
  if (!ref.ok) return ref;
  const pub = spendPubFromTx(tx).toString('hex').toLowerCase();
  const recorded = String(reserveState?.portals?.[ref.id]?.ownerPub || '').toLowerCase();
  const seen = seenOwners instanceof Map ? String(seenOwners.get(ref.id) || '') : '';
  const want = recorded || seen;
  if (want && want !== pub) return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
  if (reserveKindOf(tx) === 'withdraw' && recorded && recorded !== pub) {
    return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
  }
  if (seenOwners instanceof Map && ref.id && reserveKindOf(tx) === 'lock') {
    seenOwners.set(ref.id, pub);
  }
  return { ok: true };
}

/**
 * A withdraw pays only stake that is already locked. Principal 0 cannot
 * withdraw any amount. The cap is principal plus this epoch's interest.
 */
export function boundReserveWithdraw(tx, reserveState = null, drawn = null) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== 'withdraw') return { ok: true };
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const receipts = outs.filter((row) => String(row?.kind || kind) === 'withdraw');
  if (receipts.length !== 1) return { ok: false, reason: 'mint_amount' };
  const o = receipts[0];
  const raw = o?.valueProof?.v != null ? o.valueProof.v : (o?.nanos ?? tx?.nanos ?? 0);
  const claimed = typeof raw === 'bigint' ? Number(raw) : Math.floor(Number(raw));
  if (!Number.isInteger(claimed) || claimed < 0) return { ok: false, reason: 'insufficient' };
  const ref = reservePortalRef(tx);
  if (!ref.ok) return ref;
  const portals = reserveState?.portals || {};
  const dest = ref.from;
  let portal = (ref.id && portals[ref.id]) || (dest && portals[dest]) || null;
  const staked = Math.max(0, Math.floor(Number(portal?.staked || 0)));
  const idle = Math.max(0, Math.floor(Number(portal?.idle || 0)));
  const principal = staked + idle;
  if (!(principal > 0)) return { ok: false, reason: 'insufficient' };
  const bps = Math.max(0, Math.floor(Number(reserveState?.epochBps || 0)));
  const cap = principal + interestNanos(staked, bps);
  if (claimed > cap) return { ok: false, reason: 'insufficient' };
  if (portal?.payout) {
    const want = hash20FromAddress(portal.payout);
    const got = voutDest20(o);
    if (!want || !got || !Buffer.from(want).equals(got)) {
      return { ok: false, reason: 'payout_mismatch' };
    }
  }
  if (portal?.payoutPortalId) {
    const payPid = String(tx?.payoutPortalId || '').toLowerCase();
    if (!payPid || payPid !== String(portal.payoutPortalId).toLowerCase()) {
      return { ok: false, reason: 'payout_mismatch' };
    }
  }
  // A foreign program does not own the vault, so it cannot mint.
  if (String(tx?.programId || '') !== RESERVE_PROGRAM) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  // The label is not an amount. The output must open to exactly principal + interest.
  if (!o?.commit || !o?.valueProof || !verifySealedNote(o, cap)) {
    return { ok: false, reason: 'mint_amount' };
  }
  const mintId = withdrawMintId(ref.id, reserveState?.currentEpoch || 0);
  const already = reserveState?.mintedIds && reserveState.mintedIds[mintId];
  if (already || (drawn instanceof Set && drawn.has(mintId))) {
    return { ok: false, reason: 'double_mint' };
  }
  return { ok: true, principal, claimed, cap, mintId };
}

export function fundedDebit(tx) {
  if (!tx || tx.coinbase) return null;
  if (tx.mint && String(tx.kind || '') !== 'pool-withdraw') return null;
  const kind = txKind(tx);
  if (!kind || kind === 'lock' || kind === 'vote' || kind === 'withdraw') return null;
  let from = kind === 'vote'
    ? String(tx.payer || tx.vin?.[0]?.address || '')
    : String(tx.from || tx.vin?.[0]?.address || '');
  if (!from && tx.vin?.[0]?.dest20) {
    try {
      const d20 = Buffer.from(asU8(tx.vin[0].dest20));
      if (d20.length >= 20) from = encodeDest(d20.subarray(0, 20));
    } catch { /* keep empty */ }
  }
  if (!from) return null;
  const unfunded = !Array.isArray(tx.vin) || tx.vin.length === 0;
  if (unfunded) return null;
  if (!levyTaxed(tx) && !OUT_KINDS.has(kind)) return null;
  const amount = txAmountNanos(tx);
  const fee = Math.max(0, Math.floor(Number(tx.fee || 0)));
  const extra = Array.isArray(tx.vout) && tx.vout.length > 1
    ? tx.vout.slice(1).reduce((a, o, i) => a + claimedVoutNanos(tx, o, i + 1), 0)
    : 0;
  const nanos = amount + extra + fee;
  if (!(nanos > 0)) return null;
  return { from, nanos, amount, fee, change: extra };
}

const COINBASE_EXPLORER_KINDS = new Set(['coinbase', 'hash', 'pot', 'pool-fee', 'pool-withdraw']);

/**
 * One ledger. Spendable is the opened-note sum the caller already walked.
 * Plaintext explorer rows cannot raise it.
 */
export function reconcileSpendable(rows, address, tipHeight, noteNanos, need = SPENDABLE_CONFIRMATIONS) {
  void rows;
  void address;
  void tipHeight;
  void need;
  // One ledger. A plaintext explorer row cannot raise spendable above opened notes.
  return Math.max(0, Math.floor(Number(noteNanos) || 0));
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
 * Walk body txs in order. An address balance is not value: a debit that is
 * not a note-bound Flow spend is rejected. `spendableOf` is ignored.
 */
export function verifyFundedBody(body, spendableOf, { seenDigests = null, reserveState = null } = {}) {
  void spendableOf;
  const seen = seenDigests instanceof Set ? seenDigests : new Set();
  const seenOwners = new Map();
  const drawn = new Set();
  for (const tx of body || []) {
    const earlyOpen = openingBeforeCarry(tx);
    if (earlyOpen) return earlyOpen;
    const typed = typedCommitRejected(tx);
    if (typed) return typed;
    const kindGate = v12KindRejected(tx);
    if (kindGate) return kindGate;
    const open = valueOpenRejected(tx);
    if (open) return open;
    const stake = boundReserveWithdraw(tx, reserveState, drawn);
    if (!stake.ok) return stake;
    const kind = reserveKindOf(tx);
    if (kind === 'lock' || kind === 'vote' || kind === 'withdraw') {
      const structure = typedAdmitStructure(tx);
      if (!structure.ok) return structure;
    }
    const auth = reserveAuth(tx, reserveState, seenOwners);
    if (!auth.ok) return auth;
    if (stake.mintId) drawn.add(stake.mintId);
    const d = fundedDebit(tx);
    if (!d) continue;
    if (flowSendNeedsOpen(tx)) {
      const compact = sealedCompactSpend(tx);
      if (!compact && !verifySpendSig(tx)) {
        return { ok: false, reason: 'unsigned', from: d.from };
      }
      if (!compact) {
        const digest = spendPackDigest(tx).toString('hex');
        if (seen.has(digest)) return { ok: false, reason: 'replay', from: d.from };
        seen.add(digest);
      }
    }
    const noteBound = Array.isArray(tx.vin) && tx.vin.some((v) => v && (v.commit || v.prev));
    if (!(noteBound && flowNeedsDummy(tx))) {
      return { ok: false, reason: 'kind', from: d.from };
    }
  }
  return { ok: true };
}

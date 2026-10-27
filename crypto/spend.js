/**
 * Funded-spend law. v12 value comes from a balanced ADMITv3 input.
 * An address balance is not value, and spendableOf is not consulted.
 * Spend authority is Ed25519 over shear-spend-v1 || packDigest.
 */
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { SPENDABLE_CONFIRMATIONS, SPEND_SIG_DOMAIN, RESERVE_PROGRAM, MAX_LOCK_LEAVES } from './asert.js';
import { levyTaxed, levyNanos, txAmountNanos, custodialPullRejected } from './levy.js';
import { isSpendableHeight, valueOpenRejected } from './chronoflux.js';
import { paymentIdHash, hash20FromAddress, destOpeningFromView, ED25519_SPKI_PREFIX, ed25519RawPub, destMatchesSpendPub, dest20MatchesSpendPub, encodeDest, isStealthKey, stealthSign, stealthSpendPubFrom, ed25519PrivateFromSeed } from './address.js';
import { indexedDestHash, closureCommit } from './flow_sheet.js';
import { packTx, packDigest } from './pack.js';
import { claimedVoutNanos, flowNeedsDummy, publicReserveReceiptRejected } from './dummy.js';
import { asU8, verifyFlowConservation, verifySealedNote, leafVoteConserved } from './note.js';
import { consensusUnlockPeriod, hiddenPrincipalOpens, indexedWithdrawQuote, lockFundingRejected, lockUnlockOf, maturedHiddenCount, portalIdFromDest20, principalProofReused, reserveDigestSuffix, withdrawablePrincipal, withdrawMintId, withdrawPaysInterest } from './reserve_vault.js';
import { attachLockAuth, verifyLockAuth } from './reserve_evm.js';
import { verifyTypedAdmitFunding } from './admit_v3.js';
import { MEMBER_KEYS } from './member_keys.js';

export { MEMBER_KEYS };

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

/** Not a legal fee. Legal fees are 0..2^53-1, and those encodings have a zero high byte. */
const FEE_ILLEGAL = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

/**
 * Absent (missing, null, or undefined) is 0.
 * A number-typed integer in 0..2^53-1 is itself.
 * Anything else is null: a string, a float, NaN, a negative, or an integer above 2^53-1.
 */
export function postedFeeNanos(tx) {
  if (!tx || typeof tx !== 'object') return 0;
  if (tx.fee == null) return 0;
  const fee = tx.fee;
  if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee < 0) return null;
  return fee;
}

/** The fee field is not absent and not a number-typed integer in 0..2^53-1. */
export function feeFieldRejected(tx) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx) || Buffer.isBuffer(tx)) return null;
  if (postedFeeNanos(tx) == null) return { ok: false, reason: 'fee' };
  return null;
}

/**
 * A b-spend's outputs must sum to the leaf, and the fee is not taken from that
 * leaf or from any other note. A positive fee would still be added to the
 * block levy and minted as finder-fee and reserve-fee rows. Only absent or 0.
 */
export function bSpendFeeRejected(tx) {
  if (!tx || tx.coinbase) return null;
  const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
  if (kind !== 'b-spend') return null;
  const paid = postedFeeNanos(tx);
  if (paid == null || paid !== 0) return { ok: false, reason: 'fee' };
  return null;
}

function canonicalFee(tx) {
  const n = postedFeeNanos(tx);
  if (n == null) return FEE_ILLEGAL;
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(n));
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

export const SPEND_AMT_DST = Buffer.from('shear-spend-amt-v1');

/** Flow sends sign every output's amtCt, empty when absent, beside the packed body. */
function flowAmtDigest(packed, vout) {
  const outs = Array.isArray(vout) ? vout : [];
  const h = createHash('sha256').update(SPEND_AMT_DST).update(packed);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(outs.length >>> 0);
  h.update(count);
  for (const o of outs) h.update(lenPref(voutAmtCt(o)));
  return h.digest();
}

function voutAmtCt(o) {
  try {
    return Buffer.from(asU8(o?.amtCt || []));
  } catch {
    return Buffer.alloc(0);
  }
}

/** Pack digest of the spend body. sig and open are not hashed. */
export function spendPackDigest(tx) {
  const vins = (tx?.vin || []).map((v, i) => {
    const nc = asU8(v.noteCommit);
    const prev = asU8(v.prev);
    let d20 = nc.length === 32 ? Buffer.from(nc.subarray(0, 20)) : dest20Field(v.dest20);
    if (d20.every((b) => b === 0)) {
      const h = hash20FromAddress(v.address || '');
      if (h) d20 = Buffer.from(h);
    }
    return {
      prev: prev.length === 32 ? Buffer.from(prev) : Buffer.alloc(32),
      index: Number(v.index || i),
      dest20: d20,
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
  if (kind !== 'lock' && kind !== 'vote' && kind !== 'withdraw') {
    const flowed = flowAmtDigest(packed, tx?.vout);
    // A b-spend fee is signed, and consensus only allows absent or 0.
    // An alias does not hash as that zero. Sends stay on the packed body.
    if (kind !== 'b-spend') return flowed;
    return createHash('sha256').update(flowed).update(canonicalFee(tx)).digest();
  }
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
  attachLockAuth(tx, privateKey);
  return tx;
}

/** Spend authority is Ed25519 over shear-spend-v1 || packDigest. spendPub must commit to dest20.
 * A withdraw with no address pays a one-time dest20. The owner signature binds
 * that dest. The spend signature still binds the body. */
export function verifySpendSig(tx) {
  const pubRaw = spendPubFromTx(tx);
  if (!pubRaw) return false;
  const from = String(tx?.from || tx?.vin?.[0]?.address || '');
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  const namedTo = typeof tx?.to === 'string' && tx.to !== '';
  if (from) {
    if (!destMatchesSpendPub(from, pubRaw)) return false;
  } else if (!(kind === 'withdraw' && !namedTo)) {
    const vin = Array.isArray(tx?.vin) ? tx.vin[0] : null;
    const d20 = vin?.dest20 || tx?.dest20;
    if (!d20 || !dest20MatchesSpendPub(d20, pubRaw)) return false;
  }
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
  if (kind === 'withdraw' || kind === 'roll') {
    return String(tx?.from || tx?.vin?.[0]?.address || '');
  }
  return '';
}

export function reserveNeedsPortalOpen(tx) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  return kind === 'lock' || kind === 'vote' || kind === 'withdraw' || kind === 'roll';
}

function destOpeningShape(open) {
  const hex = String(open || '').replace(/^0x/i, '');
  return /^[0-9a-f]{128}$/i.test(hex) || /^[0-9a-f]{120}$/i.test(hex);
}

/**
 * Vote/lock/withdraw authority is the owner signature. A range proof is not
 * an authorization. An FS-1 withdraw or lock carries no identity spendPub:
 * the withdraw is the SAL plus rewardSig, and the lock is lockAuth.
 */
function fs1Carry(tx) {
  try {
    const raw = tx?.fs1;
    const b = Buffer.from(asU8(raw));
    return b.length > 0 && b[0] === 0xf1;
  } catch {
    return false;
  }
}

export function verifyReservePortalOpen(tx) {
  if (!reserveNeedsPortalOpen(tx)) return true;
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  // An FS-1 withdraw is authorised by the SAL and the owner rewardSig.
  // An FS-1 lock is authorised by lockAuth. The identity spend key is not
  // on either compact body.
  if ((kind === 'withdraw' || kind === 'lock') && fs1Carry(tx) && !spendPubFromTx(tx)) return true;
  if (!spendPubFromTx(tx)) return false;
  return verifySpendSig(tx);
}

function v3CommitCovers(tx, vin) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== 'lock' && kind !== 'vote' && kind !== 'withdraw' && kind !== 'leaf-vote') return false;
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
    if (!pr.length || (pr[0] !== 3 && pr[0] !== 0xf1)) continue;
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
  'leaf-vote',
  'withdraw',
  'roll',
  'reward-claim',
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
  // The vote note is voteOutput. A hidden change output is a send, and
  // that label does not make the transaction a send.
  if (top === 'leaf-vote') return top;
  const raw = tx.vout?.[0]?.kind;
  if (raw != null && String(raw) !== '' && String(raw) !== top) return '';
  return top;
}

/** claim, evm-value, pool-withdraw, vortice-register, user-spend, and unknown kinds. */
export function v12KindRejected(tx) {
  if (!tx || tx.coinbase) return null;
  const kind = txKind(tx);
  if (kind === 'claim') {
    const vout = Array.isArray(tx?.vout) ? tx.vout : [];
    const stated = tx?.nanos != null && tx.nanos !== '';
    const nanos = Math.floor(Number(tx?.nanos || 0));
    let opened = 0;
    let badRow = false;
    for (const row of vout) {
      const raw = row?.valueProof?.v != null ? row.valueProof.v : row?.nanos;
      const n = Math.floor(Number(raw || 0));
      if (!(Number.isFinite(n) && n > 0)) badRow = true;
      else opened += n;
    }
    // Finder-fee fee row: no amount and no outputs, so nothing is minted.
    // A stated amount must equal the sum of the outputs. A missing output,
    // a row of zero or less, or a sum that is not the stated amount does not conserve.
    if (vout.length === 0 && !stated) return null;
    if (vout.length === 0 || badRow || !(opened > 0) || !stated || !Number.isFinite(nanos) || nanos !== opened) {
      return { ok: false, reason: 'conservation' };
    }
  }
  if (kind && V12_VALUE_KINDS.has(kind)) return null;
  return { ok: false, reason: 'kind' };
}

/**
 * Only the block's first tx is the coinbase. A later tx that wears the flag
 * skips kind, range, flow, and the levy, so a fee on it mints finder-fee and
 * reserve-fee notes. Any truthy flag is that skip. A proof or spend tag on
 * the same tx is still admit_membership, from the carry check that runs first.
 */
export function userCoinbaseRejected(tx) {
  if (!tx || !tx.coinbase) return null;
  return { ok: false, reason: 'coinbase' };
}

/**
 * A refused kind that spends a note without a signature is unsigned.
 * A missing signature is not a permanent kind failure.
 * A refused kind with no note, or with a valid signature, stays kind.
 */
export function unsignedRefusedSpend(tx) {
  if (!tx || tx.coinbase) return null;
  if (!v12KindRejected(tx)) return null;
  if (!vinCarriesNote(tx)) return null;
  if (!flowSendNeedsOpen(tx)) return null;
  if (verifySpendSig(tx)) return null;
  return { ok: false, reason: 'unsigned' };
}

// Openings and wire secrets. compactTx strips them. They are not an extra field
// on the tx body. A membership row does not get that skip: those names are
// unsigned there.
export const BODY_SECRET_KEYS = new Set([
  'open',
  'portalOpen',
  'viewKey',
  'view',
  'V',
  'C',
  'closure',
  'closureCommit',
  'paymentCode',
  'scanPub',
  'spendHash20',
  'seed',
  'seedHex',
  'privateKey',
  'ip',
  'remoteAddress',
  'peerIp',
  'userAgent',
  'user-agent',
  'ua',
  'memoPlain',
  'login',
  'spendPub',
  'r',
  't',
  '_origCommit',
  '_origNoteCommit',
]);

const BODY_KEYS = new Set([
  'id', 'kind', 'from', 'to', 'nanos', 'fee', 'vin', 'vout', 'sig', 'signature',
  'memo', 'memoH', 'memoCt', 'bFlag', 'bExtra', 'unit', 'nonce', 'tag', 'dest20',
  'portalId', 'payoutPortalId', 'programId', 'choice', 'rewardSig',
  'admit_proof', 'admit_proofs', 'spendTag', 'members', 'fs1',
  'excess', 'jroot', 'height', 'mint', 'version', 'anchor', 'maxLevy', 'nowMs',
  'samples', 'weight', 'changeNanos', 'amount', 'payer', 'sponsor',
  'coinbase', 'carryNanos', 'share', 'withdrawNonce', 'reports', 'rateCommit', 'rewardRoot',
  'epochStartRoot', 'epochStartCommits', 'epochCensusCommit', 'vaultLockRoot',
  'nullifier',
  'ownerPub',
  'piProof', 'vaultLockNote', 'vaultProof', 'earnEpoch', 'rootEpoch', 'capProof',
  'lockAuth',
  'retireProof', 'retireProofs', 'principalProof', 'principalProofs',
  'voteProof', 'voteProofs', 'voteSeq', 'voteParam', 'voteOutput',
  'hashOwed', 'hashOwedRest', 'hashOwedLocal', 'hashOwedRoot', 'hashCreditRoot',
  'hashBonusUnit', 'hashAcceptedUnits', 'hashDustNanos', 'hashOwedOverflowNanos',
  'hashCredits', 'shareSlotRoot', 'issuedJobKeys', 'observe',
  'commitHeight', 'index', 'leaf', 'proof', 'commitHeader', 'commitRootA', 'commitRootB',
]);

const VIN_KEYS = new Set([
  'coinbase', 'height', 'address', 'commit', 'noteCommit', 'dest20',
  'prev', 'index', 'cTilde', 'pseudo', 'spendTag', 'portalId',
]);

const VOUT_KEYS = new Set([
  'kind', 'address', 'nanos', 'dest20', 'noteCommit', 'commit',
  'valueProof', 'rangeProof', 'viewTag', 'admitPub', 'rEph', 'rCt', 'amtCt',
  'portalId', 'memo', 'memoCt', 'unlockAtMs', 'lockEpoch', 'fundProof', 'piProof',
]);

const VALUE_PROOF_KEYS = new Set(['v', 'R', 'z']);

const OBSERVE_KEYS = new Set(['annualBps', 'observedAtMs']);

const PROOF_KEYS = new Set([
  'admit_proof', 'v', 'version', 'spendTag', 'blob', 'cTilde', 'c0',
  'proof', 'members', 'anchor', 'root', 'n', 'pseudo', 'commit', 'tag',
]);

/** Leaf-vote, withdraw, lock, and an FS-1 spend post only these proof keys. */
const ADMIT_WIRE_KEYS = new Set(['blob', 'cTilde', 'spendTag']);

function blobIsFs1(value) {
  try {
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(asU8(value));
    return raw.length > 0 && raw[0] === 0xf1;
  } catch {
    return false;
  }
}

function admitWireStrict(tx) {
  const kind = String(tx?.kind || '');
  if (kind === 'leaf-vote' || kind === 'withdraw' || kind === 'lock') return true;
  if (blobIsFs1(tx?.fs1)) return true;
  if (tx?.admit_proof && blobIsFs1(tx.admit_proof.blob)) return true;
  if (Array.isArray(tx?.admit_proofs)) {
    for (const proof of tx.admit_proofs) {
      if (proof && blobIsFs1(proof.blob)) return true;
    }
  }
  return false;
}

/**
 * A strict admit proof carries blob, cTilde, and spendTag. `t`, `r`,
 * `commit`, `pseudo`, `seed`, and any other key are unsigned. Secret-key
 * skipping does not apply: those names are the leak this gate closes.
 */
export function admitKeysRejected(tx) {
  if (!tx || typeof tx !== 'object' || Buffer.isBuffer(tx) || Array.isArray(tx)) return null;
  if (!admitWireStrict(tx)) return null;
  const proofs = [];
  if (tx.admit_proof && typeof tx.admit_proof === 'object' && !Buffer.isBuffer(tx.admit_proof) && !Array.isArray(tx.admit_proof)) {
    proofs.push(tx.admit_proof);
  }
  if (Array.isArray(tx.admit_proofs)) {
    for (const proof of tx.admit_proofs) {
      if (proof && typeof proof === 'object' && !Buffer.isBuffer(proof) && !Array.isArray(proof)) proofs.push(proof);
    }
  }
  for (const proof of proofs) {
    for (const key of Object.keys(proof)) {
      if (!ADMIT_WIRE_KEYS.has(key)) return { ok: false, reason: 'unsigned' };
    }
  }
  return null;
}

const LEDGER_ROW_KEYS = new Set([
  'noteCommit', 'dest20', 'nanos', 'sinceHeight', 'admitBase', 'address',
]);

const LEAF_KEYS = new Set(['dest20', 'unit', 'nonce', 'memoH', 'tag']);

const MERKLE_PROOF_KEYS = new Set(['side', 'hash']);

function uncoveredKey(obj, allow) {
  if (!obj || typeof obj !== 'object' || Buffer.isBuffer(obj) || Array.isArray(obj)) return null;
  for (const key of Object.keys(obj)) {
    if (BODY_SECRET_KEYS.has(key)) continue;
    if (!allow.has(key)) return key;
  }
  return null;
}

function uncoveredList(list, allow) {
  if (!Array.isArray(list)) return null;
  for (const row of list) {
    if (uncoveredKey(row, allow)) return row;
  }
  return null;
}

/**
 * `members` must be an array of plain objects. A non-array value is unsigned.
 * A string, a nested array, null, or any other non-object item is unsigned.
 * A key outside MEMBER_KEYS is unsigned, including BODY_SECRET_KEYS. Those
 * names are not skipped on a membership row.
 */
function membersFieldRejected(holder) {
  if (!holder || typeof holder !== 'object' || Buffer.isBuffer(holder) || Array.isArray(holder)) return null;
  if (!Object.prototype.hasOwnProperty.call(holder, 'members')) return null;
  const list = holder.members;
  if (!Array.isArray(list)) return { ok: false, reason: 'unsigned' };
  for (const row of list) {
    if (row === null || typeof row !== 'object' || Array.isArray(row) || Buffer.isBuffer(row)) {
      return { ok: false, reason: 'unsigned' };
    }
    for (const key of Object.keys(row)) {
      if (!MEMBER_KEYS.has(key)) return { ok: false, reason: 'unsigned' };
    }
  }
  return null;
}

/**
 * A field the spend signature does not cover. Known consensus keys stay.
 * Any other key, at any amount, is unsigned on queue, mempool, and verify.
 */
export function unsignedBodyField(tx) {
  if (!tx || typeof tx !== 'object' || Buffer.isBuffer(tx) || Array.isArray(tx)) return null;
  // v12 has no partial lock: a lock is whole π leaves, with any remainder as
  // ordinary hidden change. A remainder commitment or its opening is refused
  // by name on every path (mempool, queue, block), not left to fail later.
  if (remainderLockField(tx)) return { ok: false, reason: 'remainder_lock' };
  if (uncoveredKey(tx, BODY_KEYS)) return { ok: false, reason: 'unsigned' };
  if (uncoveredKey(tx.leaf, LEAF_KEYS)) return { ok: false, reason: 'unsigned' };
  if (uncoveredList(tx.proof, MERKLE_PROOF_KEYS)) return { ok: false, reason: 'unsigned' };
  if (uncoveredList(tx.vin, VIN_KEYS)) return { ok: false, reason: 'unsigned' };
  if (Array.isArray(tx.vout)) {
    for (const o of tx.vout) {
      if (uncoveredKey(o, VOUT_KEYS)) return { ok: false, reason: 'unsigned' };
      if (o && typeof o.valueProof === 'object' && !Buffer.isBuffer(o.valueProof) && !Array.isArray(o.valueProof)) {
        if (uncoveredKey(o.valueProof, VALUE_PROOF_KEYS)) return { ok: false, reason: 'unsigned' };
      }
    }
  }
  if (uncoveredKey(tx.observe, OBSERVE_KEYS)) return { ok: false, reason: 'unsigned' };
  const strictProof = admitKeysRejected(tx);
  if (strictProof) return strictProof;
  const proofs = [];
  if (tx.admit_proof && typeof tx.admit_proof === 'object') proofs.push(tx.admit_proof);
  if (Array.isArray(tx.admit_proofs)) proofs.push(...tx.admit_proofs);
  if (uncoveredList(proofs, PROOF_KEYS)) return { ok: false, reason: 'unsigned' };
  for (const proof of proofs) {
    const member = membersFieldRejected(proof);
    if (member) return member;
  }
  const topMembers = membersFieldRejected(tx);
  if (topMembers) return topMembers;
  if (uncoveredList(tx.hashOwed, LEDGER_ROW_KEYS)) return { ok: false, reason: 'unsigned' };
  if (uncoveredList(tx.hashOwedRest, LEDGER_ROW_KEYS)) return { ok: false, reason: 'unsigned' };
  if (uncoveredList(tx.hashOwedLocal, LEDGER_ROW_KEYS)) return { ok: false, reason: 'unsigned' };
  if (uncoveredList(tx.hashCredits, LEDGER_ROW_KEYS)) return { ok: false, reason: 'unsigned' };
  return null;
}

/** A remainder-lock field (remainCommit, remainProof) on the body, present at any value. */
export function remainderLockField(tx) {
  if (!tx || typeof tx !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(tx, 'remainCommit') || Object.prototype.hasOwnProperty.call(tx, 'remainProof');
}

const EXPLICIT_OUTPUT_KINDS = new Set(['lock', 'vote', 'withdraw']);

/**
 * A lock, vote, or withdraw output names its own kind.
 * An empty kind is not inherited from the tx.
 */
export function explicitTypedKindRejected(tx) {
  if (!tx || tx.coinbase) return null;
  const top = tx.kind == null ? '' : String(tx.kind);
  if (!EXPLICIT_OUTPUT_KINDS.has(top)) return null;
  const outs = Array.isArray(tx.vout) ? tx.vout : [];
  for (const o of outs) {
    if (!o || o.kind == null || String(o.kind) === '') return { ok: false, reason: 'kind' };
  }
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
  if (kind !== 'lock' && kind !== 'vote' && kind !== 'withdraw' && kind !== 'roll') return null;
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
export function typedCommitSum(tx, ctx = {}) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind === 'leaf-vote') {
    const paid = Math.floor(Number(tx?.fee || 0));
    const need = Math.floor(Number(levyNanos(0, { tx })) || 0);
    if (paid < need) return { ok: false, reason: 'levy' };
    // The fee is paid to the miner only when this note spend balances.
    // A number with no input is commit_sum, so it is not minted as a fee.
    if (!leafVoteConserved(tx)) return { ok: false, reason: 'commit_sum' };
    return { ok: true };
  }
  if (kind !== 'lock' && kind !== 'vote' && kind !== 'withdraw') return { ok: true, skip: true };
  if (kind === 'vote') {
    // A vote moves no value. A nonzero fee would be paid to miners with no debit.
    const paid = Math.floor(Number(tx?.fee || 0));
    if (paid !== 0) return { ok: false, reason: 'levy' };
    const voteOuts = Array.isArray(tx?.vout) ? tx.vout : [];
    for (const o of voteOuts) {
      const raw = o?.valueProof?.v;
      if (raw == null || raw === '') continue;
      const v = typeof raw === 'bigint' ? Number(raw) : Math.floor(Number(raw));
      if (v !== 0) return { ok: false, reason: 'commit_sum' };
    }
    return { ok: true, skip: true };
  }
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
    const hiddenLock = kind === 'lock' && (raw == null || raw === '');
    if (hiddenLock) {
      if (!o?.commit || !o?.rangeProof || o.rangeProof === true) {
        return { ok: false, reason: 'commit_sum' };
      }
      opened += 1;
      continue;
    }
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
  if (kind === 'lock') {
    if (opened < 1 || opened > MAX_LOCK_LEAVES) return { ok: false, reason: 'commit_sum' };
  } else if (opened !== 1) return { ok: false, reason: 'commit_sum' };
  const vaultPayout = kind === 'withdraw' ? payout : 0;
  if (!verifyFlowConservation(tx, null, vaultPayout)) return { ok: false, reason: 'commit_sum' };
  if (kind === 'lock' && tx?.vaultLockNote) {
    // The unlock is the chain clock, not a field the locker writes. Admission
    // and the block path both derive it from the vault and the header time.
    let fundCtx = ctx;
    if (ctx.unlock == null && ctx.state && ctx.nowMs != null) {
      const clock = lockUnlockOf(ctx.state, ctx.nowMs);
      fundCtx = { ...ctx, unlock: consensusUnlockPeriod(clock.epoch) };
    }
    const funded = lockFundingRejected(tx, fundCtx);
    if (funded) return { ok: false, reason: 'commit_sum' };
  }
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

/** Portal named by the carried id. A peer does not rebuild it from an address. */
export function reservePortalRef(tx) {
  const from = String(tx?.from || tx?.vin?.[0]?.address || '');
  const pid = String(tx?.portalId || tx?.vout?.[0]?.portalId || '').replace(/^0x/i, '').toLowerCase();
  if (pid && !/^[0-9a-f]{64}$/.test(pid)) return { ok: false, reason: 'unsigned' };
  return { ok: true, id: pid, from };
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
/**
 * A fresh portal's dest20 is the lockAuth key, and the portal id is
 * H(tag, dest20). A carried id, or a dest20 from another key, is a squat.
 */
function freshLockBound(tx, pubRaw) {
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const o = outs.find((row) => String(row?.kind || 'lock') === 'lock') || outs[0] || {};
  const pid = String(tx?.portalId || o?.portalId || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pid)) return false;
  let d20 = null;
  try {
    if (o?.dest20) {
      const b = Buffer.from(asU8(o.dest20));
      if (b.length >= 20) d20 = Buffer.from(b.subarray(0, 20));
    }
  } catch { d20 = null; }
  if (!d20 || !dest20MatchesSpendPub(d20, pubRaw)) return false;
  const want = portalIdFromDest20(d20);
  return want === pid;
}

export function reserveAuth(tx, reserveState = null, seenOwners = null) {
  if (!reserveNeedsPortalOpen(tx)) return { ok: true };
  const kind = reserveKindOf(tx);
  const pubRaw = spendPubFromTx(tx);
  // A sealed note needs the owner signature. A missing one is unsigned.
  // A public dest20 receipt has no spend key, so it is not an open.
  if (!verifyReservePortalOpen(tx)) {
    return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
  }
  const ref = reservePortalRef(tx);
  if (!ref.ok) return ref;
  // A compact FS-1 lock has no spendPub. The owner is the lockAuth key.
  // A compact FS-1 withdraw has no spendPub either. The SAL and the owner
  // reward signature are the authorisation. A spend key on that body is vote_leak.
  let spend;
  let ownerKey = pubRaw;
  const hiddenWithdraw = !pubRaw && kind === 'withdraw' && fs1Carry(tx);
  if (!pubRaw && !hiddenWithdraw) {
    if (!(kind === 'lock' && fs1Carry(tx))) {
      return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
    }
    spend = verifyLockAuth(tx);
    if (!spend) return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
    ownerKey = Buffer.from(spend, 'hex');
  } else if (pubRaw) {
    spend = pubRaw.toString('hex').toLowerCase();
  }
  const ownerPub = String(tx?.ownerPub || '').replace(/^0x/i, '').toLowerCase();
  const recorded = String(reserveState?.portals?.[ref.id]?.ownerPub || '').toLowerCase();
  const seen = seenOwners instanceof Map ? String(seenOwners.get(ref.id) || '') : '';
  const want = recorded || seen;
  if (kind === 'lock' && !want) {
    if (!freshLockBound(tx, ownerKey)) {
      return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
    }
    if (!/^[0-9a-f]{64}$/.test(ownerPub)) {
      return { ok: false, reason: 'owner_missing', from: reservePortalDest(tx) };
    }
    // A fresh lock's owner is the signer. A copied ownerPub is not a binding.
    if (ownerPub !== spend) {
      return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
    }
    if (seenOwners instanceof Map && ref.id) seenOwners.set(ref.id, spend);
    return { ok: true };
  }
  if (kind === 'lock' && want) {
    // A later lock is signed by the recorded owner. ownerPub cannot stand in.
    if (spend !== want || (ownerPub && ownerPub !== spend)) {
      return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
    }
  }
  if (kind === 'withdraw' && !want) {
    return { ok: false, reason: 'owner_missing', from: reservePortalDest(tx) };
  }
  if (hiddenWithdraw && ownerPub && ownerPub !== want) {
    return { ok: false, reason: 'unsigned', from: reservePortalDest(tx) };
  }
  if (seenOwners instanceof Map && ref.id && kind === 'lock') {
    seenOwners.set(ref.id, ownerPub || spend);
  }
  return { ok: true };
}

/**
 * A withdraw pays only stake that is already locked. Principal 0 cannot
 * withdraw any amount. The cap is the withdrawable legacy principal. The
 * stake reward is not part of it. A missing header time pays no principal.
 * A portal with no tranche list is one legacy credit: withdrawablePrincipal
 * includes it only after its lock epoch has ended.
 */
export function boundReserveWithdraw(tx, reserveState = null, drawn = null, clockMs = null) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== 'withdraw') return { ok: true };
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const receipts = outs.filter((row) => String(row?.kind || '') === 'withdraw');
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
  const owner = String(portal?.ownerPub || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(owner)) return { ok: false, reason: 'owner_missing' };
  const clock = Number(clockMs);
  // No header time is not a license to pay every locked nanos.
  const duePrincipal = Number.isFinite(clock) && clock > 0
    ? Math.max(0, Math.floor(Number(withdrawablePrincipal(reserveState, portal, clock)) || 0))
    : 0;
  const principal = duePrincipal;
  const hidden = Number.isFinite(clock) && clock > 0
    ? maturedHiddenCount(reserveState, portal, clock)
    : 0;
  const mintId = withdrawMintId(ref.id, reserveState?.currentEpoch || 0);
  const already = reserveState?.mintedIds && reserveState.mintedIds[mintId];
  if (already || (drawn instanceof Set && drawn.has(mintId))) {
    return { ok: false, reason: 'double_mint' };
  }
  if (hidden > 0 && principal === 0) {
    if (String(tx?.programId || '') !== RESERVE_PROGRAM) return { ok: false, reason: 'mint_forbidden' };
    if (portal?.payout) {
      const want = hash20FromAddress(portal.payout);
      const got = voutDest20(o);
      if (!want || !got || !Buffer.from(want).equals(got)) {
        return { ok: false, reason: 'payout_mismatch' };
      }
    }
    // A carried id that differs is a mismatch. The compact withdraw omits
    // payoutPortalId. Its payout is the one-time dest20 under the owner sig.
    if (portal?.payoutPortalId && tx?.payoutPortalId) {
      const payPid = String(tx.payoutPortalId).toLowerCase();
      if (payPid !== String(portal.payoutPortalId).toLowerCase()) {
        return { ok: false, reason: 'payout_mismatch' };
      }
    }
    if (claimed !== 0) {
      // Indexed leaves: the proof opens π and the receipt is π plus the stub.
      const quote = indexedWithdrawQuote(reserveState, portal, clock, tx);
      if (quote) {
        if (!quote.ok) {
          if (quote.reason === 'proof_reuse' || principalProofReused(reserveState, portal, claimed, tx?.principalProof, tx)) {
            return { ok: false, reason: 'proof_reuse' };
          }
          return { ok: false, reason: quote.reason || 'stake_reward' };
        }
        if (BigInt(claimed) !== quote.due) return { ok: false, reason: 'mint_amount' };
        const released = quote.principal <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(quote.principal) : claimed;
        return { ok: true, principal: released, claimed, cap: claimed, mintId };
      }
      if (!hiddenPrincipalOpens(reserveState, portal, clock, claimed, tx?.principalProof, tx)) {
        if (principalProofReused(reserveState, portal, claimed, tx?.principalProof, tx)) {
          return { ok: false, reason: 'proof_reuse' };
        }
        return { ok: false, reason: 'stake_reward' };
      }
      return { ok: true, principal: claimed, claimed, cap: claimed, mintId };
    }
    return { ok: true, principal: 0, claimed: 0, cap: 0, mintId };
  }
  if (claimed === 0) return { ok: false, reason: 'mint_amount' };
  if (!(principal > 0)) return { ok: false, reason: 'insufficient' };
  const due = Math.max(0, Math.floor(Number(withdrawPaysInterest(reserveState, portal, clock)) || 0));
  const cap = principal + due;
  if (claimed > cap) return { ok: false, reason: 'insufficient' };
  if (portal?.payout) {
    const want = hash20FromAddress(portal.payout);
    const got = voutDest20(o);
    if (!want || !got || !Buffer.from(want).equals(got)) {
      return { ok: false, reason: 'payout_mismatch' };
    }
  }
  // Same rule as the hidden branch. Absent is the compact body.
  if (portal?.payoutPortalId && tx?.payoutPortalId) {
    const payPid = String(tx.payoutPortalId).toLowerCase();
    if (payPid !== String(portal.payoutPortalId).toLowerCase()) {
      return { ok: false, reason: 'payout_mismatch' };
    }
  }
  // A foreign program does not own the vault, so it cannot mint.
  if (String(tx?.programId || '') !== RESERVE_PROGRAM) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  // The label is not an amount. The output must open to exactly the
  // withdrawable legacy principal. A time-locked note is not part of it.
  if (!o?.commit || !o?.valueProof || !verifySealedNote(o, cap)) {
    return { ok: false, reason: 'mint_amount' };
  }
  return { ok: true, principal, claimed, cap, mintId };
}

export function fundedDebit(tx) {
  if (!tx || tx.coinbase) return null;
  if (tx.mint && String(tx.kind || '') !== 'pool-withdraw') return null;
  const kind = txKind(tx);
  // Sealed lock, vote, and withdraw are funded by a note, not an address
  // balance. A public receipt is public_receipt in verifyFundedBody before
  // this return, so it is not an unfunded debit.
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
export function verifyFundedBody(body, spendableOf, {
  seenDigests = null,
  reserveState = null,
  nowMs = null,
  height = null,
  spentTags = null,
  magic = null,
  noteAtAnchor = null,
} = {}) {
  void spendableOf;
  const seen = seenDigests instanceof Set ? seenDigests : new Set();
  const seenOwners = new Map();
  const drawn = new Set();
  const tags = spentTags && typeof spentTags.has === 'function' ? spentTags : new Set();
  for (const tx of body || []) {
    const publicReceipt = publicReserveReceiptRejected(tx);
    if (publicReceipt) return publicReceipt;
    const earlyOpen = openingBeforeCarry(tx);
    if (earlyOpen) return earlyOpen;
    const pull = custodialPullRejected(tx);
    if (pull) return pull;
    const kindGate = v12KindRejected(tx);
    if (kindGate) return kindGate;
    const explicitKind = explicitTypedKindRejected(tx);
    if (explicitKind) return explicitKind;
    const typed = typedCommitRejected(tx);
    if (typed) return typed;
    const open = valueOpenRejected(tx);
    if (open) return open;
    const stake = boundReserveWithdraw(tx, reserveState, drawn, nowMs);
    if (!stake.ok) return stake;
    const kind = reserveKindOf(tx);
    if (kind === 'lock' || kind === 'vote' || kind === 'withdraw') {
      const noteFund = verifyTypedAdmitFunding(tx, {
        height,
        spentTags: tags,
        magic,
        noteAtAnchor,
      });
      if (!noteFund.ok) return noteFund;
      if (Array.isArray(noteFund.tags)) {
        for (const th of noteFund.tags) tags.add(th);
      }
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

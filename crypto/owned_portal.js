/**
 * One wallet for tests that lock and withdraw.
 * Each portal gets its own owner key, derived from that wallet secret and
 * the portal id. The wallet spend key is not the owner key.
 */
import { ed25519RawPub, hash20FromAddress, newIdentity } from './address.js';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS } from './asert.js';
import { commit, pointBytes, randomScalar } from './note.js';
import {
  deposit as depositRaw,
  lockTx as lockTxRaw,
  packRewardAuth,
  portalBlindFromSeed,
  portalIdFromDest,
  portalIdFromDest20,
  portalOwnerKey,
  reserveMagicBytes,
  rewardOwnerCommit,
  signWithdrawReward,
  trancheSetHash,
  withdrawTx as withdrawTxRaw,
} from './reserve_vault.js';
import {
  encodeDeposit as encodeDepositRaw,
  encodeWithdraw as encodeWithdrawRaw,
} from './reserve_evm.js';

export const portalOwner = newIdentity();
export const portalOwnerPub = Buffer.from(portalOwner.spendPub).toString('hex');
export const BIND_GENESIS_MS = 1_700_000_000_000;

function givenOwner(value) {
  const pub = String(value || '').replace(/^0x/i, '');
  return /^[0-9a-f]{64}$/i.test(pub) ? pub.toLowerCase() : '';
}

/** portalId = H(tag, dest20). r is not an input. Null when dest20 is missing. */
function hiddenPortalId(dest, seed = portalOwner.privateKey) {
  const d20 = hash20FromAddress(dest);
  const blind = portalBlindFromSeed(seed);
  if (!d20 || !blind) return null;
  return portalIdFromDest20(d20, blind);
}

/** One-time owner for `dest`. The key is bound to the hidden portal id, not the address hash. */
export function ownerFor(dest, seed = null) {
  const id = hiddenPortalId(dest, seed || portalOwner.privateKey) || portalIdFromDest(dest);
  const key = portalOwnerKey(portalOwner.privateKey, id);
  const pub = Buffer.from(ed25519RawPub(key)).toString('hex');
  return { key, pub, commit: rewardOwnerCommit(pub), portalId: id };
}

export const portalOwnerCommit = ownerFor('portal-owner').commit;

function chainAt(nowMs, genesisMs) {
  const g = Number(genesisMs) || 0;
  const now = Number(nowMs) || 0;
  if (!(g > 0) || now < g) return 0;
  return Math.floor((now - g) / RESERVE_EPOCH_MS);
}

function amountBig(nanos) {
  if (typeof nanos === 'bigint') return nanos >= 0n ? nanos : 0n;
  if (typeof nanos === 'string' && /^\d+$/.test(nanos.trim())) return BigInt(nanos.trim());
  const n = Math.floor(Number(nanos) || 0);
  return n > 0 ? BigInt(n) : 0n;
}

/** Wallet-side record of commitments this process sent to the EVM. Not chain state. */
const LOCKS = new Map();

export function resetLockWitnesses() {
  LOCKS.clear();
}

function commitBuf(word) {
  if (Buffer.isBuffer(word)) return Buffer.from(word);
  if (word instanceof Uint8Array) return Buffer.from(word);
  const hex = String(word || '').replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  return Buffer.alloc(32);
}

function rememberLock(dest, commitWord, nowTs) {
  const key = String(dest || '');
  const list = LOCKS.get(key) || [];
  list.push({ commit: commitBuf(commitWord), at: Math.floor(Number(nowTs) || 0) });
  LOCKS.set(key, list);
}

function trancheAt(nanos, at, genesisMs) {
  const g = Number(genesisMs) || 0;
  const when = Number(at);
  const span = RESERVE_EPOCH_MS;
  const epoch = g > 0 && when >= g ? Math.floor((when - g) / span) : 0;
  const end = g > 0 ? g + (epoch + 1) * span : 0;
  let remainMs = end > when ? end - when : 0;
  if (remainMs > span) remainMs = span;
  void nanos;
  return { epoch, remainMs, noteIsPrincipal: false };
}

export function lockTranches(dest, genesisMs = BIND_GENESIS_MS) {
  return recordedTranches(dest, genesisMs) || [];
}

function recordedTranches(dest, genesisMs) {
  const list = LOCKS.get(String(dest || ''));
  if (!list?.length) return null;
  return list.map((lock) => {
    const row = trancheAt(0, lock.at, genesisMs);
    row.commit = lock.commit;
    return row;
  });
}

/** Release epoch and tranche set for a withdraw the EVM will check. */
export function withdrawAuthBind(nowMs, principal, bind = null) {
  const genesisMs = bind?.genesisMs ?? BIND_GENESIS_MS;
  const dest = bind?.dest || '';
  const locks = bind?.locks || [{ nanos: principal, at: bind?.lockAt ?? genesisMs }];
  const recorded = recordedTranches(dest, genesisMs);
  const tranches = bind?.tranches || recorded || locks.map((lock) => trancheAt(lock.nanos, lock.at, genesisMs));
  const epoch = bind?.epoch != null ? bind.epoch : chainAt(bind?.nowMs ?? nowMs, genesisMs);
  return {
    epoch,
    tranches,
    trancheSet: trancheSetHash(tranches, epoch),
    magic: reserveMagicBytes(bind?.magic || MAGIC_TESTNET),
    chainId: 2701n,
    genesisMs,
  };
}

export function deposit(args = {}) {
  const ownerPub = givenOwner(args.ownerPub) || ownerFor(args.dest || args.portalId).pub;
  return depositRaw({ ...args, ownerPub });
}

export function lockTx(args = {}) {
  const dest = args.to || args.from;
  let ownerPub = givenOwner(args.ownerPub);
  if (!ownerPub) {
    const id = args.spendSeed != null
      ? (hiddenPortalId(dest, args.spendSeed) || portalIdFromDest(dest))
      : ownerFor(dest).portalId;
    const key = portalOwnerKey(portalOwner.privateKey, id);
    ownerPub = key ? Buffer.from(ed25519RawPub(key)).toString('hex') : ownerFor(dest).pub;
  }
  return lockTxRaw({ ...args, ownerPub });
}

export function ownerWithdrawAuth(dest, principal, bind = null) {
  const who = bind?.ownerKey
    ? {
      key: bind.ownerKey,
      pub: Buffer.from(ed25519RawPub(bind.ownerKey)).toString('hex'),
      portalId: hiddenPortalId(dest) || portalIdFromDest(dest),
    }
    : ownerFor(dest);
  const spec = withdrawAuthBind(bind?.nowMs, principal, { ...(bind || {}), dest });
  const tx = { to: dest };
  const signNanos = bind?.signNanos != null ? bind.signNanos : 0;
  signWithdrawReward(tx, who.key, {
    portalId: who.portalId,
    nanos: signNanos,
    dest,
    epoch: spec.epoch,
    tranches: spec.tranches,
    magic: spec.magic,
    chainId: spec.chainId,
  });
  return packRewardAuth({ ownerPub: who.pub, sig: tx.rewardSig, dest });
}

/** Sign the withdraw. Hidden principal is 0 and still requires the owner signature. */
export function withdrawTx(args = {}, principal = null) {
  const tx = withdrawTxRaw(args);
  const nanos = principal == null ? args.nanos : principal;
  const portal = args.from;
  const signed = principal != null || Number(args.nanos) > 0;
  if (portal && signed && nanos != null && Number(nanos) >= 0) {
    const hidden = args.spendSeed != null ? hiddenPortalId(portal, args.spendSeed) : null;
    const carried = String(tx.portalId || '').toLowerCase();
    const signId = hidden && carried === hidden ? hidden : (carried || portalIdFromDest(portal));
    const key = hidden
      ? portalOwnerKey(portalOwner.privateKey, hidden)
      : ownerFor(portal).key;
    const spec = withdrawAuthBind(args.nowMs ?? (BIND_GENESIS_MS + RESERVE_EPOCH_MS), nanos, args.authBind || null);
    signWithdrawReward(tx, key || ownerFor(portal).key, {
      portalId: signId,
      nanos,
      dest: args.to,
      epoch: spec.epoch,
      tranches: spec.tranches,
      magic: spec.magic,
      chainId: spec.chainId,
    });
  }
  return tx;
}

function isCommitWord(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.length === 32;
  return typeof value === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(value.trim());
}

export function encodeDeposit(dest, amountOrCommit, nowTs, ownerCommit = undefined, qualifies = undefined) {
  let word = amountOrCommit;
  let joined = qualifies;
  if (!isCommitWord(amountOrCommit)) {
    const n = amountBig(amountOrCommit);
    word = pointBytes(commit(n, randomScalar()));
    if (joined === undefined) joined = n >= BigInt(PI_SHE_NANOS);
  }
  rememberLock(dest, word, nowTs);
  // A missing owner, or the one-time owner commit, is signed here. The
  // commitment is chosen above, so the signature has to be made after it.
  // The fixture owner signs the fixture book (testnet), as withdrawAuthBind does.
  let auth = ownerCommit;
  if (auth == null) auth = { key: ownerFor(dest).key, magic: MAGIC_TESTNET };
  else if (isCommitWord(auth) && commitBuf(auth).equals(Buffer.from(ownerFor(dest).commit))) {
    auth = { key: ownerFor(dest).key, magic: MAGIC_TESTNET };
  }
  return encodeDepositRaw(dest, word, nowTs, auth, joined === true);
}

/** Auth defaults to the one-time owner of `dest`. The signed principal is 0. */
export function encodeWithdraw(dest, nowTs, auth, principal = PI_SHE_NANOS, bind = null) {
  const blob = auth === undefined
    ? ownerWithdrawAuth(dest, principal, { ...(bind || {}), nowMs: nowTs, signNanos: 0 })
    : auth;
  return encodeWithdrawRaw(dest, nowTs, blob);
}

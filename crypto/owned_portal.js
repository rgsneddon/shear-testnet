/**
 * One wallet for tests that lock and withdraw.
 * Each portal gets its own owner key, derived from that wallet secret and
 * the portal id. The wallet spend key is not the owner key.
 */
import { ed25519RawPub, newIdentity } from './address.js';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS } from './asert.js';
import {
  deposit as depositRaw,
  lockTx as lockTxRaw,
  packRewardAuth,
  portalIdFromDest,
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

/** One-time owner for `dest`. An explicit pub overrides it and cannot sign. */
export function ownerFor(dest) {
  const id = portalIdFromDest(dest);
  const key = portalOwnerKey(portalOwner.privateKey, id);
  const pub = Buffer.from(ed25519RawPub(key)).toString('hex');
  return { key, pub, commit: rewardOwnerCommit(pub) };
}

export const portalOwnerCommit = ownerFor('portal-owner').commit;

function chainAt(nowMs, genesisMs) {
  const g = Number(genesisMs) || 0;
  const now = Number(nowMs) || 0;
  if (!(g > 0) || now < g) return 0;
  return Math.floor((now - g) / RESERVE_EPOCH_MS);
}

function trancheAt(nanos, at, genesisMs) {
  const g = Number(genesisMs) || 0;
  const when = Number(at);
  const span = RESERVE_EPOCH_MS;
  const epoch = g > 0 && when >= g ? Math.floor((when - g) / span) : 0;
  const end = g > 0 ? g + (epoch + 1) * span : 0;
  let remainMs = end > when ? end - when : 0;
  if (remainMs > span) remainMs = span;
  return { amount: nanos, epoch, remainMs, noteIsPrincipal: false };
}

/** Release epoch and tranche set for a withdraw the EVM will check. */
export function withdrawAuthBind(nowMs, principal, bind = null) {
  const genesisMs = bind?.genesisMs ?? BIND_GENESIS_MS;
  const locks = bind?.locks || [{ nanos: principal, at: bind?.lockAt ?? genesisMs }];
  const tranches = bind?.tranches || locks.map((lock) => trancheAt(lock.nanos, lock.at, genesisMs));
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
  const ownerPub = givenOwner(args.ownerPub) || ownerFor(args.to || args.from).pub;
  return lockTxRaw({ ...args, ownerPub });
}

export function ownerWithdrawAuth(dest, principal, bind = null) {
  const who = ownerFor(dest);
  const spec = withdrawAuthBind(bind?.nowMs, principal, bind);
  const tx = { to: dest };
  signWithdrawReward(tx, who.key, {
    portalId: portalIdFromDest(dest),
    nanos: principal,
    dest,
    epoch: spec.epoch,
    tranches: spec.tranches,
    magic: spec.magic,
    chainId: spec.chainId,
  });
  return packRewardAuth({ ownerPub: who.pub, sig: tx.rewardSig, dest });
}

/** Sign the withdraw over `principal`, which defaults to the receipt amount. */
export function withdrawTx(args = {}, principal = null) {
  const tx = withdrawTxRaw(args);
  const nanos = principal == null ? args.nanos : principal;
  const portal = args.from;
  if (portal && nanos > 0) {
    const who = ownerFor(portal);
    const spec = withdrawAuthBind(args.nowMs ?? (BIND_GENESIS_MS + RESERVE_EPOCH_MS), nanos, args.authBind || null);
    signWithdrawReward(tx, who.key, {
      portalId: portalIdFromDest(portal),
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

export function encodeDeposit(dest, nanos, nowTs, commit = undefined) {
  const use = commit === undefined ? ownerFor(dest).commit : commit;
  return encodeDepositRaw(dest, nanos, nowTs, use);
}

/** Auth defaults to the one-time owner of `dest` over `principal` (π when omitted). */
export function encodeWithdraw(dest, nowTs, auth, principal = PI_SHE_NANOS, bind = null) {
  const blob = auth === undefined
    ? ownerWithdrawAuth(dest, principal, { ...(bind || {}), nowMs: nowTs })
    : auth;
  return encodeWithdrawRaw(dest, nowTs, blob);
}

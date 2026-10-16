/**
 * One owner key for tests that lock and withdraw.
 * A portal is owned only when the test passes this key, or its own.
 */
import { newIdentity } from './address.js';
import { PI_SHE_NANOS } from './asert.js';
import {
  deposit as depositRaw,
  lockTx as lockTxRaw,
  packRewardAuth,
  portalIdFromDest,
  rewardOwnerCommit,
  signWithdrawReward,
  withdrawTx as withdrawTxRaw,
} from './reserve_vault.js';
import {
  encodeDeposit as encodeDepositRaw,
  encodeWithdraw as encodeWithdrawRaw,
} from './reserve_evm.js';

export const portalOwner = newIdentity();
export const portalOwnerPub = Buffer.from(portalOwner.spendPub).toString('hex');
export const portalOwnerCommit = rewardOwnerCommit(portalOwnerPub);

function givenOwner(value) {
  const pub = String(value || '').replace(/^0x/i, '');
  return /^[0-9a-f]{64}$/i.test(pub) ? pub.toLowerCase() : '';
}

export function deposit(args = {}) {
  const ownerPub = givenOwner(args.ownerPub) || portalOwnerPub;
  return depositRaw({ ...args, ownerPub });
}

export function lockTx(args = {}) {
  const ownerPub = givenOwner(args.ownerPub) || portalOwnerPub;
  return lockTxRaw({ ...args, ownerPub });
}

export function ownerWithdrawAuth(dest, principal) {
  const tx = { to: dest };
  signWithdrawReward(tx, portalOwner.privateKey, {
    portalId: portalIdFromDest(dest),
    nanos: principal,
    dest,
  });
  return packRewardAuth({ ownerPub: portalOwnerPub, sig: tx.rewardSig, dest });
}

/** Sign the withdraw over `principal`, which defaults to the receipt amount. */
export function withdrawTx(args = {}, principal = null) {
  const tx = withdrawTxRaw(args);
  const nanos = principal == null ? args.nanos : principal;
  const portal = args.from;
  if (portal && nanos > 0) {
    signWithdrawReward(tx, portalOwner.privateKey, {
      portalId: portalIdFromDest(portal),
      nanos,
      dest: args.to,
    });
  }
  return tx;
}

export function encodeDeposit(dest, nanos, nowTs, commit = portalOwnerCommit) {
  return encodeDepositRaw(dest, nanos, nowTs, commit);
}

/** Auth defaults to the shared owner over `principal` (π when omitted). */
export function encodeWithdraw(dest, nowTs, auth, principal = PI_SHE_NANOS) {
  const blob = auth === undefined ? ownerWithdrawAuth(dest, principal) : auth;
  return encodeWithdrawRaw(dest, nowTs, blob);
}

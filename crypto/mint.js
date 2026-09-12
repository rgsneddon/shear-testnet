import {
  RESERVE_PROGRAM,
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  extraMintAllowed,
  wrapMintForbidden,
} from './asert.js';
import { isDestAddress, isShearAddress } from './address.js';
import { hashBonusByMiner, coinbaseTx } from '../node/src/chain.js';
import { expectedCoinbasePays, matchSealedCoinbaseVout } from './coinbase_notes.js';

export {
  RESERVE_PROGRAM,
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  hashBonusByMiner,
  coinbaseTx,
  extraMintAllowed,
};

export { wrapMintForbidden };

export function extraMint({ programId, to, nanos, kind }) {
  const k = String(kind || (programId === RESERVE_PROGRAM ? 'withdraw' : 'mint'));
  if (wrapMintForbidden({ programId, kind: k })) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  if (!extraMintAllowed(programId, { kind: k })) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  if (!isDestAddress(to) && !isShearAddress(to)) return { ok: false, reason: 'bad_address' };
  const n = Number(nanos);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'bad_nanos' };
  return { ok: true, programId, to, nanos: n, kind: k, mint: true };
}

export function coinbaseSplit(cb, { shareBatch, miner } = {}) {
  const vout = Array.isArray(cb?.vout) ? cb.vout : [];
  const pays = expectedCoinbasePays(shareBatch || [], { miner: miner || cb?.miner });
  const hashByMiner = {};
  let potNanos = 0;
  let hashNanos = 0;
  for (const o of vout) {
    const kind = String(o.kind || '');
    if (kind === 'finder-fee' || kind === 'reserve-fee') continue;
    const hit = o.commit ? matchSealedCoinbaseVout(o, pays) : {
      address: o.address || '',
      nanos: Number(o.nanos || 0),
    };
    const n = Number(hit.nanos || o.nanos || 0);
    if (kind === 'hash') {
      hashNanos += n;
      if (hit.address) hashByMiner[hit.address] = n;
    } else {
      potNanos += n;
    }
  }
  return { potNanos, hashNanos, hashByMiner };
}

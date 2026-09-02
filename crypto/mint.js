import {
  RESERVE_PROGRAM,
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  extraMintAllowed,
  wrapMintForbidden,
} from './asert.js';
import { isDestAddress, isShearAddress } from './address.js';
import { hashBonusByMiner, coinbaseTx } from '../node/src/chain.js';

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
  if (wrapMintForbidden({ programId, kind })) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  if (!extraMintAllowed(programId, { kind })) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  if (!isDestAddress(to) && !isShearAddress(to)) return { ok: false, reason: 'bad_address' };
  const n = Number(nanos);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'bad_nanos' };
  const k = String(kind || (programId === RESERVE_PROGRAM ? 'reserve' : 'mint'));
  return { ok: true, programId, to, nanos: n, kind: k, mint: true };
}

export function coinbaseSplit(cb) {
  const vout = Array.isArray(cb?.vout) ? cb.vout : [];
  const pot = vout.filter((o) => o.kind !== 'hash' && o.kind !== 'finder-fee' && o.kind !== 'reserve-fee');
  const hash = vout.filter((o) => o.kind === 'hash');
  return {
    potNanos: pot.reduce((a, o) => a + Number(o.nanos || 0), 0),
    hashNanos: hash.reduce((a, o) => a + Number(o.nanos || 0), 0),
    hashByMiner: Object.fromEntries(hash.map((o) => [o.address, Number(o.nanos || 0)])),
  };
}

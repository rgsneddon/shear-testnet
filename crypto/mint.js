import { RESERVE_PROGRAM, BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS } from './asert.js';
import { isShearAddress } from './address.js';
import { hashBonusByMiner, coinbaseTx } from '../node/src/chain.js';

export { RESERVE_PROGRAM, BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS, hashBonusByMiner, coinbaseTx };

/** Only The Reserve may mint SHE beyond the miner pot + per-hasher nanos. */
export function extraMintAllowed(programId) {
  return String(programId || '') === RESERVE_PROGRAM;
}

export function extraMint({ programId, to, nanos }) {
  if (!extraMintAllowed(programId)) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  if (!isShearAddress(to)) return { ok: false, reason: 'bad_address' };
  const n = Number(nanos);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'bad_nanos' };
  return { ok: true, programId: RESERVE_PROGRAM, to, nanos: n, kind: 'reserve' };
}

export function coinbaseSplit(cb) {
  const vout = Array.isArray(cb?.vout) ? cb.vout : [];
  const pot = vout.filter((o) => o.kind !== 'hash');
  const hash = vout.filter((o) => o.kind === 'hash');
  return {
    potNanos: pot.reduce((a, o) => a + Number(o.nanos || 0), 0),
    hashNanos: hash.reduce((a, o) => a + Number(o.nanos || 0), 0),
    hashByMiner: Object.fromEntries(hash.map((o) => [o.address, Number(o.nanos || 0)])),
  };
}

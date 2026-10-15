import {
  RESERVE_PROGRAM,
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  POOL_FEE_MAX_BPS,
  extraMintAllowed,
  wrapMintForbidden,
} from './asert.js';
import { isDestAddress, isShearAddress } from './address.js';
import { hashBonusByMiner, coinbaseTx, potPaysFromLeaves } from '../node/src/chain.js';
import { expectedCoinbasePays, matchSealedCoinbaseVout } from './coinbase_notes.js';
import { aLeavesFromShares } from './share_batch.js';
import { verifySealedNote } from './note.js';

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
  if (isShearAddress(to) || !isDestAddress(to)) return { ok: false, reason: 'shear1' };
  let n;
  if (typeof nanos === 'bigint') {
    if (nanos <= 0n) return { ok: false, reason: 'bad_nanos' };
    n = nanos <= 9007199254740991n ? Number(nanos) : nanos;
  } else {
    n = Number(nanos);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'bad_nanos' };
  }
  return { ok: true, programId, to, nanos: n, kind: k, mint: true };
}

function splitOnce(cb, shareBatch, miner, poolDest, potNanosIn) {
  const vout = Array.isArray(cb?.vout) ? cb.vout : [];
  const pays = expectedCoinbasePays(shareBatch || [], { miner, poolDest, potNanos: potNanosIn });
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
    // A carried pot opens above the pay this batch named. That opening still
    // labels the dest. Only the named pay amount counts in this pass.
    const named = (pays || []).some((p) => (p.kind || 'pot') === kind && Number(p.nanos) === Number(hit.nanos));
    const n = !o.commit
      ? Number(hit.nanos || o.nanos || 0)
      : (named ? Number(hit.nanos || 0) : 0);
    if (kind === 'hash') {
      hashNanos += n;
      if (hit.address) hashByMiner[hit.address] = n;
    } else {
      potNanos += n;
    }
  }
  return { potNanos, hashNanos, hashByMiner };
}

function noteHex(buf) {
  try {
    const b = Buffer.from(buf || []);
    return b.length === 32 ? b.toString('hex') : '';
  } catch {
    return '';
  }
}

function openedPotRows(cb) {
  const rows = [];
  for (const o of cb?.vout || []) {
    const kind = String(o?.kind || '');
    if (kind === 'hash' || kind === 'finder-fee' || kind === 'reserve-fee') continue;
    const v = Math.floor(Number(o?.valueProof?.v));
    if (!(v > 0) || !verifySealedNote(o, v)) continue;
    rows.push({ kind, v, nc: noteHex(o.noteCommit) });
  }
  return rows;
}

function assignWork(rows, pays) {
  if (rows.length !== pays.length) return false;
  const used = new Set();
  for (const pay of pays) {
    const want = noteHex(pay.noteCommit);
    let hit = -1;
    for (let i = 0; i < rows.length; i += 1) {
      if (used.has(i)) continue;
      if (rows[i].v !== pay.nanos) continue;
      if (want && rows[i].nc !== want) continue;
      hit = i;
      break;
    }
    if (hit < 0) return false;
    used.add(hit);
  }
  return true;
}

/**
 * Sealed pot notes are the subsidy, a legal fee of that subsidy, and any
 * miner pot carried in from an empty parent. Any subsidy, any carry, any
 * share batch. The reported pot is the subsidy those notes settle.
 */
function explainsSubsidy(cb, shareBatch, wantPot) {
  const opened = openedPotRows(cb);
  const sum = opened.reduce((a, row) => a + row.v, 0);
  if (!(wantPot > 0) || sum < wantPot) return false;
  const carry = sum - wantPot;
  const leaves = aLeavesFromShares(shareBatch);
  if (!leaves.length) return false;
  const maxFee = Math.floor(wantPot * POOL_FEE_MAX_BPS / 10000);
  for (let bps = 0; bps <= POOL_FEE_MAX_BPS; bps += 1) {
    const fee = Math.floor(wantPot * bps / 10000);
    if (fee > maxFee || (bps > 0 && fee === 0)) continue;
    let feeRow = null;
    const work = [];
    for (const row of opened) {
      if (fee > 0 && !feeRow && row.kind === 'pool-fee' && row.v === fee) feeRow = row;
      else work.push(row);
    }
    if (fee > 0 && !feeRow) continue;
    if (fee === 0 && opened.some((row) => row.kind === 'pool-fee')) continue;
    const pays = potPaysFromLeaves(leaves, null, fee, wantPot, carry);
    if (!assignWork(work, pays)) continue;
    const workSum = work.reduce((a, row) => a + row.v, 0);
    if (workSum + (feeRow ? feeRow.v : 0) !== wantPot + carry) continue;
    return true;
  }
  return false;
}

export function coinbaseSplit(cb, { shareBatch, miner, poolDest, potNanos } = {}) {
  const batch = shareBatch || [];
  const m = miner || cb?.miner;
  const wantPot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const tries = [];
  if (poolDest) tries.push(poolDest);
  if (m) tries.push(m);
  tries.push('');
  const uniq = [...new Set(tries)];
  let best = { potNanos: 0, hashNanos: 0, hashByMiner: {} };
  for (const pd of uniq) {
    const got = splitOnce(cb, batch, m, pd, wantPot);
    if (got.potNanos === wantPot) return got;
    if (got.potNanos + got.hashNanos > best.potNanos + best.hashNanos) best = got;
  }
  if (explainsSubsidy(cb, batch, wantPot)) {
    return { potNanos: wantPot, hashNanos: best.hashNanos, hashByMiner: best.hashByMiner };
  }
  return best;
}

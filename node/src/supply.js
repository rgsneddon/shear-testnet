/**
 * Circulating supply from public block totals, not from opened notes.
 * Permitted pot is the schedule. Permitted hash is the share-batch rule.
 * The commitment sum must match pot minted + that hash + the public fee.
 * An oversized hash changes the sum, so it cannot cancel out of the reconcile.
 */
import { decodeHeader } from '../../crypto/header.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import {
  MAGIC_TESTNET,
  HASH_BONUS_NANOS,
  hashBonusUnitNanos,
  MAX_SHARES_PER_BLOCK,
  MAX_HASH_UNITS_PER_BLOCK,
  SHARE_FLOOR_BITS,
} from '../../crypto/asert.js';
import { verifyMintSum, verifyRange, excessOf } from '../../crypto/note.js';
import { isDestAddress } from '../../crypto/address.js';
import { unpackShareBatch } from '../../crypto/pack.js';
import {
  unitsForShare,
  destOfShare,
  noteCommitOfShare,
  retainedUnitsByCommit,
  creditBitsForShare,
} from '../../crypto/share_batch.js';
import { canonicalCarry } from './chain.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ZERO_32 = Buffer.alloc(32);

function safeNum(n) {
  if (typeof n !== 'bigint' || n < 0n || n > MAX_SAFE) return null;
  return Number(n);
}

function safeSigned(n) {
  if (typeof n !== 'bigint' || n > MAX_SAFE || n < -MAX_SAFE) return null;
  return Number(n);
}

function headerMs(block) {
  try {
    if (!block?.header) return null;
    const ts = Number(decodeHeader(Buffer.from(block.header)).timestamp);
    return Number.isSafeInteger(ts) && ts > 0 ? ts : null;
  } catch {
    return null;
  }
}

function asNonNeg(v) {
  if (typeof v === 'bigint') return v >= 0n && v <= MAX_SAFE ? v : null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = BigInt(v);
    return n <= MAX_SAFE ? n : null;
  }
  return null;
}

/** Fees on non-coinbase txs. That sum is the public levy, not an opened note. */
function publicLevy(block) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  let n = 0n;
  for (let i = 1; i < txs.length; i += 1) {
    const fee = txs[i]?.fee;
    if (fee == null || fee === '') continue;
    const v = asNonNeg(fee);
    if (v == null) return null;
    n += v;
    if (n > MAX_SAFE) return null;
  }
  return n;
}

function shareCounts(share) {
  try {
    const dest = destOfShare(share);
    if (dest && isDestAddress(dest)) return true;
  } catch { /* not a dest */ }
  try {
    const nc = noteCommitOfShare(share);
    return !!(nc && nc.length === 32 && !Buffer.from(nc).equals(ZERO_32));
  } catch {
    return false;
  }
}

/**
 * Consensus hash bonus for one block, without opening a note.
 * A non-empty batch credits retainedUnitsByCommit. Under the unit cap that is 2^bits per share. Over the cap it is the pro-rata share of the cap. Missing bits are the floor.
 * An empty batch with one hash output is the finder floor.
 * An empty batch with no hash output is zero.
 */
function permittedHash(block) {
  const unit = BigInt(hashBonusUnitNanos(HASH_BONUS_NANOS));
  const floorShare = BigInt(unitsForShare());
  let shares = [];
  try {
    shares = unpackShareBatch(Array.isArray(block?.shareBatch) ? block.shareBatch : []);
  } catch {
    return { ok: false, reason: 'hash_bonus', nanos: 0n };
  }
  const hashVouts = (block?.txs?.[0]?.vout || []).filter((o) => String(o?.kind || '') === 'hash');
  if (!shares.length) {
    if (hashVouts.length === 0) return { ok: true, nanos: 0n };
    if (hashVouts.length === 1) return { ok: true, nanos: floorShare * unit };
    return { ok: false, reason: 'hash_bonus', nanos: 0n };
  }
  if (shares.length > MAX_SHARES_PER_BLOCK) {
    return { ok: false, reason: 'hash_bonus', nanos: 0n };
  }
  const seen = new Set();
  for (const share of shares) {
    if (!shareCounts(share)) return { ok: false, reason: 'hash_bonus', nanos: 0n };
    let nonce;
    try { nonce = BigInt(share?.nonce || 0).toString(); } catch {
      return { ok: false, reason: 'hash_bonus', nanos: 0n };
    }
    if (seen.has(nonce)) return { ok: false, reason: 'hash_bonus', nanos: 0n };
    seen.add(nonce);
    const credit = creditBitsForShare(share, SHARE_FLOOR_BITS, { strict: true });
    if (!credit.ok) return { ok: false, reason: 'hash_bonus', nanos: 0n };
  }
  let units = 0n;
  for (const u of retainedUnitsByCommit(shares).values()) units += BigInt(u);
  if (units > BigInt(MAX_HASH_UNITS_PER_BLOCK)) {
    return { ok: false, reason: 'hash_bonus', nanos: 0n };
  }
  return { ok: true, nanos: units * unit };
}

function rangeBound(vouts) {
  const rows = Array.isArray(vouts) ? vouts : [];
  for (const o of rows) {
    if (!o?.commit) return false;
    let pr;
    try {
      pr = o.rangeProof
        ? (Buffer.isBuffer(o.rangeProof) ? o.rangeProof : Buffer.from(o.rangeProof))
        : Buffer.alloc(0);
    } catch {
      return false;
    }
    if (!pr.length || !verifyRange(o.commit, pr)) return false;
  }
  return true;
}

function commitmentsMatch(vouts, total, excess) {
  const rows = Array.isArray(vouts) ? vouts : [];
  if (total < 0n || total > MAX_SAFE) return false;
  if (!rows.length) {
    if (total !== 0n) return false;
    if (excess == null || excess === '') return true;
    try {
      return Buffer.from(excess).equals(Buffer.from(excessOf([])));
    } catch {
      return false;
    }
  }
  if (!rangeBound(rows)) return false;
  return verifyMintSum(rows, Number(total), excess);
}

/**
 * @returns {{
 *   status: 'verified' | 'mismatch',
 *   reason: string,
 *   circulatingNanos: number,
 *   measuredPotNanos: number,
 *   measuredHashNanos: number,
 *   measuredLevyNanos: number,
 *   schedulePotNanos: number,
 *   carryNanos: number,
 *   extraMintNanos: number,
 *   burnedNanos: number,
 *   differenceNanos: number,
 * }}
 */
export function auditCirculatingSupply(blocks, {
  magic = MAGIC_TESTNET,
  extraMintNanos = 0,
  burnedNanos = 0,
} = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const extra = asNonNeg(extraMintNanos) ?? 0n;
  const burned = asNonNeg(burnedNanos) ?? 0n;
  const blank = {
    status: 'mismatch',
    reason: 'supply',
    circulatingNanos: 0,
    measuredPotNanos: 0,
    measuredHashNanos: 0,
    measuredLevyNanos: 0,
    schedulePotNanos: 0,
    carryNanos: 0,
    extraMintNanos: safeNum(extra) || 0,
    burnedNanos: safeNum(burned) || 0,
    differenceNanos: 0,
  };
  if (asNonNeg(extraMintNanos) == null || asNonNeg(burnedNanos) == null) return blank;
  if (!list.length) {
    const net = extra - burned;
    const shown = safeNum(net);
    if (shown == null) return blank;
    return {
      ...blank,
      status: 'verified',
      reason: '',
      circulatingNanos: shown,
      differenceNanos: 0,
    };
  }
  const genesisMs = headerMs(list[0]);
  if (!(genesisMs > 0)) return { ...blank, reason: 'genesis_ms' };

  let mintedPot = 0n;
  let mintedHash = 0n;
  let mintedLevy = 0n;
  let schedulePot = 0n;
  let permittedHashAll = 0n;
  let carry = 0n;
  let ok = true;
  let reason = '';

  for (const block of list) {
    const ts = headerMs(block);
    if (!(ts > 0)) {
      ok = false;
      reason = reason || 'header';
      continue;
    }
    const permitted = potSubsidyAt({ nowMs: ts, genesisMs, magic });
    if (!Number.isSafeInteger(permitted) || permitted < 0) {
      ok = false;
      reason = reason || 'pot_sched';
      continue;
    }
    const permittedBi = BigInt(permitted);
    schedulePot += permittedBi;
    const cb = Array.isArray(block?.txs) ? block.txs[0] : null;
    const carryOutN = canonicalCarry(cb);
    if (carryOutN == null) {
      ok = false;
      reason = reason || 'pot_sched';
      continue;
    }
    const carryOut = BigInt(carryOutN);
    const potMinted = permittedBi + carry - carryOut;
    if (potMinted < 0n) {
      ok = false;
      reason = reason || 'pot_sched';
      continue;
    }
    const hash = permittedHash(block);
    const levy = publicLevy(block);
    if (!hash.ok || levy == null) {
      ok = false;
      reason = reason || hash.reason || 'supply';
      carry = carryOut;
      continue;
    }
    permittedHashAll += hash.nanos;
    const publicTotal = potMinted + hash.nanos + levy;
    if (!commitmentsMatch(cb?.vout || [], publicTotal, cb?.excess)) {
      ok = false;
      reason = reason || 'supply';
      carry = carryOut;
      continue;
    }
    mintedPot += potMinted;
    mintedHash += hash.nanos;
    mintedLevy += levy;
    carry = carryOut;
  }

  const circulating = mintedPot + mintedHash + extra - burned;
  const expected = schedulePot - carry + permittedHashAll + extra - burned;
  const difference = circulating - expected;
  if (difference !== 0n) {
    ok = false;
    reason = reason || 'supply';
  }
  const nums = {
    circulatingNanos: safeNum(circulating),
    measuredPotNanos: safeNum(mintedPot),
    measuredHashNanos: safeNum(mintedHash),
    measuredLevyNanos: safeNum(mintedLevy),
    schedulePotNanos: safeNum(schedulePot),
    carryNanos: safeNum(carry),
    extraMintNanos: safeNum(extra),
    burnedNanos: safeNum(burned),
    differenceNanos: safeSigned(difference),
  };
  if (Object.values(nums).some((n) => n == null || !Number.isSafeInteger(n))) {
    return { ...blank, reason: reason || 'supply' };
  }
  return {
    status: ok ? 'verified' : 'mismatch',
    reason: ok ? '' : (reason || 'supply'),
    ...nums,
  };
}

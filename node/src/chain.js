import { createHash } from 'node:crypto';
import { potSubsidyAt, chainGenesisMs as genesisMsOf } from '../../crypto/pot_sched.js';
import { shearHash, meetsTarget, hashHex } from '../../crypto/shear_hash.js';
import { hashHeaderOffLoop } from '../../crypto/hash_offloop.js';
import { encodeHeader, decodeHeader, setNonce, VERSION } from '../../crypto/header.js';
import { merkleRoot, EMPTY_ROOT } from '../../crypto/merkle.js';
import {
  GENESIS_BITS_PACKED,
  LIVE_MIN_BITS,
  MAX_BITS,
  asertNextBits,
  bitsAcceptAsert,
  TARGET_BLOCK_INTERVAL_MS,
  isPackedBits,
  unpackBits,
  blockWork,
  blockWorkBig,
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  HASH_BONUS_NANOS_FLOOR,
  hashBonusUnitNanos,
  MAGIC_TESTNET,
  MAGIC_TESTNET_V12,
  MAGIC_MAINNET,
  extraMintAllowed,
  wrapMintForbidden,
  DEST_HRP,
  JOIN_PROGRAM,
  JOIN_KIND_GENESIS,
  SHARE_FLOOR_BITS,
  MAX_SHARES_PER_BLOCK,
  POOL_FEE_BPS,
  POOL_FEE_MAX_BPS,
  MTP_WINDOW,
  MTP_FUTURE_MS,
  HEADER_AHEAD_MS,
  medianTimePast,
  GENESIS_BPS,
  RESERVE_PROGRAM,
} from '../../crypto/asert.js';
import { isHistoricalHeader } from '../../crypto/historical_prefix.js';
import {
  verifyShareBatch,
  paidWorkKeys,
  collateShareUnits,
  aLeavesFromShares,
  unitsForShare,
  destOfShare,
  dest20OfShare,
  noteCommitOfShare,
  retainedUnitsByCommit,
  selectBlockShares,
  stashSharePow,
  dropSharePowKeys,
} from '../../crypto/share_batch.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import {
  bootReserveEvm,
  blockNeedsEvm,
  executeBlockEvm,
} from '../../crypto/reserve_evm.js';
import { isDestAddress, isShearAddress, hash20FromAddress, bech32Hrp, checkAddressField, checkTxAddressFields, admitBaseFromAddress, encodeDest } from '../../crypto/address.js';
import {
  admit_verify,
  admitVerifyBatch,
  attachAdmitPub,
  fluxsetFromBlocks,
  jroot as jrootOf,
} from '../../crypto/admit.js';
import { collateSamples, shouldPruneSamples, flowSkipAllowed, sealedVinLinkField } from '../../crypto/chronoflux.js';
import { verifyFundedBody, verifyPoolWithdrawBound, boundReserveWithdraw } from '../../crypto/spend.js';
import { portalIdFromDest } from '../../crypto/reserve_vault.js';
import { hasherPayoutDest } from '../../crypto/flow_sheet.js';
import {
  sealCoinbaseNote,
  verifySealedNote,
  verifyMintSum,
  openedCoinbaseNanos,
  coinbaseVoutsBound,
  verifyRange,
  excessOf,
  verifyFlowConservation,
  flowInputsBound,
  noteCommitOfDest20,
  asU8,
  pointFrom,
} from '../../crypto/note.js';
import { packTx, packDigest, unpackShareBatch, u64le } from '../../crypto/pack.js';
import {
  freshCreditsFromShares,
  freshForBlock,
  sealedCreditsBuried,
  hashBudgetNanos,
  hashDustFromTx,
  hashLedgerIdle,
  hashOwedDigestSuffix,
  hashOwedFromTx,
  hashOwedRootAgrees,
  hashOverflowFromTx,
  sameHashLedger,
  settleHashOwed,
  writeHashLedger,
} from '../../crypto/hash_owed.js';
import { buildDualTree, spendB } from '../../crypto/clearing.js';
import {
  nextBaseFee,
  blockWeight,
  splitLevy,
  txWeight,
  reserveFeeDest,
  levyTaxed,
  containsShe1,
  levyNeed,
  LEVY_CAP_NANOS,
  poolFeeDest,
} from '../../crypto/levy.js';
import { gateVorticeRegister } from '../../crypto/vortex.js';
import { dummyCount, flowNeedsDummy, moneyNeedsRange } from '../../crypto/dummy.js';

export { blockWeight, nextBaseFee } from '../../crypto/levy.js';

export {
  SAMPLE_PRUNE_CONFIRMATIONS,
  shouldPruneSamples,
  pruneSamples,
  collateSamples,
  leanBlock,
  sealedExplorerRows,
  explorerSpendable,
  compactTx,
  compactChainBlock,
} from '../../crypto/chronoflux.js';

export const GENESIS_PREV = Buffer.alloc(32);

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

function ref32(x) {
  if (x == null || x === '') return null;
  try {
    const b = Buffer.from(asU8(x));
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

function lookupSpentVout(vin, block, prev, bodyIndex, history) {
  const idx = Number(vin?.index || 0);
  const want = ref32(vin?.prev);
  const tryTx = (tx, blockHash) => {
    const vout = (tx?.vout || [])[idx];
    if (!vout?.commit) return null;
    if (!want) return null;
    const dig = digestTx(tx);
    if (dig.equals(want)) return vout;
    const bh = ref32(blockHash);
    if (bh && bh.equals(want)) return vout;
    if (tx?.id && String(tx.id) === String(vin.prev)) return vout;
    return null;
  };
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const last = Math.min(txs.length, 1 + Number(bodyIndex || 0));
  for (let j = 0; j < last; j += 1) {
    const hit = tryTx(txs[j], block.hash);
    if (hit) return hit;
  }
  const chain = [];
  if (Array.isArray(history) && history.length) chain.push(...history);
  else if (prev) chain.push(prev);
  for (const b of chain) {
    for (const tx of b.txs || []) {
      const hit = tryTx(tx, b.hash);
      if (hit) return hit;
    }
  }
  return null;
}

/** Non-negative safe-integer carry, 0 when absent. Null is not a carry. */
export function canonicalCarry(tx) {
  if (tx == null || tx.carryNanos == null || tx.carryNanos === '') return 0;
  const n = typeof tx.carryNanos === 'bigint' ? Number(tx.carryNanos) : Number(tx.carryNanos);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

export function digestTx(tx) {
  const vins = (tx.vin || []).map((v, i) => {
    const prev = ref32(v.prev) || Buffer.alloc(32);
    const nc = ref32(v.noteCommit);
    return {
      prev,
      index: Number(v.index || i),
      dest20: nc ? nc.subarray(0, 20) : Buffer.alloc(20),
    };
  });
  const vouts = (tx.vout || []).map((o) => {
    const nc = ref32(o.noteCommit);
    let d20 = nc ? nc.subarray(0, 20) : null;
    if (!d20) {
      try {
        const owned = o.dest20 != null && o.dest20 !== '' ? Buffer.from(asU8(o.dest20)) : null;
        if (owned && owned.length >= 20) d20 = owned.subarray(0, 20);
      } catch { /* fall through to address */ }
    }
    const claimed = o.valueProof?.v != null ? Number(o.valueProof.v) : Number(o.nanos || 0);
    return {
      dest20: d20 || dest20Of(o.address || ''),
      nanos: o.commit ? 0 : claimed,
      kind: kindByte(o.kind),
    };
  });
  const packed = packTx({
    version: 1,
    vins: vins.length ? vins : [{ prev: Buffer.alloc(32), index: Number(tx.height || 0), dest20: Buffer.alloc(20) }],
    vouts,
    memoH: tx.memoH || null,
    bFlag: tx.bFlag || tx.kind === 'b-spend' ? 1 : 0,
  });
  // A positive carry is bound into the coinbase digest. Zero omits the suffix,
  // so a paid-out coinbase keeps the previous digest. A peer who changes the
  // carry changes the merkle root.
  const carry = tx?.coinbase ? canonicalCarry(tx) : 0;
  const owedSuffix = tx?.coinbase ? hashOwedDigestSuffix(tx) : Buffer.alloc(0);
  if (tx?.coinbase && owedSuffix == null) {
    return packDigest(Buffer.concat([packed, Buffer.from('hashowed-bad')]));
  }
  if (tx?.coinbase && (carry || (owedSuffix && owedSuffix.length))) {
    const parts = [packed];
    if (carry) parts.push(Buffer.from('potcarry1'), u64le(carry));
    if (owedSuffix && owedSuffix.length) parts.push(owedSuffix);
    return packDigest(Buffer.concat(parts));
  }
  return packDigest(packed);
}

function aLeavesOf(collated, pay) {
  return collated.map((s) => {
    const d20 = dest20Of(pay(s.miner || s.address || s.dest || ''));
    return {
      dest20: d20,
      noteCommit: s.noteCommit && Buffer.from(s.noteCommit).length === 32
        ? Buffer.from(s.noteCommit)
        : noteCommitOfDest20(d20),
      count: Number(s.count) > 0 ? Number(s.count) : unitsForShare(),
    };
  });
}

function bLeavesOf(txs, pay) {
  const out = [];
  for (const tx of txs || []) {
    if (tx.kind === MEMPOOL_B || tx.kind === 'b-spend') continue;
    if (!(tx.bExtra || tx.kind === 'b-extra' || tx.bFlag)) continue;
    const dest = pay(tx.to || tx.vout?.[0]?.address || '');
    out.push({
      dest20: dest20Of(dest),
      unit: Number(tx.unit || tx.nanos || tx.vout?.[0]?.nanos || 0),
      nonce: Number(tx.nonce || 0),
      memoH: tx.memoH ? Buffer.from(tx.memoH) : Buffer.alloc(32),
      tag: String(tx.tag || 'b-extra').slice(0, 8),
    });
  }
  return out;
}

const MEMPOOL_B = 'b-spend';

function ssaOk(addr) {
  return isDestAddress(addr) && bech32Hrp(addr) === DEST_HRP && !isShearAddress(addr);
}

/** Dest count above 2^headerBits * 16 is sample_cap. */
export function sampleCountCap(bits) {
  const b = BigInt(Math.max(0, Math.floor(Number(bits) || 0)));
  return (1n << b) * 16n;
}

export function sampleCapExceeded(samples = [], bits) {
  const cap = sampleCountCap(bits);
  for (const s of collateSamples(samples)) {
    const count = BigInt(Math.max(0, Math.floor(Number(s.count) || 0)));
    if (count > cap) return true;
  }
  return false;
}

export function hashBonusByMiner(samples = [], unit = HASH_BONUS_NANOS, shareBatch = null) {
  const bonus = hashBonusUnitNanos(unit);
  const by = new Map();
  void samples;
  if (shareBatch != null) {
    for (const [addr, units] of collateShareUnits(shareBatch)) {
      by.set(addr, units * bonus);
    }
  }
  return by;
}

function ncHex(buf) {
  try {
    return Buffer.from(buf || []).toString('hex');
  } catch {
    return '';
  }
}

function chainGenesisMsFrom(blocks, prevHeader) {
  return genesisMsOf(blocks, prevHeader, decodeHeader);
}

function blockTimeMs(block) {
  try {
    return Number(decodeHeader(Buffer.from(block.header)).timestamp) || 0;
  } catch {
    return 0;
  }
}

function mintWithLevy(vouts, scheduled, excess) {
  const rows = (vouts || []).filter((o) => o?.commit);
  // A carried pot mints no note. The empty commitment sum is a mint of zero.
  if (!rows.length) return Math.floor(Number(scheduled) || 0) === 0;
  let levy = 0;
  for (const o of rows) {
    if (o.kind !== 'finder-fee' && o.kind !== 'reserve-fee') continue;
    const v = openedCoinbaseNanos(o);
    if (v == null) return false;
    levy += v;
  }
  return verifyMintSum(rows, scheduled + levy, excess);
}

export function wantPotNanos(block, opts = {}) {
  const nowMs = blockTimeMs(block) || Number(opts.nowMs) || 0;
  const genesisMs = Number(opts.genesisMs);
  if (!Number.isFinite(genesisMs) || genesisMs <= 0) return null;
  return potSubsidyAt({ nowMs, genesisMs, magic: opts.magic || MAGIC_TESTNET });
}

/** PROP of (pot − pool fee + carry) across Tree-A note_commits. The fee is not taken from carry. */
export function potPaysFromLeaves(leaves = [], poolDest = null, feeNanos = null, potNanos = BLOCK_SUBSIDY_NANOS, carryNanos = 0) {
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const carry = Math.max(0, Math.floor(Number(carryNanos) || 0));
  const pool = poolDest && isDestAddress(poolDest) ? poolDest : '';
  const poolNc = pool ? noteCommitOfDest20(hash20FromAddress(pool)).toString('hex') : '';
  const fee = feeNanos != null
    ? Math.max(0, Math.floor(Number(feeNanos) || 0))
    : (poolNc ? Math.floor(pot * POOL_FEE_BPS / 10000) : 0);
  const rest = pot - fee + carry;
  const list = (leaves || []).map((l) => ({
    noteCommit: Buffer.from(l.noteCommit || []),
    count: Number(l.count) || 0,
  })).filter((l) => l.noteCommit.length === 32 && l.count > 0);
  const total = list.reduce((a, l) => a + l.count, 0);
  const out = [];
  if (!total) return out;
  let paid = 0;
  const sorted = [...list].sort((a, b) => ncHex(a.noteCommit).localeCompare(ncHex(b.noteCommit)));
  for (let i = 0; i < sorted.length; i += 1) {
    const nanos = i === sorted.length - 1 ? rest - paid : Math.floor(rest * sorted[i].count / total);
    paid += nanos;
    if (nanos > 0) out.push({ noteCommit: sorted[i].noteCommit, nanos, kind: 'pot' });
  }
  if (poolNc && fee > 0) {
    const existing = out.find((s) => ncHex(s.noteCommit) === poolNc);
    if (existing) existing.nanos += fee;
    else out.push({ noteCommit: noteCommitOfDest20(hash20FromAddress(pool)), nanos: fee, kind: 'pool-fee' });
  }
  return out.filter((s) => s.nanos > 0);
}

/** PROP of (pot - pool fee + carry) across dest20 in shareBatch. Pool dest gets only the fee. */
export function potSharesFromBatch(shareBatch = [], poolDest = null, potNanos = BLOCK_SUBSIDY_NANOS, carryNanos = 0) {
  const leaves = aLeavesFromShares(shareBatch);
  const pays = potPaysFromLeaves(leaves, poolDest, null, potNanos, carryNanos);
  const destByNc = new Map();
  for (const s of shareBatch || []) {
    const dest = destOfShare(s);
    const nc = ncHex(noteCommitOfShare(s));
    if (dest && nc) destByNc.set(nc, dest);
  }
  if (poolDest && isDestAddress(poolDest)) {
    destByNc.set(noteCommitOfDest20(hash20FromAddress(poolDest)).toString('hex'), poolDest);
  }
  return pays.map((p) => ({
    ...p,
    address: destByNc.get(ncHex(p.noteCommit)) || '',
  })).filter((s) => s.nanos > 0);
}

export function lag1Continuity(prevHeader) {
  if (!prevHeader) return EMPTY_ROOT;
  try {
    return decodeHeader(Buffer.from(prevHeader)).continuityRoot;
  } catch {
    return EMPTY_ROOT;
  }
}

export function custodyPotShares(poolDest, potNanos = BLOCK_SUBSIDY_NANOS) {
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const feeDest = poolFeeDest() || poolDest;
  const fee = Math.floor(pot * POOL_FEE_BPS / 10000);
  const rest = pot - fee;
  const out = [];
  if (rest > 0 && isDestAddress(poolDest)) out.push({ address: poolDest, nanos: rest, kind: 'pot' });
  if (fee > 0 && isDestAddress(feeDest)) {
    out.push({ address: feeDest, nanos: fee, kind: feeDest === poolDest ? 'pot' : 'pool-fee' });
  }
  return out;
}

function notePays(o, dest, nanos) {
  if (!o?.commit || !isDestAddress(dest) || !(nanos > 0)) return false;
  const nc = ncHex(noteCommitOfDest20(hash20FromAddress(dest)));
  return ncHex(o.noteCommit) === nc && verifySealedNote(o, nanos);
}

/**
 * Old custodial shape: one hash note for the whole bonus, paid to a dest
 * that is not a hasher leaf. v12 verifyBlockConsensus does not accept it.
 */
export function matchCustodyCoinbase({
  hashVouts = [],
  poolDest,
  wantBonus,
  hasherNcs,
} = {}) {
  const bonus = Math.max(0, Math.floor(Number(wantBonus) || 0));
  const dest = poolDest && isDestAddress(poolDest) ? poolDest : '';
  const hasher = hasherNcs instanceof Set ? hasherNcs : new Set();
  if (bonus > 0) {
    if (hashVouts.length !== 1) return false;
    if (dest) {
      if (!notePays(hashVouts[0], dest, bonus)) return false;
    } else if (!verifySealedNote(hashVouts[0], bonus)) {
      return false;
    }
    const hashNc = ncHex(hashVouts[0].noteCommit);
    if (hasher.has(hashNc)) return false;
    return true;
  }
  return hashVouts.length === 0;
}

/**
 * Old shape: hash notes on hasher leaves, pot still custodial. v12
 * verifyBlockConsensus does not accept it.
 */
export function matchDestBoundHashCustodyPot({
  hashVouts = [],
  potVouts = [],
  leaves = [],
  liveUnit,
  wantPot,
  hinted,
  hasherNcs,
} = {}) {
  const hasher = hasherNcs instanceof Set ? hasherNcs : new Set();
  if (!leaves.length) return false;
  const unit = hashBonusUnitNanos(liveUnit);
  for (const leaf of leaves) {
    const n = (Number(leaf.count) || 0) * unit;
    const hit = hashVouts.find((o) => ncHex(o.noteCommit) === ncHex(leaf.noteCommit));
    if (!(n > 0) || !hit || !verifySealedNote(hit, n)) return false;
  }
  for (const o of hashVouts) {
    if (!hasher.has(ncHex(o.noteCommit))) return false;
  }
  const extra = (potVouts || []).filter((o) => !hasher.has(ncHex(o.noteCommit)));
  if (extra.length !== potVouts.length || !extra.length) return false;
  const dest = hinted && isDestAddress(hinted) ? hinted : '';
  if (dest) {
    const shares = custodyPotShares(dest, wantPot);
    if (shares.length === extra.length) {
      const used = new Set();
      let ok = true;
      for (const s of shares) {
        const hit = extra.find((o) => !used.has(ncHex(o.noteCommit)) && notePays(o, s.address, s.nanos));
        if (!hit) {
          ok = false;
          break;
        }
        used.add(ncHex(hit.noteCommit));
      }
      if (ok && used.size === extra.length) return true;
    }
  }
  // P2P ingest has no out-of-band poolDest. Accept 1% through the subsidy cap, plus the rest, on non-hasher dests. Carry is not fee'd.
  const pot = Math.max(0, Math.floor(Number(wantPot) || 0));
  if (extra.length === 2 && pot > 0) {
    for (let bps = 1; bps <= POOL_FEE_MAX_BPS; bps += 1) {
      const fee = Math.floor(pot * bps / 10000);
      const rest = pot - fee;
      if (!(fee > 0) || rest <= 0) continue;
      const feeV = extra.find((o) => verifySealedNote(o, fee));
      const restV = extra.find((o) => o !== feeV && verifySealedNote(o, rest));
      if (feeV && restV) return true;
    }
  }
  return false;
}

/**
 * Pot splits a pool may seal. A fee folded into a round participant is a slice
 * of this subsidy only, up to POOL_FEE_MAX_BPS. The split pot may include
 * carry. Which dest receives the fee is that pool's choice, not book law.
 */
function propPayCandidates(leaves, feeBase, hinted, extraAmt, shareBatch, splitPot = null) {
  const pot = splitPot == null ? feeBase : splitPot;
  const base = Math.max(0, Math.floor(Number(feeBase) || 0));
  const candidates = [];
  if (hinted) candidates.push(potPaysFromLeaves(leaves, hinted, extraAmt, pot));
  candidates.push(potPaysFromLeaves(leaves, null, extraAmt, pot));
  if (extraAmt > 0) candidates.push(potPaysFromLeaves(leaves, null, 0, pot));
  if (!(extraAmt > 0)) {
    const dests = new Set();
    if (hinted && isDestAddress(hinted)) dests.add(hinted);
    for (const s of shareBatch || []) {
      const d = destOfShare(s);
      if (d && isDestAddress(d)) dests.add(d);
    }
    for (const dest of dests) {
      for (let bps = 1; bps <= POOL_FEE_MAX_BPS; bps += 1) {
        const fee = Math.floor(base * bps / 10000);
        if (fee > 0) candidates.push(potPaysFromLeaves(leaves, dest, fee, pot));
      }
    }
  }
  return candidates;
}

/**
 * One non-hasher pot note: absent (0) or a bps of `wantPot` through
 * POOL_FEE_MAX_BPS. The published valueProof.v is only a hint. A missing,
 * high, or wrong v does not change the verdict: the note must open to a
 * legal subsidy fee.
 */
export function extraPotFeeNanos(extraVouts = [], wantPot) {
  const pot = Math.max(0, Math.floor(Number(wantPot) || 0));
  const maxFee = Math.floor(pot * POOL_FEE_MAX_BPS / 10000);
  const extra = Array.isArray(extraVouts) ? extraVouts : [];
  if (!extra.length) return 0;
  if (extra.length !== 1 || !(pot > 0)) return null;
  const claimed = Math.floor(Number(extra[0]?.valueProof?.v));
  if (claimed > 0 && claimed <= maxFee) {
    for (let bps = 1; bps <= POOL_FEE_MAX_BPS; bps += 1) {
      if (Math.floor(pot * bps / 10000) === claimed && verifySealedNote(extra[0], claimed)) return claimed;
    }
  }
  for (let bps = 1; bps <= POOL_FEE_MAX_BPS; bps += 1) {
    const n = Math.floor(pot * bps / 10000);
    if (n > 0 && n <= maxFee && n !== claimed && verifySealedNote(extra[0], n)) return n;
  }
  return null;
}

/** Fail-closed: consensus ignores hashBonusCustodyDest unless SHEAR_ALLOW_HASHBONUS_CUSTODY=1. */
export const HASHBONUS_CUSTODY_ALLOW_ENV = 'SHEAR_ALLOW_HASHBONUS_CUSTODY';

export function allowedHashBonusCustodyDest(dest) {
  if (String(process.env.SHEAR_ALLOW_HASHBONUS_CUSTODY || '').trim() !== '1') return '';
  return dest && isDestAddress(dest) ? dest : '';
}

function sealHashPay(pay, address) {
  const nanos = Number(pay.nanos);
  const base = pay.admitBase && Buffer.from(pay.admitBase).length === 32
    ? pay.admitBase
    : (address ? admitBaseFromAddress(address) : null);
  return attachAdmitPub(sealCoinbaseNote(nanos, {
    dest20: pay.dest20,
    noteCommit: pay.noteCommit,
    kind: 'hash',
  }), { admitBase: base || null });
}

export function coinbaseTx({
  height, miner, samples = [], potShares = null, destOf = (a) => a, hashBonusNanos = HASH_BONUS_NANOS,
  shareBatch = null, poolDest = null, potNanos = BLOCK_SUBSIDY_NANOS,
  hashBonusCustodyDest = null,
  carryNanos = 0,
  hashOwedIn = null,
  hashDustIn = null,
  hashOverflowIn = null,
  hashAcceptedSeries = null,
}) {
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const carry = Math.max(0, Math.floor(Number(carryNanos) || 0));
  const bonuses = hashBonusByMiner(samples, hashBonusNanos, shareBatch);
  const vout = [];
  // v12 does not retarget the hash bonus or the pot onto a custody dest.
  // Explicit shares still name the pot. Callers that pass a custodial list
  // build a block verify rejects.
  void hashBonusCustodyDest;
  const explicit = Array.isArray(potShares);
  let shares = explicit ? potShares : null;
  if (!explicit) {
    if (Array.isArray(shareBatch) && shareBatch.length) {
      shares = potSharesFromBatch(shareBatch, poolDest, pot);
      if (!shares.length) shares = [{ address: miner, nanos: pot, kind: 'pot' }];
    } else if (carry > 0) {
      shares = [];
    } else {
      shares = [{ address: miner, nanos: pot, kind: 'pot' }];
    }
  }
  for (const s of shares) {
    const pay = destOf(s.address);
    if (!isDestAddress(pay) || !s.nanos) continue;
    const d20 = hash20FromAddress(pay);
    vout.push(attachAdmitPub(sealCoinbaseNote(s.nanos, { dest20: d20, kind: s.kind || 'pot' }), {
      admitBase: admitBaseFromAddress(pay),
    }));
  }
  // Hash notes follow the owed settlement. Under the cap with nothing
  // owed, that is the retained share and the vout order matches the
  // first-seen dest order. An empty batch with an empty ledger mints no
  // hash note here. A later producer pays parent rows the same way.
  const fresh = freshCreditsFromShares(shareBatch || [], hashBonusNanos);
  const budget = hashAcceptedSeries == null ? null : hashBudgetNanos(hashAcceptedSeries, hashBonusNanos);
  if (hashAcceptedSeries != null && budget == null) throw new Error('hash_owed');
  const settled = settleHashOwed({
    owedIn: hashOwedIn || [],
    dustIn: hashDustIn || 0n,
    overflowIn: hashOverflowIn || 0n,
    fresh,
    height,
    unit: hashBonusNanos,
    budget,
  });
  if (!settled.ok) throw new Error(settled.reason || 'hash_owed');
  const payByHex = new Map(settled.pay.map((p) => [p.noteCommit.toString('hex'), p]));
  const emitted = new Set();
  for (const [address] of bonuses) {
    const payAddr = destOf(address);
    if (!isDestAddress(payAddr)) continue;
    const d20 = hash20FromAddress(payAddr);
    if (!d20) continue;
    let nc;
    try { nc = noteCommitOfDest20(d20); } catch { continue; }
    const hex = nc.toString('hex');
    const pay = payByHex.get(hex);
    if (!pay || emitted.has(hex)) continue;
    if (pay.nanos > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('hash_owed');
    emitted.add(hex);
    vout.push(sealHashPay(pay, payAddr));
  }
  for (const pay of settled.pay) {
    const hex = pay.noteCommit.toString('hex');
    if (emitted.has(hex)) continue;
    if (pay.nanos > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('hash_owed');
    emitted.add(hex);
    const addr = pay.address && isDestAddress(pay.address)
      ? pay.address
      : encodeDest(pay.dest20);
    vout.push(sealHashPay(pay, addr));
  }
  const carriedRows = (settled.owed?.length || 0) + (settled.owedRest?.length || 0);
  if (!vout.length && carry <= 0 && settled.minted === 0n && carriedRows === 0) {
    throw new Error('coinbase_needs_dest');
  }
  const tx = {
    coinbase: true,
    height,
    vin: [{ coinbase: true, height }],
    vout,
    excess: excessOf(vout),
    carryNanos: carry,
  };
  writeHashLedger(tx, settled);
  return tx;
}

export function buildTemplate({
  prev,
  prevHeader,
  prevBlock = null,
  parentWeight: parentWeightIn,
  height,
  miner,
  samples = [],
  txs = [],
  bLeaves: bLeavesIn,
  now = Date.now(),
  bits,
  destOf,
  potShares = null,
  hashBonusNanos = HASH_BONUS_NANOS,
  shareBatch = null,
  poolDest = null,
  hashBonusCustodyDest = null,
  parentFluxset = null,
  parentBlocks = null,
  hashAcceptedSeries = null,
  hashOwedIn: hashOwedInOpt = null,
}) {
  const batch = Array.isArray(shareBatch) ? selectBlockShares(shareBatch) : [];
  const fromBatch = batch.length
    ? [...collateShareUnits(batch)].map(([minerAddr, count]) => ({
      miner: minerAddr,
      address: minerAddr,
      count,
      nonce: '0',
      tag: 'share',
    }))
    : [];
  // Tree A is shareBatch units only. Typed sample counts are not money.
  const collated = fromBatch;
  const pay = destOf || ((login) => hasherPayoutDest(login) || '');
  let genesisMs = chainGenesisMsFrom(parentBlocks, null);
  if (!(genesisMs > 0) && prevHeader) {
    try {
      const parent = decodeHeader(Buffer.from(prevHeader));
      if (parent.prevBlockHash.equals(GENESIS_PREV)) genesisMs = Number(parent.timestamp) || 0;
    } catch { /* parent is not a readable header */ }
  }
  if (!(genesisMs > 0) && Number(height) === 1) genesisMs = Number(now) || 0;
  const subsidy = potSubsidyAt({
    nowMs: now,
    genesisMs: genesisMs > 0 ? genesisMs : Number(now) || 0,
    magic: MAGIC_TESTNET,
  });
  // Parent carry is unminted miner pot. Explicit shares mint what they name.
  // Anything still unpaid, including an empty list, stays carried. Solo
  // (null shares) pays the miner the subsidy plus that carry and carries nothing.
  const carryIn = canonicalCarry(prevBlock?.txs?.[0]) || 0;
  const parentCb = prevBlock?.txs?.[0] || null;
  let series = Array.isArray(hashAcceptedSeries) ? hashAcceptedSeries : null;
  // Maintained owed state. A lean parent root is not a reason to walk the chain.
  let hashOwedIn = Array.isArray(hashOwedInOpt) ? hashOwedInOpt : hashOwedFromTx(parentCb);
  if (Array.isArray(hashOwedInOpt) && parentCb && !hashOwedRootAgrees(parentCb, hashOwedInOpt)) {
    throw new Error('hash_owed');
  }
  const hashDustIn = hashDustFromTx(parentCb);
  const hashOverflowIn = hashOverflowFromTx(parentCb);
  if (hashOwedIn == null || hashDustIn == null || hashOverflowIn == null) {
    throw new Error('hash_owed');
  }
  const payable = subsidy + carryIn;
  const explicit = Array.isArray(potShares);
  let minted = 0;
  if (explicit) {
    for (const s of potShares) minted += Math.max(0, Math.floor(Number(s.nanos) || 0));
  }
  const carryOut = explicit ? payable - minted : 0;
  const cb = coinbaseTx({
    height,
    miner,
    samples: collated,
    potShares: explicit ? potShares : null,
    destOf: pay,
    hashBonusNanos,
    shareBatch: batch,
    poolDest,
    potNanos: explicit ? Math.max(subsidy, minted) : payable,
    carryNanos: carryOut > 0 ? carryOut : 0,
    hashBonusCustodyDest,
    hashOwedIn,
    hashDustIn,
    hashOverflowIn,
    hashAcceptedSeries: series,
  });
  const fees = (txs || []).reduce((a, t) => a + Math.max(0, Math.floor(Number(t.fee || 0))), 0);
  const split = splitLevy(fees);
  if (split.finder) {
    const dest = pay(miner);
    const d20 = hash20FromAddress(dest);
    cb.vout.push(d20
      ? attachAdmitPub(sealCoinbaseNote(split.finder, { dest20: d20, kind: 'finder-fee' }), {
        admitBase: admitBaseFromAddress(dest),
      })
      : { address: dest, nanos: split.finder, kind: 'finder-fee' });
  }
  if (split.reserve) {
    const dest = reserveFeeDest();
    const d20 = hash20FromAddress(dest);
    cb.vout.push(d20
      ? attachAdmitPub(sealCoinbaseNote(split.reserve, { dest20: d20, kind: 'reserve-fee' }), {
        admitBase: admitBaseFromAddress(dest),
      })
      : { address: dest, nanos: split.reserve, kind: 'reserve-fee' });
  }
  cb.excess = excessOf(cb.vout);
  const parentPubs = Array.isArray(parentFluxset)
    ? parentFluxset
    : fluxsetFromBlocks(parentBlocks || (prevBlock ? [prevBlock] : [])).pubs;
  const newPubs = [...parentPubs];
  for (const o of cb.vout || []) {
    if (o?.admitPub) newPubs.push(o.admitPub);
  }
  for (const tx of txs || []) {
    for (const o of tx.vout || []) {
      if (o?.admitPub) newPubs.push(o.admitPub);
    }
  }
  if (Number(height) === 1 || parentPubs.length || prevBlock || parentBlocks) {
    cb.jroot = jrootOf(newPubs.map((p) => (typeof p?.toBytes === 'function' ? p : p)));
  }
  const bodyTxs = [cb, ...txs];
  const merkle = merkleRoot(bodyTxs.map(digestTx));
  const aLeaves = aLeavesOf(collated, pay);
  const bLeaves = Array.isArray(bLeavesIn) ? bLeavesIn : bLeavesOf(txs, pay);
  const dual = buildDualTree({ aLeaves, bLeaves });
  let parentBase = 1;
  if (prevHeader) {
    try {
      parentBase = Number(decodeHeader(Buffer.from(prevHeader)).baseFee || 1n);
    } catch { parentBase = 1; }
  }
  let parentWeight = parentWeightIn;
  if (parentWeight == null && prevBlock) {
    parentWeight = Number(prevBlock.weight != null
      ? prevBlock.weight
      : blockWeight(prevBlock.txs || [], prevBlock.bLeaves || []));
  }
  if (parentWeight == null) parentWeight = 1;
  const baseFee = nextBaseFee(parentBase, parentWeight);
  const header = encodeHeader({
    version: VERSION,
    prevBlockHash: prev || GENESIS_PREV,
    merkleRoot: merkle,
    continuityRoot: dual.continuityRoot,
    timestamp: BigInt(now),
    bits: bits ?? GENESIS_BITS_PACKED,
    nonce: 0n,
    baseFee: BigInt(baseFee),
  });
  return {
    height,
    bits: bits ?? GENESIS_BITS_PACKED,
    header,
    merkleRoot: merkle,
    continuityRoot: dual.continuityRoot,
    rootA: dual.rootA,
    rootB: dual.rootB,
    aLeaves,
    bLeaves,
    baseFee,
    weight: blockWeight(bodyTxs, bLeaves),
    txs: bodyTxs,
    samples: Array.isArray(samples) && samples.length ? collateSamples(samples) : collated,
    shareBatch: batch,
    miner,
    poolDest: poolDest || allowedHashBonusCustodyDest(hashBonusCustodyDest) || '',
    hashBonusCustodyDest: allowedHashBonusCustodyDest(hashBonusCustodyDest) || '',
    hashCredits: freshCreditsFromShares(batch, hashBonusNanos),
  };
}

export function mineTemplate(tpl, {
  maxTries = 1_000_000,
  shareBits = 8,
  nonceStart = 0n,
  blockOnly = false,
} = {}) {
  const start = BigInt(nonceStart);
  for (let i = 0n; i < BigInt(maxTries); i += 1n) {
    const n = start + i;
    const header = setNonce(tpl.header, n);
    const hash = shearHash(header);
    if (meetsTarget(hash, tpl.bits)) {
      return { header, hash, nonce: n, block: true };
    }
    if (!blockOnly && meetsTarget(hash, shareBits)) {
      return { header, hash, nonce: n, block: false };
    }
  }
  return null;
}

export function headerHash(header) {
  return shearHash(header);
}

export const PHASE_B_GATE = true;

export function phaseBGate() {
  return {
    verifyBlockExecutesEvm: true,
    nativeFlowSend: true,
    evmSheValueTransfer: true,
    ok: true,
  };
}

export { blockNeedsEvm };

const preparedHeaderPow = new Map();

function headerPowKey(header) {
  return Buffer.from(header).toString('hex');
}

function stashPreparedHeader(header, hash) {
  preparedHeaderPow.set(headerPowKey(header), Buffer.from(hash));
}

function takePreparedHeader(header) {
  const key = headerPowKey(header);
  const found = preparedHeaderPow.get(key);
  if (!found) return null;
  preparedHeaderPow.delete(key);
  return found;
}

function dropPreparedHeader(header) {
  preparedHeaderPow.delete(headerPowKey(header));
}

function shareNonceKeys(shares, provedOnHeader) {
  return paidWorkKeys(shares, provedOnHeader);
}

/**
 * Hash the header and each share header on the worker before the sync
 * verifier runs. The sync verifier still checks targets; this only moves
 * RandomX off the accept thread. trustedPowHash is never invented here.
 * When the store supplies the grandparent header, each share is also hashed
 * against that header so a one-step deferred proof is not a sync RandomX.
 */
async function prepareOffLoopPow(block, prev, { skipSharePow = false, priorHeader = null } = {}) {
  if (!block?.header) return { ok: false, reason: 'no_header' };
  const h = Buffer.from(block.header);
  let decoded;
  try {
    decoded = decodeHeader(h);
  } catch {
    return { ok: false, reason: 'bad_header' };
  }
  if (decoded.version !== VERSION) return { ok: false, reason: 'version' };
  const wantPrev = prev?.hash ? Buffer.from(prev.hash) : GENESIS_PREV;
  if (!decoded.prevBlockHash.equals(wantPrev)) return { ok: false, reason: 'prev' };
  const shareHeaders = [];
  if (!skipSharePow && prev?.header && Array.isArray(block.shareBatch) && block.shareBatch.length) {
    let rows = [];
    try {
      rows = unpackShareBatch(block.shareBatch);
    } catch {
      rows = [];
    }
    const parent = Buffer.from(prev.header);
    let prior = null;
    if (priorHeader) {
      try {
        const raw = Buffer.isBuffer(priorHeader) ? Buffer.from(priorHeader) : Buffer.from(priorHeader);
        if (raw.length === 128) prior = raw;
      } catch { prior = null; }
    }
    for (const s of rows) {
      try {
        const nonce = BigInt(s?.nonce || 0);
        const slot = s?.proofSlot;
        if (slot === 1 || slot === '1') {
          if (prior) shareHeaders.push(setNonce(prior, nonce));
          else shareHeaders.push(setNonce(parent, nonce));
        } else if (slot === 0 || slot === '0') {
          shareHeaders.push(setNonce(parent, nonce));
        } else {
          shareHeaders.push(setNonce(parent, nonce));
          if (prior) shareHeaders.push(setNonce(prior, nonce));
        }
      } catch { /* sync verifier reports the bad row */ }
    }
  }
  const todo = [h, ...shareHeaders];
  let hashes;
  try {
    hashes = await Promise.all(todo.map((hdr) => hashHeaderOffLoop(hdr)));
  } catch {
    return { ok: false, reason: 'pow' };
  }
  stashPreparedHeader(h, hashes[0]);
  const shareKeys = [];
  for (let i = 0; i < shareHeaders.length; i += 1) {
    shareKeys.push(stashSharePow(shareHeaders[i], hashes[i + 1]));
  }
  return {
    ok: true,
    cleanup() {
      dropPreparedHeader(h);
      dropSharePowKeys(shareKeys);
    },
  };
}

function hashPaysMatch(hashVouts, pay, provenOpen, confidential) {
  if (hashVouts.length !== pay.length) return false;
  const used = new Set();
  for (const p of pay) {
    const hex = p.noteCommit.toString('hex');
    let idx = -1;
    for (let i = 0; i < hashVouts.length; i += 1) {
      if (used.has(i)) continue;
      if (ncHex(hashVouts[i].noteCommit) === hex) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return false;
    const nanos = Number(p.nanos);
    if (!Number.isSafeInteger(nanos) || nanos < 0) return false;
    const hit = hashVouts[idx];
    if (confidential) {
      if (!verifySealedNote(hit, nanos)) return false;
      if (provenOpen) provenOpen.set(hit, nanos);
    } else if (Number(hit.nanos || 0) !== nanos) {
      return false;
    }
    used.add(idx);
  }
  return used.size === hashVouts.length;
}

function leafCommitHex(leaf) {
  try {
    if (leaf?.noteCommit) {
      const b = Buffer.from(leaf.noteCommit);
      if (b.length === 32 && !b.equals(Buffer.alloc(32))) return b.toString('hex');
    }
  } catch { /* dest20 below */ }
  try {
    if (leaf?.dest20) {
      const d = Buffer.from(leaf.dest20);
      if (d.length === 20) return noteCommitOfDest20(d).toString('hex');
    }
  } catch { /* no commit */ }
  return '';
}

/**
 * Cheap share-credit bind for a block this node already accepted.
 * No ShearHash. A pruned block keeps aLeaves and drops the batch: the
 * empty batch is not a fresh-credit lie. A live batch must reproduce
 * each positive aLeaf, and the header continuity root must still match
 * the stored leaves, so a rewritten nonce byte fails closed.
 */
export function shareCreditBound(block, tipHeight = null) {
  const shares = Array.isArray(block?.shareBatch) ? block.shareBatch : [];
  if (sealedCreditsBuried(block, tipHeight) && shares.length === 0) return { ok: true, reason: '' };
  const leaves = Array.isArray(block?.aLeaves) ? block.aLeaves : [];
  let positive = false;
  for (const leaf of leaves) {
    if (Number(leaf?.count) > 0) {
      positive = true;
      break;
    }
  }
  let id = null;
  if (Buffer.isBuffer(block?.hash) && block.hash.length === 32) id = block.hash;
  else if (block?.hash instanceof Uint8Array && block.hash.length === 32) id = block.hash;
  if (!id) return { ok: false, reason: 'share_credit_bind' };
  if (shares.length === 0 && !positive) return { ok: true, reason: '' };
  const retained = retainedUnitsByCommit(shares);
  const seen = new Set();
  for (const leaf of leaves) {
    const count = Math.floor(Number(leaf?.count) || 0);
    if (count <= 0) continue;
    const hex = leafCommitHex(leaf);
    if (!hex || (retained.get(hex) || 0) !== count) return { ok: false, reason: 'share_credit_bind' };
    seen.add(hex);
  }
  for (const [hex, units] of retained) {
    if (units > 0 && !seen.has(hex)) return { ok: false, reason: 'share_credit_bind' };
  }
  if (block?.samplesPruned !== true) {
    let decoded;
    try { decoded = decodeHeader(Buffer.from(block.header)); } catch {
      return { ok: false, reason: 'share_credit_bind' };
    }
    const dual = buildDualTree({ aLeaves: leaves, bLeaves: block.bLeaves || [] });
    if (!Buffer.from(dual.continuityRoot).equals(Buffer.from(decoded.continuityRoot))) {
      return { ok: false, reason: 'share_credit_bind' };
    }
  }
  return { ok: true, reason: '' };
}

function settlementFor(prev, height, block, unit, extra = {}) {
  const shareBatch = Array.isArray(block?.shareBatch) ? block.shareBatch : (Array.isArray(block) ? block : []);
  const creditBlock = block && !Array.isArray(block) ? block : { shareBatch };
  const parent = prev?.txs?.[0] || null;
  let owedIn;
  if (extra.owedIn != null) {
    if (!hashOwedRootAgrees(parent, extra.owedIn)) return { ok: false, reason: 'hash_owed' };
    owedIn = extra.owedIn;
  } else {
    owedIn = hashOwedFromTx(parent);
  }
  const dustIn = hashDustFromTx(parent);
  const overflowIn = hashOverflowFromTx(parent);
  if (owedIn == null || dustIn == null || overflowIn == null) {
    return { ok: false, reason: 'hash_owed' };
  }
  const series = extra.hashAcceptedSeries;
  const budget = series == null ? null : hashBudgetNanos(series, unit);
  if (series != null && budget == null) return { ok: false, reason: 'hash_owed' };
  const gotFresh = freshForBlock(creditBlock, unit, extra.tipHeight);
  if (!gotFresh.ok) return { ok: false, reason: 'hash_owed' };
  const fresh = gotFresh.fresh;
  const settled = settleHashOwed({
    owedIn,
    dustIn,
    overflowIn,
    fresh,
    height,
    unit,
    budget,
  });
  if (!settled.ok) return { ok: false, reason: settled.reason || 'hash_owed' };
  // owedIn is the combined map, including rows that were packed in hashOwedRest.
  // A ledger that only looks empty inline is not idle and must not mint a finder floor.
  const parentIdle = owedIn.length === 0 && dustIn === 0n && overflowIn === 0n;
  const idle = parentIdle && hashLedgerIdle(settled, fresh.length);
  return { ...settled, idle };
}

function verifyBlockConsensus(block, prev, opts = {}) {
  if (opts.offLoopPow && !opts.trustedPowHash) {
    return prepareOffLoopPow(block, prev, {
      skipSharePow: !!opts.skipSharePow,
      priorHeader: opts.grandparentHeader || null,
    }).then((ready) => {
      if (!ready.ok) return ready;
      let result;
      try {
        result = verifyBlockConsensus(block, prev, { ...opts, offLoopPow: false });
      } catch (err) {
        ready.cleanup?.();
        throw err;
      }
      if (result && typeof result.then === 'function') {
        return result.then((out) => {
          ready.cleanup?.();
          return out;
        }, (err) => {
          ready.cleanup?.();
          throw err;
        });
      }
      ready.cleanup?.();
      return result;
    });
  }
  const {
    buried = false,
    spentB = null,
    tipHeight = 0,
    hashBonusNanos = HASH_BONUS_NANOS,
    spendableOf = null,
    mtpTimestamps = null,
    nowMs = null,
    committedBps = null,
    reserveState = null,
    poolDest = null,
    seenDigests = null,
    evmSession = null,
    evmHistory = null,
    trustedPowHash = null,
    skipSharePow = false,
    parentFluxset = null,
    parentSpendTags = null,
    genesisMs = 0,
    magic = MAGIC_TESTNET,
  } = opts;
  if (!block?.header) return { ok: false, reason: 'no_header' };
  const h = Buffer.from(block.header);
  let decoded;
  try {
    decoded = decodeHeader(h);
  } catch (e) {
    return { ok: false, reason: 'bad_header' };
  }
  if (decoded.version !== VERSION) return { ok: false, reason: 'version' };
  const wantPrev = prev?.hash ? Buffer.from(prev.hash) : GENESIS_PREV;
  if (!decoded.prevBlockHash.equals(wantPrev)) return { ok: false, reason: 'prev' };
  // Local pool already hashed this header off-thread and passes trustedPowHash.
  // P2P omits that field. It stashes a worker ShearHash, then this branch
  // still checks the target. A missing stash hashes here (local mine / tests).
  let hash;
  if (opts.probeBody === true) {
    // In-process template probe. store.append never sets this, and the
    // stand-in is not block work. Every other check still runs.
    hash = Buffer.alloc(32);
  } else if (trustedPowHash) {
    hash = Buffer.from(trustedPowHash);
    if (hash.length !== 32 || !meetsTarget(hash, decoded.bits)) {
      return { ok: false, reason: 'pow' };
    }
  } else {
    const prepared = takePreparedHeader(h);
    hash = prepared || shearHash(h);
    if (!meetsTarget(hash, decoded.bits)) return { ok: false, reason: 'pow' };
  }
  const txs = Array.isArray(block.txs) ? block.txs : [];
  if (!txs.length || !txs[0]?.coinbase) return { ok: false, reason: 'coinbase' };
  const merkle = merkleRoot(txs.map(digestTx));
  if (!merkle.equals(decoded.merkleRoot)) return { ok: false, reason: 'merkle' };
  let resolvedGenesisMs = 0;
  if (prev?.header) {
    let parent;
    try {
      parent = decodeHeader(Buffer.from(prev.header));
    } catch {
      return { ok: false, reason: 'parent_header' };
    }
    // Genesis-anchored aserti3-2d. The child stamp is the block time.
    // Parent bits are not the anchor, so an emergency ease does not stick.
    // A closed-book historical header may skip this check. v12 does not.
    const ts = Number(decoded.timestamp);
    const parentTs = Number(parent.timestamp);
    const parentIsGenesis = parent.prevBlockHash.equals(GENESIS_PREV);
    resolvedGenesisMs = parentIsGenesis ? parentTs : Number(genesisMs);
    if (!Number.isFinite(resolvedGenesisMs) || resolvedGenesisMs <= 0) {
      return { ok: false, reason: 'genesis_ms' };
    }
    const heightNow = Number(block.height || (Number(prev.height) || 0) + 1);
    const quote = asertNextBits({
      anchorBits: parentIsGenesis ? parent.bits : GENESIS_BITS_PACKED,
      anchorTimeMs: resolvedGenesisMs,
      anchorHeight: parentIsGenesis ? Number(prev.height || 1) : 1,
      blockTimeMs: ts,
      blockHeight: heightNow,
      parentTimeMs: parentTs,
    });
    const closedBook = String(magic) !== MAGIC_TESTNET_V12 && String(magic) !== MAGIC_MAINNET;
    if ((!quote.ok || !bitsAcceptAsert(decoded.bits, quote)) && !(closedBook && isHistoricalHeader(h))) {
      return { ok: false, reason: 'bits' };
    }
    if (!isPackedBits(decoded.bits)) return { ok: false, reason: 'bits' };
    const fp = unpackBits(decoded.bits);
    if (fp < LIVE_MIN_BITS || fp > MAX_BITS) return { ok: false, reason: 'bits' };
    const pWeight = Number(prev.weight != null
      ? prev.weight
      : blockWeight(prev.txs || [], prev.bLeaves || []));
    const wantBase = nextBaseFee(Number(parent.baseFee || 1n), pWeight);
    if (Number(decoded.baseFee) !== wantBase) return { ok: false, reason: 'base_fee' };
    if (!(ts > parentTs)) return { ok: false, reason: 'timestamp' };
    const window = Array.isArray(mtpTimestamps) && mtpTimestamps.length
      ? mtpTimestamps.slice(-MTP_WINDOW)
      : [parentTs];
    const mtp = medianTimePast(window);
    if (ts > mtp + MTP_FUTURE_MS) return { ok: false, reason: 'timestamp' };
    if (nowMs != null && Number.isFinite(Number(nowMs)) && ts > Number(nowMs) + HEADER_AHEAD_MS) {
      return { ok: false, reason: 'timestamp' };
    }
    if (nowMs != null && Number.isFinite(Number(nowMs)) && ts > Number(nowMs) + MTP_FUTURE_MS) {
      return { ok: false, reason: 'timestamp' };
    }
  } else {
    if (decoded.bits !== GENESIS_BITS_PACKED || !isPackedBits(decoded.bits)) {
      return { ok: false, reason: 'bits' };
    }
    if (Number(decoded.baseFee) < 1) return { ok: false, reason: 'base_fee' };
    resolvedGenesisMs = Number(decoded.timestamp);
  }
  if (!Number.isFinite(resolvedGenesisMs) || resolvedGenesisMs <= 0) {
    return { ok: false, reason: 'genesis_ms' };
  }
  const wantPot = potSubsidyAt({
    nowMs: Number(decoded.timestamp) || Number(nowMs) || 0,
    genesisMs: resolvedGenesisMs,
    magic,
  });
  // Empty rounds carry the unminted pot. The next block's outputs plus its
  // own carry must equal this subsidy plus the parent carry. Paying the pot
  // and carrying it would mint twice. Dropping it mints nothing.
  const carryOut = canonicalCarry(txs[0]);
  const carryIn = prev?.txs?.[0] ? canonicalCarry(prev.txs[0]) : 0;
  if (carryOut == null || carryIn == null || !Number.isSafeInteger(wantPot) || wantPot < 0) {
    return { ok: false, reason: 'pot_sched' };
  }
  const payablePot = wantPot + carryIn;
  const mintedPot = payablePot - carryOut;
  if (!Number.isSafeInteger(payablePot) || !Number.isSafeInteger(mintedPot) || mintedPot < 0) {
    return { ok: false, reason: 'pot_sched' };
  }
  const samples = collateSamples(
    Array.isArray(block.samples) ? block.samples : (txs[0].samples || []),
  );
  const shareBatchEarly = Array.isArray(block.shareBatch) ? block.shareBatch : [];
  if (!block.samplesPruned && !shareBatchEarly.length && sampleCapExceeded(samples, decoded.bits)) {
    return { ok: false, reason: 'sample_cap' };
  }
  const cbVouts = txs[0].vout || [];
  const confidential = cbVouts.some((o) => o.commit);
  const potVouts = cbVouts.filter((o) => o.kind !== 'hash' && o.kind !== 'finder-fee' && o.kind !== 'reserve-fee');
  const hashVouts = cbVouts.filter((o) => o.kind === 'hash');
  let potNanos = 0;
  let bonusNanos = 0;
  const height = Number(block.height || (prev?.height || 0) + 1);
  // Burial is only the parent this caller already accepted. opts.tipHeight is
  // a peer advertisement and must not open skipFlow, sample prune, or pre_seal.
  const localTip = Number(prev?.height || 0);
  void tipHeight;
  void buried;
  // A peer flag does not prune. Burial is this parent's height, not opts.tipHeight.
  if (block.samplesPruned && !shouldPruneSamples(height, localTip)) {
    return { ok: false, reason: 'samples_pruned' };
  }
  const skipFlow = flowSkipAllowed({ height, samplesPruned: block.samplesPruned }, localTip);
  const shareBatch = Array.isArray(block.shareBatch) ? block.shareBatch : [];
  // Burial may skip Flow checks. It does not skip share credit. A batch that
  // is still on the block takes the same nonce-byte gate as a live accept.
  if (skipFlow && shareBatch.length) {
    if (shareBatch.length > MAX_SHARES_PER_BLOCK) return { ok: false, reason: 'share_cap' };
    if (!prev?.header) return { ok: false, reason: 'share_batch' };
    const buriedShares = verifyShareBatch({
      parentHeader: prev.header,
      priorHeader: opts.grandparentHeader || null,
      excludeNonces: shareNonceKeys(prev?.shareBatch, opts.grandparentHeader || null),
      shares: shareBatch,
      floorBits: SHARE_FLOOR_BITS,
      skipPow: !!skipSharePow,
    });
    if (!buriedShares.ok) return buriedShares;
  }
  const payAddr = (a) => a;
  const liveUnit = hashBonusUnitNanos(hashBonusNanos);
  let provenUnits = 0;
  let provenByDest = new Map();
  let shareLeaves = null;
  // Amounts the coinbase rule already opened. A published valueProof.v
  // that is missing or wrong does not replace these.
  const provenOpen = new Map();
  if (!skipFlow) {
    if (shareBatch.length > MAX_SHARES_PER_BLOCK) return { ok: false, reason: 'share_cap' };
    if (prev?.header) {
      const proved = verifyShareBatch({
        parentHeader: prev.header,
        priorHeader: opts.grandparentHeader || null,
        excludeNonces: shareNonceKeys(prev?.shareBatch, opts.grandparentHeader || null),
        shares: shareBatch,
        floorBits: SHARE_FLOOR_BITS,
        skipPow: !!skipSharePow,
      });
      if (!proved.ok) return proved;
      provenUnits = proved.units;
      provenByDest = proved.byDest;
      shareLeaves = proved.aLeaves;
    } else if (shareBatch.length) {
      return { ok: false, reason: 'share_batch' };
    }
    const settlement = settlementFor(prev, height, block, liveUnit, {
      owedIn: opts.owedIn,
      hashAcceptedSeries: opts.hashAcceptedSeries,
      tipHeight: localTip,
    });
    if (!settlement.ok) return { ok: false, reason: settlement.reason || 'hash_owed' };
    if (!sameHashLedger(txs[0], settlement)) return { ok: false, reason: 'hash_owed' };
    if (confidential) {
      const sealedLeaves = Array.isArray(block.aLeaves) ? block.aLeaves : [];
      const fromSealed = sealedLeaves.map((l) => {
        const d20 = l.dest20 ? Buffer.from(l.dest20) : Buffer.alloc(20);
        let nc = l.noteCommit ? Buffer.from(l.noteCommit) : null;
        if (!nc || nc.length !== 32) nc = noteCommitOfDest20(d20);
        return { ...l, dest20: d20, noteCommit: nc, count: Number(l.count) || 1 };
      });
      const leaves = (shareLeaves && shareLeaves.length)
        ? shareLeaves
        : (shareBatch.length && fromSealed.length ? fromSealed : aLeavesFromShares(shareBatch));
      const hasherNcs = new Set(leaves.map((l) => ncHex(l.noteCommit)));
      const hinted = (poolDest && isDestAddress(poolDest))
        ? poolDest
        : (block.poolDest && isDestAddress(block.poolDest)
          ? block.poolDest
          : (block.miner && isDestAddress(block.miner) ? block.miner : ''));
      // A proven batch pays hasher leaves and one pro-rata pot. Custodial
      // shapes are not an accept, and a node-local env var cannot make them one.
      if (settlement.idle && !shareBatch.length) {
        const floor = unitsForShare() * liveUnit;
        const minerDest = block.miner && isDestAddress(block.miner) ? block.miner : '';
        const minerNc = minerDest ? ncHex(noteCommitOfDest20(hash20FromAddress(minerDest))) : '';
        if (hashVouts.length === 0) {
          bonusNanos = 0;
        } else if (hashVouts.length === 1 && verifySealedNote(hashVouts[0], floor)) {
          const hashNc = ncHex(hashVouts[0].noteCommit);
          let voutNc = '';
          try {
            const d20 = hashVouts[0].dest20 ? Buffer.from(hashVouts[0].dest20) : null;
            if (d20 && d20.length === 20) voutNc = ncHex(noteCommitOfDest20(d20));
          } catch { /* ignore */ }
          // Finder-floor hash, if present, is the miner dest — never the pool fee dest.
          if (!((voutNc && hashNc === voutNc) || (minerNc && hashNc === minerNc))) {
            return { ok: false, reason: 'hash_bonus' };
          }
          bonusNanos = floor;
        } else {
          return { ok: false, reason: 'hash_bonus' };
        }
        potNanos = mintedPot;
        const T = mintedPot + bonusNanos;
        if (!mintWithLevy(cbVouts, T, txs[0].excess)) return { ok: false, reason: 'pot' };
      } else {
      if (!hashPaysMatch(hashVouts, settlement.pay, provenOpen, true)) {
        return { ok: false, reason: 'hash_owed' };
      }
      bonusNanos = Number(settlement.minted);
      if (!Number.isSafeInteger(bonusNanos) || bonusNanos < 0) {
        return { ok: false, reason: 'hash_owed' };
      }
      if (hasherNcs.size) {
        const extra = potVouts.filter((o) => !hasherNcs.has(ncHex(o.noteCommit)));
        for (const o of extra) {
          if (verifySealedNote(o, mintedPot)) {
            return { ok: false, reason: 'pot_prop' };
          }
        }
        // Fee is a bps of this subsidy only. Carry is miner money and is not
        // a fee base. Hasher notes are one split of the minted pot minus that
        // subsidy fee, so a last-row carry dump does not pass.
        const extraAmt = extraPotFeeNanos(extra, wantPot);
        if (extraAmt == null) return { ok: false, reason: 'pot_prop' };
        const candidates = propPayCandidates(leaves, wantPot, hinted, extraAmt, shareBatch, mintedPot);
        let matched = false;
        let matchedPays = null;
        for (const pays of candidates) {
          let okTry = true;
          for (const pay of pays) {
            const hit = potVouts.find((o) => ncHex(o.noteCommit) === ncHex(pay.noteCommit));
            if (!hit || !verifySealedNote(hit, pay.nanos)) {
              okTry = false;
              break;
            }
          }
          if (!okTry) continue;
          const extraOk = extra.length === 0
            || (extra.length === 1 && verifySealedNote(extra[0], extraAmt));
          if (!extraOk) continue;
          const covered = new Set(pays.map((p) => ncHex(p.noteCommit)));
          if (extra.length === 1) covered.add(ncHex(extra[0].noteCommit));
          if (potVouts.some((o) => !covered.has(ncHex(o.noteCommit)))) continue;
          matched = true;
          matchedPays = pays;
          break;
        }
        if (!matched) return { ok: false, reason: 'pot_prop' };
        for (const pay of matchedPays) {
          const hit = potVouts.find((o) => ncHex(o.noteCommit) === ncHex(pay.noteCommit));
          if (hit) provenOpen.set(hit, pay.nanos);
        }
        if (extra.length === 1) provenOpen.set(extra[0], extraAmt);
      }
      const T = mintedPot + bonusNanos;
      if (!mintWithLevy(cbVouts, T, txs[0].excess)) return { ok: false, reason: 'pot' };
      potNanos = mintedPot;
      }
    } else {
      potNanos = potVouts.reduce((a, o) => a + Number(o.nanos || 0), 0);
      if (potNanos + carryOut !== payablePot) return { ok: false, reason: 'pot_sched' };
      if (settlement.idle && !shareBatch.length) {
        const floorFinder = unitsForShare() * liveUnit;
        bonusNanos = hashVouts.reduce((a, o) => a + Number(o.nanos || 0), 0);
        if (bonusNanos !== 0 && bonusNanos !== floorFinder) return { ok: false, reason: 'hash_bonus' };
      } else if (!hashPaysMatch(hashVouts, settlement.pay, null, false)) {
        return { ok: false, reason: 'hash_owed' };
      } else {
        bonusNanos = Number(settlement.minted);
        if (!Number.isSafeInteger(bonusNanos) || bonusNanos < 0) {
          return { ok: false, reason: 'hash_owed' };
        }
      }
      const maxFee = Math.floor(wantPot * POOL_FEE_MAX_BPS / 10000);
      const hasherSet = new Set(provenByDest.keys());
      if (hasherSet.size) {
        const extra = potVouts.filter((o) => !hasherSet.has(o.address));
        const extraNanos = extra.reduce((a, o) => a + Number(o.nanos || 0), 0);
        if (extraNanos > maxFee) return { ok: false, reason: 'pot_prop' };
        if (mintedPot > 0 && extraNanos === mintedPot) return { ok: false, reason: 'pot_prop' };
      }
    }
  }
  if (skipFlow) {
    const buriedSettle = settlementFor(prev, height, block, liveUnit, {
      owedIn: opts.owedIn,
      hashAcceptedSeries: opts.hashAcceptedSeries,
      tipHeight: localTip,
    });
    if (!buriedSettle.ok) return { ok: false, reason: buriedSettle.reason || 'hash_owed' };
    if (!sameHashLedger(txs[0], buriedSettle)) return { ok: false, reason: 'hash_owed' };
    if (!buriedSettle.idle) {
      const minted = Number(buriedSettle.minted);
      if (!Number.isSafeInteger(minted) || minted < 0) return { ok: false, reason: 'hash_owed' };
      if (!hashPaysMatch(hashVouts, buriedSettle.pay, provenOpen, confidential)) {
        return { ok: false, reason: 'hash_owed' };
      }
      bonusNanos = minted;
    }
    const coinbase = txs[0];
    if (!coinbase || !Array.isArray(coinbase.vout) || (coinbase.vout.length === 0 && carryOut <= 0 && buriedSettle.owed.length === 0)) {
      return { ok: false, reason: 'pot' };
    }
  }
  const boundCb = coinbaseVoutsBound(cbVouts, txs[0].excess, (o) => (
    provenOpen.has(o) ? provenOpen.get(o) : null
  ));
  if (!boundCb.ok) return boundCb;
  let potOpenedSum = 0;
  for (const o of cbVouts) {
    if (o.kind === 'hash' || o.kind === 'finder-fee' || o.kind === 'reserve-fee') continue;
    if (provenOpen.has(o)) potOpenedSum += Number(provenOpen.get(o));
    else if (o?.valueProof?.v != null && o.valueProof.v !== '') potOpenedSum += Number(o.valueProof.v);
    else potOpenedSum += Number(o.nanos || 0);
  }
  if (!Number.isSafeInteger(potOpenedSum) || potOpenedSum < 0) return { ok: false, reason: 'pot_sched' };
  // A proven share batch must pay this round, including anything carried in.
  // An empty batch may carry the miner pot. The only note that may sit beside
  // that carry is a pool-fee at or under POOL_FEE_MAX_BPS of this subsidy.
  // A pot note, or a fee above that cap, is a skim.
  if (shareBatch.length > 0 && carryOut !== 0) return { ok: false, reason: 'pot_carry' };
  if (!shareBatch.length && carryOut !== 0 && potOpenedSum !== 0) {
    const feeCap = Math.floor(wantPot * POOL_FEE_MAX_BPS / 10000);
    let feeOpened = 0;
    let feeOnly = true;
    for (const o of cbVouts) {
      if (o.kind === 'hash' || o.kind === 'finder-fee' || o.kind === 'reserve-fee') continue;
      const v = Math.floor(Number(o.valueProof?.v) || 0);
      if (o.kind !== 'pool-fee' || !(v > 0)) {
        feeOnly = false;
        break;
      }
      feeOpened += v;
    }
    if (!feeOnly || feeOpened !== potOpenedSum || feeOpened > feeCap) {
      return { ok: false, reason: 'pot_carry' };
    }
  }
  if (potOpenedSum + carryOut !== payablePot) return { ok: false, reason: 'pot_sched' };
  const aLeaves = (shareLeaves && shareLeaves.length)
    ? shareLeaves
    : (shareBatch.length && Array.isArray(block.aLeaves) && block.aLeaves.length
      ? block.aLeaves.map((l) => {
        const d20 = Buffer.from(l.dest20);
        const nc = l.noteCommit && Buffer.from(l.noteCommit).length === 32
          ? Buffer.from(l.noteCommit)
          : noteCommitOfDest20(d20);
        return { dest20: d20, count: Number(l.count) || 1, noteCommit: nc };
      })
      : (shareLeaves || []));
  if (!skipFlow && Array.isArray(shareLeaves)) {
    const have = new Map(aLeaves.map((l) => [
      Buffer.from(l.noteCommit || l.dest20).toString('hex'),
      Number(l.count),
    ]));
    for (const leaf of shareLeaves) {
      const key = Buffer.from(leaf.noteCommit || leaf.dest20).toString('hex');
      if (have.get(key) !== leaf.count) return { ok: false, reason: 'hash_bonus' };
    }
  }
  const bLeaves = Array.isArray(block.bLeaves)
    ? block.bLeaves.map((l) => ({
      dest20: Buffer.from(l.dest20),
      unit: Number(l.unit || 0),
      nonce: Number(l.nonce || 0),
      memoH: l.memoH ? Buffer.from(l.memoH) : Buffer.alloc(32),
      tag: String(l.tag || ''),
    }))
    : bLeavesOf(txs.slice(1), payAddr);
  if (!skipFlow) {
    const dual = buildDualTree({ aLeaves, bLeaves });
    if (!dual.continuityRoot.equals(decoded.continuityRoot)) return { ok: false, reason: 'continuity' };
  }
  for (const o of txs[0].vout) {
    if (o.commit && o.noteCommit && !o.address) continue;
    const r = checkAddressField(o.address, { allowEmpty: false });
    if (!r.ok) {
      if (r.reason === 'silent_id_on_chain') return { ok: false, reason: 'silent_id_on_chain' };
      if (r.reason === 'rest_frame_on_chain') return { ok: false, reason: 'rest_frame_on_chain' };
      return { ok: false, reason: r.reason === 'dest' ? 'miner_addr' : r.reason };
    }
  }
  if (block.miner) {
    const minerHrp = checkAddressField(block.miner, { allowEmpty: true });
    if (!minerHrp.ok) return { ok: false, reason: minerHrp.reason };
  }
  for (const s of samples) {
    for (const a of [s?.miner, s?.address, s?.dest]) {
      if (!a) continue;
      const sr = checkAddressField(a, { allowEmpty: true });
      if (!sr.ok) return { ok: false, reason: sr.reason };
    }
  }
  const base = Number(decoded.baseFee || 1n);
  let fees = 0;
  const spent = spentB instanceof Set ? spentB : new Set(spentB || []);
  // A live parent fluxset already has every earlier height. Do not walk the
  // chain again. Rebuild only when this block has no parent state.
  const haveLive = parentFluxset && !Array.isArray(parentFluxset) && Array.isArray(parentFluxset.pubs);
  let live;
  if (haveLive) {
    live = parentFluxset;
  } else {
    const history = Array.isArray(evmHistory) && evmHistory.length ? evmHistory : (prev ? [prev] : []);
    const rebuilt = fluxsetFromBlocks(history);
    live = Array.isArray(parentFluxset)
      ? {
          pubs: parentFluxset,
          commits: rebuilt.commits,
          spendTags: parentSpendTags instanceof Set ? parentSpendTags : new Set(parentSpendTags || rebuilt.spendTags || []),
          jroot: rebuilt.jroot,
        }
      : rebuilt;
  }
  const pubs = (live.pubs || []).slice();
  const commits = (live.commits || []).slice();
  const spentTags = new Set(live.spendTags || []);
  const pushPub = (o) => {
    if (!o?.admitPub || !o?.commit) return;
    try {
      pubs.push(typeof o.admitPub.toBytes === 'function' ? o.admitPub : pointFrom(o.admitPub));
      commits.push(Buffer.from(asU8(o.commit)));
    } catch { /* skip */ }
  };
  const body = txs.slice(1);
  for (let i = 0; i < body.length; i += 1) {
    const tx = body[i];
    const outs = Array.isArray(tx.vout) ? tx.vout : [];
    const fields = checkTxAddressFields(tx, { coinbase: false });
    if (!fields.ok) {
      if (fields.reason === 'silent_id_on_chain') return { ok: false, reason: 'silent_id_on_chain' };
      if (fields.reason === 'rest_frame_on_chain') return { ok: false, reason: 'rest_frame_on_chain' };
      return { ok: false, reason: fields.reason };
    }
    for (const o of outs) {
      if (o?.address) {
        const r = checkAddressField(o.address, { allowEmpty: String(tx.kind || o.kind || '') === 'burn' });
        if (!r.ok) return { ok: false, reason: r.reason };
      }
    }
    const ins = Array.isArray(tx.vin) ? tx.vin : [];
    for (const i of ins) {
      const link = sealedVinLinkField(i);
      if (link) return { ok: false, reason: 'vin_link' };
      if (i?.address) {
        const r = checkAddressField(i.address, { allowEmpty: false });
        if (!r.ok) return { ok: false, reason: r.reason };
      }
    }
    const unfunded = !Array.isArray(tx.vin) || tx.vin.length === 0 || tx.mint;
    if (wrapMintForbidden(tx)) {
      return { ok: false, reason: 'mint_forbidden' };
    }
    if (String(tx.programId || '') === JOIN_PROGRAM || String(tx.kind || '') === JOIN_KIND_GENESIS) {
      return { ok: false, reason: 'join_removed' };
    }
    if ((unfunded || tx.mint) && !extraMintAllowed(tx.programId, { kind: tx.kind })) {
      return { ok: false, reason: 'mint_forbidden' };
    }
    if (flowNeedsDummy(tx)) {
      const boundIns = flowInputsBound(tx);
      if (!boundIns.ok) return boundIns;
    }
    if (flowNeedsDummy(tx) && dummyCount(tx) < 1) {
      return { ok: false, reason: 'dummy_outs' };
    }
    if (moneyNeedsRange(tx)) {
      for (const o of (tx.vout || [])) {
        if (!o?.commit || !o.rangeProof || o.rangeProof === true) {
          return { ok: false, reason: 'range_proof' };
        }
        if (!verifyRange(o.commit, o.rangeProof)) return { ok: false, reason: 'range_proof' };
      }
    }
    const stake = boundReserveWithdraw(tx, reserveState);
    if (!stake.ok) return stake;
    if (flowNeedsDummy(tx)) {
      const dummies = (tx.vout || []).filter((o) => String(o.kind || '') === 'dummy');
      if (!dummies.every((o) => verifySealedNote(o, 0))) return { ok: false, reason: 'dummy_outs' };
      if (!verifyFlowConservation(tx)) return { ok: false, reason: 'commit_sum' };
      const multi = Array.isArray(tx.admit_proofs) && tx.admit_proofs.length > 1;
      if (!multi) {
      const proof = tx.admit_proof;
      if (!proof) return { ok: false, reason: 'admit_membership' };
      const tag = proof.spendTag || tx.spendTag;
      if (!tag) return { ok: false, reason: 'admit_membership' };
      const cTilde = proof.cTilde;
      const liveJ = { pubs, commits, jroot: live.jroot };
      if (!admit_verify(proof, liveJ, { cTilde, spendTag: tag, jroot: live.jroot })) {
        return { ok: false, reason: 'admit_membership' };
      }
      const th = Buffer.from(asU8(tag)).toString('hex');
      if (spentTags.has(th)) return { ok: false, reason: 'admit_link_tag' };
      spentTags.add(th);
      } else {
      const vins = (tx.vin || []).filter((v) => v && !v.coinbase);
      if (tx.admit_proofs.length !== vins.length) return { ok: false, reason: 'admit_membership' };
      const liveJ = { pubs, commits, jroot: live.jroot };
      const items = [];
      for (let pi = 0; pi < tx.admit_proofs.length; pi++) {
        const proof = tx.admit_proofs[pi];
        if (!proof) return { ok: false, reason: 'admit_membership' };
        const tag = proof.spendTag;
        if (!tag) return { ok: false, reason: 'admit_membership' };
        const cTilde = proof.cTilde;
        if (!cTilde || !vins[pi]?.commit) return { ok: false, reason: 'admit_membership' };
        const posted = Buffer.from(asU8(vins[pi].commit));
        const want = Buffer.from(asU8(cTilde));
        if (posted.length !== want.length || !posted.equals(want)) {
          return { ok: false, reason: 'admit_membership' };
        }
        items.push({ proof: proof.blob || proof.proof || proof, cTilde, spendTag: tag });
        const th = Buffer.from(asU8(tag)).toString('hex');
        if (spentTags.has(th)) return { ok: false, reason: 'admit_link_tag' };
        spentTags.add(th);
      }
      if (!admitVerifyBatch(items, liveJ, { jroot: live.jroot })) {
        return { ok: false, reason: 'admit_membership' };
      }
      }
    }
    for (const o of outs) pushPub(o);
    if ((unfunded || tx.mint) && String(tx.programId || '') === RESERVE_PROGRAM && String(tx.kind || '') === 'withdraw') {
      const bps = Number(committedBps ?? reserveState?.epochBps ?? GENESIS_BPS);
      const dest = String(tx.from || tx.vin?.[0]?.address || '');
      const portals = reserveState?.portals || {};
      const pid = String(tx.portalId || '').toLowerCase();
      const portal = (pid && portals[pid])
        || (dest && (portals[dest] || portals[portalIdFromDest(dest)]))
        || null;
      if (!portal) return { ok: false, reason: 'mint_amount' };
      const staked = Number(portal.staked || 0);
      const idle = Number(portal.idle || 0);
      const principal = staked + idle;
      const want = principal + interestNanos(staked, bps);
      const o = tx.vout?.[0];
      const claimed = o?.valueProof?.v != null ? Number(o.valueProof.v) : Number(o?.nanos ?? tx.nanos ?? 0);
      const got = o?.commit
        ? (verifySealedNote(o, want) ? want : -1)
        : claimed;
      if (got !== want) return { ok: false, reason: 'mint_amount' };
    }
    if (containsShe1(tx)) return { ok: false, reason: 'she1_on_chain' };
    const bound = verifyPoolWithdrawBound(tx);
    if (!bound.ok) return bound;
    const taxed = levyTaxed(tx);
    const need = levyNeed(tx, body.slice(0, i));
    const paid = Math.floor(Number(tx.fee || 0));
    if (paid < need) return { ok: false, reason: 'levy' };
    if (taxed && paid > LEVY_CAP_NANOS) return { ok: false, reason: 'levy' };
    if (taxed && tx.maxLevy != null && need > Number(tx.maxLevy)) {
      return { ok: false, reason: 'max_levy' };
    }
    fees += paid;
    if (String(tx.kind || '') === 'vortice-register') {
      const gate = gateVorticeRegister(tx);
      if (!gate.ok) return { ok: false, reason: gate.reason || 'vortice_register' };
    }
    if (tx.kind === 'b-spend') {
      const commitH = Number(tx.commitHeight || 0);
      const tip = localTip + 1;
      if (!(commitH >= 1) || tip < commitH) return { ok: false, reason: 'pre_seal' };
      const samePrev = commitH === Number(prev?.height || 0);
      const commitHeader = tx.commitHeader || (samePrev ? prev.header : null);
      const commitRootA = tx.commitRootA || (samePrev ? prev.rootA : null);
      const commitRootB = tx.commitRootB || (samePrev ? prev.rootB : null);
      if (!commitHeader) return { ok: false, reason: 'pre_seal' };
      const got = spendB({
        leaf: tx.leaf || {
          dest20: dest20Of(tx.to || outs[0]?.address || ''),
          unit: Number(tx.unit || tx.nanos || 0),
          nonce: Number(tx.nonce || 0),
          memoH: tx.memoH || Buffer.alloc(32),
          tag: tx.tag || 'b-spend',
        },
        proof: tx.proof || [],
        header: commitHeader,
        rootA: commitRootA,
        rootB: commitRootB,
        height: commitH,
        index: Number(tx.index || 0),
        tipHeight: tip,
        spent,
      });
      if (!got.ok) return got;
    }
  }
  if (typeof spendableOf === 'function') {
    const funded = verifyFundedBody(body, spendableOf, { seenDigests });
    if (!funded.ok) return funded;
  }
  const split = splitLevy(fees);
  const levyPaid = (kind, want) => {
    const rows = txs[0].vout.filter((v) => v.kind === kind);
    if (want === 0) return rows.length === 0 ? 0 : -1;
    let sum = 0;
    for (const o of rows) {
      const v = openedCoinbaseNanos(o);
      if (v == null) return -1;
      sum += v;
    }
    return sum === want ? sum : -1;
  };
  const finderPaid = levyPaid('finder-fee', split.finder);
  const reservePaid = levyPaid('reserve-fee', split.reserve);
  if (finderPaid !== split.finder || reservePaid !== split.reserve) return { ok: false, reason: 'levy_split' };
  const finalPubs = live.pubs.slice();
  for (const tx of txs) {
    for (const o of tx.vout || []) {
      if (!o?.admitPub) continue;
      try {
        finalPubs.push(typeof o.admitPub.toBytes === 'function' ? o.admitPub : pointFrom(o.admitPub));
      } catch { /* skip */ }
    }
  }
  const wantRoot = Buffer.from(jrootOf(finalPubs));
  const gotRoot = txs[0].jroot;
  if (gotRoot && !Buffer.from(asU8(gotRoot)).equals(wantRoot)) {
    return { ok: false, reason: 'admit_membership' };
  }
  return { ok: true, hash, decoded, aLeaves, bLeaves, jroot: wantRoot };
}

function headerTimeMs(block) {
  try {
    return Number(decodeHeader(Buffer.from(block.header)).timestamp);
  } catch {
    return Date.now();
  }
}

async function verifyBlockEvm(consensus, block, opts = {}) {
  let session = opts.evmSession;
  let fresh = false;
  try {
    if (!session) {
      session = await bootReserveEvm();
      fresh = true;
    }
  } catch (e) {
    return { ok: false, reason: 'evm', error: String(e?.message || e) };
  }
  if (fresh && Array.isArray(opts.evmHistory)) {
    for (const b of opts.evmHistory) {
      if (!blockNeedsEvm(b?.txs || [])) continue;
      const replayed = await executeBlockEvm(session, b.txs, headerTimeMs(b));
      if (!replayed.ok) {
        return { ok: false, reason: 'evm', error: `replay:${replayed.reason}` };
      }
    }
  }
  const nowMs = opts.nowMs != null ? opts.nowMs : headerTimeMs(block);
  const ran = await executeBlockEvm(session, block.txs || [], nowMs);
  if (!ran.ok) return { ok: false, reason: 'evm', error: ran.reason };
  return {
    ...consensus,
    evmRan: ran.calls > 0,
    evm: ran,
    evmSession: session,
  };
}

function asBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v == null) return Buffer.alloc(0);
  try { return Buffer.from(v); } catch { return Buffer.alloc(0); }
}

/** sha256 over each block's header and stored hash. Not a MAC.
 *  persist and a successful foreign verify write it. writeChainBin does not.
 */
export function chainLoadSeal(blocks) {
  const h = createHash('sha256');
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const header = asBuf(b?.header);
    const hash = asBuf(b?.hash);
    const n = Buffer.alloc(8);
    n.writeUInt32LE(header.length >>> 0, 0);
    n.writeUInt32LE(hash.length >>> 0, 4);
    h.update(n);
    h.update(header);
    h.update(hash);
  }
  return h.digest('hex');
}

/**
 * Load check for a chain.bin or latest.bin this store did not seal.
 * Empty passes. Does not call verifyBlock: a pruned body is not a live accept.
 * Prev is compared before ShearHash so a flipped prev byte is `prev`.
 * trustStoredHash skips ShearHash when book.seal already binds header||hash.
 * Merkle, linkage, bits, and the coinbase still run on that path.
 */
export function verifyLoadedChain(blocks, { trustStoredHash = false } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (!list.length) return { ok: true };
  let prevLink = GENESIS_PREV;
  let prevDecoded = null;
  let prevHeight = 0;
  let genesisMs = 0;
  for (let i = 0; i < list.length; i += 1) {
    const block = list[i];
    const header = asBuf(block?.header);
    if (!block?.header || header.length === 0) return { ok: false, reason: 'no_header' };
    let decoded;
    try {
      decoded = decodeHeader(header);
    } catch {
      return { ok: false, reason: 'bad_header' };
    }
    if (!decoded.prevBlockHash.equals(prevLink)) return { ok: false, reason: 'prev' };
    const height = Number(block.height);
    if (height !== i + 1) return { ok: false, reason: 'height' };
    const ts = Number(decoded.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: 'timestamp' };
    if (prevDecoded && !(ts > Number(prevDecoded.timestamp))) return { ok: false, reason: 'timestamp' };
    const stored = asBuf(block.hash);
    if (stored.length !== 32) return { ok: false, reason: 'pow' };
    let link = stored;
    if (!trustStoredHash) {
      const hash = shearHash(header);
      if (!meetsTarget(hash, decoded.bits) || !stored.equals(hash)) {
        return { ok: false, reason: 'pow' };
      }
      link = hash;
    }
    if (!prevDecoded) {
      if (decoded.bits !== GENESIS_BITS_PACKED || !isPackedBits(decoded.bits)) {
        return { ok: false, reason: 'bits' };
      }
      genesisMs = ts;
    } else {
      const parentIsGenesis = prevDecoded.prevBlockHash.equals(GENESIS_PREV);
      const quote = asertNextBits({
        anchorBits: parentIsGenesis ? prevDecoded.bits : GENESIS_BITS_PACKED,
        anchorTimeMs: parentIsGenesis ? Number(prevDecoded.timestamp) : genesisMs,
        anchorHeight: parentIsGenesis ? prevHeight : 1,
        blockTimeMs: ts,
        blockHeight: height,
        parentTimeMs: Number(prevDecoded.timestamp),
      });
      if (!quote.ok || !bitsAcceptAsert(decoded.bits, quote) || !isPackedBits(decoded.bits)) {
        return { ok: false, reason: 'bits' };
      }
    }
    const txs = Array.isArray(block.txs) ? block.txs : [];
    if (!txs.length || !txs[0]?.coinbase) return { ok: false, reason: 'coinbase' };
    const merkle = merkleRoot(txs.map(digestTx));
    if (!merkle.equals(decoded.merkleRoot)) return { ok: false, reason: 'merkle' };
    prevLink = link;
    prevDecoded = decoded;
    prevHeight = height;
  }
  return { ok: true };
}

/**
 * Consensus verify. When the body has a Reserve vortice call or an EVM SHE
 * value transfer, runs pinned Reserve bytecode (fail closed) and returns a Promise.
 */
export function verifyBlock(block, prev, opts = {}) {
  const consensus = verifyBlockConsensus(block, prev, opts);
  if (consensus && typeof consensus.then === 'function') {
    return consensus.then((done) => {
      if (!done?.ok) return done;
      const txs = Array.isArray(block?.txs) ? block.txs : [];
      if (!blockNeedsEvm(txs)) return { ...done, evmRan: false };
      return verifyBlockEvm(done, block, opts);
    });
  }
  if (!consensus.ok) return consensus;
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  if (!blockNeedsEvm(txs)) return { ...consensus, evmRan: false };
  return verifyBlockEvm(consensus, block, opts);
}

export function chainWorkOf(blocks) {
  let sum = 0n;
  for (const b of blocks) {
    const bits = decodeHeader(Buffer.from(b.header)).bits;
    sum += blockWorkBig(bits);
  }
  return sum;
}

function tipHashHex(blocks) {
  const tip = blocks[blocks.length - 1];
  if (!tip?.hash) return '';
  try {
    return Buffer.from(tip.hash).toString('hex').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * One chain, whoever found the blocks.
 * More work wins. Equal work: the lower tip hash wins.
 * First-seen is not a rule, and the pool is not a special tip.
 */
export function shouldAdopt(local, remote) {
  const L = Array.isArray(local) ? local : [];
  const R = Array.isArray(remote) ? remote : [];
  if (!R.length) return false;
  if (!L.length) return true;
  const lw = chainWorkOf(L);
  const rw = chainWorkOf(R);
  if (rw > lw) return true;
  if (rw < lw) return false;
  const rh = tipHashHex(R);
  const lh = tipHashHex(L);
  return rh !== '' && lh !== '' && rh < lh;
}

/** Consecutive sealed header gaps, oldest first. A bad stamp is the 90s pad. */
export function headerGapsMs(chain) {
  const blocks = Array.isArray(chain) ? chain : [];
  const gaps = [];
  for (let i = 1; i < blocks.length; i += 1) {
    try {
      const a = decodeHeader(Buffer.from(blocks[i - 1].header));
      const b = decodeHeader(Buffer.from(blocks[i].header));
      const d = Number(b.timestamp) - Number(a.timestamp);
      gaps.push(Number.isFinite(d) && d > 0 ? d : TARGET_BLOCK_INTERVAL_MS);
    } catch {
      gaps.push(TARGET_BLOCK_INTERVAL_MS);
    }
  }
  return gaps;
}

/** Solve time of the tip, used as the next block's difficulty. Missing history uses 90s. */
export function parentSolveIntervalMs(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 2) return TARGET_BLOCK_INTERVAL_MS;
  try {
    const last = decodeHeader(Buffer.from(blocks[blocks.length - 1].header));
    const prev = decodeHeader(Buffer.from(blocks[blocks.length - 2].header));
    const d = Number(last.timestamp) - Number(prev.timestamp);
    return Number.isFinite(d) ? d : TARGET_BLOCK_INTERVAL_MS;
  } catch {
    return TARGET_BLOCK_INTERVAL_MS;
  }
}

/** aserti3-2d quote for the next header, including the emergency ease window.
 *  candidateTimestamp is the stamp the template will seal. A missing stamp
 *  means one target interval after the tip. The anchor is genesis, never
 *  the parent bits. Template issuance uses `packed`. A stall timer may issue
 *  `eased` only when `easeBits > 0`.
 */
export function retargetQuote(chain, candidateTimestamp) {
  if (!chain.length) return { ok: false, reason: 'asert_anchor' };
  let genesis;
  let last;
  try {
    genesis = decodeHeader(Buffer.from(chain[0].header));
    last = decodeHeader(Buffer.from(chain[chain.length - 1].header));
  } catch {
    return { ok: false, reason: 'asert_anchor' };
  }
  const parentTime = Number(last.timestamp);
  let blockTime = Number(candidateTimestamp);
  if (!Number.isFinite(blockTime)) blockTime = parentTime + TARGET_BLOCK_INTERVAL_MS;
  return asertNextBits({
    anchorBits: Number(genesis.bits) || GENESIS_BITS_PACKED,
    anchorTimeMs: Number(genesis.timestamp),
    anchorHeight: Number(chain[0].height || 1),
    blockTimeMs: blockTime,
    blockHeight: Number(chain[chain.length - 1].height || chain.length) + 1,
    parentTimeMs: parentTime,
  });
}

/** Full aserti3-2d packed bits for the next header.
 *  The emergency ease window is not this return value. A fresh template
 *  issues the full target. `retargetQuote` carries the ease window.
 */
export function retarget(chain, candidateTimestamp) {
  const quote = retargetQuote(chain, candidateTimestamp);
  if (!quote.ok) return GENESIS_BITS_PACKED;
  return quote.packed;
}

export function genesisBlock({ miner, now = Date.now() }) {
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner,
    samples: [],
    txs: [],
    now,
    bits: GENESIS_BITS_PACKED,
  });
  let found = null;
  for (let n = 0n; n < 5_000_000n; n += 1n) {
    const header = setNonce(tpl.header, n);
    const hash = shearHash(header);
    if (meetsTarget(hash, GENESIS_BITS_PACKED)) {
      found = { header, hash, nonce: n };
      break;
    }
  }
  if (!found) throw new Error('genesis_pow');
  return {
    magic: MAGIC_TESTNET,
    height: 1,
    header: found.header,
    hash: found.hash,
    txs: tpl.txs,
    samples: [],
    shareBatch: [],
    miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
  };
}

export function publicJob(tpl, { jobId, shareBits }) {
  const decoded = decodeHeader(tpl.header);
  const job = {
    jobId: String(jobId),
    height: tpl.height,
    version: decoded.version,
    prevBlockHash: decoded.prevBlockHash.toString('hex'),
    merkleRoot: decoded.merkleRoot.toString('hex'),
    continuityRoot: decoded.continuityRoot.toString('hex'),
    timestamp: decoded.timestamp.toString(),
    bits: decoded.bits,
    shareBits,
    blockBits: decoded.bits,
    header: tpl.header.toString('hex'),
    nonce: '0',
    baseFee: decoded.baseFee.toString(),
  };
  return job;
}

export { hashHex };

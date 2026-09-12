import { shearHash, meetsTarget, hashHex } from '../../crypto/shear_hash.js';
import { encodeHeader, decodeHeader, setNonce, VERSION } from '../../crypto/header.js';
import { merkleRoot, EMPTY_ROOT } from '../../crypto/merkle.js';
import {
  GENESIS_BITS,
  nextBits,
  bitsForBlock,
  blockWork,
  blockWorkBig,
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  HASH_BONUS_NANOS_FLOOR,
  MAGIC_TESTNET,
  extraMintAllowed,
  wrapMintForbidden,
  DEST_HRP,
  JOIN_PROGRAM,
  JOIN_KIND_GENESIS,
  SHARE_FLOOR_BITS,
  MAX_SHARES_PER_BLOCK,
  POOL_FEE_BPS,
  MTP_WINDOW,
  MTP_FUTURE_MS,
  medianTimePast,
  GENESIS_BPS,
  RESERVE_PROGRAM,
} from '../../crypto/asert.js';
import {
  verifyShareBatch,
  collateShareUnits,
  aLeavesFromShares,
  unitsForShare,
  destOfShare,
  dest20OfShare,
  noteCommitOfShare,
  sortShares,
} from '../../crypto/share_batch.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import {
  bootReserveEvm,
  blockNeedsEvm,
  executeBlockEvm,
} from '../../crypto/reserve_evm.js';
import { isDestAddress, isShearAddress, hash20FromAddress, bech32Hrp, checkAddressField, checkTxAddressFields, admitBaseFromAddress } from '../../crypto/address.js';
import {
  admit_verify,
  attachAdmitPub,
  fluxsetFromBlocks,
  jroot as jrootOf,
} from '../../crypto/admit.js';
import { collateSamples, shouldPruneSamples } from '../../crypto/chronoflux.js';
import { verifyFundedBody } from '../../crypto/spend.js';
import { hasherPayoutDest } from '../../crypto/flow_sheet.js';
import {
  sealCoinbaseNote,
  verifySealedNote,
  verifyMintSum,
  verifyRange,
  excessOf,
  verifyFlowConservation,
  noteCommitOfDest20,
  asU8,
  pointFrom,
} from '../../crypto/note.js';
import { packTx, packDigest } from '../../crypto/pack.js';
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
} from '../../crypto/levy.js';
import { gateVorticeRegister } from '../../crypto/vortex.js';
import { dummyCount, flowNeedsDummy } from '../../crypto/dummy.js';

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

export function digestTx(tx) {
  const vins = (tx.vin || []).map((v, i) => ({
    prev: v.prev ? Buffer.from(v.prev) : Buffer.alloc(32),
    index: Number(v.index || i),
    dest20: v.noteCommit && Buffer.from(v.noteCommit).length === 32
      ? Buffer.from(v.noteCommit).subarray(0, 20)
      : Buffer.alloc(20),
  }));
  const vouts = (tx.vout || []).map((o) => ({
    dest20: o.noteCommit && Buffer.from(o.noteCommit).length === 32
      ? Buffer.from(o.noteCommit).subarray(0, 20)
      : dest20Of(o.address || ''),
    nanos: o.commit ? 0 : Number(o.nanos || 0),
    kind: kindByte(o.kind),
  }));
  return packDigest(packTx({
    version: 1,
    vins: vins.length ? vins : [{ prev: Buffer.alloc(32), index: Number(tx.height || 0), dest20: Buffer.alloc(20) }],
    vouts,
    memoH: tx.memoH || null,
    bFlag: tx.bFlag || tx.kind === 'b-spend' ? 1 : 0,
  }));
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
  const u = Number(unit);
  const bonus = Number.isFinite(u) && u >= HASH_BONUS_NANOS_FLOOR ? u : HASH_BONUS_NANOS;
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

/** PROP of (pot − pool fee) across Tree-A note_commits. Pool note gets only the fee. */
export function potPaysFromLeaves(leaves = [], poolDest = null, feeNanos = null) {
  const pool = poolDest && isDestAddress(poolDest) ? poolDest : '';
  const poolNc = pool ? noteCommitOfDest20(hash20FromAddress(pool)).toString('hex') : '';
  const fee = feeNanos != null
    ? Math.max(0, Math.floor(Number(feeNanos) || 0))
    : (poolNc ? Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000) : 0);
  const rest = BLOCK_SUBSIDY_NANOS - fee;
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
    else out.push({ noteCommit: noteCommitOfDest20(hash20FromAddress(pool)), nanos: fee, kind: 'pot' });
  }
  return out.filter((s) => s.nanos > 0);
}

/** PROP of (pot - pool fee) across dest20 in shareBatch. Pool dest gets only the fee. */
export function potSharesFromBatch(shareBatch = [], poolDest = null) {
  const leaves = aLeavesFromShares(shareBatch);
  const pays = potPaysFromLeaves(leaves, poolDest);
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

export function coinbaseTx({
  height, miner, samples = [], potShares = null, destOf = (a) => a, hashBonusNanos = HASH_BONUS_NANOS,
  shareBatch = null, poolDest = null,
}) {
  const bonuses = hashBonusByMiner(samples, hashBonusNanos, shareBatch);
  const vout = [];
  let shares = potShares && potShares.length ? potShares : null;
  if (!shares) {
    if (Array.isArray(shareBatch) && shareBatch.length) {
      shares = potSharesFromBatch(shareBatch, poolDest);
      if (!shares.length) shares = [{ address: miner, nanos: BLOCK_SUBSIDY_NANOS, kind: 'pot' }];
    } else {
      shares = [{ address: miner, nanos: BLOCK_SUBSIDY_NANOS, kind: 'pot' }];
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
  for (const [address, nanos] of bonuses) {
    const pay = destOf(address);
    if (!isDestAddress(pay)) continue;
    const d20 = hash20FromAddress(pay);
    vout.push(attachAdmitPub(sealCoinbaseNote(nanos, { dest20: d20, kind: 'hash' }), {
      admitBase: admitBaseFromAddress(pay),
    }));
  }
  if (!vout.length) {
    throw new Error('coinbase_needs_dest');
  }
  return {
    coinbase: true,
    height,
    vin: [{ coinbase: true, height }],
    vout,
    excess: excessOf(vout),
  };
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
  parentFluxset = null,
  parentBlocks = null,
}) {
  const batch = Array.isArray(shareBatch) ? sortShares(shareBatch) : [];
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
  const cb = coinbaseTx({
    height, miner, samples: collated, potShares, destOf: pay, hashBonusNanos, shareBatch: batch, poolDest,
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
    bits: bits ?? GENESIS_BITS,
    nonce: 0n,
    baseFee: BigInt(baseFee),
  });
  return {
    height,
    bits: bits ?? GENESIS_BITS,
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
  };
}

export function mineTemplate(tpl, { maxTries = 1_000_000, shareBits = 8 } = {}) {
  for (let n = 0n; n < BigInt(maxTries); n += 1n) {
    const header = setNonce(tpl.header, n);
    const hash = shearHash(header);
    if (meetsTarget(hash, tpl.bits)) {
      return { header, hash, nonce: n, block: true };
    }
    if (meetsTarget(hash, shareBits)) {
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

function verifyBlockConsensus(block, prev, {
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
} = {}) {
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
  // Local pool already hashed this header off-thread. Re-running RandomX
  // on the event loop stalls HTTP/stratum. P2P and tests omit this and hash.
  let hash;
  if (trustedPowHash) {
    hash = Buffer.from(trustedPowHash);
    if (hash.length !== 32 || !meetsTarget(hash, decoded.bits)) {
      return { ok: false, reason: 'pow' };
    }
  } else {
    hash = shearHash(h);
    if (!meetsTarget(hash, decoded.bits)) return { ok: false, reason: 'pow' };
  }
  const txs = Array.isArray(block.txs) ? block.txs : [];
  if (!txs.length || !txs[0]?.coinbase) return { ok: false, reason: 'coinbase' };
  const merkle = merkleRoot(txs.map(digestTx));
  if (!merkle.equals(decoded.merkleRoot)) return { ok: false, reason: 'merkle' };
  if (prev?.header) {
    let parent;
    try {
      parent = decodeHeader(Buffer.from(prev.header));
    } catch {
      return { ok: false, reason: 'parent_header' };
    }
    const want = bitsForBlock(parent.bits, parent.timestamp, decoded.timestamp);
    if (decoded.bits !== want) return { ok: false, reason: 'bits' };
    const pWeight = Number(prev.weight != null
      ? prev.weight
      : blockWeight(prev.txs || [], prev.bLeaves || []));
    const wantBase = nextBaseFee(Number(parent.baseFee || 1n), pWeight);
    if (Number(decoded.baseFee) !== wantBase) return { ok: false, reason: 'base_fee' };
    const ts = Number(decoded.timestamp);
    const parentTs = Number(parent.timestamp);
    if (!(ts > parentTs)) return { ok: false, reason: 'timestamp' };
    const window = Array.isArray(mtpTimestamps) && mtpTimestamps.length
      ? mtpTimestamps.slice(-MTP_WINDOW)
      : [parentTs];
    const mtp = medianTimePast(window);
    if (ts > mtp + MTP_FUTURE_MS) return { ok: false, reason: 'timestamp' };
    if (nowMs != null && Number.isFinite(Number(nowMs)) && ts > Number(nowMs) + MTP_FUTURE_MS) {
      return { ok: false, reason: 'timestamp' };
    }
  } else if (Number(decoded.baseFee) < 1) {
    return { ok: false, reason: 'base_fee' };
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
  const tip = Number(tipHeight || height);
  const buriedDeep = shouldPruneSamples(height, tip);
  void buried;
  const skipFlow = buriedDeep && !!block.samplesPruned;
  const shareBatch = Array.isArray(block.shareBatch) ? block.shareBatch : [];
  const payAddr = (a) => a;
  const unit = Number(hashBonusNanos);
  const liveUnit = Number.isFinite(unit) && unit >= HASH_BONUS_NANOS_FLOOR ? unit : HASH_BONUS_NANOS;
  let provenUnits = 0;
  let provenByDest = new Map();
  let shareLeaves = null;
  if (!skipFlow) {
    if (shareBatch.length > MAX_SHARES_PER_BLOCK) return { ok: false, reason: 'share_cap' };
    if (prev?.header) {
      const proved = verifyShareBatch({
        parentHeader: prev.header,
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
    if (confidential) {
      const wantBonus = provenUnits * liveUnit;
      const leaves = shareLeaves || aLeavesFromShares(shareBatch);
      const hasherNcs = new Set(leaves.map((l) => ncHex(l.noteCommit)));
      for (const leaf of leaves) {
        const nc = ncHex(leaf.noteCommit);
        const hit = hashVouts.find((o) => ncHex(o.noteCommit) === nc);
        if (!hit || !verifySealedNote(hit, leaf.count * liveUnit)) {
          return { ok: false, reason: 'hash_bonus' };
        }
      }
      for (const o of hashVouts) {
        if (!hasherNcs.has(ncHex(o.noteCommit))) return { ok: false, reason: 'hash_bonus' };
      }
      bonusNanos = wantBonus;
      const feeAmt = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
      const poolPay = poolDest && isDestAddress(poolDest) ? poolDest : '';
      if (hasherNcs.size) {
        const extra = potVouts.filter((o) => !hasherNcs.has(ncHex(o.noteCommit)));
        for (const o of extra) {
          if (verifySealedNote(o, BLOCK_SUBSIDY_NANOS)) {
            return { ok: false, reason: 'pot_prop' };
          }
        }
        const candidates = [];
        if (poolPay) candidates.push(potPaysFromLeaves(leaves, poolPay));
        candidates.push(potPaysFromLeaves(leaves, null, extra.length ? feeAmt : 0));
        if (extra.length) candidates.push(potPaysFromLeaves(leaves, null, 0));
        if (!extra.length && feeAmt > 0) {
          const base = potPaysFromLeaves(leaves, null, feeAmt);
          for (let i = 0; i < base.length; i += 1) {
            candidates.push(base.map((p, j) => (j === i ? { ...p, nanos: p.nanos + feeAmt } : p)));
          }
        }
        let matched = false;
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
            || (extra.length === 1 && verifySealedNote(extra[0], feeAmt));
          if (!extraOk) continue;
          const covered = new Set(pays.map((p) => ncHex(p.noteCommit)));
          if (extra.length === 1) covered.add(ncHex(extra[0].noteCommit));
          if (potVouts.some((o) => !covered.has(ncHex(o.noteCommit)))) continue;
          matched = true;
          break;
        }
        if (!matched) return { ok: false, reason: 'pot_prop' };
      }
      const T = BLOCK_SUBSIDY_NANOS + wantBonus;
      const money = cbVouts.filter((o) => o.commit && o.kind !== 'finder-fee' && o.kind !== 'reserve-fee');
      if (!verifyMintSum(money, T, txs[0].excess)) return { ok: false, reason: 'pot' };
      potNanos = BLOCK_SUBSIDY_NANOS;
    } else {
      potNanos = potVouts.reduce((a, o) => a + Number(o.nanos || 0), 0);
      bonusNanos = hashVouts.reduce((a, o) => a + Number(o.nanos || 0), 0);
      if (potNanos !== BLOCK_SUBSIDY_NANOS) return { ok: false, reason: 'pot' };
      if (bonusNanos !== provenUnits * liveUnit) return { ok: false, reason: 'hash_bonus' };
      const paid = new Map();
      for (const o of hashVouts) {
        paid.set(o.address, (paid.get(o.address) || 0) + Number(o.nanos || 0));
      }
      for (const [dest, units] of provenByDest) {
        if ((paid.get(dest) || 0) !== units * liveUnit) return { ok: false, reason: 'hash_bonus' };
      }
      for (const dest of paid.keys()) {
        if (!provenByDest.has(dest)) return { ok: false, reason: 'hash_bonus' };
      }
      const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
      const hasherSet = new Set(provenByDest.keys());
      const poolPay = poolDest && isDestAddress(poolDest) ? poolDest : '';
      if (hasherSet.size) {
        const extra = potVouts.filter((o) => !hasherSet.has(o.address));
        const extraNanos = extra.reduce((a, o) => a + Number(o.nanos || 0), 0);
        if (extraNanos > fee) return { ok: false, reason: 'pot_prop' };
        if (extraNanos === BLOCK_SUBSIDY_NANOS) return { ok: false, reason: 'pot_prop' };
        if (poolPay && extra.some((o) => o.address === poolPay) && extraNanos > fee) {
          return { ok: false, reason: 'pot_prop' };
        }
      }
    }
  }
  const aLeaves = shareLeaves
    || (Array.isArray(block.aLeaves) && block.aLeaves.length && !prev?.header
      ? block.aLeaves.map((l) => ({ dest20: Buffer.from(l.dest20), count: Number(l.count) || 1 }))
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
  const history = Array.isArray(evmHistory) && evmHistory.length ? evmHistory : (prev ? [prev] : []);
  const live = fluxsetFromBlocks(history);
  const pubs = live.pubs.slice();
  const spentTags = new Set(live.spendTags);
  const pushPub = (o) => {
    if (!o?.admitPub) return;
    try {
      pubs.push(typeof o.admitPub.toBytes === 'function' ? o.admitPub : pointFrom(o.admitPub));
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
    if (flowNeedsDummy(tx) && dummyCount(tx) < 1) {
      return { ok: false, reason: 'dummy_outs' };
    }
    if (flowNeedsDummy(tx)) {
      for (const o of (tx.vout || [])) {
        if (!o?.commit) return { ok: false, reason: 'confidential' };
        if (!o.rangeProof || !verifyRange(o.commit, o.rangeProof)) {
          return { ok: false, reason: 'confidential' };
        }
      }
      const dummies = (tx.vout || []).filter((o) => String(o.kind || '') === 'dummy');
      if (!dummies.every((o) => verifySealedNote(o, 0))) return { ok: false, reason: 'dummy_outs' };
      const spentOf = (vin) => lookupSpentVout(vin, block, prev, i, evmHistory);
      if (!verifyFlowConservation(tx, spentOf)) return { ok: false, reason: 'confidential' };
      const proof = tx.admit_proof;
      if (!proof) return { ok: false, reason: 'admit' };
      if (!admit_verify(proof, pubs)) return { ok: false, reason: 'admit' };
      const tag = proof.spendTag || tx.spendTag;
      if (!tag) return { ok: false, reason: 'admit' };
      const th = Buffer.from(asU8(tag)).toString('hex');
      if (spentTags.has(th)) return { ok: false, reason: 'admit' };
      spentTags.add(th);
    }
    for (const o of outs) pushPub(o);
    if ((unfunded || tx.mint) && String(tx.programId || '') === RESERVE_PROGRAM && String(tx.kind || '') === 'withdraw') {
      const bps = Number(committedBps ?? reserveState?.epochBps ?? GENESIS_BPS);
      const dest = String(tx.from || tx.vin?.[0]?.address || '');
      const portals = reserveState?.portals || {};
      const portal = portals[dest]
        || Object.values(portals).find((p) => p && (Number(p.staked || 0) + Number(p.idle || 0) > 0));
      const staked = Number(tx.stakedNanos ?? portal?.staked ?? 0);
      const idle = Number(tx.idleNanos ?? portal?.idle ?? 0);
      const principal = Number(tx.principalNanos ?? (staked + idle));
      const want = principal + interestNanos(staked, bps);
      const o = tx.vout?.[0];
      const got = o?.commit
        ? (verifySealedNote(o, want) ? want : -1)
        : Number(o?.nanos ?? tx.nanos ?? 0);
      if (!evmSession && got !== want) return { ok: false, reason: 'mint_amount' };
    }
    if (containsShe1(tx)) return { ok: false, reason: 'she1_on_chain' };
    const taxed = levyTaxed(tx);
    const need = levyNeed(tx, body.slice(0, i));
    const paid = Math.floor(Number(tx.fee || 0));
    if (paid < need) return { ok: false, reason: 'levy' };
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
      const tip = Number(tipHeight || block.height || (prev?.height || 0) + 1);
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
  const levyNote = (kind, want) => {
    const o = txs[0].vout.find((v) => v.kind === kind);
    if (want === 0 && !o) return 0;
    if (!o) return -1;
    if (o.commit) return verifySealedNote(o, want) ? want : -1;
    return Number(o.nanos || 0);
  };
  const finderPaid = levyNote('finder-fee', split.finder);
  const reservePaid = levyNote('reserve-fee', split.reserve);
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
    return { ok: false, reason: 'admit' };
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

/**
 * Consensus verify. When the body has a Reserve vortice call or an EVM SHE
 * value transfer, runs pinned Reserve bytecode (fail closed) and returns a Promise.
 */
export function verifyBlock(block, prev, opts = {}) {
  const consensus = verifyBlockConsensus(block, prev, opts);
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

export function shouldAdopt(local, remote) {
  const L = Array.isArray(local) ? local : [];
  const R = Array.isArray(remote) ? remote : [];
  if (!R.length) return false;
  if (!L.length) return true;
  return chainWorkOf(R) > chainWorkOf(L);
}

export function retarget(chain, candidateTimestamp) {
  if (!chain.length) return GENESIS_BITS;
  const last = decodeHeader(Buffer.from(chain[chain.length - 1].header));
  if (candidateTimestamp != null) {
    return bitsForBlock(last.bits, last.timestamp, candidateTimestamp);
  }
  if (chain.length < 2) return last.bits;
  const prev = decodeHeader(Buffer.from(chain[chain.length - 2].header));
  return nextBits(last.bits, Number(last.timestamp) - Number(prev.timestamp));
}

export function genesisBlock({ miner, now = Date.now() }) {
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner,
    samples: [],
    txs: [],
    now,
    bits: GENESIS_BITS,
  });
  let found = null;
  for (let n = 0n; n < 5_000_000n; n += 1n) {
    const header = setNonce(tpl.header, n);
    const hash = shearHash(header);
    if (meetsTarget(hash, GENESIS_BITS)) {
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

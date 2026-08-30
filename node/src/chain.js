import { shearHash, meetsTarget, hashHex } from '../../crypto/shear_hash.js';
import { encodeHeader, decodeHeader, setNonce, VERSION } from '../../crypto/header.js';
import { merkleRoot, EMPTY_ROOT } from '../../crypto/merkle.js';
import {
  GENESIS_BITS,
  nextBits,
  bitsForBlock,
  blockWork,
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  MAGIC_TESTNET,
  extraMintAllowed,
  DEST_HRP,
} from '../../crypto/asert.js';
import { isDestAddress, isShearAddress, hash20FromAddress, bech32Hrp } from '../../crypto/address.js';
import { collateSamples } from '../../crypto/chronoflux.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { packTx, packDigest } from '../../crypto/pack.js';
import { buildDualTree, spendB } from '../../crypto/clearing.js';
import {
  nextBaseFee,
  blockWeight,
  levyNanos,
  splitLevy,
  txWeight,
  reserveFeeDest,
} from '../../crypto/levy.js';

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
  return 0;
}

export function digestTx(tx) {
  const vins = (tx.vin || []).map((v, i) => ({
    prev: v.prev ? Buffer.from(v.prev) : Buffer.alloc(32),
    index: Number(v.index || i),
    dest20: dest20Of(v.address || ''),
  }));
  const vouts = (tx.vout || []).map((o) => ({
    dest20: dest20Of(o.address || ''),
    nanos: Number(o.nanos || 0),
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
  return collated.map((s) => ({
    dest20: dest20Of(pay(s.miner || s.address || '')),
    count: Number(s.count) > 0 ? Number(s.count) : 1,
  }));
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

export function hashBonusByMiner(samples = [], unit = HASH_BONUS_NANOS) {
  const u = Number(unit);
  const bonus = Number.isFinite(u) && u >= 0 ? u : HASH_BONUS_NANOS;
  const by = new Map();
  for (const s of collateSamples(samples)) {
    const addr = String(s.miner || s.address || '');
    if (!isDestAddress(addr) && !isShearAddress(addr)) continue;
    by.set(addr, (by.get(addr) || 0) + s.count * bonus);
  }
  return by;
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
}) {
  const bonuses = hashBonusByMiner(samples, hashBonusNanos);
  const vout = [];
  const shares = potShares && potShares.length
    ? potShares
    : [{ address: miner, nanos: BLOCK_SUBSIDY_NANOS }];
  for (const s of shares) {
    const pay = destOf(s.address);
    if (!isDestAddress(pay) || !s.nanos) continue;
    vout.push({ address: pay, nanos: s.nanos, kind: 'pot' });
  }
  for (const [address, nanos] of bonuses) {
    const pay = destOf(address);
    if (!isDestAddress(pay)) continue;
    vout.push({ address: pay, nanos, kind: 'hash' });
  }
  if (!vout.length) {
    throw new Error('coinbase_needs_dest');
  }
  return {
    coinbase: true,
    height,
    vin: [{ coinbase: true, height }],
    vout,
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
}) {
  const collated = collateSamples(samples);
  const continuityLag1 = lag1Continuity(prevHeader);
  const pay = destOf || ((login) => (isDestAddress(login)
    ? login
    : destForLogin(login, { continuityRoot: continuityLag1, height })));
  const cb = coinbaseTx({
    height, miner, samples: collated, potShares, destOf: pay, hashBonusNanos,
  });
  const fees = (txs || []).reduce((a, t) => a + Math.max(0, Math.floor(Number(t.fee || 0))), 0);
  const split = splitLevy(fees);
  if (split.finder) cb.vout.push({ address: pay(miner), nanos: split.finder, kind: 'finder-fee' });
  if (split.reserve) cb.vout.push({ address: reserveFeeDest(), nanos: split.reserve, kind: 'reserve-fee' });
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
    samples: collated,
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

export function verifyBlock(block, prev, {
  buried = false,
  joinFunded = false,
  spentB = null,
  tipHeight = 0,
  hashBonusNanos = HASH_BONUS_NANOS,
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
  const hash = shearHash(h);
  if (!meetsTarget(hash, decoded.bits)) return { ok: false, reason: 'pow' };
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
  } else if (Number(decoded.baseFee) < 1) {
    return { ok: false, reason: 'base_fee' };
  }
  const samples = collateSamples(
    Array.isArray(block.samples) ? block.samples : (txs[0].samples || []),
  );
  const potNanos = txs[0].vout
    .filter((o) => o.kind !== 'hash' && o.kind !== 'finder-fee' && o.kind !== 'reserve-fee')
    .reduce((a, o) => a + Number(o.nanos || 0), 0);
  if (potNanos !== BLOCK_SUBSIDY_NANOS) return { ok: false, reason: 'pot' };
  const bonusNanos = txs[0].vout.filter((o) => o.kind === 'hash').reduce((a, o) => a + Number(o.nanos || 0), 0);
  const skipFlow = buried && block.samplesPruned;
  const payAddr = (a) => a;
  const aLeaves = Array.isArray(block.aLeaves) && block.aLeaves.length
    ? block.aLeaves.map((l) => ({ dest20: Buffer.from(l.dest20), count: Number(l.count) || 1 }))
    : aLeavesOf(samples, payAddr);
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
    const sampleCount = samples.reduce((a, s) => a + (Number(s.count) > 0 ? Number(s.count) : 1), 0);
    const unit = Number(hashBonusNanos);
    const liveUnit = Number.isFinite(unit) && unit >= 0 ? unit : HASH_BONUS_NANOS;
    if (bonusNanos !== sampleCount * liveUnit) return { ok: false, reason: 'hash_bonus' };
  }
  for (const o of txs[0].vout) {
    if (!ssaOk(o.address)) return { ok: false, reason: 'miner_addr' };
  }
  const base = Number(decoded.baseFee || 1n);
  let fees = 0;
  const spent = spentB instanceof Set ? spentB : new Set(spentB || []);
  for (const tx of txs.slice(1)) {
    const outs = Array.isArray(tx.vout) ? tx.vout : [];
    for (const o of outs) {
      if (o?.address && !ssaOk(o.address)) {
        return { ok: false, reason: 'rest_frame_on_chain' };
      }
    }
    const ins = Array.isArray(tx.vin) ? tx.vin : [];
    for (const i of ins) {
      if (i?.address && isShearAddress(i.address)) return { ok: false, reason: 'rest_frame_on_chain' };
    }
    const unfunded = !Array.isArray(tx.vin) || tx.vin.length === 0 || tx.mint;
    if (unfunded && !extraMintAllowed(tx.programId, { kind: tx.kind, funded: joinFunded })) {
      return { ok: false, reason: 'mint_forbidden' };
    }
    const w = txWeight({
      vouts: Math.max(1, outs.length || (tx.to ? 1 : 0)),
      memoChunks: tx.memoCt || tx.memoH ? 1 : 0,
      bFlag: tx.bFlag || tx.kind === 'b-spend' ? 1 : 0,
    });
    const need = levyNanos(base, w);
    const paid = Math.floor(Number(tx.fee || 0));
    if (paid < need) return { ok: false, reason: 'levy' };
    fees += paid;
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
  const split = splitLevy(fees);
  const finderPaid = txs[0].vout.filter((o) => o.kind === 'finder-fee').reduce((a, o) => a + Number(o.nanos || 0), 0);
  const reservePaid = txs[0].vout.filter((o) => o.kind === 'reserve-fee').reduce((a, o) => a + Number(o.nanos || 0), 0);
  if (finderPaid !== split.finder || reservePaid !== split.reserve) return { ok: false, reason: 'levy_split' };
  return { ok: true, hash, decoded, aLeaves, bLeaves };
}

export function chainWorkOf(blocks) {
  let sum = 0;
  for (const b of blocks) {
    const bits = decodeHeader(Buffer.from(b.header)).bits;
    sum += blockWork(bits);
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

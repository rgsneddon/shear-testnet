import { shearHash, meetsTarget, hashHex } from '../../crypto/shear_hash.js';
import { encodeHeader, decodeHeader, setNonce, VERSION } from '../../crypto/header.js';
import { merkleRoot, EMPTY_ROOT, sampleLeaf } from '../../crypto/merkle.js';
import {
  GENESIS_BITS,
  nextBits,
  blockWork,
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS,
  MAGIC_TESTNET,
  extraMintAllowed,
} from '../../crypto/asert.js';
import { isShearAddress } from '../../crypto/address.js';
import { collateSamples } from '../../crypto/chronoflux.js';

export {
  SAMPLE_PRUNE_CONFIRMATIONS,
  shouldPruneSamples,
  pruneSamples,
  collateSamples,
  leanBlock,
  sealedExplorerRows,
  compactTx,
  compactChainBlock,
} from '../../crypto/chronoflux.js';

export const GENESIS_PREV = Buffer.alloc(32);

function digestTx(tx) {
  return merkleRoot([Buffer.from(JSON.stringify({
    vin: tx.vin,
    vout: tx.vout,
    height: tx.height,
  }))]);
}

export function hashBonusByMiner(samples = []) {
  const by = new Map();
  for (const s of collateSamples(samples)) {
    const addr = String(s.miner || s.address || '');
    if (!isShearAddress(addr)) continue;
    by.set(addr, (by.get(addr) || 0) + s.count * HASH_BONUS_NANOS);
  }
  return by;
}

export function coinbaseTx({ height, miner, samples = [], potShares = null }) {
  const bonuses = hashBonusByMiner(samples);
  const vout = [];
  const shares = potShares && potShares.length
    ? potShares
    : [{ address: miner, nanos: BLOCK_SUBSIDY_NANOS }];
  for (const s of shares) {
    if (!isShearAddress(s.address) || !s.nanos) continue;
    vout.push({ address: s.address, nanos: s.nanos, kind: 'pot' });
  }
  for (const [address, nanos] of bonuses) {
    vout.push({ address, nanos, kind: 'hash' });
  }
  if (!vout.length) {
    vout.push({ address: miner, nanos: BLOCK_SUBSIDY_NANOS, kind: 'pot' });
  }
  return {
    coinbase: true,
    height,
    vin: [{ coinbase: true, height }],
    vout,
  };
}

export function buildTemplate({ prev, height, miner, samples = [], txs = [], now = Date.now(), bits }) {
  const collated = collateSamples(samples);
  const cb = coinbaseTx({ height, miner, samples: collated });
  const bodyTxs = [cb, ...txs];
  const merkle = merkleRoot(bodyTxs.map(digestTx));
  const continuity = merkleRoot(collated.map((s) => sampleLeaf(s)));
  const header = encodeHeader({
    version: VERSION,
    prevBlockHash: prev || GENESIS_PREV,
    merkleRoot: merkle,
    continuityRoot: continuity,
    timestamp: BigInt(now),
    bits: bits ?? GENESIS_BITS,
    nonce: 0n,
  });
  return {
    height,
    bits: bits ?? GENESIS_BITS,
    header,
    merkleRoot: merkle,
    continuityRoot: continuity,
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

export function verifyBlock(block, prev, { buried = false } = {}) {
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
  const samples = collateSamples(
    Array.isArray(block.samples) ? block.samples : (txs[0].samples || []),
  );
  const potNanos = txs[0].vout.filter((o) => o.kind !== 'hash').reduce((a, o) => a + Number(o.nanos || 0), 0);
  if (potNanos !== BLOCK_SUBSIDY_NANOS) return { ok: false, reason: 'pot' };
  const bonusNanos = txs[0].vout.filter((o) => o.kind === 'hash').reduce((a, o) => a + Number(o.nanos || 0), 0);
  const skipFlow = buried && block.samplesPruned;
  if (!skipFlow) {
    const continuity = merkleRoot(samples.map((s) => sampleLeaf(s)));
    if (!continuity.equals(decoded.continuityRoot)) return { ok: false, reason: 'continuity' };
    const sampleCount = samples.reduce((a, s) => a + (Number(s.count) > 0 ? Number(s.count) : 1), 0);
    if (bonusNanos !== sampleCount * HASH_BONUS_NANOS) return { ok: false, reason: 'hash_bonus' };
  }
  for (const o of txs[0].vout) {
    if (!isShearAddress(o.address)) return { ok: false, reason: 'miner_addr' };
  }
  for (const tx of txs.slice(1)) {
    const unfunded = !Array.isArray(tx.vin) || tx.vin.length === 0 || tx.mint;
    if (unfunded && !extraMintAllowed(tx.programId)) {
      return { ok: false, reason: 'mint_forbidden' };
    }
  }
  return { ok: true, hash, decoded };
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

export function retarget(chain) {
  if (!chain.length) return GENESIS_BITS;
  const last = decodeHeader(Buffer.from(chain[chain.length - 1].header));
  if (chain.length < 2) return last.bits;
  const prev = decodeHeader(Buffer.from(chain[chain.length - 2].header));
  const interval = Number(last.timestamp - prev.timestamp);
  return nextBits(last.bits, interval);
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
  };
  return job;
}

export { hashHex };

/**
 * Chronoflux on the chain (HASH_TX_LIVE=1, collate O(miners)):
 *   Continuum  ∇·J = 0  spendable is conserved; the hash list is not the money
 *   Flow       J^μ      this round's hashes, collated per hasher (never one JSON row per hash)
 *   Resistance η        confirmations; at 100, Flow *samples* may be dropped
 *
 * Sealed forever (explorer reports every transfer for eternity):
 *   - 128-byte header (merkle_root + continuity_root = H(rootA||rootB) + base_fee)
 *   - coinbase vout (1 SHE pot + per-miner hash bonus totals + levy split)
 *   - every user transfer in txs[]
 *
 * Each 90s block rolls one Flow bundle: one A-leaf per hasher with
 * count = hashes (1 hash = 1 tx for bonus). Never one JSON object per hash.
 * Explorer reports those sealed rows, never the pruned sample JSON.
 *
 * Pruned after 1000 confirmations: per-round hash-sample bodies and B leaves.
 * Never prune vouts. continuity_root in the header remains the 32-byte seal.
 */
import { SPENDABLE_CONFIRMATIONS } from './asert.js';

export const SAMPLE_PRUNE_CONFIRMATIONS = 1000;
export { SPENDABLE_CONFIRMATIONS };

/** Confirmations of a sealed height, counting the including block as 1. */
export function flowConfirmations(blockHeight, tipHeight) {
  const h = Number(blockHeight) || 0;
  const tip = Number(tipHeight) || 0;
  if (h < 1 || tip < h) return 0;
  return tip - h + 1;
}

/** Consensus spendable after 1 confirmation. */
export function isSpendableHeight(blockHeight, tipHeight, need = SPENDABLE_CONFIRMATIONS) {
  const n = Math.max(1, Math.floor(Number(need) || SPENDABLE_CONFIRMATIONS));
  return flowConfirmations(blockHeight, tipHeight) >= n;
}

export function shouldPruneSamples(
  blockHeight,
  tipHeight,
  depth = SAMPLE_PRUNE_CONFIRMATIONS,
) {
  return Math.max(0, Number(tipHeight) - Number(blockHeight)) >= depth;
}

/** Collapse per-hash rows into one sample per miner. Idempotent. */
export function collateSamples(samples = []) {
  const by = new Map();
  for (const s of samples) {
    const miner = String(s.miner || s.address || '');
    if (!miner) continue;
    const count = Number(s.count) > 0 ? Number(s.count) : 1;
    const prev = by.get(miner);
    if (!prev) {
      by.set(miner, {
        miner,
        nonce: String(s.nonce || '0'),
        tag: String(s.tag || miner.slice(0, 12)),
        count,
      });
    } else {
      prev.count += count;
    }
  }
  return [...by.values()];
}

/** 90s block Flow bundle: one row per hasher, count = meeting hashes. */
export function rollHashBundle(samples = []) {
  return collateSamples(samples);
}

/** Drop Flow samples and B leaves. Never drop txs or coinbase vout — they stay sealed. */
export function pruneSamples(block) {
  const txs = Array.isArray(block.txs) ? block.txs : [];
  if (!txs.length) {
    throw new Error('prune_refuses_empty_txs');
  }
  const nextTxs = txs.map((tx) => {
    if (!tx?.coinbase) return tx;
    const { samples, ...rest } = tx;
    if (!Array.isArray(rest.vout) || !rest.vout.length) {
      throw new Error('prune_refuses_empty_coinbase');
    }
    return rest;
  });
  return {
    ...block,
    samples: [],
    bLeaves: [],
    samplesPruned: true,
    bLeavesPruned: true,
    txs: nextTxs,
  };
}

/**
 * Explorer rows from the sealed body. Independent of samples.
 * Safe after prune, forever: one row per real output, not per hash.
 */
export function sealedExplorerRows(block) {
  const height = Number(block?.height || 0);
  const hid = Buffer.isBuffer(block?.hash)
    ? block.hash.toString('hex')
    : String(block?.hash || height);
  const rows = [];
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const cb = txs[0];
  if (cb?.coinbase && Array.isArray(cb.vout)) {
    for (const o of cb.vout) {
      rows.push({
        id: `${hid}-${o.kind || 'cb'}`,
        kind: o.kind === 'hash' ? 'hash' : 'coinbase',
        from: 'coinbase',
        to: o.address,
        nanos: Number(o.nanos || 0),
        height,
        confirmed: true,
      });
    }
  }
  for (const tx of txs.slice(1)) {
    const from = tx.from || tx.vin?.[0]?.address;
    const to = tx.to || tx.vout?.[0]?.address;
    const nanos = Number(tx.nanos || tx.vout?.[0]?.nanos || 0);
    const kind = tx.kind || tx.vout?.[0]?.kind || (tx.mint ? 'reserve' : 'transfer');
    rows.push({
      id: tx.id || `${hid}-tx`,
      kind,
      from,
      to: kind === 'burn' ? '' : to,
      nanos,
      height,
      confirmed: true,
      memo: !!(tx.memoCt || tx.vout?.[0]?.memoCt),
      memoCt: tx.memoCt || tx.vout?.[0]?.memoCt,
    });
  }
  return rows;
}

/** Reconstruct dest spendable from sealed explorer rows. Burns destroy leftover. */
export function explorerSpendable(rows, address) {
  const addr = String(address || '');
  let n = 0;
  for (const r of rows || []) {
    const kind = String(r.kind || '');
    const amt = Number(r.nanos || 0);
    if (kind === 'burn') {
      if (String(r.from || '') === addr) n -= amt;
      continue;
    }
    if (String(r.to || '') === addr) n += amt;
    if (kind === 'claim' && String(r.from || '') === addr) n -= amt;
  }
  return n;
}

/** Persist live samples once on the block, not again inside coinbase JSON. */
export function leanBlock(block) {
  const txs = (block.txs || []).map((tx) => {
    if (!tx?.coinbase) return tx;
    const { samples, ...rest } = tx;
    return rest;
  });
  return {
    ...block,
    txs,
    samples: collateSamples(Array.isArray(block.samples) ? block.samples : []),
    aLeaves: Array.isArray(block.aLeaves) ? block.aLeaves : [],
    bLeaves: Array.isArray(block.bLeaves) ? block.bLeaves : [],
    rootA: block.rootA,
    rootB: block.rootB,
  };
}

/** Strip a tx down to the sealed fields. No sample bodies, no leftover template junk. */
export function compactTx(tx) {
  if (!tx) return tx;
  if (tx.coinbase) {
    return {
      coinbase: true,
      height: tx.height,
      vin: [{ coinbase: true, height: tx.height }],
      vout: (tx.vout || []).map((o) => ({
        address: o.address,
        nanos: Number(o.nanos || 0),
        kind: o.kind || 'pot',
      })),
    };
  }
  const out = {};
  if (tx.id) out.id = tx.id;
  if (tx.from) out.from = tx.from;
  if (tx.to) out.to = tx.to;
  if (tx.nanos != null) out.nanos = tx.nanos;
  if (tx.kind) out.kind = tx.kind;
  if (tx.programId) out.programId = tx.programId;
  if (tx.mint) out.mint = true;
  if (tx.key) out.key = tx.key;
  if (tx.root) out.root = tx.root;
  if (tx.commit) out.commit = tx.commit;
  if (tx.vin) out.vin = tx.vin;
  if (tx.vout) out.vout = tx.vout;
  if (tx.memoCt) out.memoCt = tx.memoCt;
  return out;
}

/**
 * On-disk chain row: header + sealed txs + (until prune) collated samples.
 * Never persist one JSON object per hash, template objects, or Buffer dumps.
 */
export function compactChainBlock(block) {
  const samplesPruned = !!block.samplesPruned;
  const bLeavesPruned = !!block.bLeavesPruned || samplesPruned;
  return {
    magic: block.magic,
    height: block.height,
    miner: block.miner,
    samplesPruned,
    bLeavesPruned,
    samples: samplesPruned ? [] : collateSamples(block.samples || []),
    aLeaves: Array.isArray(block.aLeaves) ? block.aLeaves : [],
    bLeaves: bLeavesPruned ? [] : (Array.isArray(block.bLeaves) ? block.bLeaves : []),
    rootA: block.rootA,
    rootB: block.rootB,
    weight: Number(block.weight || 0),
    txs: (block.txs || []).map(compactTx),
  };
}

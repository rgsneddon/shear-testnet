/**
 * Chronoflux on the chain (lean 1-hash=1-tx):
 *   Continuum  ∇·J = 0  spendable is conserved; the hash list is not the money
 *   Flow       J^μ      this round's hashes, collated per hasher (never one JSON row per hash)
 *   Resistance η        confirmations; at 100, Flow *samples* may be dropped
 *
 * Sealed forever (explorer reports every transfer for eternity):
 *   - 120-byte header (merkle_root + continuity_root)
 *   - coinbase vout (1 SHE pot + per-miner hash bonus totals)
 *   - every user transfer in txs[]
 * Explorer reports those sealed rows, never the pruned sample JSON.
 *
 * Pruned after 100 confirmations: per-round hash-sample bodies only.
 * continuity_root in the header remains the 32-byte seal of that Flow.
 */

export const SAMPLE_PRUNE_CONFIRMATIONS = 100;

export function flowConfirmations(blockHeight, tipHeight) {
  return Math.max(0, Number(tipHeight) - Number(blockHeight));
}

export function shouldPruneSamples(
  blockHeight,
  tipHeight,
  depth = SAMPLE_PRUNE_CONFIRMATIONS,
) {
  return flowConfirmations(blockHeight, tipHeight) >= depth;
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

/** Drop Flow samples only. Never drop txs or coinbase vout — they stay sealed. */
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
    samplesPruned: true,
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
    rows.push({
      id: tx.id || `${hid}-tx`,
      kind: tx.kind || (tx.mint ? 'reserve' : 'transfer'),
      from,
      to,
      nanos,
      height,
      confirmed: true,
      memo: !!(tx.memoCt || tx.vout?.[0]?.memoCt),
    });
  }
  return rows;
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
    samples: Array.isArray(block.samples) ? block.samples : [],
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
  if (tx.vin) out.vin = tx.vin;
  if (tx.vout) out.vout = tx.vout;
  return out;
}

/**
 * On-disk chain row: header + sealed txs + (until prune) collated samples.
 * Never persist one JSON object per hash, template objects, or Buffer dumps.
 */
export function compactChainBlock(block) {
  const samplesPruned = !!block.samplesPruned;
  return {
    magic: block.magic,
    height: block.height,
    miner: block.miner,
    samplesPruned,
    samples: samplesPruned ? [] : collateSamples(block.samples || []),
    txs: (block.txs || []).map(compactTx),
  };
}

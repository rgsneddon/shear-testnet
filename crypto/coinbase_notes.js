/**
 * Recover dest + nanos for confidential coinbase vouts from shareBatch + proofs.
 * Public dest20+nanos stay off the sealed vout; Tree-A units still imply values.
 */
import { BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS, POOL_FEE_BPS, SPENDABLE_CONFIRMATIONS, hashBonusUnitNanos } from './asert.js';
import { isDestAddress, hash20FromAddress } from './address.js';
import { aLeavesFromShares, destOfShare, noteCommitOfShare } from './share_batch.js';
import { noteCommitOfDest20, verifySealedNote, asU8 } from './note.js';

function ncHex(buf) {
  try {
    return Buffer.from(buf || []).toString('hex');
  } catch {
    return '';
  }
}

export function expectedCoinbasePays(shareBatch, {
  miner,
  poolDest,
  hashBonusNanos = HASH_BONUS_NANOS,
} = {}) {
  hashBonusNanos = hashBonusUnitNanos(hashBonusNanos);
  const batch = Array.isArray(shareBatch) ? shareBatch : [];
  const destByNc = new Map();
  for (const s of batch) {
    const key = ncHex(noteCommitOfShare(s));
    const dest = destOfShare(s);
    if (key && dest) destByNc.set(key, dest);
  }
  const leaves = aLeavesFromShares(batch);
  const out = [];
  for (const leaf of leaves) {
    const nanos = leaf.count * hashBonusNanos;
    if (nanos > 0) {
      out.push({
        address: destByNc.get(ncHex(leaf.noteCommit)) || '',
        nanos,
        kind: 'hash',
        noteCommit: leaf.noteCommit,
      });
    }
  }
  const pool = poolDest && isDestAddress(poolDest) ? poolDest : '';
  const fee = pool ? Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000) : 0;
  const rest = BLOCK_SUBSIDY_NANOS - fee;
  const total = leaves.reduce((a, l) => a + l.count, 0);
  if (!total) {
    if (miner && isDestAddress(miner)) {
      out.push({ address: miner, nanos: BLOCK_SUBSIDY_NANOS, kind: 'pot' });
    }
    return out;
  }
  let paid = 0;
  const sorted = [...leaves].sort((a, b) => {
    const da = destByNc.get(ncHex(a.noteCommit)) || ncHex(a.noteCommit);
    const db = destByNc.get(ncHex(b.noteCommit)) || ncHex(b.noteCommit);
    return da.localeCompare(db);
  });
  for (let i = 0; i < sorted.length; i += 1) {
    const leaf = sorted[i];
    const nanos = i === sorted.length - 1 ? rest - paid : Math.floor(rest * leaf.count / total);
    paid += nanos;
    if (nanos > 0) {
      out.push({
        address: destByNc.get(ncHex(leaf.noteCommit)) || '',
        nanos,
        kind: 'pot',
        noteCommit: leaf.noteCommit,
      });
    }
  }
  if (pool && fee > 0) {
    const existing = out.find((s) => s.kind === 'pot' && s.address === pool);
    if (existing) existing.nanos += fee;
    else out.push({ address: pool, nanos: fee, kind: 'pot' });
  }
  return out;
}

/** Rebuild hash/pot pays from Tree-A leaf counts when compact shareBatch dropped dests. */
export function paysFromALeaves(aLeaves, {
  hashBonusNanos = HASH_BONUS_NANOS,
} = {}) {
  hashBonusNanos = hashBonusUnitNanos(hashBonusNanos);
  const leaves = (Array.isArray(aLeaves) ? aLeaves : []).filter((l) => Number(l?.count) > 0);
  const total = leaves.reduce((a, l) => a + (Number(l.count) || 0), 0);
  const out = [];
  for (const leaf of leaves) {
    const c = Number(leaf.count) || 0;
    if (c > 0) {
      out.push({
        nanos: c * hashBonusNanos,
        kind: 'hash',
        noteCommit: leaf.noteCommit,
      });
    }
  }
  const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
  const rest = BLOCK_SUBSIDY_NANOS - fee;
  let paid = 0;
  const sorted = [...leaves].sort((a, b) => (Number(a.count) || 0) - (Number(b.count) || 0));
  for (let i = 0; i < sorted.length; i += 1) {
    const c = Number(sorted[i].count) || 0;
    if (!total || !c) continue;
    const nanos = i === sorted.length - 1 ? rest - paid : Math.floor(rest * c / total);
    paid += nanos;
    if (nanos > 0) {
      out.push({
        nanos,
        kind: 'pot',
        noteCommit: sorted[i].noteCommit,
      });
    }
  }
  return out;
}

export function matchSealedCoinbaseVout(o, pays) {
  if (!o) return { address: '', nanos: 0, kind: 'pot' };
  const kind = o.kind || 'pot';
  if (!o.commit) {
    return { address: o.address || '', nanos: Math.floor(Number(o.nanos || 0)), kind };
  }
  const nc = Buffer.from(o.noteCommit || []);
  for (const p of pays || []) {
    if ((p.kind || 'pot') !== kind) continue;
    let hit = false;
    if (p.noteCommit && nc.length === 32) {
      hit = nc.equals(Buffer.from(p.noteCommit));
    }
    if (!hit) {
      const d20 = hash20FromAddress(p.address);
      if (d20 && nc.length === 32) hit = nc.equals(noteCommitOfDest20(d20));
    }
    if (!hit) continue;
    if (verifySealedNote(o, p.nanos)) return { address: p.address, nanos: p.nanos, kind };
  }
  for (const p of pays || []) {
    if ((p.kind || 'pot') !== kind) continue;
    if (!p.nanos) continue;
    if (verifySealedNote(o, p.nanos)) {
      return { address: p.address || '', nanos: p.nanos, kind };
    }
  }
  return { address: '', nanos: 0, kind };
}

function noteCommitEq(a, b) {
  try {
    const x = Buffer.from(asU8(a));
    const y = Buffer.from(asU8(b));
    return x.length === 32 && y.length === 32 && x.equals(y);
  } catch {
    return false;
  }
}

function noteCommitHex(v) {
  try {
    const b = Buffer.from(asU8(v));
    return b.length === 32 ? b.toString('hex') : '';
  } catch {
    return '';
  }
}

/** noteCommit hexes already bound in a later vin (spent). */
export function spentNoteCommits(blocks) {
  const spent = new Set();
  for (const b of blocks || []) {
    for (const tx of b.txs || []) {
      if (tx?.coinbase) continue;
      for (const v of tx.vin || []) {
        const h = noteCommitHex(v?.noteCommit);
        if (h) spent.add(h);
      }
    }
  }
  return spent;
}

/** Mature coinbase/hash nanos owned by dest when compact explorer `to` is empty. */
export function noteCommitSpendableNanos(blocks, address, tipHeight, {
  hashBonusNanos = HASH_BONUS_NANOS,
  need = SPENDABLE_CONFIRMATIONS,
} = {}) {
  const dest20 = hash20FromAddress(address);
  if (!dest20) return 0;
  const want = noteCommitOfDest20(dest20);
  const spent = spentNoteCommits(blocks);
  const tip = Number(tipHeight) || 0;
  let nanos = 0;
  for (const b of blocks || []) {
    const h = Number(b?.height) || 0;
    if (!(h > 0 && (tip - h + 1) >= need)) continue;
    const pays = [
      ...expectedCoinbasePays(b.shareBatch || [], {
        miner: b.miner,
        hashBonusNanos,
      }),
      ...paysFromALeaves(b.aLeaves || [], { hashBonusNanos }),
    ];
    for (const tx of b.txs || []) {
      for (const o of tx.vout || []) {
        if (!o?.noteCommit || !noteCommitEq(o.noteCommit, want)) continue;
        const hex = noteCommitHex(o.noteCommit);
        if (hex && spent.has(hex)) continue;
        let n = Number(o.nanos || 0);
        if (tx.coinbase) {
          const matched = matchSealedCoinbaseVout(o, pays);
          if (matched.nanos) n = matched.nanos;
          else {
            const hit = pays.find((p) => p.noteCommit && noteCommitEq(p.noteCommit, o.noteCommit));
            if (hit) n = Number(hit.nanos || 0);
          }
        }
        if (n > 0) nanos += n;
      }
    }
  }
  return nanos;
}

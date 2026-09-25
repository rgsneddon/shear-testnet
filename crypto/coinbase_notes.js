/**
 * Recover dest + nanos for confidential coinbase vouts from shareBatch + proofs.
 * Public dest20+nanos stay off the sealed vout; Tree-A units still imply values.
 */
import { BLOCK_SUBSIDY_NANOS, HASH_BONUS_NANOS, POOL_FEE_BPS, SPENDABLE_CONFIRMATIONS, hashBonusUnitNanos } from './asert.js';
import { isDestAddress, hash20FromAddress, encodeDest } from './address.js';
import { aLeavesFromShares, destOfShare, noteCommitOfShare, unitsForShare } from './share_batch.js';
import { noteCommitOfDest20, verifySealedNote, asU8 } from './note.js';
import { poolFeeDest } from './levy.js';

function ncHex(buf) {
  try {
    return Buffer.from(buf || []).toString('hex');
  } catch {
    return '';
  }
}

function pushPotPay(out, address, nanos, kind, noteCommit) {
  if (!(nanos > 0) || !address) return;
  out.push({
    address,
    nanos,
    kind: kind || 'pot',
    ...(noteCommit ? { noteCommit } : {}),
  });
}

/** Sealed pot noteCommit is the pool dest and verifies as pot-after-fee (custodyPotShares). */
export function sealedPotIsCustody(block, poolDest, potNanos = BLOCK_SUBSIDY_NANOS) {
  if (!poolDest || !isDestAddress(poolDest)) return false;
  const dest20 = hash20FromAddress(poolDest);
  if (!dest20) return false;
  const want = noteCommitOfDest20(dest20);
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const rest = pot - Math.floor(pot * POOL_FEE_BPS / 10000);
  if (!(rest > 0)) return false;
  for (const tx of block?.txs || []) {
    if (!tx?.coinbase) continue;
    for (const o of tx.vout || []) {
      const kind = String(o.kind || 'pot');
      if (kind === 'hash' || kind === 'pool-fee' || kind === 'finder-fee' || kind === 'reserve-fee') continue;
      if (!noteCommitEq(o.noteCommit, want)) continue;
      if (o.commit && verifySealedNote(o, rest)) return true;
    }
  }
  return false;
}

function coinbaseVouts(block) {
  for (const tx of block?.txs || []) {
    if (tx?.coinbase) return Array.isArray(tx.vout) ? tx.vout : [];
  }
  return [];
}

function pushHasherNote(set, raw) {
  try {
    const b = Buffer.from(asU8(raw));
    if (b.length === 32) set.add(b.toString('hex'));
  } catch { /* ignore */ }
}

/** noteCommits that belong to hasher leaves (shareBatch or Tree-A), not the pool pot. */
function hasherNoteSet(block) {
  const set = new Set();
  for (const s of block?.shareBatch || []) pushHasherNote(set, noteCommitOfShare(s));
  for (const leaf of block?.aLeaves || []) {
    if (leaf?.noteCommit) pushHasherNote(set, leaf.noteCommit);
    try {
      const d20 = Buffer.from(asU8(leaf?.dest20));
      if (d20.length >= 20) pushHasherNote(set, noteCommitOfDest20(d20.subarray(0, 20)));
    } catch { /* ignore */ }
  }
  return set;
}

/**
 * Pool dest that holds the sealed pot-after-fee.
 * `block.poolDest` is not on chain.bin, compactChainBlock, or the wire, so a
 * missing hint must still be read from the pot note itself. A pot whose
 * noteCommit is a hasher leaf is solo prop, not custody.
 */
export function custodyPoolDestOf(block, potNanos = BLOCK_SUBSIDY_NANOS) {
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const hinted = block?.poolDest && isDestAddress(block.poolDest) ? block.poolDest : '';
  if (hinted && sealedPotIsCustody(block, hinted, pot)) return hinted;
  const rest = pot - Math.floor(pot * POOL_FEE_BPS / 10000);
  if (!(rest > 0)) return '';
  const hasher = hasherNoteSet(block);
  for (const o of coinbaseVouts(block)) {
    const kind = String(o?.kind || 'pot');
    if (kind === 'hash' || kind === 'pool-fee' || kind === 'finder-fee' || kind === 'reserve-fee') continue;
    if (!o?.commit || !verifySealedNote(o, rest)) continue;
    let nc = '';
    try {
      const b = Buffer.from(asU8(o.noteCommit));
      if (b.length === 32) nc = b.toString('hex');
    } catch { nc = ''; }
    if (!nc || hasher.has(nc)) continue;
    let d20 = null;
    try {
      const b = Buffer.from(asU8(o.dest20));
      if (b.length >= 20) d20 = b.subarray(0, 20);
    } catch { d20 = null; }
    if (!d20) continue;
    let addr = '';
    try { addr = encodeDest(d20); } catch { addr = ''; }
    if (addr && isDestAddress(addr)) return addr;
  }
  return '';
}

/**
 * True when a sealed pot-after-fee note is not a hasher leaf.
 * `poolDest` / dest20 can both be missing (chain.bin, wire) and this still
 * holds. An empty hasher set is solo, not custody: the pot note is the miner.
 */
export function coinbasePotIsCustodial(block, potNanos = BLOCK_SUBSIDY_NANOS) {
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const rest = pot - Math.floor(pot * POOL_FEE_BPS / 10000);
  if (!(rest > 0)) return false;
  const hasher = hasherNoteSet(block);
  if (!hasher.size) return false;
  for (const o of coinbaseVouts(block)) {
    const kind = String(o?.kind || 'pot');
    if (kind === 'hash' || kind === 'pool-fee' || kind === 'finder-fee' || kind === 'reserve-fee') continue;
    if (!o?.commit || !verifySealedNote(o, rest)) continue;
    let nc = '';
    try {
      const b = Buffer.from(asU8(o.noteCommit));
      if (b.length === 32) nc = b.toString('hex');
    } catch { nc = ''; }
    if (nc && !hasher.has(nc)) return true;
  }
  return false;
}

export function expectedCoinbasePays(shareBatch, {
  miner,
  poolDest,
  hashBonusNanos = HASH_BONUS_NANOS,
  potNanos = BLOCK_SUBSIDY_NANOS,
  custodialPot = false,
  feeDest = '',
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
  const pot = Math.max(0, Math.floor(Number(potNanos) || BLOCK_SUBSIDY_NANOS));
  const fee = pool ? Math.floor(pot * POOL_FEE_BPS / 10000) : 0;
  const rest = pot - fee;
  if (custodialPot && pool) {
    const poolNc = noteCommitOfDest20(hash20FromAddress(pool));
    pushPotPay(out, pool, rest, 'pot', poolNc);
    const fd = feeDest && isDestAddress(feeDest) ? feeDest : pool;
    if (fee > 0) {
      if (fd === pool) {
        const existing = out.find((s) => s.kind === 'pot' && s.address === pool);
        if (existing) existing.nanos += fee;
        else pushPotPay(out, pool, fee, 'pot', poolNc);
      } else {
        pushPotPay(out, fd, fee, 'pool-fee', noteCommitOfDest20(hash20FromAddress(fd)));
      }
    }
    return out;
  }
  const total = leaves.reduce((a, l) => a + l.count, 0);
  if (!total) {
    if (miner && isDestAddress(miner)) {
      out.push({ address: miner, nanos: pot, kind: 'pot' });
      const floor = unitsForShare() * hashBonusNanos;
      if (floor > 0) {
        out.push({
          address: miner,
          nanos: floor,
          kind: 'hash',
          noteCommit: noteCommitOfDest20(hash20FromAddress(miner)),
        });
      }
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

/** Rebuild hash/pot pays from Tree-A leaf counts when compact shareBatch dropped dests.
 * Custody is hash-only: the pot stays on the pool dest, not on hasher leaves. */
export function paysFromALeaves(aLeaves, {
  hashBonusNanos = HASH_BONUS_NANOS,
  custodialPot = false,
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
  if (custodialPot) return out;
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
  // Amount-only match paints pot-after-fee onto whichever hasher prop equals
  // the sealed pot (sole hasher → 0.99 SHE) even though the noteCommit is the pool.
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

function sameDest20(field, want) {
  if (!field || !want) return false;
  const raw = field.data || field;
  let buf;
  try { buf = Buffer.from(raw); } catch { return false; }
  return buf.length === want.length && buf.equals(Buffer.from(want));
}

/** Mature coinbase/hash nanos owned by dest when compact explorer `to` is empty. */
export function noteCommitSpendableNanos(blocks, address, tipHeight, {
  hashBonusNanos = HASH_BONUS_NANOS,
  need = SPENDABLE_CONFIRMATIONS,
  coinbaseOnly = false,
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
    const potNanos = Number(b.blockSubsidyNanos) || BLOCK_SUBSIDY_NANOS;
    const pool = custodyPoolDestOf(b, potNanos);
    const custodialPot = !!pool;
    const pays = [
      ...expectedCoinbasePays(b.shareBatch || [], {
        miner: b.miner,
        poolDest: pool,
        hashBonusNanos,
        potNanos,
        custodialPot,
        feeDest: custodialPot ? poolFeeDest() : '',
      }),
      ...paysFromALeaves(b.aLeaves || [], { hashBonusNanos, custodialPot }),
    ];
    for (const tx of b.txs || []) {
      if (coinbaseOnly && !tx?.coinbase) continue;
      for (const o of tx.vout || []) {
        const kind = String(o.kind || tx.kind || '');
        const byNote = !!(o.noteCommit && noteCommitEq(o.noteCommit, want));
        const byDest = kind === 'pool-withdraw' && sameDest20(o.dest20, dest20);
        if (!byNote && !byDest) continue;
        if (byNote) {
          const hex = noteCommitHex(o.noteCommit);
          if (hex && spent.has(hex)) continue;
        }
        let n = Number(o.nanos || 0);
        if (!tx.coinbase && !(n > 0)) {
          const sealedV = Math.floor(Number(
            o.valueProof?.v != null ? o.valueProof.v : (tx.nanos || 0),
          ));
          if (o.commit) {
            n = (sealedV > 0 && verifySealedNote(o, sealedV)) ? sealedV : 0;
          }
        }
        if (tx.coinbase) {
          const matched = matchSealedCoinbaseVout(o, pays);
          if (o.commit) {
            if (matched.nanos) n = matched.nanos;
            else {
              // Sealed match miss is fail-closed. Do not invent pot-after-fee
              // (0.99 SHE) or the whole-block hash sum.
              const sealedV = Math.floor(Number(o.valueProof?.v != null ? o.valueProof.v : 0));
              n = (sealedV > 0 && verifySealedNote(o, sealedV)) ? sealedV : 0;
            }
          } else {
            n = matched.nanos || 0;
          }
        }
        if (n > 0) nanos += n;
      }
    }
  }
  return nanos;
}

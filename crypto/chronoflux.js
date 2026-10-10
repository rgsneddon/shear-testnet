/**
 * Chronoflux on the chain (HASH_TX_LIVE=1, collate O(miners)):
 *   Continuum  ∇·J = 0  spendable is conserved; the hash list is not the money
 *   Flow       J^μ      this round's hashes, collated per hasher (never one JSON row per hash)
 *   Resistance η        confirmations; at 1000, Flow *samples* may be dropped
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
import { createHash } from 'node:crypto';
import { SPENDABLE_CONFIRMATIONS, SAMPLE_PRUNE_CONFIRMATIONS, HASH_BONUS_NANOS, BLOCK_SUBSIDY_NANOS } from './asert.js';
import { packShareBatchBytes } from './pack.js';
import { expectedCoinbasePays, matchSealedCoinbaseVout, paysFromALeaves, custodyPoolDestOf, coinbasePotIsCustodial, openedCoinbaseNanos } from './coinbase_notes.js';
import { poolFeeDest } from './levy.js';
import { verifySealedNote, asU8, canonicalSpendTag, txSpendTags } from './note.js';
import { hash20FromAddress } from './address.js';
import { canonicalReserveFields } from './reserve_vault.js';
import { compactHashLedger, packHashCreditBytes } from './hash_owed.js';

export { SAMPLE_PRUNE_CONFIRMATIONS, SPENDABLE_CONFIRMATIONS };

/** Confirmations of a sealed height, counting the including block as 1. */
export function flowConfirmations(blockHeight, tipHeight) {
  const h = Number(blockHeight) || 0;
  const tip = Number(tipHeight) || 0;
  if (h < 1 || tip < h) return 0;
  return tip - h + 1;
}

/** Consensus spendable after 9 confirmations (`SPENDABLE_CONFIRMATIONS`). */
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

/** Share-batch RandomX may skip only after 1000 conf AND samplesPruned. A peer flag is not enough. */
export function flowSkipAllowed(block, tipHeight) {
  const h = Number(block?.height || 0);
  return shouldPruneSamples(h, tipHeight) && !!block?.samplesPruned;
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
    shareBatch: [],
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
const _sealedRowCache = new Map();

export function sealedExplorerRows(block) {
  const height = Number(block?.height || 0);
  const hid = Buffer.isBuffer(block?.hash)
    ? block.hash.toString('hex')
    : String(block?.hash || height);
  const cached = hid && _sealedRowCache.get(hid);
  if (cached) return cached;
  const rows = [];
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const cb = txs[0];
  if (cb?.coinbase && Array.isArray(cb.vout)) {
    const potNanos = Number(block.blockSubsidyNanos) || BLOCK_SUBSIDY_NANOS;
    // poolDest is not stored on chain.bin or the wire. A pot note that is not a
    // hasher leaf is custody even when dest20 was stripped, so Tree-A must not PROP.
    const custodyDest = custodyPoolDestOf(block, potNanos);
    const custodialPot = !!custodyDest || coinbasePotIsCustodial(block, potNanos);
    let pays = expectedCoinbasePays(block.shareBatch || [], custodialPot && custodyDest ? {
      miner: block.miner,
      poolDest: custodyDest,
      hashBonusNanos: HASH_BONUS_NANOS,
      potNanos,
      custodialPot: true,
      feeDest: poolFeeDest(),
    } : {
      miner: block.miner,
      poolDest: poolFeeDest(),
      hashBonusNanos: HASH_BONUS_NANOS,
      potNanos,
    });
    const paysBound = (pays || []).some((p) => {
      try {
        return p.nanos && p.noteCommit && Buffer.from(p.noteCommit).length === 32;
      } catch {
        return false;
      }
    });
    if (custodialPot) {
      // Drop solo pot props. paysFromALeaves would put pot-after-fee on hasher leaves
      // whenever sealedPotIsCustody missed (no stored poolDest).
      const feeDest = poolFeeDest();
      pays = (pays || []).filter((p) => {
        const k = p.kind || 'pot';
        if (k === 'hash') return true;
        if (!custodyDest) return false;
        return p.address === custodyDest || p.address === feeDest;
      });
      const hashOnly = paysFromALeaves(block.aLeaves || [], {
        hashBonusNanos: HASH_BONUS_NANOS,
        custodialPot: true,
      });
      if (hashOnly.length) pays = [...pays, ...hashOnly];
    } else if (!paysBound) {
      const recovered = paysFromALeaves(block.aLeaves || [], { hashBonusNanos: HASH_BONUS_NANOS });
      if (recovered.length) pays = [...pays, ...recovered];
    }
    cb.vout.forEach((o, i) => {
      const hit = matchSealedCoinbaseVout(o, pays);
      const toDest20 = dest20Buf(o.dest20) || (hit.address ? dest20Buf(hash20FromAddress(hit.address)) : null);
      const claimed = Number(o.valueProof?.v != null ? o.valueProof.v : (o.nanos || 0));
      let nanos = hit.nanos || claimed;
      if (o.commit) {
        const sealedV = Math.floor(Number(o.valueProof?.v != null ? o.valueProof.v : 0));
        if (hit.nanos && verifySealedNote(o, hit.nanos)) nanos = hit.nanos;
        else if (sealedV > 0 && verifySealedNote(o, sealedV)) nanos = sealedV;
        else nanos = openedCoinbaseNanos(o, potNanos);
      }
      rows.push({
        id: `${hid}-${o.kind || 'cb'}-${i}`,
        kind: o.kind === 'hash' ? 'hash' : (o.kind === 'lock' || o.kind === 'vote' || o.kind === 'withdraw' ? o.kind : 'coinbase'),
        from: 'coinbase',
        to: hit.address || o.address || '',
        nanos,
        height,
        confirmed: true,
        noteCommit: o.noteCommit,
        toDest20: toDest20 || undefined,
      });
    });
  }
  for (const tx of txs.slice(1)) {
    const from = tx.from || tx.vin?.[0]?.address || '';
    const fromDest20 = tx.vin?.[0]?.dest20;
    const txId = tx.id || `${hid}-tx`;
    const vouts = Array.isArray(tx.vout) && tx.vout.length
      ? tx.vout
      : [{
          address: tx.to,
          nanos: Number(tx.nanos || 0),
          kind: tx.kind || (tx.mint ? 'reserve' : 'transfer'),
          memoCt: tx.memoCt,
        }];
    for (let i = 0; i < vouts.length; i += 1) {
      const o = vouts[i];
      const kind = o.kind || tx.kind || (tx.mint ? 'reserve' : 'transfer');
      const to = o.address || (i === 0 ? tx.to : '');
      const claimed = Number(o.valueProof?.v != null ? o.valueProof.v : (o.nanos != null ? o.nanos : (
        String(o.kind || '') === 'dummy' ? 0
          : (i === 0 ? tx.nanos || 0 : tx.changeNanos || 0)
      )));
      const nanos = o.commit
        ? (verifySealedNote(o, claimed) ? claimed : 0)
        : claimed;
      rows.push({
        id: `${txId}-vout-${i}`,
        kind,
        from,
        to: kind === 'burn' ? '' : to,
        nanos,
        height,
        confirmed: true,
        memo: !!(tx.memoCt || o.memoCt),
        memoCt: tx.memoCt || o.memoCt,
        noteCommit: o.noteCommit,
        fromDest20,
        toDest20: o.dest20,
      });
    }
    const fee = Math.floor(Number(tx.fee || 0));
    const kind0 = tx.kind || vouts[0]?.kind || (tx.mint ? 'reserve' : 'transfer');
    if (fee > 0) {
      const levyFrom = kind0 === 'vote'
        ? String(tx.payer || tx.vin?.[0]?.address || '')
        : String(from || '');
      if (levyFrom || fromDest20) {
        rows.push({
          id: `${txId}-levy`,
          kind: 'levy',
          from: levyFrom,
          to: '',
          nanos: fee,
          height,
          confirmed: true,
          fromDest20,
        });
      }
    }
  }
  if (hid) _sealedRowCache.set(hid, rows);
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
    if (tx?.coinbase) {
      const { samples, ...rest } = tx;
      return compactTx({ ...rest, coinbase: true });
    }
    return compactTx(tx);
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

const SEALED_SECRET_KEYS = new Set([
  'open',
  'portalOpen',
  'viewKey',
  'view',
  'V',
  'C',
  'closure',
  'closureCommit',
  'paymentCode',
  'scanPub',
  'spendHash20',
  'seed',
  'seedHex',
  'privateKey',
  'ip',
  'remoteAddress',
  'peerIp',
  'userAgent',
  'user-agent',
  'ua',
  'memoPlain',
  'login',
  'spendPub',
  'r',
  't',
  '_origCommit',
  '_origNoteCommit',
]);

function compactValue(v) {
  if (v == null || typeof v !== 'object' || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return v.map(compactValue);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (SEALED_SECRET_KEYS.has(k)) continue;
    out[k] = compactValue(val);
  }
  return out;
}

const RESERVE_TX_KINDS = new Set(['lock', 'vote', 'withdraw']);

function dest20Buf(x) {
  if (x == null || x === '') return null;
  try {
    const b = Buffer.from(asU8(x));
    if (b.length >= 20) return Buffer.from(b.subarray(0, 20));
  } catch { /* ignore */ }
  return null;
}

function dest20FromOpen(o) {
  const owned = dest20Buf(o?.dest20);
  if (owned) return owned;
  if (!o?.address) return null;
  const h = hash20FromAddress(o.address);
  return h ? Buffer.from(h) : null;
}

function portalIdFromOpen(o) {
  if (o?.portalId) return o.portalId;
  const dest = String(o?.address || '');
  if (!dest) return '';
  return createHash('sha256').update('shear-portal-v1').update(dest).digest('hex');
}

function claimedReserveV(o) {
  if (o?.valueProof?.v != null) return Math.floor(Number(o.valueProof.v));
  if (o?.nanos != null) return Math.floor(Number(o.nanos));
  return 0;
}

function attachReserveSeal(row, o) {
  const d20 = dest20FromOpen(o);
  if (d20) row.dest20 = d20;
  const portalId = portalIdFromOpen(o);
  if (portalId) row.portalId = portalId;
  const v = claimedReserveV(o);
  if (o?.valueProof) row.valueProof = compactValue(o.valueProof);
  if (Number.isFinite(v) && v !== 0) {
    row.valueProof = { ...(row.valueProof || {}), v };
  }
}

const COINBASE_OPEN_KINDS = new Set(['pot', 'hash', 'pool-fee', 'finder-fee', 'reserve-fee']);

/** A public receipt may carry {R,z,v}. A hidden output, including one labelled as a public kind, may not. */
export function outputMayCarryValueOpen(tx, o) {
  if (!o || typeof o !== 'object') return false;
  const kind = o.kind == null || o.kind === '' ? '' : String(o.kind);
  if (tx?.coinbase || String(tx?.kind || '') === 'coinbase') return COINBASE_OPEN_KINDS.has(kind);
  const top = tx?.kind == null ? '' : String(tx.kind);
  // b-spend is a public mint receipt: the opened sum is the chain leaf.
  if (top === 'lock' || top === 'vote' || top === 'withdraw' || top === 'pool-withdraw' || top === 'b-spend') return kind === top;
  // A dummy is publicly zero. That opening is not an amount. Any other value stays hidden.
  if (kind === 'dummy') {
    const v = o?.valueProof?.v;
    return v === 0 || v === 0n;
  }
  return false;
}

function carriesValueOpen(o) {
  const vp = o?.valueProof;
  if (vp == null || vp === false || vp === '') return false;
  if (typeof vp !== 'object') return true;
  return Object.keys(vp).length > 0;
}

/** Hidden outputs reject a valueProof. The range proof stays. Reason value_open. */
export function valueOpenRejected(tx) {
  if (!tx || typeof tx !== 'object') return null;
  const outs = Array.isArray(tx.vout) ? tx.vout : [];
  for (const o of outs) {
    if (!carriesValueOpen(o)) continue;
    if (outputMayCarryValueOpen(tx, o)) continue;
    return { ok: false, reason: 'value_open' };
  }
  return null;
}

function compactVout(o, tx) {
  if (!o) return o;
  const posted = o.kind == null || o.kind === '' ? '' : String(o.kind);
  const kind = posted || 'pot';
  const keepDest = kind === 'vortice-register';
  const reserveKind = RESERVE_TX_KINDS.has(posted);
  const coinbaseMoney = COINBASE_OPEN_KINDS.has(posted);
  const keepOpen = outputMayCarryValueOpen(tx, o);
  if (o.commit) {
    const row = {
      kind,
      noteCommit: o.noteCommit,
      commit: o.commit,
    };
    if (keepOpen && o.valueProof) row.valueProof = o.valueProof;
    if (o.rangeProof) row.rangeProof = o.rangeProof;
    if (o.viewTag) row.viewTag = o.viewTag;
    if (o.admitPub) row.admitPub = o.admitPub;
    if (o.rEph) row.rEph = o.rEph;
    if (o.rCt) row.rCt = o.rCt;
    if (o.dest20) row.dest20 = o.dest20;
    if (o.portalId) row.portalId = o.portalId;
    if (reserveKind || coinbaseMoney) {
      const d20 = dest20FromOpen(o);
      if (d20) row.dest20 = d20;
      if (keepOpen && coinbaseMoney && o.valueProof?.v != null) {
        row.valueProof = { ...(row.valueProof && typeof row.valueProof === 'object' ? compactValue(o.valueProof) : {}), v: Math.floor(Number(o.valueProof.v)) };
      }
      if (keepOpen && reserveKind) attachReserveSeal(row, o);
    }
    if (o.memo) row.memo = true;
    if (keepDest && o.address) row.address = o.address;
    return row;
  }
  const row = { kind };
  const d20 = dest20FromOpen(o);
  if (d20) row.dest20 = d20;
  if (o.noteCommit) row.noteCommit = o.noteCommit;
  if (keepOpen) {
    const claimed = claimedReserveV(o);
    if (Number.isFinite(claimed)) {
      row.valueProof = { ...(o.valueProof && typeof o.valueProof === 'object' ? compactValue(o.valueProof) : {}), v: claimed };
    }
    if (reserveKind) attachReserveSeal(row, o);
  }
  if (keepDest && o.address) row.address = o.address;
  if (o.memo) row.memo = true;
  return row;
}

/** Spent-note link fields are forbidden on sealed Flow vin (C̃-only). */
export function sealedVinLinkField(v) {
  if (!v || typeof v !== 'object' || v.coinbase) return null;
  if (v.prev != null && v.prev !== '') return 'prev';
  if (v.index != null && v.index !== '') return 'index';
  if (v.noteCommit != null && v.noteCommit !== '') return 'noteCommit';
  return null;
}

/** Strip a tx down to the sealed fields. No openings, view material, IP, or memo plaintext. */
export function compactTx(tx) {
  if (!tx) return tx;
  if (tx.coinbase) {
    const row = {
      coinbase: true,
      height: tx.height,
      vin: [{ coinbase: true, height: tx.height }],
      vout: (tx.vout || []).map((o) => compactVout(o, tx)),
    };
    if (tx.excess) row.excess = tx.excess;
    if (tx.jroot) row.jroot = tx.jroot;
    const carry = Math.floor(Number(tx.carryNanos) || 0);
    if (Number.isSafeInteger(carry) && carry > 0) row.carryNanos = carry;
    compactHashLedger(tx, row);
    return row;
  }
  const out = compactValue(tx);
  delete out.samples;
  const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
  const keepDest = kind === 'vortice-register';
  const reserveTx = RESERVE_TX_KINDS.has(kind);
  const reserveFields = reserveTx ? canonicalReserveFields(tx) : null;
  const poolWithdraw = kind === 'pool-withdraw';
  delete out.nanos;
  delete out.changeNanos;
  delete out.amount;
  if (!keepDest) {
    delete out.from;
    delete out.to;
    delete out.payer;
    delete out.sponsor;
  }
  if (tx.vin) {
    out.vin = (tx.vin || []).map((v) => {
      if (v?.coinbase) return compactValue({ coinbase: true, height: v.height });
      const commit = v.pseudo || v.cTilde || v.commit;
      const row = {};
      if (commit != null && commit !== '') row.commit = compactValue(commit);
      if (keepDest && v.address) row.address = v.address;
      if (reserveTx || poolWithdraw) {
        if (v.dest20) row.dest20 = v.dest20;
        else {
          const h = hash20FromAddress(v.address || (poolWithdraw ? tx.from : ''));
          if (h) row.dest20 = Buffer.from(h);
        }
      }
      return row;
    });
  }
  if (tx.vout) out.vout = (tx.vout || []).map((o) => compactVout(o, tx));
  if (tx.sig) out.sig = tx.sig;
  if (tx.signature && !out.sig) out.sig = tx.signature;
  // The owner signature is checked on the sealed body. A b-spend keeps spendPub.
  if ((keepDest || poolWithdraw || reserveTx || kind === 'b-spend') && tx.spendPub) out.spendPub = tx.spendPub;
  if (tx.memoCt || tx.memo) out.memo = true;
  if (tx.admit_proof) {
    if (tx.admit_proof.blob || tx.admit_proof.v === 2 || tx.admit_proof.v === 3) {
      let ver = 2;
      try {
        const blob = Buffer.from(asU8(tx.admit_proof.blob || []));
        if (blob.length > 0 && blob[0] === 3) ver = 3;
      } catch { /* a blob that is not bytes stays a version-2 label */ }
      out.admit_proof = {
        admit_proof: true,
        v: ver,
        spendTag: tx.admit_proof.spendTag,
        blob: tx.admit_proof.blob,
        cTilde: tx.admit_proof.cTilde,
      };
    } else {
      out.admit_proof = {
        admit_proof: true,
        spendTag: tx.admit_proof.spendTag,
        c0: tx.admit_proof.c0,
        r: tx.admit_proof.r,
      };
    }
    delete out.admit_proof.members;
    delete out.members;
  }
  if (tx.spendTag) out.spendTag = tx.spendTag;
  // A present JSON tag is replaced by the blob tag, so a lie does not survive.
  // An absent tag stays absent. txDigestV3 binds that field, and filling it
  // in after the proof would make the sealed body fail on reload.
  try {
    const fieldWasPosted = (value) => value != null && value !== '';
    if (out.admit_proof) {
      const one = canonicalSpendTag(tx.admit_proof);
      if (fieldWasPosted(tx.admit_proof.spendTag) && one.tag) out.admit_proof.spendTag = one.tag;
      else if (!fieldWasPosted(tx.admit_proof.spendTag)) delete out.admit_proof.spendTag;
    }
    if (Array.isArray(out.admit_proofs) && Array.isArray(tx.admit_proofs)) {
      out.admit_proofs = out.admit_proofs.map((proof, i) => {
        const src = tx.admit_proofs[i] || proof;
        const one = canonicalSpendTag(src);
        if (!one.tag || !proof || typeof proof !== 'object') return proof;
        if (!fieldWasPosted(src.spendTag)) {
          const next = { ...proof };
          delete next.spendTag;
          return next;
        }
        return { ...proof, spendTag: one.tag };
      });
    }
    const parsed = txSpendTags(tx);
    if (fieldWasPosted(tx.spendTag) && parsed.tags.length) out.spendTag = parsed.tags[0];
    else if (!fieldWasPosted(tx.spendTag)) delete out.spendTag;
  } catch { /* compact must not throw on a fixture */ }
  if (tx.jroot) out.jroot = tx.jroot;
  if (tx.excess) out.excess = tx.excess;
  if (reserveFields) {
    if (reserveFields.portalId) out.portalId = reserveFields.portalId;
    if (reserveFields.payoutPortalId) out.payoutPortalId = reserveFields.payoutPortalId;
    if (reserveFields.programId) out.programId = reserveFields.programId;
    if (reserveFields.kind === 'vote') out.choice = reserveFields.choice;
  }
  return out;
}

/**
 * Mempool relay. Sealed compact drops spendPub; admit still has to verify it.
 * Openings stay off the wire.
 */
export function admitWireTx(tx) {
  const wire = compactTx(tx);
  if (!wire || typeof wire !== 'object' || wire.coinbase) return wire;
  if (tx?.spendPub && !wire.spendPub) {
    wire.spendPub = typeof tx.spendPub === 'string'
      ? tx.spendPub
      : Buffer.from(tx.spendPub).toString('hex');
  }
  return wire;
}

/**
 * On-disk chain row: header + sealed txs + (until prune) collated samples.
 * Never persist one JSON object per hash, template objects, or Buffer dumps.
 */
export function compactChainBlock(block) {
  const samplesPruned = !!block.samplesPruned;
  const bLeavesPruned = !!block.bLeavesPruned || samplesPruned;
  const row = {
    magic: block.magic,
    height: block.height,
    miner: block.miner,
    samplesPruned,
    bLeavesPruned,
    samples: samplesPruned ? [] : collateSamples(block.samples || []),
    aLeaves: (Array.isArray(block.aLeaves) ? block.aLeaves : []).map((l) => ({
      noteCommit: l.noteCommit,
      count: Number(l.count) || 0,
    })),
    bLeaves: bLeavesPruned ? [] : (Array.isArray(block.bLeaves) ? block.bLeaves : []),
    rootA: block.rootA,
    rootB: block.rootB,
    weight: Number(block.weight || 0),
    txs: (block.txs || []).map(compactTx),
    sharePacked: packShareBatchBytes(block.shareBatch || []).toString('hex'),
  };
  if (Array.isArray(block.hashCredits)) {
    row.hashCreditPacked = packHashCreditBytes(block.hashCredits).toString('hex');
  }
  return row;
}

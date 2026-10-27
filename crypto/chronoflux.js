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
import { verifySealedNote, asU8, canonicalSpendTag, txSpendTags, AMOUNT_CT_BYTES, noteCommitOfDest20 } from './note.js';
import { encodeDest, hash20FromAddress } from './address.js';
import { memoEnvelopeRejected } from './flow_sheet.js';
import { canonicalReserveFields, reserveRowNanos } from './reserve_vault.js';
import { compactHashLedger, freshCreditsFromShares, packHashCreditBytes } from './hash_owed.js';

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
  const spillCredits = Array.isArray(block.hashSpillCredits)
    ? block.hashSpillCredits
    : (Array.isArray(block.hashSpill) && block.hashSpill.length
      ? freshCreditsFromShares(block.hashSpill)
      : null);
  const next = {
    ...block,
    samples: [],
    shareBatch: [],
    hashSpill: [],
    bLeaves: [],
    samplesPruned: true,
    bLeavesPruned: true,
    txs: nextTxs,
  };
  if (spillCredits && spillCredits.length) next.hashSpillCredits = spillCredits;
  return next;
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
      let recovered = '';
      if (!hit.address && !o.address && toDest20) {
        try {
          // Display only, same gate as coinbase_notes.js: a dest20 label needs a
          // 32-byte noteCommit that is that dest. Missing or short commits stay blank.
          // Off the payout schedule this string is a declared dest, not proof of payee.
          const nc = Buffer.from(asU8(o.noteCommit));
          if (nc.length === 32 && nc.equals(noteCommitOfDest20(toDest20))) {
            recovered = encodeDest(toDest20);
          }
        } catch { recovered = ''; }
      }
      const to = hit.address || o.address || recovered;
      rows.push({
        id: `${hid}-${o.kind || 'cb'}-${i}`,
        kind: o.kind === 'hash' ? 'hash' : (o.kind === 'lock' || o.kind === 'vote' || o.kind === 'withdraw' ? o.kind : 'coinbase'),
        from: 'coinbase',
        to,
        ...(recovered ? { toDeclared: true } : {}),
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

/**
 * Every byte view in a compact body as a Buffer. JSON writes a bare
 * Uint8Array as an object of indices, so without this a block read back from
 * disk would carry other bytes than the block that was validated.
 */
function viewsAsBuffers(v) {
  if (v == null || typeof v !== 'object' || Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return v.map(viewsAsBuffers);
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = viewsAsBuffers(x);
  return out;
}

function compactValue(v) {
  if (v == null || typeof v !== 'object' || Buffer.isBuffer(v)) return v;
  // Bytes, not an object of indices: JSON and the body digest read a Buffer.
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return v.map(compactValue);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (SEALED_SECRET_KEYS.has(k)) continue;
    out[k] = compactValue(val);
  }
  return out;
}

const RESERVE_TX_KINDS = new Set(['lock', 'vote', 'withdraw', 'reward-claim']);

/**
 * Top-level keys a sealed body tx may carry, from the signed body list in
 * spend.js. Anything else, including nanos, amount, and changeNanos, is not
 * copied. A key outside the signed list is already `unsigned` at admission.
 * Retire and principal proofs are not in txDigestV3. They still have to
 * ride on the sealed withdraw: the owner signature binds the retire blob,
 * and the vault opens the leaf from that same blob.
 */
export const COMPACT_TX_KEYS = Object.freeze([
  'id', 'kind', 'from', 'to', 'fee', 'vin', 'vout', 'sig', 'signature',
  'memo', 'memoH', 'memoCt', 'bFlag', 'bExtra', 'unit', 'nonce', 'tag', 'dest20',
  'portalId', 'payoutPortalId', 'programId', 'choice', 'rewardSig', 'ownerPub', 'piProof',
  // remainCommit is kept only so a block naming it is refused (spend.js
  // remainderLockField) rather than scrubbed into another body.
  'vaultLockNote', 'remainCommit', 'vaultProof', 'earnEpoch', 'rootEpoch', 'capProof',
  'retireProof', 'retireProofs', 'principalProof', 'principalProofs',
  'voteProof', 'voteProofs', 'voteSeq', 'voteParam', 'voteOutput',
  'admit_proof', 'admit_proofs', 'spendTag', 'members', 'fs1',
  'excess', 'jroot', 'height', 'mint', 'version', 'anchor', 'maxLevy', 'nowMs', 'withdrawNonce',
  'weight', 'payer', 'sponsor',
  'commitHeight', 'index', 'leaf', 'proof', 'commitHeader', 'commitRootA', 'commitRootB',
  'nullifier',
]);

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
  // The carried id only. An address is not an input, so compact cannot
  // recompute portalId from dest20 or from the public address.
  const pid = String(o?.portalId || '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(pid) ? pid : '';
}

/**
 * The amount a reserve row publishes, read as consensus reads it
 * (reserve_vault.js reserveRowNanos): its valueProof.v, or its nanos only on
 * a row with no commitment. A nanos beside a commitment is a hidden amount
 * in clear: compaction strips it and never turns it into an opening.
 */
function claimedReserveV(o) {
  const raw = reserveRowNanos(o);
  return raw == null ? 0 : Math.floor(Number(raw));
}

function attachLockTime(row, o) {
  if (String(o?.kind || row?.kind || '') !== 'lock') return;
  const unlock = Number(o?.unlockAtMs);
  if (Number.isInteger(unlock) && unlock > 0) row.unlockAtMs = unlock;
  if (o?.lockEpoch != null && o.lockEpoch !== '' && Number.isInteger(Number(o.lockEpoch)) && Number(o.lockEpoch) >= 0) {
    row.lockEpoch = Number(o.lockEpoch);
  }
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
  attachLockTime(row, o);
}

const COINBASE_OPEN_KINDS = new Set(['pot', 'hash', 'pool-fee', 'finder-fee', 'reserve-fee']);

/** A public receipt may carry {R,z,v}. A hidden output, including one labelled as a public kind, may not. */
export function outputMayCarryValueOpen(tx, o) {
  if (!o || typeof o !== 'object') return false;
  const kind = o.kind == null || o.kind === '' ? '' : String(o.kind);
  if (tx?.coinbase || String(tx?.kind || '') === 'coinbase') return COINBASE_OPEN_KINDS.has(kind);
  const top = tx?.kind == null ? '' : String(tx.kind);
  // b-spend is a public mint receipt: the opened sum is the chain leaf.
  if (top === 'lock' || top === 'vote' || top === 'withdraw' || top === 'reward-claim' || top === 'pool-withdraw' || top === 'b-spend') return kind === top;
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

/**
 * Plaintext amount keys. A hidden output carries none of them, present or
 * empty. The amount is C, the range proof, and amtCt to the dest.
 */
export const OUTPUT_AMOUNT_KEYS = Object.freeze(['nanos', 'amount', 'v', 'value']);
/** Top-level amount hints. A hidden-kind tx carries none of them. */
export const TX_AMOUNT_KEYS = Object.freeze(['nanos', 'amount', 'changeNanos']);
/** Kinds whose outputs are hidden. Reserve, pool-withdraw, b-spend, and coinbase are public-amount by design. */
const HIDDEN_TX_KINDS = new Set(['', 'send', 'transfer', 'change', 'dummy']);
export const HIDDEN_WRAP_KEYS = Object.freeze(['rEph', 'rCt', 'amtCt']);
/** Dummies go to a random dest with no admit base; they stay publicly zero instead. */
const WRAPPED_OUTPUT_KINDS = new Set(['', 'send', 'transfer', 'change']);

function hasKey(o, k) {
  return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
}

function hiddenAmountTx(tx) {
  if (!tx || tx.coinbase || String(tx.kind || '') === 'coinbase') return false;
  const kind = tx.kind == null ? String(tx.vout?.[0]?.kind || '') : String(tx.kind);
  return HIDDEN_TX_KINDS.has(kind);
}

/**
 * AL-1. A hidden output, or a hidden-kind tx, that names its amount in clear
 * is amount_field. A coinbase output with a commitment carries no nanos or
 * amount beside it. amtCt, when present, is exactly AMOUNT_CT_BYTES.
 */
export function amountFieldRejected(tx) {
  if (!tx || typeof tx !== 'object') return null;
  const coinbase = !!(tx.coinbase || String(tx.kind || '') === 'coinbase');
  if (!coinbase && hiddenAmountTx(tx)) {
    for (const k of TX_AMOUNT_KEYS) {
      if (hasKey(tx, k)) return { ok: false, reason: 'amount_field' };
    }
  }
  const outs = Array.isArray(tx.vout) ? tx.vout : [];
  for (const o of outs) {
    if (!o || typeof o !== 'object') continue;
    if (hasKey(o, 'amtCt')) {
      let n = -1;
      try { n = Buffer.from(asU8(o.amtCt)).length; } catch { n = -1; }
      if (n !== AMOUNT_CT_BYTES) return { ok: false, reason: 'amount_ct' };
    }
    if (coinbase) {
      if (o.commit && (hasKey(o, 'nanos') || hasKey(o, 'amount'))) return { ok: false, reason: 'amount_field' };
      continue;
    }
    if (outputMayCarryValueOpen(tx, o)) continue;
    if (!hiddenAmountTx(tx) && !o.commit) continue;
    for (const k of OUTPUT_AMOUNT_KEYS) {
      if (hasKey(o, k)) return { ok: false, reason: 'amount_field' };
    }
    // A hidden output is spendable and readable only by its dest: rEph, rCt, and amtCt are required.
    if (hiddenAmountTx(tx) && o.commit && WRAPPED_OUTPUT_KINDS.has(String(o.kind || ''))) {
      for (const k of HIDDEN_WRAP_KEYS) {
        if (!hasKey(o, k) || o[k] === '') return { ok: false, reason: 'amount_ct', field: k };
      }
    }
  }
  return null;
}

/** Hidden outputs reject a valueProof (value_open) and any plaintext amount field (amount_field). */
export function valueOpenRejected(tx) {
  if (!tx || typeof tx !== 'object') return null;
  const outs = Array.isArray(tx.vout) ? tx.vout : [];
  for (const o of outs) {
    if (!carriesValueOpen(o)) continue;
    if (outputMayCarryValueOpen(tx, o)) continue;
    return { ok: false, reason: 'value_open' };
  }
  return amountFieldRejected(tx) || reserveNanosRejected(tx) || memoCtRejected(tx);
}

/**
 * A lock or withdraw names its amount only on its reserve output. A
 * top-level nanos is a plaintext copy the compact body drops: it must equal
 * that output's public opening, and with a hidden output (a commit and no
 * opening) it must be absent, so a hidden amount never travels in clear.
 */
export function reserveNanosRejected(tx) {
  if (!tx || typeof tx !== 'object' || tx.coinbase) return null;
  const kind = String(tx.kind || '');
  if (kind !== 'lock' && kind !== 'withdraw') return null;
  if (!hasKey(tx, 'nanos')) return null;
  const outs = Array.isArray(tx.vout) ? tx.vout : [];
  const o = outs.find((row) => String(row?.kind || '') === kind);
  const opened = reserveRowNanos(o);
  if (opened == null) return { ok: false, reason: 'amount_field' };
  let same = false;
  try { same = BigInt(String(tx.nanos)) === BigInt(String(opened)); } catch { same = false; }
  return same ? null : { ok: false, reason: 'amount_field' };
}

/**
 * A memo envelope sits only at the top level, in the fixed slot size
 * (flow_sheet.js). An output memoCt is refused: it would mark which output
 * is the payee's (Russell 26 Oct).
 */
export function memoCtRejected(tx) {
  if (!tx || typeof tx !== 'object') return null;
  for (const o of Array.isArray(tx.vout) ? tx.vout : []) {
    if (o && typeof o === 'object' && o.memoCt != null) return { ok: false, reason: 'memo_output' };
  }
  if (tx.memoCt == null) return null;
  const reason = memoEnvelopeRejected(tx.memoCt);
  return reason ? { ok: false, reason } : null;
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
    if (o.fundProof) row.fundProof = compactValue(o.fundProof);
    if (o.viewTag) row.viewTag = o.viewTag;
    if (o.admitPub) row.admitPub = o.admitPub;
    if (o.rEph) row.rEph = o.rEph;
    if (o.rCt) row.rCt = o.rCt;
    if (o.amtCt) row.amtCt = o.amtCt;
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

function vinBytes(raw) {
  try {
    if (raw == null || raw === '') return null;
    return Buffer.from(asU8(raw));
  } catch {
    return null;
  }
}

/**
 * dest20, prev, and index that spendPackDigest hashes for one vin.
 * Address is not sealed: the digest already folded it into dest20.
 * A second compactTx must hash the same bytes.
 */
function bSpendDigestDest20(v) {
  const nc = vinBytes(v?.noteCommit);
  let d20 = nc && nc.length === 32 ? Buffer.from(nc.subarray(0, 20)) : null;
  if (!d20) {
    const field = vinBytes(v?.dest20);
    d20 = field && field.length >= 20 ? Buffer.from(field.subarray(0, 20)) : Buffer.alloc(20);
  }
  if (d20.every((b) => b === 0)) {
    const h = hash20FromAddress(v?.address || '');
    if (h) d20 = Buffer.from(h);
  }
  return d20;
}

const VIN_INDEX_MAX = 0xffffffff;

/** Integer in 0..2^32-1. Index 0 stays 0. A string, a float, and a boolean are not. */
function canonicalVinIndex(raw) {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || raw > VIN_INDEX_MAX) return null;
    return raw;
  }
  if (typeof raw === 'bigint') {
    if (raw < 0n || raw > BigInt(VIN_INDEX_MAX)) return null;
    return Number(raw);
  }
  return null;
}

function fieldPosted(raw) {
  return raw != null && raw !== '';
}

/** Why this b-spend vin is not sealable. Null when the posted link fields are canonical. */
function bSpendVinFieldRejected(v) {
  if (!v || typeof v !== 'object') return null;
  const notePosted = fieldPosted(v.noteCommit);
  const destPosted = fieldPosted(v.dest20);
  if (notePosted) {
    const nc = vinBytes(v.noteCommit);
    if (!nc || nc.length !== 32) return 'noteCommit';
    if (destPosted) return 'dest20';
  }
  if (fieldPosted(v.prev)) {
    const prev = vinBytes(v.prev);
    if (!prev || prev.length !== 32) return 'prev';
  }
  if (fieldPosted(v.index) && canonicalVinIndex(v.index) == null) return 'index';
  return null;
}

/**
 * Admission of a b-spend vin. Index must be an integer in 0..2^32-1.
 * prev and noteCommit must be 32 bytes. dest20 beside noteCommit is refused.
 * A missing field stays missing. The reason matches the body vin_link gate.
 */
export function bSpendVinRejected(tx) {
  if (!tx || tx.coinbase) return null;
  const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
  if (kind !== 'b-spend') return null;
  const vins = Array.isArray(tx.vin) ? tx.vin : [];
  for (const v of vins) {
    if (bSpendVinFieldRejected(v)) return { ok: false, reason: 'vin_link' };
  }
  return null;
}

function sealBSpendVin(v) {
  if (bSpendVinFieldRejected(v)) return null;
  const commit = v?.pseudo || v?.cTilde || v?.commit;
  const row = {};
  if (commit != null && commit !== '') row.commit = compactValue(commit);
  const notePosted = fieldPosted(v?.noteCommit);
  if (notePosted) {
    row.noteCommit = vinBytes(v.noteCommit);
  } else {
    const d20 = bSpendDigestDest20(v || {});
    if (d20.length === 20 && !d20.every((b) => b === 0)) row.dest20 = d20;
  }
  if (fieldPosted(v?.prev)) row.prev = vinBytes(v.prev);
  if (fieldPosted(v?.index)) row.index = canonicalVinIndex(v.index);
  return row;
}

/** A refused vin is copied uncoerced, so the sealed body still fails admission. */
function unsealedBSpendVin(v) {
  const row = {};
  const commit = v?.pseudo || v?.cTilde || v?.commit;
  if (commit != null && commit !== '') row.commit = compactValue(commit);
  if (fieldPosted(v?.noteCommit)) row.noteCommit = v.noteCommit;
  if (fieldPosted(v?.dest20)) row.dest20 = v.dest20;
  if (fieldPosted(v?.prev)) row.prev = v.prev;
  if (fieldPosted(v?.index)) row.index = v.index;
  return row;
}

function hex32Field(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return '';
  return value.toLowerCase();
}

function compactEpochStarts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const epoch = Math.floor(Number(item?.epoch));
    const root = hex32Field(item?.root);
    if (!Number.isInteger(epoch) || epoch < 0 || !root) continue;
    out.push({ epoch, root });
  }
  return out;
}

function compactEpochCensus(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const epoch = Math.floor(Number(item?.epoch));
    const leafCount = Math.floor(Number(item?.leafCount));
    const openHeight = Math.floor(Number(item?.openHeight));
    if (!Number.isInteger(epoch) || epoch < 0) continue;
    if (!Number.isInteger(leafCount) || leafCount < 1) continue;
    if (!Number.isInteger(openHeight) || openHeight < 0) continue;
    out.push({ epoch, leafCount, openHeight });
  }
  return out;
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
    if (Array.isArray(tx.reports) && tx.reports.length) {
      row.reports = tx.reports.map((r) => ({ id: r?.id, tenths: r?.tenths }));
    }
    if (tx.rateCommit && typeof tx.rateCommit === 'object') {
      row.rateCommit = {
        epochIndex: Math.floor(Number(tx.rateCommit.epochIndex) || 0),
        epochBps: Math.floor(Number(tx.rateCommit.epochBps) || 0),
        magic: String(tx.rateCommit.magic || ''),
      };
    }
    if (typeof tx.rewardRoot === 'string' && /^[0-9a-f]{64}$/i.test(tx.rewardRoot)) {
      row.rewardRoot = tx.rewardRoot.toLowerCase();
    }
    // A claim and a leaf vote read the frozen root and the census from the
    // coinbase. dest20 cannot rebuild either, so compact keeps them.
    const startRoot = hex32Field(tx.epochStartRoot);
    if (startRoot) row.epochStartRoot = startRoot;
    const lockRoot = hex32Field(tx.vaultLockRoot);
    if (lockRoot) row.vaultLockRoot = lockRoot;
    const startCommits = compactEpochStarts(tx.epochStartCommits);
    if (startCommits.length) row.epochStartCommits = startCommits;
    const censusCommits = compactEpochCensus(tx.epochCensusCommit);
    if (censusCommits.length) row.epochCensusCommit = censusCommits;
    const carry = Math.floor(Number(tx.carryNanos) || 0);
    if (Number.isSafeInteger(carry) && carry > 0) row.carryNanos = carry;
    if (Array.isArray(tx.issuedJobKeys) && tx.issuedJobKeys.length) {
      row.issuedJobKeys = tx.issuedJobKeys.map((id) => String(id).toLowerCase());
    }
    compactHashLedger(tx, row);
    return viewsAsBuffers(row);
  }
  const out = {};
  for (const k of COMPACT_TX_KEYS) {
    if (Object.prototype.hasOwnProperty.call(tx, k) && tx[k] !== undefined) out[k] = compactValue(tx[k]);
  }
  const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
  const keepDest = kind === 'vortice-register';
  const reserveTx = RESERVE_TX_KINDS.has(kind);
  const reserveFields = reserveTx ? canonicalReserveFields(tx) : null;
  const poolWithdraw = kind === 'pool-withdraw';
  if (!keepDest) {
    delete out.from;
    delete out.to;
    delete out.payer;
    delete out.sponsor;
  }
  // A compact lock carries portalId and dest20. The address is not on the
  // wire. A withdraw payout is the one-time dest20 under the owner signature,
  // so `to` stays off this body too. A leaf vote has no portal address.
  // The reward integer is public. Compact still drops it from a hidden
  // lock. A claim without it cannot match the proof.
  if (kind === 'reward-claim') {
    const raw = tx.nanos;
    if (typeof raw === 'bigint' && raw >= 0n) out.nanos = raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw.toString();
    else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) out.nanos = raw;
    else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) out.nanos = raw.trim();
  }
  delete out.owner;
  delete out.payout;
  delete out.address;
  if (tx.vin) {
    out.vin = (tx.vin || []).map((v, i) => {
      if (v?.coinbase) return compactValue({ coinbase: true, height: v.height });
      if (kind === 'b-spend') {
        const sealed = sealBSpendVin(v);
        return sealed || unsealedBSpendVin(v);
      }
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
  // An FS-1 withdraw and an FS-1 lock do not publish the identity spend key.
  const hideSpend = kind === 'withdraw' || kind === 'lock';
  if (!hideSpend && (keepDest || poolWithdraw || reserveTx || kind === 'b-spend') && tx.spendPub) out.spendPub = tx.spendPub;
  if (tx.memoCt || tx.memo) out.memo = true;
  if (tx.admit_proof) {
    if (tx.admit_proof.blob || tx.admit_proof.v === 3) {
      // The label is the blob's first byte, so a closed byte is still refused
      // as admit_version downstream.
      let ver = 3;
      try {
        const blob = Buffer.from(asU8(tx.admit_proof.blob || []));
        if (blob.length > 0) ver = blob[0];
      } catch { /* a blob that is not bytes keeps the byte-3 label */ }
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
  // Rebuild before the tag canonicalization so a lying spendTag is still
  // replaced, and compactValue's extra keys do not survive.
  if (admitWireStrictTx(tx)) {
    if (tx.admit_proof && typeof tx.admit_proof === 'object') out.admit_proof = admitThree(tx.admit_proof);
    if (Array.isArray(tx.admit_proofs)) out.admit_proofs = tx.admit_proofs.filter(Boolean).map(admitThree);
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
    // A lock that carries payoutPortalId is refused later. Stripping it here would hide that.
    if (kind !== 'withdraw' && reserveFields.payoutPortalId) out.payoutPortalId = reserveFields.payoutPortalId;
    if (reserveFields.programId) out.programId = reserveFields.programId;
    if (reserveFields.kind === 'vote') out.choice = reserveFields.choice;
  }
  if (kind === 'withdraw') delete out.payoutPortalId;
  // The EVM lock checks this signature. A compact body that drops it cannot replay.
  if (kind === 'lock' && tx.lockAuth) out.lockAuth = compactValue(tx.lockAuth);
  return viewsAsBuffers(out);
}

function blobIsFs1Wire(value) {
  try {
    const raw = Buffer.from(asU8(value));
    return raw.length > 0 && raw[0] === 0xf1;
  } catch {
    return false;
  }
}

function admitWireStrictTx(tx) {
  const kind = String(tx?.kind || '');
  if (kind === 'leaf-vote' || kind === 'withdraw' || kind === 'lock') return true;
  if (blobIsFs1Wire(tx?.fs1)) return true;
  if (tx?.admit_proof && blobIsFs1Wire(tx.admit_proof.blob)) return true;
  if (Array.isArray(tx?.admit_proofs)) {
    for (const proof of tx.admit_proofs) {
      if (proof && blobIsFs1Wire(proof.blob)) return true;
    }
  }
  return false;
}

function admitThree(proof) {
  if (!proof || typeof proof !== 'object') return {};
  const row = {};
  if (proof.blob != null && proof.blob !== '') row.blob = proof.blob;
  if (proof.cTilde != null && proof.cTilde !== '') row.cTilde = proof.cTilde;
  if (proof.spendTag != null && proof.spendTag !== '') row.spendTag = proof.spendTag;
  return row;
}

/**
 * Mempool relay. Sealed compact drops spendPub; admit still has to verify it.
 * Openings stay off the wire.
 */
export function admitWireTx(tx) {
  const wire = compactTx(tx);
  if (!wire || typeof wire !== 'object' || wire.coinbase) return wire;
  const wireKind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (tx?.spendPub && !wire.spendPub && wireKind !== 'withdraw' && wireKind !== 'lock') {
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
  if (Array.isArray(block.hashSpill) && block.hashSpill.length) {
    row.hashSpillPacked = packShareBatchBytes(block.hashSpill).toString('hex');
  }
  if (Array.isArray(block.hashSpillCredits) && block.hashSpillCredits.length) {
    row.hashSpillCreditPacked = packHashCreditBytes(block.hashSpillCredits).toString('hex');
  }
  if (Array.isArray(block.hashCredits)) {
    row.hashCreditPacked = packHashCreditBytes(block.hashCredits).toString('hex');
  }
  return row;
}

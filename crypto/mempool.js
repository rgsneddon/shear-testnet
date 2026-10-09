/**
 * Policy mempool: ssa1 user txs and B-spends only.
 * Paid ≥ current base; bounded; requote/drop after retarget.
 * Shares are not in the mempool.
 */
import { isDestAddress, isShearAddress, bech32Hrp, checkAddressField, checkTxAddressFields } from './address.js';
import { levyNanos, levyTaxed, txAmountNanos, nextBaseFee, mempoolDepthBytes } from './levy.js';
import { dummyCount, flowNeedsDummy, moneyNeedsRange } from './dummy.js';
import { admit_verify } from './admit.js';
import { verifyRange, flowInputsBound, unboundMembershipCarry, txSpendTags, canonicalSpendTag, asU8 } from './note.js';
import { sealedVinLinkField } from './chronoflux.js';
import { paintedSpendSig, verifyPoolWithdrawBound, typedCommitSum, typedClockRejected, boundReserveWithdraw, reserveWithdrawMintId } from './spend.js';
import { receiptAdmitRejected } from './admit.js';
import { verifyTypedAdmitFunding, checkAdmitAnchor, typedKindNeedsAdmitV3 } from './admit_v3.js';
import { trialReserveApply, txIsReserveAction, RESERVE_ACTION_CAP } from './reserve_vault.js';

export const MEMPOOL_MAX = 4096;
export const MEMPOOL_KIND_SEND = 'send';
export const MEMPOOL_KIND_B_SPEND = 'b-spend';

export function emptyMempool() {
  return { txs: [], baseFee: 1, max: MEMPOOL_MAX };
}

/** Chain tags plus every tag already accepted into this book. Callers pass a copy; this does not mutate it. */
function runningSpendTags(book, opts) {
  const tags = new Set();
  const src = opts?.spendTags;
  if (src && typeof src.forEach === 'function') {
    src.forEach((tag) => tags.add(String(tag)));
  }
  for (const prev of book?.txs || []) {
    for (const tag of txSpendTags(prev).tags) tags.add(tag.toString('hex'));
  }
  return tags;
}

function rootHexOf(live) {
  try {
    if (!live?.jroot) return '';
    const b = Buffer.from(asU8(live.jroot));
    return b.length === 32 ? b.toString('hex') : '';
  } catch {
    return '';
  }
}

export function admitMempool(pool, tx, opts = {}) {
  const { baseFee } = opts;
  const book = pool || emptyMempool();
  const base = Math.max(1, Math.floor(Number(baseFee != null ? baseFee : book.baseFee) || 1));
  if (!tx || tx.share || tx.kind === 'share') return { ok: false, reason: 'share_not_mempool' };
  if (!flowNeedsDummy(tx) && !typedKindNeedsAdmitV3(tx)) {
    const carry = unboundMembershipCarry(tx);
    if (!carry.ok) return carry;
  }
  const kind = String(tx.kind || MEMPOOL_KIND_SEND);
  const allowed = new Set([
    MEMPOOL_KIND_SEND,
    MEMPOOL_KIND_B_SPEND,
    'transfer',
    'lock',
    'vote',
    'withdraw',
  ]);
  if (!allowed.has(kind)) {
    return { ok: false, reason: 'kind' };
  }
  const clockField = typedClockRejected(tx);
  if (clockField) return clockField;
  const receiptPub = receiptAdmitRejected(tx);
  if (receiptPub) return receiptPub;
  for (const v of tx.vin || []) {
    const link = sealedVinLinkField(v);
    if (link) return { ok: false, reason: 'vin_link' };
  }
  if (moneyNeedsRange(tx)) {
    for (const o of (tx.vout || [])) {
      if (!o?.commit || !o.rangeProof || o.rangeProof === true) {
        return { ok: false, reason: 'range_proof' };
      }
      if (!verifyRange(o.commit, o.rangeProof)) return { ok: false, reason: 'range_proof' };
    }
  }
  // Same sum as the block body. A missing range proof already returned.
  // Flow sends skip this. An unbalanced lock, vote, or withdraw does not
  // sit in a template until the block path rejects it.
  const summed = typedCommitSum(tx);
  if (!summed.ok) return summed;
  // Lock, vote, and withdraw: same funding check, same drawn mint, same
  // header-time vault trial as queue and consensus. A vault miss is marked
  // so the template drops the tx instead of retrying it forever.
  const runningTags = runningSpendTags(book, opts);
  let fundTags = null;
  let vaultState = null;
  if (txIsReserveAction(tx) && ('reserveState' in opts || 'nowMs' in opts || typeof opts.noteAtAnchor === 'function' || Array.isArray(opts.blocks) || opts.height != null || 'reserveCarried' in opts)) {
    const prior = (book.txs || []).filter(txIsReserveAction);
    if (prior.length >= RESERVE_ACTION_CAP) return { ok: false, reason: 'reserve_cap' };
    const wantFund = typeof opts.noteAtAnchor === 'function' || Array.isArray(opts.blocks) || opts.height != null;
    if (wantFund) {
      const verdict = opts.verifiedFund;
      let usedVerdict = false;
      const ownHex = txSpendTags(tx).tags.map((tag) => tag.toString('hex'));
      if (ownHex.some((th) => runningTags.has(th))) {
        return { ok: false, reason: 'admit_link_tag' };
      }
      if (verdict && verdict.ok && Array.isArray(verdict.tags) && verdict.tags.length > 0 && ownHex.length > 0) {
        const anchored = checkAdmitAnchor(tx, Number(opts.height || 0));
        const live = typeof opts.noteAtAnchor === 'function' ? opts.noteAtAnchor(Number(verdict.anchor)) : null;
        const liveRoot = rootHexOf(live);
        const sameTags = verdict.tags.length === ownHex.length
          && verdict.tags.every((th) => ownHex.includes(String(th)));
        if (sameTags && anchored.ok && anchored.anchor != null && Number(anchored.anchor) === Number(verdict.anchor)
            && liveRoot && liveRoot === String(verdict.root || '')) {
          fundTags = ownHex.slice();
          usedVerdict = true;
        }
      }
      if (!usedVerdict) {
        const noteFund = verifyTypedAdmitFunding(tx, {
          height: Number(opts.height || 0),
          blocks: opts.blocks || [],
          spentTags: runningTags,
          magic: opts.magic,
          noteAtAnchor: typeof opts.noteAtAnchor === 'function' ? opts.noteAtAnchor : null,
        });
        if (!noteFund.ok) return noteFund;
        if (Array.isArray(noteFund.tags)) fundTags = noteFund.tags;
      }
    }
    const drawn = new Set();
    const minted = opts.reserveState?.mintedIds || {};
    for (const id of Object.keys(minted)) {
      if (minted[id]) drawn.add(id);
    }
    for (const prev of book.txs || []) {
      const id = reserveWithdrawMintId(prev, opts.reserveState || null);
      if (id) drawn.add(id);
    }
    const stake = boundReserveWithdraw(tx, opts.reserveState || null, drawn);
    if (!stake.ok) return { ...stake, vault: true };
    // A carried vault already includes every accepted reserve tx. Trial only
    // this one. A caller with no carried vault still trials the prefix once.
    const useCarried = Object.prototype.hasOwnProperty.call(opts, 'reserveCarried');
    const tried = trialReserveApply({
      state: useCarried ? opts.reserveCarried : (opts.reserveState || null),
      txs: useCarried ? [tx] : [...prior, tx],
      nowMs: Number(opts.nowMs) || 0,
    });
    if (!tried.ok) return { ok: false, reason: tried.reason || 'no_vault', vault: true };
    vaultState = tried.state || null;
  }
  const bound = verifyPoolWithdrawBound(tx);
  if (!bound.ok) return bound;
  const fields = checkTxAddressFields(tx, { coinbase: false });
  if (!fields.ok) return { ok: false, reason: fields.reason };
  const dests = [];
  if (tx.to) dests.push(tx.to);
  if (tx.from) dests.push(tx.from);
  for (const o of tx.vout || []) {
    if (o?.address) dests.push(o.address);
  }
  for (const v of tx.vin || []) {
    if (v?.address) dests.push(v.address);
  }
  for (const d of dests) {
    const r = checkAddressField(d, { allowEmpty: false });
    if (!r.ok) return { ok: false, reason: r.reason === 'rest_frame_on_chain' ? 'shear1' : r.reason };
    if (isShearAddress(d)) return { ok: false, reason: 'shear1' };
    if (!isDestAddress(d) || bech32Hrp(d) !== 'ssa') return { ok: false, reason: 'dest' };
  }
  let boundIns = null;
  if (flowNeedsDummy(tx)) {
    boundIns = flowInputsBound(tx);
    if (!boundIns.ok) return boundIns;
  }
  if (flowNeedsDummy(tx) && dummyCount(tx) < 1) {
    return { ok: false, reason: 'dummy_outs' };
  }
  const paintedHold = opts.paintedHold === true && paintedSpendSig(tx);
  if (flowNeedsDummy(tx)) {
    const live = opts.fluxset && !Array.isArray(opts.fluxset)
      ? opts.fluxset
      : { pubs: opts.fluxset || opts.pubs || [], commits: opts.commits || [] };
    if (Array.isArray(live.pubs) && live.pubs.length && !paintedHold) {
      const parsed = txSpendTags(tx);
      if (!parsed.ok && parsed.reason === 'admit_tag') return { ok: false, reason: 'admit_tag' };
      const boundProofs = boundIns?.proofs || [];
      if (!boundProofs.length) return { ok: false, reason: 'admit_membership' };
      const seen = new Set();
      for (let pi = 0; pi < boundProofs.length; pi += 1) {
        const proof = boundProofs[pi];
        const one = canonicalSpendTag(proof);
        if (!one.ok) return { ok: false, reason: one.reason || 'admit_membership' };
        if (!one.tag) return { ok: false, reason: 'admit_membership' };
        if (!admit_verify(proof, live, { cTilde: proof.cTilde, spendTag: one.tag, jroot: live.jroot })) {
          return { ok: false, reason: 'admit_membership' };
        }
        const th = one.tag.toString('hex');
        if (seen.has(th) || runningTags.has(th)) return { ok: false, reason: 'admit_link_tag' };
        seen.add(th);
      }
      if (!parsed.ok) return { ok: false, reason: parsed.reason || 'admit_link_tag' };
    }
  }
  const depth = mempoolDepthBytes(book.txs);
  const need = levyTaxed({ ...tx, kind }) ? levyNanos(0, { tx }) : 0;
  const paid = Math.floor(Number(tx.fee || tx.paid || 0));
  if (paid < need) return { ok: false, reason: 'levy', need, paid };
  if (levyTaxed({ ...tx, kind }) && tx.maxLevy != null && need > Number(tx.maxLevy)) {
    return { ok: false, reason: 'max_levy', need };
  }
  if ((book.txs || []).length >= (book.max || MEMPOOL_MAX)) return { ok: false, reason: 'full' };
  book.txs.push({ ...tx, fee: paid, kind });
  const accepted = book.txs[book.txs.length - 1];
  const tags = Array.isArray(fundTags) ? fundTags.slice() : txSpendTags(accepted).tags.map((tag) => tag.toString('hex'));
  for (const th of tags) runningTags.add(String(th));
  return { ok: true, tx: accepted, tags, vaultState };
}

/** After header retarget, drop or mark requote if paid < new base levy. */
export function retargetMempool(pool, nextBase) {
  const book = pool || emptyMempool();
  const base = Math.max(1, Math.floor(Number(nextBase) || 1));
  book.baseFee = base;
  const keep = [];
  const dropped = [];
  for (const tx of book.txs || []) {
    const need = levyTaxed(tx) ? levyNanos(txAmountNanos(tx), { depth: mempoolDepthBytes(keep) }) : 0;
    if (Math.floor(Number(tx.fee || 0)) < need) {
      dropped.push({ ...tx, requote: need });
    } else {
      keep.push(tx);
    }
  }
  book.txs = keep;
  return { ok: true, dropped, nextBaseFee: nextBaseFee(base, keep.length || 1) };
}

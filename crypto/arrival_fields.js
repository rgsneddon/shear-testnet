/**
 * The fields an arriving row may carry, checked on the row as it arrived,
 * before compaction. compactTx keeps the body and strips secrets and
 * local-only fields (the strip list below). It never decides validity: a
 * field a body is not allowed to carry is refused here, on every path
 * (mempool admission, append, ingest, adopt, probe), not dropped there.
 *
 * Order: a she1 or shear1 address (chainAddressFrameRejected), then the
 * named refusals admission already gives (a coinbase observe,
 * amount, published v, or membership carry, an unsigned field, a reserve leak, a value opening on a hidden output, a
 * plaintext reserve amount, a memo envelope), then dropped_field for any
 * other field compaction would drop that is neither on the strip list nor
 * rebuilt into a kept field.
 */
import { compactTx, valueOpenRejected, amountFieldRejected, sealedVinLinkField, bSpendVinRejected } from './chronoflux.js';
import { reserveRowNanos } from './reserve_vault.js';
import { unsignedBodyField } from './spend.js';
import { coinbaseObserveRejected } from './reserve_oracle.js';
import { noteU64, unboundMembershipCarry } from './note.js';
import { bech32Hrp } from './address.js';
import { compactLockLeakRejected, withdrawLeakRejected, leafVoteLeakRejected } from './reserve_vault.js';

/**
 * The strip list: secrets, client hints, and local-only rows. Compaction
 * drops these wherever they appear, and a row carrying one is still the
 * same body.
 */
export const STRIP_ANYWHERE = Object.freeze([
  'open', 'portalOpen', 'viewKey', 'view', 'V', 'C', 'closure', 'closureCommit', 'paymentCode',
  'scanPub', 'spendHash20', 'seed', 'seedHex', 'privateKey', 'ip', 'remoteAddress', 'peerIp',
  'userAgent', 'user-agent', 'ua', 'memoPlain', 'login', 'spendPub', 'r', 't', '_origCommit', '_origNoteCommit',
  'hashOwedLocal',
]);

/** Top-level addresses and client amount hints. A vortice-register keeps its address. */
export const STRIP_TOP = Object.freeze([
  'from', 'to', 'payer', 'sponsor', 'owner', 'payout', 'address', 'changeNanos', 'amount',
]);

/** A top-level nanos on these kinds is a hidden amount: stripped, never body. */
const HIDDEN_AMOUNT_KINDS = new Set(['', 'send', 'transfer', 'change']);

/**
 * Fields compaction rebuilds into a kept field, by path. Dropping the
 * source loses nothing: the kept field carries the same bytes.
 */
const REBUILT = Object.freeze({
  signature: 'sig',
  'vin[].pseudo': 'vin[].commit',
  'vin[].cTilde': 'vin[].commit',
  'vin[].address': 'vin[].dest20 (an address is not body)',
  'vout[].address': 'vout[].dest20 (an address is not body)',
  members: 'membersFieldRejected decides it; the anchor proof carries the set',
  'admit_proof.members': 'membersFieldRejected decides it; the anchor proof carries the set',
  'admit_proofs[].members': 'membersFieldRejected decides it; the anchor proof carries the set',
});

/** Coinbase fields compaction moves or folds: the samples ride on the block, ledger rows fold into their roots. */
const COINBASE_REBUILT = Object.freeze({
  samples: 'moved to the block (store.js arrivedBody)',
  'vin[].coinbase': 'rewritten as {coinbase:true,height} from tx.height',
  'vin[].height': 'rewritten as {coinbase:true,height} from tx.height',
  hashOwed: 'folded into hashOwedRoot (hash_owed.js compactHashLedger)',
  hashOwedRest: 'folded into hashOwedRoot (hash_owed.js compactHashLedger)',
  hashCredits: 'folded into hashCreditRoot (hash_owed.js compactHashLedger)',
  hashDustNanos: 'folded into the ledger roots (hash_owed.js compactHashLedger)',
  hashOwedOverflowNanos: 'folded into the ledger roots (hash_owed.js compactHashLedger)',
  carryNanos: 'a zero carry is dropped; canonicalCarry reads an absent carry as 0',
});

function isBytes(v) {
  return Buffer.isBuffer(v) || v instanceof Uint8Array;
}

function present(v) {
  return v !== undefined && v !== null;
}

/** Whether the opened amounts of the rows that name the tx's kind sum to `raw`. */
function publicSumIs(tx, raw) {
  const kind = String(tx?.kind || '');
  if (!kind) return false;
  let want;
  try { want = BigInt(String(raw)); } catch { return false; }
  let sum = 0n;
  let rows = 0;
  for (const o of Array.isArray(tx?.vout) ? tx.vout : []) {
    if (String(o?.kind || '') !== kind) continue;
    const v = reserveRowNanos(o);
    if (v == null) return false;
    try { sum += BigInt(String(v)); } catch { return false; }
    rows += 1;
  }
  return rows > 0 && sum === want;
}

/** May compaction drop `path` (array steps as []) from this row? */
function mayDrop(tx, path, key, row) {
  if (STRIP_ANYWHERE.includes(key)) return true;
  const kind = String(tx?.kind || '');
  if (!path.includes('.') && !path.includes('[]')) {
    if (STRIP_TOP.includes(key) && kind !== 'vortice-register') return true;
    if (key === 'nanos' && !tx.coinbase && HIDDEN_AMOUNT_KINDS.has(kind)) return true;
    // On a lock or withdraw, reserveNanosRejected (run first) has refused any
    // nanos that differs from the row's own opening; an equal one is a copy.
    if (key === 'nanos' && (kind === 'lock' || kind === 'withdraw')) return true;
    // On a public kind (a b-spend mint), a nanos equal to the opened amount
    // of the tx's own rows is a copy of body; any other value is not.
    if (key === 'nanos' && !tx.coinbase && publicSumIs(tx, tx.nanos)) return true;
  }
  // A plaintext amount on a committed row, or on any row of a hidden-kind
  // tx, is a hidden amount: stripped, never body. (A coinbase is refused
  // first: amountFieldRejected.)
  if (path === 'vout[].nanos' && ((row && present(row.commit)) || HIDDEN_AMOUNT_KINDS.has(kind))) return true;
  // A public row's nanos is rebuilt into its valueProof.v (compactVout).
  if (path === 'vout[].nanos' && row && !present(row.commit) && row.valueProof?.v == null) return true;
  // An admit proof keeps the keys its form needs: a strict FS-1 proof is
  // rebuilt to blob, cTilde and spendTag (admitKeysRejected refuses any
  // other key on it), and a blobless or pre-v3 proof is admit_version in a
  // block, so its other keys never reach one. unsignedBodyField limits both
  // to PROOF_KEYS.
  if (path.startsWith('admit_proof.') || path.startsWith('admit_proofs[].')) return true;
  if (Object.prototype.hasOwnProperty.call(REBUILT, path)) return true;
  if (tx?.coinbase && Object.prototype.hasOwnProperty.call(COINBASE_REBUILT, path)) return true;
  return false;
}

/** The first field the arriving row carries that compaction would drop and may not. */
export function droppedFieldOf(tx) {
  if (!tx || typeof tx !== 'object' || isBytes(tx)) return null;
  let compact;
  try {
    compact = compactTx(tx);
  } catch {
    return 'body';
  }
  const walk = (raw, kept, path, row) => {
    if (!raw || typeof raw !== 'object' || isBytes(raw)) return null;
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 1) {
        const got = walk(raw[i], Array.isArray(kept) ? kept[i] : undefined, `${path}[]`, raw[i]);
        if (got) return got;
      }
      return null;
    }
    for (const key of Object.keys(raw)) {
      if (!present(raw[key])) continue;
      const here = path ? `${path}.${key}` : key;
      const keptHas = kept && typeof kept === 'object' && !isBytes(kept) && present(kept[key]);
      if (!keptHas) {
        if (!mayDrop(tx, here, key, row)) return here;
        continue;
      }
      // A kept byte field may be rewritten (hex to bytes); only objects are walked.
      if (isBytes(kept[key]) || typeof kept[key] !== 'object') continue;
      const got = walk(raw[key], kept[key], here, path.endsWith('[]') ? raw : row);
      if (got) return got;
    }
    return null;
  };
  return walk(tx, compact, '', null);
}

/**
 * A payment-code (she1) or rest-frame (shear1) address on the row, which
 * would name its owner on chain: silent_id_on_chain or rest_frame_on_chain,
 * as chain.js judged the full rows. Compaction drops an output address, so
 * the refusal is read here, on the row as it arrived. The fields are the
 * ones chain.js checks: a coinbase's output addresses, and a body's
 * from/to/miner/payer and its vin and vout addresses.
 */
export function chainAddressFrameRejected(tx) {
  if (!tx || typeof tx !== 'object') return null;
  const fields = [];
  const push = (a) => { if (typeof a === 'string' && a.trim()) fields.push(a); };
  if (tx.coinbase) {
    for (const o of Array.isArray(tx.vout) ? tx.vout : []) push(o?.address);
  } else {
    push(tx.from); push(tx.to); push(tx.miner); push(tx.payer);
    for (const v of Array.isArray(tx.vin) ? tx.vin : []) { push(v?.address); push(v?.miner); }
    for (const o of Array.isArray(tx.vout) ? tx.vout : []) { push(o?.address); push(o?.miner); }
  }
  for (const a of fields) {
    const hrp = bech32Hrp(a.trim());
    if (hrp === 'she') return { ok: false, reason: 'silent_id_on_chain' };
    if (hrp === 'shear') return { ok: false, reason: 'rest_frame_on_chain' };
  }
  return null;
}

/**
 * Why the arriving row may not be carried, or null. Run before compaction
 * on every path a row arrives by.
 */
export function arrivalFieldRejected(tx) {
  if (!tx || typeof tx !== 'object' || isBytes(tx) || Array.isArray(tx)) return null;
  const framed = chainAddressFrameRejected(tx);
  if (framed) return framed;
  if (tx.coinbase) {
    const observed = coinbaseObserveRejected([tx]);
    if (observed) return observed;
    // A coinbase states no plaintext amount on a committed row, and a
    // published v is a u64 (COINBASE_V=opens judges whether it opens).
    const amount = amountFieldRejected(tx);
    if (amount) return amount;
    for (const o of Array.isArray(tx.vout) ? tx.vout : []) {
      const v = o?.valueProof?.v;
      if (v == null || v === '') continue;
      if (noteU64(v) == null) return { ok: false, reason: 'coinbase_output' };
    }
    // A coinbase binds no membership: a carried admit proof or spend tag is
    // admit_membership (chain.js runs the same check on the full body),
    // not a field compaction drops.
    const carry = unboundMembershipCarry(tx);
    if (!carry.ok) return carry;
  } else {
    if (String(tx.kind || '') === 'leaf-vote') {
      const leaked = leafVoteLeakRejected(tx);
      if (leaked) return leaked;
    }
    const lockLeak = compactLockLeakRejected(tx);
    if (lockLeak) return lockLeak;
    const withdrawLeak = withdrawLeakRejected(tx);
    if (withdrawLeak) return withdrawLeak;
  }
  const unsigned = unsignedBodyField(tx);
  if (unsigned) return unsigned;
  if (!tx.coinbase) {
    const open = valueOpenRejected(tx);
    if (open) return open;
    const vinAdmit = bSpendVinRejected(tx);
    if (vinAdmit) return vinAdmit;
    for (const v of Array.isArray(tx.vin) ? tx.vin : []) {
      if (sealedVinLinkField(v)) return { ok: false, reason: 'vin_link' };
    }
  }
  const dropped = droppedFieldOf(tx);
  if (dropped) return { ok: false, reason: 'dropped_field', field: dropped };
  return null;
}

/** The first row of `block` that may not be carried, as a refusal, or null. */
export function blockArrivalRejected(block) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  for (const tx of txs) {
    const refused = arrivalFieldRejected(tx);
    if (refused) return refused;
  }
  return null;
}

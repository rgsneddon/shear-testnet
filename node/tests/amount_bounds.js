/**
 * Amount bounds on a real queued Reserve tx. Each variant puts a negative or
 * overflowing amount where an amount can be written (the top-level nanos,
 * and the kind row's valueProof.v and nanos) and is put to the node twice:
 * - admission (store.queueTx) must refuse it, under a fresh id so the
 *   refusal is its own, not the queued id's (id_reused);
 * - the store's block check (probeBlock: the arrival gate, then the compact
 *   body, as append does) on the next template with the variant in place of
 *   the real tx, its merkle recomputed over the compact bodies, must refuse
 *   it.
 * The one exception is a field compaction drops (a plaintext amount on a
 * committed row is a hidden amount and must be one; a top-level nanos on a
 * kind whose body has none is another): the compact body is the real tx's
 * byte for byte. It goes in under the real id and must be refused or be that
 * same tx, and the block must be refused for the reason the arrival gate
 * gives that row, or be the real block where the gate names nothing.
 * Compaction never decides validity (crypto/arrival_fields.js).
 * A hidden row's amount is its commitment and range proof; neither is
 * touched here.
 */
import assert from 'node:assert/strict';
import { compactTx } from '../../crypto/chronoflux.js';
import { txBodyKey } from '../../crypto/mempool.js';
import { arrivalFieldRejected } from '../../crypto/arrival_fields.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { digestTx } from '../src/chain.js';

/**
 * Why a block may refuse a bad amount: an amount rule (negative_mint,
 * commit_sum, mint_amount, amount_field, value_open, coinbase_output,
 * range_proof, pot, dropped_field) or a proof that binds the amount and no
 * longer verifies over the edited body (admit_membership, stake_reward,
 * unsigned). Anything else (merkle, append, a throw) is not proof of the
 * bound.
 */
const BOUND_REASONS = new Set([
  'negative_mint', 'commit_sum', 'mint_amount', 'amount_field', 'value_open', 'coinbase_output',
  'range_proof', 'pot', 'dropped_field', 'admit_membership', 'stake_reward', 'unsigned',
]);

/** Admission's reason for a spend tag a queued body holds (crypto/mempool.js, admit_v3.js). */
const HELD_TAG = 'admit_link_tag';

/** Amounts a JSON body can carry that no output may hold. */
export const BAD_AMOUNTS = Object.freeze([
  -1,
  '-1',
  -3_141_592_653,
  Number.MAX_SAFE_INTEGER + 2,
  1e30,
  '18446744073709551616',
]);

/**
 * Plausible amounts a relayer or miner could plant beside a commitment on
 * the kind row: a hidden amount in clear. Compaction must drop every one, so
 * no amount the owner did not publish ever reaches the body (the chronoflux
 * claimedReserveV fix, Russell 26 Oct ruling C).
 */
export const PLANTED_AMOUNTS = Object.freeze([1, 7, '314159265', 314_159_265, 1_000_000_000_000]);

function kindRowIndex(tx) {
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const i = outs.findIndex((row) => String(row?.kind || '') === String(tx?.kind || ''));
  return i >= 0 ? i : (outs.length ? 0 : -1);
}

/** Every place an amount can be written on `tx`, with each bad value. */
function variantsOf(tx) {
  const out = [];
  const at = kindRowIndex(tx);
  for (const value of BAD_AMOUNTS) {
    out.push({ where: 'nanos', value, tx: { ...structuredClone(tx), nanos: value } });
    if (at < 0) continue;
    const row = tx.vout[at];
    const withV = structuredClone(tx);
    withV.vout[at] = { ...withV.vout[at], valueProof: { ...(row.valueProof && typeof row.valueProof === 'object' ? row.valueProof : {}), v: value } };
    out.push({ where: `vout[${at}].valueProof.v`, value, tx: withV });
    const withN = structuredClone(tx);
    withN.vout[at] = { ...withN.vout[at], nanos: value };
    out.push({ where: `vout[${at}].nanos`, value, tx: withN });
  }
  if (at >= 0 && tx.vout[at]?.commit != null) {
    for (const value of PLANTED_AMOUNTS) {
      const planted = structuredClone(tx);
      planted.vout[at] = { ...planted.vout[at], nanos: value };
      out.push({ where: `vout[${at}].nanos`, value, tx: planted });
    }
  }
  return out;
}

/** The txs as append validates them (store.js arrivedBody). */
function compactBlockTxs(txs) {
  return txs.map((tx) => {
    if (tx?.coinbase) {
      const { samples: _s, ...rest } = tx;
      return compactTx({ ...rest, coinbase: true });
    }
    return compactTx(tx);
  });
}

function blockOf(tpl, txs, miner) {
  const head = decodeHeader(Buffer.from(tpl.header));
  const header = encodeHeader({ ...head, merkleRoot: merkleRoot(compactBlockTxs(txs).map(digestTx)) });
  return {
    header,
    height: tpl.height,
    txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

/**
 * Check every bad amount on the queued tx `id`. Returns one row per variant
 * ({ where, value, admit, block, dropped }) for the log; asserts as above.
 * `beforeEach` resets per-check state the probe touches (the FS-1 tree).
 */
export async function amountBoundsRefused({ store, miner, now, id, kind = '', name, nowMs, beforeEach = () => {} }) {
  beforeEach();
  const { tpl } = store.template({ miner, shareBits: 4, now });
  // A leaf vote carries no id; it is found by its kind.
  const at = id != null && id !== ''
    ? tpl.txs.findIndex((row) => String(row?.id || '') === String(id))
    : tpl.txs.findIndex((row) => !row?.coinbase && String(row?.kind || '') === String(kind));
  assert.ok(at > 0, `${name}: ${id || kind} is in the template`);
  const real = tpl.txs[at];
  // An honest committed row puts no amount beside its commitment but the
  // opening it posts: a public seal (a withdraw payout) shows its nanos
  // twice, equal to valueProof.v; a hidden row (a lock) shows none. The
  // compact row drops nanos, so its hash is unchanged by the claimedReserveV
  // fix, and it publishes only the opening posted.
  for (const [i, o] of (real.vout || []).entries()) {
    if (o?.commit == null) continue;
    if (Object.prototype.hasOwnProperty.call(o, 'nanos')) {
      assert.ok(o?.valueProof?.v != null, `${name}: honest vout[${i}] shows nanos only beside its posted opening`);
      assert.equal(String(o.nanos), String(o.valueProof.v), `${name}: honest vout[${i}] nanos is its posted opening`);
    }
    const sealed = compactTx(real).vout[i];
    assert.equal(Object.prototype.hasOwnProperty.call(sealed || {}, 'nanos'), false, `${name}: compact vout[${i}] carries no nanos`);
    assert.equal(String(sealed?.valueProof?.v ?? ''), String(o?.valueProof?.v ?? ''), `${name}: vout[${i}] publishes only the opening it posted`);
  }
  const realCompact = JSON.stringify(compactTx(real), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  beforeEach();
  const base = await Promise.resolve(store.probeBlock(blockOf(tpl, tpl.txs, miner)));
  assert.equal(base.ok, true, `${name}: the real block probes (${base.reason || ''})`);
  const rows = [];
  // Control: the real tx under a fresh id. A held body is known by its key
  // (txBodyKey), which names the id only for a withdraw. Where the id is not
  // in the key, the copy is the held body: a duplicate. Where it is, the copy
  // is another body spending the held note, and is refused. A variant
  // refused for the held-tag reason was refused by the spend tag the real tx
  // holds, not by its amount; the row says so (tagShadow), and the block
  // check is the proof of the bound for it.
  const fresh = { ...structuredClone(real), id: `${id || kind}~control` };
  const sameBody = txBodyKey(fresh) === txBodyKey(real);
  const control = store.queueTx(fresh, { nowMs });
  if (sameBody) {
    assert.equal(control?.duplicate, true, `${name}: the real tx under a fresh id is the held body (${JSON.stringify(control)})`);
  } else {
    assert.equal(control?.ok, false, `${name}: the real tx under a fresh id is refused while it is queued`);
  }
  const heldTag = sameBody ? HELD_TAG : control?.reason;
  let n = 0;
  for (const v of variantsOf(real)) {
    const label = `${name} ${v.where}=${String(v.value)}`;
    const row = v.where.startsWith('vout[') ? real.vout[Number(v.where.slice(5, v.where.indexOf(']')))] : null;
    // Dropped: compaction leaves the real compact body, wherever the field
    // sits (a top-level nanos on a kind whose body has none, too). A nanos
    // beside a commitment is a hidden amount in clear: it must be dropped.
    const stripped = v.where.endsWith('].nanos') && row != null && row.commit != null;
    let dropped = false;
    try {
      dropped = JSON.stringify(compactTx(v.tx), (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)) === realCompact;
    } catch {
      dropped = false;
    }
    if (stripped) assert.equal(dropped, true, `${label}: a stripped field leaves the compact body the real one`);
    n += 1;
    const admit = store.queueTx(dropped ? structuredClone(v.tx) : { ...structuredClone(v.tx), id: `${id || kind}~bound${n}` }, { nowMs });
    if (dropped) {
      assert.ok(admit?.ok === false || admit?.duplicate === true, `${label}: admission refuses it or holds it as the same tx (${JSON.stringify(admit)})`);
    } else {
      assert.equal(admit?.ok, false, `${label}: admission refuses it`);
      assert.notEqual(admit?.reason, 'id_reused', `${label}: refused by the id, not the body`);
    }
    const txs = tpl.txs.slice();
    txs[at] = v.tx;
    beforeEach();
    let block;
    try {
      block = await Promise.resolve(store.probeBlock(blockOf(tpl, txs, miner)));
    } catch (err) {
      block = { ok: false, reason: `throw:${String(err?.message || err).slice(0, 60)}` };
    }
    if (dropped) {
      // The arrival gate reads the row as it arrived: a field it names (a
      // lock's top-level nanos is amount_field) refuses the block for that
      // reason. Any other dropped field leaves the real block.
      const named = arrivalFieldRejected(v.tx);
      if (named) {
        assert.equal(block.ok, false, `${label}: the arrival gate refuses it (${named.reason})`);
        assert.equal(block.reason, named.reason, `${label}: refused by the arrival gate's reason`);
      } else {
        assert.equal(block.ok, true, `${label}: compaction strips it, so the block is the real block (${block.reason || ''})`);
      }
    } else {
      assert.equal(block.ok, false, `${label}: the block check refuses it`);
      assert.ok(BOUND_REASONS.has(block.reason), `${label}: the block refuses it for its amount or a proof over it, not ${block.reason}`);
    }
    rows.push({
      where: v.where,
      value: String(v.value),
      admit: admit?.duplicate ? 'duplicate' : (admit?.reason || ''),
      tagShadow: !dropped && admit?.reason === heldTag,
      block: block.ok ? 'same-block' : block.reason,
      dropped,
    });
  }
  return rows;
}

/**
 * A coinbase may not name an observe (coinbaseObserveRejected): the next
 * template with one added to its coinbase is refused by the store's block
 * check, not compacted into the bare coinbase.
 */
export async function coinbaseObserveRefused({ store, miner, now, beforeEach = () => {} }) {
  beforeEach();
  const { tpl } = store.template({ miner, shareBits: 4, now });
  const txs = tpl.txs.slice();
  txs[0] = { ...txs[0], observe: { annualBps: 400, observedAtMs: Number(now) } };
  beforeEach();
  const got = await Promise.resolve(store.probeBlock(blockOf(tpl, txs, miner)));
  assert.equal(got.ok, false, 'a coinbase naming an observe is refused');
  assert.equal(got.reason, 'observe_unattested');
  return got.reason;
}

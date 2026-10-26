/**
 * The compaction read walk. A block is validated in its compact form
 * (store.js arrivedBody), so a field a validator reads must survive
 * compactTx. This wraps a compact tx so every read of a key the compact
 * body lacks, but the full row carries, is recorded: that is a field a
 * validator wants and compaction drops. Bytes are returned unwrapped.
 * A spread or clone inside a validator stops the walk below that copy,
 * so a miss is proof of a dropped read; an empty walk is checked against
 * the mutation lanes (drop vaultProof or memoCt from compactTx: the walk
 * must then record it).
 */
import assert from 'node:assert/strict';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { compactTx } from '../../crypto/chronoflux.js';

/**
 * Dropped reads that are decided, not gaps: the absent value is what the
 * validator would read anyway, or the field is local-only (strip list).
 */
export const BENIGN_DROPPED_READS = Object.freeze({
  carryNanos: 'compactTx drops a zero carry; canonicalCarry reads an absent carry as 0',
  hashOwedLocal: 'local-only owed rows (strip list); the hashOwedRoot they hash to is bound and checked',
  // Presence tests (the key read with in or hasOwnProperty), marked with ?.
  'nanos?': 'a top-level amount is tested for presence before it is read; an absent one is no plaintext amount (chain.js negativeTopNanos, chronoflux amountFieldRejected/reserveNanosRejected)',
  'vout[].nanos?': 'an output amount is tested for presence; an absent one is no plaintext amount (chronoflux amountFieldRejected)',
});

function isBytes(v) {
  return Buffer.isBuffer(v) || v instanceof Uint8Array;
}

function has(o, k) {
  return o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
}

/** Each walk proxy's plain target: a validator that clones a tx clones that. */
const plainOf = new WeakMap();

function unwrapped(v) {
  if (v == null || typeof v !== 'object') return v;
  return plainOf.has(v) ? plainOf.get(v) : v;
}

/**
 * The first frames outside this file that made a read: the validator that
 * wants the dropped field. Kept per path in `misses.readers`.
 */
function readerOf() {
  const lines = String(new Error().stack || '').split('\n').slice(1);
  return lines
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('compact_reads.js') && !line.startsWith('at new Promise'))
    .slice(0, 3)
    .join(' < ');
}

/** A read made before validation: compactTx reading its input, or the arrival gate checking the row as it arrived (arrival_fields.js). */
const COMPACTING = /\bat (compactTx|arrivedBody|arrivalFieldRejected|blockArrivalRejected|droppedFieldOf) /;

function noteMiss(misses, here) {
  if (COMPACTING.test(String(new Error().stack || ''))) return;
  misses.add(here);
  if (!misses.readers) misses.readers = new Map();
  if (!misses.readers.has(here)) misses.readers.set(here, readerOf());
}

/** `compact` wrapped so reads of keys it lacks but `full` has land in `misses`. */
export function readWalk(compact, full, misses, at = '') {
  if (compact == null || typeof compact !== 'object' || isBytes(compact)) return compact;
  const presence = (target, key) => {
    if (typeof key !== 'string' || has(target, key)) return;
    const here = Array.isArray(target) && /^d+$/.test(key) ? `${at}[]` : (at ? `${at}.${key}` : key);
    if (has(full, key)) noteMiss(misses, `${here}?`);
  };
  const proxy = new Proxy(compact, {
    // A validator that tests a key (in, hasOwnProperty) reads it too.
    has(target, key) {
      presence(target, key);
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      presence(target, key);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, recv) {
      const v = Reflect.get(target, key, recv);
      if (typeof key !== 'string') return v;
      const here = Array.isArray(target) && /^\d+$/.test(key) ? `${at}[]` : (at ? `${at}.${key}` : key);
      if (!has(target, key)) {
        if (has(full, key)) noteMiss(misses, here);
        return v;
      }
      const sub = full != null && typeof full === 'object' ? full[key] : undefined;
      return readWalk(v, sub, misses, here);
    },
  });
  plainOf.set(proxy, compact);
  return proxy;
}

/**
 * Run `fn` with structuredClone seeing through walk proxies (a Proxy cannot
 * be cloned; a validator that clones a tx gets the plain compact body, and
 * the walk stops at that copy, as the module comment says).
 */
async function seeingThrough(fn) {
  const original = globalThis.structuredClone;
  globalThis.structuredClone = (v, o) => original(unwrapped(v), o);
  try {
    return await fn();
  } finally {
    globalThis.structuredClone = original;
  }
}

/**
 * Block-validate `fullTx` in its compact form under the walk and return the
 * dropped reads. `opts` adds verify fields (the store's reserve state).
 */
export async function droppedBlockReads({ store, miner, fullTx, sealHeader, bits, now, opts = {} }) {
  const tip = store.tip();
  const built = buildTemplate({
    prev: tip ? tip.hash : GENESIS_PREV,
    prevHeader: tip ? tip.header : undefined,
    prevBlock: tip || null,
    height: (tip?.height || 0) + 1,
    miner,
    bits,
    now,
    txs: [fullTx],
    parentBlocks: store.blocks,
  });
  assert.ok(built.txs.some((row) => row.id === fullTx.id), `${fullTx.id} templated`);
  const header = await sealHeader(built.header, built.bits);
  const misses = new Set();
  const txs = built.txs.map((row) => readWalk(compactTx(row), row, misses));
  const block = {
    header,
    height: built.height,
    txs,
    samples: built.samples,
    shareBatch: built.shareBatch || [],
    miner,
    aLeaves: built.aLeaves,
    bLeaves: built.bLeaves,
    rootA: built.rootA,
    rootB: built.rootB,
    weight: built.weight,
  };
  // The store's own block check against its tip (probeBlock: every option a
  // real append passes, the EVM session included, then rolled back).
  if (typeof store.probeBlock === 'function') {
    const verdict = await seeingThrough(() => Promise.resolve(store.probeBlock(block)));
    // A failed walk is checked once more on the plain compact body, so a
    // refusal the walk itself caused shows up as such.
    const plain = verdict?.ok ? null : await Promise.resolve(store.probeBlock({ ...block, txs: built.txs.map((row) => compactTx(row)) }));
    return { ...report(verdict, misses), plain };
  }
  let genesisMs = 0;
  try { genesisMs = Number(decodeHeader(Buffer.from(store.blocks[0].header)).timestamp) || 0; } catch { genesisMs = 0; }
  const verdict = await seeingThrough(() => Promise.resolve(verifyBlock(block, tip, {
    noteAtAnchor: (anchor) => store.anchorNote(anchor),
    evmHistory: store.blocks,
    genesisMs,
    magic: store.magic,
    parentSupply: store.supplyState(),
    ...opts,
  })));
  return report(verdict, misses);
}

/**
 * The store's own next block (store.template, with whatever the mempool
 * holds), its txs walked in compact form through probeBlock. A reserve kind
 * needs the coinbase fields only the store's template stamps, so this is the
 * walk for every tx already queued.
 */
export async function droppedTemplateReads({ store, miner, now, sealHeader }) {
  const { tpl } = store.template({ miner, shareBits: 4, now });
  const header = await sealHeader(tpl.header, tpl.bits);
  const misses = new Set();
  const block = {
    header,
    height: tpl.height,
    txs: tpl.txs.map((row) => readWalk(compactTx(row), row, misses)),
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
  const verdict = await seeingThrough(() => Promise.resolve(store.probeBlock(block)));
  const plain = verdict?.ok ? null : await Promise.resolve(store.probeBlock({ ...block, txs: tpl.txs.map((row) => compactTx(row)) }));
  return { ...report(verdict, misses), plain, ids: tpl.txs.map((row) => String(row.id || '')) };
}

function report(verdict, misses) {
  const all = [...misses].sort();
  return {
    verdict,
    misses: all.filter((p) => !Object.prototype.hasOwnProperty.call(BENIGN_DROPPED_READS, p)),
    benign: all.filter((p) => Object.prototype.hasOwnProperty.call(BENIGN_DROPPED_READS, p)),
    readers: Object.fromEntries(all.map((p) => [p, misses.readers?.get(p) || ''])),
  };
}

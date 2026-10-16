/**
 * Incremental note book. A query reads one dest's notes.
 * Indexing a new suffix is the only chain walk, and it runs when the
 * book grows, not once per request over the whole height.
 */
import { MAGIC_TESTNET, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { hash20FromAddress } from '../../crypto/address.js';
import { openedCoinbaseNanos } from '../../crypto/coinbase_notes.js';
import { asU8, noteCommitOfDest20, verifySealedNote } from '../../crypto/note.js';
import { epochMs } from '../../crypto/pot_sched.js';

/**
 * A lock output is a vault tranche. A send cannot spend it, before or after
 * the epoch ends. Withdraw is the only way that principal leaves.
 * A vote is not a note.
 */
export function lockNoteHeld(out) {
  return String(out?.kind || '') === 'lock';
}

/** True once the lock's recorded unlock has passed. Coverage uses this.
 *  Spendable does not: a matured tranche is still not a send input. */
function lockNotePastUnlock(out, { tipMs = 0, genesisMs = 0, magic = MAGIC_TESTNET } = {}) {
  if (String(out?.kind || '') !== 'lock') return false;
  const tip = Number(tipMs) || 0;
  const unlock = Number(out?.unlockAtMs) || 0;
  if (unlock > 0) return tip >= unlock;
  const epoch = Number(out?.lockEpoch);
  const genesis = Number(genesisMs) || 0;
  if (Number.isInteger(epoch) && epoch >= 0 && genesis > 0) {
    const end = genesis + (epoch + 1) * epochMs(magic || MAGIC_TESTNET);
    return tip >= end;
  }
  return false;
}

function commitHex(v) {
  try {
    const b = Buffer.from(asU8(v));
    return b.length === 32 ? b.toString('hex') : '';
  } catch {
    return '';
  }
}

function dest20Hex(field) {
  if (!field) return '';
  try {
    const raw = field.data || field;
    const buf = Buffer.from(raw);
    return buf.length === 20 ? buf.toString('hex') : '';
  } catch {
    return '';
  }
}

function idOf(block, i) {
  try {
    if (block?.hash != null) {
      const b = Buffer.isBuffer(block.hash) ? block.hash : Buffer.from(block.hash);
      if (b.length > 0) return `${i}:${b.toString('hex')}`;
    }
  } catch { /* height fallback */ }
  return `${i}:h:${Number(block?.height) || 0}`;
}

function pushMap(map, key, rec) {
  if (!key) return;
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(rec);
}

function dropMap(map, key, rec) {
  if (!key) return;
  const arr = map.get(key);
  if (!arr) return;
  const at = arr.indexOf(rec);
  if (at >= 0) arr.splice(at, 1);
  if (!arr.length) map.delete(key);
}

export function createNoteLedger({ digestsOf = null } = {}) {
  let indexed = 0;
  const ids = [];
  const byCommit = new Map();
  const byDest20 = new Map();
  const notesAt = [];
  const spentCount = new Map();
  const spentAt = [];
  const digests = new Set();
  const digestsAt = [];
  let indexBlocks = 0;
  let indexOutputs = 0;
  let queryBlocks = 0;
  let queryOutputs = 0;
  let queryOpens = 0;
  let syncBlocks = 0;

  function addSpend(hex) {
    if (!hex) return;
    spentCount.set(hex, (spentCount.get(hex) || 0) + 1);
  }

  function removeSpend(hex) {
    if (!hex) return;
    const n = (spentCount.get(hex) || 0) - 1;
    if (n <= 0) spentCount.delete(hex);
    else spentCount.set(hex, n);
  }

  function indexOne(block, i) {
    indexBlocks += 1;
    syncBlocks += 1;
    const addedSpend = [];
    for (const tx of block?.txs || []) {
      if (tx?.coinbase) continue;
      for (const v of tx?.vin || []) {
        const hex = commitHex(v?.noteCommit);
        if (!hex) continue;
        addSpend(hex);
        addedSpend.push(hex);
      }
    }
    spentAt[i] = addedSpend;
    const recs = [];
    for (const tx of block?.txs || []) {
      const coinbase = !!tx?.coinbase;
      const vout = tx?.vout || [];
      for (let index = 0; index < vout.length; index += 1) {
        const o = vout[index];
        indexOutputs += 1;
        const kind = String(o?.kind || tx?.kind || '');
        if (kind === 'vote') continue;
        const rec = {
          height: Number(block?.height) || 0,
          coinbase,
          out: o,
          index,
          block,
          tx,
          commitHex: commitHex(o?.noteCommit),
          dest20Hex: kind === 'pool-withdraw' ? dest20Hex(o?.dest20) : '',
          opened: undefined,
        };
        if (rec.commitHex) pushMap(byCommit, rec.commitHex, rec);
        if (rec.dest20Hex) pushMap(byDest20, rec.dest20Hex, rec);
        recs.push(rec);
      }
    }
    notesAt[i] = recs;
    const addedDigest = [];
    if (typeof digestsOf === 'function') {
      const listed = digestsOf(block) || [];
      for (const d of listed) {
        const hex = String(d || '');
        if (!hex || digests.has(hex)) continue;
        digests.add(hex);
        addedDigest.push(hex);
      }
    }
    digestsAt[i] = addedDigest;
    ids[i] = idOf(block, i);
    indexed = i + 1;
  }

  function rollbackOne() {
    if (indexed < 1) return;
    const i = indexed - 1;
    for (const hex of digestsAt[i] || []) digests.delete(hex);
    for (const hex of spentAt[i] || []) removeSpend(hex);
    for (const rec of notesAt[i] || []) {
      dropMap(byCommit, rec.commitHex, rec);
      dropMap(byDest20, rec.dest20Hex, rec);
    }
    ids.pop();
    notesAt.pop();
    spentAt.pop();
    digestsAt.pop();
    indexed -= 1;
  }

  function sync(blocks) {
    const list = blocks || [];
    const before = syncBlocks;
    while (indexed > 0 && (
      indexed > list.length
      || idOf(list[indexed - 1], indexed - 1) !== ids[indexed - 1]
    )) {
      rollbackOne();
    }
    for (let i = indexed; i < list.length; i += 1) indexOne(list[i], i);
    return syncBlocks - before;
  }

  function openedOf(rec) {
    if (rec.opened !== undefined) return rec.opened;
    queryOpens += 1;
    const o = rec.out;
    let n = 0;
    if (o?.commit) {
      if (rec.coinbase) {
        const opened = openedCoinbaseNanos(o);
        n = opened == null ? 0 : opened;
      } else {
        const sealedV = Math.floor(Number(o.valueProof?.v != null ? o.valueProof.v : 0));
        n = (Number.isInteger(sealedV) && sealedV > 0 && verifySealedNote(o, sealedV)) ? sealedV : 0;
      }
    }
    rec.opened = n > 0 ? n : 0;
    return rec.opened;
  }

  function collect(address) {
    const dest20 = hash20FromAddress(address);
    if (!dest20) return { wantHex: '', destHex: '', rows: [] };
    const wantHex = noteCommitOfDest20(dest20).toString('hex');
    const destHex = dest20.toString('hex');
    const seen = new Set();
    const rows = [];
    const take = (arr) => {
      for (const rec of arr || []) {
        if (seen.has(rec)) continue;
        seen.add(rec);
        rows.push(rec);
      }
    };
    take(byCommit.get(wantHex));
    take(byDest20.get(destHex));
    queryOutputs += rows.length;
    return { wantHex, destHex, rows };
  }

  function rowNanos(rec, tip, { need, coinbaseOnly, wantHex, tipMs, genesisMs, magic, locksOnly = false }) {
    if (coinbaseOnly && !rec.coinbase) return 0;
    const kind = String(rec.out?.kind || rec.tx?.kind || '');
    if (locksOnly && kind !== 'lock') return 0;
    if (kind === 'lock' && lockNoteHeld(rec.out, { tipMs, genesisMs, magic })) return 0;
    const byNote = !!(rec.commitHex && rec.commitHex === wantHex);
    if (byNote && spentCount.has(rec.commitHex)) return 0;
    const h = Number(rec.height) || 0;
    if (!(h > 0 && (tip - h + 1) >= need)) return 0;
    return openedOf(rec);
  }

  function spendable(address, tipHeight, {
    need = SPENDABLE_CONFIRMATIONS,
    coinbaseOnly = false,
    tipMs = 0,
    genesisMs = 0,
    magic = MAGIC_TESTNET,
  } = {}) {
    const tip = Number(tipHeight) || 0;
    const { wantHex, rows } = collect(address);
    let nanos = 0;
    for (const rec of rows) {
      nanos += rowNanos(rec, tip, { need, coinbaseOnly, wantHex, tipMs, genesisMs, magic });
    }
    return nanos;
  }

  /** Matured lock notes are still not send inputs, so this sum stays zero. */
  function unlockedLockNanos(address, tipHeight, opts = {}) {
    const tip = Number(tipHeight) || 0;
    const { wantHex, rows } = collect(address);
    const need = opts.need ?? SPENDABLE_CONFIRMATIONS;
    let nanos = 0;
    for (const rec of rows) {
      nanos += rowNanos(rec, tip, { ...opts, need, wantHex, locksOnly: true });
    }
    return nanos;
  }

  /**
   * Lock notes whose unlock has passed, including ones already spent.
   * A spent note has left the wallet. It still covers its principal so a
   * later inbound is not frozen by that amount.
   */
  function coveredLockNanos(address, tipHeight, opts = {}) {
    const tip = Number(tipHeight) || 0;
    const { rows } = collect(address);
    const need = opts.need ?? SPENDABLE_CONFIRMATIONS;
    let nanos = 0;
    for (const rec of rows) {
      const kind = String(rec.out?.kind || rec.tx?.kind || '');
      if (kind !== 'lock') continue;
      if (opts.coinbaseOnly && !rec.coinbase) continue;
      if (!lockNotePastUnlock(rec.out, opts)) continue;
      const h = Number(rec.height) || 0;
      if (!(h > 0 && (tip - h + 1) >= need)) continue;
      nanos += openedOf(rec);
    }
    return nanos;
  }

  function refs(address) {
    const { wantHex, rows } = collect(address);
    const out = [];
    for (const rec of rows) {
      if (!rec.commitHex || rec.commitHex !== wantHex) continue;
      out.push({
        block: rec.block,
        tx: rec.tx,
        out: rec.out,
        index: rec.index,
      });
    }
    return out;
  }

  function stats() {
    return {
      indexed,
      indexBlocks,
      indexOutputs,
      queryBlocks,
      queryOutputs,
      queryOpens,
      syncBlocks,
    };
  }

  function resetQuery() {
    queryBlocks = 0;
    queryOutputs = 0;
    queryOpens = 0;
    syncBlocks = 0;
  }

  return {
    sync,
    spendable,
    unlockedLockNanos,
    coveredLockNanos,
    refs,
    spendDigests: () => digests,
    stats,
    resetQuery,
  };
}

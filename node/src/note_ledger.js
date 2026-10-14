/**
 * Incremental note book. A query reads one dest's notes.
 * Indexing a new suffix is the only chain walk, and it runs when the
 * book grows, not once per request over the whole height.
 */
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { hash20FromAddress } from '../../crypto/address.js';
import { openedCoinbaseNanos } from '../../crypto/coinbase_notes.js';
import { asU8, noteCommitOfDest20, verifySealedNote } from '../../crypto/note.js';

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
        if (kind === 'lock' || kind === 'vote') continue;
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

  function spendable(address, tipHeight, { need = SPENDABLE_CONFIRMATIONS, coinbaseOnly = false } = {}) {
    const tip = Number(tipHeight) || 0;
    const { wantHex, rows } = collect(address);
    let nanos = 0;
    for (const rec of rows) {
      if (coinbaseOnly && !rec.coinbase) continue;
      const byNote = !!(rec.commitHex && rec.commitHex === wantHex);
      if (byNote && spentCount.has(rec.commitHex)) continue;
      const h = Number(rec.height) || 0;
      if (!(h > 0 && (tip - h + 1) >= need)) continue;
      const n = openedOf(rec);
      if (n > 0) nanos += n;
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
    refs,
    spendDigests: () => digests,
    stats,
    resetQuery,
  };
}

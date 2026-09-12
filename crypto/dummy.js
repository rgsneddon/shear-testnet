/**
 * Flow dummy outs + view tags. Reserve kinds stay typed; vault is not dummy-deleted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sealNote } from './note.js';

export const DUMMY_KIND = 'dummy';
export const DUMMY_FANOUT = 1;
export const VIEW_TAG_DST = Buffer.from('shear-view-tag-v1');

const TYPED_NO_DUMMY = new Set(['lock', 'vote', 'withdraw', 'vortice-register']);

export function viewTagOf(noteCommit) {
  const nc = Buffer.from(noteCommit || []);
  if (nc.length < 1) return Buffer.alloc(1);
  return createHash('sha256').update(VIEW_TAG_DST).update(nc).digest().subarray(0, 1);
}

export function flowNeedsDummy(tx) {
  if (!tx || tx.coinbase) return false;
  const k = String(tx.kind || tx.vout?.[0]?.kind || '');
  if (TYPED_NO_DUMMY.has(k)) return false;
  return k === 'send' || k === '' || k === 'transfer';
}

export function dummyCount(tx) {
  return (tx?.vout || []).filter((o) => String(o.kind || '') === DUMMY_KIND).length;
}

export function attachDummyOuts(tx, { fanout = DUMMY_FANOUT } = {}) {
  if (!tx || !flowNeedsDummy(tx)) return tx;
  const out = { ...tx, vout: [...(tx.vout || [])] };
  let n = dummyCount(out);
  const want = Math.max(1, Math.floor(Number(fanout) || DUMMY_FANOUT));
  while (n < want) {
    const note = sealNote(0, { dest20: randomBytes(20), kind: DUMMY_KIND });
    note.viewTag = viewTagOf(note.noteCommit);
    out.vout.push(note);
    n += 1;
  }
  for (const o of out.vout) {
    if (o?.noteCommit && !o.viewTag) o.viewTag = viewTagOf(o.noteCommit);
  }
  return out;
}

export function publicExplorerRow(row) {
  const kind = String(row?.kind || '');
  const out = {
    id: row?.id,
    kind,
    height: row?.height,
    confirmed: !!row?.confirmed,
    memo: !!row?.memo,
    amountHidden: true,
  };
  if (kind === 'lock' || kind === 'vote' || kind === 'withdraw' || kind === 'vortice-register') {
    out.to = row?.to || '';
  }
  if (row?.noteCommit) out.note = Buffer.from(row.noteCommit).toString('hex');
  return out;
}

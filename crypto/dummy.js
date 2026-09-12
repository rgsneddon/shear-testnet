/**
 * Flow dummy outs + view tags. Reserve kinds stay typed; vault is not dummy-deleted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sealNote, verifySealedNote } from './note.js';
import { hash20FromAddress } from './address.js';

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

export function claimedVoutNanos(tx, o, i) {
  if (!o) return 0;
  if (String(o.kind || '') === DUMMY_KIND) return 0;
  if (o.commit) {
    const claimed = i === 0
      ? Math.floor(Number(tx?.nanos || o.nanos || 0))
      : Math.floor(Number(o.nanos || tx?.changeNanos || 0));
    return verifySealedNote(o, claimed) ? claimed : 0;
  }
  return Math.floor(Number(o.nanos || 0));
}

export function sealFlowVout(o) {
  if (!o || o.commit) return o;
  const n = Math.floor(Number(o.nanos || 0));
  const d20 = hash20FromAddress(o.address);
  if (!d20) return o;
  const note = sealNote(n, { dest20: d20, kind: o.kind || 'send' });
  note.viewTag = viewTagOf(note.noteCommit);
  if (o.address) note.address = o.address;
  return note;
}

export function attachDummyOuts(tx, { fanout = DUMMY_FANOUT } = {}) {
  if (!tx || !flowNeedsDummy(tx)) return tx;
  const raw = [...(tx.vout || [])];
  const payN = Math.floor(Number(tx.nanos != null ? tx.nanos : raw[0]?.nanos || 0));
  const changeRaw = raw.find((o, i) => i > 0 && String(o.kind) !== DUMMY_KIND);
  const changeN = Math.floor(Number(tx.changeNanos != null ? tx.changeNanos : changeRaw?.nanos || 0));
  const out = { ...tx, nanos: payN, vout: raw.map(sealFlowVout) };
  if (changeN) out.changeNanos = changeN;
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

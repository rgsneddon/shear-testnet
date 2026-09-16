/**
 * Flow dummy outs + view tags. Reserve kinds stay typed; vault is not dummy-deleted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sealNote, verifySealedNote, kernelExcess, bindVinToSpent, asU8 } from './note.js';
import { hash20FromAddress, admitBaseFromAddress } from './address.js';
import { attachAdmitPub } from './admit.js';

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

/** Money C on Flow and Reserve notes. Missing C is range_proof, including lock/vote/withdraw. */
export function moneyNeedsRange(tx) {
  if (!tx || tx.coinbase) return false;
  const k = String(tx.kind || tx.vout?.[0]?.kind || '');
  return flowNeedsDummy(tx) || k === 'lock' || k === 'vote' || k === 'withdraw';
}

/**
 * Historical Reserve compact: dest20 + valueProof.v, no Pedersen C.
 * Live heights 188/198/199 were mined this way; new mempool locks still need C.
 */
export function reserveDest20Open(o) {
  const k = String(o?.kind || '');
  if (k !== 'lock' && k !== 'vote' && k !== 'withdraw') return false;
  if (o?.commit) return false;
  try {
    const d = Buffer.from(asU8(o.dest20));
    return d.length >= 20;
  } catch {
    return false;
  }
}

export function dummyCount(tx) {
  return (tx?.vout || []).filter((o) => String(o.kind || '') === DUMMY_KIND).length;
}

export function claimedVoutNanos(tx, o, i) {
  if (!o) return 0;
  if (String(o.kind || '') === DUMMY_KIND) return 0;
  if (o.commit) {
    const claimed = o.valueProof?.v != null
      ? Math.floor(Number(o.valueProof.v))
      : (i === 0
        ? Math.floor(Number(tx?.nanos || o.nanos || 0))
        : Math.floor(Number(o.nanos || tx?.changeNanos || 0)));
    return verifySealedNote(o, claimed) ? claimed : 0;
  }
  return Math.floor(Number(o.nanos || 0));
}

export function sealFlowVout(o) {
  if (!o || o.commit) return o;
  const n = Math.floor(Number(o.nanos || 0));
  const d20 = hash20FromAddress(o.address);
  if (!d20) return o;
  let note = sealNote(n, { dest20: d20, kind: o.kind || 'send' });
  note.viewTag = viewTagOf(note.noteCommit);
  note.dest20 = d20;
  if (o.address) note.address = o.address;
  note = attachAdmitPub(note, { admitBase: admitBaseFromAddress(o.address) });
  return note;
}

export function attachDummyOuts(tx, { fanout = DUMMY_FANOUT, spent } = {}) {
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
    let note = sealNote(0, { dest20: randomBytes(20), kind: DUMMY_KIND });
    note.viewTag = viewTagOf(note.noteCommit);
    note = attachAdmitPub(note);
    out.vout.push(note);
    n += 1;
  }
  for (const o of out.vout) {
    if (o?.noteCommit && !o.viewTag) o.viewTag = viewTagOf(o.noteCommit);
  }
  if (Array.isArray(tx.vin) && tx.vin.length) {
    const vin = tx.vin.map((v, i) => {
      const src = Array.isArray(spent) ? spent[i] : (i === 0 ? spent : null);
      if (src?.commit) {
        return bindVinToSpent({ ...v }, src);
      }
      const row = { ...v };
      if (!row.commit) delete row.commit;
      if (!row.dest20 && v.address) {
        const d20 = hash20FromAddress(v.address);
        if (d20) row.dest20 = d20;
      }
      return row;
    });
    out.vin = vin;
    if (vin.every((v) => v.r) && out.vout.every((o) => o.r)) {
      const excess = kernelExcess(out.vout, vin);
      if (excess) out.excess = excess;
    }
  }
  return out;
}

export function publicExplorerRow(row) {
  const out = {
    id: row?.id,
    kind: String(row?.kind || ''),
    height: row?.height,
    confirmed: !!row?.confirmed,
    memo: !!row?.memo,
    amountHidden: true,
  };
  if (row?.noteCommit) out.note = Buffer.from(row.noteCommit).toString('hex');
  return out;
}

/**
 * Two checks every test that builds a real tx can run on it:
 * - everyFieldBound: change any one byte-carrying leaf of the compact body
 *   (TX_DIGEST=body-v2) and the leaf digest changes. A change compactTx
 *   itself undoes (it rebuilds the field from other bytes) must be on
 *   NORMALIZED, with the reason; any other unchanged digest fails.
 * - stripFieldsIn: a compact body carries no field on the strip list:
 *   secrets, client hints, addresses, and plaintext amounts on hidden rows.
 */
import assert from 'node:assert/strict';
import { digestTx } from '../src/chain.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { canonicalEncode } from '../../crypto/canonical_row.js';
import { STRIP_ANYWHERE as ARRIVAL_STRIP_ANYWHERE, STRIP_TOP as ARRIVAL_STRIP_TOP } from '../../crypto/arrival_fields.js';

/** Fields compactTx rebuilds from other bytes, so a lie in them cannot survive. */
export const NORMALIZED = Object.freeze({
  spendTag: 'compactTx replaces a posted tag with the tag read from the proof blob',
  'admit_proof.spendTag': 'compactTx replaces a posted tag with the tag read from the proof blob',
  'admit_proofs[].spendTag': 'compactTx replaces a posted tag with the tag read from the proof blob',
  'admit_proof.v': 'compactTx labels the proof with the blob version byte',
  'admit_proof.admit_proof': 'compactTx marks the proof row; the label is constant',
  memo: 'compactTx derives memo:true from the memo envelope',
  'vout[].memo': 'compactTx derives memo:true from the memo envelope',
  'vin[].coinbase': 'compactTx writes the coinbase vin as {coinbase:true,height} from tx.height',
  'vin[].height': 'compactTx writes the coinbase vin as {coinbase:true,height} from tx.height',
});

function isBytes(v) {
  return Buffer.isBuffer(v) || v instanceof Uint8Array;
}

function leafPaths(v, at = [], out = []) {
  if (v == null) return out;
  if (isBytes(v) || typeof v !== 'object') {
    out.push(at);
    return out;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => leafPaths(x, [...at, i], out));
    return out;
  }
  for (const k of Object.keys(v)) if (v[k] !== undefined) leafPaths(v[k], [...at, k], out);
  return out;
}

function label(path) {
  return path.map((p) => (typeof p === 'number' ? '[]' : p)).join('.').replace(/\.\[\]/g, '[]');
}

function changed(v) {
  if (isBytes(v)) {
    const b = Buffer.from(v);
    if (!b.length) return Buffer.from([1]);
    b[b.length - 1] ^= 1;
    return b;
  }
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'bigint') return v + 1n;
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'string') {
    const last = v.slice(-1);
    const swap = /[0-9a-f]/.test(last) ? (last === '0' ? '1' : '0') : `${last}x`;
    return `${v.slice(0, -1)}${swap}`;
  }
  return undefined;
}

function withLeaf(body, path, value) {
  const copy = structuredClone(body);
  let at = copy;
  for (let i = 0; i < path.length - 1; i += 1) at = at[path[i]];
  at[path[path.length - 1]] = value;
  return copy;
}

/**
 * Every leaf of compactTx(tx) is in the leaf digest, but the id of any kind
 * other than a withdraw, which is shown not to be. Returns the paths
 * checked and the normalized ones, for the test to print.
 */
export function everyFieldBound(tx, name = String(tx?.id || tx?.kind || 'tx')) {
  const body = compactTx(tx);
  const base = digestTx(body).toString('hex');
  assert.equal(digestTx(tx).toString('hex'), base, `${name}: the full row and its compact copy are one leaf`);
  const baseBody = canonicalEncode(compactTx(body));
  const checked = [];
  const normalized = [];
  for (const path of leafPaths(body)) {
    let leaf = body;
    for (const p of path) leaf = leaf[p];
    const next = changed(leaf);
    if (next === undefined) continue;
    const mutated = withLeaf(body, path, next);
    const name2 = label(path);
    if (canonicalEncode(compactTx(mutated)) === baseBody) {
      assert.ok(Object.prototype.hasOwnProperty.call(NORMALIZED, name2), `${name}: ${name2} changed but compaction undid it, and it is not on NORMALIZED`);
      normalized.push(name2);
      continue;
    }
    if (name2 === 'id' && String(body.kind || '') !== 'withdraw') {
      // The id is a label its sender picks and no signature covers: it is
      // not in the leaf (Russell 26 Oct). A withdraw signs its id, so there it is.
      assert.equal(digestTx(mutated).toString('hex'), base, `${name}: the id is not in the leaf digest`);
      continue;
    }
    assert.notEqual(digestTx(mutated).toString('hex'), base, `${name}: ${name2} is not in the leaf digest`);
    checked.push(name2);
  }
  assert.ok(checked.length > 0, `${name}: no field checked`);
  return { checked: [...new Set(checked)], normalized: [...new Set(normalized)] };
}

// The strip list is the arrival gate's (crypto/arrival_fields.js). A compact
// body never carries one of those, except spendPub, which a b-spend's
// compact body keeps; nor the refused fields evmProof, rootIndex, remainProof.
const STRIP_ANYWHERE = [
  ...ARRIVAL_STRIP_ANYWHERE.filter((k) => k !== 'spendPub'),
  'evmProof', 'rootIndex', 'remainProof',
];
const STRIP_TOP = [...ARRIVAL_STRIP_TOP];
const HIDDEN_KINDS = new Set(['', 'send', 'transfer', 'change', 'lock']);

/** Strip-list fields a compact body still carries, as paths. Empty means clean. */
export function stripFieldsIn(body) {
  const found = [];
  const walk = (v, at) => {
    if (v == null || typeof v !== 'object' || isBytes(v)) return;
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, `${at}[]`));
      return;
    }
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) continue;
      const here = at ? `${at}.${k}` : k;
      if (STRIP_ANYWHERE.includes(k)) found.push(here);
      walk(v[k], here);
    }
  };
  walk(body, '');
  const kind = String(body?.kind || '');
  if (body && kind !== 'vortice-register') {
    for (const k of STRIP_TOP) if (body[k] !== undefined) found.push(k);
  }
  if (body && !body.coinbase && HIDDEN_KINDS.has(kind) && body.nanos !== undefined) found.push('nanos');
  for (const o of Array.isArray(body?.vout) ? body.vout : []) {
    if (o && o.commit && o.nanos !== undefined) found.push('vout[].nanos');
    if (o && o.address !== undefined && kind !== 'vortice-register') found.push('vout[].address');
  }
  return [...new Set(found)].sort();
}

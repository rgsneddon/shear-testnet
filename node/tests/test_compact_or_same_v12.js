/**
 * store.js compactOrSame (Russell 26 Oct, ruling B: keep). A row that arrives
 * already compact is validated as that object, not as a copy. It may only
 * ever be the object when the object is its compact form exactly, so it can
 * never turn an invalid body into a valid one: an already-compact block and
 * the same block whose rows must be compacted again get one verdict, valid
 * or not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { digestTx } from '../src/chain.js';
import { sameCompactShape } from '../src/store.js';
import { createRegtestStore } from './regtest_store.js';

const T0 = 1_700_000_000_000;

/** Every Buffer as a bare Uint8Array: the same bytes, not the same shape. */
function asViews(v) {
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  if (Array.isArray(v)) return v.map(asViews);
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asViews(x)]));
  }
  return v;
}

function blockOf(tpl, txs, miner) {
  const head = decodeHeader(Buffer.from(tpl.header));
  return {
    header: encodeHeader({ ...head, merkleRoot: merkleRoot(txs.map((tx) => digestTx(compactTx(tx)))) }),
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

describe('compactOrSame never makes an invalid body valid', () => {
  it('sameCompactShape is exact equality of the compact form', () => {
    const row = { kind: 'pot', commit: Buffer.alloc(32, 7), list: [1, { v: 2 }] };
    assert.equal(sameCompactShape(row, structuredClone({ ...row, commit: Buffer.alloc(32, 7) })), false, 'structuredClone turns a Buffer into a Uint8Array');
    assert.equal(sameCompactShape(row, { ...row, commit: Buffer.alloc(32, 7), list: [1, { v: 2 }] }), true);
    assert.equal(sameCompactShape(row, { ...row, extra: undefined }), true, 'an undefined value is no key');
    for (const [label, other] of [
      ['a byte', { ...row, commit: Buffer.alloc(32, 8) }],
      ['a view', { ...row, commit: new Uint8Array(32).fill(7) }],
      ['a key', { ...row, extra: 1 }],
      ['a missing key', { kind: 'pot', commit: row.commit }],
      ['a value', { ...row, list: [1, { v: 3 }] }],
      ['a string for a number', { ...row, list: ['1', { v: 2 }] }],
      ['an array length', { ...row, list: [1, { v: 2 }, 3] }],
      ['a prototype', { ...row, list: [1, Object.assign(Object.create({ v: 2 }), { v: 2 })] }],
      ['a Map', { ...row, list: [1, new Map([['v', 2]])] }],
    ]) {
      assert.equal(sameCompactShape(row, other), false, label);
      assert.equal(sameCompactShape(other, row), false, `${label}, swapped`);
    }
    assert.equal(sameCompactShape(NaN, NaN), false, 'NaN is not the same: the copy is validated');
  });

  it('an already-compact block and its re-compacted copy get one verdict, valid or invalid', async () => {
    const store = createRegtestStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-compact-same-')), { bits: 4 });
    const miner = freshStealthDest(newIdentity()).dest;
    const { tpl } = store.template({ miner, bits: regtestBitsOverride(MAGIC_REGTEST), shareBits: 4, now: T0 });
    const compact = tpl.txs.map((tx) => {
      if (!tx?.coinbase) return compactTx(tx);
      const { samples: _s, ...rest } = tx;
      return compactTx({ ...rest, coinbase: true });
    });
    const cb = compact[0];
    assert.ok(Array.isArray(cb.vout) && cb.vout.length > 0 && Buffer.isBuffer(cb.vout[0].commit), 'the coinbase has a committed output');
    // The view form compacts back to the compact row: the store must take
    // the copy path for it and the same-object path for the compact row.
    assert.equal(sameCompactShape(asViews(cb), compactTx(asViews(cb))), false);
    assert.equal(sameCompactShape(compactTx(asViews(cb)), cb), true);
    assert.equal(sameCompactShape(cb, compactTx(cb)), true);

    const flip = (buf, at) => { const b = Buffer.from(buf); b[at] ^= 1; return b; };
    const faults = [
      ['honest', (row) => row],
      ['commit', (row) => ({ ...row, vout: [{ ...row.vout[0], commit: flip(row.vout[0].commit, 5) }, ...row.vout.slice(1)] })],
    ];
    if (Buffer.isBuffer(cb.vout[0].rangeProof)) {
      faults.push(['range proof', (row) => ({ ...row, vout: [{ ...row.vout[0], rangeProof: flip(row.vout[0].rangeProof, 40) }, ...row.vout.slice(1)] })]);
    }
    for (const [label, fault] of faults) {
      const row = fault(cb);
      const same = await Promise.resolve(store.probeBlock(blockOf(tpl, [row, ...compact.slice(1)], miner)));
      const copy = await Promise.resolve(store.probeBlock(blockOf(tpl, [asViews(row), ...compact.slice(1)], miner)));
      assert.deepEqual({ ok: same.ok, reason: same.reason }, { ok: copy.ok, reason: copy.reason }, `${label}: one verdict on both paths`);
      if (label === 'honest') assert.equal(same.ok, true, `honest: ${same.reason}`);
      else assert.equal(same.ok, false, `${label}: an invalid compact row is refused on the same-object path`);
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { verifyBlock, digestTx, buildTemplate, GENESIS_PREV } from '../src/chain.js';
import { GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { reserveFeeDest } from '../../crypto/levy.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import {
  sealCoinbaseNote,
  openedCoinbaseNanos,
  coinbaseVoutsBound,
  noteU64,
  excessOf,
  addExcess,
} from '../../crypto/note.js';
import { arrivalFieldRejected } from '../../crypto/arrival_fields.js';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

const TRUSTED = Buffer.alloc(32);

/** A genesis block whose body is one claim paying `fee`, header bound to it. */
function feeBlock(now, fee) {
  const miner = minerDest();
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner,
    bits: GENESIS_BITS_PACKED,
    now,
    txs: [{ kind: 'claim', fee, vin: [{ address: miner }] }],
  });
  return {
    header: tpl.header,
    height: 1,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

describe('v12 coinbase outputs are individually bound', () => {
  it('opens any non-negative amount and rejects a missing range proof', () => {
    const amounts = [0n, 1n, 2_000_000_000n, 100_000_000_000n, (1n << 53n) - 1n, (1n << 53n) + 1n, (1n << 64n) - 1n];
    for (const amount of amounts) {
      const note = sealCoinbaseNote(amount, { kind: 'pot' });
      const opened = openedCoinbaseNanos(note);
      assert.equal(noteU64(opened), amount);
      const asText = { ...note, valueProof: { ...note.valueProof, v: amount.toString() } };
      assert.equal(noteU64(openedCoinbaseNanos(asText)), amount);
      assert.equal(openedCoinbaseNanos({ ...note, rangeProof: Buffer.alloc(0) }), null);
      assert.equal(openedCoinbaseNanos({ ...note, rangeProof: undefined }), null);
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        const rounded = { ...note, valueProof: { ...note.valueProof, v: Number(amount) } };
        assert.equal(openedCoinbaseNanos(rounded), null);
      }
    }
    assert.equal(openedCoinbaseNanos({ commit: Buffer.alloc(32), valueProof: { v: -1n } }), null);
    assert.equal(openedCoinbaseNanos({ commit: Buffer.alloc(32), valueProof: { v: 1n << 64n } }), null);
    assert.equal(openedCoinbaseNanos({ commit: Buffer.alloc(32), valueProof: { v: '01' } }), null);
    assert.equal(openedCoinbaseNanos({ commit: Buffer.alloc(32), valueProof: { v: '1.5' } }), null);
    const a = sealCoinbaseNote(7, { kind: 'pot' });
    const b = sealCoinbaseNote(11, { kind: 'finder-fee' });
    const wide = (1n << 53n) + 1n;
    const c = sealCoinbaseNote(wide, { kind: 'reserve-fee' });
    const bound = coinbaseVoutsBound([a, b, c], excessOf([a, b, c]));
    assert.equal(bound.ok, true);
    assert.equal(noteU64(bound.opened), 18n + wide);
    assert.equal(noteU64(bound.levy), 11n + wide);
    assert.equal(noteU64(bound.rest), 7n);
    const dropped = coinbaseVoutsBound([a, { ...b, rangeProof: Buffer.alloc(0) }], excessOf([a, b]));
    assert.equal(dropped.ok, false);
    assert.equal(dropped.reason, 'coinbase_output');
    const unbound = coinbaseVoutsBound([a, { ...b, valueProof: undefined }], excessOf([a, b]));
    assert.equal(unbound.ok, false);
  });

  it('a sealed block fails if any coinbase output loses its proof, including an extra levy note', async () => {
    // R28: the reserve levy note is the one explicit coinbase output. An
    // empty round with no fee key pays its whole finder levy with it, so a
    // block whose body pays a fee carries one.
    const t0 = 1_700_000_000_000;
    const tip = feeBlock(t0, 1000);
    assert.equal(tip.txs[0].vout.length, 1);
    assert.equal(tip.txs[0].vout[0].kind, 'reserve-fee');
    const stamp = t0;
    const verdict = (block) => verifyBlock(block, null, {
      genesisMs: stamp,
      trustedPowHash: TRUSTED,
      skipSharePow: true,
      nowMs: stamp,
    });
    const again = verdict(tip);
    assert.equal(again.ok, true, again.reason);

    const stripped = {
      ...tip,
      txs: [{
        ...tip.txs[0],
        vout: tip.txs[0].vout.map((o, i) => (i === 0 ? { ...o, rangeProof: Buffer.alloc(0) } : o)),
      }, ...tip.txs.slice(1)],
    };
    // The leaf binds the compact coinbase, its range proofs included
    // (TX_DIGEST=body-v2): under the old header the edit is merkle, and
    // resealed over it the coinbase check itself refuses it.
    const unsealed = verdict(stripped);
    assert.equal(unsealed.ok, false);
    assert.equal(unsealed.reason, 'merkle');
    const bad = verdict({
      ...stripped,
      header: encodeHeader({
        ...decodeHeader(Buffer.from(tip.header)),
        merkleRoot: merkleRoot(stripped.txs.map(digestTx)),
      }),
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'coinbase_output');

    const withExtra = (extra) => {
      const vout = tip.txs[0].vout.concat([extra]);
      const txs = [{
        ...tip.txs[0],
        vout,
        excess: addExcess(tip.txs[0].excess, extra.r),
      }, ...tip.txs.slice(1)];
      const decoded = decodeHeader(Buffer.from(tip.header));
      return verdict({
        ...tip,
        header: encodeHeader({
          version: decoded.version,
          prevBlockHash: decoded.prevBlockHash,
          merkleRoot: merkleRoot(txs.map(digestTx)),
          continuityRoot: decoded.continuityRoot,
          timestamp: decoded.timestamp,
          bits: decoded.bits,
          nonce: decoded.nonce,
          baseFee: decoded.baseFee,
        }),
        txs,
      });
    };
    // An extra public finder-fee note, labelled by its own dest20: an R28
    // coinbase carries only the reserve levy note, so it is refused.
    const levy = withExtra(sealCoinbaseNote(1, { kind: 'finder-fee', dest20: Buffer.alloc(20, 0x5a) }));
    assert.equal(levy.ok, false);
    assert.equal(levy.reason, 'blunote_vout');
    // An extra reserve levy note to the reserve: the levy sum refuses it.
    const extraReserve = withExtra(sealCoinbaseNote(1, { kind: 'reserve-fee', dest20: Buffer.from(hash20FromAddress(reserveFeeDest())) }));
    assert.equal(extraReserve.ok, false);
    assert.equal(extraReserve.reason, 'levy_split');
    // The same extra with a label and no dest20 (sealCoinbaseNote's zero
    // label) is a second fault, which COINBASE_NC=dest-bound names first.
    const unbound = withExtra(sealCoinbaseNote(1, { kind: 'reserve-fee' }));
    assert.equal(unbound.ok, false);
    assert.equal(unbound.reason, 'coinbase_output');
  });

  it('an arriving coinbase states each published v as a canonical u64 and carries no membership', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-cb-arrive-'));
    try {
      // R28: the reserve levy note is the coinbase output that publishes a v.
      const cb = feeBlock(1_700_000_000_000, 1000).txs[0];
      assert.equal(cb.coinbase, true);
      assert.equal(arrivalFieldRejected(cb), null, 'the sealed coinbase arrives');
      const at = cb.vout.findIndex((o) => o?.valueProof?.v != null);
      assert.ok(at >= 0, 'the coinbase publishes a v');
      const v = noteU64(cb.vout[at].valueProof.v);
      const withV = (raw) => ({
        ...cb,
        vout: cb.vout.map((o, i) => (i === at ? { ...o, valueProof: { ...o.valueProof, v: raw } } : o)),
      });
      // One amount however the row holds it: a number, a JSON string, a bigint.
      for (const raw of [Number(v), String(v), v]) {
        assert.equal(arrivalFieldRejected(withV(raw)), null, `v ${typeof raw}`);
      }
      // Not a u64: refused on arrival, before any opening is tried.
      for (const raw of [`0${v}`, `${v}.0`, '-1', 'x1', ' 1', '18446744073709551616', -1, 1.5, true]) {
        assert.deepEqual(arrivalFieldRejected(withV(raw)), { ok: false, reason: 'coinbase_output' }, `v ${JSON.stringify(String(raw))}`);
      }
      // A carried proof or tag is admit_membership, not a field compaction drops.
      const proof = { blob: Buffer.from([3, 1]), cTilde: Buffer.alloc(32, 3), spendTag: Buffer.alloc(32, 2) };
      for (const carry of [{ admit_proof: proof }, { admit_proofs: [proof] }, { spendTag: proof.spendTag }]) {
        assert.deepEqual(arrivalFieldRejected({ ...cb, ...carry }), { ok: false, reason: 'admit_membership' }, Object.keys(carry)[0]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { verifyBlock, digestTx } from '../src/chain.js';
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
import { newIdentity } from '../../crypto/address.js';
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
    const dest = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-cb-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    const { tpl } = store.template({ miner: dest, shareBits: 4, now: t0 });
    const block = {
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    };
    const got = await Promise.resolve(store.append(block, {
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
    }));
    assert.equal(got.ok, true, got.reason);
    const tip = store.tip();
    const stamp = Number(decodeHeader(Buffer.from(tip.header)).timestamp);
    const again = verifyBlock(tip, null, {
      genesisMs: stamp,
      trustedPowHash: Buffer.from(tip.hash),
      skipSharePow: true,
      nowMs: stamp,
    });
    assert.equal(again.ok, true, again.reason);

    const stripped = {
      ...tip,
      txs: [{
        ...tip.txs[0],
        vout: tip.txs[0].vout.map((o, i) => (i === 0 ? { ...o, rangeProof: Buffer.alloc(0) } : o)),
      }, ...tip.txs.slice(1)],
    };
    const bad = verifyBlock(stripped, null, {
      genesisMs: stamp,
      trustedPowHash: Buffer.from(tip.hash),
      skipSharePow: true,
      nowMs: stamp,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'coinbase_output');

    const extra = sealCoinbaseNote(1, { kind: 'finder-fee' });
    const vout = tip.txs[0].vout.concat([extra]);
    const txs = [{
      ...tip.txs[0],
      vout,
      excess: addExcess(tip.txs[0].excess, extra.r),
    }, ...tip.txs.slice(1)];
    const decoded = decodeHeader(Buffer.from(tip.header));
    const withLevy = {
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
    };
    const levy = verifyBlock(withLevy, null, {
      genesisMs: stamp,
      trustedPowHash: Buffer.from(tip.hash),
      skipSharePow: true,
      nowMs: stamp,
    });
    assert.equal(levy.ok, false);
    assert.equal(levy.reason, 'levy_split');
  });
});

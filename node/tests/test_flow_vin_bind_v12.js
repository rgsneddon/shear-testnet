import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { verifyBlock, digestTx } from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { flowInputsBound } from '../../crypto/note.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
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

function commit(byte) {
  return Buffer.alloc(32, byte);
}

/**
 * A v12 Flow send names no amount in clear (AL-1, e2bd74cf): neither tx.nanos
 * nor an output nanos. The output here carries no commit or range proof, so a
 * bound send still stops at range_proof.
 */
function flowTx({ vins, proofs }) {
  const tx = {
    kind: 'send',
    vin: vins,
    vout: [{ kind: 'send' }],
    fee: 0,
  };
  if (proofs.length === 1) tx.admit_proof = proofs[0];
  else tx.admit_proofs = proofs;
  return tx;
}

/** The same send painted with a plaintext amount, as the pre-AL-1 wire did. */
function paintedTx(tx, nanos) {
  return { ...tx, nanos, vout: [{ kind: 'send', nanos }] };
}

function proofFor(c, tagByte) {
  return { cTilde: c, spendTag: commit(tagByte) };
}

describe('v12 Flow inputs are bound to Admit proofs', () => {
  it('rejects an unbound vin for any amount and any vin count', () => {
    const one = commit(1);
    const two = commit(2);
    const matched = flowTx({
      vins: [{ commit: one }],
      proofs: [proofFor(one, 9)],
    });
    assert.equal(flowInputsBound(matched).ok, true);
    const mismatch = flowTx({
      vins: [{ commit: one }],
      proofs: [proofFor(two, 9)],
    });
    assert.equal(flowInputsBound(mismatch).reason, 'admit_membership');
    const extra = flowTx({
      vins: [{ commit: one }, { commit: two }],
      proofs: [proofFor(one, 9)],
    });
    assert.equal(flowInputsBound(extra).reason, 'admit_membership');
    const both = flowTx({
      vins: [{ commit: one }, { commit: two }],
      proofs: [proofFor(one, 9), proofFor(two, 8)],
    });
    assert.equal(flowInputsBound(both).ok, true);
    const coinbaseVin = flowTx({
      vins: [{ commit: one, coinbase: true }],
      proofs: [proofFor(one, 9)],
    });
    assert.equal(flowInputsBound(coinbaseVin).reason, 'admit_membership');
    // The v12 wire names no amount, so the policy book binds the membership
    // shape (ec1dfa52) and an unbound vin is admit_membership.
    for (const bad of [mismatch, extra, coinbaseVin]) {
      const parked = admitMempool(emptyMempool(), bad, { baseFee: 1 });
      assert.equal(parked.ok, false);
      assert.equal(parked.reason, 'admit_membership');
    }
    const parkedBound = admitMempool(emptyMempool(), matched, { baseFee: 1 });
    assert.equal(parkedBound.ok, false);
    assert.equal(parkedBound.reason, 'range_proof');
    // An address-only vin with no proof is no membership attempt. Its vin is
    // a real dest, so the HRP gate (4c409f7a) passes and range_proof stays.
    const noMaterial = {
      kind: 'send',
      fee: 0,
      vin: [{ address: minerDest() }],
      vout: [{ kind: 'send' }],
    };
    const parkedBare = admitMempool(emptyMempool(), noMaterial, { baseFee: 1 });
    assert.equal(parkedBare.ok, false);
    assert.equal(parkedBare.reason, 'range_proof');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-flow-bare-'));
    try {
      const store = createStore(dir);
      const queued = store.queueTx(noMaterial);
      assert.equal(queued.ok, false);
      assert.equal(queued.reason, 'admit_membership');
      // A painted amount, at any size, is amount_field (AL-1) before any
      // binding, on the queue and in the mempool. It never reaches the book.
      for (const nanos of [1, 2_000_000_000, 100_000_000_000]) {
        for (const tx of [matched, mismatch, extra, coinbaseVin, noMaterial]) {
          const painted = paintedTx(tx, nanos);
          const parked = admitMempool(emptyMempool(), painted, { baseFee: 1 });
          assert.equal(parked.ok, false);
          assert.equal(parked.reason, 'amount_field', `mempool ${nanos}`);
          const q = store.queueTx(painted);
          assert.equal(q.ok, false);
          assert.equal(q.reason, 'amount_field', `queue ${nanos}`);
        }
      }
      assert.equal(store.mempool.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifyBlock rejects the extra vin before it can fund the block', async () => {
    const dest = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-flow-bind-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    const tpl = store.template({ miner: dest, shareBits: 4, now: t0 }).tpl;
    const one = commit(4);
    const two = commit(5);
    // Consensus has no membership-shape path: a Flow proof whose first byte
    // is not 3 is admit_version (0192e5fd) before chain.js binds a vin, so an
    // unbound or extra vin never funds the block. A painted amount is
    // amount_field (AL-1, e2bd74cf) before that.
    const shapes = [
      { name: 'mismatch', tx: flowTx({ vins: [{ commit: one }], proofs: [proofFor(two, 7)] }), nanos: 1 },
      {
        name: 'extra',
        tx: flowTx({ vins: [{ commit: one }, { commit: two }], proofs: [proofFor(one, 7)] }),
        nanos: 100_000_000_000,
      },
      { name: 'bound-one', tx: flowTx({ vins: [{ commit: one }], proofs: [proofFor(one, 7)] }), nanos: 3 },
    ];
    assert.equal(flowInputsBound(shapes[0].tx).reason, 'admit_membership');
    assert.equal(flowInputsBound(shapes[1].tx).reason, 'admit_membership');
    assert.equal(flowInputsBound(shapes[2].tx).ok, true);
    const cases = [];
    for (const s of shapes) {
      cases.push({ name: s.name, tx: s.tx, reason: 'admit_version' });
      cases.push({ name: `${s.name}-painted`, tx: paintedTx(s.tx, s.nanos), reason: 'amount_field' });
    }
    for (const row of cases) {
      const txs = tpl.txs.concat([row.tx]);
      const decoded = decodeHeader(Buffer.from(tpl.header));
      decoded.merkleRoot = merkleRoot(txs.map(digestTx));
      const got = verifyBlock({
        header: encodeHeader(decoded),
        txs,
        shareBatch: [],
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
      }, null, {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
        nowMs: t0,
        genesisMs: t0,
      });
      assert.equal(got.ok, false, row.name);
      assert.equal(got.reason, row.reason, row.name);
    }
  });
});

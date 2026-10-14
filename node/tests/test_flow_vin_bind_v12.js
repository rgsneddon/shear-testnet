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

function flowTx({ vins, proofs, nanos }) {
  const tx = {
    kind: 'send',
    nanos,
    vin: vins,
    vout: [{ kind: 'send', nanos }],
    fee: 0,
  };
  if (proofs.length === 1) tx.admit_proof = proofs[0];
  else tx.admit_proofs = proofs;
  return tx;
}

function proofFor(c, tagByte) {
  return { cTilde: c, spendTag: commit(tagByte) };
}

describe('v12 Flow inputs are bound to Admit proofs', () => {
  it('rejects an unbound vin for any amount and any vin count', () => {
    for (const nanos of [1, 2_000_000_000, 100_000_000_000]) {
      const one = commit(1);
      const two = commit(2);
      const matched = flowTx({
        nanos,
        vins: [{ commit: one }],
        proofs: [proofFor(one, 9)],
      });
      assert.equal(flowInputsBound(matched).ok, true);
      const mismatch = flowTx({
        nanos,
        vins: [{ commit: one }],
        proofs: [proofFor(two, 9)],
      });
      assert.equal(flowInputsBound(mismatch).reason, 'admit_membership');
      const extra = flowTx({
        nanos,
        vins: [{ commit: one }, { commit: two }],
        proofs: [proofFor(one, 9)],
      });
      assert.equal(flowInputsBound(extra).reason, 'admit_membership');
      const both = flowTx({
        nanos,
        vins: [{ commit: one }, { commit: two }],
        proofs: [proofFor(one, 9), proofFor(two, 8)],
      });
      assert.equal(flowInputsBound(both).ok, true);
      const coinbaseVin = flowTx({
        nanos,
        vins: [{ commit: one, coinbase: true }],
        proofs: [proofFor(one, 9)],
      });
      assert.equal(flowInputsBound(coinbaseVin).reason, 'admit_membership');
      for (const bad of [mismatch, extra, coinbaseVin]) {
        const parked = admitMempool(emptyMempool(), bad, { baseFee: 1 });
        assert.equal(parked.ok, false);
        assert.equal(parked.reason, 'admit_membership');
      }
      const parkedBound = admitMempool(emptyMempool(), matched, { baseFee: 1 });
      assert.equal(parkedBound.ok, false);
      assert.equal(parkedBound.reason, 'range_proof');
      const noMaterial = {
        kind: 'send',
        nanos,
        fee: 0,
        vin: [{ address: 'ssa1not-a-commit' }],
        vout: [{ kind: 'send', nanos }],
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
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
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
    const cases = [
      {
        name: 'mismatch',
        tx: flowTx({ nanos: 1, vins: [{ commit: one }], proofs: [proofFor(two, 7)] }),
        reason: 'admit_membership',
      },
      {
        name: 'extra',
        tx: flowTx({
          nanos: 100_000_000_000,
          vins: [{ commit: one }, { commit: two }],
          proofs: [proofFor(one, 7)],
        }),
        reason: 'admit_membership',
      },
      {
        name: 'bound-one',
        tx: flowTx({ nanos: 3, vins: [{ commit: one }], proofs: [proofFor(one, 7)] }),
        reason: 'dummy_outs',
      },
    ];
    for (const row of cases) {
      const txs = tpl.txs.concat([row.tx]);
      const decoded = decodeHeader(Buffer.from(tpl.header));
      decoded.merkleRoot = merkleRoot(txs.map(digestTx));
      const got = verifyBlock({
        header: encodeHeader(decoded),
        txs,
        samples: tpl.samples,
        shareBatch: [],
        miner: dest,
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

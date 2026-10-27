/**
 * A body field the spend signature does not cover is unsigned.
 * The reason holds on queueTx, admitMempool, and verifyBlock,
 * for any extra field and any amount. A signed refused kind with
 * no extra field stays kind. A clean coinbase stays coinbase.
 * verifyBlock of a clean body is not unsigned.
 * On a block, the pre-PoW row check names unsigned. These blocks carry no
 * header, a final fault, and a final fault is the verdict over an upgradeable
 * one (Russell 26 Oct), so verifyBlock names no_header.
 * A b-spend keeps its consensus fields. An extra field on that body is unsigned.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { earlyRowsRejected, verifyBlock } from '../src/chain.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { newIdentity } from '../../crypto/address.js';
import { signSpendTx } from '../../crypto/spend.js';
import { spendBox } from '../../tests/spend_box.js';

const AMOUNTS = [0, -1, 1, 2, 1_000_000_000, 9_007_199_254_740_991, 9007199254740993n];
const FIELD_NAMES = ['extraField', 'bonusNanos', 'unsignedAmount'];
const PLACES = ['top', 'vin', 'vout', 'valueProof'];

function refusedTx(dest) {
  return {
    id: 'unsigned-body',
    kind: 'user-spend',
    from: dest,
    to: dest,
    nanos: 1,
    fee: 1,
    vin: [{ address: dest, commit: Buffer.alloc(32, 4) }],
    vout: [{ address: dest, nanos: 1, kind: 'user-spend' }],
  };
}

function coinbaseTx() {
  return {
    coinbase: true,
    height: 1,
    vin: [{ coinbase: true, height: 1 }],
    vout: [],
  };
}

function bSpendTx(dest) {
  return {
    id: 'unsigned-bspend',
    kind: 'b-spend',
    from: dest,
    to: dest,
    nanos: 1,
    fee: 0,
    bFlag: 1,
    unit: 1,
    nonce: 1,
    dest20: Buffer.alloc(20, 7),
    commitHeight: 1,
    index: 0,
    commitHeader: Buffer.alloc(128, 3),
    commitRootA: Buffer.alloc(32, 4),
    commitRootB: Buffer.alloc(32, 5),
    leaf: {
      dest20: Buffer.alloc(20, 7),
      unit: 1,
      nonce: 1,
      memoH: Buffer.alloc(32, 6),
      tag: 'b',
    },
    proof: [{ side: 'L', hash: Buffer.alloc(32, 8).toString('hex') }],
    excess: Buffer.alloc(32, 9),
    vin: [{ address: dest }],
    vout: [{ address: dest, nanos: 1, kind: 'b-spend' }],
  };
}

function cloneBody(tx) {
  const next = {
    ...tx,
    vin: (tx.vin || []).map((v) => ({ ...v })),
    vout: (tx.vout || []).map((o) => ({
      ...o,
      ...(o.valueProof && typeof o.valueProof === 'object' ? { valueProof: { ...o.valueProof } } : {}),
    })),
  };
  if (tx.leaf && typeof tx.leaf === 'object' && !Buffer.isBuffer(tx.leaf)) next.leaf = { ...tx.leaf };
  if (Array.isArray(tx.proof)) {
    next.proof = tx.proof.map((step) => (
      step && typeof step === 'object' && !Buffer.isBuffer(step) ? { ...step } : step
    ));
  }
  return next;
}

function plant(tx, where, name, amount) {
  const next = cloneBody(tx);
  if (where === 'top') next[name] = amount;
  else if (where === 'vin') next.vin[0][name] = amount;
  else if (where === 'vout') next.vout[0][name] = amount;
  else if (where === 'leaf') next.leaf[name] = amount;
  else if (where === 'proof') next.proof = [{ ...next.proof[0], [name]: amount }];
  else next.vout[0].valueProof = { v: 0, [name]: amount };
  return next;
}

function blockWith(tx) {
  return { txs: [coinbaseTx(), tx] };
}

async function unsignedOnBlock(block, label) {
  assert.equal(earlyRowsRejected(block)?.reason, 'unsigned', `early ${label}`);
  const v = await Promise.resolve(verifyBlock(block));
  assert.equal(v.ok, false, `verify ${label}`);
  assert.equal(v.reason, 'no_header', `verify ${label} ${v.reason}`);
}

describe('unsigned body field', () => {
  it('queueTx, admitMempool, and verifyBlock reject any extra field and any amount', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-unsigned-body-'));
    const store = createStore(dir);
    const box = spendBox(newIdentity());
    const signed = signSpendTx(refusedTx(box.dest), box.key);
    const book = emptyMempool();
    try {
      const queued = store.queueTx(cloneBody(signed));
      assert.equal(queued.ok, false);
      assert.equal(queued.reason, 'kind', `clean queue ${queued.reason}`);
      const pooled = admitMempool(book, cloneBody(signed));
      assert.equal(pooled.ok, false);
      assert.equal(pooled.reason, 'kind', `clean mempool ${pooled.reason}`);
      const verified = await Promise.resolve(verifyBlock(blockWith(cloneBody(signed))));
      assert.equal(verified.ok, false);
      assert.notEqual(verified.reason, 'unsigned', `clean verify ${verified.reason}`);

      const bare = coinbaseTx();
      const queuedCb = store.queueTx(bare);
      assert.equal(queuedCb.ok, false);
      assert.equal(queuedCb.reason, 'coinbase', `clean coinbase queue ${queuedCb.reason}`);
      const pooledCb = admitMempool(book, coinbaseTx());
      assert.equal(pooledCb.ok, false);
      assert.equal(pooledCb.reason, 'coinbase', `clean coinbase mempool ${pooledCb.reason}`);
      const verifiedCb = await Promise.resolve(verifyBlock({ txs: [coinbaseTx()] }));
      assert.equal(verifiedCb.ok, false);
      assert.notEqual(verifiedCb.reason, 'unsigned', `clean coinbase verify ${verifiedCb.reason}`);

      const bspend = signSpendTx(bSpendTx(box.dest), box.key);
      const queuedB = store.queueTx(cloneBody(bspend));
      assert.equal(queuedB.ok, false);
      assert.notEqual(queuedB.reason, 'unsigned', `clean b-spend queue ${queuedB.reason}`);
      const pooledB = admitMempool(book, cloneBody(bspend));
      assert.equal(pooledB.ok, false);
      assert.notEqual(pooledB.reason, 'unsigned', `clean b-spend mempool ${pooledB.reason}`);
      const verifiedB = await Promise.resolve(verifyBlock(blockWith(cloneBody(bspend))));
      assert.equal(verifiedB.ok, false);
      assert.notEqual(verifiedB.reason, 'unsigned', `clean b-spend verify ${verifiedB.reason}`);

      for (const name of FIELD_NAMES) {
        for (const amount of AMOUNTS) {
          for (const where of PLACES) {
            const tx = plant(signed, where, name, amount);
            const label = `${where} ${name} ${amount}`;
            const q = store.queueTx(tx);
            assert.equal(q.ok, false, `queue ${label}`);
            assert.equal(q.reason, 'unsigned', `queue ${label} ${q.reason}`);
            const a = admitMempool(book, plant(signed, where, name, amount));
            assert.equal(a.ok, false, `mempool ${label}`);
            assert.equal(a.reason, 'unsigned', `mempool ${label} ${a.reason}`);
            await unsignedOnBlock(blockWith(plant(signed, where, name, amount)), label);
          }
          const cb = plant(coinbaseTx(), 'top', name, amount);
          const cbLabel = `coinbase ${name} ${amount}`;
          const cq = store.queueTx(cb);
          assert.equal(cq.ok, false, `queue ${cbLabel}`);
          assert.equal(cq.reason, 'unsigned', `queue ${cbLabel} ${cq.reason}`);
          const ca = admitMempool(book, plant(coinbaseTx(), 'top', name, amount));
          assert.equal(ca.ok, false, `mempool ${cbLabel}`);
          assert.equal(ca.reason, 'unsigned', `mempool ${cbLabel} ${ca.reason}`);
          await unsignedOnBlock({ txs: [plant(coinbaseTx(), 'top', name, amount)] }, cbLabel);
          const cbVin = plant(coinbaseTx(), 'vin', name, amount);
          const vinLabel = `coinbase vin ${name} ${amount}`;
          const vq = store.queueTx(cbVin);
          assert.equal(vq.ok, false, `queue ${vinLabel}`);
          assert.equal(vq.reason, 'unsigned', `queue ${vinLabel} ${vq.reason}`);
          const va = admitMempool(book, plant(coinbaseTx(), 'vin', name, amount));
          assert.equal(va.ok, false, `mempool ${vinLabel}`);
          assert.equal(va.reason, 'unsigned', `mempool ${vinLabel} ${va.reason}`);
          await unsignedOnBlock({ txs: [plant(coinbaseTx(), 'vin', name, amount)] }, vinLabel);
        }
      }
      for (const name of FIELD_NAMES) {
        for (const amount of AMOUNTS) {
          for (const where of ['top', 'leaf', 'proof']) {
            const tx = plant(bspend, where, name, amount);
            const label = `b-spend ${where} ${name} ${amount}`;
            const q = store.queueTx(tx);
            assert.equal(q.ok, false, `queue ${label}`);
            assert.equal(q.reason, 'unsigned', `queue ${label} ${q.reason}`);
            const a = admitMempool(book, plant(bspend, where, name, amount));
            assert.equal(a.ok, false, `mempool ${label}`);
            assert.equal(a.reason, 'unsigned', `mempool ${label} ${a.reason}`);
            await unsignedOnBlock(blockWith(plant(bspend, where, name, amount)), label);
          }
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A b-spend signature covers the fee. A relayer cannot raise it.
 * A send does not. The wallet signs sends through spendMessage, without a fee.
 *
 * The fee is not debited from the leaf: outputs must sum to the leaf unit,
 * b-spend is not levy-taxed, and fundedDebit ignores it. A positive fee would
 * only be added to the block levy and minted. Consensus therefore allows
 * absent or 0, and rejects every other encoding.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactTx } from '../../crypto/chronoflux.js';
import { chainBSpendsRejected } from '../../crypto/clearing.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import {
  bSpendFeeRejected,
  feeFieldRejected,
  signSpendTx,
  spendPackDigest,
  verifySpendSig,
} from '../../crypto/spend.js';
import { verifyBlock } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { payerIdentity } from './b_leaf_fund.js';

const ALIASES = [
  ['neg', -1],
  ['abc', 'abc'],
  ['nan', NaN],
  ['frac', 0.9],
  ['2^53', 2 ** 53],
  ['2^60', 2 ** 60],
  ['1e30', '1e30'],
  ['3.7', 3.7],
  ['str3', '3'],
  ['hex3', '0x3'],
  ['pad3', ' 3 '],
  ['inf', Infinity],
];
// The mempool refuses a NaN or Infinity anywhere in an arriving row as
// canonical_alias before it reads the fee (ruling 3, Russell 26 Oct); the
// node queue and the block still name the fee. Every path refuses.
const ARRIVAL_ALIAS = new Set(['nan', 'inf']);

describe('a b-spend fee is signed', () => {
  it('rejects a raised fee and leaves a send digest alone', () => {
    const who = payerIdentity();
    const tx = {
      kind: 'b-spend',
      from: who.dest,
      fee: 0,
      vin: [{ address: who.dest }],
      vout: [{ kind: 'b-spend', nanos: 9 }],
    };
    signSpendTx(tx, who.key);
    assert.equal(verifySpendSig(tx), true);
    assert.equal(verifySpendSig({ ...tx, fee: 1 }), false);
    assert.equal(verifySpendSig({ ...tx, fee: 0 }), true);
    const sealed = compactTx(tx);
    assert.equal(verifySpendSig(sealed), true);
    assert.equal(spendPackDigest(tx).equals(spendPackDigest(sealed)), true);
    assert.equal(verifySpendSig(compactTx({ ...tx, fee: 7 })), false);
    assert.equal(spendPackDigest(tx).equals(spendPackDigest({ ...tx, fee: 1 })), false);

    const priced = {
      kind: 'b-spend',
      from: who.dest,
      fee: 3,
      vin: [{ address: who.dest }],
      vout: [{ kind: 'b-spend', nanos: 9 }],
    };
    signSpendTx(priced, who.key);
    assert.equal(verifySpendSig(priced), true);
    assert.equal(verifySpendSig({ ...priced, fee: 4 }), false);
    assert.equal(verifySpendSig({ ...priced, fee: 2 }), false);

    const send = { kind: 'send', fee: 0, vin: [{ address: who.dest }], vout: [] };
    assert.equal(spendPackDigest(send).equals(spendPackDigest({ ...send, fee: 9 })), true);

    for (const [label, fee] of ALIASES) {
      assert.equal(verifySpendSig({ ...tx, fee }), false, label);
      assert.equal(spendPackDigest(tx).equals(spendPackDigest({ ...tx, fee })), false, label);
    }
  });

  it('rejects every non-canonical fee, and a positive b-spend fee', () => {
    assert.equal(feeFieldRejected({ kind: 'b-spend' }), null);
    assert.equal(feeFieldRejected({ kind: 'b-spend', fee: undefined }), null);
    assert.equal(feeFieldRejected({ kind: 'b-spend', fee: null }), null);
    assert.equal(feeFieldRejected({ kind: 'b-spend', fee: 0 }), null);
    assert.equal(feeFieldRejected({ kind: 'send', fee: Number.MAX_SAFE_INTEGER }), null);
    assert.equal(bSpendFeeRejected({ kind: 'b-spend' }), null);
    assert.equal(bSpendFeeRejected({ kind: 'b-spend', fee: 0 }), null);
    assert.equal(bSpendFeeRejected({ kind: 'send', fee: 3 }), null);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-fee-'));
    const store = createStore(dir);
    try {
      for (const [label, fee] of ALIASES) {
        for (const kind of ['b-spend', 'send']) {
          const tx = { id: `${kind}-${label}`, kind, fee, vin: [], vout: [] };
          assert.equal(feeFieldRejected(tx)?.reason, 'fee', `${kind} ${label}`);
          const parked = admitMempool(emptyMempool(), tx);
          assert.equal(parked.reason, ARRIVAL_ALIAS.has(label) ? 'canonical_alias' : 'fee', `pool ${kind} ${label}`);
          const queued = store.queueTx(tx);
          assert.equal(queued.reason, 'fee', `queue ${kind} ${label}`);
          const block = verifyBlock({
            txs: [{ coinbase: true, vout: [] }, tx],
          }, null, { probeBody: true });
          assert.equal(block.reason, 'fee', `verify ${kind} ${label}`);
        }
      }
      for (const fee of [1, 3, Number.MAX_SAFE_INTEGER]) {
        const tx = { id: `pos-${fee}`, kind: 'b-spend', fee, vin: [], vout: [] };
        assert.equal(bSpendFeeRejected(tx)?.reason, 'fee', String(fee));
        assert.equal(admitMempool(emptyMempool(), tx).reason, 'fee', String(fee));
        assert.equal(store.queueTx(tx).reason, 'fee', String(fee));
        const block = verifyBlock({
          txs: [{ coinbase: true, vout: [] }, tx],
        }, null, { probeBody: true });
        assert.equal(block.reason, 'fee', String(fee));
        assert.equal(chainBSpendsRejected([{
          height: 1,
          header: Buffer.alloc(80),
          txs: [tx],
        }])?.reason, 'fee', String(fee));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

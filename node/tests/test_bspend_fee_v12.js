/**
 * A b-spend signature covers the fee. A relayer cannot raise it.
 * A send does not. The wallet signs sends through spendMessage, without a fee.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactTx } from '../../crypto/chronoflux.js';
import { signSpendTx, spendPackDigest, verifySpendSig } from '../../crypto/spend.js';
import { payerIdentity } from './b_leaf_fund.js';

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
  });
});

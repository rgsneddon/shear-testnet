import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NANOS_PER_SHE, SPENDABLE_CONFIRMATIONS } from './asert.js';
import { levyNanos } from './levy.js';
import { fundedDebit, matureSpendableNanos, mempoolDebitNanos, verifyFundedBody, verifyDestOpening, flowSendNeedsOpen, indexedDestOpening } from './spend.js';
import { newIdentity, destOpeningFromView, hash20FromAddress, payoutDest } from './address.js';
import { destAtIndex, closureCommit } from './flow_sheet.js';

const dest = 'ssa1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const other = 'ssa1qyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';

describe('funded spend / no double-spend', () => {
  it('debits amount plus levy from the sender', () => {
    const nanos = 4 * NANOS_PER_SHE;
    const fee = levyNanos(nanos);
    const d = fundedDebit({
      kind: 'send',
      from: dest,
      to: other,
      nanos,
      fee,
      vin: [{ address: dest }],
      vout: [{ address: other, nanos }],
    });
    assert.equal(d.from, dest);
    assert.equal(d.nanos, nanos + fee);
  });

  it('credits incoming only after 6 confs and always subtracts a sealed send', () => {
    const rows = [
      { from: 'coinbase', to: dest, nanos: 10 * NANOS_PER_SHE, height: 1, kind: 'coinbase' },
      { from: dest, to: other, nanos: 3 * NANOS_PER_SHE, height: 10, kind: 'send' },
    ];
    const coinbase = rows[0];
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
    assert.equal(matureSpendableNanos([coinbase], dest, 5, SPENDABLE_CONFIRMATIONS), 0);
    assert.equal(matureSpendableNanos([coinbase], dest, 6, SPENDABLE_CONFIRMATIONS), 10 * NANOS_PER_SHE);
    assert.equal(matureSpendableNanos(rows, dest, 10, SPENDABLE_CONFIRMATIONS), 7 * NANOS_PER_SHE);
  });

  it('rejects two spends of the same mature coins in one body', () => {
    const id = newIdentity();
    const from = payoutDest(id.paymentCode);
    const to = from;
    const spendH = hash20FromAddress(id.address);
    const open = destOpeningFromView(id.viewKey, spendH, 0);
    const nanos = NANOS_PER_SHE;
    const fee = levyNanos(nanos);
    const spendableOf = (addr) => (addr === from ? 2 * NANOS_PER_SHE : 0);
    const tx = (txid) => ({
      id: txid,
      kind: 'send',
      from,
      to,
      nanos,
      fee,
      open,
      vin: [{ address: from }],
      vout: [{ address: to, nanos }],
    });
    const once = verifyFundedBody([tx('a')], spendableOf);
    assert.equal(once.ok, true, once.reason);
    const twice = verifyFundedBody([tx('a'), tx('b')], spendableOf);
    assert.equal(twice.ok, false);
    assert.equal(twice.reason, 'insufficient');
  });

  it('mempool already-queued debit blocks a second pull of the same coins', () => {
    const nanos = NANOS_PER_SHE;
    const fee = levyNanos(nanos);
    const queued = [{
      kind: 'send', from: dest, to: other, nanos, fee,
      vin: [{ address: dest }],
    }];
    assert.equal(mempoolDebitNanos(queued, dest), nanos + fee);
    assert.equal(mempoolDebitNanos(queued, other), 0);
  });

  it('mints and coinbase are not funded debits', () => {
    assert.equal(fundedDebit({ coinbase: true, vout: [{ nanos: NANOS_PER_SHE }] }), null);
    assert.equal(fundedDebit({ mint: true, kind: 'reserve', nanos: 1 }), null);
  });

  it('dest opening is required for Flow send; knowing ssa1 is not enough', () => {
    const id = newIdentity();
    const from = payoutDest(id.paymentCode);
    const spendH = hash20FromAddress(id.address);
    const open = destOpeningFromView(id.viewKey, spendH, 0);
    assert.equal(verifyDestOpening(from, open), true);
    assert.equal(verifyDestOpening(from, ''), false);
    assert.equal(verifyDestOpening(from, 'ab'.repeat(64)), false);
    const tx = {
      kind: 'send', from, to: from, nanos: 1, fee: 100,
      vin: [{ address: from }],
    };
    assert.equal(flowSendNeedsOpen(tx), true);
    assert.equal(flowSendNeedsOpen({ kind: 'pool-withdraw', from, vin: [{ address: from }], nanos: 1, fee: 100 }), false);

    const heightDest = destAtIndex(id.address, { index: 0, viewKey: id.viewKey });
    const idxOpen = indexedDestOpening(spendH, closureCommit(id.viewKey), 0);
    assert.equal(verifyDestOpening(heightDest, idxOpen), true);
    assert.equal(verifyDestOpening(from, idxOpen), false);
  });
});

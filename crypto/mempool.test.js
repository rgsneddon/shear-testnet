import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admitMempool, emptyMempool, retargetMempool } from './mempool.js';
import { encodeDest, encodeAddress } from './address.js';
import { attachDummyOuts } from './dummy.js';

const dest = encodeDest(Buffer.alloc(20, 3));

describe('policy mempool', () => {
  it('refuses an opened hidden send, admits a bound send and a B-spend, and drops a fee under the levy', () => {
    const book = emptyMempool();
    const openedShapes = [
      attachDummyOuts({ kind: 'send', to: dest, fee: 100, vout: [{ address: dest }] }),
    ];
    for (const nanos of [1, 2_000_000_000, 100_000_000_000]) {
      openedShapes.push(attachDummyOuts({
        kind: 'send',
        to: dest,
        fee: 100,
        nanos,
        vout: [{ address: dest, nanos, kind: 'send' }],
      }));
    }
    for (const opened of openedShapes) {
      const send = admitMempool(book, opened, { baseFee: 1 });
      assert.equal(send.ok, false);
      assert.equal(send.reason, 'value_open');
    }
    assert.equal(book.txs.length, 0);
    const commit = Buffer.alloc(32, 7);
    const tag = Buffer.alloc(32, 9);
    const bound = attachDummyOuts({
      kind: 'send',
      to: dest,
      fee: 100,
      nanos: 1,
      vout: [{ address: dest, nanos: 1, kind: 'send' }],
    });
    for (const o of bound.vout) {
      if (String(o.kind || '') !== 'dummy') delete o.valueProof;
    }
    bound.vin = [{ commit }];
    bound.admit_proof = { cTilde: commit, spendTag: tag };
    const admitted = admitMempool(book, bound, { baseFee: 1 });
    assert.equal(admitted.ok, true, admitted.reason);
    assert.equal(book.txs[0].kind, 'send');
    const share = admitMempool(book, { share: true, to: dest, fee: 10 }, { baseFee: 1 });
    assert.equal(share.ok, false);
    assert.equal(share.reason, 'share_not_mempool');
    const rest = admitMempool(book, { kind: 'send', to: encodeAddress(Buffer.alloc(20, 1)), fee: 10 }, { baseFee: 1 });
    assert.equal(rest.ok, false);
    assert.equal(rest.reason, 'rest_frame_on_chain');
    const she = admitMempool(book, { kind: 'send', to: 'she1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', fee: 10 }, { baseFee: 1 });
    assert.equal(she.ok, false);
    assert.equal(she.reason, 'silent_id_on_chain');
    const bsp = admitMempool(book, { kind: 'b-spend', to: dest, fee: 2, bFlag: 1 }, { baseFee: 1 });
    assert.equal(bsp.ok, true);
    const claim = admitMempool(book, {
      kind: 'claim',
      from: dest,
      to: dest,
      nanos: 1,
      fee: 2,
      vout: [{ address: dest, nanos: 1 }],
    }, { baseFee: 1 });
    assert.equal(claim.ok, false);
    assert.equal(claim.reason, 'kind');
    assert.equal(book.txs[0].kind, 'send');
    book.txs[0].fee = 1;
    const drop = retargetMempool(book, 8);
    assert.ok(drop.dropped.length >= 1);
    assert.equal(drop.dropped.some((t) => t.kind === 'send'), true);
    assert.equal(book.txs.some((t) => t.kind === 'send'), false);
    assert.equal(book.txs.some((t) => t.kind === 'b-spend'), true);
  });
});

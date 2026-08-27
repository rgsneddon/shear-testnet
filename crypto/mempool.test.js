import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admitMempool, emptyMempool, retargetMempool } from './mempool.js';
import { encodeDest, encodeAddress } from './address.js';

const dest = encodeDest(Buffer.alloc(20, 3));

describe('policy mempool', () => {
  it('admits ssa1 sends and B-spends; refuses shares and shear1', () => {
    const book = emptyMempool();
    const send = admitMempool(book, { kind: 'send', to: dest, fee: 2, vout: [{ address: dest }] }, { baseFee: 1 });
    assert.equal(send.ok, true);
    const share = admitMempool(book, { share: true, to: dest, fee: 10 }, { baseFee: 1 });
    assert.equal(share.ok, false);
    assert.equal(share.reason, 'share_not_mempool');
    const rest = admitMempool(book, { kind: 'send', to: encodeAddress(Buffer.alloc(20, 1)), fee: 10 }, { baseFee: 1 });
    assert.equal(rest.ok, false);
    assert.equal(rest.reason, 'shear1');
    const bsp = admitMempool(book, { kind: 'b-spend', to: dest, fee: 2, bFlag: 1 }, { baseFee: 1 });
    assert.equal(bsp.ok, true);
    const drop = retargetMempool(book, 8);
    assert.ok(drop.dropped.length >= 1);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { EMPTY_ROOT } from '../../crypto/merkle.js';
import { buildTemplate, GENESIS_PREV, coinbaseTx } from '../src/chain.js';

describe('flow dest coinbase', () => {
  it('pays lag-1 dest, not the rest-frame login', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { continuityRoot: EMPTY_ROOT, height: 1 });
    assert.notEqual(dest, id.address);
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: id.address,
      bits: 8,
      now: Date.now(),
    });
    assert.equal(tpl.txs[0].vout[0].address, dest);
    const plain = coinbaseTx({ height: 1, miner: id.address });
    assert.equal(plain.vout[0].address, id.address);
  });
});

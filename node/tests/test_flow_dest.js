import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, isDestAddress, isShearAddress, encodeHrp } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { EMPTY_ROOT } from '../../crypto/merkle.js';
import { buildTemplate, GENESIS_PREV, coinbaseTx, verifyBlock, mineTemplate } from '../src/chain.js';

describe('flow dest coinbase', () => {
  it('pays miner login as dest; shear1 never on coinbase', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { continuityRoot: EMPTY_ROOT, height: 1, viewKey: id.viewKey });
    assert.equal(isDestAddress(dest), true);
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 8,
      now: Date.now(),
    });
    assert.equal(tpl.txs[0].vout[0].address, dest);
    assert.equal(isShearAddress(tpl.txs[0].vout[0].address), false);
    const plain = coinbaseTx({ height: 1, miner: dest });
    assert.equal(plain.vout[0].address, dest);
    assert.throws(() => coinbaseTx({ height: 1, miner: id.address }), /coinbase_needs_dest/);
  });

  it('verifyBlock rejects rest-frame shear1 on vout', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const tpl = buildTemplate({ prev: GENESIS_PREV, height: 1, miner: dest, bits: 8, now: Date.now() });
    const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
    assert.ok(found && found.block, 'need pow');
    const block = {
      header: found.header,
      txs: tpl.txs,
      samples: tpl.samples,
      height: 1,
    };
    const ok = verifyBlock(block, null);
    assert.equal(ok.ok, true, ok.reason);
    const bad = {
      ...block,
      txs: [{
        ...tpl.txs[0],
        vout: tpl.txs[0].vout.map((o) => ({ ...o, address: id.address })),
      }],
    };
    const rej = verifyBlock(bad, null);
    assert.equal(rej.ok, false);
  });

  it('verifyBlock accepts she1 dest and still rejects shear1', () => {
    const she = encodeHrp('she', Buffer.alloc(20, 9));
    assert.equal(isDestAddress(she), true);
    assert.equal(isShearAddress(she), false);
    const tpl = buildTemplate({ prev: GENESIS_PREV, height: 1, miner: she, bits: 8, now: Date.now() });
    assert.equal(tpl.txs[0].vout[0].address, she);
    const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
    assert.ok(found && found.block, 'need pow');
    const block = { header: found.header, txs: tpl.txs, samples: tpl.samples, height: 1 };
    const ok = verifyBlock(block, null);
    assert.equal(ok.ok, true, ok.reason);
    const id = newIdentity();
    const bad = {
      ...block,
      txs: [{
        ...tpl.txs[0],
        vout: tpl.txs[0].vout.map((o) => ({ ...o, address: id.address })),
      }],
    };
    assert.equal(verifyBlock(bad, null).ok, false);
  });
});

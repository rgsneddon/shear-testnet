import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { splitLevy, levyNanos, txWeight, nextBaseFee, FEE_TARGET_WEIGHT } from '../../crypto/levy.js';
import { BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { decodeHeader } from '../../crypto/header.js';
import { bitsForBlock } from '../../crypto/asert.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

describe('verifyBlock Flow levy', () => {
  it('coinbase and A-leaves pay 0; user levy floor and finder/Reserve split', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const base = {
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 8,
      now: Date.now(),
      samples: [{ miner: dest, nonce: '1', tag: 'a', count: 3 }],
    };
    const free = mine(buildTemplate(base));
    const ok0 = verifyBlock(free, null);
    assert.equal(ok0.ok, true, ok0.reason);
    const pot = free.txs[0].vout.filter((o) => o.kind === 'pot').reduce((a, o) => a + o.nanos, 0);
    assert.equal(pot, BLOCK_SUBSIDY_NANOS);
    assert.equal(free.txs[0].vout.some((o) => o.kind === 'finder-fee'), false);

    const need = levyNanos(1, txWeight({ vouts: 1, memoChunks: 0, bFlag: 0 }));
    const unpaid = mine(buildTemplate({
      ...base,
      txs: [{
        id: 'u1',
        from: dest,
        to: dest,
        nanos: 2,
        fee: 0,
        vin: [{ address: dest }],
        vout: [{ address: dest, nanos: 2 }],
      }],
    }));
    const denied = verifyBlock(unpaid, null);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'levy');

    const paid = mine(buildTemplate({
      ...base,
      txs: [{
        id: 'u2',
        from: dest,
        to: dest,
        nanos: 2,
        fee: need,
        vin: [{ address: dest }],
        vout: [{ address: dest, nanos: 2 }],
      }],
    }));
    const allowed = verifyBlock(paid, null);
    assert.equal(allowed.ok, true, allowed.reason);
    const split = splitLevy(need);
    const finder = paid.txs[0].vout.filter((o) => o.kind === 'finder-fee').reduce((a, o) => a + Number(o.nanos || 0), 0);
    const reserve = paid.txs[0].vout.filter((o) => o.kind === 'reserve-fee').reduce((a, o) => a + Number(o.nanos || 0), 0);
    assert.equal(finder, split.finder);
    assert.equal(reserve, split.reserve);
  });

  it('ASERT base_fee from parent weight; forged base_fee is rejected', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const fat = Array.from({ length: 32 }, (_, i) => ({
      id: `w${i}`,
      from: dest,
      to: dest,
      nanos: 1,
      fee: 1,
      vin: [{ address: dest }],
      vout: [{ address: dest, nanos: 1 }],
    }));
    const t0 = Date.now();
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 8,
      now: t0,
      samples: [{ miner: dest, nonce: '1', tag: 'a', count: 1 }],
      txs: fat,
    }));
    assert.ok(parent.weight > FEE_TARGET_WEIGHT, `parent weight ${parent.weight}`);
    const parentPrev = {
      hash: null,
      header: parent.header,
      height: 1,
      txs: parent.txs,
      bLeaves: parent.bLeaves,
      weight: parent.weight,
      rootA: parent.rootA,
      rootB: parent.rootB,
    };
    const okP = verifyBlock(parent, null);
    assert.equal(okP.ok, true, okP.reason);
    parentPrev.hash = okP.hash;
    const wantBase = nextBaseFee(1, parent.weight);
    assert.ok(wantBase !== 1, `expected retarget from weight ${parent.weight}, got ${wantBase}`);

    const t1 = t0 + 90_000;
    const bits2 = bitsForBlock(decodeHeader(parent.header).bits, decodeHeader(parent.header).timestamp, t1);
    const wrong = mine(buildTemplate({
      prev: parentPrev.hash,
      prevHeader: parent.header,
      parentWeight: 1,
      height: 2,
      miner: dest,
      bits: bits2,
      now: t1,
      samples: [{ miner: dest, nonce: '2', tag: 'a', count: 1 }],
    }));
    const denied = verifyBlock(wrong, parentPrev);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'base_fee');

    const right = mine(buildTemplate({
      prev: parentPrev.hash,
      prevHeader: parent.header,
      prevBlock: parentPrev,
      parentWeight: parent.weight,
      height: 2,
      miner: dest,
      bits: bits2,
      now: t1,
      samples: [{ miner: dest, nonce: '2', tag: 'a', count: 1 }],
    }));
    assert.equal(Number(decodeHeader(right.header).baseFee), wantBase);
    const allowed = verifyBlock(right, parentPrev);
    assert.equal(allowed.ok, true, allowed.reason);
  });
});

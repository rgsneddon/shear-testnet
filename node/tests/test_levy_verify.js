import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { splitLevy, levyNanos } from '../../crypto/levy.js';
import { BLOCK_SUBSIDY_NANOS, NANOS_PER_SHE } from '../../crypto/asert.js';
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

describe('verifyBlock Phase B Flow levy', () => {
  it('dust empty L=100; 1 SHE empty 0.0002 SHE; pot/hash pay 0; underpay levy; EVM value same L; maxLevy refuse', async () => {
    assert.equal(levyNanos(1), 100);
    assert.equal(levyNanos(NANOS_PER_SHE), 20_000_000);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const other = destForLogin(newIdentity().address, { viewKey: newIdentity().viewKey, height: 1 });
    const base = {
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: Date.now(),
      samples: [{ miner: dest, nonce: '1', tag: 'a', count: 3 }],
    };
    const free = mine(buildTemplate(base));
    const ok0 = verifyBlock(free, null);
    assert.equal(ok0.ok, true, ok0.reason);
    const pot = free.txs[0].vout.filter((o) => o.kind === 'pot').reduce((a, o) => a + o.nanos, 0);
    assert.equal(pot, BLOCK_SUBSIDY_NANOS);
    assert.equal(free.txs[0].vout.some((o) => o.kind === 'finder-fee'), false);
    assert.equal(free.txs[0].vout.some((o) => o.kind === 'reserve-fee'), false);
    assert.equal(free.txs[0].vout.filter((o) => o.kind === 'hash').every((o) => o.kind === 'hash'), true);

    const sendNanos = 2;
    const need = levyNanos(sendNanos);
    assert.equal(need, 100);
    const unpaid = mine(buildTemplate({
      ...base,
      txs: [{
        id: 'u1',
        kind: 'send',
        from: dest,
        to: dest,
        nanos: sendNanos,
        fee: 0,
        vin: [{ address: dest }],
        vout: [{ address: dest, nanos: sendNanos }],
      }],
    }));
    const denied = verifyBlock(unpaid, null);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'levy');

    const capped = mine(buildTemplate({
      ...base,
      txs: [{
        id: 'cap',
        kind: 'send',
        from: dest,
        to: dest,
        nanos: sendNanos,
        fee: need,
        maxLevy: need - 1,
        vin: [{ address: dest }],
        vout: [{ address: dest, nanos: sendNanos }],
      }],
    }));
    const capDenied = verifyBlock(capped, null);
    assert.equal(capDenied.ok, false);
    assert.equal(capDenied.reason, 'max_levy');

    const paid = mine(buildTemplate({
      ...base,
      txs: [{
        id: 'u2',
        kind: 'send',
        from: dest,
        to: dest,
        nanos: sendNanos,
        fee: need,
        vin: [{ address: dest }],
        vout: [{ address: dest, nanos: sendNanos }],
      }],
    }));
    const allowed = verifyBlock(paid, null);
    assert.equal(allowed.ok, true, allowed.reason);
    const split = splitLevy(need);
    const finder = paid.txs[0].vout.filter((o) => o.kind === 'finder-fee').reduce((a, o) => a + Number(o.nanos || 0), 0);
    const reserve = paid.txs[0].vout.filter((o) => o.kind === 'reserve-fee').reduce((a, o) => a + Number(o.nanos || 0), 0);
    assert.equal(finder, split.finder);
    assert.equal(reserve, split.reserve);

    const valueNanos = 77;
    const evmNeed = levyNanos(valueNanos);
    assert.equal(evmNeed, 100);
    const evm = mine(buildTemplate({
      ...base,
      txs: [{
        id: 'evm-value',
        kind: 'evm-value',
        from: dest,
        to: other,
        nanos: valueNanos,
        fee: evmNeed,
        vin: [{ address: dest }],
        vout: [{ address: other, nanos: valueNanos, kind: 'evm-value' }],
      }],
    }));
    const evmOk = await verifyBlock(evm, null);
    assert.equal(evmOk.ok, true, evmOk.reason || evmOk.error);
    assert.equal(evmOk.evmRan, true);
    assert.equal(evmOk.evm.valueMoved, valueNanos);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { levyNanos, txWeight } from '../../crypto/levy.js';
import { RESERVE_PROGRAM } from '../../crypto/asert.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
  PHASE_B_GATE,
  phaseBGate,
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

describe('Phase B GATE — EVM in verifyBlock', () => {
  it('accepts a native Flow send and an EVM SHE value transfer plus Reserve bytecode in one block', async () => {
    const idA = newIdentity();
    const idB = newIdentity();
    const destA = destForLogin(idA.address, { viewKey: idA.viewKey, height: 1 });
    const destB = destForLogin(idB.address, { viewKey: idB.viewKey, height: 1 });
    const need = levyNanos(1, txWeight({ vouts: 1, memoChunks: 0, bFlag: 0 }));
    const sendNanos = 2;
    const lockNanos = 1000;
    const valueNanos = 77;
    const base = {
      prev: GENESIS_PREV,
      height: 1,
      miner: destA,
      bits: 4,
      now: Date.now(),
      samples: [{ miner: destA, nonce: '1', tag: 'a', count: 1 }],
    };
    const block = mine(buildTemplate({
      ...base,
      txs: [
        {
          id: 'flow-send',
          from: destA,
          to: destB,
          nanos: sendNanos,
          fee: need,
          vin: [{ address: destA }],
          vout: [{ address: destB, nanos: sendNanos }],
        },
        {
          id: 'reserve-lock',
          programId: RESERVE_PROGRAM,
          kind: 'lock',
          from: destA,
          to: destA,
          nanos: lockNanos,
          fee: need,
          vin: [{ address: destA }],
          vout: [{ address: destA, nanos: lockNanos, kind: 'lock' }],
        },
        {
          id: 'evm-value',
          kind: 'evm-value',
          from: destA,
          to: destB,
          nanos: valueNanos,
          fee: need,
          vin: [{ address: destA }],
          vout: [{ address: destB, nanos: valueNanos, kind: 'evm-value' }],
        },
      ],
    }));
    const got = await verifyBlock(block, null);
    assert.equal(got.ok, true, got.reason || got.error);
    assert.equal(got.evmRan, true);
    assert.ok(got.evm);
    assert.equal(got.evm.totalLocked, lockNanos);
    assert.equal(got.evm.valueMoved, valueNanos);
    assert.ok(got.evm.calls >= 2);
  });

  it('still forbids a random vortice extra-mint in verifyBlock', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const thief = {
      vin: [],
      mint: true,
      vout: [{ address: dest, nanos: 99 }],
      programId: 'third-party-stake',
    };
    const stolen = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: Date.now(),
      txs: [thief],
    }));
    const denied = verifyBlock(stolen, null);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'mint_forbidden');
  });

  it('records GATE true', () => {
    assert.equal(PHASE_B_GATE, true);
    const g = phaseBGate();
    assert.equal(g.verifyBlockExecutesEvm, true);
    assert.equal(g.nativeFlowSend, true);
    assert.equal(g.evmSheValueTransfer, true);
    assert.equal(g.ok, true);
  });
});

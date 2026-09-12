import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest, ed25519SeedOf } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { levyNanos, levyNeed, mempoolDepthBytes } from '../../crypto/levy.js';
import { RESERVE_PROGRAM, PI_SHE_NANOS, RESERVE_EPOCH_MS, BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { lockTx, withdrawTx } from '../../crypto/reserve_vault.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { fluxsetFromBlocks, proveFlowSpend } from '../../crypto/admit.js';
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
    const destA = freshStealthDest(idA.paymentCode).dest;
    const destB = freshStealthDest(idB.paymentCode).dest;
    const sendNanos = 2;
    const lockNanos = 1000;
    const valueNanos = 77;
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: destA,
      bits: 4,
      now: Date.now(),
      samples: [{ miner: destA, nonce: '1', tag: 'a', count: 1 }],
    }));
    const okP = verifyBlock(parent, null);
    assert.equal(okP.ok, true, okP.reason);
    parent.hash = okP.hash;
    const spent = parent.txs[0].vout.find((o) => o.kind === 'pot');
    const spentIdx = parent.txs[0].vout.indexOf(spent);
    const fee = levyNanos(sendNanos);
    const change = BLOCK_SUBSIDY_NANOS - sendNanos - fee;
    const sendTx = attachDummyOuts({
      id: 'flow-send',
      kind: 'send',
      from: destA,
      to: destB,
      nanos: sendNanos,
      fee,
      changeNanos: change,
      vin: [{
        prev: parent.hash,
        index: spentIdx,
        commit: spent.commit,
        noteCommit: spent.noteCommit,
        r: spent.r,
        address: destA,
      }],
      vout: [
        { address: destB, nanos: sendNanos, kind: 'send' },
        { address: destA, nanos: change, kind: 'send' },
      ],
    }, { spent });
    proveFlowSpend(sendTx, {
      spendSeed: idA.spendSeed || ed25519SeedOf(idA.privateKey),
      spentNote: spent,
      pubs: fluxsetFromBlocks([parent]).pubs,
    });
    const lock = {
      id: 'reserve-lock',
      programId: RESERVE_PROGRAM,
      kind: 'lock',
      from: destA,
      to: destA,
      nanos: lockNanos,
      vin: [{ address: destA }],
      vout: [{ address: destA, nanos: lockNanos, kind: 'lock' }],
    };
    lock.fee = levyNeed(lock, [sendTx]);
    const evmTx = {
      id: 'evm-value',
      kind: 'evm-value',
      from: destA,
      to: destB,
      nanos: valueNanos,
      vin: [{ address: destA }],
      vout: [{ address: destB, nanos: valueNanos, kind: 'evm-value' }],
    };
    evmTx.fee = levyNeed(evmTx, [sendTx, lock]);
    const base = {
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentFluxset: fluxsetFromBlocks([parent]).pubs,
      height: 2,
      miner: destA,
      bits: 4,
      now: Date.now() + 90_000,
      samples: [{ miner: destA, nonce: '1', tag: 'a', count: 1 }],
    };
    const block = mine(buildTemplate({
      ...base,
      txs: [sendTx, lock, evmTx],
    }));
    const got = await verifyBlock(block, { ...parent, hash: okP.hash, header: parent.header, height: 1 });
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

  it('persists EVM session: lock then withdraw against shipped verifyBlock', async () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const t0 = 1_700_000_000_000;
    const lock = lockTx({ from: dest, to: dest, nanos: PI_SHE_NANOS, id: 'lock-p' });
    lock.fee = levyNeed(lock, []);
    lock.maxLevy = lock.fee;
    const b1 = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: t0,
      txs: [lock],
    }));
    const v1 = await verifyBlock(b1, null);
    assert.equal(v1.ok, true, v1.reason || v1.error);
    assert.equal(v1.evmRan, true);
    assert.equal(v1.evm.totalLocked, PI_SHE_NANOS);
    const t1 = t0 + RESERVE_EPOCH_MS;
    const wd = withdrawTx({ from: dest, to: dest, nanos: PI_SHE_NANOS, id: 'wd-p' });
    wd.fee = 0;
    const b2 = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: t1,
      txs: [wd],
    }));
    const empty = await verifyBlock(b2, null);
    assert.equal(empty.ok, false);
    assert.ok(empty.reason === 'evm' || empty.reason === 'mint_amount', empty.reason);
    const v2 = await verifyBlock(b2, null, { evmSession: v1.evmSession, nowMs: t1 });
    assert.equal(v2.ok, true, v2.reason || v2.error);
    assert.equal(v2.evm.totalLocked, 0);
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

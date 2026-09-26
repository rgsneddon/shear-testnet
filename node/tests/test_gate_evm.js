import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest, ed25519SeedOf } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { levyNanos, levyNeed, mempoolDepthBytes } from '../../crypto/levy.js';
import { RESERVE_PROGRAM, PI_SHE_NANOS, RESERVE_EPOCH_MS, BLOCK_SUBSIDY_NANOS, GENESIS_BPS, GENESIS_BITS_PACKED, bitsForBlock } from '../../crypto/asert.js';
import { decodeHeader } from '../../crypto/header.js';
import { lockTx, withdrawTx, emptyVault, deposit } from '../../crypto/reserve_vault.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { sealNote, verifyRange } from '../../crypto/note.js';

function rangeProofsLive() {
  try {
    const n = sealNote(1, { dest20: Buffer.alloc(20, 1), kind: 'send' });
    return verifyRange(n.commit, n.rangeProof);
  } catch {
    return false;
  }
}
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
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    shareBatch: tpl.shareBatch || [],
  };
}

describe('Phase B GATE — EVM in verifyBlock', () => {
  it('accepts a native Flow send and an EVM SHE value transfer plus Reserve bytecode in one block', {
    skip: !rangeProofsLive() ? 'range proofs need shearadmit.node' : false,
  }, async () => {
    const idA = newIdentity();
    const idB = newIdentity();
    const destA = freshStealthDest(idA).dest;
    const destB = freshStealthDest(idA).dest;
    const sendNanos = 2;
    const lockNanos = 1000;
    const valueNanos = 77;
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: destA,
      bits: GENESIS_BITS_PACKED,
      now: Date.now(),
      samples: [{ miner: destA, nonce: '1', tag: 'a', count: 1 }],
    }));
    const TRUSTED = Buffer.alloc(32);
    const okP = verifyBlock(parent, null, { trustedPowHash: TRUSTED });
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
        commit: spent.commit,
        address: destA,
      }],
      vout: [
        { address: destB, nanos: sendNanos, kind: 'send' },
        { address: destA, nanos: change, kind: 'send' },
      ],
    }, { spent });
    const liveJ = fluxsetFromBlocks([parent]);
    proveFlowSpend(sendTx, {
      spendSeed: idA.spendSeed || ed25519SeedOf(idA.privateKey),
      spentNote: spent,
      pubs: liveJ.pubs,
      commits: liveJ.commits,
    });
    const lock = lockTx({ from: destA, to: destA, nanos: lockNanos, id: 'reserve-lock' });
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
    const childNow = Date.now() + 90_000;
    const ph = decodeHeader(parent.header);
    const base = {
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentFluxset: fluxsetFromBlocks([parent]).pubs,
      parentWeight: parent.weight,
      height: 2,
      miner: destA,
      bits: bitsForBlock(ph.bits, ph.timestamp, childNow),
      now: childNow,
      samples: [{ miner: destA, nonce: '1', tag: 'a', count: 1 }],
    };
    const block = mine(buildTemplate({
      ...base,
      txs: [sendTx, lock, evmTx],
    }));
    const got = await verifyBlock(block, { ...parent, hash: okP.hash, header: parent.header, height: 1 }, { trustedPowHash: TRUSTED, skipSharePow: true });
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
      bits: GENESIS_BITS_PACKED,
      now: Date.now(),
      txs: [thief],
    }));
    const denied = verifyBlock(stolen, null, { trustedPowHash: Buffer.alloc(32) });
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
      bits: GENESIS_BITS_PACKED,
      now: t0,
      txs: [lock],
    }));
    const TRUSTED = Buffer.alloc(32);
    const v1 = await verifyBlock(b1, null, { trustedPowHash: TRUSTED });
    assert.equal(v1.ok, true, v1.reason || v1.error);
    assert.equal(v1.evmRan, true);
    assert.equal(v1.evm.totalLocked, PI_SHE_NANOS);
    const t1 = t0 + RESERVE_EPOCH_MS;
    const state = emptyVault();
    deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: t0 });
    const want = PI_SHE_NANOS + interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const wd = withdrawTx({ from: dest, to: dest, nanos: want, id: 'wd-p' });
    wd.fee = 0;
    const b2 = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: t1,
      txs: [wd],
    }));
    const empty = await verifyBlock(b2, null, { trustedPowHash: TRUSTED });
    assert.equal(empty.ok, false);
    assert.ok(empty.reason === 'evm' || empty.reason === 'mint_amount', empty.reason);
    const unbound = withdrawTx({ from: dest, to: dest, nanos: want + 1, id: 'wd-over' });
    unbound.fee = 0;
    const over = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: t1,
      txs: [unbound],
    }));
    const overGot = await verifyBlock(over, null, { evmSession: v1.evmSession, nowMs: t1, reserveState: state, trustedPowHash: TRUSTED });
    assert.equal(overGot.ok, false);
    assert.equal(overGot.reason, 'mint_amount');
    const v2 = await verifyBlock(b2, null, { evmSession: v1.evmSession, nowMs: t1, reserveState: state, trustedPowHash: TRUSTED });
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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, freshStealthDest, ed25519SeedOf } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { levyNanos, levyNeed, mempoolDepthBytes } from '../../crypto/levy.js';
import { RESERVE_PROGRAM, PI_SHE_NANOS, RESERVE_EPOCH_MS, BLOCK_SUBSIDY_NANOS, GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { emptyVault, compactLockLeakRejected, withdrawLeakRejected } from '../../crypto/reserve_vault.js';
import { v12FlowVersionRejected } from '../../crypto/admit_v3.js';
import { lockTx, withdrawTx, deposit } from '../../crypto/owned_portal.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { sealNote, verifyRange } from '../../crypto/note.js';
import { signSpendTx } from '../../crypto/spend.js';

function rangeProofsLive() {
  try {
    const n = sealNote(1, { dest20: Buffer.alloc(20, 1), kind: 'send' });
    return verifyRange(n.commit, n.rangeProof);
  } catch {
    return false;
  }
}
import { fluxsetFromBlocks } from '../../crypto/admit.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { attachStubAdmitV2 } from './stub_admit_v2.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
  PHASE_B_GATE,
  phaseBGate,
} from '../src/chain.js';

/**
 * A lock or withdraw on the wire names dest20 only. from, to, payer,
 * payoutPortalId, and an ssa1 address on it are vote_leak (a5760821,
 * cb733226), which verifyBlock checks before the admit gate this file pins.
 * Nor does it carry a top-level nanos: compaction drops it, and a hidden
 * lock's plaintext amount is amount_field (reserveNanosRejected).
 */
function compactReserve(tx) {
  for (const key of ['from', 'to', 'payer', 'payoutPortalId', 'nanos']) delete tx[key];
  const strip = (row) => {
    if (!row || typeof row !== 'object') return row;
    const { address, ...rest } = row;
    return rest;
  };
  tx.vin = (tx.vin || []).map(strip);
  tx.vout = (tx.vout || []).map(strip);
  assert.equal(compactLockLeakRejected(tx), null, `${tx.id} lock leak`);
  assert.equal(withdrawLeakRejected(tx), null, `${tx.id} withdraw leak`);
  return tx;
}

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
  it('a byte-2 flow send in an EVM block is admit_version', {
    skip: !rangeProofsLive() ? 'range proofs need shearadmit.node' : false,
  }, async () => {
    const idA = newIdentity();
    const idB = newIdentity();
    const destA = freshStealthDest(idA).dest;
    const destB = freshStealthDest(idA).dest;
    const sendNanos = 2;
    const lockNanos = 1000;
    const valueNanos = 77;
    const parentNow = 1_700_000_000_000;
    const parent = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: destA,
      bits: GENESIS_BITS_PACKED,
      now: parentNow,
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
    attachStubAdmitV2(sendTx);
    // The byte-2 send itself is the admit_version refusal.
    assert.equal(v12FlowVersionRejected(compactTx(sendTx))?.reason, 'admit_version');
    const lock = compactReserve(lockTx({ from: destA, to: destA, nanos: lockNanos, id: 'reserve-lock' }));
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
    const childNow = parentNow + 90_000;
    const base = {
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentFluxset: fluxsetFromBlocks([parent]).pubs,
      parentWeight: parent.weight,
      height: 2,
      miner: destA,
      bits: GENESIS_BITS_PACKED,
      now: childNow,
      samples: [{ miner: destA, nonce: '1', tag: 'a', count: 1 }],
    };
    const block = mine(buildTemplate({
      ...base,
      txs: [compactTx(sendTx), lock, evmTx],
    }));
    const got = await verifyBlock(block, { ...parent, hash: okP.hash, header: parent.header, height: 1 }, { trustedPowHash: TRUSTED, skipSharePow: true });
    assert.equal(sendTx.admit_proof.blob[0], 2);
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'admit_version', got.reason || got.error);
  });

  it('refuses a random vortice extra-mint in verifyBlock at the range gate', () => {
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
    assert.equal(denied.reason, 'range_proof');
  });

  it('persists EVM session: lock then withdraw against shipped verifyBlock', async () => {
    const id = newIdentity();
    const pay = freshStealthDest(id);
    const dest = pay.dest;
    const key = { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared };
    const t0 = 1_700_000_000_000;
    const lock = compactReserve(lockTx({ from: dest, to: dest, nanos: PI_SHE_NANOS, id: 'lock-p' }));
    lock.fee = levyNeed(lock, []);
    lock.maxLevy = lock.fee;
    signSpendTx(lock, key);
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
    assert.equal(v1.ok, false);
    assert.equal(v1.reason, 'admit_version');
    const t1 = t0 + RESERVE_EPOCH_MS;
    const state = emptyVault();
    deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: t0 });
    const want = PI_SHE_NANOS;
    const wd = compactReserve(withdrawTx({ from: dest, to: dest, nanos: want, id: 'wd-p' }));
    wd.fee = 0;
    signSpendTx(wd, key);
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
    assert.equal(empty.reason, 'admit_version');
    const unbound = compactReserve(withdrawTx({ from: dest, to: dest, nanos: want + 1, id: 'wd-over' }));
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
    assert.equal(overGot.reason, 'admit_version');
    const v2 = await verifyBlock(b2, null, { nowMs: t1, reserveState: state, trustedPowHash: TRUSTED });
    assert.equal(v2.ok, false);
    assert.equal(v2.reason, 'admit_version');
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

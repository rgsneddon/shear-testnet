/**
 * A vault withdraw does not carry an address. from, to, payer, and
 * payoutPortalId are vote_leak in the mempool and in a block, including a
 * payout id that matches the lock. buildFundedWithdraw refuses `to`.
 * Principal 0 is not a payment.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENESIS_BITS_PACKED, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest, destCommitFromSpendPub } from '../../crypto/address.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { boundReserveWithdraw } from '../../crypto/spend.js';
import {
  buildFundedWithdraw,
  emptyVault,
  withdrawRewardRejected,
} from '../../crypto/reserve_vault.js';
import { GENESIS_PREV, buildTemplate, digestTx, verifyBlock } from '../src/chain.js';
import { createStore } from '../src/store.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const NOW = 1_700_000_000_000;
const PORTAL = 'ab'.repeat(32);

function body(extra = {}) {
  return {
    id: 'wd-leak',
    kind: 'withdraw',
    programId: RESERVE_PROGRAM,
    portalId: PORTAL,
    nanos: 1,
    fee: 0,
    vin: [],
    vout: [],
    ...extra,
  };
}

function minerDest() {
  const id = newIdentity();
  return encodeDest(destCommitFromSpendPub(id.spendPub), id.admitBase);
}

function carry(who, tx) {
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner: who,
    finderDest: who,
    txs: [],
    bits: GENESIS_BITS_PACKED,
    now: NOW,
  });
  const txs = [tpl.txs[0], tx];
  const decoded = decodeHeader(Buffer.from(tpl.header));
  const header = encodeHeader({
    version: decoded.version,
    prevBlockHash: decoded.prevBlockHash,
    merkleRoot: merkleRoot(txs.map(digestTx)),
    continuityRoot: decoded.continuityRoot,
    timestamp: decoded.timestamp,
    bits: decoded.bits,
    nonce: decoded.nonce,
    baseFee: decoded.baseFee,
  });
  return {
    header,
    txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: who,
    height: 1,
    weight: tpl.weight,
  };
}

describe('withdraw leak gate', () => {
  const who = minerDest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wd-leak-'));
  const store = createStore(dir);

  it('refuses from, to, payer, and payoutPortalId in the mempool and in a block', () => {
    const cases = [
      ['from', { from: 'ssa1qqleak' }],
      ['to', { to: 'ssa1qqleak' }],
      ['payer', { payer: 'ssa1qqleak' }],
      ['payoutPortalId', { payoutPortalId: 'cd'.repeat(32) }],
      ['matching payoutPortalId', { payoutPortalId: PORTAL }],
      ['she1', { memo: 'pay she1qq' }],
      ['shear1', { memo: 'pay shear1qq' }],
      ['spendPub', { fs1: Buffer.from([0xf1, 1, 2, 3]), spendPub: 'ee'.repeat(32) }],
    ];
    try {
      for (const [name, extra] of cases) {
        const tx = body(extra);
        const pooled = admitMempool(emptyMempool(), tx, { height: 2, reserveState: emptyVault() });
        assert.equal(pooled.ok, false, name);
        assert.equal(pooled.reason, 'vote_leak', `${name} mempool ${pooled.reason}`);
        const queued = store.queueTx(structuredClone(tx));
        assert.equal(queued.ok, false, `${name} queue`);
        assert.equal(queued.reason, 'vote_leak', `${name} queue ${queued.reason}`);
        const block = verifyBlock(carry(who, tx), null, { probeBody: true, magic: 'shear-testnet-v12' });
        assert.equal(block.ok, false, `${name} block`);
        assert.equal(block.reason, 'vote_leak', `${name} block ${block.reason}`);
      }
      const clean = compactTx(body({
        fs1: Buffer.from([0xf1, 1]),
        spendPub: 'ee'.repeat(32),
        payoutPortalId: PORTAL,
        sig: 'ab'.repeat(64),
      }));
      assert.equal(clean.spendPub, undefined);
      assert.equal(clean.payoutPortalId, undefined);
      const lock = compactTx({
        kind: 'lock',
        programId: RESERVE_PROGRAM,
        portalId: PORTAL,
        payoutPortalId: PORTAL,
        spendPub: 'ee'.repeat(32),
        fs1: Buffer.from([0xf1, 1]),
        vin: [],
        vout: [{ kind: 'lock', dest20: Buffer.alloc(20, 3) }],
      });
      assert.equal(lock.spendPub, undefined);
      assert.equal(lock.payoutPortalId, PORTAL);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildFundedWithdraw returns null when given to', () => {
    const got = buildFundedWithdraw({
      to: 'ssa1qqleak',
      dest20: Buffer.alloc(20, 4),
      nanos: 1,
      portalId: PORTAL,
      vin: [{ commit: Buffer.alloc(32, 1) }],
      admit_proofs: [{ blob: Buffer.from([0xf1, 1]), cTilde: Buffer.alloc(32, 1), spendTag: Buffer.alloc(32, 2) }],
      fs1: Buffer.from([0xf1, 1]),
      anchor: 1,
      excess: Buffer.alloc(32, 3),
      retireProof: Buffer.alloc(8, 1),
      principalProof: { R: Buffer.alloc(32, 1), z: Buffer.alloc(32, 2) },
    });
    assert.equal(got, null);
  });

  it('a principal of 0 pays nothing', () => {
    const state = emptyVault();
    state.portals[PORTAL] = { id: PORTAL, ownerPub: '11'.repeat(32), tranches: [] };
    const tx = body({ nanos: 5, dest20: Buffer.alloc(20, 5) });
    assert.equal(withdrawRewardRejected(state, tx, NOW), null);
    const bound = boundReserveWithdraw(tx, state, new Set(), NOW);
    assert.equal(bound.ok, false, bound.reason);
    assert.notEqual(Number(bound.principal || 0), 5);
  });
});

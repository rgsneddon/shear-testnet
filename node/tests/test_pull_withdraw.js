import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, destOpeningFromView, hash20FromAddress } from '../../crypto/address.js';
import { sign } from 'node:crypto';
import { poolWithdrawDigest } from '../../crypto/eip712.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  levyNanos,
  poolFeeDest,
  poolPayoutDest,
  poolWithdrawTx,
  verifyPoolWithdrawOffchain,
  containsShe1,
} from '../../crypto/levy.js';
import { signPoolWithdraw } from '../../crypto/eip712.js';
import { BLOCK_SUBSIDY_NANOS, PI_SHE_NANOS, GENESIS_BITS_PACKED, bitsForBlock } from '../../crypto/asert.js';
import { buildAutoPayoutTx } from '../../pool/src/auto_payout.js';
import { splitPot } from '../../pool/src/pool.js';
import { handleWalletApi } from '../../pool/src/wallet_api.js';
import {
  buildTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';

const TRUSTED_POW = Buffer.alloc(32);

function blockFromTpl(tpl) {
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

describe('pool-found 0.01/0.99 and pull-withdraw', () => {
  it('splits pot 0.01 pool-fee + 0.99 payout; mined withdraw is ssa1 with no she1; empty/unsigned she1 does not withdraw', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const shares = splitPot([{ miner: dest, count: 1 }], dest);
    const pot = shares.find((s) => s.kind === 'pot');
    const fee = shares.find((s) => s.kind === 'pool-fee');
    assert.equal(pot.nanos, Math.floor(BLOCK_SUBSIDY_NANOS * 0.99));
    assert.equal(fee.nanos, Math.floor(BLOCK_SUBSIDY_NANOS * 0.01));
    assert.equal(fee.address, poolFeeDest());
    assert.equal(containsShe1(shares), false);

    assert.equal(verifyPoolWithdrawOffchain({ login: '', dest, nanos: 2e9, sig: 'x' }).ok, false);
    assert.equal(verifyPoolWithdrawOffchain({ login: 'she1abc', dest, nanos: 2e9, sig: '' }).reason, 'unsigned');
    assert.equal(verifyPoolWithdrawOffchain({ login: 'ssa1nope', dest, nanos: 2e9, sig: 'x' }).reason, 'need_she1');
    assert.equal(verifyPoolWithdrawOffchain({ login: 'she1abc', dest: 'she1leak', nanos: 2e9, sig: 'x' }).reason, 'she1');

    const sig = signPoolWithdraw({
      seed: Buffer.alloc(32, 7),
      login: id.paymentCode,
      dest,
      nanos: 2_000_000_000,
    });
    const off = verifyPoolWithdrawOffchain({
      login: id.paymentCode,
      dest,
      nanos: 2_000_000_000,
      sig,
    });
    assert.equal(off.ok, true, off.reason);
    const from = poolPayoutDest();
    const L = levyNanos(off.nanos);
    const tx = poolWithdrawTx({ from, to: dest, nanos: off.nanos, fee: L });
    assert.equal(containsShe1(tx), false);
    assert.equal(JSON.stringify(tx).includes('she1'), false);
    assert.equal(tx.vout[0].address.startsWith('ssa1'), true);

    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
      potShares: shares,
      txs: [tx],
    });
    assert.equal(decodeHeader(tpl.header).bits, GENESIS_BITS_PACKED);
    const block = blockFromTpl(tpl);
    const got = verifyBlock(block, null, { trustedPowHash: TRUSTED_POW });
    assert.equal(got.ok, true, got.reason);
    const body = JSON.stringify(block.txs.slice(1));
    assert.equal(body.includes('she1'), false);
    assert.equal(containsShe1(block.txs[1]), false);

    const leakTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
      txs: [{
        ...tx,
        id: 'leak',
        login: id.paymentCode,
        she1: id.paymentCode,
      }],
    });
    const leak = blockFromTpl(leakTpl);
    const denied = verifyBlock(leak, null, { trustedPowHash: TRUSTED_POW });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'she1_on_chain');

    const api = handleWalletApi(new URL('http://127.0.0.1/api/pool/withdraw'), 'POST', {
      login: '',
      dest,
      nanos: off.nanos,
      sig: 'x',
    }, { store: { historyFor: () => [], tip: () => ({ height: 20 }), mempool: [] }, queueSend: () => ({}) });
    assert.equal(api.json.ok, false);
    assert.equal(api.json.reason, 'auto_payout');
    assert.equal(api.status, 410);
  });

  it('custody hash-bonus coinbase verifies from block.miner without opts.poolDest', () => {
    const hasherId = newIdentity();
    const poolId = newIdentity();
    const hasher = destForLogin(hasherId.address, { viewKey: hasherId.viewKey, height: 1 });
    const pool = destForLogin(poolId.address, { viewKey: poolId.viewKey, height: 1 });
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: pool,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
      poolDest: pool,
      hashBonusCustodyDest: pool,
    });
    const parent = blockFromTpl(parentTpl);
    const okP = verifyBlock(parent, null, { trustedPowHash: TRUSTED_POW });
    assert.equal(okP.ok, true, okP.reason);
    const now = 1_700_000_090_000;
    const p = decodeHeader(parent.header);
    const row = { dest: hasher, dest20: hash20FromAddress(hasher), nonce: 1n, lz: 8 };
    const childTpl = buildTemplate({
      prev: okP.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner: pool,
      bits: bitsForBlock(p.bits, p.timestamp, now),
      now,
      shareBatch: [row],
      poolDest: pool,
      hashBonusCustodyDest: pool,
    });
    const child = { ...blockFromTpl(childTpl), miner: pool };
    const got = verifyBlock(child, {
      ...parent,
      hash: okP.hash,
      header: parent.header,
      height: 1,
      weight: parent.weight,
    }, { trustedPowHash: TRUSTED_POW, skipSharePow: true });
    assert.equal(got.ok, true, got.reason);
  });

  it('miner pull HTTP is deprecated; auto-payout still spends the pool wallet while operator Flow is locked', async () => {
    const prev = process.env.SHEAR_POOL_WALLET_LOCK;
    process.env.SHEAR_POOL_WALLET_LOCK = '1';
    try {
      const hasher = newIdentity();
      const dest = destForLogin(hasher.address, { viewKey: hasher.viewKey, height: 1 });
      const pool = destForLogin(newIdentity().address, { viewKey: Buffer.alloc(32, 3), height: 1 });
      const nanos = 2_000_000_000;
      const fee = levyNanos(nanos);
      const sig = signPoolWithdraw({
        seed: hasher.spendPub,
        login: hasher.paymentCode,
        dest,
        nanos,
      });
      const open = destOpeningFromView(hasher.viewKey, hasher.spendPub, 0);
      const digest = poolWithdrawDigest({
        login: hasher.paymentCode,
        dest,
        minerShe1: hasher.paymentCode,
        payoutSsa1: dest,
        nanos,
      });
      const spendSig = sign(null, digest, hasher.privateKey).toString('hex');
      const got = handleWalletApi(new URL('http://127.0.0.1/api/pool/withdraw'), 'POST', {
        login: hasher.paymentCode,
        dest,
        nanos,
        sig,
        open,
        spendSig,
      }, {
        store: {
          historyFor: (addr) => (addr === pool ? [{
            id: 'pot-1', from: 'coinbase', to: pool, nanos: 10 * 100_000_000_000, height: 10, kind: 'pot',
          }] : []),
          tip: () => ({ height: 40 }),
          mempool: [],
        },
        poolDest: pool,
        queueSend: () => ({ ok: true }),
      });
      assert.equal(got.json.ok, false);
      assert.equal(got.json.reason, 'auto_payout');
      assert.equal(got.status, 410);
      const built = buildAutoPayoutTx({ from: pool, to: dest, nanos: PI_SHE_NANOS, fee });
      assert.equal(built.ok, true, built.reason);
      assert.equal(built.tx.from, pool);
      assert.equal(built.tx.sponsor, pool);
      assert.equal(built.tx.fee, fee);
      assert.equal(built.tx.kind, 'pool-withdraw');
      assert.equal(built.tx.poolPaysFee, true);
    } finally {
      if (prev === undefined) delete process.env.SHEAR_POOL_WALLET_LOCK;
      else process.env.SHEAR_POOL_WALLET_LOCK = prev;
    }
  });
});

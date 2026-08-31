import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  levyNanos,
  poolFeeDest,
  poolPayoutDest,
  poolWithdrawTx,
  verifyPoolWithdrawOffchain,
  containsShe1,
} from '../../crypto/levy.js';
import { BLOCK_SUBSIDY_NANOS } from '../../crypto/asert.js';
import { splitPot } from '../../pool/src/pool.js';
import { handleWalletApi } from '../../pool/src/wallet_api.js';
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

    assert.equal(verifyPoolWithdrawOffchain({ login: '', dest, nanos: 1e8, sig: 'x' }).ok, false);
    assert.equal(verifyPoolWithdrawOffchain({ login: 'she1abc', dest, nanos: 1e8, sig: '' }).reason, 'unsigned');
    assert.equal(verifyPoolWithdrawOffchain({ login: 'ssa1nope', dest, nanos: 1e8, sig: 'x' }).reason, 'need_she1');
    assert.equal(verifyPoolWithdrawOffchain({ login: 'she1abc', dest: 'she1leak', nanos: 1e8, sig: 'x' }).reason, 'she1');

    const off = verifyPoolWithdrawOffchain({
      login: id.paymentCode,
      dest,
      nanos: 2_000_000_000,
      sig: 'ok',
    });
    assert.equal(off.ok, true);
    const from = poolPayoutDest();
    const L = levyNanos(off.nanos);
    const tx = poolWithdrawTx({ from, to: dest, nanos: off.nanos, fee: L });
    assert.equal(containsShe1(tx), false);
    assert.equal(JSON.stringify(tx).includes('she1'), false);
    assert.equal(tx.vout[0].address.startsWith('ssa1'), true);

    const block = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: Date.now(),
      potShares: shares,
      txs: [tx],
    }));
    const got = verifyBlock(block, null);
    assert.equal(got.ok, true, got.reason);
    const body = JSON.stringify(block.txs.slice(1));
    assert.equal(body.includes('she1'), false);
    assert.equal(containsShe1(block.txs[1]), false);

    const leak = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: Date.now(),
      txs: [{
        ...tx,
        id: 'leak',
        login: id.paymentCode,
        she1: id.paymentCode,
      }],
    }));
    const denied = verifyBlock(leak, null);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'she1_on_chain');

    const api = handleWalletApi(new URL('http://127.0.0.1/api/pool/withdraw'), 'POST', {
      login: '',
      dest,
      nanos: off.nanos,
      sig: 'x',
    }, { store: { historyFor: () => [], tip: () => ({ height: 20 }), mempool: [] }, queueSend: () => ({}) });
    assert.equal(api.json.ok, false);
  });
});

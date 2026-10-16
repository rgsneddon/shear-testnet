/**
 * Wholesale epoch reward sets, view-key refusal, double-claim, and fee order.
 */
import http from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, spendDestOf } from '../../crypto/address.js';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { vaultDest } from '../../crypto/flow_sheet.js';
import { selectBodyIndexes } from '../../crypto/block_budget.js';
import {
  applyReserveBlock,
  deposit,
  emptyVault,
  portalIdFromDest,
  rewardClaimProof,
  rewardClaimTx,
  rewardCommitment,
} from '../../crypto/reserve_vault.js';
import { createRpc } from '../../node/src/rpc.js';
import { handleWalletApi } from '../src/wallet_api.js';

const T0 = 1_700_000_000_000;

function vault() {
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  state.genesisMs = T0;
  return state;
}

function lockPortal(state, dest, when = T0 + 1_000) {
  return deposit({
    state,
    dest,
    nanos: PI_SHE_NANOS,
    nowMs: when,
    payout: dest,
  });
}

function owner() {
  const id = newIdentity();
  const lock = vaultDest(id.address, { viewKey: id.viewKey });
  const pay = spendDestOf(id.spendPub);
  return { id, lock, pay };
}

function settle(state) {
  const draw = T0 + RESERVE_EPOCH_MS + 1;
  const plan = rewardCommitment(state, draw);
  const committed = applyReserveBlock({
    state,
    block: { height: 2, txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] },
    nowMs: draw,
    genesisMs: T0,
    requireStakeReward: true,
  });
  assert.equal(committed.ok, true, committed.reason);
  return { draw, plan };
}

function published(store) {
  return handleWalletApi(new URL('http://127.0.0.1/api/vault/rewards'), 'GET', {}, { store });
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: JSON.parse(text), text });
      });
    });
    req.on('error', reject);
  });
}

describe('vault claim rows', () => {
  it('publishes every epoch leaf and rejects a view key', async () => {
    const state = vault();
    const alice = owner();
    const bob = owner();
    assert.ok(alice.lock);
    assert.ok(bob.lock);
    assert.notEqual(alice.pay, alice.lock);
    assert.equal(lockPortal(state, alice.lock).ok, true);
    assert.equal(lockPortal(state, bob.lock).ok, true);
    const { plan } = settle(state);
    assert.equal(plan.rows.length, 2);
    const store = { reserveVault: state, mempool: [], tip() { return null; } };
    const got = published(store);
    assert.equal(got.status, 200, got.json && got.json.reason);
    assert.equal(got.json.ok, true);
    assert.equal(got.json.sets.length, 1);
    assert.equal(got.json.sets[0].root, plan.root);
    assert.equal(got.json.sets[0].leaves.length, 2);
    const ids = got.json.sets[0].leaves.map((leaf) => leaf.nullifier).sort();
    const want = plan.rows.map((row) => row.nullifier).sort();
    assert.deepEqual(ids, want);
    for (const leaf of got.json.sets[0].leaves) {
      assert.equal(typeof leaf.rho, 'number');
      assert.ok(leaf.rho > 0);
      assert.equal(leaf.nanos, undefined);
      assert.equal(leaf.portalId, undefined);
      assert.equal(leaf.epoch, undefined);
      assert.equal(leaf.vout, undefined);
      assert.equal(leaf.spent, undefined);
    }
    const blob = JSON.stringify(got.json);
    assert.equal(blob.includes(alice.lock), false);
    assert.equal(blob.includes(bob.lock), false);
    assert.equal(blob.includes('portalId'), false);
    assert.equal(blob.includes('viewKey'), false);
    assert.equal(blob.includes(alice.id.viewKey), false);
    assert.equal(blob.includes('vout'), false);

    const queried = handleWalletApi(
      new URL(`http://127.0.0.1/api/vault/claims?viewKey=${encodeURIComponent(alice.id.viewKey)}`),
      'GET',
      {},
      { store },
    );
    assert.equal(queried.status, 400);
    assert.equal(queried.json.reason, 'view_key');
    assert.equal(JSON.stringify(queried.json).includes(alice.id.viewKey), false);
    const postedKey = handleWalletApi(new URL('http://127.0.0.1/api/vault/rewards'), 'POST', {
      viewKey: alice.id.viewKey,
      address: alice.id.address,
      to: alice.pay,
    }, { store });
    assert.equal(postedKey.status, 400);
    assert.equal(postedKey.json.reason, 'view_key');
    assert.equal(JSON.stringify(postedKey.json).includes(alice.id.viewKey), false);
    const viewkey = handleWalletApi(
      new URL('http://127.0.0.1/api/vault/rewards?viewkey=abc'),
      'GET',
      {},
      { store },
    );
    assert.equal(viewkey.status, 400);
    assert.equal(viewkey.json.reason, 'view_key');
    const noVault = handleWalletApi(new URL('http://127.0.0.1/api/vault/rewards'), 'GET', {}, { store: {} });
    assert.equal(noVault.status, 503);
    assert.equal(noVault.json.reason, 'no_vault');

    const reserve = handleWalletApi(
      new URL(`http://127.0.0.1/api/vault/reserve?dest=${encodeURIComponent(alice.lock)}`),
      'GET',
      {},
      { store },
    );
    assert.equal(reserve.status, 200, reserve.json && reserve.json.reason);
    const aliceRow = plan.rows.find((row) => row.portalId === portalIdFromDest(alice.lock));
    assert.ok(aliceRow);
    assert.equal(reserve.json.claimable, aliceRow.nanos);
    assert.equal(reserve.json.claimableRewards, aliceRow.nanos);

    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    try {
      const denied = rpc.dispatch('getvaultclaims', {
        viewKey: alice.id.viewKey,
        address: alice.id.address,
        to: alice.pay,
      });
      assert.equal(denied.ok, false);
      assert.equal(denied.reason, 'view_key');
      assert.equal(JSON.stringify(denied).includes(alice.id.viewKey), false);
      const open = rpc.dispatch('api/vault/rewards', {});
      assert.equal(open.ok, true);
      assert.equal(open.sets.length, 1);
      assert.equal(open.sets[0].leaves.length, 2);
      const heard = await rpc.listen();
      const httpDenied = await getJson(
        heard.port,
        `/api/vault/claims?viewKey=${encodeURIComponent(alice.id.viewKey)}`,
      );
      assert.equal(httpDenied.status, 400);
      assert.equal(httpDenied.json.reason, 'view_key');
      assert.equal(httpDenied.text.includes(alice.id.viewKey), false);
      const httpOpen = await getJson(heard.port, '/api/vault/rewards');
      assert.equal(httpOpen.status, 200);
      assert.equal(httpOpen.json.sets[0].leaves.length, 2);
      assert.equal(httpOpen.text.includes(alice.id.viewKey), false);
    } finally {
      await rpc.close();
    }
  });

  it('refuses a second claim of the same nullifier and ranks a higher fee first', () => {
    const state = vault();
    const alice = owner();
    const bob = owner();
    assert.equal(lockPortal(state, alice.lock).ok, true);
    assert.equal(lockPortal(state, bob.lock).ok, true);
    const { plan } = settle(state);
    const store = { reserveVault: state, mempool: [] };
    const leaves = published(store).json.sets[0].leaves;
    assert.equal(leaves.length, 2);
    function bodyOf(book, row, pay, fee, id, field) {
      const amount = row.rho != null ? row.rho : row.nanos;
      const tx = rewardClaimTx({
        to: pay,
        nanos: amount,
        nullifier: row.nullifier,
        proof: rewardClaimProof(book, row.nullifier),
        id,
        fee,
      });
      return {
        kind: 'reward-claim',
        programId: RESERVE_PROGRAM,
        to: pay,
        [field]: amount,
        nullifier: row.nullifier,
        proof: tx.proof,
        vout: tx.vout,
        fee,
        id,
      };
    }
    const aliceLeaf = leaves.find((leaf) => leaf.nullifier === plan.rows.find((row) => row.portalId === portalIdFromDest(alice.lock)).nullifier);
    const bobLeaf = leaves.find((leaf) => leaf.nullifier === plan.rows.find((row) => row.portalId === portalIdFromDest(bob.lock)).nullifier);
    assert.notEqual(aliceLeaf.nullifier, bobLeaf.nullifier);
    const low = bodyOf(state, aliceLeaf, alice.pay, 1000, 'claim-low', 'rho');
    const high = bodyOf(state, bobLeaf, bob.pay, 8000, 'claim-high', 'nanos');
    assert.equal(low.nanos, undefined);
    assert.equal(low.rho, aliceLeaf.rho);
    const queueSend = (tx) => {
      store.mempool.push(tx);
      return tx;
    };
    const postedLow = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', low, {
      store,
      queueSend,
    });
    assert.equal(postedLow.status, 200, postedLow.json && postedLow.json.reason);
    const postedHigh = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', high, {
      store,
      queueSend,
    });
    assert.equal(postedHigh.status, 200, postedHigh.json && postedHigh.json.reason);
    const picks = selectBodyIndexes(store.mempool);
    assert.equal(store.mempool[picks[0]].id, 'claim-high');
    assert.equal(store.mempool[picks[1]].id, 'claim-low');
    const again = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', {
      ...low,
      id: 'claim-low-again',
    }, { store, queueSend: (tx) => tx });
    assert.equal(again.status, 400);
    assert.equal(again.json.reason, 'double_mint');
    const minted = vault();
    assert.equal(lockPortal(minted, alice.lock).ok, true);
    settle(minted);
    const mintedStore = { reserveVault: minted, mempool: [] };
    const row = published(mintedStore).json.sets[0].leaves[0];
    minted.mintedIds[row.nullifier] = true;
    const hidden = published(mintedStore);
    assert.equal(hidden.status, 200);
    assert.equal(hidden.json.sets[0].leaves.length, 1);
    assert.equal(hidden.json.sets[0].leaves[0].spent, true);
    assert.equal(hidden.json.sets[0].root, minted.rewardRoots[Object.keys(minted.rewardRoots)[0]]);
    const taken = handleWalletApi(
      new URL('http://127.0.0.1/api/wallet/send'),
      'POST',
      bodyOf(minted, row, alice.pay, 8000, 'claim-minted', 'rho'),
      { store: mintedStore, queueSend: (tx) => tx },
    );
    assert.equal(taken.status, 400);
    assert.equal(taken.json.reason, 'double_mint');
  });
});

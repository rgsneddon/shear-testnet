/**
 * Per-view-key reward claim rows, double-claim refusal, and fee ordering.
 */
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
  rewardClaimProof,
  rewardClaimTx,
  rewardCommitment,
} from '../../crypto/reserve_vault.js';
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

function claims(store, who, pay = who.pay) {
  return handleWalletApi(new URL('http://127.0.0.1/api/vault/claims'), 'POST', {
    viewKey: who.id.viewKey,
    address: who.id.address,
    to: pay,
  }, { store });
}

describe('vault claim rows', () => {
  it('returns only this view key, with claimable set on the reserve read', () => {
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
    const store = { reserveVault: state, mempool: [] };
    const got = claims(store, alice);
    assert.equal(got.status, 200, got.json && got.json.reason);
    assert.equal(got.json.ok, true);
    assert.equal(got.json.claims.length, 1);
    const mine = got.json.claims[0];
    assert.equal(typeof mine.nanos, 'number');
    assert.ok(mine.nanos > 0);
    assert.match(mine.nullifier, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(mine.proof));
    assert.equal(mine.vout.kind, 'reward-claim');
    assert.equal(mine.vout.portalId, undefined);
    const blob = JSON.stringify(got.json);
    assert.equal(blob.includes(alice.lock), false);
    assert.equal(blob.includes(bob.lock), false);
    assert.equal(blob.includes('portalId'), false);
    assert.equal(blob.includes(alice.id.viewKey), false);
    const other = plan.rows.find((row) => row.nullifier !== mine.nullifier);
    assert.ok(other);
    assert.equal(blob.includes(other.nullifier), false);
    const bobs = claims(store, bob);
    assert.equal(bobs.status, 200);
    assert.equal(bobs.json.claims.length, 1);
    assert.equal(bobs.json.claims[0].nullifier, other.nullifier);
    assert.notEqual(bobs.json.claims[0].nullifier, mine.nullifier);
    const crossed = claims(store, { id: { viewKey: bob.id.viewKey, address: alice.id.address }, pay: alice.pay });
    assert.equal(crossed.status, 200);
    assert.equal(crossed.json.claims.length, 0);
    const missingKey = claims(store, { id: { viewKey: '', address: alice.id.address }, pay: alice.pay });
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.json.reason, 'view');
    const noVault = handleWalletApi(new URL('http://127.0.0.1/api/vault/claims'), 'POST', {
      viewKey: alice.id.viewKey,
      address: alice.id.address,
      to: alice.pay,
    }, { store: {} });
    assert.equal(noVault.status, 503);
    assert.equal(noVault.json.reason, 'no_vault');
    const reserve = handleWalletApi(
      new URL(`http://127.0.0.1/api/vault/reserve?dest=${encodeURIComponent(alice.lock)}`),
      'GET',
      {},
      { store },
    );
    assert.equal(reserve.status, 200, reserve.json && reserve.json.reason);
    assert.equal(reserve.json.claimable, mine.nanos);
    assert.equal(reserve.json.claimableRewards, mine.nanos);
  });

  it('refuses a second claim of the same nullifier and ranks a higher fee first', () => {
    const state = vault();
    const alice = owner();
    const bob = owner();
    assert.equal(lockPortal(state, alice.lock).ok, true);
    assert.equal(lockPortal(state, bob.lock).ok, true);
    const { plan } = settle(state);
    const store = { reserveVault: state, mempool: [] };
    const aliceClaims = claims(store, alice).json.claims;
    const bobClaims = claims(store, bob).json.claims;
    assert.equal(aliceClaims.length, 1);
    assert.equal(bobClaims.length, 1);
    function bodyOf(book, row, pay, fee, id) {
      const tx = rewardClaimTx({
        to: pay,
        nanos: row.nanos,
        nullifier: row.nullifier,
        proof: rewardClaimProof(book, row.nullifier),
        id,
        fee,
      });
      return {
        kind: 'reward-claim',
        programId: RESERVE_PROGRAM,
        to: pay,
        nanos: row.nanos,
        nullifier: row.nullifier,
        proof: tx.proof,
        vout: tx.vout,
        fee,
        id,
      };
    }
    const low = bodyOf(state, aliceClaims[0], alice.pay, 1000, 'claim-low');
    const high = bodyOf(state, bobClaims[0], bob.pay, 8000, 'claim-high');
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
    const row = claims(mintedStore, alice).json.claims[0];
    minted.mintedIds[row.nullifier] = true;
    const hidden = claims(mintedStore, alice);
    assert.equal(hidden.status, 200);
    assert.equal(hidden.json.claims.length, 0);
    const taken = handleWalletApi(
      new URL('http://127.0.0.1/api/wallet/send'),
      'POST',
      bodyOf(minted, row, alice.pay, 8000, 'claim-minted'),
      { store: mintedStore, queueSend: (tx) => tx },
    );
    assert.equal(taken.status, 400);
    assert.equal(taken.json.reason, 'double_mint');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, destOpeningFromView, hash20FromAddress, payoutDest } from '../../crypto/address.js';
import { destForLogin, vaultDest } from '../../crypto/flow_sheet.js';
import {
  extraMintAllowed,
  RESERVE_PROGRAM,
  JOIN_PROGRAM,
  JOIN_KIND_GENESIS,
  NANOS_PER_SHE,
  PI_SHE_NANOS,
  SPENDABLE_CONFIRMATIONS,
} from '../../crypto/asert.js';
import { emptyVault } from '../../crypto/reserve_vault.js';
import { isPinnedProgram, listPublicVortices, mintVorticeDeployKey } from '../../crypto/vortex.js';
import { handleWalletApi } from '../src/wallet_api.js';

function url(path) {
  return new URL(`http://127.0.0.1${path}`);
}

function storeWith({ rows = [], reserveVault, issued } = {}) {
  return {
    blocks: [],
    historyFor: (addr) => rows.filter((r) => r.to === addr || r.from === addr),
    tip: () => ({ height: 20 }),
    mempool: [],
    reserveVault: reserveVault || emptyVault(),
    vortice: { issued: issued || Object.create(null) },
  };
}

describe('pool send reconstruct and Join vault', () => {
  it('refuses send when reconstructed spendable is below amount and accepts when dest holds credits', () => {
    const alice = newIdentity();
    const silent = payoutDest(alice.paymentCode);
    const bobId = newIdentity();
    const bob = destForLogin(bobId.address, { viewKey: bobId.viewKey, height: 1 });
    const rows = [{
      id: 'cb-1',
      from: 'coinbase',
      to: silent,
      nanos: 1.5 * NANOS_PER_SHE,
      height: 10,
      kind: 'coinbase',
    }];
    const store = storeWith({ rows });
    const posted = [];
    const spendH = hash20FromAddress(alice.address);
    const open = destOpeningFromView(alice.viewKey, spendH, 0);
    const deny = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: destForLogin(alice.address, { viewKey: alice.viewKey, height: 99 }),
      to: bob,
      amount: 0.4,
      open,
    }, { store, miners: new Map(), queueSend: (t) => posted.push(t) && t });
    assert.equal(deny.status, 400);
    assert.equal(deny.json.reason, 'insufficient');

    const unsigned = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: bob,
      amount: 0.4,
    }, { store, miners: new Map(), queueSend: () => ({ id: 'nope' }) });
    assert.equal(unsigned.status, 403);
    assert.equal(unsigned.json.reason, 'unsigned');

    const ok = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: bob,
      amount: 0.4,
      open,
    }, { store, miners: new Map(), queueSend: (t) => {
      const tx = { id: 'send-1', ...t };
      posted.push(tx);
      return tx;
    } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.tx.from, silent);
    assert.ok(ok.json.fromBalance < 1.5);
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
  });

  it('Reserve lock spends spendable Continuum and refuses when spendable is short', () => {
    const alice = newIdentity();
    const silent = payoutDest(alice.paymentCode);
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const spendH = hash20FromAddress(alice.address);
    const open = destOpeningFromView(alice.viewKey, spendH, 0);
    const she = PI_SHE_NANOS / NANOS_PER_SHE;
    const rows = [{
      id: 'cb-1',
      from: 'coinbase',
      to: silent,
      nanos: 10 * NANOS_PER_SHE,
      height: 10,
      kind: 'coinbase',
    }];
    const store = storeWith({ rows });
    const posted = [];
    const deny = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: 11,
      kind: 'lock',
      programId: RESERVE_PROGRAM,
      open,
    }, { store, miners: new Map(), queueSend: (t) => posted.push(t) && t });
    assert.equal(deny.status, 400);
    assert.equal(deny.json.reason, 'insufficient');
    assert.equal(posted.length, 0);

    const ok = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: she,
      kind: 'lock',
      programId: RESERVE_PROGRAM,
      open,
    }, { store, miners: new Map(), queueSend: (t) => {
      const tx = { id: 'lock-1', ...t };
      posted.push(tx);
      return tx;
    } });
    assert.equal(ok.status, 200, ok.json.reason);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.tx.kind, 'lock');
    assert.equal(ok.json.tx.programId, RESERVE_PROGRAM);
    assert.equal(posted[0].kind, 'lock');
    assert.equal(posted[0].programId, RESERVE_PROGRAM);
    assert.equal(Number(posted[0].nanos), PI_SHE_NANOS);
    assert.ok(ok.json.fromBalance < 10);

    const skipLevy = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: 0.1,
      kind: 'lock',
      open,
    }, { store, miners: new Map(), queueSend: (t) => posted.push(t) && t });
    assert.equal(skipLevy.status, 400);
    assert.equal(skipLevy.json.reason, 'bad_kind');
  });

  it('Join HTTP is gone; extra-mint of join-genesis is refused', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS }), false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: 'claim' }), false);
    assert.equal(extraMintAllowed('other-vortice'), false);

    const claim = handleWalletApi(url('/api/join/claim'), 'POST', {
      key: 'join1.dead',
      payout: 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    }, { store: storeWith(), miners: new Map(), queueSend: () => ({}) });
    assert.equal(claim.status, 404);
    assert.equal(claim.json.reason, 'not_found');

    const vault = handleWalletApi(url('/api/vault/join'), 'GET', {}, {
      store: storeWith(),
      miners: new Map(),
      queueSend: () => ({}),
    });
    assert.equal(vault.status, 404);
    assert.equal(vault.json.reason, 'not_found');
  });

  it('Reserve and Join program ids are not public vortices', () => {
    const key = mintVorticeDeployKey({
      programId: 'stake-pool-a',
      name: 'Stake Pool A',
      origin: 'https://dapp.example/a.json',
      source: '{}',
    });
    assert.ok(key);
    const issued = {
      'stake-pool-a': { id: 'stake-pool-a', name: 'Stake Pool A' },
      [RESERVE_PROGRAM]: { id: RESERVE_PROGRAM, name: 'The Reserve' },
      [JOIN_PROGRAM]: { id: JOIN_PROGRAM, name: 'The Join' },
    };
    const pub = listPublicVortices(issued);
    assert.equal(pub.some((v) => v.id === RESERVE_PROGRAM), false);
    assert.equal(pub.some((v) => v.id === JOIN_PROGRAM), false);
    assert.equal(isPinnedProgram(RESERVE_PROGRAM), true);
    assert.equal(extraMintAllowed('stake-pool-a'), false);
    const store = storeWith({ issued });
    const out = handleWalletApi(url('/api/vortex/list'), 'GET', {}, {
      store,
      miners: new Map(),
      queueSend: () => ({}),
    });
    assert.equal(out.status, 200);
    assert.equal(out.json.vortices.some((v) => v.id === RESERVE_PROGRAM), false);
    assert.equal(out.json.vortices.some((v) => v.id === JOIN_PROGRAM), false);
  });
});

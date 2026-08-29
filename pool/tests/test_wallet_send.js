import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  extraMintAllowed,
  RESERVE_PROGRAM,
  JOIN_PROGRAM,
  JOIN_KIND_GENESIS,
  JOIN_WINDOW_DAYS,
  NANOS_PER_SHE,
  SPENDABLE_CONFIRMATIONS,
} from '../../crypto/asert.js';
import { emptyJoin, fundGenesis, mintJoinKey, buildSnapshot, issueJoinKey, genesisTx } from '../../crypto/join_vault.js';
import { joinDest } from '../../crypto/flow_sheet.js';
import { emptyVault } from '../../crypto/reserve_vault.js';
import { isPinnedProgram, listPublicVortices, mintVorticeDeployKey } from '../../crypto/vortex.js';
import { handleWalletApi } from '../src/wallet_api.js';
import { createStore } from '../../node/src/store.js';
import { buildTemplate, mineTemplate, GENESIS_PREV } from '../../node/src/chain.js';

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
  };
}

function url(path) {
  return new URL(`http://127.0.0.1${path}`);
}

function storeWith({ rows = [], joinVault, reserveVault, issued } = {}) {
  return {
    blocks: [],
    historyFor: (addr) => rows.filter((r) => r.to === addr || r.from === addr),
    tip: () => ({ height: 20 }),
    mempool: [],
    joinVault: joinVault || emptyJoin(),
    reserveVault: reserveVault || emptyVault(),
    vortice: { issued: issued || Object.create(null) },
  };
}

describe('pool send reconstruct and Join vault', () => {
  it('refuses send when reconstructed spendable is below amount and accepts when dest holds credits', () => {
    const alice = newIdentity();
    const silent = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
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
    const deny = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: destForLogin(alice.address, { viewKey: alice.viewKey, height: 99 }),
      to: bob,
      amount: 0.4,
    }, { store, miners: new Map(), queueSend: (t) => posted.push(t) && t });
    assert.equal(deny.status, 400);
    assert.equal(deny.json.reason, 'insufficient');

    const ok = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: bob,
      amount: 0.4,
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

  it('Join genesis mints full circulation once; claim is 1:1 and not extra-mint; window is 99 days', () => {
    assert.equal(JOIN_WINDOW_DAYS, 99);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS }), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: 'claim' }), false);
    assert.equal(extraMintAllowed('other-vortice'), false);

    const alice = newIdentity();
    const payout = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const vaultDest = joinDest(alice.address, { viewKey: alice.viewKey });
    const holders = [
      { owner: 'prior1alice', coins: 3 },
      { owner: 'prior1bob', coins: 7 },
    ];
    const snap = buildSnapshot(holders);
    assert.equal(snap.circulatingNanos, 10 * NANOS_PER_SHE);
    const minted = issueJoinKey(snap, 'prior1alice');
    assert.equal(minted.ok, true);
    assert.equal(minted.she, 3);
    assert.equal(minted.root, snap.root);
    assert.equal(mintJoinKey({ owner: 'prior1alice', coins: 3 }).ok, false);
    const joinVault = emptyJoin();
    const t0 = Date.now();
    const funded = fundGenesis({
      state: joinVault,
      nanos: snap.circulatingNanos,
      nowMs: t0,
      root: snap.root,
      to: vaultDest,
    });
    assert.equal(funded.ok, true);
    assert.equal(joinVault.vaultDest, vaultDest);
    assert.equal(joinVault.remainingNanos, snap.circulatingNanos);
    assert.equal(fundGenesis({ state: joinVault, nanos: snap.circulatingNanos, nowMs: t0, root: snap.root }).ok, false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-join-http-'));
    const store = createStore(dir);
    const minerId = newIdentity();
    const miner = destForLogin(minerId.address, { viewKey: minerId.viewKey, height: 1 });
    const gen = genesisTx({ to: vaultDest, nanos: snap.circulatingNanos, root: snap.root });
    gen.fee = 8;
    const b1 = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner,
      bits: 14,
      now: t0,
      txs: [gen],
    }));
    assert.equal(store.append(b1).ok, true);
    assert.equal(store.joinVault.remainingNanos, snap.circulatingNanos);
    assert.equal(store.spendableNanos(vaultDest), snap.circulatingNanos);
    assert.equal(store.spendableNanos(payout), 0);

    const claim = handleWalletApi(url('/api/join/claim'), 'POST', {
      key: minted.key,
      payout,
    }, {
      store,
      miners: new Map(),
      queueSend: (t) => {
        const tx = { id: t.id || `claim-${Date.now()}`, ...t };
        const got = store.queueTx(tx);
        if (!got.ok) return got;
        return got.tx || tx;
      },
    });
    assert.equal(claim.status, 200);
    assert.equal(claim.json.she, 3);
    assert.equal(claim.json.public, false);
    assert.equal(claim.json.from, vaultDest);
    assert.equal(claim.json.to, payout);
    assert.equal(claim.json.remainingNanos, 7 * NANOS_PER_SHE);
    assert.equal(store.joinVault.remainingNanos, snap.circulatingNanos);
    assert.equal(store.spendableNanos(payout), 0);
    assert.equal(store.mempool.some((t) => t.kind === 'claim'), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: 'claim' }), false);

    const again = handleWalletApi(url('/api/join/claim'), 'POST', {
      key: minted.key,
      payout,
    }, {
      store,
      miners: new Map(),
      queueSend: (t) => store.queueTx({ id: t.id || `claim-dup`, ...t }),
    });
    assert.equal(again.status, 400);
    assert.equal(again.json.reason, 'already_claimed');
    assert.equal(store.joinVault.remainingNanos, snap.circulatingNanos);

    const { tpl } = store.template({ miner, bits: 14, now: t0 + 90_000 });
    const sealed = store.append(mine(tpl));
    assert.equal(sealed.ok, true, sealed.reason);
    assert.equal(store.joinVault.remainingNanos, 7 * NANOS_PER_SHE);
    assert.equal(store.spendableNanos(payout), 3 * NANOS_PER_SHE);
    assert.equal(store.spendableNanos(vaultDest), 7 * NANOS_PER_SHE);
    assert.ok(store.historyFor(payout).some((r) => r.kind === 'claim' && r.nanos === 3 * NANOS_PER_SHE));

    const afterSeal = handleWalletApi(url('/api/join/claim'), 'POST', {
      key: minted.key,
      payout,
    }, {
      store,
      miners: new Map(),
      queueSend: (t) => store.queueTx({ id: t.id || `claim-late`, ...t }),
    });
    assert.equal(afterSeal.status, 400);
    assert.equal(afterSeal.json.reason, 'already_claimed');
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

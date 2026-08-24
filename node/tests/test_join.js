import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printConfig } from '../src/node.js';
import { createStore } from '../src/store.js';
import { buildTemplate, mineTemplate, GENESIS_PREV, verifyBlock } from '../src/chain.js';
import { JOIN_PROGRAM, JOIN_WINDOW_MS, NANOS_PER_SHE } from '../../crypto/asert.js';
import {
  buildSnapshot,
  encodeJoinKey,
  genesisTx,
  claimTx,
  burnTx,
} from '../../crypto/join_vault.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin, joinDest } from '../../crypto/flow_sheet.js';

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

function claimCredit(store, dest) {
  return store.historyFor(dest)
    .filter((r) => r.kind === 'claim')
    .reduce((s, r) => s + Number(r.nanos || 0), 0);
}

describe('node Join vault', () => {
  it('printConfig names The Join window', () => {
    const c = printConfig();
    assert.equal(c.joinProgram, JOIN_PROGRAM);
    assert.equal(c.joinWindowDays, 99);
    assert.equal(c.extraMintJoinGenesis, true);
    assert.equal(c.mainnet, false);
  });

  it('append of join-genesis then claim credits the dest; leftover burns after 99 days', () => {
    const alice = newIdentity();
    const payout = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const vault = joinDest(alice.address, { viewKey: alice.viewKey });
    const snap = buildSnapshot([{ owner: 'prior1alice', coins: 1 }, { owner: 'prior1bob', coins: 2 }]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-join-'));
    const store = createStore(dir);
    const t0 = 1_800_000_000_000;
    const gen = genesisTx({ to: vault, nanos: snap.circulatingNanos, root: snap.root });
    const b1 = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: payout,
      bits: 8,
      now: t0,
      txs: [gen],
    }));
    assert.equal(store.append(b1).ok, true);
    assert.equal(store.joinVault.genesisMs, t0);
    assert.equal(store.joinVault.remainingNanos, 3 * NANOS_PER_SHE);
    assert.equal(store.spendableNanos(vault), 3 * NANOS_PER_SHE);

    const row = snap.rows.find((r) => r.owner === 'prior1alice');
    const cl = claimTx({ from: vault, to: payout, nanos: NANOS_PER_SHE, commit: row.commit });
    cl.key = encodeJoinKey(row);
    cl.root = snap.root;
    const tip = store.tip();
    const b2 = mine(buildTemplate({
      prev: tip.hash,
      prevHeader: tip.header,
      height: 2,
      miner: payout,
      bits: 8,
      now: t0 + 1000,
      txs: [cl],
    }));
    assert.equal(store.append(b2).ok, true);
    assert.equal(store.joinVault.remainingNanos, 2 * NANOS_PER_SHE);
    assert.equal(claimCredit(store, payout), NANOS_PER_SHE);
    assert.equal(store.spendableNanos(vault), 2 * NANOS_PER_SHE);

    const dup = mine(buildTemplate({
      prev: store.tip().hash,
      prevHeader: store.tip().header,
      height: 3,
      miner: payout,
      bits: 8,
      now: t0 + 2000,
      txs: [cl],
    }));
    const duped = store.append(dup);
    assert.equal(duped.ok, false);
    assert.equal(duped.reason, 'already_claimed');
    assert.equal(claimCredit(store, payout), NANOS_PER_SHE);
    assert.equal(store.joinVault.remainingNanos, 2 * NANOS_PER_SHE);

    const secondGen = genesisTx({ to: vault, nanos: snap.circulatingNanos, root: snap.root });
    const g2 = mine(buildTemplate({
      prev: store.tip().hash,
      prevHeader: store.tip().header,
      height: 3,
      miner: payout,
      bits: 8,
      now: t0 + 3000,
      txs: [secondGen],
    }));
    const againMint = store.append(g2);
    assert.equal(againMint.ok, false);
    assert.equal(againMint.reason, 'mint_forbidden');
    const gated = verifyBlock(g2, { hash: store.tip().hash }, { joinFunded: true });
    assert.equal(gated.ok, false);
    assert.equal(gated.reason, 'mint_forbidden');
    assert.equal(store.joinVault.circulatingNanos, 3 * NANOS_PER_SHE);

    const burn = burnTx({ from: vault, nanos: store.joinVault.remainingNanos });
    const b3 = mine(buildTemplate({
      prev: store.tip().hash,
      prevHeader: store.tip().header,
      height: 4,
      miner: payout,
      bits: 8,
      now: t0 + JOIN_WINDOW_MS,
      txs: [burn],
    }));
    assert.equal(store.append(b3).ok, true);
    assert.equal(store.joinVault.burned, true);
    assert.equal(store.joinVault.remainingNanos, 0);
    assert.equal(store.spendableNanos(vault), 0);

    const bob = snap.rows.find((r) => r.owner === 'prior1bob');
    const late = claimTx({
      from: vault,
      to: payout,
      nanos: 2 * NANOS_PER_SHE,
      commit: bob.commit,
    });
    late.key = encodeJoinKey(bob);
    late.root = snap.root;
    const b4 = mine(buildTemplate({
      prev: store.tip().hash,
      prevHeader: store.tip().header,
      height: 5,
      miner: payout,
      bits: 8,
      now: t0 + JOIN_WINDOW_MS + 1000,
      txs: [late],
    }));
    const lateGot = store.append(b4);
    assert.equal(lateGot.ok, false);
    assert.equal(claimCredit(store, payout), NANOS_PER_SHE);
    assert.equal(store.joinVault.remainingNanos, 0);
    assert.equal(store.joinVault.claimed[bob.commit], undefined);
  });
});

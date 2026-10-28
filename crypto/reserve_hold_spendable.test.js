import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, spendDestOf } from './address.js';
import { NANOS_PER_SHE, SPENDABLE_CONFIRMATIONS } from './asert.js';
import { vaultDest } from './flow_sheet.js';
import { levyNanos } from './levy.js';
import { signSpendTx } from './spend.js';
import {
  applyReserveBlock,
  emptyVault,
  lockTx,
  portalPrincipalNanos,
} from './reserve_vault.js';
import { createStore } from '../node/src/store.js';
import { bluWallet, soloCoin, soloPay } from '../node/tests/support/blunote_mine.js';

function powHex(n) {
  const b = Buffer.alloc(32, 0);
  b[31] = n & 0xff;
  b[30] = (n >> 8) & 0xff;
  return b.toString('hex');
}

// R28 solo option (b): each round pays its pot to a fresh one-time key of
// the miner's wallet (`blu`), not to a dest a node can walk.
async function seal(store, miner, now, n, blu) {
  const { job } = store.template({ miner, now, ...soloPay(blu) });
  return store.submitHeader({
    jobId: job.jobId,
    nonce: 0n,
    miner,
    powHash: powHex(n),
  }, { trusted: true });
}

describe('reserve principal is not spendable', () => {
  it('a lock with no lock note is not principal and does not invent a portal', () => {
    const alice = newIdentity();
    const payer = spendDestOf(alice.spendPub);
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const stranger = spendDestOf(newIdentity().spendPub);
    assert.equal(typeof payer, 'string');
    assert.equal(typeof vault, 'string');
    assert.notEqual(payer, vault);
    const state = emptyVault();
    const locked = applyReserveBlock({
      state,
      block: {
        txs: [
          { coinbase: true, vout: [] },
          lockTx({ from: payer, to: vault, nanos: NANOS_PER_SHE, id: 'lock-hold' }),
        ],
      },
      nowMs: 1_700_000_000_000,
      genesisMs: 1_700_000_000_000,
    });
    assert.equal(locked.ok, false);
    assert.equal(locked.reason, 'stake_reward');
    assert.equal(portalPrincipalNanos(state, payer), 0);
    assert.equal(portalPrincipalNanos(state, vault), 0);
    assert.equal(portalPrincipalNanos(state, stranger), 0);
    assert.equal(Object.keys(state.portals).length, 0);
    assert.equal(portalPrincipalNanos(null, payer), 0);
  });

  it('a plaintext lock is not a debit, and spendable is the note walk', async () => {
    const id = newIdentity();
    const miner = spendDestOf(id.spendPub);
    const blu = bluWallet(id.spendSeed);
    // The wallet's own walk: the notes its scan key finds in each record,
    // matured as a coinbase is.
    const walletNanos = (store) => {
      const tipH = store.tip().height;
      let sum = 0n;
      for (const b of store.blocks) {
        // The ledger's rule (note_ledger.js): tip - height + 1 confirmations.
        if (tipH - b.height + 1 < SPENDABLE_CONFIRMATIONS) continue;
        const coin = soloCoin(blu, b);
        if (coin) sum += BigInt(coin.v);
      }
      return sum;
    };
    const vault = vaultDest(id.address, { viewKey: id.viewKey });
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hold-b-'));
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hold-a-'));
    try {
      const live = createStore(dirB);
      const plain = createStore(dirA);
      const t0 = 1_700_000_000_000;
      const step = 60_000;
      for (let i = 0; i < 10; i += 1) {
        const now = t0 + i * step;
        const got = await seal(live, miner, now, i + 1, blu);
        assert.equal(got.ok, true, got.reason || `seal ${i}`);
        const twin = await seal(plain, miner, now, i + 1, blu);
        assert.equal(twin.ok, true, twin.reason || `twin ${i}`);
      }
      const mature = walletNanos(live);
      assert.ok(mature >= BigInt(NANOS_PER_SHE + 100), `mature ${mature}`);
      // The node walks dest notes only; a one-time key is no dest's.
      assert.equal(live.spendableNanos(miner), 0);
      const open = await seal(plain, miner, t0 + 10 * step, 11, blu);
      assert.equal(open.ok, true, open.reason || 'plain seal');
      const unlocked = plain.spendableNanos(miner);
      const unlockedWallet = walletNanos(plain);
      const raw = lockTx({
        from: miner,
        to: vault,
        nanos: NANOS_PER_SHE,
        id: 'lock-hold-seal',
      });
      raw.fee = levyNanos(0, { tx: raw });
      const lock = signSpendTx(raw, id.privateKey);
      const queued = live.queueTx(lock);
      assert.equal(queued.ok, false, queued.reason || 'queue');
      // A plaintext lock names from/to. Since a5760821 the mempool refuses that
      // address leak (compactLockLeakRejected) before the admit-version gate.
      assert.equal(queued.reason, 'vote_leak');
      const heldSeal = await seal(live, miner, t0 + 10 * step, 11, blu);
      assert.equal(heldSeal.ok, true, heldSeal.reason || 'lock seal');
      const held = live.spendableNanos(miner);
      assert.equal(held, unlocked);
      // The refused lock debited nothing the wallet walks either.
      assert.equal(walletNanos(live), unlockedWallet);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});

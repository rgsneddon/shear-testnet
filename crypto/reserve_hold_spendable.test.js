import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, spendDestOf } from './address.js';
import { NANOS_PER_SHE } from './asert.js';
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

function powHex(n) {
  const b = Buffer.alloc(32, 0);
  b[31] = n & 0xff;
  b[30] = (n >> 8) & 0xff;
  return b.toString('hex');
}

async function seal(store, miner, now, n) {
  const { job } = store.template({ miner, now });
  return store.submitHeader({
    jobId: job.jobId,
    nonce: 0n,
    miner,
    powHash: powHex(n),
  }, { trusted: true });
}

describe('reserve principal is not spendable', () => {
  it('a lock credited to the vault is principal of the payer and does not invent a portal', () => {
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
    });
    assert.equal(locked.some((r) => r.action === 'lock' && r.ok === true), true);
    assert.equal(portalPrincipalNanos(state, payer), NANOS_PER_SHE);
    assert.equal(portalPrincipalNanos(state, vault), NANOS_PER_SHE);
    const before = Object.keys(state.portals).length;
    assert.equal(portalPrincipalNanos(state, stranger), 0);
    assert.equal(Object.keys(state.portals).length, before);
    assert.equal(portalPrincipalNanos(null, payer), 0);
  });

  it('a plaintext lock is not a debit, and spendable is the note walk', async () => {
    const id = newIdentity();
    const miner = spendDestOf(id.spendPub);
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
        const got = await seal(live, miner, now, i + 1);
        assert.equal(got.ok, true, got.reason || `seal ${i}`);
        const twin = await seal(plain, miner, now, i + 1);
        assert.equal(twin.ok, true, twin.reason || `twin ${i}`);
      }
      const mature = live.spendableNanos(miner);
      assert.ok(mature >= NANOS_PER_SHE + 100, `mature ${mature}`);
      const open = await seal(plain, miner, t0 + 10 * step, 11);
      assert.equal(open.ok, true, open.reason || 'plain seal');
      const unlocked = plain.spendableNanos(miner);
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
      assert.equal(queued.reason, 'admit_version');
      const heldSeal = await seal(live, miner, t0 + 10 * step, 11);
      assert.equal(heldSeal.ok, true, heldSeal.reason || 'lock seal');
      const held = live.spendableNanos(miner);
      assert.equal(held, unlocked);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});

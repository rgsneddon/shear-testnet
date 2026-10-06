import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { noteCommitSpendableNanos } from '../../crypto/coinbase_notes.js';
import { reconcileSpendable } from '../../crypto/spend.js';
import { sealCoinbaseNote } from '../../crypto/note.js';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { portalIdFromDest } from '../../crypto/reserve_vault.js';
import { reconstructOwner } from '../../pool/src/wallet_api.js';

function dest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function painted(address, nanos) {
  return { to: address, from: '', kind: 'pot', height: 1, nanos };
}

describe('v12 spendable is one opened-note ledger', () => {
  it('a plaintext row cannot raise spendable for any amount or note count', () => {
    const amounts = [1, 2_000_000_000, 100_000_000_000];
    const counts = [1, 3];
    for (const amount of amounts) {
      for (const count of counts) {
        const who = dest();
        const notes = [];
        for (let i = 0; i < count; i += 1) {
          notes.push(sealCoinbaseNote(amount, {
            dest20: hash20FromAddress(who),
            kind: 'pot',
          }));
        }
        const blocks = [{
          height: 1,
          txs: [{ coinbase: true, vout: notes }],
        }];
        const tip = SPENDABLE_CONFIRMATIONS;
        const opened = noteCommitSpendableNanos(blocks, who, tip);
        assert.equal(opened, amount * count, `${amount} x ${count}`);
        const fat = amount * count * 50 + 9;
        const rows = [painted(who, fat)];
        assert.equal(reconcileSpendable(rows, who, tip, opened), opened);
        assert.equal(reconcileSpendable(rows, who, tip, 0), 0);
        const store = {
          blocks,
          tip: () => ({ height: tip }),
          historyFor: () => rows,
          mempool: [],
          reserveVault: { portals: {} },
        };
        const rec = reconstructOwner(store, who);
        assert.equal(rec.spendableNanos, opened);
        assert.notEqual(rec.spendableNanos, fat);
        const locks = [
          { staked: amount, idle: 0 },
          { staked: 0, idle: amount },
          { staked: amount, idle: amount },
        ];
        for (const lock of locks) {
          const principal = lock.staked + lock.idle;
          store.reserveVault.portals = {
            [portalIdFromDest(who)]: { ...lock, payout: who },
            other: { staked: fat, idle: fat, payout: 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' },
          };
          const held = reconstructOwner(store, who);
          const expect = opened > principal ? opened - principal : 0;
          assert.equal(held.spendableNanos, expect, `${amount} x ${count} lock ${principal}`);
          assert.notEqual(held.spendableNanos, fat);
        }
      }
    }
  });

  it('store.spendableNanos ignores a painted explorer row', () => {
    const who = dest();
    const amount = 100_000_000_000;
    const note = sealCoinbaseNote(amount, {
      dest20: hash20FromAddress(who),
      kind: 'pot',
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ledger-'));
    const store = createStore(dir);
    store.blocks.push({
      height: 1,
      hash: Buffer.alloc(32, 1),
      txs: [{ coinbase: true, vout: [note] }],
    });
    for (let h = 2; h <= SPENDABLE_CONFIRMATIONS; h += 1) {
      store.blocks.push({
        height: h,
        hash: Buffer.alloc(32, h),
        txs: [{ coinbase: true, vout: [] }],
      });
    }
    const before = store.spendableNanos(who);
    assert.equal(before, amount);
    store.explorer.push(painted(who, amount * 80));
    assert.equal(store.spendableNanos(who), before);
    const stranger = dest();
    store.explorer.push(painted(stranger, amount * 80));
    assert.equal(store.spendableNanos(stranger), 0);
    store.reserveVault.portals[portalIdFromDest(who)] = {
      staked: 1,
      idle: 0,
      payout: who,
    };
    assert.equal(store.spendableNanos(who), amount - 1);
    store.reserveVault.portals[portalIdFromDest(who)] = {
      staked: 0,
      idle: amount,
      payout: who,
    };
    assert.equal(store.spendableNanos(who), 0);
    store.explorer.push(painted(who, amount * 80));
    assert.equal(store.spendableNanos(who), 0);
  });
});

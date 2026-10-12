/**
 * A refused kind that spends notes without a signature is unsigned on queueTx.
 * The reason holds for any positive debit and any note count inside the
 * input cap, including an amount above 2^53. A signature, a missing note,
 * a zero debit, or claim stays kind. A zero principal with a fee still
 * spends the note. pool-withdraw is custodial_pull before that gate.
 * Over the cap is tx_cap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { newIdentity } from '../../crypto/address.js';
import { MAX_TX_INPUTS } from '../../crypto/note.js';
import { signSpendTx } from '../../crypto/spend.js';
import { isFinalIngestFail } from '../src/p2p.js';
import { spendBox } from '../../tests/spend_box.js';

const AMOUNTS = [1, 2, 1_000_000_000, 50_000_000_000, 9_007_199_254_740_991, 9007199254740993n];
const NOTE_COUNTS = [1, 2, 7, MAX_TX_INPUTS];
const UNSIGNED_KINDS = ['user-spend', 'evm-value', 'vortice-register', 'made-up-kind'];

function refusedTx({ kind, nanos, notes, dest }) {
  const vin = [];
  for (let i = 0; i < notes; i += 1) {
    vin.push({ address: dest, commit: Buffer.alloc(32, (i + 1) & 255) });
  }
  return {
    id: `${kind}-${nanos}-${notes}`,
    kind,
    from: dest,
    to: dest,
    nanos,
    fee: 1,
    vin,
    vout: [{ address: dest, nanos, kind }],
  };
}

describe('unsigned refused spend', () => {
  it('queueTx stays unsigned for any amount and any note count inside the cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-unsigned-refused-'));
    const store = createStore(dir);
    const box = spendBox(newIdentity());
    const dest = box.dest;
    try {
      assert.ok(MAX_TX_INPUTS >= 1);
      assert.equal(isFinalIngestFail('unsigned'), false);
      for (const kind of UNSIGNED_KINDS) {
        for (const nanos of AMOUNTS) {
          for (const notes of NOTE_COUNTS) {
            const tx = refusedTx({ kind, nanos, notes, dest });
            const got = store.queueTx(tx);
            const label = `${kind} ${nanos} notes ${notes}`;
            assert.equal(got.ok, false, label);
            assert.equal(got.reason, 'unsigned', `${label} ${got.reason}`);
          }
        }
      }
      for (const kind of UNSIGNED_KINDS) {
        for (const nanos of AMOUNTS) {
          const tx = refusedTx({ kind, nanos, notes: 1, dest });
          signSpendTx(tx, box.key);
          const got = store.queueTx(tx);
          assert.equal(got.reason, 'kind', `signed ${kind} ${nanos} ${got.reason}`);
        }
      }
      for (const nanos of AMOUNTS) {
        for (const notes of NOTE_COUNTS) {
          const claim = store.queueTx(refusedTx({ kind: 'claim', nanos, notes, dest }));
          assert.equal(claim.reason, 'kind', `claim ${nanos} notes ${notes} ${claim.reason}`);
          const pull = store.queueTx(refusedTx({ kind: 'pool-withdraw', nanos, notes, dest }));
          assert.equal(pull.reason, 'custodial_pull', `pull ${nanos} notes ${notes} ${pull.reason}`);
        }
      }
      for (const kind of UNSIGNED_KINDS) {
        const noNote = {
          id: `${kind}-nonote`,
          kind,
          from: dest,
          to: dest,
          nanos: AMOUNTS[0],
          fee: 1,
          vin: [{ address: dest }],
          vout: [{ address: dest, nanos: AMOUNTS[0], kind }],
        };
        assert.equal(store.queueTx(noNote).reason, 'kind', `no note ${kind}`);
        const zero = refusedTx({ kind, nanos: 0, notes: NOTE_COUNTS.length, dest });
        zero.fee = 0;
        assert.equal(store.queueTx(zero).reason, 'kind', `zero debit ${kind}`);
        const feeOnly = refusedTx({ kind, nanos: 0, notes: 1, dest });
        assert.equal(store.queueTx(feeOnly).reason, 'unsigned', `fee-only ${kind}`);
        const over = refusedTx({ kind, nanos: AMOUNTS[2], notes: MAX_TX_INPUTS + 1, dest });
        assert.equal(store.queueTx(over).reason, 'tx_cap', `over cap ${kind} ${store.queueTx(over).reason}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NANOS_PER_SHE, SPENDABLE_CONFIRMATIONS } from './asert.js';
import { newIdentity, spendDestOf, hash20FromAddress } from './address.js';
import { noteCommitOfDest20 } from './note.js';
import { noteCommitSpendableNanos } from './coinbase_notes.js';

describe('noteCommitSpendableNanos', () => {
  it('recovers mature compact coinbase when explorer to is empty', () => {
    const alice = newIdentity();
    const dest = spendDestOf(alice.spendPub);
    const want = noteCommitOfDest20(hash20FromAddress(dest));
    const blocks = [{
      height: 2,
      txs: [{
        coinbase: true,
        vout: [{ kind: 'pot', noteCommit: want, nanos: 2 * NANOS_PER_SHE }],
      }],
    }];
    const immature = noteCommitSpendableNanos(blocks, dest, 2);
    assert.equal(immature, 0);
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS - 1;
    const got = noteCommitSpendableNanos(blocks, dest, matureTip);
    assert.equal(got, 2 * NANOS_PER_SHE);
    const other = spendDestOf(newIdentity().spendPub);
    assert.equal(noteCommitSpendableNanos(blocks, other, matureTip), 0);
  });

  it('does not credit a noteCommit after a later vin spends it', () => {
    const alice = newIdentity();
    const dest = spendDestOf(alice.spendPub);
    const want = noteCommitOfDest20(hash20FromAddress(dest));
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS - 1;
    const blocks = [
      {
        height: 2,
        txs: [{
          coinbase: true,
          vout: [{ kind: 'pot', noteCommit: want, nanos: 2 * NANOS_PER_SHE }],
        }],
      },
      {
        height: 8,
        txs: [{
          kind: 'send',
          vin: [{ noteCommit: want, index: 0 }],
          vout: [{ kind: 'send', nanos: 1 }],
        }],
      },
    ];
    assert.equal(noteCommitSpendableNanos(blocks, dest, matureTip), 0);
  });
});

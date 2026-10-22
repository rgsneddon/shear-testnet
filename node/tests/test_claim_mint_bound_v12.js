/**
 * A claim mint is the proof's public reward. A body that names a larger
 * amount does not pass applyRewardClaim, and supply does not count it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RESERVE_PROGRAM } from '../../crypto/asert.js';
import { applyRewardClaim, emptyVault, stakeRewardSupply } from '../../crypto/reserve_vault.js';

describe('claim mint bound', () => {
  it('a claim whose nanos is not the proof reward pays nothing', () => {
    const state = emptyVault();
    const before = state.mintBankNanos;
    const tx = {
      kind: 'reward-claim',
      programId: RESERVE_PROGRAM,
      nanos: 1_000_000_000_000,
      nullifier: 'ab'.repeat(32),
      vaultProof: Buffer.alloc(48, 7),
      earnEpoch: 1,
    };
    const paid = applyRewardClaim(state, tx, 2);
    assert.equal(paid.ok, false, paid.reason);
    assert.equal(paid.nanos, 0);
    assert.equal(state.mintBankNanos, before);
    const supply = stakeRewardSupply(state, {
      height: 2,
      txs: [{ coinbase: true, vout: [] }, tx],
    }, 1_700_000_000_000, 2);
    assert.equal(supply.ok, false, supply.reason);
    assert.equal(supply.claimed, 0n);
    assert.equal(supply.minted, 0n);
  });
});

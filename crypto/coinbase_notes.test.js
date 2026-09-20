import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NANOS_PER_SHE, SPENDABLE_CONFIRMATIONS, POOL_FEE_BPS } from './asert.js';
import { newIdentity, spendDestOf, hash20FromAddress } from './address.js';
import { noteCommitOfDest20, sealCoinbaseNote } from './note.js';
import { expectedCoinbasePays, noteCommitSpendableNanos } from './coinbase_notes.js';
import { custodyPotShares } from '../node/src/chain.js';

function shareOf(dest, nonce) {
  return { dest, dest20: hash20FromAddress(dest), nonce: BigInt(nonce), lz: 8 };
}

function sealedCustodyBlock({ poolDest, hashers, height = 2 }) {
  const shares = custodyPotShares(poolDest);
  const vout = shares.map((s) => sealCoinbaseNote(s.nanos, {
    dest20: hash20FromAddress(s.address),
    kind: s.kind || 'pot',
  }));
  return {
    height,
    miner: poolDest,
    poolDest,
    shareBatch: hashers.map((d, i) => shareOf(d, i + 1)),
    txs: [{ coinbase: true, vout }],
  };
}

describe('expectedCoinbasePays potNanos', () => {
  it('splits the supplied epoch pot, not the 1 SHE fingerprint', () => {
    const hasher = spendDestOf(newIdentity().spendPub);
    const pool = spendDestOf(newIdentity().spendPub);
    const share = { dest: hasher, dest20: hash20FromAddress(hasher), nonce: 1n, lz: 8 };
    const pot = 99_000_000_000;
    const pays = expectedCoinbasePays([share], { miner: hasher, poolDest: pool, potNanos: pot });
    const potPays = pays.filter((p) => p.kind === 'pot');
    const sum = potPays.reduce((a, p) => a + p.nanos, 0);
    assert.equal(sum, pot);
    const fee = Math.floor(pot * POOL_FEE_BPS / 10000);
    assert.equal(potPays.find((p) => p.address === pool)?.nanos, fee);
    const rest = potPays.find((p) => p.address === hasher);
    assert.equal(rest?.nanos, pot - fee);
  });
});

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

  it('recovers custody pot after fee when miner is another dest and nanos are hidden', () => {
    const pool = spendDestOf(newIdentity().spendPub);
    const hasher = spendDestOf(newIdentity().spendPub);
    const want = noteCommitOfDest20(hash20FromAddress(pool));
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS - 1;
    const blocks = [{
      height: 2,
      miner: hasher,
      aLeaves: [{ noteCommit: Buffer.alloc(32, 9), count: 256 }],
      txs: [{
        coinbase: true,
        vout: [
          { kind: 'pot', noteCommit: want, nanos: 0 },
          { kind: 'hash', noteCommit: want, nanos: 0 },
        ],
      }],
    }];
    const got = noteCommitSpendableNanos(blocks, pool, matureTip);
    const pot = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * 0.01);
    assert.equal(got, pot + 256);
    assert.equal(noteCommitSpendableNanos(blocks, hasher, matureTip), 0);
  });

  it('credits sealed custodyPotShares rest to poolDest, not the 1% fee, when hasher dests differ', () => {
    const poolDest = spendDestOf(newIdentity().spendPub);
    const hasherA = spendDestOf(newIdentity().spendPub);
    const hasherB = spendDestOf(newIdentity().spendPub);
    assert.notEqual(hasherA, poolDest);
    assert.notEqual(hasherB, poolDest);
    const rest = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const fee = Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const block = sealedCustodyBlock({ poolDest, hashers: [hasherA, hasherB], height: 2 });
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS - 1;
    const got = noteCommitSpendableNanos([block], poolDest, matureTip);
    assert.equal(got, rest);
    assert.notEqual(got, fee);
    assert.equal(noteCommitSpendableNanos([block], hasherA, matureTip), 0);
    assert.equal(noteCommitSpendableNanos([block], hasherB, matureTip), 0);
  });
});

describe('expectedCoinbasePays custodialPot', () => {
  it('attributes pot-after-fee to poolDest instead of hasher leaves', () => {
    const hasher = spendDestOf(newIdentity().spendPub);
    const pool = spendDestOf(newIdentity().spendPub);
    const share = { dest: hasher, dest20: hash20FromAddress(hasher), nonce: 1n, lz: 8 };
    const split = expectedCoinbasePays([share], { miner: hasher, poolDest: pool });
    const fee = Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const rest = NANOS_PER_SHE - fee;
    assert.equal(split.find((p) => p.kind === 'pot' && p.address === pool)?.nanos, fee);
    assert.equal(split.find((p) => p.kind === 'pot' && p.address === hasher)?.nanos, rest);
    const custody = expectedCoinbasePays([share], {
      miner: hasher,
      poolDest: pool,
      custodialPot: true,
      feeDest: spendDestOf(newIdentity().spendPub),
    });
    assert.equal(custody.find((p) => p.kind === 'pot' && p.address === pool)?.nanos, rest);
    assert.equal(custody.find((p) => p.kind === 'pot' && p.address === hasher), undefined);
  });
});

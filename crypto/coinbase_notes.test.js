import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NANOS_PER_SHE, SPENDABLE_CONFIRMATIONS, POOL_FEE_BPS, HASH_BONUS_NANOS, BLOCK_SUBSIDY_NANOS } from './asert.js';
import { newIdentity, spendDestOf, hash20FromAddress } from './address.js';
import { noteCommitOfDest20, sealCoinbaseNote } from './note.js';
import { expectedCoinbasePays, noteCommitSpendableNanos, paysFromALeaves } from './coinbase_notes.js';
import { sealedExplorerRows } from './chronoflux.js';
import { aLeavesFromShares } from './share_batch.js';
import { custodyPotShares } from '../node/src/chain.js';
import { handleWalletApi, reconstructOwner } from '../pool/src/wallet_api.js';
import { poolFeeDest } from './levy.js';

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

  it('sealed match-miss is fail-closed — eight pot-after-fee quanta stay 0, not 7.92 SHE', () => {
    const pool = spendDestOf(newIdentity().spendPub);
    const hasher = spendDestOf(newIdentity().spendPub);
    const poolNc = noteCommitOfDest20(hash20FromAddress(pool));
    const hasherNc = noteCommitOfDest20(hash20FromAddress(hasher));
    const rest = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const blocks = Array.from({ length: 8 }, (_, i) => ({
      height: i + 1,
      miner: hasher,
      poolDest: pool,
      aLeaves: [{ noteCommit: Buffer.alloc(32, 9), count: 256 }],
      txs: [{
        coinbase: true,
        vout: [
          { kind: 'pot', noteCommit: poolNc, nanos: 0, commit: Buffer.alloc(32, 1) },
          { kind: 'hash', noteCommit: hasherNc, nanos: 0, commit: Buffer.alloc(32, 2) },
        ],
      }],
    }));
    const matureTip = 8 + SPENDABLE_CONFIRMATIONS;
    assert.equal(noteCommitSpendableNanos(blocks, pool, matureTip), 0);
    assert.equal(noteCommitSpendableNanos(blocks, hasher, matureTip), 0);
    assert.equal(rest * 8, 792_000_000_000);
    assert.notEqual(noteCommitSpendableNanos(blocks, hasher, matureTip), rest * 8);
  });

  it('custody credits sealed hash pays to the hasher and pot-after-fee to the pool', () => {
    const poolDest = spendDestOf(newIdentity().spendPub);
    const hasher = spendDestOf(newIdentity().spendPub);
    const rest = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const hashNanos = 256;
    const potVout = sealCoinbaseNote(rest, {
      dest20: hash20FromAddress(poolDest),
      kind: 'pot',
    });
    const hashVout = sealCoinbaseNote(hashNanos, {
      dest20: hash20FromAddress(hasher),
      kind: 'hash',
    });
    const block = {
      height: 2,
      miner: poolDest,
      poolDest,
      shareBatch: [shareOf(hasher, 1)],
      aLeaves: [{ noteCommit: noteCommitOfDest20(hash20FromAddress(hasher)), count: hashNanos }],
      txs: [{ coinbase: true, vout: [potVout, hashVout] }],
    };
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS - 1;
    assert.equal(noteCommitSpendableNanos([block], hasher, matureTip), hashNanos);
    assert.equal(noteCommitSpendableNanos([block], poolDest, matureTip), rest);
    const leafPot = paysFromALeaves(block.aLeaves).filter((p) => p.kind === 'pot');
    assert.ok(leafPot.some((p) => p.nanos === rest));
    const custodyLeaves = paysFromALeaves(block.aLeaves, { custodialPot: true });
    assert.equal(custodyLeaves.some((p) => p.kind === 'pot'), false);
    assert.ok(custodyLeaves.some((p) => p.kind === 'hash' && p.nanos === hashNanos));
    assert.equal(noteCommitSpendableNanos([block], hasher, matureTip), hashNanos);
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

function custodyHasherBlock() {
  const pool = spendDestOf(newIdentity().spendPub);
  const hasher = spendDestOf(newIdentity().spendPub);
  const share = shareOf(hasher, 1);
  const leaves = aLeavesFromShares([share]);
  const hashNanos = leaves.reduce((a, l) => a + l.count, 0) * HASH_BONUS_NANOS;
  const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
  const rest = BLOCK_SUBSIDY_NANOS - fee;
  const potVout = custodyPotShares(pool).map((s) => sealCoinbaseNote(s.nanos, {
    dest20: hash20FromAddress(s.address),
    kind: s.kind || 'pot',
  }));
  const block = {
    height: 2,
    hash: Buffer.alloc(32, 11),
    miner: pool,
    poolDest: pool,
    shareBatch: [share],
    aLeaves: leaves,
    txs: [{
      coinbase: true,
      vout: [
        ...potVout,
        sealCoinbaseNote(hashNanos, { dest20: hash20FromAddress(hasher), kind: 'hash' }),
      ],
    }],
  };
  return { pool, hasher, hashNanos, rest, block };
}

describe('custody reconstruct does not invent pot onto the hasher', () => {
  it('note spendable, explorer rows, and reconstructOwner keep hash on the hasher and pot on the pool', () => {
    const { pool, hasher, hashNanos, rest, block } = custodyHasherBlock();
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS - 1;
    assert.equal(noteCommitSpendableNanos([block], hasher, matureTip), hashNanos);
    assert.equal(noteCommitSpendableNanos([block], pool, matureTip), rest);
    assert.ok(hashNanos > 0);
    assert.ok(hashNanos < rest);

    const rows = sealedExplorerRows(block);
    const hasherRows = rows.filter((r) => r.to === hasher);
    const poolRows = rows.filter((r) => r.to === pool);
    assert.equal(hasherRows.reduce((a, r) => a + r.nanos, 0), hashNanos);
    assert.equal(hasherRows.some((r) => r.nanos === rest), false);
    assert.equal(poolRows.reduce((a, r) => a + r.nanos, 0), rest);

    const store = {
      blocks: [block],
      mempool: [],
      tip: () => ({ height: matureTip }),
      owedPi: 50 * NANOS_PER_SHE,
      confirmingPot: 40 * NANOS_PER_SHE,
      pending: 30 * NANOS_PER_SHE,
    };
    assert.equal(reconstructOwner(store, hasher).spendableNanos, hashNanos);
    assert.equal(reconstructOwner(store, pool).spendableNanos, rest);

    const pullBook = {
      viewByDest: () => ({ pendingNanos: 25 * NANOS_PER_SHE }),
    };
    const miners = new Map([
      ['w.1', { login: hasher, roundActualHashes: 1000, hashes: 1000 }],
    ]);
    const bal = handleWalletApi(
      new URL(`http://127.0.0.1/api/wallet/balance?address=${hasher}`),
      'GET',
      {},
      { store, miners, pullBook },
    );
    assert.equal(bal.status, 200);
    assert.equal(bal.json.balance, hashNanos / NANOS_PER_SHE);
    assert.equal(bal.json.reconstructed, hashNanos / NANOS_PER_SHE);
    assert.equal(bal.json.owedPi, 25);
    assert.equal(bal.json.confirmingPot, 25);
    assert.ok(bal.json.balance < bal.json.owedPi);
  });

  it('solo non-custody still props the pot onto the miner leaf', () => {
    const hasher = spendDestOf(newIdentity().spendPub);
    const share = shareOf(hasher, 3);
    const leaves = aLeavesFromShares([share]);
    const hashNanos = leaves.reduce((a, l) => a + l.count, 0) * HASH_BONUS_NANOS;
    const d20 = hash20FromAddress(hasher);
    const block = {
      height: 2,
      hash: Buffer.alloc(32, 12),
      miner: hasher,
      shareBatch: [share],
      aLeaves: leaves,
      txs: [{
        coinbase: true,
        vout: [
          sealCoinbaseNote(hashNanos, { dest20: d20, kind: 'hash' }),
          sealCoinbaseNote(BLOCK_SUBSIDY_NANOS, { dest20: d20, kind: 'pot' }),
        ],
      }],
    };
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS - 1;
    assert.equal(noteCommitSpendableNanos([block], hasher, matureTip), hashNanos + BLOCK_SUBSIDY_NANOS);
    const rows = sealedExplorerRows(block);
    assert.equal(rows.reduce((a, r) => a + r.nanos, 0), hashNanos + BLOCK_SUBSIDY_NANOS);
    const store = { blocks: [block], mempool: [], tip: () => ({ height: matureTip }) };
    assert.equal(reconstructOwner(store, hasher).spendableNanos, hashNanos + BLOCK_SUBSIDY_NANOS);
  });

  it('does not spend an unverified pool-withdraw valueProof stamp', () => {
    const pool = spendDestOf(newIdentity().spendPub);
    const hasher = spendDestOf(newIdentity().spendPub);
    const hasher20 = hash20FromAddress(hasher);
    const pay = 396000000000;
    const hashNanos = 256;
    const block = {
      height: 2,
      hash: Buffer.alloc(32, 21),
      miner: hasher,
      poolDest: pool,
      txs: [
        {
          coinbase: true,
          vout: [sealCoinbaseNote(hashNanos, { dest20: hasher20, kind: 'hash' })],
        },
        {
          kind: 'pool-withdraw',
          vout: [{
            kind: 'pool-withdraw',
            dest20: hasher20,
            valueProof: { v: pay },
          }],
        },
      ],
    };
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS - 1;
    const store = { blocks: [block], mempool: [], tip: () => ({ height: matureTip }) };
    assert.equal(reconstructOwner(store, hasher).spendableNanos, hashNanos);
    const painted = [{
      to: hasher,
      kind: 'pool-withdraw',
      nanos: pay,
      height: 2,
    }];
    const again = {
      blocks: [block],
      mempool: [],
      tip: () => ({ height: matureTip }),
      historyFor: () => painted,
    };
    assert.equal(reconstructOwner(again, hasher).spendableNanos, hashNanos);
    assert.equal(reconstructOwner(store, pool).spendableNanos, 0);
  });

  it('missing poolDest keeps pot on the sealed pool dest20 and hash on the hasher', () => {
    const pool = spendDestOf(newIdentity().spendPub);
    const hasher = spendDestOf(newIdentity().spendPub);
    const share = shareOf(hasher, 4);
    const leaves = aLeavesFromShares([share]);
    const hashNanos = leaves.reduce((a, l) => a + l.count, 0) * HASH_BONUS_NANOS;
    const fee = Math.floor(BLOCK_SUBSIDY_NANOS * POOL_FEE_BPS / 10000);
    const rest = BLOCK_SUBSIDY_NANOS - fee;
    const pool20 = hash20FromAddress(pool);
    const hasher20 = hash20FromAddress(hasher);
    const block = {
      height: 2,
      hash: Buffer.alloc(32, 13),
      miner: hasher,
      shareBatch: [share],
      aLeaves: leaves,
      txs: [{
        coinbase: true,
        vout: [
          sealCoinbaseNote(rest, { dest20: pool20, kind: 'pot' }),
          sealCoinbaseNote(fee, { dest20: hash20FromAddress(poolFeeDest()), kind: 'pool-fee' }),
          sealCoinbaseNote(hashNanos, { dest20: hasher20, kind: 'hash' }),
        ],
      }],
    };
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS - 1;
    assert.equal(noteCommitSpendableNanos([block], hasher, matureTip), hashNanos);
    assert.equal(noteCommitSpendableNanos([block], pool, matureTip), rest);
    const rows = sealedExplorerRows(block);
    const onHasher = rows.filter((r) => r.to === hasher);
    const onPool = rows.filter((r) => r.to === pool);
    assert.equal(onHasher.reduce((a, r) => a + Number(r.nanos || 0), 0), hashNanos);
    assert.equal(onHasher.some((r) => r.nanos === rest), false);
    assert.equal(onPool.reduce((a, r) => a + Number(r.nanos || 0), 0), rest);
    const store = { blocks: [block], mempool: [], tip: () => ({ height: matureTip }) };
    assert.equal(reconstructOwner(store, hasher).spendableNanos, hashNanos);
    assert.equal(reconstructOwner(store, pool).spendableNanos, rest);
    const hidden = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      height: r.height,
      amountHidden: true,
      noteCommit: r.noteCommit,
      toDest20: r.toDest20,
    }));
    const historyFor = (addr) => {
      const h20 = hash20FromAddress(addr);
      const want = h20 ? noteCommitOfDest20(h20) : null;
      return hidden.filter((r) => {
        if (h20 && r.toDest20 && Buffer.from(r.toDest20).equals(Buffer.from(h20))) return true;
        if (want && r.noteCommit && Buffer.from(r.noteCommit).equals(want)) return true;
        return false;
      }).map((r) => ({ ...r, to: addr }));
    };
    const liveStore = {
      blocks: [block],
      mempool: [],
      tip: () => ({ height: matureTip }),
      historyFor,
    };
    assert.equal(reconstructOwner(liveStore, hasher).spendableNanos, hashNanos);
    assert.equal(reconstructOwner(liveStore, pool).spendableNanos, rest);
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

  it('solo seal still props the pot onto the miner', () => {
    const hasher = spendDestOf(newIdentity().spendPub);
    const potVout = sealCoinbaseNote(NANOS_PER_SHE, {
      dest20: hash20FromAddress(hasher),
      kind: 'pot',
    });
    const block = {
      height: 2,
      miner: hasher,
      shareBatch: [shareOf(hasher, 1)],
      txs: [{ coinbase: true, vout: [potVout] }],
    };
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS - 1;
    assert.equal(noteCommitSpendableNanos([block], hasher, matureTip), NANOS_PER_SHE);
  });
});

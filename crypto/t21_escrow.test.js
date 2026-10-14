/**
 * Payee-cap escrow, the per-producer quota, TTL back to the pot, the hash
 * cap, and the governed 1 rho per hash unit. No proofs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HASH_BONUS_NANOS, NANOS_PER_SHE } from './asert.js';
import { unitsForShare } from './share_batch.js';
import { T21_OWED_MAX, T21_OWED_TTL, W_HASH_MAX } from './t21_params.js';
import { composeOwed, escrowBooks, priceWeights, quotaExceeded, weightPay } from './t21_escrow.js';

const row = (id, pot, hash, since, by = 'aa') => ({ id, pot, hash, since, by });

describe('payee-cap escrow pricing and supply', () => {
  it('prices every weight on one denominator and loses nothing', () => {
    const R = 5n;
    const u = 1n;
    const got = priceWeights(R, u, [3n, 3n]);
    assert.ok(got);
    assert.equal(got.W, 6n);
    const paid = got.rows.reduce((a, r) => a + r.v, 0n);
    assert.equal(paid + got.dust, R + u * got.W);
    assert.equal(got.rows[0].hash, u * 3n);
    assert.equal(got.rows[0].pot + got.rows[0].hash, got.rows[0].v);
    // Resplitting R − dust over the paid weight alone is a different pot.
    const onlyPaid = weightPay(R - got.rows[1].pot, 3n, 3n, u);
    assert.notEqual(onlyPaid.pot, got.rows[0].pot);
  });

  it('the per-unit rate is 1 rho at every width, and the total scales with the work', () => {
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.equal(unitsForShare(10), 2 ** 10);
    assert.equal(unitsForShare(20), 2 ** 20);
    assert.equal(unitsForShare(10), unitsForShare(10));
    const narrow = weightPay(0n, 2n ** 10n, 2n ** 10n, 1n);
    const wide = weightPay(0n, 2n ** 20n, 2n ** 20n, 1n);
    assert.equal(narrow.hash, 2n ** 10n);
    assert.equal(wide.hash, 2n ** 20n);
    assert.equal(wide.hash / narrow.hash, 2n ** 10n);
    const capShe = Number(W_HASH_MAX) / NANOS_PER_SHE;
    assert.ok(Math.abs(capShe - 2814.74976710656) < 1e-6);
    assert.ok(capShe < 2815);
  });

  it('refuses a weight that reaches 2^48', () => {
    assert.equal(priceWeights(1n, 1n, [W_HASH_MAX]), null);
    assert.equal(priceWeights(1n, 1n, [W_HASH_MAX - 1n, 1n]), null);
    assert.ok(priceWeights(1n, 1n, [W_HASH_MAX - 1n]));
  });

  it('quota is per producer: 1024 stays, 1025 rejects, two producers may both hold 1024', () => {
    const one = (n, by) => Array.from({ length: n }, (_, i) => ({ by, i }));
    assert.equal(quotaExceeded(one(T21_OWED_MAX, 'pool'), (r) => r.by), false);
    assert.equal(quotaExceeded(one(T21_OWED_MAX + 1, 'pool'), (r) => r.by), true);
    const both = one(T21_OWED_MAX, 'a').concat(one(T21_OWED_MAX, 'b'));
    assert.equal(quotaExceeded(both, (r) => r.by), false);
    assert.equal(both.length, T21_OWED_MAX * 2);
  });

  it('TTL at 960 stays, 961 returns pot and hash to the pot, and names no producer', () => {
    const owedIn = [row('e1', 3n, 4n, 10)];
    const stay = composeOwed({ owedIn, height: 10 + T21_OWED_TTL });
    assert.equal(stay.back, 0n);
    assert.equal(stay.owed.length, 1);
    const drop = composeOwed({ owedIn, height: 10 + T21_OWED_TTL + 1 });
    assert.equal(drop.owed.length, 0);
    assert.equal(drop.backPot, 3n);
    assert.equal(drop.backHash, 4n);
    assert.equal(drop.back, 7n);
    assert.equal(Object.hasOwn(drop, 'producer'), false);
    const ancient = composeOwed({ owedIn, height: 10_000 });
    assert.equal(ancient.back, 7n);
    assert.equal(ancient.owed.length, 0);
  });

  it('books escrow in, out, and back to the pot, and a reorg replays the prefix', () => {
    const prev = {
      mintedPot: 0n, mintedHash: 0n, escrow: 0n, escrowHash: 0n,
      acceptedHash: 0n, permittedHashAll: 0n,
    };
    const sealed = escrowBooks(prev, {
      potMinted: 100n, escrowPot: 30n, escrowHash: 40n, hashPaid: 10n, hashAll: 50n, dust: 5n,
    });
    assert.equal(sealed.mintedPot, 70n);
    assert.equal(sealed.mintedHash, 10n);
    assert.equal(sealed.escrow, 70n);
    assert.equal(sealed.escrowHash, 40n);
    assert.equal(sealed.acceptedHash, 50n);
    assert.equal(sealed.carry, 5n);
    assert.equal(sealed.mintedPot + sealed.mintedHash + sealed.escrow + sealed.carry, 100n + 50n + 5n);
    const settled = escrowBooks(sealed, {
      potMinted: 0n, settlePot: 30n, settleHash: 40n, hashPaid: 0n, hashAll: 0n, dust: 0n,
    });
    assert.equal(settled.escrow, 0n);
    assert.equal(settled.escrowHash, 0n);
    assert.equal(settled.mintedPot, 100n);
    assert.equal(settled.mintedHash, 50n);
    assert.equal(settled.acceptedHash, 50n);
    const expired = escrowBooks(sealed, {
      potMinted: 0n, backPot: 30n, backHash: 40n, hashPaid: 0n, hashAll: 0n, dust: 0n,
    });
    assert.equal(expired.escrow, 0n);
    assert.equal(expired.mintedPot, 70n);
    assert.equal(expired.mintedHash, 10n);
    assert.equal(expired.carry, 70n);
    assert.equal(expired.acceptedHash, 10n);
    assert.equal(expired.mintedHash + expired.escrowHash, expired.acceptedHash);
    const replay = escrowBooks(prev, {
      potMinted: 100n, escrowPot: 30n, escrowHash: 40n, hashPaid: 10n, hashAll: 50n, dust: 5n,
    });
    assert.equal(replay.escrow, sealed.escrow);
    assert.equal(replay.mintedHash, sealed.mintedHash);
    assert.equal(replay.acceptedHash, sealed.acceptedHash);
  });
});

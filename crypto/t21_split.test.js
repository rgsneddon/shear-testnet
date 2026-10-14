import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  proveT21Split,
  t21CoinbaseGate,
  verifyT21Split,
} from './t21_split.js';
import {
  coinbaseVoutsBound,
  excessOf,
  sealCoinbaseNote,
} from './note.js';

const MINT = 10n;
const WORK = 5n;
const ROWS = [
  { v: 4n, w: 2n },
  { v: 6n, w: 3n },
];

function honest() {
  return proveT21Split({ mint: MINT, totalWork: WORK, rows: ROWS });
}

function payoutNotes(proof) {
  return proof.rows.map((row, i) => ({
    kind: i === 0 ? 'pot' : 'pool-fee',
    commit: row.commit,
    noteCommit: Buffer.alloc(32, i + 1),
  }));
}

describe('T21 floor split', () => {
  it('accepts an exact split and does not publish a per-dest amount', () => {
    const proof = honest();
    const got = verifyT21Split(proof, { mint: MINT });
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.paid, MINT);
    assert.equal(got.mint, MINT);
    for (const row of proof.rows) {
      assert.equal(row.v, undefined);
      assert.equal(row.w, undefined);
      assert.equal(row.rem, undefined);
      assert.equal(row.valueProof, undefined);
    }
    assert.equal(Object.hasOwn(proof, 'valueProof'), false);
  });

  it('rejects a remainder commitment that is not the floor remainder', () => {
    const proof = honest();
    const forged = {
      ...proof,
      rows: proof.rows.map((row, i) => (i === 0
        ? { ...row, remCommit: row.slackCommit }
        : row)),
    };
    const got = verifyT21Split(forged);
    assert.equal(got.ok, false);
    assert.ok(got.reason === 'bits' || got.reason === 'slack' || got.reason === 'link');
  });

  it('rejects a public mint that is not the statement', () => {
    const proof = honest();
    const got = verifyT21Split({ ...proof, mint: '11' });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'link');
  });

  it('rejects a floor that does not match the hidden work', () => {
    assert.throws(
      () => proveT21Split({ mint: 9n, totalWork: 5n, rows: [{ v: 4n, w: 2n }, { v: 5n, w: 3n }] }),
      /t21-floor/,
    );
  });

  it('gates a coinbase only when t21Split is present', () => {
    const proof = honest();
    const vouts = payoutNotes(proof);
    const tx = { t21Split: proof, excess: proof.excess, vout: vouts };
    const ok = t21CoinbaseGate(tx, MINT, vouts, 0);
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.paid, MINT);
    const bound = coinbaseVoutsBound(vouts, proof.excess, null, ok.paid);
    assert.equal(bound.ok, true, bound.reason);
    assert.equal(bound.opened, 10);
    const sched = t21CoinbaseGate(tx, 9n, vouts, 0);
    assert.equal(sched.ok, false);
    assert.equal(sched.reason, 'pot_sched');
    const dusty = proveT21Split({
      mint: 9n,
      totalWork: 5n,
      rows: [{ v: 3n, w: 2n }, { v: 5n, w: 3n }],
    });
    const dustVouts = payoutNotes(dusty);
    const dust = t21CoinbaseGate(
      { t21Split: dusty, excess: dusty.excess },
      9n,
      dustVouts,
      0,
    );
    assert.equal(dust.ok, false);
    assert.equal(dust.reason, 'pot_sched');
    const leaked = t21CoinbaseGate(tx, MINT, vouts.map((o, i) => (
      i === 0 ? { ...o, valueProof: { v: 4 } } : o
    )), 0);
    assert.equal(leaked.ok, false);
    assert.equal(leaked.reason, 't21_split');
    const absent = t21CoinbaseGate({ excess: proof.excess }, MINT, vouts, 0);
    assert.equal(absent.ok, true);
    assert.equal(absent.absent, true);
  });

  it('rejects an empty range proof on a payout note that a hint would otherwise open', () => {
    for (const kind of ['pot', 'hash', 'finder-fee', 'reserve-fee', 'pool-fee']) {
      const note = sealCoinbaseNote(4, { kind });
      const stripped = { ...note, rangeProof: Buffer.alloc(0) };
      const got = coinbaseVoutsBound([stripped], excessOf([note]), () => 4);
      assert.equal(got.ok, false, kind);
      assert.equal(got.reason, 'range_proof', kind);
    }
    const kept = sealCoinbaseNote(4, { kind: 'pot' });
    const open = coinbaseVoutsBound([kept], excessOf([kept]), () => 4);
    assert.equal(open.ok, true, open.reason);
  });
});

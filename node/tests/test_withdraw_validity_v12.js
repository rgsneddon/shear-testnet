/**
 * PSA-fd28-1. One withdraw rule on mempool admission, template selection and
 * block verify. The block reads the public action amount (tx.nanos, then the
 * receipt label, then valueProof.v); the note must open to it and it must be
 * principal plus interest. The mempool used to read valueProof.v alone, so an
 * owner-signed withdraw whose amount field disagreed with its note reached the
 * template and cost the found block (mint_amount at append).
 *
 * A withdraw cannot reach admitMempool's vault gate without an admit proof,
 * so this spread runs the gate's two calls directly. test_vault_parity_v12
 * drives a proved mismatch through queueTx, admitMempool, the template and append.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_PROGRAM, TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { epochMs } from '../../crypto/pot_sched.js';
import { sealNote } from '../../crypto/note.js';
import { newIdentity, freshStealthDest, ed25519SeedOf, hash20FromAddress } from '../../crypto/address.js';
import { boundReserveWithdraw, signSpendTx } from '../../crypto/spend.js';
import {
  emptyVault,
  deposit,
  previewWithdraw,
  portalIdFromDest,
  verifyReservePayout,
  verifyReserveWithdraw,
} from '../../crypto/reserve_vault.js';
import { levyNeed } from '../../crypto/levy.js';

const T0 = 1_700_000_000_000;
// A portal opens the epoch at PI_SHE_NANOS.
const LOCKS = [PI_SHE_NANOS, PI_SHE_NANOS + 1_000_000];
const MAX_SAFE = 9007199254740991;

function stealthBox() {
  const id = newIdentity();
  const pay = freshStealthDest(id);
  return {
    id,
    dest: pay.dest,
    key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared },
  };
}

/** A vault whose epoch has closed, holding one owner portal. */
function closedVault(owner, lock) {
  const state = emptyVault();
  const pid = portalIdFromDest(owner.dest);
  const joined = deposit({
    state,
    dest: owner.dest,
    nanos: lock,
    nowMs: T0,
    payout: owner.dest,
    payoutPortalId: pid,
    ownerPub: owner.id.spendPub.toString('hex'),
  });
  assert.equal(joined.ok, true, joined.reason);
  const clock = state.epochStartMs + epochMs(MAGIC_TESTNET) + TARGET_BLOCK_INTERVAL_MS;
  const cap = previewWithdraw(state, owner.dest).payout;
  assert.ok(cap > lock, 'interest is part of the cap');
  return { state, clock, cap, pid };
}

/**
 * An owner-signed withdraw whose note opens to `noteNanos`.
 * `amount` sets tx.nanos; ABSENT leaves it off. `label` sets the receipt nanos.
 */
const ABSENT = Symbol('absent');
function signedWithdraw(owner, pid, noteNanos, { amount = ABSENT, label = ABSENT, id = 'w' } = {}) {
  const note = sealNote(noteNanos, { dest20: hash20FromAddress(owner.dest), kind: 'withdraw' });
  const receipt = { ...note, kind: 'withdraw', address: owner.dest };
  delete receipt.nanos;
  if (label !== ABSENT) receipt.nanos = label;
  const tx = {
    id,
    kind: 'withdraw',
    programId: RESERVE_PROGRAM,
    mint: true,
    portalId: pid,
    payoutPortalId: pid,
    from: owner.dest,
    to: owner.dest,
    fee: 0,
    vin: [],
    vout: [receipt],
  };
  if (amount !== ABSENT) tx.nanos = amount;
  tx.fee = levyNeed(tx);
  signSpendTx(tx, owner.key);
  return tx;
}

function blockRule(state, tx, clock) {
  const bound = boundReserveWithdraw(tx, state, new Set());
  if (!bound.ok) return bound.reason;
  const pay = verifyReservePayout(state, tx, clock);
  return pay.ok ? 'ok' : pay.reason;
}

/** admitMempool's withdraw gate, in its order. Queue and template both run it. */
function mempoolRule(state, tx, clock) {
  const bound = boundReserveWithdraw(tx, state, new Set());
  if (!bound.ok) return bound.reason;
  const rule = verifyReserveWithdraw(state, tx, clock);
  return rule.ok ? 'ok' : rule.reason;
}

function spread(cap) {
  const big = BigInt(MAX_SAFE) + 2n;
  return [
    { name: 'amount=cap', note: cap, amount: cap, want: 'ok' },
    { name: 'amount=cap-1', note: cap, amount: cap - 1, want: 'mint_amount' },
    { name: 'amount=cap+1', note: cap, amount: cap + 1, want: 'mint_amount' },
    { name: 'amount absent, label absent', note: cap, want: 'ok' },
    { name: 'amount absent, label=cap', note: cap, label: cap, want: 'ok' },
    { name: 'amount absent, label=cap+1', note: cap, label: cap + 1, want: 'mint_amount' },
    { name: 'amount absent, label=cap-1', note: cap, label: cap - 1, want: 'mint_amount' },
    { name: 'amount="cap"', note: cap, amount: String(cap), want: 'ok' },
    { name: 'amount=" cap "', note: cap, amount: ` ${cap} `, want: 'ok' },
    { name: 'amount="cap+1"', note: cap, amount: String(cap + 1), want: 'mint_amount' },
    { name: 'amount="cap.0"', note: cap, amount: `${cap}.0`, want: 'mint_amount' },
    { name: 'amount="-cap"', note: cap, amount: `-${cap}`, want: 'mint_amount' },
    { name: 'amount=cap n', note: cap, amount: BigInt(cap), want: 'ok' },
    { name: 'amount=cap+1 n', note: cap, amount: BigInt(cap) + 1n, want: 'mint_amount' },
    { name: 'amount=2^53+1 n', note: cap, amount: big, want: 'mint_amount' },
    { name: 'amount="2^53+1"', note: cap, amount: big.toString(), want: 'mint_amount' },
    { name: 'amount=2^53+2 number', note: cap, amount: MAX_SAFE + 3, want: 'mint_amount' },
    { name: 'amount=cap, label=cap+1', note: cap, amount: cap, label: cap + 1, want: 'ok' },
    { name: 'amount=cap+1, label=cap', note: cap, amount: cap + 1, label: cap, want: 'mint_amount' },
    { name: 'note=cap-1, amount=cap-1', note: cap - 1, amount: cap - 1, want: 'mint_amount' },
    { name: 'note=cap+1, amount=cap+1', note: cap + 1, amount: cap + 1, want: 'insufficient' },
    { name: 'note=cap-1, amount=cap', note: cap - 1, amount: cap, want: 'mint_amount' },
  ];
}

describe('PSA-fd28-1 one withdraw rule on mempool, template and block', () => {
  it('the proof value alone passes a withdraw the block refuses', () => {
    const owner = stealthBox();
    const { state, clock, cap, pid } = closedVault(owner, LOCKS[0]);
    const tx = signedWithdraw(owner, pid, cap, { amount: cap + 1, id: 'fd28-confirm' });
    assert.equal(boundReserveWithdraw(tx, state, new Set()).ok, true, 'the old mempool gate passes it');
    assert.equal(blockRule(state, tx, clock), 'mint_amount', 'the block refuses it');
    assert.equal(mempoolRule(state, tx, clock), 'mint_amount');
  });

  it('a wrong clock, a missing vault, or a foreign program fail the same way', () => {
    const owner = stealthBox();
    const { state, clock, cap, pid } = closedVault(owner, LOCKS[1]);
    const tx = signedWithdraw(owner, pid, cap, { amount: cap, id: 'fd28-edges' });
    assert.equal(verifyReserveWithdraw(state, tx, clock).ok, true);
    assert.equal(verifyReserveWithdraw(state, tx, state.epochStartMs + 1).reason, 'epoch_open');
    assert.equal(verifyReserveWithdraw(state, tx, 0).reason, 'epoch_open');
    assert.equal(verifyReserveWithdraw(null, tx, clock).reason, 'no_vault');
    assert.equal(verifyReserveWithdraw({ ...state, blankFork: true }, tx, clock).reason, 'blank_vault');
    assert.equal(verifyReserveWithdraw(state, { ...tx, programId: 'other' }, clock).reason, 'mint_forbidden');
    for (const [s, c] of [[state, clock], [state, 0], [null, clock]]) {
      assert.deepEqual(verifyReserveWithdraw(s, tx, c), verifyReservePayout(s, tx, c));
    }
    assert.deepEqual(verifyReserveWithdraw(state, { kind: 'send' }, clock), { ok: true });
  });

  it('spreads the amount field against the note value: mempool equals block', () => {
    for (const lock of LOCKS) {
      const owner = stealthBox();
      const { state, clock, cap, pid } = closedVault(owner, lock);
      for (const row of spread(cap)) {
        const tx = signedWithdraw(owner, pid, row.note, { amount: row.amount, label: row.label, id: row.name });
        const block = blockRule(state, tx, clock);
        const pool = mempoolRule(state, tx, clock);
        assert.equal(block, row.want, `${lock} ${row.name}: block ${block}`);
        assert.equal(pool, block, `${lock} ${row.name}: mempool ${pool}, block ${block}`);
      }
    }
  });
});

/**
 * PSA-62e5-1. Pool coverage for the Shear Vault reward-claim API.
 * POST /api/wallet/send with kind reward-claim. One epoch-end root, one
 * FS-1 output, mint once, and the claim does not expire. Low, Medium, and
 * High are mempool fee rates with the exact SHE cost. The whole fee is the
 * miner's. A higher fee rate is mined first.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, spendDestOf } from '../../crypto/address.js';
import { outputJoinsAdmitSet } from '../../crypto/admit.js';
import {
  MAGIC_TESTNET,
  NANOS_PER_SHE,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
  extraMintAllowed,
  formatShe,
} from '../../crypto/asert.js';
import { selectBodyIndexes, txVerifyWeight } from '../../crypto/block_budget.js';
import { buildRewardClaim, exactSheFromNanos } from '../../crypto/claim_fee.js';
import { fs1LeafFor } from '../../crypto/fs1_leaf.js';
import {
  FEE_SPLIT_FINDER_BPS,
  LEVY_CAP_NANOS,
  levyNeed,
  splitLevy,
} from '../../crypto/levy.js';
import {
  applyReserveBlock,
  deposit,
  emptyVault,
  rewardClaimProof,
  rewardClaimTx,
  rewardCommitment,
} from '../../crypto/reserve_vault.js';
import { handleWalletApi } from '../src/wallet_api.js';

const T0 = 1_700_000_000_000;

function url(path) {
  return new URL(`http://127.0.0.1${path}`);
}

function who() {
  return spendDestOf(newIdentity().spendPub);
}

function freshVault() {
  const state = emptyVault();
  state.magic = MAGIC_TESTNET;
  state.genesisMs = T0;
  return state;
}

function lockPortal(state, dest, when = T0 + 1_000) {
  return deposit({
    state,
    dest,
    nanos: PI_SHE_NANOS,
    nowMs: when,
    payout: dest,
  });
}

function commitRoot(state, plan, draw) {
  return applyReserveBlock({
    state,
    block: { height: 2, txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] },
    nowMs: draw,
    genesisMs: T0,
    requireStakeReward: true,
  });
}

/** Two earning locks and the epoch-end root. Nothing is minted yet. */
function settledPair() {
  const state = freshVault();
  const locks = [who(), who()];
  for (const dest of locks) assert.equal(lockPortal(state, dest).ok, true);
  const draw = T0 + RESERVE_EPOCH_MS + 1;
  const plan = rewardCommitment(state, draw);
  assert.equal(plan.rows.length, 2);
  const committed = commitRoot(state, plan, draw);
  assert.equal(committed.ok, true, committed.reason);
  assert.equal(Number(state.mintBankNanos), 0);
  return { state, draw, plan, locks };
}

function claimBody(state, row, { fee, id, to }) {
  const tx = rewardClaimTx({
    to,
    nanos: row.nanos,
    nullifier: row.nullifier,
    proof: rewardClaimProof(state, row.nullifier),
    id,
    fee,
  });
  return {
    kind: 'reward-claim',
    programId: RESERVE_PROGRAM,
    mint: true,
    to: tx.to,
    nanos: tx.nanos,
    nullifier: tx.nullifier,
    proof: tx.proof,
    vout: tx.vout,
    id,
    fee,
  };
}

function post(body, queueSend = (tx) => tx) {
  return handleWalletApi(url('/api/wallet/send'), 'POST', body, { queueSend });
}

function applyClaim(state, tx, nowMs) {
  return applyReserveBlock({
    state,
    block: { height: 9, txs: [{ coinbase: true, vout: [] }, tx] },
    nowMs,
    genesisMs: T0,
  });
}

function peer(fee, outs = 1) {
  return {
    kind: 'send',
    fee,
    vin: [],
    vout: Array.from({ length: outs }, () => ({})),
  };
}

describe('PSA-62e5-1 reward-claim API', () => {
  it('queues one FS-1 claim and still mints it long after the epoch', () => {
    const { state, plan } = settledPair();
    const row = plan.rows[0];
    const pay = who();
    const posted = [];
    const body = claimBody(state, row, { fee: 8_000, id: 'claim-happy', to: pay });
    const got = post(body, (tx) => {
      posted.push(tx);
      return { id: tx.id, ...tx };
    });
    assert.equal(got.status, 200, got.json && got.json.reason);
    assert.equal(got.json.ok, true);
    assert.equal(got.json.tx.kind, 'reward-claim');
    assert.equal(got.json.tx.confirmed, false);
    assert.equal(got.json.tx.fee, 8_000);
    assert.equal(got.json.tx.id, 'claim-happy');
    assert.equal(posted.length, 1);
    const tx = posted[0];
    assert.equal(tx.kind, 'reward-claim');
    assert.equal(tx.programId, RESERVE_PROGRAM);
    assert.equal(tx.mint, true);
    assert.equal(tx.fee, 8_000);
    assert.equal(tx.to, pay);
    assert.equal(tx.nullifier, row.nullifier);
    assert.equal(tx.portalId, undefined);
    assert.equal(tx.vout[0].kind, 'reward-claim');
    assert.equal(tx.vout[0].portalId, undefined);
    assert.ok(fs1LeafFor(tx.vout[0]));
    assert.equal(outputJoinsAdmitSet(tx, tx.vout[0]), true);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'reward-claim' }), true);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'claim' }), false);
    assert.ok(tx.fee >= levyNeed(tx));
    assert.ok(tx.fee <= LEVY_CAP_NANOS);

    const later = T0 + RESERVE_EPOCH_MS + 1 + (40 * RESERVE_EPOCH_MS);
    const paid = applyClaim(state, tx, later);
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(Number(state.mintBankNanos), row.nanos);
    assert.equal(state.mintedIds[row.nullifier], true);
  });

  it('refuses a second claim of the same nullifier', () => {
    const { state, plan } = settledPair();
    const row = plan.rows[0];
    const pay = who();
    const body = claimBody(state, row, { fee: 8_000, id: 'claim-once', to: pay });
    const later = T0 + RESERVE_EPOCH_MS + 1 + (40 * RESERVE_EPOCH_MS);
    const queueSend = (tx) => {
      const applied = applyClaim(state, tx, later);
      if (!applied.ok) return { ok: false, reason: applied.reason || 'double_mint' };
      return tx;
    };
    const first = post(body, queueSend);
    assert.equal(first.status, 200, first.json && first.json.reason);
    assert.equal(Number(state.mintBankNanos), row.nanos);
    const again = post({ ...body, id: 'claim-twice' }, queueSend);
    assert.equal(again.status, 400);
    assert.equal(again.json.ok, false);
    assert.equal(again.json.reason, 'double_mint');
    assert.equal(Number(state.mintBankNanos), row.nanos);
    const direct = applyClaim(state, {
      ...body,
      id: 'claim-direct',
      fee: 8_000,
    }, later);
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, 'double_mint');
  });

  it('shows Low, Medium, and High with the exact SHE cost', () => {
    const { state, plan } = settledPair();
    const [first, second] = plan.rows;
    const mempool = [peer(20_000), peer(1_000), peer(5_000)];
    const pay = who();
    const quoted = buildRewardClaim({
      to: pay,
      nanos: first.nanos,
      nullifier: first.nullifier,
      proof: rewardClaimProof(state, first.nullifier),
      id: 'claim-quote',
      mempool,
    });
    assert.deepEqual(quoted.presets.map((row) => row.id), ['low', 'medium', 'high']);
    assert.deepEqual(quoted.presets.map((row) => row.label), ['Low', 'Medium', 'High']);
    assert.ok(quoted.presets[0].fee <= quoted.presets[1].fee);
    assert.ok(quoted.presets[1].fee <= quoted.presets[2].fee);
    for (const row of quoted.presets) {
      assert.equal(row.she, exactSheFromNanos(row.fee));
      assert.equal(row.fee >= quoted.floor, true);
      assert.equal(row.fee <= LEVY_CAP_NANOS, true);
    }
    const empty = buildRewardClaim({
      to: pay,
      nanos: first.nanos,
      nullifier: first.nullifier,
      proof: rewardClaimProof(state, first.nullifier),
      id: 'claim-empty-book',
    });
    for (const row of empty.presets) {
      assert.equal(row.fee, empty.floor);
      assert.equal(row.she, exactSheFromNanos(empty.floor));
    }
    const customNanos = quoted.floor + 3;
    const custom = buildRewardClaim({
      to: pay,
      nanos: first.nanos,
      nullifier: first.nullifier,
      proof: rewardClaimProof(state, first.nullifier),
      id: 'claim-custom',
      mempool,
      custom: customNanos,
    });
    assert.equal(custom.custom.ok, true);
    assert.equal(custom.custom.fee, customNanos);
    assert.equal(custom.custom.she, exactSheFromNanos(customNanos));
    assert.equal(custom.tx.fee, customNanos);
    assert.notEqual(custom.custom.she, formatShe(customNanos / NANOS_PER_SHE));
    const short = buildRewardClaim({
      to: pay,
      nanos: first.nanos,
      nullifier: first.nullifier,
      proof: rewardClaimProof(state, first.nullifier),
      id: 'claim-short-quote',
      custom: 1,
    });
    assert.equal(short.custom.ok, false);
    assert.equal(short.custom.reason, 'levy');
    assert.equal(short.custom.she, exactSheFromNanos(1));

    const posted = [];
    const high = post(claimBody(state, first, {
      fee: quoted.presets[2].fee,
      id: 'claim-high',
      to: pay,
    }), (tx) => {
      posted.push(tx);
      return tx;
    });
    assert.equal(high.status, 200, high.json && high.json.reason);
    assert.equal(high.json.tx.fee, quoted.presets[2].fee);
    assert.equal(exactSheFromNanos(high.json.tx.fee), quoted.presets[2].she);
    const low = post(claimBody(state, second, {
      fee: quoted.presets[0].fee,
      id: 'claim-low',
      to: who(),
    }), (tx) => {
      posted.push(tx);
      return tx;
    });
    assert.equal(low.status, 200, low.json && low.json.reason);
    assert.equal(low.json.tx.fee, quoted.presets[0].fee);
    assert.equal(posted[0].fee, quoted.presets[2].fee);
    assert.equal(posted[1].fee, quoted.presets[0].fee);
  });

  it('orders mempool claims by fee rate and pays the whole fee to the miner', () => {
    const { state, plan } = settledPair();
    const [first, second] = plan.rows;
    const mempool = [peer(20_000), peer(1_000), peer(5_000)];
    const highQuote = buildRewardClaim({
      to: who(),
      nanos: first.nanos,
      nullifier: first.nullifier,
      proof: rewardClaimProof(state, first.nullifier),
      id: 'claim-rate-high',
      mempool,
      preset: 'high',
    });
    const lowQuote = buildRewardClaim({
      to: who(),
      nanos: second.nanos,
      nullifier: second.nullifier,
      proof: rewardClaimProof(state, second.nullifier),
      id: 'claim-rate-low',
      mempool,
      preset: 'low',
    });
    const queued = [];
    for (const quote of [lowQuote, highQuote]) {
      const got = post({
        kind: 'reward-claim',
        programId: RESERVE_PROGRAM,
        to: quote.tx.to,
        nanos: quote.tx.nanos,
        nullifier: quote.tx.nullifier,
        proof: quote.tx.proof,
        vout: quote.tx.vout,
        id: quote.tx.id,
        fee: quote.tx.fee,
      }, (tx) => {
        queued.push(tx);
        return tx;
      });
      assert.equal(got.status, 200, got.json && got.json.reason);
    }
    assert.ok(queued[1].fee > queued[0].fee);
    assert.ok(queued[1].fee / txVerifyWeight(queued[1]) > queued[0].fee / txVerifyWeight(queued[0]));
    const picks = selectBodyIndexes(queued);
    assert.equal(queued[picks[0]].id, 'claim-rate-high');
    assert.equal(queued[picks[1]].id, 'claim-rate-low');

    const light = queued[0];
    const heavy = {
      ...queued[1],
      id: 'claim-heavy',
      vout: [queued[1].vout[0], { ...queued[1].vout[0] }, { ...queued[1].vout[0] }],
    };
    const heavyW = txVerifyWeight(heavy);
    const lightW = txVerifyWeight(light);
    const room = Math.floor((light.fee * heavyW - 1) / lightW);
    heavy.fee = room;
    assert.ok(heavyW > lightW);
    assert.ok(heavy.fee > light.fee);
    assert.ok(light.fee * heavyW > heavy.fee * lightW);
    assert.equal([heavy, light][selectBodyIndexes([heavy, light])[0]].id, light.id);

    assert.equal(FEE_SPLIT_FINDER_BPS, 10_000);
    const both = queued[0].fee + queued[1].fee;
    assert.deepEqual(splitLevy(both), { finder: both, reserve: 0 });
  });

  it('rejects a malformed reward claim before it is queued', () => {
    const { state, plan } = settledPair();
    const row = plan.rows[0];
    const pay = who();
    const good = claimBody(state, row, { fee: 8_000, id: 'claim-bad', to: pay });
    const queued = [];
    const queueSend = (tx) => {
      queued.push(tx);
      return tx;
    };
    const cases = [
      [{ ...good, programId: 'other-vortice' }, 'bad_kind'],
      [{ ...good, programId: '' }, 'bad_kind'],
      [{ ...good, to: '' }, 'bad_send'],
      [{ ...good, to: 'shear1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' }, 'rest_frame'],
      [{ ...good, to: 'not-an-address' }, 'bad_send'],
      [{ ...good, nanos: 0 }, 'bad_send'],
      [{ ...good, nanos: -1 }, 'bad_send'],
      [{ ...good, nanos: '1.5' }, 'bad_send'],
      [{ ...good, nanos: null }, 'bad_send'],
      [{ ...good, nullifier: 'ab' }, 'bad_send'],
      [{ ...good, nullifier: 'zz'.repeat(32) }, 'bad_send'],
      [{ ...good, nullifier: '' }, 'bad_send'],
      [{ ...good, proof: null }, 'bad_send'],
      [{ ...good, proof: 'nope' }, 'bad_send'],
      [{ ...good, vout: [] }, 'bad_send'],
      [{ ...good, vout: [{ kind: 'send' }] }, 'bad_send'],
      [{ ...good, vout: [{ kind: 'claim' }] }, 'bad_send'],
      [{ ...good, fee: null }, 'bad_send'],
      [{ ...good, fee: '' }, 'bad_send'],
      [{ ...good, fee: '8_000' }, 'bad_send'],
      [{ ...good, fee: '1.5' }, 'bad_send'],
      [{ ...good, fee: -5 }, 'bad_send'],
      [{ ...good, fee: 1.5 }, 'bad_send'],
      [{ ...good, fee: 1 }, 'levy'],
      [{ ...good, fee: LEVY_CAP_NANOS + 1 }, 'levy'],
    ];
    for (const [body, reason] of cases) {
      const got = post(body, queueSend);
      assert.equal(got.status, 400, `${reason} ${JSON.stringify(got.json)}`);
      assert.equal(got.json.ok, false);
      assert.equal(got.json.reason, reason, JSON.stringify(body && { fee: body.fee, nanos: body.nanos, to: body.to }));
    }
    const bare = { ...good };
    delete bare.fee;
    const noFee = post(bare, queueSend);
    assert.equal(noFee.status, 400);
    assert.equal(noFee.json.reason, 'bad_send');
    const oldKind = post({ ...good, kind: 'claim' }, queueSend);
    assert.equal(oldKind.status, 400);
    assert.equal(queued.length, 0);
    const missed = handleWalletApi(url('/api/wallet/send'), 'GET', good, { queueSend });
    assert.equal(missed, null);
  });
});

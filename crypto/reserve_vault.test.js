import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newIdentity } from './address.js';
import { destForLogin, vaultDest } from './flow_sheet.js';
import {
  RESERVE_PROGRAM,
  PI_SHE_NANOS,
  NANOS_PER_SHE,
  RESERVE_EPOCH_MS,
  RESERVE_JOIN_CUTOFF_MS,
  extraMintAllowed,
  MAGIC_TESTNET,
  MAGIC_MAINNET,
} from './asert.js';
import {
  emptyVault,
  deposit,
  vote,
  withdraw,
  enact,
  applyReserveBlock,
  creditFeeBank,
  payoutStakeReward,
  canJoin,
  canVote,
  publicVaultView,
  portalIdFromDest,
  observeRate,
  portalRewards,
  previewWithdraw,
  VOTE_INCREASE,
  VOTE_DECREASE,
  VOTE_HOLD,
} from './reserve_vault.js';
import { RESERVE_ORACLE_ID, RESERVE_ORACLE_DEFAULT_BPS, interestNanos } from './reserve_oracle.js';

const DAY = 86_400_000;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function destOf(id) {
  return vaultDest(id.address, { viewKey: id.viewKey });
}

describe('Reserve vault protocol', () => {
  it('stake rewards pay fee bank first and mint only the gap', () => {
    const state = emptyVault();
    creditFeeBank(state, 10);
    const paid = payoutStakeReward({ state, reward: 15, id: 'r1' });
    assert.equal(paid.ok, true);
    assert.equal(paid.fromFee, 10);
    assert.equal(paid.minted, 5);
    assert.equal(paid.feeBank, 0);
    const twice = payoutStakeReward({ state, reward: 1, id: 'r1' });
    assert.equal(twice.ok, false);
    assert.equal(twice.reason, 'double_mint');
    const wait = payoutStakeReward({ state, reward: 3, id: 'r2', gateOk: false });
    assert.equal(wait.ok, false);
    assert.equal(wait.reason, 'gate_wait');
    const bank = emptyVault();
    creditFeeBank(bank, 20);
    const covered = payoutStakeReward({ state: bank, reward: 7, id: 'r3' });
    assert.equal(covered.ok, true);
    assert.equal(covered.fromFee, 7);
    assert.equal(covered.minted, 0);
  });

  it('extra mint is only shear-reserve-v1', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed('other-dapp'), false);
  });

  it('first epoch starts on the first qualifying π deposit, not at zero', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    assert.equal(state.epochStartMs, 0);
    const dust = deposit({ state, dest: a, nanos: NANOS_PER_SHE, nowMs: t0 });
    assert.equal(dust.ok, true);
    assert.equal(state.epochStartMs, 0);
    assert.equal(canVote(dust.portal.staked), false);
    const rest = PI_SHE_NANOS - NANOS_PER_SHE;
    const ok = deposit({ state, dest: a, nanos: rest, nowMs: t0 + 1000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.portal.joined, true);
    assert.equal(canVote(ok.portal.staked), true);
    assert.equal(state.epochStartMs, t0 + 1000);
    assert.notEqual(state.epochStartMs, 0);
  });

  it('after the 99-day cutoff, deposits are idle: no interest, but a first vote is allowed', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = destOf(alice);
    const b = destOf(bob);
    assert.notEqual(portalIdFromDest(a), portalIdFromDest(b));
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    assert.equal(deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    assert.equal(canJoin(state, t0 + 10 * DAY), true);
    const late = t0 + (400 - 98) * DAY;
    assert.equal(remainingUnder99(state, late), true);
    const idleBob = deposit({ state, dest: b, nanos: PI_SHE_NANOS, nowMs: late });
    assert.equal(idleBob.ok, true);
    assert.equal(idleBob.idle, true);
    assert.equal(idleBob.portal.joined, true);
    assert.equal(idleBob.portal.staked, 0);
    assert.equal(idleBob.portal.idle, PI_SHE_NANOS);
    const firstLate = vote({ state, dest: b, choice: VOTE_INCREASE, nowMs: late });
    assert.equal(firstLate.ok, true);
    const changeLate = vote({ state, dest: b, choice: VOTE_HOLD, nowMs: late });
    assert.equal(changeLate.ok, false);
    assert.equal(changeLate.reason, 'vote_locked');
    assert.equal(state.votes.increase, 1);
    assert.equal(state.votes.hold, 0);
    const more = deposit({ state, dest: a, nanos: 100, nowMs: late });
    assert.equal(more.ok, true);
    assert.equal(more.idle, true);
    const done = withdraw({ state, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(done.ok, true);
    assert.equal(done.idle, 100);
    assert.ok(done.interest > 0);
    const bobOut = withdraw({ state, dest: b, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(bobOut.ok, true);
    assert.equal(bobOut.interest, 0);
    assert.equal(bobOut.idle, PI_SHE_NANOS);
  });

  it('epoch end enacts a unique plurality onto the live hash bonus', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    vote({ state, dest: a, choice: VOTE_INCREASE, nowMs: t0 + 2 });
    assert.equal(Number(state.liveHashBonusNanos), 1);
    const tooSoon = enact({ state, nowMs: t0 + 10 * DAY });
    assert.equal(tooSoon.ok, false);
    const done = enact({ state, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(done.ok, true);
    assert.equal(Number(state.liveHashBonusNanos), 2);
    assert.equal(state.bonusEnacted, true);
    assert.equal(state.enactedUp, 1);
    assert.equal(state.enactedDown, 0);
    assert.equal(state.enactedHold, 0);
    assert.equal(state.enactedDelta, 1);
    const pub = publicVaultView(state, t0 + RESERVE_EPOCH_MS);
    assert.equal(pub.votes.increase, 1);
    assert.equal(pub.votes.decrease, 0);
    assert.equal(pub.votes.hold, 0);
    assert.notEqual(pub.votes.increase + pub.votes.decrease + pub.votes.hold, 0);
    const again = enact({ state, nowMs: t0 + RESERVE_EPOCH_MS + 1 });
    assert.equal(again.ok, false);
  });

  it('first sealed block after epoch auto-enacts the winning vote; height is unchanged', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    vote({ state, dest: a, choice: VOTE_INCREASE, nowMs: t0 + 2 });
    const height = 40;
    const block = { height, txs: [{ coinbase: true, vout: [] }] };
    applyReserveBlock({ state, block, nowMs: t0 + 10 * DAY });
    assert.equal(Number(state.liveHashBonusNanos), 1);
    assert.equal(state.bonusEnacted, false);
    applyReserveBlock({ state, block, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(Number(state.liveHashBonusNanos), 2);
    assert.equal(state.bonusEnacted, true);
    assert.equal(block.height, height);
    applyReserveBlock({ state, block: { height: height + 1, txs: [] }, nowMs: t0 + RESERVE_EPOCH_MS + 90_000 });
    assert.equal(Number(state.liveHashBonusNanos), 2);
  });

  it('accrued rewards grow on staked SHE and stay zero on idle SHE', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = destOf(alice);
    const b = destOf(bob);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    const start = portalRewards(state, a, t0);
    assert.equal(start.accrued, 0);
    assert.ok(start.projected > 0);
    const mid = portalRewards(state, a, t0 + 200 * DAY);
    assert.ok(mid.accrued > 0);
    assert.ok(mid.accrued < mid.projected);
    const end = portalRewards(state, a, t0 + RESERVE_EPOCH_MS);
    assert.equal(end.accrued, end.projected);
    const late = t0 + (400 - 50) * DAY;
    deposit({ state, dest: b, nanos: PI_SHE_NANOS, nowMs: late });
    const idle = portalRewards(state, b, late + DAY);
    assert.equal(idle.accrued, 0);
    assert.equal(idle.projected, 0);
    assert.equal(idle.idle, PI_SHE_NANOS);
    const pub = JSON.stringify(publicVaultView(state, late));
    assert.equal(pub.includes(alice.address), false);
    assert.equal(pub.includes('accrued'), false);
  });

  it('two users have distinct key-portals; public view leaks no shear1 or view key', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = destOf(alice);
    const b = destOf(bob);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    deposit({ state, dest: b, nanos: PI_SHE_NANOS, nowMs: t0 + 1 });
    vote({ state, dest: a, choice: VOTE_INCREASE, nowMs: t0 + 2 });
    vote({ state, dest: b, choice: VOTE_HOLD, nowMs: t0 + 2 });
    const pub = JSON.stringify(publicVaultView(state, t0 + 2));
    assert.equal(pub.includes(alice.address), false);
    assert.equal(pub.includes(bob.address), false);
    assert.equal(pub.includes(alice.viewKey), false);
    assert.equal(pub.includes(bob.viewKey), false);
    assert.equal(pub.includes('shear1'), false);
    assert.equal(pub.includes('viewKey'), false);
    assert.ok(a.startsWith('ssa1'));
    const round = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    assert.notEqual(a, round);
  });

  it('withdraw after 400 days extra-mints interest only for the Reserve', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const continuum = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0, payout: continuum });
    const early = withdraw({ state, dest: a, nowMs: t0 + 10 * DAY });
    assert.equal(early.ok, false);
    const done = withdraw({ state, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(done.ok, true);
    assert.equal(done.programId, RESERVE_PROGRAM);
    assert.equal(done.to, continuum);
    assert.notEqual(done.to, a);
    assert.ok(done.interest > 0);
    assert.equal(done.payout, done.principal + done.interest);
    assert.equal(done.mint.ok, true);
    assert.equal(done.mint.to, continuum);
    assert.equal(done.mint.nanos, done.interest);
    assert.equal(extraMintAllowed(done.programId, { kind: 'withdraw' }), true);
  });
});

function remainingUnder99(state, nowMs) {
  return !canJoin(state, nowMs) && RESERVE_JOIN_CUTOFF_MS > 0;
}

describe('Reserve Solidity is Shear-only copy', () => {
  it('names Shear magics, π, 400 days, 99-day join, and refuses foreign chain ids', () => {
    const src = readFileSync(join(root, 'contracts/Reserve.sol'), 'utf8');
    assert.match(src, /shear-testnet-v2/);
    assert.match(src, /shear-testnet-v3/);
    assert.match(src, /shear-testnet-v1/);
    assert.match(src, /shear-v1/);
    assert.match(src, /shear-reserve-v1/);
    assert.match(src, /400/);
    assert.match(src, /99/);
    assert.match(src, /NotShear/);
    assert.match(src, /chainid/);
    assert.match(src, /live hash bonus/);
    assert.match(src, /Reserve oracle/);
    assert.match(src, /idle/);
    assert.equal(src.includes('Bank of England'), false);
    assert.equal(src.includes('BoE'), false);
    assert.equal(src.includes(MAGIC_TESTNET.split('-')[0]), true);
    assert.match(src, /onlyShear/);
    assert.ok(existsSync(join(root, 'contracts/Reserve.sol')));
  });
});

describe('Reserve oracle', () => {
  it('lives on the vault; idle SHE earns no interest; rate is variable', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    assert.equal(state.oracle.id, RESERVE_ORACLE_ID);
    assert.equal(state.oracle.annualBps, RESERVE_ORACLE_DEFAULT_BPS);
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    const pub = publicVaultView(state, t0);
    assert.equal(pub.oracleBps, RESERVE_ORACLE_DEFAULT_BPS);
    assert.equal(pub.epochBps, RESERVE_ORACLE_DEFAULT_BPS);
    assert.equal(JSON.stringify(pub).includes(alice.address), false);
    const mid = withdraw({ state, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(mid.ok, true);
    assert.equal(mid.interest, interestNanos(PI_SHE_NANOS, RESERVE_ORACLE_DEFAULT_BPS, 400));
    const again = emptyVault();
    deposit({ state: again, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    assert.equal(observeRate({ state: again, annualBps: 0, nowMs: t0 + 1 }).ok, true);
    const frozen = withdraw({ state: again, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(frozen.ok, true);
    assert.equal(frozen.interest, interestNanos(PI_SHE_NANOS, RESERVE_ORACLE_DEFAULT_BPS));
    assert.equal(observeRate({ state: again, annualBps: -1, nowMs: t0 }).ok, false);
  });
});

describe('Reserve freeze, vote-once, dest bind', () => {
  it('two vaults with different annualBps mint the same withdraw nanos when epochBps matches', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const one = emptyVault();
    const two = emptyVault();
    deposit({ state: one, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    deposit({ state: two, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    assert.equal(observeRate({ state: one, annualBps: 100, nowMs: t0 + 1 }).ok, true);
    assert.equal(observeRate({ state: two, annualBps: 9000, nowMs: t0 + 1 }).ok, true);
    assert.notEqual(one.oracle.annualBps, two.oracle.annualBps);
    assert.equal(one.epochBps, two.epochBps);
    const w1 = withdraw({ state: one, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    const w2 = withdraw({ state: two, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(w1.ok, true);
    assert.equal(w2.ok, true);
    assert.equal(w1.interest, w2.interest);
    assert.equal(w1.interest, interestNanos(PI_SHE_NANOS, one.epochBps));
  });

  it('mid-epoch observeRate(9999) does not change withdraw or preview interest', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    const before = previewWithdraw(state, a).interest;
    assert.equal(observeRate({ state, annualBps: 9999, nowMs: t0 + 10 * DAY }).ok, true);
    assert.equal(state.oracle.annualBps, 9999);
    assert.equal(previewWithdraw(state, a).interest, before);
    const out = withdraw({ state, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(out.interest, before);
  });

  it('first lock after enact updates epochBps automatically; step > 100 is clamped', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = destOf(alice);
    const b = destOf(bob);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    assert.equal(state.epochBps, 264);
    enact({ state, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(observeRate({ state, annualBps: 9999, nowMs: t0 + RESERVE_EPOCH_MS + 1 }).ok, true);
    deposit({ state, dest: b, nanos: PI_SHE_NANOS, nowMs: t0 + RESERVE_EPOCH_MS + 2 });
    assert.equal(state.currentEpoch, 2);
    assert.equal(state.bonusEnacted, false);
    assert.equal(state.epochBps, 364);
  });

  it('first vote lands; second same portal same epoch is vote_locked and piles stay', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    const first = vote({ state, dest: a, choice: VOTE_INCREASE, nowMs: t0 + 2 });
    assert.equal(first.ok, true);
    assert.equal(state.votes.increase, 1);
    const second = vote({ state, dest: a, choice: VOTE_HOLD, nowMs: t0 + 3 });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'vote_locked');
    assert.equal(state.votes.increase, 1);
    assert.equal(state.votes.hold, 0);
  });

  it('Alice lock, Bob withdraw fails', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = destOf(alice);
    const continuumA = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const continuumB = destForLogin(bob.address, { viewKey: bob.viewKey, height: 1 });
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0, payout: continuumA });
    const stolen = withdraw({ state, dest: a, nowMs: t0 + RESERVE_EPOCH_MS, payout: continuumB });
    assert.equal(stolen.ok, false);
    assert.equal(stolen.reason, 'payout_mismatch');
    const ok = withdraw({ state, dest: a, nowMs: t0 + RESERVE_EPOCH_MS, payout: continuumA });
    assert.equal(ok.ok, true);
    assert.equal(ok.to, continuumA);
  });

  it('withdraw after epoch rollover does not drive the new piles to -1', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = destOf(alice);
    const b = destOf(bob);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    assert.equal(deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    assert.equal(vote({ state, dest: a, choice: VOTE_INCREASE, nowMs: t0 + 2 }).ok, true);
    assert.equal(state.votes.increase, 1);
    const end1 = t0 + RESERVE_EPOCH_MS;
    assert.equal(enact({ state, nowMs: end1 }).ok, true);
    assert.equal(deposit({ state, dest: b, nanos: PI_SHE_NANOS, nowMs: end1 + 1 }).ok, true);
    assert.equal(state.currentEpoch, 2);
    assert.equal(state.votes.increase, 0);
    assert.equal(vote({ state, dest: b, choice: VOTE_HOLD, nowMs: end1 + 2 }).ok, true);
    assert.equal(state.votes.hold, 1);
    const end2 = end1 + 1 + RESERVE_EPOCH_MS;
    assert.equal(enact({ state, nowMs: end2 }).ok, true);
    const out = withdraw({ state, dest: a, nowMs: end2 });
    assert.equal(out.ok, true, out.reason);
    assert.equal(state.votes.increase, 0);
    assert.equal(state.votes.hold, 1);
    assert.ok(state.votes.increase >= 0);
    assert.ok(state.votes.decrease >= 0);
    assert.ok(state.votes.hold >= 0);
    const portal = state.portals[portalIdFromDest(a)];
    assert.equal(portal.vote, null);
    assert.equal(Number(portal.voteEpoch || 0), 0);
  });

  it('a decrease vote at the unit floor is invalid; enact never sets liveHashBonusNanos below 1', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    assert.equal(asNumSafe(state.liveHashBonusNanos), 1);
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    const down = vote({ state, dest: a, choice: VOTE_DECREASE, nowMs: t0 + 2 });
    assert.equal(down.ok, false);
    assert.equal(down.reason, 'unit_floor');
    assert.equal(vote({ state, dest: a, choice: VOTE_HOLD, nowMs: t0 + 3 }).ok, true);
    const done = enact({ state, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(done.ok, true);
    assert.equal(Number(state.liveHashBonusNanos), 1);
    assert.equal(Number(state.liveHashBonusNanos) >= 1, true);
  });
});

function asNumSafe(n) {
  return Number(n);
}

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
  creditFeeBank,
  payoutStakeReward,
  canJoin,
  canVote,
  publicVaultView,
  portalIdFromDest,
  observeRate,
  portalRewards,
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
    assert.equal(extraMintAllowed(RESERVE_PROGRAM), true);
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
    assert.equal(vote({ state, dest: b, choice: VOTE_INCREASE, nowMs: late }).ok, true);
    assert.equal(vote({ state, dest: b, choice: VOTE_HOLD, nowMs: late }).ok, false);
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
    assert.equal(state.liveHashBonusNanos, 1);
    const tooSoon = enact({ state, nowMs: t0 + 10 * DAY });
    assert.equal(tooSoon.ok, false);
    const done = enact({ state, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(done.ok, true);
    assert.equal(state.liveHashBonusNanos, 2);
    assert.equal(state.bonusEnacted, true);
    const again = enact({ state, nowMs: t0 + RESERVE_EPOCH_MS + 1 });
    assert.equal(again.ok, false);
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
    assert.equal(extraMintAllowed(done.programId), true);
  });
});

function remainingUnder99(state, nowMs) {
  return !canJoin(state, nowMs) && RESERVE_JOIN_CUTOFF_MS > 0;
}

describe('Reserve Solidity is Shear-only copy', () => {
  it('names Shear magics, π, 400 days, 99-day join, and refuses foreign chain ids', () => {
    const src = readFileSync(join(root, 'contracts/Reserve.sol'), 'utf8');
    assert.match(src, /shear-testnet-v2/);
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
    assert.equal(JSON.stringify(pub).includes(alice.address), false);
    const mid = withdraw({ state, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(mid.ok, true);
    assert.equal(mid.interest, interestNanos(PI_SHE_NANOS, RESERVE_ORACLE_DEFAULT_BPS, 400));
    const again = emptyVault();
    deposit({ state: again, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    assert.equal(observeRate({ state: again, annualBps: 0, nowMs: t0 + 1 }).ok, true);
    const zero = withdraw({ state: again, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(zero.ok, true);
    assert.equal(zero.interest, 0);
    assert.equal(observeRate({ state: again, annualBps: -1, nowMs: t0 }).ok, false);
  });
});

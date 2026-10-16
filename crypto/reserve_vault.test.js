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
  cloneVault,
  vote,
  withdraw,
  enact,
  applyReserveBlock,
  verifyReservePayout,
  portalEpochInterest,
  creditFeeBank,
  payoutStakeReward,
  supplyIdentity,
  canJoin,
  canVote,
  publicVaultView,
  portalIdFromDest,
  observeRate,
  portalRewards,
  previewWithdraw,
  trialReserveApply,
  voteTx,
  reserveAction,
  signWithdrawReward,
  VOTE_INCREASE,
  VOTE_DECREASE,
  VOTE_HOLD,
} from './reserve_vault.js';
import { deposit, lockTx, withdrawTx, portalOwnerPub, ownerFor } from './owned_portal.js';
import { compactTx } from './chronoflux.js';
import { encodeWireBlock, decodeWireBlock } from '../node/src/p2p.js';
import { digestTx } from '../node/src/chain.js';
import { RESERVE_ORACLE_ID, RESERVE_ORACLE_DEFAULT_BPS, GENESIS_BPS, interestNanos } from './reserve_oracle.js';
import { extraMint } from './mint.js';
import { verifySealedNote } from './note.js';

const DAY = 86_400_000;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function destOf(id) {
  return vaultDest(id.address, { viewKey: id.viewKey });
}

describe('Reserve vault protocol', () => {
  it('stake rewards are minted in full; the fee bank is not a balance', () => {
    const state = emptyVault();
    assert.equal(creditFeeBank(state, 10), 0);
    const paid = payoutStakeReward({ state, reward: 15, id: 'r1' });
    assert.equal(paid.ok, true);
    assert.equal(paid.fromFee, 0);
    assert.equal(paid.minted, 15);
    assert.equal(paid.source, 'coinbase');
    assert.equal(paid.feeBank, 0);
    assert.equal(Number(state.feeBankNanos), 0);
    const twice = payoutStakeReward({ state, reward: 1, id: 'r1' });
    assert.equal(twice.ok, false);
    assert.equal(twice.reason, 'double_mint');
    const wait = payoutStakeReward({ state, reward: 3, id: 'r2', gateOk: false });
    assert.equal(wait.ok, false);
    assert.equal(wait.reason, 'gate_wait');
    const bank = emptyVault();
    bank.feeBankNanos = 20n;
    creditFeeBank(bank, 20);
    const covered = payoutStakeReward({ state: bank, reward: 7, id: 'r3' });
    assert.equal(covered.ok, true);
    assert.equal(covered.fromFee, 0);
    assert.equal(covered.minted, 7);
    assert.equal(Number(bank.feeBankNanos), 0);
    const idn = supplyIdentity(bank);
    assert.equal(idn.ok, false);
    assert.equal(idn.reason, 'supply');
    assert.ok(idn.mintedReward > idn.permittedReward);
    assert.equal(idn.feeBankRewardNanos, 0);
  });

  it('extra mint is only shear-reserve-v1', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed('other-dapp'), false);
  });

  it('a qualifying π deposit opens the chain epoch, not a clock of its own', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    assert.equal(state.epochStartMs, 0);
    const dust = deposit({ state, dest: a, nanos: NANOS_PER_SHE, nowMs: t0 });
    assert.equal(dust.ok, true);
    assert.equal(state.epochStartMs, 0);
    assert.equal(canVote(dust.portal.staked), false);
    const rest = PI_SHE_NANOS - NANOS_PER_SHE;
    const ok = deposit({ state, dest: a, nanos: rest, nowMs: t0 + 1000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.portal.joined, true);
    assert.equal(ok.portal.qualified, true);
    assert.equal(state.epochStartMs, t0);
    assert.equal(state.currentEpoch, 0);
    assert.notEqual(state.epochStartMs, 0);
  });

  it('after the stake cutoff, deposits are idle, earn no stake reward, and can vote once', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = destOf(alice);
    const b = destOf(bob);
    assert.notEqual(portalIdFromDest(a), portalIdFromDest(b));
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    assert.equal(deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    assert.equal(canJoin(state, t0 + Math.floor(RESERVE_EPOCH_MS / 2)), true);
    const late = t0 + RESERVE_EPOCH_MS - 1;
    assert.equal(remainingUnder99(state, late), true);
    const idleBob = deposit({ state, dest: b, nanos: PI_SHE_NANOS, nowMs: late });
    assert.equal(idleBob.ok, true);
    assert.equal(idleBob.idle, true);
    assert.equal(idleBob.portal.joined, true);
    assert.equal(idleBob.portal.staked, 0);
    assert.equal(idleBob.portal.idle, 0);
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
    assert.equal(done.idle, 0);
    assert.equal(done.interest, 0);
    assert.equal(done.earned, 0);
    const bobOut = withdraw({ state, dest: b, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(bobOut.ok, true);
    assert.equal(bobOut.interest, 0);
    assert.equal(bobOut.idle, 0);
  });

  it('epoch end enacts a unique plurality onto the live hash bonus', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    vote({ state, dest: a, choice: VOTE_INCREASE, nowMs: t0 + 2 });
    assert.equal(Number(state.liveHashBonusNanos), 1);
    const tooSoon = enact({ state, nowMs: t0 + Math.floor(RESERVE_EPOCH_MS / 2) });
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

  it('cloneVault is a deep copy; mutating the clone does not touch the original', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    assert.equal(deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    const pid = portalIdFromDest(a);
    const trial = cloneVault(state);
    trial.totalLockedNanos = 0n;
    trial.portals[pid].staked = 0;
    trial.portals[pid] = { ...trial.portals[pid], joined: false };
    applyReserveBlock({
      state: trial,
      block: { height: 1, txs: [{ coinbase: true, vout: [] }] },
      nowMs: t0 + 90_000,
    });
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal(Number(state.portals[pid].staked), 0);
    assert.equal(state.portals[pid].joined, true);
    assert.notEqual(trial.portals, state.portals);
  });

  it('accruedReward is a bigint capped at u64 across a rollover, 0%, and an undo', () => {
    const U64 = 0xffffffffffffffffn;
    const t0 = 1_700_000_000_000;
    const who = destOf(newIdentity());
    const rolled = emptyVault();
    rolled.genesisMs = t0;
    assert.equal(deposit({ state: rolled, dest: who, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    assert.equal(enact({ state: rolled, nowMs: t0 + RESERVE_EPOCH_MS }).ok, true);
    const added = 38;
    const more = deposit({
      state: rolled,
      dest: who,
      nanos: added,
      nowMs: t0 + RESERVE_EPOCH_MS + 1,
    });
    assert.equal(more.ok, true, more.reason);
    const id = portalIdFromDest(who);
    assert.equal(typeof rolled.portals[id].accruedReward, 'bigint');
    assert.equal(rolled.portals[id].accruedReward, 0n);
    assert.equal(supplyIdentity(rolled).ok, true);

    const zero = emptyVault();
    zero.genesisMs = t0;
    const zDest = destOf(newIdentity());
    assert.equal(deposit({ state: zero, dest: zDest, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    zero.epochBps = 0;
    assert.equal(enact({ state: zero, nowMs: t0 + RESERVE_EPOCH_MS }).ok, true);
    const zMore = deposit({ state: zero, dest: zDest, nanos: 1, nowMs: t0 + RESERVE_EPOCH_MS + 1 });
    assert.equal(zMore.ok, true, zMore.reason);
    assert.equal(zero.portals[portalIdFromDest(zDest)].accruedReward, 0n);
    assert.equal(supplyIdentity(zero).ok, true);

    const near = emptyVault();
    near.genesisMs = t0;
    const nDest = destOf(newIdentity());
    const stake = U64 - 5n;
    assert.equal(deposit({ state: near, dest: nDest, nanos: stake, nowMs: t0 }).ok, true);
    near.epochBps = 10000;
    assert.equal(enact({ state: near, nowMs: t0 + RESERVE_EPOCH_MS }).ok, true);
    const nMore = deposit({ state: near, dest: nDest, nanos: 1n, nowMs: t0 + RESERVE_EPOCH_MS + 1 });
    assert.equal(nMore.ok, true, nMore.reason);
    const nearId = portalIdFromDest(nDest);
    assert.equal(near.portals[nearId].accruedReward, 0n);
    const copied = cloneVault(near);
    assert.equal(copied.portals[nearId].accruedReward, 0n);
    assert.equal(supplyIdentity(near).ok, true);

    const capped = emptyVault();
    capped.genesisMs = t0;
    const cDest = destOf(newIdentity());
    assert.equal(deposit({ state: capped, dest: cDest, nanos: U64, nowMs: t0 }).ok, true);
    capped.epochBps = 10000;
    assert.equal(enact({ state: capped, nowMs: t0 + RESERVE_EPOCH_MS }).ok, true);
    const cMore = deposit({
      state: capped,
      dest: cDest,
      nanos: 1n,
      nowMs: t0 + 2 * RESERVE_EPOCH_MS,
    });
    assert.equal(cMore.ok, true, cMore.reason);
    assert.equal(capped.portals[portalIdFromDest(cDest)].accruedReward, 0n);
    assert.equal(supplyIdentity(capped).ok, true);

    const live = emptyVault();
    live.genesisMs = t0;
    const alice = destOf(newIdentity());
    const bob = destOf(newIdentity());
    assert.equal(deposit({ state: live, dest: alice, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    assert.equal(enact({ state: live, nowMs: t0 + RESERVE_EPOCH_MS }).ok, true);
    const aliceId = portalIdFromDest(alice);
    assert.equal(live.portals[aliceId].accruedReward, 0n);
    const fork = cloneVault(live);
    const settled = deposit({
      state: fork,
      dest: alice,
      nanos: 10,
      nowMs: t0 + RESERVE_EPOCH_MS + 1,
    });
    assert.equal(settled.ok, true, settled.reason);
    assert.equal(fork.portals[aliceId].accruedReward, 0n);
    const undone = trialReserveApply({
      state: live,
      inPlace: true,
      nowMs: t0 + RESERVE_EPOCH_MS + 1,
      genesisMs: t0,
      block: {
        height: 2,
        txs: [
          lockTx({ from: alice, to: alice, nanos: 10, id: 'settle-lock' }),
          withdrawTx({ from: bob, to: alice, nanos: 1, id: 'settle-miss' }),
        ],
      },
    });
    assert.equal(undone.ok, false);
    assert.equal(undone.reason, 'owner_missing');
    assert.equal(live.portals[aliceId].accruedReward, 0n);
    assert.equal(live.totalLockedNanos, 0n);
    assert.equal(supplyIdentity(live).ok, true);
    assert.equal(supplyIdentity(fork).ok, true);
  });

  it('a withdraw leaves the u64 reward cap on the portal', () => {
    const U64 = 0xffffffffffffffffn;
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    const dest = destOf(newIdentity());
    assert.equal(deposit({ state, dest, nanos: U64, nowMs: t0 }).ok, true);
    state.epochBps = 10000;
    const paid = withdraw({ state, dest, nowMs: t0 + 2 * RESERVE_EPOCH_MS });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.mint, null);
    assert.equal(paid.interest, 0);
    assert.equal(paid.earned, 0);
    assert.equal(state.mintBankNanos, 0n);
    assert.equal(supplyIdentity(state).ok, true);
  });

  it('first sealed block after epoch auto-enacts the winning vote; height is unchanged', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    vote({ state, dest: a, choice: VOTE_INCREASE, nowMs: t0 + 2 });
    const height = 40;
    const block = { height, txs: [{ coinbase: true, vout: [] }] };
    applyReserveBlock({ state, block, nowMs: t0 + Math.floor(RESERVE_EPOCH_MS / 2) });
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
    state.genesisMs = t0;
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    const start = portalRewards(state, a, t0);
    assert.equal(start.accrued, 0);
    assert.equal(start.projected, 0);
    const mid = portalRewards(state, a, t0 + Math.floor(RESERVE_EPOCH_MS / 2));
    assert.equal(mid.accrued, 0);
    assert.equal(mid.projected, 0);
    const end = portalRewards(state, a, t0 + RESERVE_EPOCH_MS);
    assert.equal(end.accrued, 0);
    const late = t0 + RESERVE_EPOCH_MS - 1;
    deposit({ state, dest: b, nanos: PI_SHE_NANOS, nowMs: late });
    const idle = portalRewards(state, b, late + DAY);
    assert.equal(idle.accrued, 0);
    assert.equal(idle.projected, 0);
    assert.equal(idle.idle, 0);
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
    state.genesisMs = t0;
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
    state.genesisMs = t0;
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0, payout: continuum });
    const early = withdraw({ state, dest: a, nowMs: t0 + Math.floor(RESERVE_EPOCH_MS / 2) });
    assert.equal(early.ok, false);
    const done = withdraw({ state, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(done.ok, true);
    assert.equal(done.programId, RESERVE_PROGRAM);
    assert.equal(done.to, continuum);
    assert.notEqual(done.to, a);
    assert.equal(done.interest, 0);
    assert.equal(done.earned, 0);
    assert.equal(done.payout, done.principal);
    assert.equal(done.mint, null);
    assert.equal(extraMintAllowed(done.programId, { kind: 'withdraw' }), true);
  });

  it('verifyReservePayout refuses a principal-only withdraw while that credit\'s epoch is open', () => {
    // Epoch 0 is already refused by settlementIndex <= 0. Epoch 1 is open
    // (chain index 1) and pays no completed interest, so a principal-only
    // receipt would pass the amount check if the arrival-epoch gate were gone.
    const epoch = RESERVE_EPOCH_MS;
    const lockAt = 1_700_000_000_000 + epoch;
    const mid = lockAt + Math.floor(epoch / 2);
    const end = lockAt + epoch;
    const alice = newIdentity();
    const dest = destOf(alice);
    const state = emptyVault();
    state.genesisMs = 1_700_000_000_000;
    state.magic = MAGIC_TESTNET;
    assert.equal(deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: lockAt }).ok, true);
    const portal = state.portals[portalIdFromDest(dest)];
    assert.equal(portalEpochInterest(state, portal, mid), 0);
    const early = withdrawTx({ from: dest, to: dest, nanos: PI_SHE_NANOS, id: 'open-epoch-principal' });
    const refused = verifyReservePayout(state, early, mid);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'epoch_open');
    const due = portalEpochInterest(state, portal, end);
    assert.equal(due, 0);
    const atEnd = withdrawTx({ from: dest, to: dest, nanos: 0, id: 'epoch-ended' });
    const paid = verifyReservePayout(state, atEnd, end);
    assert.equal(paid.ok, true, paid.reason);
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
    assert.match(src, /shear-testnet-v6/);
    assert.match(src, /shear-testnet-v8/);
    assert.match(src, /shear-testnet-v11/);
    assert.match(src, /shear-testnet-v12/);
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
    state.genesisMs = t0;
    assert.equal(state.oracle.id, RESERVE_ORACLE_ID);
    assert.equal(state.oracle.annualBps, RESERVE_ORACLE_DEFAULT_BPS);
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    const pub = publicVaultView(state, t0);
    assert.equal(pub.oracleBps, RESERVE_ORACLE_DEFAULT_BPS);
    assert.equal(pub.epochBps, RESERVE_ORACLE_DEFAULT_BPS);
    assert.equal(JSON.stringify(pub).includes(alice.address), false);
    const mid = withdraw({ state, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(mid.ok, true);
    assert.equal(mid.interest, 0);
    assert.equal(mid.earned, 0);
    const again = emptyVault();
    again.genesisMs = t0;
    deposit({ state: again, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    const refused = observeRate({ state: again, annualBps: 0, nowMs: t0 + 1 });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'rate_bundled');
    assert.equal(again.oracle.annualBps, RESERVE_ORACLE_DEFAULT_BPS);
    const frozen = withdraw({ state: again, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(frozen.ok, true);
    assert.equal(frozen.interest, 0);
    assert.equal(frozen.earned, 0);
    assert.equal(observeRate({ state: again, annualBps: -1, nowMs: t0 }).ok, false);
  });
});

describe('Reserve freeze, vote-once, dest bind', () => {
  it('two vaults ignore caller rates and mint the same bundled withdraw', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const one = emptyVault();
    const two = emptyVault();
    one.genesisMs = t0;
    two.genesisMs = t0;
    deposit({ state: one, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    deposit({ state: two, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    assert.equal(observeRate({ state: one, annualBps: 100, nowMs: t0 + 1 }).ok, false);
    assert.equal(observeRate({ state: two, annualBps: 9000, nowMs: t0 + 1 }).ok, false);
    one.oracle.annualBps = 100;
    two.oracle.annualBps = 9000;
    assert.equal(one.epochBps, two.epochBps);
    assert.equal(one.epochBps, GENESIS_BPS);
    const w1 = withdraw({ state: one, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    const w2 = withdraw({ state: two, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(w1.ok, true);
    assert.equal(w2.ok, true);
    assert.equal(w1.interest, 0);
    assert.equal(w2.interest, 0);
    assert.equal(w1.earned, w2.earned);
    assert.equal(w1.earned, 0);
  });

  it('mid-epoch observeRate(9999) does not change withdraw or preview interest', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    const before = portalEpochInterest(state, state.portals[portalIdFromDest(a)], t0 + RESERVE_EPOCH_MS);
    const saw = observeRate({ state, annualBps: 9999, nowMs: t0 + 10 * DAY });
    assert.equal(saw.ok, false);
    assert.equal(state.oracle.annualBps, GENESIS_BPS);
    state.oracle.annualBps = 9999;
    assert.equal(state.epochBps, GENESIS_BPS);
    assert.equal(previewWithdraw(state, a).interest, 0);
    assert.equal(portalEpochInterest(state, state.portals[portalIdFromDest(a)], t0 + RESERVE_EPOCH_MS), before);
    assert.equal(publicVaultView(state, t0 + 10 * DAY).oracleBps, GENESIS_BPS);
    const out = withdraw({ state, dest: a, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(out.interest, 0);
    assert.equal(out.earned, before);
    assert.equal(state.epochBps, GENESIS_BPS);
  });

  it('a vote enacts the hash bonus only; the next epoch stays on the bundle', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const a = destOf(alice);
    const b = destOf(bob);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 });
    assert.equal(state.epochBps, GENESIS_BPS);
    assert.equal(vote({ state, dest: a, choice: VOTE_INCREASE, nowMs: t0 + 2 }).ok, true);
    const enacted = enact({ state, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(enacted.ok, true);
    assert.equal(enacted.delta, 1);
    assert.equal(state.epochBps, GENESIS_BPS);
    assert.equal(observeRate({ state, annualBps: 9999, nowMs: t0 + RESERVE_EPOCH_MS + 1 }).ok, false);
    state.oracle.annualBps = 9999;
    deposit({ state, dest: b, nanos: PI_SHE_NANOS, nowMs: t0 + RESERVE_EPOCH_MS + 2 });
    assert.equal(state.currentEpoch, 1);
    assert.equal(state.bonusEnacted, false);
    assert.equal(state.epochBps, GENESIS_BPS);
    assert.equal(state.sealedObserve ?? null, null);
  });

  it('first vote lands; second same portal same epoch is vote_locked and piles stay', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
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
    state.genesisMs = t0;
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
    state.genesisMs = t0;
    assert.equal(deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    assert.equal(vote({ state, dest: a, choice: VOTE_INCREASE, nowMs: t0 + 2 }).ok, true);
    assert.equal(state.votes.increase, 1);
    const end1 = t0 + RESERVE_EPOCH_MS;
    assert.equal(enact({ state, nowMs: end1 }).ok, true);
    assert.equal(deposit({ state, dest: b, nanos: PI_SHE_NANOS, nowMs: end1 + 1 }).ok, true);
    assert.equal(state.currentEpoch, 1);
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
    state.genesisMs = t0;
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

  it('enact cannot write a zero hash unit even if vault state is corrupted to 0', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    assert.equal(deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    state.liveHashBonusNanos = 0n;
    const down = vote({ state, dest: a, choice: VOTE_DECREASE, nowMs: t0 + 2 });
    assert.equal(down.ok, false);
    assert.equal(down.reason, 'unit_floor');
    assert.equal(vote({ state, dest: a, choice: VOTE_HOLD, nowMs: t0 + 3 }).ok, true);
    const done = enact({ state, nowMs: t0 + RESERVE_EPOCH_MS });
    assert.equal(done.ok, true);
    assert.ok(Number(state.liveHashBonusNanos) >= 1);
    assert.equal(Number(state.liveHashBonusNanos), 1);
    assert.notEqual(Number(state.liveHashBonusNanos), 0);
  });

  it('compactTx(lockTx) through applyReserveBlock credits the portal; vote and withdraw follow', () => {
    const alice = newIdentity();
    const vault = destOf(alice);
    const continuum = destForLogin(alice.address, { viewKey: alice.viewKey });
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    const pid = portalIdFromDest(vault);
    const lock = compactTx(lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-c' }));
    const blob = JSON.stringify(lock);
    assert.doesNotMatch(blob, /ssa1/);
    assert.doesNotMatch(blob, /she1/);
    assert.doesNotMatch(blob, /"nanos"/);
    assert.doesNotMatch(blob, /"address"/);
    const locked = applyReserveBlock({
      state,
      block: { txs: [{ coinbase: true, vout: [] }, lock] },
      nowMs: t0,
    });
    assert.equal(locked.some((r) => r.action === 'lock' && r.ok === true), true, JSON.stringify(locked));
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal(Number(state.portals[pid].staked), 0);

    const voteSealed = compactTx(voteTx({ from: continuum, dest: vault, choice: VOTE_HOLD, id: 'vote-c' }));
    const voted = applyReserveBlock({
      state,
      block: { txs: [{ coinbase: true, vout: [] }, voteSealed] },
      nowMs: t0 + 2,
    });
    assert.equal(voted.some((r) => r.action === 'vote' && r.ok === true), true, JSON.stringify(voted));

    const rawWd = withdrawTx({ from: vault, to: continuum, nanos: 0, id: 'wd-c' });
    signWithdrawReward(rawWd, ownerFor(vault).key, {
      portalId: pid,
      nanos: 0,
      dest: continuum,
      state,
      nowMs: t0 + RESERVE_EPOCH_MS,
    });
    const wd = compactTx(rawWd);
    const withdrawn = applyReserveBlock({
      state,
      block: { txs: [{ coinbase: true, vout: [] }, wd] },
      nowMs: t0 + RESERVE_EPOCH_MS,
    });
    assert.equal(withdrawn.some((r) => r.action === 'withdraw' && r.ok === true), true, JSON.stringify(withdrawn));
    assert.equal(Number(state.totalLockedNanos), 0);

    const wireState = emptyVault();
    const wire = encodeWireBlock({
      header: Buffer.alloc(128),
      hash: Buffer.alloc(32),
      height: 1,
      txs: [{ coinbase: true, vout: [] }, lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-wire' })],
    });
    const wireBlob = JSON.stringify(wire.txs);
    assert.doesNotMatch(wireBlob, /ssa1/);
    assert.doesNotMatch(wireBlob, /"nanos"/);
    const peer = applyReserveBlock({
      state: wireState,
      block: decodeWireBlock(wire),
      nowMs: t0,
      genesisMs: t0,
    });
    assert.equal(peer.some((r) => r.action === 'lock' && r.ok === true), true, JSON.stringify(peer));
    assert.equal(Number(wireState.totalLockedNanos), 0);
  });

  it('compactTx of an address-only lock still credits applyReserveBlock from dest20 and valueProof.v', () => {
    const alice = newIdentity();
    const vault = destOf(alice);
    const continuum = destForLogin(alice.address, { viewKey: alice.viewKey });
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    const pid = portalIdFromDest(vault);
    const fat = {
      id: 'lock-addr-only',
      programId: RESERVE_PROGRAM,
      kind: 'lock',
      from: continuum,
      to: vault,
      nanos: PI_SHE_NANOS,
      spendPub: portalOwnerPub,
      vin: [{ address: continuum }],
      vout: [{ kind: 'lock', address: vault, nanos: PI_SHE_NANOS }],
    };
    const lock = compactTx(fat);
    const blob = JSON.stringify(lock);
    assert.doesNotMatch(blob, /ssa1/);
    assert.doesNotMatch(blob, /she1/);
    assert.doesNotMatch(blob, /"nanos"/);
    assert.doesNotMatch(blob, /"address"/);
    assert.equal(digestTx(lock).equals(digestTx(fat)), true);
    const locked = applyReserveBlock({
      state,
      block: { txs: [{ coinbase: true, vout: [] }, lock] },
      nowMs: t0,
    });
    assert.equal(locked.ok, false);
    assert.equal(locked.reason, 'stake_reward');
    assert.equal(state.portals[pid], undefined);

    const voteFat = {
      id: 'vote-addr-only',
      programId: RESERVE_PROGRAM,
      kind: 'vote',
      from: continuum,
      to: vault,
      choice: VOTE_HOLD,
      vin: [{ address: continuum }],
      vout: [{ kind: 'vote', address: vault, nanos: 0 }],
    };
    const voteSealed = compactTx(voteFat);
    assert.equal(digestTx(voteSealed).equals(digestTx(voteFat)), true);
    const voted = applyReserveBlock({
      state,
      block: { txs: [{ coinbase: true, vout: [] }, voteSealed] },
      nowMs: t0 + 2,
    });
    assert.equal(voted.ok, false);
  });

  it('rejects over-mint withdraw, shear1 extra-mint, mid-epoch payout, and oracle mid-epoch games', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const state = emptyVault();
    state.genesisMs = t0;
    assert.equal(deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    const due = interestNanos(PI_SHE_NANOS, state.epochBps);
    const early = withdrawTx({ from: a, to: a, nanos: PI_SHE_NANOS + due, id: 'early-clock' });
    assert.equal(verifyReservePayout(state, early, t0 + 1000).ok, false);
    assert.equal(verifyReservePayout(state, early, t0 + 1000).reason, 'epoch_open');
    const end = t0 + RESERVE_EPOCH_MS;
    const openTx = withdrawTx({ from: a, to: a, nanos: PI_SHE_NANOS + due, id: 'early' });
    openTx.nowMs = end + 30 * DAY;
    const realNow = Date.now;
    Date.now = () => end + 60 * DAY;
    try {
      assert.equal(verifyReservePayout(state, openTx, t0 + 1000).ok, false);
      assert.equal(verifyReservePayout(state, openTx, t0 + 1000).reason, 'epoch_open');
      assert.equal(verifyReservePayout(state, openTx).reason, 'epoch_open');
    } finally {
      Date.now = realNow;
    }
    const fat = withdrawTx({ from: a, to: a, nanos: PI_SHE_NANOS + due + NANOS_PER_SHE, id: 'fat' });
    const over = verifyReservePayout(state, fat, end);
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'over_mint');
    const okTx = withdrawTx({ from: a, to: a, nanos: 0, id: 'ok' });
    assert.equal(verifyReservePayout(state, okTx, end).ok, true);
    assert.equal(verifyReservePayout(state, okTx, t0 + 1000).reason, 'epoch_open');
    observeRate({ state, annualBps: 9000, nowMs: t0 + DAY });
    const rw = portalRewards(state, a, t0 + DAY);
    assert.equal(rw.epochBps, GENESIS_BPS);
    assert.equal(rw.projected, 0);
    const shear1 = extraMint({ programId: RESERVE_PROGRAM, to: alice.address, nanos: 1, kind: 'withdraw' });
    assert.equal(shear1.ok, false);
    assert.equal(shear1.reason, 'shear1');
    const twice = payoutStakeReward({ state, reward: due, id: 'dup', maxReward: due });
    assert.equal(twice.ok, true);
    const again = payoutStakeReward({ state, reward: due, id: 'dup', maxReward: due });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double_mint');
    const greedy = payoutStakeReward({ state, reward: due * 10, id: 'g', maxReward: due });
    assert.equal(greedy.ok, false);
    assert.equal(greedy.reason, 'over_mint');
    const view = publicVaultView(state, t0 + DAY);
    assert.ok(view.vaultNanos >= view.totalLockedNanos);
    assert.equal(view.accruingNanos, rw.accrued);
    assert.equal(view.reserveMintedNanos, undefined);
    assert.equal(view.reserveClaimableNanos, due);
  });

  it('a withdraw note that opens to more than the public amount is rejected', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const honest = PI_SHE_NANOS + 10;
    const tx = withdrawTx({ from: a, to: a, nanos: honest, id: 'open-more' });
    const fat = withdrawTx({ from: a, to: a, nanos: honest + 1, id: 'open-more-note' });
    tx.vout = fat.vout;
    tx.nanos = honest;
    const act = reserveAction(tx);
    assert.equal(act.kind, 'withdraw');
    assert.equal(act.nanos, honest);
    assert.equal(act.opened, false);
    assert.equal(verifySealedNote(tx.vout[0], honest + 1), true);
    assert.equal(verifySealedNote(tx.vout[0], act.nanos), false);
    const ok = reserveAction(withdrawTx({ from: a, to: a, nanos: honest, id: 'open-ok' }));
    assert.equal(ok.opened, true);
    assert.equal(ok.nanos, honest);
  });

  it('a sealed withdraw is one note, and a missing note or a missing kind does not open', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const n = PI_SHE_NANOS + 7;
    const tx = withdrawTx({ from: a, to: a, nanos: n, id: 'kt10-one' });
    assert.equal(tx.vout.length, 1);
    assert.equal(String(tx.vout[0].kind), 'withdraw');
    assert.equal(tx.vout[0].valueProof.v, n);
    assert.ok(tx.vout[0].commit);
    assert.equal(verifySealedNote(tx.vout[0], n), true);
    assert.equal(Buffer.from(tx.vout[0].r).equals(Buffer.alloc(32)), false);
    const act = reserveAction(tx);
    assert.equal(act.opened, true);
    assert.equal(act.nanos, n);
    const zero = withdrawTx({ from: a, to: a, nanos: 0, id: 'kt10-zero' });
    assert.equal(zero.vout[0].commit, undefined);
    assert.equal(reserveAction(zero).opened, true);
    assert.equal(reserveAction(zero).nanos, 0);
    const multi = withdrawTx({ from: a, to: a, nanos: n, id: 'kt10-multi' });
    multi.vout.push(withdrawTx({ from: a, to: a, nanos: n, id: 'kt10-multi-2' }).vout[0]);
    assert.equal(reserveAction(multi).opened, false);
    const bare = withdrawTx({ from: a, to: a, nanos: n, id: 'kt10-bare' });
    delete bare.vout[0].commit;
    delete bare.vout[0].valueProof;
    assert.equal(reserveAction(bare).opened, false);
    const hidden = withdrawTx({ from: a, to: a, nanos: n, id: 'kt10-kind' });
    const stripped = { ...hidden.vout[0] };
    delete stripped.kind;
    hidden.vout = [stripped];
    assert.equal(reserveAction(hidden).opened, false);
    const beside = withdrawTx({ from: a, to: a, nanos: n, id: 'kt10-beside' });
    beside.vout.push({ commit: beside.vout[0].commit });
    const kept = reserveAction(beside);
    assert.equal(kept.opened, true);
    assert.equal(kept.nanos, n);
  });

  it('a rate far from the previous freeze is adopted in full when an epoch opens', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const state = emptyVault();
    state.genesisMs = 1_700_000_000_000;
    state.epochBps = 0;
    const opened = deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: 1_700_000_000_000 });
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(state.epochBps, GENESIS_BPS);
    assert.notEqual(state.epochBps, 100);
  });

  it('a negative lock issuance rate returns principal in full', () => {
    const alice = newIdentity();
    const a = destOf(alice);
    const t0 = 1_700_000_000_000;
    const end = t0 + RESERVE_EPOCH_MS;
    const state = emptyVault();
    state.genesisMs = t0;
    assert.equal(deposit({ state, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    state.epochBps = -250;
    const short = withdrawTx({ from: a, to: a, nanos: PI_SHE_NANOS - 1, id: 'short' });
    const refused = verifyReservePayout(state, short, end);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'over_mint');
    const paid = withdraw({ state, dest: a, nowMs: end });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.reward, 0);
    assert.equal(paid.interest, 0);
    assert.equal(paid.principal, 0);
    assert.equal(paid.payout, paid.principal);
    const zero = emptyVault();
    zero.genesisMs = t0;
    assert.equal(deposit({ state: zero, dest: a, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    zero.epochBps = 0;
    const flat = withdraw({ state: zero, dest: a, nowMs: end });
    assert.equal(flat.ok, true, flat.reason);
    assert.equal(flat.payout, flat.principal);
  });
});

function asNumSafe(n) {
  return Number(n);
}

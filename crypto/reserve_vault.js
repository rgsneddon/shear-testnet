import { createHash } from 'node:crypto';
import {
  RESERVE_PROGRAM,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_JOIN_CUTOFF_MS,
  extraMintAllowed,
  NANOS_PER_SHE,
  HASH_BONUS_NANOS_FLOOR,
} from './asert.js';
import { isDestAddress, isShearAddress, hash20FromAddress } from './address.js';
import { sealCoinbaseNote, verifySealedNote } from './note.js';
import {
  emptyOracle,
  interestNanos,
  accruedNanos,
  observeRate as observeOracleRate,
  freezeEpochBps,
  GENESIS_BPS,
} from './reserve_oracle.js';
import { extraMint } from './mint.js';
import { splitLevy } from './levy.js';

export const VOTE_INCREASE = 'increase bonus';
export const VOTE_DECREASE = 'decrease bonus';
export const VOTE_HOLD = 'leave bonus as-is';
export const KIND_LOCK = 'lock';
export const KIND_WITHDRAW = 'withdraw';
export const KIND_VOTE = 'vote';

function asBig(n) {
  if (typeof n === 'bigint') return n < 0n ? 0n : n;
  const v = Math.floor(Number(n) || 0);
  if (!Number.isFinite(v) || v <= 0) return 0n;
  return BigInt(v);
}

function asNum(n) {
  return Number(asBig(n));
}

export function portalIdFromDest(dest) {
  const d = String(dest || '');
  return createHash('sha256').update('shear-portal-v1').update(d).digest('hex');
}

export function withdrawMintId(portalId, epoch) {
  return createHash('sha256')
    .update(RESERVE_PROGRAM)
    .update(String(portalId || ''))
    .update(String(epoch || 0))
    .update('withdraw')
    .digest('hex');
}

export function emptyVault() {
  return {
    programId: RESERVE_PROGRAM,
    epochStartMs: 0,
    currentEpoch: 0,
    bonusEnacted: false,
    liveHashBonusNanos: 1n,
    totalLockedNanos: 0n,
    feeBankNanos: 0n,
    mintBankNanos: 0n,
    mintedIds: Object.create(null),
    portals: Object.create(null),
    votes: { increase: 0, decrease: 0, hold: 0 },
    oracle: emptyOracle(),
    epochBps: GENESIS_BPS,
    enactedUp: 0,
    enactedDown: 0,
    enactedHold: 0,
    enactedDelta: 0,
    enactedLiveBonus: 1,
    enactedAtMs: 0,
    enactedAtEpoch: 0,
  };
}

export function creditFeeBank(state, nanos) {
  const n = asBig(nanos);
  state.feeBankNanos = asBig(state.feeBankNanos) + n;
  return asNum(state.feeBankNanos);
}

/** Stake rewards pay from the fee bank first; mint only the shortfall. */
export function payoutStakeReward({
  state,
  reward = 0,
  gateOk = true,
  id = 'reward',
} = {}) {
  const vault = state || emptyVault();
  vault.mintedIds = vault.mintedIds || Object.create(null);
  if (!gateOk) return { ok: false, reason: 'gate_wait', paid: 0, minted: 0, feeBank: asNum(vault.feeBankNanos) };
  if (vault.mintedIds[id]) return { ok: false, reason: 'double_mint', paid: 0, minted: 0, feeBank: asNum(vault.feeBankNanos) };
  const need = asBig(reward);
  const bank = asBig(vault.feeBankNanos);
  const fromFee = need < bank ? need : bank;
  const gap = need - fromFee;
  if (gap > 0n) {
    if (!extraMintAllowed(RESERVE_PROGRAM, {
      feeFirst: true,
      gateOk: true,
      reward: asNum(need),
      feeBank: asNum(bank),
      amount: asNum(gap),
    })) {
      return { ok: false, reason: 'mint_forbidden', paid: 0, minted: 0, feeBank: asNum(bank) };
    }
  }
  vault.feeBankNanos = bank - fromFee;
  vault.mintedIds[id] = true;
  if (gap > 0n) vault.mintBankNanos = asBig(vault.mintBankNanos) + gap;
  return {
    ok: true,
    paid: asNum(need),
    fromFee: asNum(fromFee),
    minted: asNum(gap),
    feeBank: asNum(vault.feeBankNanos),
    id,
  };
}

export function remainingMs(state, nowMs) {
  if (!state.epochStartMs || state.bonusEnacted) return RESERVE_EPOCH_MS;
  const end = state.epochStartMs + RESERVE_EPOCH_MS;
  return Math.max(0, end - nowMs);
}

export function canJoin(state, nowMs) {
  if (!state.epochStartMs) return true;
  return remainingMs(state, nowMs) >= RESERVE_JOIN_CUTOFF_MS;
}

export function canVote(stakedNanos, idleNanos = 0) {
  return asBig(stakedNanos) + asBig(idleNanos) >= BigInt(PI_SHE_NANOS);
}

function votesView(state) {
  if (state.bonusEnacted) {
    return {
      increase: Number(state.enactedUp || 0),
      decrease: Number(state.enactedDown || 0),
      hold: Number(state.enactedHold || 0),
    };
  }
  return { ...state.votes };
}

export function publicVaultView(state, nowMs) {
  let totalStaked = 0n;
  let totalIdle = 0n;
  let totalAccrued = 0n;
  let totalClaimable = 0n;
  const bps = Number(state.epochBps ?? GENESIS_BPS);
  const elapsed = elapsedMs(state, nowMs);
  for (const p of Object.values(state.portals || {})) {
    const staked = asBig(p.staked);
    const idle = asBig(p.idle);
    totalStaked += staked;
    totalIdle += idle;
    totalAccrued += asBig(accruedNanos(staked, bps, elapsed));
    totalClaimable += asBig(p.claimableRewards);
  }
  return {
    programId: RESERVE_PROGRAM,
    epochStartMs: state.epochStartMs || 0,
    remainingMs: remainingMs(state, nowMs),
    totalLockedNanos: asNum(state.totalLockedNanos),
    totalStakedNanos: asNum(totalStaked),
    totalIdleNanos: asNum(totalIdle),
    totalAccruedNanos: asNum(totalAccrued),
    totalClaimableNanos: asNum(totalClaimable),
    feeBankNanos: asNum(state.feeBankNanos),
    mintBankNanos: asNum(state.mintBankNanos),
    votes: votesView(state),
    oracleBps: state.oracle?.annualBps ?? 0,
    epochBps: Number(state.epochBps ?? GENESIS_BPS),
    liveHashBonusNanos: asNum(state.liveHashBonusNanos || 1n),
    bonusEnacted: !!state.bonusEnacted,
    currentEpoch: Number(state.currentEpoch || 0),
    enactedUp: Number(state.enactedUp || 0),
    enactedDown: Number(state.enactedDown || 0),
    enactedHold: Number(state.enactedHold || 0),
    enactedDelta: Number(state.enactedDelta || 0),
    enactedLiveBonus: Number(state.enactedLiveBonus || 0),
    enactedAtMs: Number(state.enactedAtMs || 0),
    enactedAtEpoch: Number(state.enactedAtEpoch || 0),
  };
}

function portalOf(state, dest) {
  const id = portalIdFromDest(dest);
  if (!state.portals[id]) {
    state.portals[id] = { id, staked: 0n, idle: 0n, vote: null, joined: false, voteEpoch: 0 };
  }
  return state.portals[id];
}

function beginEpoch(state, nowMs) {
  state.epochStartMs = nowMs;
  state.bonusEnacted = false;
  state.epochBps = freezeEpochBps({
    prevEpochBps: state.epochBps ?? GENESIS_BPS,
    annualBps: state.oracle?.annualBps,
    observedAtMs: state.oracle?.observedAtMs,
    nowMs,
  });
}

function portalPublic(p) {
  return {
    id: p.id,
    staked: asNum(p.staked),
    idle: asNum(p.idle),
    nanos: asNum(asBig(p.staked) + asBig(p.idle)),
    joined: p.joined,
    vote: p.vote,
  };
}

export function deposit({ state, dest, nanos, nowMs, payout } = {}) {
  if (!isDestAddress(dest) || isShearAddress(dest)) {
    return { ok: false, reason: 'bad_dest' };
  }
  const n = asBig(nanos);
  if (n <= 0n) return { ok: false, reason: 'bad_amount' };
  const p = portalOf(state, dest);
  if (payout && isDestAddress(payout) && !isShearAddress(payout)) {
    if (!p.payout) p.payout = payout;
  }
  if (state.epochStartMs && !state.bonusEnacted && remainingMs(state, nowMs) === 0) {
    return { ok: false, reason: 'need_enact' };
  }
  const staking = canJoin(state, nowMs);
  if (staking) p.staked = asBig(p.staked) + n;
  else p.idle = asBig(p.idle) + n;
  state.totalLockedNanos = asBig(state.totalLockedNanos) + n;
  if (!p.joined && (asBig(p.staked) + asBig(p.idle)) >= BigInt(PI_SHE_NANOS)) {
    p.joined = true;
    if (!state.epochStartMs) {
      state.currentEpoch = 1;
      beginEpoch(state, nowMs);
    } else if (state.bonusEnacted) {
      state.currentEpoch = (state.currentEpoch || 1) + 1;
      state.votes = { increase: 0, decrease: 0, hold: 0 };
      beginEpoch(state, nowMs);
    }
  }
  return {
    ok: true,
    idle: !staking,
    portal: portalPublic(p),
  };
}

export function vote({ state, dest, choice, nowMs }) {
  nowMs;
  if (!isDestAddress(dest) || isShearAddress(dest)) {
    return { ok: false, reason: 'bad_dest' };
  }
  const p = portalOf(state, dest);
  if (!p.joined || !canVote(p.staked, p.idle)) return { ok: false, reason: 'not_voter' };
  if (!state.epochStartMs) return { ok: false, reason: 'not_voter' };
  if (state.bonusEnacted) return { ok: false, reason: 'epoch_closed' };
  const allowed = [VOTE_INCREASE, VOTE_DECREASE, VOTE_HOLD];
  if (!allowed.includes(choice)) return { ok: false, reason: 'bad_vote' };
  if (choice === VOTE_DECREASE && asNum(state.liveHashBonusNanos || 1n) <= HASH_BONUS_NANOS_FLOOR) {
    return { ok: false, reason: 'unit_floor' };
  }
  const first = !p.vote || p.voteEpoch !== state.currentEpoch;
  if (!first) return { ok: false, reason: 'vote_locked' };
  p.vote = choice;
  p.voteEpoch = state.currentEpoch;
  if (choice === VOTE_INCREASE) state.votes.increase += 1;
  if (choice === VOTE_DECREASE) state.votes.decrease += 1;
  if (choice === VOTE_HOLD) state.votes.hold += 1;
  return {
    ok: true,
    portal: portalPublic(p),
  };
}

export function observeRate({ state, annualBps, nowMs }) {
  if (!state.oracle) state.oracle = emptyOracle({ nowMs });
  return observeOracleRate(state.oracle, { annualBps, nowMs });
}

export function reserveInterestNanos(stakedNanos, oracleOrBps) {
  const bps = typeof oracleOrBps === 'number' || typeof oracleOrBps === 'bigint'
    ? oracleOrBps
    : (oracleOrBps?.epochBps ?? oracleOrBps?.annualBps ?? 0);
  return interestNanos(stakedNanos, bps);
}

export function elapsedMs(state, nowMs) {
  if (!state.epochStartMs) return 0;
  return Math.max(0, Math.min(Number(nowMs) - state.epochStartMs, RESERVE_EPOCH_MS));
}

/** Per-portal accrued rewards for the owning wallet. Idle SHE earns nothing. */
export function portalRewards(state, dest, nowMs) {
  const p = portalOf(state, dest);
  const bps = Number(state.epochBps ?? GENESIS_BPS);
  const elapsed = elapsedMs(state, nowMs);
  return {
    accrued: accruedNanos(p.staked, bps, elapsed),
    projected: reserveInterestNanos(p.staked, bps),
    staked: asNum(p.staked),
    idle: asNum(p.idle),
    oracleBps: bps,
    epochBps: bps,
    elapsedMs: elapsed,
  };
}

function continuumOf(p, payout, dest) {
  const want = payout || p.payout;
  if (want && isDestAddress(want) && !isShearAddress(want)) return want;
  return dest;
}

export function previewWithdraw(state, dest) {
  const p = portalOf(state, dest);
  const principal = asNum(asBig(p.staked) + asBig(p.idle));
  const interest = reserveInterestNanos(p.staked, state.epochBps);
  return {
    principal,
    staked: asNum(p.staked),
    idle: asNum(p.idle),
    interest,
    payout: principal + interest,
    to: continuumOf(p, null, dest),
  };
}

function sealedReserveVout(to, n, kind) {
  const d20 = hash20FromAddress(to);
  if (!d20) return { address: to, nanos: n, kind };
  const note = sealCoinbaseNote(n, { dest20: d20, kind });
  return { ...note, address: to };
}

export function lockTx({ from, to, nanos, id }) {
  const n = Math.floor(Number(nanos));
  return {
    id,
    programId: RESERVE_PROGRAM,
    kind: KIND_LOCK,
    from,
    to,
    nanos: n,
    vin: [{ address: from }],
    vout: [sealedReserveVout(to, n, KIND_LOCK)],
  };
}

export function withdrawTx({ from, to, nanos, id }) {
  const n = Math.floor(Number(nanos));
  return {
    id,
    programId: RESERVE_PROGRAM,
    mint: true,
    kind: KIND_WITHDRAW,
    from,
    to,
    nanos: n,
    vin: [],
    vout: [sealedReserveVout(to, n, KIND_WITHDRAW)],
  };
}

export function voteTx({ from, dest, choice, id }) {
  return {
    id,
    programId: RESERVE_PROGRAM,
    kind: KIND_VOTE,
    from,
    to: dest,
    choice,
    vin: [{ address: from }],
    vout: [{ address: dest, nanos: 0, kind: KIND_VOTE }],
  };
}

function txDest(tx) {
  return tx?.to || tx?.vout?.[0]?.address || '';
}

function txFrom(tx) {
  return tx?.from || tx?.vin?.[0]?.address || '';
}

function txNanos(tx) {
  const claimed = Math.floor(Number(tx?.nanos || tx?.vout?.[0]?.nanos || 0));
  const o = tx?.vout?.[0];
  if (o?.commit && o?.valueProof) {
    return verifySealedNote(o, claimed) ? claimed : 0;
  }
  return claimed;
}

function txKind(tx) {
  return String(tx?.kind || tx?.vout?.[0]?.kind || '');
}

export function verifyReservePayout(state, tx) {
  if (txKind(tx) !== KIND_WITHDRAW) return { ok: true };
  const dest = txFrom(tx);
  const to = txDest(tx);
  const p = state?.portals?.[portalIdFromDest(dest)];
  if (p?.payout && to && to !== p.payout) return { ok: false, reason: 'payout_mismatch' };
  return { ok: true };
}

/** Honour Reserve lock / vote / withdraw txs already sealed in a block. */
export function applyReserveBlock({ state, block, nowMs }) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const results = [];
  // First block whose time is past the epoch collates votes into the live
  // hash bonus. Winning plurality moves the bonus by ±1. Height is unchanged.
  if (state.epochStartMs && !state.bonusEnacted && nowMs >= state.epochStartMs + RESERVE_EPOCH_MS) {
    results.push({ action: 'enact', ...enact({ state, nowMs }) });
  }
  const cb = txs.find((t) => t?.coinbase) || txs[0];
  const userFees = txs.filter((t) => t && !t.coinbase)
    .reduce((a, t) => a + Math.max(0, Math.floor(Number(t.fee || 0))), 0);
  if ((cb?.vout || []).some((o) => o?.kind === 'reserve-fee')) {
    creditFeeBank(state, splitLevy(userFees).reserve);
  }
  for (const tx of txs) {
    if (!tx || tx.coinbase) continue;
    if (String(tx.programId || '') !== RESERVE_PROGRAM) continue;
    const kind = txKind(tx);
    if (kind === KIND_LOCK) {
      results.push({
        action: KIND_LOCK,
        ...deposit({
          state,
          dest: txDest(tx),
          nanos: txNanos(tx),
          nowMs,
          payout: txFrom(tx),
        }),
      });
      continue;
    }
    if (kind === KIND_VOTE) {
      results.push({
        action: KIND_VOTE,
        ...vote({ state, dest: txDest(tx) || txFrom(tx), choice: tx.choice, nowMs }),
      });
      continue;
    }
    if (kind === KIND_WITHDRAW) {
      results.push({
        action: KIND_WITHDRAW,
        ...withdraw({
          state,
          dest: txFrom(tx),
          nowMs,
          payout: txDest(tx),
        }),
      });
    }
  }
  return results;
}

export function enact({ state, nowMs } = {}) {
  if (!state.epochStartMs || nowMs < state.epochStartMs + RESERVE_EPOCH_MS) {
    return { ok: false, reason: 'epoch_open' };
  }
  if (state.bonusEnacted) return { ok: false, reason: 'already_enacted' };
  const up = Number(state.votes.increase || 0);
  const down = Number(state.votes.decrease || 0);
  const hold = Number(state.votes.hold || 0);
  const m = Math.max(up, down, hold);
  let winners = 0;
  let delta = 0;
  if (m > 0 && up === m) { winners += 1; delta = 1; }
  if (m > 0 && down === m) { winners += 1; delta = -1; }
  if (m > 0 && hold === m) { winners += 1; delta = 0; }
  let live = asNum(state.liveHashBonusNanos || 1n);
  if (winners === 1 && delta > 0) live += 1;
  else if (winners === 1 && delta < 0) {
    if (live <= HASH_BONUS_NANOS_FLOOR) {
      delta = 0;
    } else {
      live -= 1;
    }
  }
  state.liveHashBonusNanos = BigInt(live);
  state.bonusEnacted = true;
  state.enactedUp = up;
  state.enactedDown = down;
  state.enactedHold = hold;
  state.enactedDelta = winners === 1 ? delta : 0;
  state.enactedLiveBonus = live;
  state.enactedAtMs = nowMs;
  state.enactedAtEpoch = Number(state.currentEpoch || 0);
  return {
    ok: true,
    liveHashBonusNanos: live,
    delta: winners === 1 ? delta : 0,
    enactedUp: up,
    enactedDown: down,
    enactedHold: hold,
  };
}

export function withdraw({ state, dest, nowMs, payout } = {}) {
  if (!isDestAddress(dest) || isShearAddress(dest)) {
    return { ok: false, reason: 'bad_dest' };
  }
  if (!state.epochStartMs || nowMs < state.epochStartMs + RESERVE_EPOCH_MS) {
    return { ok: false, reason: 'epoch_open' };
  }
  if (!state.bonusEnacted) {
    const did = enact({ state, nowMs });
    if (!did.ok) return did;
  }
  const p = portalOf(state, dest);
  if (p.payout && payout && payout !== p.payout) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  const staked = asNum(p.staked);
  const idle = asNum(p.idle);
  const principal = staked + idle;
  if (principal <= 0) return { ok: false, reason: 'empty' };
  const to = continuumOf(p, payout, dest);
  const interest = reserveInterestNanos(p.staked, state.epochBps);
  let mint = null;
  if (interest > 0) {
    const mintId = withdrawMintId(p.id, state.currentEpoch);
    const paid = payoutStakeReward({ state, reward: interest, id: mintId, gateOk: true });
    if (!paid.ok) return { ok: false, reason: paid.reason };
    mint = extraMint({ programId: RESERVE_PROGRAM, to, nanos: interest });
    if (!mint.ok) return { ok: false, reason: mint.reason };
  } else if (!extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' })) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  state.totalLockedNanos = asBig(state.totalLockedNanos) - asBig(principal);
  if (state.totalLockedNanos < 0n) state.totalLockedNanos = 0n;
  if (Number(p.voteEpoch || 0) === Number(state.currentEpoch || 0)) {
    if (p.vote === VOTE_INCREASE && Number(state.votes.increase) > 0) state.votes.increase -= 1;
    if (p.vote === VOTE_DECREASE && Number(state.votes.decrease) > 0) state.votes.decrease -= 1;
    if (p.vote === VOTE_HOLD && Number(state.votes.hold) > 0) state.votes.hold -= 1;
  }
  if (Number(state.votes.increase) < 0) state.votes.increase = 0;
  if (Number(state.votes.decrease) < 0) state.votes.decrease = 0;
  if (Number(state.votes.hold) < 0) state.votes.hold = 0;
  p.staked = 0n;
  p.idle = 0n;
  p.joined = false;
  p.vote = null;
  p.voteEpoch = 0;
  p.payout = null;
  return {
    ok: true,
    principal,
    staked,
    idle,
    interest,
    payout: principal + interest,
    to,
    mint,
    programId: RESERVE_PROGRAM,
    kind: KIND_WITHDRAW,
  };
}

export function sheFromNanos(n) {
  return asNum(n) / NANOS_PER_SHE;
}

export { asBig, asNum };

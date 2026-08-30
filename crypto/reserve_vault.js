import { createHash } from 'node:crypto';
import {
  RESERVE_PROGRAM,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_JOIN_CUTOFF_MS,
  extraMintAllowed,
  NANOS_PER_SHE,
} from './asert.js';
import { isDestAddress, isShearAddress } from './address.js';
import { emptyOracle, interestNanos, accruedNanos, observeRate as observeOracleRate } from './reserve_oracle.js';
import { extraMint } from './mint.js';

export const VOTE_INCREASE = 'increase bonus';
export const VOTE_DECREASE = 'decrease bonus';
export const VOTE_HOLD = 'leave bonus as-is';
export const KIND_LOCK = 'lock';
export const KIND_WITHDRAW = 'withdraw';
export const KIND_VOTE = 'vote';

export function portalIdFromDest(dest) {
  const d = String(dest || '');
  return createHash('sha256').update('shear-portal-v1').update(d).digest('hex');
}

export function emptyVault() {
  return {
    programId: RESERVE_PROGRAM,
    epochStartMs: 0,
    currentEpoch: 0,
    bonusEnacted: false,
    liveHashBonusNanos: 1,
    totalLockedNanos: 0,
    feeBankNanos: 0,
    mintBankNanos: 0,
    mintedIds: Object.create(null),
    portals: Object.create(null),
    votes: { increase: 0, decrease: 0, hold: 0 },
    oracle: emptyOracle(),
  };
}

export function creditFeeBank(state, nanos) {
  const n = Math.max(0, Math.floor(Number(nanos) || 0));
  state.feeBankNanos = (state.feeBankNanos || 0) + n;
  return state.feeBankNanos;
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
  if (!gateOk) return { ok: false, reason: 'gate_wait', paid: 0, minted: 0, feeBank: vault.feeBankNanos || 0 };
  if (vault.mintedIds[id]) return { ok: false, reason: 'double_mint', paid: 0, minted: 0, feeBank: vault.feeBankNanos || 0 };
  const need = Math.max(0, Math.floor(Number(reward) || 0));
  const bank = Math.max(0, Math.floor(Number(vault.feeBankNanos) || 0));
  const fromFee = Math.min(bank, need);
  const gap = need - fromFee;
  if (gap > 0) {
    if (!extraMintAllowed(RESERVE_PROGRAM, {
      feeFirst: true,
      gateOk: true,
      reward: need,
      feeBank: bank,
      amount: gap,
    })) {
      return { ok: false, reason: 'mint_forbidden', paid: 0, minted: 0, feeBank: bank };
    }
  }
  vault.feeBankNanos = bank - fromFee;
  vault.mintedIds[id] = true;
  if (gap > 0) vault.mintBankNanos = (vault.mintBankNanos || 0) + gap;
  return {
    ok: true,
    paid: need,
    fromFee,
    minted: gap,
    feeBank: vault.feeBankNanos,
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
  return Number(stakedNanos || 0) + Number(idleNanos || 0) >= PI_SHE_NANOS;
}

export function publicVaultView(state, nowMs) {
  return {
    programId: RESERVE_PROGRAM,
    epochStartMs: state.epochStartMs || 0,
    remainingMs: remainingMs(state, nowMs),
    totalLockedNanos: state.totalLockedNanos || 0,
    votes: { ...state.votes },
    oracleBps: state.oracle?.annualBps ?? 0,
    liveHashBonusNanos: Number(state.liveHashBonusNanos || 1),
    bonusEnacted: !!state.bonusEnacted,
    currentEpoch: Number(state.currentEpoch || 0),
  };
}

function portalOf(state, dest) {
  const id = portalIdFromDest(dest);
  if (!state.portals[id]) {
    state.portals[id] = { id, staked: 0, idle: 0, vote: null, joined: false, voteEpoch: 0 };
  }
  return state.portals[id];
}

export function deposit({ state, dest, nanos, nowMs, payout } = {}) {
  if (!isDestAddress(dest) || isShearAddress(dest)) {
    return { ok: false, reason: 'bad_dest' };
  }
  const n = Math.floor(Number(nanos));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'bad_amount' };
  const p = portalOf(state, dest);
  if (payout && isDestAddress(payout) && !isShearAddress(payout)) {
    p.payout = payout;
  }
  if (state.epochStartMs && !state.bonusEnacted && remainingMs(state, nowMs) === 0) {
    return { ok: false, reason: 'need_enact' };
  }
  const staking = canJoin(state, nowMs);
  if (staking) p.staked += n;
  else p.idle += n;
  state.totalLockedNanos += n;
  if (!p.joined && (p.staked + p.idle) >= PI_SHE_NANOS) {
    p.joined = true;
    if (!state.epochStartMs) {
      state.currentEpoch = 1;
      state.epochStartMs = nowMs;
      state.bonusEnacted = false;
    } else if (state.bonusEnacted) {
      state.currentEpoch = (state.currentEpoch || 1) + 1;
      state.epochStartMs = nowMs;
      state.bonusEnacted = false;
      state.votes = { increase: 0, decrease: 0, hold: 0 };
    }
  }
  return {
    ok: true,
    idle: !staking,
    portal: {
      id: p.id,
      staked: p.staked,
      idle: p.idle,
      nanos: p.staked + p.idle,
      joined: p.joined,
      vote: p.vote,
    },
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
  const first = !p.vote || p.voteEpoch !== state.currentEpoch;
  if (!first && remainingMs(state, nowMs) < RESERVE_JOIN_CUTOFF_MS) {
    return { ok: false, reason: 'vote_locked' };
  }
  if (!first) {
    if (p.vote === VOTE_INCREASE) state.votes.increase -= 1;
    if (p.vote === VOTE_DECREASE) state.votes.decrease -= 1;
    if (p.vote === VOTE_HOLD) state.votes.hold -= 1;
  }
  p.vote = choice;
  p.voteEpoch = state.currentEpoch;
  if (choice === VOTE_INCREASE) state.votes.increase += 1;
  if (choice === VOTE_DECREASE) state.votes.decrease += 1;
  if (choice === VOTE_HOLD) state.votes.hold += 1;
  return {
    ok: true,
    portal: {
      id: p.id,
      staked: p.staked,
      idle: p.idle,
      nanos: p.staked + p.idle,
      joined: p.joined,
      vote: p.vote,
    },
  };
}

export function observeRate({ state, annualBps, nowMs }) {
  if (!state.oracle) state.oracle = emptyOracle({ nowMs });
  return observeOracleRate(state.oracle, { annualBps, nowMs });
}

export function reserveInterestNanos(stakedNanos, oracle) {
  return interestNanos(stakedNanos, oracle?.annualBps ?? 0, 400);
}

export function elapsedMs(state, nowMs) {
  if (!state.epochStartMs) return 0;
  return Math.max(0, Math.min(Number(nowMs) - state.epochStartMs, RESERVE_EPOCH_MS));
}

/** Per-portal accrued rewards for the owning wallet. Idle SHE earns nothing. */
export function portalRewards(state, dest, nowMs) {
  const p = portalOf(state, dest);
  const bps = state.oracle?.annualBps ?? 0;
  const elapsed = elapsedMs(state, nowMs);
  return {
    accrued: accruedNanos(p.staked, bps, elapsed),
    projected: reserveInterestNanos(p.staked, state.oracle),
    staked: p.staked || 0,
    idle: p.idle || 0,
    oracleBps: bps,
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
  const principal = (p.staked || 0) + (p.idle || 0);
  const interest = reserveInterestNanos(p.staked, state.oracle);
  return {
    principal,
    staked: p.staked || 0,
    idle: p.idle || 0,
    interest,
    payout: principal + interest,
    to: continuumOf(p, null, dest),
  };
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
    vout: [{ address: to, nanos: n, kind: KIND_LOCK }],
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
    vout: [{ address: to, nanos: n, kind: KIND_WITHDRAW }],
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
  return Math.floor(Number(tx?.nanos || tx?.vout?.[0]?.nanos || 0));
}

function txKind(tx) {
  return String(tx?.kind || tx?.vout?.[0]?.kind || '');
}

/** Honour Reserve lock / vote / withdraw txs already sealed in a block. */
export function applyReserveBlock({ state, block, nowMs }) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const results = [];
  const cb = txs.find((t) => t?.coinbase) || txs[0];
  for (const o of cb?.vout || []) {
    if (o?.kind === 'reserve-fee') creditFeeBank(state, o.nanos);
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
  if (state.epochStartMs && !state.bonusEnacted && nowMs >= state.epochStartMs + RESERVE_EPOCH_MS) {
    results.push({ action: 'enact', ...enact({ state, nowMs }) });
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
  let live = Number(state.liveHashBonusNanos || 1);
  if (winners === 1 && delta > 0) live += 1;
  else if (winners === 1 && delta < 0) live = Math.max(0, live - 1);
  state.liveHashBonusNanos = live;
  state.bonusEnacted = true;
  return { ok: true, liveHashBonusNanos: live, delta: winners === 1 ? delta : 0 };
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
  const staked = p.staked;
  const idle = p.idle;
  const principal = staked + idle;
  if (principal <= 0) return { ok: false, reason: 'empty' };
  const to = continuumOf(p, payout, dest);
  const interest = reserveInterestNanos(staked, state.oracle);
  let mint = null;
  if (interest > 0) {
    mint = extraMint({ programId: RESERVE_PROGRAM, to, nanos: interest });
    if (!mint.ok) return { ok: false, reason: mint.reason };
  } else if (!extraMintAllowed(RESERVE_PROGRAM)) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  state.totalLockedNanos -= principal;
  if (p.vote === VOTE_INCREASE) state.votes.increase -= 1;
  if (p.vote === VOTE_DECREASE) state.votes.decrease -= 1;
  if (p.vote === VOTE_HOLD) state.votes.hold -= 1;
  p.staked = 0;
  p.idle = 0;
  p.joined = false;
  p.vote = null;
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
  return Number(n) / NANOS_PER_SHE;
}

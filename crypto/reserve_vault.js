import { createHash } from 'node:crypto';
import {
  RESERVE_PROGRAM,
  PI_SHE_NANOS,
  RESERVE_JOIN_CUTOFF_MS,
  extraMintAllowed,
  NANOS_PER_SHE,
  HASH_BONUS_NANOS_FLOOR,
  hashBonusUnitNanos,
  MAGIC_TESTNET,
} from './asert.js';
import { isDestAddress, isShearAddress, hash20FromAddress, encodeDest } from './address.js';
import { sealCoinbaseNote, verifySealedNote, asU8 } from './note.js';
import {
  emptyOracle,
  interestNanos,
  accruedNanos,
  GENESIS_BPS,
  RESERVE_ORACLE_MAX_BPS,
  epochRateBps,
  bundleObservationRoot,
  bundledEpochBps,
  ORACLE_QUORUM,
} from './reserve_oracle.js';
import { vortexEpochIndex, epochDays, epochMs, joinCutoffMs, MAGIC_MAINNET } from './pot_sched.js';
import { extraMint } from './mint.js';

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

export function isPortalId(s) {
  return /^[0-9a-f]{64}$/i.test(String(s || ''));
}

function portalKey(destOrId) {
  const s = String(destOrId || '');
  if (isPortalId(s)) return s.toLowerCase();
  if (s && isDestAddress(s) && !isShearAddress(s)) return portalIdFromDest(s);
  return '';
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
    liveHashBonusNanos: BigInt(HASH_BONUS_NANOS_FLOOR),
    totalLockedNanos: 0n,
    programCustodyNanos: 0n,
    feeBankNanos: 0n,
    mintBankNanos: 0n,
    rewardCapNanos: 0n,
    mintedIds: Object.create(null),
    portals: Object.create(null),
    votes: { increase: 0, decrease: 0, hold: 0 },
    oracle: emptyOracle(),
    epochBps: GENESIS_BPS,
    nextEpochBps: GENESIS_BPS,
    freezes: Object.create(null),
    genesisMs: 0,
    magic: MAGIC_TESTNET,
    enactedUp: 0,
    enactedDown: 0,
    enactedHold: 0,
    enactedDelta: 0,
    enactedLiveBonus: 1,
    enactedAtMs: 0,
    enactedAtEpoch: 0,
  };
}

/** Deep copy for fork trial state. Mutating the clone must not touch `state`. */
export function cloneVault(state) {
  const src = state && typeof state === 'object' ? state : emptyVault();
  const raw = JSON.parse(JSON.stringify(src, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const out = emptyVault();
  Object.assign(out, raw);
  out.portals = Object.create(null);
  for (const [k, p] of Object.entries(raw.portals || {})) {
    out.portals[k] = p && typeof p === 'object' ? { ...p } : p;
  }
  out.votes = { increase: 0, decrease: 0, hold: 0, ...(raw.votes || {}) };
  out.mintedIds = Object.create(null);
  Object.assign(out.mintedIds, raw.mintedIds || {});
  out.freezes = Object.create(null);
  Object.assign(out.freezes, raw.freezes || {});
  out.liveHashBonusNanos = asBig(out.liveHashBonusNanos);
  out.totalLockedNanos = asBig(out.totalLockedNanos);
  out.programCustodyNanos = 0n;
  out.feeBankNanos = asBig(out.feeBankNanos);
  out.mintBankNanos = asBig(out.mintBankNanos);
  out.rewardCapNanos = asBig(out.rewardCapNanos);
  out.blankFork = !!src.blankFork;
  delete out.vaultSeal;
  return out;
}

export function creditFeeBank(state, nanos) {
  const n = asBig(nanos);
  state.feeBankNanos = asBig(state.feeBankNanos) + n;
  return asNum(state.feeBankNanos);
}

/**
 * Reserve reward is minted in full by consensus. The fee bank is not read
 * and is not a reward source.
 */
export function payoutStakeReward({
  state,
  reward = 0,
  gateOk = true,
  id = 'reward',
  maxReward = null,
} = {}) {
  const vault = state || emptyVault();
  vault.mintedIds = vault.mintedIds || Object.create(null);
  vault.programCustodyNanos = 0n;
  const bank = asNum(vault.feeBankNanos);
  if (!gateOk) return { ok: false, reason: 'gate_wait', paid: 0, minted: 0, fromFee: 0, feeBank: bank };
  if (vault.mintedIds[id]) return { ok: false, reason: 'double_mint', paid: 0, minted: 0, fromFee: 0, feeBank: bank };
  const need = asBig(reward);
  if (need <= 0n) {
    return { ok: false, reason: 'bad_reward', paid: 0, minted: 0, fromFee: 0, feeBank: bank };
  }
  if (maxReward != null && need > asBig(maxReward)) {
    return { ok: false, reason: 'over_mint', paid: 0, minted: 0, fromFee: 0, feeBank: bank };
  }
  if (!id) {
    return { ok: false, reason: 'need_id', paid: 0, minted: 0, fromFee: 0, feeBank: bank };
  }
  if (!extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw', reward: asNum(need), amount: asNum(need) })) {
    return { ok: false, reason: 'mint_forbidden', paid: 0, minted: 0, fromFee: 0, feeBank: bank };
  }
  vault.mintedIds[id] = true;
  vault.mintBankNanos = asBig(vault.mintBankNanos) + need;
  vault.rewardCapNanos = asBig(vault.rewardCapNanos) + need;
  return {
    ok: true,
    paid: asNum(need),
    fromFee: 0,
    minted: asNum(need),
    feeBank: asNum(vault.feeBankNanos),
    id,
    source: 'coinbase',
  };
}

export function remainingMs(state, nowMs) {
  const span = epochMs(state.magic);
  if (!state.epochStartMs || state.bonusEnacted) return span;
  const end = state.epochStartMs + span;
  return Math.max(0, end - nowMs);
}

export function canJoin(state, nowMs) {
  if (!state.epochStartMs) return true;
  return remainingMs(state, nowMs) >= joinCutoffMs(state.magic);
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
  const blank = !!state?.blankFork;
  if (!blank) {
    for (const p of Object.values(state.portals || {})) {
      const staked = asBig(p.staked);
      const idle = asBig(p.idle);
      totalStaked += staked;
      totalIdle += idle;
      totalAccrued += asBig(accruedNanos(staked, bps, elapsed, state.magic));
      totalClaimable += asBig(p.claimableRewards);
    }
  }
  return {
    programId: RESERVE_PROGRAM,
    epochStartMs: blank ? 0 : (state.epochStartMs || 0),
    remainingMs: blank ? 0 : remainingMs(state, nowMs),
    totalLockedNanos: blank ? 0 : asNum(state.totalLockedNanos),
    totalStakedNanos: asNum(totalStaked),
    totalIdleNanos: asNum(totalIdle),
    totalAccruedNanos: asNum(totalAccrued),
    totalClaimableNanos: asNum(totalClaimable),
    accruingNanos: asNum(totalAccrued),
    vaultNanos: blank ? 0 : asNum(asBig(state.totalLockedNanos) + totalAccrued),
    reserveMintedNanos: blank ? 0 : asNum(asBig(state.mintBankNanos) + totalClaimable),
    feeBankNanos: 0,
    programCustodyNanos: 0,
    nextEpochBps: Number(state.nextEpochBps ?? state.epochBps ?? GENESIS_BPS),
    permittedRewardNanos: blank ? 0 : permittedRewardNanos(state),
    mintedRewardNanos: blank ? 0 : asNum(state.mintBankNanos),
    mintBankNanos: blank ? 0 : asNum(state.mintBankNanos),
    votes: blank ? { increase: 0, decrease: 0, hold: 0 } : votesView(state),
    oracleBps: bundledEpochBps() ?? GENESIS_BPS,
    oracleObserved: true,
    epochBps: Number(state.epochBps ?? GENESIS_BPS),
    epochIndex: Number(state.epochIndex || 0),
    freezeEpochIndex: Number(state.freeze?.epochIndex || 0),
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
    blankFork: blank,
  };
}

function activeOf(p) {
  return asBig(p?.active ?? p?.staked);
}

function setActive(p, n) {
  const v = asBig(n);
  p.active = v;
  p.staked = v;
}

function portalStakeNanos(p) {
  return activeOf(p) + asBig(p?.idle);
}

function lockOwner(payout, dest) {
  if (payout && isDestAddress(payout) && !isShearAddress(payout)) return payout;
  if (dest && isDestAddress(dest) && !isShearAddress(dest)) return dest;
  return '';
}

function spendPubHex(spendPub) {
  if (!spendPub) return '';
  if (typeof spendPub === 'string' && /^[0-9a-f]{64}$/i.test(spendPub.replace(/^0x/i, ''))) {
    return spendPub.replace(/^0x/i, '').toLowerCase();
  }
  try {
    const b = Buffer.from(asU8(spendPub));
    if (b.length === 32) return b.toString('hex');
  } catch { /* ignore */ }
  return '';
}

function commitHex(commit) {
  if (commit == null || commit === '') return '';
  try {
    return Buffer.from(asU8(commit)).toString('hex');
  } catch {
    return '';
  }
}

function pushLockNote(p, { nanos, owner, qualifying, unlockMs, spendPub, dest20, commit }) {
  const id = createHash('sha256')
    .update('shear-lock-note-v1')
    .update(String(p.id || ''))
    .update(String(asNum(nanos)))
    .update(String(owner || ''))
    .update(String((p.locks || []).length))
    .digest('hex');
  const owner20 = dest20 || (owner ? hash20FromAddress(owner) : null);
  const note = {
    id,
    owner,
    payout: p.payout || null,
    nanos: asNum(nanos),
    active: !!qualifying,
    unlockMs: Math.max(0, Math.floor(Number(unlockMs) || 0)),
    spent: false,
    spendPub: spendPubHex(spendPub),
    dest20: owner20 ? Buffer.from(owner20).toString('hex') : '',
    commit: commitHex(commit),
  };
  p.locks = p.locks || [];
  p.locks.push(note);
  return note;
}

function stampUnlock(state) {
  const end = Number(state.epochStartMs || 0) + epochMs(state.magic);
  for (const p of Object.values(state.portals || {})) {
    for (const note of p.locks || []) {
      if (!note.spent && !(Number(note.unlockMs) > 0)) note.unlockMs = end;
    }
  }
}

function unspentLockNanos(p) {
  let n = 0n;
  for (const note of p?.locks || []) {
    if (!note.spent) n += asBig(note.nanos);
  }
  return n;
}

export function permittedRewardNanos(state) {
  const bps = asBig(state?.epochBps ?? GENESIS_BPS);
  let n = 0n;
  for (const p of Object.values(state?.portals || {})) {
    n += (activeOf(p) * bps) / 10000n;
  }
  return asNum(n);
}

/** Supply identity: user notes hold principal; minted reward ≤ permitted reward. */
export function supplyIdentity(state) {
  const vault = state || emptyVault();
  let noteNanos = 0n;
  let indexed = 0n;
  for (const p of Object.values(vault.portals || {})) {
    indexed += portalStakeNanos(p);
    noteNanos += unspentLockNanos(p);
    for (const note of p.locks || []) {
      if (note.spent) continue;
      if (!note.owner) return { ok: false, reason: 'lock_owner' };
    }
  }
  const mintedReward = asBig(vault.mintBankNanos);
  const permittedReward = asBig(vault.rewardCapNanos);
  const custody = asBig(vault.programCustodyNanos);
  const ok = noteNanos === indexed
    && asBig(vault.totalLockedNanos) === indexed
    && custody === 0n
    && mintedReward <= permittedReward;
  return {
    ok,
    reason: ok ? undefined : 'supply',
    lockedNanos: asNum(indexed),
    noteNanos: asNum(noteNanos),
    programCustodyNanos: 0,
    permittedReward: asNum(permittedReward),
    mintedReward: asNum(mintedReward),
    feeBankRewardNanos: 0,
  };
}

/** Confirmed lock principal this dest cannot spend.
 *  Own portal, plus any portal whose payout is this dest.
 *  Does not create an empty portal. */
export function portalPrincipalNanos(state, dest) {
  if (!state || !state.portals) return 0;
  const id = portalKey(dest);
  if (!id) return 0;
  const want = String(dest || '');
  let n = 0n;
  const seen = new Set();
  for (const [pid, p] of Object.entries(state.portals)) {
    if (!p || seen.has(pid)) continue;
    const payId = p.payoutPortalId ? String(p.payoutPortalId).toLowerCase() : '';
    const payDest = p.payout ? String(p.payout) : '';
    if (pid !== id && payId !== id && payDest !== want) continue;
    seen.add(pid);
    n += portalStakeNanos(p);
  }
  return asNum(n);
}

function portalOf(state, destOrId) {
  const id = portalKey(destOrId);
  if (!id) {
    return { id: '', active: 0n, staked: 0n, idle: 0n, vote: null, joined: false, voteEpoch: 0, locks: [] };
  }
  if (!state.portals[id]) {
    state.portals[id] = {
      id, active: 0n, staked: 0n, idle: 0n, vote: null, joined: false, voteEpoch: 0, locks: [],
    };
  }
  return state.portals[id];
}

function clampBps(n) {
  let b = Math.floor(Number(n) || 0);
  if (b < 0) b = 0;
  if (b > RESERVE_ORACLE_MAX_BPS) b = RESERVE_ORACLE_MAX_BPS;
  return b;
}

function beginEpoch(state, nowMs) {
  if (!state.genesisMs) state.genesisMs = nowMs;
  const magic = state.magic || MAGIC_TESTNET;
  const days = epochDays(magic);
  const idx = vortexEpochIndex({ nowMs, genesisMs: state.genesisMs, epochDays: days });
  const prev = clampBps(state.epochBps ?? GENESIS_BPS);
  const proposed = epochRateBps(prev);
  const root = bundleObservationRoot();
  state.freezes = state.freezes || Object.create(null);
  const prior = state.freezes[idx];
  let bps = proposed;
  if (prior && Number.isFinite(Number(prior.epochBps))) bps = clampBps(prior.epochBps);
  state.epochBps = bps;
  state.nextEpochBps = bps;
  if (!prior) {
    state.freezes[idx] = {
      ok: true,
      epochIndex: idx,
      epochBps: bps,
      prevEpochBps: prev,
      observationRoot: root,
      source: 'bundle-quorum-14',
      sourceCount: ORACLE_QUORUM,
      frozenAtMs: Number(nowMs) || 0,
    };
  }
  state.freeze = state.freezes[idx];
  state.epochIndex = idx;
  state.epochStartMs = nowMs;
  state.bonusEnacted = false;
  stampUnlock(state);
  void days;
  void MAGIC_MAINNET;
}

function portalPublic(p) {
  const active = asNum(activeOf(p));
  return {
    id: p.id,
    active,
    staked: active,
    idle: asNum(p.idle),
    nanos: asNum(activeOf(p) + asBig(p.idle)),
    joined: p.joined,
    vote: p.vote,
    payout: p.payout || null,
    locks: (p.locks || []).filter((n) => !n.spent).map((n) => ({
      id: n.id,
      owner: n.owner,
      nanos: n.nanos,
      unlockMs: n.unlockMs,
      spendPub: n.spendPub || '',
      dest20: n.dest20 || '',
      commit: n.commit || '',
      timeLocked: true,
    })),
  };
}

export function deposit({
  state, dest, portalId, nanos, nowMs, payout, payoutPortalId, spendPub, noteCommit,
} = {}) {
  const id = portalKey(portalId || dest);
  if (!id) return { ok: false, reason: 'bad_dest' };
  if (dest && !isPortalId(dest) && (!isDestAddress(dest) || isShearAddress(dest))) {
    return { ok: false, reason: 'bad_dest' };
  }
  const n = asBig(nanos);
  if (n <= 0n) return { ok: false, reason: 'bad_amount' };
  const unbound = payout === false;
  const owner = lockOwner(unbound ? null : payout, isDestAddress(dest) ? dest : '');
  if (!owner && !unbound && !(payoutPortalId && isPortalId(payoutPortalId))) {
    return { ok: false, reason: 'need_payout' };
  }
  const p = portalOf(state, id);
  if (!unbound && !p.payout) {
    if (owner) p.payout = owner;
    else if (payout && isDestAddress(payout) && !isShearAddress(payout)) p.payout = payout;
  }
  if (!unbound && p.payout && !p.payoutPortalId) p.payoutPortalId = portalIdFromDest(p.payout);
  if (!unbound && payoutPortalId && isPortalId(payoutPortalId) && !p.payoutPortalId) {
    p.payoutPortalId = String(payoutPortalId).toLowerCase();
  }
  if (!unbound && !p.payout && !p.payoutPortalId) return { ok: false, reason: 'need_payout' };
  if (state.epochStartMs && !state.bonusEnacted && remainingMs(state, nowMs) === 0) {
    return { ok: false, reason: 'need_enact' };
  }
  const staking = canJoin(state, nowMs);
  if (staking) setActive(p, activeOf(p) + n);
  else p.idle = asBig(p.idle) + n;
  state.totalLockedNanos = asBig(state.totalLockedNanos) + n;
  state.programCustodyNanos = 0n;
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
  const unlockMs = state.epochStartMs ? state.epochStartMs + epochMs(state.magic) : 0;
  const noteOwner = p.payout || owner || dest;
  const note = pushLockNote(p, {
    nanos: n,
    owner: noteOwner,
    qualifying: staking,
    unlockMs,
    spendPub,
    commit: noteCommit,
  });
  return {
    ok: true,
    idle: !staking,
    note,
    portal: portalPublic(p),
  };
}

export const lock = deposit;

export function vote({ state, dest, portalId, choice, nowMs }) {
  nowMs;
  const id = portalKey(portalId || dest);
  if (!id) return { ok: false, reason: 'bad_dest' };
  if (dest && !isPortalId(dest) && (!isDestAddress(dest) || isShearAddress(dest))) {
    return { ok: false, reason: 'bad_dest' };
  }
  const p = portalOf(state, id);
  if (!p.joined || !canVote(activeOf(p), p.idle)) return { ok: false, reason: 'not_voter' };
  if (!state.epochStartMs) return { ok: false, reason: 'not_voter' };
  if (state.bonusEnacted) return { ok: false, reason: 'epoch_closed' };
  const allowed = [VOTE_INCREASE, VOTE_DECREASE, VOTE_HOLD];
  if (!allowed.includes(choice)) return { ok: false, reason: 'bad_vote' };
  if (choice === VOTE_DECREASE && hashBonusUnitNanos(state.liveHashBonusNanos) <= HASH_BONUS_NANOS_FLOOR) {
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

/** Miner, admin, vote, and snapshot observations do not move the consensus rate. */
export function observeRate({ state, annualBps, nowMs } = {}) {
  void annualBps;
  void nowMs;
  void state;
  return { ok: false, reason: 'rate_bundled' };
}

export function reserveInterestNanos(stakedNanos, oracleOrBps) {
  const bps = typeof oracleOrBps === 'number' || typeof oracleOrBps === 'bigint'
    ? oracleOrBps
    : (oracleOrBps?.epochBps ?? GENESIS_BPS);
  return interestNanos(stakedNanos, bps);
}

export function elapsedMs(state, nowMs) {
  if (!state.epochStartMs) return 0;
  return Math.max(0, Math.min(Number(nowMs) - state.epochStartMs, epochMs(state.magic)));
}

/** Per-portal accrued rewards for the owning wallet. Idle SHE earns nothing. */
export function portalRewards(state, dest, nowMs) {
  const p = portalOf(state, dest);
  const bps = Number(state.epochBps ?? GENESIS_BPS);
  const elapsed = elapsedMs(state, nowMs);
  const active = asNum(activeOf(p));
  return {
    accrued: accruedNanos(active, bps, elapsed, state.magic),
    projected: reserveInterestNanos(active, bps),
    active,
    staked: active,
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
  const active = asNum(activeOf(p));
  const principal = asNum(activeOf(p) + asBig(p.idle));
  const interest = reserveInterestNanos(active, state.epochBps);
  return {
    principal,
    active,
    staked: active,
    idle: asNum(p.idle),
    interest,
    reward: interest,
    payout: principal + interest,
    to: continuumOf(p, null, dest),
  };
}

function sealedReserveVout(to, n, kind, portalId) {
  const d20 = hash20FromAddress(to);
  if (!d20) return { address: to, nanos: n, kind, portalId: portalId || '' };
  // Reserve lock/vote/withdraw amounts are public (valueProof.v stays on the
  // wire). Exact-value Schnorr, not BP+ range — same as coinbase notes.
  const note = sealCoinbaseNote(n, { dest20: d20, kind });
  if (note.valueProof && typeof note.valueProof === 'object') {
    note.valueProof = { ...note.valueProof, v: n };
  }
  note.dest20 = d20;
  note.portalId = portalId || portalIdFromDest(to);
  return { ...note, address: to };
}

function vinDest20(from) {
  const d20 = hash20FromAddress(from);
  return d20 ? { address: from, dest20: d20 } : { address: from };
}

export function lockTx({ from, to, nanos, id, payout, unlockMs, spendPub, bindPayout = true }) {
  const n = Math.floor(Number(nanos));
  const owner = payout && isDestAddress(payout) ? payout : from;
  const portal = portalIdFromDest(to);
  const out = sealedReserveVout(owner, n, KIND_LOCK, portal);
  out.owner = owner;
  out.unlockMs = Math.max(0, Math.floor(Number(unlockMs) || 0));
  const pub = spendPubHex(spendPub);
  if (pub) out.spendPub = pub;
  const tx = {
    id,
    programId: RESERVE_PROGRAM,
    kind: KIND_LOCK,
    from,
    to,
    nanos: n,
    owner,
    portalId: portal,
    spendPub: pub || undefined,
    vin: [vinDest20(from)],
    vout: [out],
  };
  if (bindPayout) {
    tx.payout = owner;
    tx.payoutPortalId = portalIdFromDest(owner);
  } else {
    tx.payoutBound = false;
  }
  return tx;
}

export function withdrawTx({ from, to, nanos, id, principal, reward, lockNote, spendPub }) {
  const total = Math.floor(Number(nanos) || 0);
  const rewardN = reward != null ? Math.floor(Number(reward) || 0) : 0;
  const principalN = principal != null ? Math.floor(Number(principal) || 0) : (reward != null ? total - rewardN : total);
  const portal = portalIdFromDest(from);
  const release = sealedReserveVout(to, principalN, 'lock-release', portal);
  const vout = [release];
  if (rewardN > 0) {
    const minted = sealedReserveVout(to, rewardN, 'reserve-reward', portal);
    minted.mint = true;
    vout.push(minted);
  }
  const src = lockNote && typeof lockNote === 'object' ? lockNote : {};
  const vin = {
    ...vinDest20(src.owner || from),
    kind: KIND_LOCK,
  };
  if (src.commit) vin.commit = src.commit;
  if (src.id) vin.id = src.id;
  if (src.dest20) vin.dest20 = src.dest20;
  if (src.unlockMs) vin.unlockMs = src.unlockMs;
  const pub = spendPubHex(src.spendPub || spendPub);
  if (pub) vin.spendPub = pub;
  return {
    id,
    programId: RESERVE_PROGRAM,
    mint: false,
    spendsLock: true,
    kind: KIND_WITHDRAW,
    from,
    to,
    nanos: principalN + rewardN,
    principalNanos: principalN,
    rewardNanos: rewardN,
    portalId: portal,
    payoutPortalId: portalIdFromDest(to),
    spendPub: pub || undefined,
    vin: [vin],
    vout,
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
    portalId: portalIdFromDest(dest),
    payoutPortalId: portalIdFromDest(from),
    vin: [vinDest20(from)],
    vout: [sealedReserveVout(dest, 0, KIND_VOTE)],
  };
}

function destFromDest20(d20) {
  try {
    const b = Buffer.from(asU8(d20));
    if (b.length === 20) return encodeDest(b);
  } catch { /* ignore */ }
  return '';
}

function txKind(tx) {
  return String(tx?.kind || tx?.vout?.[0]?.kind || '');
}

/** Decode a Reserve action from the sealed (or legacy fat) body. */
export function reserveAction(tx) {
  const kind = txKind(tx);
  if (kind !== KIND_LOCK && kind !== KIND_VOTE && kind !== KIND_WITHDRAW) return null;
  const o = tx?.vout?.[0] || {};
  const claimed = o?.valueProof?.v != null
    ? Math.floor(Number(o.valueProof.v))
    : Math.floor(Number(tx?.nanos || o?.nanos || 0));
  let nanos = claimed;
  if (o?.commit && o?.valueProof) {
    nanos = verifySealedNote(o, claimed) ? claimed : 0;
  }
  const legacyTo = tx?.to || o?.address || destFromDest20(o?.dest20) || '';
  const legacyFrom = tx?.from || tx?.vin?.[0]?.address || destFromDest20(tx?.vin?.[0]?.dest20) || '';
  let portalId = String(tx?.portalId || o?.portalId || '').toLowerCase();
  if (!isPortalId(portalId)) {
    const dest = kind === KIND_WITHDRAW ? legacyFrom : legacyTo;
    portalId = dest ? portalIdFromDest(dest) : '';
  }
  let payoutPortalId = String(tx?.payoutPortalId || '').toLowerCase();
  if (!isPortalId(payoutPortalId)) {
    const pay = kind === KIND_WITHDRAW ? legacyTo : legacyFrom;
    payoutPortalId = pay ? portalIdFromDest(pay) : '';
  }
  return {
    kind,
    portalId,
    payoutPortalId,
    nanos,
    choice: tx?.choice,
    dest: kind === KIND_WITHDRAW ? legacyFrom : legacyTo,
    payout: kind === KIND_WITHDRAW ? legacyTo : legacyFrom,
  };
}

const FOREIGN_RESERVE_KINDS = new Set(['reserve', 'reserve-interest', 'reserve-shortfall', 'reserve-reward']);

/** A non-coinbase, non-Reserve tx cannot carry a reserve mint output. */
export function foreignReserveMint(tx) {
  if (!tx || tx.coinbase) return { ok: true };
  const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
  const program = String(tx.programId || '');
  if (program === RESERVE_PROGRAM && (kind === KIND_LOCK || kind === KIND_VOTE || kind === KIND_WITHDRAW)) {
    return { ok: true };
  }
  if (FOREIGN_RESERVE_KINDS.has(kind)) return { ok: false, reason: 'mint_forbidden' };
  for (const o of tx.vout || []) {
    if (FOREIGN_RESERVE_KINDS.has(String(o?.kind || ''))) return { ok: false, reason: 'mint_forbidden' };
  }
  return { ok: true };
}

function findLockNote(state, vin) {
  if (!state || !vin) return null;
  const id = String(vin.id || '');
  const commit = commitHex(vin.commit);
  for (const p of Object.values(state.portals || {})) {
    for (const note of p.locks || []) {
      if (id && note.id === id) return note;
      if (commit && note.commit && note.commit === commit) return note;
    }
  }
  return null;
}

/**
 * A spend of a user-held lock note before its unlock time.
 * The epoch-end withdraw is the release, so it is not reported here.
 */
export function prematureLockSpend(state, tx, blockTimeMs) {
  if (!state || !tx) return { ok: true };
  const kind = String(tx.kind || tx.vout?.[0]?.kind || '');
  if (kind === KIND_WITHDRAW) return { ok: true };
  const clock = Number(blockTimeMs);
  for (const vin of tx.vin || []) {
    const note = findLockNote(state, vin);
    const tagged = String(vin?.kind || '') === KIND_LOCK;
    if (!note && !tagged) continue;
    const unlock = Number(note?.unlockMs || vin?.unlockMs || 0);
    if (!Number.isFinite(clock) || clock < unlock) return { ok: false, reason: 'locked' };
  }
  return { ok: true };
}

/** Release outputs the owner's wallet scans as spendable after maturity. */
export function walletReleaseNotes(tx, { dest } = {}) {
  const want = dest ? hash20FromAddress(dest) : null;
  const wantHex = want ? Buffer.from(want).toString('hex') : '';
  const notes = [];
  for (const o of tx?.vout || []) {
    let d20 = '';
    try {
      if (o?.dest20) d20 = Buffer.from(asU8(o.dest20)).toString('hex');
    } catch { /* ignore */ }
    if (wantHex && d20 !== wantHex) continue;
    const nanos = o?.valueProof?.v != null ? Number(o.valueProof.v) : Number(o?.nanos || 0);
    notes.push({ dest20: d20, nanos, kind: o?.kind || '', spendable: true, timeLocked: false });
  }
  return notes;
}

/** Notes the owner's wallet lists while they are still time-locked. */
export function walletLockNotes(state, { dest, spendPub } = {}) {
  const pub = spendPubHex(spendPub);
  const want20 = dest ? hash20FromAddress(dest) : null;
  const wantHex = want20 ? Buffer.from(want20).toString('hex') : '';
  const out = [];
  for (const p of Object.values(state?.portals || {})) {
    for (const note of p.locks || []) {
      if (!note || note.spent) continue;
      if (dest && note.owner !== dest && p.payout !== dest) continue;
      if (wantHex && note.dest20 && note.dest20 !== wantHex) continue;
      if (pub && note.spendPub && note.spendPub !== pub) continue;
      out.push({
        id: note.id,
        owner: note.owner,
        dest20: note.dest20,
        spendPub: note.spendPub || pub,
        nanos: note.nanos,
        unlockMs: note.unlockMs,
        commit: note.commit || '',
        timeLocked: true,
        spendable: false,
      });
    }
  }
  return out;
}

/** Payout binding. Neither recorded field means the withdraw cannot be redirected. */
export function boundReserveWithdraw(state, tx) {
  const act = reserveAction(tx);
  if (!act || act.kind !== KIND_WITHDRAW) return { ok: true };
  if (!state) return { ok: false, reason: 'no_vault' };
  if (state.blankFork) return { ok: false, reason: 'blank_vault' };
  const p = act.portalId ? state.portals?.[act.portalId] : null;
  if (!p) return { ok: false, reason: 'empty' };
  if (asNum(activeOf(p) + asBig(p.idle)) <= 0) {
    const mintId = withdrawMintId(p.id || act.portalId, state.currentEpoch);
    if (state.mintedIds && state.mintedIds[mintId]) return { ok: false, reason: 'double_mint' };
    return { ok: false, reason: 'empty' };
  }
  if (!p.payout && !p.payoutPortalId) return { ok: false, reason: 'no_payout' };
  if (p.payoutPortalId && act.payoutPortalId && String(act.payoutPortalId).toLowerCase() !== String(p.payoutPortalId).toLowerCase()) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  if (p.payout && act.payout && isDestAddress(act.payout) && act.payout !== p.payout) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  if (p.payout && !act.payout) return { ok: false, reason: 'payout_mismatch' };
  if (act.payout && (isShearAddress(act.payout) || !isDestAddress(act.payout))) {
    return { ok: false, reason: 'shear1' };
  }
  return { ok: true, payout: p.payout || null };
}

/**
 * Epoch gate for a sealed withdraw. `blockTimeMs` is the consensus header
 * timestamp. `tx.nowMs` and the wall clock are not inputs.
 */
export function verifyReservePayout(state, tx, blockTimeMs) {
  const act = reserveAction(tx);
  if (!act) return { ok: true };
  if (!state) return { ok: false, reason: 'no_vault' };
  if (state.blankFork) return { ok: false, reason: 'blank_vault' };
  if (act.kind === KIND_LOCK) {
    if (!(act.nanos > 0)) return { ok: false, reason: 'bad_amount' };
    if (act.dest && isShearAddress(act.dest)) return { ok: false, reason: 'shear1' };
    return { ok: true };
  }
  if (act.kind !== KIND_WITHDRAW) return { ok: true };
  const clock = Number(blockTimeMs);
  if (!Number.isFinite(clock) || !state.epochStartMs || clock < state.epochStartMs + epochMs(state.magic)) {
    return { ok: false, reason: 'epoch_open' };
  }
  const bound = boundReserveWithdraw(state, tx);
  if (!bound.ok) return bound;
  const p = state.portals?.[act.portalId];
  const principal = asNum(activeOf(p) + asBig(p.idle));
  const interest = reserveInterestNanos(activeOf(p), state.epochBps);
  if (act.nanos > principal + interest) return { ok: false, reason: 'over_mint' };
  const mintId = withdrawMintId(p.id || act.portalId, state.currentEpoch);
  if (state.mintedIds && state.mintedIds[mintId]) return { ok: false, reason: 'double_mint' };
  return { ok: true };
}

/** Honour Reserve lock / vote / withdraw txs already sealed in a block. */
export function applyReserveBlock({ state, block, nowMs }) {
  if (!state || state.blankFork) return [];
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const results = [];
  // First block whose time is past the epoch collates votes into the live
  // hash bonus. Winning plurality moves the bonus by ±1. Height is unchanged.
  if (state.epochStartMs && !state.bonusEnacted && nowMs >= state.epochStartMs + epochMs(state.magic)) {
    results.push({ action: 'enact', ...enact({ state, nowMs }) });
  }
  for (const tx of txs) {
    if (!tx || tx.coinbase) continue;
    if (String(tx.programId || '') !== RESERVE_PROGRAM) continue;
    const act = reserveAction(tx);
    if (!act) continue;
    if (act.kind === KIND_LOCK) {
      results.push({
        action: KIND_LOCK,
        ...deposit({
          state,
          portalId: act.portalId,
          dest: act.dest,
          nanos: act.nanos,
          nowMs,
          payout: tx.payoutBound === false ? false : act.payout,
          payoutPortalId: tx.payoutBound === false ? '' : act.payoutPortalId,
          spendPub: tx.spendPub || tx.vout?.[0]?.spendPub,
          noteCommit: tx.vout?.[0]?.commit,
        }),
      });
      continue;
    }
    if (act.kind === KIND_VOTE) {
      results.push({
        action: KIND_VOTE,
        ...vote({
          state,
          portalId: act.portalId,
          dest: act.dest,
          choice: act.choice,
          nowMs,
        }),
      });
      continue;
    }
    if (act.kind === KIND_WITHDRAW) {
      results.push({
        action: KIND_WITHDRAW,
        ...withdraw({
          state,
          portalId: act.portalId,
          dest: act.dest,
          nowMs,
          payout: act.payout,
          payoutPortalId: act.payoutPortalId,
        }),
      });
    }
  }
  return results;
}

export function enact({ state, nowMs } = {}) {
  if (!state.epochStartMs || nowMs < state.epochStartMs + epochMs(state.magic)) {
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
  let live = hashBonusUnitNanos(state.liveHashBonusNanos);
  if (winners === 1 && delta > 0) live += 1;
  else if (winners === 1 && delta < 0) {
    if (live <= HASH_BONUS_NANOS_FLOOR) {
      delta = 0;
    } else {
      live -= 1;
    }
  }
  live = hashBonusUnitNanos(live);
  state.liveHashBonusNanos = BigInt(live);
  state.nextEpochBps = clampBps(state.epochBps ?? GENESIS_BPS);
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
    nextEpochBps: state.nextEpochBps,
  };
}

export function withdraw({ state, dest, portalId, nowMs, payout, payoutPortalId } = {}) {
  if (!state) return { ok: false, reason: 'no_vault' };
  if (state.blankFork) return { ok: false, reason: 'blank_vault' };
  const id = portalKey(portalId || dest);
  if (!id) return { ok: false, reason: 'bad_dest' };
  if (dest && !isPortalId(dest) && (!isDestAddress(dest) || isShearAddress(dest))) {
    return { ok: false, reason: 'bad_dest' };
  }
  if (!state.epochStartMs || nowMs < state.epochStartMs + epochMs(state.magic)) {
    return { ok: false, reason: 'epoch_open' };
  }
  if (!state.bonusEnacted) {
    const did = enact({ state, nowMs });
    if (!did.ok) return did;
  }
  const p = portalOf(state, id);
  const stakedNow = asNum(activeOf(p));
  const idleNow = asNum(p.idle);
  if (stakedNow + idleNow <= 0) {
    const mintId = withdrawMintId(p.id, state.currentEpoch);
    if (state.mintedIds && state.mintedIds[mintId]) return { ok: false, reason: 'double_mint' };
    return { ok: false, reason: 'empty' };
  }
  if (!p.payout && !p.payoutPortalId) return { ok: false, reason: 'no_payout' };
  if (payoutPortalId && p.payoutPortalId && String(payoutPortalId).toLowerCase() !== p.payoutPortalId) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  if (p.payout && payout && isDestAddress(payout) && payout !== p.payout) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  const staked = asNum(activeOf(p));
  const idle = asNum(p.idle);
  const principal = staked + idle;
  if (principal <= 0) return { ok: false, reason: 'empty' };
  const to = continuumOf(p, null, isDestAddress(dest) ? dest : '');
  if (p.payout && to !== p.payout) return { ok: false, reason: 'payout_mismatch' };
  const interest = reserveInterestNanos(staked, state.epochBps);
  let mint = null;
  if (interest > 0) {
    const mintId = withdrawMintId(p.id, state.currentEpoch);
    const paid = payoutStakeReward({
      state,
      reward: interest,
      id: mintId,
      gateOk: true,
      maxReward: interest,
    });
    if (!paid.ok) return { ok: false, reason: paid.reason };
    mint = extraMint({ programId: RESERVE_PROGRAM, to, nanos: interest });
    if (!mint.ok) return { ok: false, reason: mint.reason };
  } else if (!extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' })) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  state.totalLockedNanos = asBig(state.totalLockedNanos) - asBig(principal);
  if (state.totalLockedNanos < 0n) state.totalLockedNanos = 0n;
  state.programCustodyNanos = 0n;
  for (const note of p.locks || []) {
    if (!note.spent) note.spent = true;
  }
  if (Number(p.voteEpoch || 0) === Number(state.currentEpoch || 0)) {
    if (p.vote === VOTE_INCREASE && Number(state.votes.increase) > 0) state.votes.increase -= 1;
    if (p.vote === VOTE_DECREASE && Number(state.votes.decrease) > 0) state.votes.decrease -= 1;
    if (p.vote === VOTE_HOLD && Number(state.votes.hold) > 0) state.votes.hold -= 1;
  }
  if (Number(state.votes.increase) < 0) state.votes.increase = 0;
  if (Number(state.votes.decrease) < 0) state.votes.decrease = 0;
  if (Number(state.votes.hold) < 0) state.votes.hold = 0;
  setActive(p, 0n);
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
    reward: interest,
    payout: principal + interest,
    principalSpent: true,
    rewardSource: interest > 0 ? 'coinbase' : 'none',
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

import { createHash, randomBytes } from 'node:crypto';
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
import { sealCoinbaseNote, verifySealedNote, asU8, openedCoinbaseNanos, hashToScalar, scalarBytes } from './note.js';
import {
  emptyOracle,
  interestNanos,
  accruedNanos,
  observeRate as observeOracleRate,
  freezeEpochBps,
  makeFreezeRecord,
  verifyFreezeRecord,
  parseCoinbaseObserve,
  coinbaseObserveRejected,
  GENESIS_BPS,
  ORACLE_ACTIVATION_HEIGHT,
  oracleRuleAt,
  epochBpsFromReports,
  isReportBoundary,
  reserveApplyFields,
  bundleObservationRoot,
} from './reserve_oracle.js';
import { vortexEpochIndex, epochDays, epochMs, joinCutoffMs, MAGIC_MAINNET } from './pot_sched.js';
import { extraMint } from './mint.js';
import { reserveFeeDest } from './levy.js';
import { decodeHeader } from './header.js';

export const VOTE_INCREASE = 'increase bonus';
export const VOTE_DECREASE = 'decrease bonus';
export const VOTE_HOLD = 'leave bonus as-is';
export const KIND_LOCK = 'lock';
export const KIND_WITHDRAW = 'withdraw';
export const KIND_VOTE = 'vote';

/**
 * How many reserve actions one mempool, and one template, will trial.
 * This is liveness policy. A block is not rejected at this count, and it
 * is not a verify-weight parameter.
 */
export const RESERVE_ACTION_CAP = 4096;

const openMemo = new Map();
const OPEN_MEMO_MAX = 8192;
let reserveApplyCount = 0;
let reserveOpenMisses = 0;
// Set only while a carried trial mutates `state` in place. A miss restores
// the rows this trial touched. Consensus does not set this: it still clones,
// because that caller passes the live vault and drops the trial.
let undo = null;

export function reserveTrialStats() {
  return { applies: reserveApplyCount, opens: reserveOpenMisses };
}

/** Clears the counters. Cached openings stay, so a later trial can hit. */
export function resetReserveTrialStats() {
  reserveApplyCount = 0;
  reserveOpenMisses = 0;
}

function openingKey(commit, valueProof, rangeProof, claimed) {
  const r = Buffer.from(asU8(valueProof?.R || []));
  const z = Buffer.from(asU8(valueProof?.z || []));
  const rp = rangeProof ? Buffer.from(asU8(rangeProof)) : Buffer.alloc(0);
  return createHash('sha256')
    .update(commit)
    .update(r)
    .update(z)
    .update(rp)
    .update(String(claimed))
    .digest('hex');
}

/** Same commit, proof bytes, and claimed value always open the same way. */
function openingOf(vout, claimed) {
  let commit;
  try {
    commit = Buffer.from(asU8(vout?.commit));
  } catch {
    return null;
  }
  if (commit.length !== 32 || !vout?.valueProof) return null;
  let key;
  try {
    key = openingKey(commit, vout.valueProof, vout.rangeProof, claimed);
  } catch {
    return null;
  }
  const hit = openMemo.get(key);
  if (hit) return hit;
  reserveOpenMisses += 1;
  const row = { opened: !!verifySealedNote(vout, claimed), nanos: claimed };
  if (openMemo.size >= OPEN_MEMO_MAX) {
    const first = openMemo.keys().next().value;
    if (first !== undefined) openMemo.delete(first);
  }
  openMemo.set(key, row);
  return row;
}

function asBig(n) {
  if (typeof n === 'bigint') return n < 0n ? 0n : n;
  if (typeof n === 'string') {
    const s = n.trim();
    if (/^\d+$/.test(s)) {
      try { return BigInt(s); } catch { return 0n; }
    }
    if (/^-\d+$/.test(s)) return 0n;
  }
  const v = Math.floor(Number(n) || 0);
  if (!Number.isFinite(v) || v <= 0) return 0n;
  return BigInt(v);
}

function asNum(n) {
  return Number(asBig(n));
}

/** Accrued reward is a bigint and never exceeds u64. A Number would round past 2^53. */
const REWARD_U64 = 0xffffffffffffffffn;
const MAX_SAFE_NANOS = 9007199254740991n;

function capReward(n) {
  const v = asBig(n);
  return v > REWARD_U64 ? REWARD_U64 : v;
}

function epochInterestBig(staked, bps) {
  const p = asBig(staked);
  const rate = Math.floor(Number(bps) || 0);
  if (p <= 0n || !Number.isFinite(rate) || rate <= 0) return 0n;
  const got = (p * BigInt(rate)) / 10000n;
  return got > REWARD_U64 ? REWARD_U64 : got;
}

function addReward(total, delta) {
  const sum = capReward(total) + capReward(delta);
  return sum > REWARD_U64 ? REWARD_U64 : sum;
}

function nanosOut(n) {
  const v = asBig(n);
  return v <= MAX_SAFE_NANOS ? Number(v) : v;
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
    feeBankNanos: 0n,
    mintBankNanos: 0n,
    mintedIds: Object.create(null),
    portals: Object.create(null),
    votes: { increase: 0, decrease: 0, hold: 0 },
    oracle: emptyOracle(),
    sealedObserve: null,
    epochBps: GENESIS_BPS,
    nextEpochBps: null,
    // epochIndex → bps. Two boundaries can pass before the next lock opens
    // the vault. One nextEpochBps slot would drop the earlier rate, and a
    // withdraw would pay those epochs at the later rate. The latest commit
    // is also nextEpochBps, for the epoch that opens next.
    pendingRates: Object.create(null),
    rewardPermittedNanos: 0n,
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
    const row = p && typeof p === 'object' ? { ...p } : p;
    if (row && typeof row === 'object') {
      if (row.staked != null) row.staked = asBig(row.staked);
      if (row.idle != null) row.idle = asBig(row.idle);
      if (row.redeemedNanos != null) row.redeemedNanos = asBig(row.redeemedNanos);
      if (row.accruedReward != null && row.accruedReward !== '') row.accruedReward = capReward(row.accruedReward);
    }
    out.portals[k] = row;
  }
  out.votes = { increase: 0, decrease: 0, hold: 0, ...(raw.votes || {}) };
  out.mintedIds = Object.create(null);
  Object.assign(out.mintedIds, raw.mintedIds || {});
  out.freezes = Object.create(null);
  Object.assign(out.freezes, raw.freezes || {});
  out.pendingRates = Object.create(null);
  Object.assign(out.pendingRates, raw.pendingRates || {});
  out.liveHashBonusNanos = asBig(out.liveHashBonusNanos);
  out.totalLockedNanos = asBig(out.totalLockedNanos);
  out.feeBankNanos = asBig(out.feeBankNanos);
  out.mintBankNanos = asBig(out.mintBankNanos);
  out.rewardPermittedNanos = asBig(out.rewardPermittedNanos);
  out.blankFork = !!src.blankFork;
  delete out.vaultSeal;
  return out;
}

/** Transaction fees are not a vault balance. A credit leaves the bank at zero. */
export function creditFeeBank(state, _nanos) {
  void _nanos;
  if (state) state.feeBankNanos = 0n;
  return 0;
}

/**
 * Schedule allowance still owed on live stake, plus interest already
 * settled at withdraw. The mint counter is not this number: paying more
 * than the schedule makes supplyIdentity fail.
 */
function schedulePermittedNanos(vault) {
  const bps = vault?.epochBps ?? GENESIS_BPS;
  let live = 0n;
  for (const p of Object.values(vault?.portals || {})) {
    live += capReward(p?.accruedReward);
    live += epochInterestBig(p?.staked, bps);
  }
  return asBig(vault?.rewardPermittedNanos) + live;
}

/** User notes hold principal. Minted reward cannot exceed the epoch allowance. The fee bank is zero. */
export function supplyIdentity(state) {
  const vault = state || emptyVault();
  let indexed = 0n;
  for (const p of Object.values(vault.portals || {})) {
    indexed += asBig(p?.staked) + asBig(p?.idle);
  }
  const feeBank = asBig(vault.feeBankNanos);
  const minted = asBig(vault.mintBankNanos);
  const permitted = schedulePermittedNanos(vault);
  const ok = asBig(vault.totalLockedNanos) === indexed && feeBank === 0n && minted <= permitted;
  return {
    ok,
    reason: ok ? undefined : 'supply',
    lockedNanos: asNum(indexed),
    permittedReward: asNum(permitted),
    mintedReward: asNum(minted),
    feeBankRewardNanos: 0,
  };
}

/** Stake rewards pay from the fee bank first; mint only the shortfall. */
export function payoutStakeReward({
  state,
  reward = 0,
  gateOk = true,
  id = 'reward',
  maxReward = null,
} = {}) {
  const vault = state || emptyVault();
  vault.mintedIds = vault.mintedIds || Object.create(null);
  if (!gateOk) return { ok: false, reason: 'gate_wait', paid: 0, minted: 0, feeBank: asNum(vault.feeBankNanos) };
  if (vault.mintedIds[id]) return { ok: false, reason: 'double_mint', paid: 0, minted: 0, feeBank: asNum(vault.feeBankNanos) };
  const need = asBig(reward);
  if (need <= 0n) {
    return { ok: false, reason: 'bad_reward', paid: 0, minted: 0, feeBank: asNum(vault.feeBankNanos) };
  }
  if (maxReward != null && need > asBig(maxReward)) {
    return { ok: false, reason: 'over_mint', paid: 0, minted: 0, feeBank: asNum(vault.feeBankNanos) };
  }
  if (!id) {
    return { ok: false, reason: 'need_id', paid: 0, minted: 0, feeBank: asNum(vault.feeBankNanos) };
  }
  vault.feeBankNanos = 0n;
  if (!extraMintAllowed(RESERVE_PROGRAM, {
    kind: 'reserve-reward',
    feeFirst: false,
    gateOk: true,
    reward: asNum(need),
  })) {
    return { ok: false, reason: 'mint_forbidden', paid: 0, minted: 0, feeBank: 0 };
  }
  rememberMint(vault, id);
  vault.mintedIds[id] = true;
  vault.mintBankNanos = asBig(vault.mintBankNanos) + need;
  return {
    ok: true,
    paid: asNum(need),
    fromFee: 0,
    minted: asNum(need),
    source: 'coinbase',
    feeBank: 0,
    id,
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
    // Still in the vault (mint bank plus claimable). Not the on-chain mint.
    reserveClaimableNanos: blank ? 0 : asNum(asBig(state.mintBankNanos) + totalClaimable),
    feeBankNanos: blank ? 0 : asNum(state.feeBankNanos),
    mintBankNanos: blank ? 0 : asNum(state.mintBankNanos),
    votes: blank ? { increase: 0, decrease: 0, hold: 0 } : votesView(state),
    oracleBps: Number(state.epochBps ?? GENESIS_BPS),
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

function portalStakeNanos(p) {
  return asBig(p?.staked) + asBig(p?.idle);
}

/** Locked now, plus principal already paid out. The paid principal stays
 *  subtracted so the original notes and the withdraw note are not both spendable. */
function portalHeldNanos(p) {
  return portalStakeNanos(p) + asBig(p?.redeemedNanos);
}

function exactBig(n) {
  if (typeof n === 'bigint') return n < 0n ? 0n : n;
  if (typeof n === 'string' && /^\d+$/.test(n.trim())) return BigInt(n.trim());
  return asBig(n);
}

/** Confirmed lock principal this dest cannot spend.
 *  Own portal, plus any portal whose payout is this dest.
 *  Does not create an empty portal. */
function portalPrincipalBig(state, dest) {
  if (!state || !state.portals) return 0n;
  const id = portalKey(dest);
  if (!id) return 0n;
  const want = String(dest || '');
  let n = 0n;
  const seen = new Set();
  for (const [pid, p] of Object.entries(state.portals)) {
    if (!p || seen.has(pid)) continue;
    const payId = p.payoutPortalId ? String(p.payoutPortalId).toLowerCase() : '';
    const payDest = p.payout ? String(p.payout) : '';
    if (pid !== id && payId !== id && payDest !== want) continue;
    seen.add(pid);
    n += portalHeldNanos(p);
  }
  return n;
}

export function portalPrincipalNanos(state, dest) {
  return asNum(portalPrincipalBig(state, dest));
}

function wireNanos(n) {
  const x = typeof n === 'bigint' ? n : 0n;
  return x <= MAX_SAFE_NANOS ? Number(x) : x.toString();
}

/** Your (portal), Overall (program), and Flow (continuum) from one vault read. */
export function vortexSums(state, dest, flowNanos = 0) {
  return {
    your: { role: 'portal', nanos: wireNanos(portalPrincipalBig(state, dest)) },
    overall: { role: 'program', nanos: wireNanos(exactBig(state?.totalLockedNanos)) },
    flow: { role: 'continuum', nanos: wireNanos(exactBig(flowNanos)) },
  };
}

function copyPortal(row) {
  return { ...row };
}

function undoBook(maps, obj) {
  let book = maps.get(obj);
  if (!book) {
    book = new Map();
    maps.set(obj, book);
  }
  return book;
}

function rememberPortal(state, id) {
  if (!undo || undo.state !== state || !state.portals) return;
  const book = undoBook(undo.portals, state.portals);
  if (book.has(id)) return;
  const row = state.portals[id];
  book.set(id, row ? copyPortal(row) : null);
}

function rememberMint(state, id) {
  if (!undo || undo.state !== state || !state.mintedIds) return;
  const book = undoBook(undo.mints, state.mintedIds);
  if (book.has(id)) return;
  const map = state.mintedIds;
  book.set(id, Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined);
}

function rememberFreeze(state, idx) {
  if (!undo || undo.state !== state || !state.freezes) return;
  const book = undoBook(undo.freezes, state.freezes);
  if (book.has(idx)) return;
  const map = state.freezes;
  book.set(idx, Object.prototype.hasOwnProperty.call(map, idx) ? map[idx] : undefined);
}

function snapTrial(state) {
  const votes = state.votes || { increase: 0, decrease: 0, hold: 0 };
  return {
    totalLockedNanos: state.totalLockedNanos,
    feeBankNanos: state.feeBankNanos,
    mintBankNanos: state.mintBankNanos,
    liveHashBonusNanos: state.liveHashBonusNanos,
    epochBps: state.epochBps,
    nextEpochBps: state.nextEpochBps,
    pendingRates: state.pendingRates ? { ...state.pendingRates } : Object.create(null),
    rewardPermittedNanos: state.rewardPermittedNanos,
    genesisMs: state.genesisMs,
    magic: state.magic,
    currentEpoch: state.currentEpoch,
    epochStartMs: state.epochStartMs,
    epochIndex: state.epochIndex,
    bonusEnacted: state.bonusEnacted,
    enactedUp: state.enactedUp,
    enactedDown: state.enactedDown,
    enactedHold: state.enactedHold,
    enactedDelta: state.enactedDelta,
    enactedLiveBonus: state.enactedLiveBonus,
    enactedAtMs: state.enactedAtMs,
    enactedAtEpoch: state.enactedAtEpoch,
    blankFork: state.blankFork,
    votes,
    voteIncrease: Number(votes.increase || 0),
    voteDecrease: Number(votes.decrease || 0),
    voteHold: Number(votes.hold || 0),
    freeze: state.freeze,
    oracle: state.oracle,
    sealedObserve: state.sealedObserve,
    portals: state.portals,
    mintedIds: state.mintedIds,
    freezes: state.freezes,
  };
}

function restoreTrial(state, snap, frame) {
  state.totalLockedNanos = snap.totalLockedNanos;
  state.feeBankNanos = snap.feeBankNanos;
  state.mintBankNanos = snap.mintBankNanos;
  state.liveHashBonusNanos = snap.liveHashBonusNanos;
  state.epochBps = snap.epochBps;
  state.nextEpochBps = snap.nextEpochBps;
  state.pendingRates = snap.pendingRates ? { ...snap.pendingRates } : Object.create(null);
  state.rewardPermittedNanos = snap.rewardPermittedNanos;
  state.genesisMs = snap.genesisMs;
  state.magic = snap.magic;
  state.currentEpoch = snap.currentEpoch;
  state.epochStartMs = snap.epochStartMs;
  state.epochIndex = snap.epochIndex;
  state.bonusEnacted = snap.bonusEnacted;
  state.enactedUp = snap.enactedUp;
  state.enactedDown = snap.enactedDown;
  state.enactedHold = snap.enactedHold;
  state.enactedDelta = snap.enactedDelta;
  state.enactedLiveBonus = snap.enactedLiveBonus;
  state.enactedAtMs = snap.enactedAtMs;
  state.enactedAtEpoch = snap.enactedAtEpoch;
  state.blankFork = snap.blankFork;
  state.votes = snap.votes;
  if (state.votes) {
    state.votes.increase = snap.voteIncrease;
    state.votes.decrease = snap.voteDecrease;
    state.votes.hold = snap.voteHold;
  }
  state.freeze = snap.freeze;
  state.oracle = snap.oracle;
  state.sealedObserve = snap.sealedObserve;
  state.portals = snap.portals;
  state.mintedIds = snap.mintedIds;
  state.freezes = snap.freezes;
  const portals = frame.portals.get(state.portals);
  if (portals) {
    for (const [id, prev] of portals) {
      if (prev == null) delete state.portals[id];
      else state.portals[id] = prev;
    }
  }
  const mints = state.mintedIds ? frame.mints.get(state.mintedIds) : null;
  if (mints) {
    for (const [id, prev] of mints) {
      if (prev === undefined) delete state.mintedIds[id];
      else state.mintedIds[id] = prev;
    }
  }
  const freezes = state.freezes ? frame.freezes.get(state.freezes) : null;
  if (freezes) {
    for (const [idx, prev] of freezes) {
      if (prev === undefined) delete state.freezes[idx];
      else state.freezes[idx] = prev;
    }
  }
}

function portalOf(state, destOrId) {
  const id = portalKey(destOrId);
  if (!id) {
    return { id: '', staked: 0n, idle: 0n, vote: null, joined: false, voteEpoch: 0 };
  }
  rememberPortal(state, id);
  if (!state.portals[id]) {
    state.portals[id] = { id, staked: 0n, idle: 0n, vote: null, joined: false, voteEpoch: 0 };
  }
  return state.portals[id];
}

function beginEpoch(state, nowMs) {
  if (!state.genesisMs) state.genesisMs = nowMs;
  const magic = state.magic || MAGIC_TESTNET;
  const days = epochDays(magic);
  const idx = vortexEpochIndex({ nowMs, genesisMs: state.genesisMs, epochDays: days });
  const activationHeight = state.oracleActivationHeight === undefined
    ? ORACLE_ACTIVATION_HEIGHT
    : state.oracleActivationHeight;
  const rule = oracleRuleAt(state.oracleHeight ?? 0, { activationHeight });
  state.freezes = state.freezes || Object.create(null);
  const prior = state.freezes[idx];
  if (rule === 'median3b') {
    const running = Math.max(0, Math.floor(Number(state.epochBps ?? GENESIS_BPS)));
    const queued = state.pendingRates?.[idx];
    const pending = queued == null
      ? running
      : Math.max(0, Math.floor(Number(queued)));
    if (!prior) {
      rememberFreeze(state, idx);
      state.freezes[idx] = {
        ok: true,
        epochIndex: idx,
        epochBps: pending,
        prevEpochBps: running,
        magic,
        observationRoot: bundleObservationRoot(),
        source: 'median3b',
        frozenAtMs: Number(nowMs) || 0,
      };
    }
    state.epochBps = Math.max(0, Math.floor(Number(state.freezes[idx].epochBps)));
    state.freeze = state.freezes[idx];
  } else {
  const rec = makeFreezeRecord({
    epochIndex: idx,
    prevEpochBps: state.epochBps ?? GENESIS_BPS,
    nowMs,
    magic,
  });
  const check = verifyFreezeRecord(rec, { epochIndex: idx, prevFreeze: prior, magic });
  if (prior && (!check.ok || prior.epochBps !== rec.epochBps)) {
    state.epochBps = prior.epochBps;
    state.freeze = prior;
  } else {
    rememberFreeze(state, idx);
    state.freezes[idx] = rec;
    state.freeze = rec;
    state.epochBps = rec.epochBps;
  }
  }
  state.epochIndex = idx;
  state.epochStartMs = nowMs;
  state.bonusEnacted = false;
  void freezeEpochBps;
  void MAGIC_MAINNET;
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

export function deposit({ state, dest, portalId, nanos, nowMs, payout, payoutPortalId, ownerPub } = {}) {
  const id = portalKey(portalId || dest);
  if (!id) return { ok: false, reason: 'bad_dest' };
  if (dest && !isPortalId(dest) && (!isDestAddress(dest) || isShearAddress(dest))) {
    return { ok: false, reason: 'bad_dest' };
  }
  const n = asBig(nanos);
  if (n <= 0n) return { ok: false, reason: 'bad_amount' };
  const p = portalOf(state, id);
  const pub = String(ownerPub || '').replace(/^0x/i, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(pub)) {
    if (p.ownerPub && p.ownerPub !== pub) return { ok: false, reason: 'unsigned' };
    if (!p.ownerPub) p.ownerPub = pub;
  }
  if (payoutPortalId && isPortalId(payoutPortalId) && !p.payoutPortalId) {
    p.payoutPortalId = String(payoutPortalId).toLowerCase();
  }
  if (payout && isDestAddress(payout) && !isShearAddress(payout)) {
    if (!p.payout) p.payout = payout;
    if (!p.payoutPortalId) p.payoutPortalId = portalIdFromDest(payout);
  }
  if (state.epochStartMs && !state.bonusEnacted && remainingMs(state, nowMs) === 0) {
    return { ok: false, reason: 'need_enact' };
  }
  settlePortal(state, p, nowMs);
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

export function vote({ state, dest, portalId, choice, nowMs }) {
  nowMs;
  const id = portalKey(portalId || dest);
  if (!id) return { ok: false, reason: 'bad_dest' };
  if (dest && !isPortalId(dest) && (!isDestAddress(dest) || isShearAddress(dest))) {
    return { ok: false, reason: 'bad_dest' };
  }
  const p = portalOf(state, id);
  if (!p.joined || !canVote(p.staked, p.idle)) return { ok: false, reason: 'not_voter' };
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

/** Local proposal only. The next freeze reads sealedObserve, which a block writes. */
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
  return Math.max(0, Math.min(Number(nowMs) - state.epochStartMs, epochMs(state.magic)));
}

/** Per-portal accrued rewards for the owning wallet. Idle SHE earns nothing. */
export function portalRewards(state, dest, nowMs) {
  const p = portalOf(state, dest);
  const bps = Number(state.epochBps ?? GENESIS_BPS);
  const elapsed = elapsedMs(state, nowMs);
  return {
    accrued: accruedNanos(p.staked, bps, elapsed, state.magic),
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

/** Integer the commit names. A fraction, or an index outside a safe integer, is not a chain epoch. */
function statedEpochIndex(raw) {
  if (typeof raw === 'bigint') {
    if (raw < 0n || raw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(raw);
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

/** Vortex index of this header. No genesis yet means the clock has not opened, so the index is 0. */
function derivedCommitIndex(nowMs, genesisMs, magic) {
  const genesis = Number(genesisMs) || 0;
  const now = Number(nowMs) || 0;
  if (!(genesis > 0) || !(now > 0)) return 0;
  return vortexEpochIndex({
    nowMs: now,
    genesisMs: genesis,
    epochDays: epochDays(magic || MAGIC_TESTNET),
  });
}

/** Chain clock. The same integer Solidity commitRate stores: vortex index, 0 at genesis. */
function chainEpochIndex(state, nowMs) {
  const genesis = Number(state?.genesisMs) || 0;
  if (!(genesis > 0) || !(Number(nowMs) > 0)) return 0;
  return vortexEpochIndex({
    nowMs,
    genesisMs: genesis,
    epochDays: epochDays(state?.magic || MAGIC_TESTNET),
  });
}

/**
 * Rate of one chain epoch. A 3b freeze is the rate adopted when that epoch
 * opened. A queued commit covers an epoch the vault has not opened yet.
 * Fixed mode follows the running epochBps, which is the single bundled rate.
 */
function rateForEpoch(state, epochIndex) {
  const freeze = state?.freezes?.[epochIndex];
  if (freeze && freeze.source === 'median3b' && freeze.epochBps != null) {
    return Math.max(0, Math.floor(Number(freeze.epochBps)));
  }
  const queued = state?.pendingRates?.[epochIndex];
  if (queued != null && queued !== '') return Math.max(0, Math.floor(Number(queued)));
  return Math.max(0, Math.floor(Number(state?.epochBps ?? GENESIS_BPS)));
}

/**
 * Move completed chain epochs onto the portal. Stake added after this call
 * does not earn those epochs. Each epoch uses the rate committed for it.
 */
function settlePortal(state, p, nowMs) {
  if (!p) return 0n;
  const nowIdx = chainEpochIndex(state, nowMs);
  if (p.rewardEpoch == null) {
    p.rewardEpoch = nowIdx;
    p.accruedReward = capReward(p.accruedReward);
    return p.accruedReward;
  }
  const from = Math.floor(Number(p.rewardEpoch));
  let total = capReward(p.accruedReward);
  if (nowIdx > from) {
    for (let e = from; e < nowIdx; e += 1) {
      total = addReward(total, epochInterestBig(p.staked, rateForEpoch(state, e)));
    }
  }
  p.accruedReward = total;
  p.rewardEpoch = nowIdx;
  return total;
}

/** Interest a withdraw at `nowMs` pays: each completed chain epoch at that epoch's rate. */
export function portalEpochInterest(state, p, nowMs) {
  if (!p) return 0;
  const nowIdx = chainEpochIndex(state, nowMs);
  const from = p.rewardEpoch == null ? nowIdx : Math.floor(Number(p.rewardEpoch));
  let total = capReward(p.accruedReward);
  if (nowIdx > from) {
    for (let e = from; e < nowIdx; e += 1) {
      total = addReward(total, epochInterestBig(p.staked, rateForEpoch(state, e)));
    }
  }
  return nanosOut(total);
}

export function previewWithdraw(state, dest, nowMs = null) {
  const p = portalOf(state, dest);
  const clock = nowMs == null
    ? (Number(state?.epochStartMs) || 0) + epochMs(state?.magic)
    : nowMs;
  const principal = asNum(asBig(p.staked) + asBig(p.idle));
  const interest = portalEpochInterest(state, p, clock);
  return {
    principal,
    staked: asNum(p.staked),
    idle: asNum(p.idle),
    interest,
    payout: principal + interest,
    to: continuumOf(p, null, dest),
  };
}

const KT10_R_DST = Buffer.from('shear-kt10-withdraw-r-v1');
const ZERO_SCALAR = Buffer.alloc(32);

function positiveUnits(n) {
  if (typeof n === 'bigint') return n > 0n;
  if (typeof n === 'string' && /^\d+$/.test(n)) {
    try { return BigInt(n) > 0n; } catch { return false; }
  }
  return Number(n) > 0;
}

/** 32-byte withdraw nonce. Hex or raw bytes. The same bytes recompute the same r. */
export function withdrawNonceBytes(nonce) {
  if (typeof nonce === 'string' && /^[0-9a-f]{64}$/i.test(nonce)) return Buffer.from(nonce, 'hex');
  if (Buffer.isBuffer(nonce) && nonce.length === 32) return Buffer.from(nonce);
  if (nonce instanceof Uint8Array && nonce.length === 32) return Buffer.from(nonce);
  throw new Error('kt10_nonce');
}

function freshWithdrawId() {
  return `wd-${randomBytes(16).toString('hex')}`;
}

/**
 * KT-10. Blind for a vault withdrawal. Hash-derived, and not the zero scalar,
 * so v·G + r·H is not the identity when v is positive.
 * nonce is a stored 32-byte input. The same (to, nanos, id, nonce) is the same r.
 * A blank id is not a valid input here: withdrawTx mints a unique one.
 */
export function kt10WithdrawBlind(to, nanos, id = '', nonce) {
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(BigInt(nanos));
  const dest = Buffer.from(String(to));
  const ident = Buffer.from(String(id || ''));
  const extra = withdrawNonceBytes(nonce);
  for (let i = 0; i < 8; i += 1) {
    const r = hashToScalar(KT10_R_DST, Buffer.from([i]), dest, n, ident, extra);
    if (!scalarBytes(r).equals(ZERO_SCALAR)) return r;
  }
  throw new Error('kt10_blind');
}

function sealedReserveVout(to, n, kind, r) {
  const d20 = hash20FromAddress(to);
  if (!d20) return { address: to, nanos: n, kind };
  if (kind === KIND_WITHDRAW && !positiveUnits(n)) {
    return { address: to, nanos: n, kind };
  }
  // Reserve lock/vote/withdraw amounts are public (valueProof.v stays on the
  // wire). Exact-value Schnorr, not BP+ range — same as coinbase notes.
  const note = sealCoinbaseNote(n, { dest20: d20, kind, r });
  if (note.valueProof && typeof note.valueProof === 'object') {
    note.valueProof = { ...note.valueProof, v: n };
  }
  note.dest20 = d20;
  note.portalId = portalIdFromDest(to);
  return { ...note, address: to };
}

function vinDest20(from) {
  const d20 = hash20FromAddress(from);
  return d20 ? { address: from, dest20: d20 } : { address: from };
}

function exactFloorNanos(nanos) {
  if (typeof nanos === 'bigint') {
    if (nanos < 0n) return 0;
    return nanos <= 9007199254740991n ? Number(nanos) : nanos.toString();
  }
  if (typeof nanos === 'string' && /^\d+$/.test(nanos.trim())) {
    return exactFloorNanos(BigInt(nanos.trim()));
  }
  const n = Math.floor(Number(nanos) || 0);
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n;
}

export function lockTx({ from, to, nanos, id }) {
  const n = exactFloorNanos(nanos);
  return {
    id,
    programId: RESERVE_PROGRAM,
    kind: KIND_LOCK,
    from,
    to,
    nanos: n,
    portalId: portalIdFromDest(to),
    payoutPortalId: portalIdFromDest(from),
    vin: [vinDest20(from)],
    vout: [sealedReserveVout(to, n, KIND_LOCK)],
  };
}

export function withdrawTx({ from, to, nanos, id, nonce } = {}) {
  const n = exactFloorNanos(nanos);
  const ident = id == null || String(id) === '' ? freshWithdrawId() : String(id);
  const blindNonce = positiveUnits(n)
    ? (nonce == null ? randomBytes(32) : withdrawNonceBytes(nonce))
    : null;
  const blind = blindNonce ? kt10WithdrawBlind(to, n, ident, blindNonce) : null;
  const tx = {
    id: ident,
    programId: RESERVE_PROGRAM,
    mint: true,
    kind: KIND_WITHDRAW,
    from,
    to,
    nanos: n,
    portalId: portalIdFromDest(from),
    payoutPortalId: portalIdFromDest(to),
    vin: [],
    vout: [sealedReserveVout(to, n, KIND_WITHDRAW, blind)],
  };
  if (blindNonce) tx.withdrawNonce = Buffer.from(blindNonce).toString('hex');
  return tx;
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

/** Public integer on the action. Null is not zero: zero would pass an over-mint check. */
function publicNanos(raw) {
  if (typeof raw === 'bigint') {
    if (raw < 0n || raw > 9007199254740991n) return null;
    return Number(raw);
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!/^\d+$/.test(t)) return null;
    return publicNanos(BigInt(t));
  }
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(n)) return null;
  return n;
}

/** The amount the action publishes. The note has to open to this, not to a larger proof. */
function publicActionNanos(tx, o) {
  if (tx && Object.prototype.hasOwnProperty.call(tx, 'nanos') && tx.nanos != null && tx.nanos !== '') {
    return publicNanos(tx.nanos);
  }
  if (o && o.nanos != null && o.nanos !== '') return publicNanos(o.nanos);
  if (o?.valueProof?.v != null && o.valueProof.v !== '') return publicNanos(o.valueProof.v);
  return null;
}

/**
 * Withdraw notes must each open to the public action amount.
 * A sealed v12 withdraw has exactly one note whose kind is withdraw.
 * A row with no kind is not that note (a hidden output does not inherit it).
 * A withdraw with no committed note does not open.
 */
function withdrawNotesOpen(outs, pub) {
  const notes = outs.filter((row) => String(row?.kind || '') === KIND_WITHDRAW);
  const committed = notes.filter((row) => row?.commit && row?.valueProof);
  if (pub == null || notes.length !== 1 || committed.length !== 1) {
    return { opened: false, nanos: pub == null ? 0 : pub };
  }
  const note = committed[0];
  const proofV = publicNanos(note.valueProof.v);
  const cached = openingOf(note, pub);
  const opensToPublic = cached ? cached.opened === true : !!verifySealedNote(note, pub);
  const opened = opensToPublic && proofV === pub;
  return { opened, nanos: pub };
}

/** Decode a Reserve action from the sealed (or legacy fat) body. */
export function reserveAction(tx) {
  const kind = txKind(tx);
  if (kind !== KIND_LOCK && kind !== KIND_VOTE && kind !== KIND_WITHDRAW) return null;
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const o = outs.find((row) => String(row?.kind || kind) === kind) || outs[0] || {};
  const claimed = o?.valueProof?.v != null
    ? Math.floor(Number(o.valueProof.v))
    : Math.floor(Number(tx?.nanos || o?.nanos || 0));
  // A failed opening is not amount 0. Zero would pass an over-mint check.
  let nanos = claimed;
  let opened = true;
  if (kind === KIND_WITHDRAW) {
    const pub = publicActionNanos(tx, o);
    const checked = withdrawNotesOpen(outs, pub);
    opened = checked.opened;
    nanos = checked.nanos;
  } else if (o?.commit && o?.valueProof) {
    const cached = openingOf(o, claimed);
    if (cached) {
      opened = cached.opened;
      nanos = cached.nanos;
    } else {
      opened = !!verifySealedNote(o, claimed);
    }
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
    opened,
    choice: tx?.choice,
    dest: kind === KIND_WITHDRAW ? legacyFrom : legacyTo,
    payout: kind === KIND_WITHDRAW ? legacyTo : legacyFrom,
  };
}

function lenPrefUtf8(value) {
  const b = Buffer.from(String(value ?? ''));
  const n = Buffer.alloc(4);
  n.writeUInt32LE(b.length >>> 0);
  return Buffer.concat([n, b]);
}

function i64le(value) {
  const b = Buffer.alloc(8);
  const n = Math.floor(Number(value));
  const v = Number.isSafeInteger(n) ? BigInt(n) : 0n;
  b.writeBigInt64LE(v);
  return b;
}

function commit32(o) {
  try {
    if (!o?.commit) return Buffer.alloc(0);
    const b = Buffer.from(asU8(o.commit));
    return b.length === 32 ? b : Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Sealed fields reserveAction decides from. Address strings are not included.
 * The same bytes fall out of a fat body and of compactTx, which stamps the
 * portal ids before it drops the addresses.
 */
export function canonicalReserveFields(tx) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== KIND_LOCK && kind !== KIND_VOTE && kind !== KIND_WITHDRAW) return null;
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const o = outs.find((row) => String(row?.kind || kind) === kind) || outs[0] || {};
  const raw = o?.valueProof?.v != null ? o.valueProof.v : (tx?.nanos != null ? tx.nanos : o?.nanos);
  const n = Math.floor(Number(raw));
  const nanos = Number.isFinite(n) ? n : 0;
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
  const choice = kind === KIND_VOTE ? String(tx?.choice ?? '') : '';
  return {
    kind,
    portalId,
    payoutPortalId,
    programId: String(tx?.programId || ''),
    nanos,
    choice,
    commit: commit32(o),
  };
}

function withdrawNonceSigned(tx) {
  if (tx?.withdrawNonce == null || tx.withdrawNonce === '') return Buffer.alloc(32);
  try {
    return withdrawNonceBytes(tx.withdrawNonce);
  } catch {
    return Buffer.alloc(32);
  }
}

/** Merkle, owner, and v3 transcript suffix for a lock, vote, or withdraw.
 * A withdraw also signs its id and its 32-byte nonce. Lock and vote do not. */
export function reserveDigestSuffix(tx) {
  const fields = canonicalReserveFields(tx);
  if (!fields) return null;
  const parts = [
    Buffer.from('reserveact1'),
    lenPrefUtf8(fields.kind),
    lenPrefUtf8(fields.portalId),
    lenPrefUtf8(fields.payoutPortalId),
    lenPrefUtf8(fields.programId),
    lenPrefUtf8(fields.choice),
    i64le(fields.nanos),
    fields.commit,
  ];
  if (fields.kind === KIND_WITHDRAW) {
    parts.push(lenPrefUtf8(String(tx?.id || '')));
    parts.push(withdrawNonceSigned(tx));
  }
  return Buffer.concat(parts);
}

export function txIsReserveAction(tx) {
  if (!tx || tx.coinbase) return false;
  return canonicalReserveFields(tx) != null;
}

export function verifyReservePayout(state, tx, clockMs) {
  const act = reserveAction(tx);
  if (!act) return { ok: true };
  if (!state) return { ok: false, reason: 'no_vault' };
  if (state.blankFork) return { ok: false, reason: 'blank_vault' };
  if (act.kind === KIND_LOCK) {
    if (act.opened === false) return { ok: false, reason: 'bad_amount' };
    if (!(act.nanos > 0)) return { ok: false, reason: 'bad_amount' };
    if (act.dest && isShearAddress(act.dest)) return { ok: false, reason: 'shear1' };
    return { ok: true };
  }
  if (act.kind !== KIND_WITHDRAW) return { ok: true };
  if (String(tx?.programId || '') !== RESERVE_PROGRAM) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  const p = act.portalId ? state?.portals?.[act.portalId] : null;
  if (act.payoutPortalId && p?.payoutPortalId && act.payoutPortalId !== p.payoutPortalId) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  if (p?.payout && act.payout && isDestAddress(act.payout) && act.payout !== p.payout) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  if (act.payout && (isShearAddress(act.payout) || !isDestAddress(act.payout))) {
    return { ok: false, reason: 'shear1' };
  }
  const clock = Number(clockMs);
  if (!Number.isFinite(clock) || clock <= 0 || !state?.epochStartMs || clock < state.epochStartMs + epochMs(state.magic)) {
    return { ok: false, reason: 'epoch_open' };
  }
  if (!p) return { ok: false, reason: 'empty' };
  const principal = asNum(asBig(p.staked) + asBig(p.idle));
  const interest = portalEpochInterest(state, p, clock);
  const published = publicActionNanos(tx, (tx?.vout || []).find((row) => String(row?.kind || '') === KIND_WITHDRAW) || tx?.vout?.[0]);
  if (published != null && published < principal) return { ok: false, reason: 'principal_short' };
  if (act.opened === false) return { ok: false, reason: 'mint_amount' };
  if (act.nanos < principal) return { ok: false, reason: 'principal_short' };
  if (act.nanos > principal + interest) return { ok: false, reason: 'over_mint' };
  if (act.nanos !== principal + interest) return { ok: false, reason: 'mint_amount' };
  const mintId = withdrawMintId(p.id || act.portalId, state.currentEpoch);
  if (state.mintedIds && state.mintedIds[mintId]) return { ok: false, reason: 'double_mint' };
  return { ok: true };
}

/** Honour Reserve lock / vote / withdraw txs already sealed in a block. */
/**
 * Units before each block. History uses the caller's recorded units.
 * The fork is applied to `vault`. A rejected apply stops the walk.
 * The vault is the live state before the fork, not a replay of history.
 */
export function unitsAlongChain({
  unitAt = [],
  history = [],
  fork = [],
  vault = null,
  timeOf = null,
  magic = null,
  activationHeight = undefined,
} = {}) {
  const units = [];
  const rows = Array.isArray(history) ? history : [];
  for (let i = 0; i < rows.length; i += 1) {
    const recorded = i < unitAt.length ? unitAt[i] : HASH_BONUS_NANOS;
    units.push(hashBonusUnitNanos(recorded));
  }
  const trial = vault || emptyVault();
  const bookMagic = magic || trial.magic || MAGIC_TESTNET;
  if (magic) trial.magic = String(magic);
  const blocks = Array.isArray(fork) ? fork : [];
  const priorChain = rows.slice();
  let genesisWalk = 0;
  if (priorChain.length) {
    try {
      const headMs = typeof timeOf === 'function' ? Number(timeOf(priorChain[0])) || 0 : 0;
      if (headMs > 0) genesisWalk = headMs;
    } catch { /* first header is not readable */ }
  }
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    units.push(hashBonusUnitNanos(trial.liveHashBonusNanos));
    let nowMs = 0;
    try {
      nowMs = typeof timeOf === 'function' ? Number(timeOf(block)) || 0 : 0;
    } catch {
      nowMs = 0;
    }
    const parent = priorChain.length ? priorChain[priorChain.length - 1] : null;
    let parentMs = 0;
    if (parent) {
      try {
        parentMs = typeof timeOf === 'function' ? Number(timeOf(parent)) || 0 : 0;
      } catch {
        parentMs = 0;
      }
    }
    if (!(genesisWalk > 0)) {
      const head = priorChain[0] || block;
      try {
        const headMs = typeof timeOf === 'function' ? Number(timeOf(head)) || 0 : 0;
        if (headMs > 0 && (Number(head?.height) === 1 || priorChain.length === 0)) genesisWalk = headMs;
      } catch { /* genesis stays 0 until a readable header */ }
    }
    const fields = reserveApplyFields({
      prior: priorChain,
      block,
      magic: bookMagic,
      parentMs,
      genesisMs: genesisWalk,
      nowMs,
    });
    if (activationHeight !== undefined) fields.activationHeight = activationHeight;
    const applied = applyReserveBlock({ state: trial, ...fields });
    priorChain.push(block);
    if (applied && applied.ok === false) {
      return { ok: false, reason: applied.reason || 'epoch_open', units, at: rows.length + i };
    }
  }
  return { ok: true, reason: '', units, at: rows.length + blocks.length };
}

/** Hash-bonus unit live at each block, before that block's own enact. */
export function bonusUnitsBefore(blocks) {
  const walked = unitsAlongChain({
    history: [],
    fork: blocks || [],
    vault: emptyVault(),
    timeOf: (block) => {
      try {
        return Number(decodeHeader(Buffer.from(block.header)).timestamp);
      } catch {
        return 0;
      }
    },
  });
  if (!walked.ok) return null;
  return walked.units;
}

function noteDest20(o) {
  if (o?.dest20 != null && o.dest20 !== '') {
    try {
      const b = Buffer.from(asU8(o.dest20));
      if (b.length >= 20) return b.subarray(0, 20);
    } catch { /* address fallback */ }
  }
  const addr = String(o?.address || '');
  if (isDestAddress(addr)) {
    const h = hash20FromAddress(addr);
    if (h) return Buffer.from(h);
  }
  return null;
}

/** Opened reserve-fee notes that pay the reserve. A miss is not a credit. */
function openedReserveFeeNanos(cb) {
  const want = hash20FromAddress(reserveFeeDest());
  if (!want) return null;
  const reserve20 = Buffer.from(want);
  let sum = 0;
  for (const o of cb?.vout || []) {
    if (o?.kind !== 'reserve-fee') continue;
    const d20 = noteDest20(o);
    if (!d20 || !d20.equals(reserve20)) return null;
    const v = openedCoinbaseNanos(o);
    if (v == null) return null;
    sum += v;
  }
  return sum;
}

function finishReserveApply(results) {
  const bad = results.find((row) => row && row.ok === false);
  results.ok = !bad;
  if (bad) results.reason = bad.reason || 'epoch_open';
  return results;
}

export function applyReserveBlock({
  state,
  block,
  nowMs,
  oracleWindow = null,
  oracleWindowSize = null,
  activationHeight = ORACLE_ACTIVATION_HEIGHT,
  height = null,
  parentMs = 0,
  genesisMs = 0,
} = {}) {
  if (!state || state.blankFork) return [];
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const observeGate = coinbaseObserveRejected(txs);
  if (observeGate) {
    return finishReserveApply([{ ok: false, reason: observeGate.reason || 'bad_rate', action: 'observe' }]);
  }
  const results = [];
  // First block whose time is past the epoch collates votes into the live
  // hash bonus. Winning plurality moves the bonus by ±1. Height is unchanged.
  state.oracleActivationHeight = activationHeight;
  if (height != null) state.oracleHeight = Math.floor(Number(height) || 0);
  const blockHeight = Math.floor(Number(height ?? block?.height ?? state.oracleHeight ?? 0));
  const rule = oracleRuleAt(blockHeight, { activationHeight });
  const clockGenesis = Number(genesisMs) > 0 ? Number(genesisMs) : Number(state.genesisMs) || 0;
  const boundary = isReportBoundary({
    headerMs: nowMs,
    parentMs,
    genesisMs: clockGenesis,
    magic: state.magic || MAGIC_TESTNET,
  });
  const coinbase = txs.find((t) => t?.coinbase);
  // The commit's epochIndex is the vortex index of this header. 999, a
  // negative, the previous index, or the next index are not that epoch.
  // Before genesis the derived index is 0, so a pre-open epoch is refused.
  if (rule === 'median3b' && coinbase?.rateCommit && typeof coinbase.rateCommit === 'object') {
    const derived = derivedCommitIndex(nowMs, clockGenesis, state.magic || MAGIC_TESTNET);
    const stated = statedEpochIndex(coinbase.rateCommit.epochIndex);
    if (stated == null || stated !== derived) {
      return finishReserveApply([{ ok: false, reason: 'rate_commit', action: 'rate' }]);
    }
  }
  if (rule === 'median3b' && boundary && coinbase) {
    const commit = coinbase.rateCommit;
    const prev = Math.max(0, Math.floor(Number(state.epochBps ?? GENESIS_BPS)));
    const expected = epochBpsFromReports(prev, oracleWindow || [], {
      windowSize: oracleWindowSize,
    });
    if (!commit || Math.floor(Number(commit.epochBps)) !== expected) {
      return finishReserveApply([{ ok: false, reason: 'rate_commit', action: 'rate' }]);
    }
    // Queue by chain epoch. A later boundary must not erase an earlier commit:
    // the stake sat through that epoch and a withdraw pays it at that rate.
    const epochIdx = derivedCommitIndex(nowMs, clockGenesis, state.magic || MAGIC_TESTNET);
    if (!state.pendingRates) state.pendingRates = Object.create(null);
    const queued = state.pendingRates[epochIdx];
    if (queued != null && Math.floor(Number(queued)) !== expected) {
      return finishReserveApply([{ ok: false, reason: 'rate_commit', action: 'rate' }]);
    }
    state.pendingRates[epochIdx] = expected;
    state.nextEpochBps = expected;
    state.rateEpochIndex = epochIdx;
  }
  if (state.epochStartMs && !state.bonusEnacted && nowMs >= state.epochStartMs + epochMs(state.magic)) {
    const did = enact({ state, nowMs });
    results.push({ action: 'enact', ...did });
    if (!did.ok) return finishReserveApply(results);
  }
  const cb = txs.find((t) => t?.coinbase) || txs[0];
  const reservePaid = openedReserveFeeNanos(cb);
  if (reservePaid > 0) creditFeeBank(state, reservePaid);
  for (const tx of txs) {
    if (!tx || tx.coinbase) continue;
    if (String(tx.programId || '') !== RESERVE_PROGRAM) continue;
    reserveApplyCount += 1;
    const act = reserveAction(tx);
    if (!act || act.opened === false) continue;
    if (act.kind === KIND_LOCK) {
      const got = deposit({
        state,
        portalId: act.portalId,
        dest: act.dest,
        nanos: act.nanos,
        nowMs,
        payout: act.payout,
        payoutPortalId: act.payoutPortalId,
        ownerPub: tx.spendPub,
      });
      results.push({ action: KIND_LOCK, ...got });
      if (!got.ok) return finishReserveApply(results);
      continue;
    }
    if (act.kind === KIND_VOTE) {
      const got = vote({
        state,
        portalId: act.portalId,
        dest: act.dest,
        choice: act.choice,
        nowMs,
      });
      results.push({ action: KIND_VOTE, ...got });
      if (!got.ok) return finishReserveApply(results);
      continue;
    }
    if (act.kind === KIND_WITHDRAW) {
      const got = withdraw({
        state,
        portalId: act.portalId,
        dest: act.dest,
        nowMs,
        payout: act.payout,
        payoutPortalId: act.payoutPortalId,
      });
      results.push({ action: KIND_WITHDRAW, ...got });
      if (!got.ok) return finishReserveApply(results);
    }
  }
  const sealed = parseCoinbaseObserve(cb?.coinbase ? cb : null);
  if (sealed.observe) state.sealedObserve = sealed.observe;
  return finishReserveApply(results);
}

/**
 * One vault verdict for queue, mempool, template, and consensus.
 * `nowMs` is the header time the caller will seal, never the wall clock.
 * No reserve row is success. A reserve row with no vault fails closed.
 * applyReserveBlock's empty return is not success.
 */
function trialBlock(rows, block) {
  return block && Array.isArray(block.txs) ? block : { txs: rows };
}

function oracleForward(src = {}) {
  const out = {
    oracleWindow: src.oracleWindow ?? null,
    oracleWindowSize: src.oracleWindowSize ?? null,
    height: src.height ?? src.block?.height ?? null,
    parentMs: Number(src.parentMs) || 0,
    genesisMs: Number(src.genesisMs) || 0,
  };
  if (src.activationHeight !== undefined) out.activationHeight = src.activationHeight;
  else if (src.oracleActivationHeight !== undefined) out.activationHeight = src.oracleActivationHeight;
  return out;
}

function trialInPlace(state, rows, block, nowMs, oracle = {}) {
  const snap = snapTrial(state);
  const frame = {
    state,
    portals: new Map(),
    mints: new Map(),
    freezes: new Map(),
  };
  const prev = undo;
  undo = frame;
  let applied;
  try {
    applied = applyReserveBlock({
      state,
      block: trialBlock(rows, block),
      nowMs: Number(nowMs) || 0,
      ...oracleForward(oracle),
    });
  } catch (err) {
    restoreTrial(state, snap, frame);
    undo = prev;
    throw err;
  }
  if (applied && applied.ok === false) {
    const reason = applied.reason || 'epoch_open';
    restoreTrial(state, snap, frame);
    undo = prev;
    return { ok: false, reason };
  }
  if (!applied || applied.ok !== true) {
    restoreTrial(state, snap, frame);
    undo = prev;
    return { ok: false, reason: 'no_vault' };
  }
  undo = prev;
  return { ok: true, state };
}

export function trialReserveApply({
  state,
  txs,
  block,
  nowMs,
  inPlace = false,
  oracleWindow = null,
  oracleWindowSize = null,
  activationHeight = undefined,
  oracleActivationHeight = undefined,
  height = null,
  parentMs = 0,
  genesisMs = 0,
} = {}) {
  const rows = Array.isArray(txs) ? txs : (Array.isArray(block?.txs) ? block.txs : []);
  const oracle = {
    oracleWindow,
    oracleWindowSize,
    activationHeight,
    oracleActivationHeight,
    height,
    parentMs,
    genesisMs,
    block,
  };
  if (!rows.some(txIsReserveAction)) return { ok: true };
  if (!state) return { ok: false, reason: 'no_vault' };
  if (state.blankFork) return { ok: false, reason: 'blank_vault' };
  // The carried vault is already a private copy. Mutate it and undo a miss.
  // Any other caller, including consensus, still gets one clone so the live
  // vault cannot change inside a check that discards the trial.
  if (inPlace) return trialInPlace(state, rows, block, nowMs, oracle);
  const trial = cloneVault(state);
  const applied = applyReserveBlock({
    state: trial,
    block: trialBlock(rows, block),
    nowMs: Number(nowMs) || 0,
    ...oracleForward(oracle),
  });
  if (applied && applied.ok === false) {
    return { ok: false, reason: applied.reason || 'epoch_open' };
  }
  if (!applied || applied.ok !== true) return { ok: false, reason: 'no_vault' };
  return { ok: true, state: trial };
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
  if (payoutPortalId && p.payoutPortalId && String(payoutPortalId).toLowerCase() !== p.payoutPortalId) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  if (p.payout && payout && isDestAddress(payout) && payout !== p.payout) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  const staked = asBig(p.staked);
  const idle = asBig(p.idle);
  const principal = staked + idle;
  if (principal <= 0n) return { ok: false, reason: 'empty' };
  const to = continuumOf(p, payout, isDestAddress(dest) ? dest : '');
  settlePortal(state, p, nowMs);
  const interest = capReward(p.accruedReward);
  p.accruedReward = 0n;
  const mintId = withdrawMintId(p.id, state.currentEpoch);
  if (state.mintedIds && state.mintedIds[mintId]) {
    return { ok: false, reason: 'double_mint' };
  }
  let mint = null;
  if (interest > 0n) {
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
    state.rewardPermittedNanos = asBig(state.rewardPermittedNanos) + interest;
  } else if (!extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' })) {
    return { ok: false, reason: 'mint_forbidden' };
  } else {
    state.mintedIds = state.mintedIds || Object.create(null);
    rememberMint(state, mintId);
    state.mintedIds[mintId] = true;
  }
  state.totalLockedNanos = asBig(state.totalLockedNanos) - asBig(principal);
  if (state.totalLockedNanos < 0n) state.totalLockedNanos = 0n;
  p.redeemedNanos = asBig(p.redeemedNanos) + asBig(principal);
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
  const shownInterest = nanosOut(interest);
  return {
    ok: true,
    principal: nanosOut(principal),
    staked: nanosOut(staked),
    idle: nanosOut(idle),
    interest: shownInterest,
    reward: shownInterest,
    rewardSource: interest > 0n ? 'coinbase' : undefined,
    payout: nanosOut(principal + interest),
    to,
    mint,
    programId: RESERVE_PROGRAM,
    kind: KIND_WITHDRAW,
  };
}

function exactBi(n) {
  if (typeof n === 'bigint') return n >= 0n ? n : null;
  if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) return BigInt(n);
  if (typeof n === 'string' && /^\d+$/.test(n)) {
    try { return BigInt(n); } catch { return null; }
  }
  return null;
}

function withdrawRowsOf(block) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const rows = [];
  for (const tx of txs) {
    if (!tx || tx.coinbase) continue;
    if (String(tx.programId || '') !== RESERVE_PROGRAM) continue;
    if (txKind(tx) !== KIND_WITHDRAW) continue;
    rows.push(tx);
  }
  return rows;
}

function isWithdrawTx(tx) {
  if (!tx || tx.coinbase) return false;
  if (String(tx.programId || '') !== RESERVE_PROGRAM) return false;
  return txKind(tx) === KIND_WITHDRAW;
}

function isLockTx(tx) {
  if (!tx || tx.coinbase) return false;
  if (String(tx.programId || '') !== RESERVE_PROGRAM) return false;
  return txKind(tx) === KIND_LOCK;
}

/** Nanos an opened lock tx adds. Null means the amount cannot be read. */
function declaredLockNanos(tx) {
  if (!isLockTx(tx)) return 0n;
  const act = reserveAction(tx);
  if (!act || act.opened !== true) return 0n;
  return exactBi(act.nanos);
}

/**
 * One forward pass over the block. Each withdraw is checked on the vault
 * after the earlier txs, before that withdraw clears the stake.
 * Opened must be principal + permitted. The vault's own interest must be
 * that permitted amount, and the mint must be that interest.
 * Locked-in is the sum of the lock txs in this block, not the change in the
 * vault's own total. Start plus those amounts must equal principal out plus
 * what is still locked. Offsetting receipts cannot cancel across the block.
 */
function walkWithdrawInterest(vault, block, nowMs, oracle = {}) {
  const rows = withdrawRowsOf(block);
  if (!rows.length) return { ok: true, minted: 0n, permitted: 0n };
  if (!vault || vault.blankFork) return { ok: false, reason: 'supply' };
  const state = cloneVault(vault);
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const clock = Number(nowMs) || 0;
  const startLocked = asBig(state.totalLockedNanos);
  let locksIn = 0n;
  let principalOut = 0n;
  let minted = 0n;
  let permittedSum = 0n;
  let from = 0;
  let counted = 0;
  const fail = () => ({ ok: false, reason: 'supply' });
  const applySlice = (slice) => {
    if (!slice.length) return true;
    let declared = 0n;
    for (const tx of slice) {
      const n = declaredLockNanos(tx);
      if (n == null) return false;
      declared += n;
    }
    const before = asBig(state.totalLockedNanos);
    const applied = applyReserveBlock({
      state,
      block: { txs: slice, height: block?.height },
      nowMs: clock,
      ...oracleForward({ ...oracle, block }),
    });
    if (!applied || applied.ok !== true) return false;
    const after = asBig(state.totalLockedNanos);
    if (after < before) return false;
    locksIn += declared;
    return true;
  };
  for (let i = 0; i < txs.length; i += 1) {
    if (!isWithdrawTx(txs[i])) continue;
    if (!applySlice(txs.slice(from, i))) return fail();
    from = i + 1;
    const act = reserveAction(txs[i]);
    if (!act || act.opened !== true) return fail();
    const portal = act.portalId ? state.portals?.[act.portalId] : null;
    const staked = portal?.staked ?? 0n;
    const idle = portal?.idle ?? 0n;
    const principal = exactBi(asBig(staked) + asBig(idle));
    const permitted = exactBi(portalEpochInterest(state, portal, clock));
    const opened = exactBi(act.nanos);
    if (principal == null || permitted == null || opened == null) return fail();
    if (opened !== principal + permitted) return fail();
    const applied = applyReserveBlock({
      state,
      block: { txs: [txs[i]], height: block?.height },
      nowMs: clock,
      ...oracleForward({ ...oracle, block }),
    });
    if (!applied || applied.ok !== true) return fail();
    const got = [];
    for (const row of applied) {
      if (row && row.action === KIND_WITHDRAW && row.ok === true) got.push(row);
    }
    if (got.length !== 1) return fail();
    const interest = exactBi(got[0].interest);
    const vaultPrincipal = exactBi(got[0].principal);
    if (interest == null || vaultPrincipal == null) return fail();
    if (interest !== permitted || vaultPrincipal !== principal) return fail();
    const mintedHere = got[0].mint && got[0].mint.ok === true ? exactBi(got[0].mint.nanos) : 0n;
    if (mintedHere == null || mintedHere !== interest) return fail();
    minted += opened - principal;
    permittedSum += permitted;
    principalOut += principal;
    if (minted > REWARD_U64 || permittedSum > REWARD_U64) return fail();
    counted += 1;
  }
  if (!applySlice(txs.slice(from))) return fail();
  if (counted !== rows.length) return fail();
  const endLocked = asBig(state.totalLockedNanos);
  if (startLocked + locksIn !== endLocked + principalOut) return fail();
  if (minted !== permittedSum) return fail();
  return { ok: true, minted, permitted: permittedSum };
}

/**
 * Interest the withdraw receipts open to. Each one is principal + the bps
 * schedule on the pre-withdraw vault, and the mint equals that interest.
 * No withdraw is zero and does not need a vault.
 */
export function blockWithdrawInterest(vault, block, nowMs, oracle = {}) {
  const walked = walkWithdrawInterest(vault, block, nowMs, oracle);
  if (!walked.ok) return { ok: false, reason: walked.reason || 'supply' };
  return { ok: true, nanos: walked.minted };
}

/**
 * Interest the bps schedule allows for this block's withdraws.
 * One forward pass, the same pre-withdraw vault blockWithdrawInterest uses.
 */
export function blockPermittedInterest(vault, block, nowMs, oracle = {}) {
  const walked = walkWithdrawInterest(vault, block, nowMs, oracle);
  if (!walked.ok) return { ok: false, reason: walked.reason || 'supply' };
  return { ok: true, nanos: walked.permitted };
}

export function sheFromNanos(n) {
  return asNum(n) / NANOS_PER_SHE;
}

export { asBig, asNum };

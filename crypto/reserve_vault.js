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
  observeRate as observeOracleRate,
  freezeEpochBps,
  makeFreezeRecord,
  verifyFreezeRecord,
  GENESIS_BPS,
} from './reserve_oracle.js';
import { vortexEpochIndex, epochDays, epochMs, joinCutoffMs, MAGIC_MAINNET } from './pot_sched.js';
import { extraMint } from './mint.js';
import { splitLevy } from './levy.js';
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
    feeBankNanos: 0n,
    mintBankNanos: 0n,
    mintedIds: Object.create(null),
    portals: Object.create(null),
    votes: { increase: 0, decrease: 0, hold: 0 },
    oracle: emptyOracle(),
    epochBps: GENESIS_BPS,
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
  out.feeBankNanos = asBig(out.feeBankNanos);
  out.mintBankNanos = asBig(out.mintBankNanos);
  out.blankFork = !!src.blankFork;
  delete out.vaultSeal;
  return out;
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
    feeBankNanos: blank ? 0 : asNum(state.feeBankNanos),
    mintBankNanos: blank ? 0 : asNum(state.mintBankNanos),
    votes: blank ? { increase: 0, decrease: 0, hold: 0 } : votesView(state),
    oracleBps: state.oracle?.annualBps ?? 0,
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
    n += portalHeldNanos(p);
  }
  return asNum(n);
}

function portalOf(state, destOrId) {
  const id = portalKey(destOrId);
  if (!id) {
    return { id: '', staked: 0n, idle: 0n, vote: null, joined: false, voteEpoch: 0 };
  }
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
  const rec = makeFreezeRecord({
    epochIndex: idx,
    prevEpochBps: state.epochBps ?? GENESIS_BPS,
    annualBps: state.oracle?.annualBps,
    observedAtMs: state.oracle?.observedAtMs,
    nowMs,
    components: state.oracle?.components,
    magic,
  });
  state.freezes = state.freezes || Object.create(null);
  const prior = state.freezes[idx];
  const check = verifyFreezeRecord(rec, { epochIndex: idx, prevFreeze: prior, magic });
  if (prior && (!check.ok || prior.epochBps !== rec.epochBps)) {
    state.epochBps = prior.epochBps;
    state.freeze = prior;
  } else {
    state.freezes[idx] = rec;
    state.freeze = rec;
    state.epochBps = rec.epochBps;
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
  // Reserve lock/vote/withdraw amounts are public (valueProof.v stays on the
  // wire). Exact-value Schnorr, not BP+ range — same as coinbase notes.
  const note = sealCoinbaseNote(n, { dest20: d20, kind });
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

export function lockTx({ from, to, nanos, id }) {
  const n = Math.floor(Number(nanos));
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
    portalId: portalIdFromDest(from),
    payoutPortalId: portalIdFromDest(to),
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
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const o = outs.find((row) => String(row?.kind || kind) === kind) || outs[0] || {};
  const claimed = o?.valueProof?.v != null
    ? Math.floor(Number(o.valueProof.v))
    : Math.floor(Number(tx?.nanos || o?.nanos || 0));
  // A failed opening is not amount 0. Zero would pass an over-mint check.
  let nanos = claimed;
  let opened = true;
  if (o?.commit && o?.valueProof) {
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

/** Merkle, owner, and v3 transcript suffix for a lock, vote, or withdraw. */
export function reserveDigestSuffix(tx) {
  const fields = canonicalReserveFields(tx);
  if (!fields) return null;
  return Buffer.concat([
    Buffer.from('reserveact1'),
    lenPrefUtf8(fields.kind),
    lenPrefUtf8(fields.portalId),
    lenPrefUtf8(fields.payoutPortalId),
    lenPrefUtf8(fields.programId),
    lenPrefUtf8(fields.choice),
    i64le(fields.nanos),
    fields.commit,
  ]);
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
  if (act.opened === false) return { ok: false, reason: 'mint_amount' };
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
  const interest = reserveInterestNanos(p.staked, state.epochBps);
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
} = {}) {
  const units = [];
  const rows = Array.isArray(history) ? history : [];
  for (let i = 0; i < rows.length; i += 1) {
    const recorded = i < unitAt.length ? unitAt[i] : HASH_BONUS_NANOS;
    units.push(hashBonusUnitNanos(recorded));
  }
  const trial = vault || emptyVault();
  const blocks = Array.isArray(fork) ? fork : [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    units.push(hashBonusUnitNanos(trial.liveHashBonusNanos));
    let nowMs = 0;
    try {
      nowMs = typeof timeOf === 'function' ? Number(timeOf(block)) || 0 : 0;
    } catch {
      nowMs = 0;
    }
    const applied = applyReserveBlock({ state: trial, block, nowMs });
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

function finishReserveApply(results) {
  const bad = results.find((row) => row && row.ok === false);
  results.ok = !bad;
  if (bad) results.reason = bad.reason || 'epoch_open';
  return results;
}

export function applyReserveBlock({ state, block, nowMs }) {
  if (!state || state.blankFork) return [];
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const results = [];
  // First block whose time is past the epoch collates votes into the live
  // hash bonus. Winning plurality moves the bonus by ±1. Height is unchanged.
  if (state.epochStartMs && !state.bonusEnacted && nowMs >= state.epochStartMs + epochMs(state.magic)) {
    const did = enact({ state, nowMs });
    results.push({ action: 'enact', ...did });
    if (!did.ok) return finishReserveApply(results);
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
  return finishReserveApply(results);
}

/**
 * One vault verdict for queue, mempool, template, and consensus.
 * `nowMs` is the header time the caller will seal, never the wall clock.
 * No reserve row is success. A reserve row with no vault fails closed.
 * applyReserveBlock's empty return is not success.
 */
export function trialReserveApply({ state, txs, block, nowMs } = {}) {
  const rows = Array.isArray(txs) ? txs : (Array.isArray(block?.txs) ? block.txs : []);
  if (!rows.some(txIsReserveAction)) return { ok: true };
  if (!state) return { ok: false, reason: 'no_vault' };
  if (state.blankFork) return { ok: false, reason: 'blank_vault' };
  const trial = cloneVault(state);
  const applied = applyReserveBlock({
    state: trial,
    block: block && Array.isArray(block.txs) ? block : { txs: rows },
    nowMs: Number(nowMs) || 0,
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
  const staked = asNum(p.staked);
  const idle = asNum(p.idle);
  const principal = staked + idle;
  if (principal <= 0) return { ok: false, reason: 'empty' };
  const to = continuumOf(p, payout, isDestAddress(dest) ? dest : '');
  const interest = reserveInterestNanos(p.staked, state.epochBps);
  const mintId = withdrawMintId(p.id, state.currentEpoch);
  if (state.mintedIds && state.mintedIds[mintId]) {
    return { ok: false, reason: 'double_mint' };
  }
  let mint = null;
  if (interest > 0) {
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
  } else {
    state.mintedIds = state.mintedIds || Object.create(null);
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

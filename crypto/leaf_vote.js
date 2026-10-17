/**
 * One anonymous vote per live π leaf. The choice is public. The tag is not.
 *
 * k_vote = H(k, 'vote') is derived on the proving path and is not put on a
 * transaction. The consensus tag is sha256('shear-vote-v1' || nullP || epoch
 * || proposal). nullP = Hp(epoch)·k is the FS-1 link the claim circuit
 * already proves, so the verifier recomputes the tag without the key.
 * There is no miner veto.
 */
import { createHash } from 'node:crypto';
import { MAGIC_TESTNET, HASH_BONUS_NANOS, HASH_BONUS_NANOS_FLOOR } from './asert.js';
import { epochDays, joinCutoffDays } from './pot_sched.js';
import { VAULT_DAY_BLOCKS } from './vault_accrual.js';
import { scalarBytes } from './note.js';

export const VOTE_TAG_DST = 'shear-vote-v1';
export const VOTE_BIND_DST = 'shear-vote-bind-v1';
export const VOTE_PROPOSAL_DST = 'shear-vote-proposal-v1';
export const VOTE_KEY_DST = 'vote';
export const VOTE_BALLOT_LAW = 'leaf-v1';
export const VOTE_VETO_LAW = 'none';
export const VOTE_SEQ_CAP = 8;
export const VOTE_FINALITY_BLOCKS = 100;
export const MAX_BLOCK_LEAF_VOTES = 64;
export const VOTE_QUORUM_NUM = 1;
export const VOTE_QUORUM_DEN = 5;
export const RATE_FLOOR_BPS = 100;
export const RATE_CEIL_BPS = 2000;
export const VOTE_STEP_DEN = 10;
export const VOTE_GAP_BLOCKS = 7;

const PARAMS = new Set(['hb', 'rr']);

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n) >>> 0);
  return b;
}

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(Math.floor(Number(n) || 0)));
  return b;
}

function bytes32(raw) {
  if (raw == null) return null;
  const b = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw).replace(/^0x/i, ''), 'hex');
  return b.length === 32 ? b : null;
}

/** Public choice. -1 steps down, 0 holds, +1 steps up. */
export function voteChoice(raw) {
  const n = Math.floor(Number(raw));
  if (n === -1 || n === 0 || n === 1) return n;
  return null;
}

export function choiceByte(choice) {
  const n = voteChoice(choice);
  if (n == null) return null;
  return n < 0 ? 0xff : n;
}

export function voteParam(raw) {
  const name = String(raw || '');
  return PARAMS.has(name) ? name : null;
}

/** H(domain || epoch || param). The same bytes Solidity hashes with sha256. */
export function proposalId(epoch, param) {
  const name = voteParam(param);
  if (!name) return null;
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VOTE_PROPOSAL_DST),
    u64le(epoch),
    Buffer.from(name),
  ])).digest();
}

/**
 * Wallet vote key. Computed from the leaf scalar and never placed on a tx,
 * a return value of prove, or a log line.
 */
export function voteKey(scalar) {
  try {
    const raw = typeof scalar === 'bigint' ? scalarBytes(scalar) : Buffer.from(scalar);
    if (!raw || raw.length !== 32) return null;
    return createHash('sha256').update(raw).update(Buffer.from(VOTE_KEY_DST)).digest();
  } catch {
    return null;
  }
}

/** Consensus tag. One per (leaf, epoch, proposal) because nullP is. */
export function voteTag(nullP, epoch, proposal) {
  const point = bytes32(nullP);
  const pid = bytes32(proposal);
  if (!point || !pid) return null;
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VOTE_TAG_DST),
    point,
    u64le(epoch),
    pid,
  ])).digest();
}

/** Bound into the statement. Height is not here, so one proof covers the window. */
export function voteTxDigest({ choice, seq, proposalId: pid, epoch, magic }) {
  const picked = voteChoice(choice);
  const n = Math.floor(Number(seq));
  const proposal = bytes32(pid);
  if (picked == null || !proposal || n < 1 || n > VOTE_SEQ_CAP) return null;
  return createHash('sha256').update(Buffer.concat([
    Buffer.from([choiceByte(picked)]),
    u32le(n),
    proposal,
    u64le(epoch),
    Buffer.from(String(magic || MAGIC_TESTNET)),
  ])).digest();
}

/** Appended to the claim statement only when a vote is being proved. */
export function voteBindBytes({ choice, seq, proposalId: pid, txDigest }) {
  const picked = voteChoice(choice);
  const n = Math.floor(Number(seq));
  const proposal = bytes32(pid);
  const digest = bytes32(txDigest);
  if (picked == null || !proposal || !digest || n < 1 || n > VOTE_SEQ_CAP) return null;
  return Buffer.concat([
    Buffer.from(VOTE_BIND_DST),
    Buffer.from([choiceByte(picked)]),
    u32le(n),
    proposal,
    digest,
  ]);
}

/** Day the ballot closes. The same cutoff the stake reward uses. */
export function voteCloseDay(magic = MAGIC_TESTNET) {
  const days = epochDays(magic);
  const cut = joinCutoffDays(magic);
  if (cut < 0 || cut > days) return null;
  return days - cut;
}

export function voteCloseHeight(openHeight, magic = MAGIC_TESTNET) {
  const openH = Math.floor(Number(openHeight));
  const day = voteCloseDay(magic);
  if (!Number.isInteger(openH) || openH < 0 || day == null) return null;
  return openH + day * VAULT_DAY_BLOCKS;
}

/** Inclusive. Day 301 of a 400-day epoch is inside. Day 302 is not. */
export function voteWindowOpen(openHeight, height, magic = MAGIC_TESTNET) {
  const openH = Math.floor(Number(openHeight));
  const h = Math.floor(Number(height));
  const closeH = voteCloseHeight(openH, magic);
  if (closeH == null || !Number.isInteger(h) || h < 0) return false;
  return h >= openH && h <= closeH;
}

export function voteTallyReady(openHeight, height, magic = MAGIC_TESTNET) {
  const closeH = voteCloseHeight(openHeight, magic);
  const h = Math.floor(Number(height));
  if (closeH == null || !Number.isInteger(h)) return false;
  return h >= closeH + VOTE_FINALITY_BLOCKS;
}

/**
 * ±10% via floor(current / 10). A current below 10 does not move.
 * Hold does not clamp. An increase past the ceiling stops at the ceiling.
 */
export function stepRate(current, dir, floor, ceil) {
  const cur = Math.floor(Number(current));
  const lo = Math.floor(Number(floor));
  const hi = Math.floor(Number(ceil));
  if (!Number.isInteger(cur) || !Number.isInteger(lo) || !Number.isInteger(hi)) return null;
  const way = Math.floor(Number(dir) || 0);
  if (way === 0) return cur;
  const delta = Math.floor(cur / VOTE_STEP_DEN);
  if (delta === 0) return cur;
  let next = way > 0 ? cur + delta : cur - delta;
  if (next < lo) next = lo;
  if (next > hi) next = hi;
  return next;
}

export function hashBonusCeiling() {
  return HASH_BONUS_NANOS;
}

export function hashBonusFloor() {
  return HASH_BONUS_NANOS_FLOOR;
}

/**
 * Quorum is 20% of N_E, turnout including hold. A missing or zero leaf
 * count fails closed (hold). A change needs 2/3 of the non-hold votes.
 * A tie holds.
 */
export function ballotDirection(up, down, hold, leafCount) {
  const u = Math.floor(Number(up) || 0);
  const d = Math.floor(Number(down) || 0);
  const h = Math.floor(Number(hold) || 0);
  const n = Math.floor(Number(leafCount));
  if (!Number.isInteger(n) || n <= 0) return 0;
  const turnout = u + d + h;
  if (turnout * VOTE_QUORUM_DEN < n * VOTE_QUORUM_NUM) return 0;
  const directed = u + d;
  if (directed === 0 || u === d) return 0;
  if (u > d && u * 3 >= directed * 2) return 1;
  if (d > u && d * 3 >= directed * 2) return -1;
  return 0;
}

function censusMap(state) {
  if (!state.epochCensus) state.epochCensus = Object.create(null);
  return state.epochCensus;
}

function countMap(state) {
  if (!state.ballotCount) state.ballotCount = Object.create(null);
  return state.ballotCount;
}

function stepMap(state) {
  if (!state.ballotStep) state.ballotStep = Object.create(null);
  return state.ballotStep;
}

function ballotMap(state) {
  if (!state.ballots) state.ballots = Object.create(null);
  return state.ballots;
}

function slotKey(epoch, proposal) {
  const pid = bytes32(proposal);
  if (!pid) return null;
  return `${Math.floor(Number(epoch) || 0)}:${pid.toString('hex')}`;
}

export function commitCensus(state, epoch, leafCount, openHeight) {
  const idx = Math.floor(Number(epoch));
  const leaves = Math.floor(Number(leafCount));
  const openH = Math.floor(Number(openHeight));
  if (!Number.isInteger(idx) || idx < 0) return { ok: false, reason: 'bad_amount' };
  if (!Number.isInteger(leaves) || leaves < 0) return { ok: false, reason: 'bad_amount' };
  if (!Number.isInteger(openH) || openH < 0) return { ok: false, reason: 'bad_amount' };
  const book = censusMap(state);
  const key = String(idx);
  const prior = book[key];
  if (prior && prior.known && (prior.leafCount !== leaves || prior.openHeight !== openH)) {
    return { ok: false, reason: 'bad_amount' };
  }
  book[key] = { known: true, leafCount: leaves, openHeight: openH };
  return { ok: true };
}

export function censusOf(state, epoch) {
  const row = state?.epochCensus?.[String(Math.floor(Number(epoch) || 0))];
  if (!row || !row.known) return null;
  return row;
}

function choiceCode(choice) {
  if (choice === 1) return 1;
  if (choice === -1) return 2;
  return 3;
}

function codeChoice(code) {
  if (code === 1) return 1;
  if (code === 2) return -1;
  return 0;
}

function emptyCounts() {
  return { up: 0, down: 0, hold: 0 };
}

function bump(counts, choice, delta) {
  if (choice === 1) counts.up += delta;
  else if (choice === -1) counts.down += delta;
  else counts.hold += delta;
}

/**
 * Highest seq wins. An equal or lower seq is refused. Replacing a row
 * adjusts the three counters in place. No tag walk.
 */
export function recordVote(state, { epoch, proposal, tag, choice, seq }) {
  const picked = voteChoice(choice);
  const n = Math.floor(Number(seq));
  const id = bytes32(tag);
  const key = slotKey(epoch, proposal);
  if (picked == null || !id || !key || n < 1 || n > VOTE_SEQ_CAP) {
    return { ok: false, reason: 'vote_locked' };
  }
  const book = ballotMap(state);
  const epochKey = String(Math.floor(Number(epoch) || 0));
  if (!book[epochKey]) book[epochKey] = Object.create(null);
  if (!book[epochKey][key]) book[epochKey][key] = Object.create(null);
  const hex = id.toString('hex');
  const prior = book[epochKey][key][hex];
  if (prior && n <= prior.seq) return { ok: false, reason: 'vote_locked' };
  const counts = countMap(state);
  if (!counts[key]) counts[key] = emptyCounts();
  const row = counts[key];
  if (prior) bump(row, prior.choice, -1);
  bump(row, picked, 1);
  book[epochKey][key][hex] = { choice: picked, seq: n, code: choiceCode(picked) };
  return {
    ok: true,
    up: row.up,
    down: row.down,
    hold: row.hold,
    turnout: row.up + row.down + row.hold,
    replaced: !!prior,
  };
}

export function countsOf(state, epoch, proposal) {
  const key = slotKey(epoch, proposal);
  const row = key ? state?.ballotCount?.[key] : null;
  const counts = row || emptyCounts();
  return {
    up: counts.up,
    down: counts.down,
    hold: counts.hold,
    turnout: counts.up + counts.down + counts.hold,
  };
}

export function tallyBallot(state, { epoch, param, height, magic }) {
  const name = voteParam(param);
  const pid = name ? proposalId(epoch, name) : null;
  if (!pid) return { ok: false, reason: 'bad_amount', step: 0 };
  const census = censusOf(state, epoch);
  if (!census) return { ok: false, reason: 'not_voter', step: 0 };
  if (!voteTallyReady(census.openHeight, height, magic || state?.magic)) {
    return { ok: false, reason: 'epoch_open', step: 0 };
  }
  const key = slotKey(epoch, pid);
  const steps = stepMap(state);
  if (steps[key] && steps[key].tallied) {
    return { ok: true, step: steps[key].step, already: true, ...countsOf(state, epoch, pid) };
  }
  const counts = countsOf(state, epoch, pid);
  const step = ballotDirection(counts.up, counts.down, counts.hold, census.leafCount);
  steps[key] = { tallied: true, step, applied: false };
  return { ok: true, step, ...counts };
}

export function storedStep(state, epoch, proposal) {
  const key = slotKey(epoch, proposal);
  const row = key ? state?.ballotStep?.[key] : null;
  if (!row || !row.tallied) return { tallied: false, step: 0 };
  return row;
}

/**
 * Apply the epoch being left. One hash-bonus step and one reserve-rate
 * step. Counter slots for that epoch are dropped in one delete. Tags are
 * not walked.
 */
export function activateBallot(state, leftEpoch) {
  const magic = state?.magic || MAGIC_TESTNET;
  const left = Math.floor(Number(leftEpoch) || 0);
  const hb = proposalId(left, 'hb');
  const rr = proposalId(left, 'rr');
  const hbRow = storedStep(state, left, hb);
  const rrRow = storedStep(state, left, rr);
  if (hbRow.tallied) {
    const unit = stepRate(
      state.liveHashBonusNanos,
      hbRow.step,
      hashBonusFloor(),
      hashBonusCeiling(),
    );
    if (unit != null) state.liveHashBonusNanos = BigInt(unit);
  }
  if (rrRow.tallied) {
    const next = stepRate(state.epochBps, rrRow.step, RATE_FLOOR_BPS, RATE_CEIL_BPS);
    if (next != null) {
      state.epochBps = next;
      const key = String(Math.floor(Number(state.currentEpoch) || 0));
      if (!state.pendingRates) state.pendingRates = Object.create(null);
      state.pendingRates[key] = next;
      if (state.freezes) {
        if (state.freezes[key]) state.freezes[key].epochBps = next;
        if (state.freezes[state.currentEpoch]) state.freezes[state.currentEpoch].epochBps = next;
      }
      if (!state.rateTable) state.rateTable = Object.create(null);
      state.rateTable[key] = next;
    }
  }
  const counts = state.ballotCount;
  const steps = state.ballotStep;
  if (counts) {
    delete counts[slotKey(left, hb)];
    delete counts[slotKey(left, rr)];
  }
  if (steps) {
    delete steps[slotKey(left, hb)];
    delete steps[slotKey(left, rr)];
  }
  if (state.ballots) delete state.ballots[String(left)];
  void magic;
  return { ok: true, hb: hbRow.tallied ? hbRow.step : 0, rr: rrRow.tallied ? rrRow.step : 0 };
}

/** One send per locked leaf, spaced so sibling leaves are not in one proof. */
export function castVotePlan(n, { gap = VOTE_GAP_BLOCKS } = {}) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const step = Math.max(1, Math.floor(Number(gap) || VOTE_GAP_BLOCKS));
  const txs = [];
  for (let i = 0; i < count; i += 1) txs.push({ leaf: i, heightGap: i * step });
  return { label: `Cast your ${count} votes`, txs };
}

export function choiceOfCode(code) {
  return codeChoice(code);
}

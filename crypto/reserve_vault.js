import { createHash, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import {
  RESERVE_PROGRAM,
  PI_SHE_NANOS,
  RESERVE_JOIN_CUTOFF_MS,
  extraMintAllowed,
  NANOS_PER_SHE,
  HASH_BONUS_NANOS_FLOOR,
  hashBonusUnitNanos,
  MAGIC_TESTNET,
  VAULT_FS1_ACTIVATION_HEIGHT,
  MAX_BLOCK_VAULT_CLAIMS,
  MAX_LOCK_LEAVES,
  MAX_LIVE_VAULT_LEAVES,
  VAULT_CLAIM_WINDOW_EPOCHS,
} from './asert.js';
import { isDestAddress, isShearAddress, hash20FromAddress, encodeDest, admitBaseFromAddress, ED25519_SPKI_PREFIX, ed25519RawPub, ed25519PrivateFromSeed, ed25519SeedOf, destCommitFromSpendPub } from './address.js';
import { attachAdmitPub } from './admit.js';
import { fs1LeafFor } from './fs1_leaf.js';
import {
  sealCoinbaseNote, verifySealedNote, asU8, openedCoinbaseNanos, verifiedInputNanos, hashToScalar, scalarBytes, scalarFrom,
  pointFrom, pointBytes, verifyValue, proveValue, commit, proveRange, verifyRange, randomScalar, G, H,
  leafVoteConserved,
} from './note.js';
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
import {
  VAULT_PERIODS_PER_EPOCH,
  vaultEpochBlocks,
  vaultPeriodBlocks,
  vaultAccrualNanos,
  epochOfPeriod,
  arrivalStubNanos,
} from './vault_accrual.js';
import { extraMint } from './mint.js';
import { reserveFeeDest, levyNanos } from './levy.js';
import { decodeHeader } from './header.js';
import { merkleRoot, merkleProof, merkleVerify } from './merkle.js';
import { fs1TreeAppend, fs1TreeNew, fs1TreeRoot } from './native_admit.js';
import { txDigestV3 } from './admit_v3.js';
import { publicReserveReceipt } from './dummy.js';
import {
  proveLockCap, verifyLockCap, verifyVaultReward, vaultProofCap, vaultPublicReward,
  verifyLeafRetire, verifyLeafVote, retireDleqCount, retireDeclaredRows, MAX_RETIRE_ROWS,
  subtractUnlock, VAULT_PI_LEAF, VAULT_UNLOCK_OPEN,
} from './vault_reward_fs1.js';
import {
  activateBallot,
  censusOf,
  commitCensus,
  proposalId,
  recordVote,
  tallyBallot,
  voteChoice,
  voteParam,
  voteTag,
  voteWindowOpen,
  MAX_BLOCK_LEAF_VOTES,
} from './leaf_vote.js';

export const VOTE_INCREASE = 'increase bonus';
export const VOTE_DECREASE = 'decrease bonus';
export const VOTE_HOLD = 'leave bonus as-is';
export const KIND_LOCK = 'lock';
export const KIND_WITHDRAW = 'withdraw';
export const KIND_VOTE = 'vote';
export const KIND_LEAF_VOTE = 'leaf-vote';
export const STAKE_REWARD_KIND = 'stake-reward';
/** User tx that mints one archived reward. It is not a coinbase row. */
export const KIND_REWARD_CLAIM = 'reward-claim';
/** Retire DLEQs in one block. The same width as the leaf-vote cap. */
export const MAX_BLOCK_RETIRE_DLEQS = 64;
/** Domain for one reward leaf: tag || nullifier(32) || nanos u64le || ownerCommit(32). */
export const REWARD_LEAF_TAG = 'shear-reward-leaf-v1';
/** ownerCommit = sha256(tag || ownerPub). The leaf binds the key. The claim does not carry the lock dest. */
export const REWARD_OWNER_TAG = 'shear-reward-owner-v1';
/** Claim signature: tag || nullifier || u64le(nanos) || u32le(proofLen) || proof || u32le(destLen) || dest. */
export const REWARD_AUTH_TAG = 'shear-reward-auth-v1';
/** Withdraw-that-pays-a-reward signature. Same body, different tag, so a claim cannot be replayed as a withdraw. */
export const REWARD_WITHDRAW_TAG = 'shear-reward-withdraw-v1';

/**
 * How many reserve actions one mempool, and one template, will trial.
 * This is liveness policy. A block is not rejected at this count, and it
 * is not a verify-weight parameter.
 */
export const RESERVE_ACTION_CAP = 4096;
/** FS-1 root of a vault that holds no lock notes. A period that starts empty freezes this. */
export const EMPTY_VAULT_ROOT = createHash('sha256').update('shear-empty-root-v1').digest('hex');
/**
 * Retained so a block past epoch close + 4 is still a normal block.
 * Lock, withdraw, and reward sums are homomorphic commitments. Nothing
 * opens them, and this delay does not halt the chain.
 */
export const VAULT_MINT_DELAY_BLOCKS = 4;
const LOCK_FUND_DST = 'shear-lock-fund-v1';
const REMAIN_OPEN_DST = 'shear-lock-remain-v1';
const Fn = RistrettoPoint.Fn;

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

export const PORTAL_BLIND_TAG = 'shear-portal-r-v1';
export const PORTAL_ID_TAG = 'shear-portal-id-v1';
export const PORTAL_SPEND_TAG = 'shear-portal-spend-v1';

function portalSeedBytes(spendSeed) {
  let seed = spendSeed;
  if (seed && typeof seed === 'object' && !Buffer.isBuffer(seed) && !(seed instanceof Uint8Array)) {
    try { seed = ed25519SeedOf(seed); } catch { return null; }
  }
  const raw = Buffer.isBuffer(seed) ? seed : Buffer.from(seed || []);
  return raw.length === 32 ? raw : null;
}

function portalIndexBytes(lockIndex) {
  const idx = Buffer.alloc(4);
  const n = Number(lockIndex);
  idx.writeUInt32LE(Number.isInteger(n) && n >= 0 ? (n >>> 0) : 0);
  return idx;
}

/** 32-byte r from the wallet seed and the lock index. One portal per lock. */
export function portalBlindFromSeed(spendSeed, lockIndex = 0) {
  const raw = portalSeedBytes(spendSeed);
  if (!raw) return null;
  return createHash('sha256')
    .update(Buffer.from(PORTAL_BLIND_TAG))
    .update(raw)
    .update(portalIndexBytes(lockIndex))
    .digest();
}

/** One-time spend seed for this lock. The wallet re-derives it from the seed and the index. */
export function portalSpendSeed(spendSeed, lockIndex = 0) {
  const raw = portalSeedBytes(spendSeed);
  if (!raw) return null;
  return createHash('sha256')
    .update(Buffer.from(PORTAL_SPEND_TAG))
    .update(raw)
    .update(portalIndexBytes(lockIndex))
    .digest();
}

/** Fresh subaddress dest20 for this lock. Not the identity address and not the height-0 vault dest. */
export function portalDest20FromSeed(spendSeed, lockIndex = 0) {
  const one = portalSpendSeed(spendSeed, lockIndex);
  if (!one) return null;
  let pub;
  try { pub = ed25519RawPub(ed25519PrivateFromSeed(one)); } catch { return null; }
  return destCommitFromSpendPub(pub);
}

/**
 * portalId = H(tag, dest20). A peer recomputes it. r is not an input:
 * a carried id that is not this hash is a squat, and books that stored
 * the old blinded id do not match. Testnet datadirs wipe together.
 */
export function portalIdFromDest20(dest20, r = null) {
  void r;
  let d20;
  try {
    d20 = Buffer.from(asU8(dest20));
  } catch {
    return null;
  }
  if (d20.length < 20) return null;
  if (d20.length > 20) d20 = d20.subarray(0, 20);
  return createHash('sha256')
    .update(Buffer.from(PORTAL_ID_TAG))
    .update(d20)
    .digest('hex');
}

/** Address-only id. A seeded compact lock does not use this. A peer must not rebuild a portal from it. */
export function portalIdFromDest(dest) {
  const d = String(dest || '');
  return createHash('sha256').update('shear-portal-v1').update(d).digest('hex');
}

/**
 * Seeded portal id. r comes only from the spend seed. No seed, or a dest
 * that is not a 20-byte address, has no r, so the caller keeps the address id.
 * A present seed and dest20 never fall back to that address id.
 */
function portalIdFor(dest, spendSeed, lockIndex = null) {
  if (spendSeed != null) {
    const indexed = lockIndex != null && Number.isInteger(Number(lockIndex)) && Number(lockIndex) >= 0;
    const d20 = indexed ? portalDest20FromSeed(spendSeed, lockIndex) : hash20FromAddress(dest);
    const blind = portalBlindFromSeed(spendSeed, indexed ? lockIndex : 0);
    if (d20 && blind) {
      const id = portalIdFromDest20(d20, blind);
      if (id) return id;
    }
    if (indexed) return '';
  }
  return dest ? portalIdFromDest(dest) : '';
}

/** Every portal this seed can open, in lock-index order. Nothing but the seed is required. */
export function portalsFromSeed(spendSeed, count = 1) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const dest20 = portalDest20FromSeed(spendSeed, i);
    const r = portalBlindFromSeed(spendSeed, i);
    const portalId = dest20 && r ? portalIdFromDest20(dest20, r) : null;
    if (!dest20 || !portalId) break;
    out.push({ lockIndex: i, dest20, portalId, spendSeed: portalSpendSeed(spendSeed, i) });
  }
  return out;
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

function commitHexOf(v) {
  try {
    const b = Buffer.from(asU8(v));
    return b.length === 32 ? b.toString('hex') : '';
  } catch {
    return '';
  }
}

function rewardDest(portal) {
  if (portal?.payout && isDestAddress(portal.payout)) return portal.payout;
  if (portal?.dest && isDestAddress(portal.dest)) return portal.dest;
  return '';
}

/**
 * A reward epoch is archived once an earlier root covers it.
 * The root at this settlement index does not count, so recommitting
 * the same index still lists the same rows.
 */
function rewardEpochArchived(state, epoch, nowIdx) {
  const roots = state?.rewardRoots;
  if (!roots || !(nowIdx > 0)) return false;
  for (const key of Object.keys(roots)) {
    const k = Number(key);
    if (!Number.isInteger(k)) continue;
    if (epoch < k && k < nowIdx) return true;
  }
  return false;
}

/** Unpaid stake reward for each completed epoch, one row per portal. Archived epochs stay on their old root. */
export function stakeRewardsDue(state, nowMs) {
  const nowIdx = settlementIndex(state, nowMs);
  const rows = [];
  if (!(nowIdx > 0) || !state?.portals) return rows;
  for (const portal of Object.values(state.portals)) {
    if (!portal?.joined && !(portal?.tranches || []).length) continue;
    const byEpoch = new Map();
    for (const tranche of portal.tranches || []) {
      const arrival = Math.floor(Number(tranche.epoch) || 0);
      if (
        earnsStakeReward(state, tranche)
        && !tranche.partialPaid
        && nowIdx > arrival
        && epochQualifies(state, portal, arrival)
        && !rewardEpochArchived(state, arrival, nowIdx)
      ) {
        const part = partialInterest(
          asBig(tranche.amount),
          rateForEpoch(state, arrival),
          tranche.remainMs,
          epochMs(state?.magic),
        );
        if (part > 0n) byEpoch.set(arrival, (byEpoch.get(arrival) || 0n) + part);
      }
      const from = Math.floor(Number(tranche.fullFrom ?? arrival + 1));
      if (nowIdx > from && stakeRemain(tranche) > 0) {
        for (let e = from; e < nowIdx; e += 1) {
          if (!epochQualifies(state, portal, e)) break;
          if (rewardEpochArchived(state, e, nowIdx)) continue;
          const full = epochInterestBig(asBig(tranche.amount), rateForEpoch(state, e));
          if (full > 0n) byEpoch.set(e, (byEpoch.get(e) || 0n) + full);
        }
      }
    }
    const dest = rewardDest(portal);
    for (const [epoch, nanos] of byEpoch) {
      if (nanos <= 0n || !dest) continue;
      const mintId = withdrawMintId(portal.id, epoch);
      if (state.mintedIds && state.mintedIds[mintId]) continue;
      const asNumber = nanos <= 9007199254740991n ? Number(nanos) : null;
      if (asNumber == null) continue;
      rows.push({
        portalId: portal.id,
        epoch,
        nanos: asNumber,
        mintId,
        dest,
      });
    }
  }
  rows.sort((a, b) => (a.epoch - b.epoch) || (a.portalId < b.portalId ? -1 : a.portalId > b.portalId ? 1 : 0));
  return rows;
}

function u64le(value) {
  const b = Buffer.alloc(8);
  const n = BigInt(value);
  b.writeBigUInt64LE(n);
  return b;
}

/** 32-byte spend key, or 32 zero bytes when the portal has no owner yet. */
export function rewardOwnerPub(ownerPubHex) {
  const hex = String(ownerPubHex || '').replace(/^0x/i, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  return Buffer.alloc(32);
}

/** sha256(shear-reward-owner-v1 || ownerPub). The raw key is not in the leaf. */
export function rewardOwnerCommit(ownerPubHex) {
  return sha256Reward(Buffer.concat([Buffer.from(REWARD_OWNER_TAG), rewardOwnerPub(ownerPubHex)]));
}

/**
 * Leaf over one portal-epoch reward.
 * The preimage is the nullifier, the amount, and the owner commitment.
 * A different key cannot reuse the proof.
 */
export function rewardLeaf(nullifierHex, nanos, ownerPubHex = '') {
  const id = Buffer.from(String(nullifierHex || ''), 'hex');
  if (id.length !== 32) return null;
  const n = BigInt(nanos);
  if (n <= 0n || n > 0xffffffffffffffffn) return null;
  return sha256Reward(Buffer.concat([
    Buffer.from(REWARD_LEAF_TAG),
    id,
    u64le(n),
    rewardOwnerCommit(ownerPubHex),
  ]));
}

function u32le(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}

/**
 * Bytes the owner signs. `kind` is `claim` or `withdraw`.
 * The destination is the payout, not the lock dest.
 */
export function rewardAuthMessage({ kind = 'claim', nullifier, nanos, proof, dest } = {}) {
  const id = Buffer.from(String(nullifier || '').replace(/^0x/i, ''), 'hex');
  if (id.length !== 32) return null;
  const n = BigInt(nanos);
  if (n <= 0n || n > 0xffffffffffffffffn) return null;
  const packed = Buffer.isBuffer(proof) ? proof : packRewardProof(proof || []);
  if (!packed) return null;
  const destBuf = Buffer.from(String(dest || ''), 'utf8');
  const tag = kind === 'withdraw' ? REWARD_WITHDRAW_TAG : REWARD_AUTH_TAG;
  return Buffer.concat([
    Buffer.from(tag),
    id,
    u64le(n),
    u32le(packed.length),
    packed,
    u32le(destBuf.length),
    destBuf,
  ]);
}

export const WITHDRAW_OWNER_TAG = 'shear-withdraw-owner-v1';
export const TRANCHE_SET_TAG = 'shear-tranche-set-v1';
export const PORTAL_OWNER_TAG = 'shear-portal-owner-v1';
/** Shear EVM chain id. The withdraw signature binds this, not a caller nonce. */
export const WITHDRAW_CHAIN_ID = 2701n;

/** keccak256(magic string). The same word the Reserve stores as `magic`. */
export function reserveMagicBytes(magic = MAGIC_TESTNET) {
  return Buffer.from(keccak_256(Buffer.from(String(magic || MAGIC_TESTNET), 'utf8')));
}

function u256be(value) {
  const b = Buffer.alloc(32);
  let x = BigInt(value);
  if (x < 0n) x = 0n;
  for (let i = 31; i >= 0; i -= 1) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

function commitBytes(raw) {
  if (raw == null || raw === '') return null;
  try {
    const b = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === 'string' ? raw : asU8(raw), typeof raw === 'string' ? 'hex' : undefined);
    return b.length === 32 ? Buffer.from(b) : null;
  } catch {
    return null;
  }
}

/** C − π·G, the commitment a ≥ π range proof opens. */
function piShift(commitBuf) {
  return pointBytes(pointFrom(commitBuf).subtract(G.multiply(Fn.create(BigInt(PI_SHE_NANOS)))));
}

/**
 * Ordered commitment of the matured non-note tranches a withdraw releases.
 * The same sha256 chain the EVM builds before it drops those tranches.
 */
export function trancheSetHash(tranches, chain) {
  let h = createHash('sha256').update(Buffer.from(TRANCHE_SET_TAG)).digest();
  const at = Math.floor(Number(chain) || 0);
  for (const tranche of tranches || []) {
    const epoch = Math.floor(Number(tranche?.epoch) || 0);
    if (at <= epoch) continue;
    if (tranche?.noteIsPrincipal || tranche?.notePrincipal) continue;
    const commitRaw = commitBytes(tranche?.commit) || Buffer.alloc(32);
    const remain = BigInt(Math.max(0, Math.floor(Number(tranche?.remainMs) || 0)));
    h = createHash('sha256')
      .update(h)
      .update(commitRaw)
      .update(u256be(epoch))
      .update(u256be(remain))
      .digest();
  }
  return h;
}

/**
 * One-time owner seed for a lock. The wallet secret and the portal id
 * never leave the signer. A different lock id is a different key, so
 * portals of one wallet do not share a public key.
 */
export function portalOwnerSeed(spendKeyOrSeed, lockId) {
  let seed = spendKeyOrSeed;
  if (seed && typeof seed === 'object' && !Buffer.isBuffer(seed)) {
    try { seed = ed25519SeedOf(seed); } catch { return null; }
  }
  const seedBuf = Buffer.isBuffer(seed) ? seed : Buffer.from(seed || []);
  const idHex = String(lockId || '').replace(/^0x/i, '');
  if (seedBuf.length !== 32 || !/^[0-9a-f]{64}$/i.test(idHex)) return null;
  return createHash('sha256')
    .update(Buffer.from(PORTAL_OWNER_TAG))
    .update(seedBuf)
    .update(Buffer.from(idHex, 'hex'))
    .digest();
}

/** Ed25519 key derived from the wallet secret and the portal id. */
export function portalOwnerKey(spendKeyOrSeed, lockId) {
  const seed = portalOwnerSeed(spendKeyOrSeed, lockId);
  if (!seed) return null;
  return ed25519PrivateFromSeed(seed);
}

/** Magic, chain id, release epoch, and tranche set for one withdraw. */
export function withdrawBinding(state, portal, nowMs) {
  const epoch = chainEpochIndex(state, nowMs);
  return {
    epoch,
    trancheSet: trancheSetHash(portal?.tranches || [], epoch),
    magic: reserveMagicBytes(state?.magic || MAGIC_TESTNET),
    chainId: WITHDRAW_CHAIN_ID,
  };
}

/**
 * Bytes the owner signs for a principal withdraw.
 * The nullifier is the portal id. The amount is the principal.
 * The magic, chain id, release epoch, and tranche set are bound so a
 * signature cannot be replayed onto a later lock. The destination is
 * the payout. The lock dest is the withdraw's own subject.
 * The release epoch is the chain epoch of the block that mines this
 * withdraw. A signature mined after that epoch boundary does not verify.
 * The wallet has to re-sign for the epoch that includes the block.
 */
export function withdrawOwnerMessage({
  nullifier, nanos, dest, magic, chainId, epoch, trancheSet, txBind = null,
} = {}) {
  const id = Buffer.from(String(nullifier || '').replace(/^0x/i, ''), 'hex');
  if (id.length !== 32) return null;
  const n = BigInt(nanos);
  // Zero is the hidden principal. The tranche-set commitment distinguishes the lock.
  if (n < 0n || n > 0xffffffffffffffffn) return null;
  const mag = Buffer.isBuffer(magic) ? magic : Buffer.from(magic || []);
  if (mag.length !== 32) return null;
  const setRaw = Buffer.isBuffer(trancheSet) ? trancheSet : Buffer.from(String(trancheSet || ''), 'hex');
  if (setRaw.length !== 32) return null;
  let chain = 0n;
  let at = 0n;
  try {
    chain = BigInt(chainId);
    at = BigInt(epoch);
  } catch {
    return null;
  }
  if (chain < 0n || chain > 0xffffffffffffffffn) return null;
  if (at < 0n || at > 0xffffffffffffffffn) return null;
  const destBuf = Buffer.from(String(dest || ''), 'utf8');
  let bind = Buffer.alloc(32);
  if (txBind) {
    try {
      const raw = Buffer.from(asU8(txBind));
      if (raw.length === 32) bind = raw;
    } catch { bind = Buffer.alloc(32); }
  }
  return Buffer.concat([
    Buffer.from(WITHDRAW_OWNER_TAG),
    id,
    u64le(n),
    mag,
    u64le(chain),
    u64le(at),
    setRaw,
    bind,
    u32le(destBuf.length),
    destBuf,
  ]);
}

function proofTxBind(raw) {
  try {
    const buf = Buffer.from(asU8(raw));
    if (buf.length < 32) return null;
    return Buffer.from(buf.subarray(buf.length - 32));
  } catch {
    return null;
  }
}

/** Ed25519 over the auth message. Returns hex sig, or '' when the key cannot sign. */
export function signRewardAuth(message, privateKey) {
  if (!message || !privateKey) return '';
  try {
    return Buffer.from(sign(null, message, privateKey)).toString('hex');
  } catch {
    return '';
  }
}

export function verifyRewardAuth(message, ownerPubHex, sigHex) {
  if (!message) return false;
  const pubRaw = rewardOwnerPub(ownerPubHex);
  if (pubRaw.equals(Buffer.alloc(32))) return false;
  const sig = String(sigHex || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{128}$/.test(sig)) return false;
  try {
    const pub = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pubRaw]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, message, pub, Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Pubkey || sig || dest utf8. The EVM checks this blob.
 * The lock dest and the portal id are not in it.
 */
export function packRewardAuth({ ownerPub, sig, dest } = {}) {
  const pub = rewardOwnerPub(ownerPub);
  const sigBuf = Buffer.from(String(sig || '').replace(/^0x/i, ''), 'hex');
  if (pub.equals(Buffer.alloc(32)) || sigBuf.length !== 64) return null;
  return Buffer.concat([pub, sigBuf, Buffer.from(String(dest || ''), 'utf8')]);
}

function sha256Reward(buf) {
  return createHash('sha256').update(buf).digest();
}

/**
 * One root over every unpaid eligible reward due at this clock.
 * Order is the nullifier, so the tree does not sort by lock dest.
 * The amount is rate × principal × pro-rata time, with the π gate and the cutoff.
 */
export function rewardCommitment(state, nowMs) {
  const due = stakeRewardsDue(state, nowMs);
  const rows = due.map((row) => ({
    nullifier: row.mintId,
    epoch: row.epoch,
    nanos: row.nanos,
    portalId: row.portalId,
    ownerPub: String(state?.portals?.[row.portalId]?.ownerPub || '').toLowerCase(),
  }));
  rows.sort((a, b) => (a.nullifier < b.nullifier ? -1 : a.nullifier > b.nullifier ? 1 : 0));
  const leaves = rows.map((row) => rewardLeaf(row.nullifier, row.nanos, row.ownerPub));
  const root = Buffer.from(merkleRoot(leaves)).toString('hex');
  return {
    ok: true,
    rows,
    root,
    index: settlementIndex(state, nowMs),
  };
}

/** Sibling path for one archived nullifier. Empty once the root did not include it. */
export function rewardClaimProof(state, nullifierHex) {
  const id = String(nullifierHex || '').toLowerCase();
  const row = state?.rewardBook?.[id];
  const rows = row ? state?.rewardSets?.[row.rootKey] : null;
  if (!row || !Array.isArray(rows)) return null;
  const index = rows.findIndex((item) => item.nullifier === id);
  if (index < 0) return null;
  const leaves = rows.map((item) => rewardLeaf(item.nullifier, item.nanos, item.ownerPub));
  return merkleProof(leaves, index);
}

/** Packed EVM proof. Side 0 is a right sibling, side 1 is a left sibling. */
export function packRewardProof(proof) {
  const steps = Array.isArray(proof) ? proof : [];
  const parts = [];
  for (const step of steps) {
    const side = step?.side === 'L' ? 1 : 0;
    const hash = Buffer.from(String(step?.hash || ''), 'hex');
    if (hash.length !== 32) return null;
    parts.push(Buffer.from([side]), hash);
  }
  return Buffer.concat(parts);
}

/**
 * Every reward due at this clock. There is no per-block row cap: the block
 * carries one root, and each user mints their own row later.
 */
export function planStakeRewards(state, nowMs) {
  const commit = rewardCommitment(state, nowMs);
  return {
    ok: true,
    pay: commit.rows.map((row) => ({
      portalId: row.portalId,
      epoch: row.epoch,
      nanos: row.nanos,
      mintId: row.nullifier,
    })),
    held: [],
    root: commit.root,
    index: commit.index,
  };
}

/** Portal ids a withdraw in this block will pay. Notes still auto-credit. */
function withdrawPortalIds(block) {
  const ids = new Set();
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  for (const tx of txs) {
    if (!tx || tx.coinbase) continue;
    if (String(tx.programId || '') !== RESERVE_PROGRAM) continue;
    if (txKind(tx) !== KIND_WITHDRAW) continue;
    const act = reserveAction(tx);
    if (act?.portalId) ids.add(String(act.portalId).toLowerCase());
  }
  return ids;
}

export function stakeRewardNotesOf(block) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const cb = txs.find((tx) => tx?.coinbase) || null;
  return (cb?.vout || []).filter((o) => String(o?.kind || '') === STAKE_REWARD_KIND);
}

/** Hex root on the coinbase, '' when the block carries none, 'bad' when it is not 32 bytes. */
export function blockRewardRoot(block) {
  const txs = Array.isArray(block?.txs) ? block.txs : [];
  const cb = txs.find((tx) => tx?.coinbase) || null;
  const raw = cb?.rewardRoot;
  if (raw == null || raw === '') return '';
  const hex = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw).replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : 'bad';
}

/**
 * The epoch-end coinbase carries one root, or it carries no reward.
 * A stake-reward coinbase row is the dropped per-payee path.
 * A withdraw does not excuse a missing root. The root is required when
 * the caller says so and a reward is due.
 */
export function stakeRewardRejected(state, block, nowMs, { require = false } = {}) {
  if (!state || state.blankFork) return null;
  if (stakeRewardNotesOf(block).length) return { ok: false, reason: 'stake_reward' };
  const got = blockRewardRoot(block);
  if (got === 'bad') return { ok: false, reason: 'stake_reward' };
  const plan = rewardCommitment(state, nowMs);
  if (got) {
    if (got !== plan.root) return { ok: false, reason: 'stake_reward' };
    return null;
  }
  if (!require) return null;
  if (plan.rows.length) return { ok: false, reason: 'stake_reward' };
  return null;
}

function rewardAlreadyMinted(state, portal, nowMs) {
  const nowIdx = settlementIndex(state, nowMs);
  const credited = portal?.creditedEpochs || {};
  const hit = (epoch) => epoch < nowIdx && credited[epoch]
    && state.mintedIds?.[withdrawMintId(portal.id, epoch)];
  let matured = false;
  for (const tranche of portal?.tranches || []) {
    const arrival = Math.floor(Number(tranche.epoch) || 0);
    if (nowIdx <= arrival) continue;
    matured = true;
    for (let e = arrival; e < nowIdx; e += 1) {
      if (hit(e)) return true;
    }
  }
  if (!matured && !(portal?.tranches || []).length) {
    for (const key of Object.keys(credited)) {
      if (hit(Number(key))) return true;
    }
  }
  return false;
}

/** Principal leaves only through withdraw. Epoch end does not drop it. */
function releaseMaturedPrincipal(state, nowMs, holdLegacyIds = null) {
  void state;
  void nowMs;
  void holdLegacyIds;
  return 0n;
}

function ensureRewardMaps(state) {
  if (!state.rewardRoots) state.rewardRoots = Object.create(null);
  if (!state.rewardBook) state.rewardBook = Object.create(null);
  if (!state.rewardSets) state.rewardSets = Object.create(null);
}

/**
 * Root the coinbase should carry when this epoch has earning rows.
 * An empty earning set does not force a root. Principal stays until withdraw.
 */
export function coinbaseRewardRoot(state, nowMs) {
  const plan = rewardCommitment(state, nowMs);
  if (plan.rows.length) return plan.root;
  return '';
}

/**
 * Archive the root. Nothing is minted here, and principal is not released.
 * A claim tx mints one archived row later and does not touch principal.
 * An epoch with no earning rows stores nothing.
 */
export function applyStakeRewards(state, block, nowMs, { require = false } = {}) {
  const rejected = stakeRewardRejected(state, block, nowMs, { require });
  if (rejected) return { ok: false, reason: rejected.reason || 'stake_reward', minted: 0n, principal: 0n };
  const plan = rewardCommitment(state, nowMs);
  const got = blockRewardRoot(block);
  if (got && got !== plan.root) {
    return { ok: false, reason: 'stake_reward', minted: 0n, principal: 0n };
  }
  const hold = withdrawPortalIds(block);
  if (!plan.rows.length) {
    if (!(plan.index > 0)) {
      return { ok: true, minted: 0n, principal: 0n, skipped: true };
    }
    const prior = state.rewardRoots?.[String(plan.index)];
    if (got && prior && prior !== got) {
      return { ok: false, reason: 'stake_reward', minted: 0n, principal: 0n };
    }
    const principal = releaseMaturedPrincipal(state, nowMs, hold);
    return { ok: true, minted: 0n, principal, root: got || '', skipped: false };
  }
  if (!got) return { ok: true, minted: 0n, principal: 0n, skipped: true };
  ensureRewardMaps(state);
  const key = String(plan.index);
  const prior = state.rewardRoots[key];
  if (prior && prior !== plan.root) {
    return { ok: false, reason: 'stake_reward', minted: 0n, principal: 0n };
  }
  state.rewardRoots[key] = plan.root;
  state.rewardSets[key] = plan.rows.map((row) => ({
    nullifier: row.nullifier,
    nanos: row.nanos,
    epoch: row.epoch,
    portalId: row.portalId,
    ownerPub: row.ownerPub || '',
  }));
  // A portal that already has a claimable leaf does not get this block's
  // new leaves marked paid. The withdraw pays principal, and the claim
  // still owns every archived row, including the one just stored.
  const claimOwned = new Set();
  for (const row of plan.rows) {
    const id = String(row.portalId || '').toLowerCase();
    if (id && rewardReserved(state, id)) claimOwned.add(id);
  }
  for (const row of plan.rows) {
    const have = state.rewardBook[row.nullifier];
    if (have && (have.nanos !== row.nanos || have.rootKey !== key)) {
      return { ok: false, reason: 'stake_reward', minted: 0n, principal: 0n };
    }
    const portalId = String(row.portalId || '').toLowerCase();
    const paidHere = (hold.has(portalId) && !claimOwned.has(portalId)) || have?.settledByWithdraw === true;
    const entry = {
      nanos: row.nanos,
      epoch: row.epoch,
      rootKey: key,
      portalId: row.portalId,
      ownerPub: row.ownerPub || '',
    };
    if (paidHere) entry.settledByWithdraw = true;
    state.rewardBook[row.nullifier] = entry;
  }
  const principal = releaseMaturedPrincipal(state, nowMs, hold);
  return { ok: true, minted: 0n, principal, root: plan.root, skipped: false };
}

function claimNoteOpens(tx, nanos) {
  const notes = (Array.isArray(tx?.vout) ? tx.vout : []).filter((row) => String(row?.kind || '') === KIND_REWARD_CLAIM);
  if (notes.length !== 1) return false;
  const note = notes[0];
  if (!verifySealedNote(note, nanos)) return false;
  if (!fs1LeafFor(note)) return false;
  const proofV = Math.floor(Number(note?.valueProof?.v));
  return proofV === nanos;
}

/**
 * The claim output address. This is the payout, not the lock dest.
 */
function claimDestOf(tx) {
  const note = (Array.isArray(tx?.vout) ? tx.vout : []).find((row) => String(row?.kind || '') === KIND_REWARD_CLAIM);
  return String(note?.address || tx?.to || '');
}

function dest20Hex(raw) {
  try {
    if (typeof raw === 'string') {
      const hex = raw.replace(/^0x/i, '');
      if (/^[0-9a-f]{40}$/i.test(hex)) return hex.toLowerCase();
      return '';
    }
    const b = Buffer.from(asU8(raw));
    if (b.length >= 20) return Buffer.from(b.subarray(0, 20)).toString('hex');
  } catch { /* not a dest20 */ }
  return '';
}

/** The one-time dest20 hex. An address on `to` is not the signed payout. */
export function withdrawSignedDest(tx, act) {
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const note = outs.find((row) => String(row?.kind || '') === KIND_WITHDRAW);
  return dest20Hex(note?.dest20) || dest20Hex(tx?.dest20) || String(act?.payout || '');
}

/**
 * A withdraw of principal must be signed by the portal owner.
 * The message is the portal id, the principal, and the payout destination.
 * The withdraw names the lock, so it is linkable to that lock.
 * A portal with no recorded owner is refused.
 */
export function withdrawRewardRejected(state, tx, nowMs) {
  if (String(tx?.kind || '') !== KIND_WITHDRAW) return null;
  const act = reserveAction(tx);
  const id = act?.portalId || '';
  const portal = id && state?.portals ? state.portals[id] : null;
  const owner = String(portal?.ownerPub || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(owner)) return { ok: false, reason: 'owner_missing', nanos: 0 };
  const hidden = maturedHiddenCommits(state, portal, nowMs);
  // The owner signs the released principal: one π per retired leaf.
  // The receipt is that principal plus the arrival stub, and is not the signed amount.
  let principal = Math.floor(Number(withdrawablePrincipal(state, portal, nowMs)) || 0);
  if (hidden.length) {
    const indexed = hidden.some((hex) => state?.vaultLockIndex?.[hex]);
    if (indexed) {
      const proofs = Array.isArray(tx?.retireProofs) && tx.retireProofs.length
        ? tx.retireProofs.length
        : (tx?.retireProof ? 1 : 0);
      principal = proofs * PI_SHE_NANOS;
    } else {
      principal = Math.floor(Number(act?.nanos) || 0);
    }
  }
  if (!hidden.length && !(principal > 0)) return null;
  const presented = String(tx?.ownerPub || '').replace(/^0x/i, '').toLowerCase();
  if (presented && presented !== owner) return { ok: false, reason: 'unsigned', nanos: 0 };
  // An address-bearing body is signed over that address. A body with no `to`
  // is signed over the one-time dest20 hex. dest20 is not preferred while
  // `to` is present: those signatures are over the address string.
  const dest = withdrawSignedDest(tx, act);
  const bind = withdrawBinding(state, portal, nowMs);
  const firstProof = tx?.retireProof || (Array.isArray(tx?.retireProofs) ? tx.retireProofs[0] : null);
  const message = withdrawOwnerMessage({
    nullifier: id,
    nanos: principal,
    dest,
    magic: bind.magic,
    chainId: bind.chainId,
    epoch: bind.epoch,
    trancheSet: bind.trancheSet,
    txBind: proofTxBind(firstProof),
  });
  if (!verifyRewardAuth(message, owner, tx?.rewardSig)) return { ok: false, reason: 'unsigned', nanos: 0 };
  return null;
}

const VAULT_LOCK_HANDLES = new WeakMap();
const EPOCH_MINT_TAG = 'shear-epoch-mint-v1';
const ROLL_OWNER_TAG = 'shear-reward-roll-v1';

function claimHeight(height) {
  if (height == null || height === '') return null;
  const n = Math.floor(Number(height) || 0);
  return Number.isFinite(n) ? n : 0;
}

function lockNoteBytes(note) {
  if (note == null || note === '') return null;
  if (typeof note === 'string' && /^[0-9a-fA-F]{128}$/.test(note)) return Buffer.from(note, 'hex');
  try {
    const raw = Buffer.from(asU8(note));
    return raw.length === 64 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Append one vault-lock note. Many locks share an epoch. Each stores its
 * own remainder commitment. The remainder integer is not recorded.
 */
function liveVaultNotes(state) {
  const notes = Array.isArray(state?.vaultLockNotes) ? state.vaultLockNotes : [];
  const retired = state?.vaultRetired || {};
  return notes.filter((hex) => !retired[hex]);
}

/** A snapshot that lost the index still names each leaf by its note. */
function rebuildVaultLockIndex(state) {
  if (!state) return;
  if (!state.vaultLockIndex) state.vaultLockIndex = Object.create(null);
  const notes = Array.isArray(state.vaultLockNotes) ? state.vaultLockNotes : [];
  for (const hex of notes) {
    if (typeof hex !== 'string' || hex.length < 128) continue;
    const commit = hex.slice(64, 128).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(commit)) continue;
    if (!state.vaultLockIndex[commit]) state.vaultLockIndex[commit] = hex.toLowerCase();
  }
}

/** Rebuild the FS-1 root from notes a withdraw has not retired. */
function rebuildVaultLockRoot(state) {
  const live = liveVaultNotes(state);
  const handle = fs1TreeNew();
  if (!handle) return null;
  if (live.length && !fs1TreeAppend(handle, Buffer.concat(live.map((hex) => Buffer.from(hex, 'hex'))))) return null;
  VAULT_LOCK_HANDLES.set(state, { handle, n: live.length });
  if (!live.length) {
    state.vaultLockRoot = EMPTY_VAULT_ROOT;
    return state.vaultLockRoot;
  }
  const root = fs1TreeRoot(handle);
  if (!root || root.length !== 32) return null;
  state.vaultLockRoot = root.toString('hex');
  return state.vaultLockRoot;
}

function retireVaultLeaf(state, commitHex) {
  const noteHex = state?.vaultLockIndex?.[commitHex];
  if (!noteHex) return { retired: false };
  if (!state.vaultRetired) state.vaultRetired = Object.create(null);
  state.vaultRetired[noteHex] = true;
  state.vaultLockDirty = true;
  return { retired: true, noteHex };
}

/** One rebuild per block. A retire during the block only marks the leaf. */
function flushVaultLockRoot(state) {
  if (!state?.vaultLockDirty) return state?.vaultLockRoot || null;
  const root = rebuildVaultLockRoot(state);
  if (!root) return null;
  state.vaultLockDirty = false;
  return root;
}

/** Rebuild after trials that deferred the vault-lock tree. Null on failure. */
export function commitVaultLockRoot(state) {
  if (!state) return null;
  return flushVaultLockRoot(state);
}

export function appendVaultLockNote(state, note, terms = null) {
  const buf = lockNoteBytes(note);
  if (!state || !buf) return null;
  if (!Array.isArray(state.vaultLockNotes)) state.vaultLockNotes = [];
  const notes = state.vaultLockNotes;
  const retired = state.vaultRetired || {};
  const liveBefore = notes.filter((hex) => !retired[hex]);
  if (liveBefore.length >= MAX_LIVE_VAULT_LEAVES) return null;
  let slot = VAULT_LOCK_HANDLES.get(state);
  if (!slot || slot.n !== liveBefore.length) {
    const handle = fs1TreeNew();
    if (!handle) return null;
    if (liveBefore.length && !fs1TreeAppend(handle, Buffer.concat(liveBefore.map((hex) => Buffer.from(hex, 'hex'))))) return null;
    slot = { handle, n: liveBefore.length };
    VAULT_LOCK_HANDLES.set(state, slot);
  }
  if (!fs1TreeAppend(slot.handle, buf)) return null;
  slot.n += 1;
  const noteHex = buf.toString('hex');
  notes.push(noteHex);
  if (terms?.remainCommit) {
    const earn = String(Math.floor(Number(terms.earnEpoch) || 0));
    const commit = String(terms.remainCommit).replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(commit)) return null;
    if (!state.vaultRemainCommits) state.vaultRemainCommits = Object.create(null);
    if (!state.vaultRemainCommits[earn]) state.vaultRemainCommits[earn] = Object.create(null);
    state.vaultRemainCommits[earn][commit] = true;
    if (!state.vaultLeafRemain) state.vaultLeafRemain = Object.create(null);
    state.vaultLeafRemain[noteHex] = commit;
    if (!state.vaultRemainLeaf) state.vaultRemainLeaf = Object.create(null);
    state.vaultRemainLeaf[commit] = noteHex;
  }
  if (!state.vaultLockIndex) state.vaultLockIndex = Object.create(null);
  state.vaultLockIndex[buf.subarray(32, 64).toString('hex')] = noteHex;
  if (!state.vaultLeafBorn) state.vaultLeafBorn = Object.create(null);
  const born = Math.floor(Number(terms?.bornEpoch ?? terms?.earnEpoch) || 0);
  state.vaultLeafBorn[noteHex] = born;
  if (terms?.unlockEpoch != null && terms.unlockEpoch !== '') {
    const unlock = String(terms.unlockEpoch);
    if (unlock !== String(VAULT_UNLOCK_OPEN)) {
      if (!state.vaultLeafUnlock) state.vaultLeafUnlock = Object.create(null);
      state.vaultLeafUnlock[noteHex] = unlock;
    }
  }
  if (terms?.lockHeight != null && terms.lockHeight !== '') {
    const at = Math.floor(Number(terms.lockHeight));
    if (Number.isInteger(at) && at >= 0) {
      if (!state.vaultLeafHeight) state.vaultLeafHeight = Object.create(null);
      state.vaultLeafHeight[noteHex] = at;
    }
  }
  const root = fs1TreeRoot(slot.handle);
  if (!root || root.length !== 32) return null;
  state.vaultLockRoot = root.toString('hex');
  return state.vaultLockRoot;
}

function storeVaultLockRoot(state, block, index) {
  const cb = (block?.txs || []).find((tx) => tx?.coinbase) || null;
  const raw = cb?.vaultLockRoot;
  if (raw == null || raw === '') return null;
  const hex = Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return { ok: false, reason: 'stake_reward' };
  if (hex === '0'.repeat(64)) return { ok: false, reason: 'stake_reward' };
  if (hex === EMPTY_VAULT_ROOT) return null;
  if (!(index > 0)) return { ok: false, reason: 'stake_reward' };
  const key = String(index - 1);
  if (!state.vaultLockRoots) state.vaultLockRoots = Object.create(null);
  const prior = state.vaultLockRoots[key];
  const tip = String(state.vaultLockRoot || '');
  if (tip && tip !== hex) return { ok: false, reason: 'stake_reward' };
  if (prior && prior !== hex) return { ok: false, reason: 'stake_reward' };
  state.vaultLockRoots[key] = hex;
  return null;
}

function addLockCommit(state, epoch, commitBuf) {
  const key = String(epoch);
  if (!state.lockCommitSum) state.lockCommitSum = Object.create(null);
  if (!state.lockCommitCount) state.lockCommitCount = Object.create(null);
  const p = pointFrom(commitBuf);
  const prev = state.lockCommitSum[key];
  const sum = prev ? pointFrom(Buffer.from(prev, 'hex')).add(p) : p;
  state.lockCommitSum[key] = pointBytes(sum).toString('hex');
  state.lockCommitCount[key] = Number(state.lockCommitCount[key] || 0) + 1;
}

function epochDeadlineReached(state, epoch, height) {
  const closed = state?.epochClosedAtHeight?.[String(epoch)];
  if (closed == null || !(height > 0)) return false;
  return height >= Number(closed) + VAULT_MINT_DELAY_BLOCKS;
}

function markEpochsClosed(state, nowMs, height) {
  if (!(height > 0)) return;
  const genesis = Number(state?.genesisMs) || 0;
  const span = epochMs(state?.magic);
  if (!(genesis > 0) || !(span > 0)) return;
  const idx = chainEpochIndex(state, nowMs);
  if (!state.epochClosedAtHeight) state.epochClosedAtHeight = Object.create(null);
  for (let e = 0; e < idx; e += 1) {
    const key = String(e);
    if (state.epochClosedAtHeight[key] == null) state.epochClosedAtHeight[key] = height;
  }
}

function coinbaseOf(block) {
  return (block?.txs || []).find((tx) => tx?.coinbase) || null;
}

function plaintextOpeningRejected(block, fields) {
  const cb = coinbaseOf(block);
  if (!cb) return null;
  for (const name of fields) {
    const value = cb[name];
    if (value == null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return { ok: false, reason: 'stake_reward' };
  }
  return null;
}

/**
 * A withdraw total is not opened. The released commitments stay a list of
 * points. A plaintext total on the coinbase is a forged sum.
 */
function settleWithdrawTotal(state, block, height) {
  void state;
  void height;
  return plaintextOpeningRejected(block, ['epochWithdrawTotal', 'epochWithdrawTotals', 'epochWithdrawProof']);
}

/**
 * A lock-epoch sum is the homomorphic commitment total. It is not opened.
 * Close + 4 does not refuse the block. A plaintext total is a forged sum.
 */
function settleLockTotal(state, block, height) {
  void state;
  void height;
  return plaintextOpeningRejected(block, ['epochLockTotal', 'epochLockTotals', 'epochLockProof']);
}

/** A fund proof stays valid for this many blocks after the height it names. */
export const LOCK_FUND_HEIGHT_WINDOW = 4;

function fundBoundHeight(height) {
  const at = Math.floor(Number(height));
  if (!Number.isSafeInteger(at) || at < 0) return null;
  return at;
}

/**
 * Transcript for the lock-leaf equality proof: domain, the tx hash, and the
 * height the proof names. A block in [height, height + window] still accepts it.
 * The free id string is not in the hash.
 */
export function lockFundContext(tx, height, magic) {
  const at = fundBoundHeight(height);
  if (at == null) return null;
  let digest;
  try { digest = txDigestV3(tx, magic || MAGIC_TESTNET); } catch { return null; }
  if (!digest || digest.length !== 32) return null;
  return Buffer.concat([Buffer.from(LOCK_FUND_DST), digest, u64le(at)]);
}

export function fundHeightAccepted(proofHeight, blockHeight) {
  const bound = fundBoundHeight(proofHeight);
  const now = fundBoundHeight(blockHeight);
  if (bound == null || now == null) return false;
  return now >= bound && now <= bound + LOCK_FUND_HEIGHT_WINDOW;
}

function schnorrH(P, s, extra) {
  const k = randomScalar();
  const R = H.multiply(k);
  const e = hashToScalar(pointBytes(P), pointBytes(R), extra);
  const z = Fn.add(k, Fn.mul(e, s));
  return { R: pointBytes(R), z: scalarBytes(z) };
}

function schnorrHOk(P, R, z, extra) {
  try {
    const e = hashToScalar(pointBytes(P), R, extra);
    return H.multiply(scalarFrom(z)).equals(pointFrom(R).add(P.multiply(e)));
  } catch {
    return false;
  }
}

function remainExtra(tx, magic, commit) {
  const digest = txDigestV3(tx, magic || MAGIC_TESTNET);
  return Buffer.concat([Buffer.from(REMAIN_OPEN_DST), digest, Buffer.from(commit)]);
}

/** Remainder left in the open epoch. The same integer noteCredit stores. */
export function consensusRemainMs(state, nowMs) {
  const idx = chainEpochIndex(state, nowMs);
  const span = epochMs(state?.magic);
  const genesis = Number(state?.genesisMs) || 0;
  const end = genesis > 0 ? genesis + (idx + 1) * span : 0;
  const now = Number(nowMs) || 0;
  let remain = end > now ? end - now : 0;
  if (span > 0 && remain > span) remain = span;
  return remain;
}

/** Opening of `remainMs` bound to this tx hash. The integer is the consensus remainder. */
export function proveRemainOpen(remainMs, blind, tx, magic = MAGIC_TESTNET) {
  let n;
  try { n = BigInt(remainMs); } catch { return null; }
  if (n < 0n || n > 0xffffffffffffffffn) return null;
  let r;
  try { r = typeof blind === 'bigint' ? blind : scalarFrom(blind); } catch { return null; }
  const C = commit(n, r);
  const P = C.subtract(G.multiply(Fn.create(n)));
  if (!P.equals(H.multiply(r))) return null;
  const bytes = pointBytes(C);
  let extra;
  try { extra = remainExtra(tx, magic, bytes); } catch { return null; }
  const sig = schnorrH(P, r, extra);
  return { commit: bytes, R: sig.R, z: sig.z };
}

/** True when `commit` opens to `remainMs` under a proof bound to this tx hash. */
export function verifyRemainOpen(commit, remainMs, proof, tx, magic = MAGIC_TESTNET) {
  try {
    const n = BigInt(remainMs);
    if (n < 0n || n > 0xffffffffffffffffn) return false;
    const raw = Buffer.from(asU8(commit));
    if (raw.length !== 32 || !proof?.R || !proof?.z) return false;
    const C = pointFrom(raw);
    const P = C.subtract(G.multiply(Fn.create(n)));
    return schnorrHOk(P, proof.R, proof.z, remainExtra(tx, magic, raw));
  } catch {
    return false;
  }
}

const LOCK_UNLOCK_DST = Buffer.from('shear-vault-lock-unlock-v1');

/**
 * The lock-leaf transcript plus the consensus unlock. A proof for another
 * unlock, including 0 and the open sentinel, does not verify.
 */
export function lockUnlockContext(tx, height, magic, unlock) {
  const base = lockFundContext(tx, height, magic);
  if (!base) return null;
  let u;
  try { u = BigInt(unlock); } catch { return null; }
  if (u <= 0n || u === VAULT_UNLOCK_OPEN || u > 0xffffffffffffffffn) return null;
  return Buffer.concat([base, LOCK_UNLOCK_DST, u64le(u)]);
}

function leafFundingPoint(lockCommit, outCommit, unlock) {
  return subtractUnlock(pointFrom(lockCommit).subtract(pointFrom(outCommit)), unlock);
}

function sameCommitValue(lockCommit, outCommit, proof, extra, unlock) {
  try {
    const P = leafFundingPoint(lockCommit, outCommit, unlock);
    if (pointBytes(P).equals(pointBytes(RistrettoPoint.ZERO))) return !!extra;
    if (!extra || !proof?.R || !proof?.z) return false;
    const e = hashToScalar(pointBytes(P), proof.R, extra);
    return H.multiply(scalarFrom(proof.z)).equals(pointFrom(proof.R).add(P.multiply(e)));
  } catch {
    return false;
  }
}

function consumedLockOutput(tx) {
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const rows = outs.filter((row) => String(row?.kind || tx?.kind || '') === KIND_LOCK);
  return rows.length === 1 ? rows[0] : null;
}

/**
 * The lock leaf equals the funded output plus the consensus unlock and a blind.
 * leaf = funded + unlock·U + H·s. The proof is bound to this tx, the height,
 * and that unlock. Unlock 0 and the open sentinel are refused. The amount
 * is not read.
 */
export function lockFundingRejected(tx, ctx = {}) {
  const note = lockNoteBytes(tx?.vaultLockNote);
  if (!note) return null;
  if (Math.floor(Number(tx?.nanos) || 0) > 0) return { ok: false, reason: 'stake_reward' };
  const out = consumedLockOutput(tx);
  if (!out) return { ok: false, reason: 'stake_reward' };
  let raw = null;
  try { raw = out?.commit ? Buffer.from(asU8(out.commit)) : null; } catch { raw = null; }
  if (!raw || raw.length !== 32) return { ok: false, reason: 'stake_reward' };
  const range = out?.rangeProof;
  if (!range || !verifyRange(raw, range)) return { ok: false, reason: 'stake_reward' };
  let unlock;
  try { unlock = BigInt(ctx.unlock); } catch { return { ok: false, reason: 'stake_reward' }; }
  if (unlock <= 0n || unlock === VAULT_UNLOCK_OPEN || unlock > 0xffffffffffffffffn) {
    return { ok: false, reason: 'stake_reward' };
  }
  const want = note.subarray(32, 64);
  let same = false;
  try {
    same = pointBytes(leafFundingPoint(want, raw, unlock)).equals(pointBytes(RistrettoPoint.ZERO));
  } catch {
    same = false;
  }
  const boundHeight = same ? ctx.height : out.fundProof?.height;
  if (!same && !fundHeightAccepted(boundHeight, ctx.height)) return { ok: false, reason: 'stake_reward' };
  const extra = lockUnlockContext(tx, boundHeight, ctx.magic, unlock);
  if (!sameCommitValue(want, raw, out.fundProof, extra, unlock)) return { ok: false, reason: 'stake_reward' };
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  for (const row of outs) {
    if (row?.valueProof?.v != null && Math.floor(Number(row.valueProof.v) || 0) > 0) {
      return { ok: false, reason: 'stake_reward' };
    }
  }
  return null;
}

function lockOutput(tx) {
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  return outs.find((row) => String(row?.kind || tx?.kind || '') === KIND_LOCK) || outs[0] || null;
}

const PRINCIPAL_OPEN_DST = Buffer.from('shear-withdraw-principal-v1');
/** Wallet-only witness so a test can bind the equality proof after the vin is set. Not chain state. */
const LOCK_WITNESS = new WeakMap();

/** Opening of `amount` under `blind` for this lock commitment, bound to the tx hash and height. */
export function proveLockEquality(commitBuf, amount, blind, tx, magic = MAGIC_TESTNET, height = 0) {
  try {
    const n = BigInt(amount);
    const r = typeof blind === 'bigint' ? blind : scalarFrom(blind);
    const at = fundBoundHeight(height);
    const extra = lockFundContext(tx, at, magic);
    if (!extra || at == null || n < 0n) return null;
    const P = pointFrom(commitBuf).subtract(G.multiply(Fn.create(n)));
    if (!P.equals(H.multiply(r))) return null;
    return { ...schnorrH(P, r, extra), height: at };
  } catch {
    return null;
  }
}

function verifyLockEquality(commitBuf, amount, proof, tx, magic) {
  try {
    const n = BigInt(amount);
    const extra = lockFundContext(tx, proof?.height, magic);
    if (!extra || n < 0n || !proof?.R || !proof?.z) return false;
    const P = pointFrom(commitBuf).subtract(G.multiply(Fn.create(n)));
    return schnorrHOk(P, proof.R, proof.z, extra);
  } catch {
    return false;
  }
}

/**
 * Each lock leaf is the public constant π. A non-π output is change, not a
 * leaf, and this returns 0 when any lock output fails the public open-to-π
 * check. N leaves credit N×π, which is the sum of the per-leaf floors' principal.
 */
export function lockNotePrincipal(tx, magic = MAGIC_TESTNET) {
  if (!tx || tx.coinbase || String(tx.kind || tx.vout?.[0]?.kind || '') !== KIND_LOCK) return 0n;
  if (publicReserveReceipt(tx)) return 0n;
  const outs = (Array.isArray(tx.vout) ? tx.vout : []).filter((row) => String(row?.kind || '') === KIND_LOCK);
  if (!outs.length || outs.length > MAX_LOCK_LEAVES) return 0n;
  for (const out of outs) {
    if (!out?.commit || !verifyLockEquality(out.commit, VAULT_PI_LEAF, out.fundProof, tx, magic)) return 0n;
  }
  return VAULT_PI_LEAF * BigInt(outs.length);
}

/** Bind the lock commitment to its hidden amount after vin and fee are final. */
export function lockWitnessOf(tx) {
  return LOCK_WITNESS.get(tx) || null;
}

export function attachLockEquality(tx, magic = MAGIC_TESTNET) {
  const held = LOCK_WITNESS.get(tx);
  if (!held) return false;
  const outs = (Array.isArray(tx?.vout) ? tx.vout : []).filter((row) => String(row?.kind || '') === KIND_LOCK);
  const leaves = Array.isArray(held.leaves) && held.leaves.length
    ? held.leaves
    : [{ amount: held.amount, blind: held.blind }];
  if (!outs.length || outs.length !== leaves.length) return false;
  for (let i = 0; i < outs.length; i += 1) {
    const proof = proveLockEquality(outs[i].commit, leaves[i].amount, leaves[i].blind, tx, magic);
    if (!proof) return false;
    outs[i].fundProof = proof;
  }
  return true;
}

function portalWord(portalId) {
  const raw = String(portalId || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(raw)) return null;
  return Buffer.from(raw, 'hex');
}

/** Domain || tx digest || portal id. A proof with no tx is not a consensus opening. */
function principalTranscript(tx, portalId, magic) {
  const portal = portalWord(portalId);
  if (!portal || !tx) return null;
  let digest;
  try { digest = txDigestV3(tx, magic || MAGIC_TESTNET); } catch { return null; }
  if (!digest || digest.length !== 32) return null;
  return Buffer.concat([PRINCIPAL_OPEN_DST, digest, portal]);
}

/** Opening of a hidden lock commitment to the published withdraw integer, bound to this tx and portal. */
export function provePrincipalOpen(commitBuf, amount, blind, tx, portalId, magic = MAGIC_TESTNET, unlock = 0) {
  try {
    const n = BigInt(amount);
    const r = typeof blind === 'bigint' ? blind : scalarFrom(blind);
    const extra = principalTranscript(tx, portalId, magic);
    if (!extra || n < 0n) return null;
    const P = subtractUnlock(pointFrom(commitBuf).subtract(G.multiply(Fn.create(n))), unlock);
    if (!P.equals(H.multiply(r))) return null;
    const sig = schnorrH(P, r, extra);
    const opened = n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
    const u = BigInt(unlock || 0);
    return u === 0n ? { ...sig, opened } : { ...sig, opened, unlock: u.toString() };
  } catch {
    return null;
  }
}

/**
 * The opening is pure in the commitment, the amount, the Schnorr, the
 * unlock, and the tx transcript. Queue and the template both check it.
 * A hit skips the scalar multiply. A miss still runs the same relation.
 */
const principalOpenCache = new Map();
const PRINCIPAL_OPEN_MAX = 4096;

export function verifyPrincipalOpen(commitBuf, amount, proof, tx, portalId, magic = MAGIC_TESTNET) {
  try {
    const n = BigInt(amount);
    const extra = principalTranscript(tx, portalId, magic);
    if (!extra || n < 0n || !proof?.R || !proof?.z) return false;
    const commit = Buffer.from(asU8(commitBuf));
    const R = Buffer.from(asU8(proof.R));
    const z = Buffer.from(asU8(proof.z));
    const key = createHash('sha256')
      .update(commit)
      .update(extra)
      .update(R)
      .update(z)
      .update(Buffer.from(n.toString()))
      .update(Buffer.from(String(proof.unlock || 0)))
      .digest('hex');
    if (principalOpenCache.has(key)) return principalOpenCache.get(key);
    const P = subtractUnlock(pointFrom(commit).subtract(G.multiply(Fn.create(n))), proof?.unlock || 0);
    const ok = schnorrHOk(P, R, z, extra);
    if (principalOpenCache.size >= PRINCIPAL_OPEN_MAX) {
      principalOpenCache.delete(principalOpenCache.keys().next().value);
    }
    principalOpenCache.set(key, ok);
    return ok;
  } catch {
    return false;
  }
}

function hiddenClaimNote(tx) {
  const notes = (Array.isArray(tx?.vout) ? tx.vout : []).filter((row) => String(row?.kind || '') === KIND_REWARD_CLAIM);
  return notes.length === 1 ? notes[0] : null;
}

function leafForRemain(state, remainHex) {
  const note = state?.vaultRemainLeaf?.[remainHex];
  return typeof note === 'string' && note.length === 128 ? note : null;
}

function leafCommitOf(noteHex) {
  try {
    const note = Buffer.from(String(noteHex), 'hex');
    return note.length === 64 ? note.subarray(32, 64) : null;
  } catch {
    return null;
  }
}

/**
 * A claim is proved against the full lock set frozen at the start of the
 * earning epoch, including epoch 0. The remainder index is not a lookup.
 */
function consensusClaim(state, tx) {
  const earnEpoch = Math.floor(Number(tx?.earnEpoch));
  const rootEpoch = Math.floor(Number(tx?.rootEpoch));
  if (!Number.isInteger(earnEpoch) || earnEpoch < 0 || earnEpoch !== rootEpoch) return null;
  const magic = state?.magic || MAGIC_TESTNET;
  const blocks = vaultEpochBlocks(magic);
  const period = vaultPeriodBlocks(magic);
  const bps = rateForEpoch(state, epochOfPeriod(earnEpoch));
  if (!(bps > 0) || !(blocks > 0) || !(period > 0)) return null;
  const start = String(state?.epochStartRoots?.[String(earnEpoch)] || '');
  if (!/^[0-9a-f]{64}$/.test(start)) return null;
  const reward = vaultPublicReward(tx?.vaultProof);
  if (reward == null) return null;
  const constant = vaultAccrualNanos(PI_SHE_NANOS, bps, period, blocks);
  if (!constant || constant.nanos !== reward) return null;
  return {
    bps,
    span: BigInt(blocks),
    covered: BigInt(period),
    earnEpoch,
    root: start,
    reward,
  };
}

function publishedClaimReward(tx) {
  const raw = tx?.nanos;
  if (typeof raw === 'bigint' && raw >= 0n) return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    try { return BigInt(raw.trim()); } catch { return null; }
  }
  return null;
}

function vaultClaimRejected(tx, state) {
  if (tx?.portalId || tx?.from || tx?.payoutPortalId || tx?.to) return { ok: false, reason: 'stake_reward' };
  const nullifier = String(tx?.nullifier || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(nullifier)) return { ok: false, reason: 'unsigned' };
  const tip = Number(state?.tipMs) || 0;
  if (tip > 0 && state?.genesisMs) {
    const period = Math.floor(Number(tx?.earnEpoch) || 0);
    const claimEpoch = epochOfPeriod(period);
    const nowIdx = chainEpochIndex(state, tip);
    if (nowIdx > claimEpoch + VAULT_CLAIM_WINDOW_EPOCHS) return { ok: false, reason: 'stake_reward' };
  }
  const terms = consensusClaim(state, tx);
  if (!terms) return { ok: false, reason: 'stake_reward' };
  const bound = vaultProofCap(tx.vaultProof);
  if (!bound) return { ok: false, reason: 'stake_reward' };
  const published = publishedClaimReward(tx);
  if (published == null || published !== terms.reward) return { ok: false, reason: 'stake_reward' };
  const levy = Math.floor(Number(levyNanos(0, { tx })) || 0);
  if (published < BigInt(levy)) return { ok: false, reason: 'levy' };
  const shown = published <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(published) : null;
  if (shown == null || !claimNoteOpens(tx, shown)) return { ok: false, reason: 'stake_reward' };
  const got = verifyVaultReward({
    blob: tx.vaultProof,
    root: Buffer.from(terms.root, 'hex'),
    rootEpoch: terms.earnEpoch,
    nullifier: Buffer.from(nullifier, 'hex'),
    output: hiddenClaimNote(tx),
    terms,
    magic: state?.magic || MAGIC_TESTNET,
  });
  if (!got.ok) return { ok: false, reason: got.reason || 'unsigned' };
  return null;
}

function addPointSum(prevHex, commitBuf) {
  const p = pointFrom(commitBuf);
  if (!prevHex) return pointBytes(p).toString('hex');
  return pointBytes(pointFrom(Buffer.from(prevHex, 'hex')).add(p)).toString('hex');
}

function subPointSum(prevHex, commitBuf) {
  if (!prevHex) return null;
  const next = pointFrom(Buffer.from(prevHex, 'hex')).subtract(pointFrom(commitBuf));
  const bytes = pointBytes(next);
  if (bytes.equals(pointBytes(RistrettoPoint.ZERO))) return '';
  return bytes.toString('hex');
}

/**
 * A claim mints the public reward integer when its proof is accepted.
 * A plaintext epoch mint on the coinbase is still rejected.
 */
export function settleVaultMint(state, block, height = 0) {
  void state;
  void height;
  return plaintextOpeningRejected(block, ['epochMint', 'epochMints', 'epochMintProof']);
}

/** Below the FS-1 height a claim is closed. At and after it, the proof is the vault-lock set. */
export function rewardClaimRejected(tx, state = null, height = null) {
  if (String(tx?.kind || tx?.vout?.[0]?.kind || '') !== KIND_REWARD_CLAIM) return null;
  const named = claimHeight(height);
  if (named == null || named < VAULT_FS1_ACTIVATION_HEIGHT) {
    return { ok: false, reason: 'claim_unavailable' };
  }
  return vaultClaimRejected(tx, state);
}

export function applyRewardClaim(state, tx, height = null) {
  if (!state || state.blankFork) return { ok: false, reason: 'no_vault', nanos: 0 };
  if (String(tx?.programId || '') !== RESERVE_PROGRAM) return { ok: false, reason: 'mint_forbidden', nanos: 0 };
  const refused = rewardClaimRejected(tx, state, height);
  if (refused) return { ok: false, reason: refused.reason || 'unsigned', nanos: 0 };
  const nullifier = String(tx?.nullifier || '').toLowerCase();
  if (state.mintedIds?.[nullifier]) return { ok: false, reason: 'double_mint', nanos: 0 };
  const reward = vaultPublicReward(tx?.vaultProof);
  const published = publishedClaimReward(tx);
  if (reward == null || published == null || published !== reward || reward <= 0n) {
    return { ok: false, reason: 'stake_reward', nanos: 0 };
  }
  state.mintedIds = state.mintedIds || Object.create(null);
  rememberMint(state, nullifier);
  state.mintedIds[nullifier] = true;
  if (!state.claimNullifierPeriod) state.claimNullifierPeriod = Object.create(null);
  state.claimNullifierPeriod[nullifier] = Math.floor(Number(tx.earnEpoch) || 0);
  state.mintBankNanos = asBig(state.mintBankNanos) + reward;
  state.rewardPermittedNanos = asBig(state.rewardPermittedNanos) + reward;
  const epoch = String(Math.floor(Number(tx.earnEpoch) || 0));
  if (!state.epochMintNanos) state.epochMintNanos = Object.create(null);
  state.epochMintNanos[epoch] = asBig(state.epochMintNanos[epoch]) + reward;
  return { ok: true, nanos: asNum(reward), nullifier };
}

/** Ordered tranche set. A re-lock changes it, so an old roll signature does not replay. */
export function rollTrancheSet(portal) {
  let h = createHash('sha256').update(Buffer.from('shear-roll-tranche-v1')).digest();
  for (const tranche of portal?.tranches || []) {
    const raw = String(tranche?.commit || '').replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(raw)) continue;
    h = createHash('sha256').update(Buffer.concat([
      h,
      Buffer.from(raw, 'hex'),
      u64le(Math.floor(Number(tranche.epoch) || 0)),
    ])).digest();
  }
  return h;
}

function rollOwnerMessage(portalId, epoch, { magic = null, chainId = null, trancheSet = null } = {}) {
  const id = Buffer.from(String(portalId || '').replace(/^0x/i, ''), 'hex');
  if (id.length !== 32) return null;
  const mag = reserveMagicBytes(magic || MAGIC_TESTNET);
  let chain = WITHDRAW_CHAIN_ID;
  try { if (chainId != null) chain = BigInt(chainId); } catch { return null; }
  if (chain < 0n || chain > 0xffffffffffffffffn) return null;
  const set = trancheSet && trancheSet.length === 32 ? trancheSet : Buffer.alloc(32);
  return Buffer.concat([
    Buffer.from(ROLL_OWNER_TAG),
    id,
    u64le(epoch || 0),
    u64le(chain),
    mag,
    set,
  ]);
}

function rollKey(portalId, epoch) {
  return `${String(portalId || '').toLowerCase()}:${Math.floor(Number(epoch) || 0)}`;
}

/** A matured commitment that already proved it is at least π. The interest integer stays hidden.
 * A post-cutoff arrival does not earn that epoch. Withdrawing the principal
 * leaves the reward due until a proof spends it. */
function hiddenRewardDue(state, portal, nowMs) {
  if (!portal?.qualified && portal?.hiddenRewardOpen !== true) return false;
  if (portal?.hiddenRewardOpen === true) return true;
  const nowIdx = settlementIndex(state, nowMs);
  if (!(nowIdx > 0)) return false;
  for (const tranche of portal.tranches || []) {
    if (!tranche?.commit || !tranche.qualifies) continue;
    const epoch = Math.floor(Number(tranche.epoch) || 0);
    if (earnsStakeReward(state, tranche) && nowIdx > epoch && !tranche.partialPaid) return true;
    const from = Math.floor(Number(tranche.fullFrom ?? epoch + 1));
    if (nowIdx > from && stakeRemain(tranche) > 0) return true;
  }
  return false;
}

/**
 * A roll is the owner's own signed transaction. It does not carry the claim
 * nullifier: publishing both would link the portal to the lock. The claim
 * spends that nullifier on its own transaction.
 */
export function rollRewardRejected(state, tx, nowMs, height = null) {
  if (String(tx?.kind || '') !== 'roll') return null;
  void nowMs;
  void height;
  const id = String(tx?.portalId || '').toLowerCase();
  const portal = id && state?.portals ? state.portals[id] : null;
  const owner = String(portal?.ownerPub || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(owner)) return { ok: false, reason: 'owner_missing' };
  const pub = String(tx?.spendPub || tx?.ownerPub || '').replace(/^0x/i, '').toLowerCase();
  if (pub !== owner) return { ok: false, reason: 'unsigned' };
  if (tx?.vaultProof || tx?.nullifier) return { ok: false, reason: 'stake_reward' };
  const epoch = Math.floor(Number(tx?.earnEpoch) || 0);
  const current = Math.floor(Number(state?.currentEpoch) || 0);
  if (epoch !== current) return { ok: false, reason: 'epoch_open' };
  const key = rollKey(id, epoch);
  if (state?.rolled?.[key]) return { ok: false, reason: 'double_mint' };
  if (state?.withdrewEpoch?.[key]) return { ok: false, reason: 'stake_reward' };
  const chain = chainEpochIndex(state, nowMs);
  if (state?.mintedIds?.[withdrawMintId(id, chain)] || state?.mintedIds?.[withdrawMintId(id, epoch)]) {
    return { ok: false, reason: 'stake_reward' };
  }
  const set = rollTrancheSet(portal);
  const message = rollOwnerMessage(id, epoch, { magic: state?.magic || MAGIC_TESTNET, trancheSet: set });
  if (!message || !verifyRewardAuth(message, owner, tx?.rewardSig)) return { ok: false, reason: 'unsigned' };
  return null;
}

function applyRoll(state, tx, nowMs, height) {
  const refused = rollRewardRejected(state, tx, nowMs, height);
  if (refused) return { ok: false, reason: refused.reason || 'unsigned', interest: 0 };
  const id = String(tx?.portalId || '').toLowerCase();
  const epoch = Math.floor(Number(tx?.earnEpoch) || 0);
  if (!state.rolled) state.rolled = Object.create(null);
  const portal = state.portals?.[id];
  state.rolled[rollKey(id, epoch)] = rollTrancheSet(portal).toString('hex');
  if (!state.rolledLeaf) state.rolledLeaf = Object.create(null);
  for (const tranche of portal?.tranches || []) {
    const raw = String(tranche?.commit || '').replace(/^0x/i, '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(raw)) state.rolledLeaf[`${raw}:${epoch}`] = true;
  }
  return { ok: true, interest: 0, principal: asNum(state.totalLockedNanos) };
}

export function signRollReward(tx, ownerKey, { portalId, epoch, magic = null, chainId = null, state = null, trancheSet = null } = {}) {
  if (!tx || !ownerKey) return tx;
  const id = String(portalId || tx.portalId || '').replace(/^0x/i, '').toLowerCase();
  const set = trancheSet || (state ? rollTrancheSet(state.portals?.[id]) : null);
  const message = rollOwnerMessage(id, epoch, { magic, chainId, trancheSet: set });
  const sig = message ? signRewardAuth(message, ownerKey) : null;
  if (!sig) return tx;
  tx.rewardSig = sig;
  tx.spendPub = ed25519RawPub(ownerKey).toString('hex');
  tx.portalId = id;
  return tx;
}

export function rollTx({ from, id, portalId } = {}) {
  const ident = id == null || String(id) === '' ? `roll-${randomBytes(8).toString('hex')}` : String(id);
  return {
    id: ident,
    programId: RESERVE_PROGRAM,
    kind: 'roll',
    from,
    to: from,
    nanos: 0,
    portalId: portalId || portalIdFromDest(from),
    vin: [],
    vout: [],
  };
}

function rewardReserved(state, portalId) {
  const id = String(portalId || '');
  if (!id) return false;
  for (const row of Object.values(state?.rewardBook || {})) {
    if (row && row.portalId === id && row.settledByWithdraw !== true) return true;
  }
  return false;
}

/** A spend of a lock note before its unlock time. */
export function lockNoteSpendRejected(state, tx, nowMs) {
  const wanted = new Set();
  for (const vin of tx?.vin || []) {
    const a = commitHexOf(vin?.noteCommit);
    const b = commitHexOf(vin?.commit);
    if (a) wanted.add(a);
    if (b) wanted.add(b);
  }
  if (!wanted.size || !state?.portals) return null;
  const tip = Number(nowMs) || 0;
  for (const portal of Object.values(state.portals)) {
    for (const tranche of portal?.tranches || []) {
      const hex = String(tranche.noteCommit || '');
      const unlock = Number(tranche.unlockAtMs) || 0;
      if (!hex || !(unlock > 0) || !wanted.has(hex)) continue;
      if (tip < unlock) return { ok: false, reason: 'locked' };
    }
  }
  return null;
}

/**
 * Epoch label of a withdraw mint. Chain time wins once it has passed the
 * vault's current epoch, so a later deposit is not stuck on the mint id of
 * an earlier withdraw. After a block rolls, the two are the same integer.
 */
function mintEpoch(state, nowMs) {
  const chain = chainEpochIndex(state, nowMs);
  const live = Math.floor(Number(state?.currentEpoch) || 0);
  return chain > live ? chain : live;
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
    vaultLockRoot: EMPTY_VAULT_ROOT,
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
    rewardRoots: Object.create(null),
    rewardBook: Object.create(null),
    rewardSets: Object.create(null),
    epochCensus: Object.create(null),
    ballots: Object.create(null),
    ballotCount: Object.create(null),
    ballotStep: Object.create(null),
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
      if (Array.isArray(row.tranches)) {
        row.tranches = row.tranches.map((t) => ({
          ...t,
          amount: asBig(t?.amount),
        }));
      }
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
  out.rewardRoots = Object.create(null);
  Object.assign(out.rewardRoots, raw.rewardRoots || {});
  out.rewardBook = Object.create(null);
  Object.assign(out.rewardBook, raw.rewardBook || {});
  out.rewardSets = Object.create(null);
  for (const [key, rows] of Object.entries(raw.rewardSets || {})) {
    out.rewardSets[key] = Array.isArray(rows) ? rows.map((row) => ({ ...row })) : rows;
  }
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

/** Homomorphic sum of live hidden lock commitments. Empty when there are none. */
function livePrincipalCommit(vault) {
  let acc = null;
  for (const portal of Object.values(vault?.portals || {})) {
    for (const tranche of portal?.tranches || []) {
      if (tranche?.noteIsPrincipal) continue;
      const raw = commitBytes(tranche?.commit);
      if (!raw) continue;
      const p = pointFrom(raw);
      acc = acc ? acc.add(p) : p;
    }
  }
  return acc ? pointBytes(acc).toString('hex') : '';
}

/**
 * The public locked integer stays the opened legacy net, which is zero for
 * a hidden lock. Hidden principal is the commitment sum of the live lock
 * outputs, each of which was range-proved and balanced by its own author.
 * Spendable notes are not part of this sum.
 */
export function supplyIdentity(state) {
  const vault = state || emptyVault();
  let accrued = 0n;
  for (const p of Object.values(vault.portals || {})) {
    accrued += capReward(p?.accruedReward);
  }
  const feeBank = asBig(vault.feeBankNanos);
  const minted = asBig(vault.mintBankNanos);
  const permitted = schedulePermittedNanos(vault);
  const locked = asBig(vault.totalLockedNanos);
  const principal = asBig(vault.openedLockNanos) - asBig(vault.openedWithdrawNanos);
  const principalCommit = livePrincipalCommit(vault);
  const storedCommit = String(vault.vaultPrincipalSum || '');
  const commitOk = principalCommit === storedCommit;
  const ok = principal >= 0n && feeBank === 0n && minted <= permitted && commitOk;
  return {
    ok,
    reason: ok ? undefined : 'supply',
    principalNanos: asNum(principal),
    lockedNanos: asNum(locked),
    principalCommit,
    vaultNanos: asNum(principal + accrued),
    // Note-backed principal is still supply. The hidden lock integer is not on totalLocked.
    totalNanos: asNum(principal + minted),
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
  const genesis = Number(state?.genesisMs) || 0;
  if (genesis > 0) {
    const span = epochMs(state.magic);
    const idx = chainEpochIndex(state, nowMs);
    const end = genesis + (idx + 1) * span;
    const now = Number(nowMs) || 0;
    return Math.max(0, end - now) >= joinCutoffMs(state.magic);
  }
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

/** Every portal's public tranche rows, plus the arrival stub. No portal is named by the caller. */
export function publicTrancheBook(state) {
  const out = [];
  const portals = state?.portals || {};
  for (const [portalId, portal] of Object.entries(portals)) {
    const id = String(portalId || '').replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) continue;
    for (const row of publicTrancheRows(portal)) {
      let stub = 0;
      try { stub = Number(leafStubNanos(state, [row.commit])); } catch { stub = 0; }
      if (!Number.isSafeInteger(stub) || stub < 0) stub = 0;
      out.push({ ...row, portalId: id, stubNanos: stub });
    }
  }
  return out;
}

/** Matured-tranche rows a wallet can hash. No amount, no blind, no owner. */
export function publicTrancheRows(portal) {
  const rows = Array.isArray(portal?.tranches) ? portal.tranches : [];
  return rows.map((row) => {
    let commit = '';
    if (typeof row?.commit === 'string') commit = row.commit.replace(/^0x/i, '').toLowerCase();
    else if (row?.commit) {
      try { commit = Buffer.from(asU8(row.commit)).toString('hex'); } catch { commit = ''; }
    }
    return {
      commit,
      epoch: Math.floor(Number(row?.epoch) || 0),
      remainMs: Math.max(0, Math.floor(Number(row?.remainMs) || 0)),
      noteIsPrincipal: row?.noteIsPrincipal === true || row?.notePrincipal === true,
    };
  });
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
    liveHashBonusNanos: asNum(hashBonusUnitNanos(state.liveHashBonusNanos)),
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
    deferEpochRoll: !!state.deferEpochRoll,
    portals: state.portals,
    mintedIds: state.mintedIds,
    freezes: state.freezes,
    rewardRoots: state.rewardRoots ? { ...state.rewardRoots } : null,
    rewardBook: state.rewardBook ? { ...state.rewardBook } : null,
    rewardSets: state.rewardSets ? { ...state.rewardSets } : null,
    vaultLockNotes: Array.isArray(state.vaultLockNotes) ? state.vaultLockNotes.slice() : [],
    vaultRetired: state.vaultRetired ? { ...state.vaultRetired } : null,
    vaultLockRoot: state.vaultLockRoot || '',
    vaultLockIndex: state.vaultLockIndex ? { ...state.vaultLockIndex } : null,
    vaultLockRoots: state.vaultLockRoots ? { ...state.vaultLockRoots } : null,
    epochStartRoots: state.epochStartRoots ? { ...state.epochStartRoots } : null,
    vaultLeafBorn: state.vaultLeafBorn ? { ...state.vaultLeafBorn } : null,
    vaultLeafUnlock: state.vaultLeafUnlock ? { ...state.vaultLeafUnlock } : null,
    vaultLeafHeight: state.vaultLeafHeight ? { ...state.vaultLeafHeight } : null,
    rateTable: state.rateTable ? { ...state.rateTable } : null,
    claimNullifierPeriod: state.claimNullifierPeriod ? { ...state.claimNullifierPeriod } : null,
    rolled: state.rolled ? { ...state.rolled } : null,
    withdrewEpoch: state.withdrewEpoch ? { ...state.withdrewEpoch } : null,
    vaultLockDirty: !!state.vaultLockDirty,
    epochCensus: plainCopy(state.epochCensus),
    ballots: plainCopy(state.ballots),
    ballotCount: plainCopy(state.ballotCount),
    ballotStep: plainCopy(state.ballotStep),
  };
}

function plainCopy(value) {
  if (value == null) return Object.create(null);
  return JSON.parse(JSON.stringify(value));
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
  state.deferEpochRoll = !!snap.deferEpochRoll;
  state.portals = snap.portals;
  state.mintedIds = snap.mintedIds;
  state.freezes = snap.freezes;
  state.rewardRoots = snap.rewardRoots ? { ...snap.rewardRoots } : Object.create(null);
  state.rewardBook = snap.rewardBook ? { ...snap.rewardBook } : Object.create(null);
  state.rewardSets = snap.rewardSets ? { ...snap.rewardSets } : Object.create(null);
  state.vaultLockNotes = Array.isArray(snap.vaultLockNotes) ? snap.vaultLockNotes.slice() : [];
  state.vaultRetired = snap.vaultRetired ? { ...snap.vaultRetired } : Object.create(null);
  state.vaultLockRoot = snap.vaultLockRoot || '';
  state.vaultLockIndex = snap.vaultLockIndex ? { ...snap.vaultLockIndex } : Object.create(null);
  rebuildVaultLockIndex(state);
  state.vaultLockRoots = snap.vaultLockRoots ? { ...snap.vaultLockRoots } : Object.create(null);
  state.epochStartRoots = snap.epochStartRoots ? { ...snap.epochStartRoots } : Object.create(null);
  state.vaultLeafBorn = snap.vaultLeafBorn ? { ...snap.vaultLeafBorn } : Object.create(null);
  state.vaultLeafUnlock = snap.vaultLeafUnlock ? { ...snap.vaultLeafUnlock } : Object.create(null);
  state.vaultLeafHeight = snap.vaultLeafHeight ? { ...snap.vaultLeafHeight } : Object.create(null);
  state.rateTable = snap.rateTable ? { ...snap.rateTable } : Object.create(null);
  state.claimNullifierPeriod = snap.claimNullifierPeriod ? { ...snap.claimNullifierPeriod } : Object.create(null);
  state.rolled = snap.rolled ? { ...snap.rolled } : Object.create(null);
  state.withdrewEpoch = snap.withdrewEpoch ? { ...snap.withdrewEpoch } : Object.create(null);
  state.epochCensus = plainCopy(snap.epochCensus);
  state.ballots = plainCopy(snap.ballots);
  state.ballotCount = plainCopy(snap.ballotCount);
  state.ballotStep = plainCopy(snap.ballotStep);
  state.vaultLockDirty = false;
  VAULT_LOCK_HANDLES.delete(state);
  if (snap.vaultLockRoot || snap.vaultLockDirty || state.vaultLockNotes.length) rebuildVaultLockRoot(state);
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

function applyEpochOpen(state, nowMs, idx) {
  if (!state.epochStartRoots) state.epochStartRoots = Object.create(null);
  const rootKey = String(idx);
  if (!Object.prototype.hasOwnProperty.call(state.epochStartRoots, rootKey)) {
    state.epochStartRoots[rootKey] = String(state.vaultLockRoot || '');
  }
  const magic = state.magic || MAGIC_TESTNET;
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
    const running = Math.max(0, Math.floor(Number(state.epochBps ?? GENESIS_BPS)));
    const queuedRaw = state.pendingRates?.[idx];
    const hasQueue = queuedRaw != null && queuedRaw !== '';
    // The first open adopts the bundle, so a caller-set rate cannot skip
    // it. A later epoch with no commit keeps the rate already adopted.
    const firstOpen = !(Number(state.epochStartMs) > 0);
    if (!firstOpen || hasQueue) {
      const adopted = prior
        ? Math.max(0, Math.floor(Number(prior.epochBps)))
        : (hasQueue ? Math.max(0, Math.floor(Number(queuedRaw))) : running);
      if (!state.pendingRates) state.pendingRates = Object.create(null);
      if (!hasQueue && state.pendingRates[idx] == null) state.pendingRates[idx] = adopted;
      if (!prior) {
        rememberFreeze(state, idx);
        state.freezes[idx] = {
          ok: true,
          epochIndex: idx,
          epochBps: adopted,
          prevEpochBps: running,
          magic,
          observationRoot: bundleObservationRoot(),
          source: 'running',
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
  }
  const genesis = Number(state.genesisMs) || 0;
  state.epochIndex = idx;
  state.currentEpoch = idx;
  state.epochStartMs = genesis + idx * epochMs(magic);
  state.bonusEnacted = false;
  appendEpochRate(state, idx, state.epochBps);
  void freezeEpochBps;
  void MAGIC_MAINNET;
}

/** Leaf count for this epoch, once. Later blocks do not rewrite it. */
function ensureEpochCensus(state, height) {
  if (!(Number(state?.epochStartMs) > 0)) return;
  const idx = Math.floor(Number(state.currentEpoch) || 0);
  if (censusOf(state, idx)) return;
  const leaves = liveVaultNotes(state).length;
  if (leaves < 1) return;
  const openH = Math.max(0, Math.floor(Number(height) || 0));
  commitCensus(state, idx, leaves, openH);
}

/** Prospective and append-only. A second write does not rewrite a frozen rate. */
function appendEpochRate(state, idx, bps) {
  if (!state.rateTable) state.rateTable = Object.create(null);
  const key = String(Math.floor(Number(idx) || 0));
  if (state.rateTable[key] == null) state.rateTable[key] = Math.max(0, Math.floor(Number(bps) || 0));
}

/** Freeze the live root at the start of this height's period. Later locks are not in it. */
export function snapshotPeriodRoot(state, height) {
  const period = vaultPeriodBlocks(state?.magic || MAGIC_TESTNET);
  const h = Math.floor(Number(height));
  if (period == null || !Number.isInteger(h) || h < 0) return;
  const idx = Math.floor(h / period);
  if (!state.epochStartRoots) state.epochStartRoots = Object.create(null);
  const key = String(idx);
  if (Object.prototype.hasOwnProperty.call(state.epochStartRoots, key)) return;
  // A missing live root is the empty marker. Leaving the key unset let the
  // first later lock freeze itself into the period start and collect the
  // arrival stub plus a full-period claim.
  const live = String(state.vaultLockRoot || '');
  const root = /^[0-9a-f]{64}$/.test(live) ? live : EMPTY_VAULT_ROOT;
  state.epochStartRoots[key] = root;
}

/** Drop claim nullifiers whose period is outside the window. The window check still refuses them. */
function pruneClaimNullifiers(state, height) {
  const period = vaultPeriodBlocks(state?.magic || MAGIC_TESTNET);
  const book = state?.claimNullifierPeriod;
  if (period == null || !book) return;
  const h = Math.floor(Number(height));
  if (!Number.isInteger(h) || h < 0) return;
  const now = Math.floor(h / period);
  const horizon = now - VAULT_CLAIM_WINDOW_EPOCHS * VAULT_PERIODS_PER_EPOCH;
  if (horizon <= 0) return;
  for (const [id, at] of Object.entries(book)) {
    if (Math.floor(Number(at) || 0) >= horizon) continue;
    delete book[id];
    if (state.mintedIds) delete state.mintedIds[id];
  }
}

/** Open the chain vortex window. A first lock does not choose the start. */
function syncVaultEpoch(state, nowMs) {
  const genesis = Number(state?.genesisMs) || 0;
  if (!(genesis > 0)) return;
  const idx = chainEpochIndex(state, nowMs);
  if (!state.epochStartMs) {
    applyEpochOpen(state, nowMs, idx);
    return;
  }
  // The block rolls once, before its rows, when the epoch it found was
  // already enacted. deferEpochRoll holds any further roll for those rows,
  // so a same-block withdraw still settles the epoch that just ended.
  if (state.deferEpochRoll) return;
  if (idx === Number(state.currentEpoch || 0)) return;
  if (!state.bonusEnacted) return;
  // The open epoch's rate is the live epochBps until it rolls. Keep that
  // integer for the epoch that just ended. Then walk the skipped epochs:
  // a commit is paid at that rate and becomes the last paid rate. A gap
  // with no commit keeps it. The epoch we open, if it has no commit, pays
  // that same rate, so a later epoch cannot be left on the pre-gap rate.
  rememberOpenRate(state, state.currentEpoch);
  let carried = Math.max(0, Math.floor(Number(state.epochBps ?? GENESIS_BPS)));
  const from = Math.floor(Number(state.currentEpoch) || 0) + 1;
  if (!state.pendingRates) state.pendingRates = Object.create(null);
  for (let e = from; e < idx; e += 1) {
    const queued = state.pendingRates[e];
    if (queued == null || queued === '') state.pendingRates[e] = carried;
    else carried = Math.max(0, Math.floor(Number(queued)));
  }
  if (state.pendingRates[idx] == null || state.pendingRates[idx] === '') {
    state.epochBps = carried;
  }
  const leftEpoch = Math.floor(Number(state.currentEpoch) || 0);
  state.votes = { increase: 0, decrease: 0, hold: 0 };
  applyEpochOpen(state, nowMs, idx);
  activateBallot(state, leftEpoch);
}

/** Keep the rate the open epoch was paying. A queued commit already won. */
function rememberOpenRate(state, epochIndex) {
  const idx = Math.floor(Number(epochIndex) || 0);
  if (!state.pendingRates) state.pendingRates = Object.create(null);
  if (state.pendingRates[idx] != null && state.pendingRates[idx] !== '') return;
  const freeze = state.freezes?.[idx];
  if (freeze && freeze.source === 'median3b' && freeze.epochBps != null) return;
  state.pendingRates[idx] = Math.max(0, Math.floor(Number(state.epochBps ?? GENESIS_BPS)));
}

/** The lock is a plain tranche. Its unlock is the end of this epoch. It is not a note. */
function bindLockNote(state, portalId, tx, nowMs) {
  const portal = state.portals?.[portalId];
  if (!portal || !Array.isArray(portal.tranches)) return;
  const outs = (Array.isArray(tx?.vout) ? tx.vout : []).filter((row) => String(row?.kind || tx?.kind || '') === KIND_LOCK);
  if (!outs.length) return;
  const idx = chainEpochIndex(state, nowMs);
  const genesis = Number(state.genesisMs) || 0;
  const span = epochMs(state.magic);
  const computed = genesis > 0 ? genesis + (idx + 1) * span : 0;
  for (const out of outs) {
    const hex = commit32(out)?.toString('hex');
    if (!hex) continue;
    const tranche = [...portal.tranches].reverse().find((row) => String(row.commit) === hex);
    if (!tranche) continue;
    const unlock = Number(out?.unlockAtMs) > 0 ? Number(out.unlockAtMs) : computed;
    tranche.unlockAtMs = unlock;
    tranche.lockEpoch = Number.isInteger(Number(out?.lockEpoch)) ? Number(out.lockEpoch) : idx;
    tranche.noteIsPrincipal = false;
    delete tranche.noteCommit;
  }
}

function noteLockCap(state, epoch, lockCommit, proof) {
  const bps = rateForEpoch(state, epoch);
  const lockHex = Buffer.from(lockCommit).toString('hex');
  // A zero rate has a zero cap. There is no positive commitment to add,
  // and a claim at that rate cannot satisfy verifyLockCap.
  if (!(bps > 0)) {
    if (!state.vaultLockNoted) state.vaultLockNoted = Object.create(null);
    state.vaultLockNoted[lockHex] = true;
    return true;
  }
  if (!verifyLockCap(lockCommit, bps, proof)) return false;
  const capHex = Buffer.from(proof.commit).toString('hex');
  if (!state.vaultLockNoted) state.vaultLockNoted = Object.create(null);
  state.vaultLockNoted[lockHex] = true;
  if (!state.vaultLockCap) state.vaultLockCap = Object.create(null);
  state.vaultLockCap[lockHex] = capHex;
  return true;
}

/** One credit. The amount stays inside the commitment. The sum is not opened. */
function noteCredit(state, p, commitBuf, nowMs, qualifies) {
  const idx = chainEpochIndex(state, nowMs);
  const remain = consensusRemainMs(state, nowMs);
  if (!Array.isArray(p.tranches)) p.tranches = [];
  p.tranches.push({
    commit: Buffer.from(commitBuf).toString('hex'),
    epoch: idx,
    remainMs: remain,
    fullFrom: idx + 1,
    partialPaid: false,
    qualifies: qualifies === true,
  });
  addLockCommit(state, idx, commitBuf);
  state.vaultPrincipalSum = addPointSum(state.vaultPrincipalSum, commitBuf);
}

/** floor(amount * bps * remainMs / epochMs / 10000). */
function partialInterest(amount, bps, remainMs, epochLen) {
  const p = asBig(amount);
  const rate = Math.floor(Number(bps) || 0);
  const remain = Math.floor(Number(remainMs) || 0);
  const span = Math.floor(Number(epochLen) || 0);
  if (p <= 0n || !Number.isFinite(rate) || rate <= 0 || remain <= 0 || span <= 0) return 0n;
  const got = (p * BigInt(rate) * BigInt(remain)) / (BigInt(span) * 10000n);
  return got > REWARD_U64 ? REWARD_U64 : got;
}

function portalPublic(p) {
  return {
    id: p.id,
    staked: asNum(p.staked),
    idle: asNum(p.idle),
    nanos: asNum(asBig(p.staked) + asBig(p.idle)),
    joined: p.joined,
    qualified: p.qualified === true,
    vote: p.vote,
  };
}

/**
 * Build the lock commitment from a witness, or check a commitment the tx
 * already carries. The integer is not written onto the portal.
 */
/** Wallet witness for openings. Not chain state. */
const PORTAL_WITNESS = new WeakMap();
const EPOCH_WITNESS = new WeakMap();

function scalarAdd(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Fn.add(a, b);
}

/**
 * True when `piProof` shows this commitment is at least π.
 * The integer is not returned. A second tranche never reaches this:
 * deposit refuses portal_exists before it asks. A sum of smaller notes
 * is not a second chance.
 */
export function lockQualifies(commit, piProof, portal = null) {
  void portal;
  if (!piProof) return false;
  const one = commitBytes(commit);
  if (!one || !verifyRange(piShift(one), piProof)) return false;
  return true;
}

function hiddenLockCredit({ nanos, commit: commitRaw, blind, rangeProof, unlock, rangeCommit }) {
  const given = commitBytes(commitRaw);
  if (given) {
    let u = null;
    if (unlock != null && unlock !== '') {
      try { u = BigInt(unlock); } catch { return { ok: false, reason: 'stake_reward' }; }
      if (u <= 0n || u === VAULT_UNLOCK_OPEN || u > 0xffffffffffffffffn) {
        return { ok: false, reason: 'stake_reward' };
      }
    }
    let ranged = null;
    if (rangeCommit) ranged = commitBytes(rangeCommit);
    else if (u != null) {
      try { ranged = pointBytes(subtractUnlock(pointFrom(given), u)); } catch {
        return { ok: false, reason: 'stake_reward' };
      }
    } else {
      ranged = given;
    }
    if (!ranged || ranged.length !== 32 || !rangeProof || !verifyRange(ranged, rangeProof)) {
      return { ok: false, reason: 'stake_reward' };
    }
    // The stored commit is the leaf, which adds the unlock point. The π
    // proof opens the funding output, the leaf with that point removed.
    return { ok: true, commit: given, valueCommit: ranged };
  }
  const n = asBig(nanos);
  if (n <= 0n) return { ok: false, reason: 'bad_amount' };
  let r;
  try {
    r = blind == null ? randomScalar() : (typeof blind === 'bigint' ? blind : scalarFrom(blind));
  } catch {
    return { ok: false, reason: 'bad_amount' };
  }
  const C = pointBytes(commit(n, r));
  const range = proveRange(n, r);
  if (!range?.length || !verifyRange(C, range)) return { ok: false, reason: 'stake_reward' };
  return { ok: true, commit: C, nanos: n, blind: r, witnessed: true };
}

function rememberPortalWitness(portal, nanos, blind, commit) {
  const prev = PORTAL_WITNESS.get(portal) || { nanos: 0n, blind: null, opens: new Map() };
  const opens = prev.opens || new Map();
  const hex = commitBytes(commit)?.toString('hex');
  if (hex) opens.set(hex, { nanos: asBig(nanos), blind });
  PORTAL_WITNESS.set(portal, {
    nanos: prev.nanos + asBig(nanos),
    blind: scalarAdd(prev.blind, blind),
    opens,
  });
}

/** Wallet opening of one hidden lock. Not chain state. */
export function hiddenOpenOf(portal, commitHex) {
  const book = PORTAL_WITNESS.get(portal);
  const key = commitBytes(commitHex)?.toString('hex') || String(commitHex || '').replace(/^0x/i, '').toLowerCase();
  const row = book?.opens?.get(key);
  return row ? { nanos: row.nanos, blind: row.blind } : null;
}

/** True when `proof` opens `amount` as one matured hidden lock of this portal, on this tx. */
export function hiddenPrincipalOpens(state, portal, nowMs, amount, proof, tx = null) {
  if (!portal || !proof || !tx) return false;
  const want = exactBi(amount);
  if (want == null || want <= 0n) return false;
  const id = portal.id || portalKey(portal.dest);
  return maturedHiddenCommits(state, portal, nowMs).some((hex) =>
    verifyPrincipalOpen(Buffer.from(hex, 'hex'), want, proof, tx, id, state?.magic));
}

/**
 * The next matured hidden lock this process can open.
 * The blind stays in the wallet witness. Consensus still requires the proof on the tx.
 */
export function hiddenWithdrawOpening(state, destOrPortal, nowMs, tx = null) {
  const portal = destOrPortal && Array.isArray(destOrPortal.tranches)
    ? destOrPortal
    : state?.portals?.[portalKey(destOrPortal)];
  if (!portal) return null;
  const id = portal.id || portalKey(destOrPortal);
  for (const hex of maturedHiddenCommits(state, portal, nowMs)) {
    const open = hiddenOpenOf(portal, hex);
    if (!open) continue;
    const nanos = open.nanos <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(open.nanos) : open.nanos;
    const proof = tx
      ? provePrincipalOpen(Buffer.from(hex, 'hex'), open.nanos, open.blind, tx, id, state?.magic)
      : null;
    return { commit: hex, nanos, blind: open.blind, proof };
  }
  return null;
}

function rememberEpochWitness(state, epoch, nanos, blind) {
  let book = EPOCH_WITNESS.get(state);
  if (!book) {
    book = new Map();
    EPOCH_WITNESS.set(state, book);
  }
  const key = String(epoch);
  const prev = book.get(key) || { nanos: 0n, blind: null };
  book.set(key, {
    nanos: prev.nanos + asBig(nanos),
    blind: scalarAdd(prev.blind, blind),
  });
}

/**
 * The epoch's lock sum as a commitment. No plaintext, and no blinding
 * factor besides the one each lock author already used.
 */
export function produceLockOpening(state, epoch) {
  const commit = state?.lockCommitSum?.[String(epoch)];
  if (!commit || !/^[0-9a-f]{64}$/.test(String(commit))) return null;
  return { epoch: Math.floor(Number(epoch)), commit: String(commit) };
}

/** Record that the commitment sum is the epoch total. The integer stays hidden. */
export function sealEpochLocks(state, epoch) {
  const opening = produceLockOpening(state, epoch);
  if (!opening) return { ok: false, reason: 'stake_reward' };
  return { ok: true, epoch: opening.epoch, commit: opening.commit };
}

export function deposit({
  state, dest, portalId, nanos, nowMs, payout, payoutPortalId, ownerPub, spendPub,
  commit, blind, rangeProof, piProof, unlock, rangeCommit,
} = {}) {
  const id = portalKey(portalId || dest);
  if (!id) return { ok: false, reason: 'bad_dest' };
  if (dest && !isPortalId(dest) && (!isDestAddress(dest) || isShearAddress(dest))) {
    return { ok: false, reason: 'bad_dest' };
  }
  const hidden = hiddenLockCredit({ nanos, commit, blind, rangeProof, unlock, rangeCommit });
  if (!hidden.ok) return hidden;
  // No clock, no credit. A later pin must not inherit an unpinned lock.
  if (!(Number(state?.genesisMs) > 0)) return { ok: false, reason: 'clock' };
  const p = portalOf(state, id);
  const priorTranches = Array.isArray(p.tranches) ? p.tranches.length : 0;
  const priorOwner = /^[0-9a-f]{64}$/.test(String(p.ownerPub || ''));
  const pub = String(ownerPub || '').replace(/^0x/i, '').toLowerCase();
  const signer = String(spendPub || '').replace(/^0x/i, '').toLowerCase();
  const given = /^[0-9a-f]{64}$/.test(pub);
  const signed = /^[0-9a-f]{64}$/.test(signer);
  const have = /^[0-9a-f]{64}$/.test(String(p.ownerPub || ''));
  // The owner check is first, same as the EVM. A different key is unsigned
  // even when the portal id is also a duplicate. A fixture with no signer
  // leaves spendPub empty and is not this check.
  if (signed && ((given && signer !== pub) || (have && signer !== String(p.ownerPub).toLowerCase()))) {
    return { ok: false, reason: 'unsigned' };
  }
  if (have && given && p.ownerPub !== pub) return { ok: false, reason: 'unsigned' };
  // One credit per portal. A second output in this tx is not a second portal.
  if (priorTranches > 0 || priorOwner) return { ok: false, reason: 'portal_exists' };
  if (!have && given) p.ownerPub = pub;
  else if (!have && signed) p.ownerPub = signer;
  if (payoutPortalId && isPortalId(payoutPortalId) && !p.payoutPortalId) {
    p.payoutPortalId = String(payoutPortalId).toLowerCase();
  }
  if (payout && isDestAddress(payout) && !isShearAddress(payout)) {
    if (!p.payout) p.payout = payout;
    if (!p.payoutPortalId) p.payoutPortalId = portalIdFromDest(payout);
  }
  if (dest && isDestAddress(dest) && !isShearAddress(dest) && !p.dest) p.dest = dest;
  if (state.epochStartMs && !state.bonusEnacted && remainingMs(state, nowMs) === 0) {
    return { ok: false, reason: 'need_enact' };
  }
  if (state.bonusEnacted) syncVaultEpoch(state, nowMs);
  settlePortal(state, p, nowMs);
  const staking = canJoin(state, nowMs);
  let qualifies = false;
  if (hidden.witnessed) {
    rememberPortalWitness(p, hidden.nanos, hidden.blind, hidden.commit);
    if (hidden.nanos >= BigInt(PI_SHE_NANOS) && hidden.blind != null) {
      const pi = proveRange(hidden.nanos - BigInt(PI_SHE_NANOS), hidden.blind);
      qualifies = lockQualifies(hidden.commit, pi);
    }
  } else {
    qualifies = lockQualifies(hidden.valueCommit || hidden.commit, piProof, p);
  }
  noteCredit(state, p, hidden.commit, nowMs, qualifies);
  if (hidden.witnessed) {
    const epoch = chainEpochIndex(state, nowMs);
    rememberEpochWitness(state, epoch, hidden.nanos, hidden.blind);
  }
  if (qualifies) p.qualified = true;
  if (!p.joined && p.qualified) {
    p.joined = true;
    syncVaultEpoch(state, nowMs);
  } else if (p.joined && !state.epochStartMs) {
    // Clock pinned after the first lock. The next credit opens the chain epoch.
    syncVaultEpoch(state, nowMs);
  }
  return {
    ok: true,
    idle: !staking,
    portal: portalPublic(p),
  };
}

export function vote({ state, dest, portalId, choice, nowMs }) {
  void state;
  void dest;
  void portalId;
  void choice;
  void nowMs;
  return { ok: false, reason: 'vote_retired' };
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

/** Chain-genesis vortex index. Rate keys and settlement both use this integer. */
function chainEpochIndex(state, nowMs) {
  return derivedCommitIndex(nowMs, state?.genesisMs, state?.magic);
}

/**
 * Period index of chain time. Period 0 is the first slice of epoch 0.
 * At the instant an epoch ends, this is that next epoch's first period.
 */
export function chainPeriodIndex(state, nowMs) {
  const epoch = chainEpochIndex(state, nowMs);
  const genesis = Number(state?.genesisMs) || 0;
  const now = Number(nowMs) || 0;
  const span = epochMs(state?.magic);
  if (!(genesis > 0) || !(span > 0) || now < genesis) return epoch * VAULT_PERIODS_PER_EPOCH;
  const into = now - (genesis + epoch * span);
  const periodMs = Math.floor(span / VAULT_PERIODS_PER_EPOCH);
  let sub = 0;
  if (periodMs > 0 && into > 0) sub = Math.floor(into / periodMs);
  if (sub < 0) sub = 0;
  if (sub >= VAULT_PERIODS_PER_EPOCH) sub = VAULT_PERIODS_PER_EPOCH - 1;
  return epoch * VAULT_PERIODS_PER_EPOCH + sub;
}

/** First period of the epoch after the lock. A claim of this period is not early. */
export function consensusUnlockPeriod(lockEpoch) {
  const epoch = Math.floor(Number(lockEpoch) || 0);
  return (epoch + 1) * VAULT_PERIODS_PER_EPOCH;
}

/** End of the chain epoch that a lock at this time belongs to. */
export function lockUnlockOf(state, nowMs) {
  const epoch = chainEpochIndex(state, nowMs);
  const genesis = Number(state?.genesisMs) || 0;
  const span = epochMs(state?.magic);
  const unlockAtMs = genesis > 0 && span > 0 ? genesis + (epoch + 1) * span : 0;
  return { epoch, unlockAtMs };
}

/**
 * A stamped lock must name this epoch's end. A missing stamp stays the older
 * receipt: the tranche still records the end, and the output is not a note.
 * An admit pub with no matching stamp is not a note either.
 */
export function lockStampRejected(state, tx, nowMs) {
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const out = [...outs].reverse().find((row) => String(row?.kind || tx?.kind || '') === KIND_LOCK) || null;
  if (!out) return null;
  const unlock = Number(out.unlockAtMs);
  const hasUnlock = Number.isInteger(unlock) && unlock > 0;
  const hasEpoch = out.lockEpoch != null && out.lockEpoch !== '' && Number.isInteger(Number(out.lockEpoch));
  let hasAdmit = false;
  try {
    hasAdmit = Buffer.from(asU8(out.admitPub)).length === 32;
  } catch { /* a missing pub is not a stamp */ }
  if (!hasUnlock && !hasEpoch && !hasAdmit) return null;
  const want = lockUnlockOf(state, nowMs);
  if (!(want.unlockAtMs > 0)) return { ok: false, reason: 'clock' };
  if (unlock !== want.unlockAtMs || Number(out.lockEpoch) !== want.epoch) {
    return { ok: false, reason: 'lock_unlock' };
  }
  return null;
}

/** A freeze or a queued commit for this epoch. Null when it has neither. */
function recordedRate(state, epochIndex) {
  const freeze = state?.freezes?.[epochIndex];
  if (freeze && (freeze.source === 'median3b' || freeze.source === 'running') && freeze.epochBps != null) {
    return Math.max(0, Math.floor(Number(freeze.epochBps)));
  }
  const queued = state?.pendingRates?.[epochIndex];
  if (queued != null && queued !== '') return Math.max(0, Math.floor(Number(queued)));
  return null;
}

/**
 * Rate of one chain epoch. A commit or an adopted freeze wins. A gap with
 * neither keeps the newest earlier rate, not the live rate of a later epoch.
 */
function rateForEpoch(state, epochIndex) {
  const own = recordedRate(state, epochIndex);
  if (own != null) return own;
  for (let e = epochIndex - 1; e >= 0; e -= 1) {
    const prior = recordedRate(state, e);
    if (prior != null) return prior;
  }
  return Math.max(0, Math.floor(Number(state?.epochBps ?? GENESIS_BPS)));
}

/**
 * The arrival epoch pays only when the credit was locked with the stake
 * cutoff still to run. A credit locked in the final window misses that
 * epoch. A later full epoch counts it toward π. The owner can vote either way.
 */
function earnsStakeReward(state, tranche) {
  const remain = Math.floor(Number(tranche?.remainMs) || 0);
  return remain >= joinCutoffMs(state?.magic);
}

/** Remain that is a real lock, not a legacy credit whose instant was not stored. */
function stakeRemain(tranche) {
  return Math.floor(Number(tranche?.remainMs) || 0);
}

/** Sum of credits locked before the stake cutoff. The final window does not count. */
function preCutoffStake(state, portal) {
  let sum = 0n;
  for (const tranche of portal?.tranches || []) {
    if (!earnsStakeReward(state, tranche)) continue;
    sum += asBig(tranche.amount);
  }
  return sum;
}

/**
 * Stake that counts toward π in epoch `epoch`.
 * Every pre-cutoff credit counts, including a later top-up, so an earlier
 * credit still pays once that sum reaches π. A post-cutoff credit counts
 * only in epochs after the one it arrived in. A legacy credit with no
 * remain does not count and does not earn.
 */
function qualifyingStake(state, portal, epoch) {
  let sum = 0n;
  const at = Math.floor(Number(epoch) || 0);
  for (const tranche of portal?.tranches || []) {
    const arrival = Math.floor(Number(tranche?.epoch) || 0);
    const remain = stakeRemain(tranche);
    if (earnsStakeReward(state, tranche)) sum += asBig(tranche.amount);
    else if (remain > 0 && at > arrival) sum += asBig(tranche.amount);
  }
  return sum;
}

function epochQualifies(state, portal, epoch) {
  if (portal?.qualified) return true;
  return qualifyingStake(state, portal, epoch) >= BigInt(PI_SHE_NANOS);
}

/** Stake reward is off until a range proof shows the hidden stake is at least π. */
function stakeQualified(state, portal) {
  if (portal?.qualified) return true;
  return preCutoffStake(state, portal) >= BigInt(PI_SHE_NANOS);
}

/** Interest still owed on one credit. Each epoch qualifies on its own. */
function trancheDue(state, portal, tranche, nowIdx, span) {
  let total = 0n;
  const amount = asBig(tranche?.amount);
  const epoch = Math.floor(Number(tranche?.epoch) || 0);
  if (
    earnsStakeReward(state, tranche)
    && !tranche?.partialPaid
    && nowIdx > epoch
    && epochQualifies(state, portal, epoch)
  ) {
    total = addReward(total, partialInterest(amount, rateForEpoch(state, epoch), tranche.remainMs, span));
  }
  const from = Math.floor(Number(tranche?.fullFrom ?? epoch + 1));
  if (nowIdx > from && amount > 0n && stakeRemain(tranche) > 0) {
    for (let e = from; e < nowIdx; e += 1) {
      if (!epochQualifies(state, portal, e)) break;
      total = addReward(total, epochInterestBig(amount, rateForEpoch(state, e)));
    }
  }
  return total;
}

/** Reward epochs this withdraw is about to pay. Read before settle moves the cursors. */
function dueRewardEpochs(state, portal, nowMs) {
  const nowIdx = settlementIndex(state, nowMs);
  const epochs = [];
  if (!(nowIdx > 0)) return epochs;
  const seen = new Set();
  for (const tranche of portal?.tranches || []) {
    const arrival = Math.floor(Number(tranche.epoch) || 0);
    if (
      earnsStakeReward(state, tranche)
      && !tranche.partialPaid
      && nowIdx > arrival
      && epochQualifies(state, portal, arrival)
      && !seen.has(arrival)
    ) {
      seen.add(arrival);
      epochs.push(arrival);
    }
    const from = Math.floor(Number(tranche.fullFrom ?? arrival + 1));
    if (nowIdx > from && stakeRemain(tranche) > 0) {
      for (let e = from; e < nowIdx; e += 1) {
        if (!epochQualifies(state, portal, e)) break;
        if (seen.has(e)) continue;
        seen.add(e);
        epochs.push(e);
      }
    }
  }
  return epochs;
}

/** Lock epoch of a balance that never recorded a tranche list. */
function legacyLockEpoch(state, portal) {
  const raw = portal?.lockEpoch;
  if (raw != null && raw !== '' && Number.isInteger(Number(raw)) && Number(raw) >= 0) {
    return Math.floor(Number(raw));
  }
  return Math.floor(Number(state?.currentEpoch) || 0);
}

/**
 * Recorded credits, or one legacy credit for the whole balance.
 * The lock instant inside that epoch was not stored, so the credit does
 * not earn. Principal is due only after the lock epoch ends.
 */
function balanceCredits(state, portal) {
  const tranches = portal?.tranches;
  if (Array.isArray(tranches) && tranches.length > 0) return tranches;
  const whole = asBig(portal?.staked) + asBig(portal?.idle);
  if (whole <= 0n) return [];
  const epoch = legacyLockEpoch(state, portal);
  return [{
    amount: whole,
    epoch,
    remainMs: 0,
    fullFrom: epoch + 1,
    partialPaid: true,
    noteIsPrincipal: false,
  }];
}

/**
 * Every recorded credit is still inside its own lock epoch. One open
 * top-up does not re-lock an earlier deposit whose epoch has already ended.
 * A portal with no tranche list is one credit in its lock epoch.
 */
function arrivalEpochOpen(state, portal, nowMs) {
  const tranches = balanceCredits(state, portal);
  if (tranches.length === 0) return false;
  const chain = chainEpochIndex(state, nowMs);
  for (const tranche of tranches) {
    if (chain > Math.floor(Number(tranche?.epoch) || 0)) return false;
  }
  return true;
}

/**
 * Matured principal split by who carries it.
 * A time-locked note carries its own principal. A legacy tranche is what
 * withdraw() may pay. A portal with no tranche list is one legacy credit,
 * due only after its lock epoch. An open top-up is in neither number.
 */
function maturedSplit(state, portal, nowMs) {
  const tranches = balanceCredits(state, portal);
  if (tranches.length === 0) return { note: 0n, legacy: 0n };
  const chain = chainEpochIndex(state, nowMs);
  let note = 0n;
  let legacy = 0n;
  for (const tranche of tranches) {
    if (chain <= Math.floor(Number(tranche?.epoch) || 0)) continue;
    const amount = asBig(tranche.amount);
    if (tranche.noteIsPrincipal) note += amount;
    else legacy += amount;
  }
  return { note, legacy };
}

/** Principal whose own lock epoch has ended. The open top-up stays put. */
function maturedPrincipal(state, portal, nowMs) {
  const split = maturedSplit(state, portal, nowMs);
  return split.note + split.legacy;
}

/** Principal a withdraw may pay. Time-locked notes are not included. */
export function withdrawablePrincipal(state, portal, nowMs) {
  return maturedSplit(state, portal, nowMs).legacy;
}

/** Matured commitment tranches. The principal integer is not one of these. */
export function maturedHiddenCount(state, portal, nowMs) {
  return maturedHiddenCommits(state, portal, nowMs).length;
}

function maturedHiddenCommits(state, portal, nowMs) {
  const chain = chainEpochIndex(state, nowMs);
  const out = [];
  for (const tranche of portal?.tranches || []) {
    if (chain <= Math.floor(Number(tranche?.epoch) || 0)) continue;
    if (tranche?.noteIsPrincipal) continue;
    const commit = commitBytes(tranche?.commit);
    if (!commit || asBig(tranche?.amount) > 0n) continue;
    out.push(commit.toString('hex'));
  }
  return out;
}

/**
 * Exclusive settlement index. Completed epochs, including a gap, are due
 * as soon as chain time has passed them. The open epoch is not included.
 */
function settlementIndex(state, nowMs) {
  const now = Number(nowMs) || 0;
  const chain = chainEpochIndex(state, now);
  const span = epochMs(state?.magic);
  const start = Number(state?.epochStartMs) || 0;
  const ended = start > 0 && now >= start + span;
  if (chain <= 0 && !ended) return 0;
  return chain;
}

/**
 * Move completed chain epochs onto the portal. The epoch a credit arrives
 * in pays floor(amount * rate * time remaining / epoch length / 10000).
 * Later epochs pay the full rate up to, and not including, the open index.
 */
function settlePortal(state, p, nowMs) {
  if (!p) return 0n;
  const nowIdx = settlementIndex(state, nowMs);
  const span = epochMs(state.magic);
  let total = capReward(p.accruedReward);
  for (const tranche of balanceCredits(state, p)) {
    total = addReward(total, trancheDue(state, p, tranche, nowIdx, span));
    // An epoch that is still under π stays open. A later pre-cutoff top-up
    // that crosses π must still be able to pay it. A post-cutoff arrival
    // never pays, so that partial closes. Qualification only grows as
    // later epochs include more stake, so the first short full epoch stops
    // the cursor. A synthetic legacy credit is not stored.
    const arrival = Math.floor(Number(tranche.epoch) || 0);
    if (!tranche.partialPaid && nowIdx > arrival) {
      if (!earnsStakeReward(state, tranche) || epochQualifies(state, p, arrival)) {
        tranche.partialPaid = true;
      }
    }
    const from = Math.floor(Number(tranche.fullFrom ?? arrival + 1));
    if (nowIdx > from && stakeRemain(tranche) > 0) {
      let e = from;
      while (e < nowIdx && epochQualifies(state, p, e)) e += 1;
      tranche.fullFrom = e;
    }
  }
  p.accruedReward = total;
  return total;
}

/**
 * A withdraw pays principal only. The qualified reward stays for the ZK claim.
 */
export function withdrawPaysInterest(state, portal, nowMs) {
  void state;
  void portal;
  void nowMs;
  return 0;
}

/** Interest a withdraw at `nowMs` pays. Same split as settle, without writing cursors. */
export function portalEpochInterest(state, p, nowMs) {
  if (!p) return 0;
  const nowIdx = settlementIndex(state, nowMs);
  const span = epochMs(state?.magic);
  let total = capReward(p.accruedReward);
  for (const tranche of balanceCredits(state, p)) {
    total = addReward(total, trancheDue(state, p, tranche, nowIdx, span));
  }
  return nanosOut(total);
}

export function previewWithdraw(state, dest, nowMs = null) {
  const p = portalOf(state, dest);
  const clock = nowMs == null
    ? (Number(state?.epochStartMs) || 0) + epochMs(state?.magic)
    : nowMs;
  const split = maturedSplit(state, p, clock);
  const principal = nanosOut(split.legacy);
  const notePrincipal = nanosOut(split.note);
  const interest = withdrawPaysInterest(state, p, clock);
  const payable = split.legacy > 0n;
  return {
    principal,
    notePrincipal,
    staked: asNum(p.staked),
    idle: asNum(p.idle),
    interest,
    payout: payable ? principal + interest : 0,
    reason: !payable && split.note > 0n ? 'note_principal' : undefined,
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

function sealedReserveVout(to, n, kind, r, spendSeed = null, lockIndex = 0) {
  const one = kind === KIND_LOCK && spendSeed != null ? portalDest20FromSeed(spendSeed, lockIndex) : null;
  const d20 = one || hash20FromAddress(to);
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
  note.dest20 = Buffer.from(d20);
  note.portalId = kind === KIND_LOCK ? portalIdFor(to, spendSeed, lockIndex) : portalIdFor(to, spendSeed);
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

function lockLeafOutput(to, amount, blind, timeLock, lockEpoch, unlockAtMs, spendSeed = null, lockIndex = 0) {
  const C = pointBytes(commit(amount, blind));
  const range = proveRange(amount, blind);
  const one = spendSeed != null ? portalDest20FromSeed(spendSeed, lockIndex) : null;
  const d20 = one || hash20FromAddress(to);
  const out = {
    kind: KIND_LOCK,
    commit: C,
    rangeProof: range,
    address: to,
    portalId: portalIdFor(to, spendSeed, lockIndex),
  };
  if (d20) out.dest20 = Buffer.from(d20);
  if (timeLock) {
    const epoch = Number(lockEpoch);
    const unlock = Number(unlockAtMs);
    if (Number.isInteger(epoch) && epoch >= 0) out.lockEpoch = epoch;
    if (unlock > 0) out.unlockAtMs = unlock;
  }
  if (amount === BigInt(PI_SHE_NANOS)) out.piProof = proveRange(0n, blind);
  return out;
}

export function lockTx({
  from, to, nanos, id, lockEpoch = null, unlockAtMs = null, timeLock = false, spendSeed = null,
  ownerPub = null, blind = null, bps = null, lockIndex = 0,
} = {}) {
  const n = exactFloorNanos(nanos);
  const amount = BigInt(n);
  const pi = BigInt(PI_SHE_NANOS);
  const firstBlind = blind == null ? randomScalar() : (typeof blind === 'bigint' ? blind : scalarFrom(blind));
  const leaves = [];
  let change = 0n;
  if (amount < pi) {
    leaves.push({ amount, blind: firstBlind });
  } else {
    const countBig = amount / pi;
    const count = countBig > BigInt(MAX_LOCK_LEAVES) ? MAX_LOCK_LEAVES : Number(countBig);
    for (let i = 0; i < count; i += 1) {
      leaves.push({ amount: pi, blind: i === 0 ? firstBlind : randomScalar() });
    }
    change = amount - pi * BigInt(count);
  }
  const vout = leaves.map((leaf) => lockLeafOutput(to, leaf.amount, leaf.blind, timeLock, lockEpoch, unlockAtMs, spendSeed, lockIndex));
  if (change > 0n) {
    const cr = randomScalar();
    vout.push({
      commit: pointBytes(commit(change, cr)),
      rangeProof: proveRange(change, cr),
      address: from,
    });
  }
  const rate = bps == null ? GENESIS_BPS : Math.floor(Number(bps));
  const capProof = proveLockCap(leaves[0].amount, leaves[0].blind, rate);
  const tx = {
    id,
    programId: RESERVE_PROGRAM,
    kind: KIND_LOCK,
    from,
    to,
    nanos: 0,
    portalId: portalIdFor(to, spendSeed, lockIndex),
    vin: [vinDest20(from)],
    vout,
  };
  if (amount >= pi) tx.piProof = vout[0].piProof;
  LOCK_WITNESS.set(tx, {
    amount: leaves[0].amount,
    blind: leaves[0].blind,
    leaves,
    change,
  });
  if (capProof) {
    tx.capProof = {
      commit: capProof.commit,
      range: capProof.range,
      remCommit: capProof.remCommit,
      remRange: capProof.remRange,
      slackCommit: capProof.slackCommit,
      slackRange: capProof.slackRange,
      relR: capProof.relR,
      relZ: capProof.relZ,
      balR: capProof.balR,
      balZ: capProof.balZ,
    };
  }
  const pub = String(ownerPub || '').replace(/^0x/i, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(pub)) tx.ownerPub = pub;
  return tx;
}

export function withdrawTx({ from, to, nanos, id, nonce, portalId, payoutPortalId, spendSeed = null } = {}) {
  const n = exactFloorNanos(nanos);
  const ident = id == null || String(id) === '' ? freshWithdrawId() : String(id);
  const blindNonce = positiveUnits(n)
    ? (nonce == null ? randomBytes(32) : withdrawNonceBytes(nonce))
    : null;
  const blind = blindNonce ? kt10WithdrawBlind(to, n, ident, blindNonce) : null;
  const fromId = from ? portalIdFor(from, spendSeed) : '';
  const pid = String(portalId || fromId || '').toLowerCase();
  const payDefault = to ? portalIdFor(to, spendSeed) : '';
  const pay = String(payoutPortalId || payDefault || pid).toLowerCase();
  const tx = {
    id: ident,
    programId: RESERVE_PROGRAM,
    mint: true,
    kind: KIND_WITHDRAW,
    to,
    nanos: n,
    portalId: pid,
    payoutPortalId: pay,
    vin: [],
    vout: [sealedReserveVout(to, n, KIND_WITHDRAW, blind, spendSeed)],
  };
  if (from) tx.from = from;
  if (blindNonce) tx.withdrawNonce = Buffer.from(blindNonce).toString('hex');
  return tx;
}

function fs1RecordBlob(proof) {
  if (!proof || typeof proof !== 'object') return null;
  try {
    const raw = proof.blob != null ? proof.blob : proof.proof;
    const blob = Buffer.from(asU8(raw));
    if (!blob.length || blob[0] !== 0xf1) return null;
    return blob;
  } catch {
    return null;
  }
}

/** 20-byte payout. A 40-char hex string or 20 raw bytes. An address is not one. */
export function postedPayoutDest20(raw) {
  try {
    if (typeof raw === 'string') {
      const hex = raw.replace(/^0x/i, '');
      if (!/^[0-9a-f]{40}$/i.test(hex)) return null;
      return Buffer.from(hex, 'hex');
    }
    const b = Buffer.from(asU8(raw));
    return b.length === 20 ? Buffer.from(b) : null;
  } catch {
    return null;
  }
}

/**
 * A withdraw the wallet can ship. It spends an FS-1 note the wallet owns
 * and carries the retire and principal proofs. A plaintext `from` is not a
 * spend and is refused. The pool does not invent the proofs.
 * A body with no address pays [dest20] and does not gain `to` or payoutPortalId.
 */
export function buildFundedWithdraw(body = {}) {
  if (!body || typeof body !== 'object') return null;
  if (body.from != null && String(body.from) !== '') return null;
  if (body.payer != null && String(body.payer) !== '') return null;
  // `to` and payoutPortalId name the address. The payout is dest20 only.
  if (body.to != null && String(body.to) !== '') return null;
  if (body.payoutPortalId != null && String(body.payoutPortalId) !== '') return null;
  const payout20 = postedPayoutDest20(body.dest20);
  if (!payout20) return null;
  const n = exactFloorNanos(body.nanos);
  if (n == null || n < 0) return null;
  const proofs = [];
  if (body.admit_proof) proofs.push(body.admit_proof);
  if (Array.isArray(body.admit_proofs)) {
    for (const proof of body.admit_proofs) if (proof) proofs.push(proof);
  }
  if (proofs.length < 1 || proofs.length > 8) return null;
  if (proofs.some((proof) => !fs1RecordBlob(proof))) return null;
  const vins = (Array.isArray(body.vin) ? body.vin : []).filter((v) => v && !v.coinbase);
  if (vins.length !== proofs.length) return null;
  if (vins.some((v) => v.address || v.dest20)) return null;
  if (body.fs1 == null || body.fs1 === '' || body.anchor == null || !body.excess) return null;
  const retire = Array.isArray(body.retireProofs) && body.retireProofs.length
    ? body.retireProofs
    : (body.retireProof ? [body.retireProof] : []);
  const principal = Array.isArray(body.principalProofs) && body.principalProofs.length
    ? body.principalProofs
    : (body.principalProof ? [body.principalProof] : []);
  if (!retire.length || !principal.length) return null;
  const tx = {
    id: body.id == null || String(body.id) === '' ? `wd-${randomBytes(8).toString('hex')}` : String(body.id),
    programId: RESERVE_PROGRAM,
    kind: KIND_WITHDRAW,
    nanos: n,
    portalId: isPortalId(body.portalId) ? String(body.portalId).toLowerCase() : '',
    dest20: payout20,
    vin: [],
    vout: [],
    ...(body.withdrawNonce != null && body.withdrawNonce !== '' ? { withdrawNonce: body.withdrawNonce } : {}),
  };
  delete tx.from;
  delete tx.to;
  delete tx.payoutPortalId;
  const posted = Array.isArray(body.vout) ? body.vout.filter((o) => o && (o.commit || o.kind)) : [];
  if (posted.length) tx.vout = posted;
  tx.vin = vins.map((v) => {
    const next = { ...v };
    delete next.address;
    delete next.dest20;
    return next;
  });
  // A funded withdraw is a note spend. The old mint bit and a fresh nonce
  // would change the body the retire and principal proofs are bound to.
  delete tx.mint;
  if (body.withdrawNonce == null || body.withdrawNonce === '') delete tx.withdrawNonce;
  tx.anchor = body.anchor;
  tx.fs1 = body.fs1;
  tx.excess = body.excess;
  if (body.admit_proof) tx.admit_proof = body.admit_proof;
  if (Array.isArray(body.admit_proofs) && body.admit_proofs.length) tx.admit_proofs = body.admit_proofs;
  if (body.fee != null && body.fee !== '') tx.fee = body.fee;
  if (body.dest20) tx.dest20 = body.dest20;
  if (retire.length === 1) tx.retireProof = retire[0];
  else tx.retireProofs = retire;
  if (principal.length === 1) tx.principalProof = principal[0];
  else tx.principalProofs = principal;
  // The spend signature and the portal-owner signature are different
  // messages. A spend sig must not be stored as the owner sig.
  const spendSig = body.sig || body.signature;
  if (spendSig) tx.sig = spendSig;
  if (body.spendPub) tx.spendPub = body.spendPub;
  if (body.rewardSig) tx.rewardSig = body.rewardSig;
  const pub = String(body.ownerPub || '').replace(/^0x/i, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(pub)) tx.ownerPub = pub;
  return tx;
}

/**
 * A posted claim fee. Null means the caller did not choose one.
 * Zero is a choice. A negative or a non-integer is not.
 */
function chosenClaimFee(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'bigint') {
    if (raw < 0n || raw > 9007199254740991n) return null;
    return Number(raw);
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!/^\d+$/.test(t)) return null;
    return chosenClaimFee(BigInt(t));
  }
  const n = Math.floor(Number(raw));
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/**
 * Absent fee is the weight floor, raised until it covers the fee digits.
 * A caller fee is kept. The mempool ranks that bid by fee rate, and
 * consensus rejects a bid under the floor or over the levy cap.
 */
function bindClaimFee(tx, chosen) {
  const bid = chosenClaimFee(chosen);
  if (bid != null) {
    tx.fee = bid;
    return tx;
  }
  let fee = levyNanos(0, { tx });
  tx.fee = fee;
  for (let i = 0; i < 8; i += 1) {
    const need = levyNanos(0, { tx });
    if (fee >= need) break;
    fee = need;
    tx.fee = fee;
  }
  return tx;
}

/**
 * Claim one reward into `to`. `to` is not the lock dest.
 * The owner signs (nullifier, amount, proof, destination). The signature
 * carries the spend key and not the lock dest. `ownerKey` is the Ed25519
 * private key. Omit it and the claim is unsigned, which consensus refuses.
 * `fee` is the same user bid a send posts. Omit it and the weight floor is used.
 * The claim does not expire.
 */
export function rewardClaimTx({
  to, nanos, nullifier, proof, id, spendSeed = null, fee = null, ownerKey = null, rootIndex = null, vault = null,
} = {}) {
  let named = nanos;
  if (vault?.nanos != null) named = vault.nanos;
  else if ((named == null || named === '') && vault?.blob) {
    const pub = vaultPublicReward(vault.blob);
    if (pub != null) named = pub <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pub) : pub;
  }
  const n = exactFloorNanos(named);
  let out;
  if (vault?.note) {
    out = { ...vault.note, address: to, kind: KIND_REWARD_CLAIM };
    delete out.portalId;
    // The reward integer is public. The opening is what consensus checks.
    // admitPub is not in the proof digest, so attaching it here does not
    // move the statement the blob already signed.
    if (!out.admitPub) out = attachAdmitPub(out, {});
    if (out.r && !out.valueProof) {
      try {
        const opened = proveValue(n, scalarFrom(out.r));
        const C = Buffer.from(asU8(opened?.C || []));
        const have = Buffer.from(asU8(out.commit));
        if (opened?.R && opened?.z && C.length === 32 && C.equals(have)) {
          out.valueProof = { R: opened.R, z: opened.z, v: n };
        }
      } catch { /* a note that does not open stays closed */ }
    }
    delete out.r;
  } else {
    out = sealedReserveVout(to, n, KIND_REWARD_CLAIM);
    delete out.portalId;
    if (out.commit) {
      const base = admitBaseFromAddress(to);
      Object.assign(out, attachAdmitPub(out, {
        admitBase: base || undefined,
        spendSeed: spendSeed || undefined,
      }));
    }
  }
  const tx = {
    id,
    programId: RESERVE_PROGRAM,
    mint: true,
    kind: KIND_REWARD_CLAIM,
    nanos: n,
    nullifier: String(vault?.nullifier || nullifier || '').toLowerCase(),
    proof: vault ? [] : (Array.isArray(proof) ? proof : []),
    vin: [],
    vout: [out],
  };
  if (vault?.blob) {
    tx.vaultProof = Buffer.from(vault.blob);
    tx.rootEpoch = Math.floor(Number(vault.rootEpoch) || 0);
    tx.earnEpoch = Math.floor(Number(vault.earnEpoch) || 0);
    if (vault.full) tx.full = true;
  }
  if (rootIndex != null && rootIndex !== '') tx.rootIndex = Math.floor(Number(rootIndex));
  if (ownerKey) {
    const message = rewardAuthMessage({
      kind: 'claim',
      nullifier: tx.nullifier,
      nanos: n,
      proof: tx.proof,
      dest: to,
    });
    const sig = signRewardAuth(message, ownerKey);
    if (sig) {
      tx.sig = sig;
      tx.spendPub = ed25519RawPub(ownerKey).toString('hex');
    }
  }
  return bindClaimFee(tx, fee);
}

/**
 * Signature that lets the owner withdraw principal. The nullifier is the
 * portal id. The amount is the principal. The destination is the payout.
 */
export function signWithdrawReward(tx, ownerKey, {
  portalId, nanos, dest, state = null, nowMs = null, epoch = null, trancheSet = null,
  tranches = null, magic = null, chainId = null, txBind = null,
} = {}) {
  if (!tx || !ownerKey) return tx;
  const id = String(portalId || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return tx;
  const bound = state && nowMs != null ? withdrawBinding(state, state.portals?.[id], nowMs) : null;
  const at = epoch != null ? epoch : bound?.epoch;
  const set = trancheSet || bound?.trancheSet || (tranches && at != null ? trancheSetHash(tranches, at) : null);
  const mag = magic || bound?.magic || null;
  const cid = chainId != null ? chainId : (bound ? bound.chainId : null);
  const namedBind = txBind != null ? (proofTxBind(txBind) || txBind) : proofTxBind(tx?.retireProof || tx?.retireProofs?.[0]);
  const message = withdrawOwnerMessage({
    nullifier: id,
    nanos,
    dest: dest || tx.to || '',
    magic: mag,
    chainId: cid,
    epoch: at,
    trancheSet: set,
    txBind: namedBind,
  });
  const sig = signRewardAuth(message, ownerKey);
  if (!sig) return tx;
  tx.rewardSig = sig;
  tx.ownerPub = ed25519RawPub(ownerKey).toString('hex');
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
  let lockCommit = null;
  let lockRange = null;
  if (kind === KIND_LOCK) {
    const published = Math.floor(Number(tx?.nanos) || 0) > 0
      || (o?.valueProof?.v != null && Math.floor(Number(o.valueProof.v) || 0) > 0);
    lockCommit = commit32(o);
    try { lockRange = o?.rangeProof ? Buffer.from(asU8(o.rangeProof)) : null; } catch { lockRange = null; }
    opened = !published && lockCommit.length === 32 && !!lockRange?.length && verifyRange(lockCommit, lockRange);
    nanos = 0;
  } else if (kind === KIND_WITHDRAW) {
    const pub = publicActionNanos(tx, o);
    const published = o?.valueProof?.v != null && Math.floor(Number(o.valueProof.v) || 0) > 0;
    if (pub === 0 && !published) {
      opened = true;
      nanos = 0;
    } else {
      const checked = withdrawNotesOpen(outs, pub);
      opened = checked.opened;
      nanos = checked.nanos;
    }
  } else if (o?.commit && o?.valueProof) {
    const cached = openingOf(o, claimed);
    if (cached) {
      opened = cached.opened;
      nanos = cached.nanos;
    } else {
      opened = !!verifySealedNote(o, claimed);
    }
  }
  const legacyTo = tx?.to || o?.address || '';
  const legacyFrom = tx?.from || tx?.vin?.[0]?.address || '';
  // Carried id only. dest20 and the address are not inputs.
  const portalId = isPortalId(tx?.portalId || o?.portalId) ? String(tx?.portalId || o?.portalId).toLowerCase() : '';
  const payoutPortalId = isPortalId(tx?.payoutPortalId) ? String(tx.payoutPortalId).toLowerCase() : '';
  return {
    kind,
    portalId,
    payoutPortalId,
    nanos,
    opened,
    commit: lockCommit && lockCommit.length === 32 ? lockCommit : null,
    rangeProof: lockRange,
    piProof: tx?.piProof || null,
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
  // Same rule as reserveAction. A missing id stays empty on both the fat
  // body and the compact body, so the digest does not grow an address hash.
  const portalId = isPortalId(tx?.portalId || o?.portalId) ? String(tx?.portalId || o?.portalId).toLowerCase() : '';
  const payoutPortalId = isPortalId(tx?.payoutPortalId) ? String(tx.payoutPortalId).toLowerCase() : '';
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

/** Unlock bound into the reserve suffix. Absent, or not a positive integer, is 0. */
function stampedUnlockAtMs(tx) {
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  for (const o of outs) {
    if (String(o?.kind || '') !== KIND_LOCK) continue;
    const unlock = Math.floor(Number(o?.unlockAtMs));
    return Number.isInteger(unlock) && unlock > 0 ? unlock : 0;
  }
  return 0;
}

/** Lock epoch bound into the reserve suffix. Absent is -1. */
function stampedLockEpoch(tx) {
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  for (const o of outs) {
    if (String(o?.kind || '') !== KIND_LOCK) continue;
    const epoch = Number(o?.lockEpoch);
    return Number.isInteger(epoch) && epoch >= 0 ? epoch : -1;
  }
  return -1;
}

/** Canonical piProof bytes. Missing, empty, and unreadable proofs are empty,
 * so a stripped proof hashes as sha256 of empty and the suffix stays fixed-width. */
function piProofWire(tx) {
  const raw = tx?.piProof;
  if (raw == null || raw === '') return Buffer.alloc(0);
  try {
    return Buffer.from(asU8(raw));
  } catch {
    return Buffer.alloc(0);
  }
}

/** Merkle, owner, and v3 transcript suffix for a lock, vote, or withdraw.
 * Unlock time and lock epoch are always bound. A lock also binds
 * sha256(piProof) after the owner pub. Stripping or swapping the proof
 * changes that word, so the spend signature and the FS-1 digest no longer
 * match. A withdraw also signs its id and its 32-byte nonce. A vote does not
 * bind a pi proof. */
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
    i64le(stampedUnlockAtMs(tx)),
    i64le(stampedLockEpoch(tx)),
  ];
  if (fields.kind === KIND_LOCK) {
    parts.push(rewardOwnerPub(tx?.ownerPub));
    parts.push(createHash('sha256').update(piProofWire(tx)).digest());
  }
  if (fields.kind === KIND_WITHDRAW) {
    parts.push(lenPrefUtf8(String(tx?.id || '')));
    parts.push(withdrawNonceSigned(tx));
  }
  return Buffer.concat(parts);
}

/** Binds the nullifier, the amount, and the proof. The lock dest is not in it. */
export function rewardClaimDigestSuffix(tx) {
  if (txKind(tx) !== KIND_REWARD_CLAIM) return null;
  const id = Buffer.from(String(tx?.nullifier || ''), 'hex');
  if (id.length !== 32) return Buffer.from('rewardclaim-bad');
  const steps = Array.isArray(tx?.proof) ? tx.proof : [];
  const parts = [Buffer.from('rewardclaim1'), id, i64le(tx?.nanos)];
  for (const step of steps) {
    const side = step?.side === 'L' ? 1 : 0;
    const hash = Buffer.from(String(step?.hash || ''), 'hex');
    if (hash.length !== 32) return Buffer.from('rewardclaim-bad');
    parts.push(Buffer.from([side]), hash);
  }
  return Buffer.concat(parts);
}

export function txIsReserveAction(tx) {
  if (!tx || tx.coinbase) return false;
  if (txKind(tx) === KIND_LEAF_VOTE || tx.voteProof) return true;
  return canonicalReserveFields(tx) != null;
}

export function verifyReservePayout(state, tx, clockMs) {
  const act = reserveAction(tx);
  if (!act) return { ok: true };
  if (!state) return { ok: false, reason: 'no_vault' };
  if (state.blankFork) return { ok: false, reason: 'blank_vault' };
  if (act.kind === KIND_LOCK) {
    const stamp = lockStampRejected(state, tx, clockMs);
    if (stamp) return stamp;
    if (act.opened !== true || !act.commit) return { ok: false, reason: 'bad_amount' };
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
  if (!Number.isFinite(clock) || clock <= 0 || settlementIndex(state, clock) <= 0) {
    return { ok: false, reason: 'epoch_open' };
  }
  if (!p) return { ok: false, reason: 'empty' };
  if (arrivalEpochOpen(state, p, clock)) return { ok: false, reason: 'epoch_open' };
  const hidden = maturedHiddenCommits(state, p, clock);
  if (hidden.length) {
    if (act.opened === false || !(act.nanos > 0)) return { ok: false, reason: 'mint_amount' };
    // An indexed leaf proof opens π. The receipt is π plus the arrival stub.
    const quote = indexedWithdrawQuote(state, p, clock, tx);
    if (quote) {
      if (!quote.ok) return { ok: false, reason: quote.reason || 'stake_reward' };
      const published = BigInt(act.nanos);
      if (published > quote.due) return { ok: false, reason: 'over_mint' };
      if (published < quote.due) return { ok: false, reason: 'principal_short' };
      const mintId = withdrawMintId(p.id || act.portalId, mintEpoch(state, clock));
      if (state.mintedIds && state.mintedIds[mintId]) return { ok: false, reason: 'double_mint' };
      return { ok: true };
    }
    const hinted = tx.principalProof?.opened != null ? exactBi(tx.principalProof.opened) : exactBi(act.nanos);
    if (hinted == null || hinted <= 0n) return { ok: false, reason: 'stake_reward' };
    const portalId = p.id || act.portalId;
    const opens = hidden.some((hex) => verifyPrincipalOpen(
      Buffer.from(hex, 'hex'), hinted, tx.principalProof, tx, portalId, state.magic,
    ));
    if (!opens) return { ok: false, reason: 'stake_reward' };
    if (BigInt(act.nanos) > hinted) return { ok: false, reason: 'over_mint' };
    if (BigInt(act.nanos) < hinted) return { ok: false, reason: 'principal_short' };
    const mintId = withdrawMintId(p.id || act.portalId, mintEpoch(state, clock));
    if (state.mintedIds && state.mintedIds[mintId]) return { ok: false, reason: 'double_mint' };
    return { ok: true };
  }
  const split = maturedSplit(state, p, clock);
  if (split.legacy <= 0n && split.note > 0n) return { ok: false, reason: 'note_principal' };
  const principal = nanosOut(split.legacy);
  const interest = withdrawPaysInterest(state, p, clock);
  const published = publicActionNanos(tx, (tx?.vout || []).find((row) => String(row?.kind || '') === KIND_WITHDRAW) || tx?.vout?.[0]);
  if (published != null && published < principal) return { ok: false, reason: 'principal_short' };
  if (act.opened === false) return { ok: false, reason: 'mint_amount' };
  if (act.nanos < principal) return { ok: false, reason: 'principal_short' };
  if (act.nanos > principal + interest) return { ok: false, reason: 'over_mint' };
  if (act.nanos !== principal + interest) return { ok: false, reason: 'mint_amount' };
  const mintId = withdrawMintId(p.id || act.portalId, mintEpoch(state, clock));
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

function unitsOfBlocks(blocks) {
  return unitsAlongChain({
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
}

/** Hash-bonus unit live at each block, before that block's own enact. */
export function bonusUnitsBefore(blocks) {
  const walked = unitsOfBlocks(blocks);
  if (!walked.ok) return null;
  return walked.units;
}

/**
 * One unit per block, including a block whose reserve row was refused.
 * Supply then reports that refusal. A walk that did not reach the last
 * block is still epoch_open.
 */
export function supplyUnits(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const walked = unitsOfBlocks(list);
  if (!walked || !Array.isArray(walked.units) || walked.units.length !== list.length) return null;
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

function maybeTallyBallots(state, height) {
  const epoch = Math.floor(Number(state?.currentEpoch) || 0);
  if (!censusOf(state, epoch)) return;
  tallyBallot(state, { epoch, param: 'hb', height, magic: state.magic });
  tallyBallot(state, { epoch, param: 'rr', height, magic: state.magic });
}

/**
 * A leaf vote spends one owned FS-1 note. The fee is the value that note
 * destroys. A voter-written fee with no input is not credited.
 */
const LEAKED_LEAF_VOTE_FIELDS = ['feeInput', 'parentTx', 'parent'];

function valueHasAddrLeak(value, seen) {
  if (value == null) return false;
  if (typeof value === 'string') {
    return value.includes('ssa1') || value.includes('she1') || value.includes('shear1');
  }
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return false;
  if (Array.isArray(value)) return value.some((row) => valueHasAddrLeak(row, seen));
  for (const row of Object.values(value)) {
    if (valueHasAddrLeak(row, seen)) return true;
  }
  return false;
}

/**
 * A compact lock carries portalId and dest20. `to` and any ssa1 string are
 * the address, which a peer must not need. Same shape as a leaked vote.
 * payoutPortalId on a lock is that leak. More than one lock output is a second portal.
 */
export function compactLockLeakRejected(tx) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== KIND_LOCK) return null;
  if (tx?.to != null && String(tx.to) !== '') return { ok: false, reason: 'vote_leak' };
  if (tx?.from != null && String(tx.from) !== '') return { ok: false, reason: 'vote_leak' };
  if (tx?.payer != null && String(tx.payer) !== '') return { ok: false, reason: 'vote_leak' };
  if (tx?.payoutPortalId != null && String(tx.payoutPortalId) !== '') return { ok: false, reason: 'vote_leak' };
  const lockOuts = (Array.isArray(tx?.vout) ? tx.vout : []).filter((row) => String(row?.kind || '') === KIND_LOCK);
  if (lockOuts.length > 1) return { ok: false, reason: 'portal_exists' };
  if (valueHasAddrLeak(tx, new Set())) return { ok: false, reason: 'vote_leak' };
  if (fs1SpendIdentityLeak(tx)) return { ok: false, reason: 'vote_leak' };
  return null;
}

/** spendPub or a signature on an FS-1 lock is the wallet identity. */
function fs1SpendIdentityLeak(tx) {
  const spend = tx?.spendPub != null && String(tx.spendPub) !== '';
  const sig = (tx?.sig != null && String(tx.sig) !== '')
    || (tx?.signature != null && String(tx.signature) !== '');
  if (!spend && !sig) return false;
  try {
    const blob = Buffer.from(asU8(tx?.fs1));
    return blob.length > 0 && blob[0] === 0xf1;
  } catch {
    return false;
  }
}

/**
 * A withdraw names the lock by portalId. `from`, `to`, `payer`, and
 * payoutPortalId are the address, including a payout id that matches the lock.
 * ssa1, she1, and shear1 strings are the same leak.
 */
export function withdrawLeakRejected(tx) {
  const kind = String(tx?.kind || tx?.vout?.[0]?.kind || '');
  if (kind !== KIND_WITHDRAW) return null;
  if (tx?.from != null && String(tx.from) !== '') return { ok: false, reason: 'vote_leak' };
  if (tx?.to != null && String(tx.to) !== '') return { ok: false, reason: 'vote_leak' };
  if (tx?.payer != null && String(tx.payer) !== '') return { ok: false, reason: 'vote_leak' };
  if (tx?.payoutPortalId != null && String(tx.payoutPortalId) !== '') return { ok: false, reason: 'vote_leak' };
  if (valueHasAddrLeak(tx, new Set())) return { ok: false, reason: 'vote_leak' };
  // The identity spend key is the wallet address. An FS-1 withdraw does not carry it.
  if (tx?.spendPub != null && String(tx.spendPub) !== '') {
    try {
      const blob = Buffer.from(asU8(tx.fs1));
      if (blob.length > 0 && blob[0] === 0xf1) return { ok: false, reason: 'vote_leak' };
    } catch { /* a withdraw with no FS-1 blob is not this rule */ }
  }
  return null;
}

/** The fee note's commit and its parent tx stay in the wallet. A vote that carries them is refused. */
export function leafVoteLeakRejected(tx) {
  if (String(tx?.kind || '') !== KIND_LEAF_VOTE) return null;
  for (const key of LEAKED_LEAF_VOTE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(tx, key)) continue;
    if (tx[key] != null && tx[key] !== '') return { ok: false, reason: 'vote_leak' };
  }
  return null;
}

export function leafVoteFundingRejected(tx) {
  if (String(tx?.kind || '') !== KIND_LEAF_VOTE) return null;
  const leaked = leafVoteLeakRejected(tx);
  if (leaked) return leaked;
  if (tx?.from != null && String(tx.from) !== '') return { ok: false, reason: 'admit_version' };
  if (tx?.payer != null && String(tx.payer) !== '') return { ok: false, reason: 'admit_version' };
  const vins = (Array.isArray(tx?.vin) ? tx.vin : []).filter((v) => v && !v.coinbase);
  if (vins.length !== 1 || vins[0].address || vins[0].dest20) {
    return { ok: false, reason: 'admit_version' };
  }
  const proofs = [];
  if (tx?.admit_proof) proofs.push(tx.admit_proof);
  if (Array.isArray(tx?.admit_proofs)) for (const proof of tx.admit_proofs) if (proof) proofs.push(proof);
  if (proofs.length !== 1 || !fs1RecordBlob(proofs[0])) return { ok: false, reason: 'admit_version' };
  if (tx?.fs1 == null || tx.fs1 === '') return { ok: false, reason: 'admit_version' };
  let posted = null;
  let tilde = null;
  try {
    posted = Buffer.from(asU8(vins[0].commit));
    tilde = Buffer.from(asU8(proofs[0].cTilde));
  } catch {
    return { ok: false, reason: 'admit_version' };
  }
  if (posted.length !== 32 || tilde.length !== 32 || !posted.equals(tilde)) {
    return { ok: false, reason: 'admit_membership' };
  }
  if (!leafVoteConserved(tx)) return { ok: false, reason: 'commit_sum' };
  return null;
}

/**
 * One leaf, one vote proof. The tag is the vote null point, not the claim
 * null point. A vote publishes no claim nullifier. A cast vote is not
 * removed when the leaf later withdraws.
 */
export function applyLeafVote(state, tx, blockHeight) {
  const leaked = leafVoteLeakRejected(tx);
  if (leaked) return leaked;
  ensureEpochCensus(state, blockHeight);
  if (Array.isArray(tx?.voteProofs)) return { ok: false, reason: 'stake_reward' };
  if (tx?.portalId || tx?.from || tx?.to || tx?.payoutPortalId) return { ok: false, reason: 'stake_reward' };
  if (tx?.nullifier || tx?.vaultProof) return { ok: false, reason: 'stake_reward' };
  const param = voteParam(tx?.voteParam || tx?.param);
  const choice = voteChoice(tx?.choice);
  const seq = Math.floor(Number(tx?.voteSeq ?? tx?.seq));
  const epoch = Math.floor(Number(tx?.earnEpoch ?? tx?.rootEpoch));
  if (!param || choice == null || !Number.isInteger(epoch) || epoch < 0) {
    return { ok: false, reason: 'bad_amount' };
  }
  const census = censusOf(state, epoch);
  if (!census) return { ok: false, reason: 'not_voter' };
  const magic = state.magic || MAGIC_TESTNET;
  if (!voteWindowOpen(census.openHeight, blockHeight, magic)) {
    return { ok: false, reason: 'epoch_closed' };
  }
  const rootHex = String(state?.epochStartRoots?.[String(epoch)] || '');
  if (!/^[0-9a-f]{64}$/.test(rootHex)) return { ok: false, reason: 'not_voter' };
  const proof = tx?.voteProof;
  if (!proof) return { ok: false, reason: 'unsigned' };
  const pid = proposalId(epoch, param);
  if (!pid) return { ok: false, reason: 'stake_reward' };
  const paid = Math.floor(Number(tx?.fee || 0));
  const need = Math.floor(Number(levyNanos(0, { tx })) || 0);
  if (paid < need) return { ok: false, reason: 'levy' };
  const funded = leafVoteFundingRejected(tx);
  if (funded) return funded;
  const got = verifyLeafVote({
    blob: proof,
    root: Buffer.from(rootHex, 'hex'),
    epoch,
    choice,
    seq,
    proposalId: pid,
    magic,
  });
  if (!got.ok || !got.voteTag) return { ok: false, reason: got.reason || 'unsigned' };
  const recorded = recordVote(state, {
    epoch,
    proposal: pid,
    tag: got.voteTag,
    choice,
    seq,
  });
  if (!recorded.ok) return recorded;
  return { ...recorded, voteTag: got.voteTag };
}

/** A claim and a vote are separate transactions. One tx that carries both is refused. */
function applyCombinedVote() {
  return { ok: false, reason: 'stake_reward' };
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
  holdEpoch = false,
  requireStakeReward = false,
  deferVaultRoot = false,
} = {}) {
  if (!state || state.blankFork) return [];
  state.tipMs = Number(nowMs) || 0;
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
  // One clock. The first positive chain genesis wins. A later block must
  // not move it, and a lock never installs one.
  if (Number(genesisMs) > 0 && !(Number(state.genesisMs) > 0)) {
    state.genesisMs = Number(genesisMs);
  }
  const clockGenesis = Number(state.genesisMs) || 0;
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
  // A ballot tallies once the window has been closed for the finality depth.
  // The roll applies only the epoch being left.
  maybeTallyBallots(state, blockHeight);
  if (state.bonusEnacted && !holdEpoch) syncVaultEpoch(state, nowMs);
  ensureEpochCensus(state, blockHeight);
  if (state.epochStartMs && !state.bonusEnacted && nowMs >= state.epochStartMs + epochMs(state.magic)) {
    const did = enact({ state, nowMs });
    results.push({ action: 'enact', ...did });
    if (!did.ok) return finishReserveApply(results);
  }
  const credited = applyStakeRewards(state, block, nowMs, { require: requireStakeReward });
  if (!credited.ok) {
    return finishReserveApply([{ ok: false, reason: credited.reason || 'stake_reward', action: 'stake-reward' }]);
  }
  const vaultRooted = storeVaultLockRoot(state, block, settlementIndex(state, nowMs));
  if (vaultRooted) {
    return finishReserveApply([{ ok: false, reason: vaultRooted.reason || 'stake_reward', action: 'stake-reward' }]);
  }
  let vaultClaims = 0;
  let leafVotes = 0;
  for (const tx of txs) {
    if (!tx || tx.coinbase) continue;
    if (txKind(tx) === KIND_REWARD_CLAIM) vaultClaims += 1;
    if (txKind(tx) === KIND_LEAF_VOTE || tx.voteProof) leafVotes += 1;
    if (Array.isArray(tx.voteProofs)) leafVotes += tx.voteProofs.length;
  }
  if (vaultClaims > MAX_BLOCK_VAULT_CLAIMS) {
    return finishReserveApply([{ ok: false, reason: 'claim_cap', action: KIND_REWARD_CLAIM }]);
  }
  if (leafVotes > MAX_BLOCK_LEAF_VOTES) {
    return finishReserveApply([{ ok: false, reason: 'vote_cap', action: KIND_LEAF_VOTE }]);
  }
  let retireDleqs = 0;
  for (const tx of txs) {
    if (!tx || tx.coinbase || txKind(tx) !== KIND_WITHDRAW) continue;
    for (const proof of proofListOf(tx, null)) {
      const n = retireDleqCount(proof);
      if (n != null) retireDleqs += n;
    }
  }
  if (retireDleqs > MAX_BLOCK_RETIRE_DLEQS) {
    return finishReserveApply([{ ok: false, reason: 'retire_cap', action: KIND_WITHDRAW }]);
  }
  const cb = txs.find((t) => t?.coinbase) || txs[0];
  const reservePaid = openedReserveFeeNanos(cb);
  if (reservePaid > 0) creditFeeBank(state, reservePaid);
  state.deferEpochRoll = true;
  for (const tx of txs) {
    if (!tx || tx.coinbase) continue;
    if (String(tx.programId || '') !== RESERVE_PROGRAM) continue;
    reserveApplyCount += 1;
    if (String(tx.kind || '') === 'roll') {
      const got = applyRoll(state, tx, nowMs, blockHeight);
      results.push({ action: 'roll', ...got });
      if (!got.ok) {
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      continue;
    }
    if (txKind(tx) === KIND_REWARD_CLAIM) {
      const got = applyRewardClaim(state, tx, blockHeight);
      results.push({ action: KIND_REWARD_CLAIM, ...got });
      if (!got.ok) {
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      if (tx.voteProof || tx.voteProofs) {
        const voted = applyCombinedVote(state, tx, blockHeight);
        results.push({ action: KIND_LEAF_VOTE, ...voted });
        if (!voted.ok) {
          state.deferEpochRoll = false;
          return finishReserveApply(results);
        }
      }
      continue;
    }
    if (txKind(tx) === KIND_LEAF_VOTE) {
      const got = applyLeafVote(state, tx, blockHeight);
      results.push({ action: KIND_LEAF_VOTE, ...got });
      if (!got.ok) {
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      continue;
    }
    const act = reserveAction(tx);
    if (!act) continue;
    if (act.kind === KIND_LOCK && act.opened === false) {
      results.push({ action: KIND_LOCK, ok: false, reason: 'stake_reward' });
      state.deferEpochRoll = false;
      return finishReserveApply(results);
    }
    if (act.opened === false) {
      if (act.kind === KIND_WITHDRAW) {
        results.push({ action: KIND_WITHDRAW, ok: false, reason: 'stake_reward' });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      continue;
    }
    if (act.kind === KIND_LOCK) {
      if (!tx?.vaultLockNote) {
        results.push({ action: KIND_LOCK, ok: false, reason: 'stake_reward' });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      const lockOuts = (Array.isArray(tx.vout) ? tx.vout : []).filter((row) => String(row?.kind || '') === KIND_LOCK);
      if (lockOuts.length > MAX_LOCK_LEAVES) {
        results.push({ action: KIND_LOCK, ok: false, reason: 'stake_reward' });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      const stamp = lockStampRejected(state, tx, nowMs);
      if (stamp) {
        results.push({ action: KIND_LOCK, ...stamp });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      const noteCommit = tx?.vaultLockNote ? lockNoteBytes(tx.vaultLockNote)?.subarray(32, 64) : null;
      const lockEpoch = chainEpochIndex(state, nowMs);
      const unlockEpoch = tx?.vaultLockNote ? consensusUnlockPeriod(lockEpoch) : null;
      if (tx?.vaultLockNote) {
        const funded = lockFundingRejected(tx, {
          height: blockHeight,
          magic: state.magic || MAGIC_TESTNET,
          unlock: unlockEpoch,
        });
        if (funded) {
          results.push({ action: KIND_LOCK, ...funded });
          state.deferEpochRoll = false;
          return finishReserveApply(results);
        }
      }
      const fundedOut = tx?.vaultLockNote ? consumedLockOutput(tx) : null;
      if (lockOuts.length > 1) {
        results.push({ action: KIND_LOCK, ok: false, reason: 'portal_exists' });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      if (tx?.payoutPortalId != null && String(tx.payoutPortalId) !== '') {
        results.push({ action: KIND_LOCK, ok: false, reason: 'vote_leak' });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      const credits = tx?.vaultLockNote
        ? [{
          commit: noteCommit || act.commit,
          rangeProof: fundedOut?.rangeProof || act.rangeProof,
          rangeCommit: fundedOut?.commit || null,
          unlock: unlockEpoch,
          piProof: act.piProof,
        }]
        : lockOuts.map((out) => ({
          commit: commit32(out),
          rangeProof: out?.rangeProof || null,
          piProof: act.piProof,
        }));
      if (credits.length !== 1) {
        results.push({ action: KIND_LOCK, ok: false, reason: credits.length ? 'portal_exists' : 'stake_reward' });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      // The carried portal id is the storage key. dest is not a fallback.
      if (!isPortalId(act.portalId)) {
        results.push({ action: KIND_LOCK, ok: false, reason: 'bad_dest' });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      const credit = credits[0];
      const got = deposit({
        state,
        portalId: act.portalId,
        dest: act.dest,
        commit: credit.commit,
        rangeProof: credit.rangeProof,
        rangeCommit: credit.rangeCommit,
        unlock: credit.unlock,
        piProof: credit.piProof,
        nowMs,
        payout: act.payout,
        ownerPub: tx.ownerPub || tx.spendPub,
        spendPub: tx.spendPub,
      });
      results.push({ action: KIND_LOCK, ...got });
      if (!got.ok) {
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      bindLockNote(state, act.portalId, tx, nowMs);
      if (tx?.remainCommit) {
        const openMs = consensusRemainMs(state, nowMs);
        if (!verifyRemainOpen(tx.remainCommit, openMs, tx.remainProof, tx, state.magic || MAGIC_TESTNET)) {
          results.push({ action: KIND_LOCK, ok: false, reason: 'stake_reward' });
          state.deferEpochRoll = false;
          return finishReserveApply(results);
        }
      }
      if (tx?.vaultLockNote) {
        const portal = state.portals?.[act.portalId];
        const tranche = portal?.tranches?.[portal.tranches.length - 1];
        const rooted = appendVaultLockNote(state, tx.vaultLockNote, {
          earnEpoch: Math.floor(Number(tranche?.epoch) || 0),
          bornEpoch: chainPeriodIndex(state, nowMs),
          unlockEpoch: consensusUnlockPeriod(lockEpoch),
          remainCommit: tx.remainCommit,
          lockHeight: blockHeight,
        });
        if (!rooted) {
          results.push({ action: KIND_LOCK, ok: false, reason: 'stake_reward' });
          state.deferEpochRoll = false;
          return finishReserveApply(results);
        }
        ensureEpochCensus(state, blockHeight);
      }
      const noted = lockNotePrincipal(tx, state.magic || MAGIC_TESTNET);
      const claimsNote = (Array.isArray(tx?.vin) ? tx.vin : []).some((vin) => vin && (vin.commit || vin.noteCommit || vin.valueProof));
      if (!tx?.vaultLockNote && claimsNote && noted <= 0n) {
        results.push({ action: KIND_LOCK, ok: false, reason: 'stake_reward' });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      if (noted > 0n) state.openedLockNanos = asBig(state.openedLockNanos) + noted;
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
      if (!got.ok) {
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      continue;
    }
    if (act.kind === KIND_WITHDRAW) {
      const bound = withdrawRewardRejected(state, tx, nowMs);
      if (bound) {
        results.push({ action: KIND_WITHDRAW, ...bound });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      const got = withdraw({
        state,
        portalId: act.portalId,
        dest: act.dest,
        nowMs,
        payout: act.payout,
        payoutPortalId: act.payoutPortalId,
        principal: act.nanos,
        principalProof: tx.principalProof,
        retireProof: tx.retireProof,
        tx,
      });
      results.push({ action: KIND_WITHDRAW, ...got });
      if (!got.ok) {
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      if (tx.vaultProof) {
        const nullifier = String(tx?.nullifier || '').toLowerCase();
        if (state.mintedIds?.[nullifier]) {
          results.push({ action: KIND_WITHDRAW, ok: false, reason: 'double_mint' });
          state.deferEpochRoll = false;
          return finishReserveApply(results);
        }
        const reward = vaultPublicReward(tx.vaultProof);
        if (reward == null || reward <= 0n) {
          results.push({ action: KIND_WITHDRAW, ok: false, reason: 'stake_reward' });
          state.deferEpochRoll = false;
          return finishReserveApply(results);
        }
        const claimTx = { ...tx, nanos: reward <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(reward) : reward.toString() };
        const claimRefused = vaultClaimRejected(claimTx, state);
        if (claimRefused) {
          results.push({ action: KIND_WITHDRAW, ...claimRefused });
          state.deferEpochRoll = false;
          return finishReserveApply(results);
        }
        state.mintedIds = state.mintedIds || Object.create(null);
        rememberMint(state, nullifier);
        state.mintedIds[nullifier] = true;
        state.mintBankNanos = asBig(state.mintBankNanos) + reward;
        state.rewardPermittedNanos = asBig(state.rewardPermittedNanos) + reward;
      }
    }
  }
  // Include this block's locks. The first write wins, so a later block of
  // the same period does not replace the root.
  snapshotPeriodRoot(state, blockHeight);
  markEpochsClosed(state, nowMs, blockHeight);
  const minted = settleVaultMint(state, block, blockHeight);
  if (minted) {
    state.deferEpochRoll = false;
    return finishReserveApply([{ ok: false, reason: minted.reason || 'stake_reward', action: KIND_REWARD_CLAIM }]);
  }
  const openedLocks = settleLockTotal(state, block, blockHeight);
  if (openedLocks) {
    state.deferEpochRoll = false;
    return finishReserveApply([{ ok: false, reason: openedLocks.reason || 'stake_reward', action: KIND_LOCK }]);
  }
  const openedWithdraws = settleWithdrawTotal(state, block, blockHeight);
  if (openedWithdraws) {
    state.deferEpochRoll = false;
    return finishReserveApply([{ ok: false, reason: openedWithdraws.reason || 'stake_reward', action: KIND_WITHDRAW }]);
  }
  state.deferEpochRoll = false;
  pruneClaimNullifiers(state, blockHeight);
  // A template trials one withdraw at a time. Rebuilding the vault-lock
  // tree on each one does not fit the one-second body budget. The caller
  // rebuilds once after the body is chosen. A block apply does not defer:
  // it still rebuilds once, from the same live notes.
  if (!deferVaultRoot && state.vaultLockDirty && !flushVaultLockRoot(state)) {
    return finishReserveApply([{ ok: false, reason: 'stake_reward', action: KIND_WITHDRAW }]);
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

/**
 * Consensus passes an explicit genesis, and 0 means the clock is unpinned.
 * A trial that omits the argument has no chain header. Use its nowMs so a
 * lock on that trial can pin, which is what the in-place undo hit does.
 * A vault that already has a clock keeps it.
 */
function trialClock(state, nowMs, genesisMs) {
  if (genesisMs != null && genesisMs !== '') return Number(genesisMs) || 0;
  if (Number(state?.genesisMs) > 0) return 0;
  const now = Number(nowMs) || 0;
  return now > 0 ? now : 0;
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
      requireStakeReward: !!oracle.requireStakeReward,
      deferVaultRoot: !!oracle.deferVaultRoot,
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
  genesisMs = null,
  requireStakeReward = false,
  deferVaultRoot = false,
} = {}) {
  const rows = Array.isArray(txs) ? txs : (Array.isArray(block?.txs) ? block.txs : []);
  const oracle = {
    oracleWindow,
    oracleWindowSize,
    activationHeight,
    oracleActivationHeight,
    height,
    parentMs,
    genesisMs: trialClock(state, nowMs, genesisMs),
    block,
  };
  const rewardBlock = trialBlock(rows, block);
  const rewardTouch = blockRewardRoot(rewardBlock) || stakeRewardNotesOf(rewardBlock).length
    || rows.some((tx) => txKind(tx) === KIND_REWARD_CLAIM);
  if (!rows.some(txIsReserveAction) && !requireStakeReward && !rewardTouch) {
    return { ok: true };
  }
  if (!state) return { ok: false, reason: 'no_vault' };
  if (state.blankFork) return { ok: false, reason: 'blank_vault' };
  // The carried vault is already a private copy. Mutate it and undo a miss.
  // Any other caller, including consensus, still gets one clone so the live
  // vault cannot change inside a check that discards the trial.
  if (inPlace) {
    return trialInPlace(state, rows, block, nowMs, { ...oracle, requireStakeReward, deferVaultRoot });
  }
  const trial = cloneVault(state);
  const applied = applyReserveBlock({
    state: trial,
    block: rewardBlock,
    nowMs: Number(nowMs) || 0,
    requireStakeReward,
    deferVaultRoot: !!deferVaultRoot,
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
    // One rho. Down at 0 is a no-op. Down at 1 sets the bonus off.
    if (live <= 0) {
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

/** Arrival stubs of the leaves this withdraw releases. A leaf with no lock height adds nothing. */
export function leafStubNanos(state, commitHexes) {
  let sum = 0n;
  const magic = state?.magic || MAGIC_TESTNET;
  for (const hex of commitHexes || []) {
    const noteHex = state?.vaultLockIndex?.[hex];
    const height = noteHex ? state?.vaultLeafHeight?.[noteHex] : null;
    if (height == null) continue;
    const epoch = epochOfPeriod(periodIndexOfHeight(height, magic));
    const got = arrivalStubNanos({
      amount: VAULT_PI_LEAF,
      lockHeight: height,
      magic,
      rates: state?.rateTable,
      rate: rateForEpoch(state, epoch),
    });
    if (got?.nanos > 0n) sum += got.nanos;
  }
  return sum;
}

function periodIndexOfHeight(height, magic) {
  const period = vaultPeriodBlocks(magic);
  if (period == null) return 0;
  return Math.floor(Number(height) / period);
}

/**
 * Forward burn. Periods this withdraw burns: the withdraw period through
 * every later period still inside the claim window. There is no separate
 * FORWARD_BURN constant. The window is VAULT_CLAIM_WINDOW_EPOCHS, counted
 * in periods, the same unit as the claim nullifier. A period before the
 * leaf was born is not in the set.
 */
export function leafEpochsToBurn(state, noteHex, withdrawPeriod) {
  const born = Math.floor(Number(state?.vaultLeafBorn?.[noteHex] ?? 0));
  const now = Math.floor(Number(withdrawPeriod) || 0);
  if (!Number.isInteger(now) || now < 0) return [];
  const start = Math.max(born, now);
  const last = now + VAULT_CLAIM_WINDOW_EPOCHS;
  if (start > last) return [now];
  const set = [];
  for (let period = start; period <= last; period += 1) set.push(period);
  return set;
}

/**
 * The EVM precompile does not recompute txDigestV3. It checks the trailing
 * bind the owner signed, and the node only forwards a withdraw whose JS
 * digest matches that bind. A block that skipped the JS check could present
 * a different body under the same bind.
 */
function retireBindOf(tx, magic) {
  if (!tx) return null;
  try {
    const digest = txDigestV3(tx, magic || MAGIC_TESTNET);
    return digest && digest.length === 32 ? digest : null;
  } catch {
    return null;
  }
}

/** DLEQ rows a withdraw would add to the block. Null when a proof does not parse. */
export function txRetireDleqs(tx) {
  if (txKind(tx) !== KIND_WITHDRAW) return 0;
  const list = proofListOf(tx, null);
  if (!list.length) return 0;
  let n = 0;
  for (const proof of list) {
    const rows = retireDeclaredRows(proof);
    if (rows == null) return null;
    n += rows;
  }
  return n;
}

/**
 * Selection refusal for one more withdraw. Null when the tx fits the
 * block's 64-DLEQ budget or is not a counted withdraw. The overflow stays
 * queued; it is not an unsigned block.
 */
export function retireCapHit(included, tx) {
  if (!txIsReserveAction(tx)) return null;
  const adding = txRetireDleqs(tx);
  if (adding == null) return null;
  const used = Math.floor(Number(included) || 0);
  if (used + adding > MAX_BLOCK_RETIRE_DLEQS) return { reason: 'retire_cap', adding };
  return null;
}

/**
 * One body whose declared retire rows already exceed the block cap.
 * A torn header is left to the caller's own refusal. The 16-leaf cap
 * stays unsigned when the declared sum still fits in 64.
 */
function excessRetireCap(proofList) {
  if (!Array.isArray(proofList) || !proofList.length) return null;
  let dleqs = 0;
  for (const proof of proofList) {
    const rows = retireDeclaredRows(proof);
    if (rows == null || rows > MAX_RETIRE_ROWS) return null;
    dleqs += rows;
    if (dleqs > MAX_BLOCK_RETIRE_DLEQS) return { ok: false, reason: 'retire_cap' };
  }
  return null;
}

function proofListOf(tx, retireProof) {
  if (Array.isArray(tx?.retireProofs) && tx.retireProofs.length) return tx.retireProofs;
  if (retireProof) return [retireProof];
  if (tx?.retireProof) return [tx.retireProof];
  return [];
}

function openListOf(tx, principalProof) {
  if (Array.isArray(tx?.principalProofs) && tx.principalProofs.length) return tx.principalProofs;
  if (principalProof) return [principalProof];
  if (tx?.principalProof) return [tx.principalProof];
  return [];
}

/**
 * One principal opening per released leaf. A shared proof does not open
 * the next leaf. The retire blob has to parse, bind this tx, and cover
 * the claim window.
 */
function principalProofKey(proof) {
  try {
    const R = Buffer.from(asU8(proof?.R));
    const z = Buffer.from(asU8(proof?.z));
    if (!R.length || !z.length) return null;
    return createHash('sha256')
      .update(R)
      .update(z)
      .update(Buffer.from(String(proof?.unlock || 0)))
      .digest('hex');
  } catch {
    return null;
  }
}

/** The same principal opening used twice, or an opening of a leaf this withdraw already retired. */
export function principalProofReused(state, portal, amount, proof, tx) {
  if (!state || !portal || !proof || !tx) return false;
  const want = exactBi(amount);
  if (want == null || want <= 0n) return false;
  const id = portal.id || portalKey(portal.dest);
  const retired = state.vaultRetired || {};
  for (const [commitHex, noteHex] of Object.entries(state.vaultLockIndex || {})) {
    if (!retired[noteHex]) continue;
    if (verifyPrincipalOpen(Buffer.from(commitHex, 'hex'), want, proof, tx, id, state?.magic)) return true;
  }
  return false;
}

function openIndexedLeaves({
  state, tx, hiddenCommits, chainNow, portalId, proofList, openList, want,
} = {}) {
  if (want == null || want <= 0n) return { ok: false, reason: 'mint_amount' };
  const k = proofList.length;
  if (!Number.isSafeInteger(k) || k < 1) return { ok: false, reason: 'mint_amount' };
  const overCap = excessRetireCap(proofList);
  if (overCap) return overCap;
  if (k > MAX_LOCK_LEAVES) return { ok: false, reason: 'unsigned' };
  if (openList.length !== k) return { ok: false, reason: 'stake_reward' };
  const seenProof = new Set();
  for (const proof of openList) {
    const key = principalProofKey(proof);
    if (!key || seenProof.has(key)) return { ok: false, reason: 'proof_reuse' };
    seenProof.add(key);
  }
  const magic = state?.magic || MAGIC_TESTNET;
  const bind = retireBindOf(tx, magic);
  if (!bind) return { ok: false, reason: 'stake_reward' };
  const used = new Set();
  const openedCommits = [];
  const retireRows = [];
  let dleqs = 0;
  for (const proof of proofList) {
    const rows = retireDeclaredRows(proof);
    if (rows == null) return { ok: false, reason: 'stake_reward' };
    if (rows > MAX_RETIRE_ROWS) return { ok: false, reason: 'unsigned' };
    dleqs += rows;
    // Over the block's 64-DLEQ retire budget. Same reason as applyReserveBlock.
    if (dleqs > MAX_BLOCK_RETIRE_DLEQS) return { ok: false, reason: 'retire_cap' };
    const burned = verifyLeafRetire(proof, null, magic);
    if (!burned || !burned.txBind.equals(bind)) return { ok: false, reason: 'stake_reward' };
    if (burned.unlock !== BigInt(chainNow)) return { ok: false, reason: 'stake_reward' };
    const commitHex = burned.leaf.subarray(32, 64).toString('hex');
    const noteHex = state.vaultLockIndex?.[commitHex];
    if (!noteHex || burned.leaf.toString('hex') !== noteHex) {
      return { ok: false, reason: 'stake_reward' };
    }
    if (used.has(commitHex)) return { ok: false, reason: 'proof_reuse' };
    if (!hiddenCommits.includes(commitHex)) return { ok: false, reason: 'stake_reward' };
    const need = leafEpochsToBurn(state, noteHex, chainNow);
    const have = new Set(burned.epochs.map((row) => Number(row.epoch)));
    if (!need.every((epoch) => have.has(epoch))) return { ok: false, reason: 'stake_reward' };
    if (!verifyPrincipalOpen(Buffer.from(commitHex, 'hex'), VAULT_PI_LEAF, openList[used.size], tx, portalId, magic)) {
      return { ok: false, reason: 'stake_reward' };
    }
    used.add(commitHex);
    openedCommits.push(commitHex);
    retireRows.push(burned);
  }
  if (openedCommits.length !== k) return { ok: false, reason: 'stake_reward' };
  return {
    ok: true,
    openedCommits,
    hiddenPrincipal: VAULT_PI_LEAF * BigInt(k),
    retireRows,
  };
}

/**
 * Indexed hidden withdraw. The principal proofs open π per leaf.
 * The receipt is that principal plus the arrival stub.
 * Null when this portal has no indexed matured leaf.
 */
export function indexedWithdrawQuote(state, portal, nowMs, tx) {
  if (!state || !portal || !tx) return null;
  const hidden = maturedHiddenCommits(state, portal, nowMs);
  const indexed = hidden.filter((hex) => state.vaultLockIndex?.[hex]);
  if (!indexed.length) return null;
  const id = portal.id || portalKey(portal.dest);
  const want = exactBi(tx?.nanos);
  const opened = openIndexedLeaves({
    state,
    tx,
    hiddenCommits: hidden,
    chainNow: chainPeriodIndex(state, nowMs),
    portalId: id,
    proofList: proofListOf(tx, null),
    openList: openListOf(tx, null),
    want: want != null && want > 0n ? want : 1n,
  });
  if (!opened.ok) return { ok: false, reason: opened.reason || 'stake_reward' };
  const due = opened.hiddenPrincipal + leafStubNanos(state, opened.openedCommits);
  return { ok: true, due, principal: opened.hiddenPrincipal };
}

/** Principal an indexed withdraw releases. Null when the leaf is not indexed. */
export function releasedWithdrawPrincipal(state, tx, nowMs) {
  const act = reserveAction(tx);
  const portal = act?.portalId ? state?.portals?.[act.portalId] : null;
  if (!portal) return null;
  const quote = indexedWithdrawQuote(state, portal, nowMs, tx);
  if (!quote || quote.ok !== true) return null;
  return quote.principal;
}

/**
 * A withdraw retire blob that would fail in the block fails here too.
 * Absent proofs are not a blob. A proof that does not parse is stake_reward
 * even before the portal is known. With a vault, the indexed-leaf checks
 * are the same ones withdraw() applies.
 */
export function retireBlobRejected(tx, state = null, nowMs = null) {
  const proofList = proofListOf(tx, null);
  if (!proofList.length) return null;
  const overCap = excessRetireCap(proofList);
  if (overCap) return overCap;
  if (proofList.length > MAX_LOCK_LEAVES) return { ok: false, reason: 'unsigned' };
  const magic = state?.magic || MAGIC_TESTNET;
  let dleqs = 0;
  for (const proof of proofList) {
    const rows = retireDeclaredRows(proof);
    if (rows == null) return { ok: false, reason: 'stake_reward' };
    if (rows > MAX_RETIRE_ROWS) return { ok: false, reason: 'unsigned' };
    dleqs += rows;
    // Over the block's 64-DLEQ retire budget. Same reason as applyReserveBlock.
    if (dleqs > MAX_BLOCK_RETIRE_DLEQS) return { ok: false, reason: 'retire_cap' };
    if (!verifyLeafRetire(proof, null, magic)) return { ok: false, reason: 'stake_reward' };
  }
  if (!state || nowMs == null) return null;
  const id = portalKey(tx?.portalId || tx?.from);
  const portal = id ? state.portals?.[id] : null;
  if (!portal) return null;
  const hiddenCommits = maturedHiddenCommits(state, portal, nowMs);
  const indexed = hiddenCommits.filter((hex) => state.vaultLockIndex?.[hex]);
  if (!indexed.length) return null;
  const opened = openIndexedLeaves({
    state,
    tx,
    hiddenCommits,
    chainNow: chainPeriodIndex(state, nowMs),
    portalId: id,
    proofList,
    openList: openListOf(tx, null),
    want: exactBi(tx?.nanos),
  });
  if (!opened.ok) return { ok: false, reason: opened.reason || 'stake_reward' };
  return null;
}

export function withdraw({
  state, dest, portalId, nowMs, payout, payoutPortalId,
  principal = null, principalProof = null, retireProof = null, tx = null,
} = {}) {
  if (!state) return { ok: false, reason: 'no_vault' };
  if (state.blankFork) return { ok: false, reason: 'blank_vault' };
  const id = portalKey(portalId || dest);
  if (!id) return { ok: false, reason: 'bad_dest' };
  if (dest && !isPortalId(dest) && (!isDestAddress(dest) || isShearAddress(dest))) {
    return { ok: false, reason: 'bad_dest' };
  }
  // Completed deposits can be withdrawn on any later block. Each credit
  // unlocks at the end of its own lock epoch. A later top-up does not
  // re-lock principal whose epoch has already ended.
  if (settlementIndex(state, nowMs) <= 0) {
    return { ok: false, reason: 'epoch_open' };
  }
  const withdrawId = withdrawMintId(id, chainEpochIndex(state, nowMs));
  if (state.mintedIds?.[withdrawId]) return { ok: false, reason: 'double_mint' };
  if (state.epochStartMs && !state.bonusEnacted && nowMs >= state.epochStartMs + epochMs(state.magic)) {
    const did = enact({ state, nowMs });
    if (!did.ok) return did;
  }
  const p = portalOf(state, id);
  const owner = String(p.ownerPub || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(owner)) return { ok: false, reason: 'owner_missing' };
  const rewardTaken = rewardAlreadyMinted(state, p, nowMs) || rewardReserved(state, p.id);
  const dueEpochs = rewardTaken ? [] : dueRewardEpochs(state, p, nowMs);
  if (payoutPortalId && p.payoutPortalId && String(payoutPortalId).toLowerCase() !== p.payoutPortalId) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  if (p.payout && payout && isDestAddress(payout) && payout !== p.payout) {
    return { ok: false, reason: 'payout_mismatch' };
  }
  const staked = asBig(p.staked);
  const idle = asBig(p.idle);
  const hiddenCommits = maturedHiddenCommits(state, p, nowMs);
  // A commitment still inside its lock epoch is not an empty portal.
  if (arrivalEpochOpen(state, p, nowMs)) return { ok: false, reason: 'epoch_open' };
  if (staked + idle <= 0n && hiddenCommits.length === 0) return { ok: false, reason: 'empty' };
  const split = maturedSplit(state, p, nowMs);
  if (split.legacy <= 0n && split.note > 0n && hiddenCommits.length === 0) return { ok: false, reason: 'note_principal' };
  const chainEpoch = chainEpochIndex(state, nowMs);
  const chainPeriod = chainPeriodIndex(state, nowMs);
  if (state?.rolled?.[rollKey(id, chainEpoch)] || state?.rolled?.[rollKey(id, state.currentEpoch)]) {
    return { ok: false, reason: 'stake_reward' };
  }
  let openedCommits = [];
  let hiddenPrincipal = 0n;
  let retireRows = [];
  let arrivalPaid = 0n;
  if (hiddenCommits.length) {
    const want = exactBi(principal);
    const proofList = Array.isArray(tx?.retireProofs) && tx.retireProofs.length
      ? tx.retireProofs
      : (retireProof ? [retireProof] : []);
    const openList = Array.isArray(tx?.principalProofs) && tx.principalProofs.length
      ? tx.principalProofs
      : (principalProof ? [principalProof] : []);
    const indexed = hiddenCommits.filter((hex) => state.vaultLockIndex?.[hex]);
    if (proofList.length) {
      const overCap = excessRetireCap(proofList);
      if (overCap) return overCap;
      if (proofList.length > MAX_LOCK_LEAVES) return { ok: false, reason: 'unsigned' };
      let dleqs = 0;
      for (const proof of proofList) {
        const rows = retireDeclaredRows(proof);
        if (rows == null) return { ok: false, reason: 'stake_reward' };
        if (rows > MAX_RETIRE_ROWS) return { ok: false, reason: 'unsigned' };
        dleqs += rows;
        // Over the block's 64-DLEQ retire budget. Same reason as applyReserveBlock.
        if (dleqs > MAX_BLOCK_RETIRE_DLEQS) return { ok: false, reason: 'retire_cap' };
        if (!verifyLeafRetire(proof, null, state?.magic || MAGIC_TESTNET)) {
          return { ok: false, reason: 'stake_reward' };
        }
      }
    }
    if (indexed.length) {
      const opened = openIndexedLeaves({
        state, tx, hiddenCommits, chainNow: chainPeriod, portalId: id, proofList, openList, want,
      });
      if (!opened.ok) return opened;
      openedCommits = opened.openedCommits;
      hiddenPrincipal = opened.hiddenPrincipal;
      retireRows = opened.retireRows;
    } else if (want != null && want > 0n) {
      // An unindexed hidden tranche is not a receipt. Do not open it.
      return { ok: false, reason: 'stake_reward' };
    } else {
      // A matured commitment with no lock-note index is not a receipt.
      return { ok: false, reason: 'stake_reward' };
    }
    const stub = leafStubNanos(state, openedCommits);
    if (indexed.length || (want != null && want > 0n)) {
      if (want !== hiddenPrincipal + stub) return { ok: false, reason: 'mint_amount' };
      arrivalPaid = stub;
    }
  }
  const openedCommit = openedCommits[0] || null;
  const release = hiddenCommits.length ? hiddenPrincipal : split.legacy;
  if (release <= 0n && hiddenCommits.length === 0) return { ok: false, reason: 'epoch_open' };
  const to = continuumOf(p, payout, isDestAddress(dest) ? dest : '');
  // Fold the qualified reward onto the portal and leave it there.
  // The payout is principal only. The ZK claim is what will mint the reward.
  settlePortal(state, p, nowMs);
  const earned = capReward(p.accruedReward);
  const interest = 0n;
  let mint = null;
  if (!extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' })) {
    return { ok: false, reason: 'mint_forbidden' };
  }
  void rewardTaken;
  void dueEpochs;
  const chain = chainEpoch;
  if (openedCommits.length) {
    if (hiddenRewardDue(state, p, nowMs)) p.hiddenRewardOpen = true;
    if (!state.pendingWithdraw) state.pendingWithdraw = [];
    for (const hex of openedCommits) {
      state.pendingWithdraw.push({ commit: hex, epoch: chain });
      const nextSum = subPointSum(state.vaultPrincipalSum, Buffer.from(hex, 'hex'));
      if (nextSum == null) return { ok: false, reason: 'stake_reward' };
      state.vaultPrincipalSum = nextSum;
    }
  }
  state.totalLockedNanos = asBig(state.totalLockedNanos) - release;
  if (state.totalLockedNanos < 0n) state.totalLockedNanos = 0n;
  if (release > 0n) state.openedWithdrawNanos = asBig(state.openedWithdrawNanos) + release;
  p.redeemedNanos = asBig(p.redeemedNanos) + release;
  if (Array.isArray(p.tranches) && p.tranches.length) {
    p.tranches = p.tranches.filter((tranche) => {
      if (openedCommits.length) {
        const hex = commitBytes(tranche?.commit)?.toString('hex');
        return !openedCommits.includes(hex);
      }
      const matured = chain > Math.floor(Number(tranche.epoch) || 0);
      if (!matured) return true;
      return !!tranche.noteIsPrincipal;
    });
  }
  let fromStaked = release >= staked ? staked : release;
  let fromIdle = release - fromStaked;
  if (fromIdle > idle) fromIdle = idle;
  p.staked = staked - fromStaked;
  p.idle = idle - fromIdle;
  const remain = asBig(p.staked) + asBig(p.idle);
  const hiddenLeft = (p.tranches || []).some((tranche) => commitBytes(tranche?.commit) && !tranche.noteIsPrincipal);
  const stillVoter = remain >= BigInt(PI_SHE_NANOS) || (hiddenLeft && p.qualified === true);
  if (remain <= 0n && !hiddenLeft) {
    p.staked = 0n;
    p.idle = 0n;
    p.tranches = [];
    p.rewardEpoch = null;
    p.joined = false;
    p.vote = null;
    p.voteEpoch = 0;
    p.payout = null;
    delete p.lockEpoch;
  } else if (!stillVoter) {
    p.joined = false;
    p.vote = null;
    p.voteEpoch = 0;
  }
  const shownInterest = nanosOut(interest);
  const shownPrincipal = nanosOut(release);
  state.mintedIds = state.mintedIds || Object.create(null);
  rememberMint(state, withdrawId);
  state.mintedIds[withdrawId] = true;
  if (arrivalPaid > 0n) {
    state.mintBankNanos = asBig(state.mintBankNanos) + arrivalPaid;
    state.rewardPermittedNanos = asBig(state.rewardPermittedNanos) + arrivalPaid;
  }
  if (!state.withdrewEpoch) state.withdrewEpoch = Object.create(null);
  state.withdrewEpoch[rollKey(id, chain)] = true;
  state.withdrewEpoch[rollKey(id, state.currentEpoch)] = true;
  for (const row of retireRows) {
    const commitHex = row.leaf.subarray(32, 64).toString('hex');
    if (!retireVaultLeaf(state, commitHex)?.retired) return { ok: false, reason: 'stake_reward' };
    for (const epoch of row.epochs) {
      const claimId = epoch.nullifier.toString('hex');
      const retireId = epoch.retireNullifier.toString('hex');
      rememberMint(state, claimId);
      rememberMint(state, retireId);
      state.mintedIds[claimId] = true;
      state.mintedIds[retireId] = true;
    }
  }
  return {
    ok: true,
    principal: shownPrincipal,
    staked: nanosOut(fromStaked),
    idle: nanosOut(fromIdle),
    interest: shownInterest,
    reward: shownInterest,
    earned: nanosOut(earned),
    rewardSource: undefined,
    payout: nanosOut(release),
    arrival: nanosOut(arrivalPaid),
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
 * Opened must be the matured principal plus permitted. A top-up whose
 * own epoch is still open is not part of that principal. The vault's own
 * interest must be that permitted amount, and the mint must be that interest.
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
  const noteBook = () => asBig(state.openedLockNanos) - asBig(state.openedWithdrawNanos);
  const startNote = noteBook();
  let locksIn = 0n;
  let principalOut = 0n;
  let minted = 0n;
  let permittedSum = 0n;
  let from = 0;
  let counted = 0;
  let started = false;
  const fail = () => ({ ok: false, reason: 'supply' });
  const applySlice = (slice, holdEpoch = false) => {
    if (!slice.length) return true;
    const beforeOpen = asBig(state.openedLockNanos);
    const applied = applyReserveBlock({
      state,
      block: { txs: slice, height: block?.height },
      nowMs: clock,
      holdEpoch,
      ...oracleForward({ ...oracle, block }),
    });
    if (!applied || applied.ok !== true) return false;
    const added = asBig(state.openedLockNanos) - beforeOpen;
    if (added < 0n) return false;
    locksIn += added;
    return true;
  };
  for (let i = 0; i < txs.length; i += 1) {
    if (!isWithdrawTx(txs[i])) continue;
    const prefix = txs.slice(from, i);
    if (prefix.length) {
      if (!applySlice(prefix, started)) return fail();
      started = true;
    }
    from = i + 1;
    const act = reserveAction(txs[i]);
    if (!act || act.opened !== true) return fail();
    const portal = act.portalId ? state.portals?.[act.portalId] : null;
    const hidden = maturedHiddenCommits(state, portal, clock);
    const principal = hidden.length ? exactBi(act.nanos) : exactBi(withdrawablePrincipal(state, portal, clock));
    const opened = exactBi(act.nanos);
    if (principal == null || opened == null) return fail();
    // The receipt is the principal. The reward is not minted here.
    if (opened !== principal) return fail();
    // The first slice is the start of this block. Later slices, including a
    // second withdraw, stay on the epoch that slice enacted.
    const applied = applyReserveBlock({
      state,
      block: { txs: [txs[i]], height: block?.height },
      nowMs: clock,
      holdEpoch: started,
      ...oracleForward({ ...oracle, block }),
    });
    started = true;
    if (!applied || applied.ok !== true) return fail();
    const got = [];
    for (const row of applied) {
      if (row && row.action === KIND_WITHDRAW && row.ok === true) got.push(row);
    }
    if (got.length !== 1) return fail();
    const interest = exactBi(got[0].interest);
    const vaultPrincipal = exactBi(got[0].principal);
    const arrivalRaw = exactBi(got[0].arrival);
    const arrival = arrivalRaw == null ? 0n : arrivalRaw;
    if (interest == null || vaultPrincipal == null) return fail();
    // The receipt is principal plus the arrival stub. The reward mint stays 0.
    // Supply counts the stub as minted interest and releases only the principal.
    if (interest !== 0n || vaultPrincipal + arrival !== opened) return fail();
    const mintedHere = got[0].mint && got[0].mint.ok === true ? exactBi(got[0].mint.nanos) : 0n;
    if (mintedHere == null || mintedHere !== 0n) return fail();
    minted += arrival;
    permittedSum += arrival;
    principalOut += vaultPrincipal;
    if (minted > REWARD_U64 || permittedSum > REWARD_U64) return fail();
    counted += 1;
  }
  if (!applySlice(txs.slice(from), started)) return fail();
  if (counted !== rows.length) return fail();
  if (startNote + locksIn !== noteBook() + principalOut) return fail();
  if (minted !== permittedSum) return fail();
  return { ok: true, minted, permitted: permittedSum };
}

/**
 * Coinbase carries a root, not a mint. Supply grows only by claim outputs.
 * Unclaimed rows stay out of minted and permitted interest.
 */
export function stakeRewardSupply(vault, block, nowMs, height = null) {
  if (stakeRewardNotesOf(block).length) return { ok: false, reason: 'supply', minted: 0n, permitted: 0n, claimed: 0n };
  const got = blockRewardRoot(block);
  if (got === 'bad') return { ok: false, reason: 'supply', minted: 0n, permitted: 0n, claimed: 0n };
  const state = vault ? cloneVault(vault) : emptyVault();
  if (state.blankFork) return { ok: false, reason: 'supply', minted: 0n, permitted: 0n, claimed: 0n };
  if (got) {
    const committed = applyStakeRewards(state, block, nowMs, { require: true });
    if (!committed.ok || committed.skipped) {
      return { ok: false, reason: 'supply', minted: 0n, permitted: 0n, claimed: 0n };
    }
  }
  const named = height != null && height !== '' ? height : block?.height;
  const rooted = storeVaultLockRoot(state, block, settlementIndex(state, nowMs));
  if (rooted) return { ok: false, reason: 'supply', minted: 0n, permitted: 0n, claimed: 0n };
  let minted = 0n;
  for (const tx of Array.isArray(block?.txs) ? block.txs : []) {
    if (!tx || tx.coinbase || txKind(tx) !== KIND_REWARD_CLAIM) continue;
    const paid = applyRewardClaim(state, tx, named);
    if (!paid.ok) return { ok: false, reason: 'supply', minted: 0n, permitted: 0n, claimed: 0n };
    minted += asBig(paid.nanos);
  }
  const blockHeight = Math.floor(Number(named) || 0);
  markEpochsClosed(state, nowMs, blockHeight);
  const settled = settleVaultMint(state, block, blockHeight);
  if (settled) return { ok: false, reason: 'supply', minted: 0n, permitted: 0n, claimed: 0n };
  return { ok: true, minted, permitted: minted, claimed: 0n };
}

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

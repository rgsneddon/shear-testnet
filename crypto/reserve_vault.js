import { createHash, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
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
import { isDestAddress, isShearAddress, hash20FromAddress, encodeDest, admitBaseFromAddress, ED25519_SPKI_PREFIX, ed25519RawPub, ed25519PrivateFromSeed, ed25519SeedOf } from './address.js';
import { attachAdmitPub } from './admit.js';
import { fs1LeafFor } from './fs1_leaf.js';
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
import { reserveFeeDest, levyNanos } from './levy.js';
import { decodeHeader } from './header.js';
import { merkleRoot, merkleProof, merkleVerify } from './merkle.js';

export const VOTE_INCREASE = 'increase bonus';
export const VOTE_DECREASE = 'decrease bonus';
export const VOTE_HOLD = 'leave bonus as-is';
export const KIND_LOCK = 'lock';
export const KIND_WITHDRAW = 'withdraw';
export const KIND_VOTE = 'vote';
export const STAKE_REWARD_KIND = 'stake-reward';
/** User tx that mints one archived reward. It is not a coinbase row. */
export const KIND_REWARD_CLAIM = 'reward-claim';
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
    const amount = asBig(tranche?.amount);
    const remain = BigInt(Math.max(0, Math.floor(Number(tranche?.remainMs) || 0)));
    h = createHash('sha256')
      .update(h)
      .update(u256be(amount))
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
  nullifier, nanos, dest, magic, chainId, epoch, trancheSet,
} = {}) {
  const id = Buffer.from(String(nullifier || '').replace(/^0x/i, ''), 'hex');
  if (id.length !== 32) return null;
  const n = BigInt(nanos);
  if (n <= 0n || n > 0xffffffffffffffffn) return null;
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
  return Buffer.concat([
    Buffer.from(WITHDRAW_OWNER_TAG),
    id,
    u64le(n),
    mag,
    u64le(chain),
    u64le(at),
    setRaw,
    u32le(destBuf.length),
    destBuf,
  ]);
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
  const principal = Math.floor(Number(withdrawablePrincipal(state, portal, nowMs)) || 0);
  if (!(principal > 0)) return null;
  const presented = String(tx?.ownerPub || '').replace(/^0x/i, '').toLowerCase();
  if (presented && presented !== owner) return { ok: false, reason: 'unsigned', nanos: 0 };
  const dest = String(tx?.to || act?.payout || '');
  const bind = withdrawBinding(state, portal, nowMs);
  const message = withdrawOwnerMessage({
    nullifier: id,
    nanos: principal,
    dest,
    magic: bind.magic,
    chainId: bind.chainId,
    epoch: bind.epoch,
    trancheSet: bind.trancheSet,
  });
  if (!verifyRewardAuth(message, owner, tx?.rewardSig)) return { ok: false, reason: 'unsigned', nanos: 0 };
  return null;
}

/** Every reward claim is refused until the ZK FS-1 ownership proof activates. */
export function rewardClaimRejected(tx, state = null) {
  void state;
  if (String(tx?.kind || tx?.vout?.[0]?.kind || '') !== KIND_REWARD_CLAIM) return null;
  return { ok: false, reason: 'claim_unavailable' };
}

/**
 * Reward claims are closed. PR 116's ZK proof is what will open them.
 * The qualified reward stays on the portal. This does not mint it.
 */
export function applyRewardClaim(state, tx) {
  void state;
  void tx;
  return { ok: false, reason: 'claim_unavailable', nanos: 0 };
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

/** User notes hold principal. Minted reward cannot exceed the epoch allowance. The fee bank is zero. */
export function supplyIdentity(state) {
  const vault = state || emptyVault();
  let principal = 0n;
  let accrued = 0n;
  for (const p of Object.values(vault.portals || {})) {
    principal += asBig(p?.staked) + asBig(p?.idle);
    accrued += capReward(p?.accruedReward);
  }
  const feeBank = asBig(vault.feeBankNanos);
  const minted = asBig(vault.mintBankNanos);
  const permitted = schedulePermittedNanos(vault);
  const locked = asBig(vault.totalLockedNanos);
  const ok = locked === principal && feeBank === 0n && minted <= permitted;
  return {
    ok,
    reason: ok ? undefined : 'supply',
    principalNanos: asNum(principal),
    lockedNanos: asNum(principal),
    vaultNanos: asNum(principal + accrued),
    // Locked principal is still supply. It is not a burn.
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
    deferEpochRoll: !!state.deferEpochRoll,
    portals: state.portals,
    mintedIds: state.mintedIds,
    freezes: state.freezes,
    rewardRoots: state.rewardRoots ? { ...state.rewardRoots } : null,
    rewardBook: state.rewardBook ? { ...state.rewardBook } : null,
    rewardSets: state.rewardSets ? { ...state.rewardSets } : null,
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
  state.deferEpochRoll = !!snap.deferEpochRoll;
  state.portals = snap.portals;
  state.mintedIds = snap.mintedIds;
  state.freezes = snap.freezes;
  state.rewardRoots = snap.rewardRoots ? { ...snap.rewardRoots } : Object.create(null);
  state.rewardBook = snap.rewardBook ? { ...snap.rewardBook } : Object.create(null);
  state.rewardSets = snap.rewardSets ? { ...snap.rewardSets } : Object.create(null);
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
  void freezeEpochBps;
  void MAGIC_MAINNET;
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
  state.votes = { increase: 0, decrease: 0, hold: 0 };
  applyEpochOpen(state, nowMs, idx);
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
  const tranche = portal?.tranches?.[portal.tranches.length - 1];
  if (!tranche) return;
  const outs = Array.isArray(tx?.vout) ? tx.vout : [];
  const out = [...outs].reverse().find((row) => String(row?.kind || tx?.kind || '') === KIND_LOCK) || null;
  const idx = chainEpochIndex(state, nowMs);
  const genesis = Number(state.genesisMs) || 0;
  const span = epochMs(state.magic);
  const computed = genesis > 0 ? genesis + (idx + 1) * span : 0;
  const unlock = Number(out?.unlockAtMs) > 0 ? Number(out.unlockAtMs) : computed;
  tranche.unlockAtMs = unlock;
  tranche.lockEpoch = Number.isInteger(Number(out?.lockEpoch)) ? Number(out.lockEpoch) : idx;
  tranche.noteIsPrincipal = false;
  delete tranche.noteCommit;
}

/** One credit. It earns the rest of its chain epoch, then later full epochs. */
function noteCredit(state, p, amount, nowMs) {
  const idx = chainEpochIndex(state, nowMs);
  const span = epochMs(state.magic);
  const genesis = Number(state.genesisMs) || 0;
  const end = genesis > 0 ? genesis + (idx + 1) * span : 0;
  const now = Number(nowMs) || 0;
  let remain = end > now ? end - now : 0;
  if (remain > span) remain = span;
  if (!Array.isArray(p.tranches)) p.tranches = [];
  p.tranches.push({
    amount: asBig(amount),
    epoch: idx,
    remainMs: remain,
    fullFrom: idx + 1,
    partialPaid: false,
  });
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
  // No clock, no credit. A later pin must not inherit an unpinned lock.
  if (!(Number(state?.genesisMs) > 0)) return { ok: false, reason: 'clock' };
  const p = portalOf(state, id);
  const pub = String(ownerPub || '').replace(/^0x/i, '').toLowerCase();
  const given = /^[0-9a-f]{64}$/.test(pub);
  const have = /^[0-9a-f]{64}$/.test(String(p.ownerPub || ''));
  if (!given) return { ok: false, reason: 'owner_missing' };
  if (have && p.ownerPub !== pub) return { ok: false, reason: 'unsigned' };
  if (!have) p.ownerPub = pub;
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
  if (staking) p.staked = asBig(p.staked) + n;
  else p.idle = asBig(p.idle) + n;
  noteCredit(state, p, n, nowMs);
  state.totalLockedNanos = asBig(state.totalLockedNanos) + n;
  if (!p.joined && (asBig(p.staked) + asBig(p.idle)) >= BigInt(PI_SHE_NANOS)) {
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
    epochMs: epochMs(magic || MAGIC_TESTNET),
  });
}

/** Chain-genesis vortex index. Rate keys and settlement both use this integer. */
function chainEpochIndex(state, nowMs) {
  return derivedCommitIndex(nowMs, state?.genesisMs, state?.magic);
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
  return qualifyingStake(state, portal, epoch) >= BigInt(PI_SHE_NANOS);
}

/** Stake reward is off until the pre-cutoff sum is at least π. Later epochs use epochQualifies. */
function stakeQualified(state, portal) {
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

export function lockTx({
  from, to, nanos, id, lockEpoch = null, unlockAtMs = null, timeLock = false, spendSeed = null,
  ownerPub = null,
} = {}) {
  const n = exactFloorNanos(nanos);
  const out = sealedReserveVout(to, n, KIND_LOCK);
  if (timeLock) {
    const epoch = Number(lockEpoch);
    const unlock = Number(unlockAtMs);
    if (Number.isInteger(epoch) && epoch >= 0) out.lockEpoch = epoch;
    if (unlock > 0) out.unlockAtMs = unlock;
  }
  void spendSeed;
  const tx = {
    id,
    programId: RESERVE_PROGRAM,
    kind: KIND_LOCK,
    from,
    to,
    nanos: n,
    portalId: portalIdFromDest(to),
    payoutPortalId: portalIdFromDest(from),
    vin: [vinDest20(from)],
    vout: [out],
  };
  const pub = String(ownerPub || '').replace(/^0x/i, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(pub)) tx.ownerPub = pub;
  return tx;
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
  to, nanos, nullifier, proof, id, spendSeed = null, fee = null, ownerKey = null, rootIndex = null,
} = {}) {
  const n = exactFloorNanos(nanos);
  const out = sealedReserveVout(to, n, KIND_REWARD_CLAIM);
  delete out.portalId;
  if (out.commit) {
    const base = admitBaseFromAddress(to);
    Object.assign(out, attachAdmitPub(out, {
      admitBase: base || undefined,
      spendSeed: spendSeed || undefined,
    }));
  }
  const tx = {
    id,
    programId: RESERVE_PROGRAM,
    mint: true,
    kind: KIND_REWARD_CLAIM,
    to,
    nanos: n,
    nullifier: String(nullifier || '').toLowerCase(),
    proof: Array.isArray(proof) ? proof : [],
    vin: [],
    vout: [out],
  };
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
  tranches = null, magic = null, chainId = null,
} = {}) {
  if (!tx || !ownerKey) return tx;
  const id = String(portalId || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return tx;
  const bound = state && nowMs != null ? withdrawBinding(state, state.portals?.[id], nowMs) : null;
  const at = epoch != null ? epoch : bound?.epoch;
  const set = trancheSet || bound?.trancheSet || (tranches && at != null ? trancheSetHash(tranches, at) : null);
  const mag = magic || bound?.magic || null;
  const cid = chainId != null ? chainId : (bound ? bound.chainId : null);
  const message = withdrawOwnerMessage({
    nullifier: id,
    nanos,
    dest: dest || tx.to || '',
    magic: mag,
    chainId: cid,
    epoch: at,
    trancheSet: set,
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
  if (fields.kind === KIND_LOCK) {
    parts.push(rewardOwnerPub(tx?.ownerPub));
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
  if (!Number.isFinite(clock) || clock <= 0 || settlementIndex(state, clock) <= 0) {
    return { ok: false, reason: 'epoch_open' };
  }
  if (!p) return { ok: false, reason: 'empty' };
  if (arrivalEpochOpen(state, p, clock)) return { ok: false, reason: 'epoch_open' };
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
  holdEpoch = false,
  requireStakeReward = false,
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
  // Roll before the block's rows when the previous epoch is already
  // enacted, so this epoch's open adopts the queued rate. The enacting
  // block itself does not roll: it still settles the epoch that ended.
  if (state.bonusEnacted && !holdEpoch) syncVaultEpoch(state, nowMs);
  if (state.epochStartMs && !state.bonusEnacted && nowMs >= state.epochStartMs + epochMs(state.magic)) {
    const did = enact({ state, nowMs });
    results.push({ action: 'enact', ...did });
    if (!did.ok) return finishReserveApply(results);
  }
  const credited = applyStakeRewards(state, block, nowMs, { require: requireStakeReward });
  if (!credited.ok) {
    return finishReserveApply([{ ok: false, reason: credited.reason || 'stake_reward', action: 'stake-reward' }]);
  }
  const cb = txs.find((t) => t?.coinbase) || txs[0];
  const reservePaid = openedReserveFeeNanos(cb);
  if (reservePaid > 0) creditFeeBank(state, reservePaid);
  state.deferEpochRoll = true;
  for (const tx of txs) {
    if (!tx || tx.coinbase) continue;
    if (String(tx.programId || '') !== RESERVE_PROGRAM) continue;
    reserveApplyCount += 1;
    if (txKind(tx) === KIND_REWARD_CLAIM) {
      const got = applyRewardClaim(state, tx);
      results.push({ action: KIND_REWARD_CLAIM, ...got });
      if (!got.ok) {
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      continue;
    }
    const act = reserveAction(tx);
    if (!act || act.opened === false) continue;
    if (act.kind === KIND_LOCK) {
      const stamp = lockStampRejected(state, tx, nowMs);
      if (stamp) {
        results.push({ action: KIND_LOCK, ...stamp });
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      const got = deposit({
        state,
        portalId: act.portalId,
        dest: act.dest,
        nanos: act.nanos,
        nowMs,
        payout: act.payout,
        payoutPortalId: act.payoutPortalId,
        ownerPub: tx.ownerPub || tx.spendPub,
      });
      results.push({ action: KIND_LOCK, ...got });
      if (!got.ok) {
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
      bindLockNote(state, act.portalId, tx, nowMs);
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
      });
      results.push({ action: KIND_WITHDRAW, ...got });
      if (!got.ok) {
        state.deferEpochRoll = false;
        return finishReserveApply(results);
      }
    }
  }
  state.deferEpochRoll = false;
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
  if (inPlace) return trialInPlace(state, rows, block, nowMs, { ...oracle, requireStakeReward });
  const trial = cloneVault(state);
  const applied = applyReserveBlock({
    state: trial,
    block: rewardBlock,
    nowMs: Number(nowMs) || 0,
    requireStakeReward,
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
  // Completed deposits can be withdrawn on any later block. Each credit
  // unlocks at the end of its own lock epoch. A later top-up does not
  // re-lock principal whose epoch has already ended.
  if (settlementIndex(state, nowMs) <= 0) {
    return { ok: false, reason: 'epoch_open' };
  }
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
  if (staked + idle <= 0n) return { ok: false, reason: 'empty' };
  if (arrivalEpochOpen(state, p, nowMs)) return { ok: false, reason: 'epoch_open' };
  const split = maturedSplit(state, p, nowMs);
  if (split.legacy <= 0n && split.note > 0n) return { ok: false, reason: 'note_principal' };
  const release = split.legacy;
  if (release <= 0n) return { ok: false, reason: 'epoch_open' };
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
  state.totalLockedNanos = asBig(state.totalLockedNanos) - release;
  if (state.totalLockedNanos < 0n) state.totalLockedNanos = 0n;
  p.redeemedNanos = asBig(p.redeemedNanos) + release;
  const chain = chainEpochIndex(state, nowMs);
  if (Array.isArray(p.tranches) && p.tranches.length) {
    p.tranches = p.tranches.filter((tranche) => {
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
  const stillVoter = remain >= BigInt(PI_SHE_NANOS);
  if (!stillVoter && Number(p.voteEpoch || 0) === Number(state.currentEpoch || 0)) {
    if (p.vote === VOTE_INCREASE && Number(state.votes.increase) > 0) state.votes.increase -= 1;
    if (p.vote === VOTE_DECREASE && Number(state.votes.decrease) > 0) state.votes.decrease -= 1;
    if (p.vote === VOTE_HOLD && Number(state.votes.hold) > 0) state.votes.hold -= 1;
  }
  if (Number(state.votes.increase) < 0) state.votes.increase = 0;
  if (Number(state.votes.decrease) < 0) state.votes.decrease = 0;
  if (Number(state.votes.hold) < 0) state.votes.hold = 0;
  if (remain <= 0n) {
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
  const startLocked = asBig(state.totalLockedNanos);
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
      holdEpoch,
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
    const prefix = txs.slice(from, i);
    if (prefix.length) {
      if (!applySlice(prefix, started)) return fail();
      started = true;
    }
    from = i + 1;
    const act = reserveAction(txs[i]);
    if (!act || act.opened !== true) return fail();
    const portal = act.portalId ? state.portals?.[act.portalId] : null;
    const principal = exactBi(withdrawablePrincipal(state, portal, clock));
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
    if (interest == null || vaultPrincipal == null) return fail();
    if (interest !== 0n || vaultPrincipal !== principal) return fail();
    const mintedHere = got[0].mint && got[0].mint.ok === true ? exactBi(got[0].mint.nanos) : 0n;
    if (mintedHere == null || mintedHere !== 0n) return fail();
    permittedSum += 0n;
    principalOut += principal;
    if (minted > REWARD_U64 || permittedSum > REWARD_U64) return fail();
    counted += 1;
  }
  if (!applySlice(txs.slice(from), started)) return fail();
  if (counted !== rows.length) return fail();
  const endLocked = asBig(state.totalLockedNanos);
  if (startLocked + locksIn !== endLocked + principalOut) return fail();
  if (minted !== permittedSum) return fail();
  return { ok: true, minted, permitted: permittedSum };
}

/**
 * Coinbase carries a root, not a mint. Supply grows only by claim outputs.
 * Unclaimed rows stay out of minted and permitted interest.
 */
export function stakeRewardSupply(vault, block, nowMs) {
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
  let claimed = 0n;
  for (const tx of Array.isArray(block?.txs) ? block.txs : []) {
    if (!tx || tx.coinbase || txKind(tx) !== KIND_REWARD_CLAIM) continue;
    const paid = applyRewardClaim(state, tx);
    if (!paid.ok) return { ok: false, reason: 'supply', minted: 0n, permitted: 0n, claimed: 0n };
    claimed += BigInt(paid.nanos);
  }
  return { ok: true, minted: 0n, permitted: 0n, claimed };
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

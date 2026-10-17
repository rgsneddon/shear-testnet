/**
 * Vault-lock reward proof. A claim proves membership of one π leaf, knowledge
 * of its vault key, and that the hidden payout opens to the public reward
 * floor(π × rate_e × covered / (epoch_blocks × 10000)). rate_e is the total
 * for the whole epoch. A claim covers one period (covered = period_blocks),
 * not the whole epoch. The same floor with covered = epoch_blocks is the
 * full-epoch total. There is no multiplication proof and no qualify bit.
 * N leaves earn N period floors, which is at most one floor of an N×π lock.
 * The leaf is admitPub(vaultKey) || Pedersen(π) + unlock·U. The unlock period
 * is inside that commitment. A claim proves claimed_period < unlock.
 * The proof does not publish the lock commitment. The nullifier is a PRF of
 * the vault key and the period, not a hash of the public spend tag.
 */
import { createHash, randomBytes } from 'node:crypto';
import { RistrettoPoint, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { MAGIC_TESTNET, PI_SHE_NANOS, VAULT_CLAIM_WINDOW_EPOCHS, VAULT_PROOF_VER } from './asert.js';
import { vaultEpochBlocks, vaultPeriodBlocks } from './vault_accrual.js';
import { voteTag } from './leaf_vote.js';

export { VAULT_PROOF_VER };
import { admitPub } from './admit.js';
import {
  fs1NativeLoaded,
  fs1ProveUnlinked,
  fs1TreeAppend,
  fs1TreeNew,
  fs1TreeRoot,
  fs1VerifyUnlinked,
} from './native_admit.js';
import {
  G,
  H,
  asU8,
  commit,
  hashToScalar,
  pointBytes,
  pointFrom,
  proveRange,
  proveValue,
  randomScalar,
  scalarBytes,
  scalarFrom,
  sealHiddenNote,
  verifyRange,
  verifyValue,
} from './note.js';

const Fn = RistrettoPoint.Fn;

export const VAULT_REWARD_DST = 'shear-vault-reward-fs1-v1';
export const VAULT_NULL_KEY_DST = 'shear-vault-null-key-v1';
export const VAULT_NULL_EPOCH_DST = 'shear-vault-null-epoch-v1';
export const VAULT_NULL_PRF = 'shear-vault-null-prf-v1';
export const VAULT_REL_DST = 'shear-vault-reward-rel-v1';
export const VAULT_BAL_DST = 'shear-vault-reward-bal-v1';
export const CLAIM_TXID_DST = 'shear-claim-txid-v1';
export const CLAIM_PORTAL_DST = 'shear-claim-portal-v1';
export const VAULT_RETIRE_MAGIC = 'shear-retire-v1';
/** Retire nullifier domain. Not the claim PRF, so a retire blob is not a claim. */
export const VAULT_RETIRE_NULL = 'shear-vault-retire-null-v1';
export const VAULT_RETIRE_DST = 'shear-vault-retire-dleq-v1';
export const VAULT_UNLOCK_DST = 'shear-vault-unlock-base-v1';
/** Gap proof domain. The claimed period is not published as an unlock integer. */
export const VAULT_GAP_DST = 'shear-vault-unlock-gap-v1';
/** Equality of the hidden gap. The transcript does not include gap·G or gap·U. */
export const VAULT_GAP_EQ_DST = 'shear-vault-gap-eq-v1';
/** Vote-only null base. Not the claim epoch base, so a vote point is not a claim point. */
export const VAULT_VOTE_NULL_DST = 'shear-vote-null-v1';
export const VAULT_VOTE_VER = 0x56;
const VOTE_FS1_MASK = 'shear-vote-fs1-v1';
export const VAULT_VOTE_STMT = 'shear-vote-stmt-v1';
/** Claims of a still-locked leaf are below this public unlock. Withdraw replaces it. */
export const VAULT_UNLOCK_OPEN = (1n << 32n) - 1n;
/** One retire proof covers the withdraw period and the later periods still inside the window. */
export const MAX_RETIRE_ROWS = VAULT_CLAIM_WINDOW_EPOCHS + 1;
/** A constructed proof may be wider. Consensus and the EVM accept only the window. */
const MAX_RETIRE_BUILT = 64;
const RETIRE_ROW = 8 + 32 * 5;
export const VAULT_PI_LEAF = BigInt(PI_SHE_NANOS);
export const VAULT_LOCK_BLIND_DST = 'shear-vault-lock-blind-v1';
export const VAULT_LOCK_OWNER_DST = 'shear-vault-lock-owner-v1';
export const VAULT_CAP_DST = 'shear-epoch-cap-v1';
export const VAULT_LEAF_DST = 'shear-vault-leaf-v1';
const CAP_DENOM = 10000n;
export const VAULT_MAGIC_UTF8 = 'shear-testnet-v12';
/** Scalar multiplies in the relation stay under this, and this stays under the subgroup order. */
export const RELATION_BOUND = 2n ** 110n;
const RECORD_BYTES = 321;
const MAX_NANOS = 9007199254740991n;

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n) >>> 0);
  return b;
}

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function readU32(buf, off) {
  if (off + 4 > buf.length) return null;
  return { n: buf.readUInt32LE(off), off: off + 4 };
}

function readU64(buf, off) {
  if (off + 8 > buf.length) return null;
  return { n: buf.readBigUInt64LE(off), off: off + 8 };
}

function take(buf, off, len) {
  if (off + len > buf.length) return null;
  return { b: Buffer.from(buf.subarray(off, off + len)), off: off + len };
}

function bytes32(v) {
  try {
    const b = Buffer.from(asU8(v));
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/**
 * amount * bps * remain, the denominator, and denom * nanos + rem
 * are the scalars the relation multiplies. Each must be < 2^110 < l.
 */
export function relationProductsBounded(amount, bps, remain, span, nanos, rem) {
  try {
    const a = BigInt(amount);
    const rate = BigInt(bps);
    const left = BigInt(remain);
    const width = BigInt(span);
    const reward = BigInt(nanos);
    const extra = BigInt(rem);
    if (a < 0n || rate < 0n || left < 0n || width < 0n || reward < 0n || extra < 0n) return false;
    const prod = a * rate * left;
    const denom = width * 10000n;
    const gExp = denom * reward + extra;
    return prod < RELATION_BOUND && denom < RELATION_BOUND && gExp < RELATION_BOUND;
  } catch {
    return false;
  }
}

/**
 * floor(π × rate_e × held / (epochBlocks × 10000)).
 * rate_e is the total for the epoch. held == epochBlocks is that total.
 * A shorter held is one interval (a period, or an arrival stub). A non-π
 * amount is not a claim. The caller chooses held; this function does not
 * force held to equal the epoch.
 */
export function vaultRewardNanos(amount, bps, heldBlocks, epochBlocks) {
  let width;
  let held;
  let rate;
  let a;
  try {
    width = BigInt(epochBlocks);
    held = BigInt(heldBlocks);
    rate = BigInt(bps);
    a = BigInt(amount);
  } catch {
    return null;
  }
  if (width <= 0n || held <= 0n || held > width || a !== VAULT_PI_LEAF || rate <= 0n) return null;
  const denom = width * CAP_DENOM;
  const product = a * rate * held;
  if (product < 0n || product >= RELATION_BOUND || denom <= 0n || denom >= RELATION_BOUND) return null;
  const nanos = product / denom;
  const rem = product % denom;
  if (nanos <= 0n || nanos > MAX_NANOS || rem < 0n) return null;
  return { nanos, rem, denom: CAP_DENOM, held, epochBlocks: width };
}

function seedMaterial(seed) {
  if (seed == null || seed === '') return null;
  if (typeof seed === 'bigint') return scalarBytes(seed);
  try {
    const raw = Buffer.from(asU8(seed));
    return raw.length ? raw : null;
  } catch {
    return null;
  }
}

/** Same seed, index, amount, and lock time rebuild the lock blind after a restore. */
export function vaultLockBlind(seed, index, amount, lockMs) {
  const raw = seedMaterial(seed);
  if (!raw) return null;
  return hashToScalar(
    Buffer.from(VAULT_LOCK_BLIND_DST),
    raw,
    u64le(index || 0),
    u64le(amount),
    u64le(lockMs || 0),
  );
}

/** Owner scalar for that same lock. Not the wallet spend key. */
export function vaultLockOwnerScalar(seed, index) {
  const raw = seedMaterial(seed);
  if (!raw) return null;
  return hashToScalar(Buffer.from(VAULT_LOCK_OWNER_DST), raw, u64le(index || 0));
}

/** Vault key for the nullifier. Separate from the spend key and the owner scalar. */
export function vaultNullScalar(seed, index) {
  const raw = seedMaterial(seed);
  if (!raw) return null;
  return hashToScalar(Buffer.from(VAULT_NULL_KEY_DST), raw, u64le(index || 0));
}

/** Subtract unlock·U from a leaf commitment. Zero leaves the point unchanged. */
export function subtractUnlock(commitPoint, unlock) {
  const u = BigInt(unlock || 0);
  if (u === 0n) return commitPoint;
  return commitPoint.subtract(unlockBase().multiply(Fn.create(u)));
}

/** Third base for the unlock epoch. Independent of G and of the note blind H. */
function unlockBase() {
  return RistrettoPoint.hashToCurve(createHash('sha512').update(VAULT_UNLOCK_DST).digest());
}

/**
 * One vault-lock leaf: owner point || commit(π) + unlock·U.
 * The amount is the public constant π. The unlock epoch is inside the commitment.
 * A non-π amount is not a leaf.
 */
export function vaultLockNote(amount, ownerScalar, blind, unlockEpoch = VAULT_UNLOCK_OPEN) {
  let named;
  let unlock;
  try {
    named = BigInt(amount);
    unlock = BigInt(unlockEpoch);
  } catch {
    return null;
  }
  if (named !== VAULT_PI_LEAF || unlock < 0n || unlock > 0xffffffffffffffffn) return null;
  const x = typeof ownerScalar === 'bigint' ? ownerScalar : scalarFrom(ownerScalar);
  const r = typeof blind === 'bigint' ? blind : scalarFrom(blind);
  const pub = pointBytes(admitPub(x));
  let C = commit(named, r);
  if (unlock !== 0n) C = C.add(unlockBase().multiply(Fn.create(unlock)));
  const packed = pointBytes(C);
  return {
    note: Buffer.concat([pub, packed]),
    admitPub: pub,
    commit: packed,
    scalar: x,
    blind: r,
    amount: named,
    unlock,
  };
}

function statementDigest({
  magic, root, epoch, bps, span, reward, covered, gapC,
  commit: outCommit, noteCommit, dest20, amtCt, preimage,
}) {
  if (!gapC || gapC.length !== 32) return null;
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VAULT_REWARD_DST),
    Buffer.from(String(magic || MAGIC_TESTNET)),
    root,
    u64le(epoch),
    u32le(bps),
    u64le(span),
    u64le(reward),
    u64le(covered),
    gapC,
    outCommit,
    noteCommit,
    dest20,
    amtCt,
    preimage,
  ])).digest();
}

/**
 * sha256(domain || commit || noteCommit || dest20 || amtCt || nullifier || epoch || reward).
 * The free-form tx id is assigned after the proof, so the preimage is these bytes.
 */
export function claimTxPreimage({ commit: outCommit, noteCommit, dest20, amtCt, nullifier, epoch, reward }) {
  const nf = bytes32(nullifier);
  if (!outCommit || !noteCommit || !dest20 || !amtCt || !nf) return null;
  if (outCommit.length !== 32 || noteCommit.length !== 32 || dest20.length !== 20 || amtCt.length !== 8) return null;
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(CLAIM_TXID_DST),
    outCommit,
    noteCommit,
    dest20,
    amtCt,
    nf,
    u64le(epoch),
    u64le(reward),
  ])).digest();
}

function claimPortalWord(dest20) {
  return createHash('sha256').update(Buffer.from(CLAIM_PORTAL_DST)).update(dest20).digest();
}

function balanceExtra(preimage, dest20) {
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VAULT_BAL_DST),
    preimage,
    claimPortalWord(dest20),
  ])).digest();
}

/** commit, noteCommit, dest20, and amtCt from a sealed note or from packVaultOutput bytes. */
export function claimOutputBinding(output) {
  if (!output) return null;
  const packed = Buffer.isBuffer(output) || output instanceof Uint8Array;
  if (packed) {
    const parsed = parseVaultOutput(output);
    if (!parsed) return null;
    if (!verifyRange(parsed.commit, parsed.rangeProof)) return null;
    return parsed;
  }
  try {
    const outCommit = Buffer.from(asU8(output.commit));
    const noteCommit = Buffer.from(asU8(output.noteCommit));
    const amtCt = Buffer.from(asU8(output.amtCt));
    const dest20 = Buffer.from(asU8(output.dest20));
    const rangeProof = Buffer.from(asU8(output.rangeProof));
    if (outCommit.length !== 32 || noteCommit.length !== 32 || amtCt.length !== 8 || dest20.length !== 20) return null;
    if (!rangeProof.length || !verifyRange(outCommit, rangeProof)) return null;
    return { commit: outCommit, noteCommit, amtCt, dest20, rangeProof };
  } catch {
    return null;
  }
}

function hpOf(point) {
  return ristretto255_hasher.hashToCurve(pointBytes(point), { DST: 'shear-admit-Hp' });
}

/** Stable FS-1 spend tag. A claim record must not publish this point. */
export function stableSpendTag(scalar) {
  const x = typeof scalar === 'bigint' ? scalar : scalarFrom(scalar);
  return pointBytes(hpOf(admitPub(x)).multiply(x));
}

function nullBase(epoch) {
  return ristretto255_hasher.hashToCurve(u64le(epoch), { DST: VAULT_NULL_EPOCH_DST });
}

/**
 * PRF(vault key, epoch), as a point N = Hp(epoch) * key. The nullifier is
 * the hash of N. The public spend tag is a different base, so hashing the
 * tag does not produce this nullifier and does not predict the next epoch.
 */
export function vaultRewardNullifier(vaultKey, epoch) {
  try {
    const x = typeof vaultKey === 'bigint' ? vaultKey : scalarFrom(vaultKey);
    const N = nullBase(epoch).multiply(x);
    return createHash('sha256').update(VAULT_NULL_PRF).update(pointBytes(N)).digest();
  } catch {
    return null;
  }
}

/** The rejected derivation: hash the public tag times H(epoch). Tests show it is not the nullifier. */
export function tagDerivedNullifier(spendTag, epoch) {
  try {
    const tag = pointFrom(bytes32(spendTag));
    const h = hashToScalar(Buffer.from(VAULT_NULL_EPOCH_DST), u64le(epoch));
    return createHash('sha256').update(VAULT_NULL_PRF).update(pointBytes(tag.multiply(h))).digest();
  } catch {
    return null;
  }
}

function relationPoint(cTilde, reward, remCommit, bps) {
  const rate = BigInt(bps);
  const pay = BigInt(reward) * CAP_DENOM;
  if (rate <= 0n || rate >= RELATION_BOUND || pay < 0n || pay >= RELATION_BOUND) {
    throw new Error('relation_bound');
  }
  // cTilde * bps = G*(reward * 10000) + rem. The member point stays hidden.
  return pointFrom(cTilde).multiply(Fn.create(rate))
    .subtract(G.multiply(Fn.create(pay)))
    .subtract(pointFrom(remCommit));
}

function balancePoint(remCommit, slackCommit) {
  return pointFrom(remCommit).add(pointFrom(slackCommit)).subtract(G.multiply(Fn.create(CAP_DENOM - 1n)));
}

/** The amount relation. The root stays in the FS-1 digest. The reward is public. */
function relationExtra({ cTilde, bps, span, reward, remCommit, slackCommit }) {
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VAULT_REL_DST),
    cTilde,
    u32le(bps),
    u64le(span),
    u64le(reward),
    remCommit,
    slackCommit,
  ])).digest();
}

function dleqChallenge(epoch, b1, b2, A1, A2, P1, P2, magic, txBind) {
  return hashToScalar(
    Buffer.from(VAULT_RETIRE_DST),
    u64le(epoch),
    pointBytes(b1),
    pointBytes(b2),
    A1,
    A2,
    P1,
    P2,
    Buffer.from(String(magic || MAGIC_TESTNET)),
    txBind,
  );
}

function dleqProve(b1, b2, x, epoch, magic, txBind) {
  const k = randomScalar();
  const A1 = pointBytes(b1.multiply(k));
  const A2 = pointBytes(b2.multiply(k));
  const P1 = pointBytes(b1.multiply(x));
  const P2 = pointBytes(b2.multiply(x));
  const e = dleqChallenge(epoch, b1, b2, A1, A2, P1, P2, magic, txBind);
  const s = scalarBytes(Fn.add(k, Fn.mul(e, x)));
  return { A1, A2, P1, P2, s };
}

function dleqVerify(b1, b2, P1, P2, A1, A2, s, epoch, magic, txBind) {
  try {
    const e = dleqChallenge(epoch, pointFrom(b1), pointFrom(b2), A1, A2, P1, P2, magic, txBind);
    const z = scalarFrom(s);
    const left1 = pointFrom(b1).multiply(z);
    const right1 = pointFrom(A1).add(pointFrom(P1).multiply(e));
    const left2 = pointFrom(b2).multiply(z);
    const right2 = pointFrom(A2).add(pointFrom(P2).multiply(e));
    return left1.equals(right1) && left2.equals(right2);
  } catch {
    return false;
  }
}

function claimNullifierOf(P2) {
  return createHash('sha256').update(VAULT_NULL_PRF).update(P2).digest();
}

function retireNullifierOf(P2, epoch) {
  return createHash('sha256').update(VAULT_RETIRE_NULL).update(P2).update(u64le(epoch)).digest();
}

/**
 * Retire challenge. P2 is not an input: the verifier recomputes it, so the
 * proof does not publish the claim null point.
 */
function retireChallenge(epoch, A1, A2, P1, claimNf, retireNf, magic, txBind) {
  return hashToScalar(
    Buffer.from(VAULT_RETIRE_DST),
    u64le(epoch),
    A1,
    A2,
    P1,
    claimNf,
    retireNf,
    Buffer.from(String(magic || MAGIC_TESTNET)),
    txBind,
  );
}

function retireRowProve(epoch, x, P1, magic, txBind) {
  const k = randomScalar();
  const base = nullBase(epoch);
  const A1 = pointBytes(G.multiply(k));
  const A2 = pointBytes(base.multiply(k));
  const P2 = base.multiply(x);
  const P2b = pointBytes(P2);
  const claim = claimNullifierOf(P2b);
  const retire = retireNullifierOf(P2b, epoch);
  const e = retireChallenge(epoch, A1, A2, P1, claim, retire, magic, txBind);
  const s = scalarBytes(Fn.add(k, Fn.mul(e, x)));
  return { epoch, A1, A2, s, claim, retire };
}

function retireRowVerify(epoch, A1, A2, s, claim, retire, P1, magic, txBind) {
  const e = retireChallenge(epoch, A1, A2, P1, claim, retire, magic, txBind);
  if (Fn.eql(e, Fn.ZERO)) return null;
  const z = scalarFrom(s);
  const left1 = G.multiply(z);
  const right1 = pointFrom(A1).add(pointFrom(P1).multiply(e));
  if (!left1.equals(right1)) return null;
  const base = nullBase(epoch);
  const P2 = base.multiply(z).subtract(pointFrom(A2)).multiply(Fn.inv(e));
  const P2b = pointBytes(P2);
  const expectClaim = claimNullifierOf(P2b);
  const expectRetire = retireNullifierOf(P2b, epoch);
  if (!expectClaim.equals(claim) || !expectRetire.equals(retire)) return null;
  return { nullifier: expectClaim, retireNullifier: expectRetire };
}

/**
 * One leaf, one proof. Each period this withdraw burns has its own DLEQ.
 * The row publishes the claim nullifier and the retire nullifier, not the
 * null point those hashes were taken from.
 * Layout: u64 unlock || u32 n || n × (u64 period || A1 || A2 || s || claim || retire) || leaf || txBind.
 */
export function proveLeafRetire({
  scalar, epoch, epochs = null, leaf, txBind = null, magic = MAGIC_TESTNET, unlockEpoch = null,
} = {}) {
  try {
    const x = typeof scalar === 'bigint' ? scalar : scalarFrom(scalar);
    const list = [];
    const raw = Array.isArray(epochs) && epochs.length ? epochs : [epoch];
    for (const item of raw) {
      const at = Math.floor(Number(item));
      if (!Number.isSafeInteger(at) || at < 0 || list.includes(at)) return null;
      list.push(at);
    }
    if (!list.length || list.length > MAX_RETIRE_BUILT) return null;
    const note = Buffer.from(asU8(leaf));
    if (note.length !== 64) return null;
    let bind = Buffer.alloc(32);
    if (txBind != null) {
      bind = bytes32(txBind);
      if (!bind) return null;
    }
    const unlock = unlockEpoch == null ? BigInt(Math.max(...list)) : BigInt(unlockEpoch);
    if (unlock < 0n || unlock > 0xffffffffffffffffn) return null;
    const P1 = note.subarray(0, 32);
    const rows = [];
    for (const at of list) {
      const row = retireRowProve(at, x, P1, magic, bind);
      if (!row) return null;
      rows.push(row);
    }
    const proof = Buffer.concat([
      u64le(unlock),
      u32le(rows.length),
      ...rows.map((row) => Buffer.concat([u64le(row.epoch), row.A1, row.A2, row.s, row.claim, row.retire])),
      note,
      bind,
    ]);
    const primary = rows[0];
    return {
      proof,
      nullifier: primary.claim,
      nullifierHex: primary.claim.toString('hex'),
      retireNullifier: primary.retire,
      epoch: primary.epoch,
      unlock,
      epochs: rows.map((row) => ({
        epoch: row.epoch,
        nullifier: row.claim,
        nullifierHex: row.claim.toString('hex'),
        retireNullifier: row.retire,
      })),
      txBind: bind,
    };
  } catch {
    return null;
  }
}

/** How many DLEQ rows a retire proof carries. Null when the header is not one. */
export function retireDleqCount(proof) {
  try {
    const buf = Buffer.from(asU8(proof));
    if (buf.length < 12) return null;
    const n = buf.readUInt32LE(8);
    if (!Number.isInteger(n) || n < 1) return null;
    return n;
  } catch {
    return null;
  }
}

/**
 * Row count of a retire proof whose length matches the layout.
 * A short or torn buffer is not a declared proof. A count above the
 * claim window is still returned, so consensus can refuse it as unsigned.
 */
export function retireDeclaredRows(proof) {
  try {
    const buf = Buffer.from(asU8(proof));
    const n = retireDleqCount(buf);
    if (n == null) return null;
    const expect = 12 + n * RETIRE_ROW + 64 + 32;
    if (!Number.isSafeInteger(expect) || buf.length !== expect) return null;
    return n;
  } catch {
    return null;
  }
}

/**
 * A retire proof is pure in its bytes and the network name. Queue, the
 * template, and the block each open the same rows. The template's one-second
 * budget cannot re-open three DLEQ rows for every withdraw, so a verdict this
 * process already computed is reused. The nullifier filter stays outside the
 * cache: a different nullifier is a compare, not another opening.
 */
const retireVerifyCache = new Map();
const RETIRE_VERIFY_MAX = 4096;

function rememberRetire(key, opened) {
  if (retireVerifyCache.size >= RETIRE_VERIFY_MAX) {
    retireVerifyCache.delete(retireVerifyCache.keys().next().value);
  }
  retireVerifyCache.set(key, opened);
}

function openLeafRetire(buf, magic) {
  if (buf.length < 8 + 4 + RETIRE_ROW + 64 + 32) return null;
  const unlock = buf.readBigUInt64LE(0);
  const n = buf.readUInt32LE(8);
  if (n < 1 || n > MAX_RETIRE_ROWS) return null;
  let off = 12;
  const epochs = [];
  const leafAt = 12 + n * RETIRE_ROW;
  if (buf.length !== leafAt + 64 + 32) return null;
  const leaf = Buffer.from(buf.subarray(leafAt, leafAt + 64));
  const txBind = Buffer.from(buf.subarray(leafAt + 64));
  const P1 = leaf.subarray(0, 32);
  for (let i = 0; i < n; i += 1) {
    const epoch = buf.readBigUInt64LE(off); off += 8;
    const A1 = Buffer.from(buf.subarray(off, off + 32)); off += 32;
    const A2 = Buffer.from(buf.subarray(off, off + 32)); off += 32;
    const s = Buffer.from(buf.subarray(off, off + 32)); off += 32;
    const claim = Buffer.from(buf.subarray(off, off + 32)); off += 32;
    const retire = Buffer.from(buf.subarray(off, off + 32)); off += 32;
    const opened = retireRowVerify(epoch, A1, A2, s, claim, retire, P1, magic, txBind);
    if (!opened) return null;
    epochs.push({ epoch, nullifier: opened.nullifier, retireNullifier: opened.retireNullifier });
  }
  return { nullifier: epochs[0].nullifier, epoch: epochs[0].epoch, unlock, leaf, epochs, txBind };
}

/**
 * Null when the retire proof does not open `nullifier` for its leaf.
 * A proof wider than the claim window is not a consensus proof.
 */
export function verifyLeafRetire(proof, nullifier = null, magic = MAGIC_TESTNET) {
  try {
    const buf = Buffer.from(asU8(proof));
    const key = createHash('sha256').update(buf).update(Buffer.from(String(magic ?? ''))).digest('hex');
    let opened;
    if (retireVerifyCache.has(key)) opened = retireVerifyCache.get(key);
    else {
      opened = openLeafRetire(buf, magic);
      rememberRetire(key, opened);
    }
    if (!opened) return null;
    const expect = opened.nullifier;
    const nf = nullifier == null ? expect : bytes32(nullifier);
    if (!nf) return null;
    const known = opened.epochs.some((row) => row.nullifier.equals(nf) || row.retireNullifier.equals(nf));
    if (!known) return null;
    return {
      ok: true,
      nullifier: expect,
      epoch: opened.epoch,
      unlock: opened.unlock,
      leaf: opened.leaf,
      epochs: opened.epochs,
      txBind: opened.txBind,
    };
  } catch {
    return null;
  }
}

/** Q = cTilde * remain and C = G*remain + H*blind, without publishing remain. */
function remainSigmaProve(cTilde, remain, blind) {
  const k = randomScalar();
  const kr = randomScalar();
  const A1 = commit(k, kr);
  const A2 = pointFrom(cTilde).multiply(k);
  const C = commit(BigInt(remain), blind);
  const Q = pointFrom(cTilde).multiply(Fn.create(BigInt(remain)));
  const e = hashToScalar(pointBytes(A1), pointBytes(A2), pointBytes(C), pointBytes(Q), cTilde);
  const s = Fn.add(k, Fn.mul(e, Fn.create(BigInt(remain))));
  const sr = Fn.add(kr, Fn.mul(e, blind));
  return {
    A1: pointBytes(A1),
    A2: pointBytes(A2),
    C: pointBytes(C),
    Q: pointBytes(Q),
    s: scalarBytes(s),
    sr: scalarBytes(sr),
  };
}

function remainSigmaVerify(cTilde, A1, A2, C, Q, s, sr) {
  try {
    const e = hashToScalar(A1, A2, C, Q, cTilde);
    const left1 = commit(scalarFrom(s), scalarFrom(sr));
    const right1 = pointFrom(A1).add(pointFrom(C).multiply(e));
    const left2 = pointFrom(cTilde).multiply(scalarFrom(s));
    const right2 = pointFrom(A2).add(pointFrom(Q).multiply(e));
    return left1.equals(right1) && left2.equals(right2);
  } catch {
    return false;
  }
}

function gapEqChallenge(epoch, A1, A2, gapC, openP, magic, digest) {
  const mag = Buffer.from(String(magic || ''));
  const dig = digest && digest.length === 32 ? digest : null;
  if (!mag.length || !dig) return null;
  return hashToScalar(
    Buffer.from(VAULT_GAP_EQ_DST),
    mag,
    dig,
    u64le(epoch),
    A1,
    A2,
    gapC,
    pointBytes(openP),
  );
}

/**
 * gap = unlock − period − 1, hidden in commit(gap, r). A range proof shows
 * the gap is non-negative, so the claimed period is below the unlock.
 * gap·G and gap·U are not returned.
 */
function proveGapCommit(unlock, epoch) {
  let gap;
  try {
    gap = BigInt(unlock) - BigInt(epoch) - 1n;
  } catch {
    return null;
  }
  if (gap < 0n || gap > 0xffffffffn) return null;
  const r = randomScalar();
  const gapC = pointBytes(commit(gap, r));
  const range = proveRange(gap, r);
  if (!range?.length) return null;
  return { gap, r, gapC, range };
}

/**
 * openP = U·gap + H·openS and gapC = G·gap + H·r, with independent blinds.
 * The proof publishes neither gap·G nor gap·U.
 */
function proveGapEquality({ gap, r, openS, openP, epoch, gapC, magic, digest }) {
  const kGap = randomScalar();
  const kR = randomScalar();
  const kS = randomScalar();
  const A1 = G.multiply(kGap).add(H.multiply(kR));
  const A2 = unlockBase().multiply(kGap).add(H.multiply(kS));
  const e = gapEqChallenge(epoch, pointBytes(A1), pointBytes(A2), gapC, openP, magic, digest);
  if (!e) return null;
  const x = Fn.create(gap);
  return {
    A1: pointBytes(A1),
    A2: pointBytes(A2),
    zGap: scalarBytes(Fn.add(kGap, Fn.mul(e, x))),
    zR: scalarBytes(Fn.add(kR, Fn.mul(e, r))),
    zS: scalarBytes(Fn.add(kS, Fn.mul(e, openS))),
  };
}

function verifyGapEquality(epoch, gapC, openP, A1, A2, zGap, zR, zS, magic, digest) {
  const e = gapEqChallenge(epoch, A1, A2, gapC, openP, magic, digest);
  if (!e) return false;
  const zG = scalarFrom(zGap);
  const left1 = G.multiply(zG).add(H.multiply(scalarFrom(zR)));
  const right1 = pointFrom(A1).add(pointFrom(gapC).multiply(e));
  const left2 = unlockBase().multiply(zG).add(H.multiply(scalarFrom(zS)));
  const right2 = pointFrom(A2).add(openP.multiply(e));
  return left1.equals(right1) && left2.equals(right2);
}

function verifyUnlockGap(epoch, tail, openP, openR, openZ, magic, digest) {
  try {
    if (!tail?.range?.length || !tail.gapC || tail.gapC.length !== 32) return false;
    if (!openR || !openZ || !tail.A1 || !tail.A2 || !tail.zGap || !tail.zR || !tail.zS) return false;
    if (!verifyRange(tail.gapC, tail.range)) return false;
    if (!openR.equals(tail.A1) || !openZ.equals(tail.zGap)) return false;
    return verifyGapEquality(epoch, tail.gapC, openP, tail.A1, tail.A2, tail.zGap, tail.zR, tail.zS, magic, digest);
  } catch {
    return false;
  }
}

function packGapTail(gap) {
  return Buffer.concat([
    u32le(gap.range.length),
    gap.range,
    gap.gapC,
    gap.A1,
    gap.A2,
    gap.zGap,
    gap.zR,
    gap.zS,
  ]);
}

function parseGapTail(buf, off) {
  if (off === buf.length) return { tail: null };
  const rangeLen = readU32(buf, off);
  if (!rangeLen || rangeLen.n < 1) return null;
  off = rangeLen.off;
  const range = take(buf, off, rangeLen.n);
  if (!range) return null;
  off = range.off;
  const gapC = take(buf, off, 32);
  const A1 = gapC && take(buf, gapC.off, 32);
  const A2 = A1 && take(buf, A1.off, 32);
  const zGap = A2 && take(buf, A2.off, 32);
  const zR = zGap && take(buf, zGap.off, 32);
  const zS = zR && take(buf, zR.off, 32);
  if (!zS || zS.off !== buf.length) return null;
  return {
    tail: {
      range: range.b,
      gapC: gapC.b,
      A1: A1.b,
      A2: A2.b,
      zGap: zGap.b,
      zR: zR.b,
      zS: zS.b,
    },
  };
}

function schnorrProve(P, s, extra) {
  const k = randomScalar();
  const R = H.multiply(k);
  const e = hashToScalar(pointBytes(P), pointBytes(R), extra);
  const z = Fn.add(k, Fn.mul(e, s));
  return { R: pointBytes(R), z: scalarBytes(z) };
}

function schnorrVerify(P, R, z, extra) {
  try {
    const e = hashToScalar(pointBytes(P), R, extra);
    return H.multiply(scalarFrom(z)).equals(pointFrom(R).add(P.multiply(e)));
  } catch {
    return false;
  }
}

function asBlind(blind) {
  if (typeof blind === 'bigint') return blind;
  return scalarFrom(blind);
}

/** Cap blind for one lock at one rate. The node cannot recompute it. */
export function epochCapBlind(lockBlind, bps) {
  return hashToScalar(
    Buffer.from('shear-epoch-cap-blind-v1'),
    scalarBytes(asBlind(lockBlind)),
    u32le(Math.floor(Number(bps) || 0)),
  );
}

function capExtra(lockP, rate, capP, remP, slackP) {
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VAULT_CAP_DST),
    pointBytes(lockP),
    u32le(Number(rate)),
    pointBytes(capP),
    pointBytes(remP),
    pointBytes(slackP),
  ])).digest();
}

/**
 * Full-epoch reward cap for one lock, proved by that lock's author.
 * reward = floor(v * bps / 10000), and the remainder balances on H.
 * A zero reward is a valid cap. The amount is not an output.
 * `fresh` draws new cap blinds. A claim uses those so the cap point
 * does not repeat. Lock registration keeps the deterministic blinds.
 */
export function proveLockCap(amount, lockBlind, bps, opts = {}) {
  let v;
  let rate;
  try {
    v = BigInt(amount);
    rate = BigInt(Math.floor(Number(bps)));
  } catch {
    return null;
  }
  if (v <= 0n || rate <= 0n || rate >= RELATION_BOUND) return null;
  const product = v * rate;
  if (product >= RELATION_BOUND) return null;
  const reward = product / CAP_DENOM;
  const rem = product - reward * CAP_DENOM;
  const slack = CAP_DENOM - 1n - rem;
  if (slack < 0n || reward > MAX_NANOS) return null;
  const rLock = asBlind(lockBlind);
  const fresh = opts?.fresh === true;
  const rCap = fresh ? randomScalar() : epochCapBlind(rLock, rate);
  const rRem = fresh
    ? randomScalar()
    : hashToScalar(Buffer.from('shear-epoch-cap-rem-v1'), scalarBytes(rLock), u32le(Number(rate)));
  const rSlack = fresh
    ? randomScalar()
    : hashToScalar(Buffer.from('shear-epoch-cap-slack-v1'), scalarBytes(rLock), u32le(Number(rate)));
  const lockP = commit(v, rLock);
  const capP = commit(reward, rCap);
  const remP = commit(rem, rRem);
  const slackP = commit(slack, rSlack);
  const P = lockP.multiply(Fn.create(rate)).subtract(capP.multiply(Fn.create(CAP_DENOM))).subtract(remP);
  const s = Fn.sub(Fn.sub(Fn.mul(Fn.create(rate), rLock), Fn.mul(Fn.create(CAP_DENOM), rCap)), rRem);
  if (!P.equals(H.multiply(s))) return null;
  const balP = remP.add(slackP).subtract(G.multiply(Fn.create(CAP_DENOM - 1n)));
  const balS = Fn.add(rRem, rSlack);
  if (!balP.equals(H.multiply(balS))) return null;
  const rel = schnorrProve(P, s, capExtra(lockP, rate, capP, remP, slackP));
  const bal = schnorrProve(balP, balS, Buffer.from(VAULT_CAP_DST));
  const range = proveRange(reward, rCap);
  const remRange = proveRange(rem, rRem);
  const slackRange = proveRange(slack, rSlack);
  if (!range?.length || !remRange?.length || !slackRange?.length) return null;
  return {
    lockCommit: pointBytes(lockP),
    commit: pointBytes(capP),
    range,
    remCommit: pointBytes(remP),
    remRange,
    slackCommit: pointBytes(slackP),
    slackRange,
    relR: rel.R,
    relZ: rel.z,
    balR: bal.R,
    balZ: bal.z,
    reward,
    blind: rCap,
    rate,
    rLock,
    rRem,
  };
}

/** True when `proof` is this lock's cap at the public rate. `lockCommit` is the member point. */
export function verifyLockCap(lockCommit, bps, proof) {
  try {
    const rate = BigInt(Math.floor(Number(bps)));
    if (rate <= 0n || rate >= RELATION_BOUND) return false;
    const lockP = pointFrom(lockCommit);
    const capP = pointFrom(proof.commit);
    const remP = pointFrom(proof.remCommit);
    const slackP = pointFrom(proof.slackCommit);
    if (!verifyRange(pointBytes(capP), proof.range)) return false;
    if (!verifyRange(pointBytes(remP), proof.remRange)) return false;
    if (!verifyRange(pointBytes(slackP), proof.slackRange)) return false;
    const P = lockP.multiply(Fn.create(rate)).subtract(capP.multiply(Fn.create(CAP_DENOM))).subtract(remP);
    if (!schnorrVerify(P, proof.relR, proof.relZ, capExtra(lockP, rate, capP, remP, slackP))) return false;
    const balP = remP.add(slackP).subtract(G.multiply(Fn.create(CAP_DENOM - 1n)));
    return schnorrVerify(balP, proof.balR, proof.balZ, Buffer.from(VAULT_CAP_DST));
  } catch {
    return false;
  }
}

/** Re-sign the cap relation against the re-randomised member leaf. The value is unchanged. */
function rebindLockCap(cap, lockPoint, t) {
  const rate = cap.rate;
  const lockP = pointFrom(lockPoint);
  const capP = pointFrom(cap.commit);
  const remP = pointFrom(cap.remCommit);
  const slackP = pointFrom(cap.slackCommit);
  const P = lockP.multiply(Fn.create(rate)).subtract(capP.multiply(Fn.create(CAP_DENOM))).subtract(remP);
  const s = Fn.sub(
    Fn.sub(Fn.mul(Fn.create(rate), Fn.add(cap.rLock, t)), Fn.mul(Fn.create(CAP_DENOM), cap.blind)),
    cap.rRem,
  );
  if (!P.equals(H.multiply(s))) return null;
  return schnorrProve(P, s, capExtra(lockP, rate, capP, remP, slackP));
}

function leafExtra(remainCommit, capCommit) {
  return Buffer.concat([Buffer.from(VAULT_LEAF_DST), remainCommit, capCommit]);
}

/** Range proof that the cap commitment is at least the reward commitment. */
export function proveUnderCap(capBlind, capValue, rewardBlind, rewardValue) {
  const diff = BigInt(capValue) - BigInt(rewardValue);
  if (diff < 0n || diff > MAX_NANOS) return null;
  const rDiff = Fn.sub(asBlind(capBlind), asBlind(rewardBlind));
  const range = proveRange(diff, rDiff);
  return range?.length ? range : null;
}

export function verifyUnderCap(capCommit, rewardCommit, range) {
  try {
    const D = pointFrom(capCommit).subtract(pointFrom(rewardCommit));
    return verifyRange(pointBytes(D), range);
  } catch {
    return false;
  }
}

/**
 * Version, FS-1, record, then bps, epoch-block span, period, reward,
 * covered blocks, and the seven 32-byte words. The unlock integer is not
 * a field. A gap proof after the header shows claimed_period < unlock.
 */
export function packVaultRewardProof(p) {
  return Buffer.concat([
    Buffer.from([VAULT_PROOF_VER]),
    u32le(p.fs1.length),
    p.fs1,
    p.record,
    u32le(p.bps),
    u64le(p.span),
    u64le(p.epoch),
    u64le(p.reward),
    u64le(p.covered),
    p.nullBase,
    p.nullP,
    p.nullA1,
    p.openR,
    p.openZ,
    p.noteR,
    p.noteZ,
  ]);
}

function packProof(p) {
  return packVaultRewardProof(p);
}

function parseProof(blob) {
  let buf;
  try { buf = Buffer.from(asU8(blob)); } catch { return null; }
  if (buf.length < 2 || buf[0] !== VAULT_PROOF_VER) return null;
  let off = 1;
  const fs1Len = readU32(buf, off);
  if (!fs1Len) return null;
  off = fs1Len.off;
  const fs1 = take(buf, off, fs1Len.n);
  if (!fs1 || fs1.b.length < 3 || fs1.b[0] !== 0xf1) return null;
  off = fs1.off;
  const record = take(buf, off, RECORD_BYTES);
  if (!record || record.b[0] !== 0xf1) return null;
  off = record.off;
  const bps = readU32(buf, off);
  if (!bps) return null;
  off = bps.off;
  const span = readU64(buf, off);
  if (!span) return null;
  off = span.off;
  const epoch = readU64(buf, off);
  if (!epoch) return null;
  off = epoch.off;
  const reward = readU64(buf, off);
  if (!reward) return null;
  off = reward.off;
  const covered = readU64(buf, off);
  if (!covered) return null;
  off = covered.off;
  const nullBaseB = take(buf, off, 32);
  if (!nullBaseB) return null;
  off = nullBaseB.off;
  const nullP = take(buf, off, 32);
  if (!nullP) return null;
  off = nullP.off;
  const nullA1 = take(buf, off, 32);
  if (!nullA1) return null;
  off = nullA1.off;
  const openR = take(buf, off, 32);
  if (!openR) return null;
  off = openR.off;
  const openZ = take(buf, off, 32);
  if (!openZ) return null;
  off = openZ.off;
  const noteR = take(buf, off, 32);
  if (!noteR) return null;
  off = noteR.off;
  const noteZ = take(buf, off, 32);
  if (!noteZ) return null;
  off = noteZ.off;
  const gap = parseGapTail(buf, off);
  if (!gap) return null;
  return {
    fs1: fs1.b,
    record: record.b,
    bps: bps.n,
    span: span.n,
    epoch: epoch.n,
    earnEpoch: epoch.n,
    reward: reward.n,
    covered: covered.n,
    nullBase: nullBaseB.b,
    nullP: nullP.b,
    nullA1: nullA1.b,
    openR: openR.b,
    openZ: openZ.b,
    noteR: noteR.b,
    noteZ: noteZ.b,
    gap: gap.tail,
  };
}

/** The FS-1 null point inside a proof. A vote tag is the PRF of this point. */
export function vaultNullPoint(blob) {
  const parsed = parseProof(blob);
  return parsed ? parsed.nullP : null;
}

/** Public reward integer inside a proof. Null when the blob is not this version. */
export function vaultPublicReward(blob) {
  const parsed = parseProof(blob);
  return parsed ? parsed.reward : null;
}

/** Older callers named the hidden reward commitment. The reward is now the integer. */
export function vaultRewardCommit(blob) {
  return null;
}

/** Every accepted claim is a full-span member of the epoch's lock set. */
export function vaultProofFull(blob) {
  const parsed = parseProof(blob);
  return parsed ? true : null;
}

/**
 * Linking fields a claim must not publish. The re-randomised member point
 * is inside the FS-1 record; the original lock, a cap, and a remainder
 * index are not in the blob.
 */
export function vaultProofCap(blob) {
  const parsed = parseProof(blob);
  if (!parsed || parsed.record.length < 65) return null;
  return {
    memberCommit: Buffer.from(parsed.record.subarray(33, 65)),
    reward: parsed.reward,
  };
}

/**
 * Prove lock `which` inside `locks`. Each lock is { amount, scalar?, blind? }.
 * Missing secrets are drawn here and returned so a second leaf can reuse the tree.
 * The tree handle is not the chain admit tree. The published reward is
 * floor(amount * bps / 10000) for the public span. The leaf is not named.
 */
export function proveVaultReward({
  locks,
  which = 0,
  rootEpoch,
  earnEpoch,
  bps,
  remainMs,
  span,
  dest20,
  magic = MAGIC_TESTNET,
  vote = null,
} = {}) {
  if (vote) return null;
  if (!fs1NativeLoaded()) return null;
  if (Math.floor(Number(rootEpoch)) !== Math.floor(Number(earnEpoch))) return null;
  if (!Array.isArray(locks) || !locks.length || which < 0 || which >= locks.length) return null;
  const rows = [];
  for (const lock of locks) {
    const amount = BigInt(lock?.amount ?? 0);
    if (amount <= 0n) return null;
    const index = Math.floor(Number(lock?.index) || 0);
    const lockMs = Math.floor(Number(lock?.lockMs) || 0);
    let scalar = lock?.scalar == null
      ? null
      : (typeof lock.scalar === 'bigint' ? lock.scalar : scalarFrom(lock.scalar));
    if (scalar == null && lock?.seed != null) scalar = vaultNullScalar(lock.seed, index);
    if (scalar == null) scalar = randomScalar();
    let blind = lock?.blind == null
      ? null
      : (typeof lock.blind === 'bigint' ? lock.blind : scalarFrom(lock.blind));
    if (blind == null && lock?.seed != null) blind = vaultLockBlind(lock.seed, index, amount, lockMs);
    if (blind == null) blind = randomScalar();
    const unlock = lock?.unlockEpoch == null ? VAULT_UNLOCK_OPEN : lock.unlockEpoch;
    const row = vaultLockNote(amount, scalar, blind, unlock);
    if (!row) return null;
    rows.push(row);
  }
  const handle = fs1TreeNew();
  if (!handle || !fs1TreeAppend(handle, Buffer.concat(rows.map((row) => row.note)))) return null;
  const root = fs1TreeRoot(handle);
  if (!root) return null;
  const blocks = BigInt(vaultEpochBlocks(magic));
  const period = BigInt(vaultPeriodBlocks(magic));
  // Callers that pass the epoch length twice are asking for one period claim.
  // An explicit hold that is not that length is one interval, in blocks.
  let covered = period;
  if (remainMs != null && span != null && BigInt(remainMs) !== BigInt(span)) {
    const left = BigInt(remainMs);
    if (left <= 0n || left > blocks) return null;
    covered = left;
  }
  const reward = vaultRewardNanos(rows[which].amount, bps, covered, blocks);
  if (!reward) return null;
  let dest = null;
  try { dest = Buffer.from(asU8(dest20)); } catch { dest = null; }
  if (!dest || dest.length !== 20) dest = randomBytes(20);
  const epoch = Math.floor(Number(earnEpoch));
  const unlock = rows[which].unlock;
  if (BigInt(epoch) >= unlock) return null;
  const gapCommit = proveGapCommit(unlock, epoch);
  if (!gapCommit) return null;
  const nullifier = vaultRewardNullifier(rows[which].scalar, epoch);
  if (!nullifier) return null;
  let note = null;
  try {
    note = sealHiddenNote(reward.nanos, {
      dest20: dest,
      kind: 'reward-claim',
      admitBase: admitPub(randomScalar()),
    });
  } catch {
    return null;
  }
  const bound = claimOutputBinding(note);
  if (!bound) return null;
  const preimage = claimTxPreimage({
    commit: bound.commit,
    noteCommit: bound.noteCommit,
    dest20: bound.dest20,
    amtCt: bound.amtCt,
    nullifier,
    epoch,
    reward: reward.nanos,
  });
  if (!preimage) return null;
  const digest = statementDigest({
    magic,
    root,
    epoch,
    bps,
    span: blocks,
    reward: reward.nanos,
    covered,
    gapC: gapCommit.gapC,
    commit: bound.commit,
    noteCommit: bound.noteCommit,
    dest20: bound.dest20,
    amtCt: bound.amtCt,
    preimage,
  });
  if (!digest) return null;
  const epochBase = pointBytes(nullBase(epoch));
  const proved = fs1ProveUnlinked(handle, {
    indices: [which],
    xs: [scalarBytes(rows[which].scalar)],
    digest,
    anchor: Number(rootEpoch),
    nullBases: epochBase,
  });
  if (!proved || proved.records.length < RECORD_BYTES || proved.link.length < 96) return null;
  const record = Buffer.from(proved.records.subarray(0, RECORD_BYTES));
  const linkAnn = Buffer.from(proved.link.subarray(0, 32));
  const linkSr = Buffer.from(proved.link.subarray(32, 64));
  const linkN = Buffer.from(proved.link.subarray(64, 96));
  const stableTag = pointBytes(hpOf(admitPub(rows[which].scalar)).multiply(rows[which].scalar));
  if (stableTag.equals(record.subarray(1, 33))) return null;
  const t = scalarFrom(proved.t.subarray(0, 32));
  const cTilde = record.subarray(33, 65);
  const openS = Fn.add(rows[which].blind, t);
  const openP = pointFrom(cTilde)
    .subtract(G.multiply(Fn.create(VAULT_PI_LEAF)))
    .subtract(unlockBase().multiply(Fn.create(BigInt(epoch) + 1n)));
  const hidden = unlockBase().multiply(Fn.create(gapCommit.gap)).add(H.multiply(openS));
  if (!openP.equals(hidden)) return null;
  const gapEq = proveGapEquality({ ...gapCommit, openS, openP, epoch, magic, digest });
  if (!gapEq) return null;
  const gapProof = { ...gapCommit, ...gapEq };
  const noteS = scalarFrom(note.r);
  const noteP = pointFrom(bound.commit).subtract(G.multiply(Fn.create(reward.nanos)));
  if (!noteP.equals(H.multiply(noteS))) return null;
  const noteOpen = schnorrProve(noteP, noteS, balanceExtra(preimage, bound.dest20));
  const linked = createHash('sha256').update(VAULT_NULL_PRF).update(linkN).digest();
  if (!linked.equals(nullifier)) return null;
  const lockCommit = rows[which].commit;
  const blob = packProof({
    fs1: Buffer.from(proved.fs1),
    record,
    bps,
    span: blocks,
    epoch,
    reward: reward.nanos,
    covered,
    nullBase: linkAnn,
    nullP: linkN,
    nullA1: linkSr,
    openR: gapEq.A1,
    openZ: gapEq.zGap,
    noteR: noteOpen.R,
    noteZ: noteOpen.z,
  });
  const packed = Buffer.concat([blob, packGapTail(gapProof)]);
  if (packed.includes(lockCommit)) return null;
  return {
    ok: true,
    blob: packed,
    root,
    rootHex: root.toString('hex'),
    nullifier: nullifier.toString('hex'),
    nanos: reward.nanos <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(reward.nanos) : reward.nanos,
    rem: reward.rem,
    full: covered === period,
    span: blocks,
    covered,
    reward,
    rootEpoch: epoch,
    earnEpoch: epoch,
    note,
    preimage,
    unlock,
    locks: rows.map((row) => ({
      amount: row.amount,
      scalar: row.scalar,
      blind: row.blind,
      commit: row.commit,
      unlock: row.unlock,
    })),
  };
}

function fail(code, reason) {
  return { ok: false, code, reason, reward: null, full: null };
}

/**
 * code 1 accepts. code 2 is a bad reward amount. code 0 is not the owner's proof.
 * The reward integer is public and must be floor(principal * rate) for a hidden member.
 */
export function verifyVaultReward({
  blob, root, rootEpoch, nullifier, output = null, terms = null, magic = MAGIC_TESTNET,
  vote = null,
} = {}) {
  if (vote) return fail(0, 'unsigned');
  const bound = claimOutputBinding(output);
  if (!bound) return fail(0, 'unsigned');
  const parsed = parseProof(blob);
  if (!parsed) return fail(0, 'unsigned');
  const rootBuf = bytes32(root);
  const nf = bytes32(nullifier);
  if (!rootBuf || !nf) return fail(0, 'unsigned');
  if (!terms) return fail(2, 'stake_reward');
  let expectBps;
  let expectSpan;
  let expectEpoch;
  try {
    expectBps = Math.floor(Number(terms.bps));
    expectSpan = BigInt(terms.span);
    expectEpoch = BigInt(terms.earnEpoch);
  } catch {
    return fail(2, 'stake_reward');
  }
  const namedEpoch = Math.floor(Number(rootEpoch));
  if (!Number.isInteger(expectBps) || parsed.bps !== expectBps) return fail(2, 'stake_reward');
  if (parsed.span !== expectSpan || parsed.epoch !== expectEpoch) return fail(2, 'stake_reward');
  if (expectEpoch !== BigInt(namedEpoch)) return fail(2, 'stake_reward');
  if (parsed.span <= 0n || parsed.bps <= 0 || parsed.bps > 1_000_000) return fail(2, 'stake_reward');
  if (BigInt(parsed.bps) * parsed.span >= RELATION_BOUND) return fail(2, 'stake_reward');
  if (parsed.reward <= 0n || parsed.reward > MAX_NANOS) return fail(2, 'stake_reward');
  if (!parsed.gap) return fail(2, 'stake_reward');
  const expectCovered = terms.covered != null ? BigInt(terms.covered) : (expectSpan / 16n);
  if (expectCovered <= 0n || expectCovered > expectSpan || parsed.covered !== expectCovered) {
    return fail(2, 'stake_reward');
  }
  const constant = vaultRewardNanos(VAULT_PI_LEAF, parsed.bps, parsed.covered, parsed.span);
  if (!constant || constant.nanos !== parsed.reward) return fail(2, 'stake_reward');
  if (terms.reward != null && BigInt(terms.reward) !== parsed.reward) return fail(2, 'stake_reward');
  const cTilde = parsed.record.subarray(33, 65);
  let digest;
  let openP;
  let noteP;
  let preimage;
  try {
    preimage = claimTxPreimage({
      commit: bound.commit,
      noteCommit: bound.noteCommit,
      dest20: bound.dest20,
      amtCt: bound.amtCt,
      nullifier: nf,
      epoch: parsed.epoch,
      reward: parsed.reward,
    });
    if (!preimage) return fail(0, 'unsigned');
    digest = statementDigest({
      magic,
      root: rootBuf,
      epoch: parsed.epoch,
      bps: parsed.bps,
      span: parsed.span,
      reward: parsed.reward,
      covered: parsed.covered,
      gapC: parsed.gap.gapC,
      commit: bound.commit,
      noteCommit: bound.noteCommit,
      dest20: bound.dest20,
      amtCt: bound.amtCt,
      preimage,
    });
    if (!digest) return fail(0, 'unsigned');
    openP = pointFrom(cTilde)
      .subtract(G.multiply(Fn.create(VAULT_PI_LEAF)))
      .subtract(unlockBase().multiply(Fn.create(parsed.epoch + 1n)));
    noteP = pointFrom(bound.commit).subtract(G.multiply(Fn.create(parsed.reward)));
  } catch {
    return fail(2, 'stake_reward');
  }
  if (!verifyUnlockGap(parsed.epoch, parsed.gap, openP, parsed.openR, parsed.openZ, magic, digest)) return fail(2, 'stake_reward');
  if (!schnorrVerify(noteP, parsed.noteR, parsed.noteZ, balanceExtra(preimage, bound.dest20))) return fail(2, 'stake_reward');
  const anchor = Number(rootEpoch);
  if (!Number.isSafeInteger(anchor) || anchor < 0) return fail(0, 'unsigned');
  const epochBase = pointBytes(nullBase(parsed.epoch));
  const link = Buffer.concat([parsed.nullBase, parsed.nullA1, parsed.nullP]);
  if (!fs1VerifyUnlinked({
    fs1: parsed.fs1,
    records: parsed.record,
    link,
    root: rootBuf,
    digest,
    anchor,
    nullBases: epochBase,
  })) {
    return fail(0, 'unsigned');
  }
  const expect = createHash('sha256').update(VAULT_NULL_PRF).update(parsed.nullP).digest();
  if (!expect.equals(nf)) return fail(0, 'unsigned');
  const tag = parsed.record.subarray(1, 33);
  const derived = tagDerivedNullifier(tag, parsed.epoch);
  if (derived && derived.equals(nf)) return fail(0, 'unsigned');
  return { ok: true, code: 1, reason: null, reward: parsed.reward, full: true };
}

function voteNullBase(epoch, proposal) {
  const pid = bytes32(proposal);
  if (!pid) return null;
  return ristretto255_hasher.hashToCurve(Buffer.concat([u64le(epoch), pid]), { DST: VAULT_VOTE_NULL_DST });
}

function voteStatement(root, epoch, proposal, choice, seq, magic, dest20) {
  const pid = bytes32(proposal);
  const picked = Math.floor(Number(choice));
  const n = Math.floor(Number(seq));
  if (!pid || !root || root.length !== 32 || !dest20 || dest20.length !== 20) return null;
  if (picked !== -1 && picked !== 0 && picked !== 1) return null;
  if (n < 1 || n > 8) return null;
  const cb = picked < 0 ? 0xff : picked;
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VAULT_VOTE_STMT),
    root,
    u64le(epoch),
    pid,
    Buffer.from([cb]),
    u32le(n),
    Buffer.from(String(magic || MAGIC_TESTNET)),
    dest20,
  ])).digest();
}

/**
 * The one-leaf FS-1 header is the same bytes on a claim and a vote.
 * Masking the stored proof keeps those bytes off the vote. The verifier
 * undoes the mask. The key is this vote's null point, which the claim does not carry.
 */
function maskVoteFs1(fs1, linkN) {
  const out = Buffer.from(fs1);
  const point = Buffer.from(linkN);
  let block = Buffer.alloc(0);
  let used = 0;
  let n = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (used >= block.length) {
      block = createHash('sha256').update(VOTE_FS1_MASK).update(point).update(u32le(n)).digest();
      n += 1;
      used = 0;
    }
    out[i] ^= block[used];
    used += 1;
  }
  return out;
}

/**
 * Vote-only proof. The null point is Hp_vote(epoch, proposal)·k, the leaf
 * secret, not the claim null point. The blob carries no claim nullifier.
 * Layout: 0x56 || u64 epoch || N || linkAnn || linkSr || u32 fs1Len || fs1 || record || dest20.
 */
export function proveLeafVote({
  locks, which = 0, epoch, choice, seq, proposalId: pid, magic = MAGIC_TESTNET, dest20 = null,
} = {}) {
  if (!fs1NativeLoaded()) return null;
  const at = Math.floor(Number(epoch));
  if (!Number.isInteger(at) || at < 0) return null;
  const proposal = bytes32(pid);
  if (!proposal) return null;
  const basePoint = voteNullBase(at, proposal);
  if (!basePoint) return null;
  if (!Array.isArray(locks) || !locks.length || which < 0 || which >= locks.length) return null;
  const rows = [];
  for (const lock of locks) {
    const amount = BigInt(lock?.amount ?? 0);
    if (amount <= 0n) return null;
    let scalar = lock?.scalar == null
      ? null
      : (typeof lock.scalar === 'bigint' ? lock.scalar : scalarFrom(lock.scalar));
    if (scalar == null) scalar = randomScalar();
    let blind = lock?.blind == null
      ? null
      : (typeof lock.blind === 'bigint' ? lock.blind : scalarFrom(lock.blind));
    if (blind == null) blind = randomScalar();
    const unlock = lock?.unlockEpoch == null ? VAULT_UNLOCK_OPEN : lock.unlockEpoch;
    const row = vaultLockNote(amount, scalar, blind, unlock);
    if (!row) return null;
    rows.push(row);
  }
  const handle = fs1TreeNew();
  if (!handle || !fs1TreeAppend(handle, Buffer.concat(rows.map((row) => row.note)))) return null;
  const root = fs1TreeRoot(handle);
  if (!root) return null;
  let dest = null;
  try { dest = Buffer.from(asU8(dest20)); } catch { dest = null; }
  if (!dest || dest.length !== 20) dest = randomBytes(20);
  const digest = voteStatement(root, at, proposal, choice, seq, magic, dest);
  if (!digest) return null;
  const epochBase = pointBytes(basePoint);
  const proved = fs1ProveUnlinked(handle, {
    indices: [which],
    xs: [scalarBytes(rows[which].scalar)],
    digest,
    anchor: at,
    nullBases: epochBase,
  });
  if (!proved || proved.records.length < RECORD_BYTES || proved.link.length < 96) return null;
  const record = Buffer.from(proved.records.subarray(0, RECORD_BYTES));
  const linkAnn = Buffer.from(proved.link.subarray(0, 32));
  const linkSr = Buffer.from(proved.link.subarray(32, 64));
  const linkN = Buffer.from(proved.link.subarray(64, 96));
  const expectN = pointBytes(basePoint.multiply(rows[which].scalar));
  if (!expectN.equals(linkN)) return null;
  const stableTag = pointBytes(hpOf(admitPub(rows[which].scalar)).multiply(rows[which].scalar));
  if (stableTag.equals(record.subarray(1, 33))) return null;
  let note = null;
  try {
    note = sealHiddenNote(1n, { dest20: dest, kind: 'leaf-vote', admitBase: admitPub(randomScalar()) });
  } catch {
    return null;
  }
  const fs1 = maskVoteFs1(proved.fs1, linkN);
  const blob = Buffer.concat([
    Buffer.from([VAULT_VOTE_VER]),
    u64le(at),
    linkN,
    linkAnn,
    linkSr,
    u32le(fs1.length),
    fs1,
    record,
    dest,
  ]);
  const leaf = rows[which].note;
  if (blob.includes(leaf) || blob.includes(rows[which].commit)) return null;
  const tag = voteTag(linkN, at, proposal);
  if (!tag) return null;
  return {
    ok: true,
    blob,
    root,
    rootHex: root.toString('hex'),
    voteTag: tag,
    voteSeq: Math.floor(Number(seq)),
    proposalId: proposal,
    choice: Math.floor(Number(choice)),
    epoch: at,
    note,
    dest20: dest,
    locks: rows.map((row) => ({ amount: row.amount, scalar: row.scalar, blind: row.blind, commit: row.commit, unlock: row.unlock })),
  };
}

export function verifyLeafVote({
  blob, root, epoch, choice, seq, proposalId: pid, magic = MAGIC_TESTNET,
} = {}) {
  try {
    const buf = Buffer.from(asU8(blob));
    if (buf.length < 1 + 8 + 96 + 4 + 3 + RECORD_BYTES + 20 || buf[0] !== VAULT_VOTE_VER) return { ok: false, reason: 'unsigned' };
    const at = buf.readBigUInt64LE(1);
    if (at !== BigInt(Math.floor(Number(epoch)))) return { ok: false, reason: 'stake_reward' };
    const linkN = buf.subarray(9, 41);
    const linkAnn = buf.subarray(41, 73);
    const linkSr = buf.subarray(73, 105);
    const fs1Len = buf.readUInt32LE(105);
    const fs1At = 109;
    if (fs1Len < 3 || fs1At + fs1Len + RECORD_BYTES + 20 !== buf.length) return { ok: false, reason: 'unsigned' };
    const fs1 = maskVoteFs1(buf.subarray(fs1At, fs1At + fs1Len), linkN);
    if (fs1[0] !== 0xf1) return { ok: false, reason: 'unsigned' };
    const record = buf.subarray(fs1At + fs1Len, fs1At + fs1Len + RECORD_BYTES);
    if (record[0] !== 0xf1) return { ok: false, reason: 'unsigned' };
    const dest = buf.subarray(buf.length - 20);
    const rootBuf = bytes32(root);
    const proposal = bytes32(pid);
    if (!rootBuf || !proposal) return { ok: false, reason: 'unsigned' };
    const basePoint = voteNullBase(Number(at), proposal);
    if (!basePoint) return { ok: false, reason: 'unsigned' };
    const digest = voteStatement(rootBuf, at, proposal, choice, seq, magic, dest);
    if (!digest) return { ok: false, reason: 'unsigned' };
    const link = Buffer.concat([linkAnn, linkSr, linkN]);
    if (!fs1VerifyUnlinked({
      fs1,
      records: record,
      link,
      root: rootBuf,
      digest,
      anchor: Number(at),
      nullBases: pointBytes(basePoint),
    })) return { ok: false, reason: 'unsigned' };
    const tag = voteTag(linkN, at, proposal);
    if (!tag) return { ok: false, reason: 'unsigned' };
    return { ok: true, voteTag: tag, epoch: at };
  } catch {
    return { ok: false, reason: 'unsigned' };
  }
}

/** Opening of the sum of reward commitments. This is the epoch's public mint. */
export function proveEpochMint(nanos, blind) {
  const value = proveValue(nanos, blind);
  const range = proveRange(BigInt(nanos), typeof blind === 'bigint' ? blind : scalarFrom(blind));
  return {
    nanos: Math.floor(Number(nanos)),
    proof: { R: value.R, z: value.z },
    range,
    commit: value.C,
  };
}

/** commit || noteCommit || amtCt || dest20 || u32le(rangeLen) || range. The claim output. */
export function packVaultOutput(note) {
  if (!note) return null;
  let commitB;
  let noteCommit;
  let amtCt;
  let dest20;
  let range;
  try {
    commitB = Buffer.from(asU8(note.commit));
    noteCommit = Buffer.from(asU8(note.noteCommit));
    amtCt = Buffer.from(asU8(note.amtCt));
    dest20 = Buffer.from(asU8(note.dest20));
    range = Buffer.from(asU8(note.rangeProof));
  } catch {
    return null;
  }
  if (commitB.length !== 32 || noteCommit.length !== 32 || amtCt.length !== 8 || dest20.length !== 20) return null;
  if (!range.length) return null;
  return Buffer.concat([commitB, noteCommit, amtCt, dest20, u32le(range.length), range]);
}

/** Inverse of packVaultOutput. Null when the bytes are not one note. */
export function parseVaultOutput(raw) {
  let buf;
  try { buf = Buffer.from(asU8(raw)); } catch { return null; }
  if (buf.length < 32 + 32 + 8 + 20 + 4) return null;
  let off = 0;
  const commit = buf.subarray(off, off + 32); off += 32;
  const noteCommit = buf.subarray(off, off + 32); off += 32;
  const amtCt = buf.subarray(off, off + 8); off += 8;
  const dest20 = buf.subarray(off, off + 20); off += 20;
  const rangeLen = buf.readUInt32LE(off); off += 4;
  if (!rangeLen || off + rangeLen !== buf.length) return null;
  return {
    commit: Buffer.from(commit),
    noteCommit: Buffer.from(noteCommit),
    amtCt: Buffer.from(amtCt),
    dest20: Buffer.from(dest20),
    rangeProof: Buffer.from(buf.subarray(off)),
  };
}

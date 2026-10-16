/**
 * Vault-lock reward proof. A claim proves membership of one hidden lock
 * in the full FS-1 set, plus knowledge of its vault key. The note is
 * admitPub(vaultKey) || Pedersen(lock amount). The reward is a public
 * integer: floor(principal * bps * span / (span * 10000)). Span is the
 * same for every lock and cancels, so the relation is
 * principal * bps = reward * 10000 + rem, with 0 <= rem < 10000.
 * The proof does not publish the lock commitment, a cap commitment, or a
 * remainder that indexes the leaf. Blinds and the nullifier are fresh.
 * The nullifier is a PRF of the vault key and the epoch. It is not a hash
 * of the public spend tag.
 */
import { createHash, randomBytes } from 'node:crypto';
import { RistrettoPoint, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { MAGIC_TESTNET, VAULT_PROOF_VER } from './asert.js';

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
 * floor(amount * bps * span / (span * 10000)). Span cancels, so this is
 * floor(amount * bps / 10000). A remain other than the span is not a claim:
 * the public span is the same for every member of the full set.
 */
export function vaultRewardNanos(amount, bps, remainMs, span) {
  let width;
  let left;
  let rate;
  let a;
  try {
    width = BigInt(span);
    left = BigInt(remainMs);
    rate = BigInt(bps);
    a = BigInt(amount);
  } catch {
    return null;
  }
  if (width <= 0n || left !== width || a <= 0n || rate <= 0n) return null;
  const product = a * rate;
  if (product < 0n || product >= RELATION_BOUND) return null;
  const nanos = product / CAP_DENOM;
  const rem = product % CAP_DENOM;
  if (nanos <= 0n || nanos > MAX_NANOS || rem < 0n || rem >= CAP_DENOM) return null;
  if (width * CAP_DENOM >= RELATION_BOUND) return null;
  return { nanos, rem, denom: CAP_DENOM };
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

/** One vault-lock leaf: owner point || commitment to the hidden amount. */
export function vaultLockNote(amount, ownerScalar, blind) {
  const x = typeof ownerScalar === 'bigint' ? ownerScalar : scalarFrom(ownerScalar);
  const r = typeof blind === 'bigint' ? blind : scalarFrom(blind);
  const pub = pointBytes(admitPub(x));
  const C = pointBytes(commit(BigInt(amount), r));
  return {
    note: Buffer.concat([pub, C]),
    admitPub: pub,
    commit: C,
    scalar: x,
    blind: r,
    amount: BigInt(amount),
  };
}

function statementDigest({
  magic, root, epoch, bps, span, reward, remCommit, remRange, slackCommit, slackRange,
  commit: outCommit, noteCommit, dest20, amtCt, preimage,
}) {
  const hash = (raw) => createHash('sha256').update(raw).digest();
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VAULT_REWARD_DST),
    Buffer.from(String(magic || MAGIC_TESTNET)),
    root,
    u64le(epoch),
    u32le(bps),
    u64le(span),
    u64le(reward),
    remCommit,
    hash(remRange),
    slackCommit,
    hash(slackRange),
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

function dleqProve(b1, b2, x) {
  const k = randomScalar();
  const A1 = b1.multiply(k);
  const A2 = b2.multiply(k);
  const P1 = b1.multiply(x);
  const P2 = b2.multiply(x);
  const e = hashToScalar(pointBytes(A1), pointBytes(A2), pointBytes(P1), pointBytes(P2));
  const s = Fn.add(k, Fn.mul(e, x));
  return { A1: pointBytes(A1), A2: pointBytes(A2), P1: pointBytes(P1), P2: pointBytes(P2), s: scalarBytes(s) };
}

function dleqVerify(b1, b2, P1, P2, A1, A2, s) {
  try {
    const e = hashToScalar(A1, A2, P1, P2);
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

/**
 * The key holder retires one epoch's claim nullifier.
 * Proof: u64 epoch || leaf(64) || A1 || A2 || s || P2. 200 bytes.
 * DLEQ shows leaf[0:32] = G*x and P2 = Hp(epoch)*x. The nullifier is hash(P2).
 */
export function proveLeafRetire({ scalar, epoch, leaf } = {}) {
  try {
    const x = typeof scalar === 'bigint' ? scalar : scalarFrom(scalar);
    const at = Math.floor(Number(epoch));
    if (!Number.isSafeInteger(at) || at < 0) return null;
    const note = Buffer.from(asU8(leaf));
    if (note.length !== 64) return null;
    const d = dleqProve(G, nullBase(at), x);
    if (!note.subarray(0, 32).equals(d.P1)) return null;
    const nullifier = createHash('sha256').update(VAULT_NULL_PRF).update(d.P2).digest();
    const proof = Buffer.concat([u64le(at), note, d.A1, d.A2, d.s, d.P2]);
    return { proof, nullifier, nullifierHex: nullifier.toString('hex'), epoch: at };
  } catch {
    return null;
  }
}

/** Null when the retire proof does not open `nullifier` for its leaf. */
export function verifyLeafRetire(proof, nullifier = null) {
  try {
    const buf = Buffer.from(asU8(proof));
    if (buf.length !== 200) return null;
    const epoch = buf.readBigUInt64LE(0);
    const leaf = Buffer.from(buf.subarray(8, 72));
    const A1 = buf.subarray(72, 104);
    const A2 = buf.subarray(104, 136);
    const s = buf.subarray(136, 168);
    const P2 = buf.subarray(168, 200);
    const base = pointBytes(nullBase(epoch));
    if (!dleqVerify(pointBytes(G), base, leaf.subarray(0, 32), P2, A1, A2, s)) return null;
    const expect = createHash('sha256').update(VAULT_NULL_PRF).update(P2).digest();
    const nf = nullifier == null ? expect : bytes32(nullifier);
    if (!nf || !nf.equals(expect)) return null;
    return { ok: true, nullifier: expect, epoch, leaf };
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

function packProof(p) {
  return Buffer.concat([
    Buffer.from([VAULT_PROOF_VER]),
    u32le(p.fs1.length),
    p.fs1,
    p.record,
    u32le(p.bps),
    u64le(p.span),
    u64le(p.epoch),
    u64le(p.reward),
    p.nullBase,
    p.nullP,
    p.nullA1,
    p.nullA2,
    p.nullS,
    p.relR,
    p.relZ,
    p.remCommit,
    u32le(p.remRange.length),
    p.remRange,
    p.slackCommit,
    u32le(p.slackRange.length),
    p.slackRange,
    p.balR,
    p.balZ,
  ]);
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
  const nullBaseB = take(buf, off, 32);
  if (!nullBaseB) return null;
  off = nullBaseB.off;
  const nullP = take(buf, off, 32);
  if (!nullP) return null;
  off = nullP.off;
  const nullA1 = take(buf, off, 32);
  if (!nullA1) return null;
  off = nullA1.off;
  const nullA2 = take(buf, off, 32);
  if (!nullA2) return null;
  off = nullA2.off;
  const nullS = take(buf, off, 32);
  if (!nullS) return null;
  off = nullS.off;
  const relR = take(buf, off, 32);
  if (!relR) return null;
  off = relR.off;
  const relZ = take(buf, off, 32);
  if (!relZ) return null;
  off = relZ.off;
  const remCommit = take(buf, off, 32);
  if (!remCommit) return null;
  off = remCommit.off;
  const remRangeLen = readU32(buf, off);
  if (!remRangeLen || remRangeLen.n === 0) return null;
  off = remRangeLen.off;
  const remRange = take(buf, off, remRangeLen.n);
  if (!remRange) return null;
  off = remRange.off;
  const slackCommit = take(buf, off, 32);
  if (!slackCommit) return null;
  off = slackCommit.off;
  const slackRangeLen = readU32(buf, off);
  if (!slackRangeLen || slackRangeLen.n === 0) return null;
  off = slackRangeLen.off;
  const slackRange = take(buf, off, slackRangeLen.n);
  if (!slackRange) return null;
  off = slackRange.off;
  const balR = take(buf, off, 32);
  if (!balR) return null;
  off = balR.off;
  const balZ = take(buf, off, 32);
  if (!balZ || balZ.off !== buf.length) return null;
  return {
    fs1: fs1.b,
    record: record.b,
    bps: bps.n,
    span: span.n,
    epoch: epoch.n,
    earnEpoch: epoch.n,
    reward: reward.n,
    nullBase: nullBaseB.b,
    nullP: nullP.b,
    nullA1: nullA1.b,
    nullA2: nullA2.b,
    nullS: nullS.b,
    relR: relR.b,
    relZ: relZ.b,
    remCommit: remCommit.b,
    remRange: remRange.b,
    slackCommit: slackCommit.b,
    slackRange: slackRange.b,
    balR: balR.b,
    balZ: balZ.b,
  };
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
} = {}) {
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
    rows.push(vaultLockNote(amount, scalar, blind));
  }
  const handle = fs1TreeNew();
  if (!handle || !fs1TreeAppend(handle, Buffer.concat(rows.map((row) => row.note)))) return null;
  const root = fs1TreeRoot(handle);
  if (!root) return null;
  const width = BigInt(span);
  const remain = remainMs == null ? width : BigInt(remainMs);
  const reward = vaultRewardNanos(rows[which].amount, bps, remain, width);
  if (!reward) return null;
  let dest = null;
  try { dest = Buffer.from(asU8(dest20)); } catch { dest = null; }
  if (!dest || dest.length !== 20) dest = randomBytes(20);
  const epoch = Math.floor(Number(earnEpoch));
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
  const rRem = randomScalar();
  const rSlack = randomScalar();
  const slack = CAP_DENOM - 1n - reward.rem;
  if (slack < 0n) return null;
  const remCommitP = commit(reward.rem, rRem);
  const slackCommitP = commit(slack, rSlack);
  const remRange = proveRange(reward.rem, rRem);
  const slackRange = proveRange(slack, rSlack);
  if (!remRange?.length || !slackRange?.length) return null;
  const remCommit = pointBytes(remCommitP);
  const slackCommit = pointBytes(slackCommitP);
  const digest = statementDigest({
    magic,
    root,
    epoch,
    bps,
    span: width,
    reward: reward.nanos,
    remCommit,
    remRange,
    slackCommit,
    slackRange,
    commit: bound.commit,
    noteCommit: bound.noteCommit,
    dest20: bound.dest20,
    amtCt: bound.amtCt,
    preimage,
  });
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
  const s = Fn.sub(Fn.mul(Fn.create(BigInt(bps)), Fn.add(rows[which].blind, t)), rRem);
  const P = relationPoint(cTilde, reward.nanos, remCommit, bps);
  if (!P.equals(H.multiply(s))) return null;
  const extra = relationExtra({
    cTilde,
    bps,
    span: width,
    reward: reward.nanos,
    remCommit,
    slackCommit,
  });
  const rel = schnorrProve(P, s, extra);
  const balP = balancePoint(remCommit, slackCommit);
  const balS = Fn.add(rRem, rSlack);
  if (!balP.equals(H.multiply(balS))) return null;
  const bal = schnorrProve(balP, balS, balanceExtra(preimage, bound.dest20));
  const linked = createHash('sha256').update(VAULT_NULL_PRF).update(linkN).digest();
  if (!linked.equals(nullifier)) return null;
  const lockCommit = rows[which].commit;
  const blob = packProof({
    fs1: Buffer.from(proved.fs1),
    record,
    bps,
    span: width,
    epoch,
    reward: reward.nanos,
    nullBase: linkAnn,
    nullP: linkN,
    nullA1: linkSr,
    nullA2: Buffer.alloc(32),
    nullS: Buffer.alloc(32),
    relR: rel.R,
    relZ: rel.z,
    remCommit,
    remRange,
    slackCommit,
    slackRange,
    balR: bal.R,
    balZ: bal.z,
  });
  if (blob.includes(lockCommit)) return null;
  return {
    ok: true,
    blob,
    root,
    rootHex: root.toString('hex'),
    nullifier: nullifier.toString('hex'),
    nanos: reward.nanos <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(reward.nanos) : reward.nanos,
    rem: reward.rem,
    full: true,
    reward,
    rootEpoch: epoch,
    earnEpoch: epoch,
    note,
    preimage,
    locks: rows.map((row) => ({
      amount: row.amount,
      scalar: row.scalar,
      blind: row.blind,
      commit: row.commit,
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
} = {}) {
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
  if (terms.reward != null && BigInt(terms.reward) !== parsed.reward) return fail(2, 'stake_reward');
  const cTilde = parsed.record.subarray(33, 65);
  if (!verifyRange(parsed.remCommit, parsed.remRange)) return fail(2, 'stake_reward');
  if (!verifyRange(parsed.slackCommit, parsed.slackRange)) return fail(2, 'stake_reward');
  let digest;
  let P;
  let balP;
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
      remCommit: parsed.remCommit,
      remRange: parsed.remRange,
      slackCommit: parsed.slackCommit,
      slackRange: parsed.slackRange,
      commit: bound.commit,
      noteCommit: bound.noteCommit,
      dest20: bound.dest20,
      amtCt: bound.amtCt,
      preimage,
    });
    P = relationPoint(cTilde, parsed.reward, parsed.remCommit, parsed.bps);
    balP = balancePoint(parsed.remCommit, parsed.slackCommit);
  } catch {
    return fail(2, 'stake_reward');
  }
  const extra = relationExtra({
    cTilde,
    bps: parsed.bps,
    span: parsed.span,
    reward: parsed.reward,
    remCommit: parsed.remCommit,
    slackCommit: parsed.slackCommit,
  });
  if (!schnorrVerify(P, parsed.relR, parsed.relZ, extra)) return fail(2, 'stake_reward');
  if (!schnorrVerify(balP, parsed.balR, parsed.balZ, balanceExtra(preimage, bound.dest20))) return fail(2, 'stake_reward');
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

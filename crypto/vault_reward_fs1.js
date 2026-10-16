/**
 * Vault-lock reward proof. A claim or a roll proves membership of one
 * lock note plus knowledge of its vault key. The note is
 * admitPub(vaultKey) || Pedersen(lock amount). The lock amount and the
 * reward stay committed. The remainder has its own range proof, and
 * rem + slack = denom - 1, so conservation does not open either integer.
 * The nullifier is a PRF of the vault key and the epoch, checked inside
 * the proof. It is not a hash of the public spend tag. The remainder is
 * a commitment, not a public integer. A later epoch uses the public span,
 * which is the same for every lock. The only public mint is a batch sum.
 */
import { createHash } from 'node:crypto';
import { RistrettoPoint, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { MAGIC_TESTNET } from './asert.js';
import { admitPub } from './admit.js';
import {
  fs1NativeLoaded,
  fs1Prove,
  fs1TreeAppend,
  fs1TreeNew,
  fs1TreeRoot,
  fs1Verify,
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
export const VAULT_LOCK_BLIND_DST = 'shear-vault-lock-blind-v1';
export const VAULT_LOCK_OWNER_DST = 'shear-vault-lock-owner-v1';
export const VAULT_PROOF_VER = 0xa3;
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

/** floor(amount * bps * remain / (span * 10000)), and the remainder. */
export function vaultRewardNanos(amount, bps, remainMs, span) {
  const denom = BigInt(span) * 10000n;
  if (denom <= 0n) return null;
  const prod = BigInt(amount) * BigInt(bps) * BigInt(remainMs);
  if (prod < 0n) return null;
  if (!relationProductsBounded(amount, bps, remainMs, span, prod / denom, prod % denom)) return null;
  return { nanos: prod / denom, rem: prod % denom, denom };
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
  magic, root, epoch, bps, span, full, remainCommit, timeSlackCommit, commitB, amtCt, dest20, noteCommit,
  rewardRange, remCommit, remRange, slackCommit, slackRange,
}) {
  const hash = (raw) => createHash('sha256').update(raw).digest();
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VAULT_REWARD_DST),
    Buffer.from(String(magic || MAGIC_TESTNET)),
    root,
    u64le(epoch),
    u32le(bps),
    u64le(span),
    Buffer.from([full ? 1 : 0]),
    remainCommit,
    timeSlackCommit,
    commitB,
    amtCt,
    dest20,
    noteCommit,
    hash(rewardRange),
    remCommit,
    hash(remRange),
    slackCommit,
    hash(slackRange),
  ])).digest();
}

function hpOf(point) {
  return ristretto255_hasher.hashToCurve(pointBytes(point), { DST: 'shear-admit-Hp' });
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

function relationPoint(qPoint, rewardCommit, remCommit, bps, span) {
  const rate = BigInt(bps);
  const denom = BigInt(span) * 10000n;
  if (rate <= 0n || rate >= RELATION_BOUND || denom <= 0n || denom >= RELATION_BOUND) {
    throw new Error('relation_bound');
  }
  // Q is cTilde * remain, so Q * bps is the hidden product. remain is not here.
  return pointFrom(qPoint).multiply(Fn.create(rate))
    .subtract(pointFrom(rewardCommit).multiply(Fn.create(denom)))
    .subtract(pointFrom(remCommit));
}

function balancePoint(remCommit, slackCommit, denom) {
  return pointFrom(remCommit).add(pointFrom(slackCommit)).subtract(G.multiply(Fn.create(denom - 1n)));
}

/** The amount relation. Amounts stay committed. The root stays in the FS-1 digest. */
function relationExtra({
  qPoint, bps, span, commitB, amtCt, dest20, noteCommit, rewardRange, remCommit, slackCommit,
}) {
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VAULT_REL_DST),
    qPoint,
    u32le(bps),
    u64le(span),
    commitB,
    amtCt,
    dest20,
    noteCommit,
    createHash('sha256').update(rewardRange).digest(),
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

function packProof(p) {
  return Buffer.concat([
    Buffer.from([VAULT_PROOF_VER]),
    u32le(p.fs1.length),
    p.fs1,
    p.record,
    u32le(p.bps),
    u64le(p.span),
    u64le(p.epoch),
    Buffer.from([p.full ? 1 : 0]),
    p.qPoint,
    p.remainCommit,
    p.timeSlackCommit,
    p.sigA1,
    p.sigA2,
    p.sigS,
    p.sigSr,
    p.nullBase,
    p.nullP,
    p.nullA1,
    p.nullA2,
    p.nullS,
    u32le(p.timeRange.length),
    p.timeRange,
    u32le(p.timeSlackRange.length),
    p.timeSlackRange,
    p.timeBalR,
    p.timeBalZ,
    p.relR,
    p.relZ,
    p.commitB,
    p.amtCt,
    p.dest20,
    p.noteCommit,
    u32le(p.range.length),
    p.range,
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
  if (off >= buf.length) return null;
  const full = buf[off];
  off += 1;
  if (full !== 0 && full !== 1) return null;
  const qPoint = take(buf, off, 32);
  if (!qPoint) return null;
  off = qPoint.off;
  const remainCommit = take(buf, off, 32);
  if (!remainCommit) return null;
  off = remainCommit.off;
  const timeSlackCommit = take(buf, off, 32);
  if (!timeSlackCommit) return null;
  off = timeSlackCommit.off;
  const sigA1 = take(buf, off, 32);
  if (!sigA1) return null;
  off = sigA1.off;
  const sigA2 = take(buf, off, 32);
  if (!sigA2) return null;
  off = sigA2.off;
  const sigS = take(buf, off, 32);
  if (!sigS) return null;
  off = sigS.off;
  const sigSr = take(buf, off, 32);
  if (!sigSr) return null;
  off = sigSr.off;
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
  const timeRangeLen = readU32(buf, off);
  if (!timeRangeLen || timeRangeLen.n === 0) return null;
  off = timeRangeLen.off;
  const timeRange = take(buf, off, timeRangeLen.n);
  if (!timeRange) return null;
  off = timeRange.off;
  const timeSlackRangeLen = readU32(buf, off);
  if (!timeSlackRangeLen || timeSlackRangeLen.n === 0) return null;
  off = timeSlackRangeLen.off;
  const timeSlackRange = take(buf, off, timeSlackRangeLen.n);
  if (!timeSlackRange) return null;
  off = timeSlackRange.off;
  const timeBalR = take(buf, off, 32);
  if (!timeBalR) return null;
  off = timeBalR.off;
  const timeBalZ = take(buf, off, 32);
  if (!timeBalZ) return null;
  off = timeBalZ.off;
  const relR = take(buf, off, 32);
  if (!relR) return null;
  off = relR.off;
  const relZ = take(buf, off, 32);
  if (!relZ) return null;
  off = relZ.off;
  const commitB = take(buf, off, 32);
  if (!commitB) return null;
  off = commitB.off;
  const amtCt = take(buf, off, 8);
  if (!amtCt) return null;
  off = amtCt.off;
  const dest20 = take(buf, off, 20);
  if (!dest20) return null;
  off = dest20.off;
  const noteCommit = take(buf, off, 32);
  if (!noteCommit) return null;
  off = noteCommit.off;
  const rangeLen = readU32(buf, off);
  if (!rangeLen || rangeLen.n === 0) return null;
  off = rangeLen.off;
  const range = take(buf, off, rangeLen.n);
  if (!range) return null;
  off = range.off;
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
    full: full === 1,
    qPoint: qPoint.b,
    remainCommit: remainCommit.b,
    timeSlackCommit: timeSlackCommit.b,
    sigA1: sigA1.b,
    sigA2: sigA2.b,
    sigS: sigS.b,
    sigSr: sigSr.b,
    nullBase: nullBaseB.b,
    nullP: nullP.b,
    nullA1: nullA1.b,
    nullA2: nullA2.b,
    nullS: nullS.b,
    timeRange: timeRange.b,
    timeSlackRange: timeSlackRange.b,
    timeBalR: timeBalR.b,
    timeBalZ: timeBalZ.b,
    relR: relR.b,
    relZ: relZ.b,
    commitB: commitB.b,
    amtCt: amtCt.b,
    dest20: dest20.b,
    noteCommit: noteCommit.b,
    range: range.b,
    remCommit: remCommit.b,
    remRange: remRange.b,
    slackCommit: slackCommit.b,
    slackRange: slackRange.b,
    balR: balR.b,
    balZ: balZ.b,
  };
}

/** Reward commitment inside a proof. The epoch total opens the sum of these. */
export function vaultRewardCommit(blob) {
  const parsed = parseProof(blob);
  return parsed ? parsed.commitB : null;
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

function outputMatches(parsed, output) {
  if (!output || output.valueProof) return false;
  const commitB = bytes32(output.commit);
  const noteCommit = bytes32(output.noteCommit);
  let amt;
  let range;
  let dest;
  try {
    amt = Buffer.from(asU8(output.amtCt));
    range = Buffer.from(asU8(output.rangeProof));
    dest = output.dest20 ? Buffer.from(asU8(output.dest20)) : null;
  } catch {
    return false;
  }
  if (!commitB || !commitB.equals(parsed.commitB)) return false;
  if (!noteCommit || !noteCommit.equals(parsed.noteCommit)) return false;
  if (amt.length !== 8 || !amt.equals(parsed.amtCt)) return false;
  if (!range.length || !range.equals(parsed.range)) return false;
  if (dest && (dest.length !== 20 || !dest.equals(parsed.dest20))) return false;
  return true;
}

/**
 * Prove lock `which` inside `locks`. Each lock is { amount, scalar?, blind? }.
 * Missing secrets are drawn here and returned so a second leaf can reuse the tree.
 * The tree handle is not the chain admit tree.
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
  const reward = vaultRewardNanos(rows[which].amount, bps, remainMs, span);
  if (!reward || reward.nanos <= 0n || reward.nanos > MAX_NANOS) return null;
  if (!relationProductsBounded(rows[which].amount, bps, remainMs, span, reward.nanos, reward.rem)) return null;
  let d20;
  try { d20 = Buffer.from(asU8(dest20)); } catch { return null; }
  if (d20.length !== 20) return null;
  const hidden = sealHiddenNote(reward.nanos, {
    dest20: d20,
    kind: 'reward-claim',
    admitBase: admitPub(randomScalar()),
  });
  if (!hidden?.amtCt || Buffer.from(hidden.amtCt).length !== 8) return null;
  if (!hidden.rangeProof || !Buffer.from(hidden.rangeProof).length) return null;
  const commitB = Buffer.from(hidden.commit);
  const amtCt = Buffer.from(hidden.amtCt);
  const noteCommit = Buffer.from(hidden.noteCommit);
  const range = Buffer.from(hidden.rangeProof);
  const rReward = scalarFrom(hidden.r);
  const denom = BigInt(span) * 10000n;
  const slack = denom - 1n - reward.rem;
  if (slack < 0n) return null;
  const rRem = randomScalar();
  const rSlack = randomScalar();
  const remCommitP = commit(reward.rem, rRem);
  const slackCommitP = commit(slack, rSlack);
  const remRange = proveRange(reward.rem, rRem);
  const slackRange = proveRange(slack, rSlack);
  if (!remRange?.length || !slackRange?.length) return null;
  const remCommit = pointBytes(remCommitP);
  const slackCommit = pointBytes(slackCommitP);
  const epoch = Math.floor(Number(earnEpoch));
  const full = remainMs === span ? 1 : 0;
  const rTime = randomScalar();
  const timeSlack = BigInt(span) - BigInt(remainMs);
  if (timeSlack < 0n) return null;
  const rTimeSlack = randomScalar();
  const remainCommitP = commit(BigInt(remainMs), rTime);
  const timeSlackP = commit(timeSlack, rTimeSlack);
  const timeRange = proveRange(BigInt(remainMs), rTime);
  const timeSlackRange = proveRange(timeSlack, rTimeSlack);
  if (!timeRange?.length || !timeSlackRange?.length) return null;
  const remainCommit = pointBytes(remainCommitP);
  const timeSlackCommit = pointBytes(timeSlackP);
  const digest = statementDigest({
    magic,
    root,
    epoch,
    bps,
    span,
    full,
    remainCommit,
    timeSlackCommit,
    commitB,
    amtCt,
    dest20: d20,
    noteCommit,
    rewardRange: range,
    remCommit,
    remRange,
    slackCommit,
    slackRange,
  });
  const proved = fs1Prove(handle, {
    indices: [which],
    xs: [scalarBytes(rows[which].scalar)],
    digest,
    anchor: Number(rootEpoch),
  });
  if (!proved || proved.records.length < RECORD_BYTES) return null;
  const record = Buffer.from(proved.records.subarray(0, RECORD_BYTES));
  const t = scalarFrom(proved.t.subarray(0, 32));
  const cTilde = record.subarray(33, 65);
  const factor = BigInt(bps) * BigInt(remainMs);
  const s = Fn.sub(
    Fn.mul(Fn.create(factor), Fn.add(rows[which].blind, t)),
    Fn.add(Fn.mul(Fn.create(denom), rReward), rRem),
  );
  const sigma = remainSigmaProve(cTilde, remainMs, rTime);
  const P = relationPoint(sigma.Q, commitB, remCommit, bps, span);
  if (!P.equals(H.multiply(s))) return null;
  const extra = relationExtra({
    qPoint: sigma.Q,
    bps,
    span,
    commitB,
    amtCt,
    dest20: d20,
    noteCommit,
    rewardRange: range,
    remCommit,
    slackCommit,
  });
  const rel = schnorrProve(P, s, extra);
  const balP = balancePoint(remCommit, slackCommit, denom);
  const balS = Fn.add(rRem, rSlack);
  if (!balP.equals(H.multiply(balS))) return null;
  const bal = schnorrProve(balP, balS, Buffer.from(VAULT_BAL_DST));
  const timeP = pointFrom(remainCommit).add(pointFrom(timeSlackCommit)).subtract(G.multiply(Fn.create(BigInt(span))));
  const timeS = Fn.add(rTime, rTimeSlack);
  if (!timeP.equals(H.multiply(timeS))) return null;
  const timeBal = schnorrProve(timeP, timeS, Buffer.from(VAULT_BAL_DST));
  const admitPoint = admitPub(rows[which].scalar);
  const link = dleqProve(hpOf(admitPoint), nullBase(epoch), rows[which].scalar);
  if (!link.P1.equals(record.subarray(1, 33))) return null;
  const nullifier = createHash('sha256').update(VAULT_NULL_PRF).update(link.P2).digest();
  const expectNf = vaultRewardNullifier(rows[which].scalar, epoch);
  if (!expectNf || !expectNf.equals(nullifier)) return null;
  const blob = packProof({
    fs1: Buffer.from(proved.fs1),
    record,
    bps,
    span,
    epoch,
    full,
    qPoint: sigma.Q,
    remainCommit,
    timeSlackCommit,
    sigA1: sigma.A1,
    sigA2: sigma.A2,
    sigS: sigma.s,
    sigSr: sigma.sr,
    nullBase: pointBytes(hpOf(admitPoint)),
    nullP: link.P2,
    nullA1: link.A1,
    nullA2: link.A2,
    nullS: link.s,
    timeRange,
    timeSlackRange,
    timeBalR: timeBal.R,
    timeBalZ: timeBal.z,
    relR: rel.R,
    relZ: rel.z,
    commitB,
    amtCt,
    dest20: d20,
    noteCommit,
    range,
    remCommit,
    remRange,
    slackCommit,
    slackRange,
    balR: bal.R,
    balZ: bal.z,
  });
  const note = { ...hidden, dest20: d20 };
  delete note.r;
  delete note.valueProof;
  return {
    ok: true,
    blob,
    root,
    rootHex: root.toString('hex'),
    nullifier: nullifier.toString('hex'),
    nanos: Number(reward.nanos),
    rem: reward.rem,
    remainCommit: remainCommit.toString('hex'),
    full: full === 1,
    rewardBlind: rReward,
    rootEpoch: epoch,
    earnEpoch: epoch,
    note,
    locks: rows.map((row) => ({
      amount: row.amount,
      scalar: row.scalar,
      blind: row.blind,
    })),
  };
}

const IDENTITY = pointBytes(RistrettoPoint.ZERO);

function rangeOrZero(commitBytes, proof) {
  if (commitBytes.equals(IDENTITY)) return true;
  return verifyRange(commitBytes, proof);
}

/**
 * code 1 accepts. code 2 is a bad reward amount. code 0 is not the owner's proof.
 * `output`, when set, must be the hidden note the blob commits to.
 * `terms` is the consensus bps, span, and epoch. Remain is not a public input.
 * `full` on the terms, when set, must match the proof. The reward integer is not an input.
 */
export function verifyVaultReward({
  blob, root, rootEpoch, nullifier, output = null, terms = null, magic = MAGIC_TESTNET,
} = {}) {
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
  if (terms.full != null && Boolean(terms.full) !== parsed.full) return fail(2, 'stake_reward');
  if (expectEpoch !== BigInt(namedEpoch)) return fail(2, 'stake_reward');
  if (parsed.span <= 0n || parsed.bps <= 0 || parsed.bps > 1_000_000) return fail(2, 'stake_reward');
  const denom = parsed.span * 10000n;
  if (denom <= 1n || denom >= RELATION_BOUND) return fail(2, 'stake_reward');
  // remain <= span, and bps * span stays under the relation bound, so the hidden product does too.
  if (BigInt(parsed.bps) * parsed.span >= RELATION_BOUND) return fail(2, 'stake_reward');
  if (output && !outputMatches(parsed, output)) return fail(2, 'stake_reward');
  const cTilde = parsed.record.subarray(33, 65);
  if (!remainSigmaVerify(cTilde, parsed.sigA1, parsed.sigA2, parsed.remainCommit, parsed.qPoint, parsed.sigS, parsed.sigSr)) {
    return fail(2, 'stake_reward');
  }
  if (parsed.full) {
    let scaled;
    try { scaled = pointFrom(cTilde).multiply(Fn.create(parsed.span)); } catch { return fail(2, 'stake_reward'); }
    if (!pointBytes(scaled).equals(parsed.qPoint)) return fail(2, 'stake_reward');
  }
  if (terms.remainCommit) {
    const want = bytes32(terms.remainCommit);
    if (!want || !want.equals(parsed.remainCommit)) return fail(2, 'stake_reward');
  }
  if (!rangeOrZero(parsed.remainCommit, parsed.timeRange)) return fail(2, 'stake_reward');
  if (!rangeOrZero(parsed.timeSlackCommit, parsed.timeSlackRange)) return fail(2, 'stake_reward');
  if (!verifyRange(parsed.commitB, parsed.range)) return fail(2, 'stake_reward');
  if (!verifyRange(parsed.remCommit, parsed.remRange)) return fail(2, 'stake_reward');
  if (!verifyRange(parsed.slackCommit, parsed.slackRange)) return fail(2, 'stake_reward');
  let digest;
  let P;
  let balP;
  let timeP;
  try {
    digest = statementDigest({
      magic,
      root: rootBuf,
      epoch: parsed.epoch,
      bps: parsed.bps,
      span: parsed.span,
      full: parsed.full ? 1 : 0,
      remainCommit: parsed.remainCommit,
      timeSlackCommit: parsed.timeSlackCommit,
      commitB: parsed.commitB,
      amtCt: parsed.amtCt,
      dest20: parsed.dest20,
      noteCommit: parsed.noteCommit,
      rewardRange: parsed.range,
      remCommit: parsed.remCommit,
      remRange: parsed.remRange,
      slackCommit: parsed.slackCommit,
      slackRange: parsed.slackRange,
    });
    P = relationPoint(parsed.qPoint, parsed.commitB, parsed.remCommit, parsed.bps, parsed.span);
    balP = balancePoint(parsed.remCommit, parsed.slackCommit, denom);
    timeP = pointFrom(parsed.remainCommit).add(pointFrom(parsed.timeSlackCommit)).subtract(G.multiply(Fn.create(parsed.span)));
  } catch {
    return fail(2, 'stake_reward');
  }
  const extra = relationExtra({
    qPoint: parsed.qPoint,
    bps: parsed.bps,
    span: parsed.span,
    commitB: parsed.commitB,
    amtCt: parsed.amtCt,
    dest20: parsed.dest20,
    noteCommit: parsed.noteCommit,
    rewardRange: parsed.range,
    remCommit: parsed.remCommit,
    slackCommit: parsed.slackCommit,
  });
  if (!schnorrVerify(P, parsed.relR, parsed.relZ, extra)) return fail(2, 'stake_reward');
  if (!schnorrVerify(balP, parsed.balR, parsed.balZ, Buffer.from(VAULT_BAL_DST))) return fail(2, 'stake_reward');
  if (!schnorrVerify(timeP, parsed.timeBalR, parsed.timeBalZ, Buffer.from(VAULT_BAL_DST))) return fail(2, 'stake_reward');
  const anchor = Number(rootEpoch);
  if (!Number.isSafeInteger(anchor) || anchor < 0) return fail(0, 'unsigned');
  if (!fs1Verify({ fs1: parsed.fs1, records: parsed.record, root: rootBuf, digest, anchor })) {
    return fail(0, 'unsigned');
  }
  const base = bytes32(parsed.nullBase);
  if (!base) return fail(0, 'unsigned');
  const tag = parsed.record.subarray(1, 33);
  if (!dleqVerify(base, pointBytes(nullBase(parsed.epoch)), tag, parsed.nullP, parsed.nullA1, parsed.nullA2, parsed.nullS)) {
    return fail(0, 'unsigned');
  }
  const expect = createHash('sha256').update(VAULT_NULL_PRF).update(parsed.nullP).digest();
  if (!expect.equals(nf)) return fail(0, 'unsigned');
  const derived = tagDerivedNullifier(tag, parsed.epoch);
  if (derived && derived.equals(nf)) return fail(0, 'unsigned');
  return { ok: true, code: 1, reason: null, remainCommit: parsed.remainCommit, full: parsed.full };
}

/** Opening of the sum of reward commitments. This is the epoch's public mint. */
export function proveEpochMint(nanos, blind) {
  const value = proveValue(nanos, blind);
  return { nanos: Math.floor(Number(nanos)), proof: { R: value.R, z: value.z }, commit: value.C };
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

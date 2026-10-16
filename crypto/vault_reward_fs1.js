/**
 * Vault-lock reward proof. A claim or a roll proves membership of one
 * lock note plus knowledge of its vault key. The note is
 * admitPub(vaultKey) || Pedersen(lock amount). The lock amount and the
 * reward stay committed. The remainder has its own range proof, and
 * rem + slack = denom - 1, so conservation does not open either integer.
 * The nullifier is a PRF of that vault key and the one epoch. The epoch
 * is both the root epoch and the earn epoch. The only public mint is the
 * epoch total, opened on the sum of the reward commitments.
 */
import { createHash } from 'node:crypto';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
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
export const VAULT_PROOF_VER = 0xa2;
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
  magic, root, epoch, bps, remain, span, commitB, amtCt, dest20, noteCommit,
  rewardRange, remCommit, remRange, slackCommit, slackRange,
}) {
  const hash = (raw) => createHash('sha256').update(raw).digest();
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VAULT_REWARD_DST),
    Buffer.from(String(magic || MAGIC_TESTNET)),
    root,
    u64le(epoch),
    u32le(bps),
    u64le(remain),
    u64le(span),
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

/**
 * PRF(vault key, epoch). The spend tag is Hp(admitPub) * vaultKey, produced
 * inside the membership proof. The nullifier is that point times H(epoch),
 * not the tag bytes, so the tag is not the preimage.
 */
export function vaultRewardNullifier(spendTag, epoch) {
  try {
    const tag = pointFrom(bytes32(spendTag));
    const h = hashToScalar(Buffer.from(VAULT_NULL_EPOCH_DST), u64le(epoch));
    const nullPoint = tag.multiply(h);
    return createHash('sha256')
      .update(VAULT_NULL_PRF)
      .update(pointBytes(nullPoint))
      .digest();
  } catch {
    return null;
  }
}

function relationPoint(cTilde, rewardCommit, remCommit, bps, remain, span) {
  const factor = BigInt(bps) * BigInt(remain);
  const denom = BigInt(span) * 10000n;
  if (factor <= 0n || factor >= RELATION_BOUND || denom <= 0n || denom >= RELATION_BOUND) {
    throw new Error('relation_bound');
  }
  return pointFrom(cTilde).multiply(Fn.create(factor))
    .subtract(pointFrom(rewardCommit).multiply(Fn.create(denom)))
    .subtract(pointFrom(remCommit));
}

function balancePoint(remCommit, slackCommit, denom) {
  return pointFrom(remCommit).add(pointFrom(slackCommit)).subtract(G.multiply(Fn.create(denom - 1n)));
}

/** The amount relation. Amounts stay committed. The root stays in the FS-1 digest. */
function relationExtra({
  cTilde, bps, remain, span, commitB, amtCt, dest20, noteCommit, rewardRange, remCommit, slackCommit,
}) {
  return createHash('sha256').update(Buffer.concat([
    Buffer.from(VAULT_REL_DST),
    Buffer.from(cTilde),
    u32le(bps),
    u64le(remain),
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
    u64le(p.remain),
    u64le(p.span),
    u64le(p.epoch),
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
  const remain = readU64(buf, off);
  if (!remain) return null;
  off = remain.off;
  const span = readU64(buf, off);
  if (!span) return null;
  off = span.off;
  const epoch = readU64(buf, off);
  if (!epoch) return null;
  off = epoch.off;
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
    remain: remain.n,
    span: span.n,
    epoch: epoch.n,
    earnEpoch: epoch.n,
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
  const digest = statementDigest({
    magic,
    root,
    epoch,
    bps,
    remain: remainMs,
    span,
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
  const P = relationPoint(cTilde, commitB, remCommit, bps, remainMs, span);
  if (!P.equals(H.multiply(s))) return null;
  const extra = relationExtra({
    cTilde,
    bps,
    remain: remainMs,
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
  const nullifier = vaultRewardNullifier(record.subarray(1, 33), epoch);
  if (!nullifier) return null;
  const blob = packProof({
    fs1: Buffer.from(proved.fs1),
    record,
    bps,
    remain: remainMs,
    span,
    epoch,
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

/**
 * code 1 accepts. code 2 is a bad reward amount. code 0 is not the owner's proof.
 * `output`, when set, must be the hidden note the blob commits to.
 * `terms` is the consensus bps, span, remain, and the one epoch. That epoch
 * is the root epoch and the earn epoch. The reward integer is not an input.
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
  let expectRemain;
  let expectEpoch;
  try {
    expectBps = Math.floor(Number(terms.bps));
    expectSpan = BigInt(terms.span);
    expectRemain = BigInt(terms.remain);
    expectEpoch = BigInt(terms.earnEpoch);
  } catch {
    return fail(2, 'stake_reward');
  }
  const namedEpoch = Math.floor(Number(rootEpoch));
  if (!Number.isInteger(expectBps) || parsed.bps !== expectBps) return fail(2, 'stake_reward');
  if (parsed.span !== expectSpan || parsed.remain !== expectRemain || parsed.epoch !== expectEpoch) {
    return fail(2, 'stake_reward');
  }
  if (expectEpoch !== BigInt(namedEpoch)) return fail(2, 'stake_reward');
  if (parsed.span <= 0n || parsed.remain <= 0n || parsed.remain > parsed.span) return fail(2, 'stake_reward');
  if (parsed.bps <= 0 || parsed.bps > 1_000_000) return fail(2, 'stake_reward');
  const denom = parsed.span * 10000n;
  if (denom <= 1n || denom >= RELATION_BOUND) return fail(2, 'stake_reward');
  const factor = BigInt(parsed.bps) * parsed.remain;
  if (factor <= 0n || factor >= RELATION_BOUND) return fail(2, 'stake_reward');
  if (output && !outputMatches(parsed, output)) return fail(2, 'stake_reward');
  if (!verifyRange(parsed.commitB, parsed.range)) return fail(2, 'stake_reward');
  if (!verifyRange(parsed.remCommit, parsed.remRange)) return fail(2, 'stake_reward');
  if (!verifyRange(parsed.slackCommit, parsed.slackRange)) return fail(2, 'stake_reward');
  let digest;
  let P;
  let balP;
  try {
    digest = statementDigest({
      magic,
      root: rootBuf,
      epoch: parsed.epoch,
      bps: parsed.bps,
      remain: parsed.remain,
      span: parsed.span,
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
    P = relationPoint(parsed.record.subarray(33, 65), parsed.commitB, parsed.remCommit, parsed.bps, parsed.remain, parsed.span);
    balP = balancePoint(parsed.remCommit, parsed.slackCommit, denom);
  } catch {
    return fail(2, 'stake_reward');
  }
  const extra = relationExtra({
    cTilde: parsed.record.subarray(33, 65),
    bps: parsed.bps,
    remain: parsed.remain,
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
  const anchor = Number(rootEpoch);
  if (!Number.isSafeInteger(anchor) || anchor < 0) return fail(0, 'unsigned');
  if (!fs1Verify({ fs1: parsed.fs1, records: parsed.record, root: rootBuf, digest, anchor })) {
    return fail(0, 'unsigned');
  }
  const expect = vaultRewardNullifier(parsed.record.subarray(1, 33), parsed.epoch);
  if (!expect || !expect.equals(nf)) return fail(0, 'unsigned');
  return { ok: true, code: 1, reason: null };
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

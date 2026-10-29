/**
 * FS-1-funded vault operations (option A). A lock, top-up, or withdraw is an
 * FS-1 spend sharing the send spend-tag set. A vote is an owner signature.
 * The lock amount is the one opened value. Change stays range-proved.
 * Activation is VAULT_FS1_ACTIVATION_HEIGHT. Below it the book is not read.
 *
 * NEEDS RUSSELL SIGN-OFF. Consensus rule. Do not merge on this draft.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { newIdentity, encodeDest, hash20FromAddress, destCommitFromSpendPub } from '../../crypto/address.js';
import {
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
  VAULT_FS1_ACTIVATION_HEIGHT,
  VAULT_FUND_LAW,
  VAULT_LOCK_LAW,
  consensusFingerprint,
} from '../../crypto/asert.js';
import { levyNeed, levyTaxed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { admitScalarFromSeed, attachAdmitPub } from '../../crypto/admit.js';
import {
  asU8,
  kernelExcess,
  openedCoinbaseNanos,
  proveRange,
  randomScalar,
  sealHiddenNote,
  sealNote,
} from '../../crypto/note.js';
import { viewTagOf, publicReserveReceipt, publicReserveReceiptRejected } from '../../crypto/dummy.js';
import {
  ANCHOR_QUANTUM,
  ANCHOR_WINDOW,
  anchorRejectReason,
  flowProofVerifyCount,
  resetFlowProofVerifies,
  typedAdmitStructure,
  typedKindNeedsAdmitV3,
  typedProofVerifyCount,
  verifyTypedAdmitFunding,
  walletAnchor,
} from '../../crypto/admit_v3.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
  resetFs1Tree,
  resetFs1VerifyCache,
  txBodyDigestFs1,
} from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import { W_FS1_BASE, W_FS1_PER_INPUT, W_OUT, W_SEAL, W_TX, txVerifyWeight } from '../../crypto/block_budget.js';
import { joinCutoffMs } from '../../crypto/pot_sched.js';
import {
  VOTE_HOLD,
  applyReserveBlock as applyVault,
  attachLockEquality,
  canVote as vaultCanVote,
  chainPeriodIndex,
  consensusUnlockPeriod,
  emptyVault as freshEmpty,
  leafEpochsToBurn,
  leafStubNanos,
  lockTx as vaultLockTx,
  lockUnlockOf as vaultUnlock,
  lockWitnessOf,
  portalIdFromDest as portalOfDest,
  previewWithdraw as previewVault,
  proveLockEquality,
  provePrincipalOpen,
  reserveDigestSuffix as suffixOf,
  supplyIdentity as vaultSupply,
  withdraw,
} from '../../crypto/reserve_vault.js';
import { txDigestV3 } from '../../crypto/admit_v3.js';
import { proveLeafRetire, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { boundReserveWithdraw as withdrawCap, reserveAuth, signSpendTx, typedCommitSum } from '../../crypto/spend.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../..');
const T0 = 1_700_000_000_000;
const TRUST = { trustBlockHash: true, skipSharePow: true };
const K = 9;

function readSrc(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function payer() {
  const id = newIdentity();
  const dest = encodeDest(destCommitFromSpendPub(id.spendPub), id.admitBase);
  return { id, dest, spendSeed: id.spendSeed, base: id.admitBase };
}

describe('vault FS-1 funding rules', () => {
  it('names the fund, the lock, and the activation in the fingerprint', () => {
    const fp = consensusFingerprint(MAGIC_TESTNET);
    assert.match(fp, new RegExp(`VAULT_FUND=${VAULT_FUND_LAW}`));
    assert.match(fp, new RegExp(`VAULT_LOCK=${VAULT_LOCK_LAW}`));
    assert.match(fp, new RegExp(`VAULT_FS1=${VAULT_FS1_ACTIVATION_HEIGHT}`));
    assert.equal(VAULT_FUND_LAW, 'fs1-typed');
    assert.equal(VAULT_LOCK_LAW, 'fs1-tranche');
    assert.equal(VAULT_FS1_ACTIVATION_HEIGHT, 17);
    assert.match(fp, /RESERVE_NOTE=withdraw-levy-pull/);
    assert.match(fp, /RESERVE_REWARD_CLAIM=root-claim-principal-kept/);
    assert.match(fp, /RESERVE_ROLL=full-sum-next-epoch/);
    assert.equal(fp.includes('13.0'), false);
  });

  it('routes the four funding sites through the FS-1 verifier', () => {
    for (const rel of ['crypto/admit_v3.js', 'crypto/spend.js', 'crypto/mempool.js', 'node/src/store.js', 'node/src/chain.js']) {
      assert.match(readSrc(rel), /verifyTypedAdmitFunding/);
    }
    const funded = readSrc('crypto/spend.js');
    assert.match(funded, /verifyTypedAdmitFunding\(tx,/);
    const chain = readSrc('node/src/chain.js');
    assert.match(chain, /spentTags: parentTags/);
  });

  it('keeps a byte-3 bucket and a pre-activation FS-1 lock off the anchor book', () => {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 7);
    blob[0] = FS1_WIRE;
    const ct = Buffer.from(blob.subarray(33, 65));
    const fs1 = Buffer.alloc(8, 9);
    fs1[0] = FS1_WIRE;
    const lock = {
      id: 'pre',
      kind: 'lock',
      anchor: 8,
      programId: RESERVE_PROGRAM,
      portalId: 'ab'.repeat(32),
      payoutPortalId: 'cd'.repeat(32),
      fee: 0,
      fs1,
      vin: [{ commit: ct }],
      admit_proofs: [{ admit_proof: true, v: FS1_WIRE, blob, cTilde: ct, spendTag: Buffer.from(blob.subarray(1, 33)) }],
      vout: [{ kind: 'lock', commit: Buffer.alloc(32, 1) }],
    };
    let reads = 0;
    const noteAtAnchor = () => {
      reads += 1;
      return null;
    };
    const below = verifyTypedAdmitFunding(lock, { height: VAULT_FS1_ACTIVATION_HEIGHT - 1, noteAtAnchor, spentTags: new Set() });
    assert.equal(below.reason, 'vault_unavailable');
    assert.equal(reads, 0);
    assert.equal(typedProofVerifyCount(), 0);
    const bucket = Buffer.alloc(FS1_RECORD_BYTES, 3);
    bucket[0] = 3;
    const old = {
      ...lock,
      id: 'bucket',
      fs1: undefined,
      admit_proofs: [{ admit_proof: true, v: 3, blob: bucket, cTilde: ct }],
    };
    reads = 0;
    const gated = verifyTypedAdmitFunding(old, { height: 24, noteAtAnchor, spentTags: new Set() });
    assert.equal(gated.reason, 'vault_unavailable');
    assert.equal(reads, 0);
    const vote = { id: 'v', kind: 'vote', programId: RESERVE_PROGRAM, fee: 0, vin: [], vout: [], choice: VOTE_HOLD };
    assert.equal(verifyTypedAdmitFunding(vote, { height: 16, noteAtAnchor }).reason, 'vault_unavailable');
    assert.equal(reads, 0);
  });

  it('does not turn a public receipt into an FS-1 success', () => {
    const tx = {
      kind: 'lock',
      vin: [{ dest20: Buffer.alloc(20, 1) }],
      vout: [{ kind: 'lock', dest20: Buffer.alloc(20, 2), valueProof: { v: 5 } }],
    };
    assert.equal(publicReserveReceipt(tx), true);
    assert.equal(publicReserveReceiptRejected(tx).reason, 'public_receipt');
    assert.equal(typedKindNeedsAdmitV3(tx), true);
    assert.equal(typedAdmitStructure(tx).skip, undefined);
    assert.equal(typedAdmitStructure(tx).reason, 'admit_version');
    let reads = 0;
    const got = verifyTypedAdmitFunding(tx, {
      height: 40,
      noteAtAnchor: () => { reads += 1; return null; },
      spentTags: new Set(),
    });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'admit_version');
    assert.equal(got.tags, undefined);
    assert.equal(reads, 0);
    assert.equal(typedCommitSum(tx).reason, 'commit_sum');
    assert.equal(reserveAuth(tx, null, null, 'shear-testnet-v12').reason, 'unsigned');
  });

  it('rejects a cleartext debit, a vote that spends, and a vote fee', () => {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 4);
    blob[0] = FS1_WIRE;
    const ct = Buffer.from(blob.subarray(33, 65));
    const base = {
      kind: 'lock',
      anchor: 8,
      fs1: Buffer.from([FS1_WIRE]),
      vin: [{ commit: ct, dest20: Buffer.alloc(20, 1) }],
      admit_proofs: [{ blob, cTilde: ct }],
      vout: [{ kind: 'lock' }],
    };
    assert.equal(typedAdmitStructure(base).reason, 'admit_version');
    assert.equal(typedAdmitStructure({ ...base, vin: [{ commit: ct }], from: 'ssa1q' }).reason, 'admit_version');
    const vote = {
      kind: 'vote',
      fee: 0,
      fs1: Buffer.from([FS1_WIRE]),
      vin: [],
      vout: [],
      admit_proofs: [{ blob }],
    };
    assert.equal(typedAdmitStructure(vote).reason, 'admit_version');
    const priced = { kind: 'vote', fee: 1, vin: [], vout: [{ kind: 'vote', valueProof: { v: 0 } }] };
    assert.equal(typedCommitSum(priced).reason, 'levy');
    const opened = { kind: 'vote', fee: 0, vin: [], vout: [{ kind: 'vote', valueProof: { v: 1 } }] };
    assert.equal(typedCommitSum(opened).reason, 'commit_sum');
    assert.equal(levyTaxed({ kind: 'vote', vin: [], vout: [] }), false);
    assert.equal(levyTaxed({ kind: 'lock' }), true);
    assert.equal(levyTaxed({ kind: 'withdraw' }), true);
    assert.equal(levyTaxed({ kind: 'withdraw', mint: true }), true);
    assert.equal(levyTaxed({ kind: 'reward-claim' }), true);
  });

  it('costs an FS-1 input at 25+25 and a vote at the owner-signature weight', () => {
    const lock = { kind: 'lock', fs1: Buffer.from([FS1_WIRE]), vin: [{}, {}, {}], vout: [{}, {}] };
    assert.equal(txVerifyWeight(lock), W_TX + W_FS1_BASE + W_FS1_PER_INPUT * 3 + W_OUT * 2);
    const vote = { kind: 'vote', vin: [], vout: [] };
    assert.equal(txVerifyWeight(vote), W_TX + W_SEAL);
    assert.ok(txVerifyWeight(vote) < W_FS1_BASE + W_FS1_PER_INPUT);
  });

  it('binds unlock time and lock epoch, and leaves the lock id unsigned', () => {
    const commit = Buffer.alloc(32, 3);
    const row = { kind: 'lock', commit, valueProof: { v: 1000 }, unlockAtMs: 50, lockEpoch: 1 };
    const tx = { kind: 'lock', id: 'lock-a', vout: [row], portalId: 'aa'.repeat(32), programId: RESERVE_PROGRAM };
    assert.equal(suffixOf(tx).equals(suffixOf({ ...tx, id: 'lock-b' })), true);
    assert.equal(suffixOf(tx).equals(suffixOf({ ...tx, vout: [{ ...row, unlockAtMs: 51 }] })), false);
    assert.equal(suffixOf(tx).equals(suffixOf({ ...tx, vout: [{ ...row, lockEpoch: 2 }] })), false);
    const absent = suffixOf({ ...tx, vout: [{ kind: 'lock', commit, valueProof: { v: 1000 } }] });
    assert.equal(absent.equals(suffixOf(tx)), false);
  });

  it('refuses a withdraw before the tranche epoch ends, then pays that principal exactly', () => {
    const who = payer();
    const state = freshEmpty();
    state.magic = MAGIC_TESTNET;
    state.genesisMs = T0;
    const stamp = vaultUnlock({ genesisMs: T0, magic: MAGIC_TESTNET }, T0);
    const note = notedFundingLock(who, 'plain-lock', stamp);
    assert.equal(note.vout[0].admitPub, undefined);
    const locked = applyVault({
      state,
      block: { height: 1, txs: [note] },
      nowMs: T0,
      height: 1,
      genesisMs: T0,
    });
    assert.equal(locked.ok, true, locked.reason);
    const portal = state.portals[portalOfDest(who.dest)];
    assert.notEqual(portal.tranches[0].noteIsPrincipal, true);
    assert.equal(portal.tranches[0].noteCommit, undefined);
    assert.equal(portal.tranches[0].amount, undefined);
    assert.equal(String(portal.tranches[0].commit).length, 64);
    const mid = withdrawCap(vaultWithdraw(who.dest, 1), state, new Set(), T0 + 1_000);
    assert.equal(mid.reason, 'insufficient');
    const end = previewVault(state, who.dest, T0 + RESERVE_EPOCH_MS);
    assert.equal(end.principal, 0);
    assert.equal(end.notePrincipal, 0);
    const identity = vaultSupply(state);
    assert.equal(identity.ok, true, identity.reason);
    assert.equal(identity.lockedNanos, 0);
    assert.equal(identity.principalNanos, PI_SHE_NANOS);
    const paid = payNoted(state, who.dest, note, T0 + RESERVE_EPOCH_MS, 'plain-pay');
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS);
    const early = freshEmpty();
    early.magic = MAGIC_TESTNET;
    early.genesisMs = T0;
    const under = vaultLockTx({ from: who.dest, to: who.dest, nanos: PI_SHE_NANOS - 1, id: 'under' });
    const underGot = applyVault({ state: early, block: { height: 1, txs: [under] }, nowMs: T0, height: 1, genesisMs: T0 });
    assert.equal(underGot.ok, false);
    assert.equal(underGot.reason, 'stake_reward');
    assert.equal(early.portals[portalOfDest(who.dest)], undefined);
    const lateWhen = T0 + RESERVE_EPOCH_MS - joinCutoffMs(MAGIC_TESTNET) + 1_000;
    const late = freshEmpty();
    late.magic = MAGIC_TESTNET;
    late.genesisMs = T0;
    const lateStamp = vaultUnlock({ genesisMs: T0, magic: MAGIC_TESTNET }, lateWhen);
    const lateLock = notedFundingLock(who, 'late', lateStamp);
    const lateGot = applyVault({
      state: late,
      block: { height: 1, txs: [lateLock] },
      nowMs: lateWhen,
      height: 1,
      genesisMs: T0,
    });
    assert.equal(lateGot.ok, true, lateGot.reason);
    const latePortal = late.portals[portalOfDest(who.dest)];
    const remain = Math.floor(Number(latePortal.tranches[0].remainMs) || 0);
    assert.ok(remain < joinCutoffMs(MAGIC_TESTNET), `remain ${remain}`);
    assert.equal(Number(latePortal.staked) + Number(latePortal.idle), 0);
    assert.equal(vaultCanVote(latePortal.staked, latePortal.idle), false);
  });
});

function notedFundingLock(who, id, stamp) {
  const ownerPub = Buffer.from(who.id.spendPub).toString('hex');
  const tx = vaultLockTx({
    from: who.dest,
    to: who.dest,
    nanos: PI_SHE_NANOS,
    id,
    ownerPub,
    timeLock: true,
    lockEpoch: stamp.epoch,
    unlockAtMs: stamp.unlockAtMs,
  });
  tx.ownerPub = ownerPub;
  const held = lockWitnessOf(tx);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const scalar = randomScalar();
  const leaf = vaultLockNote(held.amount, scalar, held.blind, unlock);
  assert.ok(leaf, id);
  tx.vaultLockNote = leaf.note;
  tx._leaf = { note: leaf.note, scalar, blind: held.blind, unlock };
  assert.equal(attachLockEquality(tx), true, id);
  return tx;
}

function payNoted(state, dest, lock, when, id) {
  const portal = portalOfDest(dest);
  const leaf = lock._leaf;
  // Since cfe93bf5 the testnet arrival day is 24 blocks, so a lock at
  // height 1 earns an arrival stub. The receipt is π plus that stub. The
  // principal proof still opens π.
  const stub = leafStubNanos(state, [leaf.note.subarray(32, 64).toString('hex')]);
  assert.ok(stub > 0n, `${id} stub ${stub}`);
  const due = PI_SHE_NANOS + Number(stub);
  // A withdraw names its lock by portalId and pays dest20. from, to, and
  // payoutPortalId are vote_leak on the wire (325b50f5).
  const tx = {
    kind: 'withdraw',
    id,
    programId: RESERVE_PROGRAM,
    portalId: portal,
    nanos: due,
    vout: [{ kind: 'withdraw', dest20: hash20FromAddress(dest), valueProof: { v: due } }],
  };
  const period = chainPeriodIndex(state, when);
  const retire = proveLeafRetire({
    scalar: leaf.scalar,
    epochs: leafEpochsToBurn(state, leaf.note.toString('hex'), period),
    leaf: leaf.note,
    txBind: txDigestV3(tx, state.magic),
    unlockEpoch: period,
    magic: state.magic,
  });
  assert.ok(retire, id);
  tx.retireProof = retire.proof;
  tx.principalProof = provePrincipalOpen(
    leaf.note.subarray(32, 64),
    PI_SHE_NANOS,
    leaf.blind,
    tx,
    portal,
    state.magic,
    leaf.unlock,
  );
  const paid = withdraw({
    state,
    dest,
    nowMs: when,
    principal: due,
    principalProof: tx.principalProof,
    retireProof: tx.retireProof,
    tx,
  });
  if (paid.ok) assert.equal(BigInt(paid.arrival), stub, `${id} arrival`);
  return paid;
}

function vaultWithdraw(dest, nanos) {
  return {
    kind: 'withdraw',
    programId: RESERVE_PROGRAM,
    portalId: portalOfDest(dest),
    payoutPortalId: portalOfDest(dest),
    vout: [{ kind: 'withdraw', dest20: hash20FromAddress(dest), valueProof: { v: nanos } }],
  };
}

function hiddenOut(nanos, dest20, admitBase, kind) {
  const sealed = admitBase
    ? sealHiddenNote(nanos, { dest20, kind, admitBase })
    : sealNote(nanos, { dest20, kind });
  let note = attachAdmitPub(sealed, admitBase ? { admitBase } : {});
  note = { ...note, kind, dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  if (kind !== 'dummy') delete note.valueProof;
  return note;
}

function lockOut(nanos, dest20, _admitBase, unlockAtMs, lockEpoch) {
  const note = sealNote(nanos, { dest20, kind: 'lock' });
  return {
    ...note,
    kind: 'lock',
    dest20: Buffer.from(dest20),
    unlockAtMs,
    lockEpoch,
    viewTag: viewTagOf(note.noteCommit),
  };
}

function lastStamp(store) {
  const tip = store.tip();
  return tip ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) : T0;
}

async function mine(store, dest) {
  const now = Math.max(T0, lastStamp(store) + 90_000);
  const { tpl } = store.template({ miner: dest, shareBits: 4, now });
  const got = await Promise.resolve(store.append({
    header: tpl.header,
    height: tpl.height,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: Buffer.alloc(32), skipSharePow: true }));
  assert.equal(got.ok, true, `append ${got.reason || ''}`);
  return tpl;
}

function blockVerdict(store, dest, txs) {
  const list = Array.isArray(txs) ? txs : [txs];
  const tip = store.tip();
  const preview = store.template({ miner: dest, shareBits: 4, now: lastStamp(store) + 90_000 });
  const stamp = Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp);
  const built = buildTemplate({
    prev: tip ? tip.hash : GENESIS_PREV,
    prevHeader: tip ? tip.header : undefined,
    prevBlock: tip || null,
    height: (tip?.height || 0) + 1,
    miner: dest,
    bits: preview.tpl.bits,
    now: stamp,
    txs: list,
    parentBlocks: store.blocks,
  });
  for (const tx of list) {
    if (!built.txs.some((row) => row.id === tx.id)) return { ok: false, reason: 'template_dropped' };
  }
  let genesisMs = 0;
  try {
    const g = store.blocks[0];
    if (g?.header) genesisMs = Number(decodeHeader(Buffer.from(g.header)).timestamp) || 0;
  } catch { /* a missing genesis clock stays 0 */ }
  const parentSupply = typeof store.supplyState === 'function' ? store.supplyState() : null;
  return verifyBlock({
    header: built.header,
    height: built.height,
    txs: built.txs,
    samples: built.samples,
    shareBatch: built.shareBatch || [],
    miner: dest,
    aLeaves: built.aLeaves,
    bLeaves: built.bLeaves,
    rootA: built.rootA,
    rootB: built.rootB,
    weight: built.weight,
  }, tip, {
    trustedPowHash: Buffer.alloc(32),
    skipSharePow: true,
    noteAtAnchor: (anchor) => store.anchorNote(anchor),
    evmHistory: store.blocks,
    genesisMs,
    magic: MAGIC_TESTNET,
    ...(parentSupply ? { parentSupply } : {}),
  });
}

function rangeSlack(outs) {
  let bytes = 0;
  for (const o of outs) if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  return Math.ceil((bytes * 2) / 2048) + 8;
}

function placeholders(k) {
  const fs1 = Buffer.alloc(fs1BlobLen(k), 255);
  fs1[0] = FS1_WIRE;
  const proofs = [];
  for (let i = 0; i < k; i += 1) {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
    blob[0] = FS1_WIRE;
    proofs.push({ admit_proof: true, v: FS1_WIRE, spendTag: Buffer.alloc(32, 255), blob, cTilde: Buffer.alloc(32, 255) });
  }
  return { fs1, proofs, vin: proofs.map(() => ({ commit: Buffer.alloc(32, 255) })) };
}

describe('v12 FS-1 vault operations', { concurrency: false, timeout: 1_800_000 }, () => {
  if (!fs1NativeLoaded()) {
    it('needs the native FS-1 addon (crypto/native make all)', () => {
      assert.fail('shear_admit FS-1 addon is not loaded');
    });
    return;
  }

  const who = payer();
  const portalId = portalOfDest(who.dest);
  const payoutPortalId = portalId;
  let dir;
  let store;
  const coins = [];
  const spent = new Set();
  let firstLock = null;
  let tagLock = null;
  let voteSealed = false;

  function genesisMs() {
    return Number(decodeHeader(Buffer.from(store.blocks[0].header)).timestamp);
  }

  function nextHeight() {
    return store.tip().height + 1;
  }

  function stampFor(nowMs) {
    return vaultUnlock({ genesisMs: genesisMs(), magic: MAGIC_TESTNET }, nowMs);
  }

  function liveAt(anchor) {
    const live = store.anchorNote(anchor);
    assert.ok(live && live.n >= 1, `anchor ${anchor} n=${live?.n}`);
    const at = new Map();
    for (let i = 0; i < live.n; i += 1) {
      at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
    }
    const out = [];
    for (const c of coins) {
      const key = c.commit.toString('hex');
      if (spent.has(key) || !at.has(key)) continue;
      out.push({ ...c, index: at.get(key) });
    }
    return { anchor, live, coins: out, height: nextHeight() };
  }

  function buildLock({ id, coins: use, anchor, live, amount }) {
    const total = use.reduce((s, c) => s + c.v, 0);
    const k = use.length;
    const ph = placeholders(k);
    const now = Math.max(T0, lastStamp(store) + 90_000);
    const stamp = stampFor(now);
    const d20 = hash20FromAddress(who.dest);
    let fee = LEVY_FLOOR_UNITS;
    let outs = null;
    let draft = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const room = total - fee;
      assert.ok(room > amount, `${id} room ${room} amount ${amount} fee ${fee}`);
      const change = room - amount;
      outs = [
        lockOut(amount, d20, who.base, stamp.unlockAtMs, stamp.epoch),
        hiddenOut(change, d20, who.base, 'send'),
      ];
      // The reserve suffix hashes the published amount. A lock note publishes
      // nothing, so the proof is taken after that opening is gone.
      if (amount === PI_SHE_NANOS) delete outs[0].valueProof;
      draft = compactTx({
        id,
        kind: 'lock',
        anchor,
        fee,
        programId: RESERVE_PROGRAM,
        // A lock names only its own portalId. payoutPortalId is vote_leak (cb733226).
        portalId,
        to: who.dest,
        ownerPub: who.id.spendPub.toString('hex'),
        vin: ph.vin,
        vout: outs,
        fs1: ph.fs1,
        admit_proofs: ph.proofs,
        excess: Buffer.alloc(32, 255),
      });
      const need = levyNeed(draft);
      if (fee >= need && fee <= LEVY_CAP_NANOS) break;
      const next = need + rangeSlack(outs);
      assert.ok(next > fee && next <= LEVY_CAP_NANOS, `levy ${need} fee ${fee}`);
      fee = next;
      draft = null;
    }
    assert.ok(draft, `${id} fee did not settle`);
    let piProof = null;
    if (amount === PI_SHE_NANOS) {
      piProof = proveRange(0n, outs[0].r);
      assert.ok(piProof, `${id} pi`);
      draft.piProof = piProof;
    }
    const proven = fs1ProveSpend({
      live,
      anchor,
      indices: use.map((c) => c.index),
      xs: use.map((c) => c.x),
      tx: draft,
      magic: MAGIC_TESTNET,
    });
    assert.ok(proven, `${id} prove`);
    const excess = kernelExcess(outs, use.map((c, i) => ({ r: c.r, t: proven.t[i] })));
    assert.ok(excess, `${id} excess`);
    const tx = compactTx({
      id,
      kind: 'lock',
      anchor,
      fee: draft.fee,
      programId: RESERVE_PROGRAM,
      portalId,
      to: who.dest,
      ownerPub: who.id.spendPub.toString('hex'),
      vin: proven.proofs.map((p) => ({ commit: Buffer.from(p.cTilde) })),
      vout: outs,
      fs1: proven.fs1,
      admit_proofs: proven.proofs,
      excess,
      ...(piProof ? { piProof } : {}),
    });
    assert.ok(txBodyDigestFs1(tx, MAGIC_TESTNET).equals(proven.digest), `${id} compact digest`);
    // The vin is the spent note. The owner signature binds tx.dest20, which
    // compact does not rebuild from the portal address.
    tx.dest20 = Buffer.from(d20);
    // A compact lock carries dest20. The address is vote_leak.
    signSpendTx(tx, who.id.privateKey, { magic: 'shear-testnet-v12' });
    delete tx.spendPub;
    delete tx.sig;
    delete tx.signature;
    assert.equal(tx.spendPub, undefined, `${id} spendPub`);
    assert.equal(tx.sig, undefined, `${id} sig`);
    assert.equal(tx.signature, undefined, `${id} signature`);
    if (amount === PI_SHE_NANOS) {
      const lockBlind = outs[0].r;
      const lockRow = tx.vout.find((row) => String(row?.kind || '') === 'lock');
      const unlock = consensusUnlockPeriod(stamp.epoch);
      const scalar = randomScalar();
      const leaf = vaultLockNote(amount, scalar, lockBlind, unlock);
      assert.ok(leaf && lockRow && lockBlind != null, `${id} leaf`);
      assert.equal(lockRow.valueProof, undefined);
      tx.vaultLockNote = leaf.note;
      const fund = proveLockEquality(lockRow.commit, PI_SHE_NANOS, lockBlind, tx, MAGIC_TESTNET, 0);
      assert.ok(tx.piProof && fund, `${id} fund`);
      lockRow.fundProof = fund;
    }
    assert.equal(tx.from, undefined);
    assert.equal(tx._leaf, undefined);
    assert.equal(tx.vin.every((v) => v.commit && !v.dest20 && !v.address), true);
    if (amount === PI_SHE_NANOS) assert.equal(tx.vout[0].valueProof, undefined);
    else assert.equal(tx.vout[0].valueProof.v, amount);
    assert.equal(tx.vout[1].valueProof, undefined);
    assert.ok(tx.vout[1].rangeProof);
    assert.equal(txVerifyWeight(tx), W_TX + W_FS1_BASE + W_FS1_PER_INPUT * k + W_OUT * tx.vout.length);
    return { tx, proven, outs, amount, anchor };
  }

  async function appendBuilt(target, dest, txs) {
    const tip = target.tip();
    const preview = target.template({ miner: dest, shareBits: 4, now: lastStamp(target) + 90_000 });
    const stamp = Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp);
    const built = buildTemplate({
      prev: tip ? tip.hash : GENESIS_PREV,
      prevHeader: tip ? tip.header : undefined,
      prevBlock: tip || null,
      height: (tip?.height || 0) + 1,
      miner: dest,
      bits: preview.tpl.bits,
      now: stamp,
      txs,
      parentBlocks: target.blocks,
    });
    for (const tx of txs) {
      if (!built.txs.some((row) => row.id === tx.id)) return { ok: false, reason: 'template_dropped' };
    }
    return target.append({
      header: built.header,
      height: built.height,
      txs: built.txs,
      samples: built.samples,
      shareBatch: built.shareBatch || [],
      miner: dest,
      aLeaves: built.aLeaves,
      bLeaves: built.bLeaves,
      rootA: built.rootA,
      rootB: built.rootB,
      weight: built.weight,
    }, { trustedPowHash: Buffer.alloc(32), skipSharePow: true });
  }

  async function seal(built, label) {
    const { tx } = built;
    resetFlowProofVerifies();
    resetFs1VerifyCache();
    resetFs1Tree();
    const queued = store.queueTx(tx);
    assert.equal(queued.ok, true, `${label} queue ${queued.reason}`);
    assert.ok(flowProofVerifyCount() > 0, `${label} queue skipped FS-1`);
    const tpl = await mine(store, who.dest);
    assert.ok(tpl.txs.some((row) => row.id === tx.id), `${label} was not templated`);
    const tags = store.fluxset().spendTags;
    for (const p of built.proven.proofs) {
      assert.equal(tags.has(Buffer.from(p.spendTag).toString('hex')), true, `${label} tag`);
    }
    return tx;
  }

  before(async () => {
    resetFs1Tree();
    resetFlowProofVerifies();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-fs1-'));
    store = createStore(dir);
    for (let i = 0; i < 80; i += 1) {
      const tpl = await mine(store, who.dest);
      const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
      assert.ok(pot && pot.r, 'template pot opening');
      coins.push({
        r: Buffer.from(asU8(pot.r)),
        v: openedCoinbaseNanos(pot),
        commit: Buffer.from(asU8(pot.commit)),
        x: admitScalarFromSeed(who.spendSeed, pot),
      });
    }
    assert.equal(store.tip().height, 80);
    const H = nextHeight();
    assert.equal(walletAnchor(H), H - K);
    assert.equal(anchorRejectReason(8, H), null);
    assert.equal(anchorRejectReason(walletAnchor(H), H), null);
    assert.equal((H - K) - ANCHOR_WINDOW, 8);
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const spread = [
    { n: 1, amount: 1, edge: 'oldest' },
    { n: 1, amount: 1_000_000_001, edge: 'newest' },
    { n: 2, amount: 2, edge: 'newest' },
    { n: 3, amount: 50_000_000_000, edge: 'newest' },
    { n: 4, amount: PI_SHE_NANOS, edge: 'newest' },
    { n: 5, amount: PI_SHE_NANOS + 1, edge: 'newest' },
    { n: 6, amount: PI_SHE_NANOS - 1, edge: 'newest' },
    { n: 7, amount: PI_SHE_NANOS * 2, edge: 'newest' },
    { n: 8, amount: 3, edge: 'newest' },
  ];

  for (const row of spread) {
    it(`locks ${row.amount} from ${row.n} input(s) at the ${row.edge} anchor`, async () => {
      const H = nextHeight();
      const newest = walletAnchor(H);
      const oldest = newest - ANCHOR_WINDOW;
      const anchor = row.edge === 'oldest' ? oldest : newest;
      const below = oldest - ANCHOR_QUANTUM;
      const belowReason = below < ANCHOR_QUANTUM ? 'admit_anchor_quantum' : 'admit_anchor_window';
      assert.equal(anchorRejectReason(below, H), belowReason);
      assert.equal(anchorRejectReason(newest + ANCHOR_QUANTUM, H), 'admit_anchor_window');
      assert.equal(anchorRejectReason(anchor + 1, H), 'admit_anchor_quantum');
      const view = liveAt(anchor);
      assert.ok(view.coins.length >= row.n, `coins ${view.coins.length} for ${row.n}`);
      const use = view.coins.slice(0, row.n);
      const built = buildLock({
        id: `vault-lock-${row.edge}-${row.n}-${row.amount}`,
        coins: use,
        anchor,
        live: view.live,
        amount: row.amount,
      });
      if (built.tx.vout[0].valueProof) {
        const bumped = {
          ...built.tx,
          vout: built.tx.vout.map((o, i) => (i === 0
            ? { ...o, valueProof: { ...o.valueProof, v: o.valueProof.v + 1 } }
            : o)),
        };
        assert.equal(typedCommitSum(bumped).reason, 'commit_sum');
        const dropped = {
          ...built.tx,
          vout: built.tx.vout.map((o, i) => (i === 0
            ? { ...o, valueProof: { ...o.valueProof, v: o.valueProof.v - 1 } }
            : o)),
        };
        assert.equal(typedCommitSum(dropped).reason, 'commit_sum');
      } else {
        const flippedExcess = { ...built.tx, excess: Buffer.from(built.tx.excess) };
        flippedExcess.excess[0] ^= 0xff;
        assert.equal(typedCommitSum(flippedExcess).reason, 'commit_sum');
        const published = {
          ...built.tx,
          vout: built.tx.vout.map((o, i) => (i === 0
            ? { ...o, valueProof: { v: row.amount } }
            : o)),
        };
        assert.equal(typedCommitSum(published).reason, 'commit_sum');
      }
      const past = { ...built.tx, anchor: newest + ANCHOR_QUANTUM };
      assert.equal(verifyTypedAdmitFunding(past, {
        height: H,
        spentTags: new Set(),
        noteAtAnchor: () => store.anchorNote(past.anchor),
      }).reason, 'admit_anchor_window');
      const odd = { ...built.tx, anchor: anchor + 1 };
      assert.equal(verifyTypedAdmitFunding(odd, {
        height: H,
        spentTags: new Set(),
        noteAtAnchor: () => null,
      }).reason, 'admit_anchor_quantum');
      const flipped = {
        ...built.tx,
        fs1: Buffer.from(built.tx.fs1),
      };
      flipped.fs1[10] ^= 0xff;
      assert.equal(verifyTypedAdmitFunding(flipped, {
        height: H,
        spentTags: store.fluxset().spendTags,
        magic: MAGIC_TESTNET,
        noteAtAnchor: (a) => store.anchorNote(a),
      }).ok, false);
      if (row.amount === PI_SHE_NANOS) {
        const twin = { ...built.tx, id: `${built.tx.id}-twin` };
        const heightBefore = store.tip().height;
        const together = await appendBuilt(store, who.dest, [built.tx, twin]);
        assert.equal(together.ok, false, 'in-block double spend');
        assert.equal(together.reason, 'admit_link_tag');
        assert.equal(store.tip().height, heightBefore);
      }
      if (row.amount !== PI_SHE_NANOS) {
        const heightBefore = store.tip().height;
        const dropped = await appendBuilt(store, who.dest, [built.tx]);
        assert.equal(dropped.ok, false, `non-π ${row.amount} sealed`);
        assert.ok(
          dropped.reason === 'stake_reward' || dropped.reason === 'template_dropped',
          dropped.reason,
        );
        assert.equal(store.tip().height, heightBefore);
        return;
      }
      await seal(built, `lock-${row.n}`);
      if (row.edge === 'newest' && row.amount === PI_SHE_NANOS) {
        const lockHeight = store.blocks.findIndex((b) => (b.txs || []).some((tx) => tx.id === built.tx.id));
        const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-fs1-fork-'));
        try {
          const peer = createStore(peerDir);
          const prefix = await Promise.resolve(peer.ingest(store.blocks.slice(0, lockHeight), TRUST));
          assert.equal(prefix.ok, true, prefix.reason);
          await mine(peer, who.dest);
          await mine(peer, who.dest);
          assert.ok(peer.tip().height > store.blocks[lockHeight].height);
          const tag = Buffer.from(built.proven.proofs[0].spendTag).toString('hex');
          assert.equal(peer.fluxset().spendTags.has(tag), false);
          const again = peer.queueTx(built.tx);
          assert.equal(again.ok, true, `reorg tag ${again.reason}`);
          await mine(peer, who.dest);
          assert.equal(peer.fluxset().spendTags.has(tag), true);
        } finally {
          fs.rmSync(peerDir, { recursive: true, force: true });
        }
      }
      for (const c of use) spent.add(c.commit.toString('hex'));
      if (!firstLock) firstLock = built;
      if (row.amount === PI_SHE_NANOS) tagLock = built;
      if (row.amount === PI_SHE_NANOS) {
        const vote = compactTx({
          id: 'vault-vote-hold',
          kind: 'vote',
          programId: RESERVE_PROGRAM,
          portalId,
          payoutPortalId,
          choice: VOTE_HOLD,
          fee: 0,
          vin: [],
          vout: [],
        });
        vote.dest20 = Buffer.from(hash20FromAddress(who.dest));
        vote.to = who.dest;
        signSpendTx(vote, who.id.privateKey, { magic: 'shear-testnet-v12' });
        assert.equal(txVerifyWeight(vote), W_TX + W_SEAL);
        assert.equal(vote.fs1, undefined);
        const priced = { ...vote, id: 'vault-vote-fee', fee: 1 };
        assert.equal(typedCommitSum(priced).reason, 'levy');
        const queuedVote = store.queueTx(vote);
        assert.equal(queuedVote.ok, false);
        assert.equal(queuedVote.reason, 'vote_retired');
        const voteTpl = await mine(store, who.dest);
        assert.equal(voteTpl.txs.some((row) => row.id === vote.id), false);
        voteSealed = true;
      }
    });
  }

  it('rejects a second spend of a vault tag in-block, in the next block, and on a send', async () => {
    assert.ok(tagLock, 'newest lock');
    const twin = { ...tagLock.tx, id: `${tagLock.tx.id}-twin` };
    const together = await Promise.resolve(blockVerdict(store, who.dest, [tagLock.tx, twin]));
    assert.equal(together.ok, false);
    assert.equal(together.reason, 'admit_link_tag');
    const later = await Promise.resolve(blockVerdict(store, who.dest, twin));
    assert.equal(later.reason, 'admit_link_tag');
    assert.equal(store.queueTx(twin).reason, 'admit_link_tag');
    const H = nextHeight();
    const anchor = walletAnchor(H);
    const view = liveAt(anchor);
    const fresh = view.coins[0];
    assert.ok(fresh, 'a live coin remains');
    const back20 = hash20FromAddress(who.dest);
    const total = fresh.v;
    let fee = LEVY_FLOOR_UNITS;
    let outs = null;
    let draft = null;
    const ph = placeholders(1);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const room = total - fee;
      outs = [
        hiddenOut(room, back20, who.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ];
      draft = compactTx({
        id: 'vault-tag-send',
        kind: 'send',
        anchor,
        fee,
        vin: ph.vin,
        vout: outs,
        fs1: ph.fs1,
        admit_proofs: ph.proofs,
        excess: Buffer.alloc(32, 255),
      });
      const need = levyNeed(draft);
      if (fee >= need && fee <= LEVY_CAP_NANOS) break;
      fee = need + rangeSlack(outs);
      draft = null;
    }
    const spentCoin = coins.find((c) => spent.has(c.commit.toString('hex')));
    const live = store.anchorNote(anchor);
    let index = -1;
    for (let i = 0; i < live.n; i += 1) {
      if (Buffer.from(asU8(live.commits[i])).equals(spentCoin.commit)) index = i;
    }
    assert.ok(index >= 0, 'spent coin still in the anchor set');
    const proven = fs1ProveSpend({
      live,
      anchor,
      indices: [index],
      xs: [spentCoin.x],
      tx: draft,
      magic: MAGIC_TESTNET,
    });
    assert.ok(proven, 'send prove');
    const excess = kernelExcess(outs, [{ r: spentCoin.r, t: proven.t[0] }]);
    const send = compactTx({
      id: 'vault-tag-send',
      kind: 'send',
      anchor,
      fee: draft.fee,
      vin: [{ commit: Buffer.from(proven.proofs[0].cTilde) }],
      vout: outs,
      fs1: proven.fs1,
      admit_proofs: proven.proofs,
      excess,
    });
    assert.equal(store.queueTx(send).reason, 'admit_link_tag');
    const verdict = await Promise.resolve(blockVerdict(store, who.dest, send));
    assert.equal(verdict.reason, 'admit_link_tag');
  });

  it('a withdraw before the tranche epoch end is refused and the levy is due', async () => {
    assert.equal(voteSealed, true);
    const H = nextHeight();
    const anchor = walletAnchor(H);
    const view = liveAt(anchor);
    const use = view.coins.slice(0, 1);
    assert.equal(use.length, 1);
    const total = use[0].v;
    const amount = 1;
    const ph = placeholders(1);
    const d20 = hash20FromAddress(who.dest);
    let fee = LEVY_FLOOR_UNITS;
    let outs = null;
    let draft = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const room = total - fee;
      outs = [
        {
          ...sealNote(amount, { dest20: d20, kind: 'withdraw' }),
          kind: 'withdraw',
          dest20: Buffer.from(d20),
        },
        hiddenOut(room, d20, who.base, 'send'),
      ];
      draft = compactTx({
        id: 'vault-withdraw-note',
        kind: 'withdraw',
        anchor,
        fee,
        programId: RESERVE_PROGRAM,
        // A withdraw names its lock by portalId only. payoutPortalId is vote_leak (325b50f5).
        portalId,
        withdrawNonce: Buffer.alloc(32, 9).toString('hex'),
        vin: ph.vin,
        vout: outs,
        fs1: ph.fs1,
        admit_proofs: ph.proofs,
        excess: Buffer.alloc(32, 255),
      });
      const need = levyNeed(draft);
      if (fee >= need && fee <= LEVY_CAP_NANOS) break;
      fee = need + rangeSlack(outs);
      draft = null;
    }
    const proven = fs1ProveSpend({
      live: view.live,
      anchor,
      indices: [use[0].index],
      xs: [use[0].x],
      tx: draft,
      magic: MAGIC_TESTNET,
    });
    assert.ok(proven, 'withdraw prove');
    const excess = kernelExcess(outs, [{ r: use[0].r, t: proven.t[0] }]);
    const tx = compactTx({
      id: 'vault-withdraw-note',
      kind: 'withdraw',
      anchor,
      fee: draft.fee,
      programId: RESERVE_PROGRAM,
      portalId,
      withdrawNonce: Buffer.alloc(32, 9).toString('hex'),
      vin: [{ commit: Buffer.from(proven.proofs[0].cTilde) }],
      vout: outs,
      fs1: proven.fs1,
      admit_proofs: proven.proofs,
      excess,
    });
    // The payout is dest20. `to` on a withdraw is the address, which is vote_leak.
    tx.dest20 = Buffer.from(d20);
    tx.ownerPub = who.id.spendPub.toString('hex');
    signSpendTx(tx, who.id.privateKey, { magic: 'shear-testnet-v12' });
    assert.equal(txVerifyWeight(tx), W_TX + W_FS1_BASE + W_FS1_PER_INPUT + W_OUT * 2);
    assert.equal(levyTaxed(tx), true);
    assert.equal(levyTaxed({ ...tx, mint: true }), true);
    const heightBefore = store.tip().height;
    const verdict = await appendBuilt(store, who.dest, [tx]);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'insufficient');
    assert.equal(store.tip().height, heightBefore);
  });
});

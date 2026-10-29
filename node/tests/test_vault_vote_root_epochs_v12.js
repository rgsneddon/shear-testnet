/**
 * Vault Y row (a): the leaf-vote root is the root frozen with the epoch's
 * census, keyed by epoch. The claim root stays keyed by period.
 *
 * One real regtest chain (bits 4, every header mined under ShearHash), three
 * epochs, real FS-1 π locks, real leaf votes, one real claim and one real
 * withdraw:
 *   - lock L1 in epoch 0 votes in epoch 0;
 *   - L1 claims period 1 against the period-1 root;
 *   - period 2's claim root is frozen in epoch 0 (block 480);
 *   - epoch 1 opens; L2 locks in epoch 1, after period 2; L1 withdraws;
 *   - epoch 2 opens. L2 votes in epoch 2. L1, withdrawn before epoch 2's
 *     start, is refused, including with a proof against the period-2 root.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeHeader } from '../../crypto/header.js';
import { newIdentity, encodeDest, hash20FromAddress, destCommitFromSpendPub } from '../../crypto/address.js';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { admitScalarFromSeed, attachAdmitPub } from '../../crypto/admit.js';
import {
  asU8, commit, kernelExcess, openedCoinbaseNanos, pointBytes, proveRange, randomScalar, scalarBytes,
  sealHiddenNote, sealNote,
} from '../../crypto/note.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { walletAnchor, txDigestV3 } from '../../crypto/admit_v3.js';
import {
  FS1_RECORD_BYTES, FS1_WIRE, fs1BlobLen, fs1ProveSpend, resetFs1Tree, txBodyDigestFs1,
} from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import { signSpendTx } from '../../crypto/spend.js';
import {
  applyLeafVote, buildFundedWithdraw, cloneVault, chainPeriodIndex, consensusUnlockPeriod, lockUnlockOf,
  leafEpochsToBurn, portalIdFromDest20, portalBlindFromSeed, leafStubNanos, proveLockEquality,
  provePrincipalOpen, rewardClaimTx, signWithdrawReward,
} from '../../crypto/reserve_vault.js';
import { proveLeafRetire, proveLeafVote, proveVaultReward, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { censusOf, proposalId } from '../../crypto/leaf_vote.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
import { createRegtestStore } from './regtest_store.js';

const T0 = 1_700_000_000_000;
const STEP_MS = 15 * 60_000;
const REGTEST_TRIES = 8_192;

function payer(tag) {
  const id = newIdentity();
  const commit20 = destCommitFromSpendPub(id.spendPub);
  const dest = encodeDest(commit20, id.admitBase);
  return {
    tag,
    id,
    dest,
    spendSeed: id.spendSeed,
    base: id.admitBase,
    pub: Buffer.from(id.spendPub).toString('hex'),
    key: id.privateKey,
    portalId: portalIdFromDest20(hash20FromAddress(dest), portalBlindFromSeed(id.spendSeed)),
  };
}

function stampOf(store) {
  const tip = store.tip();
  return tip ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) : T0;
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

function hiddenChange(nanos, dest20, admitBase) {
  let note = attachAdmitPub(sealHiddenNote(nanos, { dest20, kind: 'send', admitBase }), { admitBase });
  note = { ...note, kind: 'send', dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  delete note.valueProof;
  return note;
}

describe('vault vote root is the epoch census root (regtest, three epochs)', { concurrency: false, timeout: 1_800_000 }, () => {
  if (!fs1NativeLoaded()) {
    it('needs the native FS-1 addon', () => assert.fail('shear_admit FS-1 addon is not loaded'));
    return;
  }
  const A = payer('A');
  const B = payer('B');
  const coins = [];
  const spent = new Set();
  let dir;
  let store;
  let magic;
  let genesis = 0;
  let L1 = null;
  let L2 = null;
  // The live root right after L1, the only leaf until L2.
  let rootL1 = '';

  /** One regtest block, its header mined under ShearHash at the sealed bits. */
  async function mine(who, now = null) {
    const at = now == null ? stampOf(store) + 90_000 : now;
    const want = regtestBitsOverride(MAGIC_REGTEST);
    const { tpl } = store.template({ miner: who.dest, bits: want, shareBits: 4, now: at });
    assert.equal(tpl.bits, want, 'template seals the regtest bits');
    const found = await mineHeaderParallel(tpl.header, tpl.bits, REGTEST_TRIES, 1);
    assert.ok(found && found.block, `regtest pow h=${tpl.height}`);
    const got = await Promise.resolve(store.append({
      header: found.header,
      txs: tpl.txs,
      samples: tpl.samples,
      miner: who.dest,
      shareBatch: tpl.shareBatch || [],
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }));
    assert.equal(got.ok, true, `append ${got.reason || ''} ${got.error || ''} h=${tpl.height}`);
    const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
    if (pot && pot.r) {
      coins.push({
        r: Buffer.from(asU8(pot.r)),
        v: openedCoinbaseNanos(pot),
        commit: Buffer.from(asU8(pot.commit)),
        x: admitScalarFromSeed(who.spendSeed, pot),
        who,
      });
    }
    return tpl;
  }

  /** The vote root the census froze for epoch e. */
  const voteRootOf = (e) => String(censusOf(store.reserveVault, e)?.root || '');

  let turn = 0;
  const next = () => (turn++ % 2 === 0 ? A : B);

  async function mineTo(height) {
    while (store.tip().height < height) await mine(next());
  }

  /** Walk the clock to targetMs, then one block past it so the epoch rolls. */
  async function rollTo(targetMs, epoch) {
    let guard = 0;
    while (stampOf(store) < targetMs) {
      guard += 1;
      assert.ok(guard < 2000, 'clock');
      await mine(next(), Math.min(targetMs, stampOf(store) + STEP_MS));
    }
    for (let i = 0; i < 3 && Number(store.reserveVault.currentEpoch) !== epoch; i += 1) {
      await mine(next(), stampOf(store) + 90_000);
    }
    assert.equal(Number(store.reserveVault.currentEpoch), epoch, `epoch ${epoch} rolled`);
  }

  function liveCoins(who) {
    const height = store.tip().height + 1;
    const anchor = walletAnchor(height);
    assert.ok(anchor, `anchor at ${height}`);
    const live = store.anchorNote(anchor);
    assert.ok(live && live.n >= 1, `anchor ${anchor}`);
    const at = new Map();
    for (let i = 0; i < live.n; i += 1) at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
    const out = [];
    for (const c of coins) {
      const key = c.commit.toString('hex');
      if (c.who !== who || spent.has(key) || !at.has(key)) continue;
      out.push({ ...c, index: at.get(key) });
    }
    return { anchor, live, coins: out };
  }

  function proveSpend(tx, use, anchor, live, outs) {
    const proven = fs1ProveSpend({
      live, anchor, indices: use.map((c) => c.index), xs: use.map((c) => c.x), tx, magic,
    });
    assert.ok(proven, 'fs1 prove');
    const excess = kernelExcess(outs, use.map((c, i) => ({ r: c.r, t: proven.t[i] })));
    assert.ok(excess, 'excess');
    const settled = compactTx({
      ...tx,
      vin: proven.proofs.map((p) => ({ commit: Buffer.from(p.cTilde) })),
      vout: outs,
      fs1: proven.fs1,
      admit_proofs: proven.proofs,
      excess,
    });
    assert.ok(txBodyDigestFs1(settled, magic).equals(proven.digest), 'digest');
    return settled;
  }

  /** One real FS-1 π lock, queued and mined. */
  async function lockOne(person, id) {
    const view = liveCoins(person);
    const use = view.coins.slice(-4);
    assert.equal(use.length, 4, `${id} inputs`);
    for (const c of use) spent.add(c.commit.toString('hex'));
    const total = use.reduce((s, c) => s + c.v, 0);
    const blind = randomScalar();
    const scalar = randomScalar();
    const clock = lockUnlockOf(store.reserveVault, stampOf(store));
    const unlock = consensusUnlockPeriod(clock.epoch);
    const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
    assert.ok(leaf, 'leaf');
    const funded = pointBytes(commit(PI_SHE_NANOS, blind));
    const range = proveRange(PI_SHE_NANOS, blind);
    const piProof = proveRange(0n, blind);
    const d20 = hash20FromAddress(person.dest);
    const ph = placeholders(4);
    let fee = LEVY_FLOOR_UNITS;
    let tx = null;
    for (let attempt = 0; attempt < 6 && !tx; attempt += 1) {
      const outs = [
        {
          kind: 'lock', commit: funded, rangeProof: range, r: scalarBytes(blind), dest20: Buffer.from(d20),
          portalId: person.portalId, viewTag: Buffer.from([1]),
        },
        hiddenChange(total - fee - PI_SHE_NANOS, d20, person.base),
      ];
      const draft = compactTx({
        id, kind: 'lock', anchor: view.anchor, fee, nanos: 0, programId: RESERVE_PROGRAM,
        portalId: person.portalId, ownerPub: person.pub, vaultLockNote: leaf.note, piProof,
        vin: ph.vin, vout: outs, fs1: ph.fs1, admit_proofs: ph.proofs,
      });
      const need = levyNeed(draft);
      if (fee >= need && fee <= LEVY_CAP_NANOS) tx = proveSpend(draft, use, view.anchor, view.live, outs);
      else fee = need + rangeSlack(outs);
    }
    assert.ok(tx, `${id} fee`);
    tx.dest20 = Buffer.from(d20);
    signSpendTx(tx, person.key, { magic: 'shear-testnet-v12' });
    delete tx.spendPub;
    delete tx.sig;
    delete tx.signature;
    const fund = proveLockEquality(funded, PI_SHE_NANOS, blind, tx, magic, 0);
    assert.ok(fund, 'fund');
    tx.vout.find((row) => String(row?.kind || '') === 'lock').fundProof = fund;
    resetFs1Tree();
    const queued = store.queueTx(tx);
    assert.equal(queued.ok, true, `${id} queue ${queued.reason}`);
    const tpl = await mine(person);
    assert.ok(tpl.txs.some((row) => row.id === id), `${id} mined`);
    return { who: person, leaf, scalar, blind, unlock, height: tpl.height };
  }

  /** A real leaf vote: the vote proof over `locks` plus an FS-1 fee spend. */
  function leafVote({ id, locks, which, epoch, payerOf }) {
    const proof = proveLeafVote({
      locks: locks.map((l) => ({ amount: PI_SHE_NANOS, scalar: l.scalar, blind: l.blind, unlockEpoch: l.unlock })),
      which,
      epoch,
      choice: 1,
      seq: 1,
      proposalId: proposalId(epoch, 'hb'),
      magic,
      dest20: hash20FromAddress(payerOf.dest),
    });
    assert.ok(proof, `${id} vote proof`);
    const view = liveCoins(payerOf);
    const use = view.coins.slice(-1);
    assert.equal(use.length, 1, `${id} fee input`);
    const d20 = hash20FromAddress(payerOf.dest);
    const ph = placeholders(1);
    let fee = LEVY_FLOOR_UNITS;
    let tx = null;
    for (let attempt = 0; attempt < 6 && !tx; attempt += 1) {
      const outs = [hiddenChange(use[0].v - fee, d20, payerOf.base)];
      const draft = compactTx({
        id, kind: 'leaf-vote', anchor: view.anchor, fee, programId: RESERVE_PROGRAM,
        voteProof: proof.blob, voteOutput: proof.note, choice: 1, voteSeq: 1, voteParam: 'hb',
        earnEpoch: epoch, vin: ph.vin, vout: outs, fs1: ph.fs1, admit_proofs: ph.proofs,
      });
      const need = levyNeed(draft);
      if (fee >= need && fee <= LEVY_CAP_NANOS) tx = proveSpend(draft, use, view.anchor, view.live, outs);
      else fee = need + rangeSlack(outs);
    }
    assert.ok(tx, `${id} fee`);
    return { tx, proof, use };
  }

  async function castAndMine(vote, id) {
    resetFs1Tree();
    const queued = store.queueTx(vote.tx, { nowMs: stampOf(store) });
    assert.equal(queued.ok, true, `${id} queue ${queued.reason}`);
    const tpl = await mine(next());
    assert.ok(tpl.txs.some((row) => row.id === id), `${id} mined`);
    for (const c of vote.use) spent.add(c.commit.toString('hex'));
  }

  function refused(vote, id) {
    const trial = applyLeafVote(cloneVault(store.reserveVault), vote.tx, store.tip().height + 1);
    assert.equal(trial.ok, false, `${id} applies`);
    resetFs1Tree();
    const queued = store.queueTx(vote.tx, { nowMs: stampOf(store) });
    assert.equal(queued.ok, false, `${id} queued`);
    return { trial: trial.reason, queue: queued.reason };
  }

  before(async () => {
    resetFs1Tree();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vote-root-'));
    store = createRegtestStore(dir, { bits: 4, lock: false });
    magic = store.magic;
    await mine(A, T0);
    await mineTo(100);
  });

  after(() => {
    closeMineWorkers();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('epoch 0: the first lock opens the census, and its own vote proves against it', async () => {
    L1 = await lockOne(A, 'lock-L1');
    genesis = Number(store.reserveVault.genesisMs);
    assert.ok(genesis > 0, 'vault genesis');
    assert.equal(Number(store.reserveVault.currentEpoch), 0);
    rootL1 = String(store.reserveVault.vaultLockRoot || '');
    const census = censusOf(store.reserveVault, 0);
    assert.ok(census && census.leafCount === 1, 'epoch-0 census counts L1');
    await mineTo(store.tip().height + 12);
    const vote = leafVote({ id: 'vote-L1-e0', locks: [L1], which: 0, epoch: 0, payerOf: A });
    assert.equal(vote.proof.rootHex, rootL1, 'proof is over the L1-only set');
    await castAndMine(vote, 'vote-L1-e0');
    assert.equal(voteRootOf(0), rootL1, 'epoch-0 vote root holds L1');
  });

  it('claims stay per period: L1 claims period 1 against the period-1 root', async () => {
    await mineTo(240);
    const root = String(store.reserveVault.epochStartRoots?.['1'] || '');
    assert.equal(root, store.reserveVault.vaultLockRoot, 'period-1 claim root holds L1');
    const proved = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, scalar: L1.scalar, blind: L1.blind, unlockEpoch: L1.unlock }],
      which: 0, rootEpoch: 1, earnEpoch: 1, bps: GENESIS_BPS, dest20: hash20FromAddress(B.dest), magic,
    });
    assert.ok(proved, 'claim proof');
    assert.equal(proved.rootHex, root, 'claim root');
    const claim = rewardClaimTx({ to: B.dest, vault: proved, id: 'claim-L1-p1', ownerKey: B.key });
    for (const k of ['to', 'from', 'portalId', 'payoutPortalId', 'full', 'spendPub']) delete claim[k];
    resetFs1Tree();
    const queued = store.queueTx(claim, { nowMs: stampOf(store) });
    assert.equal(queued.ok, true, `claim queue ${queued.reason}`);
    const tpl = await mine(next());
    assert.ok(tpl.txs.some((row) => row.id === 'claim-L1-p1'), 'claim mined');
  });

  it('epoch 1: L2 locks after period 2 froze, and L1 withdraws', async () => {
    await mineTo(481);
    const period2 = String(store.reserveVault.epochStartRoots?.['2'] || '');
    assert.equal(period2, rootL1, 'period-2 claim root is the L1-only root');
    await rollTo(genesis + RESERVE_EPOCH_MS, 1);
    assert.ok(store.tip().height > 480, 'epoch 1 opens after block 480');
    await mineTo(store.tip().height + 12);
    L2 = await lockOne(B, 'lock-L2');
    assert.equal(Number(store.reserveVault.currentEpoch), 1, 'L2 locked in epoch 1');
    await mineTo(store.tip().height + 12);

    // L1 unlocked at the end of epoch 0. Withdraw it inside epoch 1.
    const view = liveCoins(A);
    const use = view.coins.slice(-1);
    assert.equal(use.length, 1, 'withdraw change input');
    const now = stampOf(store) + 1_000;
    const stub = leafStubNanos(store.reserveVault, [L1.leaf.commit.toString('hex')]);
    const withdrawNanos = PI_SHE_NANOS + Number(stub);
    const d20 = hash20FromAddress(A.dest);
    const ph = placeholders(1);
    let fee = LEVY_FLOOR_UNITS;
    let body = null;
    for (let attempt = 0; attempt < 6 && !body; attempt += 1) {
      const receipt = attachAdmitPub(sealNote(withdrawNanos, { dest20: d20, kind: 'withdraw' }), { admitBase: A.base });
      receipt.kind = 'withdraw';
      receipt.dest20 = Buffer.from(d20);
      const change = hiddenChange(use[0].v - fee, d20, A.base);
      const draft = compactTx({
        id: 'withdraw-L1', kind: 'withdraw', anchor: view.anchor, fee, nanos: withdrawNanos,
        programId: RESERVE_PROGRAM, portalId: A.portalId, ownerPub: A.pub, dest20: Buffer.from(d20),
        vin: ph.vin, vout: [receipt, change], fs1: ph.fs1, admit_proofs: ph.proofs,
      });
      const need = levyNeed(draft);
      if (fee >= need && fee <= LEVY_CAP_NANOS) body = proveSpend(draft, use, view.anchor, view.live, [receipt, change]);
      else fee = need + rangeSlack([receipt, change]);
    }
    assert.ok(body, 'withdraw fee');
    body.nanos = withdrawNanos;
    body.dest20 = Buffer.from(d20);
    const period = chainPeriodIndex(store.reserveVault, now);
    const burn = leafEpochsToBurn(store.reserveVault, L1.leaf.note.toString('hex'), period);
    assert.ok(burn.length >= 1, `burn ${burn.join(',')}`);
    const retire = proveLeafRetire({
      scalar: L1.scalar, epochs: burn, leaf: L1.leaf.note, txBind: txDigestV3(body, magic), unlockEpoch: period,
    });
    assert.ok(retire, 'retire');
    body.retireProof = retire.proof || retire;
    body.principalProof = provePrincipalOpen(L1.leaf.commit, PI_SHE_NANOS, L1.blind, body, A.portalId, magic, L1.unlock);
    assert.ok(body.principalProof, 'principal');
    const built = buildFundedWithdraw(body);
    assert.ok(built, 'withdraw builder');
    built.dest20 = Buffer.from(d20);
    delete built.spendPub;
    delete built.sig;
    signWithdrawReward(built, A.key, {
      portalId: A.portalId, nanos: PI_SHE_NANOS, dest: Buffer.from(built.dest20).toString('hex'),
      state: store.reserveVault, nowMs: now,
    });
    for (const c of use) spent.add(c.commit.toString('hex'));
    resetFs1Tree();
    const queued = store.queueTx(built, { nowMs: now });
    assert.equal(queued.ok, true, `withdraw queue ${queued.reason}`);
    const tpl = await mine(A, now);
    assert.ok(tpl.txs.some((row) => row.id === 'withdraw-L1'), 'withdraw mined');
    assert.equal(Number(store.reserveVault.currentEpoch), 1, 'L1 withdrew in epoch 1');
    assert.equal(voteRootOf(1), rootL1, 'epoch-1 vote root is the L1-only set at its start');
  });

  it('epoch 2: the census root holds L2 and not L1; the period-2 claim root is untouched', async () => {
    await mineTo(store.tip().height + 12);
    await rollTo(genesis + 2 * RESERVE_EPOCH_MS, 2);
    const census = censusOf(store.reserveVault, 2);
    assert.ok(census && census.leafCount === 1, 'epoch-2 census counts L2 only');
    assert.equal(store.reserveVault.epochStartRoots['2'], rootL1, 'period-2 claim root unchanged');
    assert.notEqual(store.reserveVault.vaultLockRoot, rootL1, 'the live set moved: L2 in, L1 out');
    assert.equal(voteRootOf(2), store.reserveVault.vaultLockRoot, 'epoch-2 vote root is the live set at its start');
  });

  it('epoch 2: L2, locked in epoch 1, votes', async () => {
    await mineTo(store.tip().height + 12);
    const vote = leafVote({ id: 'vote-L2-e2', locks: [L2], which: 0, epoch: 2, payerOf: B });
    assert.equal(vote.proof.rootHex, store.reserveVault.vaultLockRoot, 'proof is over the live set {L2}');
    await castAndMine(vote, 'vote-L2-e2');
  });

  it('epoch 2: L1, withdrawn before epoch 2 began, is refused', async () => {
    await mineTo(store.tip().height + 12);
    // The only set L1 can still prove in is the stale L1-only root, which is
    // the period-2 claim root. That root is not epoch 2's vote root.
    const vote = leafVote({ id: 'vote-L1-e2', locks: [L1], which: 0, epoch: 2, payerOf: A });
    assert.equal(vote.proof.rootHex, store.reserveVault.epochStartRoots['2'], 'proof is against the period-2 root');
    const why = refused(vote, 'vote-L1-e2');
    assert.equal(why.trial, 'unsigned', `apply ${why.trial}`);
    // A proof over the live set at epoch 2's start would need L2's key.
    const tpl = await mine(next());
    assert.equal(tpl.txs.some((row) => row.id === 'vote-L1-e2'), false, 'refused vote not mined');
  });
});

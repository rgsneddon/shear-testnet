/**
 * A fresh peer replays the live chain, and a restart folds the same blocks.
 * The chain is one lock, one claim, one leaf vote, and one withdraw. The
 * vote spends a real FS-1 note. A second spend of that note is refused, and
 * a vote that carries the fee note is refused. The tally runs from the
 * census the chain committed.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { decodeHeader } from '../../crypto/header.js';
import { encodeWireBlock } from '../src/p2p.js';
import { newIdentity, encodeDest, hash20FromAddress, destCommitFromSpendPub } from '../../crypto/address.js';
import {
  GENESIS_BPS,
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
} from '../../crypto/asert.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { admitScalarFromSeed, attachAdmitPub } from '../../crypto/admit.js';
import {
  asU8,
  commit,
  kernelExcess,
  openedCoinbaseNanos,
  pointBytes,
  proveRange,
  randomScalar,
  scalarBytes,
  sealHiddenNote,
  sealNote,
} from '../../crypto/note.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { walletAnchor, txDigestV3 } from '../../crypto/admit_v3.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
  resetFs1Tree,
  txBodyDigestFs1,
} from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import { signSpendTx } from '../../crypto/spend.js';
import {
  applyLeafVote,
  applyReserveBlock,
  buildFundedWithdraw,
  cloneVault,
  chainPeriodIndex,
  consensusUnlockPeriod,
  lockUnlockOf,
  leafEpochsToBurn,
  portalIdFromDest,
  portalIdFromDest20,
  portalBlindFromSeed,
  leafStubNanos,
  proveLockEquality,
  provePrincipalOpen,
  rewardClaimTx,
  signWithdrawReward,
  supplyIdentity,
} from '../../crypto/reserve_vault.js';
import { auditCirculatingSupply } from '../src/supply.js';
import {
  proveLeafRetire,
  proveLeafVote,
  proveVaultReward,
  vaultLockNote,
} from '../../crypto/vault_reward_fs1.js';
import {
  censusOf,
  proposalId,
  storedStep,
  VOTE_FINALITY_BLOCKS,
  voteCloseHeight,
} from '../../crypto/leaf_vote.js';

const T0 = 1_700_000_000_000;

function payer() {
  const id = newIdentity();
  const commit20 = destCommitFromSpendPub(id.spendPub);
  const dest = encodeDest(commit20, id.admitBase);
  return {
    id,
    dest,
    spendSeed: id.spendSeed,
    base: id.admitBase,
    pub: Buffer.from(id.spendPub).toString('hex'),
    key: id.privateKey,
    // portalId = H(tag, dest20). r is not an input. The address hash does not match.
    portalId: portalIdFromDest20(hash20FromAddress(dest), portalBlindFromSeed(id.spendSeed)),
  };
}

function lastStamp(store) {
  const tip = store.tip();
  return tip ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) : T0;
}

let powSeq = 1;

function nextPow() {
  const hash = Buffer.alloc(32);
  hash.writeUInt32BE(powSeq, 28);
  powSeq += 1;
  return hash;
}

async function mine(store, dest, now) {
  const at = now == null ? Math.max(T0, lastStamp(store) + 90_000) : now;
  const { tpl } = store.template({ miner: dest, shareBits: 4, now: at });
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
  }, { trustedPowHash: nextPow(), skipSharePow: true }));
  assert.equal(got.ok, true, `append ${got.reason || ''} ${got.error || ''} h=${tpl.height}`);
  return { tpl, got };
}

async function advanceClock(store, dest, targetMs) {
  const step = 15 * 60_000;
  let guard = 0;
  while (lastStamp(store) < targetMs) {
    assert.ok(guard < 2000, 'clock');
    guard += 1;
    await mine(store, dest, Math.min(targetMs, lastStamp(store) + step));
  }
}

function potOf(tpl, who) {
  const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
  assert.ok(pot && pot.r, 'pot opening');
  return {
    r: Buffer.from(asU8(pot.r)),
    v: openedCoinbaseNanos(pot),
    commit: Buffer.from(asU8(pot.commit)),
    x: admitScalarFromSeed(who.spendSeed, pot),
    who,
  };
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
    proofs.push({
      admit_proof: true,
      v: FS1_WIRE,
      spendTag: Buffer.alloc(32, 255),
      blob,
      cTilde: Buffer.alloc(32, 255),
    });
  }
  return { fs1, proofs, vin: proofs.map(() => ({ commit: Buffer.alloc(32, 255) })) };
}

function liveCoins(store, coins, spent) {
  const height = store.tip().height + 1;
  const anchor = walletAnchor(height);
  assert.ok(anchor, `anchor at ${height}`);
  const live = store.anchorNote(anchor);
  assert.ok(live && live.n >= 1, `anchor ${anchor}`);
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
  return { anchor, live, coins: out };
}

function hiddenChange(nanos, dest20, admitBase) {
  let note = attachAdmitPub(sealHiddenNote(nanos, { dest20, kind: 'send', admitBase }), { admitBase });
  note = { ...note, kind: 'send', dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  delete note.valueProof;
  return note;
}

function proveSpend(tx, use, anchor, live, outs) {
  const proven = fs1ProveSpend({
    live,
    anchor,
    indices: use.map((c) => c.index),
    xs: use.map((c) => c.x),
    tx,
    magic: MAGIC_TESTNET,
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
  assert.ok(txBodyDigestFs1(settled, MAGIC_TESTNET).equals(proven.digest), 'digest');
  return settled;
}

describe('fresh peer and restart across lock, claim, vote, and withdraw', { concurrency: false, timeout: 1_800_000 }, () => {
  if (!fs1NativeLoaded()) {
    it('needs the native FS-1 addon', () => {
      assert.fail('shear_admit FS-1 addon is not loaded');
    });
    return;
  }

  const who = payer();
  const pay = payer();
  assert.equal(who.portalId.length, 64);
  assert.notEqual(who.portalId, portalIdFromDest(who.dest));
  assert.notEqual(pay.portalId, portalIdFromDest(pay.dest));
  let dir;
  let store;
  const coins = [];
  const spent = new Set();
  let locked = null;

  before(async () => {
    resetFs1Tree();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-sync-'));
    // The restart child takes the datadir lock, as a restarted node does.
    // This test process writes the book and does not hold it.
    store = createStore(dir, { lock: false });
    for (let n = 0; n < 4; n += 1) {
      const { tpl } = await mine(store, who.dest);
      coins.push(potOf(tpl, who));
    }
    // A second wallet. Its π lock stays live through the withdraw and the restart.
    for (let n = 0; n < 4; n += 1) {
      const { tpl } = await mine(store, pay.dest);
      coins.push(potOf(tpl, pay));
    }
    while (store.tip().height < 100) await mine(store, who.dest);
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function lockOne(person, id) {
    const view = liveCoins(store, coins, spent);
    const use = view.coins.filter((c) => c.who === person).slice(0, 4);
    assert.equal(use.length, 4, 'lock inputs');
    const total = use.reduce((s, c) => s + c.v, 0);
    const blind = randomScalar();
    const scalar = randomScalar();
    // The leaf unlock is the chain epoch at the header stamp. A later lock
    // sits in the next epoch, so period 0 would be commit_sum.
    const clock = lockUnlockOf(store.reserveVault, lastStamp(store));
    const unlock = consensusUnlockPeriod(clock.epoch);
    const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
    assert.ok(leaf, 'leaf');
    const funded = pointBytes(commit(PI_SHE_NANOS, blind));
    // The leaf is the funding output plus the unlock point. They are not the same commitment.
    assert.equal(leaf.commit.equals(funded), false, 'nonzero funding gap');
    const range = proveRange(PI_SHE_NANOS, blind);
    assert.ok(range, 'range');
    const piProof = proveRange(0n, blind);
    assert.ok(piProof, 'pi');
    const d20 = hash20FromAddress(person.dest);
    const ph = placeholders(4);
    let fee = LEVY_FLOOR_UNITS;
    let tx = null;
    let spentOuts = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const changeN = total - fee - PI_SHE_NANOS;
      assert.ok(changeN > 0, `lock change ${changeN}`);
      const outs = [
        {
          kind: 'lock',
          commit: funded,
          rangeProof: range,
          r: scalarBytes(blind),
          dest20: Buffer.from(d20),
          portalId: person.portalId,
          viewTag: Buffer.from([1]),
        },
        hiddenChange(changeN, d20, person.base),
      ];
      const draft = compactTx({
        id,
        kind: 'lock',
        anchor: view.anchor,
        fee,
        nanos: 0,
        programId: RESERVE_PROGRAM,
        portalId: person.portalId,
        ownerPub: person.pub,
        vaultLockNote: leaf.note,
        piProof,
        vin: ph.vin,
        vout: outs,
        fs1: ph.fs1,
        admit_proofs: ph.proofs,
      });
      const need = levyNeed(draft);
      if (fee >= need && fee <= LEVY_CAP_NANOS) {
        tx = proveSpend(draft, use, view.anchor, view.live, outs);
        spentOuts = outs;
        break;
      }
      const next = need + rangeSlack(outs);
      assert.ok(next > fee && next <= LEVY_CAP_NANOS, `lock levy ${need}`);
      fee = next;
    }
    assert.ok(tx, 'lock fee');
    // Current law: the queued lock carries portalId and dest20. The address is not on the wire.
    assert.equal(tx.to, undefined);
    tx.dest20 = Buffer.from(hash20FromAddress(person.dest));
    signSpendTx(tx, person.key);
    delete tx.spendPub;
    delete tx.sig;
    delete tx.signature;
    assert.equal(tx.spendPub, undefined, 'lock spendPub');
    assert.equal(tx.sig, undefined, 'lock sig');
    assert.equal(tx.signature, undefined, 'lock signature');
    const fund = proveLockEquality(funded, PI_SHE_NANOS, blind, tx, MAGIC_TESTNET, 0);
    assert.ok(fund, 'fund');
    assert.ok(tx.piProof, 'pi');
    const lockOut = tx.vout.find((row) => String(row?.kind || '') === 'lock');
    assert.ok(lockOut, 'lock out');
    lockOut.fundProof = fund;
    resetFs1Tree();
    const queued = store.queueTx(tx);
    assert.equal(queued.ok, true, `lock queue ${queued.reason}`);
    const sealed = await mine(store, who.dest);
    assert.ok(sealed.tpl.txs.some((row) => row.id === id), 'lock template');
    const wired = sealed.tpl.txs.find((row) => row.id === id);
    // The address binding moved onto dest20. `to` stays off the mined lock.
    assert.equal(wired.to, undefined, 'lock address stays off the wire');
    assert.equal(JSON.stringify(wired).includes('ssa1'), false, 'lock wire has no ssa1');
    const wiredLock = wired.vout.find((row) => String(row?.kind || '') === 'lock');
    const want20 = Buffer.from(hash20FromAddress(person.dest));
    assert.ok(Buffer.from(wiredLock.dest20).equals(want20), 'lock dest20');
    assert.ok(Buffer.from(wired.dest20).equals(want20), 'lock body dest20');
    for (const c of use) spent.add(c.commit.toString('hex'));
    const change = spentOuts[1];
    coins.push({
      r: Buffer.from(asU8(change.r)),
      v: total - tx.fee - PI_SHE_NANOS,
      commit: Buffer.from(asU8(change.commit)),
      x: admitScalarFromSeed(person.spendSeed, change),
      who: person,
    });
    return { who: person, leaf, scalar, blind, unlock };
  }

  function buildWithdraw(row, id, now) {
    const view = liveCoins(store, coins, spent);
    const use = view.coins.filter((c) => c.who === who).slice(0, 1);
    assert.equal(use.length, 1, `${id} change`);
    // Testnet day is 24 blocks, inside the 240-block period, so a mid-period
    // lock's arrival stub is part of the withdraw amount.
    const stub = leafStubNanos(store.reserveVault, [row.leaf.commit.toString('hex')]);
    assert.ok(stub > 0n, 'testnet arrival stub');
    const withdrawNanos = PI_SHE_NANOS + Number(stub);
    const d20 = hash20FromAddress(who.dest);
    const ph = placeholders(1);
    let fee = LEVY_FLOOR_UNITS;
    let body = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const changeN = use[0].v - fee;
      assert.ok(changeN > 0, `${id} withdraw change`);
      // Current law: the receipt opens to principal plus the arrival stub.
      // The principal proof still opens π. Supply releases π and mints the stub.
      const receipt = attachAdmitPub(sealNote(withdrawNanos, { dest20: d20, kind: 'withdraw' }), { admitBase: who.base });
      receipt.kind = 'withdraw';
      receipt.dest20 = Buffer.from(d20);
      const change = hiddenChange(changeN, d20, who.base);
      const draft = compactTx({
        id,
        kind: 'withdraw',
        anchor: view.anchor,
        fee,
        nanos: withdrawNanos,
        programId: RESERVE_PROGRAM,
        portalId: who.portalId,
        ownerPub: who.pub,
        dest20: Buffer.from(d20),
        vin: ph.vin,
        vout: [receipt, change],
        fs1: ph.fs1,
        admit_proofs: ph.proofs,
      });
      const need = levyNeed(draft);
      if (fee >= need && fee <= LEVY_CAP_NANOS) {
        body = proveSpend(draft, use, view.anchor, view.live, [receipt, change]);
        break;
      }
      fee = need + rangeSlack([receipt, change]);
    }
    assert.ok(body, `${id} withdraw fee`);
    // The posted body has portalId and dest20. `to` and payoutPortalId are not
    // on it, and the retire proof is bound to that body.
    body.nanos = withdrawNanos;
    body.dest20 = Buffer.from(d20);
    assert.equal(body.to, undefined, `${id} address`);
    assert.equal(body.payoutPortalId, undefined, `${id} payout portal`);
    const period = chainPeriodIndex(store.reserveVault, now);
    const burn = leafEpochsToBurn(store.reserveVault, row.leaf.note.toString('hex'), period);
    assert.equal(burn.length, 3, `${id} burn ${burn.join(',')}`);
    const retire = proveLeafRetire({
      scalar: row.scalar,
      epochs: burn,
      leaf: row.leaf.note,
      txBind: txDigestV3(body, MAGIC_TESTNET),
      unlockEpoch: period,
    });
    assert.ok(retire, `${id} retire`);
    body.retireProof = retire.proof || retire;
    body.principalProof = provePrincipalOpen(
      row.leaf.commit, PI_SHE_NANOS, row.blind, body, who.portalId, MAGIC_TESTNET, row.unlock,
    );
    assert.ok(body.principalProof, `${id} principal`);
    const built = buildFundedWithdraw(body);
    assert.ok(built, `${id} builder`);
    assert.equal(built.to, undefined, `${id} built address`);
    assert.equal(built.from, undefined, `${id} built from`);
    assert.equal(built.payoutPortalId, undefined, `${id} built payout`);
    built.dest20 = Buffer.from(d20);
    // An FS-1 withdraw is the SAL plus the owner reward signature. The
    // identity spend key on that body is vote_leak.
    delete built.spendPub;
    delete built.sig;
    // The owner signs π. The receipt above is π plus the arrival stub.
    const payoutHex = Buffer.from(built.dest20).toString('hex');
    signWithdrawReward(built, who.key, {
      portalId: who.portalId,
      nanos: PI_SHE_NANOS,
      dest: payoutHex,
      state: store.reserveVault,
      nowMs: now,
    });
    for (const c of use) spent.add(c.commit.toString('hex'));
    return built;
  }

  it('syncs a fresh peer and restarts across lock, claim, vote, and withdraw', async () => {
    locked = await lockOne(who, 'sync-lock');
    assert.ok(Number(store.reserveVault.genesisMs) > 0, 'genesis');
    while (store.tip().height < 240) await mine(store, who.dest);
    const root = String(store.reserveVault.epochStartRoots?.['1'] || '');
    assert.equal(root, store.reserveVault.vaultLockRoot, 'period root is the lock');
    const proved = proveVaultReward({
      locks: [{
        amount: PI_SHE_NANOS,
        scalar: locked.scalar,
        blind: locked.blind,
        unlockEpoch: locked.unlock,
      }],
      which: 0,
      rootEpoch: 1,
      earnEpoch: 1,
      bps: GENESIS_BPS,
      dest20: hash20FromAddress(pay.dest),
    });
    assert.ok(proved, 'claim proof');
    assert.equal(proved.rootHex, root, 'claim root');
    const claim = rewardClaimTx({
      to: pay.dest,
      vault: proved,
      id: 'sync-claim',
      ownerKey: pay.key,
    });
    delete claim.to;
    delete claim.from;
    delete claim.portalId;
    delete claim.payoutPortalId;
    // `full` and `spendPub` are not wire fields. The reward signature stays.
    delete claim.full;
    delete claim.spendPub;
    resetFs1Tree();
    const claimQueued = store.queueTx(claim, { nowMs: lastStamp(store) });
    assert.equal(claimQueued.ok, true, `claim queue ${claimQueued.reason}`);
    const claimBlock = await mine(store, who.dest);
    assert.ok(claimBlock.tpl.txs.some((row) => row.id === 'sync-claim'), 'claim template');

    const genesis = Number(store.reserveVault.genesisMs);
    await advanceClock(store, who.dest, genesis + RESERVE_EPOCH_MS);
    await mine(store, who.dest, lastStamp(store) + 90_000);
    assert.equal(store.reserveVault.currentEpoch, 1, 'epoch rolled');
    const census = censusOf(store.reserveVault, 1);
    assert.ok(census && census.leafCount >= 1, 'production census');
    assert.equal(census.known, true);

    const voteProof = proveLeafVote({
      locks: [{
        amount: PI_SHE_NANOS,
        scalar: locked.scalar,
        blind: locked.blind,
        unlockEpoch: locked.unlock,
      }],
      which: 0,
      epoch: 1,
      choice: 1,
      seq: 1,
      proposalId: proposalId(1, 'hb'),
      dest20: hash20FromAddress(pay.dest),
    });
    assert.ok(voteProof, 'vote proof');
    assert.equal(voteProof.rootHex, store.reserveVault.epochStartRoots['1'], 'vote root');
    const view = liveCoins(store, coins, spent);
    const use = view.coins.filter((c) => c.who === who).slice(0, 1);
    assert.equal(use.length, 1, 'vote input');
    const d20 = hash20FromAddress(who.dest);
    const ph = placeholders(1);
    let fee = LEVY_FLOOR_UNITS;
    let vote = null;
    let voteOuts = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const changeN = use[0].v - fee;
      assert.ok(changeN > 0, `vote change ${changeN}`);
      const outs = [hiddenChange(changeN, d20, who.base)];
      const draft = compactTx({
        id: 'sync-vote',
        kind: 'leaf-vote',
        anchor: view.anchor,
        fee,
        programId: RESERVE_PROGRAM,
        voteProof: voteProof.blob,
        voteOutput: voteProof.note,
        choice: 1,
        voteSeq: 1,
        voteParam: 'hb',
        earnEpoch: 1,
        vin: ph.vin,
        vout: outs,
        fs1: ph.fs1,
        admit_proofs: ph.proofs,
      });
      const need = levyNeed(draft);
      if (fee >= need && fee <= LEVY_CAP_NANOS) {
        vote = proveSpend(draft, use, view.anchor, view.live, outs);
        voteOuts = outs;
        break;
      }
      fee = need + rangeSlack(outs);
    }
    assert.ok(vote, 'vote fee');
    assert.equal(vote.feeInput, undefined);
    assert.equal(vote.parentTx, undefined);
    assert.equal(vote.parent, undefined);
    assert.equal(vote.to, undefined);
    const leak = { ...vote, id: 'sync-vote-leak', feeInput: 'ab'.repeat(32), parentTx: 'sync-parent' };
    const leaked = store.queueTx(leak, { nowMs: lastStamp(store) });
    assert.equal(leaked.ok, false, 'leaked queue');
    assert.equal(leaked.reason, 'vote_leak');
    const leakedApply = applyLeafVote(store.reserveVault, leak, store.tip().height + 1);
    assert.equal(leakedApply.reason, 'vote_leak');
    resetFs1Tree();
    const voteQueued = store.queueTx(vote, { nowMs: lastStamp(store) });
    assert.equal(voteQueued.ok, true, `vote queue ${voteQueued.reason}`);
    const again = store.queueTx({ ...vote, id: 'sync-vote-again' }, { nowMs: lastStamp(store) });
    assert.equal(again.ok, false, 'double spend');
    assert.equal(again.reason, 'admit_link_tag');
    const voteBlock = await mine(store, who.dest);
    assert.ok(voteBlock.tpl.txs.some((row) => row.id === 'sync-vote'), 'vote template');
    for (const c of use) spent.add(c.commit.toString('hex'));
    const voteChange = voteOuts[0];
    coins.push({
      r: Buffer.from(asU8(voteChange.r)),
      v: use[0].v - vote.fee,
      commit: Buffer.from(asU8(voteChange.commit)),
      x: admitScalarFromSeed(who.spendSeed, voteChange),
      who,
    });
    let changeSeen = false;
    for (let i = 0; i < 40 && !changeSeen; i += 1) {
      const seen = liveCoins(store, coins, spent);
      changeSeen = seen.coins.some((c) => c.who === who);
      if (!changeSeen) await mine(store, who.dest);
    }
    assert.equal(changeSeen, true, 'vote change matured');

    // The second π lock is in the snapshot. The withdraw is only in the suffix.
    const liveLock = await lockOne(pay, 'sync-lock-live');
    assert.notEqual(liveLock.who.portalId, who.portalId, 'second portal');
    assert.ok(store.reserveVault.portals[liveLock.who.portalId], 'live portal');
    const snapNames = ['book.snap', 'vault.snap', 'reserve.json'];
    const snapHeight = store.tip().height;
    const snapSaved = snapNames.map((name) => fs.readFileSync(path.join(dir, name)));

    const wall = lastStamp(store) + 1_000;
    const withdrawTx = buildWithdraw(locked, 'sync-withdraw', wall);
    resetFs1Tree();
    const wdQueued = store.queueTx(withdrawTx, { nowMs: wall });
    assert.equal(wdQueued.ok, true, `withdraw queue ${wdQueued.reason}`);
    const wdBlock = await mine(store, who.dest, wall);
    assert.ok(wdBlock.tpl.txs.some((row) => row.id === 'sync-withdraw'), 'withdraw template');
    assert.ok(wdBlock.tpl.height > snapHeight, 'snap is below the withdraw');
    assert.ok(store.reserveVault.portals[who.portalId], 'portal');
    assert.ok(store.reserveVault.portals[liveLock.who.portalId], 'live portal after withdraw');

    const tallH = voteCloseHeight(census.openHeight, MAGIC_TESTNET) + VOTE_FINALITY_BLOCKS;
    // The tally height is not mined here. Applying it on the live vault
    // would enact the bonus into the next real block, which the chain replay
    // has no record of.
    const tallyVault = cloneVault(store.reserveVault);
    const tallied = applyReserveBlock({
      state: tallyVault,
      block: { height: tallH, txs: [{ coinbase: true, vout: [] }] },
      nowMs: genesis + RESERVE_EPOCH_MS + 60_000,
      height: tallH,
      genesisMs: genesis,
    });
    assert.equal(tallied.ok, true, tallied.reason);
    const step = storedStep(tallyVault, 1, proposalId(1, 'hb'));
    assert.equal(step.tallied, true);
    assert.equal(step.step, 1);

    // One more block, then put the pre-withdraw snap back. The suffix
    // contains the withdraw. The second π lock is already in that snap.
    await mine(store, who.dest);
    snapNames.forEach((name, i) => fs.writeFileSync(path.join(dir, name), snapSaved[i]));
    const liveTip = store.tip();
    const liveAudit = auditCirculatingSupply(store.blocks);
    const liveIdentity = supplyIdentity(store.reserveVault);
    assert.equal(liveAudit.status, 'verified', liveAudit.reason || 'live supply');
    assert.equal(liveIdentity.ok, true, 'live identity');
    const opener = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault_restart_open.js');
    const opened = spawnSync(process.execPath, [opener, dir], {
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(opened.status, 0, opened.stderr || opened.stdout || 'restart process');
    const line = String(opened.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    const restarted = JSON.parse(line);
    assert.equal(restarted.loadMode, 'suffix', restarted.loadMode);
    assert.equal(restarted.height, liveTip.height);
    assert.equal(restarted.hash, Buffer.from(liveTip.hash).toString('hex'));
    assert.equal(restarted.supplyStatus, 'verified', restarted.supplyStatus);
    assert.equal(restarted.circulating, liveAudit.circulatingNanos);
    assert.equal(restarted.identityOk, true, 'restart identity');
    assert.equal(restarted.principal, liveIdentity.principalNanos);
    assert.ok(Number(restarted.principal) > 0, 'restarted principal');
    assert.equal(restarted.vaultRoot, String(store.reserveVault.vaultLockRoot || ''));
    assert.deepEqual(restarted.portals, Object.keys(store.reserveVault.portals || {}).sort());
    assert.ok(restarted.portals.includes(who.portalId), 'restart portal');
    assert.ok(restarted.portals.includes(liveLock.who.portalId), 'restart live portal');
    // A fresh peer reads the wire in its own process. It does not append
    // the parent's block objects, and it does not rebuild the portal id.
    const wirePath = path.join(dir, 'wire-blocks.jsonl');
    const wireBody = store.blocks.map((block) => JSON.stringify(encodeWireBlock(block))).join('\n');
    fs.writeFileSync(wirePath, `${wireBody}\n`);
    const wireChild = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault_wire_open.js');
    const wired = spawnSync(process.execPath, [wireChild, wirePath], {
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(wired.status, 0, wired.stderr || wired.stdout || 'wire process');
    const wireLine = String(wired.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    const peer = JSON.parse(wireLine);
    assert.equal(peer.height, store.tip().height, 'wire height');
    assert.equal(peer.hash, Buffer.from(liveTip.hash).toString('hex'), 'wire hash');
    assert.equal(peer.lockTo, false, 'wire lock has no address');
    assert.equal(peer.lockSsa1, false, 'wire lock has no ssa1');
    assert.equal(peer.lockDest20, true, 'wire lock carries dest20');
    const wire20 = Buffer.from(hash20FromAddress(who.dest)).toString('hex');
    assert.ok(peer.lockDest20s.includes(wire20), 'wire lock dest20');
    assert.ok(peer.portals.includes(who.portalId), 'wire portal');
  });
});

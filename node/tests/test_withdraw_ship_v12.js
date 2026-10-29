/**
 * A withdraw enters through queueTx only when it spends an FS-1 note and
 * carries retire and principal proofs. Twenty-two of those are one past
 * the 64-DLEQ block cap: 21 are mined, and the 22nd is in the next block.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { decodeHeader } from '../../crypto/header.js';
import { newIdentity, encodeDest, hash20FromAddress, destCommitFromSpendPub } from '../../crypto/address.js';
import {
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
import { walletAnchor } from '../../crypto/admit_v3.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
  resetFs1Tree,
  txBodyDigestFs1,
} from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import { txDigestV3 } from '../../crypto/admit_v3.js';
import { signSpendTx } from '../../crypto/spend.js';
import {
  buildFundedWithdraw,
  chainPeriodIndex,
  consensusUnlockPeriod,
  leafEpochsToBurn,
  leafStubNanos,
  portalIdFromDest20,
  proveLockEquality,
  provePrincipalOpen,
  signWithdrawReward,
  withdrawMintId,
} from '../../crypto/reserve_vault.js';
import {
  proveLeafRetire,
  vaultLockNote,
} from '../../crypto/vault_reward_fs1.js';

const T0 = 1_700_000_000_000;
const N = 22;

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
    portalId: portalIdFromDest20(hash20FromAddress(dest)),
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

/**
 * The median of eleven headers has to stay inside two hours of the next
 * stamp. A step of fifteen minutes keeps that median close enough to walk
 * a four-day epoch without tripping the bits check.
 */
async function advanceClock(store, dest, targetMs) {
  const step = 15 * 60_000;
  let guard = 0;
  while (lastStamp(store) < targetMs) {
    assert.ok(guard < 2000, 'clock');
    guard += 1;
    const want = Math.min(targetMs, lastStamp(store) + step);
    await mine(store, dest, want);
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
  // compactTx drops r. The excess is the wallet's blinds, computed on the
  // notes before they are sealed.
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

describe('shipped withdraws', { concurrency: false, timeout: 1_800_000 }, () => {
  if (!fs1NativeLoaded()) {
    it('needs the native FS-1 addon', () => {
      assert.fail('shear_admit FS-1 addon is not loaded');
    });
    return;
  }

  const owners = Array.from({ length: N }, () => payer());
  let dir;
  let store;
  const coins = [];
  const spent = new Set();
  const leaves = [];

  before(async () => {
    resetFs1Tree();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-withdraw-ship-'));
    store = createStore(dir);
    for (let i = 0; i < N; i += 1) {
      for (let n = 0; n < 4; n += 1) {
        const { tpl } = await mine(store, owners[i].dest);
        coins.push(potOf(tpl, owners[i]));
      }
    }
    while (store.tip().height < 100) {
      await mine(store, owners[0].dest);
    }
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function lockOne(who, id) {
    const view = liveCoins(store, coins, spent);
    const use = view.coins.filter((c) => c.who === who).slice(0, 4);
    assert.equal(use.length, 4, `${id} inputs`);
    const total = use.reduce((s, c) => s + c.v, 0);
    const blind = randomScalar();
    const scalar = randomScalar();
    const unlock = consensusUnlockPeriod(0);
    const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
    assert.ok(leaf, 'leaf');
    const funded = pointBytes(commit(PI_SHE_NANOS, blind));
    const range = proveRange(PI_SHE_NANOS, blind);
    assert.ok(range, 'range');
    const d20 = hash20FromAddress(who.dest);
    const ph = placeholders(4);
    let fee = LEVY_FLOOR_UNITS;
    let tx = null;
    let spentOuts = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const changeN = total - fee - PI_SHE_NANOS;
      assert.ok(changeN > 0, `${id} change ${changeN}`);
      const outs = [
        {
          kind: 'lock',
          commit: funded,
          rangeProof: range,
          r: scalarBytes(blind),
          dest20: Buffer.from(d20),
          portalId: who.portalId,
          viewTag: Buffer.from([1]),
        },
        hiddenChange(changeN, d20, who.base),
      ];
      const draft = compactTx({
        id,
        kind: 'lock',
        anchor: view.anchor,
        fee,
        nanos: 0,
        programId: RESERVE_PROGRAM,
        portalId: who.portalId,
        ownerPub: who.pub,
        vaultLockNote: leaf.note,
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
      assert.ok(next > fee && next <= LEVY_CAP_NANOS, `${id} levy ${need}`);
      fee = next;
    }
    assert.ok(tx, `${id} fee`);
    // Compact lock. `to` is vote_leak. The wallet lock carries lockAuth
    // and no spendPub or signature.
    tx.dest20 = Buffer.from(hash20FromAddress(who.dest));
    signSpendTx(tx, who.key, { magic: 'shear-testnet-v12' });
    delete tx.spendPub;
    delete tx.sig;
    delete tx.signature;
    assert.equal(tx.spendPub, undefined, `${id} spendPub`);
    assert.equal(tx.sig, undefined, `${id} sig`);
    assert.equal(tx.signature, undefined, `${id} signature`);
    // The leaf amount is the public constant π. The fund proof opens the
    // lock commitment to that constant so supply can count the note payment.
    const fund = proveLockEquality(funded, PI_SHE_NANOS, blind, tx, MAGIC_TESTNET, 0);
    assert.ok(fund, `${id} fund`);
    const lockOut = tx.vout.find((row) => String(row?.kind || '') === 'lock');
    assert.ok(lockOut, `${id} lock out`);
    lockOut.fundProof = fund;
    assert.equal(tx.from, undefined);
    resetFs1Tree();
    const queued = store.queueTx(tx);
    assert.equal(queued.ok, true, `${id} queue ${queued.reason}`);
    const sealed = await mine(store, who.dest);
    assert.ok(sealed.tpl.txs.some((row) => row.id === id), `${id} template`);
    for (const c of use) spent.add(c.commit.toString('hex'));
    const change = spentOuts[1];
    coins.push({
      r: Buffer.from(asU8(change.r)),
      v: total - tx.fee - PI_SHE_NANOS,
      commit: Buffer.from(asU8(change.commit)),
      x: admitScalarFromSeed(who.spendSeed, change),
      who,
    });
    leaves.push({ who, leaf, scalar, blind, unlock });
  }

  function buildWithdraw(row, id, now) {
    const { who, leaf, scalar, blind } = row;
    const view = liveCoins(store, coins, spent);
    const use = view.coins.filter((c) => c.who === who).slice(0, 1);
    assert.equal(use.length, 1, `${id} change`);
    const d20 = hash20FromAddress(who.dest);
    // The principal proof opens π. The receipt is π plus this leaf's arrival stub.
    const stub = leafStubNanos(store.reserveVault, [leaf.commit.toString('hex')]);
    assert.ok(stub > 0n, `${id} arrival stub`);
    const withdrawNanos = PI_SHE_NANOS + Number(stub);
    const ph = placeholders(1);
    let fee = LEVY_FLOOR_UNITS;
    let body = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const changeN = use[0].v - fee;
      assert.ok(changeN > 0, `${id} withdraw change`);
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
    // The posted body has portalId and dest20. The address is not on the wire.
    body.nanos = withdrawNanos;
    body.dest20 = Buffer.from(d20);
    assert.equal(body.to, undefined, `${id} address`);
    assert.equal(body.payoutPortalId, undefined, `${id} payout portal`);
    const period = chainPeriodIndex(store.reserveVault, now);
    const burn = leafEpochsToBurn(store.reserveVault, leaf.note.toString('hex'), period);
    assert.equal(burn.length, 3, `${id} burn ${burn.join(',')}`);
    const retire = proveLeafRetire({
      scalar,
      epochs: burn,
      leaf: leaf.note,
      txBind: txDigestV3(body, MAGIC_TESTNET),
      unlockEpoch: period,
    });
    assert.ok(retire, `${id} retire`);
    body.retireProof = retire.proof || retire;
    body.principalProof = provePrincipalOpen(
      leaf.commit, PI_SHE_NANOS, blind, body, who.portalId, MAGIC_TESTNET, row.unlock,
    );
    assert.ok(body.principalProof, `${id} principal`);
    const built = buildFundedWithdraw(body);
    assert.ok(built, `${id} builder`);
    assert.equal(built.from, undefined);
    assert.equal(built.to, undefined, `${id} built address`);
    assert.equal(built.payoutPortalId, undefined, `${id} built payout`);
    built.dest20 = Buffer.from(d20);
    // An FS-1 withdraw authorises with the SAL and the owner rewardSig.
    // spendPub on that body is the identity key, and consensus refuses it.
    delete built.spendPub;
    delete built.sig;
    // The owner signs π. The receipt is π plus the arrival stub.
    signWithdrawReward(built, who.key, {
      portalId: who.portalId,
      nanos: PI_SHE_NANOS,
      dest: Buffer.from(d20).toString('hex'),
      state: store.reserveVault,
      nowMs: now,
    });
    assert.ok(built.rewardSig, `${id} sig`);
    for (const c of use) spent.add(c.commit.toString('hex'));
    return { tx: built, now };
  }

  it('queues a funded withdraw into a block the EVM accepts, and holds the 22nd for the next block', async () => {
    for (let i = 0; i < N; i += 1) {
      await lockOne(owners[i], `ship-lock-${i}`);
    }
    const genesis = Number(store.reserveVault.genesisMs);
    await advanceClock(store, owners[0].dest, genesis + RESERVE_EPOCH_MS);
    const wall = lastStamp(store) + 1_000;
    assert.ok(wall < genesis + 2 * RESERVE_EPOCH_MS, 'withdraw stays in the release epoch');
    const queued = [];
    for (let i = 0; i < N; i += 1) {
      const built = buildWithdraw(leaves[i], `ship-wd-${i}`, wall);
      resetFs1Tree();
      const got = store.queueTx(built.tx, { nowMs: wall });
      assert.equal(got.ok, true, `withdraw ${i} ${got.reason}`);
      queued.push(built.tx.id);
    }
    const logs = [];
    const orig = console.error;
    console.error = (...args) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    let first;
    try {
      first = store.template({ miner: owners[0].dest, shareBits: 4, now: wall });
    } finally {
      console.error = orig;
    }
    const ids = new Set((first.tpl.txs || []).map((row) => row.id));
    const included = queued.filter((id) => ids.has(id));
    const held = queued.filter((id) => !ids.has(id));
    assert.equal(included.length, 21, `included ${included.join(',') || 'none'} skipped ${logs.join(' | ')}`);
    assert.deepEqual(held, ['ship-wd-21']);
    const skipped = logs.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((row) => row && row.event === 'mempool_skip' && row.id === 'ship-wd-21');
    assert.equal(skipped && skipped.reason, 'retire_cap');
    const sealed = await mine(store, owners[0].dest, wall);
    assert.equal(sealed.got.ok, true);
    assert.ok(sealed.got.evmSession, 'evm session');
    for (const id of included) {
      assert.ok(sealed.tpl.txs.some((row) => row.id === id), id);
    }
    assert.equal(sealed.tpl.txs.some((row) => row.id === 'ship-wd-21'), false);
    const nextLogs = [];
    console.error = (...args) => {
      nextLogs.push(args.map((part) => String(part)).join(' '));
    };
    let second;
    try {
      second = store.template({
        miner: owners[0].dest,
        shareBits: 4,
        now: wall + 90_000,
      });
    } finally {
      console.error = orig;
    }
    assert.ok(second.tpl.txs.some((row) => row.id === 'ship-wd-21'), '22nd next block');
    const minted = withdrawMintId(owners[0].portalId, 1);
    assert.equal(store.reserveVault.mintedIds[minted], true);
    void nextLogs;
  });
});

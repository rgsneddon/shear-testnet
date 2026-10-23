/**
 * OPEN-5 A: lock, vote, and withdraw are funded only by an in-window ADMITv3
 * input. A public balance, a from/payer field, or a noteSpends list is not a
 * debit. One honest lock spends the coinbase note it names; the same tag
 * cannot be spent again.
 */
import { describe, it } from 'node:test';
import { fileCapMs } from './slow_caps.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { buildTemplate, verifyBlock } from '../src/chain.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, RESERVE_PROGRAM, TARGET_BLOCK_INTERVAL_MS, MTP_FUTURE_MS, MTP_WINDOW } from '../../crypto/asert.js';
import { epochMs } from '../../crypto/pot_sched.js';
import { newIdentity, encodeDest, hash20FromAddress, admitBaseFromAddress, destCommitFromSpendPub, ed25519PrivateFromSeed, ed25519RawPub } from '../../crypto/address.js';
import { lockTx, voteTx, withdrawTx, VOTE_HOLD, previewWithdraw, withdrawMintId, portalIdFromDest, portalBlindFromSeed, portalIdFromDest20, portalsFromSeed } from '../../crypto/reserve_vault.js';
import { signSpendTx, typedCommitSum, verifySpendSig } from '../../crypto/spend.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { levyNeed, splitLevy, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import {
  admitProveV3,
  admitPub,
  admitScalarFromSeed,
  fluxsetFromBlocks,
  blindCommit,
  attachAdmitPub,
  outputJoinsAdmitSet,
} from '../../crypto/admit.js';
import {
  asU8,
  pointBytes,
  pointFrom,
  randomScalar,
  scalarBytes,
  commit,
  kernelExcess,
  openedCoinbaseNanos,
  proveRange,
  sealCoinbaseNote,
  sealHiddenNote,
  sealNote,
} from '../../crypto/note.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { noteCommitSpendableNanos } from '../../crypto/coinbase_notes.js';
import { portalPrincipalNanos } from '../../crypto/reserve_vault.js';
import {
  buildFundedWithdraw,
  chainPeriodIndex,
  consensusUnlockPeriod,
  leafEpochsToBurn,
  leafStubNanos,
  lockUnlockOf,
  proveLockEquality,
  provePrincipalOpen,
  signWithdrawReward,
} from '../../crypto/reserve_vault.js';
import {
  walletAnchor,
  txDigestV3,
  admitV3Context,
  fundingJroot,
} from '../../crypto/admit_v3.js';
import { FS1_RECORD_BYTES, FS1_WIRE, fs1BlobLen, fs1ProveSpend, resetFs1Tree, txBodyDigestFs1 } from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import { proveLeafRetire, proveLeafVote, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { censusOf, proposalId } from '../../crypto/leaf_vote.js';

const KINDS = ['lock', 'vote', 'withdraw'];
const AMOUNTS = [1, 1_000_000, 50_000_000_000];
const T0 = 1_700_000_000_000;

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { id, dest, spendSeed: id.spendSeed, key: id.privateKey };
}

function typedTx(kind, dest, nanos, id) {
  if (kind === 'withdraw') return withdrawTx({ from: dest, to: dest, nanos, id });
  if (kind === 'vote') return voteTx({ from: dest, dest, choice: 'hold', id });
  return lockTx({ from: dest, to: dest, nanos, id });
}

function stripPayer(tx) {
  delete tx.from;
  delete tx.payer;
  if (Array.isArray(tx.vin)) {
    tx.vin = tx.vin.map((v) => {
      if (!v || v.coinbase) return v;
      const next = { ...v };
      delete next.address;
      delete next.dest20;
      return next;
    });
  }
  return tx;
}

async function sealEmpty(store, dest, now, openings) {
  const { tpl } = store.template({ miner: dest, shareBits: 4, now });
  const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
  const opening = pot?.r && pot.commit
    ? { r: pot.r, v: openedCoinbaseNanos(pot), commit: Buffer.from(asU8(pot.commit)) }
    : null;
  const block = {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
  const got = await Promise.resolve(store.append(block, {
    trustedPowHash: easyPowHash(),
    skipSharePow: true,
  }));
  assert.equal(got.ok, true, `${got.reason || 'seal'}${got.error ? ` ${got.error}` : ''}`);
  if (openings && opening) openings.push({ height: store.tip().height, ...opening });
  return opening;
}

function anchorFlux(blocks, anchor) {
  return fluxsetFromBlocks((blocks || []).filter((b) => {
    const h = Number(b?.height || 0);
    return h > 0 && h <= anchor;
  }));
}

function indexOfCommit(blocks, anchor, commit) {
  const want = Buffer.from(asU8(commit));
  let index = 0;
  for (const b of blocks || []) {
    const h = Number(b?.height || 0);
    if (!(h > 0 && h <= anchor)) continue;
    for (const tx of b.txs || []) {
      for (const o of tx.vout || []) {
        if (!o?.admitPub) continue;
        const got = Buffer.from(asU8(o.commit || []));
        if (got.length === 32 && got.equals(want)) return { index, note: o, height: h };
        index += 1;
      }
    }
  }
  return { index: -1, note: null, height: 0 };
}

function proveFunded(tx, { x, index, flux, note, anchor, noteR }) {
  let fee = 0;
  let settled = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const t = randomScalar();
    const probe = admitProveV3({
      x,
      index,
      pubs: flux.pubs,
      commits: flux.commits,
      c: note.commit,
      t,
      ctx: Buffer.alloc(64, 9),
    });
    assert.ok(probe, `probe ${attempt}`);
    // The native tag is x·Hp(P). JS hash-to-curve is a different map, so the
    // digest uses the tag and C̃ the prover just emitted for this t.
    tx.fee = fee;
    tx.anchor = anchor;
    tx.vin = [{ commit: Buffer.from(probe.cTilde) }];
    tx.admit_proof = probe;
    const blinded = Buffer.from(blindCommit(note.commit, scalarBytes(t)));
    assert.deepEqual(Buffer.from(probe.cTilde), blinded, 'blindCommit');
    const digest = txDigestV3(tx, MAGIC_TESTNET);
    const ctx = admitV3Context({
      magic: MAGIC_TESTNET,
      anchor,
      root: fundingJroot(flux),
      n: flux.pubs.length,
      digest,
    });
    const real = admitProveV3({
      x,
      index,
      pubs: flux.pubs,
      commits: flux.commits,
      c: note.commit,
      t,
      ctx,
    });
    assert.ok(real, `prove ${attempt}`);
    assert.deepEqual(Buffer.from(real.spendTag), Buffer.from(probe.spendTag));
    assert.deepEqual(Buffer.from(real.cTilde), Buffer.from(probe.cTilde));
    tx.admit_proof = real;
    tx.vin = [{ commit: Buffer.from(real.cTilde) }];
    const need = levyNeed(tx);
    if (need === fee) {
      const rIn = note?.r || noteR;
      if (rIn) {
        const k = kernelExcess(tx.vout, [{ r: rIn, t: scalarBytes(t) }]);
        if (k) tx.excess = k;
      }
      settled = real;
      break;
    }
    fee = need;
  }
  assert.ok(settled, 'fee did not settle');
  assert.equal(tx.fee, levyNeed(tx));
  return settled;
}

function resealLock(tx, nanos) {
  const prev = tx.vout[0] || {};
  const d20 = Buffer.from(asU8(prev.dest20));
  const sealed = sealCoinbaseNote(nanos, { dest20: d20, kind: 'lock' });
  tx.vout = [{
    ...sealed,
    kind: 'lock',
    dest20: d20,
    portalId: prev.portalId || tx.portalId,
  }];
  tx.nanos = nanos;
}

/** Output opens to noteV − fee, and excess binds that sum to the spent note. */
function proveBalanced(tx, { x, index, flux, note, anchor, noteR, noteV }) {
  let fee = 0;
  let settled = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const out = noteV - fee;
    assert.ok(out > 0, `fee consumes the note ${noteV} fee ${fee}`);
    resealLock(tx, out);
    const t = randomScalar();
    tx.fee = fee;
    tx.anchor = anchor;
    const probe = admitProveV3({
      x,
      index,
      pubs: flux.pubs,
      commits: flux.commits,
      c: note.commit,
      t,
      ctx: Buffer.alloc(64, 9),
    });
    assert.ok(probe, `balance probe ${attempt}`);
    tx.vin = [{ commit: Buffer.from(probe.cTilde) }];
    tx.admit_proof = probe;
    tx.excess = kernelExcess(tx.vout, [{ r: noteR, t: scalarBytes(t) }]);
    assert.ok(tx.excess, 'excess');
    const digest = txDigestV3(tx, MAGIC_TESTNET);
    const ctx = admitV3Context({
      magic: MAGIC_TESTNET,
      anchor,
      root: fundingJroot(flux),
      n: flux.pubs.length,
      digest,
    });
    const real = admitProveV3({
      x,
      index,
      pubs: flux.pubs,
      commits: flux.commits,
      c: note.commit,
      t,
      ctx,
    });
    assert.ok(real, `balance prove ${attempt}`);
    tx.admit_proof = real;
    tx.vin = [{ commit: Buffer.from(real.cTilde) }];
    const need = levyNeed(tx);
    if (need === fee) {
      settled = real;
      break;
    }
    fee = need;
  }
  assert.ok(settled, 'balanced fee did not settle');
  assert.equal(tx.nanos + tx.fee, noteV);
  assert.equal(tx.fee, levyNeed(tx));
  return settled;
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function potOf(store, height) {
  const block = store.blocks.find((b) => Number(b.height) === height);
  return (block?.txs?.[0]?.vout || []).find((o) => o.kind === 'pot') || null;
}

function indexInFlux(flux, commit) {
  const want = Buffer.from(asU8(commit));
  for (let i = 0; i < (flux.commits || []).length; i += 1) {
    const got = Buffer.from(asU8(flux.commits[i]));
    if (got.length === want.length && got.equals(want)) return i;
  }
  return -1;
}

/** A real template block whose stored hash is the caller-chosen stand-in. */
function sealedTemplateBlock(store, dest, tx, hash) {
  const tip = store.tip();
  const { tpl } = store.template({
    miner: dest,
    shareBits: 4,
    now: headerTime(tip) + TARGET_BLOCK_INTERVAL_MS,
  });
  const stamp = headerTime({ header: tpl.header });
  const built = buildTemplate({
    prev: tip.hash,
    prevHeader: tip.header,
    prevBlock: tip,
    height: tip.height + 1,
    miner: dest,
    now: stamp,
    bits: Number(decodeHeader(Buffer.from(tpl.header)).bits),
    txs: [tx],
    parentBlocks: store.blocks,
  });
  return {
    header: built.header,
    txs: built.txs,
    samples: built.samples,
    shareBatch: built.shareBatch || [],
    miner: dest,
    aLeaves: built.aLeaves,
    bLeaves: built.bLeaves,
    rootA: built.rootA,
    rootB: built.rootB,
    weight: built.weight,
    hash,
  };
}

function forkVerdict(store, block) {
  return Promise.resolve(store.verifyFork(store.blocks.concat([block]), {
    trustBlockHash: true,
    skipSharePow: true,
    nowMs: Date.now(),
  }));
}

function resealReceipt(tx, nanos, kind) {
  const prev = tx.vout[0] || {};
  const raw = prev.dest20 || hash20FromAddress(tx.to || '');
  const d20 = Buffer.from(asU8(raw));
  const sealed = sealCoinbaseNote(nanos, { dest20: d20, kind });
  return {
    ...sealed,
    kind,
    dest20: d20,
    portalId: prev.portalId || tx.portalId,
  };
}

/** Receipt opens to receiptNanos. Hidden change is noteV − fee. Any note, any fee below it. */
function proveChanged(tx, { x, index, flux, note, anchor, noteR, noteV, receiptNanos, base }) {
  let fee = 0;
  let settled = null;
  const kind = String(tx.kind);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const changeN = noteV - fee;
    assert.ok(changeN > 0, `change ${noteV} ${fee}`);
    const sealedReceipt = resealReceipt(tx, receiptNanos, kind);
    const receipt = kind === 'withdraw'
      ? attachAdmitPub(sealedReceipt, { admitBase: base })
      : sealedReceipt;
    const d20 = Buffer.from(asU8(receipt.dest20));
    const change = attachAdmitPub(sealNote(changeN, { dest20: d20, kind: 'send' }), { admitBase: base });
    change.kind = 'send';
    change.dest20 = d20;
    tx.vout = [receipt, change];
    tx.nanos = receiptNanos;
    tx.fee = fee;
    tx.anchor = anchor;
    const t = randomScalar();
    const probe = admitProveV3({
      x,
      index,
      pubs: flux.pubs,
      commits: flux.commits,
      c: note.commit,
      t,
      ctx: Buffer.alloc(64, 9),
    });
    assert.ok(probe, `change probe ${attempt}`);
    tx.vin = [{ commit: Buffer.from(probe.cTilde) }];
    tx.admit_proof = probe;
    tx.excess = kernelExcess(tx.vout, [{ r: noteR, t: scalarBytes(t) }]);
    assert.ok(tx.excess, 'change excess');
    const digest = txDigestV3(tx, MAGIC_TESTNET);
    const ctx = admitV3Context({
      magic: MAGIC_TESTNET,
      anchor,
      root: fundingJroot(flux),
      n: flux.pubs.length,
      digest,
    });
    const real = admitProveV3({
      x,
      index,
      pubs: flux.pubs,
      commits: flux.commits,
      c: note.commit,
      t,
      ctx,
    });
    assert.ok(real, `change prove ${attempt}`);
    tx.admit_proof = real;
    tx.vin = [{ commit: Buffer.from(real.cTilde) }];
    const need = levyNeed(tx);
    if (need === fee) {
      settled = real;
      break;
    }
    fee = need;
  }
  assert.ok(settled, 'changed fee did not settle');
  assert.equal(tx.fee, levyNeed(tx));
  assert.equal(noteV, tx.fee + (noteV - tx.fee));
  const summed = typedCommitSum(tx);
  assert.equal(summed.ok, true, summed.reason || 'changed sum');
  const lean = typedCommitSum(compactTx(tx));
  assert.equal(lean.ok, true, lean.reason || 'changed compact');
  return settled;
}

function lifePayer() {
  const id = newIdentity();
  const commit20 = destCommitFromSpendPub(id.spendPub);
  const dest = encodeDest(commit20, id.admitBase);
  const portal = portalsFromSeed(id.spendSeed, 1)[0];
  const ownerKey = ed25519PrivateFromSeed(portal.spendSeed);
  const ownerPub = ed25519RawPub(ownerKey);
  return {
    id,
    dest,
    spendSeed: id.spendSeed,
    base: id.admitBase,
    pub: ownerPub.toString('hex'),
    key: ownerKey,
    portalId: portal.portalId,
    portalDest: Buffer.from(portal.dest20),
    spend20: destCommitFromSpendPub(ownerPub),
  };
}

function lifeStamp(store) {
  const tip = store.tip();
  return tip ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) : T0;
}

async function lifeMine(store, dest, now) {
  const at = now == null ? Math.max(T0, lifeStamp(store) + 90_000) : now;
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
  }, { trustedPowHash: easyPowHash(), skipSharePow: true }));
  assert.equal(got.ok, true, `life append ${got.reason || ''} ${got.error || ''} h=${tpl.height}`);
  return { tpl, got };
}

async function lifeAdvance(store, dest, targetMs) {
  let guard = 0;
  while (lifeStamp(store) < targetMs) {
    assert.ok(guard < 2000, 'clock');
    guard += 1;
    await lifeMine(store, dest, Math.min(targetMs, lifeStamp(store) + 15 * 60_000));
  }
}

function lifePot(tpl, who) {
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

function lifeSlack(outs) {
  let bytes = 0;
  for (const o of outs) if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  return Math.ceil((bytes * 2) / 2048) + 8;
}

function lifePh(k) {
  const fs1 = Buffer.alloc(fs1BlobLen(k), 255);
  fs1[0] = FS1_WIRE;
  const proofs = [];
  for (let i = 0; i < k; i += 1) {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
    blob[0] = FS1_WIRE;
    proofs.push({ blob, cTilde: Buffer.alloc(32, 255), spendTag: Buffer.alloc(32, 255) });
  }
  return { fs1, proofs, vin: proofs.map(() => ({ commit: Buffer.alloc(32, 255) })) };
}

function lifeCoins(store, coins, spent) {
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

function lifeChange(nanos, dest20, admitBase) {
  let note = attachAdmitPub(sealHiddenNote(nanos, { dest20, kind: 'send', admitBase }), { admitBase });
  note = { ...note, kind: 'send', dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  delete note.valueProof;
  return note;
}

function lifeProve(tx, use, anchor, live, outs) {
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

async function lifeLock(store, person, coins, spent, id) {
  const view = lifeCoins(store, coins, spent);
  const use = view.coins.filter((c) => c.who === person).slice(0, 4);
  assert.equal(use.length, 4, 'lock inputs');
  const total = use.reduce((s, c) => s + c.v, 0);
  const blind = randomScalar();
  const scalar = randomScalar();
  const clock = lockUnlockOf(store.reserveVault, lifeStamp(store));
  const unlock = consensusUnlockPeriod(clock.epoch);
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
  assert.ok(leaf, 'leaf');
  const funded = pointBytes(commit(PI_SHE_NANOS, blind));
  const range = proveRange(PI_SHE_NANOS, blind);
  assert.ok(range, 'range');
  const piProof = proveRange(0n, blind);
  assert.ok(piProof, 'pi');
  const change20 = hash20FromAddress(person.dest);
  const ph = lifePh(4);
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
        dest20: Buffer.from(person.portalDest),
        portalId: person.portalId,
        viewTag: Buffer.from([1]),
      },
      lifeChange(changeN, change20, person.base),
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
      tx = lifeProve(draft, use, view.anchor, view.live, outs);
      spentOuts = outs;
      break;
    }
    const next = need + lifeSlack(outs);
    assert.ok(next > fee && next <= LEVY_CAP_NANOS, `lock levy ${need}`);
    fee = next;
  }
  assert.ok(tx, 'lock fee');
  // The output dest is the one-time portal. The body dest is the owner key,
  // which is what the spend signature binds. The proof names this inclusion.
  tx.dest20 = Buffer.from(person.spend20);
  signSpendTx(tx, person.key);
  delete tx.spendPub;
  delete tx.sig;
  delete tx.signature;
  assert.equal(tx.spendPub, undefined, 'lock spendPub');
  assert.equal(tx.sig, undefined, 'lock sig');
  assert.equal(tx.signature, undefined, 'lock signature');
  const fund = proveLockEquality(funded, PI_SHE_NANOS, blind, tx, MAGIC_TESTNET, store.tip().height + 1);
  assert.ok(fund, 'fund');
  const lockOut = tx.vout.find((row) => String(row?.kind || '') === 'lock');
  assert.ok(lockOut, 'lock out');
  lockOut.fundProof = fund;
  // The π opening is what lets the portal join and open the chain epoch.
  // A hidden lock with no piProof stays a tranche and never starts the clock.
  // H(piProof) is already in the FS-1 digest, so this is the same proof.
  assert.ok(tx.piProof, 'pi');
  resetFs1Tree();
  const queued = store.queueTx(tx, { nowMs: lifeStamp(store) });
  assert.equal(queued.ok, true, `lock queue ${queued.reason}`);
  const sealed = await lifeMine(store, person.dest);
  assert.ok(sealed.tpl.txs.some((row) => row.id === id), 'lock template');
  for (const c of use) spent.add(c.commit.toString('hex'));
  const change = spentOuts[1];
  coins.push({
    r: Buffer.from(asU8(change.r)),
    v: total - tx.fee - PI_SHE_NANOS,
    commit: Buffer.from(asU8(change.commit)),
    x: admitScalarFromSeed(person.spendSeed, change),
    who: person,
  });
  return { leaf, scalar, blind, unlock };
}

async function lifeVote(store, person, coins, spent, row) {
  const voteProof = proveLeafVote({
    locks: [{
      amount: PI_SHE_NANOS,
      scalar: row.scalar,
      blind: row.blind,
      unlockEpoch: row.unlock,
    }],
    which: 0,
    epoch: 1,
    choice: 1,
    seq: 1,
    proposalId: proposalId(1, 'hb'),
    dest20: hash20FromAddress(person.dest),
  });
  assert.ok(voteProof, 'vote proof');
  assert.equal(voteProof.rootHex, store.reserveVault.epochStartRoots['1'], 'vote root');
  const view = lifeCoins(store, coins, spent);
  const use = view.coins.filter((c) => c.who === person).slice(0, 1);
  assert.equal(use.length, 1, 'vote input');
  const d20 = hash20FromAddress(person.dest);
  const ph = lifePh(1);
  let fee = LEVY_FLOOR_UNITS;
  let vote = null;
  let voteOuts = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const changeN = use[0].v - fee;
    assert.ok(changeN > 0, `vote change ${changeN}`);
    const outs = [lifeChange(changeN, d20, person.base)];
    const draft = compactTx({
      id: 'life-vote',
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
      vote = lifeProve(draft, use, view.anchor, view.live, outs);
      voteOuts = outs;
      break;
    }
    fee = need + lifeSlack(outs);
  }
  assert.ok(vote, 'vote fee');
  resetFs1Tree();
  const voteQueued = store.queueTx(vote, { nowMs: lifeStamp(store) });
  assert.equal(voteQueued.ok, true, `vote queue ${voteQueued.reason}`);
  const voteBlock = await lifeMine(store, person.dest);
  assert.ok(voteBlock.tpl.txs.some((t) => t.id === 'life-vote'), 'vote template');
  for (const c of use) spent.add(c.commit.toString('hex'));
  const voteChange = voteOuts[0];
  coins.push({
    r: Buffer.from(asU8(voteChange.r)),
    v: use[0].v - vote.fee,
    commit: Buffer.from(asU8(voteChange.commit)),
    x: admitScalarFromSeed(person.spendSeed, voteChange),
    who: person,
  });
  let changeSeen = false;
  for (let i = 0; i < 40 && !changeSeen; i += 1) {
    const seen = lifeCoins(store, coins, spent);
    changeSeen = seen.coins.some((c) => c.who === person);
    if (!changeSeen) await lifeMine(store, person.dest);
  }
  assert.equal(changeSeen, true, 'vote change matured');
}

function lifeWithdraw(store, person, coins, spent, row, id, now) {
  const view = lifeCoins(store, coins, spent);
  const use = view.coins.filter((c) => c.who === person).slice(0, 1);
  assert.equal(use.length, 1, `${id} change`);
  const stub = leafStubNanos(store.reserveVault, [row.leaf.commit.toString('hex')]);
  assert.ok(stub > 0n, 'testnet arrival stub');
  const withdrawNanos = PI_SHE_NANOS + Number(stub);
  const d20 = hash20FromAddress(person.dest);
  const ph = lifePh(1);
  let fee = LEVY_FLOOR_UNITS;
  let body = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const changeN = use[0].v - fee;
    assert.ok(changeN > 0, `${id} withdraw change`);
    const receipt = attachAdmitPub(sealNote(withdrawNanos, { dest20: d20, kind: 'withdraw' }), { admitBase: person.base });
    receipt.kind = 'withdraw';
    receipt.dest20 = Buffer.from(d20);
    const change = lifeChange(changeN, d20, person.base);
    const draft = compactTx({
      id,
      kind: 'withdraw',
      anchor: view.anchor,
      fee,
      nanos: withdrawNanos,
      programId: RESERVE_PROGRAM,
      portalId: person.portalId,
      ownerPub: person.pub,
      dest20: Buffer.from(d20),
      vin: ph.vin,
      vout: [receipt, change],
      fs1: ph.fs1,
      admit_proofs: ph.proofs,
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) {
      body = lifeProve(draft, use, view.anchor, view.live, [receipt, change]);
      break;
    }
    fee = need + lifeSlack([receipt, change]);
  }
  assert.ok(body, `${id} withdraw fee`);
  body.nanos = withdrawNanos;
  body.dest20 = Buffer.from(d20);
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
    row.leaf.commit, PI_SHE_NANOS, row.blind, body, person.portalId, MAGIC_TESTNET, row.unlock,
  );
  assert.ok(body.principalProof, `${id} principal`);
  const built = buildFundedWithdraw(body);
  assert.ok(built, `${id} builder`);
  built.dest20 = Buffer.from(d20);
  delete built.spendPub;
  delete built.sig;
  signWithdrawReward(built, person.key, {
    portalId: person.portalId,
    nanos: PI_SHE_NANOS,
    dest: Buffer.from(built.dest20).toString('hex'),
    state: store.reserveVault,
    nowMs: now,
  });
  for (const c of use) spent.add(c.commit.toString('hex'));
  return built;
}

describe('ADMITv3 note consumption', { timeout: fileCapMs(import.meta.url) }, () => {
  it('unfunded and public-debit typed txs never queue, at every amount', () => {
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v3-reject-'));
    const store = createStore(dir);
    try {
      for (const kind of KINDS) {
        for (const nanos of AMOUNTS) {
          const plain = typedTx(kind, who.dest, nanos, `${kind}-plain-${nanos}`);
          const queuedPlain = store.queueTx(plain);
          assert.equal(queuedPlain.ok, false, `${kind} ${nanos} ${queuedPlain.reason}`);
          // Current law: a lock or withdraw that still carries `to` or `from`
          // is vote_leak, ahead of admit version, the signature, and membership.
          // stripPayer removes from and payer and leaves `to`, so the debit
          // and bare bodies hit the same gate.
          if (kind === 'lock' || kind === 'withdraw') {
            assert.equal(queuedPlain.reason, 'vote_leak', `${kind} plain ${nanos} ${queuedPlain.reason}`);
            const debit = stripPayer(typedTx(kind, who.dest, nanos, `${kind}-debit-${nanos}`));
            debit.noteSpends = [{ commit: Buffer.alloc(32, 3), nanos }];
            const queuedDebit = store.queueTx(debit);
            assert.equal(queuedDebit.ok, false, `${kind} debit ${nanos}`);
            assert.equal(queuedDebit.reason, 'vote_leak', `${kind} debit ${nanos} ${queuedDebit.reason}`);
            const bare = stripPayer(typedTx(kind, who.dest, nanos, `${kind}-bare-${nanos}`));
            bare.vin = [{ commit: Buffer.alloc(32, nanos & 0xff) }];
            const queuedBare = store.queueTx(bare);
            assert.equal(queuedBare.ok, false, `${kind} bare ${nanos}`);
            assert.equal(queuedBare.reason, 'vote_leak', `${kind} bare ${nanos} ${queuedBare.reason}`);
            continue;
          }
          // Current law: the portal vote API is retired. A vote with no commit
          // vin is vote_retired, ahead of admit version.
          if (kind === 'vote') {
            assert.equal(queuedPlain.reason, 'vote_retired', `${kind} plain ${nanos} ${queuedPlain.reason}`);
          } else {
            assert.equal(queuedPlain.reason, 'admit_version', `${kind} plain ${nanos} ${queuedPlain.reason}`);
          }

          const debit = stripPayer(typedTx(kind, who.dest, nanos, `${kind}-debit-${nanos}`));
          debit.noteSpends = [{ commit: Buffer.alloc(32, 3), nanos }];
          const queuedDebit = store.queueTx(debit);
          assert.equal(queuedDebit.ok, false, `${kind} debit ${nanos}`);
          assert.equal(queuedDebit.reason, 'unsigned', `${kind} debit ${nanos} ${queuedDebit.reason}`);

          const bare = stripPayer(typedTx(kind, who.dest, nanos, `${kind}-bare-${nanos}`));
          bare.vin = [{ commit: Buffer.alloc(32, nanos & 0xff) }];
          const queuedBare = store.queueTx(bare);
          assert.equal(queuedBare.ok, false, `${kind} bare ${nanos}`);
          assert.equal(queuedBare.reason, 'admit_membership', `${kind} bare ${nanos} ${queuedBare.reason}`);
        }
      }
      assert.equal(store.blocks.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supply stays verified after a real lock, vote, and withdraw', { timeout: 600_000 }, async () => {
    assert.equal(fs1NativeLoaded(), true, 'native FS-1 addon');
    const who = lifePayer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v3-life-'));
    const store = createStore(dir);
    const coins = [];
    const spent = new Set();
    try {
      for (let n = 0; n < 4; n += 1) {
        const { tpl } = await lifeMine(store, who.dest);
        coins.push(lifePot(tpl, who));
      }
      while (store.tip().height < 100) await lifeMine(store, who.dest);
      const locked = await lifeLock(store, who, coins, spent, 'life-lock');
      // A hidden lock does not move the public integer. The live principal
      // is the commitment sum, and totalLockedNanos stays 0.
      const held = store.reserveVault.portals?.[who.portalId];
      assert.equal(held?.tranches?.length, 1, 'locked');
      assert.match(String(store.reserveVault.vaultPrincipalSum || ''), /^[0-9a-f]{64}$/);
      assert.equal(BigInt(store.reserveVault.totalLockedNanos || 0), 0n, 'public integer stays 0');
      while (store.tip().height < 240) await lifeMine(store, who.dest);
      assert.equal(String(store.reserveVault.epochStartRoots?.['1'] || ''), store.reserveVault.vaultLockRoot, 'period root');
      const genesis = Number(store.reserveVault.genesisMs);
      await lifeAdvance(store, who.dest, genesis + RESERVE_EPOCH_MS);
      // The boundary block enacts the ballot and stays on epoch 0. The
      // following block opens epoch 1. MTP can clamp one requested step,
      // so keep stepping until the roll lands.
      let rolls = 0;
      while (Number(store.reserveVault.currentEpoch) < 1 && rolls < 6) {
        rolls += 1;
        await lifeMine(store, who.dest, lifeStamp(store) + 15 * 60_000);
      }
      assert.equal(
        store.reserveVault.currentEpoch,
        1,
        `epoch rolled enacted=${store.reserveVault.bonusEnacted} start=${store.reserveVault.epochStartMs} tip=${lifeStamp(store)} genesis=${genesis}`,
      );
      const census = censusOf(store.reserveVault, 1);
      assert.ok(census && census.leafCount >= 1, 'census');
      await lifeVote(store, who, coins, spent, locked);
      const wall = lifeStamp(store) + 1_000;
      const withdrawTx = lifeWithdraw(store, who, coins, spent, locked, 'life-withdraw', wall);
      resetFs1Tree();
      const wdQueued = store.queueTx(withdrawTx, { nowMs: wall });
      assert.equal(wdQueued.ok, true, `withdraw queue ${wdQueued.reason}`);
      const wdBlock = await lifeMine(store, who.dest, wall);
      assert.ok(wdBlock.tpl.txs.some((row) => row.id === 'life-withdraw'), 'withdraw template');
      const released = store.reserveVault.portals?.[who.portalId];
      assert.equal(released?.tranches?.length || 0, 0, 'tranche released');
      assert.equal(String(store.reserveVault.vaultPrincipalSum || ''), '', 'principal sum cleared');
      assert.equal(BigInt(store.reserveVault.totalLockedNanos || 0), 0n, 'locked back to 0');
      const liveSupply = auditCirculatingSupply(store.blocks);
      assert.equal(liveSupply.status, 'verified', liveSupply.reason || String(liveSupply.differenceNanos));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FS-1 funding past the gate is commit_sum on the queue and on append, and the book stays supply-verified', { timeout: 180_000 }, async () => {
    // Stage 3b. An FS-1 lock at
    // height 17 is past the gate, so a nonzero output gap is commit_sum on
    // the queue and on append. The coinbase book that funded the note stays
    // supply-verified.
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v3-fs1-fund-'));
    const store = createStore(dir);
    try {
      for (let i = 0; i < 16; i += 1) {
        await sealEmpty(store, who.dest, T0 + i * TARGET_BLOCK_INTERVAL_MS, []);
      }
      assert.equal(store.tip().height, 16);
      const anchor = walletAnchor(17);
      assert.equal(anchor, 8);
      const live = store.anchorNote(anchor);
      assert.ok(live && live.n >= 1, `anchor ${anchor}`);
      const pot = store.blocks[0].txs[0].vout.find((o) => o.kind === 'pot');
      const want = Buffer.from(asU8(pot.commit));
      let index = -1;
      for (let i = 0; i < live.n; i += 1) {
        if (Buffer.from(asU8(live.commits[i])).equals(want)) index = i;
      }
      assert.ok(index >= 0, 'pot is inside the anchor');
      const coin = {
        index,
        r: Buffer.from(asU8(pot.r)),
        v: openedCoinbaseNanos(pot),
        x: admitScalarFromSeed(who.spendSeed, pot),
      };
      assert.ok(coin.v > 1_000_000, String(coin.v));
      const d20 = Buffer.from(asU8(hash20FromAddress(who.dest)));
      const portalId = portalIdFromDest20(d20, portalBlindFromSeed(who.spendSeed));
      assert.ok(portalId && portalId !== portalIdFromDest(who.dest));
      const ph = Buffer.alloc(fs1BlobLen(1), 255);
      ph[0] = FS1_WIRE;
      const placeholder = Buffer.alloc(FS1_RECORD_BYTES, 255);
      placeholder[0] = FS1_WIRE;
      const placeholders = [{
        admit_proof: true,
        v: FS1_WIRE,
        spendTag: Buffer.alloc(32, 255),
        blob: placeholder,
        cTilde: Buffer.alloc(32, 255),
      }];
      let fee = LEVY_FLOOR_UNITS;
      let outs = null;
      let draft = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const note = sealNote(1, { dest20: d20, kind: 'lock' });
        outs = [{ ...note, kind: 'lock', dest20: Buffer.from(d20), valueProof: { v: 1 } }];
        draft = compactTx({
          id: 'v3-fs1-mismatch',
          kind: 'lock',
          anchor,
          fee,
          programId: RESERVE_PROGRAM,
          portalId,
          vin: [{ commit: Buffer.alloc(32, 255) }],
          vout: outs,
          fs1: ph,
          admit_proofs: placeholders,
          excess: Buffer.alloc(32, 255),
        });
        const need = levyNeed(draft);
        if (fee >= need && fee <= LEVY_CAP_NANOS) break;
        fee = need;
        draft = null;
      }
      assert.ok(draft, 'fee did not settle');
      const proven = fs1ProveSpend({
        live,
        anchor,
        indices: [coin.index],
        xs: [coin.x],
        tx: draft,
        magic: MAGIC_TESTNET,
      });
      assert.ok(proven, 'fs1 prove');
      const tx = compactTx({
        id: 'v3-fs1-mismatch',
        kind: 'lock',
        anchor,
        fee: draft.fee,
        programId: RESERVE_PROGRAM,
        portalId,
        vin: [{ commit: Buffer.from(proven.proofs[0].cTilde) }],
        vout: outs,
        fs1: proven.fs1,
        admit_proofs: proven.proofs,
        excess: Buffer.alloc(32, 9),
      });
      tx.dest20 = Buffer.from(d20);
      signSpendTx(tx, who.key);
      delete tx.spendPub;
      delete tx.sig;
      delete tx.signature;
      assert.equal(tx.spendPub, undefined, 'mismatch spendPub');
      assert.equal(tx.sig, undefined, 'mismatch sig');
      assert.equal(tx.signature, undefined, 'mismatch signature');
      assert.equal(tx.to, undefined);
      const queued = store.queueTx(tx);
      assert.equal(queued.ok, false, queued.reason);
      assert.equal(queued.reason, 'commit_sum', queued.reason);
      const tip = store.tip();
      const built = buildTemplate({
        prev: tip.hash,
        prevHeader: tip.header,
        prevBlock: tip,
        height: tip.height + 1,
        miner: who.dest,
        now: T0 + 16 * TARGET_BLOCK_INTERVAL_MS,
        bits: Number(decodeHeader(Buffer.from(tip.header)).bits),
        txs: [tx],
        parentBlocks: store.blocks,
      });
      const appended = await Promise.resolve(store.append({
        header: built.header,
        txs: built.txs,
        samples: built.samples,
        shareBatch: built.shareBatch || [],
        miner: who.dest,
        aLeaves: built.aLeaves,
        bLeaves: built.bLeaves,
        rootA: built.rootA,
        rootB: built.rootB,
        weight: built.weight,
      }, { trustedPowHash: easyPowHash(), skipSharePow: true }));
      assert.equal(appended.ok, false, appended.reason);
      assert.equal(appended.reason, 'commit_sum', appended.reason);
      assert.equal(store.tip().height, 16);
      const liveSupply = auditCirculatingSupply(store.blocks);
      assert.equal(liveSupply.status, 'verified', liveSupply.reason || liveSupply.differenceNanos);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

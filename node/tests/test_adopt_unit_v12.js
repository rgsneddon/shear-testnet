/**
 * N-23. A heavier branch whose hash-bonus unit changes is adopted.
 * The unit is the one the chain walked, for any epoch length and any
 * starting unit. A constant unit does not describe that branch.
 */
import { describe, it } from 'node:test';
import { bluWallet, soloCoin, soloPay } from './support/blunote_mine.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileCapMs } from './slow_caps.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createRpc } from '../src/rpc.js';
import { shouldAdopt } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
  TARGET_BLOCK_INTERVAL_MS,
  MTP_FUTURE_MS,
  MTP_WINDOW,
} from '../../crypto/asert.js';
import { epochMs } from '../../crypto/pot_sched.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest, hash20FromAddress, admitBaseFromAddress, destCommitFromSpendPub } from '../../crypto/address.js';
import {
  outputJoinsAdmitSet,
  admitProveV3,
  admitPub,
  admitScalarFromSeed,
  fluxsetFromBlocks,
  attachAdmitPub,
} from '../../crypto/admit.js';
import { viewTagOf } from '../../crypto/dummy.js';
import {
  asU8,
  commit,
  pointBytes,
  scalarBytes,
  kernelExcess,
  openedCoinbaseNanos,
  proveRange,
  sealCoinbaseNote,
  sealHiddenNote,
  sealNote,
  randomScalar,
} from '../../crypto/note.js';
import {
  bonusUnitsBefore,
  consensusUnlockPeriod,
  lockTx,
  portalBlindFromSeed,
  portalIdFromDest,
  portalIdFromDest20,
  proveLockEquality,
  publicVaultView,
  voteTx,
  VOTE_INCREASE,
} from '../../crypto/reserve_vault.js';
import { signSpendTx, typedCommitSum } from '../../crypto/spend.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { packEpochBlock, unpackEpochBlock } from '../../crypto/chainbin.js';
import { walletAnchor, readyHeight, txDigestV3, admitV3Context, fundingJroot } from '../../crypto/admit_v3.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
  resetFs1Tree,
  txBodyDigestFs1,
} from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import { proveLeafVote, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import {
  censusOf,
  proposalId,
  storedStep,
  VOTE_FINALITY_BLOCKS,
  voteCloseHeight,
} from '../../crypto/leaf_vote.js';
import { VAULT_DAY_BLOCKS } from '../../crypto/vault_accrual.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const STEP = TARGET_BLOCK_INTERVAL_MS;

let powTag = 1;
function easyPow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag >>> 0, 4);
  powTag += 1;
  return h;
}

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { id, dest, spendSeed: id.spendSeed, key: id.privateKey };
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function blockFrom(tpl, hash) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    shareBatch: tpl.shareBatch || [],
    hash,
  };
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

function indexOfCommit(blocks, anchor, commit) {
  const want = Buffer.from(asU8(commit));
  let index = 0;
  for (const b of blocks || []) {
    const h = Number(b?.height || 0);
    if (!(h > 0 && h <= anchor)) continue;
    for (const tx of b.txs || []) {
      for (const o of tx.vout || []) {
        if (!outputJoinsAdmitSet(tx, o)) continue;
        const got = Buffer.from(asU8(o.commit || []));
        if (got.length === 32 && got.equals(want)) return { index, height: h };
        index += 1;
      }
    }
  }
  return { index: -1, height: 0 };
}

function anchorFlux(blocks, anchor) {
  return fluxsetFromBlocks((blocks || []).filter((b) => {
    const h = Number(b?.height || 0);
    return h > 0 && h <= anchor;
  }));
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

/** Chain.bin record a second node loads. Proof fields stay Buffers. */
function wireBlocks(list) {
  return (list || []).map((block) => unpackEpochBlock(packEpochBlock(block)));
}

function coveredFee(tx) {
  let sealed = tx;
  try { sealed = compactTx(structuredClone(tx)); } catch { sealed = tx; }
  return Math.max(levyNeed(tx), levyNeed(sealed));
}

function proveLock(tx, { x, index, flux, note, anchor, noteR, noteV }) {
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
    assert.ok(probe, `lock probe ${attempt}`);
    tx.vin = [{ commit: Buffer.from(probe.cTilde) }];
    tx.admit_proof = probe;
    tx.excess = kernelExcess(tx.vout, [{ r: noteR, t: scalarBytes(t) }]);
    assert.ok(tx.excess, 'lock excess');
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
    assert.ok(real, `lock prove ${attempt}`);
    tx.admit_proof = real;
    tx.vin = [{ commit: Buffer.from(real.cTilde) }];
    const need = coveredFee(tx);
    if (need === fee) {
      settled = real;
      break;
    }
    fee = need;
  }
  assert.ok(settled, 'lock fee did not settle');
  assert.equal(tx.nanos + tx.fee, noteV);
  assert.ok(tx.nanos > 0);
  return settled;
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

function proveVote(tx, { x, index, flux, note, anchor, noteR, noteV, base }) {
  let fee = 0;
  let settled = null;
  const kind = String(tx.kind);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const changeN = noteV - fee;
    assert.ok(changeN > 0, `vote change ${noteV} ${fee}`);
    const receipt = resealReceipt(tx, 0, kind);
    const d20 = Buffer.from(asU8(receipt.dest20));
    const change = attachAdmitPub(sealNote(changeN, { dest20: d20, kind: 'send' }), { admitBase: base });
    change.kind = 'send';
    change.dest20 = d20;
    tx.vout = [receipt, change];
    tx.nanos = 0;
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
    assert.ok(probe, `vote probe ${attempt}`);
    tx.vin = [{ commit: Buffer.from(probe.cTilde) }];
    tx.admit_proof = probe;
    tx.excess = kernelExcess(tx.vout, [{ r: noteR, t: scalarBytes(t) }]);
    assert.ok(tx.excess, 'vote excess');
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
    assert.ok(real, `vote prove ${attempt}`);
    tx.admit_proof = real;
    tx.vin = [{ commit: Buffer.from(real.cTilde) }];
    const need = coveredFee(tx);
    if (need === fee) {
      settled = real;
      break;
    }
    fee = need;
  }
  assert.ok(settled, 'vote fee did not settle');
  assert.equal(tx.fee, coveredFee(tx));
  const summed = typedCommitSum(tx);
  assert.equal(summed.ok, true, summed.reason || 'vote sum');
  assert.equal(typedCommitSum(compactTx(tx)).ok, true);
  return settled;
}

async function seal(store, dest, now) {
  const tip = store.tip();
  const { tpl } = store.template({ miner: dest, now });
  const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
  const opening = pot?.r && pot.commit
    ? { r: pot.r, v: openedCoinbaseNanos(pot), height: (tip?.height || 0) + 1 }
    : null;
  const pow = easyPow();
  const got = await store.append(blockFrom(tpl, pow), { trustedPowHash: pow, skipSharePow: true });
  assert.equal(got.ok, true, `${got.reason || 'seal'} at ${(tip?.height || 0) + 1}`);
  return opening;
}

async function mineUntil(store, dest, height, nowOf, openings) {
  while ((store.tip()?.height || 0) < height) {
    const tip = store.tip();
    const now = nowOf(tip);
    const got = await seal(store, dest, now);
    if (openings && got) openings.push(got);
  }
}

function nextSpendable(store, openings, used) {
  const includeAt = (store.tip()?.height || 0) + 1;
  const anchor = walletAnchor(includeAt);
  if (anchor == null) return null;
  for (const open of openings) {
    if (used.has(open.height)) continue;
    if (readyHeight(open.height) > includeAt) continue;
    const block = store.blocks.find((b) => Number(b.height) === open.height);
    const pot = block?.txs?.[0]?.vout?.find((o) => o.kind === 'pot');
    if (!pot?.commit) continue;
    const found = indexOfCommit(store.blocks, anchor, pot.commit);
    if (found.index < 0 || found.height !== open.height) continue;
    return { open, pot, found, anchor };
  }
  return null;
}

/** In-memory book with a real journal. Snaps stay off so the tally walk is linear. */
const FAST_BOOK = {
  snapEvery: 0,
  firstCheckpoint: 1_000_000,
  checkpointEvery: 1_000_000,
  diskJournal: true,
  pruneAfter: 1_000_000,
};

function phase(label, store) {
  const tip = store.tip();
  const unit = Number(store.reserveVault.liveHashBonusNanos);
  console.error(`phase ${label} h=${tip ? tip.height : 0} unit=${unit}`);
}

function whoOf() {
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
    portalId: portalIdFromDest20(hash20FromAddress(dest), portalBlindFromSeed(id.spendSeed)),
    blu: bluWallet(id.spendSeed),
  };
}

/**
 * R28: a coinbase pays no pot note. The block was mined solo with option
 * (b), so its pot is a record coin of who's wallet, found by its scan key.
 */
function potCoin(block, who) {
  const coin = soloCoin(who.blu, block);
  assert.ok(coin && coin.r, 'pot opening');
  return { r: coin.r, v: coin.v, commit: coin.commit, x: coin.x, who };
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
      blob,
      cTilde: Buffer.alloc(32, 255),
      spendTag: Buffer.alloc(32, 255),
    });
  }
  return { fs1, proofs, vin: proofs.map(() => ({ commit: Buffer.alloc(32, 255) })) };
}

function hiddenChange(nanos, dest20, admitBase) {
  let note = attachAdmitPub(sealHiddenNote(nanos, { dest20, kind: 'send', admitBase }), { admitBase });
  note = { ...note, kind: 'send', dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  delete note.valueProof;
  return note;
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

async function appendShare(store, dest, now, extra = {}) {
  const tip = store.tip();
  const at = now == null ? (tip ? headerTime(tip) + STEP : T0) : now;
  const { tpl } = store.template({ miner: dest, shareBits: 4, now: at, ...extra });
  const pow = easyPow();
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
  }, { trustedPowHash: pow, skipSharePow: true }));
  return { tpl, got, at };
}

async function mineOk(store, dest, now, extra = {}) {
  const sealed = await appendShare(store, dest, now, extra);
  assert.equal(sealed.got.ok, true, `append ${sealed.got.reason || ''} ${sealed.got.error || ''} h=${sealed.tpl.height}`);
  return sealed;
}

describe('v12 adopt keeps the walked hash-bonus unit', { timeout: fileCapMs(import.meta.url) }, () => {
  it('a heavier branch that changes the unit is adopted', { timeout: fileCapMs(import.meta.url) }, async () => {
    if (!fs1NativeLoaded()) assert.fail('shear_admit FS-1 addon is not loaded');
    const who = whoOf();
    assert.equal(who.portalId.length, 64);
    assert.notEqual(who.portalId, portalIdFromDest(who.dest));
    const heavyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-unit-heavy-'));
    const lightDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-unit-light-'));
    const coins = [];
    const spent = new Set();
    let locked = null;
    try {
      resetFs1Tree();
      // The reopen child below takes the datadir lock, as a restarted node
      // does. This test process writes the heavy book and does not hold it.
      const heavy = createStore(heavyDir, { ...FAST_BOOK, lock: false });
      for (let n = 0; n < 4; n += 1) {
        await mineOk(heavy, who.dest, undefined, soloPay(who.blu));
        coins.push(potCoin(heavy.tip(), who));
      }
      while (heavy.tip().height < 100) await mineOk(heavy, who.dest);
      phase('funded', heavy);

      const view = liveCoins(heavy, coins, spent);
      const use = view.coins.filter((c) => c.who === who).slice(0, 4);
      assert.equal(use.length, 4, 'lock inputs');
      const total = use.reduce((sum, c) => sum + c.v, 0);
      const blind = randomScalar();
      const scalar = randomScalar();
      const unlock = consensusUnlockPeriod(0);
      const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
      assert.ok(leaf, 'leaf');
      const funded = pointBytes(commit(PI_SHE_NANOS, blind));
      const range = proveRange(PI_SHE_NANOS, blind);
      assert.ok(range, 'range');
      const piProof = proveRange(0n, blind);
      assert.ok(piProof, 'pi');
      const d20 = hash20FromAddress(who.dest);
      const ph = placeholders(4);
      let fee = LEVY_FLOOR_UNITS;
      let lock = null;
      let lockOuts = null;
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
            portalId: who.portalId,
            viewTag: Buffer.from([1]),
          },
          hiddenChange(changeN, d20, who.base),
        ];
        const draft = compactTx({
          id: 'unit-lock',
          kind: 'lock',
          anchor: view.anchor,
          fee,
          nanos: 0,
          programId: RESERVE_PROGRAM,
          portalId: who.portalId,
          ownerPub: who.pub,
          vaultLockNote: leaf.note,
          piProof,
          vin: ph.vin,
          vout: outs,
          fs1: ph.fs1,
          admit_proofs: ph.proofs,
        });
        const need = levyNeed(draft);
        if (fee >= need && fee <= LEVY_CAP_NANOS) {
          lock = proveSpend(draft, use, view.anchor, view.live, outs);
          lockOuts = outs;
          break;
        }
        fee = need + rangeSlack(outs);
      }
      assert.ok(lock, 'lock fee');
      lock.dest20 = Buffer.from(d20);
      signSpendTx(lock, who.key);
      delete lock.spendPub;
      delete lock.sig;
      delete lock.signature;
      assert.equal(lock.spendPub, undefined, 'lock spendPub');
      assert.equal(lock.sig, undefined, 'lock sig');
      assert.equal(lock.signature, undefined, 'lock signature');
      const fund = proveLockEquality(funded, PI_SHE_NANOS, blind, lock, MAGIC_TESTNET, 0);
      assert.ok(fund, 'fund');
      assert.ok(lock.piProof, 'pi');
      const lockOut = lock.vout.find((row) => String(row?.kind || '') === 'lock');
      assert.ok(lockOut, 'lock out');
      lockOut.fundProof = fund;
      resetFs1Tree();
      const queuedLock = heavy.queueTx(lock);
      assert.equal(queuedLock.ok, true, queuedLock.reason || 'queue lock');
      const lockedSeal = await mineOk(heavy, who.dest);
      assert.ok(lockedSeal.tpl.txs.some((row) => row.id === 'unit-lock'), 'lock mined');
      for (const c of use) spent.add(c.commit.toString('hex'));
      const change = lockOuts[1];
      coins.push({
        r: Buffer.from(asU8(change.r)),
        v: total - lock.fee - PI_SHE_NANOS,
        commit: Buffer.from(asU8(change.commit)),
        x: admitScalarFromSeed(who.spendSeed, change),
        who,
      });
      locked = { scalar, blind, unlock };
      while (heavy.tip().height < 240) await mineOk(heavy, who.dest);
      const periodRoot = String(heavy.reserveVault.epochStartRoots?.['1'] || '');
      assert.equal(periodRoot, heavy.reserveVault.vaultLockRoot, 'period root is the lock');
      phase('period', heavy);

      const genesis = Number(heavy.reserveVault.genesisMs);
      assert.ok(genesis > 0, 'genesis');
      let clockGuard = 0;
      while (headerTime(heavy.tip()) < genesis + RESERVE_EPOCH_MS) {
        assert.ok(clockGuard < 2000, 'epoch 1 clock');
        clockGuard += 1;
        const prev = headerTime(heavy.tip());
        await mineOk(heavy, who.dest, Math.min(genesis + RESERVE_EPOCH_MS, prev + 15 * 60_000));
      }
      await mineOk(heavy, who.dest, headerTime(heavy.tip()) + STEP);
      assert.equal(heavy.reserveVault.currentEpoch, 1, 'epoch rolled');
      const census = censusOf(heavy.reserveVault, 1);
      assert.ok(census && census.known && census.leafCount >= 1, 'census');
      const closeH = voteCloseHeight(census.openHeight, MAGIC_TESTNET);
      assert.equal(closeH - census.openHeight, 3 * VAULT_DAY_BLOCKS, 'vote close is three vault days');
      phase('epoch1', heavy);

      const voteProof = proveLeafVote({
        locks: [{ amount: PI_SHE_NANOS, scalar: locked.scalar, blind: locked.blind, unlockEpoch: locked.unlock }],
        which: 0,
        epoch: 1,
        choice: -1,
        seq: 1,
        proposalId: proposalId(1, 'hb'),
        dest20: d20,
      });
      assert.ok(voteProof, 'down vote proof');
      assert.equal(voteProof.rootHex, periodRoot, 'vote root');
      const voteView = liveCoins(heavy, coins, spent);
      const voteUse = voteView.coins.filter((c) => c.who === who).slice(0, 1);
      assert.equal(voteUse.length, 1, 'vote input');
      const votePh = placeholders(1);
      let voteFee = LEVY_FLOOR_UNITS;
      let vote = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const changeN = voteUse[0].v - voteFee;
        assert.ok(changeN > 0, `vote change ${changeN}`);
        const outs = [hiddenChange(changeN, d20, who.base)];
        const draft = compactTx({
          id: 'unit-vote-down',
          kind: 'leaf-vote',
          anchor: voteView.anchor,
          fee: voteFee,
          programId: RESERVE_PROGRAM,
          voteProof: voteProof.blob,
          voteOutput: voteProof.note,
          choice: -1,
          voteSeq: 1,
          voteParam: 'hb',
          earnEpoch: 1,
          vin: votePh.vin,
          vout: outs,
          fs1: votePh.fs1,
          admit_proofs: votePh.proofs,
        });
        const need = levyNeed(draft);
        if (voteFee >= need && voteFee <= LEVY_CAP_NANOS) {
          vote = proveSpend(draft, voteUse, voteView.anchor, voteView.live, outs);
          break;
        }
        voteFee = need + rangeSlack(outs);
      }
      assert.ok(vote, 'vote fee');
      resetFs1Tree();
      const queuedVote = heavy.queueTx(vote, { nowMs: headerTime(heavy.tip()) });
      assert.equal(queuedVote.ok, true, queuedVote.reason || 'queue vote');
      const voted = await mineOk(heavy, who.dest);
      assert.ok(voted.tpl.txs.some((row) => row.id === 'unit-vote-down'), 'vote mined');
      phase('voted', heavy);

      const tallH = closeH + VOTE_FINALITY_BLOCKS;
      let talliedBlocks = 0;
      while (heavy.tip().height < tallH) {
        assert.equal(Number(heavy.reserveVault.liveHashBonusNanos), 1, 'unit moved before the tally');
        await mineOk(heavy, who.dest, headerTime(heavy.tip()) + STEP);
        talliedBlocks += 1;
        if (talliedBlocks % 200 === 0) phase('tally', heavy);
      }
      const step = storedStep(heavy.reserveVault, 1, proposalId(1, 'hb'));
      assert.equal(step.tallied, true, 'ballot tallied');
      assert.equal(step.step, -1, `down step ${step.step}`);
      assert.equal(Number(heavy.reserveVault.liveHashBonusNanos), 1, 'tally does not enact by itself');
      phase('tallied', heavy);

      const epoch2 = genesis + 2 * RESERVE_EPOCH_MS;
      let enactGuard = 0;
      while (Number(heavy.reserveVault.liveHashBonusNanos) === 1) {
        assert.ok(enactGuard < 400, `unit stayed 1 after ${enactGuard} enact blocks`);
        enactGuard += 1;
        const prev = headerTime(heavy.tip());
        const now = prev < epoch2 ? Math.min(epoch2, prev + 15 * 60_000) : prev + STEP;
        await mineOk(heavy, who.dest, now);
        if (enactGuard % 20 === 0) phase('enact', heavy);
      }
      assert.equal(Number(heavy.reserveVault.liveHashBonusNanos), 0, 'passed down vote enacts 0');
      phase('enacted', heavy);

      const zero = await appendShare(heavy, who.dest, headerTime(heavy.tip()) + STEP);
      assert.equal(zero.got.ok, true, `unit 0 append ${zero.got.reason || ''} ${zero.got.error || ''} h=${zero.tpl.height}`);
      assert.equal(Number(heavy.reserveVault.liveHashBonusNanos), 0, 'append revived the unit');
      const shown = Number(publicVaultView(heavy.reserveVault, headerTime(heavy.tip())).liveHashBonusNanos);
      assert.equal(shown, 0, 'reserve view revived the unit');
      const rpc = createRpc({ store: heavy, port: 0, host: '127.0.0.1' });
      try {
        const reserve = rpc.dispatch('getreserve', {});
        assert.equal(Number(reserve.liveHashBonusNanos), 0, 'getreserve revived the unit');
      } finally {
        await rpc.close();
      }
      const units = bonusUnitsBefore(heavy.blocks);
      assert.ok(units && units.length === heavy.blocks.length);
      assert.equal(units[units.length - 1], 0);
      assert.ok(units.some((unit) => unit === 1), 'walk lost the unit before the vote');
      const heavyTip = Buffer.from(heavy.tip().hash);
      const heavyHeight = heavy.tip().height;

      const light = createStore(lightDir, FAST_BOOK);
      const genesisIn = await Promise.resolve(light.ingest(wireBlocks(heavy.blocks.slice(0, 1)), {
        trustBlockHash: true,
        skipSharePow: true,
      }));
      assert.equal(genesisIn.ok, true, genesisIn.reason || 'genesis');
      assert.equal(shouldAdopt(light.blocks, heavy.blocks), true);
      const adopted = await Promise.resolve(light.ingest(wireBlocks(heavy.blocks), {
        trustBlockHash: true,
        skipSharePow: true,
      }));
      assert.equal(adopted.ok, true, `${adopted.reason || 'adopt'} at ${adopted.at}`);
      assert.equal(light.tip().height, heavyHeight);
      assert.ok(Buffer.from(light.tip().hash).equals(heavyTip));
      assert.equal(Number(light.reserveVault.liveHashBonusNanos), 0, 'adopt revived the unit');
      assert.deepEqual(bonusUnitsBefore(light.blocks), units);

      const opener = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hash_bonus_zero_open.js');
      const opened = spawnSync(process.execPath, [opener, heavyDir, who.dest], {
        encoding: 'utf8',
        timeout: 900_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(opened.status, 0, opened.stderr || opened.stdout || 'restart process');
      const line = String(opened.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
      const restarted = JSON.parse(line);
      assert.equal(restarted.before, 0, 'restart load revived the unit');
      assert.equal(restarted.view, 0, 'restart view revived the unit');
      assert.equal(restarted.rpc, 0, 'restart getreserve revived the unit');
      assert.equal(restarted.appendOk, true, `restart append ${restarted.reason}`);
      assert.equal(restarted.after, 0, 'restart append revived the unit');
    } finally {
      fs.rmSync(heavyDir, { recursive: true, force: true });
      fs.rmSync(lightDir, { recursive: true, force: true });
    }
  });
});

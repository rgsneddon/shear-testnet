/**
 * OPEN-5 A: lock, vote, and withdraw are funded only by an in-window ADMITv3
 * input. A public balance, a from/payer field, or a noteSpends list is not a
 * debit. One honest lock spends the coinbase note it names; the same tag
 * cannot be spent again.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { buildTemplate, verifyBlock } from '../src/chain.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_TESTNET, TARGET_BLOCK_INTERVAL_MS, MTP_FUTURE_MS, MTP_WINDOW } from '../../crypto/asert.js';
import { epochMs } from '../../crypto/pot_sched.js';
import { newIdentity, encodeDest, hash20FromAddress, admitBaseFromAddress } from '../../crypto/address.js';
import { lockTx, voteTx, withdrawTx, VOTE_HOLD, previewWithdraw, withdrawMintId, portalIdFromDest } from '../../crypto/reserve_vault.js';
import { signSpendTx, typedCommitSum, verifySpendSig } from '../../crypto/spend.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { levyNeed, splitLevy } from '../../crypto/levy.js';
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
  kernelExcess,
  openedCoinbaseNanos,
  sealCoinbaseNote,
  sealNote,
} from '../../crypto/note.js';
import { noteCommitSpendableNanos } from '../../crypto/coinbase_notes.js';
import { portalPrincipalNanos } from '../../crypto/reserve_vault.js';
import {
  walletAnchor,
  txDigestV3,
  admitV3Context,
} from '../../crypto/admit_v3.js';

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
      root: flux.jroot,
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
      root: flux.jroot,
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
      root: flux.jroot,
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

describe('ADMITv3 note consumption', () => {
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
          assert.equal(queuedPlain.reason, 'admit_version', `${kind} plain ${nanos} ${queuedPlain.reason}`);

          const debit = stripPayer(typedTx(kind, who.dest, nanos, `${kind}-debit-${nanos}`));
          debit.noteSpends = [{ commit: Buffer.alloc(32, 3), nanos }];
          const queuedDebit = store.queueTx(debit);
          assert.equal(queuedDebit.ok, false, `${kind} debit ${nanos}`);
          assert.equal(queuedDebit.reason, 'admit_version', `${kind} debit ${nanos} ${queuedDebit.reason}`);

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

  it('an in-window lock spends the original note, and a bad proof does not', { timeout: 7_200_000 }, async () => {
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v3-fund-'));
    const scratch = [];
    const store = createStore(dir);
    try {
      const readyAt = 17;
      const openings = [];
      let noteOpen = null;
      for (let i = 0; i < readyAt - 1; i += 1) {
        const opening = await sealEmpty(store, who.dest, T0 + i * TARGET_BLOCK_INTERVAL_MS, openings);
        if (!noteOpen && opening) noteOpen = opening;
      }
      assert.ok(noteOpen && noteOpen.v > AMOUNTS[AMOUNTS.length - 1], String(noteOpen && noteOpen.v));
      assert.equal(store.tip().height, readyAt - 1);
      const anchor = walletAnchor(readyAt);
      assert.equal(typeof anchor, 'number');
      assert.ok(anchor >= 8 && anchor % 8 === 0, String(anchor));

      const pot = store.blocks[0].txs[0].vout.find((o) => o.kind === 'pot');
      assert.ok(pot?.commit && pot.admitPub, 'pot enters J');
      const found = indexOfCommit(store.blocks, anchor, pot.commit);
      assert.equal(found.height, 1);
      assert.ok(found.index >= 0, 'pot is inside the anchor');
      const x = admitScalarFromSeed(who.spendSeed, pot);
      const expectP = Buffer.from(pointBytes(admitPub(x)));
      const gotP = Buffer.from(asU8(pot.admitPub));
      assert.deepEqual(gotP, expectP, 'pot key is the payer admit base');
      const flux = anchorFlux(store.blocks, anchor);
      assert.ok(flux.pubs.length >= found.index + 1);
      assert.ok(flux.jroot && Buffer.from(asU8(flux.jroot)).length === 32);

      assert.deepEqual(Buffer.from(asU8(pot.commit)), noteOpen.commit);
      const spend = { x, index: found.index, flux, note: pot, anchor, noteR: noteOpen.r };
      let mismatched = null;
      for (const nanos of AMOUNTS) {
        const mismatch = stripPayer(lockTx({
          from: who.dest,
          to: who.dest,
          nanos,
          id: `v3-mismatch-${nanos}`,
        }));
        proveFunded(mismatch, spend);
        signSpendTx(mismatch, who.key);
        const queuedMismatch = store.queueTx(mismatch);
        assert.equal(queuedMismatch.ok, false, `${nanos} ${queuedMismatch.reason}`);
        assert.equal(queuedMismatch.reason, 'commit_sum', `${nanos} ${queuedMismatch.reason}`);
        mismatched = mismatch;
      }
      const nowMis = T0 + (readyAt - 1) * TARGET_BLOCK_INTERVAL_MS;
      const tipMis = store.tip();
      const bitsMis = Number(decodeHeader(Buffer.from(tipMis.header)).bits);
      const builtMis = buildTemplate({
        prev: tipMis.hash,
        prevHeader: tipMis.header,
        prevBlock: tipMis,
        height: tipMis.height + 1,
        miner: who.dest,
        now: nowMis,
        bits: bitsMis,
        txs: [mismatched],
        parentBlocks: store.blocks,
      });
      const appendedMis = await Promise.resolve(store.append({
        header: builtMis.header,
        txs: builtMis.txs,
        samples: builtMis.samples,
        shareBatch: builtMis.shareBatch || [],
        miner: who.dest,
        aLeaves: builtMis.aLeaves,
        bLeaves: builtMis.bLeaves,
        rootA: builtMis.rootA,
        rootB: builtMis.rootB,
        weight: builtMis.weight,
      }, { trustedPowHash: easyPowHash(), skipSharePow: true }));
      assert.equal(appendedMis.ok, false, appendedMis.reason);
      assert.equal(appendedMis.reason, 'commit_sum', appendedMis.reason);
      assert.equal(store.tip().height, readyAt - 1);
      const vote = stripPayer(voteTx({
        from: who.dest,
        dest: who.dest,
        choice: 'hold',
        id: 'v3-vote-pot',
      }));
      proveFunded(vote, spend);
      signSpendTx(vote, who.key);
      const queuedVote = store.queueTx(vote);
      assert.equal(queuedVote.ok, false, queuedVote.reason);
      assert.equal(queuedVote.reason, 'commit_sum', queuedVote.reason);

      let unbalanced = null;
      for (const nanos of AMOUNTS) {
        const withdraw = stripPayer(withdrawTx({
          from: who.dest,
          to: who.dest,
          nanos,
          id: `v3-withdraw-pot-${nanos}`,
        }));
        proveFunded(withdraw, spend);
        assert.ok(withdraw.excess, `excess ${nanos}`);
        signSpendTx(withdraw, who.key);
        const queuedWithdraw = store.queueTx(withdraw);
        assert.equal(queuedWithdraw.ok, false, `${nanos} ${queuedWithdraw.reason}`);
        assert.equal(queuedWithdraw.reason, 'commit_sum', `${nanos} ${queuedWithdraw.reason}`);
        const parked = admitMempool(emptyMempool(), withdraw, { baseFee: 1 });
        assert.equal(parked.ok, false, `${nanos} ${parked.reason}`);
        assert.equal(parked.reason, 'commit_sum', `${nanos} ${parked.reason}`);
        unbalanced = withdraw;
      }
      const openedIn = noteOpen.v;
      const feeSpread = [0, 1, Math.floor(openedIn / 2), openedIn, openedIn + 1];
      for (const fee of feeSpread) {
        const trial = { ...unbalanced, fee, id: `v3-withdraw-fee-${fee}` };
        const summed = typedCommitSum(trial);
        if (fee === openedIn) {
          assert.equal(summed.ok, true, `${fee} ${summed.reason}`);
        } else {
          assert.equal(summed.ok, false, String(fee));
          assert.equal(summed.reason, 'commit_sum', `${fee} ${summed.reason}`);
        }
      }
      const tipBeforeFee = store.tip().height;
      const builtFee = buildTemplate({
        prev: store.tip().hash,
        prevHeader: store.tip().header,
        prevBlock: store.tip(),
        height: store.tip().height + 1,
        miner: who.dest,
        now: T0 + (readyAt - 1) * TARGET_BLOCK_INTERVAL_MS,
        bits: Number(decodeHeader(Buffer.from(store.tip().header)).bits),
        txs: [unbalanced],
        parentBlocks: store.blocks,
      });
      const appendedFee = await Promise.resolve(store.append({
        header: builtFee.header,
        txs: builtFee.txs,
        samples: builtFee.samples,
        shareBatch: builtFee.shareBatch || [],
        miner: who.dest,
        aLeaves: builtFee.aLeaves,
        bLeaves: builtFee.bLeaves,
        rootA: builtFee.rootA,
        rootB: builtFee.rootB,
        weight: builtFee.weight,
      }, { trustedPowHash: easyPowHash(), skipSharePow: true }));
      assert.equal(appendedFee.ok, false, appendedFee.reason);
      assert.equal(appendedFee.reason, 'commit_sum', appendedFee.reason);
      assert.equal(store.tip().height, tipBeforeFee);

      const lock = stripPayer(lockTx({
        from: who.dest,
        to: who.dest,
        nanos: 1,
        id: 'v3-lock-balanced',
      }));
      const proof = proveBalanced(lock, { ...spend, noteR: noteOpen.r, noteV: noteOpen.v });
      assert.ok(lock.nanos > 0 && lock.nanos !== noteOpen.v);
      assert.ok(!AMOUNTS.includes(lock.nanos), String(lock.nanos));
      signSpendTx(lock, who.key);
      const tag = Buffer.from(proof.spendTag).toString('hex');

      const stale = stripPayer(lockTx({
        from: who.dest,
        to: who.dest,
        nanos: AMOUNTS[1],
        id: `v3-stale-${AMOUNTS[1]}`,
      }));
      stale.anchor = anchor;
      stale.vin = [{ commit: Buffer.from(proof.cTilde) }];
      const v2 = Buffer.from(proof.blob);
      v2[0] = 2;
      stale.admit_proof = { ...proof, v: 2, blob: v2 };
      signSpendTx(stale, who.key);
      const queuedV2 = store.queueTx(stale);
      assert.equal(queuedV2.ok, false, queuedV2.reason);
      // A version-2 blob does not cover the commit, so the commit reject
      // fires before the version byte is classified.
      assert.equal(queuedV2.reason, 'admit_membership', queuedV2.reason);

      const bad = stripPayer(lockTx({
        from: who.dest,
        to: who.dest,
        nanos: AMOUNTS[2],
        id: `v3-bad-${AMOUNTS[2]}`,
      }));
      bad.anchor = anchor;
      bad.vin = [{ commit: Buffer.from(proof.cTilde) }];
      const junk = Buffer.from(proof.blob);
      junk[junk.length - 1] ^= 0xff;
      bad.admit_proof = { ...proof, blob: junk };
      signSpendTx(bad, who.key);
      const queuedBad = store.queueTx(bad);
      assert.equal(queuedBad.ok, false, queuedBad.reason);
      assert.equal(queuedBad.reason, 'admit_membership', queuedBad.reason);

      const now = T0 + (readyAt - 1) * TARGET_BLOCK_INTERVAL_MS;
      const tip = store.tip();
      const headerBits = Number(decodeHeader(Buffer.from(tip.header)).bits);
      const plainBlockTx = lockTx({
        from: who.dest,
        to: who.dest,
        nanos: AMOUNTS[0],
        id: 'block-plain',
      });
      const builtPlain = buildTemplate({
        prev: tip.hash,
        prevHeader: tip.header,
        prevBlock: tip,
        height: tip.height + 1,
        miner: who.dest,
        now,
        bits: headerBits,
        txs: [plainBlockTx],
        parentBlocks: store.blocks,
      });
      const appendedPlain = await Promise.resolve(store.append({
        header: builtPlain.header,
        txs: builtPlain.txs,
        samples: builtPlain.samples,
        shareBatch: builtPlain.shareBatch || [],
        miner: who.dest,
        aLeaves: builtPlain.aLeaves,
        bLeaves: builtPlain.bLeaves,
        rootA: builtPlain.rootA,
        rootB: builtPlain.rootB,
        weight: builtPlain.weight,
      }, { trustedPowHash: easyPowHash(), skipSharePow: true }));
      assert.equal(appendedPlain.ok, false, appendedPlain.reason);
      assert.equal(appendedPlain.reason, 'admit_version', appendedPlain.reason);
      assert.equal(store.tip().height, readyAt - 1);

      const debitBlockTx = stripPayer(lockTx({
        from: who.dest,
        to: who.dest,
        nanos: AMOUNTS[1],
        id: 'block-debit',
      }));
      debitBlockTx.noteSpends = [{ nanos: AMOUNTS[1] }];
      const builtDebit = buildTemplate({
        prev: tip.hash,
        prevHeader: tip.header,
        prevBlock: tip,
        height: tip.height + 1,
        miner: who.dest,
        now,
        bits: headerBits,
        txs: [debitBlockTx],
        parentBlocks: store.blocks,
      });
      const appendedDebit = await Promise.resolve(store.append({
        header: builtDebit.header,
        txs: builtDebit.txs,
        samples: builtDebit.samples,
        shareBatch: builtDebit.shareBatch || [],
        miner: who.dest,
        aLeaves: builtDebit.aLeaves,
        bLeaves: builtDebit.bLeaves,
        rootA: builtDebit.rootA,
        rootB: builtDebit.rootB,
        weight: builtDebit.weight,
      }, { trustedPowHash: easyPowHash(), skipSharePow: true }));
      assert.equal(appendedDebit.ok, false, appendedDebit.reason);
      assert.equal(appendedDebit.reason, 'admit_version', appendedDebit.reason);
      assert.equal(store.tip().height, readyAt - 1);

      const queued = store.queueTx(lock);
      assert.equal(queued.ok, true, queued.reason || 'queue');
      await sealEmpty(store, who.dest, now, openings);
      assert.equal(store.tip().height, readyAt);
      const sealed = store.blocks[store.blocks.length - 1].txs.find((tx) => tx.id === lock.id);
      assert.ok(sealed, 'lock sealed');
      const sealedTag = Buffer.from(asU8(sealed.admit_proof.spendTag)).toString('hex');
      assert.equal(sealedTag, tag);
      const spent = fluxsetFromBlocks(store.blocks);
      assert.equal(spent.spendTags.has(tag), true);
      assert.equal(Number(store.reserveVault.totalLockedNanos), lock.nanos);
      const tipH = store.tip().height;
      const walk = noteCommitSpendableNanos(store.blocks, who.dest, tipH);
      const principal = portalPrincipalNanos(store.reserveVault, who.dest);
      assert.equal(principal, lock.nanos);
      assert.ok(walk > principal);
      const spendable = walk - principal;
      assert.ok(spendable < walk);
      assert.equal(store.spendableNanos(who.dest), spendable);
      const cb = store.blocks[store.blocks.length - 1].txs[0];
      const openedKind = (kind) => {
        let sum = 0;
        for (const o of cb.vout || []) {
          if (o.kind !== kind) continue;
          const v = openedCoinbaseNanos(o);
          assert.notEqual(v, null, kind);
          sum += v;
        }
        return sum;
      };
      const split = splitLevy(lock.fee);
      assert.equal(openedKind('finder-fee'), split.finder);
      assert.equal(openedKind('reserve-fee'), split.reserve);

      const reloaded = createStore(dir);
      assert.equal(reloaded.tip().height, tipH);
      assert.equal(Number(reloaded.reserveVault.totalLockedNanos), lock.nanos);
      const reWalk = noteCommitSpendableNanos(reloaded.blocks, who.dest, tipH);
      const rePrincipal = portalPrincipalNanos(reloaded.reserveVault, who.dest);
      assert.equal(rePrincipal, lock.nanos);
      assert.ok(reWalk > rePrincipal);
      assert.equal(reloaded.spendableNanos(who.dest), reWalk - rePrincipal);

      const d20 = hash20FromAddress(who.dest);
      const plainKinds = ['claim', 'evm-value', 'vortice-register', 'user-spend', 'no-such-kind'];
      const plainAmounts = [1, walk];
      for (const kind of plainKinds) {
        for (const nanos of plainAmounts) {
          const note = sealNote(nanos, { dest20: d20, kind });
          const plain = {
            id: `plain-${kind}-${nanos}`,
            kind,
            from: who.dest,
            to: who.dest,
            nanos,
            fee: 0,
            vin: [{ address: who.dest }],
            vout: [{ ...note, kind, address: who.dest }],
          };
          const queuedPlainKind = store.queueTx(plain);
          assert.equal(queuedPlainKind.ok, false, `${kind} ${nanos} ${queuedPlainKind.reason}`);
          assert.equal(queuedPlainKind.reason, 'kind', `${kind} ${nanos} ${queuedPlainKind.reason}`);
        }
      }
      const tipBeforePlain = store.tip().height;
      const plainBlock = {
        id: 'block-evm-walk',
        kind: 'evm-value',
        from: who.dest,
        to: who.dest,
        nanos: walk,
        fee: 0,
        vin: [{ address: who.dest }],
        vout: [{ ...sealNote(walk, { dest20: d20, kind: 'evm-value' }), kind: 'evm-value', address: who.dest }],
      };
      const builtPlainKind = buildTemplate({
        prev: store.tip().hash,
        prevHeader: store.tip().header,
        prevBlock: store.tip(),
        height: tipBeforePlain + 1,
        miner: who.dest,
        now: T0 + tipBeforePlain * TARGET_BLOCK_INTERVAL_MS,
        bits: Number(decodeHeader(Buffer.from(store.tip().header)).bits),
        txs: [plainBlock],
        parentBlocks: store.blocks,
      });
      const appendedPlainKind = await Promise.resolve(store.append({
        header: builtPlainKind.header,
        txs: builtPlainKind.txs,
        samples: builtPlainKind.samples,
        shareBatch: builtPlainKind.shareBatch || [],
        miner: who.dest,
        aLeaves: builtPlainKind.aLeaves,
        bLeaves: builtPlainKind.bLeaves,
        rootA: builtPlainKind.rootA,
        rootB: builtPlainKind.rootB,
        weight: builtPlainKind.weight,
      }, { trustedPowHash: easyPowHash(), skipSharePow: true }));
      assert.equal(appendedPlainKind.ok, false, appendedPlainKind.reason);
      assert.equal(appendedPlainKind.reason, 'kind', appendedPlainKind.reason);
      assert.equal(store.tip().height, tipBeforePlain);

      const again = stripPayer(lockTx({
        from: who.dest,
        to: who.dest,
        nanos: lock.nanos,
        id: 'v3-lock-again',
      }));
      again.anchor = anchor;
      again.vin = [{ commit: Buffer.from(proof.cTilde) }];
      again.admit_proof = proof;
      again.fee = lock.fee;
      signSpendTx(again, who.key);
      const queuedAgain = store.queueTx(again);
      assert.equal(queuedAgain.ok, false, queuedAgain.reason);
      assert.equal(queuedAgain.reason, 'admit_link_tag', queuedAgain.reason);

      for (const kind of KINDS) {
        for (const amount of AMOUNTS) {
          const replay = stripPayer(typedTx(kind, who.dest, amount, `${kind}-replay-${amount}`));
          replay.anchor = anchor;
          replay.vin = [{ commit: Buffer.from(proof.cTilde) }];
          replay.admit_proof = proof;
          replay.fee = lock.fee;
          signSpendTx(replay, who.key);
          const got = store.queueTx(replay);
          assert.equal(got.ok, false, `${kind} ${amount} ${got.reason}`);
          assert.equal(got.reason, 'admit_link_tag', `${kind} ${amount} ${got.reason}`);
        }
      }

      const base = admitBaseFromAddress(who.dest);
      let nextHeight = 2;
      while (!(Number(store.reserveVault.epochStartMs) > 0) && nextHeight <= 12) {
        const pot = potOf(store, nextHeight);
        const open = openings.find((o) => o.height === nextHeight);
        const anchor = walletAnchor(store.tip().height + 1);
        const flux = anchorFlux(store.blocks, anchor);
        const index = indexInFlux(flux, pot.commit);
        assert.ok(index >= 0, `lock pot ${nextHeight}`);
        const x = admitScalarFromSeed(who.spendSeed, pot);
        const extra = stripPayer(lockTx({
          from: who.dest,
          to: who.dest,
          nanos: 1,
          id: `v3-lock-join-${nextHeight}`,
        }));
        proveBalanced(extra, { x, index, flux, note: pot, anchor, noteR: open.r, noteV: open.v });
        signSpendTx(extra, who.key);
        const queuedExtra = store.queueTx(extra);
        assert.equal(queuedExtra.ok, true, `${nextHeight} ${queuedExtra.reason}`);
        const clock = headerTime(store.tip()) + TARGET_BLOCK_INTERVAL_MS;
        await sealEmpty(store, who.dest, clock, openings);
        const sealedExtra = store.blocks[store.blocks.length - 1].txs.find((tx) => tx.id === extra.id);
        assert.ok(sealedExtra, `lock ${nextHeight}`);
        nextHeight += 1;
      }
      assert.ok(Number(store.reserveVault.epochStartMs) > 0, 'portal joined');

      const votePotH = nextHeight;
      const votePot = potOf(store, votePotH);
      const voteOpen = openings.find((o) => o.height === votePotH);
      const voteAnchor = walletAnchor(store.tip().height + 1);
      const voteFlux = anchorFlux(store.blocks, voteAnchor);
      const voteIndex = indexInFlux(voteFlux, votePot.commit);
      assert.ok(voteIndex >= 0, 'vote pot');
      const changedVote = stripPayer(voteTx({
        from: who.dest,
        dest: who.dest,
        choice: VOTE_HOLD,
        id: 'v3-vote-change',
      }));
      changedVote.choice = VOTE_HOLD;
      proveChanged(changedVote, {
        x: admitScalarFromSeed(who.spendSeed, votePot),
        index: voteIndex,
        flux: voteFlux,
        note: votePot,
        anchor: voteAnchor,
        noteR: voteOpen.r,
        noteV: voteOpen.v,
        receiptNanos: 0,
        base,
      });
      assert.ok(changedVote.fee > 0 && changedVote.fee < voteOpen.v);
      assert.equal(changedVote.vout[0].admitPub, undefined);
      assert.equal(outputJoinsAdmitSet(changedVote, changedVote.vout[0]), false);
      assert.equal(outputJoinsAdmitSet(changedVote, changedVote.vout[1]), true);
      const leakedVote = {
        ...changedVote,
        vout: [
          { ...changedVote.vout[0], admitPub: changedVote.vout[1].admitPub },
          changedVote.vout[1],
        ],
      };
      const leaked = store.queueTx(leakedVote);
      assert.equal(leaked.ok, false, leaked.reason);
      assert.equal(leaked.reason, 'receipt_admitpub', leaked.reason);
      signSpendTx(changedVote, who.key);
      assert.equal(verifySpendSig(changedVote), true);
      assert.equal(verifySpendSig({ ...changedVote, fee: changedVote.fee + 1 }), false);
      const pubsBeforeVote = fluxsetFromBlocks(store.blocks).pubs.length;
      const queuedVoteOk = store.queueTx(changedVote);
      assert.equal(queuedVoteOk.ok, true, queuedVoteOk.reason || 'vote queue');
      const voteClock = headerTime(store.tip()) + TARGET_BLOCK_INTERVAL_MS;
      await sealEmpty(store, who.dest, voteClock, openings);
      const voteBlock = store.blocks[store.blocks.length - 1];
      const sealedVote = voteBlock.txs.find((tx) => tx.id === changedVote.id);
      assert.ok(sealedVote, 'vote sealed');
      assert.equal(typedCommitSum(sealedVote).ok, true);
      assert.equal(Number(store.reserveVault.votes.hold), 1);
      let joinedOnVote = 0;
      for (const tx of voteBlock.txs) {
        for (const o of tx.vout || []) if (outputJoinsAdmitSet(tx, o)) joinedOnVote += 1;
      }
      const pubsAfterVote = fluxsetFromBlocks(store.blocks).pubs.length;
      assert.equal(pubsAfterVote - pubsBeforeVote, joinedOnVote);
      const sealedReceipt = sealedVote.vout.find((o) => o.kind === 'vote');
      assert.ok(sealedReceipt);
      assert.equal(sealedReceipt.admitPub, undefined);
      assert.equal(outputJoinsAdmitSet(sealedVote, sealedReceipt), false);
      const votePotOut = voteBlock.txs[0].vout.find((o) => o.kind === 'pot');
      assert.equal(outputJoinsAdmitSet(voteBlock.txs[0], votePotOut), true);

      const lockedBefore = Number(store.reserveVault.totalLockedNanos);
      const earlyPot = potOf(store, votePotH + 1);
      const earlyOpen = openings.find((o) => o.height === votePotH + 1);
      const earlyAnchor = walletAnchor(store.tip().height + 1);
      const earlyFlux = anchorFlux(store.blocks, earlyAnchor);
      const earlyIndex = indexInFlux(earlyFlux, earlyPot.commit);
      assert.ok(earlyIndex >= 0, 'early withdraw pot');
      const earlyPreview = previewWithdraw(store.reserveVault, who.dest);
      const early = stripPayer(withdrawTx({
        from: who.dest,
        to: who.dest,
        nanos: earlyPreview.payout,
        id: 'v3-withdraw-early',
      }));
      proveChanged(early, {
        x: admitScalarFromSeed(who.spendSeed, earlyPot),
        index: earlyIndex,
        flux: earlyFlux,
        note: earlyPot,
        anchor: earlyAnchor,
        noteR: earlyOpen.r,
        noteV: earlyOpen.v,
        receiptNanos: earlyPreview.payout,
        base,
      });
      signSpendTx(early, who.key);
      const futureClock = { ...early, nowMs: headerTime(store.tip()) + epochMs(MAGIC_TESTNET) };
      assert.equal(store.queueTx(futureClock).reason, 'now_ms');
      assert.equal(store.queueTx({ ...early, nowMs: 1 }).reason, 'now_ms');
      const queuedEarly = store.queueTx(early);
      assert.equal(queuedEarly.ok, false, queuedEarly.reason);
      assert.equal(queuedEarly.reason, 'epoch_open', queuedEarly.reason);
      const earlyTip = store.tip();
      const { tpl: earlyTpl } = store.template({
        miner: who.dest,
        shareBits: 4,
        now: headerTime(earlyTip) + TARGET_BLOCK_INTERVAL_MS,
      });
      const earlyStamp = headerTime({ header: earlyTpl.header });
      const builtEarly = buildTemplate({
        prev: earlyTip.hash,
        prevHeader: earlyTip.header,
        prevBlock: earlyTip,
        height: earlyTip.height + 1,
        miner: who.dest,
        now: earlyStamp,
        bits: Number(decodeHeader(Buffer.from(earlyTpl.header)).bits),
        txs: [early],
        parentBlocks: store.blocks,
      });
      const appendedEarly = await Promise.resolve(store.append({
        header: builtEarly.header,
        txs: builtEarly.txs,
        samples: builtEarly.samples,
        shareBatch: builtEarly.shareBatch || [],
        miner: who.dest,
        aLeaves: builtEarly.aLeaves,
        bLeaves: builtEarly.bLeaves,
        rootA: builtEarly.rootA,
        rootB: builtEarly.rootB,
        weight: builtEarly.weight,
      }, { trustedPowHash: easyPowHash(), skipSharePow: true }));
      assert.equal(appendedEarly.ok, false, appendedEarly.reason);
      assert.equal(appendedEarly.reason, 'epoch_open', appendedEarly.reason);
      assert.equal(store.tip().height, earlyTip.height);
      assert.equal(Number(store.reserveVault.totalLockedNanos), lockedBefore);

      // The same body, on a chain that does not extend this tip. Wall clock is
      // past the epoch. Header time is not. Fork and adopt must both refuse.
      console.error('phase early-fork');
      const clocked = sealedTemplateBlock(store, who.dest, futureClock, easyPowHash());
      const clockFork = await forkVerdict(store, clocked);
      assert.equal(clockFork.ok, false, clockFork.reason);
      assert.equal(clockFork.reason, 'now_ms', `${clockFork.reason} at ${clockFork.at}`);
      const leakedBlock = sealedTemplateBlock(store, who.dest, leakedVote, easyPowHash());
      const leakedFork = await forkVerdict(store, leakedBlock);
      assert.equal(leakedFork.ok, false, leakedFork.reason);
      assert.equal(leakedFork.reason, 'receipt_admitpub', `${leakedFork.reason} at ${leakedFork.at}`);
      const earlyForkBlock = sealedTemplateBlock(store, who.dest, early, easyPowHash());
      const earlyFork = await forkVerdict(store, earlyForkBlock);
      assert.equal(earlyFork.ok, false, earlyFork.reason);
      assert.equal(earlyFork.reason, 'epoch_open', `${earlyFork.reason} at ${earlyFork.at}`);
      assert.equal(store.tip().height, earlyTip.height);
      const rivalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v3-early-fork-'));
      scratch.push(rivalDir);
      const rival = createStore(rivalDir);
      await sealEmpty(rival, who.dest, T0 + 60_000, null);
      const adoptedEarly = await Promise.resolve(rival.ingest(store.blocks.concat([earlyForkBlock]), {
        trustBlockHash: true,
        skipSharePow: true,
        nowMs: Date.now(),
      }));
      assert.equal(adoptedEarly.ok, false, adoptedEarly.reason);
      assert.equal(adoptedEarly.reason, 'epoch_open', adoptedEarly.reason);
      assert.equal(rival.tip().height, 1);
      assert.equal(Number(rival.reserveVault.totalLockedNanos), 0);

      const epochEnd = Number(store.reserveVault.epochStartMs) + epochMs(MAGIC_TESTNET);
      const span = epochEnd - headerTime(store.tip());
      assert.ok(span > 0, 'epoch already closed');
      // The median of the last MTP window lags the parent, so a requested
      // future stamp clamps to about one MTP_FUTURE_MS per window of blocks.
      // The cap is that many windows for any epoch length, plus one window.
      const stepCap = Math.ceil(span / MTP_FUTURE_MS) * MTP_WINDOW + MTP_WINDOW;
      console.error('phase walk');
      let steps = 0;
      while (headerTime(store.tip()) < epochEnd && steps < stepCap) {
        const parentTs = headerTime(store.tip());
        await sealEmpty(store, who.dest, Math.max(epochEnd, parentTs + MTP_FUTURE_MS - 1), openings);
        steps += 1;
      }
      assert.ok(headerTime(store.tip()) >= epochEnd, `epoch open after ${steps}`);

      const drawPot = potOf(store, votePotH + 1);
      const drawOpen = openings.find((o) => o.height === votePotH + 1);
      const drawAnchor = walletAnchor(store.tip().height + 1);
      const drawFlux = anchorFlux(store.blocks, drawAnchor);
      const drawIndex = indexInFlux(drawFlux, drawPot.commit);
      assert.ok(drawIndex >= 0, 'withdraw pot');
      const preview = previewWithdraw(store.reserveVault, who.dest);
      assert.ok(preview.principal > 0);
      const cap = preview.payout;
      assert.ok(cap >= preview.principal);
      const withdraw = stripPayer(withdrawTx({
        from: who.dest,
        to: who.dest,
        nanos: cap,
        id: 'v3-withdraw-change',
      }));
      proveChanged(withdraw, {
        x: admitScalarFromSeed(who.spendSeed, drawPot),
        index: drawIndex,
        flux: drawFlux,
        note: drawPot,
        anchor: drawAnchor,
        noteR: drawOpen.r,
        noteV: drawOpen.v,
        receiptNanos: cap,
        base,
      });
      assert.notEqual(withdraw.fee, drawOpen.v);
      const wrongFee = typedCommitSum({ ...withdraw, fee: withdraw.fee + 1 });
      assert.equal(wrongFee.ok, false);
      assert.equal(wrongFee.reason, 'commit_sum');
      const exactOnly = typedCommitSum({ ...withdraw, fee: drawOpen.v });
      assert.equal(exactOnly.ok, false);
      assert.equal(exactOnly.reason, 'commit_sum');
      signSpendTx(withdraw, who.key);
      assert.equal(verifySpendSig(withdraw), true);
      const blob = Buffer.from(asU8(withdraw.admit_proof.blob));
      blob[blob.length - 1] ^= 0xff;
      assert.equal(verifySpendSig({
        ...withdraw,
        admit_proof: { ...withdraw.admit_proof, blob },
      }), false);
      const tipBeforeDraw = store.tip().height;
      const prefixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v3-prefix-'));
      scratch.push(prefixDir);
      fs.cpSync(dir, prefixDir, { recursive: true });
      // The seal key is outside the datadir. Without it the copy is a foreign
      // book, trustStoredHash is false, and easyPowHash headers fail as pow.
      fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(prefixDir));
      const queuedDraw = store.queueTx(withdraw);
      assert.equal(queuedDraw.ok, true, queuedDraw.reason || 'withdraw queue');
      const drawClock = headerTime(store.tip()) + TARGET_BLOCK_INTERVAL_MS;
      await sealEmpty(store, who.dest, drawClock, openings);
      assert.equal(store.tip().height, tipBeforeDraw + 1);
      const sealedDraw = store.blocks[store.blocks.length - 1].txs.find((tx) => tx.id === withdraw.id);
      assert.ok(sealedDraw, 'withdraw sealed');
      assert.equal(typedCommitSum(sealedDraw).ok, true);
      assert.equal(Number(store.reserveVault.totalLockedNanos), 0);

      assert.equal(auditCirculatingSupply([]).status, 'verified');
      const liveSupply = auditCirculatingSupply(store.blocks);
      assert.equal(liveSupply.status, 'verified', liveSupply.reason || 'supply');
      const supplyTip = store.tip();
      const { tpl } = store.template({
        miner: who.dest,
        shareBits: 4,
        now: headerTime(supplyTip) + TARGET_BLOCK_INTERVAL_MS,
      });
      const nextBlock = {
        header: tpl.header,
        txs: tpl.txs,
        samples: tpl.samples,
        shareBatch: tpl.shareBatch || [],
        miner: who.dest,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
        weight: tpl.weight,
      };
      const prevView = {
        hash: supplyTip.hash,
        header: supplyTip.header,
        height: supplyTip.height,
        rootA: supplyTip.rootA,
        rootB: supplyTip.rootB,
        txs: supplyTip.txs,
        bLeaves: supplyTip.bLeaves,
        weight: supplyTip.weight,
        shareBatch: supplyTip.shareBatch,
      };
      const verifyOpts = {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
        evmHistory: store.blocks,
        genesisMs: T0,
        magic: MAGIC_TESTNET,
        tipHeight: supplyTip.height,
        hashBonusNanos: Number(store.reserveVault.liveHashBonusNanos || 1),
        reserveState: store.reserveVault,
        spentB: new Set(),
        nowMs: Date.now(),
        mtpTimestamps: store.blocks.slice(-11).map((b) => headerTime(b)),
      };
      const honestNext = await Promise.resolve(verifyBlock(nextBlock, prevView, {
        ...verifyOpts,
        supplyParents: store.blocks,
      }));
      assert.equal(honestNext.ok, true, honestNext.reason || 'honest supply');
      const forged = store.blocks.map((b) => ({
        ...b,
        txs: (b.txs || []).map((tx) => ({
          ...tx,
          vout: (tx.vout || []).map((o) => ({
            ...o,
            commit: o.commit ? Buffer.from(asU8(o.commit)) : o.commit,
          })),
        })),
      }));
      const forgedPot = forged[0].txs[0].vout.find((o) => o.kind === 'pot');
      forgedPot.commit[0] ^= 0xff;
      const rejectedSupply = await Promise.resolve(verifyBlock(nextBlock, prevView, {
        ...verifyOpts,
        supplyParents: forged,
      }));
      assert.equal(rejectedSupply.ok, false, 'tampered supply');
      assert.equal(rejectedSupply.reason, 'supply', rejectedSupply.reason);
      assert.equal(store.tip().height, supplyTip.height);

      console.error('phase sealed');
      const mintPortal = portalIdFromDest(who.dest);
      const mintId = withdrawMintId(mintPortal, store.reserveVault.currentEpoch);
      assert.equal(store.reserveVault.mintedIds[mintId], true);
      const paidPortal = store.reserveVault.portals[mintPortal];
      assert.ok(paidPortal, 'withdraw keeps the portal');
      assert.equal(paidPortal.staked, 0n);
      assert.equal(paidPortal.idle, 0n);
      assert.ok(paidPortal.redeemedNanos > 0n, 'paid principal stays on the portal');
      assert.equal(BigInt(portalPrincipalNanos(store.reserveVault, who.dest)), paidPortal.redeemedNanos);
      const spareAnchor = walletAnchor(store.tip().height + 1);
      const spareFlux = anchorFlux(store.blocks, spareAnchor);
      let spare = null;
      for (let i = openings.length - 1; i >= 0; i -= 1) {
        const o = openings[i];
        if (!(o.height > 0 && o.height <= spareAnchor)) continue;
        if (o.height === drawOpen.height) continue;
        const idx = indexInFlux(spareFlux, o.commit);
        if (idx < 0) continue;
        spare = { o, idx };
        break;
      }
      assert.ok(spare, 'unspent pot inside the anchor');
      const sparePot = potOf(store, spare.o.height);
      const redraw = stripPayer(withdrawTx({
        from: who.dest,
        to: who.dest,
        nanos: cap,
        id: 'v3-withdraw-again',
      }));
      proveChanged(redraw, {
        x: admitScalarFromSeed(who.spendSeed, sparePot),
        index: spare.idx,
        flux: spareFlux,
        note: sparePot,
        anchor: spareAnchor,
        noteR: spare.o.r,
        noteV: spare.o.v,
        receiptNanos: cap,
        base,
      });
      signSpendTx(redraw, who.key);
      const queuedRedraw = store.queueTx(redraw);
      assert.equal(queuedRedraw.ok, false, queuedRedraw.reason);
      // A portal with no stake left fails the withdraw bound. The vault cap
      // is not reached, and the tip does not move.
      assert.equal(queuedRedraw.reason, 'insufficient', queuedRedraw.reason);
      assert.equal(Number(store.reserveVault.totalLockedNanos), 0);
      assert.equal(store.tip().height, supplyTip.height);

      const snapped = createStore(dir);
      assert.equal(snapped.tip().height, supplyTip.height);
      assert.equal(Number(snapped.reserveVault.totalLockedNanos), 0);
      assert.equal(snapped.reserveVault.mintedIds[mintId], true);

      const prefix = createStore(prefixDir);
      assert.ok(Number(prefix.reserveVault.totalLockedNanos) > 0);
      assert.equal(prefix.reserveVault.mintedIds[mintId], undefined);
      const withdrawBlock = store.blocks[store.blocks.length - 1];
      assert.ok(withdrawBlock.txs.some((tx) => tx.id === withdraw.id));
      const high = Buffer.alloc(32);
      high[4] = 0xff;
      high[5] = 0xff;
      high[6] = 0xff;
      const drawStamp = headerTime(withdrawBlock);
      const { tpl: sibTpl } = prefix.template({
        miner: who.dest,
        shareBits: 4,
        now: drawStamp,
      });
      const sibling = {
        header: sibTpl.header,
        txs: sibTpl.txs,
        samples: sibTpl.samples,
        shareBatch: sibTpl.shareBatch || [],
        miner: who.dest,
        aLeaves: sibTpl.aLeaves,
        bLeaves: sibTpl.bLeaves,
        rootA: sibTpl.rootA,
        rootB: sibTpl.rootB,
        weight: sibTpl.weight,
      };
      const sealedSib = await Promise.resolve(prefix.append(sibling, {
        trustedPowHash: high,
        skipSharePow: true,
      }));
      assert.equal(sealedSib.ok, true, sealedSib.reason || 'sibling');
      assert.equal(
        Number(decodeHeader(Buffer.from(prefix.tip().header)).bits),
        Number(decodeHeader(Buffer.from(withdrawBlock.header)).bits),
      );
      const ibd = await Promise.resolve(prefix.ingest([withdrawBlock], {
        trustBlockHash: true,
        skipSharePow: true,
        nowMs: Date.now(),
      }));
      assert.equal(ibd.ok, true, `${ibd.reason || 'ibd'} ${ibd.at ?? ''}`);
      assert.equal(Buffer.from(prefix.tip().hash).equals(Buffer.from(withdrawBlock.hash)), true);
      assert.equal(Number(prefix.reserveVault.totalLockedNanos), 0);
      assert.equal(prefix.reserveVault.mintedIds[mintId], true);

      console.error('phase replay');
      const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v3-replay-'));
      scratch.push(replayDir);
      fs.cpSync(dir, replayDir, { recursive: true });
      fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(replayDir));
      fs.rmSync(path.join(replayDir, 'book.snap'), { force: true });
      const replayed = createStore(replayDir);
      assert.equal(replayed.loadMode, 'full');
      assert.equal(replayed.tip().height, supplyTip.height);
      assert.equal(Number(replayed.reserveVault.totalLockedNanos), 0);
      assert.equal(replayed.reserveVault.mintedIds[mintId], true);

      console.error('phase adopt');
      const forkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v3-adopt-'));
      scratch.push(forkDir);
      const forked = createStore(forkDir);
      await sealEmpty(forked, who.dest, T0 + 120_000, null);
      const adopted = await Promise.resolve(forked.ingest(store.blocks, {
        trustBlockHash: true,
        skipSharePow: true,
        nowMs: Date.now(),
      }));
      assert.equal(adopted.ok, true, `${adopted.reason || 'adopt'} ${adopted.at ?? ''}`);
      assert.equal(forked.tip().height, supplyTip.height);
      assert.equal(Buffer.from(forked.tip().hash).equals(Buffer.from(withdrawBlock.hash)), true);
      assert.equal(Number(forked.reserveVault.totalLockedNanos), 0);
      assert.equal(forked.reserveVault.mintedIds[mintId], true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      for (const extra of scratch) fs.rmSync(extra, { recursive: true, force: true });
    }
  });
});

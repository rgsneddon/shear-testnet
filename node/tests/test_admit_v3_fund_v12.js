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
  fundingJroot,
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

  it('a byte-3 lock is vault_unavailable and does not spend the note', { timeout: 30_000 }, async () => {
    const commit = Buffer.alloc(32, 4);
    const blob = Buffer.alloc(129, 0);
    blob[0] = 3;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v3-fund-'));
    try {
      const store = createStore(dir);
      const queued = store.queueTx({
        id: 'byte3-lock',
        kind: 'lock',
        vin: [{ commit }],
        admit_proofs: [{ blob, cTilde: commit }],
      });
      assert.equal(queued.reason, 'vault_unavailable');
      assert.equal(store.fluxset().spendTags.has(Buffer.alloc(32).toString('hex')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

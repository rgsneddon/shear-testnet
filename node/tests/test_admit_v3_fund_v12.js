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
import { buildTemplate } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_TESTNET, TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { newIdentity, encodeDest } from '../../crypto/address.js';
import { lockTx, voteTx, withdrawTx } from '../../crypto/reserve_vault.js';
import { signSpendTx } from '../../crypto/spend.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { levyNeed } from '../../crypto/levy.js';
import {
  admitProveV3,
  admitPub,
  admitScalarFromSeed,
  fluxsetFromBlocks,
  blindCommit,
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

async function sealEmpty(store, dest, now) {
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
  assert.equal(got.ok, true, got.reason || 'seal');
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

  it('an in-window lock spends the original note, and a bad proof does not', { timeout: 300_000 }, async () => {
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v3-fund-'));
    const store = createStore(dir);
    try {
      const readyAt = 17;
      let noteOpen = null;
      for (let i = 0; i < readyAt - 1; i += 1) {
        const opening = await sealEmpty(store, who.dest, T0 + i * TARGET_BLOCK_INTERVAL_MS);
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
      }

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
      await sealEmpty(store, who.dest, now);
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
      assert.equal(store.spendableNanos(who.dest), walk);
      const principal = portalPrincipalNanos(store.reserveVault, who.dest);
      assert.equal(principal, lock.nanos);
      assert.ok(walk > principal);

      const reloaded = createStore(dir);
      assert.equal(reloaded.tip().height, tipH);
      assert.equal(Number(reloaded.reserveVault.totalLockedNanos), lock.nanos);
      assert.equal(
        reloaded.spendableNanos(who.dest),
        noteCommitSpendableNanos(reloaded.blocks, who.dest, tipH),
      );

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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

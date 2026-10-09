/**
 * 135a residual. A lock whose JSON spendTag is omitted is still spent.
 * A later block that spends that same note again is rejected.
 * The amount is whatever the coinbase opened to. The tag is the proof bytes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { buildTemplate, retarget } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_TESTNET, TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest } from '../../crypto/address.js';
import {
  outputJoinsAdmitSet,
  admitProveV3,
  admitPub,
  admitScalarFromSeed,
  fluxsetFromBlocks,
} from '../../crypto/admit.js';
import {
  asU8,
  pointBytes,
  scalarBytes,
  kernelExcess,
  openedCoinbaseNanos,
  sealCoinbaseNote,
  randomScalar,
  txSpendTags,
} from '../../crypto/note.js';
import { lockTx } from '../../crypto/reserve_vault.js';
import { signSpendTx } from '../../crypto/spend.js';
import { levyNeed } from '../../crypto/levy.js';
import {
  walletAnchor,
  readyHeight,
  txDigestV3,
  admitV3Context,
} from '../../crypto/admit_v3.js';

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

function dropTagFields(tx) {
  delete tx.spendTag;
  if (tx.admit_proof) delete tx.admit_proof.spendTag;
  if (Array.isArray(tx.admit_proofs)) {
    for (const proof of tx.admit_proofs) delete proof.spendTag;
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

function blobTag(proof) {
  const blob = Buffer.from(asU8(proof?.blob || proof?.proof || []));
  assert.ok(blob.length >= 33);
  assert.equal(blob[0], 3);
  return Buffer.from(blob.subarray(1, 33));
}

/**
 * Prove a lock with the JSON spendTag absent before the transcript is bound.
 * The fee is the weight of that omitted body. The amount is noteV, not a sample.
 */
function proveOmittedLock(tx, { x, index, flux, note, anchor, noteR, noteV }) {
  let fee = 0;
  let tag = null;
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
    assert.ok(probe, `probe ${attempt}`);
    tx.vin = [{ commit: Buffer.from(probe.cTilde) }];
    tx.admit_proof = probe;
    tx.excess = kernelExcess(tx.vout, [{ r: noteR, t: scalarBytes(t) }]);
    assert.ok(tx.excess, 'excess');
    dropTagFields(tx);
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
    tx.admit_proof = real;
    tx.vin = [{ commit: Buffer.from(real.cTilde) }];
    dropTagFields(tx);
    tag = blobTag(tx.admit_proof);
    const need = levyNeed(tx);
    if (need === fee) break;
    fee = need;
    tag = null;
  }
  assert.ok(tag, 'omitted-lock fee did not settle');
  assert.equal(tx.admit_proof.spendTag, undefined);
  assert.equal(tx.spendTag, undefined);
  assert.equal(tx.nanos + tx.fee, noteV);
  assert.ok(tx.fee >= 0);
  assert.ok(tx.nanos > 0);
  return tag;
}

function anchorFlux(blocks, anchor) {
  return fluxsetFromBlocks((blocks || []).filter((b) => {
    const h = Number(b?.height || 0);
    return h > 0 && h <= anchor;
  }));
}

function userTxs(tpl) {
  return (tpl.txs || []).filter((tx) => tx && !tx.coinbase);
}

describe('v12 omitted lock spend tag', () => {
  it('a field-less lock is spent, and a later re-spend of that note is rejected', { timeout: 180_000 }, async () => {
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-tag-'));
    const store = createStore(dir);
    const includeAt = readyHeight(1);
    assert.equal(Number.isInteger(includeAt), true);
    assert.ok(includeAt > 1);

    let opening = null;
    while ((store.tip()?.height || 0) + 1 < includeAt) {
      const tip = store.tip();
      const now = tip ? headerTime(tip) + STEP : T0;
      const { tpl } = store.template({ miner: who.dest, now });
      const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
      const pow = easyPow();
      const got = await store.append(blockFrom(tpl, pow), { trustedPowHash: pow, skipSharePow: true });
      assert.equal(got.ok, true, `${got.reason || 'seal'} at ${(tip?.height || 0) + 1}`);
      if (!opening && pot?.r && pot.commit) {
        opening = { r: pot.r, v: openedCoinbaseNanos(pot) };
      }
    }
    assert.equal(store.tip().height + 1, includeAt);
    assert.ok(opening && opening.v > 1, String(opening && opening.v));

    const anchor = walletAnchor(includeAt);
    const secondHeight = includeAt + 1;
    const anchor2 = walletAnchor(secondHeight);
    assert.equal(typeof anchor, 'number');
    assert.equal(typeof anchor2, 'number');
    const pot = store.blocks[0].txs[0].vout.find((o) => o.kind === 'pot');
    const found = indexOfCommit(store.blocks, anchor, pot.commit);
    const found2 = indexOfCommit(store.blocks, anchor2, pot.commit);
    assert.equal(found.height, 1);
    assert.ok(found.index >= 0, 'note is inside the first anchor');
    assert.ok(found2.index >= 0, 'note is inside the later anchor');
    const x = admitScalarFromSeed(who.spendSeed, pot);
    assert.ok(Buffer.from(pointBytes(admitPub(x))).equals(Buffer.from(asU8(pot.admitPub))), 'pot key');

    const flux = anchorFlux(store.blocks, anchor);
    const first = stripPayer(lockTx({
      from: who.dest,
      to: who.dest,
      nanos: 1,
      id: 'lock-omit',
    }));
    const tag = proveOmittedLock(first, {
      x,
      index: found.index,
      flux,
      note: pot,
      anchor,
      noteR: opening.r,
      noteV: opening.v,
    });
    signSpendTx(first, who.key);
    dropTagFields(first);
    assert.ok(blobTag(first.admit_proof).equals(tag));

    const flux2 = anchorFlux(store.blocks, anchor2);
    const second = stripPayer(lockTx({
      from: who.dest,
      to: who.dest,
      nanos: 1,
      id: 'lock-again',
    }));
    const tag2 = proveOmittedLock(second, {
      x,
      index: found2.index,
      flux: flux2,
      note: pot,
      anchor: anchor2,
      noteR: opening.r,
      noteV: opening.v,
    });
    signSpendTx(second, who.key);
    dropTagFields(second);
    assert.ok(tag2.equals(tag), 'a second proof of the same note carries the same tag');
    assert.notEqual(first.id, second.id);

    const queued = store.queueTx(first);
    assert.equal(queued.ok, true, queued.reason || 'queue omitted lock');
    const parked = store.mempool.find((m) => m.id === 'lock-omit');
    assert.ok(parked);
    assert.equal(parked.spendTag, undefined);
    assert.equal(parked.admit_proof.spendTag, undefined);
    assert.ok(txSpendTags(parked).tags[0].equals(tag));

    const tip = store.tip();
    const now = headerTime(tip) + STEP;
    const open = store.template({ miner: who.dest, now });
    assert.equal(userTxs(open.tpl).length, 1);
    assert.equal(userTxs(open.tpl)[0].id, 'lock-omit');
    const pow = easyPow();
    const mined = await store.append(blockFrom(open.tpl, pow), { trustedPowHash: pow, skipSharePow: true });
    assert.equal(mined.ok, true, mined.reason || 'mine omitted lock');
    assert.equal(store.tip().height, includeAt);
    assert.equal(store.fluxset().spendTags.has(tag.toString('hex')), true);
    const sealed = store.blocks.flatMap((b) => b.txs || []).filter((tx) => tx.id === 'lock-omit');
    assert.equal(sealed.length, 1);
    assert.equal(sealed[0].admit_proof.spendTag, undefined);
    assert.equal(sealed[0].spendTag, undefined);
    assert.ok(blobTag(sealed[0].admit_proof).equals(tag));
    assert.equal(first.nanos + first.fee, opening.v);
    const lockedOut = (sealed[0].vout || []).find((o) => String(o.kind) === 'lock');
    const lockedV = Math.floor(Number(lockedOut?.valueProof?.v));
    assert.equal(Number.isInteger(lockedV), true);
    assert.equal(lockedV + Math.floor(Number(sealed[0].fee)), opening.v);

    const againQ = store.queueTx(second);
    assert.equal(againQ.ok, false, 're-spend was queued');
    assert.equal(againQ.reason, 'admit_link_tag', againQ.reason || 'queue re-spend');
    assert.equal(store.mempool.some((m) => m.id === 'lock-again'), false);

    const parent = store.tip();
    const stamp = headerTime(parent) + STEP;
    const doubled = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: secondHeight,
      miner: who.dest,
      now: stamp,
      bits: retarget(store.blocks, stamp),
      parentBlocks: store.blocks,
      txs: [second],
    });
    assert.equal(userTxs(doubled).some((tx) => tx.id === 'lock-again'), true);
    const probePow = easyPow();
    const probed = await store.probeBlock(blockFrom(doubled, probePow));
    assert.equal(probed.ok, false);
    assert.equal(probed.reason, 'admit_link_tag', probed.reason || 'probe re-spend');
    const forcePow = easyPow();
    const forced = await store.append(blockFrom(doubled, forcePow), {
      trustedPowHash: forcePow,
      skipSharePow: true,
    });
    assert.equal(forced.ok, false, 're-spend block was appended');
    assert.equal(forced.reason, 'admit_link_tag', forced.reason || 'append re-spend');
    assert.equal(store.tip().height, includeAt);
    assert.equal(store.blocks.some((b) => (b.txs || []).some((tx) => tx.id === 'lock-again')), false);
    assert.equal(store.fluxset().spendTags.has(tag.toString('hex')), true);

    const stripped = store.blocks.map((b) => ({
      ...b,
      txs: (b.txs || []).map((tx) => {
        const copy = { ...tx, admit_proof: tx.admit_proof ? { ...tx.admit_proof } : undefined };
        return dropTagFields(copy);
      }),
    }));
    const rebuilt = fluxsetFromBlocks(stripped);
    assert.equal(rebuilt.spendTags.has(tag.toString('hex')), true);

    const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-tag-replay-'));
    fs.cpSync(dir, replayDir, { recursive: true });
    fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(replayDir));
    fs.rmSync(path.join(replayDir, 'book.snap'), { force: true });
    const loaded = createStore(replayDir);
    assert.equal(loaded.fluxset().spendTags.has(tag.toString('hex')), true);
    const replayQ = loaded.queueTx(second);
    assert.equal(replayQ.ok, false);
    assert.equal(replayQ.reason, 'admit_link_tag', replayQ.reason || 'reload re-spend');
  });
});

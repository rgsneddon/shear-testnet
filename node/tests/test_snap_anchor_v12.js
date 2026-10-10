/**
 * N-43 / N-46: a snap or suffix reload keeps n, jroot, and zeroRoot at every
 * height. Frontier blobs stay sparse. A heavier fork with a lock anchored at
 * a dropped height adopts on a reloaded store and on a store that never
 * reloaded, with the same tip and jroot.
 *
 * The spread is the reorg depth and the anchor end, at a tip that is a
 * multiple of the checkpoint spacing and at a tip that is not. The lock
 * output is whatever the opened coinbase pays after the levy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createStore, OWED_CHECKPOINT_SPACING, keepsFrontier, frontierWindow } from '../src/store.js';
import { bookSealKeyFor, bookSealKeyPath } from '../src/book_seal_key.js';
import { buildTemplate, retarget, shouldAdopt } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { SPENDABLE_CONFIRMATIONS, MAGIC_TESTNET } from '../../crypto/asert.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest } from '../../crypto/address.js';
import {
  appendFluxBlock,
  fluxsetFromBlocks,
  admitProveV3,
  admitPub,
  admitScalarFromSeed,
  blindCommit,
  outputJoinsAdmitSet,
} from '../../crypto/admit.js';
import {
  asU8,
  pointBytes,
  scalarBytes,
  kernelExcess,
  openedCoinbaseNanos,
  sealCoinbaseNote,
  randomScalar,
} from '../../crypto/note.js';
import { lockTx } from '../../crypto/reserve_vault.js';
import { signSpendTx } from '../../crypto/spend.js';
import { levyNeed } from '../../crypto/levy.js';
import { ANCHOR_QUANTUM, ANCHOR_WINDOW } from '../../crypto/admit_v3.js';
import { txDigestV3, admitV3Context } from '../../crypto/admit_v3.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const STEP = 90_000;
const K = SPENDABLE_CONFIRMATIONS;
const SPACING = OWED_CHECKPOINT_SPACING;

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

function sealNext(store, dest, opening) {
  const tip = store.tip();
  const now = tip ? headerTime(tip) + STEP : T0;
  const { tpl } = store.template({ miner: dest, now });
  if (!opening.note) {
    const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
    const v = pot ? openedCoinbaseNanos(pot) : 0;
    if (pot?.r && pot.commit && v > 1) {
      opening.note = { r: pot.r, v, commit: Buffer.from(asU8(pot.commit)) };
    }
  }
  const got = store.append({
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
  }, { trustedPowHash: easyPow(), skipSharePow: true });
  return got;
}

function growTo(store, dest, target, opening, onHeight) {
  while ((store.tip()?.height || 0) < target) {
    const got = sealNext(store, dest, opening);
    if (!got.ok) return got;
    const h = store.tip().height;
    if (onHeight) onHeight(store, h);
    if (h % SPACING === 0) process.stderr.write(`snap-anchor grow ${h}\n`);
  }
  return { ok: true, height: store.tip().height };
}

function cloneBook(src) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n43-'));
  fs.cpSync(src, dest, { recursive: true });
  fs.mkdirSync(path.dirname(bookSealKeyPath(dest)), { recursive: true });
  fs.writeFileSync(bookSealKeyPath(dest), bookSealKeyFor(src));
  return dest;
}

function asBlock(tpl, height, hash) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hash,
    height,
    bSpendIds: [],
  };
}

function forkBlocks(prefix, dest, count, txsForFirst) {
  let flux = fluxsetFromBlocks(prefix);
  const out = [];
  let prev = prefix[prefix.length - 1];
  let now = headerTime(prev) + STEP;
  for (let i = 0; i < count; i += 1) {
    const chain = prefix.concat(out);
    const bits = retarget(chain, now);
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height) + 1,
      miner: dest,
      now,
      bits,
      txs: i === 0 && txsForFirst ? txsForFirst : [],
      parentBlocks: chain,
      parentFluxset: flux,
    });
    const block = asBlock(tpl, Number(prev.height) + 1, easyPow());
    block.miner = dest;
    out.push(block);
    appendFluxBlock(flux, block);
    prev = block;
    now += STEP;
  }
  return out;
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

function proveBalanced(tx, { x, index, flux, note, anchor, noteR, noteV, key }) {
  let fee = 0;
  let settled = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const out = noteV - fee;
    assert.ok(out > 0, `levy consumes the opened note ${noteV} fee ${fee}`);
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
    signSpendTx(tx, key);
    const need = levyNeed(tx);
    if (need === fee) {
      settled = real;
      break;
    }
    fee = need;
  }
  assert.ok(settled, 'balanced fee did not settle');
  return settled;
}

function windowQuantums(lockHeight) {
  const newest = lockHeight - K;
  const oldest = newest - ANCHOR_WINDOW;
  const start = Math.ceil(Math.max(oldest, ANCHOR_QUANTUM) / ANCHOR_QUANTUM) * ANCHOR_QUANTUM;
  const list = [];
  for (let A = start; A <= newest; A += ANCHOR_QUANTUM) list.push(A);
  return list;
}

function makeLock(prefix, who, opening, anchor, id) {
  const pot = prefix[0].txs[0].vout.find((o) => o.kind === 'pot');
  const found = indexOfCommit(prefix, anchor, pot.commit);
  assert.equal(found.height, 1, `pot height at anchor ${anchor}`);
  assert.ok(found.index >= 0, `pot index at anchor ${anchor}`);
  const x = admitScalarFromSeed(who.spendSeed, pot);
  assert.ok(Buffer.from(pointBytes(admitPub(x))).equals(Buffer.from(asU8(pot.admitPub))), 'pot key');
  const flux = fluxsetFromBlocks(prefix.filter((b) => Number(b.height) > 0 && Number(b.height) <= anchor));
  const lock = stripPayer(lockTx({
    from: who.dest,
    to: who.dest,
    nanos: 1,
    id,
  }));
  proveBalanced(lock, {
    x,
    index: found.index,
    flux,
    note: pot,
    anchor,
    noteR: opening.r,
    noteV: opening.v,
    key: who.key,
  });
  assert.equal(levyNeed(lock), lock.fee, `levy drifted at anchor ${anchor}`);
  return lock;
}

function buildFork(blocks, dest, who, opening, depth, anchor) {
  const tip = blocks.length;
  const parentIndex = tip - depth - 1;
  assert.ok(parentIndex >= 0, `depth ${depth} tip ${tip}`);
  const prefix = blocks.slice(0, parentIndex + 1);
  const lockHeight = tip - depth + 1;
  assert.equal(Number(prefix[prefix.length - 1].height) + 1, lockHeight);
  assert.ok(anchor <= Number(prefix[prefix.length - 1].height), `anchor ${anchor} past parent`);
  const lock = makeLock(prefix, who, opening, anchor, `lock-d${depth}-a${anchor}`);
  const fork = forkBlocks(prefix, dest, depth + 1, [lock]);
  assert.equal(fork[0].height, lockHeight);
  assert.ok((fork[0].txs || []).some((tx) => tx.id === lock.id), 'template dropped the lock');
  const candidate = prefix.concat(fork);
  assert.equal(shouldAdopt(blocks, candidate), true, `depth ${depth} is not heavier`);
  return fork;
}

function copyBlock(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(copyBlock);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = copyBlock(value[key]);
    return out;
  }
  return value;
}

async function adopt(store, fork) {
  const got = await Promise.resolve(store.ingest(copyBlock(fork), {
    trustBlockHash: true,
    skipSharePow: true,
  }));
  assert.equal(got.ok, true, got.reason || 'adopt');
  return got;
}

function tipHex(store) {
  return Buffer.from(store.tip().hash).toString('hex');
}

function rootHex(store) {
  return Buffer.from(store.jroot()).toString('hex');
}

function rebuiltRoot(store) {
  return Buffer.from(fluxsetFromBlocks(store.blocks).jroot).toString('hex');
}

describe('v12 snap reload anchor rows', () => {
  it('a reloaded store and a live store adopt the same lock fork', { timeout: 900_000 }, async () => {
    const span = frontierWindow(0);
    const deepest = span + SPACING + 5;
    const minTip = deepest + K + ANCHOR_WINDOW + ANCHOR_QUANTUM;
    const tipOff = minTip + ((8 - (minTip % SPACING) + SPACING) % SPACING);
    const tipOn = tipOff + (SPACING - 8);
    assert.equal(tipOff % SPACING, 8);
    assert.equal(tipOn % SPACING, 0);
    assert.ok(tipOff >= minTip && tipOn > tipOff);

    const dirs = [];
    const opening = { note: null };
    const who = payer();
    const dest = who.dest;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n43-live-'));
    dirs.push(dir);
    try {
      const live = createStore(dir, { reorgHaltDepth: 0, pruneAfter: 1_000_000 });
      const halt = live.reorgHaltDepth;
      assert.equal(halt, 0);
      let savedSnap = null;
      let savedVault = null;
      // The saved tip is far enough behind that the depth-24 anchor is outside
      // its frontier window. A short suffix would still keep that row.
      const saveAt = tipOff - span - SPACING;
      const built = growTo(live, dest, tipOff, opening, (store, h) => {
        if (h === saveAt) {
          savedSnap = fs.readFileSync(path.join(dir, 'book.snap'));
          savedVault = fs.readFileSync(path.join(dir, 'reserve.json'));
        }
      });
      assert.equal(built.ok, true, built.reason || 'grow');
      assert.equal(live.tip().height, tipOff);
      assert.ok(opening.note && opening.note.v > 1, 'opened pot');
      assert.equal(live.anchorView().roots, tipOff);
      assert.ok(savedSnap && savedVault, 'suffix snap');

      const offView = live.blocks.slice();
      const offEnds = windowQuantums(tipOff - 24 + 1);
      assert.equal(keepsFrontier(offEnds[0], tipOff, halt), false, 'depth 24 oldest stays kept');
      assert.equal(keepsFrontier(offEnds[offEnds.length - 1], tipOff, halt), true);

      const tReload = performance.now();
      const offDir = cloneBook(dir);
      dirs.push(offDir);
      const offSnap = createStore(offDir, { reorgHaltDepth: 0, pruneAfter: 1_000_000 });
      assert.equal(offSnap.loadMode, 'snap', offSnap.loadMode);
      assert.equal(offSnap.anchorView().roots, tipOff, `snap roots ${offSnap.anchorView().roots}`);
      assert.equal(rootHex(offSnap), rootHex(live));
      process.stderr.write(`snap-anchor reload ${tipOff} ${(performance.now() - tReload).toFixed(0)} ms\n`);

      const holeNote = live.anchorNote(offEnds[0]);
      const snapNote = offSnap.anchorNote(offEnds[0]);
      assert.ok(holeNote && holeNote.jroot, 'live hole row');
      assert.ok(snapNote && snapNote.jroot, 'snap hole row');
      assert.ok(Buffer.from(snapNote.jroot).equals(Buffer.from(holeNote.jroot)));
      assert.equal(Number(snapNote.n), Number(holeNote.n));

      process.stderr.write(`snap-anchor suffix from ${saveAt}\n`);
      const suffixDir = cloneBook(dir);
      dirs.push(suffixDir);
      fs.writeFileSync(path.join(suffixDir, 'book.snap'), savedSnap);
      fs.writeFileSync(path.join(suffixDir, 'reserve.json'), savedVault);
      const suffix = createStore(suffixDir, { reorgHaltDepth: 0, pruneAfter: 1_000_000 });
      assert.equal(suffix.loadMode, 'suffix', suffix.loadMode);
      assert.equal(suffix.tip().height, tipOff);
      assert.equal(suffix.anchorView().roots, tipOff, `suffix roots ${suffix.anchorView().roots}`);
      assert.equal(rootHex(suffix), rootHex(live));

      const depths = [24, SPACING, 56, 88, deepest];
      const adopted = [];
      for (const depth of depths) {
        const quantums = windowQuantums(tipOff - depth + 1);
        assert.ok(quantums.length >= 2, `depth ${depth} window`);
        const ends = [quantums[0], quantums[quantums.length - 1]];
        for (const anchor of ends) {
          const fork = buildFork(offView, dest, who, opening.note, depth, anchor);
          const snapDir = cloneBook(dir);
          dirs.push(snapDir);
          const snap = createStore(snapDir, { reorgHaltDepth: 0, pruneAfter: 1_000_000 });
          assert.equal(snap.loadMode, 'snap');
          const row = snap.anchorNote(anchor);
          const liveRow = live.anchorNote(anchor);
          assert.ok(row && liveRow, `anchor ${anchor} depth ${depth}`);
          assert.ok(Buffer.from(row.jroot).equals(Buffer.from(liveRow.jroot)));
          const t0 = performance.now();
          await adopt(snap, fork);
          process.stderr.write(`snap-anchor adopt depth ${depth} anchor ${anchor} ${(performance.now() - t0).toFixed(0)} ms\n`);
          assert.equal(snap.tip().height, tipOff + 1);
          assert.equal(rootHex(snap), rebuiltRoot(snap));
          assert.ok(snap.blocks.some((b) => (b.txs || []).some((tx) => tx.anchor === anchor && tx.kind === 'lock')));
          adopted.push({ depth, anchor, tip: tipHex(snap), root: rootHex(snap), fork });
        }
      }

      const suffixGap = tipOff - saveAt;
      const suffixDepth = suffixGap + 24;
      const suffixAnchor = saveAt - span;
      assert.equal(keepsFrontier(suffixAnchor, saveAt, halt), false, 'suffix snap keeps the anchor');
      assert.ok(windowQuantums(tipOff - suffixDepth + 1).includes(suffixAnchor));
      const suffixFork = buildFork(offView, dest, who, opening.note, suffixDepth, suffixAnchor);
      const suffixRow = suffix.anchorNote(suffixAnchor);
      const liveSuffixRow = live.anchorNote(suffixAnchor);
      assert.ok(suffixRow && liveSuffixRow, 'suffix hole row');
      assert.ok(Buffer.from(suffixRow.jroot).equals(Buffer.from(liveSuffixRow.jroot)));
      await adopt(suffix, suffixFork);
      assert.equal(suffix.tip().height, tipOff + 1);
      assert.equal(rootHex(suffix), rebuiltRoot(suffix));

      const liveFork = adopted.find((row) => row.depth === 24 && row.anchor === offEnds[0]);
      await adopt(live, liveFork.fork);
      assert.equal(tipHex(live), liveFork.tip);
      assert.equal(rootHex(live), liveFork.root);

      const onDirLive = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n43-on-'));
      dirs.push(onDirLive);
      const onLive = createStore(onDirLive, { reorgHaltDepth: 0, pruneAfter: 1_000_000 });
      const onOpening = { note: null };
      const onBuilt = growTo(onLive, dest, tipOn, onOpening);
      assert.equal(onBuilt.ok, true, onBuilt.reason || 'grow on');
      assert.equal(onLive.tip().height, tipOn);
      assert.equal(onLive.anchorView().roots, tipOn);
      const onView = onLive.blocks.slice();
      const onHoleDepth = SPACING;
      const onHole = windowQuantums(tipOn - onHoleDepth + 1)[0];
      assert.equal(keepsFrontier(onHole, tipOn, halt), false, 'checkpoint tip oldest is kept');
      const onDir = cloneBook(onDirLive);
      dirs.push(onDir);
      const onSnap = createStore(onDir, { reorgHaltDepth: 0, pruneAfter: 1_000_000 });
      assert.equal(onSnap.loadMode, 'snap');
      assert.equal(onSnap.anchorView().roots, tipOn);
      assert.ok(onOpening.note && onOpening.note.v > 1, 'opened pot on the checkpoint tip');
      const onFork = buildFork(onView, dest, who, onOpening.note, onHoleDepth, onHole);
      await adopt(onSnap, onFork);
      await adopt(onLive, onFork);
      assert.equal(tipHex(onLive), tipHex(onSnap));
      assert.equal(rootHex(onLive), rootHex(onSnap));
      assert.equal(rootHex(onLive), rebuiltRoot(onLive));
    } finally {
      for (const d of dirs) {
        try { fs.rmSync(bookSealKeyPath(d), { force: true }); } catch { /* key already gone */ }
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp dir */ }
      }
    }
  });
});

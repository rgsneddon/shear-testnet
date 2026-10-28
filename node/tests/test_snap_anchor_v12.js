/**
 * N-43 / N-46: a snap or suffix reload keeps n, jroot, and zeroRoot at every
 * height. Frontier blobs stay sparse. A heavier fork with an FS-1 B-leaf
 * lock anchored at a dropped height adopts on a reloaded store and on a store that never
 * reloaded, with the same tip and jroot.
 *
 * The spread is the reorg depth and the anchor end, at a tip that is a
 * multiple of the checkpoint spacing and at a tip that is not. The lock
 * spends the opened height-1 pot through an FS-1 proof at that anchor.
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
  admitPub,
  admitScalarFromSeed,
} from '../../crypto/admit.js';
import {
  asU8,
  pointBytes,
  openedCoinbaseNanos,
} from '../../crypto/note.js';
import { levyNeed } from '../../crypto/levy.js';
import { ANCHOR_QUANTUM, ANCHOR_WINDOW } from '../../crypto/admit_v3.js';
import { resetFs1Tree } from '../../crypto/fs1_spend.js';
import { lockSend } from './b_leaf_fs1.js';
import { bluWallet, soloCoin, soloPay } from './support/blunote_mine.js';

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

// R28: a payer's dest mines its first round solo with option (b); that pot
// is a record coin of its wallet.
const soloWallets = new Map();

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  const blu = bluWallet(id.spendSeed);
  soloWallets.set(dest, blu);
  return { id, dest, spendSeed: id.spendSeed, key: id.privateKey, blu };
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function sealNext(store, dest, opening) {
  const tip = store.tip();
  const now = tip ? headerTime(tip) + STEP : T0;
  const blu = !opening.note ? soloWallets.get(dest) : null;
  const { tpl } = store.template({ miner: dest, now, ...(blu ? soloPay(blu) : {}) });
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
  if (blu && got.ok) {
    const pot = soloCoin(blu, store.tip());
    if (pot && pot.v > 1) opening.note = { r: pot.r, v: pot.v, commit: pot.commit };
  }
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

function windowQuantums(lockHeight) {
  const newest = lockHeight - K;
  const oldest = newest - ANCHOR_WINDOW;
  const start = Math.ceil(Math.max(oldest, ANCHOR_QUANTUM) / ANCHOR_QUANTUM) * ANCHOR_QUANTUM;
  const list = [];
  for (let A = start; A <= newest; A += ANCHOR_QUANTUM) list.push(A);
  return list;
}

let lockNonce = 1;

/**
 * An FS-1 B-leaf lock (b_leaf_fs1.js lockSend) that spends the height-1 pot
 * under `anchor`. The FS-1 leaves at an anchor are the first n admit-set
 * notes, so the view is the prefix up to that anchor. v12 Stage 0 refuses a
 * vault lock with a v3 bucket proof (vault_unavailable until Stage 3b), so
 * the anchored spend is an FS-1 send that locks a unit.
 */
function makeLock(prefix, who, opening, anchor, id) {
  const pot = soloCoin(who.blu, prefix[0]);
  assert.ok(pot && pot.commit.equals(Buffer.from(asU8(opening.commit))), 'opened pot');
  const flux = fluxsetFromBlocks(prefix.filter((b) => Number(b.height) > 0 && Number(b.height) <= anchor));
  const live = { n: flux.pubs.length, pubs: flux.pubs, commits: flux.commits };
  const want = Buffer.from(asU8(pot.commit));
  const index = flux.commits.findIndex((c) => Buffer.from(asU8(c)).equals(want));
  assert.ok(index >= 0, `pot index at anchor ${anchor}`);
  const x = pot.x;
  assert.ok(Buffer.from(pointBytes(admitPub(x))).equals(Buffer.from(asU8(pot.admitPub))), 'pot key');
  const lock = lockSend(who, {
    id,
    unit: 9,
    nonce: lockNonce,
    tag: 'b-extra',
    memoH: Buffer.alloc(32),
  }, {
    r: Buffer.from(asU8(opening.r)),
    v: opening.v,
    commit: want,
    index,
    x,
  }, anchor, live);
  lockNonce += 1;
  // FS-1 consensus is fee >= levyNeed. lockSend settles the fee with range
  // slack, so the old equality from the v3 settle loop does not apply.
  assert.ok(levyNeed(lock) <= lock.fee, `levy short at anchor ${anchor}`);
  assert.equal(lock.anchor, anchor);
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

    resetFs1Tree();
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
      let savedVaultSnap = null;
      // The saved tip is far enough behind that the depth-24 anchor is outside
      // its frontier window. A short suffix would still keep that row.
      const saveAt = tipOff - span - SPACING;
      const built = growTo(live, dest, tipOff, opening, (store, h) => {
        if (h === saveAt) {
          store.flushBookSnap();
          savedSnap = fs.readFileSync(path.join(dir, 'book.snap'));
          savedVault = fs.readFileSync(path.join(dir, 'reserve.json'));
          savedVaultSnap = fs.readFileSync(path.join(dir, 'vault.snap'));
        }
      });
      assert.equal(built.ok, true, built.reason || 'grow');
      assert.equal(live.tip().height, tipOff);
      live.flushBookSnap();
      assert.ok(opening.note && opening.note.v > 1, 'opened pot');
      assert.equal(live.anchorView().roots, tipOff);
      assert.ok(savedSnap && savedVault && savedVaultSnap, 'suffix snap');

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
      fs.writeFileSync(path.join(suffixDir, 'vault.snap'), savedVaultSnap);
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
          assert.equal(snap.loadMode, 'snap', snap.loadMode);
          const row = snap.anchorNote(anchor);
          const liveRow = live.anchorNote(anchor);
          assert.ok(row && liveRow, `anchor ${anchor} depth ${depth}`);
          assert.ok(Buffer.from(row.jroot).equals(Buffer.from(liveRow.jroot)));
          const t0 = performance.now();
          await adopt(snap, fork);
          process.stderr.write(`snap-anchor adopt depth ${depth} anchor ${anchor} ${(performance.now() - t0).toFixed(0)} ms\n`);
          assert.equal(snap.tip().height, tipOff + 1);
          assert.equal(rootHex(snap), rebuiltRoot(snap));
          // The anchored spend is an FS-1 B-leaf lock (kind send, bFlag 1), not a
          // vault lock. Same anchor and same fork id; only the kind changed.
          const lockId = `lock-d${depth}-a${anchor}`;
          assert.ok(snap.blocks.some((b) => (b.txs || []).some((tx) => tx.anchor === anchor && tx.id === lockId && tx.kind === 'send' && Number(tx.bFlag) === 1)));
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

  // PR 116: a bucket proof (byte 3) is not an FS-1 vault lock. It is refused
  // before a snap reload, on the same reason the four vault paths use.
  it('a byte-3 lock is vault_unavailable before a snap reload', { timeout: 30_000 }, async () => {
    const commit = Buffer.alloc(32, 4);
    const blob = Buffer.alloc(129, 0);
    blob[0] = 3;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-snap-anchor-'));
    try {
      const store = createStore(dir);
      const queued = store.queueTx({
        id: 'byte3-lock',
        kind: 'lock',
        vin: [{ commit }],
        admit_proofs: [{ blob, cTilde: commit }],
      });
      assert.equal(queued.reason, 'vault_unavailable');
    } finally {
      try { fs.rmSync(bookSealKeyPath(dir), { force: true }); } catch { /* key already gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

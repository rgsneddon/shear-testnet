/**
 * P0-c2a-1: append, load, fork, and IBD extend a cached frontier. A depth-d
 * reorg's leaf count does not grow with the height under it.
 * PSA-c2a-1: a pruned credited block is buried under the caller's tip.
 * A peer tipHeight does not bury it. Stepped supply matches a fold at that tip.
 * N-13: a heavier side branch adopts, including a lock whose anchor is an
 * earlier height than the last block of a non-canonical suffix.
 *
 * Genesis has no parent header, so a share batch there is share_batch.
 * The oldest credited block is the first child.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, OWED_CHECKPOINT_SPACING } from '../src/store.js';
import { CHECKPOINT_FIRST_HEIGHT } from '../src/bootstrap.js';
import { buildTemplate, retarget, verifyBlock, verifyLoadedChain } from '../src/chain.js';
import { auditCirculatingSupply, emptySupplyState, foldSupply, supplyStep } from '../src/supply.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  MAGIC_TESTNET,
} from '../../crypto/asert.js';
import { SAMPLE_PRUNE_CONFIRMATIONS, shouldPruneSamples } from '../../crypto/chronoflux.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
  clearLiveSharePow,
} from '../../crypto/share_batch.js';
import {
  jroot,
  emptyFluxset,
  appendFluxBlock,
  fluxsetFromBlocks,
  takeFrontierStats,
  outputJoinsAdmitSet,
  admitProveV3,
  admitPub,
  admitScalarFromSeed,
  blindCommit,
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
import { walletAnchor, txDigestV3, admitV3Context, ANCHOR_QUANTUM } from '../../crypto/admit_v3.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const PRUNE = SAMPLE_PRUNE_CONFIRMATIONS;
const TIP = PRUNE + 40;
const STEP = TARGET_BLOCK_INTERVAL_MS;

let powTag = 1;
function easyPow() {
  const h = Buffer.alloc(32);
  // The first four bytes stay zero so an easy genesis target still accepts
  // the stand-in. trustedPowHash does not skip the target check.
  h.writeUInt32LE(powTag >>> 0, 4);
  powTag += 1;
  return h;
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { id, dest, spendSeed: id.spendSeed, key: id.privateKey };
}

function shareAt(dest, low, bits) {
  return {
    dest,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
  };
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
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

function sealNext(store, dest, share = null) {
  const tip = store.tip();
  const now = tip ? headerTime(tip) + STEP : T0;
  if (share && tip?.header) {
    share.verifiedHeader = tip.header;
    rememberLiveSharePow(tip.header, share.nonce, {
      noteCommit: noteCommitOfShare(share),
      shareBits: share.shareBits,
      lz: share.lz,
    });
  }
  const { tpl } = store.template({
    miner: dest,
    now,
    shareBits: SHARE_FLOOR_BITS,
    shareBatch: share ? [share] : [],
  });
  return store.append({
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
}

function grow(store, dest, n, creditAt = null) {
  for (let i = 0; i < n; i += 1) {
    const height = (store.tip()?.height || 0) + 1;
    const share = creditAt && creditAt.has(height)
      ? shareAt(dest, BigInt(height + 7), SHARE_FLOOR_BITS)
      : null;
    const got = sealNext(store, dest, share);
    if (!got.ok) return { ok: false, reason: got.reason, height };
    if (share) {
      const credits = store.tip()?.hashCredits;
      if (!Array.isArray(credits) || credits.length < 1) {
        return { ok: false, reason: 'no_credit', height };
      }
    }
    if (height % 200 === 0) process.stderr.write(`frontier-grow ${height}\n`);
  }
  return { ok: true, height: store.tip().height };
}

function forkBlocks(prefix, dest, count, tagBase, txsForFirst = null) {
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
    if ((i + 1) % 200 === 0) process.stderr.write(`frontier-fork ${i + 1}/${count}\n`);
  }
  return out;
}

function ingest(store, fork) {
  return store.ingest(fork, { trustBlockHash: true, skipSharePow: true, nowMs: Date.now() });
}

function joiningNotes(block) {
  let n = 0;
  for (const tx of block?.txs || []) {
    for (const o of tx?.vout || []) {
      if (outputJoinsAdmitSet(tx, o)) n += 1;
    }
  }
  return n;
}

function bufEq(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.equals(y);
}

function assertZeroRoots(blocks) {
  const flux = emptyFluxset();
  let saw32 = false;
  let saw33 = false;
  let saw1024 = false;
  for (let i = 0; i < blocks.length; i += 1) {
    const before = flux.pubs.length;
    appendFluxBlock(flux, blocks[i]);
    const cb = blocks[i]?.txs?.[0];
    assert.ok(bufEq(flux.zeroRoot, cb?.jroot), `pubs-only root at height ${blocks[i].height}`);
    const n = flux.pubs.length;
    const crossed = (bound) => before < bound && n >= bound;
    const boundary = crossed(32) || crossed(33) || crossed(1024) || i === blocks.length - 1;
    if (boundary) {
      const full = jroot({ pubs: flux.pubs, commits: flux.commits });
      const zero = jroot(flux.pubs);
      assert.ok(bufEq(full, flux.jroot), `commit root at n=${n}`);
      assert.ok(bufEq(zero, flux.zeroRoot), `zero root at n=${n}`);
    }
    if (n >= 32) saw32 = true;
    if (n >= 33) saw33 = true;
    if (n >= 1024) saw1024 = true;
  }
  return { n: flux.pubs.length, saw32, saw33, saw1024 };
}

const SUPPLY_FIELDS = [
  'mintedPot', 'carry', 'mintedHash', 'mintedLevy', 'permittedHashAll',
  'acceptedHash', 'dust', 'overflow', 'liveUnit', 'genesisMs', 'height',
];

function sameSupply(a, b) {
  for (const k of SUPPLY_FIELDS) {
    if (a[k] !== b[k]) return k;
  }
  return '';
}

function parentView(block) {
  return {
    hash: block.hash,
    header: block.header,
    height: block.height,
    rootA: block.rootA,
    rootB: block.rootB,
    txs: block.txs,
    bLeaves: block.bLeaves,
    weight: block.weight,
    shareBatch: block.shareBatch,
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
        if (got.length === 32 && got.equals(want)) return { index, note: o, height: h };
        index += 1;
      }
    }
  }
  return { index: -1, note: null, height: 0 };
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
    assert.deepEqual(Buffer.from(real.spendTag), Buffer.from(probe.spendTag));
    assert.deepEqual(Buffer.from(real.cTilde), Buffer.from(blindCommit(note.commit, scalarBytes(t))));
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
  return settled;
}

describe('v12 frontier, burial, and reorg fallback', () => {
  it('a depth-2 reorg costs the same at two heights, and the pubs-only root matches the coinbase', { timeout: 600_000 }, () => {
    clearLiveSharePow();
    const dest = minerDest();
    const shortDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fr-short-'));
    const longDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fr-long-'));
    const short = createStore(shortDir);
    const long = createStore(longDir);
    const depth = 2;

    let built = grow(short, dest, 32);
    assert.equal(built.ok, true, `${built.reason} at ${built.height}`);
    takeFrontierStats();
    const earlyFork = forkBlocks(short.blocks.slice(0, short.blocks.length - depth), dest, depth + 1, 1);
    const earlyNotes = earlyFork.reduce((n, b) => n + joiningNotes(b), 0);
    takeFrontierStats();
    const earlyGot = ingest(short, earlyFork);
    const earlyStats = takeFrontierStats();
    assert.equal(earlyGot.ok, true, earlyGot.reason || 'short reorg');
    assert.equal(earlyStats.fullRoots, 0, 'short reorg rebuilt the root');
    assert.ok(earlyStats.appendedLeaves > 0);
    assert.ok(earlyStats.appendedLeaves <= earlyNotes * 2, `${earlyStats.appendedLeaves} leaves for ${earlyNotes} notes`);

    built = grow(long, dest, 16);
    assert.equal(built.ok, true, built.reason);
    takeFrontierStats();
    built = grow(long, dest, 8);
    const earlyConnect = takeFrontierStats();
    built = grow(long, dest, 96);
    assert.equal(built.ok, true, built.reason);
    takeFrontierStats();
    built = grow(long, dest, 8);
    const lateConnect = takeFrontierStats();
    assert.equal(earlyConnect.fullRoots, 0);
    assert.equal(lateConnect.fullRoots, 0);
    assert.ok(earlyConnect.appendedLeaves > 0);
    assert.equal(
      earlyConnect.appendedLeaves,
      lateConnect.appendedLeaves,
      `connect leaves ${earlyConnect.appendedLeaves} then ${lateConnect.appendedLeaves}`,
    );

    const roots = assertZeroRoots(long.blocks);
    assert.equal(roots.saw32, true, `n=${roots.n} never reached 32`);
    assert.equal(roots.saw33, true, `n=${roots.n} never reached 33`);

    const lateFork = forkBlocks(long.blocks.slice(0, long.blocks.length - depth), dest, depth + 1, 2);
    const lateNotes = lateFork.reduce((n, b) => n + joiningNotes(b), 0);
    takeFrontierStats();
    const lateGot = ingest(long, lateFork);
    const lateStats = takeFrontierStats();
    assert.equal(lateGot.ok, true, lateGot.reason || 'long reorg');
    assert.equal(lateStats.fullRoots, 0, 'long reorg rebuilt the root');
    assert.equal(
      earlyStats.appendedLeaves,
      lateStats.appendedLeaves,
      `reorg leaves ${earlyStats.appendedLeaves} at 32 and ${lateStats.appendedLeaves} at ${long.tip().height} (${earlyNotes} vs ${lateNotes} notes)`,
    );

    // A snap below the prune depth replays only the suffix. Prune rewrites the
    // packed frame, so this chain stays shorter than the prune depth.
    const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fr-snap-'));
    const snapStore = createStore(snapDir);
    built = grow(snapStore, dest, 2);
    assert.equal(built.ok, true, built.reason);
    const snap = fs.readFileSync(path.join(snapDir, 'book.snap'));
    const vault = fs.readFileSync(path.join(snapDir, 'reserve.json'));
    built = grow(snapStore, dest, 6);
    assert.equal(built.ok, true, built.reason);
    const snapTip = Buffer.from(snapStore.tip().hash);
    fs.writeFileSync(path.join(snapDir, 'book.snap'), snap);
    fs.writeFileSync(path.join(snapDir, 'reserve.json'), vault);
    const snapped = createStore(snapDir);
    assert.equal(snapped.loadMode, 'suffix', snapped.loadMode);
    assert.equal(snapped.tip().height, 8);
    assert.ok(bufEq(snapped.tip().hash, snapTip));
  });

  it('a lock anchored before the side tip still verifies on the second extension', { timeout: 600_000 }, async () => {
    clearLiveSharePow();
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fr-anchor-'));
    const store = createStore(dir);
    const forkParent = ANCHOR_QUANTUM * 2;
    const mainH = forkParent + ANCHOR_QUANTUM;
    const openings = [];
    for (let i = 0; i < mainH; i += 1) {
      const tip = store.tip();
      const now = tip ? headerTime(tip) + STEP : T0;
      const { tpl } = store.template({ miner: who.dest, shareBits: 4, now });
      const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
      const got = store.append({
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
      }, { trustedPowHash: easyPow(), skipSharePow: true });
      assert.equal(got.ok, true, `${got.reason || 'seal'} at ${i + 1}`);
      if (pot?.r && pot.commit && openings.length === 0) {
        openings.push({ r: pot.r, v: openedCoinbaseNanos(pot), commit: Buffer.from(asU8(pot.commit)) });
      }
    }
    assert.equal(store.tip().height, mainH);
    const noteOpen = openings[0];
    assert.ok(noteOpen && noteOpen.v > 1, String(noteOpen && noteOpen.v));
    const lockHeight = forkParent + 2;
    const anchor = walletAnchor(lockHeight);
    assert.equal(typeof anchor, 'number');
    assert.ok(anchor < forkParent, `anchor ${anchor} is the side tip's parent ${forkParent}`);

    const pot = store.blocks[0].txs[0].vout.find((o) => o.kind === 'pot');
    const found = indexOfCommit(store.blocks, anchor, pot.commit);
    assert.equal(found.height, 1);
    assert.ok(found.index >= 0, 'pot is inside the anchor');
    const x = admitScalarFromSeed(who.spendSeed, pot);
    assert.ok(bufEq(pointBytes(admitPub(x)), pot.admitPub), 'pot key');
    const flux = fluxsetFromBlocks(store.blocks.filter((b) => Number(b.height) > 0 && Number(b.height) <= anchor));
    const lock = stripPayer(lockTx({
      from: who.dest,
      to: who.dest,
      nanos: 1,
      id: 'v12-side-lock',
    }));
    proveBalanced(lock, {
      x,
      index: found.index,
      flux,
      note: pot,
      anchor,
      noteR: noteOpen.r,
      noteV: noteOpen.v,
    });
    signSpendTx(lock, who.key);

    const prefix = store.blocks.slice(0, forkParent);
    const first = forkBlocks(prefix, who.dest, 1, 10);
    const held = await Promise.resolve(ingest(store, first));
    assert.equal(held.ok, false);
    assert.equal(held.reason, 'side_hold', held.reason || 'first side');
    assert.equal(store.tip().height, mainH);

    const sidePrefix = prefix.concat(first);
    const second = forkBlocks(sidePrefix, who.dest, 1, 20, [lock]);
    assert.equal(second[0].height, lockHeight);
    const locked = await Promise.resolve(ingest(store, second));
    assert.notEqual(locked.reason, 'admit_anchor_root');
    assert.notEqual(locked.reason, 'hash_owed');
    assert.ok(locked.ok || locked.reason === 'side_hold', locked.reason || 'lock side');

    let guard = 0;
    let cursor = sidePrefix.concat(second);
    while (store.tip().height === mainH && guard < mainH) {
      const more = forkBlocks(cursor, who.dest, 1, 30 + guard);
      const got = await Promise.resolve(ingest(store, more));
      assert.notEqual(got.reason, 'admit_anchor_root');
      assert.notEqual(got.reason, 'hash_owed');
      assert.ok(got.ok || got.reason === 'side_hold', got.reason || 'extend side');
      cursor = cursor.concat(more);
      guard += 1;
    }
    assert.ok(store.tip().height > mainH, 'side branch never became heavier');
    const sealed = store.blocks.some((b) => (b.txs || []).some((tx) => tx.id === 'v12-side-lock'));
    assert.equal(sealed, true, 'lock is on the adopted branch');

    const againParent = store.blocks.length - 1 - 2;
    const again = forkBlocks(store.blocks.slice(0, againParent + 1), who.dest, 3, 80);
    const adopted = await Promise.resolve(ingest(store, again));
    assert.equal(adopted.ok, true, adopted.reason || 'post-adopt reorg');
    assert.notEqual(adopted.reason, 'hash_owed');
  });

  it('pruned credits stay valid under the caller tip across load, IBD, and a deeper fork', { timeout: 2_700_000 }, () => {
    clearLiveSharePow();
    const dest = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fr-bury-'));
    const store = createStore(dir);
    const creditAt = new Set([2, OWED_CHECKPOINT_SPACING, OWED_CHECKPOINT_SPACING + 1, TIP - PRUNE]);
    const boundary = TIP - PRUNE;

    let built = grow(store, dest, 64, creditAt);
    assert.equal(built.ok, true, `${built.reason} at ${built.height}`);
    const lowParent = store.blocks.length - 1 - 2;
    const lowFork = forkBlocks(store.blocks.slice(0, lowParent + 1), dest, 1, 100);
    takeFrontierStats();
    const lowHold = ingest(store, lowFork);
    const lowStats = takeFrontierStats();
    assert.equal(lowHold.reason, 'side_hold', lowHold.reason || 'low hold');
    assert.equal(lowStats.fullRoots, 0);
    assert.equal(lowStats.appendedLeaves, joiningNotes(lowFork[0]));

    built = grow(store, dest, TIP - store.tip().height, creditAt);
    assert.equal(built.ok, true, `${built.reason} at ${built.height}`);
    assert.equal(store.tip().height, TIP);

    const highParent = store.blocks.length - 1 - 2;
    const highFork = forkBlocks(store.blocks.slice(0, highParent + 1), dest, 1, 200);
    takeFrontierStats();
    const highHold = ingest(store, highFork);
    const highStats = takeFrontierStats();
    assert.equal(highHold.reason, 'side_hold', highHold.reason || 'high hold');
    assert.equal(highStats.fullRoots, 0);
    assert.equal(
      lowStats.appendedLeaves,
      highStats.appendedLeaves,
      `hold leaves ${lowStats.appendedLeaves} then ${highStats.appendedLeaves}`,
    );

    for (const h of creditAt) {
      const block = store.blocks[h - 1];
      assert.equal(block.height, h);
      assert.ok(Array.isArray(block.hashCredits) && block.hashCredits.length > 0, `credit ${h}`);
      assert.equal(shouldPruneSamples(h, TIP), true, `height ${h} buried at ${TIP}`);
      assert.equal(block.samplesPruned, true, `height ${h} pruned`);
      assert.equal((block.shareBatch || []).length, 0);
    }
    assert.equal(store.blocks[0].samplesPruned, true, 'height 1 prunes once the tip reaches the depth');
    assert.equal(store.blocks[boundary - 1].height, boundary);
    assert.equal(store.blocks[boundary - 1].samplesPruned, true);
    assert.equal(store.blocks[boundary].height, boundary + 1);
    assert.equal(store.blocks[boundary].samplesPruned === true, false);

    const credited = store.blocks[1];
    const genesisMs = headerTime(store.blocks[0]);
    const shallow = verifyBlock(credited, parentView(store.blocks[0]), {
      burialTip: credited.height + PRUNE - 1,
      trustedPowHash: credited.hash,
      skipSharePow: true,
      genesisMs,
      nowMs: Date.now(),
    });
    assert.equal(shallow.ok, false);
    assert.equal(shallow.reason, 'samples_pruned', shallow.reason);
    const peer = verifyBlock(credited, parentView(store.blocks[0]), {
      tipHeight: credited.height + PRUNE + 40,
      trustedPowHash: credited.hash,
      skipSharePow: true,
      genesisMs,
      nowMs: Date.now(),
    });
    assert.equal(peer.ok, false);
    assert.equal(peer.reason, 'samples_pruned', peer.reason);

    const shortFold = foldSupply(store.blocks.slice(0, credited.height), {
      tipHeight: credited.height + PRUNE - 1,
      genesisMs,
    });
    assert.equal(shortFold.ok, false);
    assert.equal(shortFold.reason, 'hash_owed', shortFold.reason);

    const chain = store.blocks.slice();
    const tipHash = Buffer.from(store.tip().hash);
    const roots = assertZeroRoots(chain);
    assert.equal(roots.saw1024, true, `n=${roots.n} never reached 1024`);

    const audited = auditCirculatingSupply(chain, { magic: MAGIC_TESTNET });
    assert.equal(audited.status, 'verified', audited.reason || 'supply');

    process.stderr.write('frontier-phase load\n');
    fs.rmSync(path.join(dir, 'book.snap'));
    const full = createStore(dir);
    assert.equal(full.loadMode, 'full', full.loadMode);
    assert.ok(bufEq(full.tip().hash, tipHash));

    const loaded = verifyLoadedChain(chain, {
      trustStoredHash: true,
      nowMs: Date.now(),
      genesisMs,
    });
    assert.equal(loaded.ok, true, loaded.reason || 'reload');
    assert.equal(loaded.supplyAt.length, chain.length);
    const folded = foldSupply(chain, { tipHeight: TIP, genesisMs });
    assert.equal(folded.ok, true, folded.reason || 'fold');
    assert.equal(sameSupply(folded.state, loaded.supplyAt[chain.length - 1]), '');
    let stepped = emptySupplyState(genesisMs);
    for (let i = 0; i < chain.length; i += 1) {
      const next = supplyStep(stepped, chain[i], {
        tipHeight: TIP,
        height: i + 1,
        genesisMs,
        blockHash: chain[i].hash,
        magic: MAGIC_TESTNET,
      });
      assert.equal(next.ok, true, `${next.reason} at height ${i + 1}`);
      stepped = next.state;
      const field = sameSupply(stepped, loaded.supplyAt[i]);
      assert.equal(field, '', `${field} drifted at height ${i + 1}`);
    }

    process.stderr.write('frontier-phase ibd\n');
    const ibdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fr-ibd-'));
    const ibd = createStore(ibdDir);
    const adopted = ingest(ibd, chain);
    assert.equal(adopted.ok, true, adopted.reason || 'ibd');
    assert.ok(bufEq(ibd.tip().hash, tipHash));

    // The reorg floor freezes the block at CHECKPOINT_FIRST_HEIGHT. A branch
    // that replaces it is refused. One that starts there still re-steps the
    // pruned credits under the new tip.
    const under = ibd.blocks.slice(0, 20);
    assert.ok(shouldPruneSamples(under[under.length - 1].height, TIP));
    const heldUnder = ingest(ibd, forkBlocks(under, dest, 1, 300));
    assert.equal(heldUnder.reason, 'side_hold', heldUnder.reason || 'under prune');
    assert.equal(ibd.tip().height, TIP);

    const floor = CHECKPOINT_FIRST_HEIGHT;
    assert.ok(TIP > floor);
    const count = (ibd.blocks.length - floor) + 1;
    process.stderr.write(`frontier-phase fork ${count}\n`);
    const deep = forkBlocks(ibd.blocks.slice(0, floor), dest, count, 500);
    const deepGot = ingest(ibd, deep);
    assert.equal(deepGot.ok, true, deepGot.reason || 'deep reorg');
    assert.notEqual(deepGot.reason, 'hash_owed');
    assert.ok(ibd.tip().height > TIP);

    const thirdParent = ibd.blocks.length - 1 - 2;
    const third = forkBlocks(ibd.blocks.slice(0, thirdParent + 1), dest, 3, 400);
    const thirdGot = ingest(ibd, third);
    assert.equal(thirdGot.ok, true, thirdGot.reason || 'second deep reorg');
  });
});

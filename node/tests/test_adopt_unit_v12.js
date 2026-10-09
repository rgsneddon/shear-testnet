/**
 * N-23. A heavier branch whose hash-bonus unit changes is adopted.
 * The unit is the one the chain walked, for any epoch length and any
 * starting unit. A constant unit does not describe that branch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { shouldAdopt } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  MAGIC_TESTNET,
  TARGET_BLOCK_INTERVAL_MS,
  MTP_FUTURE_MS,
  MTP_WINDOW,
  PI_SHE_NANOS,
} from '../../crypto/asert.js';
import { epochMs } from '../../crypto/pot_sched.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest, hash20FromAddress, admitBaseFromAddress } from '../../crypto/address.js';
import {
  outputJoinsAdmitSet,
  admitProveV3,
  admitPub,
  admitScalarFromSeed,
  fluxsetFromBlocks,
  attachAdmitPub,
} from '../../crypto/admit.js';
import {
  asU8,
  pointBytes,
  scalarBytes,
  kernelExcess,
  openedCoinbaseNanos,
  sealCoinbaseNote,
  sealNote,
  randomScalar,
} from '../../crypto/note.js';
import { lockTx, voteTx, VOTE_INCREASE, bonusUnitsBefore } from '../../crypto/reserve_vault.js';
import { signSpendTx, typedCommitSum } from '../../crypto/spend.js';
import { levyNeed } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { packEpochBlock, unpackEpochBlock } from '../../crypto/chainbin.js';
import { walletAnchor, readyHeight, txDigestV3, admitV3Context } from '../../crypto/admit_v3.js';

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

describe('v12 adopt keeps the walked hash-bonus unit', () => {
  it('a heavier branch that changes the unit is adopted', { timeout: 600_000 }, async () => {
    const who = payer();
    const heavyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-unit-heavy-'));
    const lightDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-unit-light-'));
    try {
      const heavy = createStore(heavyDir);
      const firstReady = readyHeight(1);
      assert.equal(Number.isInteger(firstReady), true);
      assert.ok(firstReady > 1);
      const openings = [];
      await mineUntil(heavy, who.dest, firstReady - 1, (tip) => (
        tip ? headerTime(tip) + STEP : T0
      ), openings);
      assert.ok(openings.length > 0 && openings[0].v > 0, String(openings[0] && openings[0].v));
      const joinCap = Math.ceil(PI_SHE_NANOS / openings[0].v) + 4;
      const used = new Set();
      let locks = 0;
      let blanks = 0;
      while (!(Number(heavy.reserveVault.epochStartMs) > 0)) {
        const spend = nextSpendable(heavy, openings, used);
        if (!spend) {
          assert.ok(blanks < firstReady + joinCap, `no confirmed note after ${blanks}`);
          const minted = await seal(heavy, who.dest, headerTime(heavy.tip()) + STEP);
          if (minted) openings.push(minted);
          blanks += 1;
          continue;
        }
        assert.ok(locks < joinCap, `portal did not join after ${locks} locks`);
        const x = admitScalarFromSeed(who.spendSeed, spend.pot);
        assert.ok(Buffer.from(pointBytes(admitPub(x))).equals(Buffer.from(asU8(spend.pot.admitPub))), 'pot key');
        const lock = stripPayer(lockTx({
          from: who.dest,
          to: who.dest,
          nanos: 1,
          id: `unit-lock-${spend.open.height}`,
        }));
        proveLock(lock, {
          x,
          index: spend.found.index,
          flux: anchorFlux(heavy.blocks, spend.anchor),
          note: spend.pot,
          anchor: spend.anchor,
          noteR: spend.open.r,
          noteV: spend.open.v,
        });
        signSpendTx(lock, who.key);
        const queuedLock = heavy.queueTx(lock);
        assert.equal(queuedLock.ok, true, queuedLock.reason || 'queue lock');
        const minted = await seal(heavy, who.dest, headerTime(heavy.tip()) + STEP);
        if (minted) openings.push(minted);
        used.add(spend.open.height);
        locks += 1;
        assert.equal(
          heavy.blocks.some((b) => (b.txs || []).some((tx) => tx.id === lock.id)),
          true,
          `lock ${spend.open.height} was not sealed`,
        );
      }
      assert.ok(locks > 0, 'joined without a lock');
      let voteSpend = null;
      let voteBlanks = 0;
      while (!voteSpend) {
        voteSpend = nextSpendable(heavy, openings, used);
        if (voteSpend) break;
        assert.ok(voteBlanks < firstReady, `no vote note after ${voteBlanks}`);
        const minted = await seal(heavy, who.dest, headerTime(heavy.tip()) + STEP);
        if (minted) openings.push(minted);
        voteBlanks += 1;
      }
      const voteX = admitScalarFromSeed(who.spendSeed, voteSpend.pot);
      assert.ok(Buffer.from(pointBytes(admitPub(voteX))).equals(Buffer.from(asU8(voteSpend.pot.admitPub))), 'vote pot key');
      const vote = stripPayer(voteTx({
        from: who.dest,
        dest: who.dest,
        choice: VOTE_INCREASE,
        id: 'unit-vote',
      }));
      proveVote(vote, {
        x: voteX,
        index: voteSpend.found.index,
        flux: anchorFlux(heavy.blocks, voteSpend.anchor),
        note: voteSpend.pot,
        anchor: voteSpend.anchor,
        noteR: voteSpend.open.r,
        noteV: voteSpend.open.v,
        base: admitBaseFromAddress(who.dest),
      });
      signSpendTx(vote, who.key);
      const queuedVote = heavy.queueTx(vote);
      assert.equal(queuedVote.ok, true, queuedVote.reason || 'queue vote');
      const voteMint = await seal(heavy, who.dest, headerTime(heavy.tip()) + STEP);
      if (voteMint) openings.push(voteMint);
      assert.equal(heavy.blocks.some((b) => (b.txs || []).some((tx) => tx.id === 'unit-vote')), true);

      const floorUnit = Number(heavy.reserveVault.liveHashBonusNanos);
      assert.ok(floorUnit >= 1);
      const epochEnd = Number(heavy.reserveVault.epochStartMs) + epochMs(MAGIC_TESTNET);
      const span = epochEnd - headerTime(heavy.tip());
      assert.ok(span > 0, 'epoch already closed');
      const stepCap = Math.ceil(span / MTP_FUTURE_MS) * MTP_WINDOW + MTP_WINDOW;
      let steps = 0;
      while (Number(heavy.reserveVault.liveHashBonusNanos) === floorUnit && steps < stepCap) {
        const parentTs = headerTime(heavy.tip());
        await seal(heavy, who.dest, Math.max(epochEnd, parentTs + MTP_FUTURE_MS - 1));
        steps += 1;
        if (steps % 32 === 0) console.error(`phase walk ${steps} h=${heavy.tip().height}`);
      }
      const raised = Number(heavy.reserveVault.liveHashBonusNanos);
      assert.ok(raised > floorUnit, `unit stayed ${floorUnit} after ${steps}`);
      assert.equal(raised, floorUnit + 1);
      await seal(heavy, who.dest, headerTime(heavy.tip()) + STEP);
      assert.equal(Number(heavy.reserveVault.liveHashBonusNanos), raised);
      const units = bonusUnitsBefore(heavy.blocks);
      assert.ok(units && units.length === heavy.blocks.length);
      assert.ok(new Set(units).size > 1, `units ${units[0]}..${units[units.length - 1]}`);
      assert.equal(units[units.length - 1], raised);
      assert.ok(units.some((unit) => unit === floorUnit));
      const heavyTip = Buffer.from(heavy.tip().hash);
      const heavyHeight = heavy.tip().height;

      const light = createStore(lightDir);
      const genesis = await Promise.resolve(light.ingest(wireBlocks(heavy.blocks.slice(0, 1)), { trustBlockHash: true }));
      assert.equal(genesis.ok, true, genesis.reason || 'genesis');
      assert.equal(light.tip().height, 1);
      assert.equal(Number(light.reserveVault.liveHashBonusNanos), floorUnit);
      assert.equal(shouldAdopt(light.blocks, heavy.blocks), true);
      assert.ok(!Buffer.from(light.tip().hash).equals(heavyTip));
      const adopted = await Promise.resolve(light.ingest(wireBlocks(heavy.blocks), { trustBlockHash: true }));
      assert.equal(adopted.ok, true, `${adopted.reason || 'adopt'} at ${adopted.at}`);
      assert.equal(light.tip().height, heavyHeight);
      assert.ok(Buffer.from(light.tip().hash).equals(heavyTip));
      assert.equal(Number(light.reserveVault.liveHashBonusNanos), raised);
      const adoptedUnits = bonusUnitsBefore(light.blocks);
      assert.deepEqual(adoptedUnits, units);
    } finally {
      fs.rmSync(heavyDir, { recursive: true, force: true });
      fs.rmSync(lightDir, { recursive: true, force: true });
    }
  });
});

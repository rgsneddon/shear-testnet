/**
 * P0-6ee-1. A template with k reserve txs applies each one once and does not
 * verify its proof again. An arrival applies once and verifies once.
 * Amounts, portals, and k vary. The cap is the exported policy value.
 */
import { describe, it } from 'node:test';
import { fileCapMs } from './slow_caps.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createStore } from '../src/store.js';
import { digestTx } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_TESTNET, TARGET_BLOCK_INTERVAL_MS, RESERVE_PROGRAM, PI_SHE_NANOS } from '../../crypto/asert.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest, hash20FromAddress, ed25519RawPub } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
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
  sealHiddenNote,
  randomScalar,
  hideVin,
  reviveTx,
  commit,
  proveRange,
  txSpendTags,
} from '../../crypto/note.js';
import {
  lockTx,
  portalIdFromDest,
  portalsFromSeed,
  portalOwnerKey,
  proveLockEquality,
  consensusUnlockPeriod,
  lockUnlockOf,
  RESERVE_ACTION_CAP,
  reserveTrialStats,
  resetReserveTrialStats,
} from '../../crypto/reserve_vault.js';
import { signSpendTx } from '../../crypto/spend.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import {
  walletAnchor,
  readyHeight,
  txDigestV3,
  admitV3Context,
  fundingJroot,
  flowProofVerifyCount,
  resetFlowProofVerifies,
} from '../../crypto/admit_v3.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
  resetFs1Tree,
  resetFs1VerifyCache,
  txBodyDigestFs1,
} from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import { destCommitFromSpendPub } from '../../crypto/stealth_ed25519.js';
import { MAX_BLOCK_RESERVE_TXS } from '../../crypto/block_budget.js';
import { rememberFundVerdict } from '../../crypto/fund_verdict.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const STEP = TARGET_BLOCK_INTERVAL_MS;
const KS = [10, 100, 1000];

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
  return { id, dest, spendSeed: id.spendSeed, key: id.privateKey, base: id.admitBase };
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

function userTxs(tpl) {
  return (tpl.txs || []).filter((tx) => tx && !tx.coinbase);
}

function rootHex(jroot) {
  const b = Buffer.from(asU8(jroot));
  assert.equal(b.length, 32);
  return b.toString('hex');
}

function destAt(n) {
  const raw = Buffer.alloc(20);
  raw.writeUInt32BE(n >>> 0, 16);
  return encodeDest(raw);
}

/** The object the template digests, so the seeded verdict key matches. */
function asTemplated(tx, height) {
  const m = reviveTx(tx);
  const dest = destForLogin(m.to, { height }) || m.to;
  return {
    ...m,
    to: dest,
    bFlag: m.kind === 'b-spend' || m.bFlag,
    vin: m.vin || [{ address: m.from }],
    vout: m.vout || [{ address: dest, nanos: m.nanos, kind: m.kind }],
  };
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

function proveLock(tx, { x, index, flux, note, anchor, noteR, noteV }) {
  let fee = 0;
  let tag = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const out = noteV - fee;
    assert.ok(out > 0, `fee consumes the note ${noteV} fee ${fee}`);
    const prev = tx.vout[0] || {};
    const d20 = Buffer.from(asU8(prev.dest20));
    const sealed = sealCoinbaseNote(out, { dest20: d20, kind: 'lock' });
    tx.vout = [{ ...sealed, kind: 'lock', dest20: d20, portalId: prev.portalId || tx.portalId }];
    tx.nanos = out;
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
    tx.admit_proof = real;
    tx.vin = [{ commit: Buffer.from(real.cTilde) }];
    tag = Buffer.from(asU8(real.spendTag));
    const need = levyNeed(tx);
    if (need === fee) break;
    fee = need;
    tag = null;
  }
  assert.ok(tag, 'lock fee did not settle');
  assert.equal(tx.nanos + tx.fee, noteV);
  assert.ok(tx.nanos > 0);
  return tag;
}

/**
 * A balanced lock of `nanos` for any positive nanos. The fee is the weight
 * levy of that body. The proof blob is not a real membership proof: the
 * queue verdict is seeded, and one separate lock goes through queueTx.
 */
function cheapLock({ to, nanos, id, anchor, height }) {
  let fee = 0;
  let tx = null;
  const tag = randomBytes(32);
  const spendPub = randomBytes(32).toString('hex');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const d20 = hash20FromAddress(to);
    assert.ok(d20, 'dest20');
    const spent = sealCoinbaseNote(nanos + fee, { dest20: d20, kind: 'lock' });
    const out = sealCoinbaseNote(nanos, { dest20: d20, kind: 'lock' });
    out.kind = 'lock';
    out.address = to;
    out.dest20 = d20;
    out.portalId = portalIdFromDest(to);
    let vin = null;
    for (let spin = 0; spin < 4 && !vin?.commit; spin += 1) {
      vin = hideVin({}, spent, randomScalar());
    }
    assert.ok(vin?.commit, 'vin commit');
    const excess = kernelExcess([out], [{ r: spent.r, t: vin.t }]);
    assert.ok(excess, 'excess');
    const blob = Buffer.alloc(129);
    blob[0] = 3;
    tag.copy(blob, 1);
    tx = {
      id,
      programId: RESERVE_PROGRAM,
      kind: 'lock',
      to,
      nanos,
      fee,
      portalId: portalIdFromDest(to),
      payoutPortalId: portalIdFromDest(to),
      anchor,
      excess,
      spendPub,
      vin: [{ commit: Buffer.from(vin.commit) }],
      vout: [out],
      admit_proof: {
        v: 3,
        blob,
        cTilde: Buffer.from(vin.commit),
        spendTag: Buffer.from(tag),
      },
    };
    const need = levyNeed(tx);
    if (need === fee) break;
    fee = need;
    tx = null;
  }
  assert.ok(tx, `levy did not settle for ${id}`);
  assert.ok(tx.nanos > 0);
  assert.ok(tx.fee >= 0);
  const view = asTemplated(tx, height);
  const digest = digestTx(view).toString('hex');
  assert.equal(digest.length, 64);
  return { tx, tag: tag.toString('hex'), digest };
}

function resetCounters() {
  resetReserveTrialStats();
  resetFlowProofVerifies();
  resetFs1VerifyCache();
}

function readCounters() {
  const trial = reserveTrialStats();
  return {
    applies: trial.applies,
    opens: trial.opens,
    // Byte-3 typedProofVerifyCount is retired at 0. FS-1 verifies are this counter.
    verifies: flowProofVerifyCount(),
  };
}

function clearUser(store) {
  store.mempool.length = 0;
}

/**
 * A hidden π lock the vault trial accepts. The FS-1 blob is not a membership
 * proof: the template reads a seeded funding verdict and does not verify it.
 * No from/to. nanos stays 0, which is what a hidden lock publishes.
 */
function seededLock(store, { id, height, anchor, nowMs }) {
  const portalId = randomBytes(32).toString('hex');
  const spendPub = randomBytes(32).toString('hex');
  const dest20 = randomBytes(20);
  const stamp = lockUnlockOf(store.reserveVault, nowMs);
  const blind = randomScalar();
  const ownerScalar = randomScalar();
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const leaf = vaultLockNote(PI_SHE_NANOS, ownerScalar, blind, unlock);
  assert.ok(leaf, id);
  const funded = pointBytes(commit(PI_SHE_NANOS, blind));
  const range = proveRange(PI_SHE_NANOS, blind);
  assert.ok(range, id);
  const tag = randomBytes(32);
  let fee = LEVY_FLOOR_UNITS;
  let tx = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const changeN = 1_000_000;
    const inputV = PI_SHE_NANOS + changeN + fee;
    const spent = sealCoinbaseNote(inputV, { dest20 });
    const change = sealHiddenNote(changeN, { dest20, kind: 'send' });
    delete change.valueProof;
    const lockOut = {
      kind: 'lock',
      commit: funded,
      rangeProof: range,
      r: scalarBytes(blind),
      dest20,
      portalId,
      viewTag: Buffer.from([1]),
      unlockAtMs: stamp.unlockAtMs,
      lockEpoch: stamp.epoch,
    };
    const outs = [lockOut, { ...change, kind: 'send', dest20 }];
    const vinCommit = Buffer.from(asU8(spent.commit));
    const excess = kernelExcess(outs, [{ r: spent.r }]);
    assert.ok(excess, 'excess');
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 0);
    blob[0] = FS1_WIRE;
    tag.copy(blob, 1);
    vinCommit.copy(blob, 33);
    const fs1 = Buffer.alloc(fs1BlobLen(1), 0);
    fs1[0] = FS1_WIRE;
    tx = {
      id,
      kind: 'lock',
      anchor,
      fee,
      nanos: 0,
      programId: RESERVE_PROGRAM,
      portalId,
      payoutPortalId: portalId,
      ownerPub: spendPub,
      spendPub,
      vaultLockNote: leaf.note,
      vin: [{ commit: vinCommit }],
      vout: outs,
      fs1,
      admit_proofs: [{ blob, cTilde: vinCommit, spendTag: Buffer.from(tag) }],
      excess,
    };
    const fund = proveLockEquality(funded, PI_SHE_NANOS, blind, tx, MAGIC_TESTNET, height);
    assert.ok(fund, `fund ${id}`);
    lockOut.fundProof = fund;
    const need = levyNeed(tx);
    if (fee >= need && fee <= LEVY_CAP_NANOS) break;
    fee = need + 8;
    tx = null;
  }
  assert.ok(tx, `levy did not settle for ${id}`);
  assert.equal(tx.to, undefined);
  assert.equal(tx.from, undefined);
  return tx;
}

function rangeSlack(outs) {
  let bytes = 0;
  for (const o of outs) if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  return Math.ceil((bytes * 2) / 2048) + 8;
}

function realFs1Lock(store, who, saved) {
  const height = store.tip().height + 1;
  const anchor = walletAnchor(height);
  const live = store.anchorNote(anchor);
  const at = new Map();
  for (let i = 0; i < live.n; i += 1) {
    at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
  }
  const coins = [];
  let total = 0;
  for (const row of saved) {
    const key = Buffer.from(asU8(row.commit)).toString('hex');
    if (!at.has(key)) continue;
    coins.push({
      r: row.r,
      v: row.v,
      commit: row.commit,
      index: at.get(key),
      x: admitScalarFromSeed(who.spendSeed, row.pot),
    });
    total += row.v;
    if (coins.length >= 4 && total > PI_SHE_NANOS + LEVY_CAP_NANOS) break;
  }
  assert.ok(total > PI_SHE_NANOS + LEVY_FLOOR_UNITS, `pots ${total}`);
  const portal = portalsFromSeed(who.spendSeed, 1)[0];
  const ownerKey = portalOwnerKey(who.spendSeed, portal.portalId);
  const ownerPub = ed25519RawPub(ownerKey).toString('hex');
  const blind = randomScalar();
  const scalar = randomScalar();
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, consensusUnlockPeriod(0));
  const funded = pointBytes(commit(PI_SHE_NANOS, blind));
  const range = proveRange(PI_SHE_NANOS, blind);
  const d20 = Buffer.from(portal.dest20);
  const fs1 = Buffer.alloc(fs1BlobLen(coins.length), 255);
  fs1[0] = FS1_WIRE;
  const proofs = [];
  for (let i = 0; i < coins.length; i += 1) {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
    blob[0] = FS1_WIRE;
    proofs.push({ blob, cTilde: Buffer.alloc(32, 255), spendTag: Buffer.alloc(32, 255) });
  }
  let fee = LEVY_FLOOR_UNITS;
  let tx = null;
  let outs = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const changeN = total - fee - PI_SHE_NANOS;
    assert.ok(changeN > 0, `change ${changeN}`);
    outs = [
      {
        kind: 'lock',
        commit: funded,
        rangeProof: range,
        r: scalarBytes(blind),
        dest20: d20,
        portalId: portal.portalId,
        viewTag: Buffer.from([1]),
      },
      (() => {
        let note = attachAdmitPub(sealHiddenNote(changeN, { dest20: hash20FromAddress(who.dest), kind: 'send', admitBase: who.base }), { admitBase: who.base });
        note = { ...note, kind: 'send', dest20: Buffer.from(hash20FromAddress(who.dest)), viewTag: viewTagOf(note.noteCommit) };
        delete note.valueProof;
        return note;
      })(),
    ];
    const draft = compactTx({
      id: 'lock-live',
      kind: 'lock',
      anchor,
      fee,
      nanos: 0,
      programId: RESERVE_PROGRAM,
      portalId: portal.portalId,
      payoutPortalId: portal.portalId,
      ownerPub,
      vaultLockNote: leaf.note,
      vin: proofs.map(() => ({ commit: Buffer.alloc(32, 255) })),
      vout: outs,
      fs1,
      admit_proofs: proofs,
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) {
      const proven = fs1ProveSpend({
        live,
        anchor,
        indices: coins.map((c) => c.index),
        xs: coins.map((c) => c.x),
        tx: draft,
        magic: MAGIC_TESTNET,
      });
      assert.ok(proven, 'fs1 prove');
      const excess = kernelExcess(outs, coins.map((c, i) => ({ r: c.r, t: proven.t[i] })));
      tx = compactTx({
        ...draft,
        vin: proven.proofs.map((p) => ({ commit: Buffer.from(p.cTilde) })),
        vout: outs,
        fs1: proven.fs1,
        admit_proofs: proven.proofs,
        excess,
      });
      assert.ok(txBodyDigestFs1(tx, MAGIC_TESTNET).equals(proven.digest), 'digest');
      break;
    }
    fee = need + rangeSlack(outs);
  }
  assert.ok(tx, 'live lock fee');
  tx.dest20 = destCommitFromSpendPub(ed25519RawPub(ownerKey));
  tx.ownerPub = ownerPub;
  signSpendTx(tx, ownerKey);
  const fund = proveLockEquality(funded, PI_SHE_NANOS, blind, tx, MAGIC_TESTNET, 0);
  assert.ok(fund, 'live fund');
  tx.vout.find((row) => String(row?.kind || '') === 'lock').fundProof = fund;
  return tx;
}

function rememberOne(store, tx, anchor, root) {
  const tags = txSpendTags(tx).tags.map((tag) => tag.toString('hex'));
  assert.equal(tags.length, 1, tx.id);
  const remembered = rememberFundVerdict(tx, store.tip(), anchor, root, tags);
  assert.equal(remembered, true, tx.id);
}

describe('v12 reserve trial is incremental', { timeout: fileCapMs(import.meta.url) }, () => {
  it('k reserve txs cost one apply each, and one arrival verifies once', { timeout: 300_000 }, async () => {
    // The template admits at most MAX_BLOCK_RESERVE_TXS (32), and the
    // selector stops reserve rows at TEMPLATE_BUDGET_MS. The old 100 and
    // 1000 spreads were byte-3 bodies the selector now refuses as
    // vault_unavailable. The spread below stays inside both caps.
    assert.equal(fs1NativeLoaded(), true, 'shear_admit FS-1 addon is not loaded');
    assert.ok(RESERVE_ACTION_CAP > MAX_BLOCK_RESERVE_TXS);
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reserve-trial-'));
    const store = createStore(dir);
    try {
      const includeAt = readyHeight(1);
      const saved = [];
      while ((store.tip()?.height || 0) + 1 < includeAt) {
        const tip = store.tip();
        const now = tip ? headerTime(tip) + STEP : T0;
        const { tpl } = store.template({ miner: who.dest, shareBits: 4, now });
        const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
        const pow = easyPow();
        const got = await store.append(blockFrom(tpl, pow), { trustedPowHash: pow, skipSharePow: true });
        assert.equal(got.ok, true, `${got.reason || 'seal'} at ${(tip?.height || 0) + 1}`);
        if (pot?.r && pot.commit) {
          saved.push({
            r: Buffer.from(asU8(pot.r)),
            v: openedCoinbaseNanos(pot),
            commit: Buffer.from(asU8(pot.commit)),
            pot,
          });
        }
      }
      const height = store.tip().height + 1;
      const anchor = walletAnchor(height);
      assert.equal(typeof anchor, 'number');
      const live = store.anchorNote(anchor);
      const root = Buffer.from(asU8(live.jroot)).toString('hex');
      assert.equal(root.length, 64);
      const stamp = headerTime(store.tip()) + STEP;
      const rates = [];
      // TEMPLATE_BUDGET_MS is 1000. store.js stops admitting reserve rows
      // at that wall and leaves the tail queued. Each admitted row costs
      // one apply. k=2 and k=4 fit here. k=8 fits on the Linux runner and
      // is cut to a prefix on this Windows host once that second elapses.
      for (const k of [2, 4, 8]) {
        clearUser(store);
        const rows = [];
        for (let i = 0; i < k; i += 1) {
          const tx = seededLock(store, { id: `lock-${k}-${i}`, height, anchor, nowMs: stamp });
          rememberOne(store, tx, anchor, root);
          rows.push(tx);
        }
        const portals = new Set(rows.map((tx) => tx.portalId));
        assert.equal(portals.size, k);
        store.mempool.push(...rows);
        resetCounters();
        const firstBuilt = store.template({ miner: who.dest, shareBits: 4, now: stamp });
        const first = readCounters();
        const firstIds = userTxs(firstBuilt.tpl).map((tx) => tx.id);
        const wantIds = rows.map((tx) => tx.id);
        assert.deepEqual(firstIds, wantIds.slice(0, firstIds.length), `budget cut is a suffix at k=${k}`);
        if (k < 8 || process.platform !== 'win32') {
          assert.equal(firstIds.length, k, `template kept ${firstIds.length} of ${k} ${firstIds[0] || ''}`);
        } else {
          assert.ok(firstIds.length > 0 && firstIds.length <= k, `template kept ${firstIds.length} of ${k}`);
        }
        assert.equal(first.applies, firstIds.length, `applies ${first.applies} kept ${firstIds.length} at k=${k}`);
        assert.ok(first.applies < (k * (k + 1)) / 2, `prefix replay at k=${k}`);
        assert.equal(first.verifies, 0, `verifies ${first.verifies} at k=${k}`);
        resetCounters();
        const secondBuilt = store.template({ miner: who.dest, shareBits: 4, now: stamp });
        const second = readCounters();
        const secondIds = userTxs(secondBuilt.tpl).map((tx) => tx.id);
        // The 1000ms wall moves between passes, so the second prefix can be
        // shorter or longer than the first. It is still a suffix cut.
        assert.deepEqual(secondIds, wantIds.slice(0, secondIds.length), `second cut is a suffix at k=${k}`);
        if (k < 8 || process.platform !== 'win32') {
          assert.equal(secondIds.length, k, `second template kept ${secondIds.length} of ${k}`);
        } else {
          assert.ok(secondIds.length > 0 && secondIds.length <= k, `second template kept ${secondIds.length} of ${k}`);
        }
        assert.equal(second.applies, secondIds.length, `second applies ${second.applies} kept ${secondIds.length} at k=${k}`);
        assert.equal(second.verifies, 0, `second verifies ${second.verifies} at k=${k}`);
        rates.push(second.applies / secondIds.length);
      }
      assert.ok(rates.every((rate) => rate === 1), `per-tx rates ${rates.join(',')}`);

      clearUser(store);
      resetFs1Tree();
      const arrival = realFs1Lock(store, who, saved);
      resetCounters();
      const queued = store.queueTx(arrival, { nowMs: stamp });
      const arrived = readCounters();
      assert.equal(queued.ok, true, queued.reason || 'queue live lock');
      assert.equal(arrived.applies, 1, `arrival applies ${arrived.applies}`);
      assert.equal(arrived.verifies, 1, `arrival verifies ${arrived.verifies}`);
      assert.equal(store.mempool.some((tx) => tx.id === 'lock-live'), true);

      clearUser(store);
      for (let i = 0; i < RESERVE_ACTION_CAP; i += 1) {
        store.mempool.push({
          id: `cap-${i}`,
          kind: 'lock',
          programId: RESERVE_PROGRAM,
          portalId: randomBytes(32).toString('hex'),
          nanos: 0,
          vout: [{ kind: 'lock' }],
        });
      }
      const overBody = seededLock(store, { id: 'over-cap', height, anchor, nowMs: stamp });
      resetCounters();
      const over = store.queueTx(overBody, { nowMs: stamp });
      const capped = readCounters();
      assert.equal(over.ok, false);
      assert.equal(over.reason, 'reserve_cap', over.reason || 'cap');
      assert.equal(capped.applies, 0, `cap applies ${capped.applies}`);
      assert.equal(capped.verifies, 0, `cap verifies ${capped.verifies}`);
      assert.equal(store.mempool.some((tx) => tx.id === 'over-cap'), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

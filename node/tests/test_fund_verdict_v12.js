/**
 * P0-006-1 / N-38. A funding verdict is the tx's own funding bytes plus the
 * tip, the anchor, and the anchor root. A rejected tx writes no row. A hit
 * never spends a tag the tx itself does not carry. Any amount, any of the
 * spreads below. The merkle digest is not the cache key.
 */
import { describe, it } from 'node:test';
import { fileCapMs } from './slow_caps.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createStore } from '../src/store.js';
import { digestTx, buildTemplate, retarget, shouldAdopt, chainWorkOf } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  MAGIC_TESTNET,
  TARGET_BLOCK_INTERVAL_MS,
  RESERVE_PROGRAM,
  SHARE_FLOOR_BITS,
  SPENDABLE_CONFIRMATIONS,
  PI_SHE_NANOS,
} from '../../crypto/asert.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest, hash20FromAddress, ed25519PrivateFromSeed, ed25519RawPub } from '../../crypto/address.js';
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
  txSpendTags,
  commit,
  proveRange,
} from '../../crypto/note.js';
import {
  lockTx,
  portalIdFromDest,
  portalsFromSeed,
  proveLockEquality,
  consensusUnlockPeriod,
} from '../../crypto/reserve_vault.js';
import { signSpendTx } from '../../crypto/spend.js';
import { levyNeed, LEVY_WEIGHT_RATE_DEN, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import {
  walletAnchor,
  readyHeight,
  txDigestV3,
  admitV3Context,
  fundingJroot,
  flowProofVerifyCount,
  resetFlowProofVerifies,
  anchorRejectReason,
  ANCHOR_WINDOW,
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
import { rememberFundVerdict } from '../../crypto/fund_verdict.js';
import { nonceWithShareTarget } from '../../crypto/share_batch.js';
import { createPool, SEAL_ESCAPE_AFTER, SEAL_ESCAPE_PROBE_CAP, sealFailureClass } from '../../pool/src/pool.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const STEP = TARGET_BLOCK_INTERVAL_MS;
const KS = [1, 2, 8, 32];
const SHARE_BATCHES = [1, 7, 64];
const DEPTHS = [1, 2, 6];
const ANCHOR_OFFSETS = [0, 1, ANCHOR_WINDOW - 1, ANCHOR_WINDOW];
const FEE = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';

let powTag = 1;
let destSeq = 1;
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

function clearUser(store) {
  const keep = (store.mempool || []).filter((tx) => tx && tx.coinbase);
  store.mempool.length = 0;
  store.mempool.push(...keep);
}

function dropId(store, id) {
  const want = String(id || '');
  for (let i = store.mempool.length - 1; i >= 0; i -= 1) {
    if (String(store.mempool[i]?.id || '') === want) store.mempool.splice(i, 1);
  }
}

function assertNoSpentRow(store) {
  const spent = store.fluxset().spendTags;
  for (const row of store.mempool || []) {
    for (const tag of txSpendTags(row).tags) {
      assert.equal(spent.has(tag.toString('hex')), false, String(row?.id || ''));
    }
  }
}

async function mineUntil(store, dest, includeAt, time0) {
  while ((store.tip()?.height || 0) + 1 < includeAt) {
    const tip = store.tip();
    const now = tip ? headerTime(tip) + STEP : time0;
    const { tpl } = store.template({ miner: dest, now });
    const pow = easyPow();
    const got = await store.append(blockFrom(tpl, pow), { trustedPowHash: pow, skipSharePow: true });
    assert.equal(got.ok, true, `${got.reason || 'seal'} at ${(tip?.height || 0) + 1}`);
  }
  assert.equal(store.tip().height + 1, includeAt);
}

async function sealEmpty(store, dest) {
  const now = headerTime(store.tip()) + STEP;
  const built = store.template({ miner: dest, now });
  assert.equal(userTxs(built.tpl).length, 0, 'empty template picked up a user tx');
  const pow = easyPow();
  const got = await store.append(blockFrom(built.tpl, pow), { trustedPowHash: pow, skipSharePow: true });
  assert.equal(got.ok, true, got.reason || 'empty');
}

async function probeTip(store, dest) {
  const now = headerTime(store.tip()) + STEP;
  const built = store.template({ miner: dest, now });
  const pow = easyPow();
  const got = await Promise.resolve(store.probeBlock(blockFrom(built.tpl, pow)));
  assert.equal(got.ok, true, got.reason || 'probe');
  return built.tpl;
}

function tagHexOf(tx) {
  const tags = txSpendTags(tx).tags;
  assert.ok(tags.length > 0, String(tx?.id || 'tag'));
  return tags[0].toString('hex');
}

function retag(tx, nanos) {
  const copy = reviveTx(tx);
  const tag = randomBytes(32);
  const proof = { ...copy.admit_proof };
  const blob = Buffer.from(asU8(proof.blob ?? proof.proof));
  assert.ok(blob.length >= 33 && (blob[0] === 2 || blob[0] === 3), 'versioned blob');
  tag.copy(blob, 1);
  proof.blob = blob;
  proof.spendTag = Buffer.from(tag);
  copy.admit_proof = proof;
  copy.spendTag = Buffer.from(tag);
  copy.nanos = nanos;
  copy.id = `clone-${tag.toString('hex').slice(0, 12)}`;
  return copy;
}

async function spendByOtherId(store, dest, newId) {
  const now = headerTime(store.tip()) + STEP;
  const built = store.template({ miner: dest, now });
  assert.ok(userTxs(built.tpl).some((tx) => tx.id === 'lock-live'), 'lock missing from template');
  const pow = easyPow();
  const block = blockFrom(built.tpl, pow);
  block.txs = (block.txs || []).map((tx) => (tx && !tx.coinbase ? { ...tx, id: newId } : tx));
  assert.equal(store.mempool.some((tx) => tx.id === 'lock-live'), true);
  const got = await store.append(block, { trustedPowHash: pow, skipSharePow: true });
  assert.equal(got.ok, true, got.reason || newId);
  assert.equal(store.mempool.some((tx) => tx.id === 'lock-live'), false, 'id drop hid a spent tag');
  assertNoSpentRow(store);
}

async function reorgAway(store, dest, depth) {
  const cut = store.blocks.length - depth;
  assert.ok(cut > 0, `depth ${depth} longer than the chain`);
  const prefix = store.blocks.slice(0, cut);
  const parent = prefix[prefix.length - 1];
  const fork = [];
  let prev = parent;
  let stamp = headerTime(parent) + STEP;
  for (let i = 0; i < depth + 1; i += 1) {
    const chain = prefix.concat(fork);
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height || 0) + 1,
      miner: dest,
      now: stamp,
      bits: retarget(chain, stamp),
      parentBlocks: chain,
    });
    const pow = easyPow();
    const block = blockFrom(tpl, pow);
    block.height = Number(prev.height || 0) + 1;
    fork.push(block);
    prev = block;
    stamp += STEP;
  }
  const candidate = prefix.concat(fork);
  assert.equal(
    shouldAdopt(store.blocks, candidate),
    true,
    `main ${chainWorkOf(store.blocks)} fork ${chainWorkOf(candidate)} depth ${depth}`,
  );
  const won = await store.ingest(fork, { trustBlockHash: true });
  assert.equal(won.ok, true, won.reason || `reorg ${depth}`);
}

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function jobBlock(pool, job) {
  const rec = pool.store.jobs.get(String(job.jobId));
  assert.ok(rec?.tpl?.header, 'job template');
  const tpl = rec.tpl;
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    poolDest: tpl.poolDest || '',
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    height: tpl.height,
  };
}

function parseEvents(lines) {
  const out = [];
  for (const line of lines) {
    const start = String(line).indexOf('{');
    if (start < 0) continue;
    try { out.push(JSON.parse(String(line).slice(start))); } catch { /* not an event */ }
  }
  return out;
}

async function captureErrors(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    lines.push(args.map((a) => String(a)).join(' '));
    orig.apply(console, args);
  };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

function liveAnchor(store) {
  const height = Number(store.tip()?.height || 0) + 1;
  const anchor = walletAnchor(height);
  assert.equal(typeof anchor, 'number', `no anchor at ${height}`);
  const root = rootHex(store.anchorNote(anchor)?.jroot);
  return { height, anchor, root };
}

function seedStub(store, { nanos, id }) {
  const { height, anchor, root } = liveAnchor(store);
  destSeq += 1;
  const built = cheapLock({ to: destAt(destSeq), nanos, id, anchor, height });
  const remembered = rememberFundVerdict(
    asTemplated(built.tx, height),
    store.tip(),
    anchor,
    root,
    [built.tag],
  );
  assert.equal(remembered, true, id);
  store.mempool.push(built.tx);
  return built;
}

async function plant(pool, rows) {
  const genesis = pool.issueJob(undefined, { force: true });
  assert.ok(genesis?.jobId, 'plant job');
  const header = Buffer.from(genesis.header, 'hex');
  for (const row of rows) {
    const nonce = nonceWithShareTarget(BigInt(row.low), row.bits);
    const got = pool.creditAcceptedShare({
      dest: row.dest,
      nonce,
      lz: row.bits,
      shareBits: row.bits,
      creditedShareBits: row.bits,
      verifiedHeader: header,
      hash: '11',
    });
    assert.equal(got.ok, true, got.reason || 'credit');
  }
  const sealed = await pool.sealFoundShare({
    jobId: genesis.jobId,
    nonce: 0n,
    miner: FEE,
    powHash: easyPow().toString('hex'),
  });
  assert.equal(sealed.ok, true, sealed.reason || 'plant');
  pool.rollOpenRound();
  const published = pool.issueJob(undefined, { force: true });
  assert.ok(published?.jobId, 'published');
  assert.equal(pool.lag1Shares.length, rows.length, 'lag1');
  return pool.lag1Shares.slice();
}

function rangeSlack(outs) {
  let bytes = 0;
  for (const o of outs) if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  return Math.ceil((bytes * 2) / 2048) + 8;
}

function fs1Placeholders(k) {
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

function proveFs1(tx, use, anchor, live, outs) {
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

/**
 * One FS-1 π lock of the coinbase pots inside the wallet anchor.
 * The body has no from/to. The owner is the one-time portal key.
 */
function fs1LockOf(store, who, saved) {
  const height = store.tip().height + 1;
  const anchor = walletAnchor(height);
  assert.equal(typeof anchor, 'number', `anchor at ${height}`);
  const live = store.anchorNote(anchor);
  assert.ok(live && live.n >= 1, `anchor notes ${anchor}`);
  const at = new Map();
  for (let i = 0; i < live.n; i += 1) {
    at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
  }
  const coins = [];
  let total = 0;
  for (const row of saved) {
    const key = Buffer.from(asU8(row.commit)).toString('hex');
    if (!at.has(key)) continue;
    const coin = {
      r: row.r,
      v: row.v,
      commit: row.commit,
      index: at.get(key),
      x: admitScalarFromSeed(who.spendSeed, row.pot),
    };
    coins.push(coin);
    total += coin.v;
    if (coins.length >= 4 && total > PI_SHE_NANOS + LEVY_CAP_NANOS) break;
  }
  assert.ok(total > PI_SHE_NANOS + LEVY_FLOOR_UNITS, `pots ${total}`);
  const portal = portalsFromSeed(who.spendSeed, 1)[0];
  // dest20 is this key, and the portal id is H(dest20). portalOwnerKey is a different key.
  const ownerKey = ed25519PrivateFromSeed(portal.spendSeed);
  const ownerPub = ed25519RawPub(ownerKey).toString('hex');
  const blind = randomScalar();
  const scalar = randomScalar();
  const unlock = consensusUnlockPeriod(0);
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
  assert.ok(leaf, 'leaf');
  const funded = pointBytes(commit(PI_SHE_NANOS, blind));
  const range = proveRange(PI_SHE_NANOS, blind);
  assert.ok(range, 'range');
  const d20 = Buffer.from(portal.dest20);
  const ph = fs1Placeholders(coins.length);
  let fee = LEVY_FLOOR_UNITS;
  let tx = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const changeN = total - fee - PI_SHE_NANOS;
    assert.ok(changeN > 0, `lock change ${changeN}`);
    const outs = [
      {
        kind: 'lock',
        commit: funded,
        rangeProof: range,
        r: scalarBytes(blind),
        dest20: d20,
        portalId: portal.portalId,
        viewTag: Buffer.from([1]),
      },
      hiddenChange(changeN, Buffer.from(hash20FromAddress(who.dest)), who.base),
    ];
    const draft = compactTx({
      id: 'lock-live',
      kind: 'lock',
      anchor,
      fee,
      nanos: 0,
      programId: RESERVE_PROGRAM,
      portalId: portal.portalId,
      ownerPub,
      vaultLockNote: leaf.note,
      vin: ph.vin,
      vout: outs,
      fs1: ph.fs1,
      admit_proofs: ph.proofs,
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) {
      tx = proveFs1(draft, coins, anchor, live, outs);
      break;
    }
    const next = need + rangeSlack(outs);
    assert.ok(next > fee && next <= LEVY_CAP_NANOS, `lock levy ${need}`);
    fee = next;
  }
  assert.ok(tx, 'lock fee');
  tx.dest20 = destCommitFromSpendPub(ed25519RawPub(ownerKey));
  tx.ownerPub = ownerPub;
  signSpendTx(tx, ownerKey);
  delete tx.spendPub;
  delete tx.sig;
  delete tx.signature;
  assert.equal(tx.spendPub, undefined, 'lock spendPub');
  assert.equal(tx.sig, undefined, 'lock sig');
  assert.equal(tx.signature, undefined, 'lock signature');
  const fund = proveLockEquality(funded, PI_SHE_NANOS, blind, tx, MAGIC_TESTNET, 0);
  assert.ok(fund, 'fund');
  const lockOut = tx.vout.find((row) => String(row?.kind || '') === 'lock');
  lockOut.fundProof = fund;
  assert.equal(tx.from, undefined);
  assert.equal(tx.to, undefined);
  return tx;
}

/** A new spend tag on the first proof. The merkle suffix does not bind that tag. */
function retagProof(tx, nanos = null) {
  const copy = reviveTx(tx);
  const tag = randomBytes(32);
  const proofs = (copy.admit_proofs || []).map((proof, i) => {
    if (i !== 0) return proof;
    const blob = Buffer.from(asU8(proof.blob));
    assert.equal(blob[0], FS1_WIRE);
    tag.copy(blob, 1);
    return {
      blob,
      cTilde: Buffer.from(asU8(proof.cTilde)),
      spendTag: Buffer.from(tag),
    };
  });
  copy.admit_proofs = proofs;
  copy.id = `clone-${tag.toString('hex').slice(0, 12)}`;
  if (nanos != null) copy.nanos = nanos;
  return copy;
}

describe('v12 fund verdict is the funding witness', { timeout: fileCapMs(import.meta.url) }, () => {
  it('a rejected or retagged body cannot satisfy another tx, at any amount', { timeout: 300_000 }, async () => {
    // Stage 3b. The gate is open at height 17, so this is an FS-1 lock.
    // Byte-3 typedProofVerifyCount stays 0: no path verifies a bucket proof.
    // The FS-1 counter is the verify the verdict is allowed to skip.
    assert.equal(fs1NativeLoaded(), true, 'shear_admit FS-1 addon is not loaded');
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fund-verdict-'));
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
      assert.equal(store.tip().height + 1, includeAt);
      resetFs1Tree();
      const real = fs1LockOf(store, who, saved);
      const liveTag = tagHexOf(real);
      const liveDigest = digestTx(real).toString('hex');
      const stamp = headerTime(store.tip()) + STEP;
      // Memo is outside the FS-1 digest, so this copy still verifies. Its fee
      // is under the weight levy. Queue it before the proved lock: the same
      // spend tag would otherwise be admit_link_tag and hide the levy.
      const padded = reviveTx(real);
      padded.id = 'lock-levy';
      const settled = Math.floor(Number(padded.fee || 0));
      let extra = 1;
      let raised = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        padded.memo = 'z'.repeat(extra);
        if (levyNeed(padded) > settled) {
          raised = true;
          break;
        }
        let weight = 0;
        try { weight = Buffer.byteLength(JSON.stringify(padded)); } catch { weight = 0; }
        extra += Math.max(1, (settled * LEVY_WEIGHT_RATE_DEN) + 1 - weight);
      }
      assert.equal(raised, true, 'memo never raised the weight levy');
      const rejected = store.queueTx(padded, { nowMs: stamp });
      assert.equal(rejected.ok, false, rejected.reason || 'pad');
      assert.equal(rejected.reason, 'levy', rejected.reason || 'pad');
      assert.equal(store.mempool.some((tx) => tx.id === padded.id), false);
      resetFs1VerifyCache();
      const queued = store.queueTx(real, { nowMs: stamp });
      assert.equal(queued.ok, true, queued.reason || 'queue');
      assert.ok(flowProofVerifyCount() >= 1, 'accepted lock did not verify');
      resetFs1VerifyCache();
      const hit = store.template({ miner: who.dest, shareBits: 4, now: stamp });
      assert.equal(flowProofVerifyCount(), 0, 'accepted lock verified again');
      assert.ok(userTxs(hit.tpl).some((tx) => tx.id === real.id));
      store.mempool.push(padded);
      resetFs1VerifyCache();
      const poisoned = store.template({ miner: who.dest, shareBits: 4, now: stamp });
      assert.equal(userTxs(poisoned.tpl).some((tx) => tx.id === padded.id), false);
      assert.ok(userTxs(poisoned.tpl).some((tx) => tx.id === real.id));
      dropId(store, padded.id);

      const seenNanos = new Set();
      // 32 is the reserve-tx template cap. A larger spread would drop clones
      // before the funding check, so the spread stays inside that cap.
      for (const k of [1, 2, 8]) {
        const clones = [];
        for (let i = 0; i < k; i += 1) {
          const clone = retagProof(real);
          // Current law: the reserve suffix binds nanos, not the spend tag.
          // A tag change keeps the merkle leaf and still misses the verdict.
          assert.equal(digestTx(clone).toString('hex'), liveDigest, 'retag changed the merkle leaf');
          assert.notEqual(tagHexOf(clone), liveTag);
          clones.push(clone);
        }
        const priced = retagProof(real, (k * 1000) + 1);
        assert.notEqual(digestTx(priced).toString('hex'), liveDigest, 'nanos left the merkle leaf');
        seenNanos.add(priced.nanos);
        clones.push(priced);
        // The retag still spends the proved lock's note. Queue names that
        // before the sum, so both the tag copy and the nanos edit are
        // admit_link_tag and neither is funded again. The template names the
        // sum first, so the nanos edit is commit_sum there.
        const tagRefused = store.queueTx(clones[0], { nowMs: stamp });
        assert.equal(tagRefused.ok, false, tagRefused.reason || 'retag');
        assert.equal(tagRefused.reason, 'admit_link_tag', tagRefused.reason);
        const pricedRefused = store.queueTx(priced, { nowMs: stamp });
        assert.equal(pricedRefused.ok, false, pricedRefused.reason || 'nanos');
        assert.equal(pricedRefused.reason, 'admit_link_tag', pricedRefused.reason);
        store.mempool.push(...clones);
        resetFs1VerifyCache();
        const skips = [];
        const logErr = console.error;
        console.error = (...args) => {
          skips.push(args.map((part) => String(part)).join(' '));
          logErr.apply(console, args);
        };
        let built;
        try {
          built = store.template({ miner: who.dest, shareBits: 4, now: stamp });
        } finally {
          console.error = logErr;
        }
        const ids = new Set(userTxs(built.tpl).map((tx) => tx.id));
        assert.equal(ids.has(real.id), true, `k=${k} dropped the proved lock`);
        for (const clone of clones) assert.equal(ids.has(clone.id), false, clone.id);
        assert.match(skips.find((line) => line.includes(clones[0].id)) || '', /admit_link_tag/);
        assert.match(skips.find((line) => line.includes(priced.id)) || '', /commit_sum/);
        assert.equal(flowProofVerifyCount(), 0, `k=${k} funded a refused body`);
        for (const clone of clones) dropId(store, clone.id);
        resetFs1VerifyCache();
        const again = store.template({ miner: who.dest, shareBits: 4, now: stamp });
        assert.equal(flowProofVerifyCount(), 0, `k=${k} poisoned the proved lock`);
        assert.ok(userTxs(again.tpl).some((tx) => tx.id === real.id));
      }
      assert.ok(seenNanos.size > 1, 'clone amounts collapsed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * P0-006-1 / N-38. A funding verdict is the tx's own funding bytes plus the
 * tip, the anchor, and the anchor root. A rejected tx writes no row. A hit
 * never spends a tag the tx itself does not carry. Any amount, any of the
 * spreads below. The merkle digest is not the cache key.
 */
import { describe, it } from 'node:test';
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
} from '../../crypto/asert.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
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
  hideVin,
  reviveTx,
  txSpendTags,
} from '../../crypto/note.js';
import { lockTx, portalIdFromDest } from '../../crypto/reserve_vault.js';
import { signSpendTx } from '../../crypto/spend.js';
import { levyNeed, LEVY_WEIGHT_RATE_DEN } from '../../crypto/levy.js';
import {
  walletAnchor,
  readyHeight,
  txDigestV3,
  admitV3Context,
  typedProofVerifyCount,
  resetTypedProofVerifies,
  anchorRejectReason,
  ANCHOR_WINDOW,
} from '../../crypto/admit_v3.js';
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

describe('v12 fund verdict is the funding witness', () => {
  it('a rejected or retagged body cannot satisfy another tx, at any amount', { timeout: 300_000 }, async () => {
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fund-verdict-'));
    const store = createStore(dir);
    const includeAt = readyHeight(1);
    assert.equal(Number.isInteger(includeAt), true);
    let pool = null;
    try {
      let opening = null;
      while ((store.tip()?.height || 0) + 1 < includeAt) {
        const tip = store.tip();
        const now = tip ? headerTime(tip) + STEP : T0;
        const { tpl } = store.template({ miner: who.dest, now });
        const minted = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
        const pow = easyPow();
        const got = await store.append(blockFrom(tpl, pow), { trustedPowHash: pow, skipSharePow: true });
        assert.equal(got.ok, true, `${got.reason || 'seal'} at ${(tip?.height || 0) + 1}`);
        if (!opening && minted?.r && minted.commit) {
          opening = { r: minted.r, v: openedCoinbaseNanos(minted) };
        }
      }
      assert.equal(store.tip().height + 1, includeAt);
      const pot = store.blocks[0].txs[0].vout.find((o) => o.kind === 'pot');
      assert.ok(opening && pot?.commit, 'pot');
      assert.ok(opening.v > 1, String(opening.v));
      const anchor = walletAnchor(includeAt);
      assert.equal(anchor, includeAt - SPENDABLE_CONFIRMATIONS);
      const found = indexOfCommit(store.blocks, anchor, pot.commit);
      assert.ok(found.index >= 0, 'note is inside the anchor');
      const x = admitScalarFromSeed(who.spendSeed, pot);
      assert.ok(Buffer.from(pointBytes(admitPub(x))).equals(Buffer.from(asU8(pot.admitPub))), 'pot key');
      const real = stripPayer(lockTx({
        from: who.dest,
        to: who.dest,
        nanos: opening.v,
        id: 'lock-live',
      }));
      const flux = anchorFlux(store.blocks, anchor);
      proveLock(real, {
        x,
        index: found.index,
        flux,
        note: pot,
        anchor,
        noteR: opening.r,
        noteV: opening.v,
      });
      signSpendTx(real, who.key);
      assert.equal(real.nanos + real.fee, opening.v);
      assert.ok(real.nanos > 1);
      const liveTag = tagHexOf(real);
      const liveDigest = digestTx(real).toString('hex');
      const stamp = headerTime(store.tip()) + STEP;

      const padded = reviveTx(real);
      const settled = Math.floor(Number(padded.fee || 0));
      // The weight levy stays on its floor until the JSON crosses fee * DEN.
      // Grow an unsigned field until the levy is strictly above the settled fee.
      let extra = 1;
      let raised = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        padded.junk = 'z'.repeat(extra);
        if (levyNeed(padded) > settled) {
          raised = true;
          break;
        }
        let weight = 0;
        try { weight = Buffer.byteLength(JSON.stringify(padded)); } catch { weight = 0; }
        extra += Math.max(1, (settled * LEVY_WEIGHT_RATE_DEN) + 1 - weight);
      }
      assert.equal(raised, true, 'junk never raised the weight levy');
      const rejected = store.queueTx(padded, { nowMs: stamp });
      assert.equal(rejected.ok, false, rejected.reason || 'pad');
      assert.equal(rejected.reason, 'levy', rejected.reason || 'pad');
      assert.equal(store.mempool.some((tx) => tx.id === padded.id), false);
      resetTypedProofVerifies();
      store.mempool.push(padded);
      const poisoned = store.template({ miner: who.dest, now: stamp });
      assert.ok(typedProofVerifyCount() >= 1, 'a levy reject left a verdict row');
      assert.equal(userTxs(poisoned.tpl).some((tx) => tx.junk), false);
      dropId(store, padded.id);
      assert.equal(store.mempool.some((tx) => tx.id === padded.id), false);

      resetTypedProofVerifies();
      const queued = store.queueTx(real, { nowMs: stamp });
      assert.equal(queued.ok, true, queued.reason || 'queue');
      assert.ok(typedProofVerifyCount() >= 1, 'accepted lock did not verify');
      resetTypedProofVerifies();
      const hit = store.template({ miner: who.dest, now: stamp });
      assert.equal(typedProofVerifyCount(), 0, 'accepted lock verified again');
      assert.ok(userTxs(hit.tpl).some((tx) => tx.id === real.id));
      const hitProbe = await Promise.resolve(store.probeBlock(blockFrom(hit.tpl, easyPow())));
      assert.equal(hitProbe.ok, true, hitProbe.reason || 'hit probe');

      const seenNanos = new Set();
      for (const k of KS) {
        const clones = [];
        for (let i = 0; i < k; i += 1) {
          const clone = retag(real, (k * 1000) + i + 1);
          assert.equal(digestTx(clone).toString('hex'), liveDigest, 'retag changed the merkle leaf');
          assert.ok(Buffer.from(asU8(clone.vout[0].commit)).equals(Buffer.from(asU8(real.vout[0].commit))));
          assert.notEqual(tagHexOf(clone), liveTag);
          clones.push(clone);
          seenNanos.add(clone.nanos);
        }
        if (k > 1) {
          const local = new Set(clones.map((tx) => tx.nanos));
          assert.ok(local.size > 1, `k=${k} nanos collapsed`);
        }
        store.mempool.push(...clones);
        resetTypedProofVerifies();
        const built = store.template({ miner: who.dest, now: stamp });
        const ids = new Set(userTxs(built.tpl).map((tx) => tx.id));
        assert.equal(ids.has(real.id), true, `k=${k} dropped the proved lock`);
        for (const clone of clones) assert.equal(ids.has(clone.id), false, clone.id);
        assert.ok(typedProofVerifyCount() >= k, `k=${k} verifies ${typedProofVerifyCount()}`);
        for (const clone of clones) dropId(store, clone.id);
        resetTypedProofVerifies();
        const again = store.template({ miner: who.dest, now: stamp });
        assert.equal(typedProofVerifyCount(), 0, `k=${k} poisoned the proved lock`);
        assert.ok(userTxs(again.tpl).some((tx) => tx.id === real.id));
      }
      assert.ok(seenNanos.size > 1, 'clone amounts collapsed');

      const newest = includeAt - SPENDABLE_CONFIRMATIONS;
      for (const off of ANCHOR_OFFSETS) {
        const presented = newest - off;
        const why = anchorRejectReason(presented, includeAt);
        if (off === 0) {
          assert.equal(why, null, 'wallet anchor rejected');
          assert.equal(presented, real.anchor);
          continue;
        }
        assert.ok(why, `offset ${off} was legal`);
        const bad = reviveTx(real);
        bad.id = `anchor-${off}`;
        bad.anchor = presented;
        const q = store.queueTx(bad, { nowMs: stamp });
        assert.equal(q.ok, false, q.reason || `offset ${off}`);
        assert.equal(store.mempool.some((tx) => tx.id === bad.id), false, bad.id);
      }
      resetTypedProofVerifies();
      const afterAnchor = store.template({ miner: who.dest, now: stamp });
      assert.equal(typedProofVerifyCount(), 0, 'a rejected anchor poisoned the lock');
      assert.ok(userTxs(afterAnchor.tpl).some((tx) => tx.id === real.id));

      for (const depth of DEPTHS) {
        if (!store.mempool.some((tx) => tx.id === real.id)) {
          const again = store.queueTx(reviveTx(real), { nowMs: headerTime(store.tip()) + STEP });
          assert.equal(again.ok, true, again.reason || `requeue ${depth}`);
        }
        await spendByOtherId(store, who.dest, `spent-d${depth}-${powTag}`);
        assert.equal(store.fluxset().spendTags.has(liveTag), true, `depth ${depth} did not spend`);
        for (let extra = 1; extra < depth; extra += 1) await sealEmpty(store, who.dest);
        assertNoSpentRow(store);
        const cleared = await probeTip(store, who.dest);
        assert.equal(userTxs(cleared).length, 0, `depth ${depth} still templates a user tx`);
        resetTypedProofVerifies();
        await reorgAway(store, who.dest, depth);
        assert.equal(store.fluxset().spendTags.has(liveTag), false, `depth ${depth} kept the spent tag`);
        assertNoSpentRow(store);
        const back = (store.mempool || []).some((tx) => txSpendTags(tx).tags.some((tag) => tag.toString('hex') === liveTag));
        if (back) assert.ok(typedProofVerifyCount() >= 1, `bounce skipped verify at depth ${depth}`);
        await probeTip(store, who.dest);
        clearUser(store);
      }
      const restored = store.queueTx(reviveTx(real), { nowMs: headerTime(store.tip()) + STEP });
      assert.equal(restored.ok, true, restored.reason || 'restored');
      clearUser(store);

      const poolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fund-pool-'));
      pool = createPool({ dataDir: poolDir, stratumPort: 0, httpPort: 0, miner: FEE });
      // Pot shares are sized from the wall clock. The template sizes the payable
      // pot from the header stamp, and that stamp cannot sit more than the MTP
      // future limit ahead of the chain. A chain left in an older pot epoch
      // therefore carries the subsidy gap. An empty round may carry. A share
      // batch may not, and consensus rejects it as pot_carry. This chain starts
      // inside the epoch that contains the wall clock.
      const poolStart = Date.now() - (includeAt * STEP);
      await mineUntil(pool.store, FEE, includeAt, poolStart);
      const stubNanos = new Set();
      for (const k of KS) {
        clearUser(pool.store);
        const ids = [];
        for (let i = 0; i < k; i += 1) {
          const nanos = (k * 1000) + i + 1;
          const built = seedStub(pool.store, { nanos, id: `stub-${k}-${i}` });
          ids.push(built.tx.id);
          stubNanos.add(nanos);
        }
        if (k > 1) assert.ok(new Set(ids.map((_, i) => (k * 1000) + i + 1)).size > 1);
        let job = pool.issueJob(undefined, { force: true });
        if (!job) {
          await pool.whenShareProofs();
          job = pool.issueJob(undefined, { force: true });
        }
        assert.ok(job?.jobId, `k=${k} job`);
        const block = jobBlock(pool, job);
        const gotIds = new Set(userTxs(block).map((tx) => tx.id));
        for (const id of ids) assert.equal(gotIds.has(id), true, id);
        const looked = await Promise.resolve(pool.store.probeBlock(block));
        assert.equal(looked.ok, false, `k=${k} stub sealed`);
        assert.equal(sealFailureClass(looked.reason), 'body', looked.reason || `k=${k}`);
        const beforeBans = pool.adminOps.health().bans;
        const beforeProbes = Number(pool.stats.sealEscapeProbes) || 0;
        const lines = await captureErrors(async () => {
          for (let n = 0; n < SEAL_ESCAPE_AFTER; n += 1) {
            const failed = await pool.sealFoundShare({
              jobId: pool.lastJob.jobId,
              nonce: 0n,
              miner: FEE,
              powHash: easyPow().toString('hex'),
            });
            assert.equal(failed.ok, false, `k=${k} seal ${n} ${failed.reason || ''}`);
          }
        });
        const alerts = parseEvents(lines).filter((ev) => ev && ev.event === 'seal_body_tx_fault');
        assert.ok(alerts.some((ev) => ids.includes(String(ev.id || ''))), `k=${k} alert`);
        assert.equal(pool.adminOps.health().bans, beforeBans, `k=${k} ban`);
        const delta = (Number(pool.stats.sealEscapeProbes) || 0) - beforeProbes;
        assert.ok(delta <= SEAL_ESCAPE_PROBE_CAP, `k=${k} probes ${delta}`);
        const paid = await pool.sealFoundShare({
          jobId: pool.lastJob.jobId,
          nonce: 0n,
          miner: FEE,
          powHash: easyPow().toString('hex'),
        });
        assert.equal(paid.ok, true, paid.reason || `k=${k} follow`);
        const sealedIds = new Set((pool.store.tip().txs || []).map((tx) => tx.id));
        for (const id of ids) assert.equal(sealedIds.has(id), false, `sealed ${id}`);
        clearUser(pool.store);
      }
      assert.ok(stubNanos.size > 1, 'stub amounts collapsed');

      const shareDest = minerDest();
      for (const n of SHARE_BATCHES) {
        clearUser(pool.store);
        pool.rollOpenRound();
        const rows = [];
        for (let i = 0; i < n; i += 1) {
          rows.push({
            dest: shareDest,
            low: (n * 100000) + i + 1,
            bits: SHARE_FLOOR_BITS + (i % 3),
          });
        }
        const planted = await plant(pool, rows);
        const built = seedStub(pool.store, { nanos: n, id: `share-stub-${n}` });
        let job = pool.issueJob(undefined, { force: true });
        if (!job) {
          await pool.whenShareProofs();
          job = pool.issueJob(undefined, { force: true });
        }
        assert.ok(job?.jobId, `batch ${n} job`);
        const block = jobBlock(pool, job);
        assert.equal(userTxs(block).some((tx) => tx.id === built.tx.id), true, `batch ${n} stub`);
        assert.equal((block.shareBatch || []).length, planted.length, `batch ${n} shares`);
        const looked = await Promise.resolve(pool.store.probeBlock(block));
        assert.equal(looked.ok, false, `batch ${n} sealed the stub`);
        assert.equal(sealFailureClass(looked.reason), 'body', looked.reason || `batch ${n}`);
        const beforeBans = pool.adminOps.health().bans;
        const beforeProbes = Number(pool.stats.sealEscapeProbes) || 0;
        const beforeShares = pool.lag1Shares.length + pool.deferredShares.length;
        const lines = await captureErrors(async () => {
          for (let s = 0; s < SEAL_ESCAPE_AFTER; s += 1) {
            const failed = await pool.sealFoundShare({
              jobId: pool.lastJob.jobId,
              nonce: 0n,
              miner: FEE,
              powHash: easyPow().toString('hex'),
            });
            assert.equal(failed.ok, false, `batch ${n} seal ${s} ${failed.reason || ''}`);
          }
        });
        const alerts = parseEvents(lines).filter((ev) => ev && ev.event === 'seal_body_tx_fault');
        assert.ok(alerts.some((ev) => String(ev.id || '') === built.tx.id), `batch ${n} alert`);
        assert.equal(pool.adminOps.health().bans, beforeBans, `batch ${n} ban`);
        const delta = (Number(pool.stats.sealEscapeProbes) || 0) - beforeProbes;
        assert.ok(delta <= SEAL_ESCAPE_PROBE_CAP, `batch ${n} probes ${delta}`);
        assert.equal(pool.lag1Shares.length + pool.deferredShares.length, beforeShares, `batch ${n} lost shares`);
        assert.equal(beforeShares, planted.length, `batch ${n} hold`);
        const paid = await pool.sealFoundShare({
          jobId: pool.lastJob.jobId,
          nonce: 0n,
          miner: FEE,
          powHash: easyPow().toString('hex'),
        });
        assert.equal(paid.ok, true, paid.reason || `batch ${n} follow`);
        const sealedIds = new Set((pool.store.tip().txs || []).map((tx) => tx.id));
        assert.equal(sealedIds.has(built.tx.id), false, `batch ${n} sealed the stub`);
        clearUser(pool.store);
        pool.rollOpenRound();
      }
    } finally {
      if (pool) pool.close();
    }
  });
});

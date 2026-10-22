/**
 * 104b + 104c. One header-time vault verdict on queueTx, admitMempool,
 * template, and consensus. Choice is in the v3 transcript, the owner digest,
 * and the merkle leaf. A second vote or withdraw in the same portal epoch
 * is rejected, and a flipped choice cannot keep the old digest.
 */
import { describe, it } from 'node:test';
import { fileCapMs } from './slow_caps.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { buildTemplate } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import {
  MAGIC_TESTNET,
  TARGET_BLOCK_INTERVAL_MS,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
  hashBonusUnitNanos,
} from '../../crypto/asert.js';
import { epochMs } from '../../crypto/pot_sched.js';
import { newIdentity, encodeDest, hash20FromAddress, admitBaseFromAddress, destCommitFromSpendPub } from '../../crypto/address.js';
import {
  lockTx,
  voteTx,
  withdrawTx,
  previewWithdraw,
  portalIdFromDest,
  portalIdFromDest20,
  portalBlindFromSeed,
  consensusUnlockPeriod,
  proveLockEquality,
  VOTE_HOLD,
  VOTE_INCREASE,
  canonicalReserveFields,
  reserveDigestSuffix,
} from '../../crypto/reserve_vault.js';
import { deposit } from '../../crypto/owned_portal.js';
import { signSpendTx, spendPackDigest, typedCommitSum } from '../../crypto/spend.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { digestTx } from '../src/chain.js';
import {
  admitProveV3,
  admitPub,
  admitScalarFromSeed,
  fluxsetFromBlocks,
  blindCommit,
  attachAdmitPub,
} from '../../crypto/admit.js';
import {
  asU8,
  commit,
  pointBytes,
  proveRange,
  randomScalar,
  scalarBytes,
  kernelExcess,
  openedCoinbaseNanos,
  sealNote,
  sealCoinbaseNote,
  sealHiddenNote,
} from '../../crypto/note.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { walletAnchor, readyHeight, txDigestV3, admitV3Context, fundingJroot } from '../../crypto/admit_v3.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
  fs1RootAt,
  resetFs1Tree,
  resetFs1VerifyCache,
  txBodyDigestFs1,
} from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import { proveLeafVote, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { censusOf, proposalId, voteCloseHeight } from '../../crypto/leaf_vote.js';
import { VAULT_DAY_BLOCKS } from '../../crypto/vault_accrual.js';

const T0 = 1_700_000_000_000;
const LOCKS = [PI_SHE_NANOS, PI_SHE_NANOS + 1_000_000];

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

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function tipHeight(store) {
  const t = store.tip();
  return t ? Number(t.height) : 0;
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
  if (openings && opening) openings.push({ height: store.tip().height, dest, ...opening });
  return opening;
}

function anchorFlux(blocks, anchor) {
  return fluxsetFromBlocks((blocks || []).filter((b) => {
    const h = Number(b?.height || 0);
    return h > 0 && h <= anchor;
  }));
}

function indexInFlux(flux, commit) {
  const want = Buffer.from(asU8(commit));
  for (let i = 0; i < (flux.commits || []).length; i += 1) {
    const got = Buffer.from(asU8(flux.commits[i]));
    if (got.length === want.length && got.equals(want)) return i;
  }
  return -1;
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
  const summed = typedCommitSum(tx);
  assert.equal(summed.ok, true, summed.reason || 'changed sum');
  assert.equal(typedCommitSum(compactTx(tx)).ok, true);
  return settled;
}

function proveVote(store, who, opening, id, choice) {
  const anchor = walletAnchor(tipHeight(store) + 1);
  assert.ok(anchor >= opening.height, `anchor ${anchor} covers ${opening.height}`);
  const flux = anchorFlux(store.blocks, anchor);
  const pot = (store.blocks.find((b) => Number(b.height) === opening.height)?.txs?.[0]?.vout || [])
    .find((o) => o.kind === 'pot');
  const index = indexInFlux(flux, pot.commit);
  assert.ok(index >= 0, `pot ${opening.height}`);
  const tx = stripPayer(voteTx({
    from: who.dest,
    dest: who.dest,
    choice,
    id,
  }));
  proveChanged(tx, {
    x: admitScalarFromSeed(who.spendSeed, pot),
    index,
    flux,
    note: pot,
    anchor,
    noteR: opening.r,
    noteV: opening.v,
    receiptNanos: 0,
    base: admitBaseFromAddress(who.dest),
  });
  signSpendTx(tx, who.key);
  return tx;
}

function proveWithdraw(store, who, opening, id) {
  const anchor = walletAnchor(tipHeight(store) + 1);
  const flux = anchorFlux(store.blocks, anchor);
  const pot = (store.blocks.find((b) => Number(b.height) === opening.height)?.txs?.[0]?.vout || [])
    .find((o) => o.kind === 'pot');
  const index = indexInFlux(flux, pot.commit);
  assert.ok(index >= 0, `withdraw pot ${opening.height}`);
  const preview = previewWithdraw(store.reserveVault, who.dest);
  assert.ok(preview.payout > 0);
  const tx = stripPayer(withdrawTx({
    from: who.dest,
    to: who.dest,
    nanos: preview.payout,
    id,
  }));
  proveChanged(tx, {
    x: admitScalarFromSeed(who.spendSeed, pot),
    index,
    flux,
    note: pot,
    anchor,
    noteR: opening.r,
    noteV: opening.v,
    receiptNanos: preview.payout,
    base: admitBaseFromAddress(who.dest),
  });
  signSpendTx(tx, who.key);
  return tx;
}

function scalarBuf(r) {
  if (typeof r === 'bigint') return scalarBytes(r);
  const b = Buffer.from(asU8(r));
  return b.length === 32 ? b : scalarBytes(r);
}

function rangeSlack(outs) {
  let bytes = 0;
  for (const o of outs) if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  return Math.ceil((bytes * 2) / 2048) + 8;
}

function placeholders(k) {
  const fs1 = Buffer.alloc(fs1BlobLen(k), 255);
  fs1[0] = FS1_WIRE;
  const proofs = [];
  for (let i = 0; i < k; i += 1) {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
    blob[0] = FS1_WIRE;
    proofs.push({
      admit_proof: true,
      v: FS1_WIRE,
      spendTag: Buffer.alloc(32, 255),
      blob,
      cTilde: Buffer.alloc(32, 255),
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

async function mineAt(store, dest, now, openings, who) {
  const { tpl } = store.template({ miner: dest, shareBits: 4, now });
  const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
  const got = await Promise.resolve(store.append({
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
  }, { trustedPowHash: easyPowHash(), skipSharePow: true }));
  assert.equal(got.ok, true, `mine ${got.reason || ''} ${got.error || ''} h=${tpl.height}`);
  if (openings && who && pot?.r && pot.commit) {
    openings.push({
      r: scalarBuf(pot.r),
      v: openedCoinbaseNanos(pot),
      commit: Buffer.from(asU8(pot.commit)),
      x: admitScalarFromSeed(who.spendSeed, pot),
      height: tpl.height,
    });
  }
  return tpl;
}

function liveCoins(store, coins, spent) {
  const height = tipHeight(store) + 1;
  const anchor = walletAnchor(height);
  assert.ok(anchor, `anchor at ${height}`);
  const live = store.anchorNote(anchor);
  assert.ok(live && live.n >= 1, `anchor ${anchor}`);
  const at = new Map();
  for (let i = 0; i < live.n; i += 1) {
    at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
  }
  const out = [];
  for (const c of coins) {
    const key = c.commit.toString('hex');
    if (spent.has(key) || !at.has(key)) continue;
    out.push({ ...c, index: at.get(key) });
  }
  return { anchor, live, coins: out };
}

function proveSpend(tx, use, anchor, live, outs) {
  resetFs1Tree();
  resetFs1VerifyCache();
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

function buildFeeVote(store, who, coins, spent, id, fields) {
  const view = liveCoins(store, coins, spent);
  const use = view.coins.slice(0, 1);
  assert.equal(use.length, 1, `${id} input`);
  const d20 = hash20FromAddress(who.dest);
  const ph = placeholders(1);
  let fee = LEVY_FLOOR_UNITS;
  let tx = null;
  let outs = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const changeN = use[0].v - fee;
    assert.ok(changeN > 0, `${id} change ${changeN}`);
    outs = [hiddenChange(changeN, d20, who.id.admitBase)];
    const draft = compactTx({
      id,
      kind: 'leaf-vote',
      anchor: view.anchor,
      fee,
      programId: RESERVE_PROGRAM,
      vin: ph.vin,
      vout: outs,
      fs1: ph.fs1,
      admit_proofs: ph.proofs,
      ...fields,
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) {
      tx = proveSpend(draft, use, view.anchor, view.live, outs);
      break;
    }
    const next = need + rangeSlack(outs);
    assert.ok(next > fee && next <= LEVY_CAP_NANOS, `${id} levy ${need}`);
    fee = next;
  }
  assert.ok(tx, `${id} fee`);
  return { tx, use, outs };
}

async function advanceClock(store, dest, targetMs) {
  const step = 15 * 60_000;
  let guard = 0;
  while (headerTime(store.tip()) < targetMs) {
    assert.ok(guard < 4000, 'clock');
    guard += 1;
    const prev = headerTime(store.tip());
    await mineAt(store, dest, Math.min(targetMs, prev + step));
  }
}

function mempoolTags(store) {
  const spent = new Set();
  for (const m of store.mempool) {
    const tags = [];
    if (m?.admit_proof?.spendTag) tags.push(m.admit_proof.spendTag);
    if (Array.isArray(m?.admit_proofs)) {
      for (const proof of m.admit_proofs) if (proof?.spendTag) tags.push(proof.spendTag);
    }
    for (const tag of tags) {
      try { spent.add(Buffer.from(asU8(tag)).toString('hex')); } catch { /* skip */ }
    }
  }
  return spent;
}

function skipReason(lines, id) {
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.event === 'mempool_skip' && String(row.id) === String(id)) return row.reason;
    } catch { /* other logs */ }
  }
  return '';
}

async function sameVerdict(store, tx, reason, wall) {
  const before = tipHeight(store);
  const queued = store.queueTx(tx, { nowMs: wall });
  assert.equal(queued.ok, false, queued.reason || 'queue');
  assert.equal(queued.reason, reason, `queue ${queued.reason}`);
  assert.equal(store.mempool.some((m) => m.id === tx.id), false);

  const book = emptyMempool();
  book.txs = store.mempool.slice();
  const admitted = admitMempool(book, tx, {
    baseFee: 1,
    reserveState: store.reserveVault,
    nowMs: wall,
    height: before + 1,
    blocks: store.blocks,
    spendTags: mempoolTags(store),
    // The direct mempool call has to see the same anchor row queue and
    // consensus read. Without it a real FS-1 proof stops at admit_anchor_root.
    noteAtAnchor: (anchor) => store.anchorNote(anchor),
    magic: MAGIC_TESTNET,
  });
  assert.equal(admitted.ok, false, admitted.reason || 'admit');
  assert.equal(admitted.reason, reason, `admit ${admitted.reason}`);

  const logs = [];
  const orig = console.error;
  console.error = (...args) => {
    logs.push(args.map((part) => String(part)).join(' '));
  };
  let tpl;
  try {
    store.mempool.push(tx);
    const built = store.template({ miner: tx.to || store.blocks[0].miner, shareBits: 4, now: wall });
    tpl = built.tpl;
  } finally {
    console.error = orig;
  }
  const inBlock = (tpl.txs || []).some((row) => row.id === tx.id);
  assert.equal(inBlock, false, 'template kept a rejected reserve tx');
  assert.equal(skipReason(logs, tx.id), reason, `template ${skipReason(logs, tx.id)}`);
  if (admitted.vault) {
    assert.equal(store.mempool.some((m) => m.id === tx.id), false, 'template left a vault reject queued');
  } else {
    const at = store.mempool.findIndex((m) => m.id === tx.id);
    if (at >= 0) store.mempool.splice(at, 1);
  }

  const tip = store.tip();
  const stamp = headerTime({ header: tpl.header });
  assert.equal(stamp, wall, 'header stamp matches the mempool clock');
  const user = store.mempool.filter((m) => m && !m.coinbase);
  const block = buildTemplate({
    prev: tip.hash,
    prevHeader: tip.header,
    prevBlock: tip,
    height: tip.height + 1,
    miner: tip.miner || store.blocks[0].miner,
    now: stamp,
    bits: Number(decodeHeader(Buffer.from(tpl.header)).bits),
    txs: [...user, tx],
    parentBlocks: store.blocks,
    parentFluxset: store.fluxset().pubs,
    hashBonusNanos: hashBonusUnitNanos(store.reserveVault.liveHashBonusNanos),
  });
  const appended = await Promise.resolve(store.append({
    header: block.header,
    txs: block.txs,
    samples: block.samples,
    shareBatch: block.shareBatch || [],
    miner: tip.miner,
    aLeaves: block.aLeaves,
    bLeaves: block.bLeaves,
    rootA: block.rootA,
    rootB: block.rootB,
    weight: block.weight,
  }, {
    trustedPowHash: easyPowHash(),
    skipSharePow: true,
  }));
  assert.equal(appended.ok, false, appended.reason || 'consensus');
  assert.equal(appended.reason, reason, `consensus ${appended.reason}`);
  assert.equal(tipHeight(store), before);
  return stamp;
}

describe('vault parity', { timeout: fileCapMs(import.meta.url) }, () => {
  it('binds choice on the three digests and leaves a send digest unchanged', () => {
    const amounts = [1, PI_SHE_NANOS];
    assert.ok(new Set(amounts).size >= 2);
    const who = payer();
    for (const nanos of amounts) {
      const lock = lockTx({ from: who.dest, to: who.dest, nanos, id: `lock-${nanos}` });
      const sealedLock = compactTx(lock);
      assert.equal(digestTx(sealedLock).equals(digestTx(lock)), true);
      assert.equal(reserveDigestSuffix(lock).equals(reserveDigestSuffix(sealedLock)), true);
      const vote = voteTx({ from: who.dest, dest: who.dest, choice: VOTE_HOLD, id: `vote-${nanos}` });
      const sealedVote = compactTx(vote);
      assert.equal(String(sealedVote.choice), VOTE_HOLD);
      assert.equal(digestTx(sealedVote).equals(digestTx(vote)), true);
      assert.equal(txDigestV3(sealedVote).equals(txDigestV3(vote)), true);
      assert.equal(spendPackDigest(sealedVote).equals(spendPackDigest(vote)), true);
      const flipped = { ...vote, choice: VOTE_INCREASE };
      assert.equal(digestTx(flipped).equals(digestTx(vote)), false);
      assert.equal(txDigestV3(flipped).equals(txDigestV3(vote)), false);
      assert.equal(spendPackDigest(flipped).equals(spendPackDigest(vote)), false);
      assert.equal(canonicalReserveFields(flipped).choice, VOTE_INCREASE);
    }
    const send = { kind: 'send', fee: 1, vin: [{ address: who.dest }], vout: [{ kind: 'send', nanos: 1 }] };
    const tagged = { ...send, choice: VOTE_INCREASE };
    assert.equal(reserveDigestSuffix(send), null);
    assert.equal(txDigestV3(send).equals(txDigestV3(tagged)), true);
    assert.equal(digestTx(send).equals(digestTx(tagged)), true);
    assert.equal(spendPackDigest(send).equals(spendPackDigest(tagged)), true);
  });

  it('a byte-3 vault proof is vault_unavailable on queue, mempool, template, and consensus', async () => {
    const commit = Buffer.alloc(32, 4);
    const blob = Buffer.alloc(129, 0);
    blob[0] = 3;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-parity-'));
    try {
      // Burial past height 1000 rewrites a chain segment on every append. These
// verdicts do not depend on that rewrite. The book stays in memory.
const store = createStore(dir, {
  snapEvery: 0,
  firstCheckpoint: 1_000_000,
  checkpointEvery: 1_000_000,
  diskJournal: false,
  pruneAfter: 1_000_000,
});
      const who = payer();
      await sealEmpty(store, who.dest, T0);
      const wall = headerTime(store.tip()) + 90_000;
      for (const kind of ['lock', 'vote', 'withdraw']) {
        // Current law: a byte-3 bucket proof is vault_unavailable on every
        // path. The FS-1 cases below are the funded verdicts.
        await sameVerdict(store, {
          id: `byte3-${kind}`,
          kind,
          // A withdraw with no opened amount is mint_amount and never reaches
          // the block. The bucket gate still runs first, on the tx that is in it.
          nanos: 1,
          vin: [{ commit: Buffer.from(commit) }],
          admit_proofs: [{ blob: Buffer.from(blob), cTilde: Buffer.from(commit) }],
        }, 'vault_unavailable', wall);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FS-1 admit_membership and not_voter are the same reason on all four paths', async () => {
    if (!fs1NativeLoaded()) assert.fail('shear_admit FS-1 addon is not loaded');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-parity-fs1-'));
    try {
      // Burial past height 1000 rewrites a chain segment on every append. These
// verdicts do not depend on that rewrite. The book stays in memory.
const store = createStore(dir, {
  snapEvery: 0,
  firstCheckpoint: 1_000_000,
  checkpointEvery: 1_000_000,
  diskJournal: false,
  pruneAfter: 1_000_000,
});
      const who = payer();
      const coins = [];
      const spent = new Set();
      await mineAt(store, who.dest, T0, coins, who);
      while (tipHeight(store) < 16) {
        await mineAt(store, who.dest, headerTime(store.tip()) + 90_000, coins, who);
      }
      assert.ok(coins.length >= 2, 'pots');
      const member = buildFeeVote(store, who, coins, spent, 'parity-member', {
        voteProof: Buffer.alloc(32, 7),
        choice: 1,
        voteSeq: 1,
        voteParam: 'hb',
        earnEpoch: 0,
      });
      const badFs1 = Buffer.from(member.tx.fs1);
      badFs1[badFs1.length - 1] ^= 0xff;
      const bad = { ...member.tx, id: 'parity-member-bad', fs1: badFs1 };
      await sameVerdict(store, bad, 'admit_membership', headerTime(store.tip()) + 90_000);
      // No π leaf has been locked, so this epoch has no census. The spend is real.
      const outsider = buildFeeVote(store, who, coins.slice(1), spent, 'parity-outsider', {
        voteProof: Buffer.alloc(32, 8),
        choice: 1,
        voteSeq: 1,
        voteParam: 'hb',
        earnEpoch: 0,
      });
      await sameVerdict(store, outsider.tx, 'not_voter', headerTime(store.tip()) + 90_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unowned vote fee past the anchor is refused against that valid anchor', async () => {
    if (!fs1NativeLoaded()) assert.fail('shear_admit FS-1 addon is not loaded');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-parity-own-'));
    try {
      // Burial past height 1000 rewrites a chain segment on every append. These
// verdicts do not depend on that rewrite. The book stays in memory.
const store = createStore(dir, {
  snapEvery: 0,
  firstCheckpoint: 1_000_000,
  checkpointEvery: 1_000_000,
  diskJournal: false,
  pruneAfter: 1_000_000,
});
      const who = payer();
      const coins = [];
      await mineAt(store, who.dest, T0, coins, who);
      while (tipHeight(store) < 16) {
        await mineAt(store, who.dest, headerTime(store.tip()) + 90_000, coins, who);
      }
      const height = tipHeight(store) + 1;
      const anchor = walletAnchor(height);
      const live = store.anchorNote(anchor);
      assert.ok(anchor && live && live.n >= 1, 'anchor');
      const anchorRoot = fs1RootAt(live);
      assert.equal(anchorRoot.length, 32, 'anchor root');
      const past = coins.filter((c) => Number(c.height) > anchor);
      assert.ok(past.length >= 1, 'a fee note mined after the anchor');
      const note = past[past.length - 1];
      const noteCommit = Buffer.from(note.commit);
      const inAnchor = live.commits.some((row) => Buffer.from(asU8(row)).equals(noteCommit));
      assert.equal(inAnchor, false, 'the later note is not in the anchor');
      const pub = Buffer.from(pointBytes(admitPub(note.x)));
      const widened = {
        n: live.n + 1,
        jroot: Buffer.from(asU8(live.jroot)),
        pubs: [...live.pubs.map((row) => Buffer.from(asU8(row))), pub],
        commits: [...live.commits.map((row) => Buffer.from(asU8(row))), noteCommit],
      };
      const widenedRoot = fs1RootAt(widened);
      assert.equal(widenedRoot.equals(anchorRoot), false, 'adding the later note changes the root');
      const d20 = hash20FromAddress(who.dest);
      const ph = placeholders(1);
      let fee = LEVY_FLOOR_UNITS;
      let drafted = null;
      const use = [{ ...note, index: live.n }];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const changeN = note.v - fee;
        assert.ok(changeN > 0, `change ${changeN}`);
        const outs = [hiddenChange(changeN, d20, who.id.admitBase)];
        const draft = compactTx({
          id: 'parity-unowned-fee',
          kind: 'leaf-vote',
          anchor,
          fee,
          programId: RESERVE_PROGRAM,
          voteProof: Buffer.alloc(32, 9),
          choice: 1,
          voteSeq: 1,
          voteParam: 'hb',
          earnEpoch: 0,
          vin: ph.vin,
          vout: outs,
          fs1: ph.fs1,
          admit_proofs: ph.proofs,
        });
        const need = levyNeed(draft);
        if (fee >= need && fee <= LEVY_CAP_NANOS) {
          drafted = proveSpend(draft, use, anchor, widened, outs);
          break;
        }
        const next = need + rangeSlack(outs);
        assert.ok(next > fee && next <= LEVY_CAP_NANOS, `levy ${need}`);
        fee = next;
      }
      assert.ok(drafted, 'proof of the later note');
      const carried = Buffer.from(drafted.fs1).subarray(3, 35);
      assert.equal(carried.equals(widenedRoot), true, 'the proof carries the widened root');
      // The anchor named on the vote is real. The fee note is not in it.
      // Putting that anchor's root on the proof must still fail membership.
      const posted = Buffer.from(drafted.fs1);
      anchorRoot.copy(posted, 3);
      drafted.fs1 = posted;
      assert.equal(Buffer.from(drafted.fs1).subarray(3, 35).equals(anchorRoot), true, 'posted root is the anchor');
      await sameVerdict(store, drafted, 'admit_membership', headerTime(store.tip()) + 90_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FS-1 vote_locked and epoch_closed are the same reason on all four paths', async () => {
    if (!fs1NativeLoaded()) assert.fail('shear_admit FS-1 addon is not loaded');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-parity-window-'));
    try {
      // Burial past height 1000 rewrites a chain segment on every append. These
// verdicts do not depend on that rewrite. The book stays in memory.
const store = createStore(dir, {
  snapEvery: 0,
  firstCheckpoint: 1_000_000,
  checkpointEvery: 1_000_000,
  diskJournal: false,
  pruneAfter: 1_000_000,
});
      const born = newIdentity();
      const commit20 = destCommitFromSpendPub(born.spendPub);
      const who = {
        id: born,
        dest: encodeDest(commit20, born.admitBase),
        spendSeed: born.spendSeed,
        key: born.privateKey,
      };
      const coins = [];
      const spent = new Set();
      const d20 = hash20FromAddress(who.dest);
      const portalId = portalIdFromDest20(d20, portalBlindFromSeed(who.spendSeed));
      assert.notEqual(portalId, portalIdFromDest(who.dest));
      await mineAt(store, who.dest, T0, coins, who);
      while (coins.length < 8) {
        await mineAt(store, who.dest, headerTime(store.tip()) + 90_000, coins, who);
      }
      while (tipHeight(store) < 16) {
        await mineAt(store, who.dest, headerTime(store.tip()) + 90_000, coins, who);
      }
      const view = liveCoins(store, coins, spent);
      const use = view.coins.slice(0, 4);
      assert.equal(use.length, 4, 'lock inputs');
      const total = use.reduce((sum, c) => sum + c.v, 0);
      const blind = randomScalar();
      const scalar = randomScalar();
      const unlock = consensusUnlockPeriod(0);
      const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
      assert.ok(leaf, 'leaf');
      const funded = pointBytes(commit(PI_SHE_NANOS, blind));
      const range = proveRange(PI_SHE_NANOS, blind);
      assert.ok(range, 'range');
      const ph = placeholders(4);
      let fee = LEVY_FLOOR_UNITS;
      let lock = null;
      let lockOuts = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const changeN = total - fee - PI_SHE_NANOS;
        assert.ok(changeN > 0, `lock change ${changeN}`);
        const outs = [
          {
            kind: 'lock',
            commit: funded,
            rangeProof: range,
            r: scalarBytes(blind),
            dest20: Buffer.from(d20),
            portalId,
            viewTag: Buffer.from([1]),
          },
          hiddenChange(changeN, d20, who.id.admitBase),
        ];
        const draft = compactTx({
          id: 'parity-lock',
          kind: 'lock',
          anchor: view.anchor,
          fee,
          nanos: 0,
          programId: RESERVE_PROGRAM,
          portalId,
          ownerPub: Buffer.from(who.id.spendPub).toString('hex'),
          vaultLockNote: leaf.note,
          vin: ph.vin,
          vout: outs,
          fs1: ph.fs1,
          admit_proofs: ph.proofs,
        });
        const need = levyNeed(draft);
        if (fee >= need && fee <= LEVY_CAP_NANOS) {
          lock = proveSpend(draft, use, view.anchor, view.live, outs);
          lockOuts = outs;
          break;
        }
        const next = need + rangeSlack(outs);
        assert.ok(next > fee && next <= LEVY_CAP_NANOS, `lock levy ${need}`);
        fee = next;
      }
      assert.ok(lock, 'lock fee');
      lock.dest20 = Buffer.from(d20);
      signSpendTx(lock, who.key);
      const fund = proveLockEquality(funded, PI_SHE_NANOS, blind, lock, MAGIC_TESTNET, 0);
      assert.ok(fund, 'fund');
      lock.piProof = proveRange(0n, blind);
      assert.ok(lock.piProof, 'pi');
      const lockRow = lock.vout.find((row) => String(row?.kind || '') === 'lock');
      assert.ok(lockRow, 'lock out');
      lockRow.fundProof = fund;
      const queuedLock = store.queueTx(lock);
      assert.equal(queuedLock.ok, true, `lock queue ${queuedLock.reason}`);
      const lockedTip = await mineAt(store, who.dest, headerTime(store.tip()) + 90_000);
      assert.ok(lockedTip.txs.some((row) => row.id === 'parity-lock'), 'lock mined');
      for (const c of use) spent.add(c.commit.toString('hex'));
      const change = lockOuts[1];
      coins.push({
        r: scalarBuf(change.r),
        v: total - lock.fee - PI_SHE_NANOS,
        commit: Buffer.from(asU8(change.commit)),
        x: admitScalarFromSeed(who.spendSeed, change),
      });
      while (tipHeight(store) < 240) {
        await mineAt(store, who.dest, headerTime(store.tip()) + 90_000);
      }
      const periodRoot = String(store.reserveVault.epochStartRoots?.['1'] || '');
      assert.equal(periodRoot, store.reserveVault.vaultLockRoot, 'period root');
      const genesis = Number(store.reserveVault.genesisMs);
      assert.ok(genesis > 0, 'genesis');
      await advanceClock(store, who.dest, genesis + RESERVE_EPOCH_MS);
      await mineAt(store, who.dest, headerTime(store.tip()) + 90_000);
      assert.equal(store.reserveVault.currentEpoch, 1, 'epoch');
      const census = censusOf(store.reserveVault, 1);
      assert.ok(census && census.known && census.leafCount >= 1, 'census');
      const closeH = voteCloseHeight(census.openHeight, MAGIC_TESTNET);
      assert.equal(closeH - census.openHeight, 3 * VAULT_DAY_BLOCKS, 'vote close is three vault days');
      const voteProof = proveLeafVote({
        locks: [{ amount: PI_SHE_NANOS, scalar, blind, unlockEpoch: unlock }],
        which: 0,
        epoch: 1,
        choice: 1,
        seq: 1,
        proposalId: proposalId(1, 'hb'),
        dest20: d20,
      });
      assert.ok(voteProof, 'vote proof');
      assert.equal(voteProof.rootHex, periodRoot, 'vote root');
      const first = buildFeeVote(store, who, coins, spent, 'parity-vote-1', {
        voteProof: voteProof.blob,
        voteOutput: voteProof.note,
        choice: 1,
        voteSeq: 1,
        voteParam: 'hb',
        earnEpoch: 1,
      });
      const queuedVote = store.queueTx(first.tx, { nowMs: headerTime(store.tip()) });
      assert.equal(queuedVote.ok, true, `vote queue ${queuedVote.reason}`);
      const voted = await mineAt(store, who.dest, headerTime(store.tip()) + 90_000);
      assert.ok(voted.txs.some((row) => row.id === 'parity-vote-1'), 'vote mined');
      for (const c of first.use) spent.add(c.commit.toString('hex'));
      const second = buildFeeVote(store, who, coins, spent, 'parity-vote-2', {
        voteProof: voteProof.blob,
        voteOutput: voteProof.note,
        choice: 1,
        voteSeq: 1,
        voteParam: 'hb',
        earnEpoch: 1,
      });
      await sameVerdict(store, second.tx, 'vote_locked', headerTime(store.tip()) + 90_000);
      // Close height is still inside the window. The queue trials at the tip
      // height, so the ballot has to be one block past that close.
      while (tipHeight(store) <= closeH) {
        await mineAt(store, who.dest, headerTime(store.tip()) + 90_000);
      }
      const closedProof = proveLeafVote({
        locks: [{ amount: PI_SHE_NANOS, scalar, blind, unlockEpoch: unlock }],
        which: 0,
        epoch: 1,
        choice: 1,
        seq: 2,
        proposalId: proposalId(1, 'hb'),
        dest20: d20,
      });
      assert.ok(closedProof, 'closed vote proof');
      assert.equal(closedProof.rootHex, periodRoot, 'closed vote root');
      const third = buildFeeVote(store, who, coins, spent, 'parity-vote-3', {
        voteProof: closedProof.blob,
        voteOutput: closedProof.note,
        choice: 1,
        voteSeq: 2,
        voteParam: 'hb',
        earnEpoch: 1,
      });
      await sameVerdict(store, third.tx, 'epoch_closed', headerTime(store.tip()) + 90_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

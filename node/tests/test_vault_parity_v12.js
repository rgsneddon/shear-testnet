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
import { MAGIC_TESTNET, TARGET_BLOCK_INTERVAL_MS, PI_SHE_NANOS } from '../../crypto/asert.js';
import { epochMs } from '../../crypto/pot_sched.js';
import { newIdentity, encodeDest, hash20FromAddress, admitBaseFromAddress } from '../../crypto/address.js';
import {
  lockTx,
  voteTx,
  withdrawTx,
  previewWithdraw,
  portalIdFromDest,
  VOTE_HOLD,
  VOTE_INCREASE,
  canonicalReserveFields,
  reserveDigestSuffix,
} from '../../crypto/reserve_vault.js';
import { deposit } from '../../crypto/owned_portal.js';
import { signSpendTx, spendPackDigest, typedCommitSum } from '../../crypto/spend.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { levyNeed } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { digestTx } from '../src/chain.js';
import {
  admitProveV3,
  admitScalarFromSeed,
  fluxsetFromBlocks,
  blindCommit,
  attachAdmitPub,
} from '../../crypto/admit.js';
import {
  asU8,
  randomScalar,
  scalarBytes,
  kernelExcess,
  openedCoinbaseNanos,
  sealNote,
  sealCoinbaseNote,
} from '../../crypto/note.js';
import { walletAnchor, readyHeight, txDigestV3, admitV3Context, fundingJroot } from '../../crypto/admit_v3.js';

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
    hashBonusNanos: Number(store.reserveVault.liveHashBonusNanos || 1),
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

  it('a byte-3 vault proof is unavailable on queue before the vault reason', async () => {
    const commit = Buffer.alloc(32, 4);
    const blob = Buffer.alloc(129, 0);
    blob[0] = 3;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-parity-'));
    try {
      const store = createStore(dir);
      for (const kind of ['lock', 'vote', 'withdraw']) {
        const queued = store.queueTx({
          id: `byte3-${kind}`,
          kind,
          vin: [{ commit }],
          admit_proofs: [{ blob, cTilde: commit }],
        });
        assert.equal(queued.reason, 'vault_unavailable', kind);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

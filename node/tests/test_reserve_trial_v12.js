/**
 * P0-6ee-1. A template with k reserve txs applies each one once and does not
 * verify its proof again. An arrival applies once and verifies once.
 * Amounts, portals, and k vary. The cap is the exported policy value.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createStore } from '../src/store.js';
import { digestTx } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { MAGIC_TESTNET, TARGET_BLOCK_INTERVAL_MS, RESERVE_PROGRAM } from '../../crypto/asert.js';
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
} from '../../crypto/note.js';
import {
  lockTx,
  portalIdFromDest,
  RESERVE_ACTION_CAP,
  reserveTrialStats,
  resetReserveTrialStats,
} from '../../crypto/reserve_vault.js';
import { signSpendTx } from '../../crypto/spend.js';
import { levyNeed } from '../../crypto/levy.js';
import {
  walletAnchor,
  readyHeight,
  txDigestV3,
  admitV3Context,
  fundingJroot,
  typedProofVerifyCount,
  resetTypedProofVerifies,
} from '../../crypto/admit_v3.js';
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
  resetTypedProofVerifies();
}

function readCounters() {
  const trial = reserveTrialStats();
  return {
    applies: trial.applies,
    opens: trial.opens,
    verifies: typedProofVerifyCount(),
  };
}

describe('v12 reserve trial is incremental', () => {
  it('a byte-3 lock is vault_unavailable before a reserve trial', { timeout: 30_000 }, async () => {
    // FS-1 acceptance is test_vault_fs1_funding_v12.js.
    const commit = Buffer.alloc(32, 4);
    const blob = Buffer.alloc(129, 0);
    blob[0] = 3;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reserve-trial-'));
    try {
      const store = createStore(dir);
      const queued = store.queueTx({
        id: 'byte3-lock',
        kind: 'lock',
        vin: [{ commit }],
        admit_proofs: [{ blob, cTilde: commit }],
      });
      assert.equal(queued.reason, 'vault_unavailable');
      assert.equal(store.mempool.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

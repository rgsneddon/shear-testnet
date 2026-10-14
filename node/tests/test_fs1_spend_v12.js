/**
 * FS-1 full-set sends end to end. One aggregate FS-1 spend (0xF1) covers
 * 1, 2, 5, and 8 inputs. Each send is accepted by admitMempool, verifyBlock,
 * queueTx, and append, and its spend tags join the chain. The payee opens the
 * received note and spends it. A spent tag and a non-leaf output are rejected.
 * Prove and verify timings go to $TMPDIR/shear-fs1-spend-timings.jsonl.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { newIdentity, encodeDest, hash20FromAddress } from '../../crypto/address.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { admitBaseScalar, admitScalarFromSeed, attachAdmitPub, blindCommit } from '../../crypto/admit.js';
import {
  asU8,
  kernelExcess,
  openedCoinbaseNanos,
  openNoteAmount,
  sealHiddenNote,
  sealNote,
} from '../../crypto/note.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { walletAnchor, flowProofVerifyCount, resetFlowProofVerifies } from '../../crypto/admit_v3.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
  fs1RootAt,
  resetFs1Tree,
  txBodyDigestFs1,
} from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded, fs1TreeAppend, fs1TreeNew, fs1Verify } from '../../crypto/native_admit.js';
import { txVerifyWeight } from '../../crypto/block_budget.js';

const T0 = 1_700_000_000_000;
const TIMINGS = path.join(os.tmpdir(), 'shear-fs1-spend-timings.jsonl');
const PROOF_SEQUENCE = [1, 2, 5, 8];

function record(row) {
  const line = JSON.stringify({ t: new Date().toISOString(), cpus: os.cpus().length, ...row });
  console.log(line);
  try { fs.appendFileSync(TIMINGS, `${line}\n`); } catch { /* a log miss is not a verdict */ }
}

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { id, dest, spendSeed: id.spendSeed, base: id.admitBase };
}

function hiddenOut(nanos, dest20, admitBase, kind) {
  const sealed = admitBase
    ? sealHiddenNote(nanos, { dest20, kind, admitBase })
    : sealNote(nanos, { dest20, kind });
  let note = attachAdmitPub(sealed, admitBase ? { admitBase } : {});
  note = { ...note, kind, dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  if (kind !== 'dummy') delete note.valueProof;
  return note;
}

function lastStamp(store) {
  const tip = store.tip();
  return tip ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) : T0;
}

async function mine(store, dest) {
  const now = Math.max(T0, lastStamp(store) + 90_000);
  const { tpl } = store.template({ miner: dest, shareBits: 4, now });
  const got = await Promise.resolve(store.append({
    header: tpl.header,
    height: tpl.height,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: Buffer.alloc(32), skipSharePow: true }));
  assert.equal(got.ok, true, `append ${got.reason || ''}`);
  return tpl;
}

function blockVerdict(store, dest, tx) {
  const tip = store.tip();
  const preview = store.template({ miner: dest, shareBits: 4, now: lastStamp(store) + 90_000 });
  const stamp = Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp);
  const built = buildTemplate({
    prev: tip ? tip.hash : GENESIS_PREV,
    prevHeader: tip ? tip.header : undefined,
    prevBlock: tip || null,
    height: (tip?.height || 0) + 1,
    miner: dest,
    bits: preview.tpl.bits,
    now: stamp,
    txs: [tx],
    parentBlocks: store.blocks,
  });
  if (!built.txs.some((row) => row.id === tx.id)) return { ok: false, reason: 'template_dropped' };
  let genesisMs = 0;
  try {
    const g = store.blocks[0];
    if (g?.header) genesisMs = Number(decodeHeader(Buffer.from(g.header)).timestamp) || 0;
  } catch { /* a missing genesis clock stays 0 */ }
  const parentSupply = typeof store.supplyState === 'function' ? store.supplyState() : null;
  return verifyBlock({
    header: built.header,
    height: built.height,
    txs: built.txs,
    samples: built.samples,
    shareBatch: built.shareBatch || [],
    miner: dest,
    aLeaves: built.aLeaves,
    bLeaves: built.bLeaves,
    rootA: built.rootA,
    rootB: built.rootB,
    weight: built.weight,
  }, tip, {
    trustedPowHash: Buffer.alloc(32),
    skipSharePow: true,
    noteAtAnchor: (anchor) => store.anchorNote(anchor),
    evmHistory: store.blocks,
    genesisMs,
    magic: MAGIC_TESTNET,
    ...(parentSupply ? { parentSupply } : {}),
  });
}

function rangeSlack(outs) {
  let bytes = 0;
  for (const o of outs) if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  return Math.ceil((bytes * 2) / 2048) + 8;
}

/** Placeholder FS-1 fields of the exact final length, with the widest JSON bytes. */
function placeholders(k) {
  const fs1 = Buffer.alloc(fs1BlobLen(k), 255);
  fs1[0] = FS1_WIRE;
  const proofs = [];
  for (let i = 0; i < k; i += 1) {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
    blob[0] = FS1_WIRE;
    proofs.push({ admit_proof: true, v: 3, spendTag: Buffer.alloc(32, 255), blob, cTilde: Buffer.alloc(32, 255) });
  }
  return { fs1, proofs, vin: proofs.map(() => ({ commit: Buffer.alloc(32, 255) })) };
}

/**
 * Build, settle the levy, and prove one send of `coins` (each
 * { index, x, r, v, commit }) to `to`. `outsOf(room)` builds the outputs.
 */
function buildSend({ id, kind = 'send', coins, anchor, live, outsOf }) {
  const total = coins.reduce((s, c) => s + c.v, 0);
  const k = coins.length;
  const ph = placeholders(k);
  let fee = LEVY_FLOOR_UNITS;
  let outs = null;
  let draft = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const room = total - fee;
    assert.ok(room >= 1, `fee consumes the coins ${total} ${fee}`);
    outs = outsOf(room);
    draft = compactTx({
      id,
      kind,
      anchor,
      fee,
      vin: ph.vin,
      vout: outs,
      fs1: ph.fs1,
      admit_proofs: ph.proofs,
      excess: Buffer.alloc(32, 255),
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) break;
    const next = need + rangeSlack(outs);
    assert.ok(next > fee && next <= LEVY_CAP_NANOS, `levy ${need} fee ${fee}`);
    fee = next;
    draft = null;
  }
  assert.ok(draft, 'fee did not settle');
  const t0 = process.hrtime.bigint();
  const proven = fs1ProveSpend({
    live,
    anchor,
    indices: coins.map((c) => c.index),
    xs: coins.map((c) => c.x),
    tx: draft,
    magic: MAGIC_TESTNET,
  });
  const proveMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(proven, `${id} prove`);
  assert.equal(proven.fs1.length, fs1BlobLen(k));
  for (let i = 0; i < k; i += 1) {
    const want = Buffer.from(blindCommit(coins[i].commit, proven.t[i]));
    assert.ok(want.equals(proven.proofs[i].cTilde), `${id} C~ ${i} is C + t·H`);
  }
  const excess = kernelExcess(outs, coins.map((c, i) => ({ r: c.r, t: proven.t[i] })));
  assert.ok(excess, `${id} excess`);
  const tx = compactTx({
    id,
    kind,
    anchor,
    fee: draft.fee,
    vin: proven.proofs.map((p) => ({ commit: Buffer.from(p.cTilde) })),
    vout: outs,
    fs1: proven.fs1,
    admit_proofs: proven.proofs,
    excess,
  });
  const need = levyNeed(tx);
  assert.ok(tx.fee >= need, `${id} levy ${need} fee ${tx.fee}`);
  assert.ok(txBodyDigestFs1(tx, MAGIC_TESTNET).equals(proven.digest), `${id} compact digest`);
  return { tx, outs, proven, proveMs, fee: tx.fee, total };
}

describe('v12 FS-1 full-set send', { concurrency: false }, () => {
  if (!fs1NativeLoaded()) {
    it('needs the native FS-1 addon (crypto/native make all)', () => {
      assert.fail('shear_admit FS-1 addon is not loaded');
    });
    return;
  }

  const who = payer();
  const payee = payer();
  let dir;
  let store;
  const coins = [];
  const spent = new Set();
  const opts = () => ({
    height: store.tip().height + 1,
    noteAtAnchor: (a) => store.anchorNote(a),
    blocks: store.blocks,
  });
  let firstSpend = null;
  let received = null;

  /** Every unspent coin of `who` inside the anchor row, with its index. */
  function liveCoins() {
    const height = store.tip().height + 1;
    const anchor = walletAnchor(height);
    const live = store.anchorNote(anchor);
    assert.ok(live && live.n >= 1, `anchor ${anchor}`);
    const at = new Map();
    for (let i = 0; i < live.n; i += 1) at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
    const out = [];
    for (const c of coins) {
      const key = c.commit.toString('hex');
      if (spent.has(key) || !at.has(key)) continue;
      out.push({ ...c, index: at.get(key) });
    }
    return { anchor, live, coins: out, height };
  }

  async function sendAndSeal(built, label) {
    const { tx } = built;
    const o = opts();
    const beforeMem = flowProofVerifyCount();
    const parked = admitMempool(emptyMempool(), tx, o);
    assert.equal(parked.ok, true, `${label} mempool ${parked.reason}`);
    assert.ok(flowProofVerifyCount() > beforeMem, `${label} mempool skipped the FS-1 verify`);
    resetFlowProofVerifies();
    resetFs1Tree();
    const verdict = await Promise.resolve(blockVerdict(store, who.dest, tx));
    assert.equal(verdict.ok, true, `${label} verify ${verdict.reason}`);
    assert.ok(flowProofVerifyCount() > 0, `${label} block skipped the FS-1 verify`);
    const queued = store.queueTx(tx);
    assert.equal(queued.ok, true, `${label} queue ${queued.reason}`);
    const tpl = await mine(store, who.dest);
    assert.ok(tpl.txs.some((row) => row.id === tx.id), `${label} was not templated`);
    const sealed = store.blocks[store.blocks.length - 1].txs.find((row) => row.id === tx.id);
    assert.ok(sealed, `${label} is not in the block`);
    const tags = store.fluxset().spendTags;
    for (const p of built.proven.proofs) {
      assert.equal(tags.has(Buffer.from(p.spendTag).toString('hex')), true, `${label} tag not spent`);
    }
    return sealed;
  }

  before(async () => {
    try { fs.unlinkSync(TIMINGS); } catch { /* first run */ }
    resetFs1Tree();
    resetFlowProofVerifies();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fs1-spend-'));
    store = createStore(dir);
    const t0 = Date.now();
    for (let i = 0; i < 34; i += 1) {
      const tpl = await mine(store, who.dest);
      const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
      assert.ok(pot && pot.r, 'template pot opening');
      coins.push({
        r: Buffer.from(asU8(pot.r)),
        v: openedCoinbaseNanos(pot),
        commit: Buffer.from(asU8(pot.commit)),
        x: admitScalarFromSeed(who.spendSeed, pot),
      });
    }
    record({ phase: 'grow', blocks: store.tip().height, ms: Date.now() - t0 });
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const k of PROOF_SEQUENCE) {
    it(`sends with ${k} input${k > 1 ? 's' : ''} and the payee receives`, async () => {
      const view = liveCoins();
      assert.ok(view.coins.length >= k, `only ${view.coins.length} live coins for ${k}`);
      const use = view.coins.slice(0, k);
      const pay20 = hash20FromAddress(payee.dest);
      const change20 = hash20FromAddress(who.dest);
      let payNote = null;
      let payNanos = 0;
      const built = buildSend({
        id: `fs1-send-${k}`,
        coins: use,
        anchor: view.anchor,
        live: view.live,
        outsOf: (room) => {
          const pay = Math.max(1, Math.floor(room / 3));
          payNanos = pay;
          payNote = hiddenOut(pay, pay20, payee.base, 'send');
          return [
            payNote,
            hiddenOut(room - pay, change20, who.base, 'send'),
            hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
          ];
        },
      });
      const { tx } = built;
      const root = fs1RootAt(view.live);
      const recs = Buffer.concat(built.proven.proofs.map((p) => p.blob));
      const reps = 3;
      let verifyMs = Infinity;
      for (let i = 0; i < reps; i += 1) {
        const t0 = process.hrtime.bigint();
        const ok = fs1Verify({ fs1: tx.fs1, records: recs, root, digest: built.proven.digest, anchor: view.anchor });
        verifyMs = Math.min(verifyMs, Number(process.hrtime.bigint() - t0) / 1e6);
        assert.equal(ok, true, 'native verify');
      }
      record({
        phase: 'spend',
        inputs: k,
        leaves: view.live.n,
        proveMs: Math.round(built.proveMs),
        verifyMs: Math.round(verifyMs * 10) / 10,
        fs1Bytes: tx.fs1.length,
        recordBytes: recs.length,
        weight: txVerifyWeight(tx),
        fee: built.fee,
      });
      await sendAndSeal(built, `send-${k}`);
      for (const c of use) spent.add(c.commit.toString('hex'));
      if (!firstSpend) firstSpend = { use, built };
      const sealedPay = store.blocks[store.blocks.length - 1].txs.find((row) => row.id === tx.id).vout[0];
      const pub = Buffer.from(asU8(sealedPay.admitPub));
      const set = store.fluxset();
      assert.ok(set.pubs.some((p) => Buffer.from(asU8(p.toBytes ? p.toBytes() : p)).equals(pub)), 'payee note joined the admit set');
      const opened = openNoteAmount(sealedPay, admitBaseScalar(payee.spendSeed));
      assert.ok(opened, 'payee opens the received note');
      assert.equal(Number(opened.v), payNanos, 'payee reads the amount');
      assert.ok(Buffer.from(asU8(opened.r)).equals(Buffer.from(asU8(payNote.r))), 'payee unwraps the blind');
      assert.equal(openNoteAmount(sealedPay, admitBaseScalar(who.spendSeed)), null, 'the payer cannot open it');
      if (!received) {
        received = {
          r: Buffer.from(asU8(opened.r)),
          v: Number(opened.v),
          commit: Buffer.from(asU8(sealedPay.commit)),
          x: admitScalarFromSeed(payee.spendSeed, sealedPay),
        };
      }
    });
  }

  it('the payee spends the received note', async () => {
    assert.ok(received && Number.isSafeInteger(received.v) && received.v > 0, 'received opening');
    for (let i = 0; i < 17; i += 1) await mine(store, who.dest);
    const view = liveCoins();
    let index = -1;
    for (let i = 0; i < view.live.n; i += 1) {
      if (Buffer.from(asU8(view.live.commits[i])).equals(received.commit)) index = i;
    }
    assert.ok(index >= 0, 'received note is inside the anchor');
    const back20 = hash20FromAddress(who.dest);
    const built = buildSend({
      id: 'fs1-receive-spend',
      coins: [{ ...received, index }],
      anchor: view.anchor,
      live: view.live,
      outsOf: (room) => [
        hiddenOut(room, back20, who.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    });
    await sendAndSeal(built, 'receive-spend');
  });

  it('rejects a second spend of a spent note', async () => {
    assert.ok(firstSpend, 'first spend');
    const view = liveCoins();
    const c = firstSpend.use[0];
    let index = -1;
    for (let i = 0; i < view.live.n; i += 1) {
      if (Buffer.from(asU8(view.live.commits[i])).equals(c.commit)) index = i;
    }
    assert.ok(index >= 0);
    const back20 = hash20FromAddress(who.dest);
    const built = buildSend({
      id: 'fs1-double',
      coins: [{ ...c, index }],
      anchor: view.anchor,
      live: view.live,
      outsOf: (room) => [
        hiddenOut(room, back20, who.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    });
    assert.ok(
      Buffer.from(built.proven.proofs[0].spendTag).equals(Buffer.from(firstSpend.built.proven.proofs[0].spendTag)),
      'the same note gives the same tag',
    );
    const queued = store.queueTx(built.tx);
    assert.equal(queued.ok, false);
    assert.equal(queued.reason, 'admit_link_tag');
    const verdict = await Promise.resolve(blockVerdict(store, who.dest, built.tx));
    assert.equal(verdict.ok, false);

    const fresh = liveCoins().coins[0];
    const twice = buildSend({
      id: 'fs1-twice',
      coins: [fresh],
      anchor: view.anchor,
      live: view.live,
      outsOf: (room) => [
        hiddenOut(room, back20, who.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    });
    const again = buildSend({
      id: 'fs1-twice-b',
      coins: [fresh],
      anchor: view.anchor,
      live: view.live,
      outsOf: (room) => [
        hiddenOut(room, back20, who.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    });
    assert.equal(store.queueTx(twice.tx).ok, true, 'first of two');
    const second = store.queueTx(again.tx);
    assert.equal(second.ok, false, 'a mempool double spend');
  });

  it('rejects a send with a non-leaf output, and a non-leaf cannot enter the tree', async () => {
    const view = liveCoins();
    const fresh = view.coins.find((c) => !spent.has(c.commit.toString('hex')) && c.index !== undefined);
    assert.ok(fresh);
    const back20 = hash20FromAddress(who.dest);
    const built = buildSend({
      id: 'fs1-nonleaf',
      coins: [view.coins[view.coins.length - 1]],
      anchor: view.anchor,
      live: view.live,
      outsOf: (room) => {
        const good = hiddenOut(room, back20, who.base, 'send');
        return [{ ...good, admitPub: Buffer.alloc(32, 0xff) }, hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy')];
      },
    });
    const o = opts();
    assert.equal(admitMempool(emptyMempool(), built.tx, o).reason, 'admit_note_point');
    assert.equal(store.queueTx(built.tx).reason, 'admit_note_point');
    const verdict = await Promise.resolve(blockVerdict(store, who.dest, built.tx));
    assert.equal(verdict.ok, false);

    const h = fs1TreeNew();
    const bad = Buffer.alloc(64, 0xff);
    assert.equal(fs1TreeAppend(h, bad), false, 'tree refuses a non-leaf');
  });
});

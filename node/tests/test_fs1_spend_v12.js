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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRegtestStore } from './regtest_store.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { DATADIR_CLAIM_NAME, DATADIR_LOCK_NAME } from '../src/datadir_lock.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { buildTemplate, digestTx, txCoreDigest, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { emptyMempool, admitMempool, heldBodyKey, txBodyKey } from '../../crypto/mempool.js';
import { createP2p, fingerprintHelloHash, jsonWire } from '../src/p2p.js';
import { newIdentity, encodeDest, hash20FromAddress } from '../../crypto/address.js';
import { admitWireTx, compactTx } from '../../crypto/chronoflux.js';
import { admitBaseScalar, admitScalarFromSeed } from '../../crypto/admit.js';
import {
  asU8,
  openedCoinbaseNanos,
  openNoteAmount,
  reviveTx,
} from '../../crypto/note.js';
import { walletAnchor, flowProofVerifyCount, resetFlowProofVerifies } from '../../crypto/admit_v3.js';
import {
  fs1RootAt,
  resetFs1Tree,
  resetFs1VerifyCache,
} from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded, fs1TreeAppend, fs1TreeNew, fs1Verify } from '../../crypto/native_admit.js';
import { txVerifyWeight } from '../../crypto/block_budget.js';
import { buildSend, hiddenOut } from './fs1_send_kit.js';
import { everyFieldBound, stripFieldsIn } from './body_bound.js';
import { droppedBlockReads } from './compact_reads.js';
import { canonicalEncode } from '../../crypto/canonical_row.js';
import { memoSeal, memoEnvelopeRejected } from '../../crypto/flow_sheet.js';

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

function lastStamp(store) {
  const tip = store.tip();
  return tip ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) : T0;
}

// Regtest work (bits 4, about 16 hashes). Every block is stored under its
// own ShearHash and appended with no trusted hash. The regtest bits exist
// only once createRegtestStore has sealed them, so they are read per block.
const MAX_TRIES = 8_192;
const regtestBits = () => regtestBitsOverride(MAGIC_REGTEST);

async function sealHeader(header, bits) {
  const found = await mineHeaderParallel(header, bits, MAX_TRIES, 1);
  assert.ok(found && found.block, 'regtest pow');
  return found.header;
}

async function mine(store, dest) {
  const now = Math.max(T0, lastStamp(store) + 90_000);
  const bits = regtestBits();
  const { tpl } = store.template({ miner: dest, bits, shareBits: 4, now });
  assert.equal(tpl.bits, bits, 'template seals the regtest bits');
  const header = await sealHeader(tpl.header, tpl.bits);
  const got = await Promise.resolve(store.append({
    header,
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
  }));
  assert.equal(got.ok, true, `append ${got.reason || ''}`);
  return tpl;
}

async function blockVerdict(store, dest, tx) {
  const tip = store.tip();
  const preview = store.template({ miner: dest, bits: regtestBits(), shareBits: 4, now: lastStamp(store) + 90_000 });
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
  const header = await sealHeader(built.header, built.bits);
  return verifyBlock({
    header,
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
    noteAtAnchor: (anchor) => store.anchorNote(anchor),
    evmHistory: store.blocks,
    genesisMs,
    magic: store.magic,
    ...(parentSupply ? { parentSupply } : {}),
  });
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
  // The book's magic, as queueTx and block verify use it.
  const opts = () => ({
    magic: store.magic,
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
    // Mempool admit cached this proof's verify. Drop the cache, not just the
    // tree, so block verify has to run the native FS-1 check itself.
    resetFs1VerifyCache();
    resetFs1Tree();
    const verdict = await Promise.resolve(blockVerdict(store, who.dest, tx));
    assert.equal(verdict.ok, true, `${label} verify ${verdict.reason}`);
    assert.ok(flowProofVerifyCount() > 0, `${label} block skipped the FS-1 verify`);
    const queued = store.queueTx(tx);
    assert.equal(queued.ok, true, `${label} queue ${queued.reason}`);
    const heldRow = store.mempool.find((row) => String(row.id) === String(tx.id));
    const key = heldBodyKey(heldRow);
    assert.equal(txBodyKey(tx), key, `${label}: the arrival and its held row are one body`);
    assert.equal(txBodyKey(reviveTx(heldRow)), key, `${label}: a re-read row is the same body`);
    // structuredClone turns each Buffer into a bare Uint8Array: the same bytes.
    assert.equal(txBodyKey(structuredClone(tx)), key, `${label}: a cloned body is the same body`);
    const tpl = await mine(store, who.dest);
    assert.ok(tpl.txs.some((row) => row.id === tx.id), `${label} was not templated`);
    const sealed = store.blocks[store.blocks.length - 1].txs.find((row) => row.id === tx.id);
    assert.ok(sealed, `${label} is not in the block`);
    assert.equal(txBodyKey(sealed), key, `${label}: the block's copy is the held body`);
    // Every byte of the compact body is in the leaf, and the block carries
    // no strip-list field, for the send and for the coinbase that seals it.
    const coinbase = store.blocks[store.blocks.length - 1].txs[0];
    for (const [name, row] of [[label, tx], [`${label} coinbase`, coinbase]]) {
      const bound = everyFieldBound(row, name);
      assert.ok(bound.checked.length >= 5, `${name}: ${bound.checked.length} fields`);
      assert.deepEqual(stripFieldsIn(compactTx(row)), [], `${name}: strip-list fields`);
    }
    assert.equal(digestTx(sealed).equals(digestTx(tx)), true, `${label}: the stored copy is the validated leaf`);
    // A relayer's copy with fields compaction drops is the same body: one
    // compact form, so one leaf and one verdict (store.js validates compact).
    const relayed = {
      ...tx,
      junk: 'relayer bytes',
      spendPub: Buffer.alloc(32, 7),
      vout: tx.vout.map((o, i) => (i === 0 ? { ...o, address: who.dest } : o)),
    };
    assert.equal(canonicalEncode(compactTx(relayed)), canonicalEncode(compactTx(tx)), `${label}: dropped fields leave one compact body`);
    assert.equal(digestTx(relayed).equals(digestTx(tx)), true, `${label}: and one leaf`);
    assert.equal(store.mempool.some((row) => heldBodyKey(row) === key), false, `${label} left the mempool`);
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
    store = createRegtestStore(dir, { bits: 4 });
    assert.equal(store.magic, MAGIC_REGTEST);
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
    closeMineWorkers();
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

  it('a tx id decides nothing in a block: an earlier tx labelled with a later tx\'s digest changes no verdict', async () => {
    const view = liveCoins();
    assert.ok(view.coins.length >= 2, `only ${view.coins.length} live coins`);
    const back20 = hash20FromAddress(who.dest);
    const one = (c, id) => buildSend({
      id,
      coins: [c],
      anchor: view.anchor,
      live: view.live,
      outsOf: (room) => [
        hiddenOut(room, back20, who.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    }).tx;
    const a = one(view.coins[0], 'label-a');
    const b = one(view.coins[1], 'label-b');
    const tip = store.tip();
    const preview = store.template({ miner: who.dest, bits: regtestBits(), shareBits: 4, now: lastStamp(store) + 90_000 });
    const built = buildTemplate({
      prev: tip.hash,
      prevHeader: tip.header,
      prevBlock: tip,
      height: tip.height + 1,
      miner: who.dest,
      bits: preview.tpl.bits,
      now: Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp),
      txs: [a, b],
      parentBlocks: store.blocks,
    });
    const user = built.txs.slice(1);
    assert.deepEqual(user.map((row) => row.id), ['label-a', 'label-b'], 'both sends in the block, a first');
    const header = await sealHeader(built.header, built.bits);
    const genesisMs = Number(decodeHeader(Buffer.from(store.blocks[0].header)).timestamp) || 0;
    const blockOf = (txs) => ({
      header,
      height: built.height,
      txs,
      samples: built.samples,
      shareBatch: built.shareBatch || [],
      miner: who.dest,
      aLeaves: built.aLeaves,
      bLeaves: built.bLeaves,
      rootA: built.rootA,
      rootB: built.rootB,
      weight: built.weight,
    });
    const verdictOf = async (txs) => {
      resetFs1VerifyCache();
      resetFs1Tree();
      return Promise.resolve(verifyBlock(blockOf(txs), tip, {
        noteAtAnchor: (anchor) => store.anchorNote(anchor),
        evmHistory: store.blocks,
        genesisMs,
        magic: store.magic,
        parentSupply: store.supplyState(),
      }));
    };
    const plain = await verdictOf(built.txs);
    assert.equal(plain.ok, true, `plain labels ${plain.reason}`);
    // The earlier send names the later send's leaf digest, the later one the
    // earlier's: the labels a sender-picked id match would resolve.
    const [ra, rb] = user.map((row) => digestTx(row).toString('hex'));
    const crossed = [built.txs[0], { ...user[0], id: rb }, { ...user[1], id: ra }];
    // The id is a label no signature covers, so it is not in the leaf
    // (Russell 26 Oct): relabelled, each send keeps its leaf, and the block
    // under the old header is the same block, with the same verdict.
    const crossedLeaves = crossed.slice(1).map((row) => digestTx(row).toString('hex'));
    assert.equal(crossedLeaves[0], ra, 'a label is not in its leaf');
    assert.equal(crossedLeaves[1], rb, 'a label is not in its leaf');
    const underOld = await verdictOf(crossed);
    assert.equal(underOld.ok, true, `a relabelled body under the old header ${underOld.reason}`);
    // Sealed under its own header, the crossed block decides as the plain
    // block does, and both spends land: no label decides a verdict.
    const rebuilt = buildTemplate({
      prev: tip.hash,
      prevHeader: tip.header,
      prevBlock: tip,
      height: tip.height + 1,
      miner: who.dest,
      bits: preview.tpl.bits,
      now: Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp),
      txs: [{ ...a, id: rb }, { ...b, id: ra }],
      parentBlocks: store.blocks,
    });
    assert.deepEqual(rebuilt.txs.slice(1).map((row) => row.id), [rb, ra], 'both relabelled sends in the block');
    const crossedHeader = await sealHeader(rebuilt.header, rebuilt.bits);
    const crossedBlock = {
      header: crossedHeader,
      height: rebuilt.height,
      txs: rebuilt.txs,
      samples: rebuilt.samples,
      shareBatch: rebuilt.shareBatch || [],
      miner: who.dest,
      aLeaves: rebuilt.aLeaves,
      bLeaves: rebuilt.bLeaves,
      rootA: rebuilt.rootA,
      rootB: rebuilt.rootB,
      weight: rebuilt.weight,
    };
    resetFs1VerifyCache();
    resetFs1Tree();
    const relabelled = await Promise.resolve(verifyBlock(crossedBlock, tip, {
      noteAtAnchor: (anchor) => store.anchorNote(anchor),
      evmHistory: store.blocks,
      genesisMs,
      magic: store.magic,
      parentSupply: store.supplyState(),
    }));
    assert.equal(relabelled.ok, plain.ok, `crossed labels ${relabelled.reason}`);
    resetFs1VerifyCache();
    resetFs1Tree();
    const got = await Promise.resolve(store.append(crossedBlock));
    assert.equal(got.ok, true, `append ${got.reason || ''}`);
    const sealed = store.blocks[store.blocks.length - 1].txs.slice(1);
    assert.deepEqual(sealed.map((row) => String(row.id)), [rb, ra], 'the block holds the relabelled sends');
    const tags = store.fluxset().spendTags;
    for (const row of [a, b]) {
      for (const p of row.admit_proofs) assert.equal(tags.has(Buffer.from(asU8(p.spendTag)).toString('hex')), true, 'spend joined the chain');
    }
    spent.add(view.coins[0].commit.toString('hex'));
    spent.add(view.coins[1].commit.toString('hex'));
  });

  describe('a held body is known by its bytes, not the id its sender picks', () => {
    const LABEL = 'shared-label';
    const back20 = () => hash20FromAddress(who.dest);
    const sendOf = (view, c, id) => buildSend({
      id,
      coins: [c],
      anchor: view.anchor,
      live: view.live,
      outsOf: (room) => [
        hiddenOut(room, back20(), who.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    }).tx;
    const held = (tx) => store.mempool.some((m) => heldBodyKey(m) === txBodyKey(tx));
    let a = null;
    let b = null;

    it('two bodies under one id are each judged and held; one body under two ids is one', () => {
      const view = liveCoins();
      assert.ok(view.coins.length >= 5, `only ${view.coins.length} live coins`);
      a = sendOf(view, view.coins[0], LABEL);
      b = sendOf(view, view.coins[1], LABEL);
      // Queued now, so later tests do not spend these notes again.
      spent.add(view.coins[0].commit.toString('hex'));
      spent.add(view.coins[1].commit.toString('hex'));
      // The cost of a key on a real send: what each arrival pays once, and
      // what a full pool's first walk pays per held row (heldBodyKey keeps it).
      const reps = 200;
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < reps; i += 1) txBodyKey(a);
      record({ phase: 'body-key', bytes: JSON.stringify(compactTx(a)).length, usPerKey: Math.round(Number(process.hrtime.bigint() - t0) / 1e3 / reps) });
      const before = store.mempool.length;
      const qa = store.queueTx(a);
      assert.equal(qa.ok, true, `a ${qa.reason}`);
      const qb = store.queueTx(b);
      assert.equal(qb.ok, true, `another body under a's id is judged on its own: ${qb.reason}`);
      assert.equal(qb.duplicate, undefined);
      assert.equal(store.mempool.filter((m) => String(m.id) === LABEL).length, 2, 'both bodies held');
      const relabelled = store.queueTx({ ...a, id: 'another-label' });
      assert.equal(relabelled.ok, true, relabelled.reason);
      assert.equal(relabelled.duplicate, true, 'the same body under a second id is the held tx');
      assert.equal(store.mempool.length, before + 2);
      // A changed body spending a's note under a's id is its sender changing a
      // queued tx: refused. Under a fresh id it is a double spend of a held note.
      const respend = sendOf(view, view.coins[0], LABEL);
      assert.notEqual(txBodyKey(respend), txBodyKey(a), 'a new proof is a new body');
      const reused = store.queueTx(respend);
      assert.equal(reused.ok, false);
      assert.equal(reused.reason, 'id_reused');
      const twice = store.queueTx({ ...respend, id: 'fresh-label' });
      assert.equal(twice.ok, false);
      assert.equal(twice.reason, 'admit_link_tag');
      assert.equal(store.mempool.length, before + 2);
    });

    it('a block sealing another body under a held id evicts neither held body', async () => {
      assert.ok(a && b && held(a) && held(b), 'a and b held');
      const view = liveCoins();
      const c = sendOf(view, view.coins[0], LABEL);
      spent.add(view.coins[0].commit.toString('hex'));
      const tip = store.tip();
      const preview = store.template({ miner: who.dest, bits: regtestBits(), shareBits: 4, now: lastStamp(store) + 90_000 });
      const built = buildTemplate({
        prev: tip.hash,
        prevHeader: tip.header,
        prevBlock: tip,
        height: tip.height + 1,
        miner: who.dest,
        bits: preview.tpl.bits,
        now: Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp),
        txs: [c],
        parentBlocks: store.blocks,
      });
      assert.deepEqual(built.txs.slice(1).map((row) => row.id), [LABEL], 'the block carries only c, under the held id');
      const header = await sealHeader(built.header, built.bits);
      resetFs1VerifyCache();
      resetFs1Tree();
      const got = await Promise.resolve(store.append({
        header,
        height: built.height,
        txs: built.txs,
        samples: built.samples,
        shareBatch: built.shareBatch || [],
        miner: who.dest,
        aLeaves: built.aLeaves,
        bLeaves: built.bLeaves,
        rootA: built.rootA,
        rootB: built.rootB,
        weight: built.weight,
      }));
      assert.equal(got.ok, true, `append ${got.reason || ''}`);
      assert.equal(held(a), true, 'a sealed id does not evict a');
      assert.equal(held(b), true, 'nor b');
      assert.equal(held(c), false);
    });

    it('a gossiped body under a held label is not suppressed, and a relabelled copy is held once', async () => {
      const view = liveCoins();
      const e = sendOf(view, view.coins[0], 'gossip-label');
      const f = sendOf(view, view.coins[1], 'gossip-label');
      spent.add(view.coins[0].commit.toString('hex'));
      spent.add(view.coins[1].commit.toString('hex'));
      const mesh = createP2p({ store, port: 0, host: '127.0.0.1', magic: store.magic, helloMs: 5000, idleMs: 60_000 });
      const bound = await mesh.listen();
      const sock = net.connect(bound.port, '127.0.0.1');
      sock.on('data', () => {});
      sock.on('error', () => {});
      try {
        await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
        sock.write(`${JSON.stringify({ type: 'hello', magic: store.magic, fingerprint: fingerprintHelloHash(store.magic) })}\n`);
        await delay(60);
        const send = (tx) => sock.write(`${jsonWire({ type: 'tx', magic: store.magic, tx: admitWireTx(tx), stem: false })}\n`);
        const before = store.mempool.length;
        send(e);
        for (let i = 0; i < 400 && !held(e); i += 1) await delay(25);
        assert.equal(held(e), true, 'e queued from gossip');
        // f is another body under e's label: the old dedupe dropped it unseen.
        send(f);
        for (let i = 0; i < 400 && !held(f); i += 1) await delay(25);
        assert.equal(held(f), true, 'f is not hidden behind e\'s label');
        // e again under a new label is the body already held.
        send({ ...e, id: 'gossip-relabel' });
        await delay(300);
        assert.equal(store.mempool.length, before + 2);
        assert.equal(store.mempool.some((m) => String(m.id) === 'gossip-relabel'), false);
      } finally {
        sock.destroy();
        mesh.close();
      }
    });
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
    // Held, so its note is taken: later tests pick other coins.
    spent.add(fresh.commit.toString('hex'));
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

  it('block validation reads no field compaction drops: a send with a memo, walked', async () => {
    const view = liveCoins();
    assert.ok(view.coins.length >= 1, `only ${view.coins.length} live coins`);
    const memoCt = memoSeal(who.dest, 'walk the reads', Buffer.alloc(32, 9));
    const built = buildSend({
      id: 'walked-memo',
      coins: [view.coins[0]],
      anchor: view.anchor,
      live: view.live,
      outsOf: (room) => [
        { ...hiddenOut(room, hash20FromAddress(who.dest), who.base, 'send'), memoCt },
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    });
    assert.equal(memoEnvelopeRejected(compactTx(built.tx).vout[0].memoCt), null, 'the memo envelope survives compaction');
    resetFs1Tree();
    resetFs1VerifyCache();
    const walked = await droppedBlockReads({
      store,
      miner: who.dest,
      fullTx: built.tx,
      sealHeader,
      bits: regtestBits(),
      now: lastStamp(store) + 90_000,
    });
    assert.equal(walked.verdict.ok, true, `walked block ${walked.verdict.reason} (plain ${JSON.stringify(walked.plain)})`);
    assert.deepEqual(walked.misses, [], `no validator read lands on a field compaction drops (${JSON.stringify(walked.readers)})`);
    const bound = everyFieldBound(built.tx, 'walked-memo');
    assert.ok(bound.checked.some((p) => p.startsWith('vout[].memoCt')), 'the memo envelope is in the leaf');
  });

  it('a peer failure mark does not outlive a valid body for that hash', async () => {
    const mesh = createP2p({ store, port: 0, host: '127.0.0.1', magic: store.magic, helloMs: 5000, idleMs: 60_000 });
    try {
      // A peer once served a bad body under the tip's hash, and one under a
      // hash this chain does not hold. The store now holds a valid body for
      // the first: the next accepted block clears that mark, not the other.
      const held = Buffer.from(store.tip().hash).toString('hex');
      const unknown = 'ab'.repeat(32);
      const rec = { id: 999, failed: new Set([held, unknown]), softFailed: new Map([[held, { at: Date.now(), reason: 'merkle' }]]) };
      mesh.peers.set({ planted: true }, rec);
      await mine(store, who.dest);
      assert.equal(rec.failed.has(held), false, 'the hard mark for a stored hash is gone');
      assert.equal(rec.softFailed.has(held), false, 'the soft mark for a stored hash is gone');
      assert.equal(rec.failed.has(unknown), true, 'a mark for a hash the chain lacks stays');
    } finally {
      await Promise.resolve(mesh.close());
    }
  });

  it('a remainder commitment or its opening is remainder_lock on the queue and in a block', async () => {
    const view = liveCoins();
    assert.ok(view.coins.length >= 1, `only ${view.coins.length} live coins`);
    const built = buildSend({
      id: 'remainder-probe',
      coins: [view.coins[0]],
      anchor: view.anchor,
      live: view.live,
      outsOf: (room) => [
        hiddenOut(room, hash20FromAddress(who.dest), who.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    });
    const remainCommit = Buffer.alloc(32, 0x31).toString('hex');
    const withCommit = { ...built.tx, remainCommit };
    const withProof = { ...built.tx, remainProof: { R: 'ab'.repeat(32), z: 'cd'.repeat(32) } };
    for (const [label, tx] of [['remainCommit', withCommit], ['remainProof', withProof]]) {
      const queued = store.queueTx(tx);
      assert.equal(queued.ok, false, `${label} queued`);
      assert.equal(queued.reason, 'remainder_lock', `${label} on the queue`);
      const parked = admitMempool(emptyMempool(), tx, opts());
      assert.equal(parked.reason, 'remainder_lock', `${label} in the mempool`);
      const verdict = await Promise.resolve(blockVerdict(store, who.dest, tx));
      assert.equal(verdict.ok, false, `${label} in a block`);
      assert.equal(verdict.reason, 'remainder_lock', `${label} in a block`);
    }
    // A block the store is handed with a remainCommit body is refused by
    // name and the chain does not move. (remainProof is not consensus bytes:
    // compaction drops it before validation, so it never reaches a block.)
    const tip = store.tip();
    const preview = store.template({ miner: who.dest, bits: regtestBits(), shareBits: 4, now: lastStamp(store) + 90_000 });
    const tpl = buildTemplate({
      prev: tip.hash,
      prevHeader: tip.header,
      prevBlock: tip,
      height: tip.height + 1,
      miner: who.dest,
      bits: preview.tpl.bits,
      now: Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp),
      txs: [built.tx],
      parentBlocks: store.blocks,
    });
    const txs = [tpl.txs[0], ...tpl.txs.slice(1).map((row) => ({ ...row, remainCommit }))];
    const header = encodeHeader({ ...decodeHeader(Buffer.from(tpl.header)), merkleRoot: merkleRoot(txs.map(digestTx)), nonce: 0n });
    const sealed = await sealHeader(header, tpl.bits);
    resetFs1Tree();
    resetFs1VerifyCache();
    const got = await Promise.resolve(store.append({
      header: sealed,
      height: tpl.height,
      txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: who.dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }));
    assert.equal(got.ok, false, 'a remainCommit block');
    assert.equal(got.reason, 'remainder_lock');
    assert.equal(Buffer.from(store.tip().hash).equals(Buffer.from(tip.hash)), true, 'the chain did not move');
  });

  it('a reorg keeps an unrelated held send and brings back the loser\'s send: an FS-1 vin names no outpoint', async () => {
    const view = liveCoins();
    assert.ok(view.coins.length >= 3, `only ${view.coins.length} live coins`);
    const back20 = hash20FromAddress(who.dest);
    const sendOf = (c, id) => buildSend({
      id,
      coins: [c],
      anchor: view.anchor,
      live: view.live,
      outsOf: (room) => [
        hiddenOut(room, back20, who.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    }).tx;
    const s1 = sendOf(view.coins[0], 'reorg-held');
    const t = sendOf(view.coins[1], 'reorg-loser');
    const w = sendOf(view.coins[2], 'reorg-winner');
    for (const c of view.coins.slice(0, 3)) spent.add(c.commit.toString('hex'));
    // The v1 leaf (the packed core alone) cannot tell these three spends of
    // three different notes apart; the body-v2 leaf can.
    const core = [s1, t, w].map((row) => txCoreDigest(row).toString('hex'));
    assert.equal(new Set(core).size, 1, 'one v1 leaf for three different FS-1 spends');
    const leaves = [s1, t, w].map((row) => digestTx(row).toString('hex'));
    assert.equal(new Set(leaves).size, 3, 'three body-v2 leaves');
    const held = (tx) => store.mempool.some((m) => heldBodyKey(m) === txBodyKey(tx));
    // A peer that shares the chain to here.
    const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fs1-peer-'));
    fs.cpSync(dir, peerDir, { recursive: true });
    fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(peerDir));
    // The copy carries our datadir lock: the peer takes its own.
    for (const f of [DATADIR_LOCK_NAME, DATADIR_CLAIM_NAME]) fs.rmSync(path.join(peerDir, f), { force: true });
    resetFs1Tree();
    resetFs1VerifyCache();
    const peer = createRegtestStore(peerDir, { bits: 4 });
    try {
      assert.equal(Buffer.from(peer.tip().hash).equals(Buffer.from(store.tip().hash)), true, 'peer at our tip');
      // Our branch: one block sealing t, with s1 held and not mined.
      const q1 = store.queueTx(s1);
      assert.equal(q1.ok, true, `s1 ${q1.reason}`);
      const tip = store.tip();
      const preview = store.template({ miner: who.dest, bits: regtestBits(), shareBits: 4, now: lastStamp(store) + 90_000 });
      const built = buildTemplate({
        prev: tip.hash,
        prevHeader: tip.header,
        prevBlock: tip,
        height: tip.height + 1,
        miner: who.dest,
        bits: preview.tpl.bits,
        now: Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp),
        txs: [t],
        parentBlocks: store.blocks,
      });
      const header = await sealHeader(built.header, built.bits);
      resetFs1Tree();
      resetFs1VerifyCache();
      const ours = await Promise.resolve(store.append({
        header,
        height: built.height,
        txs: built.txs,
        samples: built.samples,
        shareBatch: built.shareBatch || [],
        miner: who.dest,
        aLeaves: built.aLeaves,
        bLeaves: built.bLeaves,
        rootA: built.rootA,
        rootB: built.rootB,
        weight: built.weight,
      }));
      assert.equal(ours.ok, true, `ours ${ours.reason || ''}`);
      assert.equal(held(s1), true);
      assert.equal(held(t), false, 't is sealed on our branch');
      // The peer's branch: two blocks, the first sealing w, another FS-1 send.
      resetFs1Tree();
      resetFs1VerifyCache();
      const qw = peer.queueTx(w);
      assert.equal(qw.ok, true, `w on the peer ${qw.reason}`);
      const b1 = await mine(peer, who.dest);
      assert.ok(b1.txs.some((row) => row.id === 'reorg-winner'), 'w sealed on the peer');
      await mine(peer, who.dest);
      // Two real blocks at one height with different FS-1 spends now have
      // two hashes (under the v1 leaf they had one, and the node took the
      // peer's block for ours with no reorg).
      const ourTip = store.blocks[store.blocks.length - 1];
      const theirs = peer.blocks[ourTip.height - 1];
      assert.equal(Number(theirs.height), Number(ourTip.height), 'same height');
      assert.equal(Buffer.from(theirs.hash).equals(Buffer.from(ourTip.hash)), false, 'different spends, different block hashes');
      // Our header with the peer's body is refused, never taken as our block.
      const forgedTip = { ...theirs, header: ourTip.header, hash: ourTip.hash };
      const forged = store.ingest([forgedTip]);
      assert.equal(forged.ok, false, 'a known hash with another body');
      assert.equal(forged.reason, 'merkle');
      assert.equal(Buffer.from(store.tip().hash).equals(Buffer.from(ourTip.hash)), true, 'our block stands');
      // The known-hash prefix case: our own chain relayed back with block
      // `ourTip` carrying the peer's body, and an honest child on top so the
      // fork is heavier. The prefix matches ours hash for hash; its body is
      // still checked against the header, so the fork is refused.
      const childPreview = store.template({ miner: who.dest, bits: regtestBits(), shareBits: 4, now: lastStamp(store) + 90_000 });
      const childHeader = await sealHeader(childPreview.tpl.header, childPreview.tpl.bits);
      const child = {
        header: childHeader,
        height: childPreview.tpl.height,
        txs: childPreview.tpl.txs,
        samples: childPreview.tpl.samples,
        shareBatch: childPreview.tpl.shareBatch || [],
        miner: who.dest,
        aLeaves: childPreview.tpl.aLeaves,
        bLeaves: childPreview.tpl.bLeaves,
        rootA: childPreview.tpl.rootA,
        rootB: childPreview.tpl.rootB,
        weight: childPreview.tpl.weight,
      };
      const relayedChain = [...store.blocks.slice(0, -1), forgedTip, child];
      resetFs1Tree();
      resetFs1VerifyCache();
      const prefixed = await Promise.resolve(store.ingest(relayedChain));
      assert.equal(prefixed.ok, false, 'a known-hash prefix with another body');
      assert.equal(prefixed.reason, 'merkle');
      assert.equal(Buffer.from(store.tip().hash).equals(Buffer.from(ourTip.hash)), true, 'our tip stands');
      resetFs1Tree();
      resetFs1VerifyCache();
      const got = await Promise.resolve(store.ingest(peer.blocks));
      assert.equal(got.ok, true, `${got.reason || 'ingest'} at=${got.at}`);
      assert.equal(got.reorg, true, 'the heavier branch wins');
      assert.equal(Buffer.from(store.tip().hash).equals(Buffer.from(peer.tip().hash)), true);
      // w's FS-1 vin names no outpoint: it spends neither s1's note nor t's.
      assert.equal(held(s1), true, 'an unrelated held send stays');
      assert.equal(held(t), true, 'the loser\'s send comes back to the mempool');
      assert.equal(held(w), false, 'the winner\'s send is sealed');
    } finally {
      fs.rmSync(peerDir, { recursive: true, force: true });
    }
  });
});

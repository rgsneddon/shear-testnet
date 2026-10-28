/**
 * The mempool checks an FS-1 send under the book's own magic, as block
 * verify does. queueTx and template() used to build admitOpts without
 * magic, so verifyFlowAdmitFs1 fell back to MAGIC_TESTNET: off testnet a
 * valid send was refused by the mempool and dropped from templates, while a
 * block holding it verified.
 *
 * Regtest book, real proof of work (bits 4), every block under its own
 * ShearHash:
 * - a send proved under the regtest magic enters the mempool and a mined block;
 * - a send proved under the testnet magic is refused by the mempool and by
 *   block verify.
 * Mainnet magic, through the same admitMempool and FS-1 verify the store
 * uses: a send proved under mainnet is admitted with the mainnet magic and
 * refused under any other. A full mainnet book would need mainnet-difficulty
 * work for every funding block.
 */
import { after, before, describe, it } from 'node:test';
import { bluWallet, soloCoin, soloPay } from './support/blunote_mine.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, hash20FromAddress, newIdentity } from '../../crypto/address.js';
import { admitScalarFromSeed, attachAdmitPub } from '../../crypto/admit.js';
import { verifyFlowAdmitV3, walletAnchor } from '../../crypto/admit_v3.js';
import { MAGIC_MAINNET, MAGIC_TESTNET } from '../../crypto/asert.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { viewTagOf } from '../../crypto/dummy.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
  resetFs1Tree,
} from '../../crypto/fs1_spend.js';
import { decodeHeader } from '../../crypto/header.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import {
  asU8,
  kernelExcess,
  openedCoinbaseNanos,
  sealHiddenNote,
  sealNote,
} from '../../crypto/note.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { buildTemplate, GENESIS_PREV } from '../src/chain.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

const T0 = 1_700_000_000_000;
const STEP = 90_000;
// Four-bit regtest work is about 16 hashes.
const MAX_TRIES = 8_192;
const GROW = 20;
const CASE_MS = 600_000;

after(() => closeMineWorkers());

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { id, dest, spendSeed: id.spendSeed, base: id.admitBase, blu: bluWallet(id.spendSeed) };
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

function bodyOf(tpl, header, dest) {
  return {
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
  };
}

/** Mine the store's own template with real regtest work, then append it. */
async function mine(store, dest, extra = {}) {
  const want = regtestBitsOverride(MAGIC_REGTEST);
  const { tpl } = store.template({ miner: dest, bits: want, shareBits: 4, now: lastStamp(store) + STEP, ...extra });
  assert.equal(tpl.bits, want, 'template seals the regtest bits');
  const found = await mineHeaderParallel(tpl.header, tpl.bits, MAX_TRIES, 1);
  assert.ok(found && found.block, 'regtest pow');
  const got = await Promise.resolve(store.append(bodyOf(tpl, found.header, dest)));
  assert.equal(got.ok, true, `append ${got.reason || ''}`);
  return tpl;
}

/** A block that carries `tx` without the mempool, with real regtest work. */
async function mineWith(store, dest, tx) {
  const tip = store.tip();
  const want = regtestBitsOverride(MAGIC_REGTEST);
  const built = buildTemplate({
    prev: tip ? tip.hash : GENESIS_PREV,
    prevHeader: tip ? tip.header : undefined,
    prevBlock: tip || null,
    height: (tip?.height || 0) + 1,
    miner: dest,
    bits: want,
    now: lastStamp(store) + STEP,
    txs: [tx],
    parentBlocks: store.blocks,
  });
  assert.ok(built.txs.some((row) => row.id === tx.id), 'the block carries the send');
  const found = await mineHeaderParallel(built.header, built.bits, MAX_TRIES, 1);
  assert.ok(found && found.block, 'regtest pow');
  return Promise.resolve(store.append(bodyOf(built, found.header, dest)));
}

function rangeSlack(outs) {
  let bytes = 0;
  for (const o of outs) if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  return Math.ceil((bytes * 2) / 2048) + 8;
}

function placeholders() {
  const fs1 = Buffer.alloc(fs1BlobLen(1), 255);
  fs1[0] = FS1_WIRE;
  const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
  blob[0] = FS1_WIRE;
  const proofs = [{ admit_proof: true, v: 3, spendTag: Buffer.alloc(32, 255), blob, cTilde: Buffer.alloc(32, 255) }];
  return { fs1, proofs, vin: [{ commit: Buffer.alloc(32, 255) }] };
}

/** One-input FS-1 send of `coin`, proved under `magic`. */
function buildSend({ id, coin, anchor, live, magic, payee, change20, changeBase }) {
  const ph = placeholders();
  let fee = LEVY_FLOOR_UNITS;
  let outs = null;
  let draft = null;
  const pay20 = hash20FromAddress(payee.dest);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const room = coin.v - fee;
    assert.ok(room >= 1, 'fee consumes the coin');
    const pay = Math.max(1, Math.floor(room / 3));
    outs = [
      hiddenOut(pay, pay20, payee.base, 'send'),
      hiddenOut(room - pay, change20, changeBase, 'send'),
      hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
    ];
    draft = compactTx({
      id, kind: 'send', anchor, fee, vin: ph.vin, vout: outs, fs1: ph.fs1, admit_proofs: ph.proofs, excess: Buffer.alloc(32, 255),
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) break;
    fee = need + rangeSlack(outs);
    draft = null;
  }
  assert.ok(draft, 'fee did not settle');
  const proven = fs1ProveSpend({ live, anchor, indices: [coin.index], xs: [coin.x], tx: draft, magic });
  assert.ok(proven, `${id} prove`);
  const excess = kernelExcess(outs, [{ r: coin.r, t: proven.t[0] }]);
  assert.ok(excess, `${id} excess`);
  return compactTx({
    id,
    kind: 'send',
    anchor,
    fee: draft.fee,
    vin: proven.proofs.map((p) => ({ commit: Buffer.from(p.cTilde) })),
    vout: outs,
    fs1: proven.fs1,
    admit_proofs: proven.proofs,
    excess,
  });
}

describe('v12 mempool and block verify use the book magic for FS-1', { concurrency: false }, () => {
  if (!fs1NativeLoaded()) {
    it('needs the native FS-1 addon (crypto/native make all)', () => {
      assert.fail('shear_admit FS-1 addon is not loaded');
    });
    return;
  }

  const who = payer();
  const payee = payer();
  const coins = [];
  let dir;
  let store;

  function liveCoins() {
    const height = store.tip().height + 1;
    const anchor = walletAnchor(height);
    const live = store.anchorNote(anchor);
    assert.ok(live && live.n >= 1, `anchor ${anchor}`);
    const at = new Map();
    for (let i = 0; i < live.n; i += 1) at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
    const out = coins.filter((c) => at.has(c.commit.toString('hex')))
      .map((c) => ({ ...c, index: at.get(c.commit.toString('hex')) }));
    return { anchor, live, coins: out, height };
  }

  function send(id, coin, view, magic) {
    return buildSend({
      id,
      coin,
      anchor: view.anchor,
      live: view.live,
      magic,
      payee,
      change20: hash20FromAddress(who.dest),
      changeBase: who.base,
    });
  }

  before(async () => {
    resetFs1Tree();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-book-magic-'));
    store = createRegtestStore(dir, { bits: 4 });
    assert.equal(store.magic, MAGIC_REGTEST);
    // R28: who mines solo with option (b); each pot is a record coin of
    // who's wallet, found with its scan key.
    for (let i = 0; i < GROW; i += 1) {
      await mine(store, who.dest, soloPay(who.blu));
      const pot = soloCoin(who.blu, store.tip());
      assert.ok(pot && pot.r, 'record pot opening');
      coins.push({ r: pot.r, v: pot.v, commit: pot.commit, x: pot.x });
    }
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a regtest send enters the mempool and a mined block; a testnet-magic send is refused by both', { timeout: CASE_MS }, async () => {
    const view = liveCoins();
    assert.ok(view.coins.length >= 2, `only ${view.coins.length} live coins`);
    const good = send('magic-regtest', view.coins[0], view, MAGIC_REGTEST);
    const wrong = send('magic-testnet', view.coins[1], view, MAGIC_TESTNET);

    // Mempool. Before the fix the regtest send was refused here.
    const queued = store.queueTx(good);
    assert.equal(queued.ok, true, `regtest send queue ${queued.reason}`);
    const refused = store.queueTx(wrong);
    assert.equal(refused.ok, false, 'testnet-magic send must not queue');
    assert.equal(refused.reason, 'admit_membership');
    assert.equal(store.mempool.some((t) => String(t.id) === 'magic-testnet'), false);

    // Template and block. The template keeps the regtest send.
    const height = store.tip().height;
    const tpl = await mine(store, who.dest);
    assert.ok(tpl.txs.some((row) => row.id === 'magic-regtest'), 'template dropped the regtest send');
    assert.equal(store.tip().height, height + 1);
    const sealed = store.blocks[store.blocks.length - 1].txs.find((row) => row.id === 'magic-regtest');
    assert.ok(sealed, 'the regtest send is in the block');

    // A block that carries the testnet-magic send directly is refused.
    const tipHash = Buffer.from(store.tip().hash).toString('hex');
    const blocked = await mineWith(store, who.dest, wrong);
    assert.equal(blocked.ok, false, 'block with the testnet-magic send must not append');
    assert.equal(blocked.reason, 'admit_membership');
    assert.equal(Buffer.from(store.tip().hash).toString('hex'), tipHash, 'tip unchanged');
  });

  it('a mainnet-magic send passes the shared mempool and FS-1 verify only under mainnet', { timeout: CASE_MS }, () => {
    const view = liveCoins();
    assert.ok(view.coins.length >= 3, 'coins left');
    // The last coin is unspent: the first test spent only coin 0.
    const coin = view.coins[view.coins.length - 1];
    const tx = send('magic-mainnet', coin, view, MAGIC_MAINNET);
    const base = {
      height: store.tip().height + 1,
      blocks: store.blocks,
      noteAtAnchor: (a) => store.anchorNote(a),
    };
    const ok = admitMempool(emptyMempool(), tx, { ...base, magic: MAGIC_MAINNET });
    assert.equal(ok.ok, true, `mainnet magic ${ok.reason}`);
    for (const magic of [MAGIC_REGTEST, MAGIC_TESTNET, undefined]) {
      const got = admitMempool(emptyMempool(), tx, { ...base, magic });
      assert.equal(got.ok, false, `mempool under ${magic}`);
      assert.equal(got.reason, 'admit_membership', `mempool under ${magic}`);
    }
    const flow = verifyFlowAdmitV3(tx, { ...base, magic: MAGIC_MAINNET });
    assert.equal(flow.ok, true, `flow verify ${flow.reason}`);
    const off = verifyFlowAdmitV3(tx, { ...base, magic: MAGIC_REGTEST });
    assert.equal(off.ok, false);
    assert.equal(off.reason, 'admit_membership');
  });
});

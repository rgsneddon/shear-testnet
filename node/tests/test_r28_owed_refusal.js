// R28 (D2, Russell 28 Oct, "Code fix now"): the owed ledger and the hash-credit
// record are retired, and a block or coinbase that still carries one of their
// fields is refused as blunote_owed, on the rows as they arrived, before any
// compaction could strip the field.
//
// Before the fix a miner could seal a coinbase hashOwedRoot (digest-bound):
// append took the block and every later template on that tip threw hash_owed,
// so the honest network stalled. A relay could add hash-credit rows to an
// honest block (no digest binds them) and the peer stored and served them.
// A record-less block fell back to the retired ledger in the owed step and in
// the supply step, so a public audit read it through the old path.
//
// Every block here is real: regtest work (bits 4, about 16 ShearHash hashes),
// mined off the main thread; nothing passes a trusted hash.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import { packHashCreditBytes, packSpillCreditBytes, advanceHashOwed, replayHashOwed } from '../../crypto/hash_owed.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { nativeLoaded } from '../../crypto/native_admit.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { digestTx } from '../src/chain.js';
import { encodeWireBlock, decodeWireBlock, jsonWire } from '../src/p2p.js';
import { auditCirculatingSupply, emptySupplyState, supplyStep } from '../src/supply.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

try { setHashBackend('jit'); } catch { /* interpreter */ }
after(() => closeMineWorkers());

const T0 = 1_700_000_000_000;
const STEP = 90_000;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `r28-owed-${tag}-`));
}

function headerMs(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

/** One credit row, as the retired record wrote them. */
function creditRow(fill = 0x2c) {
  const dest20 = Buffer.alloc(20, fill);
  return { noteCommit: noteCommitOfDest20(dest20), dest20, nanos: 7n, sinceHeight: 1 };
}

/**
 * The next block on `store`'s tip, its coinbase changed by `seal` (the miner
 * seals the change: the merkle root is rebuilt and the header is mined).
 */
async function mineNext(store, dest, seal = null) {
  const tip = store.tip();
  const now = tip ? headerMs(tip) + STEP : T0;
  const bits = regtestBitsOverride(MAGIC_REGTEST);
  const { tpl } = store.template({ miner: dest, bits, now });
  assert.equal(tpl.bits, bits, 'regtest template bits');
  let txs = tpl.txs;
  let header = tpl.header;
  if (seal) {
    txs = [seal({ ...tpl.txs[0] }), ...tpl.txs.slice(1)];
    const d = decodeHeader(Buffer.from(tpl.header));
    header = encodeHeader({ ...d, merkleRoot: merkleRoot(txs.map(digestTx)) });
  }
  const found = await mineHeaderParallel(header, tpl.bits, 8_192, 1);
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    hash: found.hash,
    height: tpl.height,
    txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

async function appendHonest(store, dest) {
  const block = await mineNext(store, dest);
  const got = await Promise.resolve(store.append(block));
  assert.equal(got.ok, true, got.reason);
  return store.tip();
}

/** A wire copy of a stored block as a peer receives it, after `alter` edits the JSON. */
function relayed(block, alter = null) {
  const w = JSON.parse(jsonWire(encodeWireBlock(block)));
  if (alter) alter(w);
  return decodeWireBlock(JSON.parse(JSON.stringify(w)));
}

const RETIRED = new Set(['hashCredits', 'hashCreditPacked']);
const OWED_TX = ['hashOwed', 'hashOwedRest', 'hashOwedLocal', 'hashOwedRoot', 'hashCreditRoot', 'hashCredits',
  'hashDustNanos', 'hashOwedOverflowNanos', 'hashAcceptedUnits', 'hashBonusUnit'];

function carriesRetired(block) {
  for (const key of RETIRED) if (block && Object.prototype.hasOwnProperty.call(block, key)) return key;
  const cb = block?.txs?.[0];
  for (const key of OWED_TX) if (cb && Object.prototype.hasOwnProperty.call(cb, key)) return `txs[0].${key}`;
  return '';
}

describe('R28 refuses the retired owed ledger and hash-credit record', () => {
  it('a miner-sealed coinbase hashOwedRoot is refused, and the honest tip still templates (the stall)', async () => {
    const dir = tmp('stall');
    try {
      const store = createRegtestStore(dir, { bits: 4 });
      const dest = minerDest();
      const honest = await appendHonest(store, dest);
      const sealedRoot = await mineNext(store, dest, (cb) => ({ ...cb, hashOwedRoot: Buffer.alloc(32, 7) }));
      const got = await Promise.resolve(store.append(sealedRoot));
      let after = 'not reached';
      if (got.ok) {
        try { store.template({ miner: dest, bits: regtestBitsOverride(MAGIC_REGTEST), now: headerMs(sealedRoot) + STEP }); after = 'ok'; } catch (err) { after = `throws ${err.message}`; }
      }
      assert.equal(got.ok, false, `the sealed root was appended; the next template ${after}`);
      assert.equal(got.reason, 'blunote_owed');
      assert.equal(Buffer.from(store.tip().hash).toString('hex'), Buffer.from(honest.hash).toString('hex'), 'the tip did not move');
      assert.doesNotThrow(() => store.template({ miner: dest, bits: regtestBitsOverride(MAGIC_REGTEST), now: headerMs(honest) + STEP }));
      const next = await appendHonest(store, dest);
      assert.equal(Number(next.height), Number(honest.height) + 1, 'the honest chain extends');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every owed or hash-credit field a miner seals into the coinbase is blunote_owed', async () => {
    const dir = tmp('seal');
    try {
      const store = createRegtestStore(dir, { bits: 4 });
      const dest = minerDest();
      await appendHonest(store, dest);
      const row = creditRow();
      const seals = {
        hashOwedRoot: Buffer.alloc(32, 7),
        hashCreditRoot: Buffer.alloc(32, 7),
        hashOwed: [row],
        hashOwedRest: [row],
        hashOwedLocal: [row],
        hashCredits: [row],
        hashDustNanos: '5',
        hashOwedOverflowNanos: '5',
        hashAcceptedUnits: '0',
        hashBonusUnit: 1,
      };
      const seen = {};
      for (const [field, value] of Object.entries(seals)) {
        const tipBefore = Buffer.from(store.tip().hash).toString('hex');
        const block = await mineNext(store, dest, (cb) => ({ ...cb, [field]: value }));
        const got = await Promise.resolve(store.append(block));
        seen[field] = got.ok ? 'ACCEPTED' : got.reason;
        assert.equal(Buffer.from(store.tip().hash).toString('hex'), tipBefore, `${field}: the tip did not move`);
      }
      for (const field of Object.keys(seals)) assert.equal(seen[field], 'blunote_owed', `${field}: ${JSON.stringify(seen)}`);
      await appendHonest(store, dest);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a relay that adds or alters hash-credit rows on an honest block: the peer refuses that copy and accepts the honest one', async () => {
    const dirA = tmp('relay-a');
    const dirB = tmp('relay-b');
    try {
      const a = createRegtestStore(dirA, { bits: 4 });
      const dest = minerDest();
      const one = await appendHonest(a, dest);
      const two = await appendHonest(a, dest);
      let b = createRegtestStore(dirB, { bits: 4 });
      const first = await Promise.resolve(b.ingest([relayed(one)]));
      assert.equal(first.ok, true, first.reason);
      const credit = creditRow();
      const creditHex = packHashCreditBytes([{ ...credit, admitBase: null }]).toString('hex');
      const alterations = {
        'hashCreditPacked rows added': (w) => { w.hashCreditPacked = creditHex; },
        'an empty hashCreditPacked record added': (w) => { w.hashCreditPacked = packHashCreditBytes([]).toString('hex'); },
        'hashCredits rows added as JSON': (w) => {
          w.hashCredits = [{ noteCommit: credit.noteCommit.toString('hex'), dest20: credit.dest20.toString('hex'), nanos: '7' }];
        },
        'coinbase hashOwed rows added': (w) => {
          w.txs[0].hashOwed = [{ noteCommit: credit.noteCommit.toString('hex'), dest20: credit.dest20.toString('hex'), nanos: '7', sinceHeight: 1 }];
        },
        'coinbase hashOwedRoot added': (w) => { w.txs[0].hashOwedRoot = 'ab'.repeat(32); },
        'coinbase hashCreditRoot added': (w) => { w.txs[0].hashCreditRoot = 'ab'.repeat(32); },
        'spill credit rows added': (w) => { w.hashSpillCreditPacked = packSpillCreditBytes([{ ...credit, admitBase: null }]).toString('hex'); },
      };
      const want = (label) => (label.startsWith('spill') ? 'hash_spill' : 'blunote_owed');
      const seen = {};
      for (const [label, alter] of Object.entries(alterations)) {
        const got = await Promise.resolve(b.ingest([relayed(two, alter)]));
        seen[label] = got.ok ? 'ACCEPTED' : `${got.reason}${got.peerOnly ? ' peerOnly' : ''}`;
        assert.equal(Number(b.tip().height), Number(one.height), `${label}: the altered copy did not move the tip`);
      }
      for (const label of Object.keys(alterations)) {
        assert.equal(seen[label], `${want(label)} peerOnly`, `${label}: ${JSON.stringify(seen)}`);
      }
      // The honest copy of the same block, from another peer, is accepted.
      const honest = await Promise.resolve(b.ingest([relayed(two)]));
      assert.equal(honest.ok, true, honest.reason);
      assert.equal(Buffer.from(b.tip().hash).toString('hex'), Buffer.from(two.hash).toString('hex'));
      assert.equal(carriesRetired(b.tip()), '', 'the stored block carries no retired field');
      // An altered copy served again after the honest one changes nothing stored.
      const again = await Promise.resolve(b.ingest([relayed(two, alterations['hashCreditPacked rows added'])]));
      if (!again.ok) assert.equal(again.reason, 'blunote_owed');
      assert.equal(Buffer.from(b.tip().hash).toString('hex'), Buffer.from(two.hash).toString('hex'));
      assert.equal(carriesRetired(b.tip()), '');
      // The stored copy, served on, carries no hash-credit column.
      const served = JSON.parse(jsonWire(encodeWireBlock(b.tip())));
      assert.equal(Object.prototype.hasOwnProperty.call(served, 'hashCreditPacked'), false, 'the wire sends no credit column');
      // And a reload of the book reads none back (chain.bin and the compact row).
      b.flushBookSnap?.();
      b.close?.();
      b = createRegtestStore(dirB, { bits: 4 });
      assert.equal(Buffer.from(b.tip().hash).toString('hex'), Buffer.from(two.hash).toString('hex'));
      for (const block of b.blocks || []) assert.equal(carriesRetired(block), '', `reloaded height ${block.height}`);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('a record-less block is refused by the owed step and by the supply step', async () => {
    const dir = tmp('norecord');
    try {
      const store = createRegtestStore(dir, { bits: 4 });
      const dest = minerDest();
      const one = await appendHonest(store, dest);
      assert.ok(one.blunoteRecord, 'a stored block keeps its record');
      const bare = { ...one };
      delete bare.blunoteRecord;
      const stepped = advanceHashOwed({ owedIn: [], acceptedSeries: [], block: bare, height: 1, tipHeight: 1 });
      assert.equal(stepped.ok, false);
      assert.equal(stepped.reason, 'blunote_record');
      const replay = replayHashOwed([bare]);
      assert.equal(replay.ok, false);
      assert.equal(replay.reason, 'blunote_record');
      // Control: the same block with its record steps.
      assert.equal(advanceHashOwed({ owedIn: [], acceptedSeries: [], block: one, height: 1, tipHeight: 1 }).ok, true);
      const supplied = supplyStep(emptySupplyState(headerMs(one)), bare, { magic: MAGIC_REGTEST, height: 1 });
      assert.equal(supplied.ok, false);
      assert.equal(supplied.reason, 'blunote_record');
      const control = supplyStep(emptySupplyState(headerMs(one)), one, { magic: MAGIC_REGTEST, height: 1 });
      assert.equal(control.ok, true, control.reason);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the public supply audit of a record-less block is a named refusal, not a blank', async () => {
    assert.equal(nativeLoaded(), true, 'the audit needs the native addon on this host');
    const dir = tmp('audit');
    try {
      const store = createRegtestStore(dir, { bits: 4 });
      const dest = minerDest();
      const one = await appendHonest(store, dest);
      const two = await appendHonest(store, dest);
      const clean = auditCirculatingSupply([one, two], { magic: MAGIC_REGTEST });
      assert.equal(clean.status, 'verified', clean.reason);
      const bare = { ...two };
      delete bare.blunoteRecord;
      const got = auditCirculatingSupply([one, bare], { magic: MAGIC_REGTEST });
      assert.equal(got.status, 'mismatch');
      assert.equal(got.reason, 'blunote_record');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

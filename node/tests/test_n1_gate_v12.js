/**
 * N-1 runs after the cheap gates. A missing header or an over-cap tx does
 * not derive a leaf. A header that passes still rejects a bad note.
 * A sealed restart does not rescan. A bad coinbase payee is dropped.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bitsForBlock, consensusFingerprint, GENESIS_BITS_PACKED, MAGIC_TESTNET, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import { writeChainBin } from '../../crypto/chainbin.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { fs1LeafDeriveCount, fs1LeafFor, resetFs1LeafDerives } from '../../crypto/fs1_leaf.js';
import { jroot as jrootOf, outputJoinsAdmitSet } from '../../crypto/admit.js';
import { MAX_TX_OUTPUTS } from '../../crypto/note.js';
import { coinbaseOutputCap, payeeCapLive, COINBASE_EXTRA_NOTES, K_VW } from '../../crypto/block_budget.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import { encodeBookSnap, decodeBookSnap } from '../src/book_snap.js';
import { readLatestBootstrap } from '../src/bootstrap.js';
import {
  BOOK_SEAL_DOMAIN,
  GENESIS_PREV,
  V12_GENESIS_BLOCK_HASH,
  buildTemplate,
  canonicalCarry,
  chainLoadSeal,
  coinbaseTx,
  digestTx,
  dropBrokenCoinbaseNotes,
  verifyBlock,
} from '../src/chain.js';
import { createStore } from '../src/store.js';
import { emptySupplyState, supplyStep } from '../src/supply.js';
import { encodeDest, hash20FromAddress, newIdentity, poolFeeDest } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { payeeFs1Ok } from '../../crypto/n1.js';
import {
  clearLiveSharePow,
  dest20OfShare,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
} from '../../crypto/share_batch.js';
import { admitClient, bindAcceptedShare, SHEARK_MINER_VERSION } from '../../pool/src/pool.js';
import { createPullBook } from '../../pool/src/pull_book.js';
import { evaluateSoloSubmit, parseSoloLogin } from '../src/solo_stratum.js';

const T0 = 1_700_000_000_000;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function badOut(fill = 0x04) {
  return { kind: 'pot', admitPub: Buffer.alloc(32, 0xff), commit: Buffer.alloc(32, fill) };
}

function badCoinbaseBlock(fill = 0x11) {
  const tx = {
    coinbase: true,
    id: 'cb-bad',
    kind: 'coinbase',
    vout: [badOut(fill)],
  };
  const header = encodeHeader({
    prevBlockHash: GENESIS_PREV,
    merkleRoot: merkleRoot([digestTx(tx)]),
    continuityRoot: Buffer.alloc(32),
    timestamp: T0,
    bits: GENESIS_BITS_PACKED,
    nonce: 0n,
    baseFee: 1n,
  });
  return { header, height: 1, hash: Buffer.alloc(32), txs: [tx] };
}

describe('N-1 gate order', () => {
  it('does not derive a leaf before the header or the output cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-gate-'));
    const store = createStore(dir);
    try {
      resetFs1LeafDerives();
      const missing = store.verifyFork([{ txs: [{ kind: 'pot', vout: [badOut()] }] }]);
      assert.equal(missing.reason, 'no_header');
      assert.equal(fs1LeafDeriveCount(), 0);

      resetFs1LeafDerives();
      const bare = verifyBlock({ txs: [{ coinbase: true, kind: 'coinbase', vout: [badOut()] }] }, null);
      assert.equal(bare.reason, 'no_header');
      assert.equal(fs1LeafDeriveCount(), 0);

      const over = {
        id: 'over-cap',
        kind: 'pay',
        vout: Array.from({ length: MAX_TX_OUTPUTS + 1 }, () => badOut()),
      };
      resetFs1LeafDerives();
      assert.equal(admitMempool(emptyMempool(), over).reason, 'tx_cap');
      assert.equal(fs1LeafDeriveCount(), 0);
      resetFs1LeafDerives();
      assert.equal(store.queueTx(over).reason, 'tx_cap');
      assert.equal(fs1LeafDeriveCount(), 0);

      const one = { id: 'one-bad', kind: 'pay', vout: [badOut()] };
      resetFs1LeafDerives();
      assert.equal(admitMempool(emptyMempool(), one).reason, 'admit_note_point');
      assert.ok(fs1LeafDeriveCount() > 0);

      const block = badCoinbaseBlock();
      resetFs1LeafDerives();
      assert.equal(verifyBlock(block, null, { probeBody: true }).reason, 'admit_note_point');
      const derived = fs1LeafDeriveCount();
      assert.ok(derived > 0);
      assert.equal(verifyBlock(block, null, { probeBody: true }).reason, 'admit_note_point');
      assert.equal(fs1LeafDeriveCount(), derived);
      resetFs1LeafDerives();
      const forkBlock = badCoinbaseBlock();
      assert.equal(store.verifyFork([forkBlock], { probeBody: true }).reason, 'admit_note_point');
      assert.equal(fs1LeafDeriveCount(), 0);
      resetFs1LeafDerives();
      const freshBytes = badCoinbaseBlock(0x12);
      assert.equal(store.verifyFork([freshBytes], { probeBody: true }).reason, 'admit_note_point');
      assert.ok(fs1LeafDeriveCount() > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the leaf rescan when book.seal matches, and does not scan a bad header', () => {
    const tx = { id: 'bad-load', kind: 'pot', vout: [badOut(0x21)] };
    const header = Buffer.alloc(80, 1);
    const hash = Buffer.alloc(32, 2);
    const writeBook = (dir, seal) => {
      fs.mkdirSync(dir, { recursive: true });
      const block = { header, hash, height: 1, txs: [tx] };
      if (seal) {
        const key = bookSealKeyFor(dir);
        fs.writeFileSync(path.join(dir, 'book.seal'), chainLoadSeal([block], key));
      }
      fs.writeFileSync(path.join(dir, 'chain.jsonl'), `${JSON.stringify({
        header: header.toString('hex'),
        hash: hash.toString('hex'),
        height: 1,
        txs: [tx],
      })}\n`);
    };

    const open = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-open-'));
    writeBook(open, false);
    resetFs1LeafDerives();
    assert.throws(() => createStore(open), /bad_header/);
    assert.equal(fs1LeafDeriveCount(), 0);
    fs.rmSync(open, { recursive: true, force: true });

    const sealed = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-seal-'));
    writeBook(sealed, true);
    resetFs1LeafDerives();
    assert.throws(() => createStore(sealed), (err) => {
      assert.equal(err.message, 'bad_header');
      return true;
    });
    assert.equal(fs1LeafDeriveCount(), 0);
    fs.rmSync(sealed, { recursive: true, force: true });
  });

  it('drops a broken coinbase payee instead of throwing', () => {
    const dest = minerDest();
    const cb = coinbaseTx({
      height: 1,
      miner: dest,
      potShares: [{ address: dest, nanos: 1000, kind: 'pot' }],
      potNanos: 1000,
    });
    assert.equal(cb.vout.length, 1);
    cb.vout.push(badOut());
    const lines = [];
    const orig = console.error;
    console.error = (line) => lines.push(String(line));
    try {
      assert.doesNotThrow(() => dropBrokenCoinbaseNotes(cb));
    } finally {
      console.error = orig;
    }
    assert.equal(cb.vout.length, 1);
    assert.equal(cb.vout[0].kind, 'pot');
    assert.equal(canonicalCarry(cb), 0);
    assert.ok(lines.some((line) => line.includes('coinbase_note_drop') && line.includes('admit_note_point')));
  });

  it('re-splits a dropped pot over the payees that remain, and verifyBlock accepts that template', () => {
    const who = minerDest();
    const other = minerDest();
    const solo = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: who,
      finderDest: who,
      now: T0,
      bits: GENESIS_BITS_PACKED,
    });
    const subsidy = Number(solo.txs[0].vout.find((o) => o.kind === 'pot')?.valueProof?.v || 0);
    const drop = 1000;
    assert.ok(subsidy > drop);
    const honest = supplyOf(solo);
    assert.equal(honest.ok, true, honest.reason);
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: who,
      finderDest: who,
      now: T0,
      bits: GENESIS_BITS_PACKED,
      potShares: [
        { address: who, nanos: subsidy - drop, kind: 'pot' },
        { address: other, nanos: drop, kind: 'pot' },
      ],
    });
    const cb = tpl.txs[0];
    assert.equal(canonicalCarry(cb), 0);
    const victim = cb.vout.find((o) => o.kind === 'pot' && Number(o.valueProof?.v) === drop);
    assert.ok(victim);
    const survivorBefore = cb.vout.find((o) => o.kind === 'pot' && o !== victim);
    assert.ok(survivorBefore);
    const survivorCommit = Buffer.from(survivorBefore.commit);
    victim.admitPub = Buffer.alloc(32, 0xab);
    const broken = verifyBlock(viewOf(tpl), null, { probeBody: true });
    assert.equal(broken.reason, 'admit_note_point');
    dropBrokenCoinbaseNotes(cb);
    finishTemplate(tpl);
    const pots = cb.vout.filter((o) => o.kind === 'pot');
    assert.equal(pots.length, 1);
    assert.equal(Number(pots[0].valueProof.v), subsidy);
    assert.equal(canonicalCarry(cb), 0);
    assert.equal(Buffer.from(pots[0].commit).equals(survivorCommit), false);
    for (const o of cb.vout) {
      assert.equal(Buffer.from(o.commit).length, 32);
      assert.equal(Buffer.from(o.admitPub).length, 32);
      assert.ok(fs1LeafFor(o));
    }
    const kept = verifyBlock(viewOf(tpl), null, { probeBody: true });
    assert.equal(kept.ok, true, kept.reason || '');
    const repaired = supplyOf(tpl);
    assert.equal(repaired.ok, true, repaired.reason);
    assert.equal(repaired.state.mintedPot, honest.state.mintedPot);
    assert.equal(repaired.state.carry, honest.state.carry);

    const both = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: who,
      finderDest: who,
      now: T0,
      bits: GENESIS_BITS_PACKED,
      potShares: [
        { address: who, nanos: subsidy - drop, kind: 'pot' },
        { address: other, nanos: drop, kind: 'pot' },
      ],
    });
    for (const o of both.txs[0].vout) {
      if (o.kind === 'pot') o.admitPub = Buffer.alloc(32, 0xac);
    }
    dropBrokenCoinbaseNotes(both.txs[0]);
    finishTemplate(both);
    assert.equal(both.txs[0].vout.filter((o) => o.kind === 'pot').length, 0);
    assert.equal(canonicalCarry(both.txs[0]), subsidy);
    const carried = verifyBlock(viewOf(both), null, { probeBody: true });
    assert.equal(carried.ok, true, carried.reason || '');
    const carriedSupply = supplyOf(both);
    assert.equal(carriedSupply.ok, true, carriedSupply.reason);
    assert.equal(carriedSupply.state.mintedPot, 0n);
    assert.equal(carriedSupply.state.carry, honest.state.mintedPot + honest.state.carry);
    assert.equal(
      carriedSupply.state.mintedPot + carriedSupply.state.carry,
      honest.state.mintedPot + honest.state.carry,
    );

    const hashNote = coinbaseTx({
      height: 1,
      miner: who,
      potShares: [{ address: who, nanos: 1000, kind: 'pot' }],
      potNanos: 1000,
    });
    hashNote.vout.push({
      kind: 'hash',
      admitPub: Buffer.alloc(32, 0xcd),
      commit: Buffer.alloc(32, 0xce),
      nanos: 5,
      valueProof: { v: 5 },
    });
    assert.throws(() => dropBrokenCoinbaseNotes(hashNote), /admit_note_point/);
    assert.equal(hashNote.vout.length, 2);
  });

  it('refuses a bad payee at share entry, and an honest share template verifies', () => {
    const who = minerDest();
    const bad = encodeDest(hash20FromAddress(who), Buffer.alloc(32, 0xff));
    const login = {
      version: SHEARK_MINER_VERSION,
      client: 'ShearHash',
    };
    assert.equal(payeeFs1Ok(who), true);
    assert.equal(payeeFs1Ok(poolFeeDest()), true);
    assert.equal(payeeFs1Ok(encodeDest(Buffer.alloc(20, 5))), true);
    assert.equal(payeeFs1Ok(bad), false);
    const refusedLogin = admitClient({ ...login, login: bad });
    assert.equal(refusedLogin.ok, false);
    assert.equal(refusedLogin.reason, 'admit_note_point');
    assert.equal(admitClient({ ...login, login: who }).ok, true);
    const id = newIdentity();
    const refusedPayout = admitClient({
      ...login,
      login: id.paymentCode,
      dest: bad,
    });
    assert.equal(refusedPayout.ok, false);
    assert.equal(refusedPayout.reason, 'admit_note_point');
    const solo = parseSoloLogin(bad);
    assert.equal(solo.ok, false);
    assert.equal(solo.reason, 'admit_note_point');
    assert.equal(parseSoloLogin(who).ok, true);
    const soloShare = evaluateSoloSubmit({
      store: { jobs: new Map() },
      jobId: 'missing',
      nonce: 1n,
      dest: bad,
    });
    assert.equal(soloShare.ok, false);
    assert.equal(soloShare.reason, 'admit_note_point');
    const bookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-payee-'));
    try {
      const book = createPullBook(bookDir);
      assert.equal(book.bindDest('miner', bad), false);
      assert.equal(book.bindDest('miner', who), true);
    } finally {
      fs.rmSync(bookDir, { recursive: true, force: true });
    }

    const nonce = nonceWithShareTarget(1n, SHARE_FLOOR_BITS);
    const refusedShare = bindAcceptedShare([], {
      dest: bad,
      nonce,
      shareBits: SHARE_FLOOR_BITS,
      header: Buffer.alloc(80, 1),
    });
    assert.equal(refusedShare.ok, false);
    assert.equal(refusedShare.reason, 'admit_note_point');
    assert.equal(refusedShare.list.length, 0);

    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: who,
      bits: GENESIS_BITS_PACKED,
      now: T0,
    });
    const parent = viewOf(parentTpl);
    const okParent = verifyBlock(parent, null, { probeBody: true });
    assert.equal(okParent.ok, true, okParent.reason || '');
    clearLiveSharePow();
    const accepted = bindAcceptedShare([], {
      dest: who,
      nonce,
      shareBits: SHARE_FLOOR_BITS,
      lz: SHARE_FLOOR_BITS,
      verifiedHeader: parent.header,
      hash: 'ab'.repeat(32),
    });
    assert.equal(accepted.ok, true, accepted.reason || '');
    assert.equal(accepted.list.length, 1);
    assert.equal(accepted.list[0].dest, who);

    const now = T0 + 90_000;
    const ph = decodeHeader(parent.header);
    const row = {
      dest: who,
      dest20: dest20OfShare({ dest: who }),
      nonce,
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
      proofSlot: 0,
    };
    const childTpl = buildTemplate({
      prev: okParent.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner: who,
      bits: bitsForBlock(ph.bits, ph.timestamp, now),
      now,
      shareBatch: [row],
    });
    assert.ok(childTpl.shareBatch.length > 0);
    clearLiveSharePow();
    assert.equal(rememberLiveSharePow(parent.header, nonce, {
      noteCommit: noteCommitOfShare(row),
      shareBits: SHARE_FLOOR_BITS,
      lz: SHARE_FLOOR_BITS,
    }), true);
    const child = viewOf(childTpl);
    const got = verifyBlock(child, { ...parent, hash: okParent.hash, height: 1 }, {
      probeBody: true,
      skipSharePow: true,
    });
    assert.equal(got.ok, true, got.reason || '');

    const cb = childTpl.txs[0];
    const pot = cb.vout.find((o) => o.kind === 'pot');
    assert.ok(pot);
    const carryBefore = canonicalCarry(cb);
    pot.admitPub = Buffer.alloc(32, 0xab);
    assert.throws(() => dropBrokenCoinbaseNotes(cb, { shares: true }), /admit_note_point/);
    assert.equal(canonicalCarry(cb), carryBefore);
    assert.equal(cb.vout.some((o) => Buffer.from(o.admitPub).equals(Buffer.alloc(32, 0xab))), true);
  });

  it('evicts a broken share payee and rebuilds a template that verifies', () => {
    const who = minerDest();
    const other = minerDest();
    const parentTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: who,
      bits: GENESIS_BITS_PACKED,
      now: T0,
    });
    const parent = viewOf(parentTpl);
    const okParent = verifyBlock(parent, null, { probeBody: true });
    assert.equal(okParent.ok, true, okParent.reason || '');
    const now = T0 + 90_000;
    const ph = decodeHeader(parent.header);
    const row = (dest, low) => ({
      dest,
      dest20: dest20OfShare({ dest }),
      nonce: nonceWithShareTarget(low, SHARE_FLOOR_BITS),
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
      proofSlot: 0,
    });
    const broken = row(other, 2n);
    const bad20 = Buffer.from(broken.dest20).toString('hex');
    const tpl = buildTemplate({
      prev: okParent.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      parentWeight: parent.weight,
      height: 2,
      miner: who,
      bits: bitsForBlock(ph.bits, ph.timestamp, now),
      now,
      shareBatch: [row(who, 1n), broken],
      prepareCoinbase(cb) {
        const victim = (cb.vout || []).find((o) => (
          o.kind === 'pot' && Buffer.from(o.dest20).toString('hex') === bad20
        ));
        assert.ok(victim);
        victim.admitPub = Buffer.alloc(32, 0xab);
      },
    });
    assert.equal(tpl.shareBatch.length, 1);
    assert.equal(Buffer.from(dest20OfShare(tpl.shareBatch[0])).toString('hex'), Buffer.from(dest20OfShare({ dest: who })).toString('hex'));
    assert.equal(tpl.txs[0].vout.some((o) => Buffer.from(o.admitPub || Buffer.alloc(0)).equals(Buffer.alloc(32, 0xab))), false);
    clearLiveSharePow();
    const kept = tpl.shareBatch[0];
    assert.equal(rememberLiveSharePow(parent.header, kept.nonce, {
      noteCommit: noteCommitOfShare(kept),
      shareBits: SHARE_FLOOR_BITS,
      lz: SHARE_FLOOR_BITS,
    }), true);
    const got = verifyBlock(viewOf(tpl), { ...parent, hash: okParent.hash, height: 1 }, {
      probeBody: true,
      skipSharePow: true,
    });
    assert.equal(got.ok, true, got.reason || '');
  });

  it('refuses a pre-N-1 seal and a pre-N-1 snap', () => {
    assert.equal(BOOK_SEAL_DOMAIN, 'bookseal2');
    const rules = consensusFingerprint();
    assert.match(rules, /N1=admit-note-point/);
    const header = Buffer.alloc(80, 1);
    const hash = Buffer.alloc(32, 2);
    const tx = { id: 'old-seal', kind: 'pot', vout: [badOut(0x51)] };
    const block = { header, hash, height: 1, txs: [tx] };
    const key = randomBytes(32);
    const current = chainLoadSeal([block], key);
    assert.equal(sealDigest([block], key, 'bookseal2', rules), current);
    assert.notEqual(sealDigest([block], key, 'bookseal1', rules), current);
    const oldRules = rules.replace(':N1=admit-note-point', '');
    assert.notEqual(oldRules, rules);
    assert.notEqual(sealDigest([block], key, 'bookseal2', oldRules), current);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-oldseal-'));
    try {
      const installKey = bookSealKeyFor(dir);
      fs.writeFileSync(path.join(dir, 'book.seal'), sealDigest([block], installKey, 'bookseal1', rules));
      fs.writeFileSync(path.join(dir, 'chain.jsonl'), `${JSON.stringify({
        header: header.toString('hex'),
        hash: hash.toString('hex'),
        height: 1,
        txs: [tx],
      })}\n`);
      resetFs1LeafDerives();
      assert.throws(() => createStore(dir), /bad_header/);
      assert.equal(fs1LeafDeriveCount(), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const snapKey = randomBytes(32);
    const expect = {
      rules,
      genesisPin: String(V12_GENESIS_BLOCK_HASH || ''),
      checkpoint: { height: 0, hash: '' },
    };
    const oldSnap = encodeBookSnap(snapState(oldRules), snapKey);
    assert.equal(decodeBookSnap(oldSnap, snapKey, expect), null);
    const liveSnap = encodeBookSnap(snapState(rules), snapKey);
    const opened = decodeBookSnap(liveSnap, snapKey, expect);
    assert.equal(opened && opened.rules, rules);
    assert.equal(opened.height, 1);
  });

  it('caps a coinbase and budgets a fork before any leaf', () => {
    const cap = coinbaseOutputCap();
    assert.equal(cap, payeeCapLive() + COINBASE_EXTRA_NOTES + K_VW);
    assert.ok(payeeCapLive() + 1 <= cap);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-cap-'));
    const store = createStore(dir);
    try {
      const over = coinbaseBlock(cap + 1);
      resetFs1LeafDerives();
      assert.equal(verifyBlock(over, null, { probeBody: true }).reason, 'tx_cap');
      assert.equal(fs1LeafDeriveCount(), 0);
      resetFs1LeafDerives();
      assert.equal(store.verifyFork([coinbaseBlock(cap + 1)], { probeBody: true }).reason, 'tx_cap');
      assert.equal(fs1LeafDeriveCount(), 0);
      resetFs1LeafDerives();
      assert.equal(admitMempool(emptyMempool(), over.txs[0]).reason, 'tx_cap');
      assert.equal(fs1LeafDeriveCount(), 0);
      resetFs1LeafDerives();
      assert.equal(store.queueTx(over.txs[0]).reason, 'tx_cap');
      assert.equal(fs1LeafDeriveCount(), 0);

      const heavy = coinbaseBlock(payeeCapLive() + 1);
      resetFs1LeafDerives();
      assert.equal(verifyBlock(heavy, null, { probeBody: true }).reason, 'payee_cap');
      assert.equal(fs1LeafDeriveCount(), 0);
      resetFs1LeafDerives();
      assert.equal(store.verifyFork([coinbaseBlock(payeeCapLive() + 1)], { probeBody: true }).reason, 'payee_cap');
      assert.equal(fs1LeafDeriveCount(), 0);
      resetFs1LeafDerives();
      assert.equal(store.queueTx(heavy.txs[0]).reason, 'payee_cap');
      assert.equal(fs1LeafDeriveCount(), 0);
      resetFs1LeafDerives();
      assert.equal(admitMempool(emptyMempool(), heavy.txs[0]).reason, 'payee_cap');
      assert.equal(fs1LeafDeriveCount(), 0);

      const one = { id: 'one-bad-after-budget', kind: 'pay', vout: [badOut(0x45)] };
      resetFs1LeafDerives();
      assert.equal(admitMempool(emptyMempool(), one).reason, 'admit_note_point');
      assert.ok(fs1LeafDeriveCount() > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unsealed 183-output coinbase before any leaf', () => {
    const n = coinbaseOutputCap() + 1;
    assert.equal(n, 183);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-183-'));
    try {
      const block = coinbaseBlock(n);
      fs.writeFileSync(path.join(dir, 'chain.jsonl'), `${JSON.stringify({
        header: Buffer.from(block.header).toString('hex'),
        hash: Buffer.from(block.hash).toString('hex'),
        height: 1,
        txs: block.txs,
      })}\n`);
      resetFs1LeafDerives();
      assert.throws(() => createStore(dir), (err) => {
        assert.notEqual(err.message, 'admit_note_point');
        return true;
      });
      assert.equal(fs1LeafDeriveCount(), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still rejects a bad leaf on load after the header, the cap, and the budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-leaf-load-'));
    try {
      const block = badCoinbaseBlock(0x71);
      assert.equal(block.txs[0].vout.length <= coinbaseOutputCap(), true);
      assert.equal(meetsTarget(Buffer.from(block.hash), GENESIS_BITS_PACKED), true);
      fs.mkdirSync(dir, { recursive: true });
      const key = bookSealKeyFor(dir);
      fs.writeFileSync(path.join(dir, 'book.seal'), chainLoadSeal([block], key));
      fs.writeFileSync(path.join(dir, 'chain.jsonl'), `${JSON.stringify({
        header: Buffer.from(block.header).toString('hex'),
        hash: Buffer.from(block.hash).toString('hex'),
        height: 1,
        txs: block.txs,
      })}\n`);
      resetFs1LeafDerives();
      assert.throws(() => createStore(dir), /admit_note_point/);
      assert.ok(fs1LeafDeriveCount() > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks a bootstrap header before the leaves', () => {
    const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-boot-'));
    try {
      const bootBlock = {
        header: Buffer.alloc(128, 1),
        hash: Buffer.alloc(32, 9),
        height: 1,
        txs: [{ coinbase: true, kind: 'coinbase', vout: [badOut(0x61)] }],
      };
      const bootPaths = path.join(bootDir, 'bootstrap');
      fs.mkdirSync(bootPaths, { recursive: true });
      writeChainBin(path.join(bootPaths, 'latest.bin'), [bootBlock]);
      fs.writeFileSync(path.join(bootPaths, 'latest.json'), `${JSON.stringify({
        latest: true,
        magic: MAGIC_TESTNET,
        height: 1,
        hash: bootBlock.hash.toString('hex'),
        genesisHash: bootBlock.hash.toString('hex'),
      })}\n`);
      resetFs1LeafDerives();
      assert.throws(() => readLatestBootstrap(bootDir), /prev/);
      assert.equal(fs1LeafDeriveCount(), 0);
    } finally {
      fs.rmSync(bootDir, { recursive: true, force: true });
    }
  });
});

function finishTemplate(tpl) {
  const cb = tpl.txs[0];
  const pubs = [];
  for (const tx of tpl.txs) {
    for (const o of tx.vout || []) {
      if (outputJoinsAdmitSet(tx, o)) pubs.push(o.admitPub);
    }
  }
  if (pubs.length) cb.jroot = Buffer.from(jrootOf(pubs));
  else delete cb.jroot;
  const decoded = decodeHeader(Buffer.from(tpl.header));
  const merkle = merkleRoot(tpl.txs.map(digestTx));
  tpl.merkleRoot = merkle;
  tpl.header = encodeHeader({
    version: decoded.version,
    prevBlockHash: decoded.prevBlockHash,
    merkleRoot: merkle,
    continuityRoot: decoded.continuityRoot,
    timestamp: decoded.timestamp,
    bits: decoded.bits,
    nonce: 0n,
    baseFee: decoded.baseFee,
  });
  return tpl;
}

function supplyOf(tpl) {
  return supplyStep(emptySupplyState(T0), viewOf(tpl), {
    height: 1,
    genesisMs: T0,
    magic: MAGIC_TESTNET,
    tipHeight: 1,
    blockHash: Buffer.alloc(32),
  });
}

function viewOf(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    height: tpl.height,
  };
}

function coinbaseBlock(nOut) {
  const tx = {
    coinbase: true,
    id: 'cb-cap',
    kind: 'coinbase',
    vout: Array.from({ length: nOut }, () => badOut(0x31)),
  };
  const header = encodeHeader({
    prevBlockHash: GENESIS_PREV,
    merkleRoot: merkleRoot([digestTx(tx)]),
    continuityRoot: Buffer.alloc(32),
    timestamp: T0,
    bits: GENESIS_BITS_PACKED,
    nonce: 0n,
    baseFee: 1n,
  });
  return { header, height: 1, hash: Buffer.alloc(32), txs: [tx] };
}

function sealDigest(blocks, key, domain, rules) {
  const h = createHash('sha256');
  const put = (buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
    const n = Buffer.alloc(4);
    n.writeUInt32LE(b.length >>> 0, 0);
    h.update(n);
    h.update(b);
  };
  put(domain);
  put(rules);
  put('');
  const cp = Buffer.alloc(4);
  cp.writeUInt32LE(0, 0);
  h.update(cp);
  put('');
  h.update(key);
  for (const b of blocks) {
    const header = Buffer.from(b.header);
    const hash = Buffer.from(b.hash);
    const n = Buffer.alloc(8);
    n.writeUInt32LE(header.length >>> 0, 0);
    n.writeUInt32LE(hash.length >>> 0, 4);
    h.update(n);
    h.update(header);
    h.update(hash);
  }
  return h.digest('hex');
}

function snapState(rules) {
  const z = 'ab'.repeat(32);
  return {
    rules,
    genesisPin: '',
    checkpointHeight: 0,
    height: 1,
    tipHash: Buffer.alloc(32, 3),
    diskDigest: z,
    frameDigest: z,
    vaultCommitment: z,
    genesisMs: T0,
    acceptedSeries: [0],
    unitAt: [0],
  };
}

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
import { consensusFingerprint, GENESIS_BITS_PACKED, MAGIC_TESTNET } from '../../crypto/asert.js';
import { writeChainBin } from '../../crypto/chainbin.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { fs1LeafDeriveCount, resetFs1LeafDerives } from '../../crypto/fs1_leaf.js';
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
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

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

  it('skips the leaf rescan when book.seal matches, and still scans an unsealed book', () => {
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
    assert.throws(() => createStore(open), /admit_note_point/);
    assert.ok(fs1LeafDeriveCount() > 0);
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

  it('puts a dropped pot back in the carry, and verifyBlock accepts that block', () => {
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
    victim.admitPub = Buffer.alloc(32, 0xab);
    const broken = verifyBlock(viewOf(tpl), null, { probeBody: true });
    assert.equal(broken.reason, 'admit_note_point');
    dropBrokenCoinbaseNotes(cb);
    assert.equal(cb.vout.filter((o) => o.kind === 'pot').length, 1);
    assert.equal(canonicalCarry(cb), drop);
    // Public nanos, no commitment. verifyBlock's pot check then reads the carry
    // without a range proof. The dropped amount is what keeps that sum whole.
    for (const o of cb.vout) {
      o.nanos = Number(o.valueProof?.v || 0);
      delete o.commit;
      delete o.admitPub;
    }
    const reseal = () => {
      delete cb.jroot;
      const decoded = decodeHeader(Buffer.from(tpl.header));
      tpl.header = encodeHeader({
        version: decoded.version,
        prevBlockHash: decoded.prevBlockHash,
        merkleRoot: merkleRoot(tpl.txs.map(digestTx)),
        continuityRoot: decoded.continuityRoot,
        timestamp: decoded.timestamp,
        bits: decoded.bits,
        nonce: 0n,
        baseFee: decoded.baseFee,
      });
    };
    reseal();
    const kept = verifyBlock(viewOf(tpl), null, { probeBody: true });
    assert.notEqual(kept.reason, 'pot_sched', kept.reason || '');
    cb.carryNanos = 0;
    reseal();
    assert.equal(verifyBlock(viewOf(tpl), null, { probeBody: true }).reason, 'pot_sched');

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
      assert.throws(() => createStore(dir), /admit_note_point/);
      assert.ok(fs1LeafDeriveCount() > 0);
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

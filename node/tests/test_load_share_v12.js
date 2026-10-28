// Loading a sealed book applies the share and payout rules again. R28: shares
// are BluNotes frames; the pool fee is a rate (feeBps, at most
// POOL_FEE_MAX_BPS) paid to the coinbase's one-time key; a coinbase carries
// no payee note and a block no payee leaves; work paid in the parent is
// refused; and an untrusted load hashes every share it does not trust.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GENESIS_BITS_PACKED,
  POOL_FEE_MAX_BPS,
  shareFloorBits,
  asertNextBits,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { writeChainBin, readChainBin } from '../../crypto/chainbin.js';
import { decodeHeader, encodeHeader, setNonce } from '../../crypto/header.js';
import { shareSlotRoot } from '../../crypto/pack.js';
import { meetsTarget, setHashBackend, shearHash } from '../../crypto/shear_hash.js';
import { compareBluShares, resetSharePowCounters, sharePowCounters } from '../../crypto/share_batch.js';
import { SHARE_BYTES_MAX, bindNonce, oneTimeKey } from '../../crypto/blunote.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import { GENESIS_PREV, buildTemplate, chainLoadSeal, digestTx, verifyLoadedChain } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { bluWallet } from './support/blunote_mine.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-load-share-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

const MINER = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const POOL = bluWallet();

// R39: rows go into blocks at genesis bits, so their floor is that block's.
const FLOOR = shareFloorBits(GENESIS_BITS_PACKED);

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

let tagN = 1;
function tagHash() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(tagN, 4);
  tagN += 1;
  assert.equal(meetsTarget(h, GENESIS_BITS_PACKED), true);
  return h;
}

function feeKey() {
  const k = oneTimeKey(POOL);
  return { R: k.R, P: k.P, viewTag: k.tag };
}

/** A BluNotes row for a fresh key, its nonce bound on `header`. Load trusts its own work. */
function shareRow(header, bits = FLOOR, counter = 0, slot = 0) {
  const k = oneTimeKey(bluWallet());
  return {
    shareR: k.R,
    shareP: k.P,
    viewTag: k.tag,
    nonce: bindNonce(header, k.R, k.P, counter, bits),
    lz: bits & 0xff,
    shareBits: bits,
    proofSlot: slot,
  };
}

function rowsFor(header, count, bits = FLOOR) {
  return Array.from({ length: count }, () => shareRow(header, bits)).sort(compareBluShares);
}

function asBlock(tpl, hash) {
  return {
    header: Buffer.from(tpl.header),
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: (tpl.shareBatch || []).map((s) => ({ ...s })),
    miner: MINER,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hash,
    height: tpl.height,
  };
}

function restamp(block) {
  const decoded = decodeHeader(Buffer.from(block.header));
  return {
    ...block,
    header: encodeHeader({ ...decoded, merkleRoot: merkleRoot((block.txs || []).map(digestTx)), timestamp: Number(decoded.timestamp) }),
  };
}

function sealBook(dir, blocks) {
  const bin = path.join(dir, 'chain.bin');
  writeChainBin(bin, blocks);
  const stamped = readChainBin(bin).map(restamp);
  writeChainBin(bin, stamped);
  fs.writeFileSync(path.join(dir, 'book.seal'), `${chainLoadSeal(stamped, bookSealKeyFor(dir))}\n`);
}

function expectFail(blocks, re) {
  const dir = tmp('shear-load-share-bad-');
  sealBook(dir, blocks);
  assert.throws(() => createStore(dir), re);
  assert.equal(fs.existsSync(path.join(dir, 'reserve.json')), false);
}

function expectOk(blocks) {
  const dir = tmp('shear-load-share-ok-');
  sealBook(dir, blocks);
  const store = createStore(dir);
  const supply = auditCirculatingSupply(store.blocks);
  assert.equal(supply.status, 'verified', supply.reason);
  assert.equal(store.tip().height, blocks.length);
  return store;
}

function genesisBlock(when) {
  const tpl = buildTemplate({ prev: GENESIS_PREV, height: 1, miner: MINER, bits: GENESIS_BITS_PACKED, now: when, feeKey: feeKey(), feeBps: 100 });
  return asBlock(tpl, tagHash());
}

function childBlock(genesis, parent, rows, when, feeBps = 100) {
  const parentDecoded = decodeHeader(Buffer.from(parent.header));
  const genesisDecoded = decodeHeader(Buffer.from(genesis.header));
  const parentIsGenesis = parentDecoded.prevBlockHash.equals(GENESIS_PREV);
  const quote = asertNextBits({
    anchorBits: parentIsGenesis ? parentDecoded.bits : GENESIS_BITS_PACKED,
    anchorTimeMs: parentIsGenesis ? Number(parentDecoded.timestamp) : Number(genesisDecoded.timestamp),
    anchorHeight: parentIsGenesis ? Number(parent.height) : 1,
    blockTimeMs: when,
    blockHeight: Number(parent.height) + 1,
    parentTimeMs: Number(parentDecoded.timestamp),
  });
  assert.equal(quote.ok, true, quote.reason || 'asert');
  const tpl = buildTemplate({
    prev: parent.hash,
    prevHeader: parent.header,
    prevBlock: parent,
    height: Number(parent.height) + 1,
    miner: MINER,
    bits: quote.packed,
    now: when,
    shareBatch: rows,
    parentBlocks: [genesis, parent].filter((b, i, all) => all.indexOf(b) === i),
    feeKey: feeKey(),
    feeBps,
  });
  return asBlock(tpl, tagHash());
}

/** genesis + one child seating `count` shares; the child's parent record is the genesis's. */
function bookAt(count, feeBps = 100) {
  const t0 = Date.now() - 400_000;
  const genesis = genesisBlock(t0);
  // The child names its parent's record root: keep genesis's from a verify-equivalent load.
  const loaded = expectOk([genesis]);
  genesis.blunoteRecord = loaded.tip().blunoteRecord;
  const rows = rowsFor(genesis.header, count);
  const child = childBlock(genesis, genesis, rows, t0 + 90_000, feeBps);
  return { blocks: [genesis, child], rows };
}

describe('v12 load applies the share rules', () => {
  it('keeps the pool fee rate at or under the cap and refuses the rest, and any payee note', () => {
    for (const count of [1, 4, 17]) {
      for (const bps of [0, 100, POOL_FEE_MAX_BPS]) expectOk(bookAt(count, bps).blocks);
      for (const bps of [POOL_FEE_MAX_BPS + 1, 10_000]) {
        const book = bookAt(count, 100);
        book.blocks[1].txs[0] = { ...book.blocks[1].txs[0], blunote: { ...book.blocks[1].txs[0].blunote, feeBps: bps } };
        expectFail(book.blocks, /blunote_fields/);
      }
      // A custodial pot note in the coinbase is refused: payouts are the draw's.
      const custody = bookAt(count, 100);
      custody.blocks[1].txs[0] = { ...custody.blocks[1].txs[0], vout: [...custody.blocks[1].txs[0].vout, { kind: 'pot', nanos: 1 }] };
      expectFail(custody.blocks, /blunote_vout/);
    }
  });

  it('rejects a bad share byte, a duplicate, a paid work key, and a payee leaf', () => {
    const illegal = [
      (h) => shareRow(h, FLOOR - 1),
      (h) => shareRow(h, shareCreditMaxBits() + 1),
      (h) => ({ ...shareRow(h, FLOOR), shareBits: FLOOR + 4 }),
    ];
    [1, 4, 17].forEach((count, index) => {
      const book = bookAt(count);
      const child = book.blocks[1];
      child.shareBatch = [...child.shareBatch, illegal[index % illegal.length](book.blocks[0].header)].sort(compareBluShares);
      child.txs[0].shareSlotRoot = shareSlotRoot(child.shareBatch);
      expectFail(book.blocks, /share_target/);
    });
    for (const count of [2, 4, 17]) {
      const book = bookAt(count);
      const child = book.blocks[1];
      child.shareBatch = [...child.shareBatch, { ...child.shareBatch[0] }].sort(compareBluShares);
      child.txs[0].shareSlotRoot = shareSlotRoot(child.shareBatch);
      expectFail(book.blocks, /share_order|dup_share/);
    }
    // Work paid in block 2 re-seated as slot 1 in block 3.
    const paid = bookAt(4);
    const loaded = expectOk(paid.blocks);
    paid.blocks[1].blunoteRecord = loaded.tip().blunoteRecord;
    const again = paid.blocks[1].shareBatch.map((row) => ({ ...row, proofSlot: 1 }));
    const when = Number(decodeHeader(Buffer.from(paid.blocks[1].header)).timestamp) + 90_000;
    const third = childBlock(paid.blocks[0], paid.blocks[1], again, when);
    third.shareBatch = again;
    third.txs[0].shareSlotRoot = shareSlotRoot(again);
    expectFail([...paid.blocks, third], /paid_share|share_key/);
    // A payee leaf on a BluNotes block is refused.
    for (const count of [1, 3, 17]) {
      const book = bookAt(count);
      book.blocks[1].aLeaves = [{ dest20: Buffer.alloc(20, 1), count: 1 }];
      expectFail(book.blocks, /blunote_leaves|continuity/);
    }
  });

  it('hashes unproven shares when the load does not trust them', () => {
    setHashBackend('jit');
    const widths = [FLOOR, FLOOR + 1, FLOOR + 4, shareCreditMaxBits()];
    for (const bits of widths) {
      for (const count of [1, 4, 17]) {
        const t0 = Date.now() - 400_000;
        const genesis = genesisBlock(t0);
        const loaded = expectOk([genesis]);
        genesis.blunoteRecord = loaded.tip().blunoteRecord;
        // Rows whose real digest misses their width: only an untrusted load sees that.
        const rows = [];
        while (rows.length < count) {
          const row = shareRow(genesis.header, bits, rows.length);
          if (!meetsTarget(shearHash(setNonce(Buffer.from(genesis.header), BigInt(row.nonce))), bits)) rows.push(row);
        }
        rows.sort(compareBluShares);
        const child = childBlock(genesis, genesis, rows, t0 + 90_000);
        const checked = verifyLoadedChain([genesis, child], { trustStoredHash: true, trustShareWork: false, nowMs: Date.now() });
        assert.equal(checked.ok, false, `${bits}:${count}`);
        assert.equal(checked.reason, 'share_pow');
      }
    }
    // A book with no seal is foreign: its block hashes are checked too.
    const sealed = bookAt(1);
    const dir = tmp('shear-load-share-foreign-');
    writeChainBin(path.join(dir, 'chain.bin'), sealed.blocks);
    assert.throws(() => createStore(dir), /pow/);
    assert.equal(fs.existsSync(path.join(dir, 'reserve.json')), false);
  });

  it('hashes a byte-cap unproven batch on an untrusted load', () => {
    setHashBackend('jit');
    const bits = shareCreditMaxBits();
    const count = Math.floor(SHARE_BYTES_MAX / 89);
    const t0 = Date.now() - 400_000;
    const genesis = genesisBlock(t0);
    const loaded = expectOk([genesis]);
    genesis.blunoteRecord = loaded.tip().blunoteRecord;
    const rows = rowsFor(genesis.header, count, bits);
    const child = childBlock(genesis, genesis, rows, t0 + 90_000);
    resetSharePowCounters();
    const t1 = Date.now();
    const checked = verifyLoadedChain([genesis, child], { trustStoredHash: true, trustShareWork: false, nowMs: Date.now() });
    const ms = Date.now() - t1;
    const hashed = sharePowCounters().sync;
    assert.equal(checked.ok, false);
    assert.equal(checked.reason, 'share_pow');
    // Fail-closed on the first miss. A cold skipPow would leave this at 0.
    assert.ok(hashed >= 1, `syncSharePow ${hashed}`);
    console.log(JSON.stringify({ event: 'load_share_byte_cap', count, bits, ms, hashed, reason: checked.reason }));
  });
});

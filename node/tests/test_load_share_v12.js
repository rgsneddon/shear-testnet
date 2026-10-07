import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash20FromAddress, newIdentity } from '../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  MAX_SHARES_PER_BLOCK,
  POOL_FEE_MAX_BPS,
  SHARE_FLOOR_BITS,
  asertNextBits,
  shareCreditMaxBits,
} from '../../crypto/asert.js';
import { writeChainBin, readChainBin } from '../../crypto/chainbin.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader, setNonce } from '../../crypto/header.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import { shareSlotRoot } from '../../crypto/pack.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import { meetsTarget, setHashBackend, shearHash } from '../../crypto/shear_hash.js';
import {
  aLeavesFromShares,
  destBoundShareHash,
  nonceWithShareTarget,
  noteCommitOfShare,
  resetSharePowCounters,
  sharePowCounters,
} from '../../crypto/share_batch.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import {
  GENESIS_PREV,
  buildTemplate,
  canonicalCarry,
  chainLoadSeal,
  digestTx,
  potPaysFromLeaves,
  verifyLoadedChain,
} from '../src/chain.js';
import { createStore } from '../src/store.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { merkleRoot } from '../../crypto/merkle.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-load-share-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

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

function shareRow(dest, low, bits, slot = 0) {
  const row = {
    dest,
    nonce: nonceWithShareTarget(BigInt(low), bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    proofSlot: slot,
  };
  row.noteCommit = Buffer.from(noteCommitOfShare(row));
  return row;
}

function rowsFor(destCount, count, bits = SHARE_FLOOR_BITS, slot = 0) {
  const dests = Array.from({ length: destCount }, () => minerDest());
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(shareRow(dests[i % dests.length], i + 1, bits, slot));
  }
  return rows;
}

function asBlock(tpl, miner, hash) {
  return {
    header: Buffer.from(tpl.header),
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: (tpl.shareBatch || []).map((s) => ({ ...s })),
    miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hashCredits: tpl.hashCredits,
    hash,
    height: tpl.height,
  };
}

function restamp(block) {
  const decoded = decodeHeader(Buffer.from(block.header));
  const txs = block.txs || [];
  return {
    ...block,
    header: encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: merkleRoot(txs.map(digestTx)),
      continuityRoot: decoded.continuityRoot,
      timestamp: Number(decoded.timestamp),
      bits: decoded.bits,
      nonce: decoded.nonce,
      baseFee: decoded.baseFee,
    }),
  };
}

function sealBook(dir, blocks) {
  const bin = path.join(dir, 'chain.bin');
  writeChainBin(bin, blocks);
  const stamped = readChainBin(bin).map(restamp);
  writeChainBin(bin, stamped);
  const key = bookSealKeyFor(dir);
  fs.writeFileSync(path.join(dir, 'book.seal'), `${chainLoadSeal(stamped, key)}\n`);
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
  const dest = minerDest();
  const hash = tagHash();
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner: dest,
    bits: GENESIS_BITS_PACKED,
    now: when,
    potShares: [],
  });
  return asBlock(tpl, dest, hash);
}

function quoteFor(genesis, parent, when) {
  const parentDecoded = decodeHeader(Buffer.from(parent.header));
  const genesisDecoded = decodeHeader(Buffer.from(genesis.header));
  const parentIsGenesis = parentDecoded.prevBlockHash.equals(GENESIS_PREV);
  return asertNextBits({
    anchorBits: parentIsGenesis ? parentDecoded.bits : GENESIS_BITS_PACKED,
    anchorTimeMs: parentIsGenesis ? Number(parentDecoded.timestamp) : Number(genesisDecoded.timestamp),
    anchorHeight: parentIsGenesis ? Number(parent.height) : 1,
    blockTimeMs: when,
    blockHeight: Number(parent.height) + 1,
    parentTimeMs: Number(parentDecoded.timestamp),
  });
}

function paysWithFee(rows, poolDest, subsidy, carry, feeNanos) {
  const leaves = aLeavesFromShares(rows);
  const pays = potPaysFromLeaves(leaves, poolDest, feeNanos, subsidy, carry);
  const destByNc = new Map();
  for (const row of rows) {
    destByNc.set(Buffer.from(row.noteCommit).toString('hex'), row.dest);
  }
  if (poolDest) {
    const nc = noteCommitOfDest20(hash20FromAddress(poolDest)).toString('hex');
    destByNc.set(nc, poolDest);
  }
  return pays.map((p) => ({
    ...p,
    address: destByNc.get(Buffer.from(p.noteCommit).toString('hex')) || '',
  })).filter((p) => p.nanos > 0 && p.address);
}

function childBlock(genesis, parent, rows, when, pays) {
  const genesisDecoded = decodeHeader(Buffer.from(genesis.header));
  const subsidy = potSubsidyAt({
    nowMs: when,
    genesisMs: Number(genesisDecoded.timestamp),
    magic: MAGIC_TESTNET,
  });
  const carry = canonicalCarry(parent.txs[0]) || 0;
  const quote = quoteFor(genesis, parent, when);
  assert.equal(quote.ok, true, quote.reason || 'asert');
  const tpl = buildTemplate({
    prev: parent.hash,
    prevHeader: parent.header,
    prevBlock: parent,
    height: Number(parent.height) + 1,
    miner: rows[0].dest,
    bits: quote.packed,
    now: when,
    potShares: pays,
    shareBatch: rows,
    parentBlocks: [genesis, parent].filter((b, i, all) => all.indexOf(b) === i),
  });
  return { block: asBlock(tpl, rows[0].dest, tagHash()), subsidy, carry };
}

function bookAt(destCount, count, feeNanos, poolDest) {
  const t0 = Date.now() - 400_000;
  const genesis = genesisBlock(t0);
  const rows = rowsFor(destCount, count);
  const when = t0 + 90_000;
  const genesisDecoded = decodeHeader(Buffer.from(genesis.header));
  const subsidy = potSubsidyAt({
    nowMs: when,
    genesisMs: Number(genesisDecoded.timestamp),
    magic: MAGIC_TESTNET,
  });
  const carry = canonicalCarry(genesis.txs[0]) || 0;
  const pays = paysWithFee(rows, poolDest, subsidy, carry, feeNanos);
  const built = childBlock(genesis, genesis, rows, when, pays);
  return { blocks: [genesis, built.block], subsidy, carry, pays, rows };
}

describe('v12 load applies the share rules', () => {
  it('keeps a subsidy fee at or under the cap and rejects the rest', () => {
    const spreads = [
      { dests: 1, count: 1 },
      { dests: 3, count: 4 },
      { dests: 17, count: 17 },
    ];
    for (const spread of spreads) {
      const probe = bookAt(spread.dests, spread.count, 0, null);
      const maxFee = Math.floor(probe.subsidy * POOL_FEE_MAX_BPS / 10000);
      assert.ok(probe.carry > 0);
      assert.ok(maxFee > 0);
      const pool = minerDest();
      const fees = [
        { name: '0', fee: 0, pool: null, ok: true },
        { name: '200', fee: Math.floor(probe.subsidy * 200 / 10000), pool, ok: true },
        { name: '201', fee: Math.floor(probe.subsidy * 201 / 10000), pool, ok: false },
        { name: '10000', fee: probe.subsidy, pool, ok: false },
        {
          name: 'carry-cap',
          fee: Math.floor((probe.subsidy + probe.carry) * POOL_FEE_MAX_BPS / 10000),
          pool,
          ok: false,
        },
      ];
      assert.ok(fees[1].fee > 0 && fees[1].fee <= maxFee);
      assert.ok(fees[2].fee > maxFee);
      assert.ok(fees[3].fee > maxFee);
      assert.ok(fees[4].fee > maxFee);
      for (const fee of fees) {
        const book = bookAt(spread.dests, spread.count, fee.fee, fee.pool);
        const sum = book.pays.reduce((n, row) => n + row.nanos, 0);
        if (fee.ok) {
          assert.equal(sum, book.subsidy + book.carry, fee.name);
          expectOk(book.blocks);
        } else {
          expectFail(book.blocks, /pot_prop|pot_sched|pot/);
        }
      }
      const custody = bookAt(spread.dests, spread.count, 0, null);
      const stranger = minerDest();
      const minted = custody.subsidy + custody.carry;
      const whole = [{
        address: stranger,
        noteCommit: noteCommitOfDest20(hash20FromAddress(stranger)),
        nanos: minted,
        kind: 'pot',
      }];
      const when = Number(decodeHeader(Buffer.from(custody.blocks[0].header)).timestamp) + 90_000;
      const built = childBlock(custody.blocks[0], custody.blocks[0], custody.rows, when, whole);
      assert.equal(whole[0].nanos, minted);
      expectFail([custody.blocks[0], built.block], /pot_prop/);
    }
  });

  it('rejects a bad share byte, a duplicate, a paid work key, and a leaf lie', () => {
    const spreads = [
      { dests: 1, count: 1 },
      { dests: 3, count: 4 },
      { dests: 17, count: 17 },
    ];
    const illegal = [
      (low) => shareRow(minerDest(), low, SHARE_FLOOR_BITS - 1),
      (low) => shareRow(minerDest(), low, shareCreditMaxBits() + 1),
      (low) => {
        const row = shareRow(minerDest(), low, SHARE_FLOOR_BITS);
        row.shareBits = SHARE_FLOOR_BITS + 4;
        row.creditedShareBits = SHARE_FLOOR_BITS + 4;
        return row;
      },
    ];
    spreads.forEach((spread, index) => {
      const book = bookAt(spread.dests, spread.count, 0, null);
      const child = book.blocks[1];
      const extra = illegal[index % illegal.length](10_000 + index);
      child.shareBatch = [...child.shareBatch, extra];
      child.txs[0].shareSlotRoot = shareSlotRoot(child.shareBatch);
      expectFail(book.blocks, /share_target/);
    });

    for (const spread of [{ dests: 1, count: 2 }, { dests: 3, count: 4 }, { dests: 17, count: 17 }]) {
      const book = bookAt(spread.dests, spread.count, 0, null);
      const child = book.blocks[1];
      child.shareBatch = [...child.shareBatch, { ...child.shareBatch[0] }];
      child.txs[0].shareSlotRoot = shareSlotRoot(child.shareBatch);
      expectFail(book.blocks, /dup_share/);
    }

    const paid = bookAt(3, 4, 0, null);
    const parent = paid.blocks[1];
    const again = parent.shareBatch.map((row) => ({ ...row, proofSlot: 1 }));
    const when = Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000;
    const third = childBlock(paid.blocks[0], parent, again, when, potPaysFromLeaves(
      aLeavesFromShares(again),
      null,
      0,
      potSubsidyAt({
        nowMs: when,
        genesisMs: Number(decodeHeader(Buffer.from(paid.blocks[0].header)).timestamp),
        magic: MAGIC_TESTNET,
      }),
      canonicalCarry(parent.txs[0]) || 0,
    ).map((p) => ({
      ...p,
      address: again.find((row) => Buffer.from(row.noteCommit).equals(Buffer.from(p.noteCommit)))?.dest || again[0].dest,
    })));
    expectFail([...paid.blocks, third.block], /share_pow/);

    for (const dests of [1, 3, 17]) {
      const book = bookAt(dests, dests, 0, null);
      const child = book.blocks[1];
      child.aLeaves = child.aLeaves.map((leaf, i) => (
        i === 0 ? { ...leaf, count: Number(leaf.count) + 1 } : leaf
      ));
      expectFail(book.blocks, /hash_bonus/);
    }
  });

  it('hashes unproven shares when the load does not trust them', () => {
    setHashBackend('jit');
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, SHARE_FLOOR_BITS + 4, shareCreditMaxBits()];
    const spreads = [
      { dests: 1, count: 1 },
      { dests: 3, count: 4 },
      { dests: 17, count: 17 },
    ];
    for (const bits of widths) {
      for (const spread of spreads) {
        const t0 = Date.now() - 400_000;
        const genesis = genesisBlock(t0);
        const dests = Array.from({ length: spread.dests }, () => minerDest());
        const rows = [];
        let low = 1;
        for (let i = 0; i < spread.count; i += 1) {
          let row;
          do {
            row = shareRow(dests[i % dests.length], low, bits, 0);
            low += 1;
            const bound = destBoundShareHash(
              shearHash(setNonce(Buffer.from(genesis.header), BigInt(row.nonce))),
              row.noteCommit,
            );
            if (!meetsTarget(bound, bits)) break;
          } while (low < 1_000_000);
          rows.push(row);
        }
        const when = t0 + 90_000;
        const genesisDecoded = decodeHeader(Buffer.from(genesis.header));
        const subsidy = potSubsidyAt({
          nowMs: when,
          genesisMs: Number(genesisDecoded.timestamp),
          magic: MAGIC_TESTNET,
        });
        const carry = canonicalCarry(genesis.txs[0]) || 0;
        const pays = paysWithFee(rows, null, subsidy, carry, 0);
        const built = childBlock(genesis, genesis, rows, when, pays);
        const checked = verifyLoadedChain([genesis, built.block], {
          trustStoredHash: true,
          trustShareWork: false,
          nowMs: Date.now(),
        });
        assert.equal(checked.ok, false, `${bits}:${spread.dests}x${spread.count}`);
        assert.equal(checked.reason, 'share_pow');
      }
    }
    const sealed = bookAt(1, 1, 0, null);
    const dir = tmp('shear-load-share-foreign-');
    writeChainBin(path.join(dir, 'chain.bin'), sealed.blocks);
    assert.throws(() => createStore(dir), /pow/);
    assert.equal(fs.existsSync(path.join(dir, 'reserve.json')), false);
  });

  it('hashes a near-cap unproven batch on an untrusted load', () => {
    setHashBackend('jit');
    const bits = shareCreditMaxBits();
    const count = MAX_SHARES_PER_BLOCK - 1;
    const t0 = Date.now() - 400_000;
    const genesis = genesisBlock(t0);
    const dest = minerDest();
    const rows = [];
    for (let i = 0; i < count; i += 1) rows.push(shareRow(dest, i + 1, bits, 0));
    const when = t0 + 90_000;
    const genesisDecoded = decodeHeader(Buffer.from(genesis.header));
    const subsidy = potSubsidyAt({
      nowMs: when,
      genesisMs: Number(genesisDecoded.timestamp),
      magic: MAGIC_TESTNET,
    });
    const carry = canonicalCarry(genesis.txs[0]) || 0;
    const pays = paysWithFee(rows, null, subsidy, carry, 0);
    const built = childBlock(genesis, genesis, rows, when, pays);
    resetSharePowCounters();
    const t1 = Date.now();
    const checked = verifyLoadedChain([genesis, built.block], {
      trustStoredHash: true,
      trustShareWork: false,
      nowMs: Date.now(),
    });
    const ms = Date.now() - t1;
    const hashed = sharePowCounters().sync;
    assert.equal(checked.ok, false);
    assert.equal(checked.reason, 'share_pow');
    // Fail-closed on the first miss. A cold skipPow would leave this at 0.
    assert.ok(hashed >= 1, `syncSharePow ${hashed}`);
    console.log(JSON.stringify({
      event: 'load_share_near_cap', count, bits, ms, hashed, reason: checked.reason,
    }));
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash20FromAddress, newIdentity } from '../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  POOL_FEE_MAX_BPS,
  asertNextBits,
} from '../../crypto/asert.js';
import { writeChainBin, readChainBin } from '../../crypto/chainbin.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  aLeavesFromShares,
  clearLiveSharePow,
  noteCommitOfShare,
  nonceWithShareTarget,
  rememberLiveSharePow,
} from '../../crypto/share_batch.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import {
  GENESIS_PREV,
  buildTemplate,
  canonicalCarry,
  chainLoadSeal,
  digestTx,
  potPaysFromLeaves,
} from '../src/chain.js';
import { encodeWireBlock, decodeWireBlock } from '../src/p2p.js';
import { createStore } from '../src/store.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { merkleRoot } from '../../crypto/merkle.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fee-fold-keys-'));
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

function shareRow(dest, low) {
  const bits = 8;
  const row = {
    dest,
    nonce: nonceWithShareTarget(BigInt(low), bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    proofSlot: 0,
  };
  row.noteCommit = Buffer.from(noteCommitOfShare(row));
  return row;
}

function rowsFor(counts) {
  const dests = counts.map(() => minerDest());
  const rows = [];
  let low = 1;
  dests.forEach((dest, i) => {
    for (let n = 0; n < counts[i]; n += 1) {
      rows.push(shareRow(dest, low));
      low += 1;
    }
  });
  return { dests, rows };
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
  return stamped;
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

function emptyBlock(genesis, parent, when) {
  const quote = quoteFor(genesis, parent, when);
  assert.equal(quote.ok, true, quote.reason || 'asert');
  const tpl = buildTemplate({
    prev: parent.hash,
    prevHeader: parent.header,
    prevBlock: parent,
    height: Number(parent.height) + 1,
    miner: parent.miner,
    bits: quote.packed,
    now: when,
    potShares: [],
    parentBlocks: [genesis, parent].filter((b, i, all) => all.indexOf(b) === i),
  });
  return asBlock(tpl, parent.miner, tagHash());
}

function genesisBlock(when) {
  const dest = minerDest();
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner: dest,
    bits: GENESIS_BITS_PACKED,
    now: when,
    potShares: [],
  });
  return asBlock(tpl, dest, tagHash());
}

function attachPays(rows, poolDest, pays) {
  const destByNc = new Map();
  for (const row of rows) destByNc.set(Buffer.from(row.noteCommit).toString('hex'), row.dest);
  if (poolDest) {
    destByNc.set(noteCommitOfDest20(hash20FromAddress(poolDest)).toString('hex'), poolDest);
  }
  return pays.map((p) => ({
    ...p,
    address: destByNc.get(Buffer.from(p.noteCommit).toString('hex')) || '',
  })).filter((p) => p.nanos > 0 && p.address);
}

function separatePays(rows, poolDest, subsidy, carry, feeNanos) {
  const leaves = aLeavesFromShares(rows);
  return attachPays(rows, poolDest, potPaysFromLeaves(leaves, poolDest, feeNanos, subsidy, carry));
}

function foldIntoHasher(pays) {
  const fee = pays.find((p) => p.kind === 'pool-fee');
  if (!fee) return null;
  const pot = pays.find((p) => p !== fee && Buffer.from(p.noteCommit).equals(Buffer.from(fee.noteCommit)));
  if (!pot) return null;
  return pays
    .filter((p) => p !== fee)
    .map((p) => (p === pot ? { ...p, nanos: p.nanos + fee.nanos, kind: 'pot' } : p));
}

function payBlock(genesis, parent, rows, when, pays) {
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
  return asBlock(tpl, rows[0].dest, tagHash());
}

function remember(parent, rows) {
  for (const row of rows) {
    assert.equal(rememberLiveSharePow(parent.header, row.nonce, {
      noteCommit: row.noteCommit,
      shareBits: row.shareBits,
      lz: row.lz,
    }), true);
  }
}

function cloneBlocks(blocks) {
  const dir = tmp('shear-fee-fold-clone-');
  const bin = path.join(dir, 'chain.bin');
  writeChainBin(bin, blocks);
  return readChainBin(bin).map(restamp);
}

function appendAll(blocks) {
  const list = cloneBlocks(blocks);
  const dir = tmp('shear-fee-fold-live-');
  const store = createStore(dir);
  let prev = null;
  for (const block of list) {
    if (prev && block.shareBatch?.length) remember(prev, block.shareBatch);
    delete block.poolDest;
    const got = store.append(block, { trustedPowHash: block.hash });
    if (!got.ok) return { ok: false, reason: got.reason, store, dir };
    prev = block;
  }
  return { ok: true, reason: '', store, dir, height: store.tip().height };
}

function ingestChild(blocks) {
  const list = cloneBlocks(blocks);
  const parent = list[list.length - 2];
  const child = list[list.length - 1];
  const dir = tmp('shear-fee-fold-wire-');
  const store = createStore(dir);
  for (const block of list.slice(0, -1)) {
    const got = store.append(block, { trustedPowHash: block.hash });
    if (!got.ok) return { ok: false, reason: got.reason, where: 'parent' };
  }
  remember(parent, child.shareBatch || []);
  const wire = decodeWireBlock(encodeWireBlock(child));
  delete wire.poolDest;
  const got = store.ingest([wire], { trustedPowHash: child.hash });
  const done = got && typeof got.then === 'function' ? null : got;
  if (done == null) return { ok: false, reason: 'async', where: 'ingest' };
  return { ok: !!done.ok, reason: done.reason || '', height: done.ok ? store.tip().height : store.tip().height };
}

function ipcBytes(blocks) {
  const list = cloneBlocks(blocks);
  const parent = list[list.length - 2];
  const child = list[list.length - 1];
  const dir = tmp('shear-fee-fold-ipc-');
  const store = createStore(dir);
  for (const block of list.slice(0, -1)) {
    const got = store.append(block, { trustedPowHash: block.hash });
    if (!got.ok) return { ok: false, reason: got.reason };
  }
  remember(parent, child.shareBatch || []);
  const wire = decodeWireBlock(encodeWireBlock(child));
  delete wire.poolDest;
  const got = store.append(wire, { trustedPowHash: child.hash });
  return { ok: !!got.ok, reason: got.reason || '', height: store.tip().height };
}

function reload(blocks) {
  clearLiveSharePow();
  const dir = tmp('shear-fee-fold-load-');
  try {
    const stamped = sealBook(dir, blocks);
    const store = createStore(dir);
    const supply = auditCirculatingSupply(store.blocks);
    return {
      ok: true,
      reason: '',
      height: store.tip().height,
      supply: supply.status,
      blocks: stamped.length,
    };
  } catch (err) {
    return {
      ok: false,
      reason: String(err?.message || err),
      reserve: fs.existsSync(path.join(dir, 'reserve.json')),
    };
  }
}

function fourPaths(blocks, label) {
  const live = appendAll(blocks.map((b) => ({ ...b, shareBatch: (b.shareBatch || []).map((s) => ({ ...s })) })));
  const wire = ingestChild(blocks);
  const ipc = ipcBytes(blocks);
  const loaded = reload(blocks);
  return { label, live, wire, ipc, loaded };
}

describe('v12 pool fee is its own note', () => {
  it('live, wire ingest, IPC bytes, and reload agree for any fee shape', { timeout: 300_000 }, () => {
    const counts = {
      1: [1],
      3: [1, 4, 2],
      17: Array.from({ length: 17 }, (_, i) => (i === 0 ? 5 : i === 8 ? 3 : i === 16 ? 2 : 1)),
    };
    const fees = [0, 1, 100, 200];
    const spreads = [];
    for (const dests of [1, 3]) {
      for (const bps of fees) {
        for (const carry of [0, 1]) {
          spreads.push({ dests, bps, carry, kind: 'stranger' });
          spreads.push({ dests, bps, carry, kind: 'miner' });
          if (dests > 1) spreads.push({ dests, bps, carry, kind: 'other' });
        }
      }
    }
    for (const bps of [0, 200]) {
      for (const carry of [0, 1]) {
        spreads.push({ dests: 17, bps, carry, kind: 'stranger' });
        spreads.push({ dests: 17, bps, carry, kind: 'other' });
      }
    }
    spreads.push({ dests: 3, bps: 100, carry: 3, kind: 'stranger' });

    for (const spread of spreads) {
      const t0 = Date.now() - 86_400_000;
      const genesis = genesisBlock(t0);
      const chain = [genesis];
      let when = t0;
      let parent = genesis;
      for (let i = 0; i < spread.carry; i += 1) {
        when += 90_000;
        parent = emptyBlock(genesis, parent, when);
        chain.push(parent);
      }
      when += 90_000;
      const { dests, rows } = rowsFor(counts[spread.dests]);
      const genesisDecoded = decodeHeader(Buffer.from(genesis.header));
      const subsidy = potSubsidyAt({
        nowMs: when,
        genesisMs: Number(genesisDecoded.timestamp),
        magic: MAGIC_TESTNET,
      });
      const carry = canonicalCarry(parent.txs[0]) || 0;
      const feeNanos = Math.floor(subsidy * spread.bps / 10000);
      let feeDest = minerDest();
      if (spread.kind === 'miner') feeDest = rows[0].dest;
      if (spread.kind === 'other') feeDest = dests[dests.length - 1];
      let pays = feeNanos > 0
        ? separatePays(rows, feeDest, subsidy, carry, feeNanos)
        : separatePays(rows, null, subsidy, carry, 0);
      if (spread.dests === 3 && spread.bps === 200 && spread.carry === 0 && spread.kind === 'stranger') {
        pays = pays.slice().reverse();
      }
      const child = payBlock(genesis, parent, rows, when, pays);
      const potVouts = (child.txs[0].vout || []).filter((o) => o.kind === 'pot' || o.kind === 'pool-fee');
      if (feeNanos > 0) {
        assert.equal(potVouts.filter((o) => o.kind === 'pool-fee').length, 1, `${spread.dests} ${spread.kind} ${spread.bps}`);
      }
      const got = fourPaths([...chain, child], `${spread.dests}x${spread.bps} c${spread.carry} ${spread.kind}`);
      assert.equal(got.live.ok, true, `${got.label} live ${got.live.reason}`);
      assert.equal(got.wire.ok, true, `${got.label} wire ${got.wire.reason}`);
      assert.equal(got.ipc.ok, true, `${got.label} ipc ${got.ipc.reason}`);
      assert.equal(got.loaded.ok, true, `${got.label} load ${got.loaded.reason}`);
      assert.equal(got.live.height, chain.length + 1);
      assert.equal(got.wire.height, chain.length + 1);
      assert.equal(got.ipc.height, chain.length + 1);
      assert.equal(got.loaded.height, chain.length + 1);
      assert.equal(got.loaded.supply, 'verified');

      if (feeNanos > 0 && (spread.kind === 'miner' || spread.kind === 'other') && spread.bps === 100) {
        const folded = foldIntoHasher(separatePays(rows, feeDest, subsidy, carry, feeNanos));
        assert.ok(folded, got.label);
        const bad = payBlock(genesis, parent, rows, when, folded);
        const rejected = fourPaths([...chain, bad], `${got.label} fold`);
        const solo = spread.dests === 1;
        for (const path of [rejected.live, rejected.wire, rejected.ipc, rejected.loaded]) {
          if (solo) {
            assert.equal(path.ok, true, `${rejected.label} ${path.reason || ''}`);
          } else {
            assert.equal(path.ok, false, rejected.label);
            assert.match(String(path.reason || ''), /pot_prop/);
          }
        }
        if (!solo) assert.equal(rejected.loaded.reserve, false);
      }
    }

    const t0 = Date.now() - 86_400_000;
    const genesis = genesisBlock(t0);
    const when = t0 + 90_000;
    const { rows } = rowsFor([1, 4, 2]);
    const genesisDecoded = decodeHeader(Buffer.from(genesis.header));
    const subsidy = potSubsidyAt({
      nowMs: when,
      genesisMs: Number(genesisDecoded.timestamp),
      magic: MAGIC_TESTNET,
    });
    const carry = canonicalCarry(genesis.txs[0]) || 0;
    const maxFee = Math.floor(subsidy * POOL_FEE_MAX_BPS / 10000);
    const illegal = [maxFee + 1, subsidy, Math.floor((subsidy + carry) * POOL_FEE_MAX_BPS / 10000)];
    for (const feeNanos of illegal) {
      assert.ok(feeNanos > maxFee, String(feeNanos));
      const stranger = minerDest();
      const pays = separatePays(rows, stranger, subsidy, carry, feeNanos);
      const child = payBlock(genesis, genesis, rows, when, pays);
      const got = fourPaths([genesis, child], `over ${feeNanos}`);
      for (const path of [got.live, got.wire, got.ipc, got.loaded]) {
        assert.equal(path.ok, false, `${got.label} ${path.reason || 'accepted'}`);
        assert.match(String(path.reason || ''), /pot_prop/);
      }
      assert.equal(got.loaded.reserve, false);
    }
  });
});

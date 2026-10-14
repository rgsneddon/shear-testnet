import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  GENESIS_BITS_PACKED,
  MTP_FUTURE_MS,
  SAMPLE_PRUNE_CONFIRMATIONS,
  TARGET_BLOCK_INTERVAL_MS,
} from '../../crypto/asert.js';
import { writeChainBin, readChainBin } from '../../crypto/chainbin.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { sealCoinbaseNote, addExcess, noteCommitOfDest20 } from '../../crypto/note.js';
import { pruneSamples, shouldPruneSamples } from '../../crypto/chronoflux.js';
import { applyBlockToFluxset, emptyFluxset } from '../../crypto/admit.js';
import { createStore } from '../src/store.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import {
  GENESIS_PREV,
  V12_GENESIS_BLOCK_HASH,
  buildTemplate,
  chainLoadSeal,
  digestTx,
} from '../src/chain.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { bootstrapMayInstall } from '../src/bootstrap.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-seal-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function tipHex(store) {
  return Buffer.from(store.tip().hash).toString('hex');
}

let tag = 1;
function sealNext(store, dest, when) {
  const { tpl } = store.template({ miner: dest, now: when });
  const got = store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hashCredits: tpl.hashCredits,
  }, { trustedPowHash: easyPow(tag), skipSharePow: true });
  tag += 1;
  assert.equal(got.ok, true, got.reason || 'append');
  return got.block;
}

function chainOf(store) {
  const dir = tmp('shear-body-snap-');
  writeChainBin(path.join(dir, 'chain.bin'), store.blocks);
  return readChainBin(path.join(dir, 'chain.bin'));
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

function loadSealed(blocks, opts = {}) {
  const dir = tmp('shear-body-load-');
  sealBook(dir, blocks);
  return { dir, store: createStore(dir, opts) };
}

function expectLoad(blocks, re, opts = {}) {
  const dir = tmp('shear-body-bad-');
  sealBook(dir, blocks);
  assert.throws(() => createStore(dir, opts), re);
  assert.equal(fs.existsSync(path.join(dir, 'reserve.json')), false);
  return dir;
}

function unkeyedSeal(blocks) {
  const h = createHash('sha256');
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

function withTxs(block, txs) {
  const decoded = decodeHeader(Buffer.from(block.header));
  return {
    ...block,
    header: encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: merkleRoot(txs.map(digestTx)),
      continuityRoot: decoded.continuityRoot,
      timestamp: decoded.timestamp,
      bits: decoded.bits,
      nonce: decoded.nonce,
      baseFee: decoded.baseFee,
    }),
    hash: Buffer.from(block.hash),
    txs,
  };
}

function buildBook(n, dest, t0) {
  const chain = [];
  let prevHash = GENESIS_PREV;
  let prevHeader = null;
  let flux = emptyFluxset();
  for (let h = 1; h <= n; h += 1) {
    const tpl = buildTemplate({
      prev: prevHash,
      prevHeader,
      prevBlock: chain[chain.length - 1] || null,
      height: h,
      miner: dest,
      now: t0 + (h - 1) * TARGET_BLOCK_INTERVAL_MS,
      bits: GENESIS_BITS_PACKED,
      parentFluxset: flux.pubs,
      parentBlocks: chain.length ? [chain[0]] : null,
    });
    const block = {
      header: tpl.header,
      txs: tpl.txs,
      shareBatch: tpl.shareBatch || [],
      hashCredits: tpl.hashCredits,
      miner: dest,
      height: h,
      hash: easyPow(h),
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
      samples: tpl.samples,
    };
    chain.push(block);
    flux = applyBlockToFluxset(flux, block);
    prevHash = block.hash;
    prevHeader = tpl.header;
  }
  return chain;
}

function withStamp(block, timestamp) {
  const decoded = decodeHeader(Buffer.from(block.header));
  return {
    ...block,
    header: encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: decoded.merkleRoot,
      continuityRoot: decoded.continuityRoot,
      timestamp,
      bits: decoded.bits,
      nonce: decoded.nonce,
      baseFee: decoded.baseFee,
    }),
    hash: Buffer.from(block.hash),
    txs: block.txs,
  };
}

describe('foreign load checks the block body before the vault boots', () => {
  it('reloads an honest book and rejects mint, range, credit, and owed lies', () => {
    assert.equal(V12_GENESIS_BLOCK_HASH, '');
    const dest = minerDest();
    const dir = tmp('shear-body-honest-');
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    sealNext(store, dest, t0);
    sealNext(store, dest, t0 + TARGET_BLOCK_INTERVAL_MS);
    sealNext(store, dest, t0 + 2 * TARGET_BLOCK_INTERVAL_MS);
    const honestTip = tipHex(store);
    const supplyBefore = auditCirculatingSupply(store.blocks);
    assert.equal(supplyBefore.status, 'verified', supplyBefore.reason);

    const again = createStore(dir);
    assert.equal(tipHex(again), honestTip);
    const supplyAgain = auditCirculatingSupply(again.blocks);
    assert.equal(supplyAgain.status, 'verified', supplyAgain.reason);
    assert.equal(supplyAgain.circulatingNanos, supplyBefore.circulatingNanos);

    const snap = chainOf(store);
    for (const n of [1, 2, 3]) {
      const prefix = loadSealed(snap.slice(0, n));
      assert.equal(prefix.store.tip().height, n);
      const got = auditCirculatingSupply(prefix.store.blocks);
      assert.equal(got.status, 'verified', got.reason);
    }

    const head = snap[0];
    for (const amount of [1, 2_000_000_000, 100_000_000_000]) {
      const extra = sealCoinbaseNote(amount, { kind: 'pot' });
      const tx0 = head.txs[0];
      const txs = [{
        ...tx0,
        vout: tx0.vout.concat([extra]),
        excess: addExcess(tx0.excess, extra.r),
      }, ...head.txs.slice(1)];
      expectLoad([withTxs(head, txs)], /pot/);
    }
    const strippedTx = {
      ...head.txs[0],
      vout: head.txs[0].vout.map((o, i) => (
        i === 0 ? { ...o, rangeProof: Buffer.alloc(0) } : o
      )),
    };
    expectLoad([withTxs(head, [strippedTx, ...head.txs.slice(1)])], /coinbase_output/);

    const bare = {
      kind: 'pay',
      vin: [{ n: 0 }],
      vout: [{ commit: Buffer.alloc(32, 7), rangeProof: Buffer.alloc(4) }],
    };
    expectLoad([withTxs(head, [head.txs[0], bare])], /range_proof/);

    const creditDest = Buffer.alloc(20, 4);
    const forgedCredit = {
      ...head,
      hashCredits: [{
        noteCommit: noteCommitOfDest20(creditDest),
        dest20: creditDest,
        nanos: 1n,
      }],
    };
    expectLoad([forgedCredit], /hash_owed/);

    const forgedRoot = withTxs(head, [{
      ...head.txs[0],
      hashOwedRoot: Buffer.alloc(32, 9),
    }, ...head.txs.slice(1)]);
    expectLoad([forgedRoot], /hash_owed/);

    const supplyAfter = auditCirculatingSupply(store.blocks);
    assert.equal(supplyAfter.status, 'verified', supplyAfter.reason);
    assert.equal(supplyAfter.circulatingNanos, supplyBefore.circulatingNanos);
    assert.equal(fs.existsSync(path.join(dir, 'reserve.json')), true);
  });

  it('pins a v12 genesis hash and a checkpoint, and refuses a lower-work install', () => {
    const dest = minerDest();
    const dir = tmp('shear-body-pin-');
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    sealNext(store, dest, t0);
    sealNext(store, dest, t0 + TARGET_BLOCK_INTERVAL_MS);
    const snap = chainOf(store);
    const genesis = Buffer.from(snap[0].hash).toString('hex');
    const wrong = 'ab'.repeat(32);
    expectLoad(snap, /genesis/, { genesisHash: wrong });
    const pinned = loadSealed(snap, { genesisHash: genesis });
    assert.equal(pinned.store.tip().height, 2);
    expectLoad(snap, /checkpoint/, {
      checkpoint: { height: 2, hash: wrong },
    });
    const checked = loadSealed(snap, {
      genesisHash: genesis,
      checkpoint: { height: 1, hash: genesis },
    });
    assert.equal(checked.store.tip().height, 2);
    expectLoad(snap.slice(0, 1), /checkpoint/, {
      checkpoint: { height: 2, hash: genesis },
    });
    assert.equal(bootstrapMayInstall(snap, snap).ok, false);
    assert.equal(bootstrapMayInstall([], []).ok, false);
    const allowed = bootstrapMayInstall([], snap);
    assert.equal(allowed.ok, true);
    assert.ok(allowed.work > 0n);
  });

  it('bounds every load stamp by the clock plus the consensus future limit', () => {
    const clock = 1_800_000_000_000;
    const dest = minerDest();
    const dir = tmp('shear-body-time-');
    const store = createStore(dir);
    const block = sealNext(store, dest, clock - MTP_FUTURE_MS);
    const snap = chainOf(store);
    const inside = loadSealed([withStamp(snap[0], clock + 8 * TARGET_BLOCK_INTERVAL_MS)], {
      loadNowMs: clock,
    });
    assert.equal(inside.store.tip().height, 1);
    assert.equal(Buffer.from(block.hash).length, 32);
    const spacings = [
      MTP_FUTURE_MS + 1,
      2 * MTP_FUTURE_MS,
      10 * MTP_FUTURE_MS,
    ];
    for (const gap of spacings) {
      const header = encodeHeader({
        prevBlockHash: GENESIS_PREV,
        merkleRoot: Buffer.alloc(32),
        continuityRoot: Buffer.alloc(32),
        timestamp: clock + gap,
        bits: GENESIS_BITS_PACKED,
      });
      const row = {
        height: 1,
        header,
        hash: Buffer.alloc(32, 1),
        txs: [{ coinbase: true, vout: [{ kind: 'pot' }] }],
      };
      const bad = tmp('shear-body-future-');
      writeChainBin(path.join(bad, 'chain.bin'), [row]);
      assert.throws(() => createStore(bad, { loadNowMs: clock }), /timestamp/);
      assert.equal(fs.existsSync(path.join(bad, 'reserve.json')), false);
    }
  });

  it('a copied or unkeyed seal does not skip header work', () => {
    const dest = minerDest();
    const dir = tmp('shear-body-copy-');
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    sealNext(store, dest, t0);
    const snap = chainOf(store);
    const copied = tmp('shear-body-copied-');
    writeChainBin(path.join(copied, 'chain.bin'), snap);
    fs.copyFileSync(path.join(dir, 'book.seal'), path.join(copied, 'book.seal'));
    assert.throws(() => createStore(copied), /pow/);
    assert.equal(fs.existsSync(path.join(copied, 'reserve.json')), false);

    const rewritten = withTxs(snap[0], [{
      ...snap[0].txs[0],
      hashOwedRoot: Buffer.alloc(32, 6),
    }, ...snap[0].txs.slice(1)]);
    const forged = tmp('shear-body-unkeyed-');
    writeChainBin(path.join(forged, 'chain.bin'), [rewritten]);
    fs.writeFileSync(path.join(forged, 'book.seal'), `${unkeyedSeal([rewritten])}\n`);
    assert.throws(() => createStore(forged), /pow/);
    assert.equal(fs.existsSync(path.join(forged, 'reserve.json')), false);

    expectLoad([rewritten], /hash_owed/);
  });

  it('accepts a pruned book across the burial depth and still binds a forged credit', { timeout: 900_000 }, () => {
    const dest = minerDest();
    const t0 = 1_700_000_000_000;
    const depth = SAMPLE_PRUNE_CONFIRMATIONS;
    const lengths = [1, 3, depth, depth + 1];
    const want = lengths[lengths.length - 1];
    const snap = buildBook(want, dest, t0);
    assert.equal(snap.length, want);
    assert.equal(snap[snap.length - 1].height, want);
    const tipH = snap[snap.length - 1].height;
    const pruned = snap.map((b) => (
      shouldPruneSamples(b.height, tipH, depth) ? pruneSamples(b) : b
    ));
    assert.equal(pruned.some((b) => b.samplesPruned === true), true);
    assert.equal(pruned[pruned.length - 1].samplesPruned === true, false);
    const loadStarted = Date.now();
    const loaded = loadSealed(pruned);
    const supply = auditCirculatingSupply(loaded.store.blocks);
    console.log(JSON.stringify({
      event: 'load_body',
      blocks: want,
      pruned: true,
      ms: Date.now() - loadStarted,
      supply: supply.status,
    }));
    assert.equal(loaded.store.tip().height, want);
    assert.equal(supply.status, 'verified', supply.reason);
    const buried = pruned.find((b) => b.samplesPruned === true);
    const buriedDest = Buffer.alloc(20, 5);
    const forged = {
      ...buried,
      hashCredits: [{
        noteCommit: noteCommitOfDest20(buriedDest),
        dest20: buriedDest,
        nanos: 9n,
      }],
    };
    const swapped = pruned.map((b) => (b.height === forged.height ? forged : b));
    expectLoad(swapped, /hash_owed/);
    for (const n of lengths) {
      if (n === want) continue;
      const tipAt = pruned[n - 1].height;
      const slice = pruned.slice(0, n).map((b) => {
        if (b.height === tipAt) {
          return snap[n - 1];
        }
        return shouldPruneSamples(b.height, tipAt, depth) ? b : snap[b.height - 1];
      });
      const prefixStarted = Date.now();
      const prefix = loadSealed(slice);
      console.log(JSON.stringify({
        event: 'load_body',
        blocks: n,
        ms: Date.now() - prefixStarted,
      }));
      assert.equal(prefix.store.tip().height, n);
      const prefixSupply = auditCirculatingSupply(prefix.store.blocks);
      assert.equal(prefixSupply.status, 'verified', prefixSupply.reason);
    }
  });
});

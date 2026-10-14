/**
 * Boot-verify accept/reject matches the synchronous load path, and a timer
 * on the event loop runs while the worker walks a short book.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  TARGET_BLOCK_INTERVAL_MS,
} from '../../crypto/asert.js';
import { applyBlockToFluxset, emptyFluxset } from '../../crypto/admit.js';
import { readChainBin, writeChainBin } from '../../crypto/chainbin.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import {
  GENESIS_PREV,
  buildTemplate,
  digestTx,
  verifyLoadedChain,
  verifyLoadedChainAsync,
} from '../src/chain.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let tagN = 1;
function tagHash() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(tagN, 4);
  tagN += 1;
  assert.equal(meetsTarget(h, GENESIS_BITS_PACKED), true);
  return h;
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

/** The same short book the foreign-replay test loads from chain.bin. */
function loadBook(n) {
  const dest = minerDest();
  const chain = [];
  let prevHash = GENESIS_PREV;
  let prevHeader = null;
  let flux = emptyFluxset();
  const t0 = 1_700_000_000_000;
  for (let h = 1; h <= n; h += 1) {
    const now = t0 + (h - 1) * TARGET_BLOCK_INTERVAL_MS;
    const genesisMs = h === 1 ? now : Number(decodeHeader(Buffer.from(chain[0].header)).timestamp);
    const subsidy = potSubsidyAt({ nowMs: now, genesisMs, magic: MAGIC_TESTNET });
    const tpl = buildTemplate({
      prev: prevHash,
      prevHeader,
      prevBlock: chain[chain.length - 1] || null,
      height: h,
      miner: dest,
      now,
      bits: GENESIS_BITS_PACKED,
      potShares: [{ address: dest, nanos: subsidy, kind: 'pot' }],
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
      hash: tagHash(),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-verify-'));
  const bin = path.join(dir, 'chain.bin');
  writeChainBin(bin, chain);
  const stamped = readChainBin(bin).map(restamp);
  writeChainBin(bin, stamped);
  return readChainBin(bin);
}

function view(got) {
  return {
    ok: got?.ok === true,
    reason: got?.reason || '',
    genesisMs: Number(got?.genesisMs) || 0,
    height: Number(got?.supply?.height) || 0,
  };
}

describe('boot-verify worker', () => {
  const nowMs = 1_800_000_000_000;
  const opts = { trustStoredHash: true, nowMs };
  const book = loadBook(4);

  it('matches the synchronous load on a good book and on a bad height', async () => {
    const sync = verifyLoadedChain(structuredClone(book), opts);
    const asyncGot = await verifyLoadedChainAsync(structuredClone(book), opts);
    assert.equal(sync.ok, true, sync.reason || 'sync');
    assert.deepEqual(view(asyncGot), view(sync));

    const bad = structuredClone(book);
    bad[1].height = 9;
    const syncBad = verifyLoadedChain(structuredClone(bad), opts);
    const asyncBad = await verifyLoadedChainAsync(structuredClone(bad), opts);
    assert.equal(syncBad.ok, false);
    assert.equal(syncBad.reason, 'height');
    assert.deepEqual(view(asyncBad), view(syncBad));
  });

  it('lets an event-loop timer run during a multi-block verify', async () => {
    const heights = [];
    const lines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, enc, cb) => {
      lines.push(String(chunk));
      return orig(chunk, enc, cb);
    };
    let turns = 0;
    let stop = false;
    const spin = () => {
      if (stop) return;
      turns += 1;
      setImmediate(spin);
    };
    setImmediate(spin);
    try {
      const got = await verifyLoadedChainAsync(structuredClone(book), {
        ...opts,
        onProgress: (p) => heights.push(p.height),
      });
      assert.equal(got.ok, true, got.reason || 'replay');
    } finally {
      stop = true;
      process.stderr.write = orig;
    }
    assert.ok(turns >= 2, `turns ${turns}`);
    assert.deepEqual(heights, [1, 2, 3, 4]);
    assert.ok(lines.some((l) => l.includes('book-replay 1/4')));
    assert.ok(lines.some((l) => l.includes('book-replay 4/4')));
    console.log(`boot-verify-timer turns ${turns}`);
  });

  it('keeps an empty book on the caller', async () => {
    const sync = verifyLoadedChain([], opts);
    const asyncGot = await verifyLoadedChainAsync([], opts);
    assert.deepEqual(asyncGot, sync);
    assert.equal(asyncGot.ok, true);
  });
});

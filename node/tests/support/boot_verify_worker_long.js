/**
 * Sealed restart one block past the sample-prune depth. The synchronous
 * createStore and the worker restart run in separate processes so the walk
 * is not paid twice on the wall clock. Native shearadmit is required: the
 * JS range verifier cannot finish 1001 blocks inside a 10-minute cap.
 */
import { performance } from 'node:perf_hooks';
import { fork } from 'node:child_process';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  SAMPLE_PRUNE_CONFIRMATIONS,
  TARGET_BLOCK_INTERVAL_MS,
} from '../../../crypto/asert.js';
import { applyBlockToFluxset, emptyFluxset } from '../../../crypto/admit.js';
import { readChainBin, writeChainBin } from '../../../crypto/chainbin.js';
import { destForLogin } from '../../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../../crypto/header.js';
import { merkleRoot } from '../../../crypto/merkle.js';
import { nativeLoaded } from '../../../crypto/native_admit.js';
import { meetsTarget } from '../../../crypto/shear_hash.js';
import { potSubsidyAt } from '../../../crypto/pot_sched.js';
import { encodeRecord } from '../../../crypto/blunote.js';
import { bookSealKeyFor } from '../../src/book_seal_key.js';
import {
  GENESIS_PREV,
  buildTemplate,
  chainLoadSeal,
  digestTx,
} from '../../src/chain.js';

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

// R28: every block here is an empty round with no fee key, so its record
// is the empty one: no batch, no fee note, no winners. A child's coinbase
// binds it (blunote_prev), and the load re-derives and checks it.
const EMPTY_RECORD = encodeRecord({
  batchRoot: Buffer.alloc(32), n: 0, W: 0n, T: 0n, feeV: 0n, feeR: null, feeP: null, winners: [],
}).toString('hex');

function buildBook(n) {
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
    chain.push({
      header: tpl.header,
      txs: tpl.txs,
      shareBatch: tpl.shareBatch || [],
      hashCredits: tpl.hashCredits,
      height: h,
      hash: tagHash(),
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
      samples: tpl.samples,
      blunoteRecord: EMPTY_RECORD,
    });
    flux = applyBlockToFluxset(flux, chain[chain.length - 1]);
    prevHash = chain[chain.length - 1].hash;
    prevHeader = tpl.header;
  }
  return chain;
}

function openStore(dir, yieldForeign, loadNowMs) {
  const child = fork(new URL('./boot_verify_open_store.js', import.meta.url), [], {
    execArgv: [],
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    child.on('message', (msg) => {
      settled = true;
      if (msg?.error) reject(new Error(msg.error));
      else resolve(msg);
    });
    child.on('error', (err) => {
      if (!settled) reject(err);
    });
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`store child exit ${code}`));
    });
    child.send({
      dir,
      yieldForeign,
      loadNowMs,
      magic: MAGIC_TESTNET,
      oracleActivationHeight: 100_000,
    });
  });
}

describe('sealed restart past 1000 blocks', () => {
  const nowMs = 1_800_000_000_000;

  before(() => {
    process.env.SHEAR_SEAL_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-seal-long-'));
  });

  it('matches the synchronous load', {
    timeout: 600_000,
    skip: nativeLoaded() ? false : 'native shearadmit.node required; the JS range verifier cannot walk 1001 blocks inside the auditor cap',
  }, async () => {
    const n = SAMPLE_PRUNE_CONFIRMATIONS + 1;
    assert.equal(n, 1001);
    const started = performance.now();
    const built = buildBook(n);
    const packedAt = performance.now();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-long-src-'));
    const bin = path.join(scratch, 'chain.bin');
    writeChainBin(bin, built);
    const loaded = readChainBin(bin).map(restamp);
    writeChainBin(bin, loaded);
    const bytes = fs.readFileSync(bin);
    function sealCopy(dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'chain.bin'), bytes);
      const blocks = readChainBin(path.join(dir, 'chain.bin'));
      const key = bookSealKeyFor(dir);
      fs.writeFileSync(path.join(dir, 'book.seal'), `${chainLoadSeal(blocks, key, MAGIC_TESTNET)}\n`);
    }
    const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-long-sync-'));
    const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-long-async-'));
    sealCopy(syncDir);
    sealCopy(asyncDir);
    const sealedAt = performance.now();
    const [sync, asyncStore] = await Promise.all([
      openStore(syncDir, false, nowMs),
      openStore(asyncDir, true, nowMs),
    ]);
    assert.equal(sync.loadMode, 'full', 'main thread rejected the sealed book');
    assert.equal(asyncStore.loadMode, 'full');
    assert.equal(sync.height, n);
    assert.equal(asyncStore.height, n);
    assert.equal(asyncStore.tip, sync.tip);
    assert.equal(sync.status, 'verified', sync.reason);
    assert.equal(asyncStore.status, 'verified', asyncStore.reason);
    assert.equal(asyncStore.circulating, sync.circulating);
    const done = performance.now();
    console.log(
      `boot-verify-1001 ms ${Math.round(done - started)} `
      + `build ${Math.round(packedAt - started)} seal ${Math.round(sealedAt - packedAt)} `
      + `open ${Math.round(done - sealedAt)}`,
    );
  });
});

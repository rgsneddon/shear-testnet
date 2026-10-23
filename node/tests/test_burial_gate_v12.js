/**
 * Inbox 052, the P2P burial gate.
 * A peer height field is not burial. The local tip does not bury a block
 * on a shorter candidate chain. samplesPruned still needs this chain's
 * own tip and SAMPLE_PRUNE_CONFIRMATIONS.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { VERSION, encodeHeader } from '../../crypto/header.js';
import { GENESIS_BITS_PACKED, MAGIC_TESTNET } from '../../crypto/asert.js';
import { decodeWireBlock, encodeWireBlock } from '../src/p2p.js';
import { applyVerifiedIpcBlock } from '../src/p2p_ipc.js';
import { verifyBlock } from '../src/chain.js';
import { createStore } from '../src/store.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function genesisBody(store, dest) {
  const { tpl } = store.template({
    miner: dest,
    now: 1_700_000_000_000,
    shareBatch: [],
  });
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: [],
    shareBatch: [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hashCredits: tpl.hashCredits,
    samplesPruned: true,
  };
}

describe('v12 P2P burial gate', () => {
  it('rejects a peer height before it can open burial', async () => {
    const dest = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-burial-gate-'));
    const store = createStore(dir);
    const body = genesisBody(store, dest);
    const opts = {
      trustedPowHash: easyPow(3),
      skipSharePow: true,
      nowMs: 1_700_000_000_000,
      tipHeight: 1_000_000,
    };
    for (const lied of [2, 80_000, 0]) {
      const got = verifyBlock({ ...body, height: lied }, null, opts);
      assert.equal(got.ok, false, `genesis height ${lied} ${got.reason}`);
      assert.equal(got.reason, 'height', `genesis height ${lied}`);
    }
    const matched = verifyBlock({ ...body, height: 1 }, null, opts);
    assert.equal(matched.ok, false, matched.reason);
    assert.equal(matched.reason, 'samples_pruned');
    const omitted = verifyBlock(body, null, opts);
    assert.equal(omitted.ok, false, omitted.reason);
    assert.equal(omitted.reason, 'samples_pruned');

    const parentHash = Buffer.alloc(32, 9);
    const childHeader = encodeHeader({
      version: VERSION,
      prevBlockHash: parentHash,
      merkleRoot: Buffer.alloc(32, 1),
      continuityRoot: Buffer.alloc(32, 2),
      timestamp: 1_700_000_090_000n,
      bits: GENESIS_BITS_PACKED,
      nonce: 0n,
      baseFee: 1n,
    });
    const parent = { hash: parentHash, height: 5, header: Buffer.alloc(128) };
    for (const lied of [1, 5, 80_000]) {
      const got = verifyBlock({
        ...body,
        header: childHeader,
        height: lied,
      }, parent, opts);
      assert.equal(got.ok, false, `child height ${lied} ${got.reason}`);
      assert.equal(got.reason, 'height', `child height ${lied}`);
    }

    const ingested = store.ingest([{ ...body, height: 80_000, hash: easyPow(5) }], {
      trustedPowHash: easyPow(5),
      skipSharePow: true,
    });
    assert.equal(ingested.ok, false, ingested.reason);
    assert.equal(ingested.reason, 'height');
    assert.equal(store.tip(), null);

    const viaIpc = applyVerifiedIpcBlock(store, {
      type: 'ipc_block',
      magic: MAGIC_TESTNET,
      block: encodeWireBlock({ ...body, height: 80_000, hash: easyPow(6) }),
      powHash: easyPow(6).toString('hex'),
    });
    assert.equal(viaIpc.ok, false, viaIpc.reason);
    assert.equal(viaIpc.reason, 'height');
    const wired = decodeWireBlock(encodeWireBlock({ ...body, height: 1, hash: easyPow(7) }));
    assert.equal(wired.samplesPruned, true);
    assert.equal(wired.height, 1);
    // No ipc_headers run. The claimed hash is not the header hash, so append
    // rejects it before burial. Pruned IPC blocks verify off the loop.
    const viaIpcPruned = await applyVerifiedIpcBlock(store, {
      type: 'ipc_block',
      magic: MAGIC_TESTNET,
      block: encodeWireBlock({ ...body, height: 1, hash: easyPow(7) }),
      powHash: easyPow(7).toString('hex'),
    });
    assert.equal(viaIpcPruned.ok, false, viaIpcPruned.reason);
    assert.equal(viaIpcPruned.reason, 'hash_claim');
    assert.equal(store.tip(), null);
  });

  it('does not bury a new block under the local tip', () => {
    const storeSrc = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const forkAt = storeSrc.indexOf('function forkBurial');
    const supplyAt = storeSrc.indexOf('function supplyCarriedTo');
    assert.ok(forkAt > 0 && supplyAt > forkAt);
    const forkSrc = storeSrc.slice(forkAt, supplyAt);
    assert.match(forkSrc, /fork\.length/);
    assert.doesNotMatch(forkSrc, /Math\.max/);
    assert.doesNotMatch(storeSrc, /shouldPruneSamples\(incomingH/);
    assert.match(storeSrc, /candidateTip/);
    assert.match(storeSrc, /suffixBurial/);
    assert.doesNotMatch(storeSrc, /Math\.max\(storeTip/);
    assert.doesNotMatch(storeSrc, /Math\.max\(oldTip/);
    assert.match(storeSrc, /peer-advertised height must not prune/);
    const chainSrc = fs.readFileSync(new URL('../src/chain.js', import.meta.url), 'utf8');
    assert.match(chainSrc, /reason: 'height'/);
    const ipcSrc = fs.readFileSync(new URL('../src/p2p_ipc.js', import.meta.url), 'utf8');
    assert.match(ipcSrc, /structuralH = tipH \+ 1/);
    assert.match(ipcSrc, /reason: 'height'/);
  });
});

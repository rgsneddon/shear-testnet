/**
 * A b-spend signature is checked on the sealed body.
 * compactTx keeps the vin bytes spendPackDigest hashes.
 * Live append, restart replay, fresh IBD, and snapshot load share that verdict.
 * Stripping spendPub is unsigned on every one of those paths.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { bProof, bindBSpend, buildDualTree, chainBSpendsRejected } from '../../crypto/clearing.js';
import { compactTx, leanBlock } from '../../crypto/chronoflux.js';
import { writeChainBin } from '../../crypto/chainbin.js';
import { encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { hash20FromAddress } from '../../crypto/address.js';
import { signSpendTx } from '../../crypto/spend.js';
import { digestTx, chainLoadSeal } from '../src/chain.js';
import { bookSealKeyFor } from '../src/book_seal_key.js';
import { createStore } from '../src/store.js';
import { encodeWireBlock, decodeWireBlock, jsonWire } from '../src/p2p.js';
import {
  asBlock,
  easyPowHash,
  openStore,
  payerIdentity,
  sealEmpty,
  sealMintOut,
  templateOn,
} from './b_leaf_fund.js';

function reasonOf(got) {
  return got?.ok ? '' : (got?.reason || '');
}

function copyChain(blocks) {
  return blocks.map((b) => ({ ...b, txs: (b.txs || []).map((tx) => ({ ...tx })) }));
}

function reseal(dir, blocks) {
  writeChainBin(path.join(dir, 'chain.bin'), blocks);
  const key = bookSealKeyFor(dir);
  fs.writeFileSync(path.join(dir, 'book.seal'), `${chainLoadSeal(blocks, key)}\n`);
}

function openResealed(blocks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-seal-'));
  reseal(dir, blocks);
  return createStore(dir, { pruneAfter: 1_000_000 });
}

function wireIngest(store, block, pow) {
  const decoded = decodeWireBlock(JSON.parse(jsonWire(encodeWireBlock({ ...block, hash: pow }))));
  return Promise.resolve(store.ingest([decoded], { trustedPowHash: pow, skipSharePow: true }))
    .then((got) => ({ got, decoded }));
}

describe('sealed b-spend signature', () => {
  it('replay and fresh IBD use the same verdict as the live body', { timeout: 180_000 }, async () => {
    assert.equal(SPENDABLE_CONFIRMATIONS, 9);
    const owner = payerIdentity();
    const dest20 = Buffer.from(hash20FromAddress(owner.dest));
    const leaf = {
      dest20,
      unit: 9,
      nonce: 1,
      memoH: Buffer.alloc(32),
      tag: 'b',
    };
    const tree = buildDualTree({ aLeaves: [], bLeaves: [leaf] });
    const commit = {
      height: 1,
      header: encodeHeader({
        prevBlockHash: Buffer.alloc(32),
        merkleRoot: Buffer.alloc(32),
        continuityRoot: tree.continuityRoot,
        timestamp: 1n,
        bits: 14,
        nonce: 0n,
        baseFee: 1n,
      }),
      rootA: tree.rootA,
      rootB: tree.rootB,
    };
    const out = sealMintOut(9, owner.dest, 'b-spend');
    const tx = {
      id: 'bspend-honest',
      kind: 'b-spend',
      from: owner.dest,
      fee: 0,
      commitHeight: 1,
      leaf,
      proof: bProof([leaf], 0),
      index: 0,
      vin: [{ address: owner.dest }],
      vout: [out],
    };
    signSpendTx(tx, owner.key, { magic: 'shear-testnet-v12' });
    const tipHeight = 9;
    const raw = bindBSpend(tx, { history: [commit], tipHeight, spent: new Set() });
    assert.equal(raw.ok, true, raw.reason);
    const sealed = compactTx(tx);
    const again = compactTx(sealed);
    assert.equal(merkleRoot([digestTx(tx)]).equals(merkleRoot([digestTx(sealed)])), true);
    assert.equal(merkleRoot([digestTx(sealed)]).equals(merkleRoot([digestTx(again)])), true);
    const sealedBind = bindBSpend(sealed, { history: [commit], tipHeight, spent: new Set() });
    assert.equal(sealedBind.ok, true, sealedBind.reason);
    const twice = bindBSpend(again, { history: [commit], tipHeight, spent: new Set() });
    assert.equal(twice.ok, true, twice.reason);
    assert.ok(sealed.vin?.[0]?.dest20, 'compact vin dropped dest20');
    assert.equal(sealed.sig, tx.sig);
    const stripped = compactTx(tx);
    delete stripped.spendPub;
    delete stripped.sig;
    const strippedBind = bindBSpend(stripped, { history: [commit], tipHeight, spent: new Set() });
    assert.equal(strippedBind.ok, false);
    assert.equal(strippedBind.reason, 'unsigned');

    const book = openStore('shear-bspend-seal-');
    try {
      const genesis = await sealEmpty(book.store, owner.dest);
      assert.equal(genesis.ok, true, genesis.reason);
      while ((book.store.tip()?.height || 0) < SPENDABLE_CONFIRMATIONS - 1) {
        const pad = await sealEmpty(book.store, owner.dest);
        assert.equal(pad.ok, true, pad.reason);
      }
      assert.equal(book.store.tip().height, 8);
      const tpl = templateOn(book.store, { miner: owner.dest, txs: [tx] });
      const full = asBlock(tpl);
      const live = await Promise.resolve(book.store.probeBlock(full));
      const lean = await Promise.resolve(book.store.probeBlock(leanBlock({
        ...full,
        hash: Buffer.alloc(32),
        height: book.store.tip().height + 1,
      })));
      assert.equal(live.ok, false, live.reason);
      assert.equal(reasonOf(live), reasonOf(lean), `${reasonOf(live)} vs ${reasonOf(lean)}`);
      assert.equal(reasonOf(live), 'proof', reasonOf(live));
      assert.notEqual(reasonOf(lean), 'unsigned');

      const fresh = openResealed(book.store.blocks);
      assert.equal(fresh.tip().height, 8);
      const pow = easyPowHash();
      const ibd = await wireIngest(fresh, full, pow);
      assert.equal(ibd.got.ok, false, ibd.got.reason);
      assert.equal(reasonOf(ibd.got), reasonOf(live), ibd.got.reason);
      const wireVin = ibd.decoded.txs.find((row) => row && row.kind === 'b-spend')?.vin?.[0];
      assert.ok(wireVin?.dest20, 'wire vin dropped dest20');

      const replayBlocks = copyChain(book.store.blocks);
      replayBlocks.push(leanBlock({
        ...full,
        hash: easyPowHash(),
        height: replayBlocks.length + 1,
      }));
      assert.equal(chainBSpendsRejected(replayBlocks)?.reason, 'proof');
      const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-replay-'));
      reseal(replayDir, replayBlocks);
      assert.throws(() => createStore(replayDir, { pruneAfter: 1_000_000 }), /proof/);

      const dropped = { ...tx, id: 'bspend-bare' };
      delete dropped.spendPub;
      delete dropped.sig;
      const droppedTpl = asBlock(templateOn(book.store, { miner: owner.dest, txs: [dropped] }));
      const droppedLive = await Promise.resolve(book.store.probeBlock(droppedTpl));
      const droppedLean = await Promise.resolve(book.store.probeBlock(leanBlock({
        ...droppedTpl,
        hash: Buffer.alloc(32),
        height: book.store.tip().height + 1,
      })));
      assert.equal(droppedLive.reason, 'unsigned');
      assert.equal(droppedLean.reason, 'unsigned');
      const droppedIbd = await wireIngest(openResealed(book.store.blocks), droppedTpl, easyPowHash());
      assert.equal(droppedIbd.got.reason, 'unsigned', droppedIbd.got.reason);
      const bareBlocks = copyChain(book.store.blocks);
      bareBlocks.push(leanBlock({
        ...droppedTpl,
        hash: easyPowHash(),
        height: bareBlocks.length + 1,
      }));
      assert.equal(chainBSpendsRejected(bareBlocks)?.reason, 'unsigned');
      const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-bspend-bare-'));
      reseal(bareDir, bareBlocks);
      assert.throws(() => createStore(bareDir, { pruneAfter: 1_000_000 }), /unsigned/);

      const snapped = createStore(book.dir, { pruneAfter: 1_000_000 });
      assert.equal(snapped.tip().height, book.store.tip().height);
      assert.equal(chainBSpendsRejected(snapped.blocks), null);
    } finally {
      book.close();
    }
  });
});

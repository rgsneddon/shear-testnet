import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { findShare, dest20OfShare } from '../../crypto/share_batch.js';
import { unpackShareBatch, unpackShareBatchBytes, shareRowJson } from '../../crypto/pack.js';
import { compactChainBlock } from '../../crypto/chronoflux.js';
import { encodeWireBlock, decodeWireBlock } from '../src/p2p.js';
import { createStore } from '../src/store.js';
import { coinbaseSplit } from '../../crypto/mint.js';

function destOf(byte) {
  return encodeDest(Buffer.alloc(20, byte));
}

let powTag = 1;
function mineAppend(store, { miner, shareBatch = [], poolDest = null, now }) {
  const { tpl } = store.template({
    miner,
    shareBits: SHARE_FLOOR_BITS,
    shareBatch,
    poolDest,
    now,
  });
  const pow = Buffer.alloc(32, 0);
  pow[31] = powTag;
  powTag += 1;
  return store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || shareBatch,
    miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
  }, { trustedPowHash: pow });
}

describe('shareBatch on disk and p2p wire', () => {
  it('unpackShareBatch accepts 40-char dest20 hex', () => {
    const dest = destOf(7);
    const d20 = dest20OfShare({ dest });
    const row = shareRowJson({ dest, dest20: d20, nonce: 99n, lz: 8 });
    assert.equal(String(row.noteCommit).length, 64);
    assert.equal(row.dest20, undefined);
    const [got] = unpackShareBatch([row]);
    assert.equal(got.noteCommit.length, 32);
    assert.equal(got.nonce, 99n);
  });

  it('a second store appends a hash-bonus block from encodeWireBlock', async () => {
    const hasher = destOf(5);
    const pool = destOf(9);
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wire-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wire-b-'));
    const a = createStore(dirA);
    const b = createStore(dirB);
    const t0 = 1_700_000_000_000;
    const first = mineAppend(a, { miner: hasher, now: t0 });
    assert.equal(first.ok, true, first.reason);
    const cloned = {
      header: first.block.header,
      txs: first.block.txs,
      samples: first.block.samples || [],
      shareBatch: first.block.shareBatch || [],
      miner: hasher,
      aLeaves: first.block.aLeaves,
      bLeaves: first.block.bLeaves,
      rootA: first.block.rootA,
      rootB: first.block.rootB,
    };
    const b1 = b.append(cloned, { trustedPowHash: Buffer.from(first.block.hash) });
    assert.equal(b1.ok, true, b1.reason);

    const share = findShare(first.block.header, {
      dest: hasher,
      dest20: dest20OfShare({ dest: hasher }),
      floorBits: SHARE_FLOOR_BITS,
      maxTries: 2_000_000,
    });
    assert.ok(share, 'need floor-8 lag-1 share');
    const second = mineAppend(a, {
      miner: hasher,
      shareBatch: [{
        dest: hasher,
        dest20: share.dest20,
        nonce: share.nonce,
        lz: share.lz,
        shareBits: share.shareBits || share.lz,
        proofSlot: 0,
      }],
      poolDest: pool,
      now: t0 + 90_000,
    });
    assert.equal(second.ok, true, second.reason);
    assert.ok((second.block.shareBatch || []).length >= 1, 'sealed block keeps shareBatch');
    const split = coinbaseSplit(second.block.txs[0], {
      shareBatch: second.block.shareBatch,
      miner: hasher,
    });
    assert.ok(split.hashNanos > 0, 'lag-1 hash bonus is a sealed note, not public nanos');
    assert.equal(split.hashByMiner[hasher] > 0, true);
    assert.ok((second.block.txs[0].vout || []).some((o) => o.kind === 'hash' && o.commit));

    const compact = compactChainBlock(second.block);
    const packedShares = unpackShareBatchBytes(Buffer.from(compact.sharePacked, 'hex'));
    assert.ok(packedShares.length >= 1);
    assert.equal(packedShares[0].noteCommit.length, 32);
    assert.equal(compact.shareBatch, undefined);
    assert.equal(compact.sharePacked.includes(packedShares[0].noteCommit.toString('hex')), true);

    const wire = encodeWireBlock(second.block);
    assert.equal(typeof wire.sharePacked, 'string');
    assert.ok(wire.sharePacked.length > 8, 'wire carries packed shares');
    assert.equal(wire.shareBatch, undefined);
    const round = JSON.parse(JSON.stringify(wire));
    const ingested = b.append(decodeWireBlock(round), { trustedPowHash: Buffer.from(second.block.hash) });
    assert.equal(ingested.ok, true, ingested.reason);
    assert.equal(b.tip().height, 2);

    const missing = encodeWireBlock({ ...second.block, shareBatch: [] });
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wire-c-'));
    const c = createStore(dirC);
    assert.equal(c.append(cloned, { trustedPowHash: Buffer.from(first.block.hash) }).ok, true);
    const rejected = c.append(decodeWireBlock(missing), { trustedPowHash: Buffer.from(second.block.hash) });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'continuity');
  });
});

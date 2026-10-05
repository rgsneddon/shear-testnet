import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_SHARES_PER_BLOCK } from './asert.js';
import { packShareBatchBytes, unpackShareBatchBytes } from './pack.js';
import { selectBlockShares, shareInclusionTie } from './share_batch.js';
import { writeChainSegments, readChainSegments, segmentFileName } from './chainbin.js';
import { encodeHeader } from './header.js';
import { EMPTY_ROOT } from './merkle.js';
import { P2P_MAX_FRAME_DEFAULT } from '../node/src/p2p.js';

function fakeBlock(height) {
  return {
    header: encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: EMPTY_ROOT,
      continuityRoot: EMPTY_ROOT,
      timestamp: BigInt(height + 1),
      bits: 14,
      nonce: BigInt(height + 1),
      baseFee: 1n,
    }),
    rootA: Buffer.alloc(32),
    rootB: Buffer.alloc(32),
    hash: Buffer.alloc(32, height + 1),
    height,
    aLeaves: [],
    bLeaves: [],
    txs: [{ coinbase: true, height, vout: [{ kind: 'pot' }] }],
    shareBatch: [{ noteCommit: Buffer.alloc(32, height + 1), nonce: BigInt(height + 1), lz: 8 }],
  };
}

describe('v11 65536 lean share path', () => {
  it('keeps the heavier share, not the lower dest', () => {
    const weakLow = { noteCommit: Buffer.alloc(32, 1), nonce: 1n, lz: 8 };
    const strongHigh = { noteCommit: Buffer.alloc(32, 250), nonce: 1n, lz: 12 };
    const kept = selectBlockShares([weakLow, strongHigh], 1);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].lz, 12);
    assert.equal(kept[0].noteCommit[0], 250);
  });

  it('breaks equal weight on the share tie, not on dest order', () => {
    const low = { noteCommit: Buffer.alloc(32, 1), nonce: 1n, lz: 8 };
    const high = { noteCommit: Buffer.alloc(32, 9), nonce: 1n, lz: 8 };
    const kept = selectBlockShares([low, high], 1);
    const want = shareInclusionTie(low).compare(shareInclusionTie(high)) <= 0 ? low : high;
    assert.equal(kept[0].noteCommit[0], want.noteCommit[0]);
    assert.notEqual(kept[0].noteCommit[0], 0);
  });

  it('round-trips packed frames and still reads a legacy JSON array', () => {
    const shares = [
      { noteCommit: Buffer.alloc(32, 4), nonce: 9n, lz: 8 },
      { noteCommit: Buffer.alloc(32, 5), nonce: 3n, lz: 10 },
    ];
    const packed = packShareBatchBytes(shares);
    assert.notEqual(packed[0], 0x5b);
    const back = unpackShareBatchBytes(packed);
    assert.equal(back.length, 2);
    assert.equal(back[0].nonce, 9n);
    assert.equal(back[1].lz, 10);
    const legacy = Buffer.from(JSON.stringify([{ noteCommit: 'ab'.repeat(32), nonce: '4', lz: 8 }]));
    assert.equal(unpackShareBatchBytes(legacy).length, 1);
  });

  it('a full 65536 packed share line fits in the default P2P frame', () => {
    const nc = Buffer.alloc(32, 2);
    const shares = Array.from({ length: MAX_SHARES_PER_BLOCK }, (_, i) => ({
      noteCommit: nc,
      nonce: BigInt(i),
      lz: 8,
    }));
    const hex = packShareBatchBytes(shares).toString('hex');
    const line = `${JSON.stringify({ type: 'block', block: { sharePacked: hex } })}\n`;
    assert.ok(line.length < P2P_MAX_FRAME_DEFAULT, `line ${line.length} frame ${P2P_MAX_FRAME_DEFAULT}`);
    assert.ok(line.length > 2 * 1024 * 1024);
  });

  it('rewrites only the dirty segment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-seg-'));
    const blocks = [0, 1, 2, 3].map((h) => fakeBlock(h));
    writeChainSegments(dir, blocks, { segmentBlocks: 2 });
    const seg1 = fs.readFileSync(path.join(dir, segmentFileName(1)));
    blocks[0] = { ...blocks[0], samplesPruned: true, shareBatch: [] };
    writeChainSegments(dir, blocks, { segmentBlocks: 2, only: new Set([0]) });
    assert.deepEqual(fs.readFileSync(path.join(dir, segmentFileName(1))), seg1);
    const loaded = readChainSegments(dir);
    assert.equal(loaded[0].samplesPruned, true);
    assert.equal(loaded[0].shareBatch.length, 0);
    assert.equal(loaded[2].height, 2);
    assert.equal(loaded[3].shareBatch.length, 1);
  });
});

/**
 * PSA-pr74-1. A held share batch leaves memory and disk once its block is
 * at or below the reorg floor minus the prune depth. Memory keeps height by
 * hash only. A start lists the folder and reads no body.
 *
 * Each cell prunes `blocks` blocks of `shares` shares each: the tip runs to
 * PRUNE + blocks, and the block at tip - PRUNE is held when it is pruned.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { newIdentity } from '../../crypto/address.js';
import { SAMPLE_PRUNE_CONFIRMATIONS, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { packShareBatchBytes } from '../../crypto/pack.js';
import { nonceWithShareTarget } from '../../crypto/share_batch.js';
import { createBurialHold, createBurialProof, reorgFloor, settledHeight } from '../src/burial_hold.js';

const PRUNE = SAMPLE_PRUNE_CONFIRMATIONS;
const SHARES = [1, 1000, 8000, 65_536];
const LENGTHS = [1000, 3000, 10_000];
const MB = 1024 * 1024;

function hexAt(h) {
  return createHash('sha256').update(`block-${h}`).digest('hex');
}

function bodyOf(shares) {
  const id = newIdentity();
  const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
  const share = {
    dest,
    nonce: nonceWithShareTarget(11n, SHARE_FLOOR_BITS),
    lz: SHARE_FLOOR_BITS,
    shareBits: SHARE_FLOOR_BITS,
    creditedShareBits: SHARE_FLOOR_BITS,
    proofSlot: 0,
  };
  // Header, roots, coinbase, and leaves of an epoch row, then the packed batch.
  return Buffer.concat([Buffer.alloc(2048, 0x5a), packShareBatchBytes(new Array(shares).fill(share))]);
}

function filesIn(folder) {
  return fs.existsSync(folder) ? fs.readdirSync(folder).length : 0;
}

describe('v12 burial hold', () => {
  it('settles a block at the reorg floor minus the prune depth', () => {
    assert.equal(reorgFloor(999), 0);
    assert.equal(reorgFloor(1000), 1000);
    assert.equal(reorgFloor(1399), 1000);
    assert.equal(reorgFloor(1400), 1400);
    assert.equal(settledHeight(1000), 0);
    assert.equal(settledHeight(1399), 0);
    assert.equal(settledHeight(1400), 400);
    assert.equal(settledHeight(1799), 400);
    assert.equal(settledHeight(1800), 800);
    assert.equal(settledHeight(11_000), 10_000);
    assert.equal(settledHeight(11_399), 10_000);
    // The floor only rises, and a chain this store adopts keeps the floor
    // block, so its tip is at least the floor. A settled block stays buried.
    for (let tip = PRUNE; tip < 12_000; tip += 37) {
      const floor = reorgFloor(tip);
      const settled = settledHeight(tip);
      assert.ok(floor <= tip);
      if (settled > 0) assert.ok(floor - settled >= PRUNE, `tip ${tip}`);
      assert.ok(tip - PRUNE - settled <= 399, `held window at tip ${tip}`);
    }
  });

  for (const shares of SHARES) {
    const body = bodyOf(shares);
    for (const length of LENGTHS) {
      it(`${shares} shares x ${length} pruned blocks stays bounded`, { timeout: 1_800_000 }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hold-'));
        const folder = path.join(dir, 'burial-hold');
        const hold = createBurialHold({ dir, write: true });
        const proof = createBurialProof({ dir, key: Buffer.alloc(32, 7) });
        const before = process.memoryUsage();
        const t0 = Date.now();
        const top = PRUNE + length;
        let maxHeld = 0;
        let maxBytes = 0;
        let maxProven = 0;
        let maxHeap = 0;
        for (let tip = PRUNE + 1; tip <= top; tip += 1) {
          const h = tip - PRUNE;
          assert.equal(hold.remember(hexAt(h), h, () => body, tip), h > settledHeight(tip));
          proof.note(hexAt(h), h, tip);
          hold.evict(tip);
          proof.evict(tip);
          const held = hold.count();
          if (held > maxHeld) maxHeld = held;
          if (hold.diskBytes() > maxBytes) maxBytes = hold.diskBytes();
          if (proof.count() > maxProven) maxProven = proof.count();
          if (tip % 500 === 0) {
            const heap = process.memoryUsage().heapUsed;
            if (heap > maxHeap) maxHeap = heap;
          }
          assert.equal(held, h - settledHeight(tip), `held at tip ${tip}`);
        }
        proof.save();
        const heights = hold.heights();
        const settled = settledHeight(top);
        assert.ok(heights.every((h) => h > settled && h <= top - PRUNE));
        assert.ok(maxHeld <= 399, `held ${maxHeld}`);
        assert.ok(maxProven <= 399, `proven ${maxProven}`);
        assert.equal(filesIn(folder), hold.count());
        assert.ok(maxBytes <= 399 * body.length, `disk ${maxBytes}`);
        assert.equal(hold.diskBytes(), hold.count() * body.length);
        const after = process.memoryUsage();
        const heapGrowth = Math.max(maxHeap, after.heapUsed) - before.heapUsed;
        const bufferGrowth = after.arrayBuffers - before.arrayBuffers;
        assert.ok(heapGrowth < 64 * MB, `heap grew ${heapGrowth}`);
        assert.ok(bufferGrowth < 64 * MB, `buffers grew ${bufferGrowth}`);

        // A start lists the folder. No body is read, and nothing settled comes back.
        const reads = [];
        const realRead = fs.readFileSync;
        fs.readFileSync = (file, ...rest) => {
          if (String(file).startsWith(folder)) reads.push(file);
          return realRead(file, ...rest);
        };
        let again;
        try {
          again = createBurialHold({ dir, write: true });
          again.load(top);
        } finally {
          fs.readFileSync = realRead;
        }
        assert.equal(reads.length, 0);
        assert.deepEqual(again.heights(), heights);
        const reproof = createBurialProof({ dir, key: Buffer.alloc(32, 7) });
        reproof.load();
        assert.equal(reproof.count(), proof.count());
        const foreign = createBurialProof({ dir, key: Buffer.alloc(32, 8) });
        foreign.load();
        assert.equal(foreign.count(), 0, 'another install key reads no proof');
        if (heights.length) {
          assert.equal(again.read(hexAt(heights[0])).length, body.length);
        }
        process.stderr.write(`${JSON.stringify({
          shares,
          pruned: length,
          tip: top,
          bodyBytes: body.length,
          written: length,
          maxHeld,
          heldAtEnd: hold.count(),
          maxProven,
          maxDiskMB: Number((maxBytes / MB).toFixed(1)),
          unboundedDiskMB: Number(((length * body.length) / MB).toFixed(1)),
          heapGrowthMB: Number((heapGrowth / MB).toFixed(1)),
          bufferGrowthMB: Number((bufferGrowth / MB).toFixed(1)),
          ms: Date.now() - t0,
        })}\n`);
        fs.rmSync(dir, { recursive: true, force: true });
      });
    }
  }

  it('a fast-sync store holds nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hold-fast-'));
    const hold = createBurialHold({ dir, write: false });
    for (let tip = PRUNE + 1; tip <= PRUNE + 500; tip += 1) {
      assert.equal(hold.remember(hexAt(tip - PRUNE), tip - PRUNE, () => Buffer.alloc(64), tip), false);
    }
    assert.equal(hold.count(), 0);
    assert.equal(fs.existsSync(path.join(dir, 'burial-hold')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

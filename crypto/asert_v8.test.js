import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from './address.js';
import { meetsTarget } from './shear_hash.js';
import {
  nextBits,
  GENESIS_BITS,
  GENESIS_BITS_PACKED,
  TARGET_BLOCK_INTERVAL_MS,
  unpackBits,
  consensusFingerprint,
  MAGIC_TESTNET,
  MAGIC_TESTNET_V7,
  MAGIC_TESTNET_V8,
  MAGIC_TESTNET_V9,
  asertNextBits,
  ASERT_EMERGENCY_GAP_FACTOR,
} from './asert.js';
import { decodeHeader, encodeHeader } from './header.js';
import { nonceWithShareTarget } from './share_batch.js';
import { createStore } from '../node/src/store.js';
import { judgeShare, createPool } from '../pool/src/pool.js';

function dest() {
  return encodeDest(Buffer.alloc(20, 7));
}

function powHex(n) {
  const b = Buffer.alloc(32, 0);
  b[31] = n & 0xff;
  b[30] = (n >> 8) & 0xff;
  return b.toString('hex');
}

function seal(store, { miner, now, bits, pow }) {
  const args = { miner, now };
  if (bits != null) args.bits = bits;
  const { job } = store.template(args);
  return store.submitHeader({
    jobId: job.jobId,
    nonce: 0n,
    miner,
    powHash: pow,
  }, { trusted: true });
}

function meanGaps(store) {
  const ts = store.blocks.map((b) => Number(decodeHeader(Buffer.from(b.header)).timestamp));
  const gaps = [];
  for (let i = 1; i < ts.length; i += 1) gaps.push(ts[i] - ts[i - 1]);
  const sum = gaps.reduce((a, b) => a + b, 0);
  return { gaps, mean: sum / gaps.length };
}

// v12 work is genesis-anchored aserti3-2d (7b50960a). The v8 median step and
// its ±1 lid are retired: nextBits is 0-lidded on testnet and does not move.
// The 90 s rule pool and solo share is now asertNextBits from the genesis
// header, with the own-timestamp emergency window for a late block.
describe('shear-testnet-v8 pool and solo share the 90s rule', () => {
  it('a 90000 ms chain stays at genesis work and eight fast gaps from a later parent add a bit', () => {
    const live = consensusFingerprint();
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V9);
    assert.equal(MAGIC_TESTNET_V9, 'shear-testnet-v9');
    assert.match(live, /NETWORK=shear-testnet-v12/);
    assert.doesNotMatch(live, /NETWORK=shear-testnet-v9/);
    assert.equal(live.includes('NETWORK=shear-testnet-v8'), false);
    assert.notEqual(live, live.replaceAll('shear-testnet-v12', 'shear-testnet-v8'));
    assert.equal(MAGIC_TESTNET_V8, 'shear-testnet-v8');
    assert.equal(MAGIC_TESTNET_V7, 'shear-testnet-v7');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V7);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v8-'));
    const store = createStore(dir);
    const miner = dest();
    // The pool stamps its job with the wall clock. Seat the chain so the late
    // template below lands a minute before that clock, inside MTP + 2 h.
    const span = 8 * TARGET_BLOCK_INTERVAL_MS + 8 * 2_000 + 20 * TARGET_BLOCK_INTERVAL_MS;
    const t0 = Date.now() - span - 60_000;
    for (let i = 0; i < 9; i += 1) {
      const got = seal(store, { miner, now: t0 + i * TARGET_BLOCK_INTERVAL_MS, pow: powHex(i + 1) });
      assert.equal(got.ok, true, `90s seal ${i} ${got.reason}`);
    }
    const paced = meanGaps(store);
    assert.equal(paced.gaps.length, 8);
    assert.equal(paced.mean, TARGET_BLOCK_INTERVAL_MS);
    for (const b of store.blocks) {
      const bits = decodeHeader(Buffer.from(b.header)).bits;
      assert.equal(bits, GENESIS_BITS_PACKED);
    }
    const fixed = nextBits(GENESIS_BITS_PACKED, TARGET_BLOCK_INTERVAL_MS);
    assert.equal(fixed, GENESIS_BITS_PACKED);

    const parentBefore = decodeHeader(Buffer.from(store.tip().header));
    const parentBits = parentBefore.bits;
    const start = Number(parentBefore.timestamp);
    for (let i = 1; i <= 8; i += 1) {
      const got = seal(store, { miner, now: start + i * 2_000, pow: powHex(100 + i) });
      assert.equal(got.ok, true, `fast seal ${i} ${got.reason}`);
    }
    const tip = decodeHeader(Buffer.from(store.tip().header));
    const prev = decodeHeader(Buffer.from(store.blocks[store.blocks.length - 2].header));
    assert.equal(Number(tip.timestamp) - Number(prev.timestamp), 2_000);
    const genesis = decodeHeader(Buffer.from(store.blocks[0].header));
    assert.equal(genesis.bits, GENESIS_BITS_PACKED);
    const quoteAt = (height, ts, parentTs) => asertNextBits({
      anchorBits: genesis.bits,
      anchorTimeMs: Number(genesis.timestamp),
      anchorHeight: 1,
      blockTimeMs: ts,
      blockHeight: height,
      parentTimeMs: parentTs,
    });
    for (let i = 1; i < store.blocks.length; i += 1) {
      const a = decodeHeader(Buffer.from(store.blocks[i - 1].header));
      const b = decodeHeader(Buffer.from(store.blocks[i].header));
      const q = quoteAt(store.blocks[i].height, Number(b.timestamp), Number(a.timestamp));
      assert.equal(q.ok, true);
      assert.equal(q.easeBits, 0);
      assert.equal(b.bits, q.packed, `height ${store.blocks[i].height} seals the ASERT quote`);
    }
    // Eight 2 s gaps put the chain 8·88 s ahead of schedule: +704000/τ bits.
    assert.ok(unpackBits(tip.bits) > unpackBits(parentBits), `fast gaps must harden, got ${unpackBits(tip.bits)}`);
    assert.ok(unpackBits(tip.bits) > GENESIS_BITS);
    assert.equal(nextBits(tip.bits, 2_000), tip.bits);

    const longNow = Number(tip.timestamp) + TARGET_BLOCK_INTERVAL_MS * 20;
    assert.ok(longNow - Number(tip.timestamp) > ASERT_EMERGENCY_GAP_FACTOR * TARGET_BLOCK_INTERVAL_MS);
    const quote = quoteAt(store.tip().height + 1, longNow, Number(tip.timestamp));
    assert.equal(quote.ok, true);
    assert.ok(quote.easeBits > 0, 'a 20·T gap opens the emergency window');
    const want = quote.packed;
    const eased = quote.eased;
    assert.ok(unpackBits(want) < unpackBits(tip.bits), 'a late block is easier');
    assert.ok(unpackBits(eased) < unpackBits(want));

    const soloJob = store.template({ miner, shareBits: 8, now: longNow }).job;
    assert.equal(Number(soloJob.timestamp), longNow);
    assert.equal(soloJob.blockBits, want);
    assert.notEqual(soloJob.blockBits, eased);

    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner,
      bits: GENESIS_BITS_PACKED,
      lockBits: true,
    });
    const poolJob = pool.issueJob();
    assert.ok(poolJob, 'pool issues a job on this tip');
    // Same rule, the pool's own stamp: the full quote, never the eased one.
    const poolTs = Number(decodeHeader(Buffer.from(poolJob.header, 'hex')).timestamp);
    assert.ok(poolTs > longNow);
    const poolQuote = quoteAt(store.tip().height + 1, poolTs, Number(tip.timestamp));
    assert.equal(Number(poolJob.blockBits), poolQuote.packed);
    assert.notEqual(Number(poolJob.blockBits), poolQuote.eased);

    const miss = Buffer.alloc(32, 0xff);
    miss[0] = 0;
    assert.equal(meetsTarget(miss, 8), true);
    assert.equal(meetsTarget(miss, want), false);
    assert.equal(meetsTarget(miss, Number(poolJob.blockBits)), false);
    // Share credit is the nonce high byte (b0d0b030). The issued job header
    // carries nonce 0, which names no legal share width, so it earns nothing.
    const poolHdr = decodeHeader(Buffer.from(poolJob.header, 'hex'));
    const shareHeader = (nonce) => encodeHeader({
      version: poolHdr.version,
      prevBlockHash: poolHdr.prevBlockHash,
      merkleRoot: poolHdr.merkleRoot,
      continuityRoot: poolHdr.continuityRoot,
      timestamp: poolHdr.timestamp,
      bits: poolHdr.bits,
      nonce,
      baseFee: poolHdr.baseFee,
    });
    const unnamed = judgeShare({
      job: { ...poolJob, shareBits: 8 },
      hash: miss,
      header: shareHeader(0n),
      dest: '',
    });
    assert.equal(unnamed.ok, false);
    assert.equal(unnamed.reason, 'share_target');
    const judged = judgeShare({
      job: { ...poolJob, shareBits: 8 },
      hash: miss,
      header: shareHeader(nonceWithShareTarget(0n, 8)),
      dest: '',
    });
    assert.equal(judged.ok, true, judged.reason);
    assert.equal(judged.creditedShareBits, 8);
    assert.equal(judged.block, false);

    const offered = store.template({
      miner,
      now: longNow,
      bits: eased,
      shareBits: 8,
    });
    assert.equal(Number(offered.job.blockBits), want);
    assert.equal(Number(offered.job.bits), want);
    const rec = store.jobs.get(offered.job.jobId);
    const decoded = decodeHeader(Buffer.from(rec.tpl.header));
    rec.tpl.header = encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: decoded.merkleRoot,
      continuityRoot: decoded.continuityRoot,
      timestamp: decoded.timestamp,
      // One unit under the emergency window at this stamp.
      bits: eased - 1,
      nonce: 0n,
      baseFee: decoded.baseFee,
    });
    const beforeH = store.tip().height;
    const denied = store.submitHeader({
      jobId: offered.job.jobId,
      nonce: 0n,
      miner,
      powHash: powHex(400),
    }, { trusted: true });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'bits');
    assert.equal(store.tip().height, beforeH);

    const kept = seal(store, { miner, now: longNow, pow: powHex(401) });
    assert.equal(kept.ok, true, kept.reason);
    const sealed = decodeHeader(Buffer.from(store.tip().header));
    assert.equal(Number(sealed.timestamp), longNow);
    assert.equal(sealed.bits, want);
    assert.notEqual(sealed.bits, eased);
    pool.close();
  });
});

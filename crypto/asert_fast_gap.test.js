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
  ASERT_STEP_ID,
  asertNextBits,
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
  b[31] = n;
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

// v12 work is genesis-anchored aserti3-2d (7b50960a, tau = 2 h). The v8/v11
// median step and its lid are retired: testnet nextBits is 0-lidded and does
// not move. Eight 2 s gaps put the chain 8 * 88 s ahead of the genesis
// schedule, so the ASERT quote is harder than the genesis seed.
describe('eight fast gaps raise work and the pool uses that target', () => {
  it('rejects a genesis-bits header after eight 2000ms gaps and does not seal a miss', () => {
    // The retired median step is inert on testnet: a fast gap moves nothing.
    let packed = GENESIS_BITS_PACKED;
    for (let n = 0; n < 8; n += 1) packed = nextBits(packed, 2_000);
    assert.equal(packed, GENESIS_BITS_PACKED);
    assert.equal(nextBits(GENESIS_BITS_PACKED, TARGET_BLOCK_INTERVAL_MS), GENESIS_BITS_PACKED);

    const fp = consensusFingerprint();
    assert.equal(fp.includes(`ASERT_STEP=${ASERT_STEP_ID}`), true);
    assert.equal(fp.includes('ASERT_STEP=(T-seen)/tau'), false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fast-gap-'));
    const store = createStore(dir);
    const miner = dest();
    // The pool stamps its job with the wall clock. Seat the chain a minute
    // before that clock so the pool's job sits inside MTP + 2 h.
    const t0 = Date.now() - 8 * 2_000 - 60_000;
    for (let i = 0; i < 9; i += 1) {
      const got = seal(store, { miner, now: t0 + i * 2_000, pow: powHex(i + 1) });
      assert.equal(got.ok, true, `seal ${i} ${got.reason}`);
    }
    const tip = decodeHeader(Buffer.from(store.tip().header));
    const prev = decodeHeader(Buffer.from(store.blocks[store.blocks.length - 2].header));
    const gap = Number(tip.timestamp) - Number(prev.timestamp);
    assert.equal(gap, 2_000);
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
      assert.equal(Number(b.timestamp) - Number(a.timestamp), 2_000);
      const q = quoteAt(store.blocks[i].height, Number(b.timestamp), Number(a.timestamp));
      assert.equal(q.ok, true);
      assert.equal(q.easeBits, 0);
      assert.equal(b.bits, q.packed, `height ${store.blocks[i].height} seals the ASERT quote`);
    }
    assert.ok(unpackBits(tip.bits) > GENESIS_BITS, `fast gaps must harden, got ${unpackBits(tip.bits)}`);
    const nextQuote = quoteAt(store.tip().height + 1, t0 + 9 * 2_000, Number(tip.timestamp));
    assert.equal(nextQuote.ok, true);
    assert.equal(nextQuote.easeBits, 0);
    const want = nextQuote.packed;
    assert.ok(unpackBits(want) > unpackBits(tip.bits), `a ninth fast gap hardens again, got ${unpackBits(want)}`);

    const under = store.template({
      miner,
      now: t0 + 9 * 2_000,
      bits: GENESIS_BITS_PACKED,
      shareBits: 8,
    });
    assert.equal(Number(under.job.blockBits), want);
    assert.equal(Number(under.job.bits), want);
    assert.notEqual(Number(under.job.blockBits), GENESIS_BITS_PACKED);
    const rec = store.jobs.get(under.job.jobId);
    const decodedJob = decodeHeader(Buffer.from(rec.tpl.header));
    rec.tpl.header = encodeHeader({
      version: decodedJob.version,
      prevBlockHash: decodedJob.prevBlockHash,
      merkleRoot: decodedJob.merkleRoot,
      continuityRoot: decodedJob.continuityRoot,
      timestamp: decodedJob.timestamp,
      bits: GENESIS_BITS_PACKED,
      nonce: 0n,
      baseFee: decodedJob.baseFee,
    });
    rec.job = { ...rec.job, bits: 8, blockBits: 8, shareBits: 8 };
    const beforeH = store.tip().height;
    const denied = store.submitHeader({
      jobId: under.job.jobId,
      nonce: 0n,
      miner,
      powHash: powHex(30),
    }, { trusted: true });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'bits');
    assert.equal(store.tip().height, beforeH);

    const { job } = store.template({ miner, now: t0 + 9 * 2_000, bits: 8, shareBits: 8 });
    assert.equal(Number(job.blockBits), want);
    assert.equal(Number(job.bits), want);

    const shareOnly = Buffer.alloc(32, 0xff);
    shareOnly[0] = 0;
    assert.equal(meetsTarget(shareOnly, 8), true);
    assert.equal(meetsTarget(shareOnly, want), false);
    // Share credit is the nonce high byte (b0d0b030). The issued job header
    // carries nonce 0, which names no legal share width, so it earns nothing.
    const jobHdr = decodeHeader(Buffer.from(job.header, 'hex'));
    const shareHeader = (nonce) => encodeHeader({
      version: jobHdr.version,
      prevBlockHash: jobHdr.prevBlockHash,
      merkleRoot: jobHdr.merkleRoot,
      continuityRoot: jobHdr.continuityRoot,
      timestamp: jobHdr.timestamp,
      bits: jobHdr.bits,
      nonce,
      baseFee: jobHdr.baseFee,
    });
    assert.equal(jobHdr.bits, want);
    const unnamed = judgeShare({
      job: { ...job, shareBits: 8 },
      hash: shareOnly,
      header: shareHeader(0n),
      dest: '',
    });
    assert.equal(unnamed.ok, false);
    assert.equal(unnamed.reason, 'share_target');
    const missed = judgeShare({
      job: { ...job, shareBits: 8 },
      hash: shareOnly,
      header: shareHeader(nonceWithShareTarget(0n, 8)),
      dest: '',
    });
    assert.equal(missed.ok, true, missed.reason);
    assert.equal(missed.creditedShareBits, 8);
    assert.equal(missed.block, false);
    const substituted = judgeShare({
      job: { ...job, bits: 8, blockBits: 8, shareBits: 8 },
      hash: shareOnly,
      header: shareHeader(nonceWithShareTarget(0n, 8)),
      dest: '',
    });
    assert.equal(substituted.block, false);

    const hit = judgeShare({
      job: { ...job, shareBits: 8 },
      hash: Buffer.alloc(32, 0),
      header: Buffer.from(job.header, 'hex'),
      dest: '',
    });
    assert.equal(hit.block, true);

    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner,
      bits: GENESIS_BITS_PACKED,
      lockBits: true,
    });
    try {
      const live = pool.issueJob();
      assert.ok(live, 'pool issues a job on this tip');
      // Same rule at the pool's own stamp: the full quote, never genesis bits.
      const liveTs = Number(decodeHeader(Buffer.from(live.header, 'hex')).timestamp);
      const liveQuote = quoteAt(store.tip().height + 1, liveTs, Number(tip.timestamp));
      assert.equal(liveQuote.ok, true);
      assert.equal(liveQuote.easeBits, 0);
      assert.equal(Number(live.blockBits), liveQuote.packed);
      assert.notEqual(Number(live.blockBits), GENESIS_BITS_PACKED);
      assert.ok(unpackBits(live.blockBits) > GENESIS_BITS);
    } finally {
      pool.close();
    }
  });
});

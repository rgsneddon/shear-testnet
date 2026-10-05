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
  medianIntervalMs,
} from './asert.js';
import { decodeHeader, encodeHeader } from './header.js';
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

describe('shear-testnet-v8 pool and solo share the 90s rule', () => {
  it('a 90000 ms chain stays at genesis work and eight fast gaps from a later parent add a bit', () => {
    const live = consensusFingerprint();
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V9);
    assert.equal(MAGIC_TESTNET_V9, 'shear-testnet-v9');
    assert.match(live, /NETWORK=shear-testnet-v11/);
    assert.doesNotMatch(live, /NETWORK=shear-testnet-v9/);
    assert.equal(live.includes('NETWORK=shear-testnet-v8'), false);
    assert.notEqual(live, live.replaceAll('shear-testnet-v11', 'shear-testnet-v8'));
    assert.equal(MAGIC_TESTNET_V8, 'shear-testnet-v8');
    assert.equal(MAGIC_TESTNET_V7, 'shear-testnet-v7');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V7);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v8-'));
    const store = createStore(dir);
    const miner = dest();
    const t0 = 1_700_000_000_000;
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
    const gaps = [];
    for (let i = 1; i < store.blocks.length; i += 1) {
      const a = decodeHeader(Buffer.from(store.blocks[i - 1].header));
      const b = decodeHeader(Buffer.from(store.blocks[i].header));
      gaps.push(Number(b.timestamp) - Number(a.timestamp));
    }
    const seen = medianIntervalMs(gaps);
    const want = nextBits(tip.bits, seen);
    assert.equal(seen, 2_000);
    assert.ok(unpackBits(want) > unpackBits(parentBits), `fast median must harden, got ${unpackBits(want)}`);
    assert.ok(unpackBits(want) > GENESIS_BITS);

    const longNow = Number(tip.timestamp) + TARGET_BLOCK_INTERVAL_MS * 20;
    const eased = nextBits(tip.bits, longNow - Number(tip.timestamp));
    assert.ok(unpackBits(eased) < unpackBits(want));

    const soloJob = store.template({ miner, shareBits: 8, now: longNow }).job;
    assert.equal(soloJob.blockBits, want);
    assert.notEqual(soloJob.blockBits, eased);
    assert.equal(Number(soloJob.timestamp) > Number(tip.timestamp), true);

    const pool = createPool({
      dataDir: dir,
      stratumPort: 0,
      httpPort: 0,
      miner,
      bits: GENESIS_BITS_PACKED,
      lockBits: true,
    });
    const poolJob = pool.issueJob();
    assert.equal(Number(poolJob.blockBits), want);
    assert.equal(Number(poolJob.blockBits), Number(soloJob.blockBits));

    const miss = Buffer.alloc(32, 0xff);
    miss[0] = 0;
    assert.equal(meetsTarget(miss, 8), true);
    assert.equal(meetsTarget(miss, want), false);
    const judged = judgeShare({
      job: { ...poolJob, shareBits: 8 },
      hash: miss,
      header: Buffer.from(poolJob.header, 'hex'),
      dest: '',
    });
    assert.equal(judged.ok, true);
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
      bits: eased,
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

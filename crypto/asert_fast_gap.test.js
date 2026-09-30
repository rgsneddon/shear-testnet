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
} from './asert.js';
import { decodeHeader } from './header.js';
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

describe('eight fast gaps raise work and the pool uses that target', () => {
  it('rejects a genesis-bits header after eight 2000ms gaps and does not seal a miss', () => {
    let packed = GENESIS_BITS_PACKED;
    for (let n = 0; n < 8; n += 1) packed = nextBits(packed, 2_000);
    assert.ok(unpackBits(packed) >= GENESIS_BITS + 1, `eight gaps ${unpackBits(packed)}`);
    assert.equal(nextBits(packed, TARGET_BLOCK_INTERVAL_MS), packed);
    assert.equal(nextBits(GENESIS_BITS_PACKED, 90_000), GENESIS_BITS_PACKED);

    const fp = consensusFingerprint();
    assert.equal(fp.includes(`ASERT_STEP=${ASERT_STEP_ID}`), true);
    assert.equal(fp.includes('ASERT_STEP=(T-seen)/tau'), false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fast-gap-'));
    const store = createStore(dir);
    const miner = dest();
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 9; i += 1) {
      const got = seal(store, { miner, now: t0 + i * 2_000, pow: powHex(i + 1) });
      assert.equal(got.ok, true, `seal ${i} ${got.reason}`);
    }
    const tip = decodeHeader(Buffer.from(store.tip().header));
    const prev = decodeHeader(Buffer.from(store.blocks[store.blocks.length - 2].header));
    const gap = Number(tip.timestamp) - Number(prev.timestamp);
    assert.equal(gap, 2_000);
    const want = nextBits(tip.bits, gap);
    assert.equal(want, packed);
    assert.ok(unpackBits(want) >= GENESIS_BITS + 1);

    const denied = seal(store, {
      miner,
      now: t0 + 9 * 2_000,
      bits: GENESIS_BITS_PACKED,
      pow: powHex(30),
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'bits');

    const { job } = store.template({ miner, now: t0 + 9 * 2_000 });
    assert.equal(Number(job.blockBits), want);
    assert.equal(Number(job.bits), want);

    const shareOnly = Buffer.alloc(32, 0xff);
    shareOnly[0] = 0;
    assert.equal(meetsTarget(shareOnly, 8), true);
    assert.equal(meetsTarget(shareOnly, want), false);
    const missed = judgeShare({
      job: { ...job, shareBits: 8 },
      hash: shareOnly,
      header: Buffer.from(job.header, 'hex'),
      dest: '',
    });
    assert.equal(missed.ok, true);
    assert.equal(missed.block, false);

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
      assert.equal(Number(live.blockBits), want);
      assert.ok(unpackBits(live.blockBits) >= GENESIS_BITS + 1);
    } finally {
      pool.close();
    }
  });
});

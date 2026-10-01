import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encodeHeader } from '../../crypto/header.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  nextBits,
  packBits,
  unpackBits,
  GENESIS_BITS,
  GENESIS_BITS_PACKED,
  TARGET_BLOCK_INTERVAL_MS,
  SAMPLE_PRUNE_CONFIRMATIONS,
  HEADER_AHEAD_MS,
  ASERT_HARDEN_MAX,
  MAGIC_TESTNET,
  MAGIC_TESTNET_V7,
  MAGIC_TESTNET_V8,
  MAGIC_TESTNET_V9,
  medianIntervalMs,
  consensusFingerprint,
} from '../../crypto/asert.js';
import {
  retarget,
  verifyBlock,
  buildTemplate,
  publicJob,
  GENESIS_PREV,
} from '../src/chain.js';
import { judgeShare } from '../../pool/src/pool.js';
import { evaluateSoloSubmit, soloWireJob } from '../src/solo_stratum.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function hdr(timestamp, bits) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32, 1),
    merkleRoot: Buffer.alloc(32, 2),
    continuityRoot: Buffer.alloc(32, 3),
    timestamp,
    bits,
  });
}

function climb(start) {
  let packed = start;
  for (let n = 0; n < 8; n += 1) packed = nextBits(packed, 2_000);
  return unpackBits(packed) - unpackBits(start);
}

/** Expected solve time at constant hashrate, then the shipped next-work step. */
function pruneWindows({ hashrate, windows, maxAhead = false }) {
  const n = SAMPLE_PRUNE_CONFIRMATIONS;
  let bits = GENESIS_BITS;
  let excess = 0;
  const means = [];
  const tails = [];
  const life = [];
  let bias = 0;
  for (let w = 0; w < windows; w += 1) {
    const trues = [];
    for (let i = 0; i < n; i += 1) {
      const trueMs = (2 ** bits / hashrate) * 1000;
      let claimed = trueMs;
      if (maxAhead) {
        const nextExcess = HEADER_AHEAD_MS;
        claimed = Math.max(1, trueMs + (nextExcess - excess));
        bias += claimed - trueMs;
        excess = nextExcess;
      }
      trues.push(trueMs);
      life.push(trueMs);
      bits = unpackBits(nextBits(packBits(bits), claimed));
    }
    means.push(mean(trues));
    tails.push(mean(trues.slice(-200)));
  }
  return { means, tails, life: mean(life), bias };
}

function trust() {
  return { trustedPowHash: Buffer.alloc(32, 0), skipSharePow: true };
}

describe('shear-testnet-v8 shared pool and solo work', () => {
  it('90000 ms is the fixed point across prune windows and the life of the chain', () => {
    assert.equal(SAMPLE_PRUNE_CONFIRMATIONS, 1000);
    assert.equal(TARGET_BLOCK_INTERVAL_MS, 90_000);
    const windows = 3;
    const gaps = [];
    let bits = GENESIS_BITS_PACKED;
    let ts = 1_700_000_000_000;
    const chain = [{ header: hdr(ts, bits) }];
    for (let w = 0; w < windows; w += 1) {
      for (let i = 0; i < SAMPLE_PRUNE_CONFIRMATIONS; i += 1) {
        const want = retarget(chain);
        assert.equal(want, bits);
        ts += TARGET_BLOCK_INTERVAL_MS;
        gaps.push(TARGET_BLOCK_INTERVAL_MS);
        bits = want;
        chain.push({ header: hdr(ts, bits) });
      }
    }
    assert.equal(mean(gaps), 90_000);
    assert.equal(unpackBits(retarget(chain)), unpackBits(GENESIS_BITS_PACKED));
    const honest = pruneWindows({ hashrate: 15_000, windows });
    assert.ok(honest.means[0] > 70_000, `seed window moves toward 90s, got ${honest.means[0]}`);
    for (const m of honest.tails) {
      assert.ok(Math.abs(m - 90_000) < 2_000, `honest settled tail ${m}`);
    }
    for (const m of honest.means.slice(1)) {
      assert.ok(Math.abs(m - 90_000) < 2_000, `honest later window ${m}`);
    }
    const lied = pruneWindows({ hashrate: 15_000, windows, maxAhead: true });
    for (const m of lied.tails) {
      assert.ok(Math.abs(m - 90_000) < 2_000, `max-ahead settled tail ${m}`);
    }
    for (const m of lied.means.slice(1)) {
      assert.ok(Math.abs(m - 90_000) < 2_000, `max-ahead later window ${m}`);
    }
    assert.ok(lied.bias <= HEADER_AHEAD_MS, `timestamp excess ${lied.bias}`);
    // A hashrate change later in the chain recenters on the same fixed point.
    const shifted = pruneWindows({ hashrate: 15_000 * 4, windows: 2 });
    for (const m of shifted.tails) {
      assert.ok(Math.abs(m - 90_000) < 2_000, `later hashrate settled tail ${m}`);
    }
    assert.ok(Math.abs(shifted.means[1] - 90_000) < 2_000, `later hashrate window ${shifted.means[1]}`);
  });

  it('eight 2000 ms gaps add at least one bit from genesis and from a later parent', () => {
    assert.ok(climb(GENESIS_BITS_PACKED) >= 1);
    assert.ok(climb(packBits(30)) >= 1);
    assert.ok(climb(GENESIS_BITS_PACKED) >= ASERT_HARDEN_MAX);
    const held = nextBits(packBits(30), TARGET_BLOCK_INTERVAL_MS);
    assert.equal(unpackBits(held), 30);
  });

  it('verify, pool judge, and solo submit share one next-work and reject a private easier target or a long stamp', () => {
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v10');
    assert.equal(MAGIC_TESTNET_V9, 'shear-testnet-v9');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V9);
    assert.equal(MAGIC_TESTNET_V8, 'shear-testnet-v8');
    assert.equal(MAGIC_TESTNET_V7, 'shear-testnet-v7');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V8);
    assert.notEqual(MAGIC_TESTNET_V7, MAGIC_TESTNET);
    const fp = consensusFingerprint();
    assert.match(fp, /NETWORK=shear-testnet-v10/);
    assert.doesNotMatch(fp, /NETWORK=shear-testnet-v8/);
    assert.match(fp, /ASERT_STEP=median11\(log2\(T\/seen\)\)\*\(T\/tau\)/);
    assert.equal(medianIntervalMs([2_000]), TARGET_BLOCK_INTERVAL_MS);
    assert.equal(medianIntervalMs(Array.from({ length: 6 }, () => 2_000)), 2_000);

    const id = newIdentity();
    const miner = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const t0 = 1_700_000_000_000;
    const genesisTpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner,
      bits: GENESIS_BITS_PACKED,
      now: t0,
    });
    const genesis = {
      header: genesisTpl.header,
      txs: genesisTpl.txs,
      samples: genesisTpl.samples,
      miner,
      hash: Buffer.alloc(32, 4),
      height: 1,
      weight: 1,
    };
    const g = verifyBlock(genesis, null, trust());
    assert.equal(g.ok, true, g.reason);

    const gap = 2_000;
    const childTpl = buildTemplate({
      prev: genesis.hash,
      prevHeader: genesis.header,
      prevBlock: genesis,
      height: 2,
      miner,
      bits: nextBits(GENESIS_BITS_PACKED, TARGET_BLOCK_INTERVAL_MS),
      now: t0 + gap,
    });
    const child = {
      header: childTpl.header,
      txs: childTpl.txs,
      samples: childTpl.samples,
      miner,
      hash: Buffer.alloc(32, 5),
      height: 2,
      weight: 1,
    };
    const c = verifyBlock(child, genesis, {
      ...trust(),
      parentIntervalMs: TARGET_BLOCK_INTERVAL_MS,
      nowMs: t0 + gap,
    });
    assert.equal(c.ok, true, c.reason);

    const parentBits = nextBits(GENESIS_BITS_PACKED, TARGET_BLOCK_INTERVAL_MS);
    const chain = [
      { header: genesis.header },
      { header: child.header },
    ];
    const want = retarget(chain);
    assert.equal(want, nextBits(parentBits, TARGET_BLOCK_INTERVAL_MS));
    assert.equal(unpackBits(want), unpackBits(parentBits));
    const oneGapHard = nextBits(parentBits, gap);
    assert.ok(unpackBits(oneGapHard) > unpackBits(want));

    const easyTpl = buildTemplate({
      prev: child.hash,
      prevHeader: child.header,
      prevBlock: child,
      height: 3,
      miner,
      bits: oneGapHard,
      now: t0 + gap + gap,
    });
    const easy = verifyBlock({
      header: easyTpl.header,
      txs: easyTpl.txs,
      samples: easyTpl.samples,
      miner,
      height: 3,
    }, child, {
      ...trust(),
      parentIntervalMs: TARGET_BLOCK_INTERVAL_MS,
      grandparentHeader: genesis.header,
      nowMs: t0 + gap + gap,
    });
    assert.equal(easy.ok, false);
    assert.equal(easy.reason, 'bits');
    const omitted = verifyBlock({
      header: easyTpl.header,
      txs: easyTpl.txs,
      samples: easyTpl.samples,
      miner,
      height: 3,
    }, child, {
      ...trust(),
      parentIntervalMs: gap,
      nowMs: t0 + gap + gap,
    });
    assert.equal(omitted.ok, false);
    assert.equal(omitted.reason, 'bits');

    const aheadTpl = buildTemplate({
      prev: child.hash,
      prevHeader: child.header,
      prevBlock: child,
      height: 3,
      miner,
      bits: want,
      now: t0 + gap + TARGET_BLOCK_INTERVAL_MS,
    });
    const ahead = verifyBlock({
      header: aheadTpl.header,
      txs: aheadTpl.txs,
      samples: aheadTpl.samples,
      miner,
      height: 3,
    }, child, {
      ...trust(),
      parentIntervalMs: TARGET_BLOCK_INTERVAL_MS,
      grandparentHeader: genesis.header,
      nowMs: t0 + gap + 2_000,
    });
    assert.equal(ahead.ok, false);
    assert.equal(ahead.reason, 'timestamp');

    const honestTpl = buildTemplate({
      prev: child.hash,
      prevHeader: child.header,
      prevBlock: child,
      height: 3,
      miner,
      bits: want,
      now: t0 + gap + gap,
    });
    const honest = verifyBlock({
      header: honestTpl.header,
      txs: honestTpl.txs,
      samples: honestTpl.samples,
      miner,
      height: 3,
    }, child, {
      ...trust(),
      parentIntervalMs: TARGET_BLOCK_INTERVAL_MS,
      grandparentHeader: genesis.header,
      nowMs: t0 + gap + gap,
    });
    assert.equal(honest.ok, true, honest.reason);

    const job = publicJob(honestTpl, { jobId: 'v8', shareBits: 8 });
    assert.equal(job.blockBits, want);
    assert.equal(job.bits, want);

    const shareOnly = Buffer.alloc(32, 0xff);
    shareOnly[0] = 0;
    const poolMiss = judgeShare({ job, hash: shareOnly, header: honestTpl.header });
    assert.equal(poolMiss.ok, true, poolMiss.reason);
    assert.equal(poolMiss.block, false);
    const poolHit = judgeShare({ job, hash: Buffer.alloc(32, 0), header: honestTpl.header });
    assert.equal(poolHit.block, true);
    assert.equal(meetsTarget(shareOnly, job.blockBits), false);
    assert.equal(meetsTarget(Buffer.alloc(32, 0), job.blockBits), true);

    const wired = soloWireJob(job, 8);
    assert.equal(Number(wired.blockBits), want);
    assert.equal(Number(wired.bits), want);
    const soloSrc = fs.readFileSync(new URL('../src/solo_stratum.js', import.meta.url), 'utf8');
    assert.match(soloSrc, /blockBits = decodeHeader\(header\)\.bits/);
    assert.match(soloSrc, /meetsTarget\(hash, blockBits\)/);
    try {
      const store = {
        jobs: new Map([['v8', { tpl: honestTpl, job: wired, shareBits: 8 }]]),
      };
      const solo = evaluateSoloSubmit({ store, jobId: 'v8', nonce: 0n, dest: '' });
      if (solo.ok) {
        const hashed = Buffer.from(solo.hash, 'hex');
        assert.equal(solo.block, meetsTarget(hashed, want));
      }
    } catch (err) {
      assert.match(String(err?.message || err), /ShearHash|native addon/);
    }
  });
});

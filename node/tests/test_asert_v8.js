import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encodeHeader, setNonce } from '../../crypto/header.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import { nonceWithShareTarget } from '../../crypto/share_batch.js';
import {
  asertNextBits,
  unpackBits,
  GENESIS_BITS,
  GENESIS_BITS_PACKED,
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  SAMPLE_PRUNE_CONFIRMATIONS,
  HEADER_AHEAD_MS,
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

/** Hashes per second that solve the v12 genesis target in one target interval. */
function genesisHashrate() {
  return (2 ** GENESIS_BITS) * 1000 / TARGET_BLOCK_INTERVAL_MS;
}

function quoteAt(anchorTime, parentTime, height, blockTime) {
  return asertNextBits({
    anchorBits: GENESIS_BITS_PACKED,
    anchorTimeMs: anchorTime,
    anchorHeight: 1,
    blockTimeMs: blockTime,
    blockHeight: height,
    parentTimeMs: parentTime,
  });
}

/**
 * Expected solve time under aserti3-2d at a constant hashrate.
 * The block stamp is an input to the target, so the interval is the fixed point of that quote.
 */
function solveMs(anchorTime, parentTime, height, hashrate) {
  let guess = TARGET_BLOCK_INTERVAL_MS;
  for (let k = 0; k < 16; k += 1) {
    const quote = quoteAt(anchorTime, parentTime, height, parentTime + guess);
    if (!quote.ok) throw new Error(quote.reason);
    const next = (2 ** unpackBits(quote.packed) / hashrate) * 1000;
    if (Math.abs(next - guess) < 1) return next;
    guess = next;
  }
  return guess;
}

/** 2s gaps until the genesis-anchored deficit has raised work by at least one bit. */
function fastScheduleBits(gaps, { prefixOnTime = 0 } = {}) {
  const anchor = 1_700_000_000_000;
  let parent = anchor;
  let height = 1;
  let packed = GENESIS_BITS_PACKED;
  for (let i = 0; i < prefixOnTime; i += 1) {
    height += 1;
    parent += TARGET_BLOCK_INTERVAL_MS;
  }
  for (let i = 0; i < gaps; i += 1) {
    height += 1;
    const blockTime = parent + 2_000;
    const quote = quoteAt(anchor, parent, height, blockTime);
    if (!quote.ok) throw new Error(quote.reason);
    packed = quote.packed;
    parent = blockTime;
  }
  return packed;
}

/** Expected solve time at constant hashrate, then the shipped aserti3-2d step. */
function pruneWindows({ hashrate, windows, maxAhead = false }) {
  const n = SAMPLE_PRUNE_CONFIRMATIONS;
  const anchorTime = 1_700_000_000_000;
  let parentTime = anchorTime;
  let height = 1;
  let excess = 0;
  const means = [];
  const tails = [];
  const life = [];
  let bias = 0;
  for (let w = 0; w < windows; w += 1) {
    const trues = [];
    for (let i = 0; i < n; i += 1) {
      height += 1;
      const trueMs = solveMs(anchorTime, parentTime, height, hashrate);
      let claimed = trueMs;
      if (maxAhead) {
        const nextExcess = HEADER_AHEAD_MS;
        claimed = Math.max(1, trueMs + (nextExcess - excess));
        bias += claimed - trueMs;
        excess = nextExcess;
      }
      trues.push(trueMs);
      life.push(trueMs);
      parentTime += claimed;
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
    const honestHps = genesisHashrate();
    const honest = pruneWindows({ hashrate: honestHps, windows });
    assert.ok(honest.means[0] > 70_000, `seed window moves toward 90s, got ${honest.means[0]}`);
    for (const m of honest.tails) {
      assert.ok(Math.abs(m - 90_000) < 2_000, `honest settled tail ${m}`);
    }
    for (const m of honest.means.slice(1)) {
      assert.ok(Math.abs(m - 90_000) < 2_000, `honest later window ${m}`);
    }
    const lied = pruneWindows({ hashrate: honestHps, windows, maxAhead: true });
    for (const m of lied.tails) {
      assert.ok(Math.abs(m - 90_000) < 2_000, `max-ahead settled tail ${m}`);
    }
    for (const m of lied.means.slice(1)) {
      assert.ok(Math.abs(m - 90_000) < 2_000, `max-ahead later window ${m}`);
    }
    assert.ok(lied.bias <= HEADER_AHEAD_MS, `timestamp excess ${lied.bias}`);
    // A hashrate change later in the chain recenters on the same fixed point.
    const shifted = pruneWindows({ hashrate: honestHps * 4, windows: 2 });
    for (const m of shifted.tails) {
      assert.ok(Math.abs(m - 90_000) < 2_000, `later hashrate settled tail ${m}`);
    }
    assert.ok(Math.abs(shifted.means[1] - 90_000) < 2_000, `later hashrate window ${shifted.means[1]}`);
  });

  it('a 2s schedule adds at least one bit once the deficit reaches tau', () => {
    const fromGenesis = fastScheduleBits(82);
    assert.ok(unpackBits(fromGenesis) >= GENESIS_BITS + 1, `genesis fast run ${unpackBits(fromGenesis)}`);
    const later = fastScheduleBits(82, { prefixOnTime: 10 });
    assert.ok(unpackBits(later) >= GENESIS_BITS + 1, `later fast run ${unpackBits(later)}`);
    const held = quoteAt(1_700_000_000_000, 1_700_000_000_000, 2, 1_700_000_000_000 + TARGET_BLOCK_INTERVAL_MS);
    assert.equal(held.ok, true, held.reason);
    assert.equal(held.packed, GENESIS_BITS_PACKED);
  });

  it('verify, pool judge, and solo submit share one next-work and reject a private easier target or a long stamp', () => {
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v12');
    assert.equal(MAGIC_TESTNET_V9, 'shear-testnet-v9');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V9);
    assert.equal(MAGIC_TESTNET_V8, 'shear-testnet-v8');
    assert.equal(MAGIC_TESTNET_V7, 'shear-testnet-v7');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V8);
    assert.notEqual(MAGIC_TESTNET_V7, MAGIC_TESTNET);
    const fp = consensusFingerprint();
    assert.match(fp, /NETWORK=shear-testnet-v12/);
    assert.doesNotMatch(fp, /NETWORK=shear-testnet-v8/);
    assert.match(fp, /ASERT_STEP=aserti3-2d/);
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
      hash: Buffer.alloc(32, 4),
      height: 1,
      weight: 1,
    };
    const g = verifyBlock(genesis, null, trust());
    assert.equal(g.ok, true, g.reason);
    // R28: the child's coinbase binds this record's root (blunote_prev).
    genesis.blunoteRecord = g.blunoteRecord;

    const childTime = t0 + TARGET_BLOCK_INTERVAL_MS;
    const childQuote = quoteAt(t0, t0, 2, childTime);
    assert.equal(childQuote.ok, true, childQuote.reason);
    assert.equal(childQuote.packed, GENESIS_BITS_PACKED);
    const childTpl = buildTemplate({
      prev: genesis.hash,
      prevHeader: genesis.header,
      prevBlock: genesis,
      height: 2,
      miner,
      bits: childQuote.packed,
      now: childTime,
    });
    const child = {
      header: childTpl.header,
      txs: childTpl.txs,
      hash: Buffer.alloc(32, 5),
      height: 2,
      weight: 1,
    };
    const c = verifyBlock(child, genesis, {
      ...trust(),
      nowMs: childTime + 1_000,
      genesisMs: t0,
    });
    assert.equal(c.ok, true, c.reason);
    child.blunoteRecord = c.blunoteRecord;

    const nextTime = childTime + TARGET_BLOCK_INTERVAL_MS;
    const chain = [
      { header: genesis.header, height: 1 },
      { header: child.header, height: 2 },
    ];
    const want = retarget(chain, nextTime);
    const wantQuote = quoteAt(t0, childTime, 3, nextTime);
    assert.equal(wantQuote.ok, true, wantQuote.reason);
    assert.equal(want, wantQuote.packed);
    assert.equal(want, GENESIS_BITS_PACKED);
    const fastQuote = quoteAt(t0, childTime, 3, childTime + 2_000);
    assert.equal(fastQuote.ok, true, fastQuote.reason);
    assert.ok(fastQuote.packed > want, `fast gap packed ${fastQuote.packed}`);

    const easyTpl = buildTemplate({
      prev: child.hash,
      prevHeader: child.header,
      prevBlock: child,
      height: 3,
      miner,
      bits: want - 1,
      now: nextTime,
    });
    const easy = verifyBlock({
      header: easyTpl.header,
      txs: easyTpl.txs,
      height: 3,
    }, child, {
      ...trust(),
      grandparentHeader: genesis.header,
      nowMs: nextTime + 1_000,
      genesisMs: t0,
    });
    assert.equal(easy.ok, false);
    assert.equal(easy.reason, 'bits');
    const fastTime = childTime + 2_000;
    const omittedTpl = buildTemplate({
      prev: child.hash,
      prevHeader: child.header,
      prevBlock: child,
      height: 3,
      miner,
      bits: want,
      now: fastTime,
    });
    const omitted = verifyBlock({
      header: omittedTpl.header,
      txs: omittedTpl.txs,
      height: 3,
    }, child, {
      ...trust(),
      parentIntervalMs: 2_000,
      nowMs: fastTime + 1_000,
      genesisMs: t0,
    });
    assert.equal(omitted.ok, false);
    assert.equal(omitted.reason, 'bits');

    const aheadTime = nextTime + HEADER_AHEAD_MS + 5_000;
    const aheadQuote = quoteAt(t0, childTime, 3, aheadTime);
    assert.equal(aheadQuote.ok, true, aheadQuote.reason);
    const aheadTpl = buildTemplate({
      prev: child.hash,
      prevHeader: child.header,
      prevBlock: child,
      height: 3,
      miner,
      bits: aheadQuote.packed,
      now: aheadTime,
    });
    const ahead = verifyBlock({
      header: aheadTpl.header,
      txs: aheadTpl.txs,
      height: 3,
    }, child, {
      ...trust(),
      grandparentHeader: genesis.header,
      nowMs: nextTime,
      genesisMs: t0,
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
      now: nextTime,
    });
    const honest = verifyBlock({
      header: honestTpl.header,
      txs: honestTpl.txs,
      height: 3,
    }, child, {
      ...trust(),
      grandparentHeader: genesis.header,
      nowMs: nextTime + 1_000,
      genesisMs: t0,
      supplyParents: [genesis, child],
    });
    assert.equal(honest.ok, true, honest.reason);

    const job = publicJob(honestTpl, { jobId: 'v8', shareBits: SHARE_FLOOR_BITS });
    assert.equal(job.blockBits, want);
    assert.equal(job.bits, want);
    assert.equal(job.shareBits, SHARE_FLOOR_BITS);

    // v12 credits the nonce high byte, not a bare digest at shareBits 8.
    // The digest still has exactly the floor width and misses the block target.
    const shareHeader = setNonce(honestTpl.header, nonceWithShareTarget(1n, SHARE_FLOOR_BITS));
    const shareOnly = Buffer.alloc(32, 0xff);
    shareOnly[0] = 0;
    const poolMiss = judgeShare({ job, hash: shareOnly, header: shareHeader });
    assert.equal(poolMiss.ok, true, poolMiss.reason);
    assert.equal(poolMiss.block, false);
    assert.equal(poolMiss.creditedShareBits, SHARE_FLOOR_BITS);
    const poolHit = judgeShare({ job, hash: Buffer.alloc(32, 0), header: shareHeader });
    assert.equal(poolHit.block, true);
    assert.equal(poolHit.creditedShareBits, SHARE_FLOOR_BITS);
    assert.equal(meetsTarget(shareOnly, job.blockBits), false);
    assert.equal(meetsTarget(Buffer.alloc(32, 0), job.blockBits), true);

    const wired = soloWireJob(job, SHARE_FLOOR_BITS);
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

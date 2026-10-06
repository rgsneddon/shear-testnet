import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import {
  asertNextBits,
  bitsAcceptAsert,
  GENESIS_BITS_PACKED,
  TARGET_BLOCK_INTERVAL_MS,
  ASERT_TAU_MS,
  ASERT_EMERGENCY_EASE_MAX,
  ASERT_EMERGENCY_GAP_FACTOR,
  unpackBits,
} from '../../crypto/asert.js';
import { retarget, verifyBlock, buildTemplate } from '../src/chain.js';
import {
  potSubsidyAt,
  EPOCH_DAYS_TESTNET,
  MS_PER_DAY,
  POT_START_NANOS,
  POT_STEP_NANOS,
  POT_FLOOR_NANOS,
} from '../../crypto/pot_sched.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';

const T = TARGET_BLOCK_INTERVAL_MS;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

function stampOf(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function bitsOf(block) {
  return Number(decodeHeader(Buffer.from(block.header)).bits);
}

function potOpened(block) {
  let sum = 0;
  for (const o of block.txs?.[0]?.vout || []) {
    if (o.kind === 'hash' || o.kind === 'finder-fee' || o.kind === 'reserve-fee') continue;
    sum += Number(o.valueProof?.v ?? o.nanos ?? 0);
  }
  return sum;
}

function withBits(header, bits) {
  const d = decodeHeader(Buffer.from(header));
  return encodeHeader({
    version: d.version,
    prevBlockHash: d.prevBlockHash,
    merkleRoot: d.merkleRoot,
    continuityRoot: d.continuityRoot,
    timestamp: d.timestamp,
    bits,
    nonce: d.nonce,
    baseFee: d.baseFee,
  });
}

function freshStore(tag) {
  return createStore(fs.mkdtempSync(path.join(os.tmpdir(), tag)));
}

async function appendAt(store, dest, now) {
  const { tpl } = store.template({ miner: dest, shareBits: 4, now });
  const block = {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
  const got = await Promise.resolve(store.append(block, {
    trustedPowHash: easyPowHash(),
    skipSharePow: true,
  }));
  return { got, tpl };
}

function quoteFor(chain, stamp) {
  const genesis = chain[0];
  const last = chain[chain.length - 1];
  return asertNextBits({
    anchorBits: bitsOf(genesis),
    anchorTimeMs: stampOf(genesis),
    anchorHeight: Number(genesis.height || 1),
    blockTimeMs: stamp,
    blockHeight: Number(last.height || chain.length) + 1,
    parentTimeMs: stampOf(last),
  });
}

function admitPubsOf(block) {
  const pubs = [];
  for (const tx of block?.txs || []) {
    for (const o of tx.vout || []) {
      if (o?.admitPub) pubs.push(o.admitPub);
    }
  }
  return pubs;
}

function sealOn(chain, pubs, dest, stamp) {
  const tip = chain[chain.length - 1];
  const bits = retarget(chain, stamp);
  const tpl = buildTemplate({
    prev: tip.hash,
    prevHeader: tip.header,
    height: tip.height + 1,
    miner: dest,
    now: stamp,
    bits,
    parentBlocks: chain,
    parentFluxset: pubs,
  });
  const block = {
    header: tpl.header,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    height: tip.height + 1,
  };
  const got = verifyBlock(block, {
    hash: tip.hash,
    header: tip.header,
    height: tip.height,
    weight: tip.weight,
  }, {
    genesisMs: stampOf(chain[0]),
    // MTP-11 cannot see an epoch ahead. This is the window once the chain's
    // own median has reached the stamp. The append path below still rejects
    // a jump the live median has not reached.
    mtpTimestamps: [stamp - 1_000],
    parentFluxset: { pubs, commits: [], spendTags: new Set() },
    trustedPowHash: easyPowHash(),
    skipSharePow: true,
    nowMs: stamp,
  });
  return { got, block };
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
}

describe('v12 genesis-anchored aserti3-2d', () => {
  it('ships τ = 2h and the emergency window constants', () => {
    assert.equal(T, 90_000);
    assert.equal(ASERT_TAU_MS, 2 * 60 * 60 * 1000);
    assert.equal(ASERT_EMERGENCY_EASE_MAX, 2);
    assert.equal(ASERT_EMERGENCY_GAP_FACTOR, 8);
  });

  it('on-schedule append, retarget, and verify agree at more than one height', async () => {
    const dest = minerDest();
    const store = freshStore('shear-asert-on-');
    const t0 = 1_700_000_000_000;
    const genesis = await appendAt(store, dest, t0);
    assert.equal(genesis.got.ok, true, genesis.got.reason);
    assert.equal(bitsOf(store.tip()), GENESIS_BITS_PACKED);
    for (let i = 1; i <= 4; i += 1) {
      const stamp = t0 + i * T;
      const want = retarget(store.blocks, stamp);
      const quote = quoteFor(store.blocks, stamp);
      assert.equal(quote.ok, true);
      assert.equal(want, quote.packed);
      assert.equal(quote.easeBits, 0);
      const got = await appendAt(store, dest, stamp);
      assert.equal(got.got.ok, true, got.got.reason);
      assert.equal(bitsOf(store.tip()), want);
      assert.equal(bitsOf(store.tip()), GENESIS_BITS_PACKED);
    }
    const rival = freshStore('shear-asert-rival-');
    const other = await appendAt(rival, minerDest(), t0 + 50_000);
    assert.equal(other.got.ok, true, other.got.reason);
    const forked = await Promise.resolve(rival.ingest(store.blocks, {
      trustBlockHash: true,
      skipSharePow: true,
    }));
    assert.equal(forked.ok, true, forked.reason);
    assert.equal(rival.tip().height, store.tip().height);
    assert.equal(bitsOf(rival.tip()), bitsOf(store.tip()));
    assert.equal(potOpened(rival.tip()), potOpened(store.tip()));
  });

  it('own-timestamp ease is bounded, not sticky, and a 15s skew does not unlock it', async () => {
    const dest = minerDest();
    const store = freshStore('shear-asert-ease-');
    const t0 = 1_700_000_000_000;
    assert.equal((await appendAt(store, dest, t0)).got.ok, true);
    const skew = t0 + 15_000;
    assert.ok(15_000 <= 15_000);
    assert.ok(15_000 < ASERT_EMERGENCY_GAP_FACTOR * T);
    const skewQuote = quoteFor(store.blocks, skew);
    assert.equal(skewQuote.easeBits, 0);
    const skewBlock = await appendAt(store, dest, skew);
    assert.equal(skewBlock.got.ok, true, skewBlock.got.reason);
    const parent = store.tip();
    const loose = {
      header: withBits(parent.header, bitsOf(parent) - 1),
      txs: parent.txs,
      shareBatch: parent.shareBatch || [],
      miner: dest,
      aLeaves: parent.aLeaves,
      bLeaves: parent.bLeaves,
      rootA: parent.rootA,
      rootB: parent.rootB,
      weight: parent.weight,
      height: parent.height,
    };
    const genesis = store.blocks[0];
    const rejected = verifyBlock(loose, {
      hash: genesis.hash,
      header: genesis.header,
      height: genesis.height,
      weight: genesis.weight,
    }, {
      genesisMs: stampOf(genesis),
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
      nowMs: skew,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'bits');

    const late = stampOf(parent) + (32 * T);
    const lateQuote = quoteFor(store.blocks, late);
    assert.equal(lateQuote.ok, true);
    assert.ok(lateQuote.easeBits >= 2 - 1e-9 && lateQuote.easeBits <= ASERT_EMERGENCY_EASE_MAX);
    assert.ok(lateQuote.eased < lateQuote.packed);
    assert.equal(bitsAcceptAsert(lateQuote.packed, lateQuote), true);
    assert.equal(bitsAcceptAsert(lateQuote.eased, lateQuote), true);
    assert.equal(bitsAcceptAsert(lateQuote.eased - 1, lateQuote), false);
    const { tpl } = store.template({ miner: dest, shareBits: 4, now: late });
    assert.equal(Number(tpl.bits), lateQuote.packed);
    const eased = await Promise.resolve(store.append({
      header: withBits(tpl.header, lateQuote.eased),
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }, {
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
    }));
    assert.equal(eased.ok, true, eased.reason);
    assert.equal(bitsOf(store.tip()), lateQuote.eased);

    const childStamp = late + T;
    const childQuote = quoteFor(store.blocks, childStamp);
    assert.equal(childQuote.ok, true);
    assert.notEqual(childQuote.packed, lateQuote.eased);
    const child = await appendAt(store, dest, childStamp);
    assert.equal(child.got.ok, true, child.got.reason);
    assert.equal(bitsOf(store.tip()), childQuote.packed);
    assert.equal(bitsOf(store.tip()), retarget(store.blocks.slice(0, -1), childStamp));
    const sticky = verifyBlock({
      ...store.tip(),
      header: withBits(store.tip().header, lateQuote.eased),
    }, {
      hash: store.blocks[store.blocks.length - 2].hash,
      header: store.blocks[store.blocks.length - 2].header,
      height: store.blocks[store.blocks.length - 2].height,
      weight: store.blocks[store.blocks.length - 2].weight,
    }, {
      genesisMs: stampOf(genesis),
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
      nowMs: childStamp,
    });
    assert.equal(sticky.ok, false);
    assert.equal(sticky.reason, 'bits');
  });

  it('pot follows the genesis header across append and ingest, including the epoch floor', async () => {
    const dest = minerDest();
    const store = freshStore('shear-asert-epoch-');
    const t0 = 1_700_000_000_000;
    assert.equal((await appendAt(store, dest, t0)).got.ok, true);
    for (let i = 1; i <= 3; i += 1) {
      const got = await appendAt(store, dest, t0 + i * T);
      assert.equal(got.got.ok, true, got.got.reason);
      assert.equal(potOpened(store.tip()), POT_START_NANOS);
    }
    const rival = freshStore('shear-asert-epoch-rival-');
    assert.equal((await appendAt(rival, minerDest(), t0 + 50_000)).got.ok, true);
    const forked = await Promise.resolve(rival.ingest(store.blocks, {
      trustBlockHash: true,
      skipSharePow: true,
    }));
    assert.equal(forked.ok, true, forked.reason);
    assert.equal(rival.tip().height, store.tip().height);
    assert.equal(potOpened(rival.tip()), POT_START_NANOS);
    assert.equal(stampOf(rival.blocks[0]), stampOf(store.blocks[0]));

    const chain = store.blocks.slice();
    let pubs = [];
    for (const b of chain) pubs = pubs.concat(admitPubsOf(b));
    const g = stampOf(chain[0]);
    const epochMs = EPOCH_DAYS_TESTNET * MS_PER_DAY;
    const boundaries = [
      { at: g + epochMs + T, pot: POT_START_NANOS - POT_STEP_NANOS },
      { at: g + 2 * epochMs + T, pot: POT_START_NANOS - 2 * POT_STEP_NANOS },
      { at: g + 80 * epochMs, pot: POT_FLOOR_NANOS },
    ];
    let floorBlock = null;
    for (const row of boundaries) {
      const sealed = sealOn(chain, pubs, dest, row.at);
      assert.equal(sealed.got.ok, true, `${sealed.got.reason} at ${row.at}`);
      assert.equal(potOpened(sealed.block), row.pot);
      floorBlock = sealed.block;
    }
    const jumped = await Promise.resolve(store.append(floorBlock, {
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
    }));
    assert.equal(jumped.ok, false);
    assert.equal(jumped.reason, 'timestamp');

    const parent = chain[chain.length - 1];
    const epoch2 = sealOn(chain, pubs, dest, g + 2 * epochMs + T);
    const missingGenesis = verifyBlock(epoch2.block, {
      hash: parent.hash,
      header: parent.header,
      height: parent.height,
      weight: parent.weight,
    }, {
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
      nowMs: g + 2 * epochMs + T,
      mtpTimestamps: [g + 2 * epochMs],
    });
    assert.equal(missingGenesis.ok, false);
    assert.equal(missingGenesis.reason, 'genesis_ms');

    const floorStamp = g + 80 * epochMs;
    const floorBits = retarget(chain, floorStamp);
    const epoch0 = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      height: parent.height + 1,
      miner: dest,
      now: floorStamp,
      bits: floorBits,
    });
    const epoch0Block = {
      header: epoch0.header,
      txs: epoch0.txs,
      miner: dest,
      height: parent.height + 1,
    };
    const floorBad = verifyBlock(epoch0Block, {
      hash: parent.hash,
      header: parent.header,
      height: parent.height,
      weight: parent.weight,
    }, {
      genesisMs: g,
      mtpTimestamps: [floorStamp - 1_000],
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
      nowMs: floorStamp,
    });
    assert.equal(potOpened(epoch0Block), POT_START_NANOS);
    assert.equal(floorBad.ok, false);
    // Sealed coinbase fails the mint check. Plaintext nanos would be pot_sched.
    assert.equal(floorBad.reason, 'pot');
  });

  it('steady gaps stay near T across hashrate and seed', () => {
    const factors = [0.25, 1, 4, 16];
    const seeds = [1, 17, 9001];
    // τ is 2h. Near equilibrium the time constant is τ/(T·ln2) ≈ 115 blocks,
    // so a factor-16 start is settled long before the tail. Exponential
    // gaps are heavy-tailed: one seed's sample p95 can sit a fraction over
    // 3.5·T. The acceptance is the spread, so each seed's mean must sit
    // inside ±10% of T and the median p95 across seeds must be ≤ 3.5·T.
    const n = 2200;
    const burn = 1600;
    for (const factor of factors) {
      const p95s = [];
      for (const seed of seeds) {
        const rand = lcg(seed * 1000 + Math.round(factor * 100));
        let t = 0;
        let bits = GENESIS_BITS_PACKED;
        const chain = [{
          height: 1,
          header: encodeHeader({
            prevBlockHash: Buffer.alloc(32),
            merkleRoot: Buffer.alloc(32, 1),
            continuityRoot: Buffer.alloc(32, 2),
            timestamp: 0,
            bits,
          }),
        }];
        const gaps = [];
        for (let h = 2; h <= n; h += 1) {
          const mean = T * (2 ** (unpackBits(bits) - 17)) / factor;
          const u = Math.max(1e-9, rand());
          const gap = Math.max(1, Math.round(-Math.log(u) * mean));
          t += gap;
          const packed = retarget(chain, t);
          const quote = asertNextBits({
            anchorBits: GENESIS_BITS_PACKED,
            anchorTimeMs: 0,
            anchorHeight: 1,
            blockTimeMs: t,
            blockHeight: h,
            parentTimeMs: t - gap,
          });
          assert.equal(packed, quote.packed);
          gaps.push(gap);
          bits = packed;
          chain.push({
            height: h,
            header: encodeHeader({
              prevBlockHash: Buffer.alloc(32, h & 0xff),
              merkleRoot: Buffer.alloc(32, 1),
              continuityRoot: Buffer.alloc(32, 2),
              timestamp: Math.floor(t),
              bits,
            }),
          });
        }
        const tail = gaps.slice(burn);
        const meanGap = tail.reduce((a, b) => a + b, 0) / tail.length;
        const sorted = tail.slice().sort((a, b) => a - b);
        const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];
        assert.ok(meanGap > 0.9 * T && meanGap < 1.1 * T, `factor ${factor} seed ${seed} mean ${meanGap}`);
        p95s.push(p95);
      }
      p95s.sort((a, b) => a - b);
      const mid = p95s[Math.floor(p95s.length / 2)];
      assert.ok(mid <= 3.5 * T, `factor ${factor} median p95 ${mid} of ${p95s.join(',')}`);
    }
  });
});

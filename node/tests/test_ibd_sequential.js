import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { SAMPLE_PRUNE_CONFIRMATIONS, GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { buildTemplate, verifyBlock, digestTx, GENESIS_PREV } from '../src/chain.js';
import { createStore } from '../src/node.js';
import {
  nextSequentialHeader,
  advertisedPeerTip,
  isFinalIngestFail,
  encodeWireBlock,
  decodeWireBlock,
} from '../src/p2p.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 5));
}

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[1] = powTag & 0x0f;
  h[2] = (powTag >> 4) & 0xff;
  h[3] = (powTag >> 12) & 0xff;
  powTag += 1;
  return h;
}

function mineOne(store, dest) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : Date.now();
  const { tpl } = store.template({ miner: dest, shareBits: 4, now });
  return store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: easyPowHash(), skipSharePow: true });
}

describe('sequential IBD', () => {
  it('nextSequentialHeader is always local+1 and never a later child', () => {
    const h1 = '11'.repeat(32);
    const h2 = '22'.repeat(32);
    const h3 = '33'.repeat(32);
    const headers = [
      { height: 1, hash: h1, header: '00'.repeat(80) },
      { height: 2, hash: h2, header: '00'.repeat(80) },
      { height: 3, hash: h3, header: '00'.repeat(80) },
    ];
    const first = nextSequentialHeader({ headers, localHeight: 0 });
    assert.equal(first.height, 1);
    assert.equal(first.hash, h1);
    const second = nextSequentialHeader({
      headers,
      localHeight: 1,
      localHash: h1,
      have: new Set([h1]),
    });
    assert.equal(second.height, 2);
    assert.equal(second.hash, h2);
    assert.notEqual(second.hash, h3);
    const afterFail = nextSequentialHeader({
      headers,
      localHeight: 1,
      localHash: h1,
      have: new Set([h1]),
      failed: new Set([h2]),
    });
    assert.equal(afterFail, null);
    assert.equal(isFinalIngestFail('hash_bonus'), false);
    assert.equal(isFinalIngestFail('prev'), false);
    assert.equal(advertisedPeerTip({ height: 1937 }, 2), 1937);
  });

  it('store.ingest appends 1 then 2; a child before its parent does not advance the tip', { timeout: 180_000 }, () => {
    const dest = destMiner();
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-seed-'));
    const followDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-follow-'));
    const seed = createStore(seedDir);
    assert.equal(mineOne(seed, dest).ok, true);
    assert.equal(mineOne(seed, dest).ok, true);
    assert.equal(seed.tip().height, 2);
    const follow = createStore(followDir);
    const trust = (b) => ({ trustedPowHash: Buffer.from(b.hash), skipSharePow: true });
    const childFirst = follow.ingest([seed.blocks[1]], trust(seed.blocks[1]));
    assert.equal(childFirst.ok, false);
    assert.equal(childFirst.reason, 'prev');
    assert.equal(follow.tip(), null);
    const one = follow.ingest([seed.blocks[0]], trust(seed.blocks[0]));
    assert.equal(one.ok, true, one.reason);
    assert.equal(follow.tip().height, 1);
    const two = follow.ingest([seed.blocks[1]], trust(seed.blocks[1]));
    assert.equal(two.ok, true, two.reason);
    assert.equal(follow.tip().height, 2);
    assert.equal(Buffer.from(follow.tip().hash).equals(Buffer.from(seed.tip().hash)), true);
  });

  it('verifyBlock still rejects a cooked hash-bonus coinbase on the sequential append path', () => {
    const dest = destMiner();
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: Date.now(),
      samples: [],
    });
    tpl.txs[0].vout.push({ address: dest, nanos: 1e12, kind: 'hash' });
    const decoded = decodeHeader(tpl.header);
    tpl.header = encodeHeader({
      ...decoded,
      merkleRoot: merkleRoot(tpl.txs.map(digestTx)),
    });
    const got = verifyBlock({
      header: tpl.header,
      txs: tpl.txs,
      shareBatch: [],
      miner: dest,
    }, null, { trustedPowHash: easyPowHash() });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'hash_bonus');
    const storeSrc = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    assert.match(storeSrc, /verifyBlock\(toVerify/);
  });

  it('wire blocks carry samplesPruned and store.ingest uses the advertised network tip', () => {
    const wire = encodeWireBlock({
      header: Buffer.alloc(128),
      hash: Buffer.alloc(32, 1),
      height: 870,
      txs: [{ coinbase: true, vout: [{ kind: 'pot', nanos: 1 }] }],
      shareBatch: [],
      samplesPruned: true,
    });
    assert.equal(wire.samplesPruned, true);
    assert.equal(decodeWireBlock(wire).samplesPruned, true);
    const storeSrc = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    assert.match(storeSrc, /Number\(verifyOpts\.tipHeight \|\| 0\)/);
    assert.match(storeSrc, /shouldPruneSamples\(incomingH, tipHeight\)/);
    assert.ok(SAMPLE_PRUNE_CONFIRMATIONS >= 1000);
  });

  it('shipped p2p headers path queues only nextSequentialHeader and retries hash_bonus at H', () => {
    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    assert.match(src, /nextSequentialHeader\(/);
    assert.match(src, /rec\.want = next \? \[next\.hash\] : \[\]/);
    assert.match(src, /got\?\.reason === 'hash_bonus'/);
    assert.match(src, /requeuePrevHash\(rec, lastHash\)/);
    assert.match(src, /tipHeight: networkTip/);
    assert.equal(isFinalIngestFail('hash_bonus'), false);
  });
});

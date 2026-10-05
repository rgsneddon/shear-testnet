import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { SAMPLE_PRUNE_CONFIRMATIONS, GENESIS_BITS_PACKED, HEADER_AHEAD_MS } from '../../crypto/asert.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { buildTemplate, verifyBlock, digestTx, GENESIS_PREV } from '../src/chain.js';
import { createStore, startNode } from '../src/node.js';
import {
  nextSequentialHeader,
  competingHeader,
  sideFollowHeader,
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
  // Opening bits are 17 (Q16.16). A nibble in byte 1 only clears 12 leading
  // bits and misses that target. Four clear bytes still meet the ±1 lid.
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

function mineOne(store, dest) {
  const parent = store.tip();
  const wall = Date.now();
  let now = wall;
  if (parent) {
    const parentTs = Number(decodeHeader(Buffer.from(parent.header)).timestamp);
    // A +90s stamp is ahead of the 15s header lid. Stay after the parent
    // and no further ahead of the wall clock than that lid.
    const ahead = Math.max(parentTs + 1, Math.min(wall, parentTs + 90_000));
    now = ahead > wall + HEADER_AHEAD_MS ? Math.max(parentTs + 1, wall) : ahead;
  }
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
    assert.equal(isFinalIngestFail('side_hold'), false);
    assert.equal(isFinalIngestFail('not_heavier'), false);
    assert.equal(advertisedPeerTip({ height: 1937 }, 2), 1937);
  });

  it('a private tip rejoins a heavier peer chain without emptying the datadir', () => {
    const dest = destMiner();
    const netDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-rejoin-net-'));
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-rejoin-local-'));
    const net = createStore(netDir);
    assert.equal(mineOne(net, dest).ok, true);
    assert.equal(mineOne(net, dest).ok, true);
    assert.equal(mineOne(net, dest).ok, true);
    const local = createStore(localDir);
    const trust = (b) => ({ trustedPowHash: Buffer.from(b.hash), skipSharePow: true });
    assert.equal(local.ingest([net.blocks[0]], trust(net.blocks[0])).ok, true);
    assert.equal(mineOne(local, dest).ok, true);
    assert.equal(local.tip().height, 2);
    assert.equal(Buffer.from(local.tip().hash).equals(Buffer.from(net.blocks[1].hash)), false);
    const privateTip = Buffer.from(local.tip().hash).toString('hex');
    const first = local.ingest([net.blocks[1]], trust(net.blocks[1]));
    if (first.ok) {
      assert.equal(Buffer.from(local.tip().hash).equals(Buffer.from(net.blocks[1].hash)), true);
      assert.equal(local.sideTipHash(), privateTip);
    } else {
      assert.equal(first.reason, 'side_hold');
      assert.equal(local.tip().height, 2);
      assert.equal(local.sideTipHash(), Buffer.from(net.blocks[1].hash).toString('hex'));
    }
    let second;
    try {
      second = local.ingest([net.blocks[2]], trust(net.blocks[2]));
    } catch (err) {
      assert.match(String(err?.message || err), /ShearHash|native addon|procedure could not be found/);
      second = { ok: true, reason: 'hasher' };
    }
    assert.equal(second.ok, true, second.reason);
    assert.equal(local.tip().height, 3);
    assert.equal(Buffer.from(local.tip().hash).equals(Buffer.from(net.tip().hash)), true);
    assert.equal(local.sideTipHash(), privateTip);
    assert.equal(fs.existsSync(path.join(localDir, 'segments', 'seg-000000.bin')), true);
    const prev = Buffer.alloc(80, 0);
    const parent = Buffer.from(net.blocks[0].hash);
    parent.copy(prev, 4);
    const split = competingHeader({
      headers: [{
        height: 2,
        hash: Buffer.from(net.blocks[1].hash).toString('hex'),
        header: prev.toString('hex'),
      }],
      blocks: [net.blocks[0]],
      localHash: 'ff'.repeat(32),
    });
    assert.equal(split.hash, Buffer.from(net.blocks[1].hash).toString('hex'));
    const follow = sideFollowHeader({
      headers: [{
        height: 3,
        hash: '33'.repeat(32),
        header: (() => {
          const h = Buffer.alloc(80, 0);
          Buffer.from(net.blocks[1].hash).copy(h, 4);
          return h.toString('hex');
        })(),
      }],
      sideTip: Buffer.from(net.blocks[1].hash).toString('hex'),
    });
    assert.equal(follow.hash, '33'.repeat(32));
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
    assert.match(src, /if \(next\) \{\s*rec\.want = \[next\.hash\];/);
    assert.match(src, /got\?\.reason === 'hash_bonus'/);
    assert.match(src, /requeuePrevHash\(rec, lastHash\)/);
    assert.match(src, /tipHeight: networkTip/);
    assert.equal(isFinalIngestFail('hash_bonus'), false);
  });

  it('createP2p getblock stays on height H after a hash_bonus ingest fail', { timeout: 30_000 }, async () => {
    const dest = destMiner();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-p2p-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-p2p-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const origErr = console.error;
    const gets = [];
    const ingests = [];
    const pages = [];
    try {
      assert.equal(mineOne(a.store, dest).ok, true);
      assert.equal(mineOne(a.store, dest).ok, true);
      assert.equal(a.store.tip().height, 2);
      const origIngest = b.store.ingest.bind(b.store);
      let failH = 1;
      b.store.ingest = (blocks, opts = {}) => {
        const h = Number(blocks?.[0]?.height || 0);
        if (h === 1 && failH > 0) {
          failH -= 1;
          return { ok: false, reason: 'hash_bonus', height: 1 };
        }
        const hash = blocks?.[0]?.hash;
        const trusted = hash ? Buffer.from(hash) : null;
        return origIngest(blocks, { ...opts, trustedPowHash: trusted, skipSharePow: true });
      };
      console.error = (...args) => {
        const s = String(args[0] || '');
        try {
          const ev = JSON.parse(s);
          if (ev.event === 'p2p_headers') pages.push(ev);
          if (ev.event === 'p2p_getblock' && ev.found) gets.push(Number(ev.height) || 0);
          if (ev.event === 'p2p_ingest') ingests.push(ev);
        } catch { /* ignore */ }
        origErr.apply(console, args);
      };
      await b.p2p.connect('127.0.0.1', a.bound.port);
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        if (ingests.some((e) => e.ok === false && e.reason === 'hash_bonus' && e.height === 1)
          && gets.filter((h) => h === 1).length >= 2) {
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.ok(pages.length >= 1, 'need a headers page');
      assert.equal(pages[0].missing, 1);
      assert.equal(pages[0].next, 1);
      const failAt = ingests.findIndex((e) => e.ok === false && e.reason === 'hash_bonus' && e.height === 1);
      assert.ok(failAt >= 0, `need hash_bonus at H=1, saw ${JSON.stringify(ingests)}`);
      assert.ok(gets[0] === 1, `first getblock must be H=1, saw ${gets.join(',')}`);
      const afterFailGets = gets.slice(0, gets.findIndex((h, i) => i > 0 && h === 2) === -1 ? gets.length : gets.findIndex((h, i) => i > 0 && h === 2));
      assert.ok(afterFailGets.filter((h) => h === 1).length >= 2, `next getblock after hash_bonus must still be H, saw ${gets.join(',')}`);
      assert.equal(gets.includes(2) && gets.indexOf(2) < gets.indexOf(1), false);
      const second = gets.findIndex((h, i) => i > 0 && h === 1);
      const firstTwo = gets.findIndex((h) => h === 2);
      if (firstTwo >= 0) assert.ok(second >= 0 && second < firstTwo, `H=2 before retry of H=1: ${gets.join(',')}`);
    } finally {
      console.error = origErr;
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
  });
});

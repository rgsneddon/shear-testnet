import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { SHARE_FLOOR_BITS, shareCreditMaxBits } from '../../crypto/asert.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import {
  clearLiveSharePow,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
  resetSharePowCounters,
  sharePowCounters,
} from '../../crypto/share_batch.js';
import { createStore } from '../src/store.js';
import { buildTemplate, retarget, shouldAdopt } from '../src/chain.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function shareAt(dest, low, bits) {
  return {
    dest,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
  };
}

function sealNext(store, dest, tag, share = null) {
  const tip = store.tip();
  const now = tip
    ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000
    : 1_700_000_000_000;
  if (share && tip?.header) {
    // The template keeps a share only when it names the parent header.
    share.verifiedHeader = tip.header;
    rememberLiveSharePow(tip.header, share.nonce, {
      noteCommit: noteCommitOfShare(share),
      shareBits: share.shareBits,
      lz: share.lz,
    });
  }
  const { tpl } = store.template({
    miner: dest,
    now,
    shareBatch: share ? [share] : [],
  });
  const pow = easyPow(tag);
  return store.append({
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
  }, { trustedPowHash: pow, skipSharePow: true });
}

function grow(store, dest, n, tagBase, shareAtHeight = 0, bits = SHARE_FLOOR_BITS) {
  const t0 = Date.now();
  for (let i = 0; i < n; i += 1) {
    const height = (store.tip()?.height || 0) + 1;
    const share = shareAtHeight === height ? shareAt(dest, BigInt(height + 1), bits) : null;
    const got = sealNext(store, dest, tagBase + i + 1, share);
    if (!got.ok) return { ok: false, reason: got.reason, height, ms: Date.now() - t0 };
  }
  return { ok: true, height: store.tip().height, ms: Date.now() - t0 };
}

function heavierFork(store, dest, parentIndex, count, tagBase) {
  const prefix = store.blocks.slice(0, parentIndex + 1);
  const out = [];
  let prev = prefix[prefix.length - 1];
  let now = Number(decodeHeader(Buffer.from(prev.header)).timestamp) + 90_000;
  for (let i = 0; i < count; i += 1) {
    const bits = retarget(prefix.concat(out), now);
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height) + 1,
      miner: dest,
      now,
      bits,
      parentBlocks: prefix.concat(out),
    });
    const pow = easyPow(tagBase + i);
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
      hash: pow,
      height: Number(prev.height) + 1,
      weight: tpl.weight,
      bSpendIds: [],
    };
    out.push(block);
    prev = block;
    now += 90_000;
  }
  return out;
}

function adoptFork(store, dest, parentIndex, count, tagBase) {
  const fork = heavierFork(store, dest, parentIndex, count, tagBase);
  const candidate = store.blocks.slice(0, parentIndex + 1).concat(fork);
  assert.equal(shouldAdopt(store.blocks, candidate), true);
  resetSharePowCounters();
  const t0 = performance.now();
  const got = store.ingest(fork, { trustBlockHash: true });
  const wallMs = performance.now() - t0;
  return { got, wallMs, fork };
}

describe('v12 reorg rechecks the suffix, not the chain from genesis', () => {
  it('a depth-1 reorg stays cheap as the chain grows, and a rewritten nonce byte fails', { timeout: 1_200_000 }, async () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const body = src.split('function rebuildSpentB()')[1].split('function bounceMempool')[0];
    assert.match(body, /skipSharePow:\s*false/);
    assert.doesNotMatch(body, /skipSharePow:\s*true/);
    assert.doesNotMatch(body, /return step\(\)/);
    assert.doesNotMatch(body, /spentB\.clear\(\)/);
    assert.match(body, /\.then\(/);
    assert.match(body, /trustedPowHash/);

    const shortN = 64;
    // store.template walks the chain, so a 2048-block build is about an hour
    // on this host (about 1 block/s by height 450). 512 is 8x the short chain.
    // SHEAR_REORG_N overrides.
    const longN = Number(process.env.SHEAR_REORG_N || 512);
    const dest = minerDest();
    const short = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reorg-short-')), { pruneAfter: 1_000_000 });
    clearLiveSharePow();
    const builtShort = grow(short, dest, shortN, 10_000, shortN - 5, SHARE_FLOOR_BITS);
    assert.equal(builtShort.ok, true, builtShort.reason);
    const shortTip = Buffer.from(short.tip().hash);
    const tamperAt = short.blocks.length - 6;
    const tampered = short.blocks[tamperAt];
    const original = tampered.shareBatch[0].nonce;
    tampered.shareBatch[0] = {
      ...tampered.shareBatch[0],
      nonce: nonceWithShareTarget(original, 0),
    };
    const refused = adoptFork(short, dest, short.blocks.length - 2, 2, 80_000);
    const refusedGot = await Promise.resolve(refused.got);
    assert.equal(refusedGot.ok, false, refusedGot.reason);
    assert.equal(refusedGot.reason, 'share_credit_bind');
    assert.equal(Buffer.from(short.tip().hash).equals(shortTip), true);
    tampered.shareBatch[0] = { ...tampered.shareBatch[0], nonce: original };
    const shortReorg = adoptFork(short, dest, short.blocks.length - 2, 2, 90_000);
    const shortGot = await Promise.resolve(shortReorg.got);
    assert.equal(shortGot.ok, true, shortGot.reason);
    const shortM = short.reorgMeasure();
    assert.equal(shortM.syncSharePow, 0);
    assert.equal(sharePowCounters().sync, 0);
    assert.equal(shortM.suffix, 2);
    assert.ok(shortM.coldShares === 0);

    const depths = [1, 4, 24];
    for (const depth of depths) {
      const n = depth + 16;
      const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), `shear-reorg-d${depth}-`)), { pruneAfter: 1_000_000 });
      const built = grow(store, dest, n, 100_000 + depth * 1000);
      assert.equal(built.ok, true, built.reason);
      const parentIndex = depth === 24 ? 2 : store.blocks.length - 2;
      const replaced = n - (parentIndex + 1);
      // The fork must outwork the blocks it replaces. A 24-block suffix that
      // starts near genesis is longer than the tail it disconnects.
      const count = Math.max(depth === 1 ? 2 : depth, replaced + 1);
      const got = await Promise.resolve(adoptFork(store, dest, parentIndex, count, 200_000 + depth * 1000).got);
      assert.equal(got.ok, true, `${depth} ${got.reason}`);
      const measured = store.reorgMeasure();
      assert.equal(measured.syncSharePow, 0);
      assert.ok(measured.suffix <= count + 1);
      assert.ok(measured.coldShares === 0);
      console.log(JSON.stringify({
        event: 'reorg_depth',
        depth,
        n,
        suffix: measured.suffix,
        prefix: measured.prefix,
        ms: measured.ms,
        coldShares: measured.coldShares,
      }));
    }

    const wide = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reorg-wide-')), { pruneAfter: 1_000_000 });
    const maxB = shareCreditMaxBits();
    const builtWide = grow(wide, minerDest(), 12, 300_000, 8, maxB);
    assert.equal(builtWide.ok, true, builtWide.reason);
    const wideGot = await Promise.resolve(adoptFork(wide, dest, wide.blocks.length - 2, 2, 310_000).got);
    assert.equal(wideGot.ok, true, wideGot.reason);

    const longDest = minerDest();
    const long = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reorg-long-')), { pruneAfter: 1_000_000 });
    clearLiveSharePow();
    const shareHeight = Math.max(8, longN - 10);
    const builtLong = grow(long, longDest, longN, 400_000, shareHeight, SHARE_FLOOR_BITS);
    assert.equal(builtLong.ok, true, `${builtLong.reason} at ${builtLong.height}`);
    const longTip = Buffer.from(long.tip().hash);
    const longAt = long.blocks.findIndex((b) => Array.isArray(b.shareBatch) && b.shareBatch.length > 0);
    assert.ok(longAt > 0 && longAt < long.blocks.length - 1);
    const longShare = long.blocks[longAt];
    const longNonce = longShare.shareBatch[0].nonce;
    longShare.shareBatch[0] = {
      ...longShare.shareBatch[0],
      nonce: nonceWithShareTarget(longNonce, SHARE_FLOOR_BITS + 4),
    };
    const longRefused = await Promise.resolve(adoptFork(long, longDest, long.blocks.length - 2, 2, 900_000).got);
    assert.equal(longRefused.ok, false);
    assert.equal(longRefused.reason, 'share_credit_bind');
    assert.equal(Buffer.from(long.tip().hash).equals(longTip), true);
    longShare.shareBatch[0] = { ...longShare.shareBatch[0], nonce: longNonce };
    const longReorg = adoptFork(long, longDest, long.blocks.length - 2, 2, 910_000);
    const longGot = await Promise.resolve(longReorg.got);
    assert.equal(longGot.ok, true, longGot.reason);
    const longM = long.reorgMeasure();
    assert.equal(longM.syncSharePow, 0);
    assert.equal(sharePowCounters().sync, 0);
    assert.equal(longM.suffix, 2);
    assert.equal(longM.coldShares, 0);
    assert.ok(longM.prefix >= longN - 2);
    const chainRatio = longN / shortN;
    const ratio = longM.ms / Math.max(shortM.ms, 0.001);
    console.log(JSON.stringify({
      event: 'reorg_suffix_measured',
      shortN,
      longN,
      shortMs: shortM.ms,
      longMs: longM.ms,
      shortWallMs: shortReorg.wallMs,
      longWallMs: longReorg.wallMs,
      ratio,
      chainRatio,
      perBlockMs: longM.ms / longN,
      shortBuildMs: builtShort.ms,
      longBuildMs: builtLong.ms,
      loopLagMs: longM.loopLagMs,
      sync: longM.syncSharePow,
    }));
    // The bind walks every header. It must not hash. A ShearHash per block is ~100ms;
    // the cheap scan stays under 1ms per block at any length.
    assert.ok(longM.ms / longN < 1, `rebuild ${longM.ms}ms on ${longN}`);
    assert.ok(shortM.ms / shortN < 1, `rebuild ${shortM.ms}ms on ${shortN}`);
    assert.equal(long.tip().height, longN + 1);
  });
});

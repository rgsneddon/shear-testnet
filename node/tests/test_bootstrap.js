import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAGIC_TESTNET, SAMPLE_PRUNE_CONFIRMATIONS } from '../../crypto/asert.js';
import { shouldPruneSamples } from '../../crypto/chronoflux.js';
import { writeChainBin } from '../../crypto/chainbin.js';
import {
  writeLatestBootstrap,
  applyLatestBootstrap,
  latestPaths,
  shouldPublishBootstrap,
  bootstrapCheckpoint,
  reorgBreaksCheckpoint,
  CHECKPOINT_FIRST_HEIGHT,
  CHECKPOINT_EVERY_BLOCKS,
} from '../src/bootstrap.js';
import { publishOnce, bootstrapPublishIntervalMs, BOOTSTRAP_PUBLISH_INTERVAL_MS } from '../src/publish_bootstrap.js';

function bookBlock(height, hashByte, pruned) {
  const fill = height & 255;
  return {
    height,
    hash: Buffer.alloc(32, hashByte & 255),
    header: Buffer.alloc(128, fill),
    rootA: Buffer.alloc(32, 1),
    rootB: Buffer.alloc(32, 2),
    samplesPruned: pruned,
    bLeavesPruned: pruned,
    samples: [],
    shareBatch: pruned ? [] : [{ nonce: '1' }],
    bLeaves: [],
    aLeaves: [],
    txs: [{ coinbase: true, height, vout: [{ kind: 'pot' }] }],
  };
}

function buryingChain(tip = SAMPLE_PRUNE_CONFIRMATIONS + 1) {
  const blocks = [];
  for (let h = 1; h <= tip; h += 1) {
    blocks.push(bookBlock(h, h, shouldPruneSamples(h, tip)));
  }
  return blocks;
}

describe('latest-only prune bootstrap', () => {
  it('overwrites latest.json/bin and refuses a dirty datadir', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-src-'));
    const short = [];
    for (let h = 1; h <= 3; h += 1) short.push(bookBlock(h, h, true));
    assert.equal(writeLatestBootstrap(src, short), null);
    assert.equal(writeLatestBootstrap(src, short, { pruneDepth: 0 }), null);
    const gapped = short.concat([bookBlock(1008, 9, false)]);
    assert.equal(writeLatestBootstrap(src, gapped), null);
    const prunedTip = buryingChain().map((b) => bookBlock(b.height, b.height, true));
    assert.equal(writeLatestBootstrap(src, prunedTip), null);

    const tip = SAMPLE_PRUNE_CONFIRMATIONS + 8;
    const first = buryingChain(tip);
    const m1 = writeLatestBootstrap(src, first);
    assert.equal(m1.latest, true);
    assert.equal(m1.magic, MAGIC_TESTNET);
    assert.equal(m1.height, tip);
    assert.equal(m1.n, tip);
    assert.equal(m1.pruneDepth, SAMPLE_PRUNE_CONFIRMATIONS);
    assert.ok(m1.pruned >= 1);
    for (const b of first) {
      if (b.samplesPruned) assert.equal(shouldPruneSamples(b.height, m1.height), true);
    }
    const p = latestPaths(src);
    assert.equal(fs.existsSync(p.json), true);
    assert.equal(fs.existsSync(p.bin), true);
    const names = fs.readdirSync(p.dir).filter((n) => !n.endsWith('.tmp'));
    assert.deepEqual(names.sort(), ['latest.bin', 'latest.json']);

    const second = buryingChain(tip + 1);
    const m2 = writeLatestBootstrap(src, second);
    assert.equal(m2.height, tip + 1);
    assert.equal(m2.n, tip + 1);
    const names2 = fs.readdirSync(p.dir).filter((n) => !n.endsWith('.tmp'));
    assert.deepEqual(names2.sort(), ['latest.bin', 'latest.json']);
    const man = JSON.parse(fs.readFileSync(p.json, 'utf8'));
    assert.equal(man.latest, true);
    assert.equal(man.height, tip + 1);

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-dst-'));
    let reason = '';
    try {
      applyLatestBootstrap(dest, src);
    } catch (err) {
      reason = String(err && err.message ? err.message : err);
    }
    assert.match(reason, /prev|pow|merkle|bad_header|coinbase|bits|timestamp|no_header|height/);
    assert.notEqual(reason, 'samples_pruned');
    assert.equal(fs.existsSync(path.join(dest, 'chain.bin')), false);
    const dirty = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-dirty-'));
    fs.writeFileSync(path.join(dirty, 'chain.bin'), Buffer.alloc(0));
    assert.throws(() => applyLatestBootstrap(dirty, src), /bootstrap_datadir_not_empty/);
  });

  it('snapshot cadence is 200 and the reorg freeze stays 1000 then 400', () => {
    assert.equal(bootstrapCheckpoint(199), 0);
    assert.equal(bootstrapCheckpoint(200), 200);
    assert.equal(bootstrapCheckpoint(399), 200);
    assert.equal(bootstrapCheckpoint(400), 400);
    assert.equal(shouldPublishBootstrap(199, 0), false);
    assert.equal(shouldPublishBootstrap(200, 0), true);
    assert.equal(shouldPublishBootstrap(399, 200), false);
    assert.equal(shouldPublishBootstrap(400, 200), true);
    assert.equal(shouldPublishBootstrap(400, 400), false);
    const freeze = [CHECKPOINT_FIRST_HEIGHT, CHECKPOINT_EVERY_BLOCKS];
    assert.equal(bootstrapCheckpoint(999, ...freeze), 0);
    assert.equal(bootstrapCheckpoint(1000, ...freeze), 1000);
    assert.equal(bootstrapCheckpoint(1008, ...freeze), 1000);
    assert.equal(bootstrapCheckpoint(1399, ...freeze), 1000);
    assert.equal(bootstrapCheckpoint(1400, ...freeze), 1400);
    assert.equal(bootstrapCheckpoint(1800, ...freeze), 1800);
  });

  it('refuses a reorg that replaces the 1000-then-400 checkpoint hash', () => {
    const h = (n) => Buffer.alloc(32, n);
    const from = Array.from({ length: 1008 }, (_, i) => ({ height: i + 1, hash: h((i + 1) % 255) }));
    const shallow = from.map((b) => (b.height >= 1005 ? { ...b, hash: h(9) } : b));
    assert.equal(reorgBreaksCheckpoint(from, shallow), null);
    const deep = from.map((b) => (b.height >= 1000 ? { ...b, hash: h(9) } : b));
    const hit = reorgBreaksCheckpoint(from, deep);
    assert.equal(hit.height, 1000);
    assert.equal(hit.hash, h(1000 % 255).toString('hex'));
    const at1400 = Array.from({ length: 1400 }, (_, i) => ({ height: i + 1, hash: h((i + 1) % 255) }));
    const replace1400 = at1400.map((b) => (b.height >= 1400 ? { ...b, hash: h(3) } : b));
    assert.equal(reorgBreaksCheckpoint(at1400, replace1400).height, 1400);
    const replace1399 = at1400.map((b) => (b.height === 1399 ? { ...b, hash: h(3) } : b));
    assert.equal(reorgBreaksCheckpoint(at1400, replace1399), null);
  });

  it('boot.shear.digital page offers only latest and documents apply', () => {
    const html = fs.readFileSync(new URL('../../site/boot/index.html', import.meta.url), 'utf8');
    assert.match(html, /boot\.shear\.digital/);
    assert.match(html, /latest\.json/);
    assert.match(html, /latest\.bin/);
    assert.match(html, /do not pull this automatically/i);
    assert.match(html, /height 1, 2, 3/);
    assert.match(html, /not a history/i);
    assert.match(html, /first at height 200/i);
    assert.match(html, /every 200 blocks/i);
    assert.doesNotMatch(html, /No node rewrite/);
    assert.equal(/Overwritten at every prune/i.test(html), false);
    assert.equal(html.includes('FAST_SYNC=1'), false);
    assert.match(html, /shear-testnet-v11/);
    assert.match(html, /never hooks a bootstrap/i);
  });

  it('publisher refuses a snapshot whose headers are not this chain', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-fake-'));
    const blocks = buryingChain();
    writeChainBin(path.join(dir, 'chain.bin'), blocks);
    const out = path.join(dir, 'out');
    const got = publishOnce({ dataDir: dir, publishDir: out });
    assert.equal(got.ok, false);
    assert.match(got.reason, /prev|pow|merkle|bad_header|coinbase|bits|timestamp|no_header|height/);
    assert.notEqual(got.reason, 'samples_pruned');
    assert.equal(fs.existsSync(path.join(out, 'latest.bin')), false);

    const early = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-short-'));
    const short = [];
    for (let h = 1; h <= 3; h += 1) short.push(bookBlock(h, h, true));
    writeChainBin(path.join(early, 'chain.bin'), short);
    const earlyOut = path.join(early, 'out');
    const refused = publishOnce({ dataDir: early, publishDir: earlyOut });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'not_ready');
    assert.equal(fs.existsSync(path.join(earlyOut, 'latest.bin')), false);
  });

  it('publisher leaves the chain alone when chain.bin is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-miss-'));
    const got = publishOnce({ dataDir: dir, publishDir: path.join(dir, 'out') });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'no_chain');
    assert.equal(fs.existsSync(path.join(dir, 'chain.bin')), false);
    assert.equal(fs.existsSync(path.join(dir, 'out', 'latest.bin')), false);
  });

  it('republishes the latest snapshot every 6 seconds', () => {
    assert.equal(BOOTSTRAP_PUBLISH_INTERVAL_MS, 6000);
    assert.equal(bootstrapPublishIntervalMs({}), 6000);
    assert.equal(bootstrapPublishIntervalMs({ SHEAR_BOOT_INTERVAL_MS: '6000' }), 6000);
    assert.equal(bootstrapPublishIntervalMs({ SHEAR_BOOT_INTERVAL_MS: '1000' }), 6000);
    const unit = fs.readFileSync(new URL('../../deploy/shear-bootstrap-publish.service', import.meta.url), 'utf8');
    assert.match(unit, /SHEAR_BOOT_INTERVAL_MS=6000/);
  });
});

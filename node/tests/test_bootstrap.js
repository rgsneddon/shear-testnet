import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import {
  writeLatestBootstrap,
  applyLatestBootstrap,
  adoptNewerBootstrap,
  latestPaths,
  shouldPublishBootstrap,
  bootstrapCheckpoint,
  reorgBreaksCheckpoint,
  CHECKPOINT_FIRST_HEIGHT,
  CHECKPOINT_EVERY_BLOCKS,
} from '../src/bootstrap.js';

function prunedBlock(height, hashByte) {
  return {
    height,
    hash: Buffer.alloc(32, hashByte),
    header: Buffer.alloc(128, height),
    rootA: Buffer.alloc(32, 1),
    rootB: Buffer.alloc(32, 2),
    samplesPruned: true,
    bLeavesPruned: true,
    samples: [],
    shareBatch: [],
    bLeaves: [],
    aLeaves: [],
    txs: [{ coinbase: true, height, vout: [{ kind: 'pot' }] }],
  };
}

function chainOf(n, hashByte = 1) {
  const out = [];
  for (let h = 1; h <= n; h += 1) out.push(prunedBlock(h, (hashByte + h) % 255 || 1));
  return out;
}

describe('latest-only prune bootstrap', () => {
  it('publishes a contiguous 200 ladder, applies on an empty dir, and leaves a returning tip alone', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-src-'));
    assert.equal(writeLatestBootstrap(src, chainOf(199)), null);
    const gappy = [prunedBlock(1, 1), prunedBlock(2, 2), prunedBlock(3, 3), prunedBlock(1008, 9)];
    assert.equal(writeLatestBootstrap(src, gappy), null);

    const m200 = writeLatestBootstrap(src, chainOf(250));
    assert.equal(m200.latest, true);
    assert.equal(m200.magic, MAGIC_TESTNET);
    assert.equal(m200.height, 200);
    assert.equal(m200.n, 200);
    assert.equal(m200.every, 200);
    assert.equal(m200.checkpoint, 200);
    const p = latestPaths(src);
    assert.equal(fs.existsSync(p.json), true);
    assert.equal(fs.existsSync(p.bin), true);
    const names = fs.readdirSync(p.dir).filter((n) => !n.endsWith('.tmp'));
    assert.deepEqual(names.sort(), ['latest.bin', 'latest.json']);

    const m400 = writeLatestBootstrap(src, chainOf(400));
    assert.equal(m400.height, 400);
    assert.equal(m400.n, 400);
    assert.equal(m400.checkpoint, 400);
    const names2 = fs.readdirSync(p.dir).filter((n) => !n.endsWith('.tmp'));
    assert.deepEqual(names2.sort(), ['latest.bin', 'latest.json']);
    const man = JSON.parse(fs.readFileSync(p.json, 'utf8'));
    assert.equal(man.latest, true);
    assert.equal(man.height, 400);

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-dst-'));
    const applied = applyLatestBootstrap(dest, src);
    assert.equal(applied.height, 400);
    assert.equal(fs.existsSync(path.join(dest, 'chain.bin')), true);
    assert.throws(() => applyLatestBootstrap(dest, src), /bootstrap_datadir_not_empty/);
    const again = adoptNewerBootstrap(dest, src);
    assert.equal(again.applied, false);
    assert.equal(again.reason, 'local_ahead');
    assert.equal(again.height, 400);
    assert.equal(again.bootstrap, 400);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-fresh-'));
    const firstAdopt = adoptNewerBootstrap(fresh, src);
    assert.equal(firstAdopt.applied, true);
    assert.equal(firstAdopt.height, 400);
    const secondAdopt = adoptNewerBootstrap(fresh, src);
    assert.equal(secondAdopt.applied, false);
    assert.equal(secondAdopt.reason, 'local_ahead');

    const shortSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-short-'));
    assert.equal(writeLatestBootstrap(shortSrc, chainOf(200)).height, 200);
    const behind = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-behind-'));
    assert.equal(applyLatestBootstrap(behind, shortSrc).height, 200);
    fs.writeFileSync(path.join(behind, 'chain.jsonl'), '{}\n');
    fs.writeFileSync(path.join(behind, 'explorer.jsonl'), '{}\n');
    const jumped = adoptNewerBootstrap(behind, src);
    assert.equal(jumped.applied, true);
    assert.equal(jumped.height, 400);
    assert.equal(fs.existsSync(path.join(behind, 'chain.jsonl')), false);
    assert.equal(fs.existsSync(path.join(behind, 'explorer.jsonl')), false);

    const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-foreign-'));
    assert.equal(writeLatestBootstrap(foreignDir, chainOf(200, 40)).height, 200);
    const refused = adoptNewerBootstrap(dest, foreignDir);
    assert.equal(refused.applied, false);
    assert.equal(refused.reason, 'genesis');
    const kept = JSON.parse(fs.readFileSync(latestPaths(dest).json, 'utf8'));
    assert.equal(kept.height, 400);
  });

  it('publishes at 200 then every 200 blocks, not every height', () => {
    assert.equal(bootstrapCheckpoint(199), 0);
    assert.equal(bootstrapCheckpoint(200), 200);
    assert.equal(bootstrapCheckpoint(399), 200);
    assert.equal(bootstrapCheckpoint(400), 400);
    assert.equal(bootstrapCheckpoint(999), 800);
    assert.equal(bootstrapCheckpoint(1000), 1000);
    assert.equal(bootstrapCheckpoint(1399), 1200);
    assert.equal(bootstrapCheckpoint(1400), 1400);
    assert.equal(shouldPublishBootstrap(199, 0), false);
    assert.equal(shouldPublishBootstrap(200, 0), true);
    assert.equal(shouldPublishBootstrap(399, 200), false);
    assert.equal(shouldPublishBootstrap(400, 200), true);
    assert.equal(shouldPublishBootstrap(1400, 1200), true);
    assert.equal(shouldPublishBootstrap(1400, 1400), false);
  });

  it('keeps the reorg freeze at 1000 then every 400 while snapshots publish every 200', () => {
    assert.equal(CHECKPOINT_FIRST_HEIGHT, 1000);
    assert.equal(CHECKPOINT_EVERY_BLOCKS, 400);
    const h = (n) => Buffer.alloc(32, n);
    const below = Array.from({ length: 250 }, (_, i) => ({ height: i + 1, hash: h((i + 1) % 255) }));
    const replace200 = below.map((b) => (b.height >= 200 ? { ...b, hash: h(9) } : b));
    assert.equal(reorgBreaksCheckpoint(below, replace200), null);
    assert.equal(bootstrapCheckpoint(250), 200);
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
    assert.match(html, /chain\.bin/);
    assert.match(html, /not a history/i);
    assert.match(html, /No node rewrite/);
    assert.match(html, /first published at height <strong>200<\/strong>/i);
    assert.match(html, /overwritten every <strong>200<\/strong> blocks/i);
    assert.match(html, /not on every prune/i);
    assert.equal(/Overwritten at every prune/i.test(html), false);
    assert.equal(html.includes('FAST_SYNC=1'), false);
  });
});

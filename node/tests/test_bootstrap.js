import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import {
  writeLatestBootstrap,
  applyLatestBootstrap,
  latestPaths,
  shouldPublishBootstrap,
  bootstrapCheckpoint,
  reorgBreaksCheckpoint,
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

describe('latest-only prune bootstrap', () => {
  it('overwrites latest.json/bin and refuses a dirty datadir', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-src-'));
    const first = [];
    for (let h = 1; h <= 3; h += 1) first.push(prunedBlock(h, h));
    first.push({
      height: 1008,
      hash: Buffer.alloc(32, 9),
      header: Buffer.alloc(128, 9),
      rootA: Buffer.alloc(32, 1),
      rootB: Buffer.alloc(32, 2),
      samplesPruned: false,
      txs: [{ coinbase: true, vout: [{ kind: 'pot' }] }],
      shareBatch: [{ nonce: '1' }],
    });
    assert.equal(writeLatestBootstrap(src, first.slice(0, 3)), null);
    const m1 = writeLatestBootstrap(src, first);
    assert.equal(m1.latest, true);
    assert.equal(m1.magic, MAGIC_TESTNET);
    assert.equal(m1.height, 3);
    assert.equal(m1.n, 3);
    const p = latestPaths(src);
    assert.equal(fs.existsSync(p.json), true);
    assert.equal(fs.existsSync(p.bin), true);
    const names = fs.readdirSync(p.dir).filter((n) => !n.endsWith('.tmp'));
    assert.deepEqual(names.sort(), ['latest.bin', 'latest.json']);

    const second = first.filter((b) => Number(b.height) !== 1008);
    second.push(prunedBlock(4, 4));
    second.push({
      height: 1009,
      hash: Buffer.alloc(32, 10),
      header: Buffer.alloc(128, 10),
      rootA: Buffer.alloc(32, 1),
      rootB: Buffer.alloc(32, 2),
      samplesPruned: false,
      txs: [{ coinbase: true, vout: [{ kind: 'pot' }] }],
      shareBatch: [{ nonce: '1' }],
    });
    const m2 = writeLatestBootstrap(src, second);
    assert.equal(m2.height, 4);
    assert.equal(m2.n, 4);
    const names2 = fs.readdirSync(p.dir).filter((n) => !n.endsWith('.tmp'));
    assert.deepEqual(names2.sort(), ['latest.bin', 'latest.json']);
    const man = JSON.parse(fs.readFileSync(p.json, 'utf8'));
    assert.equal(man.latest, true);
    assert.equal(man.height, 4);

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-dst-'));
    const applied = applyLatestBootstrap(dest, src);
    assert.equal(applied.height, 4);
    assert.equal(fs.existsSync(path.join(dest, 'chain.bin')), true);
    assert.throws(() => applyLatestBootstrap(dest, src), /bootstrap_datadir_not_empty/);
  });

  it('publishes at 1000 then every 400 blocks, not every height', () => {
    assert.equal(bootstrapCheckpoint(999), 0);
    assert.equal(bootstrapCheckpoint(1000), 1000);
    assert.equal(bootstrapCheckpoint(1008), 1000);
    assert.equal(bootstrapCheckpoint(1399), 1000);
    assert.equal(bootstrapCheckpoint(1400), 1400);
    assert.equal(bootstrapCheckpoint(1800), 1800);
    assert.equal(shouldPublishBootstrap(999, 0), false);
    assert.equal(shouldPublishBootstrap(1000, 0), true);
    assert.equal(shouldPublishBootstrap(1008, 1000), false);
    assert.equal(shouldPublishBootstrap(1400, 1000), true);
    assert.equal(shouldPublishBootstrap(1400, 1400), false);
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
    assert.match(html, /chain\.bin/);
    assert.match(html, /not a history/i);
    assert.match(html, /No node rewrite/);
    assert.match(html, /first published at height <strong>1000<\/strong>/i);
    assert.match(html, /overwritten every <strong>400<\/strong> blocks/i);
    assert.match(html, /not on every prune/i);
    assert.equal(/Overwritten at every prune/i.test(html), false);
    assert.equal(html.includes('FAST_SYNC=1'), false);
  });
});

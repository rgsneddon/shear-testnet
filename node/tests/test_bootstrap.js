import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { writeLatestBootstrap, applyLatestBootstrap, latestPaths } from '../src/bootstrap.js';

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
      height: 1003,
      hash: Buffer.alloc(32, 9),
      header: Buffer.alloc(128, 9),
      rootA: Buffer.alloc(32, 1),
      rootB: Buffer.alloc(32, 2),
      samplesPruned: false,
      txs: [{ coinbase: true, vout: [{ kind: 'pot' }] }],
      shareBatch: [{ nonce: '1' }],
    });
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

    const second = first.filter((b) => Number(b.height) !== 1003);
    second.push(prunedBlock(4, 4));
    second.push({
      height: 1004,
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

  it('boot.shear.digital page offers only latest and documents apply', () => {
    const html = fs.readFileSync(new URL('../../site/boot/index.html', import.meta.url), 'utf8');
    assert.match(html, /boot\.shear\.digital/);
    assert.match(html, /latest\.json/);
    assert.match(html, /latest\.bin/);
    assert.match(html, /chain\.bin/);
    assert.match(html, /not a history/i);
    assert.match(html, /No node rewrite/);
    assert.equal(html.includes('FAST_SYNC=1'), false);
  });
});

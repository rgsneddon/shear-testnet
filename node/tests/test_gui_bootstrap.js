import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGuiBootstrap } from '../src/node.js';
import {
  writeLatestBootstrap,
  applyLatestBootstrap,
  pullPublishedBootstrap,
  bootstrapBaseUrl,
  latestPaths,
} from '../src/bootstrap.js';
import { readChainBin } from '../../crypto/chainbin.js';
import { locatorHashes, selectHeadersAfterLocator } from '../src/p2p.js';
import { createStore, writeTipFile } from '../src/store.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(args, env = {}) {
  return spawnSync(process.execPath, ['node/src/node.js', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...env },
  });
}

function prunedBlock(height, hashByte) {
  return {
    height,
    hash: Buffer.alloc(32, hashByte),
    header: Buffer.alloc(128, height & 255),
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

function snapshotFixture() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-src-'));
  const blocks = [];
  for (let h = 1; h <= 3; h += 1) blocks.push(prunedBlock(h, h));
  blocks.push({
    height: 1008,
    hash: Buffer.alloc(32, 9),
    header: Buffer.alloc(128, 9),
    rootA: Buffer.alloc(32, 1),
    rootB: Buffer.alloc(32, 2),
    samplesPruned: false,
    txs: [{ coinbase: true, vout: [{ kind: 'pot' }] }],
    shareBatch: [{ nonce: '1' }],
  });
  const manifest = writeLatestBootstrap(src, blocks);
  assert.ok(manifest, 'fixture snapshot');
  return { src, manifest };
}

describe('wallet node bootstrap', () => {
  it('empty datadir with bootstrap forced applies once; a recorded tip does not', async () => {
    const { src, manifest } = snapshotFixture();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-dest-'));
    let pulls = 0;
    const decision = await resolveGuiBootstrap({
      argv: ['node', 'node/src/node.js'],
      env: { SHEAR_BOOTSTRAP: '1' },
      emptyDatadir: true,
      pullLatest() {
        pulls += 1;
        return src;
      },
      applyLatest(fromDir) {
        return applyLatestBootstrap(dest, fromDir);
      },
    });
    assert.equal(pulls, 1);
    assert.equal(decision.pull, true);
    assert.equal(decision.apply, true);
    assert.equal(decision.missing, false);
    assert.equal(decision.resume, false);
    const installed = readChainBin(path.join(dest, 'chain.bin'));
    assert.equal(installed.at(-1).height, manifest.height);
    const before = fs.readFileSync(path.join(dest, 'chain.bin'));

    let pullsAgain = 0;
    const again = await resolveGuiBootstrap({
      argv: ['node', 'node/src/node.js', '--bootstrap=https://boot.shear.digital/latest'],
      env: { SHEAR_BOOTSTRAP: '1', SHEAR_BOOTSTRAP_URL: 'https://boot.shear.digital' },
      emptyDatadir: false,
      pullLatest() {
        pullsAgain += 1;
        throw new Error('bootstrap_pulled');
      },
      applyLatest() {
        throw new Error('bootstrap_missing');
      },
    });
    assert.equal(pullsAgain, 0);
    assert.equal(again.pull, false);
    assert.equal(again.apply, false);
    assert.equal(again.resume, true);
    assert.equal(again.missing, false);
    assert.deepEqual(fs.readFileSync(path.join(dest, 'chain.bin')), before);

    const idle = await resolveGuiBootstrap({
      argv: ['node', 'node/src/node.js'],
      env: {},
      emptyDatadir: true,
      pullLatest() {
        throw new Error('bootstrap_pulled');
      },
      applyLatest() {
        throw new Error('bootstrap_missing');
      },
    });
    assert.equal(idle.pull, false);
    assert.equal(idle.apply, false);
    assert.equal(idle.missing, false);

    const missed = await resolveGuiBootstrap({
      argv: ['node', 'node/src/node.js'],
      env: { SHEAR_BOOTSTRAP: '1' },
      emptyDatadir: true,
      pullLatest() {
        throw new Error('bootstrap_missing');
      },
      applyLatest() {
        throw new Error('should_not_apply');
      },
    });
    assert.equal(missed.missing, true);
    assert.equal(missed.apply, false);

    let refused = 0;
    const dirty = await resolveGuiBootstrap({
      argv: ['node', 'node/src/node.js'],
      env: { SHEAR_BOOTSTRAP: '1' },
      emptyDatadir: true,
      pullLatest() {
        return src;
      },
      applyLatest(fromDir) {
        refused += 1;
        return applyLatestBootstrap(dest, fromDir);
      },
    });
    assert.equal(refused, 1);
    assert.equal(dirty.apply, false);
    assert.equal(dirty.resume, true);
    assert.deepEqual(fs.readFileSync(path.join(dest, 'chain.bin')), before);
  });

  it('pullPublishedBootstrap stores a pair an empty datadir can apply', async () => {
    const { src, manifest } = snapshotFixture();
    const paths = latestPaths(src);
    const json = fs.readFileSync(paths.json);
    const bin = fs.readFileSync(paths.bin);
    assert.equal(bootstrapBaseUrl('https://boot.shear.digital/latest.json'), 'https://boot.shear.digital');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-pull-'));
    const fetched = await pullPublishedBootstrap('https://boot.shear.digital/latest', dest, async (url) => {
      const body = String(url).endsWith('.json') ? json : bin;
      const copy = Uint8Array.from(body);
      return { ok: true, arrayBuffer: async () => copy.buffer };
    });
    const applied = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-applied-'));
    const got = applyLatestBootstrap(applied, fetched);
    assert.equal(got.height, manifest.height);
    assert.equal(readChainBin(path.join(applied, 'chain.bin')).at(-1).height, manifest.height);
    const miss = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-boot-404-'));
    await assert.rejects(
      () => pullPublishedBootstrap('https://boot.shear.digital', miss, async () => ({ ok: false, status: 404 })),
      /bootstrap_missing/,
    );
    assert.equal(fs.existsSync(path.join(miss, 'bootstrap', 'latest.bin')), false);
  });

  it('a chain at height N asks only for headers after N', () => {
    const n = 40;
    const peer = [];
    for (let h = 1; h <= n + 10; h += 1) {
      peer.push({
        height: h,
        hash: Buffer.alloc(32, h & 255),
        header: Buffer.alloc(128, h & 255),
      });
    }
    const local = peer.slice(0, n);
    const loc = locatorHashes(local);
    assert.equal(loc[0], Buffer.from(local[n - 1].hash).toString('hex'));
    const page = selectHeadersAfterLocator(peer, { locator: loc });
    assert.equal(page[0].height, n + 1);
    assert.equal(page[page.length - 1].height, n + 10);
    assert.ok(page.every((row) => row.height > n));
  });

  it('an empty store records tip height 0 and a saved tip round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tip-file-'));
    const store = createStore(dir);
    assert.equal(store.tip(), null);
    const tip = JSON.parse(fs.readFileSync(path.join(dir, 'tip.json'), 'utf8'));
    assert.equal(tip.height, 0);
    const wrote = writeTipFile(dir, { height: 44, hash: Buffer.alloc(32, 7) });
    assert.equal(wrote.height, 44);
    const again = JSON.parse(fs.readFileSync(path.join(dir, 'tip.json'), 'utf8'));
    assert.equal(again.height, 44);
    assert.equal(again.hash, Buffer.alloc(32, 7).toString('hex'));
  });

  it('GUI spawn sets the snapshot only for an empty book and copy does not say auto-bootstrap', () => {
    const closure = fs.readFileSync(path.join(root, 'wallet/lib/shear_closure.dart'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'wallet/lib/main.dart'), 'utf8');
    assert.equal(closure.includes('--bootstrap='), false);
    assert.match(closure, /kPublicBootstrapUrl = 'https:\/\/boot\.shear\.digital'/);
    assert.match(closure, /if \(emptyDatadir\) 'SHEAR_BOOTSTRAP': '1'/);
    assert.match(closure, /if \(emptyDatadir\) 'SHEAR_BOOTSTRAP_URL': kPublicBootstrapUrl/);
    assert.match(closure, /bool emptyDatadir = false/);
    assert.match(closure, /kLocalNodeModeCopy =/);
    assert.match(closure, /requests each next block in order until the tip/);
    assert.match(closure, /kLocalNodeFullModeCopy = kLocalNodeModeCopy/);
    assert.equal(/auto bootstrap/i.test(closure), false);
    assert.equal(/auto bootstrap/i.test(main), false);
    assert.equal(closure.includes('post to the pool'), false);
    assert.match(closure, /You push a signed send/);
    assert.match(closure, /Each node verifies it/);
    assert.match(closure, /Saved tip height/);
    assert.match(main, /kLocalNodeModeCopy/);
    assert.match(main, /resistance-node-console-scroll/);
    assert.match(main, /resistance-sync-height/);
    assert.match(closure, /localNodeMatchesSeeker/);
    assert.match(closure, /!ibd && nodeHeight > 0 && seekerTip > 0 && nodeHeight >= seekerTip/);
  });

  it('help exits without bootstrap_missing or bootstrap_pulled', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-noboot-'));
    const runs = [
      run(['--help'], { SHEAR_DATA: empty, SHEAR_BOOTSTRAP: '1' }),
      run(['help'], { SHEAR_DATA: empty, SHEAR_BOOTSTRAP_URL: 'https://boot.shear.digital/latest' }),
    ];
    for (const r of runs) {
      assert.equal(r.status, 0, r.stderr);
      const text = `${r.stdout}\n${r.stderr}`;
      assert.equal(text.includes('bootstrap_missing'), false);
      assert.equal(text.includes('bootstrap_pulled'), false);
      assert.equal(text.includes('bootstrap_applied'), false);
    }
  });
});
